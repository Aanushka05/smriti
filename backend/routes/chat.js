const express = require('express');
const { db, uuid } = require('../database');
const { handleChatTurn } = require('../chat_service');
const { chatStatus } = require('../chat_providers');
const { requireAuth, canAccessPatient } = require('../middleware/auth');

const router = express.Router();

// POST /api/chat  { patientId?, message, lang }  ->  { reply, lang }
/* Chat is the one route that spends money per call, so it gets its own
 * throttle. Keyed on the authenticated user, not the IP: several patients
 * may share a clinic's connection and must not throttle each other. */
const CHAT_WINDOW_MS = Number(process.env.CHAT_RATE_WINDOW_MS) || 60 * 1000;
const CHAT_MAX_PER_WINDOW = Number(process.env.CHAT_RATE_MAX) || 15;
const chatHits = new Map();

function chatRateLimited(userId) {
  const now = Date.now();
  const hits = (chatHits.get(userId) || []).filter((t) => now - t < CHAT_WINDOW_MS);
  hits.push(now);
  chatHits.set(userId, hits);
  // Keep the map from growing without bound on a long-running server.
  if (chatHits.size > 5000) {
    for (const [k, v] of chatHits) if (!v.some((t) => now - t < CHAT_WINDOW_MS)) chatHits.delete(k);
  }
  return hits.length > CHAT_MAX_PER_WINDOW;
}

// GET /api/chat/status — whether chat can work, and if not, what is missing.
// Names of missing settings only; never their values.
router.get('/chat/status', requireAuth, (req, res) => res.json({ ok: true, chat: chatStatus() }));

router.post('/chat', requireAuth, async (req, res, next) => {
  try {
    const { patientId, message, lang } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Please type a message first.', field: 'message' });
    }
    // Bound the input: an unbounded prompt is both a cost and an abuse vector.
    if (String(message).length > 2000) {
      return res.status(400).json({ error: 'That message is too long. Please shorten it.', field: 'message' });
    }
    if (chatRateLimited(req.user.id)) {
      return res.status(429).json({
        error: 'You are sending messages very quickly. Please wait a moment.',
        code: 'RATE_LIMITED',
      });
    }
    if (patientId && !canAccessPatient(req.user, patientId)) {
      return res.status(403).json({ error: 'This patient is not linked to your account.', code: 'NOT_LINKED' });
    }

    const priorRows = patientId
      ? db.prepare('SELECT role, text_lang FROM chat_messages WHERE patient_id=? ORDER BY created_at DESC LIMIT 8').all(patientId).reverse()
      : [];
    const history = priorRows.map((r) => ({ role: r.role, text: r.text_lang }));

    const { englishUser, englishReply, replyInLang } = await handleChatTurn(history, message, lang || 'en-IN');

    if (patientId) {
      const now = Date.now();
      const insert = db.prepare(`INSERT INTO chat_messages (id,patient_id,role,lang,text_en,text_lang,created_at)
        VALUES (?,?,?,?,?,?,?)`);
      insert.run(uuid(), patientId, 'user', lang, englishUser, message, now);
      insert.run(uuid(), patientId, 'assistant', lang, englishReply, replyInLang, now + 1);
    }

    res.json({ reply: replyInLang, lang: lang || 'en-IN' });
  } catch (err) {
    // The detail is for the server log. The client gets a summary: an
    // upstream error body can echo back the request, headers included.
    console.error('[chat]', err.code || 'error', err.message);
    const status = err.status || 502;
    const safe = {
      chat_not_configured: 'The companion is not available on this server yet.',
      chat_bad_style: 'The companion is misconfigured on this server.',
      chat_upstream_error: 'The companion could not answer just now. Please try again.',
      chat_empty_reply: 'The companion could not think of a reply. Please try again.',
    }[err.code]
      || 'The companion could not answer just now. Please try again.';
    res.status(status).json({ error: safe, code: err.code || 'chat_error' });
  }
});

// GET /api/chat/:patientId/history
router.get('/chat/:patientId/history', requireAuth, (req, res) => {
  if (!canAccessPatient(req.user, req.params.patientId)) {
    return res.status(403).json({ error: 'This patient is not linked to your account.', code: 'NOT_LINKED' });
  }
  const rows = db.prepare(`SELECT role, text_lang as text, created_at FROM chat_messages
    WHERE patient_id=? ORDER BY created_at ASC`).all(req.params.patientId);
  res.json(rows);
});

// DELETE /api/chat/:patientId/history — "clear conversation"
router.delete('/chat/:patientId/history', requireAuth, (req, res) => {
  if (!canAccessPatient(req.user, req.params.patientId)) {
    return res.status(403).json({ error: 'This patient is not linked to your account.', code: 'NOT_LINKED' });
  }
  db.prepare('DELETE FROM chat_messages WHERE patient_id=?').run(req.params.patientId);
  res.json({ ok: true });
});

module.exports = { router };
