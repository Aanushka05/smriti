// routes/schedules.js — the caregiver schedule system and the reminder
// occurrences it produces.
//
//   Caregiver adds a schedule  ->  schedules row
//        ensureOccurrences()   ->  one reminder row per due date
//        patient dashboard     ->  reads those reminder rows
//        patient acts on one   ->  status done / snoozed / missed
//        adherence + caregiver dashboard update from those same rows
//
// Nothing here is generated for display: every number the dashboards show
// comes back out of these tables.

const express = require('express');
const {
  db, uuid, toDateKey, refreshPatientSchedule, ensureOccurrences,
  reminderStats, notifyCaregivers,
} = require('../database');
const { requireAuth, requirePatientAccess } = require('../middleware/auth');
const realtime = require('../realtime');

const router = express.Router();

const REPEATS = ['once', 'daily', 'weekly', 'monthly'];
const PRIORITIES = ['low', 'normal', 'high'];
const REMINDER_TYPES = ['app', 'voice', 'both', 'none'];
const CATEGORIES = ['Medicine', 'Meal', 'Hydration', 'Exercise', 'Appointment', 'Activity', 'Therapy', 'General'];
const CATEGORY_ICONS = {
  Medicine: '💊', Meal: '🍽️', Hydration: '💧', Exercise: '🚶', Appointment: '📅',
  Activity: '🧶', Therapy: '🧠', General: '🔔',
};
const STATUSES = ['pending', 'done', 'missed', 'snoozed'];
const SNOOZE_MIN = 5;
const SNOOZE_MAX = 180;

// --------------------------------------------------------------- shapes
function schedulePublic(s) {
  return {
    id: s.id,
    patientId: s.patient_id,
    title: s.title,
    description: s.description || '',
    category: s.category || 'General',
    icon: s.icon || CATEGORY_ICONS[s.category] || '🔔',
    date: s.scheduled_date || null,
    time: s.scheduled_time || null,
    repeat: s.repeat_rule || 'daily',
    reminderType: s.reminder_type || 'app',
    priority: s.priority || 'normal',
    notes: s.notes || '',
    status: s.status || 'active',
    createdBy: s.created_by,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

function reminderPublic(r) {
  return {
    id: r.id,
    patientId: r.patient_id,
    scheduleId: r.schedule_id || null,
    icon: r.icon || '🔔',
    type: r.type || 'General',
    title: r.title,
    text: r.text || '',
    time: r.time || '',
    date: r.due_date || null,
    priority: r.priority || 'normal',
    status: r.status || 'pending',
    snoozedUntil: r.snoozed_until || null,
    completedAt: r.completed_at || null,
    updatedAt: r.updated_at,
  };
}

function fail(res, status, error, field) {
  return res.status(status).json({ error, field: field || null });
}

/** Shared validation for create and update. Returns a clean record or null. */
function readScheduleInput(body, res, existing) {
  const b = body || {};
  const pick = (key, fallback) => (b[key] === undefined ? fallback : b[key]);

  const title = String(pick('title', existing && existing.title) || '').trim();
  if (!title) { fail(res, 400, 'Please enter the activity or task name.', 'title'); return null; }
  if (title.length > 120) { fail(res, 400, 'The activity name is too long (120 characters maximum).', 'title'); return null; }

  const time = String(pick('time', existing && existing.scheduled_time) || '').trim();
  if (!/^\d{2}:\d{2}$/.test(time)) { fail(res, 400, 'Please choose a time (HH:MM).', 'time'); return null; }

  const repeat = String(pick('repeat', (existing && existing.repeat_rule) || 'daily'));
  if (!REPEATS.includes(repeat)) { fail(res, 400, `Repeat must be one of: ${REPEATS.join(', ')}.`, 'repeat'); return null; }

  let date = pick('date', existing && existing.scheduled_date);
  date = date ? String(date).trim() : '';
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail(res, 400, 'Please enter the date as YYYY-MM-DD.', 'date'); return null;
  }
  // A one-off needs a concrete day; a repeating one starts today by default.
  if (!date) {
    if (repeat === 'once') { fail(res, 400, 'A one-time activity needs a date.', 'date'); return null; }
    date = toDateKey(new Date());
  }

  const priority = String(pick('priority', (existing && existing.priority) || 'normal'));
  if (!PRIORITIES.includes(priority)) { fail(res, 400, `Priority must be one of: ${PRIORITIES.join(', ')}.`, 'priority'); return null; }

  const reminderType = String(pick('reminderType', (existing && existing.reminder_type) || 'app'));
  if (!REMINDER_TYPES.includes(reminderType)) {
    fail(res, 400, `Reminder type must be one of: ${REMINDER_TYPES.join(', ')}.`, 'reminderType'); return null;
  }

  const category = CATEGORIES.includes(pick('category', existing && existing.category))
    ? String(pick('category', existing && existing.category)) : 'General';

  return {
    title,
    description: String(pick('description', (existing && existing.description) || '') || '').trim(),
    category,
    icon: String(pick('icon', (existing && existing.icon) || '') || '').trim() || CATEGORY_ICONS[category],
    date,
    time,
    repeat,
    reminderType,
    priority,
    notes: String(pick('notes', (existing && existing.notes) || '') || '').trim(),
  };
}

// =============================================================== SCHEDULES

// GET /api/patients/:patientId/schedules
router.get('/patients/:patientId/schedules', requireAuth, requirePatientAccess, (req, res) => {
  refreshPatientSchedule(req.patientId);
  const rows = db.prepare(`SELECT * FROM schedules WHERE patient_id=? AND status != 'deleted'
    ORDER BY scheduled_time, title`).all(req.patientId);
  res.json({ schedules: rows.map(schedulePublic) });
});

// GET /api/patients/:patientId/schedules/upcoming?days=7
router.get('/patients/:patientId/schedules/upcoming', requireAuth, requirePatientAccess, (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
  refreshPatientSchedule(req.patientId);

  // Materialise the coming days so "upcoming" is real rows, not a forecast.
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const key = toDateKey(d);
    ensureOccurrences(req.patientId, key);
    const rows = db.prepare(`SELECT * FROM reminders WHERE patient_id=? AND due_date=?
      ORDER BY time`).all(req.patientId, key);
    if (rows.length) out.push({ date: key, items: rows.map(reminderPublic) });
  }
  res.json({ days, upcoming: out });
});

