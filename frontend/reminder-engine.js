/* reminder-engine.js — medication reminders that do not need a server.
 * =====================================================================
 * The schedule lives in IndexedDB, the occurrences are generated on the
 * device (local-store.js), and this file is the clock that fires them.
 * Nothing in this path touches the network.
 *
 * BE CLEAR ABOUT THE GUARANTEE
 * ---------------------------------------------------------------------
 *   While the app is open (or backgrounded but not killed):
 *       reminders fire on time. Reliable.
 *
 *   While the app is CLOSED:
 *       a web app cannot wake the device at a chosen minute. Full stop.
 *       See the long note in service-worker.js for exactly which browser
 *       APIs exist and why none of them is dependable enough to carry a
 *       medication reminder.
 *
 *       What this engine does instead: on every launch it replays the
 *       schedule, catches everything that came due while the app was
 *       shut, marks what was missed, and raises the caregiver alert. A
 *       dose missed overnight is caught the next morning — late, but
 *       never lost or silently forgotten.
 *
 *   For an alarm that fires with the app closed, this frontend needs a
 *   native wrapper (Capacitor + Android AlarmManager). The README sets
 *   that out. This file deliberately does not pretend to replace it.
 * =====================================================================
 */

const REMINDER_TICK_MS = 30000;          // check twice a minute
const DUE_WINDOW_MINUTES = 1;            // fire within a minute of the time
const RE_NUDGE_MINUTES = 20;             // nudge again if still unanswered

const reminderEngine = {
  timer: null,
  running: false,
  firedToday: new Set(),                 // reminderId -> already announced
  lastTickAt: null,
  notificationsGranted: false,
};

/* ---------------------------------------------------------------------
   PERMISSION
--------------------------------------------------------------------- */

/**
 * Asks for notification permission. Only useful while the app is running
 * or backgrounded — we never imply more than that to the user.
 */
async function requestReminderPermission() {
  if (!('Notification' in window)) return { supported: false, granted: false };
  if (Notification.permission === 'granted') {
    reminderEngine.notificationsGranted = true;
    return { supported: true, granted: true };
  }
  if (Notification.permission === 'denied') return { supported: true, granted: false };
  try {
    const result = await Notification.requestPermission();
    reminderEngine.notificationsGranted = result === 'granted';
    return { supported: true, granted: reminderEngine.notificationsGranted };
  } catch (e) {
    return { supported: true, granted: false };
  }
}

/* ---------------------------------------------------------------------
   FIRING
--------------------------------------------------------------------- */

