// routes/auth.js — registration, login, session for Smriti.
//
// Accounts are username + password for BOTH roles, so a user can pick
// their own simple credentials (e.g. rahul123 / rahul@123) and log straight
// back in with them. Usernames are unique across patients AND caregivers
// together, which is what lets a single /api/auth/login endpoint resolve
// the role by itself.
//
// Passwords are hashed with bcrypt before they touch the database and are
// never returned by any endpoint.

const express = require('express');
const bcrypt = require('bcryptjs');
const { db, uuid, slugify } = require('../database');
const { signToken, requireAuth } = require('../middleware/auth');
const {
  issueChallenge, verifyChallenge, resendChallenge, mfaEnabled, otpStatus,
} = require('../otp_service');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9._]{3,30}$/;
const MIN_PASSWORD = 4; // low, deliberately: elderly patients often use a 4-6 digit PIN

// ------------------------------------------------------------- helpers
function fail(res, status, error, field) {
  return res.status(status).json({ error, field: field || null });
}

function normUsername(value) {
  return String(value || '').trim().toLowerCase();
}

/** A username may exist in at most one of the two account tables. */
function usernameTaken(username) {
  const p = db.prepare('SELECT id FROM patients WHERE lower(username)=?').get(username);
  if (p) return 'patient';
  const c = db.prepare('SELECT id FROM caregivers WHERE lower(username)=?').get(username);
  if (c) return 'caregiver';
  return null;
}

function validateCredentials({ username, password, confirmPassword }, res) {
  if (!username) { fail(res, 400, 'Please choose a username.', 'username'); return false; }
  if (!USERNAME_RE.test(username)) {
    fail(res, 400, 'Username must be 3-30 characters and may contain only letters, numbers, dots and underscores.', 'username');
    return false;
  }
  if (!password || String(password).length < MIN_PASSWORD) {
    fail(res, 400, `Password must be at least ${MIN_PASSWORD} characters.`, 'password');
    return false;
  }
  if (confirmPassword !== undefined && String(password) !== String(confirmPassword)) {
    fail(res, 400, 'Password and Confirm Password do not match.', 'confirmPassword');
    return false;
  }
  if (usernameTaken(username)) {
    fail(res, 409, 'That username is already taken. Please choose another one.', 'username');
    return false;
  }
  return true;
}

function patientPublic(row) {
  if (!row) return null;
  const family = db.prepare('SELECT id,name,relation,initial,color FROM family_members WHERE patient_id=?').all(row.id);
  return {
    id: row.id, username: row.username, name: row.name, age: row.age, gender: row.gender,
    mobile: row.mobile, lang: row.lang, emergencyContact: row.emergency_contact, family,
    createdAt: row.created_at,
  };
}

function caregiverPublic(row) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, name: row.name, mobile: row.mobile, email: row.email,
    role: row.role, relationship: row.relationship, lang: row.lang, createdAt: row.created_at,
  };
}

function caregiverPatients(caregiverId) {
  return db.prepare(`SELECT p.id, p.username, p.name, p.age, p.gender, p.lang
     FROM patients p JOIN caregiver_patients cp ON cp.patient_id = p.id
     WHERE cp.caregiver_id = ? ORDER BY p.name COLLATE NOCASE`).all(caregiverId);
}

/** Three starter family entries so Family Faces is playable immediately. */
function seedStarterFamily(patientId) {
  const starter = [
    { name: 'Family member 1', relation: 'Family member 1', initial: 'F1', color: '#6B2737' },
    { name: 'Family member 2', relation: 'Family member 2', initial: 'F2', color: '#3E5C3A' },
    { name: 'Family member 3', relation: 'Family member 3', initial: 'F3', color: '#C88B2E' },
  ];
  const stmt = db.prepare('INSERT INTO family_members (id,patient_id,name,relation,initial,color) VALUES (?,?,?,?,?,?)');
  starter.forEach((f) => stmt.run(uuid(), patientId, f.name, f.relation, f.initial, f.color));
}

/**
 * Creates a patient row. Shared by self-registration and by a caregiver
 * creating a patient from "Add Patient", so both paths produce an account
 * that can actually log in.
 */
