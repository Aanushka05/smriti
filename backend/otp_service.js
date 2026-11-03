/* ============================================================================
 * otp_service.js — second-factor login codes for patients and caregivers.
 *
 * A code is a short-lived password, so it is treated like one:
 *
 *   - generated with crypto.randomInt, never Math.random. A predictable code
 *     is not a second factor at all;
 *   - stored as a bcrypt HASH. A stolen database must not hand out live
 *     logins, and nothing in this file can read a code back;
 *   - single use, time limited, attempt limited, and rate limited on both
 *     sending and verifying;
 *   - compared only through bcrypt, which is constant-time for our purposes.
 *
 * DELIVERY. In production a code goes out over SMS through the existing
 * sms_service. In development there is no gateway, so the code is written to
 * the SERVER LOG and — only when OTP_DEV_ECHO is explicitly enabled — returned
 * in the response so an automated test can complete the flow. That switch
 * defaults to OFF and refuses to turn on when NODE_ENV is production.
 * ==========================================================================*/

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, uuid } = require('./database');
const { sendSms, activeProvider } = require('./sms_service');

const CODE_LENGTH = 6;
const TTL_MS = Number(process.env.OTP_TTL_MS) || 5 * 60 * 1000;        // 5 minutes
const MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS) || 5;
const MAX_RESENDS = Number(process.env.OTP_MAX_RESENDS) || 3;
const RESEND_COOLDOWN_MS = Number(process.env.OTP_RESEND_COOLDOWN_MS) || 30 * 1000;
// How many codes one account may request in a window, whatever it does with them.
const REQUEST_WINDOW_MS = Number(process.env.OTP_WINDOW_MS) || 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = Number(process.env.OTP_MAX_PER_WINDOW) || 6;

/**
 * Whether the code may be echoed back to the client. Development only.
 * Production is checked separately so a stray env var in a deployed
 * environment cannot quietly disable the second factor.
 */
function devEchoEnabled() {
  if (String(process.env.NODE_ENV).toLowerCase() === 'production') return false;
  return String(process.env.OTP_DEV_ECHO || '').toLowerCase() === 'true';
}

/** A uniformly random 6-digit code, zero-padded. */
function generateCode() {
  const max = 10 ** CODE_LENGTH;
  return String(crypto.randomInt(0, max)).padStart(CODE_LENGTH, '0');
}