function minutesUntil(timeStr, now) {
  const [h, m] = String(timeStr || '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const due = new Date(now);
  due.setHours(h, m, 0, 0);
  return Math.round((due.getTime() - now.getTime()) / 60000);
}

/** Announces one reminder: on screen, by voice, and as a notification. */
async function fireReminder(reminder) {
  const key = `${reminder.id}:${Math.floor(Date.now() / (RE_NUDGE_MINUTES * 60000))}`;
  if (reminderEngine.firedToday.has(key)) return;
  reminderEngine.firedToday.add(key);

  const isMedicine = reminder.type === 'Medicine' || reminder.priority === 'high';
  const title = isMedicine ? `💊 ${reminder.title}` : `🔔 ${reminder.title}`;
  const body = `${reminder.time}${reminder.text ? ` · ${reminder.text}` : ''}`;

  // 1. On screen — always works, and is the primary channel for a patient
  //    who is looking at the tablet.
  showReminderBanner(reminder);

  // 2. Spoken — the patient may not be reading. Uses the OFFLINE speech
  //    synthesis voice, never a cloud translation call.
  try {
    if (state.patient) {
      voiceService.speak(`${reminder.title}. ${reminder.text || ''}`, state.patient.lang);
    }
  } catch (e) { /* speech is a bonus, never a dependency */ }

  // 3. A system notification, if the app is backgrounded but alive.
  try {
    if (reminderEngine.notificationsGranted && 'Notification' in window) {
      const registration = await navigator.serviceWorker.getRegistration();
      const options = {
        body,
        tag: `reminder-${reminder.id}`,      // replaces, never stacks
        requireInteraction: isMedicine,      // medicine stays until acted on
        icon: './icons/icon-192.png',
        badge: './icons/icon-192.png',
      };
      if (registration) await registration.showNotification(title, options);
      else new Notification(title, options);
    }
  } catch (e) { /* notification failure must never break the banner */ }
}

/** The large in-app reminder card. Deliberately simple and unmissable. */
function showReminderBanner(reminder) {
  const host = document.getElementById('reminder-host');
  if (!host) return;

  const isMedicine = reminder.type === 'Medicine' || reminder.priority === 'high';
  host.innerHTML = `
  <div class="reminder-banner ${isMedicine ? 'reminder-critical' : ''}" role="alertdialog"
       aria-live="assertive" aria-label="${escapeHtml(reminder.title)}">
    <div class="reminder-banner-inner">
      <div class="text-5xl" aria-hidden="true">${escapeHtml(reminder.icon || '🔔')}</div>
      <div class="flex-1 min-w-0">
        <div class="text-2xl font-semibold">${escapeHtml(reminder.title)}</div>
        <div class="text-xl text-maroon font-semibold">${escapeHtml(reminder.time)}</div>
        ${reminder.text ? `<div class="text-lg text-inksoft mt-1">${escapeHtml(reminder.text)}</div>` : ''}
      </div>
    </div>
    <div class="reminder-banner-actions">
      <button onclick="answerReminder('${jsAttr(reminder.id)}','done')" class="btn-patient btn-done flex-1">
        ✓ ${t('markDone')}
      </button>
      <button onclick="answerReminder('${jsAttr(reminder.id)}','snoozed')" class="btn-patient btn-quiet flex-1">
        ⏰ ${t('snooze15')}
      </button>
      <button onclick="dismissReminderBanner()" class="btn-patient btn-quiet" aria-label="${t('close')}">✕</button>
    </div>
  </div>`;
}

function dismissReminderBanner() {
  const host = document.getElementById('reminder-host');
  if (host) host.innerHTML = '';
}

/**
 * The patient answering a reminder. Writes locally first — this works
 * with no connectivity, which is the entire point.
 */
async function answerReminder(reminderId, action) {
  dismissReminderBanner();
  try {
    await recordReminderActionLocally(reminderId, action, { minutes: 15 });
    showToast(action === 'done' ? t('reminderMarkedDone') : t('reminderSnoozed'));
    if (state.patientId) {
      state.patient = await loadPatientFromLocal(state.patientId);
      await loadNextReminder();
      render();
    }
  } catch (err) {
    console.error('[reminders] could not record the action', err);
    showToast(t('sessionNotSaved'));
  }
}

/* ---------------------------------------------------------------------
   THE TICK
--------------------------------------------------------------------- */

async function reminderTick() {
  if (!state.patientId || !localDbAvailable()) return;
  reminderEngine.lastTickAt = Date.now();

  try {
    const today = localDateKey();
    await ensureLocalOccurrences(state.patientId, today);

    const now = new Date();
    const due = await dexieDb.reminders
      .where('[patientId+dueDate]').equals([state.patientId, today])
      .toArray();

    for (const r of due) {
      if (r.status === 'done' || r.status === 'missed') continue;
      if (r.status === 'snoozed' && r.snoozedUntil && r.snoozedUntil > Date.now()) continue;

      const delta = minutesUntil(r.time, now);
      if (delta === null) continue;

      // Fire at the time, and keep nudging while it is unanswered — a
      // patient with memory difficulties may need more than one prompt.
      const isDue = delta <= DUE_WINDOW_MINUTES;
      const notYetMissed = delta > -MISSED_GRACE_MINUTES;
      if (isDue && notYetMissed) await fireReminder(r);
    }

    // Catch anything that came due while the app was closed.
    const result = await detectMissedDosesLocally(state.patientId);
    if (result.missed > 0) {
      state.patient = await loadPatientFromLocal(state.patientId);
      if (!state.game) render();
      if (result.alerts > 0) showToast(t('missedDoseRecorded'));
    }
  } catch (err) {
    console.error('[reminders] tick failed', err);
  }
}

function startReminderEngine() {
  stopReminderEngine();
  if (!localDbAvailable()) return;
  reminderEngine.running = true;

  // Run once immediately — this is the "catch up after being closed" pass.
  reminderTick();
  reminderEngine.timer = setInterval(reminderTick, REMINDER_TICK_MS);

  // Coming back to the tab is the most likely moment to have missed
  // something, so check then too.
  document.addEventListener('visibilitychange', onReminderVisibility);
}

function stopReminderEngine() {
  clearInterval(reminderEngine.timer);
  reminderEngine.timer = null;
  reminderEngine.running = false;
  document.removeEventListener('visibilitychange', onReminderVisibility);
}

function onReminderVisibility() {
  if (document.visibilityState === 'visible') reminderTick();
}

/* ---------------------------------------------------------------------
   HONEST CAPABILITY REPORT
   Shown in the patient's Help panel and the caregiver's sync panel, so
   nobody assumes a guarantee the platform cannot give.
--------------------------------------------------------------------- */
function reminderCapability() {
  const notifications = 'Notification' in window
    ? Notification.permission : 'unsupported';
  const installed = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;

  return {
    whileOpen: true,                                  // always reliable
    whileBackgrounded: notifications === 'granted',   // usually, not guaranteed
    whileClosed: false,                               // never, for a web app
    notifications,
    installedAsApp: !!installed,
    explanation: notifications === 'granted'
      ? t('reminderCapabilityGranted')
      : t('reminderCapabilityLimited'),
  };
}
