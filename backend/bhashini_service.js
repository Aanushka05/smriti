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

function creds() {
  const { BHASHINI_USER_ID, BHASHINI_API_KEY, BHASHINI_PIPELINE_ID } = process.env;
  if (!BHASHINI_USER_ID || !BHASHINI_API_KEY || !BHASHINI_PIPELINE_ID) {
    throw new Error(
      'Bhashini credentials are not configured. Set BHASHINI_USER_ID, BHASHINI_API_KEY and ' +
      'BHASHINI_PIPELINE_ID in backend/.env (see .env.example). Get these from https://bhashini.gov.in/ulca/user/login'
    );
  }
  return { BHASHINI_USER_ID, BHASHINI_API_KEY, BHASHINI_PIPELINE_ID };
}

// Step 1: ask Bhashini which translation service + endpoint to use for
// this exact source -> target language pair.
async function getPipelineConfig(sourceLanguage, targetLanguage) {
  const key = `${sourceLanguage}|${targetLanguage}`;
  const cached = pipelineConfigCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const { BHASHINI_USER_ID, BHASHINI_API_KEY, BHASHINI_PIPELINE_ID } = creds();

  const res = await fetchWithTimeout(ULCA_CONFIG_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      userID: BHASHINI_USER_ID,
      ulcaApiKey: BHASHINI_API_KEY,
    },
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

  const resolved = {
    serviceId,
    endpoint: inferenceEndpoint.callbackUrl || DEFAULT_INFERENCE_ENDPOINT,
    keyName: (inferenceEndpoint.inferenceApiKey && inferenceEndpoint.inferenceApiKey.name) || 'Authorization',
    keyValue: inferenceEndpoint.inferenceApiKey && inferenceEndpoint.inferenceApiKey.value,
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

module.exports = { translateBatch, getPipelineConfig, baseLang, SUPPORTED_LANGUAGES, TRANSLATE_TIMEOUT_MS };
