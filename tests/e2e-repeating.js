/* Recurring reminders: ONE card that keeps coming back, bounded by the
 * patient's waking hours. Run against a live server from the project root. */
const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const rawCall = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
};

/* Login is a two-step flow now: password, then a 6-digit code. These suites
 * are not about authentication, so `call` finishes the second step by
 * itself and hands back the completed session — every existing assertion on
 * .data.token keeps working. The code comes from OTP_DEV_ECHO, which is
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


const stamp = Date.now().toString().slice(-6);
const OPEN = ['pending', 'snoozed'];

(async () => {
  const cg = (await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Waking CG', username: 'wakecg' + stamp, password: 'wake@1234',
    confirmPassword: 'wake@1234', contact: `wake${stamp}@example.org`, role: 'asha',
  } })).data;
  const CG = cg.token;

  const made = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Waking Patient', username: 'wakept' + stamp,
    password: 'wake@1234', confirmPassword: 'wake@1234', age: 70,
  } });
  const PID = made.data.patient.id;
  const PT = (await call('/auth/login', { method: 'POST',
    body: { username: 'wakept' + stamp, password: 'wake@1234' } })).data.token;

  const water = async () => {
    const p = await call(`/patients/${PID}`, { token: CG });
    return p.data.reminders.filter((x) => x.title === 'Water');
  };
  const openWater = async () => (await water()).find((x) => OPEN.includes(x.status));

  console.log('\n== setup ==');
  let r = await call(`/patients/${PID}`, { token: CG });
  check('a new patient has a default waking window',
    r.data.wakingStart === '07:00' && r.data.wakingEnd === '21:00',
    [r.data.wakingStart, r.data.wakingEnd]);

  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: {
    title: 'Water', time: '07:00', repeat: 'interval', repeatEveryMinutes: 120, category: 'Hydration',
  } });
  check('a recurring schedule is accepted', r.status === 201, r.data);
  check('it reports its gap back', r.data.schedule.repeatEveryMinutes === 120, r.data.schedule);
  const schedId = r.data.schedule.id;

  console.log('\n== one reminder, not a wall of them ==');
  let w = await water();
  check('exactly one occurrence exists to begin with', w.length === 1, w.map((x) => x.time));
  check('and it is open', OPEN.includes(w[0].status), w[0].status);

  // Reading repeatedly must not manufacture more.
  for (let i = 0; i < 5; i++) await call(`/patients/${PID}`, { token: CG });
  w = await water();
  check('re-reading the day creates no extra occurrences', w.length === 1, w.map((x) => x.time));

  console.log('\n== acknowledging it schedules the next one ==');
  let open = await openWater();
  r = await call(`/reminders/${open.id}/complete`, { method: 'POST', token: PT });
  check('the open reminder can be completed', r.status === 200, r.data);

  w = await water();
  check('a follow-up appears after completion', w.length === 2, w.map((x) => x.time + ':' + x.status));
  check('still only ONE is open at a time',
    w.filter((x) => OPEN.includes(x.status)).length === 1,
    w.map((x) => x.time + ':' + x.status));
  check('the completed one is kept as history',
    w.filter((x) => x.status === 'done').length === 1, w.map((x) => x.status));

  // And again, to prove it is a chain rather than a one-off.
  open = await openWater();
  await call(`/reminders/${open.id}/complete`, { method: 'POST', token: PT });
  w = await water();
  check('the chain continues on the next acknowledgement', w.length === 3, w.map((x) => x.time));
  check('and still only one is open',
    w.filter((x) => OPEN.includes(x.status)).length === 1, w.map((x) => x.status));

  console.log('\n== the waking window bounds it ==');
  const times = (await water()).map((x) => x.time).sort();
  check('nothing is scheduled before waking', times.every((x) => x >= '07:00'), times);
  check('nothing is scheduled after bedtime', times.every((x) => x <= '21:00'), times);

  r = await call(`/patients/${PID}`, { method: 'PUT', token: CG, body: { wakingStart: '09:00', wakingEnd: '15:00' } });
  check('the window can be narrowed', r.status === 200, r.data);
  w = await water();
  const stillOpen = w.filter((x) => OPEN.includes(x.status));
  check('open reminders stay inside the new window',
    stillOpen.every((x) => x.time >= '09:00' && x.time <= '15:00'),
    stillOpen.map((x) => x.time));
  check('narrowing never leaves the patient with two open cards',
    stillOpen.length <= 1, stillOpen.map((x) => x.time));

  // The classic mistake: a start time before the patient is up.
  await call(`/schedules/${schedId}`, { method: 'PUT', token: CG, body: {
    title: 'Water', time: '05:00', repeat: 'interval', repeatEveryMinutes: 120,
  } });
  w = await water();
  const afterEdit = w.filter((x) => OPEN.includes(x.status));
  check('a pre-dawn start time is pulled forward to waking, not dropped',
    afterEdit.length === 1 && afterEdit[0].time >= '09:00', afterEdit.map((x) => x.time));

  console.log('\n== bad input is refused, not silently defaulted ==');
  r = await call(`/patients/${PID}`, { method: 'PUT', token: CG, body: { wakingStart: '22:00', wakingEnd: '06:00' } });
  check('a reversed window is rejected', r.status === 400, r.data);
  r = await call(`/patients/${PID}`, { method: 'PUT', token: CG, body: { wakingStart: 'morning' } });
  check('a malformed time is rejected', r.status === 400, r.data);
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: {
    title: 'x', time: '08:00', repeat: 'interval', repeatEveryMinutes: 5 } });
  check('an absurdly short gap is rejected', r.status === 400, r.data);
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: {
    title: 'x', time: '08:00', repeat: 'interval', repeatEveryMinutes: 5000 } });
  check('an absurdly long gap is rejected', r.status === 400, r.data);

  console.log('\n== ordinary schedules are untouched ==');
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: CG, body: {
    title: 'Tablet', time: '10:00', repeat: 'daily', category: 'Medicine' } });
  check('a daily schedule is still accepted', r.status === 201, r.data);
  const p = await call(`/patients/${PID}`, { token: CG });
  const tablets = p.data.reminders.filter((x) => x.title === 'Tablet');
  check('a daily schedule fires exactly once', tablets.length === 1, tablets.map((x) => x.time));
  check('a non-recurring schedule reports no gap',
    p.data.schedules.find((s) => s.title === 'Tablet').repeatEveryMinutes === null);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
