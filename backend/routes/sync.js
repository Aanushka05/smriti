// routes/sync.js — the endpoint the offline devices drain into.
// =====================================================================
// IDEMPOTENCY IS THE WHOLE POINT
// ---------------------------------------------------------------------
// A device on a weak link cannot tell "the server never got it" apart
// from "the server got it and the reply was lost". So it retries, and the
// same event WILL arrive twice. That is normal, not an error.
//
// Every event carries a UUID minted on the device. `sync_events` has that
// ID as its PRIMARY KEY, and the row is inserted in the SAME transaction
// as the effect it causes. So the second arrival hits the primary key,
// finds the event already recorded, and is answered `duplicate` — with no
// second session, no second missed dose, no second SMS.
//
// The device treats `accepted` and `duplicate` identically: both mean
// "the server holds this", which is its cue to stop retrying.
// =====================================================================

const express = require('express');
const {
  db, uuid, recomputeMetrics, notifyCaregivers, DOMAINS, toDateKey, refreshPatientSchedule,
  upsertGameSession,
} = require('../database');
const { requireAuth, canAccessPatient } = require('../middleware/auth');
const realtime = require('../realtime');
const { deliverMissedDoseAlert } = require('../sms_service');

const router = express.Router();

const MAX_EVENTS_PER_BATCH = 100;

const EVENT_TYPES = {
  GAME_RESULT: 'game_result',
  REMINDER_ACTION: 'reminder_action',
  MISSED_DOSE_ALERT: 'missed_dose_alert',
  PATIENT_INTERACTION: 'patient_interaction',
  GAME_SESSION_START: 'game_session_start',
  GAME_SESSION_END: 'game_session_end',
};

/* ------------------------------------------------------------- schema */
// Created here rather than in database.js so the offline layer is a
// self-contained addition that does not touch the existing schema file.
db.exec(`
CREATE TABLE IF NOT EXISTS sync_events (
  event_id TEXT PRIMARY KEY,            -- device-generated UUID = the idempotency key
  patient_id TEXT NOT NULL,
  device_id TEXT,
  event_type TEXT NOT NULL,
  occurred_at INTEGER,                  -- when the patient actually did it
  created_at INTEGER,                   -- when the device wrote it down
  received_at INTEGER NOT NULL,         -- when the server first saw it
  payload TEXT,
  result TEXT                           -- what applying it produced
);
CREATE INDEX IF NOT EXISTS idx_sync_events_patient ON sync_events(patient_id, received_at);

-- Delivery log for critical alerts, so a caregiver SMS is attempted once
-- and its outcome is auditable.
CREATE TABLE IF NOT EXISTS critical_alerts (
  id TEXT PRIMARY KEY,                  -- device alert id, also idempotency key
  patient_id TEXT NOT NULL,
  reminder_id TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT,
  due_date TEXT,
  due_time TEXT,
  detected_offline INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  delivery_status TEXT DEFAULT 'pending',   -- pending | sent | failed | no_contact
  delivery_channel TEXT,                    -- sms_gateway | gsm_modem | none
  delivery_attempts INTEGER DEFAULT 0,
  last_attempt_at INTEGER,
  last_error TEXT,
  acknowledged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_patient ON critical_alerts(patient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_delivery ON critical_alerts(delivery_status);
`);

const findEvent = db.prepare('SELECT event_id, result FROM sync_events WHERE event_id=?');
const insertEvent = db.prepare(`INSERT INTO sync_events
  (event_id,patient_id,device_id,event_type,occurred_at,created_at,received_at,payload,result)
  VALUES (?,?,?,?,?,?,?,?,?)`);

/* ------------------------------------------------------ event handlers */
// Each returns a small result object. Each runs INSIDE the transaction
// that records the event, so "effect applied" and "event recorded" are
// inseparable — a crash between them is impossible.

