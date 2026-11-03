/* db.js — the patient's LOCAL database (IndexedDB via Dexie).
 * =====================================================================
 * WHY IndexedDB, and why Dexie
 * ---------------------------------------------------------------------
 * The rest of this project has no build step: plain <script> files and a
 * server-side SQLite. The local store had to fit that, hold megabytes of
 * activity, survive a browser restart, and support transactions and
 * indexed queries.
 *
 *   localStorage  — synchronous, ~5MB, strings only. Fine for a token or a
 *                   preference (still used for those); useless for a
 *                   growing event log.
 *   SQLite (wasm) — powerful, but needs OPFS plumbing and ~1MB of wasm for
 *                   no advantage over IndexedDB here.
 *   PouchDB       — excellent, but its sync model expects CouchDB. This
 *                   project already has a REST + SQLite backend, so we
 *                   would be fighting it.
 *   IndexedDB     — the only browser store with the capacity, indexes and
 *                   transactions this needs. Dexie is a thin, well-proven
 *                   wrapper over it and ships a UMD build that drops into
 *                   this project as one more <script>, exactly like
 *                   Chart.js already does.
 *
 * So: IndexedDB + Dexie on the device, unchanged better-sqlite3 on the
 * server. The server schema is NOT touched by this file.
 *
 * ---------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------
 * Every patient action is written HERE FIRST and to the server second.
 * The device is the source of truth while offline; the server is a
 * synchronisation destination, not a precondition for the app working.
 *
 * Nothing in here is ever deleted because it was "sent" — only after the
 * server has confirmed it (see outbox.js).
 * =====================================================================
 */

const DB_NAME = 'smritisaathi_care';

/* Sync states an outbox row moves through. Kept as constants so a typo
 * cannot silently create a state nothing ever processes. */
const SYNC = {
  PENDING: 'pending',   // written locally, not yet sent
  SENDING: 'sending',   // in flight right now
  SYNCED: 'synced',     // server confirmed — safe to prune
  FAILED: 'failed',     // repeated failures; still kept, still retried
};

/* Event types that can travel through the outbox. The server validates
 * this same list, so an unknown type can never be silently dropped. */
const EVENT = {
  GAME_RESULT: 'game_result',
  REMINDER_ACTION: 'reminder_action',   // done / missed / snoozed
  MISSED_DOSE_ALERT: 'missed_dose_alert',
  PATIENT_INTERACTION: 'patient_interaction',
  GAME_SESSION_START: 'game_session_start',
  GAME_SESSION_END: 'game_session_end',
};

const dexieDb = new Dexie(DB_NAME);

/**
 * Schema. Indexes are chosen for the queries the app actually runs:
 * "today's reminders", "unsynced outbox rows oldest first", "sessions for
 * this patient in a date range".
 *
 * ++id      auto-increment primary key
 * &field    unique index
 * [a+b]     compound index
 */
dexieDb.version(1).stores({
  // The signed-in patient, cached so the app can open with no network.
  profile: 'id, username, updatedAt',

  // The caregiver's plan, mirrored locally so reminders can be generated
  // on the device with no server involved.
  schedules: 'id, patientId, status, scheduledTime, updatedAt',

  // One occurrence of a schedule on one date. Generated locally.
  reminders: 'id, patientId, scheduleId, [patientId+dueDate], dueDate, status, syncStatus, updatedAt',

  // Completed cognitive activities. Append-only.
  sessions: 'id, patientId, domain, completedAt, syncStatus',

  // THE OUTBOX. Every write the server still needs to hear about.
  outbox: 'eventId, patientId, eventType, syncStatus, createdAt, [syncStatus+createdAt], nextAttemptAt',

  // Critical alerts (missed medication) with their own delivery log.
  alerts: 'id, patientId, type, severity, createdAt, deliveryStatus, syncStatus',

  // Small key/value bag: last sync time, device id, cached settings.
  meta: 'key',
});

/* Version 2 adds play sessions, which is how the 30-minute limit and the
 * daily session allowance survive with no network. Dexie upgrades an
 * existing device in place; the tables above are untouched. */
