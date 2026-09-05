// routes/patients.js — patient records, caregiver↔patient linking, game
// results, reminders, schedules and notifications for SmritiSaathi Care.
//
// Every route here is authenticated. Anything addressed at a specific
// patient additionally goes through requirePatientAccess, so a caregiver
// can only ever see patients linked to their own account and a patient can
// only ever see themselves.

const express = require('express');
const bcrypt = require('bcryptjs');
const {
  db, uuid, recomputeMetrics, notifyCaregivers, DOMAINS,
  refreshPatientSchedule, reminderStats, toDateKey,
} = require('../database');
const { requireAuth, requireRole, requirePatientAccess } = require('../middleware/auth');
const {
  patientPublic, caregiverPatients, createPatient, linkCaregiverPatient,
  usernameTaken, normUsername, USERNAME_RE, MIN_PASSWORD,
} = require('./auth');
const { schedulePublic, reminderPublic } = require('./schedules');
const realtime = require('../realtime');

const router = express.Router();

// ------------------------------------------------------------- helpers
/**
 * The whole patient record the dashboards read.
 *
 * `range` ({from, to} in ms) filters the SESSIONS, which is what makes the
 * date picker affect the charts, the performance figures and the recent
 * sessions table together — they all read this one object. Reminders and
 * schedules are always "today", because that is what those panels mean.
 * `metrics` stays the all-time rollup and is labelled as such in the UI.
 */