/**
 * A patient's emergency contact is the only route a missed-dose alert has to
 * a human being, so it is required rather than optional. Validated in one
 * place so no caller can skip it by talking to the API directly.
 */
function validateEmergencyContact(value) {
  const contact = String(value == null ? '' : value).trim();
  if (!contact) return { ok: false, error: 'Please enter an emergency contact number.' };
  const digits = contact.replace(/[^0-9]/g, '');
  if (!/^[0-9+\-\s()]{6,20}$/.test(contact) || digits.length < 6 || digits.length > 15) {
    return { ok: false, error: 'Please enter a valid emergency contact phone number.' };
  }
  return { ok: true, value: contact };
}

function createPatient({ name, username, password, age, gender, lang, mobile, emergencyContact, createdBy }) {
  const emergency = validateEmergencyContact(emergencyContact);
  if (!emergency.ok) {
    const err = new Error(emergency.error);
    err.status = 400; err.field = 'emergencyContact';
    throw err;
  }
  const id = uuid();
  db.prepare(`INSERT INTO patients
    (id,username,name,age,gender,mobile,lang,emergency_contact,pin_hash,created_at,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, username, name, age || null, gender || null, mobile || null, lang || 'en-IN',
    emergency.value, bcrypt.hashSync(String(password), 8), Date.now(), createdBy || null
  );
  seedStarterFamily(id);
  return db.prepare('SELECT * FROM patients WHERE id=?').get(id);
}

function linkCaregiverPatient(caregiverId, patientId) {
  db.prepare('INSERT OR IGNORE INTO caregiver_patients (caregiver_id,patient_id) VALUES (?,?)').run(caregiverId, patientId);
}

// ------------------------------------------------------- REGISTER PATIENT
// POST /api/auth/register/patient
function registerPatientHandler(req, res) {
  const b = req.body || {};
  const name = String(b.name || b.fullName || '').trim();
  const username = normUsername(b.username);

  if (!name) return fail(res, 400, 'Please enter the full name.', 'name');
  if (!validateCredentials({ username, password: b.password, confirmPassword: b.confirmPassword }, res)) return;

  const age = b.age === '' || b.age == null ? null : Number(b.age);
  if (age !== null && (!Number.isFinite(age) || age < 1 || age > 120)) {
    return fail(res, 400, 'Please enter a valid age between 1 and 120.', 'age');
  }
  const mobile = String(b.mobile || '').trim() || null;
  if (mobile && db.prepare('SELECT id FROM patients WHERE mobile=?').get(mobile)) {
    return fail(res, 409, 'A patient with this mobile number is already registered.', 'mobile');
  }

  // Optional caregiver link, by caregiver username or caregiver id.
  const caregiverKey = String(b.caregiverUsername || b.caregiverId || '').trim();
  let caregiver = null;
  if (caregiverKey) {
    caregiver = db.prepare('SELECT * FROM caregivers WHERE lower(username)=? OR id=?')
      .get(caregiverKey.toLowerCase(), caregiverKey);
    if (!caregiver) {
      return fail(res, 404, `No caregiver found with the ID "${caregiverKey}". Leave it blank if you do not have one yet.`, 'caregiverUsername');
    }
  }

  let row;
  try {
    row = db.transaction(() => {
      const created = createPatient({
        name, username, password: b.password, age, gender: b.gender, lang: b.lang,
        mobile, emergencyContact: b.emergencyContact, createdBy: caregiver ? caregiver.id : null,
      });
      if (caregiver) linkCaregiverPatient(caregiver.id, created.id);
      return created;
    })();
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return fail(res, 409, 'That username or mobile number is already registered.', 'username');
    }
    throw err;
  }

  // The same second factor as login and as caregiver registration, so there
  // is exactly one way into a session. Registering used to hand back a token
  // directly, which meant an account could be created and used without the
  // code ever being seen.
  if (mfaEnabled()) {
    return beginMfa(res, 'patient', row, {
      status: 201,
      message: `Welcome, ${row.name}. We have sent a 6-digit code to confirm it is you.`,
    });
  }

  return res.status(201).json({
    token: signToken({ id: row.id, role: 'patient' }),
    role: 'patient', patient: patientPublic(row),
    linkedCaregiver: caregiver ? { id: caregiver.id, username: caregiver.username, name: caregiver.name } : null,
    message: `Welcome, ${row.name}. Your account has been created.`,
  });
}
// createPatient throws a tagged validation error; turn it into the same
// shape every other field error uses so the form can highlight it.
function withValidation(handler) {
  return (req, res, next) => {
    try {
      // The handler now returns a promise (registration ends in an async
      // second factor), so a rejection has to be caught here too — a sync
      // try/catch alone would let it escape as an unhandled rejection and
      // leave the request hanging.
      return Promise.resolve(handler(req, res, next)).catch((err) => {
        if (res.headersSent) return;
        if (err && err.status === 400) return fail(res, 400, err.message, err.field);
        return next(err);
      });
    } catch (err) {
      if (err && err.status === 400) return fail(res, 400, err.message, err.field);
      throw err;
    }
  };
}

router.post('/auth/register/patient', withValidation(registerPatientHandler));

// ----------------------------------------------------- REGISTER CAREGIVER
// POST /api/auth/register/caregiver
function registerCaregiverHandler(req, res) {
  const b = req.body || {};
  const name = String(b.name || b.fullName || '').trim();
  const username = normUsername(b.username);
  const contact = String(b.contact || b.email || b.mobile || '').trim();
  const relationship = String(b.relationship || b.role || 'family').trim();

  if (!name) return fail(res, 400, 'Please enter the full name.', 'name');
  if (!validateCredentials({ username, password: b.password, confirmPassword: b.confirmPassword }, res)) return;
  if (!contact) return fail(res, 400, 'Please enter an email address or phone number.', 'contact');

  const isEmail = contact.includes('@');
  if (isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    return fail(res, 400, 'Please enter a valid email address.', 'contact');
  }
  if (!isEmail && !/^[0-9+\-\s]{6,15}$/.test(contact)) {
    return fail(res, 400, 'Please enter a valid phone number or an email address.', 'contact');
  }
  const email = isEmail ? contact : null;
  const mobile = isEmail ? null : contact;
  if (email && db.prepare('SELECT id FROM caregivers WHERE email=?').get(email)) {
    return fail(res, 409, 'A caregiver with this email is already registered.', 'contact');
  }

  // No document is required. A caregiver proves who they are with a second
  // factor at sign-in, which is checkable and revocable; an uploaded image
  // was neither, and it stopped legitimate caregivers registering at all.
  //
  // The verification_* columns are left in the schema untouched so existing
  // rows keep their data, but nothing reads them any more.
  const id = uuid();
  try {
    db.prepare(`INSERT INTO caregivers
      (id,username,name,mobile,email,role,relationship,lang,password_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      id, username, name, mobile, email, b.role || 'family', relationship, b.lang || 'en-IN',
      bcrypt.hashSync(String(b.password), 8), Date.now()
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return fail(res, 409, 'That username or email is already registered.', 'username');
    }
    throw err;
  }

  const row = db.prepare('SELECT * FROM caregivers WHERE id=?').get(id);

  // Registration went straight to a session before, which quietly bypassed
  // the second factor: create an account, get a token, never see a code.
  // It now ends where login ends, so there is one way in and one only.
  if (mfaEnabled()) {
    return beginMfa(res, 'caregiver', row, {
      status: 201,
      message: `Welcome, ${row.name}. We have sent a 6-digit code to confirm it is you.`,
    });
  }

  return res.status(201).json({
    token: signToken({ id, role: 'caregiver' }),
    role: 'caregiver', caregiver: caregiverPublic(row), patients: [],
    message: `Welcome, ${row.name}. Your caregiver account has been created.`,
  });
}
router.post('/auth/register/caregiver', withValidation(registerCaregiverHandler));