// POST /api/patients/:patientId/schedules
router.post('/patients/:patientId/schedules', requireAuth, requirePatientAccess, (req, res) => {
  const input = readScheduleInput(req.body, res, null);
  if (!input) return undefined;

  const id = uuid();
  const now = Date.now();
  db.prepare(`INSERT INTO schedules
    (id,patient_id,created_by,title,description,category,icon,scheduled_date,scheduled_time,
     repeat_rule,reminder_type,priority,notes,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`).run(
    id, req.patientId, req.user.id, input.title, input.description, input.category, input.icon,
    input.date, input.time, input.repeat, input.reminderType, input.priority, input.notes, now, now
  );

  // Create today's card straight away so the patient sees it immediately.
  refreshPatientSchedule(req.patientId);
  realtime.publish(req.patientId, 'schedule:created', { scheduleId: id, title: input.title });

  const row = db.prepare('SELECT * FROM schedules WHERE id=?').get(id);
  return res.status(201).json({
    ok: true, schedule: schedulePublic(row),
    message: `"${input.title}" added to the schedule.`,
  });
});

// PUT /api/schedules/:scheduleId
router.put('/schedules/:scheduleId', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params.scheduleId);
  if (!existing) return fail(res, 404, 'Schedule not found.');
  req.params.patientId = existing.patient_id;

  return requirePatientAccess(req, res, () => {
    const input = readScheduleInput(req.body, res, existing);
    if (!input) return undefined;

    db.prepare(`UPDATE schedules SET title=?, description=?, category=?, icon=?, scheduled_date=?,
      scheduled_time=?, repeat_rule=?, reminder_type=?, priority=?, notes=?, updated_at=? WHERE id=?`).run(
      input.title, input.description, input.category, input.icon, input.date, input.time,
      input.repeat, input.reminderType, input.priority, input.notes, Date.now(), existing.id
    );

    // Rebuild any not-yet-actioned occurrences so edits show up at once;
    // anything already completed or missed is history and stays untouched.
    db.prepare("DELETE FROM reminders WHERE schedule_id=? AND status IN ('pending','snoozed')").run(existing.id);
    refreshPatientSchedule(existing.patient_id);
    realtime.publish(existing.patient_id, 'schedule:updated', { scheduleId: existing.id, title: input.title });

    const row = db.prepare('SELECT * FROM schedules WHERE id=?').get(existing.id);
    return res.json({ ok: true, schedule: schedulePublic(row), message: 'Schedule updated.' });
  });
});

