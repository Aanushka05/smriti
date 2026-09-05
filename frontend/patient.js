/* patient.js — the patient's own screen.
 *
 * Deliberately simpler than the caregiver dashboard: big type, big touch
 * targets, one column on a phone, no tables, no charts to read, one clear
 * action per card. Sections, in order:
 *
 *   Greeting · Next reminder · Today's schedule · Today's activities
 *   Cognitive games · Performance · Progress · Voice · Help / emergency
 *
 * Everything on this screen is read from the backend. There are no
 * hard-coded schedules, reminders or scores anywhere in this file.
 */

/* ------------------------------------------------------------- TOP BAR */
function patientTopBar() {
  const lang = state.patient.lang;
  return `
  <header class="bg-maroonDark text-white">
    <div class="max-w-4xl mx-auto px-4 sm:px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-2xl" aria-hidden="true">🧵</span>
        <span class="font-serif2 text-xl sm:text-2xl tracking-wide truncate">${APP_NAME}</span>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <span data-live-indicator class="text-xs px-3 py-2 rounded-full bg-white/10 border border-white/25">
          ${realtimeStatusText()}
        </span>
        <select onchange="onLanguageChange(this.value, {patient:true})" aria-label="${t('preferredLanguage')}"
          class="text-sm bg-white/10 border border-white/30 rounded-full px-3 py-2 text-white">
          ${LANGS.map((l) => `<option value="${l.code}" ${l.code === lang ? 'selected' : ''} class="text-ink">🌐 ${l.native}</option>`).join('')}
        </select>
        <button onclick="logout()" class="text-sm bg-white/10 hover:bg-white/20 px-4 py-2 rounded-full border border-white/30 min-h-[44px]">
          ${t('logout')}
        </button>
      </div>
    </div>
  </header>
  ${wovenStrip(6)}`;
}

/* --------------------------------------------------------- GREETING */
function timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return t('goodMorningGreeting');
  if (h < 17) return t('goodAfternoonGreeting');
  return t('goodEveningGreeting');
}

/* ------------------------------------------------------- PATIENT HOME */
function renderPatientHome() {
  const p = state.patient;
  if (!p) return renderLoading();

  return `
  ${patientTopBar()}
  <main class="max-w-4xl mx-auto px-4 sm:px-5 py-6 fade-in pb-16">
    <section class="mb-7">
      <h1 class="font-serif2 text-3xl sm:text-4xl text-maroonDark leading-tight">
        ${timeGreeting()}, ${escapeHtml(p.name)}
      </h1>
      <p class="text-lg text-inksoft mt-1">${todayLongDate()}</p>
    </section>

    ${nextReminderCard()}
    ${todaysScheduleSection()}
    ${todaysActivitiesSection()}
    ${cognitiveGamesSection()}
    ${performanceSection()}
    ${progressSection()}
    ${voiceSection()}
    ${helpSection()}
  </main>`;
}

