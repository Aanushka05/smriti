/* local-store.js — local-first reads and writes for patient activity.
 * =====================================================================
 * Every function here follows the same shape:
 *
 *     write locally  ->  enqueue for sync  ->  return immediately
 *
 * The UI never waits on the network to confirm a patient action, and a
 * failed request never costs the patient their data. When the app is
 * online the outbox drains within a second, so the behaviour looks
 * identical to before — it just no longer depends on that succeeding.
 *
 * It also mirrors the server's schedule -> occurrence logic so a device
 * that has not spoken to the server in days still knows what is due
 * today. That mirror is the reason medication reminders keep working
 * with no connectivity at all.
 * =====================================================================
 */

/* ---------------------------------------------------------------------
   CACHING SERVER STATE FOR OFFLINE USE
--------------------------------------------------------------------- */

/**
 * Called after any successful fetch of the patient record. Stores the
 * profile, the schedules and today's reminders so the next cold start
 * can be fully offline.
 *
 * Local rows that are still unsynced are NOT overwritten by server data —
 * the device's own record of what the patient did wins until the server
 * has confirmed it.
 */
async function cachePatientLocally(patient) {
  if (!localDbAvailable() || !patient) return;
  try {
    await openLocalDb();
    const now = Date.now();

    await dexieDb.transaction('rw', [dexieDb.profile, dexieDb.schedules, dexieDb.reminders, dexieDb.sessions], async () => {
      await dexieDb.profile.put({
        id: patient.id,
        username: patient.username,
        name: patient.name,
        age: patient.age,
        gender: patient.gender,
        lang: patient.lang,
        emergencyContact: patient.emergencyContact,
        wakingStart: patient.wakingStart,
        wakingEnd: patient.wakingEnd,
        // The play allowance is a CAREGIVER decision. Caching it is what
        // lets the limit hold on a device with no network — and the device
        // can only ever read it, never raise it.
        extraGameSessions: patient.play ? patient.play.granted : 0,
        maxGameSessions: patient.play ? patient.play.baseAllowance : null,
        caregivers: patient.caregivers || [],
        family: patient.family || [],
        updatedAt: now,
      });

      const serverScheduleIds = new Set();
      for (const s of patient.schedules || []) {
        serverScheduleIds.add(s.id);
        await dexieDb.schedules.put({ ...s, patientId: patient.id, updatedAt: now });
      }

      const serverReminderIds = new Set();
      const cachedDates = new Set();
      for (const r of patient.reminders || []) {
        // The server calls this field "date"; the local index is on "dueDate".
        // Without this the row misses the [patientId+dueDate] index, which
        // makes it invisible to the reminder tick, invisible to missed-dose
        // detection, and causes ensureLocalOccurrences to add a duplicate.
        const dueDate = r.dueDate || r.date || null;
        serverReminderIds.add(r.id);
        if (dueDate) cachedDates.add(dueDate);

        const existing = await dexieDb.reminders.get(r.id);
        // Do not let a stale server copy clobber an action this device
        // has taken but not yet synced.
        if (existing && existing.syncStatus === SYNC.PENDING) continue;
        await dexieDb.reminders.put({
          ...r, patientId: patient.id, dueDate, syncStatus: SYNC.SYNCED, updatedAt: now,
        });
      }

      await pruneDeletedRows(patient.id, serverScheduleIds, serverReminderIds, cachedDates);

      for (const s of patient.sessions || []) {
        const existing = await dexieDb.sessions.get(s.id);
        if (existing && existing.syncStatus === SYNC.PENDING) continue;
        await dexieDb.sessions.put({
          ...s, patientId: patient.id, completedAt: s.ts || s.completedAt || now,
          syncStatus: SYNC.SYNCED,
        });
      }
    });

    await metaSet('lastPatientCacheAt', now);
  } catch (err) {
    console.warn('[local-store] could not cache patient locally', err);
  }
}

/**
 * Drops local rows the server no longer has, so a schedule the caregiver
 * deleted stops reappearing on the device and stops generating reminders.
 *
 * Anything still PENDING is kept no matter what — an unsynced action is the
 * one thing this must never throw away. Sessions are never pruned here: the
 * server sends only the selected date range, so absence proves nothing.
 *
 * Must be called inside the caching transaction.
 */