/** Shows a phone or email as "9•••••1234" / "a•••@example.org". */
function maskDestination(dest) {
  const value = String(dest || '');
  if (!value) return null;
  if (value.includes('@')) {
    const [user, domain] = value.split('@');
    return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, user.length - 1))}@${domain}`;
  }
  return value.length <= 4 ? '•'.repeat(value.length)
    : `${value.slice(0, 1)}${'•'.repeat(value.length - 5)}${value.slice(-4)}`;
}

const countRecent = db.prepare(
  'SELECT COUNT(*) AS c FROM otp_challenges WHERE user_id=? AND created_at > ?');
const insertChallenge = db.prepare(`INSERT INTO otp_challenges
  (id,user_id,role,code_hash,destination,created_at,expires_at,attempts,resend_count,last_sent_at)
  VALUES (?,?,?,?,?,?,?,0,0,?)`);
const findChallenge = db.prepare('SELECT * FROM otp_challenges WHERE id=?');

/**
 * Issues a challenge for a user who has already proved their password.
 * Returns what the client needs to continue — never the code itself unless
 * the development echo is explicitly on.
 */
async function issueChallenge({ userId, role, destination }) {
  const now = Date.now();

  // Rate limit per account, so a stolen password cannot be used to spray an
  // unlimited number of codes at someone's phone.
  const recent = countRecent.get(userId, now - REQUEST_WINDOW_MS).c;
  if (recent >= MAX_REQUESTS_PER_WINDOW) {
    const err = new Error('Too many verification codes requested. Please wait a few minutes and try again.');
    err.status = 429;
    err.code = 'otp_rate_limited';
    throw err;
  }

  const code = generateCode();
  const id = uuid();
  insertChallenge.run(id, userId, role, bcrypt.hashSync(code, 8),
    destination || null, now, now + TTL_MS, now);

  await deliver(code, destination, role);

  return {
    challengeId: id,
    expiresAt: now + TTL_MS,
    destination: maskDestination(destination),
    delivery: activeProvider().name,
    // Development convenience ONLY, and never in production.
    devCode: devEchoEnabled() ? code : undefined,
  };
}

/** Sends the code, or logs it when no gateway is configured. */
async function deliver(code, destination, role) {
  const text = `Smriti: your verification code is ${code}. It expires in ${Math.round(TTL_MS / 60000)} minutes. Do not share it with anyone.`;
  const provider = activeProvider();

  if (provider.name === 'console' || !destination) {
    // Honest about what happened: the code was NOT delivered anywhere.
    console.log(`[otp] no SMS provider configured — code for ${role} ${maskDestination(destination) || '(no destination)'} is ${code}`);
    return { delivered: false, reason: 'no_provider' };
  }
  try {
    await sendSms(destination, text);
    return { delivered: true };
  } catch (err) {
    // Do not fail the login flow on a gateway hiccup; the code is still valid
    // and the user can ask for a resend. The reason is logged, not shown.
    console.error('[otp] could not send the code:', err.message);
    return { delivered: false, reason: 'send_failed' };
  }
}

/**
 * Checks a code against a challenge.
 *
 * Every failure path returns the SAME shape and a deliberately unspecific
 * message, so an attacker cannot tell "wrong code" from "expired" from
 * "already used" and work out which challenge ids are live.
 */
function verifyChallenge(challengeId, submittedCode) {
  const bad = { ok: false, error: 'That code is not correct, or it has expired. Please try again.' };
  const row = findChallenge.get(String(challengeId || ''));
  if (!row) return bad;

  const now = Date.now();
  if (row.consumed_at) return bad;                       // single use
  if (row.expires_at < now) return bad;                  // expired
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: 'Too many incorrect attempts. Please request a new code.', locked: true };
  }

  const code = String(submittedCode || '').trim();
  if (!/^\d{6}$/.test(code)) {
    db.prepare('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=?').run(row.id);
    return bad;
  }

  if (!bcrypt.compareSync(code, row.code_hash)) {
    db.prepare('UPDATE otp_challenges SET attempts=attempts+1 WHERE id=?').run(row.id);
    const left = MAX_ATTEMPTS - (row.attempts + 1);
    return left > 0 ? bad
      : { ok: false, error: 'Too many incorrect attempts. Please request a new code.', locked: true };
  }

  // Burn it in the same statement that checks it is still unburnt, so two
  // requests racing with the same code cannot both succeed.
  const consumed = db.prepare(
    'UPDATE otp_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(now, row.id);
  if (consumed.changes !== 1) return bad;

  return { ok: true, userId: row.user_id, role: row.role };
}

/** Issues a fresh code for an existing challenge, within limits. */
async function resendChallenge(challengeId) {
  const row = findChallenge.get(String(challengeId || ''));
  if (!row) {
    const err = new Error('That verification session has expired. Please sign in again.');
    err.status = 400; throw err;
  }
  if (row.consumed_at) {
    const err = new Error('That code has already been used. Please sign in again.');
    err.status = 400; throw err;
  }
  const now = Date.now();
  if (row.resend_count >= MAX_RESENDS) {
    const err = new Error('You have requested too many codes. Please sign in again in a few minutes.');
    err.status = 429; throw err;
  }
  if (row.last_sent_at && now - row.last_sent_at < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - row.last_sent_at)) / 1000);
    const err = new Error(`Please wait ${wait} more seconds before asking for another code.`);
    err.status = 429; throw err;
  }

  // A resend replaces the code: the previous one must stop working, or
  // "resend" would quietly widen the window of valid codes.
  const code = generateCode();
  db.prepare(`UPDATE otp_challenges SET code_hash=?, expires_at=?, attempts=0,
    resend_count=resend_count+1, last_sent_at=? WHERE id=?`)
    .run(bcrypt.hashSync(code, 8), now + TTL_MS, now, row.id);

  await deliver(code, row.destination, row.role);

  return {
    challengeId: row.id,
    expiresAt: now + TTL_MS,
    destination: maskDestination(row.destination),
    resendsLeft: MAX_RESENDS - (row.resend_count + 1),
    devCode: devEchoEnabled() ? code : undefined,
  };
}

/** Whether second-factor login is switched on at all. */
function mfaEnabled() {
  // Defaults ON. Turning it off is a deliberate act and is logged at startup.
  return String(process.env.MFA_ENABLED || 'true').toLowerCase() !== 'false';
}

function otpStatus() {
  return {
    enabled: mfaEnabled(),
    codeLength: CODE_LENGTH,
    ttlMinutes: Math.round(TTL_MS / 60000),
    maxAttempts: MAX_ATTEMPTS,
    maxResends: MAX_RESENDS,
    // Published so a client can show an honest countdown instead of guessing.
    resendCooldownMs: RESEND_COOLDOWN_MS,
    delivery: activeProvider().name,
    devEcho: devEchoEnabled(),
  };
}

module.exports = {
  issueChallenge, verifyChallenge, resendChallenge,
  mfaEnabled, otpStatus, maskDestination,
  CODE_LENGTH, TTL_MS, MAX_ATTEMPTS, MAX_RESENDS,
};