// ------------------------------------------------------------------ LOGIN
// POST /api/auth/login  { username, password }
// The role is resolved from whichever table owns the username, so the same
// form works for both patients and caregivers.
// Wraps an async handler so a rejected promise becomes a response rather
// than a request that never finishes.
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch((err) => {
    if (res.headersSent) return;
    if (err && err.status) return res.status(err.status).json({ error: err.message, field: err.field });
    next(err);
  });
};

router.post('/auth/login', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const identifier = String(b.username || b.identifier || '').trim();
  const password = String(b.password || '');
  if (!identifier || !password) return fail(res, 400, 'Please enter your username and password.', 'username');

  const key = identifier.toLowerCase();
  const patient = db.prepare('SELECT * FROM patients WHERE lower(username)=? OR mobile=?').get(key, identifier);
  if (patient) {
    if (!bcrypt.compareSync(password, patient.pin_hash)) {
      return fail(res, 401, 'Incorrect username or password.', 'password');
    }
    // Password accepted. That is the FIRST factor only.
    if (mfaEnabled()) return beginMfa(res, 'patient', patient);
    return issueSession(res, 'patient', patient);
  }

  const caregiver = db.prepare('SELECT * FROM caregivers WHERE lower(username)=? OR lower(email)=? OR mobile=?')
    .get(key, key, identifier);
  if (caregiver) {
    if (!bcrypt.compareSync(password, caregiver.password_hash)) {
      return fail(res, 401, 'Incorrect username or password.', 'password');
    }
    if (mfaEnabled()) return beginMfa(res, 'caregiver', caregiver);
    return issueSession(res, 'caregiver', caregiver);
  }

  return fail(res, 401, 'Incorrect username or password.', 'username');
}));

