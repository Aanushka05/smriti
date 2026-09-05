/* dashboard.js — SmritiSaathi Care caregiver dashboard.
 *
 * Sections: My Patients · Add Patient · Patient Profile · Patient
 * Performance · Schedule · Reminders · Cognitive Performance · Reports ·
 * AI Analysis. Every button here performs a real backend call; numbers are
 * recomputed from state.patient on each render (see charts.js: statsFor).
 */

const CG_SECTIONS = [
  { key: 'overview', icon: '📊', label: () => t('overview'), needsPatient: false },
  { key: 'patients', icon: '👥', label: () => t('myPatients'), needsPatient: false },
  { key: 'add-patient', icon: '➕', label: () => t('addPatient'), needsPatient: false },
  { key: 'profile', icon: '🧓', label: () => t('patientProfile'), needsPatient: true },
  { key: 'performance', icon: '📈', label: () => t('patientPerformance'), needsPatient: true },
  { key: 'cognitive', icon: '🧠', label: () => t('cognitiveTrends'), needsPatient: true },
  { key: 'schedule', icon: '🗓️', label: () => t('schedule'), needsPatient: true },
  { key: 'reminders', icon: '🔔', label: () => t('reminderAdherence'), needsPatient: true },
  { key: 'analysis', icon: '🤖', label: () => t('aiInsights'), needsPatient: true },
  { key: 'reports', icon: '📄', label: () => t('reports'), needsPatient: true },
];

/** Sections whose figures are scoped by the shared date range. */
const RANGE_SCOPED_SECTIONS = ['overview', 'performance', 'cognitive', 'analysis', 'reports'];

/* ------------------------------------------------------------- LOADING */
async function loadCaregiverPatients(opts = {}) {
  // `silent` is used by the live-update path: refresh the data without
  // flashing a spinner over a dashboard the caregiver is already reading.
  if (!opts.silent) { setLoad('patients', 'loading'); render(); }

  const res = await api.myPatients();
  if (!res.ok) {
    state.patients = [];
    setLoad('patients', 'error', res.error);
    return;
  }
  state.patients = res.data.patients || [];
  setLoad('patients', 'ready');

  if (state.patients.length) {
    const stillThere = state.patients.some((p) => p.id === state.patientId);
    if (!stillThere) state.patientId = state.patients[0].id;
    await refreshPatientData(state.patientId);
  } else {
    state.patientId = null;
    state.patient = null;
  }
  await loadNotifications();
  await loadOverview({ silent: true });
}

async function loadNotifications() {
  const res = await api.notifications();
  state.notifications = res.ok && Array.isArray(res.data) ? res.data : [];
}

/** The across-all-patients figures for the Overview row. */
async function loadOverview(opts = {}) {
  if (!opts.silent) { setLoad('overview', 'loading'); render(); }
  const res = await api.overview();
  if (!res.ok) { setLoad('overview', 'error', res.error); if (!opts.silent) render(); return null; }
  state.overview = res.data;
  setLoad('overview', 'ready');
  if (!opts.silent) render();
  return state.overview;
}

async function selectCaregiverPatient(id) {
  state.patientId = id;
  state.analysis = null;
  await refreshPatientData(id);
  if (state.cgSection === 'patients' || state.cgSection === 'add-patient') state.cgSection = 'profile';
  render();
}

