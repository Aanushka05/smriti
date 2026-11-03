// Offline-first checks: the idempotent sync API, no-duplicate guarantees,
// missed-dose alerting and the delivery log.
const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

async function rawCall(p, { method = 'GET', body, token }

 = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

/* Login is a two-step flow now: password, then a 6-digit code. This suite is
 * not about authentication, so `call` completes the second step itself and
 * returns the finished session — every existing assertion on .data.token
 * keeps working unchanged. The code comes from OTP_DEV_ECHO, which is
 * development-only and refused when NODE_ENV=production. */
/* Patient registration requires an emergency contact. These suites are about
 * other features, so `call` supplies a valid default rather than repeating
 * it at forty call sites. e2e-security.js deliberately does NOT do this —
 * it is the suite that proves the field is actually enforced. */
const TEST_EMERGENCY = '9800000000';

function withRequiredFields(path, opts) {
  const body = opts && opts.body;
  if (!body || typeof body !== 'object') return opts;
  const registersPatient = path.includes('/auth/register/patient')
    || (path.includes('/caregiver/patients') && body.mode === 'create');
  if (registersPatient && body.emergencyContact === undefined) {
    return { ...opts, body: { ...body, emergencyContact: TEST_EMERGENCY } };
  }
  return opts;
}

async function call(path, opts = {}) {
  const first = await rawCall(path, withRequiredFields(path, opts));
  if (!first.data || !first.data.mfaRequired) return first;
  if (!first.data.devCode) {
    throw new Error('Login needs a verification code, but OTP_DEV_ECHO is not enabled. '
      + 'Set OTP_DEV_ECHO=true in backend/.env to run these suites.');
  }
  const verified = await rawCall('/auth/verify-otp', {
    method: 'POST',
    body: { challengeId: first.data.challengeId, code: first.data.devCode },
  });
  // Keep the status of the operation the caller actually asked for: a
  // registration is a 201 even though the code that completes it answers 200.
  return { ...verified, status: first.status === 201 ? 201 : verified.status };
}


const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
});

const stamp = Date.now().toString().slice(-6);
const today = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