function fullPatient(id, range) {
  const patient = db.prepare('SELECT * FROM patients WHERE id=?').get(id);
  if (!patient) return null;
  const from = range && Number.isFinite(range.from) ? range.from : 0;
  const to = range && Number.isFinite(range.to) ? range.to : Date.now();

  const family = db.prepare('SELECT id,name,relation,initial,color FROM family_members WHERE patient_id=?').all(id);
  const sessions = db.prepare(
    'SELECT * FROM sessions WHERE patient_id=? AND completed_at BETWEEN ? AND ? ORDER BY completed_at ASC'
  ).all(id, from, to)
    .map((s) => ({
      id: s.id, domain: s.domain, gameType: s.game_type, level: s.level, score: s.score,
      totalRounds: s.total_rounds, accuracy: s.accuracy, avgTimeMs: s.avg_time_ms,
      ts: s.completed_at,
      time: new Date(s.completed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      date: new Date(s.completed_at).toLocaleDateString(),
    }));
  // Bring today's reminder occurrences up to date before reading them, so
  // a schedule the caregiver added a moment ago is already visible here.
  refreshPatientSchedule(id);
  const today = toDateKey(new Date());
  const reminders = db.prepare(`SELECT * FROM reminders WHERE patient_id=? AND (due_date=? OR due_date IS NULL)
    ORDER BY time`).all(id, today).map(reminderPublic);
  const schedules = db.prepare(`SELECT * FROM schedules WHERE patient_id=? AND status != 'deleted'
    ORDER BY scheduled_time`).all(id).map(schedulePublic);
  const metrics = db.prepare('SELECT * FROM performance_metrics WHERE patient_id=?').all(id);
  const caregivers = db.prepare(`SELECT c.id,c.username,c.name,c.relationship FROM caregivers c
     JOIN caregiver_patients cp ON cp.caregiver_id=c.id WHERE cp.patient_id=?`).all(id);

  // Per-area figures for the SELECTED RANGE, so the charts and the KPI
  // cards move together when the caregiver changes the date filter.
  const rangeMetrics = DOMAINS.map((domain) => {
    const rows = sessions.filter((s) => s.domain === domain);
    const accs = rows.map((s) => s.accuracy);
    return {
      domain,
      sessions_count: rows.length,
      avg_accuracy: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null,
      best_accuracy: accs.length ? Math.max(...accs) : null,
      avg_time_ms: rows.length ? Math.round(rows.reduce((a, s) => a + s.avgTimeMs, 0) / rows.length) : null,
    };
  });

  return {
    id: patient.id, username: patient.username, name: patient.name, age: patient.age,
    gender: patient.gender, lang: patient.lang, mobile: patient.mobile,
    emergencyContact: patient.emergency_contact, createdAt: patient.created_at,
    range: { from, to },
    family, sessions, reminders, schedules, metrics, rangeMetrics, caregivers,
    reminderStats: reminderStats(id, today),
  };
}

/** Small rollup used by the caregiver's "My Patients" cards. All figures
 * are read straight out of the tables — null means "nothing recorded yet",
 * which the UI renders as an empty state rather than a zero. */
function patientSummary(row) {
  refreshPatientSchedule(row.id);
  const s = db.prepare(`SELECT COUNT(*) c, AVG(accuracy) a, MAX(completed_at) last
                        FROM sessions WHERE patient_id=?`).get(row.id);
  const stats = reminderStats(row.id);
  const declining = db.prepare(`SELECT domain FROM performance_metrics WHERE patient_id=? AND trend='declining'`)
    .all(row.id).map((r) => r.domain);
  return {
    id: row.id, username: row.username, name: row.name, age: row.age, gender: row.gender, lang: row.lang,
    totalSessions: s.c || 0,
    overallAccuracy: s.c ? Math.round(s.a * 100) : null,
    lastSessionAt: s.last || null,
    reminderCompletion: stats.allTime.adherence,
    remindersToday: stats.today,
    decliningDomains: declining,
  };
}

// ================================================== CAREGIVER ↔ PATIENTS

// GET /api/caregiver/patients — the caregiver's own linked patients
router.get('/caregiver/patients', requireAuth, requireRole('caregiver'), (req, res) => {
  const rows = caregiverPatients(req.user.id);
  res.json({ patients: rows.map(patientSummary) });
});

// GET /api/caregiver/overview — the numbers across ALL of this caregiver's
// patients, for the dashboard's top row. Counted from stored rows; a figure
// with nothing behind it comes back null so the UI shows a dash.
router.get('/caregiver/overview', requireAuth, requireRole('caregiver'), (req, res) => {
  const patients = caregiverPatients(req.user.id);
  const today = toDateKey(new Date());

  let todaysReminders = 0;
  let completedToday = 0;
  let missedToday = 0;
  let snoozedToday = 0;
  let accuracySum = 0;
  let accuracyCount = 0;
  let sessionsToday = 0;

  for (const p of patients) {
    refreshPatientSchedule(p.id, today);

    const counts = db.prepare(`SELECT
        COUNT(*) total,
        SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
        SUM(CASE WHEN status='missed' THEN 1 ELSE 0 END) missed,
        SUM(CASE WHEN status='snoozed' THEN 1 ELSE 0 END) snoozed
      FROM reminders WHERE patient_id=? AND due_date=?`).get(p.id, today);

    todaysReminders += counts.total || 0;
    completedToday += counts.done || 0;
    missedToday += counts.missed || 0;
    snoozedToday += counts.snoozed || 0;

    // Average patient performance = the mean of each patient's own average,
    // so one very active patient cannot dominate the figure.
    const perf = db.prepare('SELECT AVG(accuracy) a, COUNT(*) c FROM sessions WHERE patient_id=?').get(p.id);
    if (perf.c > 0) { accuracySum += perf.a; accuracyCount += 1; }

    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    sessionsToday += db.prepare('SELECT COUNT(*) c FROM sessions WHERE patient_id=? AND completed_at >= ?')
      .get(p.id, startOfDay.getTime()).c;
  }

  const settledToday = completedToday + missedToday;
  res.json({
    date: today,
    totalPatients: patients.length,
    todaysReminders,
    completedToday,
    missedToday,
    snoozedToday,
    pendingToday: todaysReminders - completedToday - missedToday - snoozedToday,
    todaysAdherence: settledToday ? Math.round((completedToday / settledToday) * 100) : null,
    averagePerformance: accuracyCount ? Math.round((accuracySum / accuracyCount) * 100) : null,
    patientsWithData: accuracyCount,
    sessionsToday,
  });
});

// POST /api/caregiver/patients — "Add Patient".
// mode: 'link'   -> connect an existing patient by username / patient ID / mobile
// mode: 'create' -> register a brand-new patient account and link it
router.post('/caregiver/patients', requireAuth, requireRole('caregiver'), (req, res) => {
  const b = req.body || {};
  const mode = b.mode === 'create' ? 'create' : 'link';

  if (mode === 'link') {
    const key = String(b.patientUsername || b.patientId || b.identifier || b.patientMobile || '').trim();
    if (!key) return res.status(400).json({ error: 'Enter the Patient ID, username or mobile number.', field: 'identifier' });
    const patient = db.prepare('SELECT * FROM patients WHERE lower(username)=? OR id=? OR mobile=?')
      .get(key.toLowerCase(), key, key);
    if (!patient) return res.status(404).json({ error: `No patient found for "${key}".`, field: 'identifier' });

    const already = db.prepare('SELECT 1 FROM caregiver_patients WHERE caregiver_id=? AND patient_id=?')
      .get(req.user.id, patient.id);
    if (already) return res.status(409).json({ error: `${patient.name} is already in your patient list.`, field: 'identifier' });

    linkCaregiverPatient(req.user.id, patient.id);
    return res.status(201).json({
      ok: true, linked: true, patient: patientSummary(patient),
      message: `${patient.name} is now connected to your account.`,
    });
  }

  // ---- create a new patient account, owned by this caregiver ----
  const name = String(b.name || b.fullName || '').trim();
  const username = normUsername(b.username);
  if (!name) return res.status(400).json({ error: 'Please enter the full name.', field: 'name' });
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-30 characters (letters, numbers, dots, underscores).', field: 'username' });
  }
  if (usernameTaken(username)) {
    return res.status(409).json({ error: 'That username is already taken.', field: 'username' });
  }
  if (!b.password || String(b.password).length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.`, field: 'password' });
  }
  if (b.confirmPassword !== undefined && String(b.password) !== String(b.confirmPassword)) {
    return res.status(400).json({ error: 'Password and Confirm Password do not match.', field: 'confirmPassword' });
  }
  const age = b.age === '' || b.age == null ? null : Number(b.age);
  if (age !== null && (!Number.isFinite(age) || age < 1 || age > 120)) {
    return res.status(400).json({ error: 'Please enter a valid age between 1 and 120.', field: 'age' });
  }
  const mobile = String(b.mobile || '').trim() || null;
  if (mobile && db.prepare('SELECT id FROM patients WHERE mobile=?').get(mobile)) {
    return res.status(409).json({ error: 'A patient with this mobile number already exists.', field: 'mobile' });
  }

  const created = db.transaction(() => {
    const row = createPatient({
      name, username, password: b.password, age, gender: b.gender, lang: b.lang,
      mobile, emergencyContact: b.emergencyContact, createdBy: req.user.id,
    });
    linkCaregiverPatient(req.user.id, row.id);
    return row;
  })();

  res.status(201).json({
    ok: true, created: true, patient: patientSummary(created), profile: patientPublic(created),
    message: `${created.name} has been registered and connected. They can log in with the username "${created.username}".`,
  });
});

// DELETE /api/caregiver/patients/:patientId — unlink (never deletes the
// patient's own account or their history)
router.delete('/caregiver/patients/:patientId', requireAuth, requireRole('caregiver'), requirePatientAccess, (req, res) => {
  db.prepare('DELETE FROM caregiver_patients WHERE caregiver_id=? AND patient_id=?').run(req.user.id, req.patientId);
  res.json({ ok: true, message: 'Patient removed from your list. Their account and history are unchanged.' });
});

// GET /api/patients — list, restricted by role
router.get('/patients', requireAuth, (req, res) => {
  if (req.user.role === 'caregiver') return res.json(caregiverPatients(req.user.id));
  const row = db.prepare('SELECT id,username,name,age,gender,lang FROM patients WHERE id=?').get(req.user.id);
  res.json(row ? [row] : []);
});

// GET /api/patients/:patientId?from=&to= — single source of truth for the
// frontend. The optional range filters the sessions, which is what makes
// one date picker drive the charts, KPIs and session list together.
router.get('/patients/:patientId', requireAuth, requirePatientAccess, (req, res) => {
  const from = req.query.from ? Number(req.query.from) : undefined;
  const to = req.query.to ? Number(req.query.to) : undefined;
  if (req.query.from && !Number.isFinite(from)) {
    return res.status(400).json({ error: 'from must be a timestamp in milliseconds.', field: 'from' });
  }
  if (req.query.to && !Number.isFinite(to)) {
    return res.status(400).json({ error: 'to must be a timestamp in milliseconds.', field: 'to' });
  }
  return res.json(fullPatient(req.patientId, { from, to }));
});

// PUT /api/patients/:patientId — profile edits (name, age, gender, language…)
router.put('/patients/:patientId', requireAuth, requirePatientAccess, (req, res) => {
  const b = req.body || {};
  const current = db.prepare('SELECT * FROM patients WHERE id=?').get(req.patientId);
  const age = b.age === '' || b.age == null ? current.age : Number(b.age);
  if (age !== null && age !== undefined && (!Number.isFinite(age) || age < 1 || age > 120)) {
    return res.status(400).json({ error: 'Please enter a valid age between 1 and 120.', field: 'age' });
  }
  db.prepare(`UPDATE patients SET name=?, age=?, gender=?, lang=?, emergency_contact=? WHERE id=?`).run(
    String(b.name || current.name).trim(), age, b.gender || current.gender,
    b.lang || current.lang, b.emergencyContact !== undefined ? b.emergencyContact : current.emergency_contact,
    req.patientId
  );
  res.json({ ok: true, patient: fullPatient(req.patientId) });
});

// POST /api/patients/:patientId/password — caregiver or the patient can
// reset the patient's password. Hashed, never echoed back.
router.post('/patients/:patientId/password', requireAuth, requirePatientAccess, (req, res) => {
  const { password, confirmPassword } = req.body || {};
  if (!password || String(password).length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters.`, field: 'password' });
  }
  if (confirmPassword !== undefined && String(password) !== String(confirmPassword)) {
    return res.status(400).json({ error: 'Password and Confirm Password do not match.', field: 'confirmPassword' });
  }
  db.prepare('UPDATE patients SET pin_hash=? WHERE id=?').run(bcrypt.hashSync(String(password), 8), req.patientId);
  res.json({ ok: true, message: 'Password updated.' });
});

