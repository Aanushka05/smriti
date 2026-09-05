/* config.js — the ONE place the frontend defines where the backend lives
 * and what the app is called. Nothing else in frontend/ hard-codes
 * "http://localhost:5000"; everything goes through API_BASE_URL and the
 * apiFetch() helper in app.js.
 *
 * Resolution order:
 *   1. window.SMRITISAATHI_API_BASE  — set this to override (e.g. a LAN IP)
 *   2. the page's own origin + /api  — when the Express backend is serving
 *      frontend/ too (the normal `npm start` setup: one port, no CORS)
 *   3. http://localhost:5000/api     — when frontend/ is served separately
 *      (python -m http.server, Live Server, npx serve, file://, …)
 *
 * app.js probes the candidates in order at boot, so both setups work
 * without editing any file.
 */

const APP_NAME = 'SmritiSaathi Care';
const APP_TAGLINE = 'A gentle companion for memory care';
const DEFAULT_BACKEND_PORT = 5000;

function buildApiCandidates() {
  const candidates = [];
  if (typeof window !== 'undefined' && window.SMRITISAATHI_API_BASE) {
    candidates.push(String(window.SMRITISAATHI_API_BASE).replace(/\/+$/, ''));
  }
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    candidates.push(`${location.origin}/api`);
    candidates.push(`${location.protocol}//${location.hostname}:${DEFAULT_BACKEND_PORT}/api`);
  }
  candidates.push(`http://localhost:${DEFAULT_BACKEND_PORT}/api`);
  return [...new Set(candidates)];
}

const API_CANDIDATES = buildApiCandidates();

/** Overwritten by app.js once a candidate answers /api/health. */
let API_BASE_URL = API_CANDIDATES[0];

/** Kept as an alias because older code in this project referenced API_BASE. */
function currentApiBase() { return API_BASE_URL; }
