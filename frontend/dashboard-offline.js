/* dashboard-offline.js — what the caregiver sees about offline data.
 * =====================================================================
 * Two audiences, two needs:
 *
 *   The CAREGIVER needs to know whether what they are looking at is
 *   current: when the patient's device last synced, what is still sitting
 *   on it unsent, and — most importantly — whether any critical alert has
 *   actually reached a human.
 *
 *   The PATIENT needs one calm line telling them their data is safe. No
 *   counts, no jargon, no action required.
 *
 * The delivery status of a missed-dose alert is shown truthfully. If no
 * SMS provider is configured, it says the alert was recorded but not sent
 * — never a green tick that implies a caregiver was contacted.
 */

/* ----------------------------------------------------- caregiver view */

async function loadOfflineStatus() {
  if (!state.patientId) return null;
  setLoad('offline', 'loading');
  render();

  const res = await apiFetch(`/sync/status/${encodeURIComponent(state.patientId)}`);
  if (!res.ok) {
    setLoad('offline', 'error', res.error);
    render();
    return null;
  }
  state.offlineStatus = res.data;

  // The caregiver's own device may also hold unsent data.
  if (localDbAvailable()) {
    try { state.offlineStatus.localStats = await localDbStats(); } catch (e) { /* optional */ }
  }
  setLoad('offline', 'ready');
  render();
  return state.offlineStatus;
}

function sectionOfflineStatus() {
  const s = state.offlineStatus;
  const status = state.loadState.offline;
  const header = sectionTitle(t('offlineStatus'), escapeHtml(state.patient ? state.patient.name : ''));

  if (status === 'loading' || (status !== 'error' && !s)) {
    return `${header}<div class="card-textile rounded-2xl p-6">${panelState('offline')}</div>`;
  }
  if (status === 'error') {
    return `${header}<div class="card-textile rounded-2xl p-6">${panelState('offline', 'loadOfflineStatus()')}</div>`;
  }

  const alerts = s.alerts || [];
  const undelivered = alerts.filter((a) => a.deliveryStatus !== 'sent' && !a.acknowledgedAt);

  return `
  ${header}

  <div class="flex flex-wrap gap-3 mb-5">
    <button onclick="loadOfflineStatus()" class="px-5 py-3 rounded-xl border border-linec bg-white font-semibold min-h-[44px]">
      🔄 ${t('refresh')}
    </button>
    <button onclick="syncNow()" class="px-5 py-3 rounded-xl bg-slateb text-white font-semibold min-h-[44px]">
      ⬆ ${t('syncNow')}
    </button>
  </div>

  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
    ${kpiCard(t('lastSynced'), s.lastSyncAt ? fmtDateTime(s.lastSyncAt) : t('never'), '')}
    ${kpiCard(t('eventsReceived'), s.totalEvents || 0, '')}
    ${kpiCard(t('pendingData'), (s.localStats && s.localStats.pending) || 0, t('onThisDevice'))}
    ${kpiCard(t('criticalAlerts'), alerts.length, s.alertsDetectedOffline
    ? `${s.alertsDetectedOffline} ${t('detectedOffline')}` : '')}
  </div>

  ${undelivered.length ? `
  <div class="offline-notice mb-5">
    <span aria-hidden="true">⚠️</span>
    <span>${t('undeliveredAlertsWarning').replace('{n}', undelivered.length)}</span>
  </div>` : ''}

  <div class="card-textile rounded-2xl p-5 mb-5">
    <h2 class="font-serif2 text-lg mb-1">🚨 ${t('criticalAlerts')}</h2>
    <p class="text-xs text-inksoft mb-4">${t('criticalAlertsHelp')}</p>
    ${alerts.length === 0
    ? `<div class="text-center py-6 text-inksoft text-sm">${t('noCriticalAlerts')}</div>`
    : `<ul class="list-none p-0 m-0 flex flex-col gap-2">
        ${alerts.map(alertRow).join('')}
      </ul>`}
  </div>

  ${pendingDataCard(s)}

  <p class="text-xs text-inksoft mt-4">${t('offlineStatusFootnote')}</p>`;
}

