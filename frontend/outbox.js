/* outbox.js — the sync queue and the engine that drains it.
 * =====================================================================
 * THE CONTRACT
 * ---------------------------------------------------------------------
 * 1. A patient action is written to the local tables AND appended to the
 *    outbox in ONE IndexedDB transaction. Either both happen or neither
 *    does, so an action can never exist locally without a plan to sync it.
 *
 * 2. Nothing is removed from the outbox because it was SENT. A row leaves
 *    only after the server has explicitly confirmed that event ID. If the
 *    network dies mid-request, the row is still 'pending' and is retried.
 *
 * 3. Every event carries a UUID generated on the device. The server keys
 *    on that ID, so re-sending after a timeout can never create a second
 *    record. Retrying is always safe — which is what lets us retry hard.
 *
 * 4. Patient activity is append-only. A game result or a missed dose is a
 *    historical fact; syncing never overwrites or reorders history, so
 *    there is no last-writer-wins conflict to lose data to.
 *
 * WHAT THIS SURVIVES
 *   - connection dropping mid-sync      (row stays pending, retried)
 *   - the app being closed              (IndexedDB is on disk)
 *   - the device restarting             (same)
 *   - flapping connectivity             (backoff + single-flight guard)
 *   - a backlog of hundreds of events   (batched, resumable)
 * =====================================================================
 */

const SYNC_BATCH_SIZE = 25;
const MAX_RETRY_BEFORE_FLAGGING = 5;   // after this we surface it, but keep trying
const BACKOFF_BASE_MS = 4000;
const BACKOFF_MAX_MS = 30 * 60 * 1000; // 30 minutes between attempts at worst

const syncEngine = {
  running: false,
  pendingCount: 0,
  failedCount: 0,
  lastSyncAt: null,
  lastError: null,
  autoTimer: null,
  listeners: new Set(),
};

function onSyncChange(fn) {
  syncEngine.listeners.add(fn);
  return () => syncEngine.listeners.delete(fn);
}

function emitSyncChange() {
  for (const fn of syncEngine.listeners) {
    try { fn(syncEngine); } catch (e) { console.warn('[sync] listener failed', e); }
  }
  if (typeof refreshConnectivityIndicators === 'function') refreshConnectivityIndicators();
}

/* ---------------------------------------------------------------------
   ENQUEUE — the only way anything enters the sync queue
--------------------------------------------------------------------- */

/**
 * Appends one event to the outbox.
 *
 * `localWrite` (optional) runs INSIDE the same transaction, so the local
 * table update and the queue entry commit together. That atomicity is the
 * whole reason a half-written action cannot exist.
 *
 * @param {string} eventType  one of EVENT.*
 * @param {object} payload    what the server needs to apply it
 * @param {object} opts       { patientId, tables, localWrite, priority }
 * @returns {Promise<object>} the queued event row
 */
async function enqueueEvent(eventType, payload, opts = {}) {
  await openLocalDb();

  const now = Date.now();
  const event = {
    eventId: newUuid(),                        // stable across every retry
    patientId: opts.patientId || (state.patient && state.patient.id) || null,
    eventType,
    payload,
    deviceId: await getDeviceId(),
    // Two clocks on purpose: `occurredAt` is when the patient actually did
    // it (what the record means), `createdAt` is when we wrote it down.
    occurredAt: payload && payload.occurredAt ? payload.occurredAt : now,
    createdAt: now,
    syncStatus: SYNC.PENDING,
    retryCount: 0,
    lastAttemptAt: null,
    lastError: null,
    nextAttemptAt: now,
    serverConfirmedAt: null,
    priority: opts.priority === 'critical' ? 'critical' : 'normal',
  };

  const tables = ['outbox', ...(opts.tables || [])];
  await dexieDb.transaction('rw', tables, async () => {
    if (typeof opts.localWrite === 'function') await opts.localWrite(event);
    await dexieDb.outbox.add(event);
  });

  await refreshSyncCounts();

  // Try immediately if we have a link; if not, the watcher will pick it up.
  if (typeof isOnline === 'function' && isOnline()) scheduleSync(200);
  return event;
}

async function refreshSyncCounts() {
  if (!localDbAvailable()) return;
  const [pending, failed] = await Promise.all([
    dexieDb.outbox.where('syncStatus').anyOf(SYNC.PENDING, SYNC.SENDING).count(),
    dexieDb.outbox.where('syncStatus').equals(SYNC.FAILED).count(),
  ]);
  syncEngine.pendingCount = pending;
  syncEngine.failedCount = failed;
  emitSyncChange();
}

/* ---------------------------------------------------------------------
   BACKOFF
--------------------------------------------------------------------- */

/** Exponential backoff with jitter, capped. Jitter matters: without it,
 *  every queued row retries at the same instant when a village tower
 *  comes back and we hammer the server. */
