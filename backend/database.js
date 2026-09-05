// database.js — single source of truth for persisted data (SQLite via
// better-sqlite3).
//
// SmritiSaathi Care data model
// ---------------------------------------------------------------------
//   Users        -> patients + caregivers (both carry a unique `username`)
//   Caregivers   -> patients            (caregiver_patients, many-to-many)
//   Patients     -> family_members, sessions, reminders, schedules
//   Sessions     -> CognitiveSessions AND GameResults (one row per played
//                   game: domain, game_type, level, score, accuracy, times)
//   performance_metrics -> per-domain rollup, recomputed on every result
//   reports / notifications -> caregiver-facing artefacts
//
// The original schema is preserved; everything new is added through
// idempotent migrations so an existing smritisaathi.db keeps its data.

const path = require('path');
const fs = require('fs');

let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  console.error('\n[db] Could not load better-sqlite3.');
  console.error('[db] Run "npm install" inside the backend/ folder first.');
  console.error('[db] Original error:', err.message, '\n');
  throw err;
}

const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'smritisaathi.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER,
  gender TEXT,
  mobile TEXT UNIQUE,
  lang TEXT DEFAULT 'en-IN',
  emergency_contact TEXT,
  pin_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS caregivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mobile TEXT,
  email TEXT UNIQUE,
  role TEXT DEFAULT 'family',
  lang TEXT DEFAULT 'en-IN',
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS caregiver_patients (
  caregiver_id TEXT NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  PRIMARY KEY (caregiver_id, patient_id)
);

CREATE TABLE IF NOT EXISTS family_members (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name TEXT, relation TEXT, initial TEXT, color TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  game_type TEXT,
  level INTEGER,
  score INTEGER,
  total_rounds INTEGER,
  accuracy REAL NOT NULL,
  avg_time_ms INTEGER NOT NULL,
  answers TEXT,
  completed_at INTEGER NOT NULL
);