/* ------------------------------------------------------------------ MFA
 * A password is the first factor; the code is the second. Login therefore
 * ends in a CHALLENGE, not a token — the token is only minted once the code
 * has been verified. Anything else would make the second factor decorative.
 */

/** Where a code should be sent for this account. */
function otpDestinationFor(role, row) {
  if (role === 'patient') return row.mobile || row.emergency_contact || null;
  return row.mobile || row.email || null;
}

/** The reply that starts a second-factor login. Carries no token. */
async function beginMfa(res, role, row, opts = {}) {
  // Express 4 does not catch a rejected promise from a route handler, so a
  // rate-limit refusal thrown here would hang the request instead of
  // answering it. Handle it where it happens.
  let challenge;
  try {
    challenge = await issueChallenge({
      userId: row.id, role, destination: otpDestinationFor(role, row),
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.status ? err.message : 'Could not start verification. Please try again.',
      field: 'password',
    });
  }
  return res.status(opts.status || 200).json({
    mfaRequired: true,
    challengeId: challenge.challengeId,
    role,
    expiresAt: challenge.expiresAt,
    destination: challenge.destination,
    delivery: challenge.delivery,
    // Present only when OTP_DEV_ECHO is on, and never in production.
    devCode: challenge.devCode,
    message: opts.message || (challenge.destination
      ? `We sent a 6-digit code to ${challenge.destination}.`
      : 'A 6-digit code has been generated for this account.'),
  });
}

/** The reply that completes a login, for either role. */
function issueSession(res, role, row) {
  if (role === 'patient') {
    // The caregiver a patient registered against used to be reported by the
    // registration response. That response is now a challenge, so the link is
    // reported here instead — where the session is actually created — rather
    // than being quietly lost.
    const linked = db.prepare(
      `SELECT c.id, c.username, c.name FROM caregivers c
       JOIN caregiver_patients cp ON cp.caregiver_id = c.id
       WHERE cp.patient_id = ? ORDER BY c.name COLLATE NOCASE LIMIT 1`).get(row.id) || null;
    return res.json({
      token: signToken({ id: row.id, role: 'patient' }),
      role: 'patient', patient: patientPublic(row),
      linkedCaregiver: linked,
    });
  }
  return res.json({
    token: signToken({ id: row.id, role: 'caregiver' }),
    role: 'caregiver', caregiver: caregiverPublic(row),
    patients: caregiverPatients(row.id),
  });
}

// POST /api/auth/verify-otp  { challengeId, code }
router.post('/auth/verify-otp', (req, res) => {
  const b = req.body || {};
  const result = verifyChallenge(b.challengeId, b.code);
  if (!result.ok) {
    return res.status(result.locked ? 429 : 401).json({ error: result.error, field: 'code' });
  }

  const row = result.role === 'patient'
    ? db.prepare('SELECT * FROM patients WHERE id=?').get(result.userId)
    : db.prepare('SELECT * FROM caregivers WHERE id=?').get(result.userId);
  if (!row) return fail(res, 401, 'That account no longer exists.', 'code');

  return issueSession(res, result.role, row);
});

