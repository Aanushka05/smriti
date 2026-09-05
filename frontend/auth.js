/* auth.js — SmritiSaathi Care
 * Role selection plus real login/registration for BOTH roles on the same
 * website. Credentials are username + password chosen by the user
 * (e.g. rahul123 / rahul@123); the backend hashes them with bcrypt and the
 * same credentials work on every later login.
 */

const inputCls = 'w-full border border-linec rounded-xl px-4 py-3 text-base bg-white focus-visible:outline-none';

function langPickerHTML(id, selected) {
  return `
  <select id="${id}" onchange="onLanguageChange(this.value)" aria-label="Language"
    class="border border-linec rounded-xl px-3 py-2 bg-panel text-sm">
    ${LANGS.map((l) => `<option value="${l.code}" ${l.code === selected ? 'selected' : ''}>${l.native}</option>`).join('')}
  </select>`;
}

function connectionPill() {
  return `<p class="text-xs text-center mt-2 ${backendReachable ? 'text-leafgreen' : 'text-alertc'}">
    ${backendReachable ? '🟢 ' + t('connectedToServer') : '🔴 ' + t('backendUnreachableShort')}
  </p>`;
}

/* ------------------------------------------------------------ LANDING */
function renderRoleSelect() {
  return `
  <div class="min-h-screen textile-bg">
    <div class="diamond-border"></div>
    <div class="max-w-2xl mx-auto pt-14 px-5 pb-12 fade-in">
      <div class="flex justify-end mb-4">${langPickerHTML('lang-role-select', i18n.currentLang)}</div>
      <div class="text-center mb-10">
        <div class="text-4xl mb-2">🧶</div>
        <h1 class="font-serif2 text-3xl text-maroon mb-1">${APP_NAME}</h1>
        <p class="text-inksoft">${t('tagline')}</p>
      </div>
      <div class="grid sm:grid-cols-2 gap-5">
        <button onclick="selectRole('patient')" class="card-textile rounded-2xl p-8 text-left hover:shadow-lg transition">
          <div class="text-4xl mb-3">🧓</div>
          <div class="font-serif2 text-xl mb-1">${t('patient')}</div>
          <div class="text-sm text-inksoft">${t('login')} / ${t('register')}</div>
        </button>
        <button onclick="selectRole('caregiver')" class="card-textile rounded-2xl p-8 text-left hover:shadow-lg transition">
          <div class="text-4xl mb-3">🤝</div>
          <div class="font-serif2 text-xl mb-1">${t('caregiver')}</div>
          <div class="text-sm text-inksoft">${t('login')} / ${t('register')}</div>
        </button>
      </div>
      <p class="text-xs text-inksoft text-center mt-8">${t('notDiagnosis')}</p>
      ${connectionPill()}
      ${backendReachable ? '' : `
      <div class="card-textile rounded-2xl p-4 mt-4 text-sm">
        <div class="font-semibold text-alertc mb-1">${t('backendUnreachableShort')}</div>
        <p class="text-inksoft mb-3">${t('backendStartHint')}</p>
        <button onclick="retryBackend()" class="px-4 py-2 rounded-xl bg-maroon text-white text-sm font-semibold">${t('retryConnection')}</button>
      </div>`}
    </div>
  </div>`;
}

async function retryBackend() {
  showToast(t('checkingServer'));
  const health = await resolveApiBase();
  if (health.ok) {
    const restored = await restoreSession();
    if (!restored) state.screen = 'role-select';
    showToast(t('connectedToServer'));
  } else {
    showToast(t('backendUnreachable'));
  }
  render();
}

function selectRole(role) {
  state.authRole = role;
  state.authMode = 'login';
  state.authError = null;
  goto('auth');
}

function setAuthMode(mode) {
  state.authMode = mode;
  state.authError = null;
  render();
}

/* --------------------------------------------------------------- AUTH */
function renderAuth() {
  const role = state.authRole || 'patient';
  const mode = state.authMode;
  return `
  <div class="min-h-screen textile-bg pb-12">
    <div class="diamond-border"></div>
    <div class="max-w-md mx-auto pt-10 px-5 fade-in">
      <button onclick="goto('role-select')" class="text-sm text-inksoft mb-4">← ${t('back')}</button>
      <div class="text-center mb-4">
        <div class="font-serif2 text-2xl text-maroon">${APP_NAME}</div>
      </div>
      <div class="card-textile rounded-2xl p-6">
        <div class="flex items-center justify-between mb-5 gap-2">
          <h2 class="font-serif2 text-2xl">${role === 'patient' ? t('patient') : t('caregiver')}</h2>
          ${langPickerHTML('lang-auth', i18n.currentLang)}
        </div>
        <div class="flex gap-2 mb-6">
          <button onclick="setAuthMode('login')" class="flex-1 py-2.5 rounded-xl text-sm font-medium ${mode === 'login' ? 'bg-maroon text-white' : 'bg-cream text-inksoft'}">${t('login')}</button>
          <button onclick="setAuthMode('register')" class="flex-1 py-2.5 rounded-xl text-sm font-medium ${mode === 'register' ? 'bg-maroon text-white' : 'bg-cream text-inksoft'}">${t('register')}</button>
        </div>
        ${state.authError ? `<div class="mb-4 rounded-xl border border-alertc bg-[#FBEAE7] text-alertc text-sm px-4 py-3">${escapeHtml(state.authError)}</div>` : ''}
        ${mode === 'login' ? loginForm(role) : (role === 'patient' ? patientRegisterForm() : caregiverRegisterForm())}
      </div>
      ${connectionPill()}
    </div>
  </div>`;
}

