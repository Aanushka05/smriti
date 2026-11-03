/* ============================================================================
 * routes/speech.js — voice in, voice out.
 *
 * Everything Bhashini needs stays on the server: the API key never reaches a
 * browser, and audio is relayed rather than posted to Bhashini from the page.
 *
 * The honest part is /speech/capability. There is a real temptation to tell
 * the frontend "yes, this language works" and let it discover otherwise when
 * the microphone button does nothing. This route asks the pipeline instead,
 * and reports exactly what came back — including "not configured".
 * ==========================================================================*/

const express = require('express');
const {
  transcribeAudio, synthesizeSpeech, speechCapability, baseLang, SUPPORTED_LANGUAGES,
} = require('../bhashini_service');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

/** Audio is base64 and therefore bulky; this route alone gets a bigger body. */
const audioBody = express.json({ limit: '8mb' });

function bhashiniConfigured() {
  return !!(process.env.BHASHINI_API_KEY && process.env.BHASHINI_PIPELINE_ID);
}

/**
 * Turns a service error into something a patient can read, without leaking
 * endpoint URLs, keys or stack traces.
 */
function speechError(res, err, fallbackMessage) {
  const message = String(err && err.message ? err.message : '');
  const unsupported = /does not offer|not one of the languages/i.test(message);
  const timedOut = /abort|timeout/i.test(message);

  if (unsupported) return res.status(422).json({ error: message, reason: 'unsupported_language' });
  if (timedOut) {
    return res.status(504).json({
      error: 'The speech service did not answer in time. Please try again.',
      reason: 'timeout',
    });
  }
  // Log the detail, show the user the summary.
  console.error('[speech]', message);
  return res.status(502).json({ error: fallbackMessage, reason: 'service_unavailable' });
}

// GET /api/speech/capability?lang=as
// What this server can actually do for a language, right now.
router.get('/speech/capability', async (req, res) => {
  const lang = baseLang(req.query.lang || 'en');
  try {
    const capability = await speechCapability(lang);
    return res.json({ ok: true, capability });
  } catch (err) {
    // A failed probe is itself an answer: nothing online is available.
    return res.json({
      ok: true,
      capability: {
        language: lang, offered: SUPPORTED_LANGUAGES.has(lang), configured: bhashiniConfigured(),
        translation: false, asr: false, tts: false, checked: true,
        note: 'The speech service could not be reached.',
      },
    });
  }
});

// POST /api/speech/transcribe  { audio, lang }
// Voice to text. Signed in only: this relays a recording of a patient's voice.
router.post('/speech/transcribe', requireAuth, audioBody, async (req, res) => {
  const b = req.body || {};
  if (!bhashiniConfigured()) {
    return res.status(503).json({
      error: 'Online speech recognition is not configured on this server.',
      reason: 'not_configured',
    });
  }
  try {
    const out = await transcribeAudio(b.audio, b.lang || 'en');
    return res.json({ ok: true, ...out });
  } catch (err) {
    return speechError(res, err, 'Could not understand that recording. Please try again.');
  }
});

// POST /api/speech/synthesize  { text, lang, gender }
// Text to voice.
router.post('/speech/synthesize', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!bhashiniConfigured()) {
    return res.status(503).json({
      error: 'Online speech is not configured on this server.',
      reason: 'not_configured',
    });
  }
  try {
    const out = await synthesizeSpeech(b.text, b.lang || 'en', b.gender);
    return res.json({ ok: true, ...out });
  } catch (err) {
    return speechError(res, err, 'Could not read that out. Please try again.');
  }
});

module.exports = router;