function applyGameResult(event) {
  const p = event.payload || {};
  if (!DOMAINS.includes(p.domain)) throw Object.assign(new Error(`unknown domain "${p.domain}"`), { permanent: true });

  const accuracy = Number(p.accuracy);
  const avgTimeMs = Number(p.avgTimeMs);
  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1) {
    throw Object.assign(new Error('accuracy must be between 0 and 1'), { permanent: true });
  }
  if (!Number.isFinite(avgTimeMs) || avgTimeMs < 0) {
    throw Object.assign(new Error('avgTimeMs must be positive'), { permanent: true });
  }

  // Keep the device's session id so the two sides agree on identity.
  const sessionId = p.sessionId || uuid();
  const a = p.adaptive || {};
  db.prepare(`INSERT OR IGNORE INTO sessions
    (id,patient_id,domain,game_type,level,score,total_rounds,accuracy,avg_time_ms,answers,
     start_level,end_level,max_level,hints_used,skipped_count,timeout_count,wrong_count,
     duration_ms,adaptive_score,adaptive_band,adaptive_status,difficulty_changes,game_session_id,
     completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    sessionId, event.patientId, p.domain, p.gameType || null, p.level || null,
    p.score == null ? null : Number(p.score), p.totalRounds == null ? null : Number(p.totalRounds),
    accuracy, Math.round(avgTimeMs), JSON.stringify(p.answers || []),
    a.startLevel == null ? null : Number(a.startLevel),
    a.endLevel == null ? null : Number(a.endLevel),
    a.maxLevel == null ? null : Number(a.maxLevel),
    Number(a.hints) || 0, Number(a.skips) || 0, Number(a.timeouts) || 0, Number(a.wrong) || 0,
    a.durationMs == null ? null : Number(a.durationMs),
    a.score == null ? null : Number(a.score), a.band || null, a.status || null,
    JSON.stringify(a.difficultyChanges || []), p.gameSessionId || null,
    // The time the patient PLAYED, not the time it synced — otherwise a
    // week of offline activity would all land on today's chart.
    event.occurredAt || event.createdAt || Date.now()
  );
  return { sessionId };
}

/* A play session the device opened or closed. The device is the record of
 * truth for usage — it is the only thing that knows what happened while the
 * network was down — so the server takes what it is told and stores it. What
 * the device may NOT decide is its own allowance; that lives on the patient
 * row and only a caregiver can change it. */
function applyGameSessionStart(event) {
  const p = event.payload || {};
  if (!p.sessionId || !p.dayKey || !p.startedAt) {
    throw Object.assign(new Error('sessionId, dayKey and startedAt are required'), { permanent: true });
  }
  const outcome = upsertGameSession(event.patientId, {
    id: p.sessionId, dayKey: p.dayKey, startedAt: Number(p.startedAt), status: 'active',
  });
  return { sessionId: p.sessionId, outcome };
}

function applyGameSessionEnd(event) {
  const p = event.payload || {};
  if (!p.sessionId || !p.dayKey) {
    throw Object.assign(new Error('sessionId and dayKey are required'), { permanent: true });
  }
  const outcome = upsertGameSession(event.patientId, {
    id: p.sessionId,
    dayKey: p.dayKey,
    // A close may arrive before its open if the queue was reordered, so carry
    // a usable start rather than rejecting the more important of the two.
    startedAt: Number(p.startedAt) || (Number(p.endedAt) - Number(p.durationMs || 0)) || Date.now(),
    endedAt: Number(p.endedAt) || Date.now(),
    durationMs: Number(p.durationMs) || 0,
    gamesPlayed: Number(p.gamesPlayed) || 0,
    endReason: p.reason || 'finished',
    status: 'ended',
  });
  return { sessionId: p.sessionId, outcome };
}

function applyReminderAction(event) {
  const p = event.payload || {};
  const allowed = ['done', 'missed', 'snoozed', 'pending'];
  if (!allowed.includes(p.action)) {
    throw Object.assign(new Error(`action must be one of ${allowed.join(', ')}`), { permanent: true });
  }

  // The device may have generated this occurrence itself while offline
  // (id "local:<scheduleId>:<date>:<time>"), so the server may not have the
  // row yet. Materialise the day, then match on schedule + date + time.
  // Time matters: a schedule repeating through the day has several
  // occurrences on one date, and matching without it would mark the wrong
  // one done.
  refreshPatientSchedule(event.patientId, p.dueDate);

  let row = db.prepare('SELECT * FROM reminders WHERE id=?').get(p.reminderId);
  if (!row && p.scheduleId && p.dueDate && p.time) {
    row = db.prepare(
      'SELECT * FROM reminders WHERE patient_id=? AND schedule_id=? AND due_date=? AND time=?')
      .get(event.patientId, p.scheduleId, p.dueDate, p.time);
  }
  if (!row && p.scheduleId && p.dueDate) {
    // An older device that did not send a time. One occurrence a day was
    // the only shape it knew, so matching on schedule + date is correct.
    row = db.prepare('SELECT * FROM reminders WHERE patient_id=? AND schedule_id=? AND due_date=?')
      .get(event.patientId, p.scheduleId, p.dueDate);
  }

  // Still nothing (the schedule was deleted server-side, say): record the
  // action as a standalone occurrence rather than discarding what the
  // patient actually did.
  if (!row) {
    const id = p.reminderId || uuid();
    db.prepare(`INSERT OR IGNORE INTO reminders
      (id,patient_id,schedule_id,icon,type,title,time,text,due_date,priority,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, event.patientId, p.scheduleId || null, '🔔', p.category || 'General',
      p.title || 'Reminder', p.time || '', p.title || '', p.dueDate || toDateKey(new Date()),
      p.priority || 'normal', p.action, event.occurredAt || Date.now()
    );
    return { reminderId: id, created: true };
  }

  // Append-only in spirit: a completed dose is a historical fact and is
  // never downgraded by a later-arriving "missed" from a stale device.
  if (row.status === 'done' && p.action === 'missed') {
    return { reminderId: row.id, ignored: 'already completed' };
  }

  db.prepare('UPDATE reminders SET status=?, completed_at=?, snoozed_until=?, updated_at=? WHERE id=?').run(
    p.action,
    p.action === 'done' ? (event.occurredAt || Date.now()) : null,
    p.action === 'snoozed' ? (event.occurredAt || Date.now()) + (Number(p.minutes) || 15) * 60000 : null,
    event.occurredAt || Date.now(),
    row.id
  );
  return { reminderId: row.id };
}

