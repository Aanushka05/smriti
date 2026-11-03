// chat_service.js
// -----------------------------------------------------------------------
// Backend brain for chat.js. Architecture (matches the spec exactly):
//
//   User -> chat.js -> POST /api/chat -> chat_service.js -> Anthropic API
//         -> Bhashini (if translation is required) -> response -> chat.js
//
// The assistant itself always reasons in English (best quality, and keeps
// prompt engineering simple). If the patient's selected language isn't
// English, we:
//   1. translate the incoming message TO English via Bhashini so the
//      model understands it regardless of script/language,
//   2. get the English reply from Claude,
//   3. translate the reply back to the patient's language via Bhashini.
// No API key of any kind is ever sent to the frontend.
// -----------------------------------------------------------------------

const fetch = require('node-fetch');
const { translateBatch, baseLang } = require('./bhashini_service');
const { askModel, chatStatus } = require('./chat_providers');

/* The model, the prompt and the request shape all live in chat_providers.js,
 * so changing provider is a configuration change rather than a code change. */

/**
 * handleChatTurn
 * @param {Array<{role:'user'|'assistant', text:string}>} history - prior turns, in the PATIENT'S language
 * @param {string} userMessage - latest message, in the patient's language
 * @param {string} langCode - e.g. 'as-IN', 'hi-IN', 'en-IN'
 */
async function handleChatTurn(history, userMessage, langCode) {
  const lang = baseLang(langCode);

  // 1) translate incoming message + history to English (skip if already English)
  const englishUser = lang === 'en' ? userMessage : (await translateBatch([userMessage], lang, 'en'))[0];
  const englishHistory = lang === 'en'
    ? history
    : await Promise.all(history.map(async (m) => ({ role: m.role, text: (await translateBatch([m.text], lang, 'en'))[0] })));

  // 2) hand the conversation to whichever model is configured
  const messages = [
    ...englishHistory.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text })),
    { role: 'user', content: englishUser },
  ];
  const englishReply = await askModel(messages);

  // 3) translate the reply back to the patient's language
  const replyInLang = lang === 'en' ? englishReply : (await translateBatch([englishReply], 'en', lang))[0];

  return { englishUser, englishReply, replyInLang };
}

module.exports = { handleChatTurn, chatStatus };
