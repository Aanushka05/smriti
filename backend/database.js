// database.js — single source of truth for persisted data (SQLite via
// better-sqlite3).
//
// Smriti data model
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
// Repeating-through-the-day schedules (hydration, mobility) and the waking
// window that bounds them, so nothing rings while the patient is asleep.
addColumnIfMissing('schedules', 'repeat_every_minutes', 'INTEGER');
addColumnIfMissing('patients', 'waking_start', "TEXT DEFAULT '07:00'");
addColumnIfMissing('patients', 'waking_end', "TEXT DEFAULT '21:00'");

// Adaptive play data. Every column is additive: existing sessions keep
// working, they simply carry nulls for the figures nobody recorded.
addColumnIfMissing('sessions', 'start_level', 'INTEGER');
addColumnIfMissing('sessions', 'end_level', 'INTEGER');
addColumnIfMissing('sessions', 'max_level', 'INTEGER');
addColumnIfMissing('sessions', 'hints_used', 'INTEGER DEFAULT 0');
addColumnIfMissing('sessions', 'skipped_count', 'INTEGER DEFAULT 0');
addColumnIfMissing('sessions', 'timeout_count', 'INTEGER DEFAULT 0');
addColumnIfMissing('sessions', 'wrong_count', 'INTEGER DEFAULT 0');
addColumnIfMissing('sessions', 'duration_ms', 'INTEGER');
addColumnIfMissing('sessions', 'adaptive_score', 'INTEGER');
addColumnIfMissing('sessions', 'adaptive_band', 'TEXT');
addColumnIfMissing('sessions', 'adaptive_status', 'TEXT');
addColumnIfMissing('sessions', 'difficulty_changes', 'TEXT');
addColumnIfMissing('sessions', 'game_session_id', 'TEXT');

// How many extra play sessions a caregiver has granted for today. Kept on the
// patient so it travels with the profile the device already caches, which is
// what lets the allowance hold while offline.
addColumnIfMissing('patients', 'extra_game_sessions', 'INTEGER DEFAULT 0');
addColumnIfMissing('patients', 'extra_sessions_day', 'TEXT');
addColumnIfMissing('patients', 'max_game_sessions', 'INTEGER');

/* ------------------------------------------------ MFA + VERIFICATION
 * Additive only: every existing row keeps its data, and an account created
 * before these columns existed still logs in.
 */
addColumnIfMissing('caregivers', 'verification_status', "TEXT DEFAULT 'pending'");
addColumnIfMissing('caregivers', 'verification_file', 'TEXT');
addColumnIfMissing('caregivers', 'verification_mime', 'TEXT');
addColumnIfMissing('caregivers', 'verification_size', 'INTEGER');
addColumnIfMissing('caregivers', 'verification_uploaded_at', 'INTEGER');
addColumnIfMissing('caregivers', 'verification_reviewed_at', 'INTEGER');
addColumnIfMissing('caregivers', 'verification_note', 'TEXT');

// One-time codes. The code itself is stored HASHED, exactly like a password:
// a stolen database must not hand out live login codes.
db.exec(`
CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  destination TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  resend_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_otp_user ON otp_challenges (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_expiry ON otp_challenges (expires_at);`);

// Old challenges are of no use to anyone and are a standing liability, so
// they are cleared at startup and hourly thereafter.
function purgeExpiredOtps() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return db.prepare('DELETE FROM otp_challenges WHERE expires_at < ?').run(cutoff).changes;
}
purgeExpiredOtps();
setInterval(purgeExpiredOtps, 60 * 60 * 1000).unref();

// One stretch of play, as recorded by the device. The device owns usage; the
// server stores it so the caregiver can see it and so it survives the device.
db.exec(`
CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  day_key TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER DEFAULT 0,
  games_played INTEGER DEFAULT 0,
  end_reason TEXT,
  status TEXT DEFAULT 'active',
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_game_sessions_patient_day
  ON game_sessions (patient_id, day_key);`);

