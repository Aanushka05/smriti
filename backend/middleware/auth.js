// middleware/auth.js — JWT issuing + route protection for SmritiSaathi Care.
//
// Every protected route goes through requireAuth, which puts a normalised
// `req.user = { id, role, username, name }` on the request. Ownership
// checks (a caregiver may only touch patients linked to them; a patient may
// only touch their own record) live in requirePatientAccess so no route has
// to re-implement them.

const jwt = require('jsonwebtoken');
const { db } = require('../database');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_TTL = process.env.JWT_TTL || '12h';

if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET is not set — using an insecure development secret. Set it in backend/.env before deploying.');
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return null;
}

/** Populates req.user when a valid token is present; never rejects. */
function optionalAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return next();
  try {
    req.user = resolveUser(jwt.verify(token, JWT_SECRET));
  } catch (err) { /* ignore — treated as anonymous */ }
  next();
}

function resolveUser(claims) {
  if (!claims || !claims.id || !claims.role) return null;
  if (claims.role === 'patient') {
    const row = db.prepare('SELECT id,username,name,lang FROM patients WHERE id=?').get(claims.id);
    return row ? { id: row.id, role: 'patient', username: row.username, name: row.name, lang: row.lang } : null;
  }
  const row = db.prepare('SELECT id,username,name,lang FROM caregivers WHERE id=?').get(claims.id);
  return row ? { id: row.id, role: 'caregiver', username: row.username, name: row.name, lang: row.lang } : null;
}

function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ error: 'You are not signed in. Please log in again.', code: 'NO_TOKEN' });
  }
  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Your session has expired. Please log in again.' : 'Your session is no longer valid. Please log in again.',
      code: expired ? 'TOKEN_EXPIRED' : 'BAD_TOKEN',
    });
  }
  const user = resolveUser(claims);
  if (!user) {
    return res.status(401).json({ error: 'This account no longer exists. Please log in again.', code: 'NO_USER' });
  }
  req.user = user;
  next();
}

function requireRole(role) {
  return function roleGuard(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'You are not signed in.', code: 'NO_TOKEN' });
    if (req.user.role !== role) {
      return res.status(403).json({ error: `This action is only available to a ${role} account.`, code: 'WRONG_ROLE' });
    }
    next();
  };
}

/** True when this user is allowed to read/write the given patient. */
function canAccessPatient(user, patientId) {
  if (!user || !patientId) return false;
  if (user.role === 'patient') return user.id === patientId;
  const link = db.prepare('SELECT 1 FROM caregiver_patients WHERE caregiver_id=? AND patient_id=?').get(user.id, patientId);
  return !!link;
}

/**
 * Guards any route with a :patientId param (or a patientId in the body).
 * Responds 404 for an unknown patient and 403 for one this user is not
 * linked to, so a caregiver can never read another caregiver's patient.
 */
function requirePatientAccess(req, res, next) {
  const patientId = req.params.patientId || (req.body || {}).patientId || req.query.patientId;
  if (!patientId) return res.status(400).json({ error: 'patientId is required.' });
  const exists = db.prepare('SELECT id FROM patients WHERE id=?').get(patientId);
  if (!exists) return res.status(404).json({ error: 'Patient not found.' });
  if (!canAccessPatient(req.user, patientId)) {
    return res.status(403).json({ error: 'This patient is not linked to your account.', code: 'NOT_LINKED' });
  }
  req.patientId = patientId;
  next();
}

module.exports = {
  signToken, requireAuth, optionalAuth, requireRole,
  requirePatientAccess, canAccessPatient, JWT_SECRET, TOKEN_TTL,
};
