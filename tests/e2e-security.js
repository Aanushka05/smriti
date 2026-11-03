/* MFA/OTP, caregiver verification, mandatory emergency contact, and the
 * authorization boundary. Run against a live server from the project root.
 *
 * The OTP path needs OTP_DEV_ECHO=true in backend/.env, which is refused when
 * NODE_ENV=production — there is no way for this suite to weaken a real
 * deployment. */
const fs = require('fs');
const path = require('path');
const UPLOAD_DIR = path.join(__dirname, '..', 'backend', 'private_uploads');
const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const call = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* none */ }
  return { status: res.status, data };
};

const stamp = Date.now().toString().slice(-6);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(256, 7),
]).toString('base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(256, 3)]).toString('base64');

const registerCg = (extra = {}) => call('/auth/register/caregiver', { method: 'POST', body: {
  name: 'Sec CG', username: 'seccg' + stamp + (extra.suffix || ''), password: 'sec@12345',
  confirmPassword: 'sec@12345', contact: `sec${stamp}${extra.suffix || ''}@example.org`,
  role: 'asha', ...extra.body,
} });

(async () => {
  console.log('\n== caregiver registration needs no document ==');
  let r = await registerCg();
  check('registration succeeds with credentials alone', r.status === 201, r.data);
  check('no document field is demanded',
    !JSON.stringify(r.data).includes('verificationDocument'), r.data.field);
  check('registration does NOT hand out a session directly',
    !r.data.token && r.data.mfaRequired === true, Object.keys(r.data));
  check('it returns a challenge to verify', !!r.data.challengeId, r.data.challengeId);

  // Sending a document anyway must be ignored, not accepted and stored.
  const withDoc = await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Doc CG', username: 'doccg' + stamp, password: 'sec@12345',
    confirmPassword: 'sec@12345', contact: `doccg${stamp}@example.org`, role: 'asha',
    verificationDocument: { name: 'id.png', type: 'image/png', data: PNG },
  } });
  check('an unsolicited document does not break registration', withDoc.status === 201, withDoc.data);

  const CG_TOKEN = (await call('/auth/verify-otp', { method: 'POST',
    body: { challengeId: r.data.challengeId, code: r.data.devCode } })).data.token;
  check('the code completes the sign-up and returns a session', !!CG_TOKEN);

  const whoami = await call('/auth/me', { token: CG_TOKEN });
  check('the new caregiver has the caregiver role', whoami.data.role === 'caregiver', whoami.data.role);
  check('no verification state is advertised any more',
    !JSON.stringify(whoami.data).includes('verificationStatus'), whoami.data);

  console.log('\n== no identity documents are stored at all ==');
  check('the upload service is gone',
    !fs.existsSync(path.join(__dirname, '..', 'backend', 'upload_service.js')));
  check('no document directory is left behind',
    !fs.existsSync(UPLOAD_DIR) || fs.readdirSync(UPLOAD_DIR).length === 0);
  const rules = await call('/auth/upload-rules');
  check('the upload-rules endpoint is gone', rules.status === 404, rules.status);

  console.log('\n== emergency contact is mandatory ==');
  for (const [label, value] of [
    ['missing', undefined], ['empty', ''], ['whitespace', '   '],
    ['too short', '12'], ['not a number', 'call my son'],
  ]) {
    r = await call('/auth/register/patient', { method: 'POST', body: {
      name: 'EC Patient', username: 'ec' + stamp + Math.random().toString(36).slice(2, 6),
      password: 'sec@12345', confirmPassword: 'sec@12345', age: 70, emergencyContact: value,
    } });
    check(`an emergency contact that is ${label} is refused`, r.status === 400, [r.status, r.data && r.data.error]);
    if (r.status === 400) {
      check(`  ...and names the field`, r.data.field === 'emergencyContact', r.data.field);
    }
  }

  const PT_USER = 'secpt' + stamp;
  r = await call('/auth/register/patient', { method: 'POST', body: {
    name: 'Sec Patient', username: PT_USER, password: 'sec@12345',
    confirmPassword: 'sec@12345', age: 70, emergencyContact: '9800000123',
  } });
  check('a valid emergency contact is accepted', r.status === 201, r.data);
  // Registering a patient now ends at the code too, so finish it to get the
  // account back — the same one way in for everybody.
  check('patient registration also requires the code',
    r.data.mfaRequired === true && !r.data.token, Object.keys(r.data));
  const ptVerified = await call('/auth/verify-otp', { method: 'POST',
    body: { challengeId: r.data.challengeId, code: r.data.devCode } });
  check('the code completes patient registration', ptVerified.status === 200 && !!ptVerified.data.token);
  const PID = ptVerified.data.patient.id;
  check('and the emergency contact is stored',
    ptVerified.data.patient.emergencyContact === '9800000123', ptVerified.data.patient);

  // The caregiver "Add Patient" path must be guarded too, not only self-registration.
  r = await call('/caregiver/patients', { method: 'POST', token: CG_TOKEN, body: {
    mode: 'create', name: 'No EC', username: 'noec' + stamp,
    password: 'sec@12345', confirmPassword: 'sec@12345', age: 70,
  } });
  check('a caregiver cannot add a patient without one either', r.status === 400, [r.status, r.data && r.data.error]);

  console.log('\n== login now needs a second factor ==');
  r = await call('/auth/mfa-status');
  check('MFA is switched on', r.data.mfa.enabled === true, r.data.mfa);
  check('codes are 6 digits', r.data.mfa.codeLength === 6, r.data.mfa);

  r = await call('/auth/login', { method: 'POST', body: { username: PT_USER, password: 'sec@12345' } });
  check('a correct password alone returns NO token', !r.data.token, Object.keys(r.data));
  check('it returns a challenge instead', r.data.mfaRequired === true && !!r.data.challengeId, r.data);
  check('the destination is masked, not echoed in full',
    !r.data.destination || !r.data.destination.includes('9800000123'), r.data.destination);
  const challengeId = r.data.challengeId;
  const code = r.data.devCode;
  check('the development echo supplied a code for this test', /^\d{6}$/.test(String(code)));

  r = await call('/auth/login', { method: 'POST', body: { username: PT_USER, password: 'wrong-password' } });
  check('a wrong password still fails before any code is issued',
    r.status === 401 && !r.data.challengeId, r.data);

  console.log('\n== wrong, expired and reused codes ==');
  r = await call('/auth/verify-otp', { method: 'POST', body: { challengeId, code: '000000' } });
  check('a wrong code is rejected', r.status === 401 && !r.data.token, r.data);
  check('and the message does not reveal the real code',
    !String(r.data.error).includes(String(code)), r.data.error);

  r = await call('/auth/verify-otp', { method: 'POST', body: { challengeId: 'not-a-real-id', code } });
  check('an unknown challenge is rejected', r.status === 401, r.data);

  r = await call('/auth/verify-otp', { method: 'POST', body: { challengeId, code } });
  check('the correct code completes the login', r.status === 200 && !!r.data.token, r.data);
  check('and returns the right identity', r.data.role === 'patient' && r.data.patient.id === PID, r.data.role);
  const PT = r.data.token;

  r = await call('/auth/verify-otp', { method: 'POST', body: { challengeId, code } });
  check('the same code cannot be used twice', r.status !== 200 && !r.data.token, r.data);

  console.log('\n== attempt limit ==');
  r = await call('/auth/login', { method: 'POST', body: { username: PT_USER, password: 'sec@12345' } });
  const lockId = r.data.challengeId;
  const realCode = r.data.devCode;
  let locked = false;
  for (let i = 0; i < 6; i++) {
    const attempt = await call('/auth/verify-otp', { method: 'POST', body: { challengeId: lockId, code: '111111' } });
    if (attempt.status === 429) { locked = true; break; }
  }
  check('repeated wrong codes lock the challenge', locked);
  r = await call('/auth/verify-otp', { method: 'POST', body: { challengeId: lockId, code: realCode } });
  check('and the real code no longer works on a locked challenge', r.status !== 200 && !r.data.token, r.data);

  console.log('\n== resend ==');
  r = await call('/auth/login', { method: 'POST', body: { username: PT_USER, password: 'sec@12345' } });
  const resendId = r.data.challengeId;
  const firstCode = r.data.devCode;
  const cooldownMs = (await call('/auth/mfa-status')).data.mfa.resendCooldownMs || 30000;
  await new Promise((done) => setTimeout(done, cooldownMs + 500));
  r = await call('/auth/resend-otp', { method: 'POST', body: { challengeId: resendId } });
  check('a code can be resent', r.status === 200 && /^\d{6}$/.test(String(r.data.devCode)), r.data);
  const secondCode = r.data.devCode;
  check('resending issues a DIFFERENT code', secondCode !== firstCode, [firstCode, secondCode].length);

  r = await call('/auth/verify-otp', { method: 'POST', body: { challengeId: resendId, code: firstCode } });
  check('the superseded code stops working', r.status !== 200 && !r.data.token, r.data);
  r = await call('/auth/verify-otp', { method: 'POST', body: { challengeId: resendId, code: secondCode } });
  check('the newest code works', r.status === 200 && !!r.data.token, r.data);

  r = await call('/auth/resend-otp', { method: 'POST', body: { challengeId: resendId } });
  check('a consumed challenge cannot be resent', r.status >= 400, r.data);

  console.log('\n== request rate limiting ==');
  let limited = false;
  for (let i = 0; i < 10; i++) {
    const attempt = await call('/auth/login', { method: 'POST', body: { username: PT_USER, password: 'sec@12345' } });
    if (attempt.status === 429) { limited = true; break; }
  }
  check('too many code requests are rate limited', limited);

  console.log('\n== nothing secret is ever echoed ==');
  const health = await call('/health');
  const blob = JSON.stringify(health.data);
  for (const secret of ['JWT_SECRET', 'password_hash', 'code_hash', 'BHASHINI_API_KEY', 'ANTHROPIC_API_KEY']) {
    check(`/health does not expose ${secret}`, !blob.includes(secret));
  }
  const me = await call('/auth/me', { token: PT });
  const meBlob = JSON.stringify(me.data);
  check('/auth/me does not expose a password hash', !/pin_hash|password_hash/.test(meBlob));

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
