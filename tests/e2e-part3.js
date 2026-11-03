// Part 3 checks: the analysis engine, translation robustness and the
// backend side of the charts (the data they are drawn from).
// Browser-side chart assertions are done separately in the live page.
const BASE = 'http://localhost:5000/api';
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
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
  return { status: res.status, data };
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

/** Words the analysis must never produce, in any configuration. */
const FORBIDDEN = [
  /\bhas dementia\b/i, /\bdoes not have dementia\b/i, /\bdementia is (worsening|progressing|improving)\b/i,
  /\bdiagnos(is|ed|e)\b/i, /\byou should take\b/i, /\bprescrib/i, /\bmedication dose\b/i,
];

(async () => {
  console.log('\n== sign in ==');
  // This run gets its own caregiver. Borrowing the seeded asha_demo account
  // would pile a fresh set of test patients onto the demo dashboard every run.
  const cg = (await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Analysis Caregiver', username: 'anacg' + stamp,
    password: 'anacg@1234', confirmPassword: 'anacg@1234',
    contact: `anacg${stamp}@example.org`, relationship: 'ASHA Worker', role: 'asha',
  } })).data;
  const CG = cg.token;
  check('caregiver signed in', !!CG);

  // A patient owned by this run, so every count below is exact.
  const created = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Analysis Patient', username: 'ana' + stamp,
    password: 'ana12345', confirmPassword: 'ana12345', age: 71,
  } });
  check('analysis patient created', created.status === 201, created.data);
  const PID = created.data.patient.id;
  const PT = (await call('/auth/login', { method: 'POST', body: { username: 'ana' + stamp, password: 'ana12345' } })).data.token;

  console.log('\n== insufficient data is stated, not invented ==');
  let r = await call(`/patients/${PID}/analysis`, { token: CG });
  check('zero sessions -> insufficient_data', r.data.overallTrend === 'insufficient_data', r.data.overallTrend);
  check('says so in plain words', /not enough data/i.test(r.data.headline), r.data.headline);
  check('no invented strengths', r.data.strengths.length === 0, r.data.strengths);
  check('no invented concerns', r.data.areasToWatch.length === 0, r.data.areasToWatch);
  check('still offers a next step', r.data.recommendedActions.length > 0);

  const post2 = async (domain, gameType, accuracy, avgTimeMs) => call('/game-results', {
    method: 'POST', token: PT,
    body: { patientId: PID, domain, gameType, level: 2, score: Math.round(accuracy * 5), totalRounds: 5, accuracy, avgTimeMs },
  });

  await post2('memory', 'Memory Match', 0.8, 4000);
  await post2('memory', 'Memory Match', 0.8, 4100);
  r = await call(`/patients/${PID}/analysis`, { token: CG });
  check('two sessions is still insufficient', r.data.overallTrend === 'insufficient_data', r.data.overallTrend);

  console.log('\n== a real trend is derived from the real numbers ==');
  // Declining memory: 90, 85, 60, 55
  const decliner = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Declining Patient', username: 'dec' + stamp,
    password: 'dec12345', confirmPassword: 'dec12345', age: 74,
  } });
  const DID = decliner.data.patient.id;
  const DT = (await call('/auth/login', { method: 'POST', body: { username: 'dec' + stamp, password: 'dec12345' } })).data.token;
  const postD = (domain, gameType, accuracy, avgTimeMs) => call('/game-results', {
    method: 'POST', token: DT,
    body: { patientId: DID, domain, gameType, level: 2, score: Math.round(accuracy * 5), totalRounds: 5, accuracy, avgTimeMs },
  });
  for (const [acc, ms] of [[0.9, 3000], [0.85, 3200], [0.6, 6000], [0.55, 7000]]) {
    await postD('memory', 'Memory Match', acc, ms);
  }
  r = await call(`/patients/${DID}/analysis`, { token: CG });
  check('falling scores -> declining', r.data.overallTrend === 'declining', r.data.overallTrend);
  check('the decline is named with numbers',
    r.data.areasToWatch.some((a) => /decreased/i.test(a.title) && /\d+%/.test(a.detail)),
    r.data.areasToWatch.map((a) => a.title));
  check('rising response time is flagged',
    r.data.areasToWatch.some((a) => /response time/i.test(a.title)),
    r.data.areasToWatch.map((a) => a.title));
  check('an action addresses the decline',
    r.data.recommendedActions.some((s) => /easier level|rebuild confidence|more time/i.test(s)),
    r.data.recommendedActions);

  // Improving: 55, 60, 85, 90
  const riser = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Improving Patient', username: 'imp' + stamp,
    password: 'imp12345', confirmPassword: 'imp12345', age: 68,
  } });
  const IID = riser.data.patient.id;
  const IT = (await call('/auth/login', { method: 'POST', body: { username: 'imp' + stamp, password: 'imp12345' } })).data.token;
  for (const [acc, ms] of [[0.55, 5000], [0.6, 4800], [0.85, 4000], [0.9, 3800]]) {
    await call('/game-results', { method: 'POST', token: IT, body: {
      patientId: IID, domain: 'memory', gameType: 'Memory Match', level: 2,
      score: Math.round(acc * 5), totalRounds: 5, accuracy: acc, avgTimeMs: ms,
    } });
  }
  r = await call(`/patients/${IID}/analysis`, { token: CG });
  check('rising scores -> improving', r.data.overallTrend === 'improving', r.data.overallTrend);
  check('the improvement is listed as a strength',
    r.data.strengths.some((s) => /improved/i.test(s.title)), r.data.strengths.map((s) => s.title));

  console.log('\n== the figures are the ones actually stored ==');
  r = await call(`/patients/${IID}/analysis`, { token: CG });
  const sessions = (await call(`/patients/${IID}/sessions`, { token: CG })).data;
  const realAvg = Math.round((sessions.reduce((a, s) => a + s.accuracy, 0) / sessions.length) * 100);
  const realResp = +(sessions.reduce((a, s) => a + s.avgTimeMs, 0) / sessions.length / 1000).toFixed(1);
  check('session count matches the database', r.data.figures.sessions === sessions.length, { engine: r.data.figures.sessions, db: sessions.length });
  check('average accuracy matches the database', r.data.figures.averageAccuracyPct === realAvg, { engine: r.data.figures.averageAccuracyPct, db: realAvg });
  check('average response time matches the database', r.data.figures.averageResponseSeconds === realResp, { engine: r.data.figures.averageResponseSeconds, db: realResp });
  check('best score matches the database',
    r.data.figures.bestAccuracyPct === Math.round(Math.max(...sessions.map((s) => s.accuracy)) * 100));
  check('per-area figures are present', Array.isArray(r.data.figures.byArea) && r.data.figures.byArea.length === 6, r.data.figures.byArea.length);

  console.log('\n== analysis reacts to new data, with no code or db edits ==');
  const before = (await call(`/patients/${IID}/analysis`, { token: CG })).data;
  await call('/game-results', { method: 'POST', token: IT, body: {
    patientId: IID, domain: 'language', gameType: 'Word Recall', level: 1,
    score: 5, totalRounds: 5, accuracy: 1.0, avgTimeMs: 2500,
  } });
  const after = (await call(`/patients/${IID}/analysis`, { token: CG })).data;
  check('session count moved', after.figures.sessions === before.figures.sessions + 1, { before: before.figures.sessions, after: after.figures.sessions });
  check('the new area appears in the figures',
    after.figures.byArea.find((d) => d.domain === 'language').sessions === 1,
    after.figures.byArea.find((d) => d.domain === 'language'));
  check('the write-up changed with the data', after.summary !== before.summary, { before: before.summary, after: after.summary });

  console.log('\n== safe wording ==');
  const texts = [];
  for (const id of [PID, DID, IID]) {
    const a = (await call(`/patients/${id}/analysis`, { token: CG })).data;
    texts.push(JSON.stringify([a.headline, a.summary, a.strengths, a.areasToWatch, a.recommendedActions]));
  }
  const joined = texts.join(' ');
  check('never claims or rules out a diagnosis', !FORBIDDEN.some((re) => re.test(joined)),
    FORBIDDEN.filter((re) => re.test(joined)).map(String));
  check('carries a non-diagnostic disclaimer',
    /not a medical assessment or diagnosis/i.test((await call(`/patients/${DID}/analysis`, { token: CG })).data.disclaimer));

  console.log('\n== the engine runs without any AI key ==');
  r = await call(`/patients/${DID}/analysis`, { method: 'POST', token: CG, body: {} });
  check('POST analysis returns 200', r.status === 200, r.data);
  check('source is the built-in engine', r.data.source === 'engine', r.data.source);
  check('explains why there is no AI write-up', /ANTHROPIC_API_KEY/.test(r.data.note || ''), r.data.note);
  check('findings are identical to the GET snapshot',
    JSON.stringify(r.data.areasToWatch) === JSON.stringify((await call(`/patients/${DID}/analysis`, { token: CG })).data.areasToWatch));

  console.log('\n== translation ==');
  r = await call('/translate/languages');
  check('supported languages listed', r.status === 200 && r.data.languages.includes('as') && r.data.languages.includes('hi'), r.data);

  r = await call('/translate-ui', { method: 'POST', body: { texts: ['Hello'], sourceLanguage: 'en', targetLanguage: 'hi' } });
  check('endpoint reachable (no ERR_CONNECTION_REFUSED)', r.status === 200, r.status);
  // With credentials this must genuinely translate; without them it must
  // hand back the original text AND say why. Both are correct answers —
  // what would be wrong is inventing a translation, or failing silently.
  const bhashiniOn = (await call('/health')).data.bhashiniConfigured === true;
  if (bhashiniOn) {
    check('it really translates when configured',
      r.data.translated === true && r.data.translations[0] !== 'Hello', r.data);
    check('and reports no failure reason', !r.data.reasonCode, r.data.reasonCode);
  } else {
    check('falls back to English rather than failing',
      r.data.translations[0] === 'Hello' && r.data.translated === false, r.data);
    check('says WHY it fell back', r.data.reasonCode === 'not_configured', r.data.reasonCode);
  }

  r = await call('/translate-ui', { method: 'POST', body: { texts: ['Hello'], targetLanguage: 'klingon' } });
  check('unsupported language is named', r.data.reasonCode === 'unsupported_language' && /klingon/i.test(r.data.reason), r.data);

  r = await call('/translate-ui', { method: 'POST', body: { texts: ['Hello'], sourceLanguage: 'en', targetLanguage: 'en' } });
  check('same-language request is a no-op', r.data.translated === true && r.data.translations[0] === 'Hello', r.data);

  r = await call('/translate-ui', { method: 'POST', body: { texts: [], targetLanguage: 'hi' } });
  check('empty batch rejected', r.status === 400, r.data);
  r = await call('/translate-ui', { method: 'POST', body: { texts: [1, 2], targetLanguage: 'hi' } });
  check('non-string entries rejected', r.status === 400, r.data);
  r = await call('/translate-ui', { method: 'POST', body: { texts: ['a'], targetLanguage: '' } });
  check('missing target language rejected', r.status === 400, r.data);
  r = await call('/translate-ui', { method: 'POST', body: { texts: new Array(600).fill('x'), targetLanguage: 'hi' } });
  check('oversized batch rejected', r.status === 400, r.data);

  console.log('\n== no credentials leak to the client ==');
  const page = await (await fetch('http://localhost:5000/')).text();
  const scripts = ['config.js', 'app.js', 'bhashini-client.js', 'charts.js', 'dashboard-analysis.js', 'realtime.js'];
  let leaked = [];
  for (const f of scripts) {
    const body = await (await fetch(`http://localhost:5000/${f}`)).text();
    if (/BHASHINI_(API_KEY|USER_ID)|ANTHROPIC_API_KEY|JWT_SECRET|ulcaApiKey|sk-ant-/.test(body)) leaked.push(f);
  }
  check('no API keys or secrets in any served script', leaked.length === 0, leaked);
  check('no secrets in index.html', !/BHASHINI|ANTHROPIC|JWT_SECRET|sk-ant-/.test(page));

  console.log('\n== chart data source ==');
  const full = (await call(`/patients/${IID}`, { token: CG })).data;
  check('sessions carry what the charts plot',
    full.sessions.every((s) => typeof s.accuracy === 'number' && typeof s.avgTimeMs === 'number' && !!s.domain && !!s.ts),
    full.sessions[0]);
  check('metrics carry the per-domain averages',
    full.metrics.length === 6 && full.metrics.every((m) => typeof m.sessions_count === 'number'),
    full.metrics.length);
  check('reminderStats carries the adherence slices',
    full.reminderStats && ['total', 'completed', 'missed', 'snoozed', 'pending'].every((k) => typeof full.reminderStats.allTime[k] === 'number'),
    full.reminderStats && full.reminderStats.allTime);

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
