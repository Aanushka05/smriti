/* app.js — SmritiSaathi Care
 * Shared state, the single authenticated API client, the voice service,
 * session handling and the router/route-guard.
 *
 * Every other file (auth.js, games.js, dashboard.js, charts.js, chat.js)
 * relies on the globals defined here: state, api, apiFetch, goto,
 * showToast, t(), i18n, voiceService, LANGS, wovenStrip().
 */

const SESSION_KEY = 'smritisaathi_session_v2';

const LANGS = [
  { code: 'en-IN', name: 'English', native: 'English' },
  { code: 'hi-IN', name: 'Hindi', native: 'हिन्दी' },
  { code: 'as-IN', name: 'Assamese', native: 'অসমীয়া' },
  { code: 'bn-IN', name: 'Bengali', native: 'বাংলা' },
  { code: 'mni-IN', name: 'Manipuri', native: 'মৈতৈলোন্' },
  { code: 'brx-IN', name: 'Bodo', native: 'बड़ो' },
  { code: 'ne-IN', name: 'Nepali', native: 'नेपाली' },
  { code: 'mr-IN', name: 'Marathi', native: 'मराठी' },
  { code: 'gu-IN', name: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'kn-IN', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ml-IN', name: 'Malayalam', native: 'മലയാളം' },
  { code: 'or-IN', name: 'Odia', native: 'ଓଡ଼ିଆ' },
  { code: 'pa-IN', name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'ta-IN', name: 'Tamil', native: 'தமிழ்' },
  { code: 'te-IN', name: 'Telugu', native: 'తెలుగు' },
  { code: 'ur-IN', name: 'Urdu', native: 'اردو' },
];

/* ---------------------------------------------------------------------
   APP STATE
--------------------------------------------------------------------- */
const state = {
  booted: false,
  screen: 'loading',
  role: null,             // 'patient' | 'caregiver'
  token: null,
  authRole: null,         // which role the auth screen is showing
  authMode: 'login',      // 'login' | 'register'
  authError: null,
  authBusy: false,
  patientId: null,
  patient: null,          // full patient record (sessions, reminders, …)
  caregiver: null,
  patients: [],           // caregiver's linked patients (summaries)
  cgSection: 'overview',  // caregiver dashboard section
  addPatientMode: 'link', // 'link' | 'create'
  addPatientError: null,

  // Part 4 — overview, reports and the one shared date range.
  overview: null,
  showProfile: false,
  dateRange: null,          // set by initDateRange() at boot
  reportPatientId: null,
  reportPeriod: null,
  downloadBusy: null,       // 'pdf' | 'csv' | 'html' while a file is fetching

  // Part 2 — schedules, reminders, and the load state of each panel.
  // 'idle' | 'loading' | 'ready' | 'error' drives the loading / empty /
  // error states every dynamic panel is required to have.
  nextReminder: null,
  upcoming: null,
  scheduleForm: null,      // null = closed, {} = add, {id,…} = edit
  scheduleError: null,
  scheduleBusy: false,
  patientSection: 'home',  // patient dashboard section
  loadState: { patients: 'idle', patient: 'idle', upcoming: 'idle', analysis: 'idle', report: 'idle', overview: 'idle' },
  loadError: { patients: null, patient: null, upcoming: null, analysis: null, report: null, overview: null },
  voiceListening: false,
  lastVoiceTranscript: null,
  analysis: null,
  analysisBusy: false,
  report: null,
  reportBusy: false,
  notifications: [],
  showNotifications: false,
  levels: { memory: 1, attention: 1, pattern: 1 },
  game: null,
  listeningFor: null,
  chatOpen: false,
  chatHistory: [],
  chatBusy: false,
};

let backendReachable = null;

/* ---------------------------------------------------------------------
   SESSION — only a token + role are persisted. Everything else is
   re-fetched from the backend on load, so the browser can never hold a
   "logged in" state the server does not agree with.
--------------------------------------------------------------------- */
function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch (e) { return null; }
}
function setSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* private mode */ }
  state.token = session.token;
  state.role = session.role;
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  state.token = null;
  state.role = null;
}
function isLoggedIn() { return !!state.token && !!state.role; }

