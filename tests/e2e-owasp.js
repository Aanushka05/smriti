/* Security probes against a running server.
 *
 * These follow current OWASP guidance. That is a statement about the practices
 * being checked — it is NOT a certification, and passing this file does not
 * mean the application has been independently assessed. */
const jwt = require('../backend/node_modules/jsonwebtoken');
const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const rawCall = async (path, { method = 'GET', token, body, headers = {} } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* none */ }
  return { status: res.status, data, headers: res.headers };
};
async function call(path, opts = {}) {
  const first = await rawCall(path, opts);
  if (!first.data || !first.data.mfaRequired) return first;
  const verified = await rawCall('/auth/verify-otp', { method: 'POST',
    body: { challengeId: first.data.challengeId, code: first.data.devCode } });
  // Keep the status of the operation the caller actually asked for.
  return { ...verified, status: first.status === 201 ? 201 : verified.status };
}

const stamp = Date.now().toString().slice(-6);

(async () => {
  console.log('\n== A05: security headers ==');
  const page = await fetch('http://localhost:5000/');
  const h = (n) => page.headers.get(n);
  check('X-Content-Type-Options: nosniff', h('x-content-type-options') === 'nosniff', h('x-content-type-options'));
  check('X-Frame-Options: DENY', h('x-frame-options') === 'DENY', h('x-frame-options'));
  check('Referrer-Policy is set', !!h('referrer-policy'), h('referrer-policy'));
  check('Permissions-Policy is set', !!h('permissions-policy'), h('permissions-policy'));
  check('a Content-Security-Policy is served', !!h('content-security-policy'));
  check('CSP forbids framing', /frame-ancestors 'none'/.test(h('content-security-policy') || ''));
  check('CSP blocks plugins/objects', /object-src 'none'/.test(h('content-security-policy') || ''));
  check('the server does not advertise its stack', !page.headers.get('x-powered-by'));

  const api = await fetch('http://localhost:5000/api/health');
  check('API responses are not cached', /no-store/.test(api.headers.get('cache-control') || ''),
    api.headers.get('cache-control'));

  console.log('\n== A01/A07: CORS is not wide open ==');
  const evil = await fetch('http://localhost:5000/api/health', { headers: { Origin: 'https://evil.example' } });
  const acao = evil.headers.get('access-control-allow-origin');
  check('an unknown origin is NOT reflected back', acao !== 'https://evil.example', acao);
  check('and the wildcard is not used either', acao !== '*', acao);

  console.log('\n== A02/A07: JWT handling ==');
  const health = (await call('/health')).data;
  check('health reports the security posture', !!health.security, health.security);
  check('it never reveals the secret itself',
    !JSON.stringify(health).includes(process.env.JWT_SECRET || 'dev-secret-change-me'));

  // A token signed with a different key must be refused.
  const forged = jwt.sign({ id: 'manisha', role: 'patient' }, 'not-the-real-secret', { expiresIn: '1h' });
  let r = await rawCall('/auth/me', { token: forged });
  check('a token signed with the wrong key is rejected', r.status === 401, r.status);

  // The classic algorithm-confusion probe: alg "none".
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ id: 'manisha', role: 'patient', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  r = await rawCall('/auth/me', { token: `${header}.${payload}.` });
  check('an unsigned "alg: none" token is rejected', r.status === 401, r.status);

  r = await rawCall('/auth/me', { token: 'not.a.token' });
  check('a malformed token is rejected', r.status === 401, r.status);
  r = await rawCall('/auth/me');
  check('no token is rejected', r.status === 401, r.status);

  const expired = jwt.sign({ id: 'manisha', role: 'patient' },
    process.env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '-1s' });
  r = await rawCall('/auth/me', { token: expired });
  check('an expired token is rejected', r.status === 401, r.status);

  console.log('\n== A01: broken access control (IDOR/BOLA) ==');
  const cgA = (await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Owner CG', username: 'owncg' + stamp, password: 'own@12345', confirmPassword: 'own@12345',
    contact: `own${stamp}@example.org`, role: 'asha' } })).data;
  const made = await call('/caregiver/patients', { method: 'POST', token: cgA.token, body: {
    mode: 'create', name: 'Owned Patient', username: 'ownpt' + stamp,
    password: 'own@12345', confirmPassword: 'own@12345', age: 70, emergencyContact: '9800000000' } });
  const PID = made.data.patient.id;
  const PT = (await call('/auth/login', { method: 'POST',
    body: { username: 'ownpt' + stamp, password: 'own@12345' } })).data.token;

  const cgB = (await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Nosy CG', username: 'nosy' + stamp, password: 'own@12345', confirmPassword: 'own@12345',
    contact: `nosy${stamp}@example.org`, role: 'asha' } })).data;

  for (const [label, path, opts] of [
    ['read the patient', `/patients/${PID}`, {}],
    ['read sessions', `/patients/${PID}/sessions`, {}],
    ['read metrics', `/patients/${PID}/metrics`, {}],
    ['read the dashboard', `/dashboard/${PID}`, {}],
    ['read reminders', `/patients/${PID}/reminders`, {}],
    ['read the analysis', `/patients/${PID}/analysis`, {}],
    ['read play activity', `/patients/${PID}/play`, {}],
    ['read chat history', `/chat/${PID}/history`, {}],
    ['edit the profile', `/patients/${PID}`, { method: 'PUT', body: { name: 'hacked' } }],
    ['reset the password', `/patients/${PID}/password`, { method: 'POST', body: { password: 'takeover1' } }],
    ['grant extra play', `/patients/${PID}/play/grant`, { method: 'POST' }],
    ['add a schedule', `/patients/${PID}/schedules`, { method: 'POST', body: { title: 'x', time: '08:00' } }],
    ['post a game result', '/game-results', { method: 'POST', body: { patientId: PID, domain: 'memory', accuracy: 1, avgTimeMs: 10 } }],
    ['talk to the chatbot as them', '/chat', { method: 'POST', body: { patientId: PID, message: 'hello' } }],
  ]) {
    const res = await call(path, { ...opts, token: cgB.token });
    check(`an unrelated caregiver cannot ${label}`, res.status === 403 || res.status === 404, res.status);
  }

  r = await call('/patients/manisha', { token: PT });
  check('a patient cannot read another patient', r.status === 403, r.status);

  // Syncing into someone else's record.
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId: 'd' + stamp, events: [
    { eventId: 'e' + stamp, eventType: 'game_result', patientId: 'manisha', occurredAt: Date.now(),
      payload: { domain: 'memory', accuracy: 1, avgTimeMs: 100 } }] } });
  const rejected = r.status !== 200 || (r.data.results || []).every((x) => x.status !== 'accepted');
  check('a device cannot sync data into another patient record', rejected, r.data);

  console.log('\n== A03: input validation ==');
  r = await rawCall('/auth/login', { method: 'POST', body: { username: { $ne: null }, password: { $ne: null } } });
  check('a non-string login is refused, not coerced', r.status >= 400 && !r.data.token, r.status);
  r = await call(`/patients/${PID}`, { method: 'PUT', token: cgA.token, body: { age: 'DROP TABLE patients' } });
  check('a non-numeric age is refused', r.status === 400, r.status);
  const after = await call('/patients/' + PID, { token: cgA.token });
  check('and the patients table is very much still there', after.status === 200, after.status);
  r = await call(`/patients/${PID}/schedules`, { method: 'POST', token: cgA.token,
    body: { title: "x'); DROP TABLE schedules;--", time: '08:00' } });
  check('SQL in a text field is stored as text, not executed', r.status === 201, r.status);
  const stillThere = await call(`/patients/${PID}/schedules`, { token: cgA.token });
  check('the schedules table survived it', stillThere.status === 200, stillThere.status);

  console.log('\n== A04: rate limiting ==');
  let limited = false;
  for (let i = 0; i < 80; i++) {
    const attempt = await rawCall('/auth/login', { method: 'POST',
      body: { username: 'nobody' + stamp, password: 'wrong' } });
    if (attempt.status === 429) { limited = true; break; }
  }
  check('repeated login attempts are throttled', limited);

  console.log('\n== A09: nothing sensitive is echoed ==');
  const blob = JSON.stringify(health);
  for (const secret of ['JWT_SECRET', 'password_hash', 'pin_hash', 'code_hash',
    'BHASHINI_API_KEY', 'KIWI_API_KEY', 'ulcaApiKey', 'verification_file']) {
    check(`/health does not expose ${secret}`, !blob.includes(secret));
  }
  const me = await call('/auth/me', { token: PT });
  check('/auth/me carries no password hash', !/pin_hash|password_hash/.test(JSON.stringify(me.data)));
  const profile = await call(`/patients/${PID}`, { token: cgA.token });
  check('a patient profile carries no password hash',
    !/pin_hash|password_hash/.test(JSON.stringify(profile.data)));
  check('and no verification filename', !/verification_file|\.png|\.pdf/.test(JSON.stringify(profile.data)));

  r = await rawCall('/this-route-does-not-exist');
  check('an unknown API route gives JSON, not a stack trace',
    r.status === 404 && !!r.data && !/at Object|at Module|node_modules/.test(JSON.stringify(r.data)), r.data);

  console.log('\n== chat: keys stay server-side ==');
  const chatStatus = await call('/chat/status', { token: PT });
  check('chat status is readable by a signed-in user', chatStatus.status === 200, chatStatus.status);
  check('it names missing settings but never their values',
    !JSON.stringify(chatStatus.data).match(/sk-|Bearer |api[_-]?key["']?\s*:\s*["'][A-Za-z0-9_-]{12,}/),
    chatStatus.data);
  r = await rawCall('/chat', { method: 'POST', body: { message: 'hello' } });
  check('the chatbot rejects an anonymous caller', r.status === 401, r.status);

  for (const file of ['/app.js', '/chat.js', '/speech.js', '/bhashini-client.js', '/config.js', '/theme.js']) {
    const src = await (await fetch('http://localhost:5000' + file)).text();
    const leak = /sk-[A-Za-z0-9]{16,}|ulcaApiKey\s*[:=]\s*['"][^'"]+|KIWI_API_KEY\s*[:=]\s*['"][^'"]+/.test(src);
    check(`${file} contains no API key`, !leak);
  }

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
