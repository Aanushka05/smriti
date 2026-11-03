// sms_service.js — getting a missed-dose alert to a human.
// =====================================================================
// WHAT A BROWSER CAN AND CANNOT DO — read this before trusting anything
// ---------------------------------------------------------------------
// A web page CANNOT send an SMS. There is no browser API for it, in any
// browser, on any platform. `sms:` links only OPEN the messaging app with
// a draft and require the user to press send — useless for an alert about
// a patient who just forgot their medication.
//
// So SMS always leaves from a process with access to a radio or a gateway.
// This module is that process. It has three interchangeable providers:
//
//   console  — writes the message to the server log. Development and demo
//              only. It proves the pipeline without pretending to deliver.
//   http     — an SMS gateway over the internet (Twilio, MSG91, Gupshup,
//              a state SMS gateway...). Reliable, but REQUIRES INTERNET on
//              whichever machine runs this backend.
//   gsm      — a SIM800/SIM7600-class modem on a serial/USB port, driven
//              with AT commands. Sends over the cellular voice/SMS network
//              and NEEDS NO INTERNET AT ALL. This is the only provider
//              that satisfies "patient and caregiver both offline".
//
// WHERE THIS PROCESS RUNS DECIDES WHAT IS POSSIBLE
// ---------------------------------------------------------------------
// If this backend only ever runs in a data centre, then a patient with no
// internet cannot reach it, and no alert can be delivered until they do.
// That is a deployment limit, not a code limit.
//
// For genuinely offline-capable alerting, run a copy of this backend on a
// LOCAL device near the patient — a small always-on box (Raspberry Pi
// class), the caregiver's laptop, or a clinic machine — with a GSM modem
// attached and the patient's phone joined to its Wi-Fi/hotspot. Then:
//
//   patient device -> local Wi-Fi -> local backend -> GSM modem -> SMS
//
// with no internet anywhere in the chain. The local instance syncs to the
// central server later, when a connection exists.
//
// WHAT STILL CANNOT BE GUARANTEED
// ---------------------------------------------------------------------
// If there is no CELLULAR COVERAGE either, no SMS can leave the area, by
// any means. In that case this module keeps the alert queued with its
// original timestamp and retries when the network returns — it does not
// pretend the message was sent.
// =====================================================================

const { db } = require('./database');

const PROVIDER = (process.env.SMS_PROVIDER || 'console').toLowerCase();
const SMS_FROM = process.env.SMS_FROM || 'SMRITI';
const MAX_DELIVERY_ATTEMPTS = Number(process.env.SMS_MAX_ATTEMPTS) || 5;
const RETRY_BASE_MS = Number(process.env.SMS_RETRY_BASE_MS) || 60000;
const HTTP_TIMEOUT_MS = Number(process.env.SMS_HTTP_TIMEOUT_MS) || 15000;

/* =====================================================================
   PROVIDER: console — development and demo
   ===================================================================== */
const consoleProvider = {
  name: 'console',
  available: () => true,
  describe: () => 'Development logger — messages are printed, NOT delivered.',
  async send({ to, text }) {
    console.log('');
    console.log('  ┌── SMS (console provider — NOT actually delivered) ──');
    console.log(`  │ to  : ${to}`);
    console.log(`  │ text: ${text}`);
    console.log('  └────────────────────────────────────────────────────');
    console.log('');
    return { delivered: false, simulated: true, channel: 'console' };
  },
};

/* =====================================================================
   PROVIDER: http — an internet SMS gateway
   Configured generically so it fits Twilio, MSG91, Gupshup or a state
   gateway without code changes.
   ===================================================================== */
