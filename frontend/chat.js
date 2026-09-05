/* chat.js
 * ---------------------------------------------------------------------
 * Real chat architecture (no dummy/static UI):
 *   User -> chat.js -> POST /api/chat -> backend/chat_service.js
 *         -> Anthropic API -> Bhashini (if translation required) -> reply
 *         -> chat.js -> rendered in the patient's selected language
 *
 * No API key of any kind ever appears in this file — the backend holds
 * ANTHROPIC_API_KEY and the Bhashini credentials.
 * ---------------------------------------------------------------------
 */

function toggleChat() {
  state.chatOpen = !state.chatOpen;
  if (state.chatOpen && state.patientId && state.chatHistory.length === 0) loadChatHistory();
  renderChatWidget();
}

async function loadChatHistory() {
  if (!state.patientId) return;
  const res = await apiFetch(`/chat/${encodeURIComponent(state.patientId)}/history`);
  if (res.ok && Array.isArray(res.data)) {
    state.chatHistory = res.data.map((r) => ({ role: r.role, text: r.text }));
    renderChatWidget();
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const message = input.value.trim();
  if (!message || state.chatBusy) return;
  input.value = '';

  const lang = (state.patient && state.patient.lang) || i18n.currentLang;
  state.chatHistory.push({ role: 'user', text: message });
  state.chatBusy = true;
  renderChatWidget();

  const res = await apiFetch('/chat', {
    method: 'POST',
    body: { patientId: state.patientId, message, lang },
  });
  if (res.ok && res.data && res.data.reply) {
    state.chatHistory.push({ role: 'assistant', text: res.data.reply });
  } else {
    state.chatHistory.push({ role: 'assistant', text: res.error || t('chatError') });
  }
  state.chatBusy = false;
  renderChatWidget();
}

function chatVoiceInput() {
  const lang = (state.patient && state.patient.lang) || i18n.currentLang;
  voiceService.listen(lang, (transcript) => {
    const input = document.getElementById('chat-input');
    if (input) { input.value = transcript; sendChatMessage(); }
  }, () => {});
}

function chatSpeakLast() {
  const lang = (state.patient && state.patient.lang) || i18n.currentLang;
  const lastAssistant = [...state.chatHistory].reverse().find((m) => m.role === 'assistant');
  if (lastAssistant) voiceService.speak(lastAssistant.text, lang);
}

async function clearChat() {
  state.chatHistory = [];
  if (state.patientId) {
    await apiFetch(`/chat/${encodeURIComponent(state.patientId)}/history`, { method: 'DELETE' });
  }
  renderChatWidget();
}

function chatBubble(m) {
  const cls = m.role === 'user' ? 'chat-bubble-user ml-auto' : 'chat-bubble-assistant mr-auto';
  return `<div class="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm mb-2 ${cls}">${escapeHtml(m.text)}</div>`;
}

function renderChatWidget() {
  let host = document.getElementById('chat-host');
  if (!host) return;

  // Only show the chat launcher once someone is logged in (patient or caregiver).
  if (!state.patient && !state.caregiver) { host.innerHTML = ''; return; }

  if (!state.chatOpen) {
    host.innerHTML = `
    <button onclick="toggleChat()" aria-label="${t('chatTitle')}"
      class="fixed bottom-6 right-6 w-14 h-14 rounded-full bg-maroon text-white text-2xl shadow-lg flex items-center justify-center z-40">
      💬
    </button>`;
    return;
  }

  host.innerHTML = `
  <div id="chat-panel" class="fixed bottom-6 right-6 w-[min(92vw,380px)] h-[min(70vh,540px)] card-textile rounded-2xl shadow-2xl z-40 flex flex-col overflow-hidden">
    <div class="bg-maroonDark text-white px-4 py-3 flex items-center justify-between">
      <span class="font-serif2 text-base">${t('chatTitle')}</span>
      <button onclick="toggleChat()" class="text-white/80 hover:text-white text-lg leading-none">✕</button>
    </div>
    <div id="chat-messages" class="flex-1 overflow-y-auto px-4 py-3 bg-[#F9F5EB]">
      ${state.chatHistory.length === 0 ? `<div class="text-xs text-inksoft text-center mt-6">${t('chatPlaceholder')}</div>` : state.chatHistory.map(chatBubble).join('')}
      ${state.chatBusy ? `<div class="text-xs text-inksoft">${t('chatThinking')}</div>` : ''}
    </div>
    <div class="border-t border-linec p-3 flex items-center gap-2">
      <button onclick="chatVoiceInput()" title="${t('tapToSpeak')}" class="w-10 h-10 rounded-full border border-linec bg-white flex items-center justify-center">🎤</button>
      <input id="chat-input" type="text" placeholder="${t('chatPlaceholder')}"
        onkeydown="if(event.key==='Enter'){sendChatMessage();}"
        class="flex-1 border border-linec rounded-full px-4 py-2 text-sm">
      <button onclick="sendChatMessage()" class="w-10 h-10 rounded-full bg-maroon text-white flex items-center justify-center" ${state.chatBusy ? 'disabled' : ''}>➤</button>
    </div>
    <div class="px-3 pb-2 flex justify-between">
      <button onclick="chatSpeakLast()" class="text-xs text-slateb">🔊 ${t('hearReminder')}</button>
      <button onclick="clearChat()" class="text-xs text-slateb">${t('chatClear')}</button>
    </div>
  </div>`;

  const box = document.getElementById('chat-messages');
  if (box) box.scrollTop = box.scrollHeight;
}
