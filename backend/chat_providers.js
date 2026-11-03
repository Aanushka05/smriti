/* ============================================================================
 * chat_providers.js — which AI answers the companion chat.
 *
 * WHY THIS FILE EXISTS
 * The chat was hard-wired to one vendor's URL and request shape. Swapping the
 * provider meant editing the calling code. It is now selected by configuration,
 * so a different model is an .env change rather than a code change.
 *
 * ON "KIWI AI"
 * The endpoint and model for Kiwi are NOT hard-coded here, deliberately. I
 * could not verify an official public Kiwi AI API specification, and inventing
 * a URL would produce code that looks finished and fails in production against
 * an endpoint that does not exist. So Kiwi is configured, not guessed:
 *
 *     CHAT_PROVIDER=kiwi
 *     KIWI_API_URL=<the official endpoint from Kiwi's own documentation>
 *     KIWI_API_KEY=<your key>
 *     KIWI_MODEL=<the model name>
 *     KIWI_API_STYLE=openai   # or "anthropic"
 *
 * Nearly every chat API in use today speaks one of two request shapes, so
 * KIWI_API_STYLE covers both without needing bespoke code. If Kiwi uses a
 * third shape, add it below — that is the only change required.
 *
 * The key is read from the environment on every call and never leaves this
 * file. Nothing here is ever sent to the browser.
 * ==========================================================================*/

const fetch = require('node-fetch');

const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS) || 30000;
const MAX_REPLY_TOKENS = Number(process.env.CHAT_MAX_TOKENS) || 400;

/** The companion's brief. It is not a doctor and must never act like one. */
const SYSTEM_PROMPT = `You are the in-app companion inside Smriti, a dementia-support app used by
elderly patients and their family caregivers / ASHA workers in Northeast India. You are talking
directly to the patient (or sometimes their caregiver). Keep replies short (2-4 sentences),
warm, simple, and reassuring — this app is used by people with memory difficulties.

Most messages you receive are ordinary conversation: greetings, small talk, questions about
their day, or general chat. Respond to these warmly and normally, like a friendly companion —
do not add a medical disclaimer to a message unless the person is actually asking about a
symptom, a diagnosis, or a medication.

You are NOT a doctor and must never present yourself as one. Do not diagnose, do not interpret
symptoms, and do not advise on medication doses or changes. Only when someone specifically asks
something medical, say warmly that you are not able to advise on that and suggest they check
with their ASHA worker, doctor, or family.

Never claim to remember earlier conversations you were not shown in this request. Respond only
in English — translation to the patient's language happens outside of you.`;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------- request shapes */

