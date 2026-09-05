// routes/auth.js — registration, login, session for SmritiSaathi Care.
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
function createPatient({ name, username, password, age, gender, lang, mobile, emergencyContact, createdBy }) {
  const id = uuid();
  db.prepare(`INSERT INTO patients
    (id,username,name,age,gender,mobile,lang,emergency_contact,pin_hash,created_at,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, username, name, age || null, gender || null, mobile || null, lang || 'en-IN',
    emergencyContact || null, bcrypt.hashSync(String(password), 8), Date.now(), createdBy || null
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

  const token = signToken({ id: row.id, role: 'patient' });
  res.status(201).json({
    token, role: 'patient', patient: patientPublic(row),
    linkedCaregiver: caregiver ? { id: caregiver.id, username: caregiver.username, name: caregiver.name } : null,
    message: `Welcome, ${row.name}. Your account has been created.`,
  });
}
router.post('/auth/register/patient', registerPatientHandler);

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

  const id = uuid();
  try {
    db.prepare(`INSERT INTO caregivers (id,username,name,mobile,email,role,relationship,lang,password_hash,created_at)
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
  const token = signToken({ id, role: 'caregiver' });
  res.status(201).json({
    token, role: 'caregiver', caregiver: caregiverPublic(row), patients: [],
    message: `Welcome, ${row.name}. Your caregiver account has been created.`,
  });
}
router.post('/auth/register/caregiver', registerCaregiverHandler);

// ------------------------------------------------------------------ LOGIN
// POST /api/auth/login  { username, password }
// The role is resolved from whichever table owns the username, so the same
// form works for both patients and caregivers.
router.post('/auth/login', (req, res) => {
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
    const token = signToken({ id: patient.id, role: 'patient' });
    return res.json({ token, role: 'patient', patient: patientPublic(patient) });
  }

  const caregiver = db.prepare('SELECT * FROM caregivers WHERE lower(username)=? OR lower(email)=? OR mobile=?')
    .get(key, key, identifier);
  if (caregiver) {
    if (!bcrypt.compareSync(password, caregiver.password_hash)) {
      return fail(res, 401, 'Incorrect username or password.', 'password');
    }
    const token = signToken({ id: caregiver.id, role: 'caregiver' });
    return res.json({
      token, role: 'caregiver', caregiver: caregiverPublic(caregiver),
      patients: caregiverPatients(caregiver.id),
    });
  }

  return fail(res, 401, 'Incorrect username or password.', 'username');
});

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
