/* service-worker.js — makes the app open with no connection at all.
 * =====================================================================
 * WHAT THIS DOES
 *   - Precaches the whole application shell on install, so a cold start
 *     with zero connectivity still renders a working app.
 *   - Serves the shell cache-first (it is versioned; a new deploy busts
 *     it) and API calls network-first (fresh data when possible, the last
 *     known-good copy when not).
 *   - NEVER caches a mutation. A POST/PUT/DELETE that fails is the
 *     outbox's problem, not the cache's — quietly "succeeding" a write
 *     from cache would be a data-integrity bug.
 *
 * WHAT THIS CANNOT DO — and why the app does not pretend otherwise
 * ---------------------------------------------------------------------
 * A service worker CANNOT run a reliable alarm clock. It is started by
 * the browser in response to an event and stopped again within seconds.
 * There is no supported way for a web page to guarantee waking a phone at
 * 08:00 to say "take your medicine" when the browser is fully closed:
 *
 *   - Notification Triggers (showTrigger) is Chromium-only, still behind
 *     a flag in most builds, and was never shipped on iOS Safari.
 *   - Periodic Background Sync requires an INSTALLED PWA, is Chromium
 *     only, and the browser decides the interval — it can be hours, and
 *     it is disabled entirely when the device is on battery saver.
 *   - Push notifications would wake the device, but they need a server
 *     and an internet connection, which is exactly what we do not have.
 *   - On iOS, background execution for web apps is effectively nil.
 *
 * So this project treats reminders honestly in three tiers:
 *
 *   Tier 1 (works everywhere, implemented here)
 *     While the app is open, an in-page timer fires reminders on time,
 *     and missed doses are detected locally. This is fully reliable for
 *     the "patient is using the tablet" case this app is designed around.
 *
 *   Tier 2 (best effort, implemented here)
 *     Reminders due while the app was closed are detected and surfaced
 *     the moment it is reopened, with their real due time preserved. A
 *     dose missed overnight is caught at the next open, not lost.
 *
 *   Tier 3 (NOT possible as a web app — needs a native wrapper)
 *     Waking a closed device at an exact time. For that, this frontend
 *     should be wrapped with Capacitor and use Android's AlarmManager
 *     (setExactAndAllowWhileIdle) plus a foreground service. That wrapper
 *     can reuse this entire codebase unchanged — see README.
 * =====================================================================
 */

const SHELL_CACHE = 'smritisaathi-shell-v4';
const DATA_CACHE = 'smritisaathi-data-v1';

/* The application shell: everything needed to render offline. Chart.js and
 * Dexie are included because they are vendored locally — the app must not
 * need a CDN to start. */
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './themes.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './vendor/chart.umd.min.js',
  './vendor/dexie.min.js',
  './config.js',
  './bhashini-client.js',
  './db.js',
  './connectivity.js',
  './outbox.js',
  './local-store.js',
  './app.js',
  './realtime.js',
  './auth.js',
  './theme.js',
  './speech.js',
  './adaptive.js',
  './game-session.js',
  './games.js',
  './games-part2.js',
  './patient.js',
  './charts.js',
  './daterange.js',
  './dashboard.js',
  './dashboard-schedule.js',
  './dashboard-reports.js',
  './dashboard-analysis.js',
  './dashboard-play.js',
  './dashboard-offline.js',
  './chat.js',
];

/* GET endpoints worth keeping a last-known-good copy of, so the caregiver
 * dashboard still shows something on a dead link. */
const CACHEABLE_API = [/\/api\/patients\/[^/]+$/, /\/api\/caregiver\/patients$/, /\/api\/auth\/me$/];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // addAll is atomic — one 404 would fail the whole install and leave
    // the app with no offline shell, so add individually and report.
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[sw] could not precache', url, err && err.message); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n !== SHELL_CACHE && n !== DATA_CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle our own origin; never interfere with third parties.
  if (url.origin !== self.location.origin) return;

  // ---- MUTATIONS: never cached, never faked -------------------------
  // If this fails the app keeps the write in IndexedDB and retries. A
  // cached "success" here would be a lie the outbox could not detect.
  if (request.method !== 'GET') return;

  // ---- The live-update stream must never be cached ------------------
  if (url.pathname.endsWith('/api/events')) return;

  // ---- Health probe: always the real network ------------------------
  // Answering this from cache would report a dead link as healthy.
  if (url.pathname.endsWith('/api/health')) return;

  // ---- API reads: network first, fall back to the last good copy ----
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, url));
    return;
  }

  // ---- App shell: cache first, revalidate in the background ---------
  event.respondWith(cacheFirst(request));
});

async function networkFirst(request, url) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && CACHEABLE_API.some((re) => re.test(url.pathname))) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) {
      // Tell the app this is stale so it can label the screen honestly
      // rather than presenting old numbers as current.
      const headers = new Headers(cached.headers);
      headers.set('X-Served-From', 'sw-cache');
      return new Response(await cached.blob(), {
        status: cached.status, statusText: cached.statusText, headers,
      });
    }
    // No cached copy: a clean, parseable failure the app already handles.
    return new Response(
      JSON.stringify({ error: 'You are offline and this has not been saved on this device yet.', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json', 'X-Served-From': 'sw-offline' } }
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });

  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  if (cached) {
    network.catch(() => {});   // refresh in the background, ignore failure
    return cached;
  }

  const response = await network;
  if (response) return response;

  // A navigation with nothing cached: hand back the shell so the SPA can
  // boot and explain itself, instead of the browser's dinosaur.
  if (request.mode === 'navigate') {
    const shell = await cache.match('./index.html');
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

/* ---------------------------------------------------------------------
   BACKGROUND SYNC — a bonus, never a dependency
   Where supported (Chromium), the browser retries this when connectivity
   returns even if the tab was closed. Everywhere else, the in-page sync
   engine does the same job the moment the app is next opened.
--------------------------------------------------------------------- */
self.addEventListener('sync', (event) => {
  if (event.tag !== 'smritisaathi-sync') return;
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    // The outbox lives in the page (it needs the auth token), so ask any
    // open client to flush. With no client open, the next launch syncs.
    for (const client of clientList) client.postMessage({ type: 'FLUSH_OUTBOX' });
  })());
});

/* Notifications shown while the app is running. Tapping one focuses the
 * app rather than opening a second copy. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => 'focus' in c);
    if (existing) return existing.focus();
    if (self.clients.openWindow) return self.clients.openWindow('./');
    return null;
  })());
});