const httpProvider = {
  name: 'http',
  available: () => !!process.env.SMS_HTTP_URL,
  describe: () => `HTTP SMS gateway at ${process.env.SMS_HTTP_URL || '(unset)'} — requires internet.`,
  async send({ to, text }) {
    const url = process.env.SMS_HTTP_URL;
    if (!url) throw new Error('SMS_HTTP_URL is not configured.');

    const fetchFn = global.fetch || require('node-fetch');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    // The body template lets one provider serve many gateways.
    const template = process.env.SMS_HTTP_BODY
      || '{"to":"{{to}}","from":"{{from}}","message":"{{text}}"}';
    const body = template
      .replace(/{{to}}/g, to)
      .replace(/{{from}}/g, SMS_FROM)
      .replace(/{{text}}/g, String(text).replace(/"/g, '\\"'));

    const headers = { 'Content-Type': 'application/json' };
    if (process.env.SMS_HTTP_AUTH_HEADER) {
      headers.Authorization = process.env.SMS_HTTP_AUTH_HEADER;
    }

    try {
      const res = await fetchFn(url, {
        method: process.env.SMS_HTTP_METHOD || 'POST',
        headers, body, signal: controller.signal,
      });
      const responseText = await res.text().catch(() => '');
      if (!res.ok) throw new Error(`gateway returned ${res.status}: ${responseText.slice(0, 200)}`);
      return { delivered: true, channel: 'sms_gateway', response: responseText.slice(0, 200) };
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`SMS gateway did not respond within ${HTTP_TIMEOUT_MS / 1000}s.`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },
};

/* =====================================================================
   PROVIDER: gsm — a real modem on a serial port
   ---------------------------------------------------------------------
   Works with SIM800/SIM900 (2G) and SIM7600/SIM7670 (4G LTE) modules, and
   with most USB cellular dongles that expose an AT command port.
   Sends over the cellular network: NO INTERNET REQUIRED.
   Needs: the `serialport` package and the hardware attached.
       npm install serialport
       SMS_PROVIDER=gsm  SMS_GSM_PORT=COM4        (Windows)
       SMS_PROVIDER=gsm  SMS_GSM_PORT=/dev/ttyUSB0 (Linux / Raspberry Pi)
   ===================================================================== */
const gsmProvider = {
  name: 'gsm',
  available: () => {
    if (!process.env.SMS_GSM_PORT) return false;
    try { require.resolve('serialport'); return true; } catch (e) { return false; }
  },
  describe: () => {
    const port = process.env.SMS_GSM_PORT || '(unset)';
    let driver = 'serialport NOT installed — run: npm install serialport';
    try { require.resolve('serialport'); driver = 'serialport installed'; } catch (e) { /* keep message */ }
    return `GSM modem on ${port} (${driver}) — sends over cellular, no internet needed.`;
  },

  async send({ to, text }) {
    const portPath = process.env.SMS_GSM_PORT;
    if (!portPath) throw new Error('SMS_GSM_PORT is not configured.');

    let SerialPort;
    try {
      ({ SerialPort } = require('serialport'));
    } catch (e) {
      throw new Error('The serialport package is not installed. Run "npm install serialport" in backend/.');
    }

    const baudRate = Number(process.env.SMS_GSM_BAUD) || 115200;
    const commandTimeout = Number(process.env.SMS_GSM_TIMEOUT_MS) || 20000;

    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: portPath, baudRate }, (err) => {
        if (err) reject(new Error(`Could not open ${portPath}: ${err.message}`));
      });

      let buffer = '';
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try { port.close(() => {}); } catch (e) { /* already closing */ }
        fn(arg);
      };

      const timeout = setTimeout(
        () => finish(reject, new Error(`GSM modem did not respond within ${commandTimeout / 1000}s.`)),
        commandTimeout
      );

      // AT command sequence for a text-mode SMS.
      //   AT            modem awake?
      //   AT+CMGF=1     text mode (not PDU)
      //   AT+CSCS="GSM" character set
      //   AT+CMGS="..." begin message, wait for the "> " prompt
      //   <text><Ctrl-Z> send
      const steps = [
        { cmd: 'AT\r', expect: 'OK' },
        { cmd: 'AT+CMGF=1\r', expect: 'OK' },
        { cmd: 'AT+CSCS="GSM"\r', expect: 'OK' },
        { cmd: `AT+CMGS="${to}"\r`, expect: '>' },
        { cmd: `${text}\x1A`, expect: '+CMGS' },   // 0x1A = Ctrl-Z
      ];
      let step = 0;

      port.on('open', () => { port.write(steps[0].cmd); });

      port.on('data', (chunk) => {
        buffer += chunk.toString('utf8');

        if (buffer.includes('ERROR')) {
          finish(reject, new Error(`Modem rejected the command: ${buffer.trim().slice(-120)}`));
          return;
        }
        if (!buffer.includes(steps[step].expect)) return;

        buffer = '';
        step += 1;
        if (step < steps.length) {
          // The modem needs a beat after the "> " prompt before the body.
          setTimeout(() => port.write(steps[step].cmd), 250);
        } else {
          finish(resolve, { delivered: true, channel: 'gsm_modem', port: portPath });
        }
      });

      port.on('error', (err) => finish(reject, new Error(`Serial port error: ${err.message}`)));
    });
  },
};

