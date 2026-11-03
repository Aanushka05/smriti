/* ============================================================================
 * security.js — the headers, the origins, and the brute-force brake.
 *
 * Gathered in one file so the protections are reviewable together rather than
 * scattered through server.js. Everything here follows current OWASP guidance;
 * that is a claim about the practices, not a certification of any kind.
 * ==========================================================================*/

/**
 * Which origins may call this API.
 *
 * The default is same-origin only: this server serves its own frontend, so a
 * browser needs no CORS at all. `cors()` with no arguments reflects ANY origin
 * and sets Access-Control-Allow-Origin: *, which lets any website on the
 * internet make authenticated calls on a logged-in user's behalf.
 *
 * Set CORS_ORIGINS in .env only when the frontend is genuinely hosted
 * elsewhere, e.g. "https://care.example.org,https://staging.example.org".
 */
function allowedOrigins() {
  const raw = String(process.env.CORS_ORIGINS || '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function corsOptions() {
  const allowed = allowedOrigins();
  return {
    origin(origin, callback) {
      // No Origin header: same-origin, curl, a mobile shell. Always fine.
      if (!origin) return callback(null, true);
      if (allowed.includes(origin)) return callback(null, true);
      // Refuse by NOT setting the header, rather than by throwing — a throw
      // becomes a 500 and tells the caller more than a plain refusal does.
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  };
}

/**
 * Security headers on every response.
 *
 * Written by hand rather than pulling in Helmet: this is a small, auditable
 * set, and adding a dependency to set six headers is not a trade worth making
 * for an app that has to be deployable on a Raspberry Pi with no npm mirror.
 */
function securityHeaders(req, res, next) {
  // Never let a browser guess a type. Combined with a strict CSP this is what
  // stops an uploaded file being executed as script.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // No framing: this app shows patient data and must not be clickjacked.
  res.setHeader('X-Frame-Options', 'DENY');
  // Do not leak the patient's URL (which can carry an id) to other sites.
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Nothing here needs a camera, a payment handler or geolocation.
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), payment=(), usb=(), microphone=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // An API response is never a document; make caches and browsers treat it
  // that way, and never store a response that carries patient data.
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, private');
  }

  // HSTS only makes sense over TLS, and sending it over plain HTTP on
  // localhost would lock a developer's browser out of their own machine.
  if (req.secure || String(req.headers['x-forwarded-proto']).startsWith('https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

/**
 * Content-Security-Policy for the app shell.
 *
 * Kept separate from the header block above because it is the one directive
 * that has to know what the page actually loads. This app uses the Tailwind
 * play CDN and inline configuration, so 'unsafe-inline' is currently required
 * for styles and scripts — that is a real weakness and it is written down
 * rather than hidden: building Tailwind ahead of time would remove it.
 */
function contentSecurityPolicy(req, res, next) {
  if (req.path.startsWith('/api/')) return next();

  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // 'unsafe-inline'/'unsafe-eval' are needed by the Tailwind play CDN.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    // Recorded audio is played back from a data: URL.
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    // The frontend only ever talks to its own origin; Bhashini is reached
    // from the server, never from the page.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '));
  next();
}

/* ------------------------------------------------------ brute-force brake
 *
 * TWO TIERS, because the two threats are different shapes.
 *
 *   TARGETED  — someone guessing one account's password. Tight limit, keyed on
 *               the account being attacked as well as where from. This is the
 *               attack that actually breaks into a specific patient's record.
 *
 *   SPRAYING  — someone trying one password across many accounts. Loose limit,
 *               keyed on the connection alone.
 *
 * Keying only on the connection, as an earlier version did, punishes everyone
 * behind one address for one attacker — and a rural clinic, a PHC or a family
 * sharing a hotspot all look like a single address. That is a real denial of
 * service against exactly the users this app exists for.
 */
const AUTH_WINDOW_MS = Number(process.env.AUTH_RATE_WINDOW_MS) || 15 * 60 * 1000;
// Attempts against ONE account from one place.
const AUTH_MAX_PER_ACCOUNT = Number(process.env.AUTH_RATE_MAX_ACCOUNT) || 12;
// Attempts from one place across ALL accounts.
const AUTH_MAX_PER_CLIENT = Number(process.env.AUTH_RATE_MAX) || 300;

const authHits = new Map();

function clientKey(req) {
  // Behind a proxy the real address is in x-forwarded-for. Trusting that header
  // is only safe when a proxy is actually in front, hence the opt-in.
  if (String(process.env.TRUST_PROXY || '').toLowerCase() === 'true') {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Records a hit against a bucket and says whether it has gone over. */
function overLimit(key, max, now) {
  const hits = (authHits.get(key) || []).filter((t) => now - t < AUTH_WINDOW_MS);
  hits.push(now);
  authHits.set(key, hits);
  return hits.length > max;
}

function authRateLimit(req, res, next) {
  const now = Date.now();
  const client = clientKey(req);

  // Whichever account this attempt is aimed at, if any.
  const body = req.body || {};
  const target = String(body.username || body.identifier || '').trim().toLowerCase();

  if (authHits.size > 20000) {
    for (const [k, v] of authHits) if (!v.some((t) => now - t < AUTH_WINDOW_MS)) authHits.delete(k);
  }

  const targetedOver = target && overLimit(`acct:${client}|${target}`, AUTH_MAX_PER_ACCOUNT, now);
  const sprayOver = overLimit(`ip:${client}`, AUTH_MAX_PER_CLIENT, now);

  if (targetedOver || sprayOver) {
    return res.status(429).json({
      error: 'Too many attempts. Please wait a few minutes and try again.',
      code: 'RATE_LIMITED',
    });
  }
  return next();
}

/** What is switched on, for the health endpoint. Names only, never values. */
function securityStatus() {
  const origins = allowedOrigins();
  return {
    cors: origins.length ? 'allowlist' : 'same-origin only',
    corsOriginCount: origins.length,
    securityHeaders: true,
    csp: true,
    authRateLimit: {
      windowMinutes: Math.round(AUTH_WINDOW_MS / 60000),
      maxPerAccount: AUTH_MAX_PER_ACCOUNT,
      maxPerClient: AUTH_MAX_PER_CLIENT,
    },
    jwtSecretConfigured: !!process.env.JWT_SECRET,
    httpsExpectedInProduction: true,
  };
}

module.exports = {
  corsOptions, securityHeaders, contentSecurityPolicy,
  authRateLimit, securityStatus, allowedOrigins,
};