/* ---------------------------------------------------------------------
   API CLIENT — one place that knows about URLs, auth headers, JSON
   parsing and error shapes. Never throws a raw fetch error at the UI.
--------------------------------------------------------------------- */
async function resolveApiBase() {
  for (const base of API_CANDIDATES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`${base}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      // A 200 is not enough: a static server with SPA fallback answers
      // /api/health with index.html. Only accept a candidate that returns
      // this app's own health payload.
      const body = await res.json().catch(() => null);
      if (!body || body.ok !== true || body.app !== APP_NAME) continue;
      API_BASE_URL = base;
      backendReachable = true;
      return { ok: true, base, health: body };
    } catch (e) { /* try the next candidate */ }
  }
  backendReachable = false;
  return { ok: false };
}

/**
 * apiFetch — the only function in the frontend that calls fetch() against
 * the backend. Returns { ok, status, data, error } and never rejects.
 * A 401 clears the session and sends the user back to the login screen.
 */
async function apiFetch(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
  }
  if (state.token && options.auth !== false) opts.headers.Authorization = `Bearer ${state.token}`;

  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, opts);
  } catch (err) {
    backendReachable = false;
    return { ok: false, status: 0, data: null, error: t('backendUnreachable'), offline: true };
  }
  backendReachable = true;

  let data = null;
  const text = await res.text().catch(() => '');
  if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

  if (res.status === 401 && options.auth !== false) {
    handleSessionExpired((data && data.error) || t('sessionExpired'));
    return { ok: false, status: 401, data, error: (data && data.error) || t('sessionExpired') };
  }
  if (!res.ok) {
    return {
      ok: false, status: res.status, data,
      error: (data && data.error) || `${t('requestFailed')} (${res.status})`,
      field: data && data.field,
    };
  }
  return { ok: true, status: res.status, data };
}

function handleSessionExpired(message) {
  if (!isLoggedIn()) return;
  if (typeof stopRealtime === 'function') stopRealtime();
  clearSession();
  resetUserState();
  showToast(message || t('sessionExpired'));
  state.screen = 'auth';
  render();
}

function resetUserState() {
  state.patient = null; state.patientId = null; state.patients = [];
  state.caregiver = null; state.analysis = null; state.notifications = [];
  state.chatHistory = []; state.chatOpen = false; state.game = null;
  state.cgSection = 'overview';
  state.overview = null; state.report = null; state.reportPatientId = null; state.showProfile = false;
  state.nextReminder = null; state.upcoming = null; state.scheduleForm = null;

  // Clearing the data MUST also clear the load flags. Leaving one on
  // 'ready' while its data is null is what makes a panel render a null —
  // the states and the data they describe always reset together.
  Object.keys(state.loadState).forEach((key) => {
    state.loadState[key] = 'idle';
    state.loadError[key] = null;
  });
}

/* Thin, named wrappers so screens read clearly. */
const api = {
  registerPatient: (payload) => apiFetch('/auth/register/patient', { method: 'POST', body: payload, auth: false }),
  registerCaregiver: (payload) => apiFetch('/auth/register/caregiver', { method: 'POST', body: payload, auth: false }),
  login: (username, password) => apiFetch('/auth/login', { method: 'POST', body: { username, password }, auth: false }),
  me: () => apiFetch('/auth/me'),

  // The date range travels with the patient fetch, which is what makes one
  // picker drive the charts, KPIs and session list together.
  getPatient: (patientId, range) => {
    const q = range && Number.isFinite(range.from)
      ? `?from=${range.from}&to=${range.to}` : '';
    return apiFetch(`/patients/${encodeURIComponent(patientId)}${q}`);
  },
  overview: () => apiFetch('/caregiver/overview'),
  updatePatient: (patientId, payload) => apiFetch(`/patients/${encodeURIComponent(patientId)}`, { method: 'PUT', body: payload }),
  myPatients: () => apiFetch('/caregiver/patients'),
  addPatient: (payload) => apiFetch('/caregiver/patients', { method: 'POST', body: payload }),
  removePatient: (patientId) => apiFetch(`/caregiver/patients/${encodeURIComponent(patientId)}`, { method: 'DELETE' }),
  addFamilyMember: (patientId, payload) => apiFetch(`/patients/${encodeURIComponent(patientId)}/family`, { method: 'POST', body: payload }),

  saveGameResult: (result) => apiFetch('/game-results', { method: 'POST', body: result }),

  // ---- schedules (the caregiver's plan) ----
  schedules: (patientId) => apiFetch(`/patients/${encodeURIComponent(patientId)}/schedules`),
  addSchedule: (patientId, payload) => apiFetch(`/patients/${encodeURIComponent(patientId)}/schedules`, { method: 'POST', body: payload }),
  updateSchedule: (scheduleId, payload) => apiFetch(`/schedules/${encodeURIComponent(scheduleId)}`, { method: 'PUT', body: payload }),
  deleteSchedule: (scheduleId) => apiFetch(`/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' }),
  upcoming: (patientId, days) => apiFetch(`/patients/${encodeURIComponent(patientId)}/schedules/upcoming?days=${days || 7}`),

  // ---- reminders (one dated occurrence of a schedule) ----
  reminders: (patientId, date) => apiFetch(`/patients/${encodeURIComponent(patientId)}/reminders${date ? `?date=${date}` : ''}`),
  nextReminder: (patientId) => apiFetch(`/patients/${encodeURIComponent(patientId)}/reminders/next`),
  addReminder: (patientId, payload) => apiFetch(`/patients/${encodeURIComponent(patientId)}/reminders`, { method: 'POST', body: payload }),
  completeReminder: (reminderId) => apiFetch(`/reminders/${encodeURIComponent(reminderId)}/complete`, { method: 'POST' }),
  missReminder: (reminderId) => apiFetch(`/reminders/${encodeURIComponent(reminderId)}/miss`, { method: 'POST' }),
  snoozeReminder: (reminderId, minutes) => apiFetch(`/reminders/${encodeURIComponent(reminderId)}/snooze`, { method: 'POST', body: { minutes: minutes || 15 } }),
  updateReminder: (reminderId, status) => apiFetch(`/reminders/${encodeURIComponent(reminderId)}`, { method: 'PUT', body: { status } }),
  deleteReminder: (reminderId) => apiFetch(`/reminders/${encodeURIComponent(reminderId)}`, { method: 'DELETE' }),
  adherence: (patientId) => apiFetch(`/patients/${encodeURIComponent(patientId)}/adherence`),

  report: (patientId, period) => {
    let q = `period=${encodeURIComponent(period || 'weekly')}`;
    // A custom dashboard range overrides the named period, so the report
    // matches exactly what the caregiver is looking at.
    if (state.dateRange && state.dateRange.key === 'custom') {
      q += `&from=${state.dateRange.from}&to=${state.dateRange.to}`;
    }
    return apiFetch(`/patients/${encodeURIComponent(patientId)}/report?${q}`);
  },
  reportPeriods: () => apiFetch('/report/periods'),

  // Two analysis calls on purpose: the GET recomputes from stored data and
  // is free, so live updates use it; the POST additionally asks the AI for
  // a written-up version, so it is only fired when the caregiver asks.
  analysisSnapshot: (patientId, days) => apiFetch(`/patients/${encodeURIComponent(patientId)}/analysis?days=${days || 0}`),
  analysis: (patientId, days) => apiFetch(`/patients/${encodeURIComponent(patientId)}/analysis`, { method: 'POST', body: { days: days || 0 } }),
  notifications: () => apiFetch('/notifications'),
  markNotificationsRead: () => apiFetch('/notifications/read-all', { method: 'PUT' }),
};

/** Always call this after a mutation, then render() — never trust a stale copy. */
async function refreshPatientData(patientId) {
  if (!patientId) return null;
  setLoad('patient', 'loading');
  const res = await api.getPatient(patientId, state.dateRange);
  if (res.ok && res.data) {
    state.patient = res.data;
    state.patientId = res.data.id;
    state.levels = computeLevels(res.data.sessions || []);
    setLoad('patient', 'ready');
  } else {
    setLoad('patient', 'error', res.error);
  }
  return state.patient;
}

/** The reminder coming up next, shown large on the patient dashboard. */
async function loadNextReminder() {
  if (!state.patientId) return null;
  const res = await api.nextReminder(state.patientId);
  state.nextReminder = res.ok && res.data ? res.data.next : null;
  return state.nextReminder;
}

/* ---------------------------------------------------------------------
   LOAD STATE — every dynamic panel reports idle/loading/ready/error so it
   can render a spinner, the data, an empty state, or a retry button
   instead of silently showing nothing.
--------------------------------------------------------------------- */
function setLoad(key, status, error) {
  state.loadState[key] = status;
  state.loadError[key] = status === 'error' ? (error || t('genericLoadError')) : null;
}

/** Standard markup for a panel that is loading or has failed. */
function panelState(key, retryFn, emptyMessage) {
  const status = state.loadState[key];
  if (status === 'loading' || (status === 'idle' && !emptyMessage)) {
    return `<div class="flex items-center justify-center gap-3 py-10 text-inksoft" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span><span>${t('loading')}</span>
    </div>`;
  }
  if (status === 'error') {
    return `<div class="rounded-xl border border-alertc bg-[#FBEAE7] p-4 text-sm" role="alert">
      <div class="font-semibold text-alertc mb-1">${t('couldNotLoad')}</div>
      <div class="text-inksoft mb-3">${escapeHtml(state.loadError[key] || '')}</div>
      ${retryFn ? `<button onclick="${retryFn}" class="px-4 py-2 rounded-lg bg-maroon text-white text-sm font-semibold">${t('tryAgain')}</button>` : ''}
    </div>`;
  }
  if (emptyMessage) {
    return `<div class="text-center py-8 text-inksoft text-sm">${emptyMessage}</div>`;
  }
  return '';
}

/**
 * Downloads a report through fetch (so the Authorization header is sent)
 * and hands the browser a blob. A plain <a href> could not carry the token.
 */
async function downloadReport(patientId, format, days) {
  const url = `${API_BASE_URL}/patients/${encodeURIComponent(patientId)}/report/download?format=${format}&days=${days || 0}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) {
      if (res.status === 401) { handleSessionExpired(); return; }
      showToast(t('reportFailed'));
      return;
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = match ? match[1] : `SmritiSaathi_Care_Report.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    showToast(t('reportDownloaded'));
  } catch (err) {
    showToast(t('reportFailed'));
  }
}