function field(label, inputHtml, hint) {
  return `<div class="mb-4">
    <label class="block text-sm font-medium mb-1.5">${label}</label>
    ${inputHtml}
    ${hint ? `<div class="text-xs text-inksoft mt-1">${hint}</div>` : ''}
  </div>`;
}

/* -------------------------------------------------------------- LOGIN */
function loginForm(role) {
  const btnColor = role === 'patient' ? 'bg-maroon' : 'bg-slateb';
  return `
  <form onsubmit="return submitLogin(event)">
    ${field(t('username'), `<input required id="login-username" autocomplete="username" class="${inputCls}" placeholder="rahul123">`)}
    ${field(t('password'), `<input required id="login-password" type="password" autocomplete="current-password" class="${inputCls}" placeholder="••••••••">`)}
    <button ${state.authBusy ? 'disabled' : ''} class="w-full ${btnColor} text-white py-3.5 rounded-xl text-base font-medium mt-2 disabled:opacity-60">
      ${state.authBusy ? t('pleaseWait') : t('loginBtn')}
    </button>
    <button type="button" onclick="setAuthMode('register')" class="w-full text-sm text-slateb mt-3">${t('newHereRegister')}</button>
    <button type="button" onclick="showToast(t('forgotPasswordHelp'))" class="w-full text-xs text-inksoft mt-2">${t('forgotPassword')}</button>
    <p class="text-xs text-inksoft mt-4 text-center">${t('demoAccounts')}</p>
  </form>`;
}

async function submitLogin(e) {
  e.preventDefault();
  if (state.authBusy) return false;
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) { state.authError = t('fillAllFields'); render(); return false; }

  state.authBusy = true; state.authError = null; render();
  const res = await api.login(username, password);
  state.authBusy = false;

  if (!res.ok) { state.authError = res.error; render(); return false; }
  await afterAuth(res.data, t('loginSuccess'));
  return false;
}

/* --------------------------------------------------- REGISTER: PATIENT */
function patientRegisterForm() {
  return `
  <form onsubmit="return submitPatientRegister(event)">
    ${field(t('fullName'), `<input required id="pr-name" class="${inputCls}" placeholder="Rahul Sharma">`)}
    ${field(t('username'), `<input required id="pr-username" autocomplete="username" class="${inputCls}" placeholder="rahul123">`, t('usernameHint'))}
    <div class="grid grid-cols-2 gap-3">
      ${field(t('password'), `<input required id="pr-pass" type="password" autocomplete="new-password" class="${inputCls}">`)}
      ${field(t('confirmPassword'), `<input required id="pr-pass2" type="password" autocomplete="new-password" class="${inputCls}">`)}
    </div>
    <div class="grid grid-cols-2 gap-3">
      ${field(t('age'), `<input required id="pr-age" type="number" min="1" max="120" class="${inputCls}">`)}
      ${field(t('gender'), `<select id="pr-gender" class="${inputCls}">
          <option value="Female">${t('female')}</option>
          <option value="Male">${t('male')}</option>
          <option value="Other">${t('other')}</option>
        </select>`)}
    </div>
    ${field(t('preferredLanguage'), `<select id="pr-lang" class="${inputCls}">
      ${LANGS.map((l) => `<option value="${l.code}" ${l.code === i18n.currentLang ? 'selected' : ''}>${l.native}</option>`).join('')}
    </select>`)}
    ${field(t('caregiverId'), `<input id="pr-caregiver" class="${inputCls}" placeholder="asha_demo">`, t('caregiverIdHint'))}
    ${field(t('mobileNumber'), `<input id="pr-mobile" class="${inputCls}" inputmode="numeric">`, t('optional'))}
    ${field(t('emergencyContact'), `<input id="pr-emergency" class="${inputCls}" inputmode="numeric">`, t('optional'))}
    <button ${state.authBusy ? 'disabled' : ''} class="w-full bg-maroon text-white py-3.5 rounded-xl text-base font-medium mt-2 disabled:opacity-60">
      ${state.authBusy ? t('pleaseWait') : t('registerBtn')}
    </button>
    <button type="button" onclick="setAuthMode('login')" class="w-full text-sm text-slateb mt-3">${t('alreadyRegistered')}</button>
  </form>`;
}

