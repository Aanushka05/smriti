// routes/translate.js — the only path from the UI to Bhashini.
//
//   frontend -> POST /api/translate-ui -> bhashini_service.js -> Bhashini
//            <- translated strings, or English plus the reason
//
// Credentials never leave the backend: the frontend sends English source
// strings and a target language, nothing else.
//
// Failure policy: the app must keep working when translation does not.
// A failure returns HTTP 200 with the ORIGINAL English text plus
// `translated: false` and a machine-readable `reason` — so the UI stays
// usable and can tell the user exactly what happened, instead of the
// browser console filling with 502s on every language switch. The error is
// reported, not swallowed.

const express = require('express');
const { translateBatch, SUPPORTED_LANGUAGES } = require('../bhashini_service');

const router = express.Router();

const MAX_TEXTS = 500;

/** Turns an exception into a stable reason code the client can branch on. */
function classify(err) {
  const message = err && err.message ? err.message : 'Unknown translation error.';
  if (err && err.code === 'UNSUPPORTED_LANGUAGE') return { code: 'unsupported_language', message };
  if (/not configured/i.test(message)) return { code: 'not_configured', message };
  if (/did not respond within/i.test(message)) return { code: 'timeout', message };
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network|fetch failed/i.test(message)) return { code: 'unreachable', message };
  if (/language pair may not be supported/i.test(message)) return { code: 'unsupported_language', message };
  return { code: 'service_error', message };
}

// GET /api/translate/languages — what the backend will accept.
router.get('/translate/languages', (req, res) => {
  res.json({ languages: Array.from(SUPPORTED_LANGUAGES).sort() });
});

// POST /api/translate-ui
// { texts: [...English...], sourceLanguage: 'en', targetLanguage: 'as' }
// -> { translations, translated, reason? }
router.post('/translate-ui', async (req, res) => {
  const { texts, sourceLanguage, targetLanguage } = req.body || {};

  if (!Array.isArray(texts) || texts.length === 0) {
    return res.status(400).json({ error: 'texts must be a non-empty array of strings.', field: 'texts' });
  }
  if (texts.length > MAX_TEXTS) {
    return res.status(400).json({ error: `Too many strings in one request (limit ${MAX_TEXTS}).`, field: 'texts' });
  }
  if (!texts.every((s) => typeof s === 'string')) {
    return res.status(400).json({ error: 'Every entry in texts must be a string.', field: 'texts' });
  }
  if (!targetLanguage) {
    return res.status(400).json({ error: 'targetLanguage is required.', field: 'targetLanguage' });
  }

  try {
    const translations = await translateBatch(texts, sourceLanguage || 'en', targetLanguage);
    return res.json({ translations, translated: true });
  } catch (err) {
    const { code, message } = classify(err);
    console.error(`[translate-ui] ${code}: ${message}`);
    return res.json({ translations: texts, translated: false, reason: message, reasonCode: code });
  }
});

// POST /api/translate — single string, same contract.
router.post('/translate', async (req, res) => {
  const { text, target, source } = req.body || {};
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required.', field: 'text' });
  }
  if (!target) return res.status(400).json({ error: 'target is required.', field: 'target' });

  try {
    const [translated] = await translateBatch([text], source || 'en', target);
    return res.json({ translated, ok: true });
  } catch (err) {
    const { code, message } = classify(err);
    console.error(`[translate] ${code}: ${message}`);
    return res.json({ translated: text, ok: false, reason: message, reasonCode: code });
  }
});

module.exports = { router, classify };
