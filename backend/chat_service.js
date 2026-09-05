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

const SYSTEM_PROMPT = `You are the in-app companion inside SmritiSaathi Care, a dementia-support app used by
elderly patients and their family caregivers / ASHA workers in Northeast India. You are talking
directly to the patient (or sometimes their caregiver). Keep replies short (2-4 sentences),
warm, simple, and reassuring — this app is used by people with memory difficulties. Avoid
medical diagnoses; if asked something medical, gently suggest they check with their ASHA
worker, doctor, or family. Never claim to remember earlier conversations you were not shown in
this request. Respond only in English — translation to the patient's language happens outside
of you.`;

async function callClaude(messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set in backend/.env — chat cannot reach an AI model.');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API call failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text : "I'm here, but I couldn't form a reply just now.";
}

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

  // 2) build Anthropic message list and call Claude
  const messages = [
    ...englishHistory.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text })),
    { role: 'user', content: englishUser },
  ];
  const englishReply = await callClaude(messages);

  // 3) translate the reply back to the patient's language
  const replyInLang = lang === 'en' ? englishReply : (await translateBatch([englishReply], 'en', lang))[0];

  return { englishUser, englishReply, replyInLang };
}

module.exports = { handleChatTurn };
