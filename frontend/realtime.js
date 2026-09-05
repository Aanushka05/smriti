/* realtime.js — keeps the open dashboard in step with the database.
 *
 * Primary channel: Server-Sent Events on /api/events. The backend pushes a
 * small hint ({type, patientId}) whenever a schedule, reminder, session or
 * patient changes; this file then re-fetches through the normal
 * authenticated endpoints and re-renders. Nothing sensitive travels on the
 * event itself.
 *
 * Fallback: if EventSource is missing or the stream cannot be established,
 * it switches to polling on a timer. Either way the screen updates in place
 * — there is never a full page reload.
 */

const REALTIME = {
  source: null,
  connected: false,
  mode: 'off',              // 'sse' | 'polling' | 'off'
  pollTimer: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  lastEventAt: null,
  refreshing: false,
  pendingRefresh: false,
};

const POLL_INTERVAL_MS = 20000;
const MAX_BACKOFF_MS = 30000;

/* ------------------------------------------------------------- connect */
function startRealtime() {
  stopRealtime();
  if (!isLoggedIn()) return;

  if (typeof window.EventSource !== 'function') {
    startPolling('This browser does not support live updates');
    return;
  }

  try {
    // EventSource cannot set an Authorization header, so the token goes in
    // the query string; the backend accepts it for this route only.
    const url = `${API_BASE_URL}/events?token=${encodeURIComponent(state.token)}`;
    const source = new EventSource(url);
    REALTIME.source = source;
    REALTIME.mode = 'sse';

    source.addEventListener('ready', () => {
      REALTIME.connected = true;
      REALTIME.reconnectAttempts = 0;
      stopPolling();
      updateLiveIndicator();
    });

    source.addEventListener('update', (event) => {
      let data = null;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      REALTIME.lastEventAt = Date.now();
      handleRealtimeEvent(data);
    });

    source.onerror = () => {
      REALTIME.connected = false;
      updateLiveIndicator();
      // The browser retries SSE itself, but if it keeps failing we fall
      // back to polling so the dashboard never goes stale.
      REALTIME.reconnectAttempts += 1;
      if (REALTIME.reconnectAttempts >= 3) {
        try { source.close(); } catch (e) { /* already closed */ }
        REALTIME.source = null;
        startPolling('Live connection unavailable');
      }
    };
  } catch (err) {
    startPolling('Live connection could not be started');
  }
}

function stopRealtime() {
  if (REALTIME.source) {
    try { REALTIME.source.close(); } catch (e) { /* already closed */ }
    REALTIME.source = null;
  }
  stopPolling();
  clearTimeout(REALTIME.reconnectTimer);
  REALTIME.connected = false;
  REALTIME.mode = 'off';
  REALTIME.reconnectAttempts = 0;
}

/* ------------------------------------------------------------- polling */
function startPolling(reason) {
  if (REALTIME.pollTimer) return;
  REALTIME.mode = 'polling';
  REALTIME.connected = false;
  if (reason) console.info(`[realtime] ${reason} — falling back to polling every ${POLL_INTERVAL_MS / 1000}s`);
  REALTIME.pollTimer = setInterval(() => {
    if (isLoggedIn() && document.visibilityState !== 'hidden') refreshLiveData({ silent: true });
  }, POLL_INTERVAL_MS);
  updateLiveIndicator();
}

function stopPolling() {
  if (REALTIME.pollTimer) { clearInterval(REALTIME.pollTimer); REALTIME.pollTimer = null; }
}

/* --------------------------------------------------------- event handling */
function handleRealtimeEvent(data) {
  if (!data || !data.type) return;

  // A change to a patient we are not currently looking at only matters for
  // the caregiver's patient list, not for the open detail view.
  const affectsCurrent = !data.patientId || data.patientId === state.patientId;

  if (data.type.startsWith('schedule:') || data.type.startsWith('reminder:')
      || data.type === 'session:recorded' || data.type === 'patient:updated') {
    refreshLiveData({ silent: true, patientsList: state.role === 'caregiver', force: affectsCurrent });
  }
}

/**
 * Re-fetches whatever the current screen shows and re-renders in place.
 * Coalesces bursts (a schedule edit fires several events) into one pass.
 */
async function refreshLiveData(opts = {}) {
  if (!isLoggedIn()) return;
  if (REALTIME.refreshing) { REALTIME.pendingRefresh = true; return; }
  REALTIME.refreshing = true;

  try {
    if (state.role === 'caregiver') {
      if (opts.patientsList !== false) await loadCaregiverPatients({ silent: true });
      else if (state.patientId) await refreshPatientData(state.patientId);

      // New activity changes what the analysis says, so recompute it too.
      // The GET snapshot is free (no AI call), and only while the caregiver
      // is actually looking at that panel.
      if (state.cgSection === 'analysis' && state.analysis && typeof refreshAnalysis === 'function') {
        await refreshAnalysis({ silent: true });
      }
    } else if (state.patientId) {
      await refreshPatientData(state.patientId);
      await loadNextReminder();
    }
    // Never re-render on top of a game in progress — that would wipe the
    // round the patient is halfway through.
    if (!state.game) render();
  } catch (err) {
    console.warn('[realtime] refresh failed', err);
  } finally {
    REALTIME.refreshing = false;
    if (REALTIME.pendingRefresh) {
      REALTIME.pendingRefresh = false;
      setTimeout(() => refreshLiveData(opts), 300);
    }
  }
}

/** Small dot in the header so the user can see updates are live. */
function updateLiveIndicator() {
  document.querySelectorAll('[data-live-indicator]').forEach((el) => {
    const live = REALTIME.connected;
    el.textContent = live ? `🟢 ${t('liveUpdates')}` : (REALTIME.mode === 'polling' ? `🟡 ${t('autoRefresh')}` : `⚪ ${t('offlineUpdates')}`);
    el.setAttribute('title', live ? t('liveUpdatesHelp') : t('autoRefreshHelp'));
  });
}

function realtimeStatusText() {
  if (REALTIME.connected) return `🟢 ${t('liveUpdates')}`;
  if (REALTIME.mode === 'polling') return `🟡 ${t('autoRefresh')}`;
  return `⚪ ${t('offlineUpdates')}`;
}

// Reconnect when the tab comes back to the foreground; browsers freeze
// timers and sockets in background tabs.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !isLoggedIn()) return;
  if (REALTIME.mode === 'sse' && !REALTIME.connected) startRealtime();
  refreshLiveData({ silent: true });
});
