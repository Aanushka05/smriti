const express = require('express');
const { db, uuid } = require('../database');
const { handleChatTurn } = require('../chat_service');
const { requireAuth, canAccessPatient } = require('../middleware/auth');

const router = express.Router();

// POST /api/chat  { patientId?, message, lang }  ->  { reply, lang }
router.post('/chat', requireAuth, async (req, res, next) => {
  try {
    const { patientId, message, lang } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Please type a message first.', field: 'message' });
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
    console.error('[chat]', err.message);
    res.status(502).json({ error: err.message });
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