function applyMissedDoseAlert(event) {
  const p = event.payload || {};
  const alertId = p.alertId || event.eventId;

  const patient = db.prepare('SELECT name FROM patients WHERE id=?').get(event.patientId);
  db.prepare(`INSERT OR IGNORE INTO critical_alerts
    (id,patient_id,reminder_id,type,severity,title,due_date,due_time,detected_offline,created_at,received_at,delivery_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`).run(
    alertId, event.patientId, p.reminderId || null, 'missed_medication',
    p.severity || 'critical', p.title || 'Medication', p.dueDate || null, p.dueTime || null,
    p.detectedOffline ? 1 : 0, event.occurredAt || event.createdAt || Date.now(), Date.now()
  );

  notifyCaregivers(
    event.patientId,
    `Missed medication: ${p.title || 'medication'}`,
    `${patient ? patient.name : 'The patient'} did not confirm ${p.title || 'their medication'}`
      + `${p.dueTime ? ` due at ${p.dueTime}` : ''}`
      + `${p.detectedOffline ? ' (recorded while the device was offline)' : ''}.`,
    'critical'
  );

  return { alertId, needsDelivery: true };
}

function applyPatientInteraction(event) {
  // Lightweight engagement signal; the row itself is the record.
  return { recorded: true };
}

const HANDLERS = {
  [EVENT_TYPES.GAME_RESULT]: applyGameResult,
  [EVENT_TYPES.REMINDER_ACTION]: applyReminderAction,
  [EVENT_TYPES.MISSED_DOSE_ALERT]: applyMissedDoseAlert,
  [EVENT_TYPES.PATIENT_INTERACTION]: applyPatientInteraction,
  [EVENT_TYPES.GAME_SESSION_START]: applyGameSessionStart,
  [EVENT_TYPES.GAME_SESSION_END]: applyGameSessionEnd,
};

/* ------------------------------------------------------------- routes */

