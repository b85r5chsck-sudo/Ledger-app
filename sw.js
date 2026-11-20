// Kitchen Ledger offline support.
//
// Each build is one "release": scripts/build.js replaces __BUILD_ID__ with a
// hash of the built files, so any change to the page, settings or icons
// gives a new worker. A new release is only used once all of its files are
// cached, and the page and its settings always come from the same release.

const CACHE_PREFIX = "kitchen-ledger:" + self.registration.scope + ":";
const CACHE_NAME = CACHE_PREFIX + "__BUILD_ID__";
const FONT_CACHE = CACHE_PREFIX + "fonts";

const APP_FILES = [
  "./",
  "./client-config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png"
];

// The page has its libraries built in; only the fonts come from outside.
const FONT_CSS = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap";
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache: "reload" skips the browser's HTTP cache, so every file is this release's.
    // addAll fails as a whole, so a half-cached release is never used.
    await cache.addAll(APP_FILES.map(u => new Request(u, { cache: "reload" })));
    try {
      const fonts = await caches.open(FONT_CACHE);
      if (!(await fonts.match(FONT_CSS))) await fonts.put(FONT_CSS, await fetch(new Request(FONT_CSS, { mode: "no-cors" })));
    } catch (e) { /* fonts are optional: the page falls back to system fonts */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Only this app's own older releases, never other apps' caches on the same site.
    await Promise.all(keys
      .filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME && k !== FONT_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isAppEntry(url) {
  const scope = new URL(self.registration.scope);
  return url.origin === scope.origin &&
    (url.pathname === scope.pathname || url.pathname === scope.pathname + "index.html");
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // The app page: always the installed release, so it matches its settings and
  // works offline. A new release reaches devices through a new worker.
  if (req.mode === "navigate" && isAppEntry(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match("./");
      if (cached) return cached;
      return fetch(req); // first visit, before the worker has finished installing
    })());
    return;
  }

  // This release's own files.
  if (url.origin === location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(req, { ignoreSearch: true })) || fetch(req);
    })());
    return;
  }

  // Fonts: cache first, saving what loads for next time.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") {
        event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      }
      return res;
    })());
  }
});
