// End-to-end check of the Smriti API against a running backend.
const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' -> ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
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
  return { status: res.status, data, headers: res.headers };
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


const stamp = Date.now().toString().slice(-6);
const CG = { username: 'priya' + stamp, password: 'priya@123' };
const PT = { username: 'rahul' + stamp, password: 'rahul@123' };
const PT2 = { username: 'sunita' + stamp, password: 'sunita@1' };

(async () => {
  console.log('\n== health ==');
  let r = await call('/health');
  check('health ok', r.status === 200 && r.data.app === 'Smriti', r.data);

  console.log('\n== caregiver registration ==');
  r = await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Priya Das', username: CG.username, password: CG.password, confirmPassword: CG.password,
    contact: `priya${stamp}@example.org`, relationship: 'Family caregiver', role: 'family',
  } });
  check('caregiver registered (201)', r.status === 201, r.data);
  check('token returned', !!(r.data && r.data.token), r.data);
  check('role is caregiver', r.data.role === 'caregiver');
  check('starts with zero patients', Array.isArray(r.data.patients) && r.data.patients.length === 0);
  const cgToken = r.data.token;

  r = await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Copycat', username: CG.username, password: 'x1234', confirmPassword: 'x1234', contact: 'a@b.co',
  } });
  check('duplicate username rejected (409)', r.status === 409, r.data);

  r = await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Mismatch', username: 'mismatch' + stamp, password: 'abcd', confirmPassword: 'efgh', contact: 'a@b.co',
  } });
  check('password mismatch rejected (400)', r.status === 400 && /Confirm Password/.test(r.data.error), r.data);

  console.log('\n== caregiver login with the SAME credentials ==');
  r = await call('/auth/login', { method: 'POST', body: { username: CG.username, password: CG.password } });
  check('login works with registered credentials', r.status === 200 && r.data.role === 'caregiver', r.data);
  const cgToken2 = r.data.token;

  r = await call('/auth/login', { method: 'POST', body: { username: CG.username, password: 'wrong' } });
  check('wrong password rejected (401)', r.status === 401, r.data);

  console.log('\n== protected routes ==');
  r = await call('/caregiver/patients');
  check('no token -> 401', r.status === 401 && r.data.code === 'NO_TOKEN', r.data);
  r = await call('/caregiver/patients', { token: 'not-a-real-token' });
  check('bad token -> 401 BAD_TOKEN', r.status === 401 && r.data.code === 'BAD_TOKEN', r.data);
  r = await call('/caregiver/patients', { token: cgToken2 });
  check('valid token -> empty patient list', r.status === 200 && r.data.patients.length === 0, r.data);

  console.log('\n== patient self-registration, linked to that caregiver ==');
  r = await call('/auth/register/patient', { method: 'POST', body: {
    name: 'Rahul Sharma', username: PT.username, password: PT.password, confirmPassword: PT.password,
    age: 71, gender: 'Male', lang: 'hi-IN', caregiverUsername: CG.username, emergencyContact: '9800000123',
  } });
  check('patient registered (201)', r.status === 201, r.data);
  check('linked caregiver reported', r.data.linkedCaregiver && r.data.linkedCaregiver.username === CG.username, r.data);
  check('starter family seeded', r.data.patient.family.length === 3, r.data.patient.family);
  const ptToken = r.data.token;
  const ptId = r.data.patient.id;

  r = await call('/auth/register/patient', { method: 'POST', body: {
    name: 'Ghost', username: 'ghost' + stamp, password: 'abcd', confirmPassword: 'abcd', caregiverUsername: 'no_such_cg',
  } });
  check('unknown caregiver id rejected (404)', r.status === 404, r.data);

  console.log('\n== patient login with the SAME credentials ==');
  r = await call('/auth/login', { method: 'POST', body: { username: PT.username, password: PT.password } });
  check('patient login works', r.status === 200 && r.data.role === 'patient', r.data);
  const ptToken2 = r.data.token;

  r = await call('/auth/me', { token: ptToken2 });
  check('/auth/me returns patient', r.status === 200 && r.data.patient.username === PT.username, r.data);

  console.log('\n== caregiver now sees the linked patient ==');
  r = await call('/caregiver/patients', { token: cgToken2 });
  check('one linked patient', r.status === 200 && r.data.patients.length === 1, r.data);
  check('summary has zero sessions', r.data.patients[0].totalSessions === 0, r.data.patients[0]);

  console.log('\n== Add Patient: create a new patient account ==');
  r = await call('/caregiver/patients', { method: 'POST', token: cgToken2, body: {
    mode: 'create', name: 'Sunita Devi', username: PT2.username, password: PT2.password,
    confirmPassword: PT2.password, age: 69, gender: 'Female', lang: 'as-IN',
  } });
  check('patient created + linked (201)', r.status === 201 && r.data.created, r.data);
  const pt2Id = r.data.patient.id;
  r = await call('/auth/login', { method: 'POST', body: { username: PT2.username, password: PT2.password } });
  check('caregiver-created patient can log in', r.status === 200 && r.data.role === 'patient', r.data);

  console.log('\n== Add Patient: link an existing patient by ID ==');
  r = await call('/caregiver/patients', { method: 'POST', token: cgToken2, body: { mode: 'link', identifier: 'manisha' } });
  check('linked demo patient manisha (201)', r.status === 201 && r.data.linked, r.data);
  r = await call('/caregiver/patients', { method: 'POST', token: cgToken2, body: { mode: 'link', identifier: 'manisha' } });
  check('linking twice rejected (409)', r.status === 409, r.data);
  r = await call('/caregiver/patients', { method: 'POST', token: cgToken2, body: { mode: 'link', identifier: 'nobody_here' } });
  check('unknown patient rejected (404)', r.status === 404, r.data);
  r = await call('/caregiver/patients', { token: cgToken2 });
  check('three patients now linked', r.data.patients.length === 3, r.data.patients.map((p) => p.name));

  console.log('\n== isolation: another caregiver cannot read these patients ==');
  const other = await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Other CG', username: 'other' + stamp, password: 'other123', confirmPassword: 'other123', contact: '9812345678',
  } });
  r = await call(`/patients/${ptId}`, { token: other.data.token });
  check('unlinked caregiver -> 403', r.status === 403 && r.data.code === 'NOT_LINKED', r.data);
  r = await call(`/patients/${ptId}`, { token: cgToken2 });
  check('linked caregiver -> 200', r.status === 200, r.status);

  console.log('\n== game results, metrics, notifications ==');
  r = await call('/game-results', { method: 'POST', token: ptToken2, body: {
    patientId: ptId, domain: 'memory', gameType: 'Family Faces', level: 1,
    score: 4, totalRounds: 5, accuracy: 0.8, avgTimeMs: 4200, answers: [],
  } });
  check('game result saved (201)', r.status === 201, r.data);
  check('fresh patient returned with the session', r.data.patient.sessions.length === 1, r.data.patient.sessions);
  r = await call('/game-results', { method: 'POST', token: ptToken2, body: {
    patientId: ptId, domain: 'memory', gameType: 'Family Faces', level: 2, score: 3, totalRounds: 5, accuracy: 0.6, avgTimeMs: 5100,
  } });
  check('second session appended (2 total)', r.data.patient.sessions.length === 2);
  r = await call('/game-results', { method: 'POST', token: ptToken2, body: { patientId: ptId, domain: 'nonsense', accuracy: 0.5, avgTimeMs: 100 } });
  check('invalid domain rejected (400)', r.status === 400, r.data);
  r = await call('/game-results', { method: 'POST', token: ptToken2, body: { patientId: 'manisha', domain: 'memory', accuracy: 0.5, avgTimeMs: 100 } });
  check('patient cannot post for another patient (403)', r.status === 403, r.data);

  r = await call(`/patients/${ptId}/metrics`, { token: cgToken2 });
  const mem = r.data.find((m) => m.domain === 'memory');
  check('memory metric rolled up', mem && mem.sessions_count === 2, mem);
  check('memory trend computed', mem && mem.trend === 'declining', mem && mem.trend);

  r = await call('/notifications', { token: cgToken2 });
  check('caregiver got notifications from the sessions', Array.isArray(r.data) && r.data.length >= 2, r.data && r.data.length);

  console.log('\n== reminders + schedules ==');
  r = await call(`/patients/${ptId}/schedules`, { method: 'POST', token: cgToken2, body: {
    title: 'Morning medicine', time: '08:30', category: 'Medicine', repeat: 'daily', notes: 'One tablet after food',
  } });
  check('schedule created (201)', r.status === 201, r.data);
  // Part 2 shape: POST /schedules returns { schedule }, and the matching
  // reminder occurrence is fetched from the reminders endpoint.
  let rem = await call(`/patients/${ptId}/reminders`, { token: cgToken2 });
  check('matching reminder created for the patient', rem.data.reminders.some((x) => x.title === 'Morning medicine'), rem.data.reminders);
  const reminderId = rem.data.reminders.find((x) => x.title === 'Morning medicine').id;
  r = await call(`/patients/${ptId}/schedules`, { method: 'POST', token: cgToken2, body: { title: 'Bad time', time: '8am' } });
  check('bad time format rejected (400)', r.status === 400, r.data);

  r = await call(`/reminders/${reminderId}`, { method: 'PUT', token: ptToken2, body: { status: 'done' } });
  check('patient marked reminder done', r.status === 200 && r.data.reminder.status === 'done', r.data);
  r = await call(`/reminders/${reminderId}`, { method: 'PUT', token: other.data.token, body: { status: 'missed' } });
  check('other caregiver cannot change it (403)', r.status === 403, r.data);
  r = await call(`/reminders/${reminderId}`, { method: 'PUT', token: ptToken2, body: { status: 'exploded' } });
  check('invalid status rejected (400)', r.status === 400, r.data);

  console.log('\n== profile + family ==');
  r = await call(`/patients/${ptId}`, { method: 'PUT', token: cgToken2, body: { name: 'Rahul S Sharma', age: 72, gender: 'Male', lang: 'hi-IN' } });
  check('profile updated', r.status === 200 && r.data.patient.name === 'Rahul S Sharma', r.data);
  r = await call(`/patients/${ptId}`, { method: 'PUT', token: cgToken2, body: { age: 999 } });
  check('silly age rejected (400)', r.status === 400, r.data);
  r = await call(`/patients/${ptId}/family`, { method: 'POST', token: cgToken2, body: { name: 'Meena', relation: 'Daughter' } });
  check('family member added', r.status === 201 && r.data.patient.family.length === 4, r.data.patient.family.length);

  console.log('\n== reports ==');
  // Part 4 report shape: performance / reminders / cognitiveSessions / analysis.
  r = await call(`/patients/${ptId}/report?period=monthly`, { token: cgToken2 });
  check('report generated', r.status === 200 && r.data.report.cognitiveSessions.count === 2,
    r.data && r.data.report && r.data.report.cognitiveSessions);
  check('report is branded Smriti', r.data.report.app === 'Smriti');
  const dl = await fetch(`${BASE}/patients/${ptId}/report/download?format=html&period=all`, { headers: { Authorization: `Bearer ${cgToken2}` } });
  const html = await dl.text();
  check('HTML download works', dl.status === 200 && html.includes('Smriti'), dl.status);
  check('download has a filename', (dl.headers.get('content-disposition') || '').includes('Smriti_'), dl.headers.get('content-disposition'));
  const csv = await fetch(`${BASE}/patients/${ptId}/report/download?format=csv&period=all`, { headers: { Authorization: `Bearer ${cgToken2}` } });
  const csvText = await csv.text();
  check('CSV download works', csv.status === 200 && csvText.includes('Accuracy %'), csvText.slice(0, 80));
  const pdf = await fetch(`${BASE}/patients/${ptId}/report/download?format=pdf&period=all`, { headers: { Authorization: `Bearer ${cgToken2}` } });
  const pdfBuf = Buffer.from(await pdf.arrayBuffer());
  check('PDF download works', pdf.status === 200 && pdfBuf.slice(0, 5).toString() === '%PDF-', pdf.status);
  r = await call(`/patients/${ptId}/reports`, { token: cgToken2 });
  check('report history stored', Array.isArray(r.data) && r.data.length >= 1, r.data && r.data.length);

  console.log('\n== AI analysis (no API key -> rule-based) ==');
  // The engine needs at least 3 sessions before it will describe a trend,
  // so add a third here — two sessions correctly yields "insufficient data".
  await call('/game-results', { method: 'POST', token: ptToken2, body: {
    patientId: ptId, domain: 'attention', gameType: 'Spot the Odd One', level: 1,
    score: 3, totalRounds: 5, accuracy: 0.6, avgTimeMs: 4600,
  } });
  r = await call(`/patients/${ptId}/analysis`, { method: 'POST', token: cgToken2, body: { days: 0 } });
  check('analysis returns 200', r.status === 200, r.data);
  check('trend is described once there is enough data', r.data.overallTrend !== 'insufficient_data', r.data.overallTrendLabel);
  check('source is the built-in engine', r.data.source === 'engine', r.data.source);
  check('findings are real', Array.isArray(r.data.strengths) && Array.isArray(r.data.areasToWatch) && (r.data.strengths.length + r.data.areasToWatch.length) > 0, { s: r.data.strengths, a: r.data.areasToWatch });
  check('suggestions present', Array.isArray(r.data.recommendedActions) && r.data.recommendedActions.length > 0);
  check('explains why there is no AI write-up', typeof r.data.note === 'string' && r.data.note.includes('ANTHROPIC_API_KEY'), r.data.note);
  r = await call(`/patients/${pt2Id}/analysis`, { method: 'POST', token: cgToken2, body: {} });
  check('analysis on a brand-new patient does not crash', r.status === 200 && /not enough/i.test(r.data.headline), r.data && r.data.headline);

  console.log('\n== unlink ==');
  r = await call(`/caregiver/patients/manisha`, { method: 'DELETE', token: cgToken2 });
  check('unlink works', r.status === 200, r.data);
  r = await call('/caregiver/patients', { token: cgToken2 });
  check('back to two patients', r.data.patients.length === 2, r.data.patients.length);
  r = await call('/auth/login', { method: 'POST', body: { username: 'manisha', password: '1234' } });
  check('unlinked patient account still works', r.status === 200, r.status);

  console.log('\n== misc ==');
  r = await call('/no-such-endpoint');
  check('unknown API route -> JSON 404', r.status === 404 && typeof r.data.error === 'string', r.data);
  r = await call('/translate-ui', { method: 'POST', body: { texts: ['Hello'], sourceLanguage: 'en', targetLanguage: 'hi' } });
  // Correct behaviour depends on whether this server has Bhashini credentials:
  // a real translation when it does, the untouched English when it does not.
  // Never a fabrication either way.
  const bhashiniOn = (await call('/health')).data.bhashiniConfigured === true;
  check('translate-ui always answers', r.status === 200, r.status);
  check(bhashiniOn ? 'it really translates when configured'
    : 'it returns the original English when not configured',
    bhashiniOn
      ? (r.data.translated === true && r.data.translations[0] !== 'Hello')
      : (r.data.translated === false && r.data.translations[0] === 'Hello'),
    r.data);
  r = await call('/auth/username-available?username=' + CG.username);
  check('username availability: taken', r.data.available === false);
  r = await call('/auth/username-available?username=free' + stamp);
  check('username availability: free', r.data.available === true);
  r = await call('/patients/login', { method: 'POST', body: { mobile: '9000000002', pin: '1234' } });
  check('legacy patient login still works', r.status === 200 && r.data.patient.name === 'Ramesh', r.data);
  r = await call('/caregivers/login', { method: 'POST', body: { email: 'demo.asha@example.org', password: '1234' } });
  check('legacy caregiver login still works', r.status === 200 && r.data.patients.length >= 3, r.status);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
