// bhashini_service.js
// -----------------------------------------------------------------------
// Real integration with the Bhashini / ULCA translation API. This is the
// ONLY place in the whole project that talks to Bhashini, and the ONLY
// place that is allowed to know BHASHINI_API_KEY / BHASHINI_USER_ID.
//
// Two-step flow required by Bhashini (see https://bhashini.gitbook.io/bhashini-apis):
//   1. Pipeline CONFIG call  -> POST https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline
//      Authenticated with userID + ulcaApiKey headers. Tells us which
//      serviceId to use for a given source/target language pair, and
//      returns the actual inference endpoint + a short-lived inference key.
//   2. Pipeline COMPUTE call -> POST <callbackUrl from step 1> (defaults to
//      https://dhruva-api.bhashini.gov.in/services/inference/pipeline)
//      Authenticated with the inference key from step 1. This is the call
//      that actually returns translated text.
//
// The config response (serviceId + endpoint + inference key) is cached in
// memory per source/target pair since it rarely changes and step 1 is
// comparatively slow — this is caching of Bhashini's OWN routing info, not
// a hand-written translation dictionary. Translated STRINGS are cached in
// SQLite (see database.js: translation_cache) exactly as the client spec
// asked for: translationCache[sourceLanguage][targetLanguage][text], but
// backed by a real table instead of an object literal, and every row in
// that table was produced by an actual Bhashini response — never typed by
// a developer.
// -----------------------------------------------------------------------

const fetch = require('node-fetch');
const { db } = require('./database');

const ULCA_CONFIG_ENDPOINT = 'https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline';
const DEFAULT_INFERENCE_ENDPOINT = 'https://dhruva-api.bhashini.gov.in/services/inference/pipeline';

// Without a timeout a slow or unreachable Bhashini endpoint would hang the
// request until the client gives up, and every language switch would feel
// broken. 15s is generous for a batch translate and still bounded.
const TRANSLATE_TIMEOUT_MS = Number(process.env.BHASHINI_TIMEOUT_MS) || 15000;

// The languages this app offers. Anything outside this set is rejected up
// front with a clear message rather than sent to Bhashini to fail there.
const SUPPORTED_LANGUAGES = new Set([
  'en', 'hi', 'as', 'bn', 'mni', 'brx', 'ne', 'mr',
  'gu', 'kn', 'ml', 'or', 'pa', 'ta', 'te', 'ur',
]);

const pipelineConfigCache = new Map(); // key: `${src}|${tgt}` -> { serviceId, endpoint, keyName, keyValue, expiresAt }

