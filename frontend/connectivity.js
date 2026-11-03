/* connectivity.js — is the SERVER reachable, and how well?
 * =====================================================================
 * navigator.onLine is not enough, and relying on it is the classic cause
 * of "the app says online but nothing works". It only reports whether the
 * device has *a* network interface up. On the connections this app is
 * built for it is wrong constantly:
 *
 *   - connected to a village Wi-Fi with no upstream  -> onLine === true
 *   - captive portal intercepting every request      -> onLine === true
 *   - 2G/EDGE so slow that requests time out         -> onLine === true
 *   - mobile data on, backend itself down            -> onLine === true
 *
 * So this module probes the app's own /api/health endpoint and classifies
 * the link by whether it answered and how long it took. navigator.onLine
 * is used only as a fast negative hint ("definitely offline") and to
 * trigger an immediate re-probe when the OS says the network came back.
 * =====================================================================
 */

const LINK = {
  ONLINE: 'online',     // server answered promptly
  WEAK: 'weak',         // server answered, but slowly — treat as fragile
  OFFLINE: 'offline',   // server did not answer
  UNKNOWN: 'unknown',   // not probed yet
};

/* A response slower than this means the link is real but poor: worth
 * syncing on, not worth blocking the UI on. */
const WEAK_THRESHOLD_MS = 2500;
const PROBE_TIMEOUT_MS = 6000;

/* Probe cadence. Healthy links are checked rarely; a dead link is checked
 * with exponential backoff so a phone with no signal is not kept awake
 * retrying every second. */
const PROBE_INTERVAL_ONLINE_MS = 45000;
const PROBE_BACKOFF_MIN_MS = 3000;
const PROBE_BACKOFF_MAX_MS = 120000;

const connectivity = {
  status: LINK.UNKNOWN,
  lastLatencyMs: null,
  lastCheckAt: null,
  lastOnlineAt: null,
  consecutiveFailures: 0,
  probing: false,
  timer: null,
  listeners: new Set(),
};

/** Anything that wants to react to a change in link quality. */
function onConnectivityChange(fn) {
  connectivity.listeners.add(fn);
  return () => connectivity.listeners.delete(fn);
}

function emitConnectivity(previous) {
  for (const fn of connectivity.listeners) {
    try { fn(connectivity.status, previous); } catch (e) { console.warn('[connectivity] listener failed', e); }
  }
}

function setLinkStatus(next, latencyMs) {
  const previous = connectivity.status;
  connectivity.status = next;
  connectivity.lastLatencyMs = latencyMs == null ? connectivity.lastLatencyMs : latencyMs;
  connectivity.lastCheckAt = Date.now();

  if (next === LINK.ONLINE || next === LINK.WEAK) {
    connectivity.lastOnlineAt = Date.now();
    connectivity.consecutiveFailures = 0;
  } else {
    connectivity.consecutiveFailures += 1;
  }
  if (previous !== next) emitConnectivity(previous);
  return next;
}

/**
 * One real probe against the app's own backend.
 * Returns the resulting link status.
 */
async function probeConnectivity() {
  if (connectivity.probing) return connectivity.status;
  connectivity.probing = true;

  // Fast negative: the OS is certain there is no network at all.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    connectivity.probing = false;
    return setLinkStatus(LINK.OFFLINE, null);
  }

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    // cache: 'no-store' so a service worker or HTTP cache cannot answer
    // this for us — that would report a dead link as healthy.
    const res = await fetch(`${API_BASE_URL}/health`, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timer);

    const latency = Date.now() - started;
    if (!res.ok) return setLinkStatus(LINK.OFFLINE, latency);

    // Confirm it is OUR backend, not a captive portal returning 200.
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true || body.app !== APP_NAME) {
      return setLinkStatus(LINK.OFFLINE, latency);
    }
    return setLinkStatus(latency > WEAK_THRESHOLD_MS ? LINK.WEAK : LINK.ONLINE, latency);
  } catch (err) {
    return setLinkStatus(LINK.OFFLINE, Date.now() - started);
  } finally {
    connectivity.probing = false;
  }
}