function alertRow(a) {
  const delivery = {
    sent: { icon: '📨', label: t('alertDelivered'), cls: 'bg-leafgreen text-white' },
    pending: { icon: '⏳', label: t('alertPending'), cls: 'bg-ochre text-white' },
    failed: { icon: '❌', label: t('alertFailed'), cls: 'bg-alertc text-white' },
    no_contact: { icon: '📵', label: t('alertNoContact'), cls: 'bg-alertc text-white' },
  }[a.deliveryStatus] || { icon: '⏳', label: t('alertPending'), cls: 'bg-[#EDE7D8] text-inksoft' };

  return `
  <li class="flex items-start gap-3 p-3 rounded-lg ${a.acknowledgedAt ? 'bg-[#F2F7F1]' : 'bg-[#FBEAE7]'}">
    <span class="text-xl" aria-hidden="true">💊</span>
    <div class="flex-1 min-w-0">
      <div class="text-sm font-semibold">${escapeHtml(a.title || t('criticalAlerts'))}</div>
      <div class="text-xs text-inksoft">
        ${a.dueDate ? escapeHtml(a.dueDate) : ''} ${a.dueTime ? escapeHtml(a.dueTime) : ''}
        · ${t('recorded')} ${fmtDateTime(a.createdAt)}
        ${a.detectedOffline ? ` · ${t('detectedOffline')}` : ''}
      </div>
      ${a.lastError ? `<div class="text-xs text-alertc mt-0.5">${escapeHtml(a.lastError)}</div>` : ''}
    </div>
    <div class="flex flex-col items-end gap-1.5">
      <span class="text-xs px-2.5 py-1 rounded-full ${delivery.cls} whitespace-nowrap">
        ${delivery.icon} ${delivery.label}
      </span>
      ${a.acknowledgedAt
    ? `<span class="text-xs text-leafgreen">✓ ${t('acknowledged')}</span>`
    : `<button onclick="acknowledgeAlert('${jsAttr(a.id)}')"
           class="text-xs px-3 py-2 rounded-lg border border-linec bg-white min-h-[36px]">${t('acknowledge')}</button>`}
    </div>
  </li>`;
}

function pendingDataCard(s) {
  const local = s.localStats;
  if (!local) return '';
  const nothing = local.pending === 0 && local.failed === 0;

  return `
  <div class="card-textile rounded-2xl p-5">
    <h2 class="font-serif2 text-lg mb-1">📦 ${t('pendingData')}</h2>
    <p class="text-xs text-inksoft mb-4">${t('pendingDataHelp')}</p>
    ${nothing
    ? `<div class="text-center py-6 text-inksoft text-sm">${t('nothingPending')}</div>`
    : `<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        ${kpiCard(t('syncPending'), local.pending, '')}
        ${kpiCard(t('alertFailed'), local.failed, '')}
        ${kpiCard(t('sessions'), local.sessions, t('storedOnDevice'))}
        ${kpiCard(t('reminders'), local.reminders, t('storedOnDevice'))}
      </div>`}
    ${local.usageBytes != null ? `
      <p class="text-xs text-inksoft mt-3">
        ${t('storageUsed')}: ${(local.usageBytes / 1048576).toFixed(1)} MB
        ${local.quotaBytes ? ` / ${(local.quotaBytes / 1048576).toFixed(0)} MB` : ''}
      </p>` : ''}
  </div>`;
}

async function acknowledgeAlert(alertId) {
  const res = await apiFetch(`/alerts/${encodeURIComponent(alertId)}/acknowledge`, { method: 'POST' });
  if (!res.ok) { showToast(res.error); return; }
  showToast(t('acknowledged'));
  await loadOfflineStatus();
}

/* ------------------------------------------------------- patient view */

/**
 * One line for the patient. Only shown when it means something — a
 * dementia-friendly screen should not carry a permanent status widget
 * they have to interpret.
 */
function patientOfflineNotice() {
  if (typeof linkStatus !== 'function') return '';
  const offline = isOffline();
  const pending = (typeof syncEngine !== 'undefined' && syncEngine.pendingCount) || 0;
  if (!offline && pending === 0) return '';

  return `
  <div class="offline-notice mb-5" role="status">
    <span aria-hidden="true">${offline ? '🟡' : '🔄'}</span>
    <span>${offline ? t('patientOfflineReassurance') : t('patientSyncingReassurance')}</span>
  </div>`;
}