function todayLongDate() {
  return new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

function sectionHeading(icon, title, extra) {
  return `
  <div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
    <h2 class="font-serif2 text-2xl text-maroonDark flex items-center gap-2">
      <span aria-hidden="true">${icon}</span>${title}
    </h2>
    ${extra || ''}
  </div>`;
}

/* --------------------------------------------------- NEXT REMINDER */
function nextReminderCard() {
  const n = state.nextReminder;
  if (!n) {
    return `
    <section class="mb-7" aria-labelledby="next-reminder-heading">
      ${sectionHeading('⏭️', `<span id="next-reminder-heading">${t('nextReminder')}</span>`)}
      <div class="card-textile rounded-2xl p-6 text-center text-lg text-inksoft">
        ${t('nothingComingUp')}
      </div>
    </section>`;
  }
  const isToday = n.date === localDateKey();
  return `
  <section class="mb-7" aria-labelledby="next-reminder-heading">
    ${sectionHeading('⏭️', `<span id="next-reminder-heading">${t('nextReminder')}</span>`)}
    <div class="card-textile rounded-2xl p-5 sm:p-6 border-l-8 border-l-ochre">
      <div class="flex items-center gap-4 flex-wrap">
        <span class="text-5xl" aria-hidden="true">${escapeHtml(n.icon)}</span>
        <div class="flex-1 min-w-[180px]">
          <div class="text-2xl sm:text-3xl font-semibold">${escapeHtml(n.title)}</div>
          <div class="text-xl text-maroon font-semibold mt-1">
            ${escapeHtml(n.time)}${isToday ? '' : ` · ${escapeHtml(formatDayLabel(n.date))}`}
          </div>
          ${n.text ? `<div class="text-lg text-inksoft mt-1">${escapeHtml(n.text)}</div>` : ''}
        </div>
        <button onclick="speakReminder('${jsAttr(n.id)}')" class="btn-patient btn-quiet" aria-label="${t('hearReminder')}">
          🔊 ${t('hearReminder')}
        </button>
      </div>
      ${isToday && n.status !== 'done' ? `
      <div class="flex gap-3 flex-wrap mt-5">
        <button onclick="completeReminder('${jsAttr(n.id)}')" class="btn-patient btn-done flex-1">✓ ${t('markDone')}</button>
        <button onclick="snoozeReminder('${jsAttr(n.id)}', 15)" class="btn-patient btn-quiet flex-1">⏰ ${t('snooze15')}</button>
      </div>` : ''}
    </div>
  </section>`;
}

function localDateKey(d) {
  const date = d || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDayLabel(dateKey) {
  if (!dateKey) return '';
  const today = localDateKey();
  const tomorrow = localDateKey(new Date(Date.now() + 86400000));
  if (dateKey === today) return t('today');
  if (dateKey === tomorrow) return t('tomorrow');
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

/* -------------------------------------------------- TODAY'S SCHEDULE */
function todaysScheduleSection() {
  const schedules = (state.patient.schedules || []).filter((s) => s.status === 'active');
  return `
  <section class="mb-7" aria-labelledby="schedule-heading">
    ${sectionHeading('🗓️', `<span id="schedule-heading">${t('todaysSchedule')}</span>`)}
    ${schedules.length === 0 ? `
      <div class="card-textile rounded-2xl p-6 text-center text-lg text-inksoft">
        ${t('noScheduleYet')}
      </div>` : `
      <ul class="flex flex-col gap-3 list-none p-0 m-0">
        ${schedules.map((s) => `
          <li class="card-textile rounded-2xl p-4 flex items-center gap-3 flex-wrap">
            <span class="text-3xl shrink-0" aria-hidden="true">${escapeHtml(s.icon)}</span>
            <div class="flex-1 min-w-[140px]">
              <div class="text-xl font-semibold">${escapeHtml(s.title)}</div>
              <div class="text-lg text-maroon">${escapeHtml(s.time)} · ${t('repeat_' + s.repeat)}</div>
              ${s.description ? `<div class="text-base text-inksoft mt-0.5">${escapeHtml(s.description)}</div>` : ''}
            </div>
            ${s.priority === 'high' ? `<span class="text-sm px-3 py-1.5 rounded-full bg-[#FBEAE7] text-alertc font-semibold shrink-0">${t('important')}</span>` : ''}
          </li>`).join('')}
      </ul>`}
  </section>`;
}

/* ------------------------------------------------ TODAY'S ACTIVITIES */
function todaysActivitiesSection() {
  const reminders = state.patient.reminders || [];
  const stats = state.patient.reminderStats;
  const done = reminders.filter((r) => r.status === 'done').length;

  return `
  <section class="mb-7" aria-labelledby="activities-heading">
    ${sectionHeading('✅', `<span id="activities-heading">${t('todaysActivities')}</span>`,
    reminders.length ? `<span class="text-lg text-inksoft">${done}/${reminders.length} ${t('doneLower')}</span>` : '')}
    ${reminders.length === 0 ? `
      <div class="card-textile rounded-2xl p-6 text-center text-lg text-inksoft">
        ${t('noRemindersToday')}
      </div>` : `
      <ul class="flex flex-col gap-3 list-none p-0 m-0">
        ${reminders.map((r) => patientReminderCard(r)).join('')}
      </ul>
      ${stats && stats.today.adherence !== null ? `
      <p class="text-base text-inksoft mt-3">${t('todaysAdherence')}: <strong>${stats.today.adherence}%</strong></p>` : ''}`}
  </section>`;
}

function patientReminderCard(r) {
  const style = {
    done: 'border-l-leafgreen bg-[#F2F7F1]',
    missed: 'border-l-alertc',
    snoozed: 'border-l-ochre',
    pending: 'border-l-linec',
  }[r.status] || 'border-l-linec';

  const badge = {
    done: `<span class="text-base px-3 py-1.5 rounded-full bg-leafgreen text-white font-semibold">✓ ${t('done')}</span>`,
    missed: `<span class="text-base px-3 py-1.5 rounded-full bg-[#FBEAE7] text-alertc font-semibold">${t('missed')}</span>`,
    snoozed: `<span class="text-base px-3 py-1.5 rounded-full bg-ochre text-white font-semibold">⏰ ${t('snoozed')}</span>`,
  }[r.status] || '';

  return `
  <li class="card-textile rounded-2xl p-4 border-l-8 ${style}">
    <div class="flex items-start gap-4 flex-wrap">
      <span class="text-3xl" aria-hidden="true">${escapeHtml(r.icon)}</span>
      <div class="flex-1 min-w-[160px]">
        <div class="text-xl font-semibold">${escapeHtml(r.title)}</div>
        <div class="text-lg text-maroon">${escapeHtml(r.time)}</div>
        ${r.text ? `<div class="text-base text-inksoft mt-0.5">${escapeHtml(r.text)}</div>` : ''}
      </div>
      ${badge}
    </div>
    <div class="flex gap-2.5 flex-wrap mt-4">
      <button onclick="speakReminder('${jsAttr(r.id)}')" class="btn-patient btn-quiet" aria-label="${t('hearReminder')}: ${escapeHtml(r.title)}">🔊</button>
      ${r.status === 'done' ? '' : `
        <button onclick="completeReminder('${jsAttr(r.id)}')" class="btn-patient btn-done flex-1">✓ ${t('markDone')}</button>
        <button onclick="snoozeReminder('${jsAttr(r.id)}', 15)" class="btn-patient btn-quiet">⏰ ${t('snooze15')}</button>`}
    </div>
  </li>`;
}

/* ------------------------------------------------------------- GAMES */
function cognitiveGamesSection() {
  return `
  <section class="mb-7" aria-labelledby="games-heading">
    ${sectionHeading('🧠', `<span id="games-heading">${t('cognitiveGames')}</span>`)}
    <div class="grid gap-4" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      ${GAMES.map((g) => {
    const level = (state.levels && state.levels[g.domain]) || 1;
    return `
      <div class="card-textile rounded-2xl overflow-hidden flex flex-col">
        <div class="h-2" style="background:${DOMAIN_META[g.domain].color}"></div>
        <div class="p-5 flex-1 flex flex-col">
          <div class="text-4xl mb-2" aria-hidden="true">${g.icon}</div>
          <h3 class="font-serif2 text-xl mb-1">${g.title()}</h3>
          <p class="text-base text-inksoft mb-3 flex-1">${g.instructions()}</p>
          <p class="text-sm text-inksoft mb-3">${DOMAIN_META[g.domain].label()} · ${t('level')} ${level}/5</p>
          <button onclick="startGame('${g.key}')" class="btn-patient w-full text-white"
            style="background:${DOMAIN_META[g.domain].color}">${t('playGame')}</button>
        </div>
      </div>`;
  }).join('')}
    </div>
  </section>`;
}

/* ------------------------------------------------------- PERFORMANCE */
function performanceSection() {
  const sessions = (state.patient.sessions || []);
  const metrics = (state.patient.metrics || []).filter((m) => m.sessions_count > 0);

  if (state.loadState.patient === 'loading') {
    return `<section class="mb-7">${sectionHeading('📊', t('myPerformance'))}
      <div class="card-textile rounded-2xl p-6">${panelState('patient')}</div></section>`;
  }
  if (state.loadState.patient === 'error') {
    return `<section class="mb-7">${sectionHeading('📊', t('myPerformance'))}
      <div class="card-textile rounded-2xl p-6">${panelState('patient', 'reloadPatient()')}</div></section>`;
  }

  if (!sessions.length) {
    return `
    <section class="mb-7" aria-labelledby="performance-heading">
      ${sectionHeading('📊', `<span id="performance-heading">${t('myPerformance')}</span>`)}
      <div class="card-textile rounded-2xl p-6 text-center text-lg text-inksoft">
        ${t('noSessionsYetPatient')}
      </div>
    </section>`;
  }

  const overall = Math.round((sessions.reduce((a, s) => a + s.accuracy, 0) / sessions.length) * 100);
  const avgSeconds = (sessions.reduce((a, s) => a + s.avgTimeMs, 0) / sessions.length / 1000).toFixed(1);

  return `
  <section class="mb-7" aria-labelledby="performance-heading">
    ${sectionHeading('📊', `<span id="performance-heading">${t('myPerformance')}</span>`)}
    <div class="grid gap-3 mb-4" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="card-textile rounded-2xl p-4 text-center">
        <div class="text-4xl font-serif2 text-maroon">${sessions.length}</div>
        <div class="text-base text-inksoft">${t('activitiesDone')}</div>
      </div>
      <div class="card-textile rounded-2xl p-4 text-center">
        <div class="text-4xl font-serif2 text-maroon">${overall}%</div>
        <div class="text-base text-inksoft">${t('overallScore')}</div>
      </div>
      <div class="card-textile rounded-2xl p-4 text-center">
        <div class="text-4xl font-serif2 text-maroon">${avgSeconds}s</div>
        <div class="text-base text-inksoft">${t('averageAnswerTime')}</div>
      </div>
    </div>
    <div class="card-textile rounded-2xl p-5">
      <h3 class="text-lg font-semibold mb-3">${t('byActivityArea')}</h3>
      <ul class="flex flex-col gap-3 list-none p-0 m-0">
        ${metrics.map((m) => {
    const pct = Math.round(m.avg_accuracy * 100);
    return `
        <li>
          <div class="flex justify-between text-base mb-1">
            <span>${DOMAIN_META[m.domain] ? DOMAIN_META[m.domain].label() : escapeHtml(m.domain)}</span>
            <span class="font-semibold">${pct}%</span>
          </div>
          <div class="h-3 rounded-full bg-[#EDE7D8] overflow-hidden" role="img"
            aria-label="${DOMAIN_META[m.domain] ? DOMAIN_META[m.domain].label() : m.domain} ${pct}%">
            <div class="h-full rounded-full" style="width:${pct}%;background:${DOMAIN_META[m.domain] ? DOMAIN_META[m.domain].color : '#6B2737'}"></div>
          </div>
        </li>`;
  }).join('')}
      </ul>
    </div>
  </section>`;
}

/* ---------------------------------------------------------- PROGRESS */
function progressSection() {
  const sessions = (state.patient.sessions || []).slice(-7);
  if (!sessions.length) return '';

  const first = sessions[0].accuracy;
  const last = sessions[sessions.length - 1].accuracy;
  const direction = sessions.length < 2 ? 'flat' : last > first ? 'up' : last < first ? 'down' : 'flat';
  const message = {
    up: t('progressUp'),
    down: t('progressDown'),
    flat: t('progressSteady'),
  }[direction];

  return `
  <section class="mb-7" aria-labelledby="progress-heading">
    ${sectionHeading('📈', `<span id="progress-heading">${t('myProgress')}</span>`)}
    <div class="card-textile rounded-2xl p-5">
      <p class="text-lg mb-4">${message}</p>
      <div class="flex items-end gap-2 h-28" role="img" aria-label="${t('lastActivitiesChart')}">
        ${sessions.map((s) => {
    const pct = Math.round(s.accuracy * 100);
    return `<div class="flex-1 flex flex-col items-center justify-end gap-1">
            <span class="text-sm text-inksoft">${pct}%</span>
            <div class="w-full rounded-t-lg" style="height:${Math.max(pct, 6)}%;background:${DOMAIN_META[s.domain] ? DOMAIN_META[s.domain].color : '#6B2737'}"></div>
          </div>`;
  }).join('')}
      </div>
      <p class="text-sm text-inksoft mt-3">${t('lastNActivities').replace('{n}', sessions.length)}</p>
    </div>
  </section>`;
}

/* ------------------------------------------------------------- VOICE */
function voiceSection() {
  return `
  <section class="mb-7" aria-labelledby="voice-heading">
    ${sectionHeading('🎤', `<span id="voice-heading">${t('voiceHelp')}</span>`)}
    <div class="card-textile rounded-2xl p-5">
      <button onclick="startVoiceCommand()" aria-pressed="${state.voiceListening}"
        class="btn-patient w-full text-white text-xl ${state.voiceListening ? 'pulse-rec' : ''}"
        style="background:${state.voiceListening ? '#B23A2E' : '#4A5C7A'}">
        🎤 ${state.voiceListening ? t('listening') : t('tapToSpeak')}
      </button>
      ${state.lastVoiceTranscript ? `
        <p class="text-base text-inksoft mt-3" role="status" aria-live="polite">
          ${t('youSaid')}: “${escapeHtml(state.lastVoiceTranscript)}”
        </p>` : ''}
      <p class="text-base text-inksoft mt-3">${t('voiceExamples')}</p>
      <ul class="text-base text-inksoft list-disc pl-6 mt-1 space-y-0.5">
        <li>“${t('voiceCmdReminders')}”</li>
        <li>“${t('voiceCmdNext')}”</li>
        <li>“${t('voiceCmdGame')}”</li>
        <li>“${t('voiceCmdRead')}”</li>
      </ul>
    </div>
  </section>`;
}

/* -------------------------------------------------------------- HELP */
function helpSection() {
  const contact = state.patient.emergencyContact;
  const caregivers = state.patient.caregivers || [];
  return `
  <section aria-labelledby="help-heading">
    ${sectionHeading('🆘', `<span id="help-heading">${t('helpAndContacts')}</span>`)}
    <div class="card-textile rounded-2xl p-5">
      ${contact ? `
        <a href="tel:${encodeURIComponent(contact)}"
          class="btn-patient w-full bg-alertc text-white text-xl block text-center no-underline">
          📞 ${t('callEmergencyContact')} · ${escapeHtml(contact)}
        </a>` : `
        <p class="text-lg text-inksoft">${t('noEmergencyContact')}</p>`}
      ${caregivers.length ? `
        <div class="mt-4">
          <h3 class="text-lg font-semibold mb-2">${t('myCaregivers')}</h3>
          <ul class="list-none p-0 m-0 flex flex-col gap-2">
            ${caregivers.map((c) => `
              <li class="text-lg">👤 ${escapeHtml(c.name)}${c.relationship ? ` · ${escapeHtml(c.relationship)}` : ''}</li>`).join('')}
          </ul>
        </div>` : ''}
      <p class="text-sm text-inksoft mt-4">${t('notDiagnosis')}</p>
    </div>
  </section>`;
}

/* ------------------------------------------------- REMINDER ACTIONS */
function findReminder(id) {
  const list = (state.patient && state.patient.reminders) || [];
  return list.find((r) => r.id === id)
    || (state.nextReminder && state.nextReminder.id === id ? state.nextReminder : null);
}

function speakReminder(id) {
  const r = findReminder(id);
  if (!r) return;
  voiceService.speak(`${r.title}. ${r.time}. ${r.text || ''}`, state.patient.lang);
}

async function completeReminder(id) {
  const res = await api.completeReminder(id);
  if (!res.ok) { showToast(res.error); return; }
  showToast(t('reminderMarkedDone'));
  await refreshPatientData(state.patientId);
  await loadNextReminder();
  render();
}

async function snoozeReminder(id, minutes) {
  const res = await api.snoozeReminder(id, minutes);
  if (!res.ok) { showToast(res.error); return; }
  showToast(res.data.message || t('reminderSnoozed'));
  await refreshPatientData(state.patientId);
  await loadNextReminder();
  render();
}

async function reloadPatient() {
  await refreshPatientData(state.patientId);
  await loadNextReminder();
  render();
}

/* ------------------------------------------------------ VOICE COMMANDS
 * Web Speech API where the browser has it; every command also has a
 * button, so nothing is voice-only. If speech recognition is missing we
 * say so plainly instead of failing silently.
 */
const VOICE_COMMANDS = [
  {
    match: /remind|reminder|schedule|today/i,
    run: () => {
      const list = (state.patient.reminders || []).filter((r) => r.status !== 'done');
      if (!list.length) { speakAndToast(t('allRemindersDone')); return; }
      const text = list.map((r) => `${r.title} at ${r.time}`).join('. ');
      speakAndToast(`${t('todaysReminders')}: ${text}`);
    },
  },
  {
    match: /next|coming up|after this/i,
    run: () => {
      const n = state.nextReminder;
      speakAndToast(n ? `${t('nextReminder')}: ${n.title} at ${n.time}` : t('nothingComingUp'));
    },
  },
  {
    match: /memory match|match/i,
    run: () => startGame('game-memorymatch'),
  },
  {
    match: /word/i,
    run: () => startGame('game-wordrecall'),
  },
  {
    match: /sequence|order/i,
    run: () => startGame('game-sequence'),
  },
  {
    match: /game|play|activity|memory/i,
    run: () => startGame('game-familyfaces'),
  },
  {
    match: /performance|score|how am i doing|progress/i,
    run: () => {
      const sessions = state.patient.sessions || [];
      if (!sessions.length) { speakAndToast(t('noSessionsYetPatient')); return; }
      const pct = Math.round((sessions.reduce((a, s) => a + s.accuracy, 0) / sessions.length) * 100);
      speakAndToast(`${t('overallScore')}: ${pct}%. ${sessions.length} ${t('activitiesDone')}.`);
    },
  },
  {
    match: /help|emergency|call/i,
    run: () => {
      const c = state.patient.emergencyContact;
      speakAndToast(c ? `${t('callEmergencyContact')}: ${c}` : t('noEmergencyContact'));
    },
  },
];

function speakAndToast(message) {
  showToast(message);
  voiceService.speak(message, state.patient.lang);
}

function startVoiceCommand() {
  if (state.voiceListening) return;
  const supported = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!supported) {
    showToast(t('voiceNotSupported'));
    return;
  }
  state.voiceListening = true;
  state.lastVoiceTranscript = null;
  render();

  voiceService.listen(
    state.patient.lang,
    (transcript) => {
      state.voiceListening = false;
      state.lastVoiceTranscript = transcript;
      render();
      handleVoiceCommand(transcript);
    },
    (err) => {
      state.voiceListening = false;
      render();
      showToast(err === 'no-speech' ? t('voiceNoSpeech') : t('voiceFailed'));
    }
  );
}

function handleVoiceCommand(transcript) {
  const said = String(transcript || '').trim();
  if (!said) { showToast(t('voiceNoSpeech')); return; }
  const command = VOICE_COMMANDS.find((c) => c.match.test(said));
  if (!command) { speakAndToast(t('voiceNotUnderstood')); return; }
  command.run();
}