async function pruneDeletedRows(patientId, serverScheduleIds, serverReminderIds, cachedDates) {
  const localSchedules = await dexieDb.schedules.where('patientId').equals(patientId).toArray();
  const goneSchedules = localSchedules
    .filter((s) => !serverScheduleIds.has(s.id) && s.syncStatus !== SYNC.PENDING)
    .map((s) => s.id);
  if (goneSchedules.length) await dexieDb.schedules.bulkDelete(goneSchedules);

  const goneSet = new Set(goneSchedules);
  const localReminders = await dexieDb.reminders.where('patientId').equals(patientId).toArray();
  const doomed = localReminders.filter((r) => {
    if (r.syncStatus === SYNC.PENDING) return false;      // never drop unsynced work
    if (goneSet.has(r.scheduleId)) return true;           // its schedule is gone
    // Only judge a date the server actually reported on. It sends today's
    // reminders, so a row for today that is missing from that list was
    // deleted server-side — including a local: twin now superseded by the
    // real row. Other dates were simply not part of this response.
    if (!r.dueDate || !cachedDates.has(r.dueDate)) return false;
    return !serverReminderIds.has(r.id);
  }).map((r) => r.id);
  if (doomed.length) await dexieDb.reminders.bulkDelete(doomed);
}

/** Rebuilds the in-memory patient object from IndexedDB, for offline boot. */
async function loadPatientFromLocal(patientId) {
  if (!localDbAvailable()) return null;
  await openLocalDb();

  const profile = patientId ? await dexieDb.profile.get(patientId) : (await dexieDb.profile.toArray())[0];
  if (!profile) return null;

  const today = localDateKey();
  await ensureLocalOccurrences(profile.id, today);
  await detectMissedDosesLocally(profile.id);

  const [schedules, reminders, sessions] = await Promise.all([
    dexieDb.schedules.where('patientId').equals(profile.id).toArray(),
    dexieDb.reminders.where('[patientId+dueDate]').equals([profile.id, today]).toArray(),
    dexieDb.sessions.where('patientId').equals(profile.id).toArray(),
  ]);

  sessions.sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));

  return {
    ...profile,
    schedules: schedules.filter((s) => s.status !== 'deleted')
      .sort((a, b) => String(a.time).localeCompare(String(b.time))),
    reminders: reminders.sort((a, b) => String(a.time).localeCompare(String(b.time))),
    sessions,
    metrics: computeLocalMetrics(sessions),
    rangeMetrics: computeLocalMetrics(sessions),
    reminderStats: await computeLocalReminderStats(profile.id, today),
    fromLocalCache: true,
  };
}

/** Per-domain rollup computed on the device, mirroring the server's. */
function computeLocalMetrics(sessions) {
  return Object.keys(DOMAIN_META).map((domain) => {
    const rows = sessions.filter((s) => s.domain === domain);
    const accs = rows.map((s) => s.accuracy);
    return {
      domain,
      sessions_count: rows.length,
      avg_accuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null,
      best_accuracy: accs.length ? Math.max(...accs) : null,
      avg_time_ms: rows.length ? Math.round(rows.reduce((a, s) => a + s.avgTimeMs, 0) / rows.length) : null,
      trend: 'none',
    };
  });
}

/** Adherence computed locally, using the same rule as the server. */
async function computeLocalReminderStats(patientId, dateKey) {
  const all = await dexieDb.reminders.where('patientId').equals(patientId).toArray();
  const today = all.filter((r) => r.date === dateKey || r.dueDate === dateKey);
  const count = (rows, status) => rows.filter((r) => r.status === status).length;
  const block = (rows) => {
    const completed = count(rows, 'done');
    const missed = count(rows, 'missed');
    const settled = completed + missed;
    return {
      total: rows.length, completed, missed,
      snoozed: count(rows, 'snoozed'), pending: count(rows, 'pending'),
      adherence: settled ? Math.round((completed / settled) * 100) : null,
    };
  };
  return { date: dateKey, allTime: block(all), today: block(today) };
}

/* ---------------------------------------------------------------------
   OFFLINE REMINDER GENERATION
   A mirror of the server's occursOn()/ensureOccurrences(). Keeping the
   rule on the device is what lets medication reminders fire with no
   connectivity — the device does not need to be told what is due.
--------------------------------------------------------------------- */

/* The device must generate exactly the occurrences the server would, or the
 * same dose appears twice after a sync. These mirror occurrenceTimes() and
 * wakingWindow() in backend/database.js — change one, change the other. */
