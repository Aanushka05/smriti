/* Bhashini: translation, speech-to-text, text-to-speech, and what happens
 * when none of it is available.
 *
 * This server has NO Bhashini credentials, which is the important case to get
 * right: the app must degrade honestly rather than pretend. Where credentials
 * exist the online assertions below become live; they are written so that both
 * outcomes are checked rather than skipped. */
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
  try { data = await res.json(); } catch { /* none */ }
  return { status: res.status, data };
};

/* Login is two-step now; finish it transparently. */
async function call(path, opts = {}) {
  const first = await rawCall(path, opts);
  if (!first.data || !first.data.mfaRequired) return first;
  const verified = await rawCall('/auth/verify-otp', {
    method: 'POST',
    body: { challengeId: first.data.challengeId, code: first.data.devCode },
  });
  // Keep the status of the operation the caller actually asked for: a
  // registration is a 201 even though the code that completes it answers 200.
  return { ...verified, status: first.status === 201 ? 201 : verified.status };
}

const stamp = Date.now().toString().slice(-6);
// The five priority languages, in the order the brief lists them.
const PRIORITY = ['as', 'brx', 'mni', 'hi', 'en'];

(async () => {
  const cg = (await call('/auth/register/caregiver', { method: 'POST', body: {
    name: 'Bhashini CG', username: 'bhcg' + stamp, password: 'bh@123456',
    confirmPassword: 'bh@123456', contact: `bh${stamp}@example.org`, role: 'asha',
    
  } })).data;
  const CG = cg.token;

  const health = (await call('/health')).data;
  const configured = health.bhashiniConfigured === true;
  console.log(`\n  (Bhashini credentials configured on this server: ${configured})`);

  console.log('\n== the server never leaks its credentials ==');
  const blob = JSON.stringify(health);
  check('/health reports only whether Bhashini is configured',
    typeof health.bhashiniConfigured === 'boolean', health.bhashiniConfigured);
  for (const secret of ['ulcaApiKey', 'BHASHINI_API_KEY', 'BHASHINI_USER_ID', 'inferenceApiKey', 'Authorization']) {
    check(`no ${secret} in /health`, !blob.includes(secret));
  }
  const langs = await call('/translate/languages');
  check('the language list carries no credentials',
    !JSON.stringify(langs.data).match(/apiKey|userID|secret/i));

  console.log('\n== capability is reported honestly, per language ==');
  for (const lang of PRIORITY) {
    const r = await call(`/speech/capability?lang=${lang}`);
    check(`${lang}: capability answers`, r.status === 200 && !!r.data.capability, r.data);
    const c = r.data.capability;
    check(`${lang}: the language is offered by the app`, c.offered === true, c);
    check(`${lang}: "configured" matches the server's real state`,
      c.configured === configured, [c.configured, configured]);
    if (!configured) {
      // The property that matters: with no credentials nothing may claim to work.
      check(`${lang}: claims NO speech-to-text when unconfigured`, c.asr === false, c);
      check(`${lang}: claims NO text-to-speech when unconfigured`, c.tts === false, c);
      check(`${lang}: says why`, typeof c.note === 'string' && c.note.length > 0, c.note);
    } else {
      // Verified against the live API on 2026-09-06. These are what this
      // pipeline actually offers — not a guess, and not the same for every
      // language, which is the whole reason capability is probed.
      const EXPECTED = {
        as: { asr: false, tts: true },   // Assamese: voice out, no voice in
        brx: { asr: false, tts: true },  // Bodo
        mni: { asr: false, tts: true },  // Manipuri
        hi: { asr: true, tts: true },    // Hindi: both
        en: { asr: true, tts: true },
      }[lang];
      check(`${lang}: translation is available`, c.translation === true, c);
      check(`${lang}: speech-to-text reported correctly (${EXPECTED.asr})`, c.asr === EXPECTED.asr, c);
      check(`${lang}: text-to-speech reported correctly (${EXPECTED.tts})`, c.tts === EXPECTED.tts, c);
    }
  }

  const unknown = await call('/speech/capability?lang=zz');
  check('a language the app does not offer is reported as not offered',
    unknown.data.capability.offered === false, unknown.data.capability);

  console.log('\n== speech endpoints degrade, never crash ==');
  const pt = await call('/caregiver/patients', { method: 'POST', token: CG, body: {
    mode: 'create', name: 'Bh Patient', username: 'bhpt' + stamp,
    password: 'bh@123456', confirmPassword: 'bh@123456', age: 70, emergencyContact: '9800000000',
  } });
  const PT = (await call('/auth/login', { method: 'POST',
    body: { username: 'bhpt' + stamp, password: 'bh@123456' } })).data.token;

  let r = await call('/speech/transcribe', { method: 'POST', token: PT,
    body: { audio: Buffer.alloc(64, 5).toString('base64'), lang: 'as' } });
  check('transcribe answers with a clear status, not a crash',
    [200, 422, 502, 503, 504].includes(r.status), r.status);
  check('and never returns invented text',
    !(r.status === 200 && r.data.text && !configured), r.data);
  if (!configured) {
    check('it says the service is not configured',
      r.status === 503 && r.data.reason === 'not_configured', r.data);
  }

  r = await call('/speech/synthesize', { method: 'POST', token: PT,
    body: { text: 'Time to take your medicine.', lang: 'as' } });
  check('synthesize answers with a clear status, not a crash',
    [200, 422, 502, 503, 504].includes(r.status), r.status);
  check('and never returns silent or fake audio',
    !(r.status === 200 && !r.data.audioBase64), r.data);

  if (configured) {
    console.log('\n== speech really works, end to end ==');

    // Text to speech must return real WAV audio, not an empty success.
    let tts = await call('/speech/synthesize', { method: 'POST', token: PT,
      body: { text: 'Time to take your medicine.', lang: 'as' } });
    check('Assamese text-to-speech returns audio', tts.status === 200 && !!tts.data.audioBase64, tts.status);
    if (tts.status === 200) {
      const wav = Buffer.from(tts.data.audioBase64, 'base64');
      check('the audio is a real WAV file', wav.subarray(0, 4).toString() === 'RIFF', wav.subarray(0, 4).toString());
      check('and it is not a token-length stub', wav.length > 5000, wav.length);
    }

    // The strongest available check without a microphone: speak a phrase,
    // then ask the service to transcribe its own audio back.
    const phrase = 'मुझे दवा लेनी है';
    tts = await call('/speech/synthesize', { method: 'POST', token: PT, body: { text: phrase, lang: 'hi' } });
    check('Hindi text-to-speech returns audio', tts.status === 200 && !!tts.data.audioBase64, tts.status);
    if (tts.status === 200) {
      const asr = await call('/speech/transcribe', { method: 'POST', token: PT,
        body: { audio: tts.data.audioBase64, lang: 'hi' } });
      check('Hindi speech-to-text returns text', asr.status === 200 && !!asr.data.text, asr.status);
      check('and the round trip recovers the phrase',
        String(asr.data.text || '').includes('दवा'), asr.data.text);
    }

    // A language the pipeline has no ASR model for must be refused clearly,
    // never answered with invented text.
    const noAsr = await call('/speech/transcribe', { method: 'POST', token: PT,
      body: { audio: Buffer.alloc(2048, 3).toString('base64'), lang: 'as' } });
    check('Assamese speech-to-text is refused, not faked',
      noAsr.status !== 200 && !noAsr.data.text, [noAsr.status, noAsr.data]);
    check('and the refusal names the reason',
      typeof noAsr.data.reason === 'string' && noAsr.data.reason.length > 0, noAsr.data.reason);

    console.log('\n== translation really works, in the priority languages ==');
    for (const lang of ['as', 'brx', 'mni', 'hi']) {
      const tr = await call('/translate-ui', { method: 'POST', body: {
        texts: ['Time to take your morning medicine.'], sourceLanguage: 'en', targetLanguage: lang } });
      const out = tr.data.translations && tr.data.translations[0];
      check(`${lang}: really translated`,
        tr.data.translated === true && out && out !== 'Time to take your morning medicine.', out);
      check(`${lang}: the result is not Latin script`, /[^\u0000-\u024F]/.test(out || ''), out);
    }
  }

  console.log('\n== speech is protected ==');
  r = await rawCall('/speech/transcribe', { method: 'POST', body: { audio: 'AAAA', lang: 'hi' } });
  check('transcribe rejects an anonymous caller', r.status === 401, r.status);
  r = await rawCall('/speech/synthesize', { method: 'POST', body: { text: 'hello', lang: 'hi' } });
  check('synthesize rejects an anonymous caller', r.status === 401, r.status);
  check('capability is readable without a session (the login screen needs it)',
    (await rawCall('/speech/capability?lang=hi')).status === 200);

  console.log('\n== translation still works and still falls back ==');
  r = await call('/translate-ui', { method: 'POST', body: {
    texts: ['Time to take your medicine.', 'Drink some water.'],
    sourceLanguage: 'en', targetLanguage: 'as',
  } });
  check('translate-ui answers whether or not Bhashini is reachable', r.status === 200, r.status);
  check('it says plainly whether it translated', typeof r.data.translated === 'boolean', r.data);
  check('it always returns one string per input',
    Array.isArray(r.data.translations) && r.data.translations.length === 2, r.data.translations);
  if (!configured) {
    // The honest failure: hand back the ORIGINAL text and say it was not
    // translated, rather than returning something invented.
    check('with no credentials it reports translated: false',
      r.data.translated === false, r.data.translated);
    check('and falls back to the original English, not a fabrication',
      r.data.translations[0] === 'Time to take your medicine.', r.data.translations);
    check('and gives a machine-readable reason',
      typeof r.data.reasonCode === 'string' && r.data.reasonCode.length > 0, r.data.reasonCode);
  }

  r = await call('/translate-ui', { method: 'POST', body: { texts: [], targetLanguage: 'as' } });
  check('an empty request is refused rather than guessed at', r.status === 400, r.status);
  r = await call('/translate-ui', { method: 'POST', body: { texts: ['hi'] } });
  check('a missing target language is refused', r.status === 400, r.status);

  console.log('\n== the frontend states the offline limits honestly ==');
  const speechSrc = await (await fetch('http://localhost:5000/speech.js')).text();
  check('it does not claim offline speech-to-text',
    /offlineAsr: false/.test(speechSrc), 'offlineAsr should be false');
  check('it explains that browser recognition needs the network',
    /NOT an offline capability/i.test(speechSrc));
  check('it checks for a real device voice before offering to speak',
    /deviceVoiceFor/.test(speechSrc) && /getVoices/.test(speechSrc));
  check('it tells the user when a language has no voice',
    /noVoiceForLanguage/.test(speechSrc));
  check('Bhashini is only ever reached through the backend',
    !/dhruva-api|ulcacontrib|ulcaApiKey/.test(speechSrc));

  const clientSrc = await (await fetch('http://localhost:5000/bhashini-client.js')).text();
  check('no credentials in the frontend translation client',
    !/ulcaApiKey|BHASHINI_API_KEY|userID:/.test(clientSrc));

  console.log(`\n================  ${pass} passed, ${fail} failed  ================\n`);
  process.exit(fail ? 1 : 0);
})();