-- A reminder is ONE OCCURRENCE of a schedule on one date (or a one-off card
-- added directly). Occurrences are materialised from the schedules table by
-- ensureOccurrences() so a daily schedule produces a fresh, separately
-- tracked reminder every day instead of one row that never resets.
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  schedule_id TEXT REFERENCES schedules(id) ON DELETE CASCADE,
  icon TEXT, type TEXT, title TEXT, time TEXT, text TEXT,
  due_date TEXT,
  priority TEXT DEFAULT 'normal',
  status TEXT DEFAULT 'pending',
  snoozed_until INTEGER,
  completed_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  patient_id TEXT REFERENCES patients(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  lang TEXT,
  text_en TEXT NOT NULL,
  text_lang TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS translation_cache (
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  PRIMARY KEY (source_lang, target_lang, source_text)
);

-- A schedule is the PLAN a caregiver sets ("Medicine, 08:00, daily").
-- It never holds a completion status itself — that lives on the per-day
-- reminder occurrences generated from it.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  created_by TEXT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  icon TEXT,
  scheduled_date TEXT,
  scheduled_time TEXT,
  repeat_rule TEXT DEFAULT 'daily',
  reminder_type TEXT DEFAULT 'app',
  priority TEXT DEFAULT 'normal',
  notes TEXT,
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS performance_metrics (
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  sessions_count INTEGER NOT NULL DEFAULT 0,
  avg_accuracy REAL,
  best_accuracy REAL,
  avg_time_ms INTEGER,
  trend TEXT,
  last_session_at INTEGER,
  PRIMARY KEY (patient_id, domain)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  generated_by TEXT,
  title TEXT,
  period_start INTEGER,
  period_end INTEGER,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_type TEXT NOT NULL,
  patient_id TEXT,
  title TEXT,
  body TEXT,
  level TEXT DEFAULT 'info',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_patient ON sessions(patient_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_reminders_patient ON reminders(patient_id);
CREATE INDEX IF NOT EXISTS idx_schedules_patient ON schedules(patient_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
`);

// ---------------------------------------------------------------------
// Idempotent column migrations. SQLite cannot add a UNIQUE column with
// ALTER TABLE, so the column is added plain and a unique index is created
// separately (after the backfill below).
// ---------------------------------------------------------------------
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return true;
}

addColumnIfMissing('patients', 'username', 'TEXT');
addColumnIfMissing('patients', 'created_by', 'TEXT');
addColumnIfMissing('caregivers', 'username', 'TEXT');
addColumnIfMissing('caregivers', 'relationship', 'TEXT');

// Part 2: schedules gained description / reminder type / priority, and
// reminders became per-day occurrences of a schedule.
addColumnIfMissing('schedules', 'description', 'TEXT');
addColumnIfMissing('schedules', 'reminder_type', "TEXT DEFAULT 'app'");
addColumnIfMissing('schedules', 'priority', "TEXT DEFAULT 'normal'");
addColumnIfMissing('schedules', 'updated_at', 'INTEGER');
addColumnIfMissing('reminders', 'schedule_id', 'TEXT');
addColumnIfMissing('reminders', 'due_date', 'TEXT');
addColumnIfMissing('reminders', 'priority', "TEXT DEFAULT 'normal'");
addColumnIfMissing('reminders', 'snoozed_until', 'INTEGER');
addColumnIfMissing('reminders', 'completed_at', 'INTEGER');

db.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(patient_id, due_date);`);

function slugify(base, fallback) {
  const s = String(base || '').toLowerCase().replace(/[^a-z0-9_.]/g, '');
  return s || fallback;
}

// Backfill usernames for rows created before usernames existed, so every
// pre-existing account can still log in through the new username flow.
function backfillUsernames() {
  const taken = new Set([
    ...db.prepare('SELECT username u FROM patients WHERE username IS NOT NULL').all().map((r) => r.u),
    ...db.prepare('SELECT username u FROM caregivers WHERE username IS NOT NULL').all().map((r) => r.u),
  ]);
  const unique = (candidate) => {
    let name = candidate;
    let n = 1;
    while (taken.has(name)) { n += 1; name = `${candidate}${n}`; }
    taken.add(name);
    return name;
  };
  const setP = db.prepare('UPDATE patients SET username=? WHERE id=?');
  for (const r of db.prepare("SELECT id,name,mobile FROM patients WHERE username IS NULL OR username = ''").all()) {
    setP.run(unique(slugify(r.name, slugify(r.mobile, 'patient'))), r.id);
  }
  const setC = db.prepare('UPDATE caregivers SET username=? WHERE id=?');
  for (const r of db.prepare("SELECT id,name,email FROM caregivers WHERE username IS NULL OR username = ''").all()) {
    setC.run(unique(slugify(r.name, slugify((r.email || '').split('@')[0], 'caregiver'))), r.id);
  }
}

// =====================================================================
// OPTIONAL DEVELOPMENT SEED DATA — NOT PRODUCTION DATA
// ---------------------------------------------------------------------
// Everything below this banner exists only so a freshly cloned checkout
// has something on screen. It runs ONCE, on an empty database, and can be
// switched off entirely with SEED_DEMO_DATA=false in backend/.env.
//
// No part of the app depends on these rows: real accounts, sessions,
// schedules and reminders are written through exactly the same tables by
// the normal routes. The numbers here are FIXED, not randomised, so demo
// figures are reproducible and can never be mistaken for measurements —
// live dashboards read only what the database actually holds.
// =====================================================================
const SEED_ENABLED = String(process.env.SEED_DEMO_DATA || 'true').toLowerCase() !== 'false';

function seedIfEmpty() {
  if (!SEED_ENABLED) {
    console.log('[seed] SEED_DEMO_DATA=false — starting with an empty database.');
    return;
  }
  const count = db.prepare('SELECT COUNT(*) c FROM patients').get().c;
  if (count > 0) return;

  // Fixed response times per session index — deliberately deterministic.
  const DEMO_TIMES_MS = [4100, 3800, 4400, 3600, 4000];

  const mkSessions = (patientId, domain, gameType, values, level) =>
    values.map((pct, i) => ({
      id: uuid(), patientId, domain, gameType, level,
      score: Math.round((pct / 100) * 5), totalRounds: 5,
      accuracy: pct / 100,
      avgTimeMs: DEMO_TIMES_MS[i % DEMO_TIMES_MS.length],
      completedAt: Date.now() - (values.length - i) * 86400000,
    }));

  const insertPatient = db.prepare(`INSERT INTO patients
    (id,username,name,age,gender,mobile,lang,emergency_contact,pin_hash,created_at)
    VALUES (@id,@username,@name,@age,@gender,@mobile,@lang,@emergency_contact,@pin_hash,@created_at)`);
  const insertFamily = db.prepare(`INSERT INTO family_members
    (id,patient_id,name,relation,initial,color) VALUES (@id,@patient_id,@name,@relation,@initial,@color)`);
  const insertSession = db.prepare(`INSERT INTO sessions
    (id,patient_id,domain,game_type,level,score,total_rounds,accuracy,avg_time_ms,answers,completed_at)
    VALUES (@id,@patientId,@domain,@gameType,@level,@score,@totalRounds,@accuracy,@avgTimeMs,@answers,@completedAt)`);
  // The demo seeds SCHEDULES only. Today's reminder cards are then
  // generated from them by ensureOccurrences(), exactly as they are for a
  // schedule a real caregiver adds — no pre-baked reminder rows.
  const insertSchedule = db.prepare(`INSERT INTO schedules
    (id,patient_id,created_by,title,description,category,icon,scheduled_date,scheduled_time,
     repeat_rule,reminder_type,priority,notes,status,created_at,updated_at)
    VALUES (@id,@patient_id,'seed',@title,@description,@category,@icon,@scheduled_date,@scheduled_time,
     'daily','app',@priority,@notes,'active',@created_at,@created_at)`);

  const demoPin = bcrypt.hashSync('1234', 8);
  const demo = [
    {
      id: 'manisha', username: 'manisha', name: 'Manisha', age: 68, gender: 'Female', mobile: '9000000001', lang: 'mr-IN',
      family: [
        { name: 'Aai', relation: 'Mother', initial: 'A', color: '#6B2737' },
        { name: 'Baba', relation: 'Father', initial: 'B', color: '#3E5C3A' },
        { name: 'Aji', relation: 'Grandmother', initial: 'Aj', color: '#C88B2E' },
        { name: 'Kaka', relation: 'Uncle', initial: 'K', color: '#4A5C7A' },
        { name: 'Tai', relation: 'Sister', initial: 'T', color: '#8B5E34' },
      ],
      sessions: [
        ...mkSessions('manisha', 'memory', 'Family Faces', [72, 76, 78, 81, 84], 2),
        ...mkSessions('manisha', 'attention', 'Spot the Odd One', [70, 71, 72, 73, 74], 1),
        ...mkSessions('manisha', 'pattern', 'Weaving Completion', [65, 69, 73, 76, 79], 2),
      ],
      reminders: [
        { icon: '💊', type: 'Medicine', title: 'Morning Medicine', time: '08:00', text: 'Time to take your morning medicine.' },
        { icon: '💧', type: 'Hydration', title: 'Drink Water', time: '11:00', text: 'Please drink a glass of water.' },
        { icon: '📅', type: 'Appointment', title: 'PHC Check-up', time: '15:00', text: 'PHC check-up this afternoon.' },
      ],
    },
    {
      id: 'ramesh', username: 'ramesh', name: 'Ramesh', age: 72, gender: 'Male', mobile: '9000000002', lang: 'hi-IN',
      family: [
        { name: 'Maa', relation: 'Mother', initial: 'M', color: '#6B2737' },
        { name: 'Pita', relation: 'Father', initial: 'P', color: '#3E5C3A' },
        { name: 'Beta', relation: 'Son', initial: 'B', color: '#C88B2E' },
        { name: 'Beti', relation: 'Daughter', initial: 'Be', color: '#4A5C7A' },
        { name: 'Bhai', relation: 'Brother', initial: 'Bh', color: '#8B5E34' },
      ],
      sessions: [
        ...mkSessions('ramesh', 'memory', 'Family Faces', [82, 80, 79, 77, 75], 3),
        ...mkSessions('ramesh', 'attention', 'Spot the Odd One', [78, 76, 75, 72, 70], 2),
        ...mkSessions('ramesh', 'pattern', 'Weaving Completion', [80, 81, 81, 82, 82], 3),
      ],
      reminders: [
        { icon: '💊', type: 'Medicine', title: 'Blood Pressure Tablet', time: '09:00', text: 'Time to take your blood pressure tablet.' },
        { icon: '💧', type: 'Hydration', title: 'Drink Water', time: '12:00', text: 'Please drink a glass of water.' },
        { icon: '🚶', type: 'Exercise', title: 'Evening Walk', time: '17:30', text: 'Time for a short evening walk.' },
      ],
    },
    {
      id: 'anima', username: 'anima', name: 'Anima', age: 66, gender: 'Female', mobile: '9000000003', lang: 'as-IN',
      family: [
        { name: 'Aai', relation: 'Mother', initial: 'A', color: '#6B2737' },
        { name: 'Deuta', relation: 'Father', initial: 'D', color: '#3E5C3A' },
        { name: 'Aita', relation: 'Grandmother', initial: 'Ai', color: '#C88B2E' },
        { name: 'Khura', relation: 'Uncle', initial: 'K', color: '#4A5C7A' },
        { name: 'Kokai', relation: 'Elder Brother', initial: 'Ko', color: '#7A4A6B' },
      ],
      sessions: [
        ...mkSessions('anima', 'memory', 'Family Faces', [68, 71, 74, 76, 78], 2),
        ...mkSessions('anima', 'attention', 'Spot the Odd One', [72, 74, 76, 78, 80], 2),
        ...mkSessions('anima', 'pattern', 'Weaving Completion', [82, 80, 79, 77, 75], 3),
      ],
      reminders: [
        { icon: '💊', type: 'Medicine', title: 'Evening Medicine', time: '19:00', text: 'Time to take your evening medicine.' },
        { icon: '💧', type: 'Hydration', title: 'Drink Water', time: '13:00', text: 'Please drink a glass of water.' },
        { icon: '🧶', type: 'Activity', title: 'Weaving practice', time: '16:00', text: 'A short weaving practice session.' },
      ],
    },
  ];

  const tx = db.transaction(() => {
    for (const p of demo) {
      insertPatient.run({
        id: p.id, username: p.username, name: p.name, age: p.age, gender: p.gender, mobile: p.mobile,
        lang: p.lang, emergency_contact: '9800000000', pin_hash: demoPin, created_at: Date.now(),
      });
      for (const f of p.family) insertFamily.run({ id: uuid(), patient_id: p.id, ...f });
      for (const s of p.sessions) insertSession.run({ ...s, answers: JSON.stringify([]) });
      for (const r of p.reminders) {
        insertSchedule.run({
          id: uuid(), patient_id: p.id, title: r.title, description: r.text, category: r.type,
          icon: r.icon, scheduled_date: toDateKey(new Date()), scheduled_time: r.time,
          priority: r.type === 'Medicine' ? 'high' : 'normal', notes: '', created_at: Date.now(),
        });
      }
    }
    const cgId = uuid();
    db.prepare(`INSERT INTO caregivers (id,username,name,mobile,email,role,relationship,lang,password_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      cgId, 'asha_demo', 'Demo ASHA Worker', '9800000001', 'demo.asha@example.org', 'asha',
      'ASHA Worker', 'en-IN', demoPin, Date.now()
    );
    for (const p of demo) db.prepare('INSERT INTO caregiver_patients (caregiver_id, patient_id) VALUES (?,?)').run(cgId, p.id);
  });
  tx();
  console.log('[db] seeded demo patients (manisha / ramesh / anima) — password 1234');
  console.log('[db] seeded demo caregiver (asha_demo) — password 1234');
}

seedIfEmpty();
backfillUsernames();

// Unique indexes are created AFTER the backfill so legacy rows cannot
// collide on a NULL/duplicate username during migration.
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_username ON patients(username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_caregivers_username ON caregivers(username);
`);

// ---------------------------------------------------------------------
// PerformanceMetrics — derived, but stored, so reports and the caregiver
// dashboard read one cheap row per domain instead of re-scanning every
// session. Recomputed whenever a session is written.
// ---------------------------------------------------------------------
// The cognitive areas the app observes. Each one is fed by at least one
// real activity — a domain with no completed activity reports an empty
// state, never a made-up number.
const DOMAINS = ['memory', 'attention', 'language', 'orientation', 'problem_solving', 'pattern'];

const DOMAIN_LABELS = {
  memory: 'Memory',
  attention: 'Attention',
  language: 'Language',
  orientation: 'Orientation',
  problem_solving: 'Problem solving',
  pattern: 'Pattern recognition',
};

function recomputeMetrics(patientId) {
  const upsert = db.prepare(`INSERT INTO performance_metrics
    (patient_id,domain,sessions_count,avg_accuracy,best_accuracy,avg_time_ms,trend,last_session_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(patient_id,domain) DO UPDATE SET
      sessions_count=excluded.sessions_count, avg_accuracy=excluded.avg_accuracy,
      best_accuracy=excluded.best_accuracy, avg_time_ms=excluded.avg_time_ms,
      trend=excluded.trend, last_session_at=excluded.last_session_at`);

  for (const domain of DOMAINS) {
    const rows = db.prepare(
      'SELECT accuracy, avg_time_ms, completed_at FROM sessions WHERE patient_id=? AND domain=? ORDER BY completed_at ASC'
    ).all(patientId, domain);

    if (!rows.length) { upsert.run(patientId, domain, 0, null, null, null, 'none', null); continue; }

    const avgAcc = rows.reduce((a, r) => a + r.accuracy, 0) / rows.length;
    const best = rows.reduce((a, r) => Math.max(a, r.accuracy), 0);
    const avgTime = Math.round(rows.reduce((a, r) => a + r.avg_time_ms, 0) / rows.length);
    let trend = 'steady';
    if (rows.length >= 3) {
      const last3 = rows.slice(-3);
      if (last3[0].accuracy > last3[1].accuracy && last3[1].accuracy > last3[2].accuracy) trend = 'declining';
      else if (last3[2].accuracy > last3[0].accuracy) trend = 'improving';
    } else if (rows.length === 2) {
      trend = rows[1].accuracy >= rows[0].accuracy ? 'improving' : 'declining';
    }
    upsert.run(patientId, domain, rows.length, avgAcc, best, avgTime, trend, rows[rows.length - 1].completed_at);
  }
}

// Backfill rollups for any patient whose sessions predate this table
// (seeded demo data, or a database created before performance_metrics
// existed). Idempotent, and cheap because it only touches patients that
// have no metric rows yet.
function backfillMetrics() {
  const rows = db.prepare(`SELECT p.id FROM patients p
    WHERE NOT EXISTS (SELECT 1 FROM performance_metrics m WHERE m.patient_id = p.id)`).all();
  for (const r of rows) recomputeMetrics(r.id);
  if (rows.length) console.log(`[db] computed performance metrics for ${rows.length} patient(s)`);
}
backfillMetrics();

// ---------------------------------------------------------------------
// SCHEDULE OCCURRENCES
// A schedule is a plan; a reminder row is one occurrence of it on one
// date. ensureOccurrences() materialises the rows for a given date, so a
// "daily" schedule is a fresh, separately tracked reminder every day and
// adherence figures mean something. It is idempotent — calling it twice
// for the same date creates nothing extra.
// ---------------------------------------------------------------------

/** Local (not UTC) YYYY-MM-DD, so "today" matches the caregiver's day. */
function toDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDateKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Does a schedule fall due on this date? */
function occursOn(schedule, dateKey) {
  if (schedule.status !== 'active') return false;
  const start = schedule.scheduled_date || toDateKey(new Date(schedule.created_at));
  if (dateKey < start) return false;

  switch (schedule.repeat_rule) {
    case 'once':
      return dateKey === start;
    case 'daily':
      return true;
    case 'weekly':
      return parseDateKey(dateKey).getDay() === parseDateKey(start).getDay();
    case 'monthly':
      return parseDateKey(dateKey).getDate() === parseDateKey(start).getDate();
    default:
      return true;
  }
}

const findOccurrence = db.prepare('SELECT id FROM reminders WHERE schedule_id=? AND due_date=?');
const insertOccurrence = db.prepare(`INSERT INTO reminders
  (id,patient_id,schedule_id,icon,type,title,time,text,due_date,priority,status,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`);

/**
 * Creates any missing reminder rows for `dateKey`. Returns how many were
 * created. Safe to call on every read.
 */
function ensureOccurrences(patientId, dateKey) {
  const date = dateKey || toDateKey(new Date());
  const schedules = db.prepare("SELECT * FROM schedules WHERE patient_id=? AND status='active'").all(patientId);
  let created = 0;
  const tx = db.transaction(() => {
    for (const s of schedules) {
      if (!occursOn(s, date)) continue;
      if (findOccurrence.get(s.id, date)) continue;
      insertOccurrence.run(
        uuid(), patientId, s.id, s.icon || '🔔', s.category || 'General', s.title,
        s.scheduled_time, s.description || s.notes || s.title, date,
        s.priority || 'normal', Date.now()
      );
      created += 1;
    }
  });
  tx();
  return created;
}

/**
 * Marks past-due pending reminders as missed. A reminder is missed once
 * its date is over, or (for today) once its time passed by more than the
 * grace period and nobody acted on it.
 */
const MISSED_GRACE_MINUTES = 120;

function markOverdueMissed(patientId) {
  const now = new Date();
  const today = toDateKey(now);
  const rows = db.prepare("SELECT * FROM reminders WHERE patient_id=? AND status IN ('pending','snoozed')").all(patientId);
  const update = db.prepare("UPDATE reminders SET status='missed', updated_at=? WHERE id=?");
  let changed = 0;
  for (const r of rows) {
    if (!r.due_date) continue;
    if (r.status === 'snoozed' && r.snoozed_until && r.snoozed_until > Date.now()) continue;

    let overdue = r.due_date < today;
    let dueMs = null;
    if (!overdue && r.due_date === today && r.time) {
      const [h, m] = String(r.time).split(':').map(Number);
      if (Number.isFinite(h) && Number.isFinite(m)) {
        const due = new Date(now); due.setHours(h, m, 0, 0);
        dueMs = due.getTime();
        overdue = now.getTime() - dueMs > MISSED_GRACE_MINUTES * 60000;
      }
    }
    // A reminder created AFTER its own time was never missable — a
    // caregiver adding "08:00 medicine" at 10pm should not instantly see
    // it marked missed. For a pending row, updated_at is its creation time.
    if (overdue && r.status === 'pending' && dueMs !== null && r.updated_at > dueMs) continue;

    if (overdue) { update.run(Date.now(), r.id); changed += 1; }
  }
  return changed;
}

/** Brings a patient's reminder rows up to date before anything reads them. */
function refreshPatientSchedule(patientId, dateKey) {
  const created = ensureOccurrences(patientId, dateKey);
  const missed = markOverdueMissed(patientId);
  return { created, missed };
}

/** Real adherence figures, computed from stored occurrences only. */
function reminderStats(patientId, dateKey) {
  const today = dateKey || toDateKey(new Date());
  const count = (sql, ...params) => db.prepare(sql).get(patientId, ...params).c;

  const totals = {
    total: count('SELECT COUNT(*) c FROM reminders WHERE patient_id=?'),
    completed: count("SELECT COUNT(*) c FROM reminders WHERE patient_id=? AND status='done'"),
    missed: count("SELECT COUNT(*) c FROM reminders WHERE patient_id=? AND status='missed'"),
    snoozed: count("SELECT COUNT(*) c FROM reminders WHERE patient_id=? AND status='snoozed'"),
    pending: count("SELECT COUNT(*) c FROM reminders WHERE patient_id=? AND status='pending'"),
  };
  const todayTotals = {
    total: count('SELECT COUNT(*) c FROM reminders WHERE patient_id=? AND due_date=?', today),
    completed: count("SELECT COUNT(*) c FROM reminders WHERE patient_id=? AND due_date=? AND status='done'", today),
    missed: count("SELECT COUNT(*) c FROM reminders WHERE patient_id=? AND due_date=? AND status='missed'", today),
    snoozed: count("SELECT COUNT(*) c FROM reminders WHERE patient_id=? AND due_date=? AND status='snoozed'", today),
    pending: count("SELECT COUNT(*) c FROM reminders WHERE patient_id=? AND due_date=? AND status='pending'", today),
  };
  // Adherence = completed out of the ones that have actually come due
  // (done + missed). Pending/snoozed items still have time to be done, so
  // counting them would understate adherence early in the day.
  const settled = totals.completed + totals.missed;
  const settledToday = todayTotals.completed + todayTotals.missed;

  return {
    date: today,
    allTime: { ...totals, adherence: settled ? Math.round((totals.completed / settled) * 100) : null },
    today: { ...todayTotals, adherence: settledToday ? Math.round((todayTotals.completed / settledToday) * 100) : null },
  };
}

function addNotification({ userId, userType, patientId, title, body, level }) {
  db.prepare(`INSERT INTO notifications (id,user_id,user_type,patient_id,title,body,level,is_read,created_at)
    VALUES (?,?,?,?,?,?,?,0,?)`)
    .run(uuid(), userId, userType, patientId || null, title, body || '', level || 'info', Date.now());
}

/** Notify every caregiver linked to a patient (used by game results etc). */
function notifyCaregivers(patientId, title, body, level) {
  const rows = db.prepare('SELECT caregiver_id FROM caregiver_patients WHERE patient_id=?').all(patientId);
  for (const r of rows) {
    addNotification({ userId: r.caregiver_id, userType: 'caregiver', patientId, title, body, level });
  }
}

/** Generate today's reminder cards for every patient at startup. */
function refreshAllSchedules() {
  const rows = db.prepare('SELECT id FROM patients').all();
  let created = 0;
  for (const r of rows) created += refreshPatientSchedule(r.id).created;
  if (created) console.log(`[db] generated ${created} reminder(s) from active schedules`);
}
refreshAllSchedules();

module.exports = {
  db, uuid, slugify,
  recomputeMetrics, addNotification, notifyCaregivers,
  DOMAINS, DOMAIN_LABELS,
  toDateKey, parseDateKey, occursOn,
  ensureOccurrences, markOverdueMissed, refreshPatientSchedule, refreshAllSchedules,
  reminderStats,
};