/** The OpenAI chat-completions shape, which most providers copy. */
function openAiStyle({
  url, key, model, messages, authHeader, systemPrompt,
}) {
  return {
    url,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [authHeader || 'Authorization']: (authHeader && authHeader !== 'Authorization')
          ? key : `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_REPLY_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
    },
    // Where the reply text lives in the response.
    extract: (data) => {
      const choice = (data.choices || [])[0];
      const message = choice && (choice.message || choice.delta);
      return (message && message.content) || null;
    },
  };
}

/** The Anthropic messages shape. */
function anthropicStyle({
  url, key, model, messages, systemPrompt,
}) {
  return {
    url,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_REPLY_TOKENS,
        system: systemPrompt,
        messages,
      }),
    },
    extract: (data) => {
      const block = (data.content || []).find((b) => b.type === 'text');
      return block ? block.text : null;
    },
  };
}

const STYLES = { openai: openAiStyle, anthropic: anthropicStyle };

/* --------------------------------------------------------- the providers */

const PROVIDERS = {
  kiwi: {
    name: 'kiwi',
    label: 'Kiwi AI',
    url: () => process.env.KIWI_API_URL,
    key: () => process.env.KIWI_API_KEY,
    model: () => process.env.KIWI_MODEL,
    style: () => String(process.env.KIWI_API_STYLE || 'openai').toLowerCase(),
    authHeader: () => process.env.KIWI_AUTH_HEADER,
    missing() {
      const gaps = [];
      if (!process.env.KIWI_API_URL) gaps.push('KIWI_API_URL');
      if (!process.env.KIWI_API_KEY) gaps.push('KIWI_API_KEY');
      if (!process.env.KIWI_MODEL) gaps.push('KIWI_MODEL');
      return gaps;
    },
  },
  anthropic: {
    name: 'anthropic',
    label: 'Claude',
    url: () => process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages',
    key: () => process.env.ANTHROPIC_API_KEY,
    model: () => process.env.ANTHROPIC_MODEL || 'claude-opus-5',
    style: () => 'anthropic',
    authHeader: () => null,
    missing() {
      return process.env.ANTHROPIC_API_KEY ? [] : ['ANTHROPIC_API_KEY'];
    },
  },
};

/**
 * The provider to use.
 *
 * CHAT_PROVIDER names it explicitly. With nothing set, whichever is actually
 * configured is used — so an existing deployment that only has an Anthropic
 * key keeps working untouched, which is the point.
 */
function activeProvider() {
  const named = String(process.env.CHAT_PROVIDER || '').toLowerCase();
  if (named && PROVIDERS[named]) return PROVIDERS[named];
  if (named) return null;                       // named something unknown
  if (!PROVIDERS.kiwi.missing().length) return PROVIDERS.kiwi;
  if (!PROVIDERS.anthropic.missing().length) return PROVIDERS.anthropic;
  return null;
}

/** What the chat can do right now, and if not, exactly what is missing. */
function chatStatus() {
  const named = String(process.env.CHAT_PROVIDER || '').toLowerCase();
  const provider = activeProvider();

  if (named && !PROVIDERS[named]) {
    return {
      configured: false, provider: named,
      reason: `CHAT_PROVIDER="${named}" is not a provider this build knows. Use one of: ${Object.keys(PROVIDERS).join(', ')}.`,
    };
  }
  if (!provider) {
    return {
      configured: false, provider: null,
      reason: 'No chat provider is configured. Set CHAT_PROVIDER and its keys in backend/.env.',
      available: Object.keys(PROVIDERS),
    };
  }
  const gaps = provider.missing();
  return {
    configured: gaps.length === 0,
    provider: provider.name,
    label: provider.label,
    model: gaps.length ? null : provider.model(),
    // Names of missing settings only — never their values.
    missing: gaps,
    reason: gaps.length
      ? `${provider.label} is selected but ${gaps.join(', ')} ${gaps.length > 1 ? 'are' : 'is'} not set in backend/.env.`
      : null,
  };
}

/**
 * Sends one turn to the configured model and returns the reply text.
 * `systemPrompt` lets a caller other than the companion chat (e.g. the AI
 * Insights write-up) reuse the same provider/routing without inheriting the
 * companion's persona. Defaults to the companion's own prompt so existing
 * callers are unaffected.
 * Throws a tagged error the route can turn into an honest message.
 */
async function askModel(messages, systemPrompt = SYSTEM_PROMPT) {
  const status = chatStatus();
  if (!status.configured) {
    const err = new Error(status.reason);
    err.code = 'chat_not_configured';
    err.status = 503;
    throw err;
  }

  const provider = PROVIDERS[status.provider];
  const styleName = provider.style();
  const build = STYLES[styleName];
  if (!build) {
    const err = new Error(`Unknown API style "${styleName}". Use "openai" or "anthropic".`);
    err.code = 'chat_bad_style';
    err.status = 500;
    throw err;
  }

  const { url, options, extract } = build({
    url: provider.url(),
    key: provider.key(),
    model: provider.model(),
    authHeader: provider.authHeader(),
    messages,
    systemPrompt,
  });

  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Logged server-side with detail; the caller gets a summary.
    const err = new Error(`${provider.label} call failed (${res.status}): ${body.slice(0, 300)}`);
    err.code = 'chat_upstream_error';
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  const text = extract(data);
  if (!text) {
    const err = new Error(`${provider.label} returned no usable reply.`);
    err.code = 'chat_empty_reply';
    err.status = 502;
    throw err;
  }
  return text;
}

module.exports = { askModel, chatStatus, activeProvider, SYSTEM_PROMPT, PROVIDERS };