function setCgSection(key) {
  const section = CG_SECTIONS.find((s) => s.key === key);
  if (section && section.needsPatient && !state.patient) {
    showToast(t('selectPatientFirst'));
    state.cgSection = state.patients.length ? 'patients' : 'add-patient';
    render();
    return;
  }
  state.cgSection = key;
  render();
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------- CHROME */
function caregiverTopBar() {
  const unread = state.notifications.filter((n) => !n.read).length;
  const cg = state.caregiver;
  const initials = cg ? cg.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '?';

  return `
  <header class="bg-ink text-white">
    <div class="max-w-7xl mx-auto px-4 sm:px-5 py-3 flex items-center justify-between gap-3 flex-wrap">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-xl" aria-hidden="true">🧵</span>
        <span class="font-serif2 text-xl tracking-wide">${APP_NAME}</span>
        <span class="text-xs bg-ochre/90 text-ink px-2 py-1 rounded-full ml-1 font-medium hidden sm:inline">${t('caregiver')}</span>
      </div>

      <div class="flex items-center gap-2 text-sm flex-wrap">
        <span data-live-indicator class="text-xs px-2.5 py-1.5 rounded-full bg-white/10 border border-white/25">
          ${typeof realtimeStatusText === 'function' ? realtimeStatusText() : ''}
        </span>

        <button onclick="toggleNotifications()" aria-label="${t('notifications')}"
          class="relative text-xs bg-white/10 hover:bg-white/20 px-3 py-2 rounded-full border border-white/30">
          🔔 <span class="hidden sm:inline">${t('notifications')}</span>
          ${unread ? `<span class="absolute -top-1 -right-1 bg-alertc text-white rounded-full text-[10px] px-1.5 font-bold">${unread}</span>` : ''}
        </button>

        <select onchange="onLanguageChange(this.value)" aria-label="${t('preferredLanguage')}"
          class="text-xs bg-white/10 border border-white/30 rounded-full px-2 py-2">
          ${LANGS.map((l) => `<option value="${l.code}" ${l.code === i18n.currentLang ? 'selected' : ''} class="text-ink">🌐 ${l.native}</option>`).join('')}
        </select>

        <button onclick="toggleProfile()" aria-label="${t('profile')}"
          class="flex items-center gap-2 bg-white/10 hover:bg-white/20 pl-1.5 pr-3 py-1.5 rounded-full border border-white/30">
          <span class="w-7 h-7 rounded-full bg-ochre text-ink text-xs font-bold flex items-center justify-center">${escapeHtml(initials)}</span>
          <span class="text-xs hidden md:inline">${cg ? escapeHtml(cg.name) : ''}</span>
        </button>

        <button onclick="logout()" class="text-xs bg-white/10 hover:bg-white/20 px-3 py-2 rounded-full border border-white/30">
          ${t('logout')}
        </button>
      </div>
    </div>
  </header>
  ${profilePanel()}`;
}

function toggleProfile() {
  state.showProfile = !state.showProfile;
  render();
}

/** The caregiver's own details — who is signed in, and their patient count. */
function profilePanel() {
  if (!state.showProfile || !state.caregiver) return '';
  const cg = state.caregiver;
  return `
  <div class="bg-[#3A322B] text-white/90">
    <div class="max-w-7xl mx-auto px-5 py-4 flex items-start justify-between gap-4 flex-wrap">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-2 text-sm">
        <div><div class="text-[11px] text-white/50">${t('fullName')}</div>${escapeHtml(cg.name)}</div>
        <div><div class="text-[11px] text-white/50">${t('username')}</div>${escapeHtml(cg.username)}</div>
        <div><div class="text-[11px] text-white/50">${t('emailOrPhone')}</div>${escapeHtml(cg.email || cg.mobile || '—')}</div>
        <div><div class="text-[11px] text-white/50">${t('relationshipWithPatient')}</div>${escapeHtml(cg.relationship || '—')}</div>
        <div><div class="text-[11px] text-white/50">${t('myPatients')}</div>${state.patients.length}</div>
        <div><div class="text-[11px] text-white/50">${t('registeredOn')}</div>${fmtDate(cg.createdAt)}</div>
      </div>
      <button onclick="toggleProfile()" class="text-xs text-white/60 hover:text-white px-2" aria-label="${t('close')}">✕</button>
    </div>
  </div>`;
}

function caregiverNav() {
  return `
  <nav class="bg-ink text-white md:w-56 shrink-0">
    <div class="flex md:flex-col gap-1 p-2 md:py-5 overflow-x-auto">
      ${CG_SECTIONS.map((s) => {
    const active = state.cgSection === s.key;
    const dim = s.needsPatient && !state.patient ? 'opacity-40' : '';
    return `<button onclick="setCgSection('${s.key}')" title="${s.label()}"
          class="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm whitespace-nowrap ${dim} ${active ? 'bg-ochre text-ink font-semibold' : 'text-white/75 hover:bg-white/10'}">
          <span class="text-base">${s.icon}</span><span class="hidden md:inline">${s.label()}</span>
        </button>`;
  }).join('')}
    </div>
  </nav>`;
}

function patientSwitcher() {
  if (!state.patients.length) return '';
  return `
  <div class="flex items-center gap-2 flex-wrap">
    <label class="text-xs text-inksoft">${t('selectPatient')}</label>
    <select onchange="selectCaregiverPatient(this.value)" class="text-sm border border-linec rounded-lg px-3 py-2 bg-white">
      ${state.patients.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === state.patientId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
    </select>
  </div>`;
}

function notificationsPanel() {
  if (!state.showNotifications) return '';
  return `
  <div class="card-textile rounded-2xl p-5 mb-5">
    <div class="flex items-center justify-between mb-3">
      <div class="font-serif2 text-lg">${t('notifications')}</div>
      <div class="flex gap-2">
        <button onclick="markAllNotificationsRead()" class="text-xs text-slateb">${t('markAllRead')}</button>
        <button onclick="toggleNotifications()" class="text-xs text-inksoft">✕</button>
      </div>
    </div>
    ${state.notifications.length === 0 ? `<div class="text-sm text-inksoft py-3">${t('noNotifications')}</div>` : `
    <div class="flex flex-col gap-2 max-h-72 overflow-y-auto">
      ${state.notifications.map((n) => `
        <div class="flex gap-3 items-start p-2.5 rounded-lg ${n.read ? 'bg-[#F9F5EB]' : 'bg-[#EDE7D8]'}">
          <span>${n.level === 'warning' ? '⚠️' : '📌'}</span>
          <div class="min-w-0">
            <div class="text-sm font-medium">${escapeHtml(n.title)}</div>
            <div class="text-xs text-inksoft">${escapeHtml(n.body)} · ${fmtDateTime(n.createdAt)}</div>
          </div>
        </div>`).join('')}
    </div>`}
  </div>`;
}

async function toggleNotifications() {
  state.showNotifications = !state.showNotifications;
  if (state.showNotifications) await loadNotifications();
  render();
}

async function markAllNotificationsRead() {
  await api.markNotificationsRead();
  await loadNotifications();
  render();
}

/* --------------------------------------------------------------- ROOT */
function renderCaregiverDashboard() {
  return `
  <div class="min-h-screen flex flex-col textile-bg">
    ${caregiverTopBar()}
    <div class="flex-1 flex flex-col md:flex-row max-w-7xl mx-auto w-full">
      ${caregiverNav()}
      <div class="flex-1 px-4 sm:px-5 md:px-8 py-6 fade-in min-w-0">
        <div class="flex items-center justify-between flex-wrap gap-3 mb-2">
          ${patientSwitcher()}
          ${RANGE_SCOPED_SECTIONS.includes(state.cgSection) ? dateRangePicker() : ''}
          <span class="text-xs px-3 py-1.5 rounded-full ${backendReachable ? 'pill-live' : 'pill-offline'}">
            ${backendReachable ? '🟢 ' + t('liveData') : '🔴 ' + t('backendUnreachableShort')}
          </span>
        </div>
        ${RANGE_SCOPED_SECTIONS.includes(state.cgSection)
    ? `<p class="text-xs text-inksoft mb-5">${dateRangeCaption()}</p>` : '<div class="mb-3"></div>'}
        ${notificationsPanel()}
        ${cgSectionBody()}
      </div>
    </div>
  </div>`;
}

function cgSectionBody() {
  switch (state.cgSection) {
    case 'overview': return sectionOverview();
    case 'patients': return sectionMyPatients();
    case 'add-patient': return sectionAddPatient();
    case 'profile': return sectionPatientProfile();
    case 'performance': return sectionPatientPerformance();
    case 'cognitive': return sectionCognitive();
    case 'schedule': return sectionSchedule();
    case 'reminders': return sectionReminders();
    case 'reports': return sectionReports();
    case 'analysis': return sectionAnalysis();
    default: return sectionMyPatients();
  }
}

function sectionTitle(title, subtitle) {
  return `<div class="mb-5">
    <h1 class="font-serif2 text-2xl text-maroonDark">${title}</h1>
    ${subtitle ? `<p class="text-sm text-inksoft mt-1">${subtitle}</p>` : ''}
  </div>`;
}

/* ---------------------------------------------------------- OVERVIEW */
/**
 * The across-all-patients row. Every figure is counted by the backend from
 * stored rows; a figure with nothing behind it arrives as null and is
 * rendered as a dash, never as a 0 that looks like a measurement.
 */
function sectionOverview() {
  const o = state.overview;
  const status = state.loadState.overview;
  const header = sectionTitle(t('overview'), t('acrossAllPatients'));

  if (status === 'error') {
    return `${header}<div class="card-textile rounded-2xl p-6">${panelState('overview', 'loadOverview()')}</div>`;
  }
  // No data yet for any reason (loading, idle, or a status that got out of
  // step with the data) shows the loading panel rather than reading a null.
  if (!o) {
    return `${header}<div class="card-textile rounded-2xl p-6">${panelState('overview')}</div>`;
  }

  const tile = (icon, label, value, sub, tone) => `
    <div class="card-textile rounded-2xl p-4">
      <div class="flex items-center gap-2 mb-1">
        <span class="text-lg" aria-hidden="true">${icon}</span>
        <span class="text-xs text-inksoft">${label}</span>
      </div>
      <div class="text-3xl font-serif2 ${tone || 'text-ink'}">${value == null ? '—' : value}</div>
      ${sub ? `<div class="text-xs text-inksoft mt-0.5">${sub}</div>` : ''}
    </div>`;

  const upcoming = upcomingAcrossPatients();

  return `
  ${header}

  <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
    ${tile('👥', t('totalPatients'), o.totalPatients, o.totalPatients === 0 ? t('addYourFirstPatient') : '')}
    ${tile('🔔', t('todaysReminders'), o.todaysReminders, `${o.pendingToday} ${t('stillPending')}`)}
    ${tile('✅', t('completedTasks'), o.completedToday, t('today'), 'text-leafgreen')}
    ${tile('⚠️', t('missedTasks'), o.missedToday, t('today'), o.missedToday > 0 ? 'text-alertc' : '')}
    ${tile('📈', t('averagePerformance'), o.averagePerformance == null ? null : o.averagePerformance + '%',
    o.patientsWithData ? `${o.patientsWithData} ${t('patientsWithActivity')}` : t('noActivityYet'))}
  </div>

  ${o.totalPatients === 0 ? `
  <div class="card-textile rounded-2xl p-8 text-center">
    <div class="text-4xl mb-3" aria-hidden="true">👋</div>
    <div class="font-serif2 text-lg mb-2">${t('emptyDashboardTitle')}</div>
    <p class="text-sm text-inksoft mb-5 max-w-md mx-auto">${t('emptyDashboardBody')}</p>
    <button onclick="setCgSection('add-patient')" class="px-5 py-3 rounded-xl bg-maroon text-white font-semibold min-h-[44px]">
      ➕ ${t('addPatient')}
    </button>
  </div>` : `
  <div class="grid lg:grid-cols-2 gap-5">
    <div class="card-textile rounded-2xl p-5">
      <div class="flex items-center justify-between mb-3">
        <h2 class="font-serif2 text-lg">🗓️ ${t('upcomingSchedule')}</h2>
        <span class="text-xs text-inksoft">${t('today')}</span>
      </div>
      ${upcoming.length === 0
    ? `<div class="text-center py-6 text-inksoft text-sm">${t('nothingLeftToday')}</div>`
    : `<ul class="list-none p-0 m-0 flex flex-col gap-2">
        ${upcoming.map((u) => `
          <li class="flex items-center gap-3 p-2.5 bg-[#F9F5EB] rounded-lg">
            <span aria-hidden="true">${escapeHtml(u.icon)}</span>
            <span class="font-semibold text-sm w-12">${escapeHtml(u.time)}</span>
            <span class="flex-1 min-w-0 truncate text-sm">${escapeHtml(u.title)}</span>
            <span class="text-xs text-inksoft truncate max-w-[90px]">${escapeHtml(u.patientName)}</span>
          </li>`).join('')}
      </ul>`}
      <button onclick="setCgSection('schedule')" class="mt-4 text-sm text-slateb font-semibold">${t('manageSchedule')} →</button>
    </div>

    <div class="card-textile rounded-2xl p-5">
      <div class="flex items-center justify-between mb-3">
        <h2 class="font-serif2 text-lg">👥 ${t('myPatients')}</h2>
        <button onclick="setCgSection('patients')" class="text-sm text-slateb font-semibold">${t('viewAll')} →</button>
      </div>
      <ul class="list-none p-0 m-0 flex flex-col gap-2">
        ${state.patients.slice(0, 6).map((p) => `
          <li class="flex items-center gap-3 p-2.5 bg-[#F9F5EB] rounded-lg">
            <span aria-hidden="true">🧓</span>
            <button onclick="openPatient('${jsAttr(p.id)}')" class="flex-1 min-w-0 text-left truncate text-sm font-medium underline-offset-2 hover:underline">
              ${escapeHtml(p.name)}
            </button>
            <span class="text-xs text-inksoft">${p.totalSessions} ${t('sessions').toLowerCase()}</span>
            <span class="text-sm font-semibold w-12 text-right">${p.overallAccuracy == null ? '—' : p.overallAccuracy + '%'}</span>
          </li>`).join('')}
      </ul>
    </div>
  </div>

  <div class="grid lg:grid-cols-2 gap-5 mt-5">
    <div class="card-textile rounded-2xl p-5">
      <h2 class="font-serif2 text-lg mb-3">🔔 ${t('todaysAdherence')}</h2>
      ${o.todaysAdherence == null
    ? `<div class="text-center py-6 text-inksoft text-sm">${t('noneDueYet')}</div>`
    : `<div class="flex items-center gap-4">
        <div class="text-4xl font-serif2 ${o.todaysAdherence >= 60 ? 'text-leafgreen' : 'text-alertc'}">${o.todaysAdherence}%</div>
        <div class="flex-1">
          <div class="h-3 rounded-full bg-[#EDE7D8] overflow-hidden">
            <div class="h-full rounded-full ${o.todaysAdherence >= 60 ? 'bg-leafgreen' : 'bg-alertc'}" style="width:${o.todaysAdherence}%"></div>
          </div>
          <div class="text-xs text-inksoft mt-1.5">
            ${o.completedToday} ${t('completed').toLowerCase()} · ${o.missedToday} ${t('missed').toLowerCase()} · ${o.snoozedToday} ${t('snoozed').toLowerCase()}
          </div>
        </div>
      </div>`}
      <button onclick="setCgSection('reminders')" class="mt-4 text-sm text-slateb font-semibold">${t('reminders')} →</button>
    </div>

    <div class="card-textile rounded-2xl p-5">
      <h2 class="font-serif2 text-lg mb-3">🧠 ${t('activityToday')}</h2>
      <div class="flex items-center gap-4">
        <div class="text-4xl font-serif2 text-maroon">${o.sessionsToday}</div>
        <div class="text-sm text-inksoft">${o.sessionsToday === 1 ? t('sessionCompletedToday') : t('sessionsCompletedToday')}</div>
      </div>
      <button onclick="setCgSection('cognitive')" class="mt-4 text-sm text-slateb font-semibold">${t('cognitiveTrends')} →</button>
    </div>
  </div>`}

  <p class="text-xs text-inksoft mt-5">${t('notDiagnosis')}</p>`;
}

/** Today's not-yet-done reminders across every linked patient. */
function upcomingAcrossPatients() {
  const rows = [];
  // state.patient holds the full record only for the selected patient, so
  // the list is built from the summary each patient card already carries.
  if (state.patient && state.patient.reminders) {
    state.patient.reminders
      .filter((r) => r.status === 'pending' || r.status === 'snoozed')
      .forEach((r) => rows.push({ ...r, patientName: state.patient.name }));
  }
  return rows.sort((a, b) => String(a.time).localeCompare(String(b.time))).slice(0, 6);
}

/* ------------------------------------------------------- MY PATIENTS */
function sectionMyPatients() {
  if (!state.patients.length) {
    return `
    ${sectionTitle(t('myPatients'), t('noPatientsYet'))}
    <div class="card-textile rounded-2xl p-8 text-center">
      <div class="text-4xl mb-3">👥</div>
      <div class="font-serif2 text-lg mb-2">${t('emptyDashboardTitle')}</div>
      <p class="text-sm text-inksoft mb-5 max-w-md mx-auto">${t('emptyDashboardBody')}</p>
      <button onclick="setCgSection('add-patient')" class="px-5 py-3 rounded-xl bg-maroon text-white font-semibold">➕ ${t('addPatient')}</button>
    </div>`;
  }
  return `
  ${sectionTitle(t('myPatients'), `${state.patients.length} ${t('patientsConnected')}`)}
  <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
    ${state.patients.map((p) => `
      <div class="card-textile rounded-2xl p-5 flex flex-col ${p.id === state.patientId ? 'ring-2 ring-ochre' : ''}">
        <div class="flex items-start justify-between gap-2 mb-2">
          <div>
            <div class="font-serif2 text-lg">${escapeHtml(p.name)}</div>
            <div class="text-xs text-inksoft">${t('patientId')}: ${escapeHtml(p.username || p.id)}</div>
          </div>
          <span class="text-2xl">🧓</span>
        </div>
        <div class="text-xs text-inksoft mb-3">
          ${t('age')} ${escapeHtml(p.age || '—')} · ${escapeHtml(p.gender || '—')} ·
          ${escapeHtml((LANGS.find((l) => l.code === p.lang) || {}).native || p.lang || '—')}
        </div>
        <div class="grid grid-cols-3 gap-2 text-center mb-3">
          <div class="bg-[#F9F5EB] rounded-lg py-2">
            <div class="text-lg font-serif2">${p.totalSessions}</div>
            <div class="text-[10px] text-inksoft">${t('sessions')}</div>
          </div>
          <div class="bg-[#F9F5EB] rounded-lg py-2">
            <div class="text-lg font-serif2">${p.overallAccuracy == null ? '—' : p.overallAccuracy + '%'}</div>
            <div class="text-[10px] text-inksoft">${t('accuracy')}</div>
          </div>
          <div class="bg-[#F9F5EB] rounded-lg py-2">
            <div class="text-lg font-serif2">${p.reminderCompletion == null ? '—' : p.reminderCompletion + '%'}</div>
            <div class="text-[10px] text-inksoft">${t('reminders')}</div>
          </div>
        </div>
        ${p.decliningDomains && p.decliningDomains.length ? `
          <div class="text-xs text-alertc mb-3">⚠️ ${t('decliningIn')}: ${p.decliningDomains.map((d) => DOMAIN_META[d] ? DOMAIN_META[d].label() : d).join(', ')}</div>` : ''}
        <div class="text-xs text-inksoft mb-4">${t('lastSession')}: ${p.lastSessionAt ? fmtDate(p.lastSessionAt) : t('never')}</div>
        <div class="mt-auto flex gap-2">
          <button onclick="openPatient('${jsAttr(p.id)}')" class="flex-1 py-2.5 rounded-xl bg-maroon text-white text-sm font-semibold">${t('openPatient')}</button>
          <button onclick="unlinkPatient('${jsAttr(p.id)}','${jsAttr(p.name)}')" title="${t('removePatient')}" class="px-3 py-2.5 rounded-xl border border-linec bg-white text-sm">✕</button>
        </div>
      </div>`).join('')}
  </div>
  <button onclick="setCgSection('add-patient')" class="mt-5 px-5 py-3 rounded-xl bg-slateb text-white font-semibold">➕ ${t('addPatient')}</button>`;
}

async function openPatient(id) {
  state.patientId = id;
  state.analysis = null;
  await refreshPatientData(id);
  state.cgSection = 'profile';
  render();
}

async function unlinkPatient(id, name) {
  if (!window.confirm(`${t('confirmRemovePatient')} ${name}?`)) return;
  const res = await api.removePatient(id);
  if (!res.ok) { showToast(res.error); return; }
  showToast(res.data.message || t('patientRemoved'));
  if (state.patientId === id) { state.patientId = null; state.patient = null; }
  await loadCaregiverPatients();
  state.cgSection = state.patients.length ? 'patients' : 'add-patient';
  render();
}

/* ------------------------------------------------------- ADD PATIENT */
function sectionAddPatient() {
  const mode = state.addPatientMode;
  return `
  ${sectionTitle(t('addPatient'), t('addPatientSubtitle'))}
  <div class="max-w-xl">
    <div class="flex gap-2 mb-5">
      <button onclick="setAddPatientMode('link')" class="flex-1 py-2.5 rounded-xl text-sm font-medium ${mode === 'link' ? 'bg-maroon text-white' : 'bg-cream text-inksoft border border-linec'}">${t('linkExistingPatient')}</button>
      <button onclick="setAddPatientMode('create')" class="flex-1 py-2.5 rounded-xl text-sm font-medium ${mode === 'create' ? 'bg-maroon text-white' : 'bg-cream text-inksoft border border-linec'}">${t('createNewPatient')}</button>
    </div>
    ${state.addPatientError ? `<div class="mb-4 rounded-xl border border-alertc bg-[#FBEAE7] text-alertc text-sm px-4 py-3">${escapeHtml(state.addPatientError)}</div>` : ''}
    <div class="card-textile rounded-2xl p-6">
      ${mode === 'link' ? linkPatientForm() : createPatientForm()}
    </div>
  </div>`;
}

function setAddPatientMode(mode) {
  state.addPatientMode = mode;
  state.addPatientError = null;
  render();
}

function linkPatientForm() {
  return `
  <form onsubmit="return submitLinkPatient(event)">
    <p class="text-sm text-inksoft mb-4">${t('linkPatientHelp')}</p>
    ${field(t('patientIdOrUsername'), `<input required id="link-identifier" class="${inputCls}" placeholder="manisha">`)}
    <button class="w-full bg-maroon text-white py-3.5 rounded-xl text-base font-medium">${t('connectPatient')}</button>
  </form>`;
}

async function submitLinkPatient(e) {
  e.preventDefault();
  const identifier = document.getElementById('link-identifier').value.trim();
  if (!identifier) { state.addPatientError = t('fillAllFields'); render(); return false; }
  const res = await api.addPatient({ mode: 'link', identifier });
  if (!res.ok) { state.addPatientError = res.error; render(); return false; }
  state.addPatientError = null;
  showToast(res.data.message);
  state.patientId = res.data.patient.id;
  await loadCaregiverPatients();
  state.cgSection = 'patients';
  render();
  return false;
}

function createPatientForm() {
  return `
  <form onsubmit="return submitCreatePatient(event)">
    <p class="text-sm text-inksoft mb-4">${t('createPatientHelp')}</p>
    ${field(t('fullName'), `<input required id="np-name" class="${inputCls}">`)}
    ${field(t('username'), `<input required id="np-username" class="${inputCls}" placeholder="rahul123">`, t('usernameHint'))}
    <div class="grid grid-cols-2 gap-3">
      ${field(t('password'), `<input required id="np-pass" type="password" class="${inputCls}">`)}
      ${field(t('confirmPassword'), `<input required id="np-pass2" type="password" class="${inputCls}">`)}
    </div>
    <div class="grid grid-cols-2 gap-3">
      ${field(t('age'), `<input required id="np-age" type="number" min="1" max="120" class="${inputCls}">`)}
      ${field(t('gender'), `<select id="np-gender" class="${inputCls}">
        <option value="Female">${t('female')}</option><option value="Male">${t('male')}</option><option value="Other">${t('other')}</option>
      </select>`)}
    </div>
    ${field(t('preferredLanguage'), `<select id="np-lang" class="${inputCls}">
      ${LANGS.map((l) => `<option value="${l.code}">${l.native}</option>`).join('')}
    </select>`)}
    ${field(t('emergencyContact'), `<input id="np-emergency" class="${inputCls}" inputmode="numeric">`, t('optional'))}
    <button class="w-full bg-maroon text-white py-3.5 rounded-xl text-base font-medium">${t('registerAndConnect')}</button>
  </form>`;
}

async function submitCreatePatient(e) {
  e.preventDefault();
  const password = document.getElementById('np-pass').value;
  const confirmPassword = document.getElementById('np-pass2').value;
  if (password !== confirmPassword) { state.addPatientError = t('passwordsDontMatch'); render(); return false; }
  const payload = {
    mode: 'create',
    name: document.getElementById('np-name').value.trim(),
    username: document.getElementById('np-username').value.trim(),
    password,
    confirmPassword,
    age: document.getElementById('np-age').value,
    gender: document.getElementById('np-gender').value,
    lang: document.getElementById('np-lang').value,
    emergencyContact: document.getElementById('np-emergency').value.trim(),
  };
  const res = await api.addPatient(payload);
  if (!res.ok) { state.addPatientError = res.error; render(); return false; }
  state.addPatientError = null;
  showToast(res.data.message);
  state.patientId = res.data.patient.id;
  await loadCaregiverPatients();
  state.cgSection = 'patients';
  render();
  return false;
}

/* --------------------------------------------------- PATIENT PROFILE */
function sectionPatientProfile() {
  const p = state.patient;
  return `
  ${sectionTitle(t('patientProfile'), escapeHtml(p.name))}
  <div class="grid lg:grid-cols-2 gap-5">
    <div class="card-textile rounded-2xl p-5">
      <div class="font-serif2 text-lg mb-4">${t('basicDetails')}</div>
      <form onsubmit="return submitPatientProfile(event)">
        ${field(t('fullName'), `<input required id="pp-name" class="${inputCls}" value="${escapeHtml(p.name)}">`)}
        <div class="grid grid-cols-2 gap-3">
          ${field(t('age'), `<input id="pp-age" type="number" min="1" max="120" class="${inputCls}" value="${escapeHtml(p.age || '')}">`)}
          ${field(t('gender'), `<select id="pp-gender" class="${inputCls}">
            ${['Female', 'Male', 'Other'].map((g) => `<option value="${g}" ${p.gender === g ? 'selected' : ''}>${t(g.toLowerCase())}</option>`).join('')}
          </select>`)}
        </div>
        ${field(t('preferredLanguage'), `<select id="pp-lang" class="${inputCls}">
          ${LANGS.map((l) => `<option value="${l.code}" ${l.code === p.lang ? 'selected' : ''}>${l.native}</option>`).join('')}
        </select>`)}
        ${field(t('emergencyContact'), `<input id="pp-emergency" class="${inputCls}" value="${escapeHtml(p.emergencyContact || '')}">`)}
        <button class="w-full bg-maroon text-white py-3 rounded-xl font-medium">${t('saveChanges')}</button>
      </form>
    </div>

    <div class="flex flex-col gap-5">
      <div class="card-textile rounded-2xl p-5">
        <div class="font-serif2 text-lg mb-3">${t('accountAndLinks')}</div>
        <div class="text-sm text-inksoft space-y-1.5">
          <div><strong class="text-ink">${t('patientId')}:</strong> ${escapeHtml(p.username || p.id)}</div>
          <div><strong class="text-ink">${t('registeredOn')}:</strong> ${fmtDate(p.createdAt)}</div>
          <div><strong class="text-ink">${t('mobileNumber')}:</strong> ${escapeHtml(p.mobile || '—')}</div>
          <div><strong class="text-ink">${t('connectedCaregivers')}:</strong>
            ${(p.caregivers || []).map((c) => escapeHtml(`${c.name} (${c.username})`)).join(', ') || '—'}</div>
        </div>
        <p class="text-xs text-inksoft mt-3">${t('passwordNeverShown')}</p>
      </div>

      <div class="card-textile rounded-2xl p-5">
        <div class="font-serif2 text-lg mb-3">${t('familyMembers')}</div>
        <div class="flex flex-wrap gap-2 mb-4">
          ${(p.family || []).map((f) => `
            <span class="inline-flex items-center gap-2 text-sm bg-[#F9F5EB] border border-linec rounded-full pl-1.5 pr-3 py-1">
              <span class="w-6 h-6 rounded-full text-white text-[10px] flex items-center justify-center" style="background:${escapeHtml(f.color)}">${escapeHtml(f.initial)}</span>
              ${escapeHtml(f.name)} · ${escapeHtml(f.relation)}
            </span>`).join('') || `<span class="text-sm text-inksoft">${t('noFamilyMembers')}</span>`}
        </div>
        <form onsubmit="return submitFamilyMember(event)" class="flex gap-2 flex-wrap">
          <input required id="fm-name" placeholder="${t('name')}" class="flex-1 min-w-[120px] border border-linec rounded-lg px-3 py-2 text-sm">
          <input required id="fm-relation" placeholder="${t('relation')}" class="flex-1 min-w-[120px] border border-linec rounded-lg px-3 py-2 text-sm">
          <button class="px-4 py-2 rounded-lg bg-slateb text-white text-sm font-semibold">${t('add')}</button>
        </form>
        <p class="text-xs text-inksoft mt-2">${t('familyMembersHelp')}</p>
      </div>
    </div>
  </div>`;
}

async function submitPatientProfile(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('pp-name').value.trim(),
    age: document.getElementById('pp-age').value,
    gender: document.getElementById('pp-gender').value,
    lang: document.getElementById('pp-lang').value,
    emergencyContact: document.getElementById('pp-emergency').value.trim(),
  };
  const res = await api.updatePatient(state.patientId, payload);
  if (!res.ok) { showToast(res.error); return false; }
  state.patient = res.data.patient;
  await loadCaregiverPatients();
  showToast(t('profileUpdated'));
  render();
  return false;
}