const LOCAL_DEFAULT_WAKING_START = '07:00';
const LOCAL_DEFAULT_WAKING_END = '21:00';
const LOCAL_MIN_REPEAT_MINUTES = 30;
const LOCAL_MAX_REPEAT_MINUTES = 12 * 60;
const LOCAL_DEFAULT_REPEAT_MINUTES = 120;
const LOCAL_HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function localToMinutes(hhmm) {
  const m = LOCAL_HHMM.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function localToHhmm(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The patient's waking window, defaulted whenever it is missing or reversed. */
function localWakingWindow(profile) {
  const s = localToMinutes(profile && profile.wakingStart);
  const e = localToMinutes(profile && profile.wakingEnd);
  const start = s === null ? localToMinutes(LOCAL_DEFAULT_WAKING_START) : s;
  const end = e === null ? localToMinutes(LOCAL_DEFAULT_WAKING_END) : e;
  if (end <= start) {
    return {
      start: localToMinutes(LOCAL_DEFAULT_WAKING_START),
      end: localToMinutes(LOCAL_DEFAULT_WAKING_END),
    };
  }
  return { start, end };
}

/**
 * Every clock time a schedule fires on a day it occurs. One entry for an
 * ordinary schedule; for an 'interval' schedule, one per repeat between
 * waking and bedtime — never while the patient is asleep.
 */
function localOccurrenceTimes(schedule, profile) {
  const time = schedule.time || '08:00';
  if (schedule.repeat !== 'interval') return [time];

  const { start, end } = localWakingWindow(profile);
  const step = Math.min(Math.max(
    Number(schedule.repeatEveryMinutes) || LOCAL_DEFAULT_REPEAT_MINUTES,
    LOCAL_MIN_REPEAT_MINUTES), LOCAL_MAX_REPEAT_MINUTES);

  const asked = localToMinutes(time);
  const first = Math.max(asked === null ? start : asked, start);
  const times = [];
  for (let t = first; t <= end; t += step) times.push(localToHhmm(t));
  return times.length ? times : [localToHhmm(start)];
}

const LOCAL_OPEN_STATUSES = ['pending', 'snoozed'];

/** Minutes past midnight of a timestamp, on this device. */
function localMinutesOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

function localRoundUp5(mins) { return Math.ceil(mins / 5) * 5; }

/**
 * The next occurrence time for a recurring schedule, or null when one is
 * already open or the waking day is over. Mirrors nextRecurringTime() in
 * backend/database.js so the device and the server agree.
 */
function localNextRecurringTime(schedule, rows, profile) {
  const { start, end } = localWakingWindow(profile);
  const step = Math.min(Math.max(
    Number(schedule.repeatEveryMinutes) || LOCAL_DEFAULT_REPEAT_MINUTES,
    LOCAL_MIN_REPEAT_MINUTES), LOCAL_MAX_REPEAT_MINUTES);

  const mine = rows.filter((r) => r.scheduleId === schedule.id)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));

  // One live reminder at a time.
  if (mine.some((r) => LOCAL_OPEN_STATUSES.includes(r.status))) return null;

  let next;
  if (!mine.length) {
    const asked = localToMinutes(schedule.time);
    next = Math.max(asked === null ? start : asked, start);
  } else {
    const last = mine[mine.length - 1];
    const acted = last.completedAt || (last.status !== 'pending' ? last.updatedAt : null);
    const anchor = acted ? localMinutesOfDay(acted) : localToMinutes(last.time);
    next = localRoundUp5((anchor === null ? start : anchor) + step);
    if (next < start) next = start;
  }

  if (next > end) return null;
  const taken = new Set(mine.map((r) => r.time));
  let guard = 0;
  while (taken.has(localToHhmm(next)) && next <= end && guard++ < 48) next += step;
  return next <= end ? localToHhmm(next) : null;
}

function localOccursOn(schedule, dateKey) {
  if (schedule.status !== 'active') return false;
  const start = schedule.date || localDateKey(new Date(schedule.createdAt || Date.now()));
  if (dateKey < start) return false;

  const parse = (key) => { const [y, m, d] = String(key).split('-').map(Number); return new Date(y, m - 1, d); };
  switch (schedule.repeat) {
    case 'once': return dateKey === start;
    case 'daily': return true;
    case 'weekly': return parse(dateKey).getDay() === parse(start).getDay();
    case 'monthly': return parse(dateKey).getDate() === parse(start).getDate();
    default: return true;
  }
}

/**
 * Creates any missing reminder rows for `dateKey` from the locally cached
 * schedules. Idempotent — safe to call on every read.
 *
 * IDs are derived deterministically from scheduleId + date so the device
 * and the server independently generate the SAME id for the same
 * occurrence. That is what stops a day's medicine appearing twice after
 * a sync.
 */