/* ---------------------------------------------------------------------
   VOICE SERVICE — driven entirely by the currently selected language code.
--------------------------------------------------------------------- */
const voiceService = {
  speak(text, langCode) {
    try {
      if (!window.speechSynthesis) { showToast(t('voiceNotSupported')); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = langCode || i18n.currentLang; u.rate = 0.9;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { showToast(t('voiceNotSupported')); }
  },
  listen(langCode, onResult, onError) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showToast(t('voiceNotSupported')); if (onError) onError('unsupported'); return null; }
    const rec = new SR();
    rec.lang = langCode || i18n.currentLang; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => onResult(e.results[0][0].transcript);
    rec.onerror = (e) => { if (onError) onError(e.error); };
    try { rec.start(); } catch (e) { if (onError) onError('start-failed'); }
    return rec;
  },
};

/* ---------------------------------------------------------------------
   SMALL HELPERS
--------------------------------------------------------------------- */
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

function nextLevel(level, accuracy) {
  if (accuracy >= 0.8) return Math.min(5, level + 1);
  if (accuracy < 0.5) return Math.max(1, level - 1);
  return level;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** For values interpolated inside a single-quoted inline handler. */
function jsAttr(value) { return escapeHtml(String(value == null ? '' : value)).replace(/\\/g, '\\\\'); }

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function wovenStrip(h) { return `<div class="woven" style="height:${h || 8}px"></div>`; }

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/* ---------------------------------------------------------------------
   ROUTING + ROUTE GUARDS
   Protected screens are listed with the role that may open them. Trying to
   reach one without a session sends the user to the login screen instead.
--------------------------------------------------------------------- */
const ROUTE_ROLES = {
  'patient-home': 'patient',
  'game-familyfaces': 'patient',
  'game-memorymatch': 'patient',
  'game-sequence': 'patient',
  'game-wordrecall': 'patient',
  'game-oddone': 'patient',
  'game-weaving': 'patient',
  'game-orientation': 'patient',
  'caregiver-dashboard': 'caregiver',
};

function goto(screen) {
  const required = ROUTE_ROLES[screen];
  if (required && !isLoggedIn()) {
    showToast(t('pleaseLoginFirst'));
    state.screen = 'auth';
    state.authRole = required;
    state.authMode = 'login';
    render();
    return;
  }
  if (required && state.role !== required) {
    showToast(t('wrongRoleForPage'));
    state.screen = state.role === 'caregiver' ? 'caregiver-dashboard' : 'patient-home';
    render();
    return;
  }
  state.screen = screen;
  render();
  window.scrollTo(0, 0);
}

function homeScreenForRole() {
  return state.role === 'caregiver' ? 'caregiver-dashboard' : 'patient-home';
}

/* Language change: warm the Bhashini cache, refresh voice locale, re-render. */
async function onLanguageChange(langCode, opts = {}) {
  showToast(t('switchingLanguage'));
  await i18n.setLanguage(langCode);
  if (opts.patient && state.patient) {
    state.patient.lang = langCode;
    await api.updatePatient(state.patient.id, { lang: langCode });
  }
  render();
}
i18n.onChange = () => { /* callers re-render explicitly after awaiting setLanguage */ };

/* ---------------------------------------------------------------------
   MAIN RENDER DISPATCH
--------------------------------------------------------------------- */
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  let html = '';
  switch (state.screen) {
    case 'loading': html = renderLoading(); break;
    case 'role-select': html = renderRoleSelect(); break;
    case 'auth': html = renderAuth(); break;
    case 'patient-home': html = renderPatientHome(); break;
    case 'game-familyfaces': html = renderFamilyFaces(); break;
    case 'game-memorymatch': html = renderMemoryMatch(); break;
    case 'game-sequence': html = renderSequence(); break;
    case 'game-wordrecall': html = renderWordRecall(); break;
    case 'game-oddone': html = renderOddOne(); break;
    case 'game-weaving': html = renderWeaving(); break;
    case 'game-orientation': html = renderOrientation(); break;
    case 'caregiver-dashboard': html = renderCaregiverDashboard(); break;
    default: html = renderRoleSelect();
  }
  // Replacing innerHTML throws every canvas away. Destroy the Chart
  // instances bound to them FIRST, or Chart.js keeps them alive and the
  // next draw hits "Canvas is already in use".
  if (typeof destroyAllCharts === 'function') destroyAllCharts();

  app.innerHTML = html;

  // These live in later-loaded scripts; guard so the very first render
  // (the loading screen) can never throw a ReferenceError.
  if (state.screen === 'caregiver-dashboard' && typeof drawCharts === 'function') drawCharts();
  if (typeof renderChatWidget === 'function') renderChatWidget();
  document.title = state.role
    ? `${APP_NAME} — ${state.role === 'caregiver' ? t('caregiverDashboard') : t('patientDashboard')}`
    : APP_NAME;
}