const PROVIDERS = { console: consoleProvider, http: httpProvider, gsm: gsmProvider };

/**
 * Picks the provider to use. If the configured one is not actually usable
 * (no hardware, no gateway URL) we say so loudly and fall back to the
 * console logger rather than silently appearing to deliver messages.
 */
function activeProvider() {
  const chosen = PROVIDERS[PROVIDER];
  if (!chosen) {
    console.warn(`[sms] Unknown SMS_PROVIDER "${PROVIDER}" — falling back to the console logger.`);
    return consoleProvider;
  }
  if (!chosen.available()) {
    console.warn(`[sms] SMS_PROVIDER="${PROVIDER}" is configured but not usable: ${chosen.describe()}`);
    console.warn('[sms] Falling back to the console logger. Alerts will NOT reach a caregiver.');
    return consoleProvider;
  }
  return chosen;
}

function smsStatus() {
  const provider = PROVIDERS[PROVIDER] || consoleProvider;
  const configuredOk = provider.available();

  // "usable" is not the same as "actually delivers". The console provider
  // is always usable and never delivers anything, so it must not be
  // reported as a working alert channel.
  const deliversRealSms = configuredOk && PROVIDER !== 'console';

  let warning = null;
  if (!configuredOk) {
    warning = `SMS_PROVIDER="${PROVIDER}" is configured but not usable, so alerts are only logged. `
      + 'No caregiver will receive them.';
  } else if (!deliversRealSms) {
    warning = 'No SMS provider is configured (SMS_PROVIDER=console). Missed-dose alerts are recorded '
      + 'and shown on the caregiver dashboard, but no SMS is sent. Set SMS_PROVIDER=http for a gateway, '
      + 'or SMS_PROVIDER=gsm with a modem for alerts that work without internet.';
  }

  return {
    configured: PROVIDER,
    usable: configuredOk,
    deliversRealSms,
    description: provider.describe(),
    // Only a GSM modem can deliver with no internet at all.
    deliversWithoutInternet: PROVIDER === 'gsm' && configuredOk,
    warning,
  };
}

/* =====================================================================
   DELIVERY
   ===================================================================== */

/** Who to text: every caregiver linked to the patient who has a number. */
function caregiverNumbersFor(patientId) {
  const rows = db.prepare(`SELECT c.id, c.name, c.mobile FROM caregivers c
    JOIN caregiver_patients cp ON cp.caregiver_id = c.id
    WHERE cp.patient_id = ? AND c.mobile IS NOT NULL AND c.mobile != ''`).all(patientId);

  // Fall back to the patient's own emergency contact if no caregiver has
  // a number on file — better than nobody being told.
  if (!rows.length) {
    const p = db.prepare('SELECT emergency_contact FROM patients WHERE id=?').get(patientId);
    if (p && p.emergency_contact) {
      return [{ id: null, name: 'Emergency contact', mobile: p.emergency_contact }];
    }
  }
  return rows;
}

function alertMessage(alert, patientName) {
  const when = alert.due_time ? ` (due ${alert.due_time}${alert.due_date ? ` on ${alert.due_date}` : ''})` : '';
  const offline = alert.detected_offline ? ' Recorded while their device was offline.' : '';
  return `Smriti: ${patientName || 'Your patient'} has not confirmed `
    + `"${alert.title || 'their medication'}"${when}.${offline} Please check on them.`;
}

/**
 * Attempts delivery for one alert. Idempotent and safe to call again:
 * an alert already 'sent' is never sent twice, and every attempt is
 * logged with its outcome.
 */
