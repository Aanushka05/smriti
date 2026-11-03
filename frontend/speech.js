/* ============================================================================
 * speech.js — voice in and voice out, online and off.
 *
 * THE ORDER
 *   1. Bhashini, through our own backend, when there is a connection and the
 *      language is actually supported for that task.
 *   2. The browser's own speech engine, when it genuinely has the language.
 *   3. Say plainly that it cannot be done.
 *
 * WHAT IS AND IS NOT OFFLINE — this matters, and is easy to get wrong.
 *
 *   Text to speech: `speechSynthesis` uses voices installed on the DEVICE, so
 *   it genuinely works with no network. Which voices exist is decided by the
 *   operating system, not by us. Hindi and English are common. Assamese, Bodo
 *   and Manipuri voices are almost never installed on an ordinary phone.
 *
 *   Speech to text: `webkitSpeechRecognition` in Chrome sends audio to
 *   Google's servers. It is NOT an offline capability, whatever its name
 *   suggests. When the device is offline there is no browser speech
 *   recognition to fall back to, and this file says so rather than showing a
 *   microphone button that will never respond.
 *
 * So the honest summary is: offline TTS is real but language-limited, and
 * offline STT does not exist in a browser. Anything else would be a promise
 * the app cannot keep to someone relying on it.
 * ==========================================================================*/

/* The languages this app prioritises, and what each engine can do for them.
 * `bhashini` is not asserted here — it is discovered from the server, because
 * Bhashini supports different languages for translation, ASR and TTS. */
const LANGUAGE_PRIORITY = ['as', 'brx', 'mni', 'hi', 'en'];

const speechState = {
  capability: new Map(),     // lang -> what the server reported
  deviceVoices: null,        // resolved once the browser has loaded them
  recognition: null,
  recording: null,
};

/* ------------------------------------------------------- device voices */

/** The voices actually installed on this device. Loads asynchronously. */
function loadDeviceVoices() {
  if (speechState.deviceVoices) return Promise.resolve(speechState.deviceVoices);
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) { speechState.deviceVoices = []; resolve([]); return; }
    const take = () => {
      const voices = window.speechSynthesis.getVoices() || [];
      if (voices.length) { speechState.deviceVoices = voices; resolve(voices); return true; }
      return false;
    };
    if (take()) return;
    // Chrome populates the list asynchronously and fires this once.
    window.speechSynthesis.onvoiceschanged = () => { if (!take()) resolve([]); };
    setTimeout(() => { if (!speechState.deviceVoices) { speechState.deviceVoices = []; resolve([]); } }, 1500);
  });
}

/** Is there a voice on THIS device for this language? */
async function deviceVoiceFor(langCode) {
  const voices = await loadDeviceVoices();
  const base = String(langCode || '').split('-')[0].toLowerCase();
  return voices.find((v) => String(v.lang || '').toLowerCase().startsWith(base)) || null;
}

/* ------------------------------------------------------- capability */

/**
 * What can actually be done for this language, here, now. Combines what the
 * server says about Bhashini with what this device can do by itself.
 */
async function speechCapabilityFor(langCode) {
  const base = String(langCode || 'en').split('-')[0].toLowerCase();
  const cached = speechState.capability.get(base);
  const fresh = cached && Date.now() - cached.at < 5 * 60 * 1000;

  let online = fresh ? cached.online : { asr: false, tts: false, configured: false, note: null };
  if (!fresh && isOnline()) {
    try {
      const res = await api.speechCapability(base);
      if (res.ok && res.data.capability) online = res.data.capability;
    } catch { /* leave it false — an unknown capability is not a capability */ }
  }

  const voice = await deviceVoiceFor(base);
  const capability = {
    language: base,
    onlineAsr: !!online.asr && isOnline(),
    onlineTts: !!online.tts && isOnline(),
    // Real, and independent of the network.
    offlineTts: !!voice,
    offlineVoiceName: voice ? voice.name : null,
    // There is no such thing in a browser. Stated, not hidden.
    offlineAsr: false,
    configured: !!online.configured,
    note: online.note || null,
  };
  capability.canSpeak = capability.onlineTts || capability.offlineTts;
  capability.canListen = capability.onlineAsr;
  speechState.capability.set(base, { at: Date.now(), online, capability });
  return capability;
}