dexieDb.version(2).stores({
  // One stretch of play. [patientId+dayKey] is the allowance lookup.
  gameSessions: 'id, patientId, dayKey, [patientId+dayKey], status, startedAt, syncStatus',
});

/* ---------------------------------------------------------------------
   IDENTITY
   Every event needs an ID that is unique across devices and stable across
   retries — that is what makes the server able to reject duplicates.
--------------------------------------------------------------------- */
function newUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC-4122 v4 from crypto.getRandomValues, for older WebViews.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/* ---------------------------------------------------------------------
   META HELPERS
--------------------------------------------------------------------- */
async function metaGet(key, fallback) {
  const row = await dexieDb.meta.get(key);
  return row === undefined ? fallback : row.value;
}

async function metaSet(key, value) {
  await dexieDb.meta.put({ key, value, updatedAt: Date.now() });
  return value;
}

/**
 * A stable ID for this device+browser. It goes on every synced event so
 * the server can tell "the same event re-sent from one device" apart from
 * "two devices genuinely did something".
 */
async function getDeviceId() {
  let id = await metaGet('deviceId', null);
  if (!id) { id = newUuid(); await metaSet('deviceId', id); }
  return id;
}

/* ---------------------------------------------------------------------
   OPEN / DIAGNOSTICS
--------------------------------------------------------------------- */
let dbReady = null;

/**
 * Opens the database once. If IndexedDB is unavailable (private mode in
 * some browsers, storage disabled), this rejects — callers fall back to
 * online-only behaviour rather than crashing, and the UI says so.
 */
function openLocalDb() {
  if (!dbReady) {
    dbReady = dexieDb.open()
      .then(async () => {
        await getDeviceId();
        return dexieDb;
      })
      .catch((err) => {
        console.error('[db] IndexedDB unavailable — offline features are disabled:', err && err.message);
        dbReady = null;
        throw err;
      });
  }
  return dbReady;
}

function localDbAvailable() {
  return typeof indexedDB !== 'undefined' && typeof Dexie !== 'undefined';
}

/**
 * Ask the browser to keep this data even under storage pressure. Without
 * it, a device low on space can evict IndexedDB — which for this app
 * would mean losing unsynced medication records.
 */
async function requestPersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return { supported: false, persisted: false };
    const already = await navigator.storage.persisted();
    const persisted = already || await navigator.storage.persist();
    return { supported: true, persisted };
  } catch (e) {
    return { supported: false, persisted: false };
  }
}

/** Rough numbers for the caregiver's "pending data" display. */
async function localDbStats() {
  const [pending, failed, sessions, reminders, alerts, lastSync, quota] = await Promise.all([
    dexieDb.outbox.where('syncStatus').anyOf(SYNC.PENDING, SYNC.SENDING).count(),
    dexieDb.outbox.where('syncStatus').equals(SYNC.FAILED).count(),
    dexieDb.sessions.count(),
    dexieDb.reminders.count(),
    dexieDb.alerts.count(),
    metaGet('lastSyncAt', null),
    (async () => {
      try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; }
      catch (e) { return null; }
    })(),
  ]);
  return {
    pending, failed, sessions, reminders, alerts, lastSyncAt: lastSync,
    usageBytes: quota ? quota.usage : null,
    quotaBytes: quota ? quota.quota : null,
  };
}

/**
 * Clears device-local patient data. Used on logout ONLY when there is
 * nothing left to sync — signing out must never be a way to lose a
 * patient's unsynced medication history.
 */
async function clearLocalPatientData({ force = false } = {}) {
  const outstanding = await dexieDb.outbox
    .where('syncStatus').anyOf(SYNC.PENDING, SYNC.SENDING, SYNC.FAILED).count();
  if (outstanding > 0 && !force) {
    return { cleared: false, outstanding };
  }
  await dexieDb.transaction('rw', [dexieDb.profile, dexieDb.schedules, dexieDb.reminders,
    dexieDb.sessions, dexieDb.alerts], async () => {
    await Promise.all([
      dexieDb.profile.clear(), dexieDb.schedules.clear(), dexieDb.reminders.clear(),
      dexieDb.sessions.clear(), dexieDb.alerts.clear(),
    ]);
  });
  return { cleared: true, outstanding: 0 };
}