// ------------------------------------------------------- FAMILY MEMBERS
router.post('/patients/:patientId/family', requireAuth, requirePatientAccess, (req, res) => {
  const { name, relation, color } = req.body || {};
  if (!name || !relation) return res.status(400).json({ error: 'Name and relation are required.', field: 'name' });
  const palette = ['#6B2737', '#3E5C3A', '#C88B2E', '#4A5C7A', '#8B5E34', '#7A4A6B'];
  const count = db.prepare('SELECT COUNT(*) c FROM family_members WHERE patient_id=?').get(req.patientId).c;
  db.prepare('INSERT INTO family_members (id,patient_id,name,relation,initial,color) VALUES (?,?,?,?,?,?)')
    .run(uuid(), req.patientId, String(name).trim(), String(relation).trim(),
      String(name).trim().slice(0, 2), color || palette[count % palette.length]);
  res.status(201).json({ ok: true, patient: fullPatient(req.patientId) });
});

router.delete('/patients/:patientId/family/:memberId', requireAuth, requirePatientAccess, (req, res) => {
  const info = db.prepare('DELETE FROM family_members WHERE id=? AND patient_id=?').run(req.params.memberId, req.patientId);
  if (!info.changes) return res.status(404).json({ error: 'Family member not found.' });
  res.json({ ok: true, patient: fullPatient(req.patientId) });
});