async function submitPatientRegister(e) {
  e.preventDefault();
  if (state.authBusy) return false;
  const password = document.getElementById('pr-pass').value;
  const confirmPassword = document.getElementById('pr-pass2').value;
  const payload = {
    name: document.getElementById('pr-name').value.trim(),
    username: document.getElementById('pr-username').value.trim(),
    password,
    confirmPassword,
    age: document.getElementById('pr-age').value,
    gender: document.getElementById('pr-gender').value,
    lang: document.getElementById('pr-lang').value,
    caregiverUsername: document.getElementById('pr-caregiver').value.trim(),
    mobile: document.getElementById('pr-mobile').value.trim(),
    emergencyContact: document.getElementById('pr-emergency').value.trim(),
  };
  if (!payload.name || !payload.username || !password) { state.authError = t('fillAllFields'); render(); return false; }
  if (password !== confirmPassword) { state.authError = t('passwordsDontMatch'); render(); return false; }

  state.authBusy = true; state.authError = null; render();
  const res = await api.registerPatient(payload);
  state.authBusy = false;

  if (!res.ok) { state.authError = res.error; render(); return false; }
  await afterAuth(res.data, res.data.message || t('registrationSuccess'));
  return false;
}

/* ------------------------------------------------- REGISTER: CAREGIVER */
function caregiverRegisterForm() {
  return `
  <form onsubmit="return submitCaregiverRegister(event)">
    ${field(t('fullName'), `<input required id="cr-name" class="${inputCls}" placeholder="Priya Das">`)}
    ${field(t('username'), `<input required id="cr-username" autocomplete="username" class="${inputCls}" placeholder="priya_care">`, t('usernameHint'))}
    <div class="grid grid-cols-2 gap-3">
      ${field(t('password'), `<input required id="cr-pass" type="password" autocomplete="new-password" class="${inputCls}">`)}
      ${field(t('confirmPassword'), `<input required id="cr-pass2" type="password" autocomplete="new-password" class="${inputCls}">`)}
    </div>
    ${field(t('emailOrPhone'), `<input required id="cr-contact" class="${inputCls}" placeholder="priya@example.org">`)}
    ${field(t('relationshipWithPatient'), `<select id="cr-relationship" class="${inputCls}">
        <option value="Family caregiver">${t('roleFamily')}</option>
        <option value="ASHA Worker">${t('roleAsha')}</option>
        <option value="Community Health Worker">${t('roleChw')}</option>
        <option value="Son / Daughter">${t('relSonDaughter')}</option>
        <option value="Spouse">${t('relSpouse')}</option>
        <option value="Nurse">${t('relNurse')}</option>
      </select>`)}
    <button ${state.authBusy ? 'disabled' : ''} class="w-full bg-slateb text-white py-3.5 rounded-xl text-base font-medium mt-2 disabled:opacity-60">
      ${state.authBusy ? t('pleaseWait') : t('registerBtn')}
    </button>
    <button type="button" onclick="setAuthMode('login')" class="w-full text-sm text-slateb mt-3">${t('alreadyRegistered')}</button>
  </form>`;
}

async function submitCaregiverRegister(e) {
  e.preventDefault();
  if (state.authBusy) return false;
  const password = document.getElementById('cr-pass').value;
  const confirmPassword = document.getElementById('cr-pass2').value;
  const relationship = document.getElementById('cr-relationship').value;
  const payload = {
    name: document.getElementById('cr-name').value.trim(),
    username: document.getElementById('cr-username').value.trim(),
    password,
    confirmPassword,
    contact: document.getElementById('cr-contact').value.trim(),
    relationship,
    role: relationship === 'ASHA Worker' ? 'asha' : relationship === 'Community Health Worker' ? 'chw' : 'family',
    lang: i18n.currentLang,
  };
  if (!payload.name || !payload.username || !password || !payload.contact) {
    state.authError = t('fillAllFields'); render(); return false;
  }
  if (password !== confirmPassword) { state.authError = t('passwordsDontMatch'); render(); return false; }

  state.authBusy = true; state.authError = null; render();
  const res = await api.registerCaregiver(payload);
  state.authBusy = false;

  if (!res.ok) { state.authError = res.error; render(); return false; }
  await afterAuth(res.data, res.data.message || t('registrationSuccess'));
  return false;
}

/* -------------------------------------------------- POST-AUTH ROUTING */
async function afterAuth(data, message) {
  setSession({ token: data.token, role: data.role });
  resetUserState();
  state.role = data.role;

  if (data.role === 'patient') {
    state.patient = data.patient;
    state.patientId = data.patient.id;
    await refreshPatientData(data.patient.id);
    await loadNextReminder();
    await i18n.setLanguage((state.patient && state.patient.lang) || 'en-IN');
    showToast(message);
    goto('patient-home');
  } else {
    state.caregiver = data.caregiver;
    await loadCaregiverPatients();
    await i18n.setLanguage(state.caregiver.lang || i18n.currentLang);
    // Land on the Overview when there is something to see, and straight on
    // Add Patient for a brand-new caregiver with an empty dashboard.
    state.cgSection = state.patients.length ? 'overview' : 'add-patient';
    showToast(message);
    goto('caregiver-dashboard');
  }
  startRealtime();
}

async function logout() {
  stopRealtime();
  await apiFetch('/auth/logout', { method: 'POST' });
  clearSession();
  resetUserState();
  state.screen = 'role-select';
  state.authRole = null;
  state.authMode = 'login';
  showToast(t('loggedOut'));
  render();
}
