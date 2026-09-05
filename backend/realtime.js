// realtime.js — live dashboard updates over Server-Sent Events.
//
// Why SSE and not Socket.IO: the app is a plain Express + static-file
// server with no build step, and every update here flows server -> client.
// SSE is native in both Node and the browser, needs no extra dependency,
// no protocol upgrade, and reconnects on its own. The frontend falls back
// to polling if EventSource is unavailable or the stream drops.
//
// Delivery rule: an event about a patient reaches that patient and every
// caregiver linked to them — nobody else. Subscriptions are authenticated
// exactly like any other route.

const { db } = require('./database');

const HEARTBEAT_MS = 25000;

/** id -> Set of { res, role } */
const clients = new Map();

function addClient(user, res) {
  if (!clients.has(user.id)) clients.set(user.id, new Set());
  const entry = { res, role: user.role };
  clients.get(user.id).add(entry);
  return entry;
}

function removeClient(user, entry) {
  const set = clients.get(user.id);
  if (!set) return;
  set.delete(entry);
  if (!set.size) clients.delete(user.id);
}

function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (err) {
    return false;
  }
}

/** Everyone entitled to see changes about this patient. */
function audienceFor(patientId) {
  const ids = [patientId];
  const rows = db.prepare('SELECT caregiver_id FROM caregiver_patients WHERE patient_id=?').all(patientId);
  for (const r of rows) ids.push(r.caregiver_id);
  return ids;
}

/**
 * publish — tell every connected client who may see this patient that
 * something changed. The payload is a hint, not the data: clients re-fetch
 * through the normal authenticated endpoints, so a live update can never
 * leak more than a regular request would.
 */
function publish(patientId, type, payload = {}) {
  if (!patientId) return 0;
  let delivered = 0;
  const body = { type, patientId, at: Date.now(), ...payload };
  for (const userId of audienceFor(patientId)) {
    const set = clients.get(userId);
    if (!set) continue;
    for (const entry of set) if (writeEvent(entry.res, 'update', body)) delivered += 1;
  }
  return delivered;
}

/** Notify one specific user (e.g. a caregiver's patient list changed). */
function publishToUser(userId, type, payload = {}) {
  const set = clients.get(userId);
  if (!set) return 0;
  let delivered = 0;
  const body = { type, at: Date.now(), ...payload };
  for (const entry of set) if (writeEvent(entry.res, 'update', body)) delivered += 1;
  return delivered;
}

/** Express handler for GET /api/events (requireAuth runs before it). */
function streamHandler(req, res) {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const entry = addClient(req.user, res);
  writeEvent(res, 'ready', { role: req.user.role, id: req.user.id, at: Date.now() });

  // Comment-only heartbeat keeps proxies from closing an idle stream.
  const beat = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch (err) { /* closed */ }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(beat);
    removeClient(req.user, entry);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function connectionCount() {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}

module.exports = { streamHandler, publish, publishToUser, connectionCount };