// POST /api/sync/batch  { deviceId, events: [...] }
// -> { results: [{ eventId, status: accepted|duplicate|rejected, ... }] }
router.post('/sync/batch', requireAuth, async (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events) return res.status(400).json({ error: 'events must be an array.', field: 'events' });
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return res.status(400).json({ error: `Too many events in one batch (limit ${MAX_EVENTS_PER_BATCH}).`, field: 'events' });
  }

  const results = [];
  const touchedPatients = new Set();
  const alertsToDeliver = [];

  for (const event of events) {
    // ---- validate the envelope -------------------------------------
    if (!event || !event.eventId || !event.eventType) {
      results.push({ eventId: event && event.eventId, status: 'rejected', error: 'eventId and eventType are required.' });
      continue;
    }
    if (!HANDLERS[event.eventType]) {
      results.push({ eventId: event.eventId, status: 'rejected', error: `Unknown event type "${event.eventType}".` });
      continue;
    }
    if (!event.patientId || !canAccessPatient(req.user, event.patientId)) {
      results.push({ eventId: event.eventId, status: 'rejected', error: 'Not permitted for this patient.' });
      continue;
    }

    // ---- already seen? then this is a retry, not a new fact ---------
    const seen = findEvent.get(event.eventId);
    if (seen) {
      let previous = null;
      try { previous = JSON.parse(seen.result); } catch (e) { previous = null; }
      results.push({ eventId: event.eventId, status: 'duplicate', result: previous });
      continue;
    }

    // ---- apply + record, atomically --------------------------------
    try {
      const outcome = db.transaction(() => {
        const applied = HANDLERS[event.eventType](event);
        insertEvent.run(
          event.eventId, event.patientId, body.deviceId || null, event.eventType,
          event.occurredAt || null, event.createdAt || null, Date.now(),
          JSON.stringify(event.payload || {}), JSON.stringify(applied || {})
        );
        return applied;
      })();

      results.push({ eventId: event.eventId, status: 'accepted', result: outcome });
      touchedPatients.add(event.patientId);
      if (outcome && outcome.needsDelivery) {
        alertsToDeliver.push({ alertId: outcome.alertId, patientId: event.patientId });
      }
    } catch (err) {
      // A permanent error means retrying can never work — tell the device
      // to stop, and say why. Anything else stays retryable.
      if (err && err.permanent) {
        results.push({ eventId: event.eventId, status: 'rejected', error: err.message });
      } else {
        console.error('[sync] failed to apply event', event.eventId, err && err.message);
        results.push({ eventId: event.eventId, status: 'error', error: 'Could not apply this event. It will be retried.' });
      }
    }
  }

  // Recompute rollups once per patient, not once per event.
  for (const patientId of touchedPatients) {
    try {
      recomputeMetrics(patientId);
      realtime.publish(patientId, 'sync:received', { count: results.length });
    } catch (err) { console.error('[sync] post-processing failed', err && err.message); }
  }

  // Critical alerts go out AFTER the transaction has committed, so an SMS
  // is never sent for an alert that failed to persist.
  for (const item of alertsToDeliver) {
    deliverMissedDoseAlert(item.alertId).catch((err) => {
      console.error('[sync] alert delivery failed', item.alertId, err && err.message);
    });
  }

  res.json({
    receivedAt: Date.now(),
    accepted: results.filter((r) => r.status === 'accepted').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    rejected: results.filter((r) => r.status === 'rejected').length,
    results,
  });
});

// GET /api/sync/status/:patientId — what the server holds, for the
// caregiver's "last synced / pending" display.
router.get('/sync/status/:patientId', requireAuth, (req, res) => {
  if (!canAccessPatient(req.user, req.params.patientId)) {
    return res.status(403).json({ error: 'This patient is not linked to your account.', code: 'NOT_LINKED' });
  }
  const last = db.prepare(`SELECT MAX(received_at) last, COUNT(*) total
    FROM sync_events WHERE patient_id=?`).get(req.params.patientId);
  const offlineOrigin = db.prepare(`SELECT COUNT(*) c FROM critical_alerts
    WHERE patient_id=? AND detected_offline=1`).get(req.params.patientId);
  const alerts = db.prepare(`SELECT id,type,severity,title,due_date,due_time,created_at,
      delivery_status,delivery_channel,delivery_attempts,last_error,acknowledged_at,detected_offline
    FROM critical_alerts WHERE patient_id=? ORDER BY created_at DESC LIMIT 20`).all(req.params.patientId);

  res.json({
    lastSyncAt: last.last || null,
    totalEvents: last.total || 0,
    alertsDetectedOffline: offlineOrigin.c || 0,
    alerts: alerts.map((a) => ({
      id: a.id, type: a.type, severity: a.severity, title: a.title,
      dueDate: a.due_date, dueTime: a.due_time, createdAt: a.created_at,
      deliveryStatus: a.delivery_status, deliveryChannel: a.delivery_channel,
      deliveryAttempts: a.delivery_attempts, lastError: a.last_error,
      acknowledgedAt: a.acknowledged_at, detectedOffline: !!a.detected_offline,
    })),
  });
});

// POST /api/alerts/:alertId/acknowledge — caregiver has seen and handled it.
router.post('/alerts/:alertId/acknowledge', requireAuth, (req, res) => {
  const alert = db.prepare('SELECT * FROM critical_alerts WHERE id=?').get(req.params.alertId);
  if (!alert) return res.status(404).json({ error: 'Alert not found.' });
  if (!canAccessPatient(req.user, alert.patient_id)) {
    return res.status(403).json({ error: 'This patient is not linked to your account.', code: 'NOT_LINKED' });
  }
  db.prepare('UPDATE critical_alerts SET acknowledged_at=? WHERE id=?').run(Date.now(), alert.id);
  realtime.publish(alert.patient_id, 'alert:acknowledged', { alertId: alert.id });
  res.json({ ok: true });
});

module.exports = { router, EVENT_TYPES };
