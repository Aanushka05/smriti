/* Removes everything the automated test suites created, leaving only the
 * seeded demo: caregiver asha_demo with patients manisha, ramesh and anima.
 * Run with --dry-run to see the counts without changing anything. */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'backend');
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
const dbFile = path.join(root, 'data', 'smritisaathi.db');

const DRY = process.argv.includes('--dry-run');
const KEEP_PATIENTS = ['manisha', 'ramesh', 'anima'];
const KEEP_CAREGIVER = 'asha_demo';
// Set below, once the database is open: the seed writes everything in one
// burst at startup, so anything newer on a demo patient came from a test run.
let SEED_CUTOFF = 0;

if (!DRY) {
  const backup = dbFile.replace(/\.db$/, `.backup-${Date.now()}.db`);
  fs.copyFileSync(dbFile, backup);
  console.log('backup written to ' + path.basename(backup) + '\n');
}

const db = new Database(dbFile);
db.pragma('foreign_keys = OFF');

// Find where the seed ended rather than hard-coding a date: take the newest
// row the seeder wrote and allow a minute of slack for the rest of startup.
const seedEnd = db.prepare(
  "SELECT MAX(created_at) AS t FROM schedules WHERE created_by = 'seed'").get().t;
if (!seedEnd) throw new Error('no seeded schedules found — is this the right database?');
SEED_CUTOFF = seedEnd + 60000;

const pList = KEEP_PATIENTS.map((p) => `'${p}'`).join(',');
const cgId = db.prepare('SELECT id FROM caregivers WHERE username = ?').get(KEEP_CAREGIVER);
if (!cgId) throw new Error('demo caregiver ' + KEEP_CAREGIVER + ' not found — aborting');

// Which tables carry a patient_id we can filter on.
const patientTables = ['sessions', 'performance_metrics', 'reminders', 'schedules',
  'game_sessions',
  'reports', 'notifications', 'family_members', 'critical_alerts', 'chat_messages',
  'caregiver_patients', 'sync_events'];

const counted = [];
const run = (label, sql, params = []) => {
  const countSql = sql.replace(/^DELETE FROM/i, 'SELECT COUNT(*) AS c FROM');
  const c = db.prepare(countSql).get(...params).c;
  if (c > 0) counted.push([label, c]);
  if (!DRY && c > 0) db.prepare(sql).run(...params);
};

const tx = db.transaction(() => {
  // 1. Everything belonging to a patient the tests invented.
  for (const t of patientTables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols.includes('patient_id')) continue;
    run(`${t}: rows for test patients`,
      `DELETE FROM ${t} WHERE patient_id NOT IN (${pList})`);
  }

  // 2. Links from test caregivers to the demo patients.
  run('caregiver_patients: links from test caregivers',
    `DELETE FROM caregiver_patients WHERE caregiver_id <> ?`, [cgId.id]);

  // 3. Schedules the tests added onto the demo patients, and their reminders.
  const testScheduleIds = db.prepare(
    `SELECT id FROM schedules WHERE patient_id IN (${pList}) AND created_at > ?`)
    .all(SEED_CUTOFF).map((r) => r.id);
  if (testScheduleIds.length) {
    const ids = testScheduleIds.map((i) => `'${i}'`).join(',');
    run('reminders: from test-created schedules',
      `DELETE FROM reminders WHERE schedule_id IN (${ids})`);
    run('schedules: test-created on demo patients',
      `DELETE FROM schedules WHERE id IN (${ids})`);
  }

  // 4. Reminders whose schedule no longer exists (the four blank rows).
  run('reminders: orphaned (no parent schedule)',
    `DELETE FROM reminders WHERE schedule_id IS NOT NULL
       AND schedule_id NOT IN (SELECT id FROM schedules)`);

  // 5. Ad-hoc reminders added to the demo patients. The seeder only ever
  //    creates reminders from a schedule, so a reminder with no schedule on a
  //    demo patient was added by hand or by a test run.
  run('reminders: one-off reminders added to demo patients',
    `DELETE FROM reminders WHERE patient_id IN (${pList}) AND schedule_id IS NULL`);

  // 6. Sync and alert rows. Nothing here is seeded — every row was produced by
  //    a device syncing, which during development means a test run.
  run('critical_alerts: raised during testing', 'DELETE FROM critical_alerts');
  run('sync_events: recorded during testing', 'DELETE FROM sync_events');
  run('otp_challenges: login codes from testing', 'DELETE FROM otp_challenges');
  run('game_sessions: play recorded during testing', 'DELETE FROM game_sessions');

  // 7. Game sessions recorded on the demo patients after the seed finished.
  run('sessions: recorded on demo patients after seeding',
    `DELETE FROM sessions WHERE patient_id IN (${pList}) AND completed_at > ?`, [SEED_CUTOFF]);

  // 8. The test accounts themselves.
  run('patients: test-created accounts', `DELETE FROM patients WHERE id NOT IN (${pList})`);
  run('caregivers: test-created accounts', `DELETE FROM caregivers WHERE id <> ?`, [cgId.id]);
});
tx();


console.log(DRY ? '--- DRY RUN, nothing changed ---' : '--- removed ---');
for (const [label, n] of counted) console.log('  ' + String(n).padStart(5) + '  ' + label);
if (!counted.length) console.log('  nothing to remove — already clean');

if (!DRY) {
  // Reclaiming the freed pages needs exclusive access, which a running server
  // denies. The rows are already gone either way, so this is a nice-to-have.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
  } catch (err) {
    console.log('\n  (file not compacted — the server is running. Harmless.)');
  }
}

console.log('\n--- remaining ---');
for (const t of ['caregivers', 'patients', 'caregiver_patients', 'schedules',
  'reminders', 'sessions', 'performance_metrics', 'critical_alerts', 'sync_events']) {
  console.log('  ' + String(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c).padStart(5) + '  ' + t);
}
db.close();