async function deliverMissedDoseAlert(alertId) {
  const alert = db.prepare('SELECT * FROM critical_alerts WHERE id=?').get(alertId);
  if (!alert) return { ok: false, reason: 'unknown alert' };

  // Already delivered — do not send a second SMS for the same missed dose.
  if (alert.delivery_status === 'sent') {
    return { ok: true, alreadySent: true, channel: alert.delivery_channel };
  }
  if ((alert.delivery_attempts || 0) >= MAX_DELIVERY_ATTEMPTS) {
    return { ok: false, reason: 'attempt limit reached', attempts: alert.delivery_attempts };
  }

  const patient = db.prepare('SELECT name FROM patients WHERE id=?').get(alert.patient_id);
  const recipients = caregiverNumbersFor(alert.patient_id);

  const markAttempt = (status, channel, error) => {
    db.prepare(`UPDATE critical_alerts
      SET delivery_status=?, delivery_channel=?, delivery_attempts=delivery_attempts+1,
          last_attempt_at=?, last_error=? WHERE id=?`)
      .run(status, channel, Date.now(), error || null, alertId);
  };

  if (!recipients.length) {
    // Nobody to tell. Recorded plainly so the caregiver dashboard can
    // prompt for a contact number rather than this failing invisibly.
    markAttempt('no_contact', 'none', 'No caregiver mobile number or emergency contact on file.');
    console.warn(`[sms] alert ${alertId}: no phone number on file for patient ${alert.patient_id}`);
    return { ok: false, reason: 'no recipient' };
  }

  const provider = activeProvider();
  const text = alertMessage(alert, patient && patient.name);
  const outcomes = [];

  for (const r of recipients) {
    try {
      const result = await provider.send({ to: r.mobile, text });
      outcomes.push({ to: r.mobile, name: r.name, ok: true, ...result });
    } catch (err) {
      outcomes.push({ to: r.mobile, name: r.name, ok: false, error: err.message });
      console.error(`[sms] alert ${alertId} to ${r.mobile} failed: ${err.message}`);
    }
  }

  const anyReal = outcomes.some((o) => o.ok && o.delivered);
  const anySimulated = outcomes.some((o) => o.ok && o.simulated);

  if (anyReal) {
    markAttempt('sent', outcomes.find((o) => o.delivered).channel, null);
    return { ok: true, delivered: true, outcomes };
  }
  if (anySimulated) {
    // Be explicit: the pipeline worked, but nothing left the building.
    markAttempt('pending', 'console', 'Logged only — no SMS provider is configured.');
    return { ok: true, delivered: false, simulated: true, outcomes };
  }

  markAttempt('failed', provider.name, outcomes.map((o) => o.error).filter(Boolean).join('; ').slice(0, 300));
  return { ok: false, delivered: false, outcomes };
}

/**
 * Retries alerts that have not been delivered. Called on a timer, so an
 * alert raised while the modem had no signal goes out when signal
 * returns — with its ORIGINAL timestamp preserved in the message.
 */
async function retryPendingAlerts() {
  const rows = db.prepare(`SELECT id, delivery_attempts, last_attempt_at FROM critical_alerts
    WHERE delivery_status IN ('pending','failed') AND delivery_attempts < ?
    ORDER BY created_at ASC LIMIT 20`).all(MAX_DELIVERY_ATTEMPTS);

  let attempted = 0;
  for (const row of rows) {
    // Exponential backoff per alert.
    const wait = RETRY_BASE_MS * (2 ** Math.min(row.delivery_attempts || 0, 5));
    if (row.last_attempt_at && Date.now() - row.last_attempt_at < wait) continue;
    await deliverMissedDoseAlert(row.id);
    attempted += 1;
  }
  return { attempted, considered: rows.length };
}

let retryTimer = null;

function startAlertRetryLoop(intervalMs) {
  stopAlertRetryLoop();
  retryTimer = setInterval(() => {
    retryPendingAlerts().catch((err) => console.error('[sms] retry loop failed', err && err.message));
  }, intervalMs || 120000);
  if (retryTimer.unref) retryTimer.unref();
}

function stopAlertRetryLoop() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
}

/**
 * Sends one message through the active provider. Used by the OTP service;
 * the alert path has its own retry and delivery bookkeeping and does not
 * go through here.
 */
async function sendSms(to, text) {
  if (!to) throw new Error('no destination');
  return activeProvider().send({ to: String(to), text: String(text) });
}

module.exports = {
  deliverMissedDoseAlert, retryPendingAlerts, sendSms, activeProvider,
  startAlertRetryLoop, stopAlertRetryLoop,
  smsStatus, caregiverNumbersFor, PROVIDERS,
};
