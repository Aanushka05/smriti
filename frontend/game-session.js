/* ============================================================================
 * game-session.js — how long, and how often.
 *
 * Cognitive activities help; unlimited screen time does not. The patient gets
 * a bounded amount of play per day, and only a caregiver can extend it.
 *
 * The limit is enforced ON THE DEVICE, from data in IndexedDB, because it has
 * to hold with no network — an "are you allowed?" call to the server would
 * simply fail open when the signal drops, which is the one moment it matters.
 * The server is the record of truth for the ALLOWANCE (a caregiver granting an
 * extra session); the device is the record of truth for USAGE, and syncs it up.
 * ==========================================================================*/

const GAME_LIMITS = {
  SESSION_MINUTES: 30,        // one stretch of play
  DAILY_SESSIONS: 3,          // before a caregiver has to agree to more
  WARN_AT_MINUTES: 25,        // a gentle heads-up before time is up
};

const SESSION_STATE = { ACTIVE: 'active', ENDED: 'ended' };

/** The local day key, so the allowance resets at midnight on the device. */
function gameDayKey(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Today's play record for this patient: the sessions used, and how many are
 * allowed. Reads local first and never needs the network.
 */
async function gameAllowance(patientId, day) {
  const dayKey = day || gameDayKey();
  const fallback = {
    dayKey,
    used: 0,
    allowed: GAME_LIMITS.DAILY_SESSIONS,
    granted: 0,
    remaining: GAME_LIMITS.DAILY_SESSIONS,
    active: null,
    totalMs: 0,
    sessions: [],
  };
  if (!localDbAvailable()) return fallback;

  await openLocalDb();
  const rows = (await dexieDb.gameSessions
    .where('[patientId+dayKey]').equals([patientId, dayKey]).toArray())
    .sort((a, b) => a.startedAt - b.startedAt);

  // A grant is a caregiver decision, so it comes from the profile the server
  // sent — the patient's own device must not be able to award itself more.
  const profile = await dexieDb.profile.get(patientId);
  const granted = Number((profile && profile.extraGameSessions) || 0);
  // The caregiver may have set a different standing limit; honour it.
  const base = Number((profile && profile.maxGameSessions)) || GAME_LIMITS.DAILY_SESSIONS;
  const allowed = base + granted;

  const active = rows.find((r) => r.status === SESSION_STATE.ACTIVE) || null;
  const used = rows.filter((r) => r.status === SESSION_STATE.ENDED).length;

  return {
    dayKey,
    used,
    allowed,
    granted,
    baseAllowance: base,
    remaining: Math.max(0, allowed - used),
    active,
    totalMs: rows.reduce((sum, r) => sum + (r.durationMs || 0), 0),
    sessions: rows,
  };
}

/**
 * Whether the patient may start playing right now, and if not, why not —
 * the reason is what the screen shows them, so it has to be specific.
 */
async function canPlayNow(patientId) {
  const a = await gameAllowance(patientId);
  if (a.active) {
    const elapsedMs = Date.now() - a.active.startedAt;
    if (elapsedMs >= GAME_LIMITS.SESSION_MINUTES * 60000) {
      return { ok: false, reason: 'session_time_up', allowance: a };
    }
    return { ok: true, reason: 'resuming', allowance: a, elapsedMs };
  }
  if (a.remaining <= 0) return { ok: false, reason: 'daily_sessions_used', allowance: a };
  return { ok: true, reason: 'new_session', allowance: a };
}

/**
 * Opens a play session, or returns the one already running. Written locally
 * and queued, so a session started with no signal still counts.
 */
async function startGameSession(patientId) {
  const gate = await canPlayNow(patientId);
  if (!gate.ok) return gate;
  if (gate.allowance.active) return { ok: true, session: gate.allowance.active, allowance: gate.allowance };

  const session = {
    id: newUuid(),
    patientId,
    dayKey: gameDayKey(),
    startedAt: Date.now(),
    endedAt: null,
    durationMs: 0,
    gamesPlayed: 0,
    status: SESSION_STATE.ACTIVE,
    syncStatus: SYNC.PENDING,
  };

  await enqueueEvent(EVENT.GAME_SESSION_START, {
    sessionId: session.id, dayKey: session.dayKey, startedAt: session.startedAt,
  }, {
    patientId,
    tables: ['gameSessions'],
    localWrite: async () => { await dexieDb.gameSessions.add(session); },
  });

  return { ok: true, session, allowance: await gameAllowance(patientId) };
}

/** Closes the running session. Idempotent: closing a closed session is a no-op. */
async function endGameSession(patientId, reason) {
  if (!localDbAvailable()) return null;
  await openLocalDb();
  const a = await gameAllowance(patientId);
  if (!a.active) return null;

  const endedAt = Date.now();
  const durationMs = endedAt - a.active.startedAt;

  await enqueueEvent(EVENT.GAME_SESSION_END, {
    sessionId: a.active.id, dayKey: a.active.dayKey, startedAt: a.active.startedAt,
    endedAt, durationMs, gamesPlayed: a.active.gamesPlayed || 0, reason: reason || 'finished',
  }, {
    patientId,
    tables: ['gameSessions'],
    localWrite: async () => {
      await dexieDb.gameSessions.update(a.active.id, {
        endedAt, durationMs, status: SESSION_STATE.ENDED, endReason: reason || 'finished',
        syncStatus: SYNC.PENDING,
      });
    },
  });

  return { endedAt, durationMs };
}

/** Counts a completed game against the running session. */
async function noteGamePlayed(patientId) {
  if (!localDbAvailable()) return;
  await openLocalDb();
  const a = await gameAllowance(patientId);
  if (!a.active) return;
  await dexieDb.gameSessions.update(a.active.id, {
    gamesPlayed: (a.active.gamesPlayed || 0) + 1,
  });
}

/** Milliseconds left in the running session, or null when none is running. */
function sessionTimeLeftMs(active) {
  if (!active) return null;
  return Math.max(0, GAME_LIMITS.SESSION_MINUTES * 60000 - (Date.now() - active.startedAt));
}

/* --------------------------------------------------------- the watchdog
 * A patient can leave a game open. The session has to close itself, or the
 * 30-minute limit means nothing.
 */
let sessionWatchdog = null;

function startSessionWatchdog() {
  stopSessionWatchdog();
  sessionWatchdog = setInterval(async () => {
    if (!state.patientId || state.role !== 'patient') return;
    const a = await gameAllowance(state.patientId);
    if (!a.active) return;
    const left = sessionTimeLeftMs(a.active);
    if (left <= 0) {
      await endGameSession(state.patientId, 'time_limit');
      if (state.game) { clearGameTimers(); state.game = null; }
      state.sessionEndedMessage = 'time_limit';
      goto('patient-home');
      render();
    } else if (state.screen && String(state.screen).startsWith('game-')) {
      // Keep the on-screen countdown honest without a re-render storm.
      const host = document.getElementById('session-clock');
      if (host) host.textContent = formatTimeLeft(left);
    }
  }, 10000);
}

function stopSessionWatchdog() {
  if (sessionWatchdog) clearInterval(sessionWatchdog);
  sessionWatchdog = null;
}

function formatTimeLeft(ms) {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