// POST /api/auth/resend-otp  { challengeId }
router.post('/auth/resend-otp', asyncRoute(async (req, res) => {
  try {
    const out = await resendChallenge((req.body || {}).challengeId);
    return res.json({
      ok: true, challengeId: out.challengeId, expiresAt: out.expiresAt,
      destination: out.destination, resendsLeft: out.resendsLeft, devCode: out.devCode,
      message: 'A new code is on its way.',
    });
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message, field: 'code' });
  }
}));

// GET /api/auth/mfa-status — what the login screen needs to know up front.
router.get('/auth/mfa-status', (req, res) => res.json({ ok: true, mfa: otpStatus() }));

// ------------------------------------------------------------------- ME
// GET /api/auth/me — used on page load to restore a session, and by the
// frontend route guard to detect an expired token.
router.get('/auth/me', requireAuth, (req, res) => {
  if (req.user.role === 'patient') {
    const row = db.prepare('SELECT * FROM patients WHERE id=?').get(req.user.id);
    return res.json({ role: 'patient', patient: patientPublic(row) });
  }
  const row = db.prepare('SELECT * FROM caregivers WHERE id=?').get(req.user.id);
  res.json({ role: 'caregiver', caregiver: caregiverPublic(row), patients: caregiverPatients(row.id) });
});

// POST /api/auth/logout — the token is stateless, so this only exists so
// the client has one honest endpoint to call; it always succeeds.
router.post('/auth/logout', (req, res) => res.json({ ok: true }));

// GET /api/auth/username-available?username=rahul123
router.get('/auth/username-available', (req, res) => {
  const username = normUsername(req.query.username);
  if (!USERNAME_RE.test(username)) return res.json({ available: false, reason: 'invalid' });
  res.json({ available: !usernameTaken(username) });
});

// ------------------------------------------------------ LEGACY ENDPOINTS
// Kept so anything still calling the original mobile/email routes keeps
// working. They delegate to exactly the same tables and hashing.
router.post('/patients/register', (req, res) => {
  const b = req.body || {};
  const secret = b.password || b.pin;
  req.body = {
    ...b,
    username: b.username || slugify(b.mobile, `patient${Date.now()}`),
    password: secret,
    confirmPassword: b.confirmPassword != null ? b.confirmPassword : secret,
  };
  return registerPatientHandler(req, res);
});

router.post('/patients/login', (req, res) => {
  const { mobile, pin, username, password } = req.body || {};
  const row = db.prepare('SELECT * FROM patients WHERE mobile=? OR lower(username)=?')
    .get(String(mobile || ''), String(username || mobile || '').toLowerCase());
  const secret = String(pin || password || '');
  if (!row || !bcrypt.compareSync(secret, row.pin_hash)) {
    return fail(res, 401, 'Invalid mobile number or PIN.');
  }
  res.json({ token: signToken({ id: row.id, role: 'patient' }), role: 'patient', patient: patientPublic(row) });
});

router.post('/caregivers/register', (req, res) => {
  const b = req.body || {};
  req.body = {
    ...b,
    username: b.username || slugify((b.email || '').split('@')[0], `caregiver${Date.now()}`),
    contact: b.contact || b.email || b.mobile,
    confirmPassword: b.confirmPassword != null ? b.confirmPassword : b.password,
    relationship: b.relationship || b.role || 'family',
  };
  return registerCaregiverHandler(req, res);
});

router.post('/caregivers/login', (req, res) => {
  const { email, password, username } = req.body || {};
  const key = String(username || email || '').toLowerCase();
  const row = db.prepare('SELECT * FROM caregivers WHERE lower(email)=? OR lower(username)=?').get(key, key);
  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash)) {
    return fail(res, 401, 'Invalid email or password.');
  }
  res.json({
    token: signToken({ id: row.id, role: 'caregiver' }), role: 'caregiver',
    caregiver: caregiverPublic(row), patients: caregiverPatients(row.id),
  });
});

module.exports = {
  router, patientPublic, caregiverPublic, caregiverPatients,
  createPatient, linkCaregiverPatient, usernameTaken, normUsername, USERNAME_RE, MIN_PASSWORD,
};