async function submitFamilyMember(e) {
  e.preventDefault();
  const name = document.getElementById('fm-name').value.trim();
  const relation = document.getElementById('fm-relation').value.trim();
  const res = await api.addFamilyMember(state.patientId, { name, relation });
  if (!res.ok) { showToast(res.error); return false; }
  state.patient = res.data.patient;
  showToast(t('familyMemberAdded'));
  render();
  return false;
}

/* ---------------------------------------------- PATIENT PERFORMANCE */
function kpiCard(label, value, sub) {
  return `
  <div class="card-textile rounded-2xl p-4">
    <div class="text-xs text-inksoft mb-1">${label}</div>
    <div class="text-2xl font-serif2 text-ink">${value}</div>
    ${sub ? `<div class="text-xs text-inksoft mt-0.5">${sub}</div>` : ''}
  </div>`;
}

function sectionPatientPerformance() {
  const p = state.patient;
  const stats = statsFor(p);
  const sessionRows = stats.all.slice().reverse().slice(0, 12).map((s) => `
    <tr class="border-b border-linec last:border-0">
      <td class="py-2 pr-3 text-sm">${escapeHtml(s.date || '')} ${escapeHtml(s.time || '')}</td>
      <td class="py-2 pr-3 text-sm"><span class="inline-block w-2 h-2 rounded-full mr-1.5" style="background:${DOMAIN_META[s.domain] ? DOMAIN_META[s.domain].color : '#888'}"></span>${DOMAIN_META[s.domain] ? DOMAIN_META[s.domain].label() : escapeHtml(s.domain)}</td>
      <td class="py-2 pr-3 text-sm">${escapeHtml(s.gameType || '—')}</td>
      <td class="py-2 pr-3 text-sm font-semibold">${Math.round(s.accuracy * 100)}%</td>
      <td class="py-2 pr-3 text-sm text-inksoft">${(s.avgTimeMs / 1000).toFixed(1)}s</td>
      <td class="py-2 text-sm text-inksoft">L${s.level || '—'}</td>
    </tr>`).join('');

  return `
  ${sectionTitle(t('patientPerformance'), escapeHtml(p.name))}
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
    ${kpiCard(t('totalSessions'), stats.totalSessions, t('acrossThreeDomains'))}
    ${kpiCard(t('overallAccuracy'), stats.overallAccuracy === null ? '—' : stats.overallAccuracy + '%', t('weightedAverage'))}
    ${kpiCard(t('avgResponseTime'), stats.avgResponseTime + 's', t('perQuestion'))}
    ${kpiCard(t('reminderCompletion'), stats.remCompletion == null ? '—' : stats.remCompletion + '%', t('adherenceSub'))}
  </div>

  ${stats.flags.length ? `
  <div class="flex gap-3 items-start bg-[#FBEAE7] border border-alertc rounded-xl p-4 mb-3">
    <span class="text-xl">⚠️</span>
    <div>
      <div class="font-bold text-alertc mb-0.5">${t('performanceObservation')}</div>
      <div class="text-sm">${stats.flags.map((d) => DOMAIN_META[d].label()).join(', ')} — ${t('declineMessage')}</div>
    </div>
  </div>` : ''}
  ${stats.improving.length ? `
  <div class="flex gap-3 items-start bg-[#E7F1E5] border border-leafgreen rounded-xl p-4 mb-4">
    <span class="text-xl">✓</span>
    <div class="text-sm">${stats.improving.map((d) => DOMAIN_META[d].label()).join(', ')} — ${t('improvingMessage')}</div>
  </div>` : ''}
  <p class="text-xs text-inksoft mb-6">${t('notDiagnosis')}</p>

  <div class="grid lg:grid-cols-3 gap-4 mb-6">
    ${Object.keys(DOMAIN_META).map((d) => {
    const m = (p.metrics || []).find((x) => x.domain === d) || {};
    const trend = m.trend || 'none';
    const badge = trend === 'improving' ? 'bg-leafgreen text-white' : trend === 'declining' ? 'bg-alertc text-white' : 'bg-[#EDE7D8] text-inksoft';
    return `
      <div class="card-textile rounded-2xl p-4">
        <div class="flex items-center justify-between mb-2">
          <span class="font-serif2 text-base">${DOMAIN_META[d].label()}</span>
          <span class="text-[10px] px-2 py-1 rounded-full ${badge}">${t('trend_' + trend) || trend}</span>
        </div>
        <div class="text-sm text-inksoft">${t('sessions')}: <strong class="text-ink">${m.sessions_count || 0}</strong></div>
        <div class="text-sm text-inksoft">${t('average')}: <strong class="text-ink">${m.avg_accuracy == null ? '—' : Math.round(m.avg_accuracy * 100) + '%'}</strong></div>
        <div class="text-sm text-inksoft">${t('best')}: <strong class="text-ink">${m.best_accuracy == null ? '—' : Math.round(m.best_accuracy * 100) + '%'}</strong></div>
      </div>`;
  }).join('')}
  </div>

  <div class="card-textile rounded-2xl p-5">
    <div class="font-serif2 text-lg mb-3">${t('recentSessions')}</div>
    ${stats.all.length === 0 ? `<div class="text-sm text-inksoft text-center py-8">${t('noSessionsYet')}</div>` : `
    <div class="overflow-x-auto">
      <table class="w-full min-w-[560px]">
        <thead><tr class="text-left text-xs text-inksoft border-b border-linec">
          <th class="pb-2 font-medium">${t('time')}</th><th class="pb-2 font-medium">${t('domain')}</th>
          <th class="pb-2 font-medium">${t('game')}</th><th class="pb-2 font-medium">${t('accuracy')}</th>
          <th class="pb-2 font-medium">${t('avgTime')}</th><th class="pb-2 font-medium">${t('level')}</th>
        </tr></thead>
        <tbody>${sessionRows}</tbody>
      </table>
    </div>`}
  </div>`;
}