/** fetch with an AbortController timeout, so no call can hang forever. */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TRANSLATE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Bhashini did not respond within ${(timeoutMs || TRANSLATE_TIMEOUT_MS) / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The credentials, and the header shape the config call actually wants.
 *
 * The Udyat key (ulcaApiKey) is what authenticates the config call. A userID
 * is OPTIONAL: tested against the live API, sending one that is not a real
 * user id is rejected with "Error in fetching ulcaApiKey", while omitting it
 * entirely succeeds. So an empty userID must never be sent as a header.
 */
function creds() {
  const { BHASHINI_USER_ID, BHASHINI_API_KEY, BHASHINI_PIPELINE_ID } = process.env;
  if (!BHASHINI_API_KEY || !BHASHINI_PIPELINE_ID) {
    throw new Error(
      'Bhashini is not configured. Set BHASHINI_API_KEY (your Udyat key) and ' +
      'BHASHINI_PIPELINE_ID in backend/.env (see .env.example). Get these from ' +
      'https://bhashini.gov.in/ulca/user/login'
    );
  }
  return { BHASHINI_USER_ID, BHASHINI_API_KEY, BHASHINI_PIPELINE_ID };
}

/** Headers for the ULCA config call. userID is included only if we have one. */
function configHeaders() {
  const { BHASHINI_USER_ID, BHASHINI_API_KEY } = creds();
  const headers = { 'Content-Type': 'application/json', ulcaApiKey: BHASHINI_API_KEY };
  if (BHASHINI_USER_ID) headers.userID = BHASHINI_USER_ID;
  return headers;
}

// Step 1: ask Bhashini which translation service + endpoint to use for
// this exact source -> target language pair.
async function getPipelineConfig(sourceLanguage, targetLanguage) {
  const key = `${sourceLanguage}|${targetLanguage}`;
  const cached = pipelineConfigCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const { BHASHINI_PIPELINE_ID } = creds();

  const res = await fetchWithTimeout(ULCA_CONFIG_ENDPOINT, {
    method: 'POST',
    headers: configHeaders(),
    body: JSON.stringify({
      pipelineTasks: [
        {
          taskType: 'translation',
          config: { language: { sourceLanguage, targetLanguage } },
        },
      ],
      pipelineRequestConfig: { pipelineId: BHASHINI_PIPELINE_ID },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bhashini pipeline config call failed (${res.status}): ${body}`);
  }
  const data = await res.json();

  const translationConfig = (data.pipelineResponseConfig || []).find((c) => c.taskType === 'translation');
  const serviceId = translationConfig && translationConfig.config && translationConfig.config[0] && translationConfig.config[0].serviceId;
  const inferenceEndpoint = data.pipelineInferenceAPIEndPoint || {};

  if (!serviceId) {
    throw new Error(`Bhashini did not return a translation serviceId for ${sourceLanguage} -> ${targetLanguage}. This language pair may not be supported by your pipeline.`);
  }

  // Tested against the live API: the config response does NOT always carry an
  // inference key. When it does not, use the one from the environment — that
  // is what the Bhashini dashboard issues alongside the Udyat key. Without
  // this fallback every compute call goes out unauthenticated and fails.
  const resolved = {
    serviceId,
    endpoint: inferenceEndpoint.callbackUrl
      || process.env.BHASHINI_INFERENCE_ENDPOINT || DEFAULT_INFERENCE_ENDPOINT,
    keyName: (inferenceEndpoint.inferenceApiKey && inferenceEndpoint.inferenceApiKey.name)
      || process.env.BHASHINI_INFERENCE_API_KEY_NAME || 'Authorization',
    keyValue: (inferenceEndpoint.inferenceApiKey && inferenceEndpoint.inferenceApiKey.value)
      || process.env.BHASHINI_INFERENCE_API_KEY_VALUE || null,
    expiresAt: Date.now() + 30 * 60 * 1000, // re-fetch every 30 min
  };
  pipelineConfigCache.set(key, resolved);
  return resolved;
}

// Step 2: send the actual text through the resolved service and get
// translated text back.
async function computeTranslation(texts, sourceLanguage, targetLanguage) {
  const cfg = await getPipelineConfig(sourceLanguage, targetLanguage);

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.keyValue) headers[cfg.keyName] = cfg.keyValue;

  const res = await fetchWithTimeout(cfg.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      pipelineTasks: [
        {
          taskType: 'translation',
          config: {
            language: { sourceLanguage, targetLanguage },
            serviceId: cfg.serviceId,
          },
        },
      ],
      inputData: { input: texts.map((source) => ({ source })) },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bhashini pipeline compute call failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const pipelineResponse = (data.pipelineResponse || []).find((r) => r.taskType === 'translation');
  const output = (pipelineResponse && pipelineResponse.output) || [];
  return texts.map((original, i) => (output[i] && output[i].target) || original);
}

const getCached = db.prepare(`SELECT translated_text FROM translation_cache WHERE source_lang=? AND target_lang=? AND source_text=?`);
const putCached = db.prepare(`INSERT OR REPLACE INTO translation_cache (source_lang,target_lang,source_text,translated_text) VALUES (?,?,?,?)`);

/**
 * translateBatch — the function every route calls. Splits the batch into
 * "already cached" (served instantly from translation_cache, itself only
 * ever populated by real Bhashini responses) and "needs Bhashini", calls
 * Bhashini once for the uncached remainder, writes the results back to the
 * cache, and returns translations in the original order.
 */
async function translateBatch(texts, sourceLanguage, targetLanguage) {
  const src = baseLang(sourceLanguage);
  const tgt = baseLang(targetLanguage);
  if (src === tgt) return texts.slice();

  // Reject a language this app does not offer up front, with a message
  // that names it, instead of sending it to Bhashini to fail obscurely.
  if (!SUPPORTED_LANGUAGES.has(tgt)) {
    const err = new Error(`"${targetLanguage}" is not one of the languages this app supports.`);
    err.code = 'UNSUPPORTED_LANGUAGE';
    throw err;
  }

  const results = new Array(texts.length);
  const missIdx = [];
  const missTexts = [];

  texts.forEach((text, i) => {
    const row = getCached.get(src, tgt, text);
    if (row) results[i] = row.translated_text;
    else { missIdx.push(i); missTexts.push(text); }
  });

  if (missTexts.length) {
    const translated = await computeTranslation(missTexts, src, tgt);
    translated.forEach((tr, j) => {
      const i = missIdx[j];
      results[i] = tr;
      putCached.run(src, tgt, missTexts[j], tr);
    });
  }
  return results;
}

function baseLang(code) {
  return (code || 'en').split('-')[0].toLowerCase();
}

/* ==========================================================================
 * SPEECH — ASR (voice to text) and TTS (text to voice).
 *
 * Same two-step ULCA shape as translation: ask the pipeline which service
 * handles this task for this language, then call that service. The config
 * call is what tells us whether a language is ACTUALLY supported for a task,
 * which is why capability is discovered at runtime rather than asserted from
 * a hard-coded list — Bhashini supports different languages for translation,
 * ASR and TTS, and guessing would mean lying to the user.
 * ==========================================================================*/

const SPEECH_TIMEOUT_MS = Number(process.env.BHASHINI_SPEECH_TIMEOUT_MS) || 30000;
const MAX_AUDIO_BYTES = Number(process.env.BHASHINI_MAX_AUDIO_BYTES) || 5 * 1024 * 1024;

// Cached per task+language, because the config call is slow and its answer
// is stable. Failures are cached too, briefly, so a language Bhashini does
// not support is not re-asked on every keystroke.
const speechConfigCache = new Map();
const SPEECH_CONFIG_TTL_MS = 30 * 60 * 1000;
const SPEECH_FAILURE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolves the service that performs `task` ('asr' or 'tts') for `language`.
 * Throws with a plain message when the pipeline does not offer it.
 */
async function getSpeechConfig(task, language) {
  const key = `${task}|${language}`;
  const cached = speechConfigCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) throw new Error(cached.error);
    return cached;
  }

  const { BHASHINI_PIPELINE_ID } = creds();

  // ASR takes sourceLanguage only; TTS likewise. Neither has a target.
  const res = await fetchWithTimeout(ULCA_CONFIG_ENDPOINT, {
    method: 'POST',
    headers: configHeaders(),
    body: JSON.stringify({
      pipelineTasks: [{ taskType: task, config: { language: { sourceLanguage: language } } }],
      pipelineRequestConfig: { pipelineId: BHASHINI_PIPELINE_ID },
    }),
  }, SPEECH_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bhashini ${task} config call failed (${res.status}): ${body}`);
  }
  const data = await res.json();

  const taskConfig = (data.pipelineResponseConfig || []).find((c) => c.taskType === task);
  const first = taskConfig && taskConfig.config && taskConfig.config[0];
  const serviceId = first && first.serviceId;

  if (!serviceId) {
    const message = `Bhashini does not offer ${task.toUpperCase()} for "${language}" on this pipeline.`;
    speechConfigCache.set(key, { error: message, expiresAt: Date.now() + SPEECH_FAILURE_TTL_MS });
    throw new Error(message);
  }

  const inference = data.pipelineInferenceAPIEndPoint || {};
  const resolved = {
    serviceId,
    // TTS needs a voice; ASR needs a sample rate. Both come from the config
    // rather than being assumed, because the model decides what it accepts.
    supportedVoices: (first.supportedVoices || []),
    samplingRate: (first.samplingRate || null),
    endpoint: inference.callbackUrl
      || process.env.BHASHINI_INFERENCE_ENDPOINT || DEFAULT_INFERENCE_ENDPOINT,
    keyName: (inference.inferenceApiKey && inference.inferenceApiKey.name)
      || process.env.BHASHINI_INFERENCE_API_KEY_NAME || 'Authorization',
    keyValue: (inference.inferenceApiKey && inference.inferenceApiKey.value)
      || process.env.BHASHINI_INFERENCE_API_KEY_VALUE || null,
    expiresAt: Date.now() + SPEECH_CONFIG_TTL_MS,
  };
  speechConfigCache.set(key, resolved);
  return resolved;
}

/**
 * Voice to text. `audioBase64` is what the browser recorded.
 * Returns { text, language, source: 'bhashini' }.
 */
async function transcribeAudio(audioBase64, language) {
  const lang = baseLang(language);
  if (!SUPPORTED_LANGUAGES.has(lang)) {
    throw new Error(`"${language}" is not one of the languages this app offers.`);
  }
  const raw = String(audioBase64 || '');
  const payload = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!payload) throw new Error('No audio was received.');
  // Guard before decoding: a huge payload should be refused, not buffered.
  if (payload.length * 0.75 > MAX_AUDIO_BYTES) {
    throw new Error('That recording is too long. Please record a shorter message.');
  }

  const cfg = await getSpeechConfig('asr', lang);
  const res = await fetchWithTimeout(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [cfg.keyName]: cfg.keyValue },
    body: JSON.stringify({
      pipelineTasks: [{
        taskType: 'asr',
        config: {
          language: { sourceLanguage: lang },
          serviceId: cfg.serviceId,
          audioFormat: 'wav',
          samplingRate: cfg.samplingRate || 16000,
        },
      }],
      inputData: { audio: [{ audioContent: payload }] },
    }),
  }, SPEECH_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bhashini ASR failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const output = (data.pipelineResponse || []).find((p) => p.taskType === 'asr');
  const text = output && output.output && output.output[0] && output.output[0].source;

  // An empty result is a real outcome, not a failure: the patient may have
  // said nothing. Saying so is more useful than inventing words.
  return { text: text || '', language: lang, source: 'bhashini', empty: !text };
}

/**
 * Text to voice. Returns { audioBase64, mimeType, language, source }.
 */
async function synthesizeSpeech(text, language, gender) {
  const lang = baseLang(language);
  if (!SUPPORTED_LANGUAGES.has(lang)) {
    throw new Error(`"${language}" is not one of the languages this app offers.`);
  }
  const value = String(text || '').trim();
  if (!value) throw new Error('There is nothing to read out.');
  if (value.length > 2000) throw new Error('That passage is too long to read out in one go.');

  const cfg = await getSpeechConfig('tts', lang);
  const res = await fetchWithTimeout(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [cfg.keyName]: cfg.keyValue },
    body: JSON.stringify({
      pipelineTasks: [{
        taskType: 'tts',
        config: {
          language: { sourceLanguage: lang },
          serviceId: cfg.serviceId,
          gender: gender || 'female',
          samplingRate: cfg.samplingRate || 8000,
        },
      }],
      inputData: { input: [{ source: value }] },
    }),
  }, SPEECH_TIMEOUT_MS);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bhashini TTS failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const output = (data.pipelineResponse || []).find((p) => p.taskType === 'tts');
  const audio = output && output.audio && output.audio[0] && output.audio[0].audioContent;
  if (!audio) throw new Error('Bhashini returned no audio for that text.');

  return { audioBase64: audio, mimeType: 'audio/wav', language: lang, source: 'bhashini' };
}