// DELETE /api/schedules/:scheduleId
router.delete('/schedules/:scheduleId', requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params.scheduleId);
  if (!existing) return fail(res, 404, 'Schedule not found.');
  req.params.patientId = existing.patient_id;

  return requirePatientAccess(req, res, () => {
    db.transaction(() => {
      // Drop future/pending cards, keep the completed + missed history so
      // past adherence figures do not silently change.
      db.prepare("DELETE FROM reminders WHERE schedule_id=? AND status IN ('pending','snoozed')").run(existing.id);
      db.prepare("UPDATE schedules SET status='deleted', updated_at=? WHERE id=?").run(Date.now(), existing.id);
    })();
    realtime.publish(existing.patient_id, 'schedule:deleted', { scheduleId: existing.id });
    return res.json({ ok: true, message: `"${existing.title}" removed from the schedule.` });
  });
});

// =============================================================== REMINDERS

// GET /api/patients/:patientId/reminders?date=YYYY-MM-DD
router.get('/patients/:patientId/reminders', requireAuth, requirePatientAccess, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : toDateKey(new Date());
  refreshPatientSchedule(req.patientId, date);

  const today = db.prepare('SELECT * FROM reminders WHERE patient_id=? AND due_date=? ORDER BY time').all(req.patientId, date);
  const undated = db.prepare('SELECT * FROM reminders WHERE patient_id=? AND due_date IS NULL ORDER BY time').all(req.patientId);
  const recent = db.prepare(`SELECT * FROM reminders WHERE patient_id=? AND due_date < ?
    ORDER BY due_date DESC, time DESC LIMIT 20`).all(req.patientId, date);

  res.json({
    date,
    reminders: [...today, ...undated].map(reminderPublic),
    recent: recent.map(reminderPublic),
    stats: reminderStats(req.patientId, date),
  });
});

// GET /api/patients/:patientId/reminders/next — the one coming up
router.get('/patients/:patientId/reminders/next', requireAuth, requirePatientAccess, (req, res) => {
  refreshPatientSchedule(req.patientId);
  // Look ahead a few days so "next" still has an answer once today's
  // reminders are all done.
  for (let i = 1; i <= 3; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    ensureOccurrences(req.patientId, toDateKey(d));
  }
  const today = toDateKey(new Date());
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const next = db.prepare(`SELECT * FROM reminders
    WHERE patient_id=? AND status IN ('pending','snoozed')
      AND (due_date > ? OR (due_date = ? AND time >= ?))
    ORDER BY due_date, time LIMIT 1`).get(req.patientId, today, today, currentTime)
    || db.prepare(`SELECT * FROM reminders WHERE patient_id=? AND due_date=? AND status IN ('pending','snoozed')
       ORDER BY time LIMIT 1`).get(req.patientId, today);

  res.json({ next: next ? reminderPublic(next) : null });
});

// POST /api/patients/:patientId/reminders — a one-off card, no schedule
router.post('/patients/:patientId/reminders', requireAuth, requirePatientAccess, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const time = String(b.time || '').trim();
  if (!title) return fail(res, 400, 'Reminder title is required.', 'title');
  if (!/^\d{2}:\d{2}$/.test(time)) return fail(res, 400, 'Time must be in HH:MM format.', 'time');

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? b.date : toDateKey(new Date());
  const category = CATEGORIES.includes(b.type) ? b.type : 'General';
  const id = uuid();
  db.prepare(`INSERT INTO reminders
    (id,patient_id,schedule_id,icon,type,title,time,text,due_date,priority,status,updated_at)
    VALUES (?,?,NULL,?,?,?,?,?,?,?,'pending',?)`).run(
    id, req.patientId, b.icon || CATEGORY_ICONS[category], category, title, time,
    String(b.text || title).trim(), date, PRIORITIES.includes(b.priority) ? b.priority : 'normal', Date.now()
  );
  realtime.publish(req.patientId, 'reminder:created', { reminderId: id, title });

  const row = db.prepare('SELECT * FROM reminders WHERE id=?').get(id);
  res.status(201).json({ ok: true, reminder: reminderPublic(row), message: 'Reminder added.' });
});