/* ------------------------------------------------------ text to speech */

/**
 * Reads text aloud. Bhashini first when it is available for this language,
 * the device's own voice otherwise. Returns which one was used, so the caller
 * can be honest with the user rather than silently doing nothing.
 */
async function speakText(text, langCode) {
  const value = String(text || '').trim();
  if (!value) return { ok: false, reason: 'empty' };
  const lang = String(langCode || i18n.currentLang || 'en').split('-')[0];
  const capability = await speechCapabilityFor(lang);

  if (capability.onlineTts) {
    try {
      const res = await api.synthesizeSpeech(value, lang);
      if (res.ok && res.data.audioBase64) {
        await playAudioBase64(res.data.audioBase64, res.data.mimeType);
        return { ok: true, source: 'bhashini' };
      }
    } catch {
      // Fall through to the device rather than failing: a slightly different
      // accent is better than silence.
    }
  }

  if (capability.offlineTts) {
    voiceService.speak(value, langCode || i18n.currentLang);
    return { ok: true, source: 'device', voice: capability.offlineVoiceName };
  }

  return {
    ok: false,
    reason: 'no_voice',
    message: t('noVoiceForLanguage').replace('{lang}', languageName(lang)),
  };
}

function playAudioBase64(base64, mimeType) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(`data:${mimeType || 'audio/wav'};base64,${base64}`);
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error('playback failed'));
    audio.play().catch(reject);
  });
}

/* ------------------------------------------------------ speech to text */

/**
 * Records a short clip and sends it to Bhashini.
 *
 * Only offered when the server says this language is supported AND there is a
 * connection — there is no offline path, and pretending otherwise would leave
 * a patient holding a button that does nothing.
 */
async function listenForSpeech(langCode, { maxMs = 8000 } = {}) {
  const lang = String(langCode || i18n.currentLang || 'en').split('-')[0];
  const capability = await speechCapabilityFor(lang);

  if (!capability.canListen) {
    return {
      ok: false,
      reason: isOnline() ? 'unsupported_language' : 'offline',
      message: isOnline()
        ? t('noListeningForLanguage').replace('{lang}', languageName(lang))
        : t('listeningNeedsInternet'),
    };
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return { ok: false, reason: 'no_microphone', message: t('microphoneUnavailable') };
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return { ok: false, reason: 'permission_denied', message: t('microphonePermission') };
  }

  try {
    const audioBase64 = await recordClip(stream, maxMs);
    const res = await api.transcribeSpeech(audioBase64, lang);
    if (!res.ok) return { ok: false, reason: 'service', message: res.error };
    if (res.data.empty) return { ok: false, reason: 'nothing_heard', message: t('nothingHeard') };
    return { ok: true, text: res.data.text, source: 'bhashini' };
  } catch (err) {
    return { ok: false, reason: 'failed', message: t('couldNotRecord') };
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function recordClip(stream, maxMs) {
  return new Promise((resolve, reject) => {
    if (typeof MediaRecorder === 'undefined') { reject(new Error('no recorder')); return; }
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    speechState.recording = recorder;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onerror = () => reject(new Error('recording failed'));
    recorder.onstop = () => {
      speechState.recording = null;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(blob);
    };
    recorder.start();
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, maxMs);
  });
}

/** Stops a recording early, when the patient taps the button again. */
function stopListening() {
  if (speechState.recording && speechState.recording.state === 'recording') {
    speechState.recording.stop();
  }
}

function languageName(code) {
  const found = (typeof LANGS !== 'undefined' ? LANGS : []).find((l) => l.code.startsWith(code));
  return found ? found.native : code;
}