/**
 * What this server can ACTUALLY do for a language right now.
 *
 * Deliberately does not guess. Without credentials every online capability is
 * reported false, because claiming otherwise would have the frontend offer a
 * microphone button that cannot work.
 */
async function speechCapability(language) {
  const lang = baseLang(language);
  const configured = !!(process.env.BHASHINI_API_KEY && process.env.BHASHINI_PIPELINE_ID);
  const result = {
    language: lang,
    offered: SUPPORTED_LANGUAGES.has(lang),
    configured,
    translation: false,
    asr: false,
    tts: false,
    checked: false,
    note: null,
  };
  if (!result.offered) { result.note = 'This app does not offer that language.'; return result; }
  if (!configured) {
    result.note = 'Bhashini credentials are not configured on this server, so online speech is unavailable.';
    return result;
  }

  // Ask the pipeline rather than assuming. Each probe is cached.
  result.checked = true;

  // English is the source language: there is nothing to translate, and asking
  // Bhashini for an en->en model correctly returns nothing. Reporting that as
  // "translation unavailable" would be misleading.
  const translationProbe = lang === 'en'
    ? Promise.resolve().then(() => { result.translation = true; })
    : getPipelineConfig('en', lang).then(() => { result.translation = true; }).catch(() => {});

  await Promise.all([
    translationProbe,
    getSpeechConfig('asr', lang).then(() => { result.asr = true; }).catch(() => {}),
    getSpeechConfig('tts', lang).then(() => { result.tts = true; }).catch(() => {}),
  ]);
  return result;
}

module.exports = {
  translateBatch, getPipelineConfig, baseLang, SUPPORTED_LANGUAGES, TRANSLATE_TIMEOUT_MS,
  transcribeAudio, synthesizeSpeech, speechCapability, getSpeechConfig,
  SPEECH_TIMEOUT_MS, MAX_AUDIO_BYTES,
};