// An earlier build pre-generated every slot of a recurring schedule for the
// whole day, which buried the patient in near-identical cards. Recurring
// schedules now keep one open occurrence at a time, so collapse the leftovers.
// Only untouched rows are removed — anything done or missed is history and
// stays, so adherence figures do not change.
db.exec(`
  DELETE FROM reminders WHERE id IN (
    SELECT r.id FROM reminders r
    JOIN schedules s ON s.id = r.schedule_id
    WHERE s.repeat_rule = 'interval'
      AND r.status IN ('pending', 'snoozed')
      AND r.id <> (
        SELECT r2.id FROM reminders r2
        WHERE r2.schedule_id = r.schedule_id AND r2.due_date = r.due_date
          AND r2.status IN ('pending', 'snoozed')
        ORDER BY r2.time LIMIT 1
      )
  )`);

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
     repeat_rule,repeat_every_minutes,reminder_type,priority,notes,status,created_at,updated_at)
    VALUES (@id,@patient_id,'seed',@title,@description,@category,@icon,@scheduled_date,@scheduled_time,
     @repeat_rule,@repeat_every_minutes,'app',@priority,@notes,'active',@created_at,@created_at)`);

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
        { icon: '💧', type: 'Hydration', title: 'Drink Water', time: '07:00', text: 'Please drink a glass of water.', repeat: 'interval', everyMinutes: 120 },
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
        { icon: '💧', type: 'Hydration', title: 'Drink Water', time: '07:00', text: 'Please drink a glass of water.', repeat: 'interval', everyMinutes: 120 },
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
        { icon: '💧', type: 'Hydration', title: 'Drink Water', time: '07:00', text: 'Please drink a glass of water.', repeat: 'interval', everyMinutes: 120 },
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
          repeat_rule: r.repeat || 'daily',
          repeat_every_minutes: r.repeat === 'interval' ? (r.everyMinutes || DEFAULT_REPEAT_MINUTES) : null,
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

/* ---------------------------------------------------------------- WAKING HOURS
 * A schedule that repeats through the day must not ring at 3am. Every patient
 * carries a waking window; interval schedules are generated only inside it.
 */
const DEFAULT_WAKING_START = '07:00';
const DEFAULT_WAKING_END = '21:00';
const MIN_REPEAT_MINUTES = 30;
const MAX_REPEAT_MINUTES = 12 * 60;
const DEFAULT_REPEAT_MINUTES = 120;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm) {
  const m = HHMM.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function toHhmm(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The patient's waking window. Falls back to the default whenever the stored
 * values are missing or nonsensical (end at or before start), so a bad value
 * can never silence every reminder.
 */
function wakingWindow(patient) {
  const startRaw = toMinutes(patient && patient.waking_start);
  const endRaw = toMinutes(patient && patient.waking_end);
  const start = startRaw === null ? toMinutes(DEFAULT_WAKING_START) : startRaw;
  const end = endRaw === null ? toMinutes(DEFAULT_WAKING_END) : endRaw;
  if (end <= start) {
    return { start: toMinutes(DEFAULT_WAKING_START), end: toMinutes(DEFAULT_WAKING_END) };
  }
  return { start, end };
}

/**
 * Every clock time a schedule fires on a day it occurs.
 *
 * Ordinary schedules fire once, at their set time. An 'interval' schedule
 * fires repeatedly — every `repeat_every_minutes` — but only between waking
 * up and going to bed. A start time before waking is pulled forward to the
 * waking hour rather than dropped, so "water from 06:00 every 2h" on a
 * 07:00–21:00 day starts at 07:00.
 */
function occurrenceTimes(schedule, patient) {
  const time = schedule.scheduled_time || '08:00';
  if (schedule.repeat_rule !== 'interval') return [time];

  const { start, end } = wakingWindow(patient);
  const step = Math.min(Math.max(
    Number(schedule.repeat_every_minutes) || DEFAULT_REPEAT_MINUTES,
    MIN_REPEAT_MINUTES), MAX_REPEAT_MINUTES);

  const asked = toMinutes(time);
  const first = Math.max(asked === null ? start : asked, start);
  const times = [];
  for (let t = first; t <= end; t += step) times.push(toHhmm(t));
  // A start time past bedtime would otherwise produce nothing at all.
  return times.length ? times : [toHhmm(start)];
}

/* ------------------------------------------------- RECURRING REMINDERS
 * A schedule that repeats through the day is ONE reminder that keeps coming
 * back, not a wall of cards. Only a single occurrence is ever open at a time;
 * the next is created once the patient acts on the current one (or it lapses),
 * anchored to when that happened. Drink at 10:37 with a 2-hour gap and the
 * next prompt is 12:40, which is what "drink regularly" actually means.
 *
 * Each occurrence is still its own row, so adherence, missed-dose alerts and
 * the caregiver's history all keep working exactly as before.
 */
const OPEN_STATUSES = ['pending', 'snoozed'];

const occurrencesForDay = db.prepare(
  `SELECT id, time, status, completed_at, updated_at FROM reminders
   WHERE schedule_id=? AND due_date=? ORDER BY time`);

/** Minutes past midnight of a timestamp, in the server's local timezone. */
function minutesOfDay(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

/** Rounds up to the next 5-minute mark, so prompts read 12:40 rather than 12:37. */
function roundUp5(mins) {
  return Math.ceil(mins / 5) * 5;
}

function repeatStep(schedule) {
  return Math.min(Math.max(
    Number(schedule.repeat_every_minutes) || DEFAULT_REPEAT_MINUTES,
    MIN_REPEAT_MINUTES), MAX_REPEAT_MINUTES);
}

/**
 * The clock time of the next occurrence of a recurring schedule, or null when
 * one is already open, or the day is over.
 */
function nextRecurringTime(schedule, dateKey, patient) {
  const { start, end } = wakingWindow(patient);
  const step = repeatStep(schedule);
  const rows = occurrencesForDay.all(schedule.id, dateKey);

  // Exactly one live reminder at a time — this is the whole point.
  if (rows.some((r) => OPEN_STATUSES.includes(r.status))) return null;

  let next;
  // A caregiver who edits the schedule expects the change to take effect now,
  // not after the current cycle. So an edit restarts the chain from the new
  // start time rather than continuing from where the old one left off.
  const editedSinceLastOccurrence = schedule.updated_at
    && rows.every((r) => (r.completed_at || r.updated_at || 0) < schedule.updated_at);

  if (!rows.length || editedSinceLastOccurrence) {
    const asked = toMinutes(schedule.scheduled_time);
    next = Math.max(asked === null ? start : asked, start);
  } else {
    // Anchor on the most recent occurrence: when it was actually acted on if
    // we know, otherwise when it was due.
    const last = rows[rows.length - 1];
    const acted = last.completed_at || (last.status !== 'pending' ? last.updated_at : null);
    const anchor = acted ? minutesOfDay(acted) : toMinutes(last.time);
    next = roundUp5((anchor === null ? start : anchor) + step);
    if (next < start) next = start;
  }

  // Never before waking, never after bedtime.
  if (next > end) return null;

  // A slot already used earlier today: walk forward rather than collide.
  const taken = new Set(rows.map((r) => r.time));
  let guard = 0;
  while (taken.has(toHhmm(next)) && next <= end && guard++ < 48) next += step;
  return next <= end ? toHhmm(next) : null;
}

const findOccurrence = db.prepare(
  'SELECT id FROM reminders WHERE schedule_id=? AND due_date=? AND time=?');
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
  const patient = db.prepare('SELECT waking_start, waking_end FROM patients WHERE id=?').get(patientId);
  let created = 0;
  const tx = db.transaction(() => {
    for (const s of schedules) {
      if (!occursOn(s, date)) continue;

      // A recurring schedule contributes at most ONE open occurrence.
      const times = s.repeat_rule === 'interval'
        ? [nextRecurringTime(s, date, patient)].filter(Boolean)
        : [s.scheduled_time || '08:00'];

      for (const time of times) {
        if (findOccurrence.get(s.id, date, time)) continue;
        insertOccurrence.run(
          uuid(), patientId, s.id, s.icon || '🔔', s.category || 'General', s.title,
          time, s.description || s.notes || s.title, date,
          s.priority || 'normal', Date.now()
        );
        created += 1;
      }
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
/* ------------------------------------------------------ PLAY ALLOWANCE
 * Cognitive activities help; unlimited screen time does not. A patient gets a
 * bounded number of play sessions a day, each capped in length. Only a
 * caregiver can grant more, and a grant is spent on the day it was given —
 * carrying it forward would quietly turn "one extra today" into "four a day
 * for ever".
 */
const DEFAULT_SESSION_MINUTES = 30;
const DEFAULT_DAILY_SESSIONS = 3;
const MAX_CONFIGURABLE_SESSIONS = 10;

/** Today's play record for a patient, as the caregiver and device both see it. */
function gameAllowance(patientId, dayKey) {
  const day = dayKey || toDateKey(new Date());
  const patient = db.prepare(
    'SELECT extra_game_sessions, extra_sessions_day, max_game_sessions FROM patients WHERE id=?')
    .get(patientId) || {};

  const base = Number(patient.max_game_sessions) || DEFAULT_DAILY_SESSIONS;
  // A grant only counts for the day it was made.
  const granted = patient.extra_sessions_day === day
    ? Number(patient.extra_game_sessions) || 0 : 0;

  const rows = db.prepare(
    `SELECT id, started_at, ended_at, duration_ms, games_played, status, end_reason
     FROM game_sessions WHERE patient_id=? AND day_key=? ORDER BY started_at`).all(patientId, day);

  const used = rows.filter((r) => r.status === 'ended').length;
  const allowed = base + granted;

  return {
    dayKey: day,
    used,
    allowed,
    granted,
    baseAllowance: base,
    remaining: Math.max(0, allowed - used),
    sessionMinutes: DEFAULT_SESSION_MINUTES,
    totalMs: rows.reduce((sum, r) => sum + (r.duration_ms || 0), 0),
    sessions: rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: r.duration_ms || 0,
      gamesPlayed: r.games_played || 0,
      status: r.status,
      endReason: r.end_reason || null,
    })),
  };
}

/** Records a play session the device reported. Idempotent on the session id. */
function upsertGameSession(patientId, row) {
  const existing = db.prepare('SELECT * FROM game_sessions WHERE id=?').get(row.id);
  if (!existing) {
    db.prepare(`INSERT INTO game_sessions
      (id,patient_id,day_key,started_at,ended_at,duration_ms,games_played,end_reason,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, patientId, row.dayKey, row.startedAt, row.endedAt || null,
      row.durationMs || 0, row.gamesPlayed || 0, row.endReason || null,
      row.status || 'active', Date.now());
    return 'created';
  }
  // A session only ever moves forward: active -> ended. A late-arriving start
  // event must never reopen a session the device already closed.
  if (existing.status === 'ended' && (!row.status || row.status === 'active')) return 'ignored';
  db.prepare(`UPDATE game_sessions SET ended_at=?, duration_ms=?, games_played=?,
    end_reason=?, status=?, updated_at=? WHERE id=?`).run(
    row.endedAt || existing.ended_at, Math.max(row.durationMs || 0, existing.duration_ms || 0),
    Math.max(row.gamesPlayed || 0, existing.games_played || 0),
    row.endReason || existing.end_reason, row.status || existing.status, Date.now(), row.id);
  return 'updated';
}

function refreshPatientSchedule(patientId, dateKey) {
  const created = ensureOccurrences(patientId, dateKey);
  const missed = markOverdueMissed(patientId);
  // Marking the open occurrence missed frees the slot for the next one in a
  // recurring series. Generate again so a single refresh settles the day.
  const followUps = missed ? ensureOccurrences(patientId, dateKey) : 0;
  return { created: created + followUps, missed };
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
  toDateKey, parseDateKey, occursOn, occurrenceTimes, wakingWindow, nextRecurringTime,
  gameAllowance, upsertGameSession, purgeExpiredOtps,
  DEFAULT_SESSION_MINUTES, DEFAULT_DAILY_SESSIONS, MAX_CONFIGURABLE_SESSIONS,
  toMinutes, toHhmm,
  DEFAULT_WAKING_START, DEFAULT_WAKING_END, DEFAULT_REPEAT_MINUTES,
  MIN_REPEAT_MINUTES, MAX_REPEAT_MINUTES,
  ensureOccurrences, markOverdueMissed, refreshPatientSchedule, refreshAllSchedules,
  reminderStats,
};
