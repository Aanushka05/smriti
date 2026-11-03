/* Adaptive difficulty, grading, and the play allowance.
 * Run against a live server from the project root. */
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

const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
});
const stamp = Date.now().toString().slice(-6);
const today = (() => { const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();

(async () => {
  const cg = (await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Adaptive CG', username: 'adcg' + stamp, password: 'adapt@1234',
    confirmPassword: 'adapt@1234', contact: `adcg${stamp}@example.org`, role: 'asha',
  } })).data;
  const CG = cg.token;
  const made = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Adaptive Patient', username: 'adpt' + stamp,
    password: 'adapt@1234', confirmPassword: 'adapt@1234', age: 71,
  } });
  const PID = made.data.patient.id;
  const PT = (await call('/auth/login', { method: 'POST',
    body: { username: 'adpt' + stamp, password: 'adapt@1234' } })).data.token;
  const deviceId = 'test-device-' + stamp;

  console.log('\n== the play allowance ==');
  let r = await call(`/patients/${PID}/play`, { token: CG });
  check('a new patient gets the default allowance',
    r.data.play.allowed === 3 && r.data.play.baseAllowance === 3, r.data.play);
  check('sessions are capped at 30 minutes', r.data.play.sessionMinutes === 30, r.data.play);
  check('nothing is used yet', r.data.play.used === 0 && r.data.play.remaining === 3, r.data.play);

  r = await call(`/patients/${PID}`, { token: PT });
  check('the allowance travels with the profile, so the device knows it offline',
    !!r.data.play && r.data.play.allowed === 3, r.data.play);

  console.log('\n== the device reports play, the server records it ==');
  const sessionIds = [uuid(), uuid(), uuid()];
  for (const [i, id] of sessionIds.entries()) {
    const start = Date.now() - (3 - i) * 3600000;
    const events = [
      { eventId: uuid(), eventType: 'game_session_start', patientId: PID, occurredAt: start,
        payload: { sessionId: id, dayKey: today, startedAt: start } },
      { eventId: uuid(), eventType: 'game_session_end', patientId: PID, occurredAt: start + 600000,
        payload: { sessionId: id, dayKey: today, startedAt: start, endedAt: start + 600000,
          durationMs: 600000, gamesPlayed: 2, reason: 'finished' } },
    ];
    r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId, events } });
    check(`session ${i + 1} syncs`, r.status === 200 && r.data.results.every((x) => x.status === 'accepted'),
      r.data.results);
  }

  r = await call(`/patients/${PID}/play`, { token: CG });
  check('all three sessions are counted', r.data.play.used === 3, r.data.play);
  check('the allowance is now spent', r.data.play.remaining === 0, r.data.play);
  check('total play time adds up', r.data.play.totalMs === 1800000, r.data.play.totalMs);
  check('each session is listed for the caregiver', r.data.play.sessions.length === 3);
  check('with its duration and game count',
    r.data.play.sessions.every((s) => s.durationMs === 600000 && s.gamesPlayed === 2));

  console.log('\n== only a caregiver can grant more ==');
  r = await call(`/patients/${PID}/play/grant`, { method: 'POST', token: PT, body: { count: 5 } });
  check('the patient cannot grant themselves extra play', r.status === 403, r.data);
  r = await call(`/patients/${PID}/play`, { token: CG });
  check('and the allowance is unchanged by the attempt', r.data.play.remaining === 0, r.data.play);

  r = await call(`/patients/${PID}/play/grant`, { method: 'POST', token: CG });
  check('the caregiver can grant one more', r.status === 200 && r.data.play.remaining === 1, r.data.play);
  check('the grant is reported separately from the base', r.data.play.granted === 1, r.data.play);

  r = await call(`/patients/${PID}/play/limit`, { method: 'PUT', token: CG, body: { maxSessions: 5 } });
  check('the caregiver can change the standing limit',
    r.status === 200 && r.data.play.baseAllowance === 5, r.data.play);
  check('a grant stacks on top of the new limit', r.data.play.allowed === 6, r.data.play);

  r = await call(`/patients/${PID}/play/limit`, { method: 'PUT', token: CG, body: { maxSessions: 99 } });
  check('an absurd limit is refused', r.status === 400, r.data);
  r = await call(`/patients/${PID}/play/limit`, { method: 'PUT', token: PT, body: { maxSessions: 9 } });
  check('the patient cannot raise their own limit', r.status === 403, r.data);

  console.log('\n== play sessions never double-count ==');
  const dupe = { eventId: uuid(), eventType: 'game_session_end', patientId: PID, occurredAt: Date.now(),
    payload: { sessionId: sessionIds[0], dayKey: today, startedAt: Date.now() - 600000,
      endedAt: Date.now(), durationMs: 600000, gamesPlayed: 2, reason: 'finished' } };
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId, events: [dupe] } });
  check('a re-sent close is accepted without creating a session', r.status === 200, r.data.results);
  r = await call(`/patients/${PID}/play`, { token: CG });
  check('the session count did not change', r.data.play.used === 3, r.data.play);

  const replay = { eventId: uuid(), eventType: 'game_session_start', patientId: PID, occurredAt: Date.now(),
    payload: { sessionId: sessionIds[0], dayKey: today, startedAt: Date.now() } };
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId, events: [replay] } });
  r = await call(`/patients/${PID}/play`, { token: CG });
  check('a late start event cannot reopen a finished session', r.data.play.used === 3, r.data.play);

  console.log('\n== adaptive figures survive the round trip ==');
  const gameEventId = uuid();
  const gameEvent = {
    eventId: gameEventId, eventType: 'game_result', patientId: PID, occurredAt: Date.now(),
    payload: {
      domain: 'attention', gameType: 'Spot the Odd One', sessionId: uuid(),
      level: 3, score: 4, totalRounds: 5, accuracy: 0.8, avgTimeMs: 4200,
      answers: [], gameSessionId: sessionIds[0],
      adaptive: {
        startLevel: 2, endLevel: 3, maxLevel: 4, correct: 4, wrong: 1,
        hints: 2, skips: 1, timeouts: 1, durationMs: 42000,
        score: 71, band: 'good', status: 'difficulty_increased',
        difficultyChanges: [{ round: 3, from: 2, to: 3, reason: 'consecutive_correct' }],
      },
    },
  };
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId, events: [gameEvent] } });
  check('a game with adaptive data syncs', r.data.results[0].status === 'accepted', r.data.results);

  r = await call(`/patients/${PID}`, { token: CG });
  const s = r.data.sessions.find((x) => x.gameType === 'Spot the Odd One');
  check('the session comes back', !!s, r.data.sessions.map((x) => x.gameType));
  check('difficulty start / end / peak are stored',
    s.startLevel === 2 && s.endLevel === 3 && s.maxLevel === 4,
    [s.startLevel, s.endLevel, s.maxLevel]);
  check('hints, skips and timeouts are stored',
    s.hintsUsed === 2 && s.skippedCount === 1 && s.timeoutCount === 1,
    [s.hintsUsed, s.skippedCount, s.timeoutCount]);
  check('wrong answers are stored, not just right ones', s.wrongCount === 1, s.wrongCount);
  check('the composite score is stored', s.adaptiveScore === 71, s.adaptiveScore);
  check('the grade band is stored', s.adaptiveBand === 'good', s.adaptiveBand);
  check('the adaptive status is stored', s.adaptiveStatus === 'difficulty_increased', s.adaptiveStatus);
  check('session duration is stored', s.durationMs === 42000, s.durationMs);

  console.log('\n== re-syncing a game never duplicates it ==');
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId, events: [gameEvent] } });
  check('the replayed event is reported as a duplicate',
    r.data.results[0].status === 'duplicate', r.data.results);
  r = await call(`/patients/${PID}`, { token: CG });
  check('and only one session exists',
    r.data.sessions.filter((x) => x.gameType === 'Spot the Odd One').length === 1);

  console.log('\n== a rejected event is never silently swallowed ==');
  r = await call('/sync/batch', { method: 'POST', token: PT, body: { deviceId, events: [
    { eventId: uuid(), eventType: 'game_session_end', patientId: PID, occurredAt: Date.now(), payload: {} },
  ] } });
  check('a malformed session event is rejected with a reason',
    r.data.results[0].status === 'rejected' && !!r.data.results[0].error, r.data.results);

  console.log('\n== the frontend engine is wired in ==');
  for (const [file, needles] of [
    ['/adaptive.js', ['adaptiveDecide', 'PROMOTE_STREAK', 'DEMOTE_STREAK', 'gradeSession', 'adaptiveStatus']],
    ['/game-session.js', ['GAME_LIMITS', 'SESSION_MINUTES: 30', 'DAILY_SESSIONS: 3', 'canPlayNow', 'startSessionWatchdog']],
    ['/dashboard-play.js', ['playSection', 'grantExtraSession', 'adaptiveSummaryCard']],
    ['/charts.js', ['drawDifficultyChart', 'drawOutcomesChart']],
    ['/games.js', ['recordOutcome', 'useHint', 'skipQuestion', 'adaptiveStart']],
  ]) {
    const body = await (await fetch('http://localhost:5000' + file)).text();
    const missing = needles.filter((n) => !body.includes(n));
    check(`${file} carries its adaptive logic`, missing.length === 0, missing);
  }

  // Difficulty must move one step at a time. A jump from Easy to Hard is the
  // exact thing the spec rules out, so assert the rule in the source.
  const adaptive = await (await fetch('http://localhost:5000/adaptive.js')).text();
  check('promotion steps up by exactly one level',
    /clampLevel\(level \+ 1\)/.test(adaptive), 'no single-step promotion found');
  check('demotion steps down by exactly one level',
    /clampLevel\(level - 1\)/.test(adaptive), 'no single-step demotion found');
  check('a hinted or laboured streak does not promote',
    /correct_but_effortful/.test(adaptive));
  check('the ladder has five named steps',
    ['easy', 'easy_medium', 'medium', 'medium_hard', 'hard'].every((k) => adaptive.includes(`'${k}'`)));

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