function renderLoading() {
  return `
  <div class="min-h-screen textile-bg flex items-center justify-center">
    <div class="text-center fade-in">
      <div class="text-4xl mb-3">🧶</div>
      <div class="font-serif2 text-2xl text-maroon">${APP_NAME}</div>
      <div class="text-sm text-inksoft mt-2">${t('startingUp')}</div>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------------
   BOOT — probe the backend, then restore an existing session (which also
   proves the token is still valid) before showing anything.
--------------------------------------------------------------------- */
async function restoreSession() {
  const saved = getSession();
  if (!saved || !saved.token) return false;
  state.token = saved.token;
  state.role = saved.role;

  const res = await api.me();
  if (!res.ok) {
    clearSession();
    resetUserState();
    return false;
  }
  const data = res.data;
  state.role = data.role;
  if (data.role === 'patient') {
    state.patient = data.patient;
    state.patientId = data.patient.id;
    await refreshPatientData(data.patient.id);
    await loadNextReminder();
    await i18n.setLanguage(state.patient.lang || 'en-IN');
    state.screen = 'patient-home';
  } else {
    state.caregiver = data.caregiver;
    await loadCaregiverPatients();
    await i18n.setLanguage(state.caregiver.lang || 'en-IN');
    state.screen = 'caregiver-dashboard';
  }
  startRealtime();
  return true;
}

async function init() {
  initDateRange();   // one shared filter, restored from the last visit
  render();          // loading screen
  const health = await resolveApiBase();
  if (health.ok) {
    const restored = await restoreSession();
    if (!restored) state.screen = 'role-select';
  } else {
    // No server: the user cannot be signed in, and pretending otherwise is
    // exactly what made "registered accounts don't work" happen before.
    clearSession();
    resetUserState();
    state.screen = 'role-select';
  }
  state.booted = true;
  render();
}

// Wait for every script in index.html to be parsed before the first render,
// so screen renderers defined in auth.js / games.js / dashboard.js exist.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
