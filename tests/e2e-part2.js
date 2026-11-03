// Part 2 end-to-end checks: schedule CRUD, reminder lifecycle, adherence,
// the new games, performance metrics and the live-update stream.
const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}

async function rawCall(path, { method = 'GET', body, token }

 = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
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


let MED_TITLE = '';
const today = (() => {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
const stamp = Date.now().toString().slice(-6);

(async () => {
  console.log('\n== sign in ==');
  // This run owns its caregiver AND its patient. Using the seeded asha_demo /
  // manisha accounts left a fresh copy of every schedule below on the demo
  // patient on each run, which is exactly what a scheduling test must not do.
  const cg = (await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Schedule Caregiver', username: 'schedcg' + stamp,
    password: 'schedcg@1234', confirmPassword: 'schedcg@1234',
    contact: `schedcg${stamp}@example.org`, relationship: 'ASHA Worker', role: 'asha',
  } })).data;
  const CG = cg.token;
  check('caregiver signed in', !!CG);

  const made = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Schedule Patient', username: 'schedpt' + stamp,
    password: 'schedpt@1234', confirmPassword: 'schedpt@1234', age: 72, lang: 'en-IN',
  } });
  check('patient created for this run', made.status === 201, made.data);
  const PID = made.data.patient.id;
  const pt = (await call('/auth/login', { method: 'POST',
    body: { username: 'schedpt' + stamp, password: 'schedpt@1234' } })).data;
  const PT = pt.token;
  check('patient signed in', !!PT);

  console.log('\n== live update stream (SSE) ==');
  // Open the caregiver's stream, then have the PATIENT complete something
  // and confirm the caregiver's stream is told about it.
  const events = [];
  const ctrl = new AbortController();
  const streamReady = (async () => {
    const res = await fetch(`${BASE}/events?token=${encodeURIComponent(CG)}`, { signal: ctrl.signal });
    check('SSE stream opened (200)', res.status === 200, res.status);
    check('SSE content-type', (res.headers.get('content-type') || '').includes('text/event-stream'), res.headers.get('content-type'));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(chunk);
          const dt = /^data: (.+)$/m.exec(chunk);
          if (ev && dt) { try { events.push({ event: ev[1], data: JSON.parse(dt[1]) }); } catch (e) { /* skip */ } }
        }
      }
    } catch (e) { /* aborted */ }
  })();
  await new Promise((r) => setTimeout(r, 700));
  check('stream sent a ready event', events.some((e) => e.event === 'ready'), events);
  const health = (await call('/health')).data;
  check('server counts the live connection', health.liveConnections >= 1, health.liveConnections);

  console.log('\n== schedule: add ==');
  let r = await call(`/patients/${PID}/schedules`, {
    method: 'POST', token: CG, body: {
      title: 'Medicine ' + stamp, description: 'One tablet after breakfast', category: 'Medicine',
      time: '08:00', repeat: 'daily', reminderType: 'both', priority: 'high', notes: 'Blue box on the shelf',
    },
  });
  check('add schedule (201)', r.status === 201, r.data);
  check('all fields stored', r.data.schedule.description === 'One tablet after breakfast'
    && r.data.schedule.priority === 'high' && r.data.schedule.reminderType === 'both'
    && r.data.schedule.notes === 'Blue box on the shelf', r.data.schedule);
  const medId = r.data.schedule.id;

  r = await call(`/patients/${PID}/schedules`, {
    method: 'POST', token: CG, body: { title: 'Morning Walk ' + stamp, category: 'Exercise', time: '07:00', repeat: 'daily' },
  });
  const walkId = r.data.schedule.id;
  check('second schedule added', r.status === 201);

  r = await call(`/patients/${PID}/schedules`, {
    method: 'POST', token: CG, body: { title: 'Doctor Appointment', category: 'Appointment', time: '11:00', repeat: 'once', date: '2026-09-15', priority: 'high' },
  });
  check('one-time schedule with a date', r.status === 201 && r.data.schedule.date === '2026-09-15', r.data.schedule);

  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: { title: 'Weekly therapy', time: '16:00', repeat: 'weekly', category: 'Therapy' } });
  check('weekly schedule', r.status === 201 && r.data.schedule.repeat === 'weekly');
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: { title: 'Monthly checkup', time: '10:00', repeat: 'monthly', category: 'Appointment' } });
  check('monthly schedule', r.status === 201 && r.data.schedule.repeat === 'monthly');

  console.log('\n== schedule: validation ==');
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: { title: '', time: '08:00' } });
  check('empty title rejected', r.status === 400 && r.data.field === 'title', r.data);
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: { title: 'x', time: '8am' } });
  check('bad time rejected', r.status === 400 && r.data.field === 'time', r.data);
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: { title: 'x', time: '08:00', repeat: 'hourly' } });
  check('bad repeat rejected', r.status === 400 && r.data.field === 'repeat', r.data);
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: { title: 'x', time: '08:00', repeat: 'once' } });
  check('one-time without a date rejected', r.status === 400 && r.data.field === 'date', r.data);
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: { title: 'x', time: '08:00', priority: 'urgent' } });
  check('bad priority rejected', r.status === 400 && r.data.field === 'priority', r.data);

  console.log('\n== schedule: edit + delete ==');
  r = await call(`/schedules/${medId}`, { method: 'PUT', token: CG, body: { title: 'Medicine evening ' + stamp, time: '20:00', priority: 'normal' } });
  MED_TITLE = 'Medicine evening ' + stamp;
  check('edit schedule', r.status === 200 && r.data.schedule.title === MED_TITLE && r.data.schedule.time === '20:00', r.data.schedule);
  check('untouched fields preserved on edit', r.data.schedule.description === 'One tablet after breakfast', r.data.schedule.description);

  r = await call(`/schedules/${walkId}`, { method: 'DELETE', token: CG });
  check('delete schedule', r.status === 200, r.data);
  r = await call(`/patients/${PID}/schedules`, { token: CG });
  check('deleted schedule is gone from the list', !r.data.schedules.some((s) => s.id === walkId));
  check('other schedules remain', r.data.schedules.some((s) => s.id === medId));

  console.log('\n== patient sees the caregiver schedule ==');
  r = await call(`/patients/${PID}/schedules`, { token: PT });
  check('patient can read their schedule', r.status === 200 && r.data.schedules.length > 0, r.status);
  check('patient sees the edited medicine entry', r.data.schedules.some((s) => s.title === MED_TITLE));

  r = await call(`/patients/${PID}/reminders`, { token: PT });
  check('reminder generated for today from the schedule', r.data.reminders.some((x) => x.title === MED_TITLE), r.data.reminders.map((x) => x.title));
  check('reminder carries the schedule time', (r.data.reminders.find((x) => x.title === MED_TITLE) || {}).time === '20:00');
  const remId = r.data.reminders.find((x) => x.title === MED_TITLE).id;

  console.log('\n== reminder lifecycle ==');
  r = await call(`/reminders/${remId}/snooze`, { method: 'POST', token: PT, body: { minutes: 20 } });
  check('snooze', r.status === 200 && r.data.reminder.status === 'snoozed', r.data);
  check('snoozedUntil is in the future', r.data.reminder.snoozedUntil > Date.now());
  r = await call(`/reminders/${remId}/snooze`, { method: 'POST', token: PT, body: { minutes: 500 } });
  check('silly snooze rejected', r.status === 400, r.data);

  r = await call(`/reminders/${remId}/complete`, { method: 'POST', token: PT });
  check('complete', r.status === 200 && r.data.reminder.status === 'done', r.data);
  check('completedAt recorded', !!r.data.reminder.completedAt);
  check('stats returned with the action', r.data.stats && typeof r.data.stats.allTime.adherence === 'number', r.data.stats);

  r = await call(`/reminders/${remId}/snooze`, { method: 'POST', token: PT, body: { minutes: 15 } });
  check('cannot snooze a completed reminder', r.status === 409, r.data);

  // A second reminder to mark missed
  r = await call(`/patients/${PID}/reminders`, { method: 'POST', token: CG, body: { title: 'Drink water now', time: '09:30', type: 'Hydration' } });
  check('one-off reminder added', r.status === 201, r.data);
  const oneOff = r.data.reminder.id;
  r = await call(`/reminders/${oneOff}/miss`, { method: 'POST', token: CG });
  check('mark missed', r.status === 200 && r.data.reminder.status === 'missed', r.data);

  console.log('\n== adherence ==');
  r = await call(`/patients/${PID}/adherence`, { token: CG });
  const A = r.data;
  check('adherence endpoint', r.status === 200 && A.allTime, A);
  check('counts total/completed/missed/snoozed', ['total', 'completed', 'missed', 'snoozed'].every((k) => typeof A.allTime[k] === 'number'), A.allTime);
  check('adherence = completed / (completed+missed)',
    A.allTime.adherence === Math.round((A.allTime.completed / (A.allTime.completed + A.allTime.missed)) * 100),
    A.allTime);
  check('today block present', A.today && A.today.total >= 1, A.today);

  console.log('\n== upcoming ==');
  r = await call(`/patients/${PID}/schedules/upcoming?days=5`, { token: CG });
  check('upcoming returns dated groups', r.status === 200 && r.data.upcoming.length > 0, r.status);
  check('first group is today', r.data.upcoming[0].date === today, r.data.upcoming[0] && r.data.upcoming[0].date);
  check('weekly item only on its weekday',
    r.data.upcoming.filter((d) => d.items.some((i) => i.title === 'Weekly therapy')).length <= 1,
    r.data.upcoming.map((d) => d.date + ':' + d.items.filter((i) => i.title === 'Weekly therapy').length));

  console.log('\n== repeat rules do not duplicate ==');
  await call(`/patients/${PID}/reminders`, { token: CG });
  await call(`/patients/${PID}/reminders`, { token: CG });
  r = await call(`/patients/${PID}/reminders`, { token: CG });
  const medToday = r.data.reminders.filter((x) => x.title === MED_TITLE).length;
  check('repeated reads create exactly one occurrence per day', medToday === 1, medToday);

  console.log('\n== cognitive games write real results ==');
  // Use a patient created by THIS run, so per-domain counts are exact no
  // matter how many times the suite has been run before.
  const gp = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Games Patient', username: 'games' + stamp,
    password: 'games123', confirmPassword: 'games123', age: 70,
  } });
  check('games patient created', gp.status === 201, gp.data);
  const GPID = gp.data.patient.id;
  const GPT = (await call('/auth/login', { method: 'POST', body: { username: 'games' + stamp, password: 'games123' } })).data.token;

  const games = [
    { domain: 'memory', gameType: 'Memory Match', accuracy: 0.8, avgTimeMs: 5200 },
    { domain: 'problem_solving', gameType: 'Sequence Recall', accuracy: 0.6, avgTimeMs: 6100 },
    { domain: 'language', gameType: 'Word Recall', accuracy: 1.0, avgTimeMs: 3400 },
    { domain: 'orientation', gameType: 'Day and Date', accuracy: 0.8, avgTimeMs: 4200 },
    { domain: 'attention', gameType: 'Spot the Odd One', accuracy: 0.4, avgTimeMs: 4800 },
  ];
  for (const g of games) {
    r = await call('/game-results', {
      method: 'POST', token: GPT,
      body: { patientId: GPID, ...g, level: 2, score: Math.round(g.accuracy * 5), totalRounds: 5, answers: [{ q: 1, isCorrect: true, responseTimeMs: 3000 }] },
    });
    check(`${g.gameType} result saved`, r.status === 201, r.data && r.data.error);
  }
  r = await call(`/patients/${GPID}/metrics`, { token: CG });
  const byDomain = Object.fromEntries(r.data.map((m) => [m.domain, m]));
  check('language metric created', byDomain.language && byDomain.language.sessions_count === 1, byDomain.language);
  check('orientation metric created', byDomain.orientation && byDomain.orientation.sessions_count === 1, byDomain.orientation);
  check('problem_solving metric created', byDomain.problem_solving && byDomain.problem_solving.sessions_count === 1, byDomain.problem_solving);
  check('language avg matches what was sent', Math.round(byDomain.language.avg_accuracy * 100) === 100, byDomain.language.avg_accuracy);
  check('response time stored', byDomain.language.avg_time_ms === 3400, byDomain.language.avg_time_ms);

  r = await call(`/patients/${GPID}/sessions`, { token: CG });
  const last = r.data[r.data.length - 1];
  check('session stores game type, level, score and time',
    last.gameType === 'Spot the Odd One' && last.level === 2 && last.avgTimeMs === 4800 && !!last.ts, last);

  r = await call('/game-results', { method: 'POST', token: PT, body: { patientId: PID, domain: 'telepathy', accuracy: 0.5, avgTimeMs: 100 } });
  check('unknown domain still rejected', r.status === 400, r.data);

  console.log('\n== live events actually arrived ==');
  await new Promise((res2) => setTimeout(res2, 800));
  const types = events.filter((e) => e.event === 'update').map((e) => e.data.type);
  check('caregiver was told about schedule changes', types.includes('schedule:created') && types.includes('schedule:updated') && types.includes('schedule:deleted'), types);
  check('caregiver was told about reminder changes', types.includes('reminder:updated'), types);
  check('caregiver was told about the patient sessions', types.includes('session:recorded'), types);
  // Every event must name a patient THIS caregiver is linked to — the run
  // touches more than one patient, so it is a membership test, not equality.
  const myPatients = (await call('/caregiver/patients', { token: CG })).data.patients.map((p) => p.id);
  const updates = events.filter((e) => e.event === 'update');
  check('every event names a patient this caregiver may see',
    updates.length > 0 && updates.every((e) => myPatients.includes(e.data.patientId)),
    updates.map((e) => e.data.patientId).filter((id) => !myPatients.includes(id)));

  console.log('\n== isolation still holds ==');
  const other = await call('/auth/register/caregiver', {
    method: 'POST', body: { name: 'Nosy', username: 'nosy' + stamp, password: 'nosy1234', confirmPassword: 'nosy1234', contact: 'nosy' + stamp + '@example.org' },
  });
  r = await call(`/patients/${PID}/schedules`, { token: other.data.token });
  check('unlinked caregiver cannot read schedules', r.status === 403, r.status);
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: other.data.token, body: { title: 'hack', time: '01:00' } });
  check('unlinked caregiver cannot add a schedule', r.status === 403, r.status);
  r = await call(`/reminders/${remId}/complete`, { method: 'POST', token: other.data.token });
  check('unlinked caregiver cannot touch a reminder', r.status === 403, r.status);
  r = await call(`/patients/${PID}/schedules`, { token: null });
  check('no token -> 401', r.status === 401, r.status);

  console.log('\n== no fabricated numbers for a brand-new patient ==');
  const fresh = await call('/caregiver/patients', {
    method: 'POST', token: CG,
    body: { mode: 'create', name: 'Fresh Patient', username: 'fresh' + stamp, password: 'fresh123', confirmPassword: 'fresh123', age: 70 },
  });
  const FID = fresh.data.patient.id;
  check('new patient created', fresh.status === 201);
  check('no sessions', fresh.data.patient.totalSessions === 0, fresh.data.patient);
  check('accuracy is null, not a zero or a made-up number', fresh.data.patient.overallAccuracy === null, fresh.data.patient.overallAccuracy);
  check('adherence is null before anything comes due', fresh.data.patient.reminderCompletion === null, fresh.data.patient.reminderCompletion);
  r = await call(`/patients/${FID}/reminders`, { token: CG });
  check('no reminders for a patient with no schedule', r.data.reminders.length === 0, r.data.reminders);
  check('empty stats rather than invented ones', r.data.stats.allTime.total === 0 && r.data.stats.allTime.adherence === null, r.data.stats.allTime);
  r = await call(`/patients/${FID}/metrics`, { token: CG });
  check('every domain reports zero sessions', r.data.every((m) => m.sessions_count === 0), r.data.map((m) => m.domain + ':' + m.sessions_count));

  ctrl.abort();
  await streamReady.catch(() => {});
  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