async function ensureLocalOccurrences(patientId, dateKey) {
  if (!localDbAvailable()) return 0;
  await openLocalDb();
  const date = dateKey || localDateKey();

  const profile = await dexieDb.profile.get(patientId);
  const schedules = await dexieDb.schedules.where('patientId').equals(patientId).toArray();
  const active = schedules.filter((s) => s.status === 'active' && localOccursOn(s, date));
  let created = 0;

  await dexieDb.transaction('rw', dexieDb.reminders, async () => {
    const existing = await dexieDb.reminders
      .where('[patientId+dueDate]').equals([patientId, date]).toArray();

    for (const s of active) {
      // A recurring schedule contributes at most ONE open occurrence, so the
      // patient sees a single card that keeps coming back — not a wall of them.
      const time = s.repeat === 'interval'
        ? localNextRecurringTime(s, existing, profile)
        : (s.time || '08:00');
      if (!time) continue;
      if (existing.some((r) => r.scheduleId === s.id && r.time === time)) continue;

      const row = {
        id: `local:${s.id}:${date}:${time}`,   // deterministic, collision-free
        patientId,
        scheduleId: s.id,
        icon: s.icon || '🔔',
        type: s.category || 'General',
        title: s.title,
        text: s.description || s.notes || s.title,
        time,
        date,
        dueDate: date,
        priority: s.priority || 'normal',
        status: 'pending',
        snoozedUntil: null,
        completedAt: null,
        createdLocally: true,
        syncStatus: SYNC.SYNCED,   // the occurrence itself is derivable, not an event
        updatedAt: Date.now(),
      };
      await dexieDb.reminders.add(row);
      existing.push(row);
      created += 1;
    }
  });
  return created;
}



/* ---------------------------------------------------------------------
   PATIENT ACTIONS — local write first, always
--------------------------------------------------------------------- */

/**
 * Records a completed cognitive activity.
 * Writes the session locally and queues it; never blocks on the network.
 */
async function recordGameResultLocally(result) {
  const sessionId = newUuid();
  const now = Date.now();

  const session = {
    id: sessionId,
    patientId: result.patientId,
    domain: result.domain,
    gameType: result.gameType,
    level: result.level,
    score: result.score,
    totalRounds: result.totalRounds,
    accuracy: result.accuracy,
    avgTimeMs: result.avgTimeMs,
    answers: result.answers || [],
    completedAt: now,
    ts: now,
    time: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    date: new Date(now).toLocaleDateString(),
    syncStatus: SYNC.PENDING,
  };

  await enqueueEvent(EVENT.GAME_RESULT, { ...result, sessionId, occurredAt: now }, {
    patientId: result.patientId,
    tables: ['sessions'],
    localWrite: async () => { await dexieDb.sessions.add(session); },
  });

  return session;
}

/**
 * Records a reminder action (done / missed / snoozed).
 * Medication actions are queued as critical so they sync first.
 */
async function recordReminderActionLocally(reminderId, action, extra = {}) {
  await openLocalDb();
  const now = Date.now();
  const reminder = await dexieDb.reminders.get(reminderId);
  if (!reminder) return null;

  const updates = {
    status: action,
    updatedAt: now,
    syncStatus: SYNC.PENDING,
    completedAt: action === 'done' ? now : null,
    snoozedUntil: action === 'snoozed' ? now + (extra.minutes || 15) * 60000 : null,
  };

  await enqueueEvent(EVENT.REMINDER_ACTION, {
    reminderId,
    scheduleId: reminder.scheduleId,
    dueDate: reminder.dueDate,
    title: reminder.title,
    time: reminder.time,
    category: reminder.type,
    priority: reminder.priority,
    action,
    minutes: extra.minutes || null,
    occurredAt: now,
  }, {
    patientId: reminder.patientId,
    tables: ['reminders'],
    priority: reminder.type === 'Medicine' ? 'critical' : 'normal',
    localWrite: async () => { await dexieDb.reminders.update(reminderId, updates); },
  });

  return { ...reminder, ...updates };
}

/* ---------------------------------------------------------------------
   MISSED-DOSE DETECTION — runs on the device, needs no server
--------------------------------------------------------------------- */

const MISSED_GRACE_MINUTES = 120;