function backoffDelay(retryCount) {
  const base = Math.min(BACKOFF_BASE_MS * (2 ** Math.min(retryCount, 8)), BACKOFF_MAX_MS);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/* ---------------------------------------------------------------------
   FLUSH — drain the queue
--------------------------------------------------------------------- */

/**
 * Sends everything that is due, oldest first, in batches.
 * Single-flight: concurrent callers get the in-progress run.
 */
let flushInFlight = null;

async function flushOutbox(opts = {}) {
  if (flushInFlight) return flushInFlight;
  flushInFlight = doFlush(opts).finally(() => { flushInFlight = null; });
  return flushInFlight;
}

async function doFlush({ force = false } = {}) {
  if (!localDbAvailable()) return { skipped: 'no-local-db' };
  await openLocalDb();

  if (!isLoggedIn()) return { skipped: 'not-signed-in' };
  if (!force && typeof isOnline === 'function' && !isOnline()) return { skipped: 'offline' };

  syncEngine.running = true;
  syncEngine.lastError = null;
  emitSyncChange();

  let sent = 0;
  let confirmed = 0;
  let failed = 0;

  try {
    for (;;) {
      const now = Date.now();
      // Due rows only: anything in backoff is left alone until its time.
      const batch = await dexieDb.outbox
        .where('syncStatus').anyOf(SYNC.PENDING, SYNC.FAILED)
        .filter((row) => !row.nextAttemptAt || row.nextAttemptAt <= now)
        .limit(SYNC_BATCH_SIZE)
        .toArray();

      if (!batch.length) break;

      const ids = batch.map((r) => r.eventId);
      await dexieDb.outbox.where('eventId').anyOf(ids).modify({
        syncStatus: SYNC.SENDING, lastAttemptAt: now,
      });

      const res = await apiFetch('/sync/batch', {
        method: 'POST',
        body: {
          deviceId: await getDeviceId(),
          events: batch.map((r) => ({
            eventId: r.eventId,
            patientId: r.patientId,
            eventType: r.eventType,
            occurredAt: r.occurredAt,
            createdAt: r.createdAt,
            payload: r.payload,
          })),
        },
      });

      sent += batch.length;

      if (!res.ok) {
        // The whole batch failed to reach the server (or was rejected).
        // Nothing is deleted — every row goes back to pending with a
        // longer backoff, and will be retried.
        syncEngine.lastError = res.error;
        await dexieDb.transaction('rw', dexieDb.outbox, async () => {
          for (const row of batch) {
            const retryCount = (row.retryCount || 0) + 1;
            await dexieDb.outbox.update(row.eventId, {
              syncStatus: retryCount >= MAX_RETRY_BEFORE_FLAGGING ? SYNC.FAILED : SYNC.PENDING,
              retryCount,
              lastError: res.error || 'request failed',
              nextAttemptAt: Date.now() + backoffDelay(retryCount),
            });
          }
        });
        failed += batch.length;
        break;   // stop this run; the watcher will try again later
      }

      // Per-event results. The server tells us exactly which IDs it has,
      // including ones it already had from a previous timed-out attempt.
      const results = (res.data && res.data.results) || [];
      const byId = new Map(results.map((r) => [r.eventId, r]));

      await dexieDb.transaction('rw', dexieDb.outbox, async () => {
        for (const row of batch) {
          const result = byId.get(row.eventId);

          // Accepted OR already-known: both mean the server holds it.
          if (result && (result.status === 'accepted' || result.status === 'duplicate')) {
            await dexieDb.outbox.update(row.eventId, {
              syncStatus: SYNC.SYNCED,
              serverConfirmedAt: Date.now(),
              lastError: null,
            });
            confirmed += 1;
            continue;
          }

          // Permanently invalid — retrying cannot help. Keep the row (so
          // nothing is silently lost) but stop burning battery on it.
          if (result && result.status === 'rejected') {
            await dexieDb.outbox.update(row.eventId, {
              syncStatus: SYNC.FAILED,
              lastError: result.error || 'rejected by server',
              nextAttemptAt: Date.now() + BACKOFF_MAX_MS,
              retryCount: (row.retryCount || 0) + 1,
            });
            failed += 1;
            continue;
          }

          // No verdict for this ID: treat as not delivered and retry.
          const retryCount = (row.retryCount || 0) + 1;
          await dexieDb.outbox.update(row.eventId, {
            syncStatus: retryCount >= MAX_RETRY_BEFORE_FLAGGING ? SYNC.FAILED : SYNC.PENDING,
            retryCount,
            lastError: 'no confirmation returned',
            nextAttemptAt: Date.now() + backoffDelay(retryCount),
          });
          failed += 1;
        }
      });

      // Mirror confirmations onto the local domain rows.
      await markLocalRecordsSynced(batch, byId);
    }

    if (confirmed > 0) {
      syncEngine.lastSyncAt = Date.now();
      await metaSet('lastSyncAt', syncEngine.lastSyncAt);
    }
    await pruneConfirmedEvents();
  } catch (err) {
    console.error('[sync] flush failed', err);
    syncEngine.lastError = err && err.message;
    // Anything left mid-flight goes back to pending — never stuck.
    await dexieDb.outbox.where('syncStatus').equals(SYNC.SENDING)
      .modify({ syncStatus: SYNC.PENDING });
  } finally {
    syncEngine.running = false;
    await refreshSyncCounts();
  }

  return { sent, confirmed, failed };
}

/** Reflects server confirmation on the sessions/reminders/alerts rows. */
async function markLocalRecordsSynced(batch, byId) {
  const done = batch.filter((r) => {
    const v = byId.get(r.eventId);
    return v && (v.status === 'accepted' || v.status === 'duplicate');
  });
  if (!done.length) return;

  await dexieDb.transaction('rw', [dexieDb.sessions, dexieDb.reminders, dexieDb.alerts], async () => {
    for (const row of done) {
      const p = row.payload || {};
      if (row.eventType === EVENT.GAME_RESULT && p.sessionId) {
        await dexieDb.sessions.update(p.sessionId, { syncStatus: SYNC.SYNCED });
      } else if (row.eventType === EVENT.REMINDER_ACTION && p.reminderId) {
        await dexieDb.reminders.update(p.reminderId, { syncStatus: SYNC.SYNCED });
      } else if (row.eventType === EVENT.MISSED_DOSE_ALERT && p.alertId) {
        await dexieDb.alerts.update(p.alertId, { syncStatus: SYNC.SYNCED });
      }
    }
  });
}

/**
 * Removes confirmed events after a grace period. The delay is deliberate:
 * it keeps a short audit trail on the device so a caregiver can see what
 * synced and when, and it means a server-side rollback within that window
 * is still recoverable from the device.
 */
const CONFIRMED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function pruneConfirmedEvents() {
  const cutoff = Date.now() - CONFIRMED_RETENTION_MS;
  await dexieDb.outbox
    .where('syncStatus').equals(SYNC.SYNCED)
    .filter((r) => (r.serverConfirmedAt || 0) < cutoff)
    .delete();
}

/* ---------------------------------------------------------------------
   AUTOMATIC SYNC
--------------------------------------------------------------------- */

function scheduleSync(delayMs) {
  clearTimeout(syncEngine.autoTimer);
  syncEngine.autoTimer = setTimeout(() => { flushOutbox(); }, delayMs || 1000);
}

/**
 * Starts the engine: sync when the link returns, when the tab is focused,
 * and on a slow heartbeat as a backstop.
 */
function startSyncEngine() {
  stopSyncEngine();
  if (!localDbAvailable()) return;

  // The moment connectivity comes back, drain the queue.
  syncEngine.unsubscribeConnectivity = onConnectivityChange((status, previous) => {
    if ((status === LINK.ONLINE || status === LINK.WEAK)
        && previous !== LINK.ONLINE && previous !== LINK.WEAK) {
      // Drop any backoff earned while the device was offline first.
      clearSyncBackoff().then(() => scheduleSync(500));
    }
  });

  syncEngine.heartbeat = setInterval(() => {
    if (isOnline() && syncEngine.pendingCount > 0) flushOutbox();
  }, 60000);

  refreshSyncCounts().then(() => { if (isOnline()) scheduleSync(1500); });
}

function stopSyncEngine() {
  clearTimeout(syncEngine.autoTimer);
  clearInterval(syncEngine.heartbeat);
  if (typeof syncEngine.unsubscribeConnectivity === 'function') syncEngine.unsubscribeConnectivity();
  syncEngine.autoTimer = null;
  syncEngine.heartbeat = null;
}

/** Manual "Sync now", for the caregiver panel. */
/**
 * Clears the waiting period on queued events.
 *
 * Called when connectivity returns and when the user asks to sync now.
 * Retries that failed because the device was offline carry a backoff that
 * was never about the server, and honouring it would leave a patient's
 * work queued for minutes after the signal came back.
 */
async function clearSyncBackoff() {
  if (!localDbAvailable()) return 0;
  await openLocalDb();
  const now = Date.now();
  const waiting = await dexieDb.outbox
    .where('syncStatus').anyOf(SYNC.PENDING, SYNC.FAILED)
    .filter((row) => row.nextAttemptAt && row.nextAttemptAt > now)
    .toArray();
  if (!waiting.length) return 0;
  await dexieDb.outbox.bulkPut(waiting.map((row) => ({ ...row, nextAttemptAt: now })));
  return waiting.length;
}

async function syncNow() {
  if (!localDbAvailable()) { showToast(t('offlineUnavailable')); return null; }
  await probeConnectivity();
  if (!isOnline()) { showToast(t('syncOfflineSafe')); return null; }
  await clearSyncBackoff();
  const result = await flushOutbox({ force: true });
  if (result && result.confirmed) showToast(`${t('syncedCount')}: ${result.confirmed}`);
  else if (result && result.skipped) showToast(t('syncNothingToDo'));
  return result;
}

/** Everything still waiting, for the "pending data" view. */
async function pendingEvents(limit = 50) {
  await openLocalDb();
  return dexieDb.outbox
    .where('syncStatus').anyOf(SYNC.PENDING, SYNC.SENDING, SYNC.FAILED)
    .reverse().limit(limit).toArray();
}