// =============================================== SESSIONS / GAME RESULTS
router.get('/patients/:patientId/sessions', requireAuth, requirePatientAccess, (req, res) => {
  res.json(fullPatient(req.patientId).sessions);
});

router.get('/patients/:patientId/metrics', requireAuth, requirePatientAccess, (req, res) => {
  res.json(db.prepare('SELECT * FROM performance_metrics WHERE patient_id=?').all(req.patientId));
});

// POST /api/game-results — append-only; never overwrites history
router.post('/game-results', requireAuth, requirePatientAccess, (req, res) => {
  const { domain, gameType, level, score, totalRounds, accuracy, avgTimeMs, answers } = req.body || {};
  if (!DOMAINS.includes(domain)) {
    return res.status(400).json({ error: `domain must be one of ${DOMAINS.join(', ')}.`, field: 'domain' });
  }
  const acc = Number(accuracy);
  const avg = Number(avgTimeMs);
  if (!Number.isFinite(acc) || acc < 0 || acc > 1) {
    return res.status(400).json({ error: 'accuracy must be a number between 0 and 1.', field: 'accuracy' });
  }
  if (!Number.isFinite(avg) || avg < 0) {
    return res.status(400).json({ error: 'avgTimeMs must be a positive number.', field: 'avgTimeMs' });
  }

  const id = uuid();
  db.prepare(`INSERT INTO sessions
    (id,patient_id,domain,game_type,level,score,total_rounds,accuracy,avg_time_ms,answers,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, req.patientId, domain, gameType || null, level || null, score == null ? null : Number(score),
    totalRounds == null ? null : Number(totalRounds), acc, Math.round(avg), JSON.stringify(answers || []), Date.now()
  );
  recomputeMetrics(req.patientId);

  const patientName = db.prepare('SELECT name FROM patients WHERE id=?').get(req.patientId).name;
  notifyCaregivers(
    req.patientId,
    `${patientName} completed ${gameType || domain}`,
    `Accuracy ${Math.round(acc * 100)}% · average response ${(avg / 1000).toFixed(1)}s`,
    acc < 0.5 ? 'observe' : 'info'
  );

  // Tell every open dashboard for this patient that a session landed, so
  // the caregiver's charts move without anyone pressing refresh.
  realtime.publish(req.patientId, 'session:recorded', {
    sessionId: id, domain, gameType: gameType || null, accuracy: acc,
  });

  res.status(201).json({ ok: true, sessionId: id, patient: fullPatient(req.patientId) });
});

// Schedules and reminders moved to routes/schedules.js in Part 2, where
// a schedule is the plan and each reminder is one dated occurrence of it.

// ======================================================== NOTIFICATIONS
router.get('/notifications', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications WHERE user_id=? AND user_type=?
    ORDER BY created_at DESC LIMIT 50`).all(req.user.id, req.user.role);
  res.json(rows.map((n) => ({
    id: n.id, title: n.title, body: n.body, level: n.level,
    patientId: n.patient_id, read: !!n.is_read, createdAt: n.created_at,
  })));
});

router.put('/notifications/:id/read', requireAuth, (req, res) => {
  const info = db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ ok: true });
});

router.put('/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=? AND user_type=?').run(req.user.id, req.user.role);
  res.json({ ok: true });
});

// Backwards-compatible alias kept from the original prototype.
router.get('/dashboard/:patientId', requireAuth, requirePatientAccess, (req, res) => {
  res.json(fullPatient(req.patientId));
});

module.exports = { router, fullPatient, patientSummary };