/** Shared status change used by done / missed / pending. */
function setReminderStatus(req, res, status) {
  const reminder = db.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.reminderId);
  if (!reminder) return fail(res, 404, 'Reminder not found.');
  req.params.patientId = reminder.patient_id;

  return requirePatientAccess(req, res, () => {
    const now = Date.now();
    db.prepare('UPDATE reminders SET status=?, completed_at=?, snoozed_until=NULL, updated_at=? WHERE id=?')
      .run(status, status === 'done' ? now : null, now, reminder.id);

    if (status === 'done') {
      const patient = db.prepare('SELECT name FROM patients WHERE id=?').get(reminder.patient_id);
      notifyCaregivers(
        reminder.patient_id,
        `${patient.name} completed "${reminder.title}"`,
        `Marked done at ${new Date(now).toLocaleTimeString()}`, 'info'
      );
    }
    realtime.publish(reminder.patient_id, 'reminder:updated', { reminderId: reminder.id, status });

    const row = db.prepare('SELECT * FROM reminders WHERE id=?').get(reminder.id);
    return res.json({
      ok: true, reminder: reminderPublic(row),
      stats: reminderStats(reminder.patient_id),
    });
  });
}

// PUT /api/reminders/:reminderId  { status }
router.put('/reminders/:reminderId', requireAuth, (req, res) => {
  const status = (req.body || {}).status;
  if (!STATUSES.includes(status)) {
    return fail(res, 400, `Status must be one of: ${STATUSES.join(', ')}.`, 'status');
  }
  if (status === 'snoozed') {
    return fail(res, 400, 'Use POST /api/reminders/:id/snooze to snooze a reminder.', 'status');
  }
  return setReminderStatus(req, res, status);
});

// POST /api/reminders/:reminderId/complete
router.post('/reminders/:reminderId/complete', requireAuth, (req, res) => setReminderStatus(req, res, 'done'));

// POST /api/reminders/:reminderId/miss
router.post('/reminders/:reminderId/miss', requireAuth, (req, res) => setReminderStatus(req, res, 'missed'));

// POST /api/reminders/:reminderId/snooze  { minutes }
router.post('/reminders/:reminderId/snooze', requireAuth, (req, res) => {
  const minutes = Number((req.body || {}).minutes) || 15;
  if (minutes < SNOOZE_MIN || minutes > SNOOZE_MAX) {
    return fail(res, 400, `Snooze must be between ${SNOOZE_MIN} and ${SNOOZE_MAX} minutes.`, 'minutes');
  }
  const reminder = db.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.reminderId);
  if (!reminder) return fail(res, 404, 'Reminder not found.');
  if (reminder.status === 'done') return fail(res, 409, 'That reminder is already done.');
  req.params.patientId = reminder.patient_id;

  return requirePatientAccess(req, res, () => {
    const until = Date.now() + minutes * 60000;
    db.prepare("UPDATE reminders SET status='snoozed', snoozed_until=?, updated_at=? WHERE id=?")
      .run(until, Date.now(), reminder.id);
    realtime.publish(reminder.patient_id, 'reminder:updated', { reminderId: reminder.id, status: 'snoozed' });

    const row = db.prepare('SELECT * FROM reminders WHERE id=?').get(reminder.id);
    return res.json({
      ok: true, reminder: reminderPublic(row), stats: reminderStats(reminder.patient_id),
      message: `Snoozed for ${minutes} minutes.`,
    });
  });
});

// DELETE /api/reminders/:reminderId — removes one occurrence only
router.delete('/reminders/:reminderId', requireAuth, (req, res) => {
  const reminder = db.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.reminderId);
  if (!reminder) return fail(res, 404, 'Reminder not found.');
  req.params.patientId = reminder.patient_id;

  return requirePatientAccess(req, res, () => {
    db.prepare('DELETE FROM reminders WHERE id=?').run(reminder.id);
    realtime.publish(reminder.patient_id, 'reminder:deleted', { reminderId: reminder.id });
    return res.json({ ok: true, stats: reminderStats(reminder.patient_id) });
  });
});

// GET /api/patients/:patientId/adherence
router.get('/patients/:patientId/adherence', requireAuth, requirePatientAccess, (req, res) => {
  refreshPatientSchedule(req.patientId);
  res.json(reminderStats(req.patientId));
});

module.exports = {
  router, schedulePublic, reminderPublic,
  REPEATS, PRIORITIES, REMINDER_TYPES, CATEGORIES, CATEGORY_ICONS,
};