/* ------------------------------------------- COGNITIVE PERFORMANCE */
function sectionCognitive() {
  return `
  ${sectionTitle(t('cognitivePerformance'), escapeHtml(state.patient.name))}
  <div class="grid lg:grid-cols-3 gap-5 mb-5">
    <div class="lg:col-span-2 card-textile rounded-2xl p-5">
      <div class="font-serif2 text-lg mb-3">${t('cognitivePerformanceOverTime')}</div>
      <div class="h-64 relative">
        <canvas id="trendChart"></canvas>
      </div>
    </div>
    <div class="card-textile rounded-2xl p-5">
      <div class="font-serif2 text-lg mb-3">${t('averageByDomain')}</div>
      <div class="h-64"><canvas id="compareChart"></canvas></div>
    </div>
  </div>
  <div class="grid lg:grid-cols-2 gap-5">
    <div class="card-textile rounded-2xl p-5">
      <div class="font-serif2 text-lg mb-3">${t('averageResponseTimeOverSessions')}</div>
      <div class="h-56"><canvas id="respChart"></canvas></div>
    </div>
    <div class="card-textile rounded-2xl p-5">
      <div class="font-serif2 text-lg mb-3">${t('reminderAdherence')}</div>
      <div class="h-56"><canvas id="adherenceChart"></canvas></div>
    </div>
  </div>
  <p class="text-xs text-inksoft mt-4">${t('notDiagnosis')}</p>`;
}

/* Schedule and Reminders sections live in dashboard-schedule.js (Part 2). */

/* Reports live in dashboard-reports.js and AI Insights in
 * dashboard-analysis.js (Part 3) — one module per concern. */