(async () => {
  console.log('\n== setup: a caregiver with a phone number, and a patient ==');
  let r = await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Offline Caregiver', username: `offcg${stamp}`, password: 'off@1234',
    confirmPassword: 'off@1234', contact: '9876500000', relationship: 'ASHA Worker',
  } });
  check('caregiver registered with a mobile number', r.status === 201, r.data);
  const CG = r.data.token;

  r = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Offline Patient', username: `offpt${stamp}`,
    password: 'off@1234', confirmPassword: 'off@1234', age: 76,
  } });
  const PID = r.data.patient.id;
  const PT = (await call('/auth/login', { method: 'POST', body: { username: `offpt${stamp}`, password: 'off@1234' } })).data.token;
  check('patient created and can sign in', !!PID && !!PT);

  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: {
    title: 'Morning Medicine', category: 'Medicine', time: '08:00',
    repeat: 'daily', priority: 'high', reminderType: 'both',
  } });
  const scheduleId = r.data.schedule.id;
  check('medication schedule saved', r.status === 201, r.data);

  console.log('\n== the sync endpoint accepts an offline batch ==');
  const gameEventId = uuid();
  const sessionId = uuid();
  const playedAt = Date.now() - 3 * 60 * 60 * 1000;   // 3 hours ago, while "offline"
  const batch = {
    deviceId: `device-${stamp}`,
    events: [{
      eventId: gameEventId,
      patientId: PID,
      eventType: 'game_result',
      occurredAt: playedAt,
      createdAt: playedAt,
      payload: {
        sessionId, patientId: PID, domain: 'memory', gameType: 'Memory Match',
        level: 2, score: 4, totalRounds: 5, accuracy: 0.8, avgTimeMs: 4300, answers: [],
      },
    }],
  };
  r = await call('/sync/batch', { method: 'POST', token: PT, body: batch });
  check('batch accepted', r.status === 200 && r.data.accepted === 1, r.data);
  check('per-event result returned', r.data.results[0].status === 'accepted', r.data.results);

  r = await call(`/patients/${PID}/sessions`, { token: CG });
  check('the session was stored', r.data.length === 1, r.data.length);
  check('it kept the id the device generated', r.data[0].id === sessionId, r.data[0].id);
  check('it is timestamped when it was PLAYED, not when it synced',
    Math.abs(r.data[0].ts - playedAt) < 2000, { stored: r.data[0].ts, played: playedAt });

  console.log('\n== IDEMPOTENCY: the same event re-sent creates nothing new ==');
  r = await call('/sync/batch', { method: 'POST', token: PT, body: batch });
  check('re-send answered "duplicate"', r.data.results[0].status === 'duplicate', r.data.results);
  check('duplicates counted separately', r.data.duplicates === 1 && r.data.accepted === 0, r.data);
  r = await call(`/patients/${PID}/sessions`, { token: CG });
  check('still exactly one session — no duplicate row', r.data.length === 1, r.data.length);

  // Re-send it five more times, as a flapping connection would.
  for (let i = 0; i < 5; i += 1) await call('/sync/batch', { method: 'POST', token: PT, body: batch });
  r = await call(`/patients/${PID}/sessions`, { token: CG });
  check('seven deliveries of one event still yield one session', r.data.length === 1, r.data.length);

  console.log('\n== a backlog of many events syncs in one go ==');
  const backlog = [];
  for (let i = 0; i < 12; i += 1) {
    backlog.push({
      eventId: uuid(), patientId: PID, eventType: 'game_result',
      occurredAt: Date.now() - (i + 1) * 3600000, createdAt: Date.now(),
      payload: {
        sessionId: uuid(), patientId: PID, domain: 'attention', gameType: 'Spot the Odd One',
        level: 1, score: 3, totalRounds: 5, accuracy: 0.6, avgTimeMs: 5000,
      },
    });
  }
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId: `device-${stamp}`, events: backlog } });
  check('12 queued events accepted at once', r.data.accepted === 12, r.data);
  r = await call(`/patients/${PID}/sessions`, { token: CG });
  check('all of them stored', r.data.length === 13, r.data.length);

  console.log('\n== a device-generated reminder id is matched to the server row ==');
  const reminders = (await call(`/patients/${PID}/reminders`, { token: PT })).data.reminders;
  check('the schedule produced a reminder', reminders.some((x) => x.title === 'Morning Medicine'), reminders.map((x) => x.title));

  // The device made its own occurrence id while offline; the server must
  // still resolve it via scheduleId + dueDate rather than creating a copy.
  const localReminderId = `local:${scheduleId}:${today}`;
  r = await call('/sync/batch', { method: 'POST', token: PT, body: {
    deviceId: `device-${stamp}`,
    events: [{
      eventId: uuid(), patientId: PID, eventType: 'reminder_action',
      occurredAt: Date.now(), createdAt: Date.now(),
      payload: { reminderId: localReminderId, scheduleId, dueDate: today,
        title: 'Morning Medicine', time: '08:00', category: 'Medicine', action: 'done' },
    }],
  } });
  check('offline reminder action accepted', r.data.accepted === 1, r.data);
  const after = (await call(`/patients/${PID}/reminders`, { token: PT })).data;
  const med = after.reminders.find((x) => x.title === 'Morning Medicine');
  check('the SERVER row was marked done (not a duplicate created)', med && med.status === 'done', med);
  check('no second reminder appeared',
    after.reminders.filter((x) => x.title === 'Morning Medicine').length === 1,
    after.reminders.filter((x) => x.title === 'Morning Medicine').length);

  console.log('\n== a completed dose is never downgraded by a late "missed" ==');
  r = await call('/sync/batch', { method: 'POST', token: PT, body: {
    deviceId: 'stale-device',
    events: [{
      eventId: uuid(), patientId: PID, eventType: 'reminder_action',
      occurredAt: Date.now() - 7200000, createdAt: Date.now(),
      payload: { reminderId: localReminderId, scheduleId, dueDate: today, action: 'missed', category: 'Medicine' },
    }],
  } });
  check('the stale event is accepted (not lost)', r.data.accepted === 1, r.data);
  const stillDone = (await call(`/patients/${PID}/reminders`, { token: PT })).data
    .reminders.find((x) => x.title === 'Morning Medicine');
  check('but the dose is still recorded as taken', stillDone.status === 'done', stillDone.status);

  console.log('\n== missed-dose alert -> caregiver notification + delivery log ==');
  const alertId = `alert:local:${scheduleId}:${today}`;
  const alertEvent = {
    eventId: uuid(), patientId: PID, eventType: 'missed_dose_alert',
    occurredAt: Date.now(), createdAt: Date.now(),
    payload: { alertId, reminderId: localReminderId, scheduleId, title: 'Evening Medicine',
      dueDate: today, dueTime: '20:00', severity: 'critical', detectedOffline: true },
  };
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId: `device-${stamp}`, events: [alertEvent] } });
  check('missed-dose alert accepted', r.data.accepted === 1, r.data);

  await new Promise((res) => setTimeout(res, 600));   // let delivery run
  r = await call(`/sync/status/${PID}`, { token: CG });
  check('the alert reaches the caregiver status feed', r.data.alerts.some((a) => a.id === alertId), r.data.alerts);
  const alert = r.data.alerts.find((a) => a.id === alertId);
  check('it is marked as detected offline', alert.detectedOffline === true, alert);
  check('a delivery attempt was logged', alert.deliveryAttempts >= 1, alert);
  check('with no SMS provider it is honestly NOT marked sent', alert.deliveryStatus !== 'sent', alert.deliveryStatus);
  check('the caregiver got an in-app notification',
    (await call('/notifications', { token: CG })).data.some((n) => /Missed medication/i.test(n.title)));

  console.log('\n== the same alert twice does not raise a second one ==');
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId: `device-${stamp}`, events: [alertEvent] } });
  check('re-sent alert is a duplicate', r.data.duplicates === 1, r.data);
  r = await call(`/sync/status/${PID}`, { token: CG });
  check('still only one alert row', r.data.alerts.filter((a) => a.id === alertId).length === 1);

  console.log('\n== validation and access control ==');
  r = await call('/sync/batch', { method: 'POST', token: PT, body: {
    events: [{ eventId: uuid(), patientId: PID, eventType: 'teleport', payload: {} }] } });
  check('unknown event type rejected, not retried forever', r.data.results[0].status === 'rejected', r.data.results);
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { events: [{ patientId: PID, eventType: 'game_result' }] } });
  check('an event with no id is rejected', r.data.results[0].status === 'rejected', r.data.results);
  r = await call('/sync/batch', { method: 'POST', token: PT, body: {
    events: [{ eventId: uuid(), patientId: PID, eventType: 'game_result', payload: { domain: 'telepathy', accuracy: 0.5, avgTimeMs: 10 } }] } });
  check('an invalid payload is rejected permanently', r.data.results[0].status === 'rejected', r.data.results);

  const other = await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Nosy', username: `nosy${stamp}`, password: 'nosy1234', confirmPassword: 'nosy1234',
    contact: `nosy${stamp}@example.org` } });
  check('second caregiver registered', other.status === 201, other.data);
  r = await call('/sync/batch', { method: 'POST', token: other.data.token, body: {
    events: [{ eventId: uuid(), patientId: PID, eventType: 'game_result',
      payload: { domain: 'memory', accuracy: 0.9, avgTimeMs: 1000 } }] } });
  check('another caregiver cannot sync into this patient', r.data.results[0].status === 'rejected', r.data.results);
  r = await call(`/sync/status/${PID}`, { token: other.data.token });
  check('nor read their sync status', r.status === 403, r.status);
  r = await call('/sync/batch', { method: 'POST', body: { events: [] } });
  check('no token is rejected', r.status === 401, r.status);
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { events: new Array(200).fill({}) } });
  check('an oversized batch is rejected', r.status === 400, r.status);

  console.log('\n== sync status feeds the caregiver dashboard ==');
  r = await call(`/sync/status/${PID}`, { token: CG });
  check('reports a last-sync time', typeof r.data.lastSyncAt === 'number', r.data.lastSyncAt);
  check('reports how many events arrived', r.data.totalEvents >= 15, r.data.totalEvents);
  check('counts alerts that were detected offline', r.data.alertsDetectedOffline >= 1, r.data.alertsDetectedOffline);

  r = await call(`/alerts/${alertId}/acknowledge`, { method: 'POST', token: CG });
  check('caregiver can acknowledge an alert', r.status === 200, r.data);
  r = await call(`/sync/status/${PID}`, { token: CG });
  check('the acknowledgement is recorded',
    !!r.data.alerts.find((a) => a.id === alertId).acknowledgedAt);

  console.log('\n== the server states its SMS capability honestly ==');
  const health = (await call('/health')).data;
  check('health reports the SMS provider', !!health.sms && health.sms.configured === 'console', health.sms);
  check('it does NOT claim to deliver real SMS', health.sms.deliversRealSms === false, health.sms);
  check('it does NOT claim offline delivery', health.sms.deliversWithoutInternet === false, health.sms);
  check('it warns that alerts are logged only', /no SMS is sent/i.test(health.sms.warning || ''), health.sms.warning);

  console.log('\n== the PWA files are served ==');
  for (const [file, needle] of [
    ['/manifest.webmanifest', 'Smriti'],
    ['/service-worker.js', 'SHELL_CACHE'],
    ['/db.js', 'IndexedDB'],
    ['/outbox.js', 'enqueueEvent'],
    ['/connectivity.js', 'probeConnectivity'],
    ['/local-store.js', 'recordGameResultLocally'],
    ['/reminder-engine.js', 'detectMissedDosesLocally'],
    ['/vendor/dexie.min.js', 'Dexie'],
  ]) {
    const res = await fetch(`http://localhost:5000${file}`);
    const body = await res.text();
    check(`${file} served and correct`, res.status === 200 && body.includes(needle), res.status);
  }

  console.log('\n== every icon the manifest names actually exists ==');
  // A manifest pointing at a missing icon fails silently: no install prompt,
  // no error. So verify each one is a real PNG of the declared size.
  const manifest = JSON.parse(
    await (await fetch('http://localhost:5000/manifest.webmanifest')).text());
  check('the manifest declares icons', manifest.icons.length >= 2, manifest.icons.length);
  check('it declares a maskable icon',
    manifest.icons.some((i) => (i.purpose || '').includes('maskable')));
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const icon of manifest.icons) {
    const res = await fetch('http://localhost:5000/' + icon.src);
    const buf = Buffer.from(await res.arrayBuffer());
    const isPng = buf.subarray(0, 8).equals(PNG_MAGIC);
    // Width and height sit at bytes 16..24, in the IHDR chunk.
    const declared = Number(icon.sizes.split('x')[0]);
    const w = isPng ? buf.readUInt32BE(16) : 0;
    const h = isPng ? buf.readUInt32BE(20) : 0;
    check(icon.src + ' is a real PNG at ' + icon.sizes,
      res.status === 200 && isPng && w === declared && h === declared,
      'status ' + res.status + ', png ' + isPng + ', ' + w + 'x' + h);
  }

  console.log('\n== the cache layer cannot resurrect deleted rows ==');
  // These live in the browser, so assert on the source: a regression here is
  // silent and nasty (duplicate reminders, alarms that never fire), and it has
  // already happened once.
  const localStore = await (await fetch('http://localhost:5000/local-store.js')).text();

  // The server field is "date"; the Dexie index is on "dueDate". Caching one as
  // the other makes the row invisible to the reminder tick AND makes
  // ensureLocalOccurrences add a duplicate next to it.
  check('cached reminders get a dueDate the index can see',
    /dueDate\s*=\s*r\.dueDate\s*\|\|\s*r\.date/.test(localStore));
  check('the cached row is written with that dueDate',
    /dexieDb\.reminders\.put\(\{[^}]*dueDate,/.test(localStore));

  // Without a prune, a schedule the caregiver deletes lives on the device for
  // ever and keeps generating reminders every day.
  check('the cache prunes rows the server no longer has',
    /async function pruneDeletedRows/.test(localStore) &&
    /await pruneDeletedRows\(/.test(localStore));
  check('pruning refuses to touch unsynced work',
    /if \(r\.syncStatus === SYNC\.PENDING\) return false;/.test(localStore));
  check('pruning only judges dates the server reported on',
    /cachedDates\.has\(r\.dueDate\)/.test(localStore));

  // The server sends only the selected range of sessions, so absence there
  // proves nothing and must never be read as a deletion.
  check('sessions are never pruned by absence',
    !/dexieDb\.sessions\.bulkDelete/.test(localStore));

  console.log('\n== reconnecting does not sit behind offline-earned backoff ==');
  // A retry that failed because the device had no network says nothing about
  // the server. Carrying that delay past reconnection leaves a patient's work
  // queued for minutes after the signal came back.
  const outboxSrc = await (await fetch('http://localhost:5000/outbox.js')).text();
  check('there is a way to clear the waiting period',
    /async function clearSyncBackoff/.test(outboxSrc));
  check('reconnecting clears it before flushing',
    /clearSyncBackoff\(\)\.then\(\(\) => scheduleSync/.test(outboxSrc));
  check('a manual sync clears it too',
    /await clearSyncBackoff\(\);\n  const result = await flushOutbox/.test(outboxSrc));
  check('but a normal flush still respects backoff',
    /row\.nextAttemptAt <= now/.test(outboxSrc));

  console.log('\n== play limits survive with no network ==');
  const sessionSrc = await (await fetch('http://localhost:5000/game-session.js')).text();
  check('the allowance is computed on the device, not asked of the server',
    /await dexieDb\.gameSessions/.test(sessionSrc) && !/apiFetch|fetch\(/.test(sessionSrc));
  check('the caregiver grant is read from the cached profile',
    /profile\.extraGameSessions/.test(sessionSrc));
  check('a session that overruns is closed by a watchdog',
    /startSessionWatchdog/.test(sessionSrc) && /time_limit/.test(sessionSrc));

  const dbSrc = await (await fetch('http://localhost:5000/db.js')).text();
  check('play sessions have a local table',
    /gameSessions: '/.test(dbSrc));
  check('the schema is versioned so existing devices upgrade',
    /dexieDb\.version\(2\)/.test(dbSrc));

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