/**
 * Marks past-due reminders as missed and raises a CRITICAL ALERT for any
 * missed medication. This is the trigger for the caregiver SMS path.
 *
 * Runs entirely locally so it works with no connectivity — which is the
 * whole point: a missed dose is most likely exactly when the patient is
 * offline and unsupported.
 */
async function detectMissedDosesLocally(patientId) {
  if (!localDbAvailable()) return { missed: 0, alerts: 0 };
  await openLocalDb();

  const now = new Date();
  const today = localDateKey(now);
  const rows = await dexieDb.reminders.where('patientId').equals(patientId).toArray();

  let missed = 0;
  let alerts = 0;

  for (const r of rows) {
    if (r.status !== 'pending' && r.status !== 'snoozed') continue;
    if (r.status === 'snoozed' && r.snoozedUntil && r.snoozedUntil > Date.now()) continue;
    if (!r.dueDate) continue;

    let overdue = r.dueDate < today;
    let dueMs = null;
    if (!overdue && r.dueDate === today && r.time) {
      const [h, m] = String(r.time).split(':').map(Number);
      if (Number.isFinite(h) && Number.isFinite(m)) {
        const due = new Date(now); due.setHours(h, m, 0, 0);
        dueMs = due.getTime();
        overdue = now.getTime() - dueMs > MISSED_GRACE_MINUTES * 60000;
      }
    }
    // A reminder created after its own time was never missable.
    if (overdue && r.status === 'pending' && dueMs !== null && r.updatedAt > dueMs) continue;
    if (!overdue) continue;

    await dexieDb.reminders.update(r.id, { status: 'missed', updatedAt: Date.now(), syncStatus: SYNC.PENDING });
    missed += 1;

    await enqueueEvent(EVENT.REMINDER_ACTION, {
      reminderId: r.id, scheduleId: r.scheduleId, dueDate: r.dueDate,
      title: r.title, time: r.time, category: r.type, priority: r.priority,
      action: 'missed', detectedOffline: !isOnline(), occurredAt: Date.now(),
    }, { patientId, priority: r.type === 'Medicine' ? 'critical' : 'normal' });

    // Medication is the case that needs a human told.
    if (r.type === 'Medicine' || r.priority === 'high') {
      await raiseMissedDoseAlert(patientId, r);
      alerts += 1;
    }
  }

  if (missed > 0 && typeof refreshConnectivityIndicators === 'function') refreshConnectivityIndicators();
  return { missed, alerts };
}

/**
 * Creates a critical alert for a missed dose and queues it for delivery.
 *
 * Delivery itself happens server-side (SMS to the caregiver) — see
 * backend/sms_service.js. The device's job is to make sure the alert
 * EXISTS and is never lost, however long the phone stays offline.
 */
async function raiseMissedDoseAlert(patientId, reminder) {
  await openLocalDb();

  // One alert per missed occurrence, ever. The deterministic id makes a
  // repeat detection pass a no-op rather than a second SMS.
  const alertId = `alert:${reminder.id}`;
  const existing = await dexieDb.alerts.get(alertId);
  if (existing) return existing;

  const profile = await dexieDb.profile.get(patientId);
  const alert = {
    id: alertId,
    patientId,
    type: 'missed_medication',
    severity: 'critical',
    reminderId: reminder.id,
    scheduleId: reminder.scheduleId,
    title: reminder.title,
    dueDate: reminder.dueDate,
    dueTime: reminder.time,
    patientName: profile ? profile.name : null,
    detectedOffline: !isOnline(),
    createdAt: Date.now(),
    deliveryStatus: 'queued',       // queued -> sent -> delivered / failed
    deliveryAttempts: [],
    syncStatus: SYNC.PENDING,
  };

  await enqueueEvent(EVENT.MISSED_DOSE_ALERT, {
    alertId, reminderId: reminder.id, scheduleId: reminder.scheduleId,
    title: reminder.title, dueDate: reminder.dueDate, dueTime: reminder.time,
    severity: 'critical', detectedOffline: !isOnline(), occurredAt: Date.now(),
  }, {
    patientId,
    tables: ['alerts'],
    priority: 'critical',
    localWrite: async () => { await dexieDb.alerts.add(alert); },
  });

  return alert;
}

/** Alerts still waiting to reach a caregiver, for the offline panel. */
async function pendingAlerts(patientId) {
  await openLocalDb();
  return dexieDb.alerts
    .where('patientId').equals(patientId)
    .filter((a) => a.syncStatus !== SYNC.SYNCED)
    .reverse().toArray();
}