/** How long to wait before the next probe, given the current state. */
function nextProbeDelay() {
  if (connectivity.status === LINK.ONLINE) return PROBE_INTERVAL_ONLINE_MS;
  if (connectivity.status === LINK.WEAK) return Math.round(PROBE_INTERVAL_ONLINE_MS / 3);
  // Offline: exponential backoff with jitter, so a device with no signal
  // is not woken constantly and many devices do not retry in lockstep.
  const exponent = Math.min(connectivity.consecutiveFailures, 6);
  const base = Math.min(PROBE_BACKOFF_MIN_MS * (2 ** exponent), PROBE_BACKOFF_MAX_MS);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function scheduleNextProbe() {
  clearTimeout(connectivity.timer);
  connectivity.timer = setTimeout(async () => {
    await probeConnectivity();
    scheduleNextProbe();
  }, nextProbeDelay());
}

function startConnectivityWatch() {
  stopConnectivityWatch();
  probeConnectivity().then(scheduleNextProbe);

  // The OS telling us the network changed is a hint to re-probe NOW,
  // never a conclusion on its own.
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
  document.addEventListener('visibilitychange', handleVisibility);
}

function stopConnectivityWatch() {
  clearTimeout(connectivity.timer);
  connectivity.timer = null;
  window.removeEventListener('online', handleBrowserOnline);
  window.removeEventListener('offline', handleBrowserOffline);
  document.removeEventListener('visibilitychange', handleVisibility);
}

async function handleBrowserOnline() {
  connectivity.consecutiveFailures = 0;   // give it a fair chance immediately
  await probeConnectivity();
  scheduleNextProbe();
}

function handleBrowserOffline() {
  setLinkStatus(LINK.OFFLINE, null);
  scheduleNextProbe();
}

async function handleVisibility() {
  if (document.visibilityState !== 'visible') return;
  await probeConnectivity();
  scheduleNextProbe();
}

/* --------------------------------------------------------------- API */

function isOnline() {
  return connectivity.status === LINK.ONLINE || connectivity.status === LINK.WEAK;
}
function isOffline() {
  return connectivity.status === LINK.OFFLINE;
}
function linkStatus() {
  return connectivity.status;
}

/**
 * The single line the patient and caregiver see. Deliberately plain: a
 * dementia-friendly screen should never show a stack of network jargon.
 */
function connectivityIndicator() {
  const pending = (typeof syncEngine !== 'undefined' && syncEngine.pendingCount) || 0;

  if (typeof syncEngine !== 'undefined' && syncEngine.running) {
    return { icon: '🔄', tone: 'syncing', text: t('syncSyncing') };
  }
  if (connectivity.status === LINK.OFFLINE) {
    return { icon: '🟡', tone: 'offline', text: t('syncOfflineSafe') };
  }
  if (pending > 0) {
    return { icon: '⚠️', tone: 'pending', text: `${t('syncPending')} (${pending})` };
  }
  if (connectivity.status === LINK.WEAK) {
    return { icon: '🟠', tone: 'weak', text: t('syncWeak') };
  }
  if (connectivity.status === LINK.ONLINE) {
    return { icon: '🟢', tone: 'online', text: t('syncOnline') };
  }
  return { icon: '⚪', tone: 'unknown', text: t('syncChecking') };
}

/** Small pill used in both dashboards' headers. */
function connectivityPill(extraClass) {
  const s = connectivityIndicator();
  return `<span data-connectivity class="text-xs px-3 py-1.5 rounded-full whitespace-nowrap ${extraClass || ''}"
    title="${escapeHtml(connectivityDetail())}">${s.icon} ${escapeHtml(s.text)}</span>`;
}

/** The longer explanation, shown on hover and in the sync panel. */
function connectivityDetail() {
  const parts = [];
  if (connectivity.lastCheckAt) parts.push(`${t('lastChecked')}: ${new Date(connectivity.lastCheckAt).toLocaleTimeString()}`);
  if (connectivity.lastLatencyMs != null && isOnline()) parts.push(`${connectivity.lastLatencyMs}ms`);
  if (connectivity.lastOnlineAt && isOffline()) parts.push(`${t('lastOnline')}: ${new Date(connectivity.lastOnlineAt).toLocaleString()}`);
  return parts.join(' · ');
}

/** Repaints just the pills, without re-rendering the whole screen. */
function refreshConnectivityIndicators() {
  const s = connectivityIndicator();
  document.querySelectorAll('[data-connectivity]').forEach((el) => {
    el.textContent = `${s.icon} ${s.text}`;
    el.setAttribute('title', connectivityDetail());
  });
}
