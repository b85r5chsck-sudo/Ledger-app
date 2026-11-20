// Kitchen Ledger offline support.
//
// Each build is one "release": scripts/build.js fills in the release id (a
// hash of the built files) and the file list below, so any change to the page,
// settings or icons gives a new worker. A release is only used once all of its files are
// cached and checked, and an open page always stays on one release.

const CACHE_PREFIX = "kitchen-ledger:" + self.registration.scope + ":";
const CACHE_NAME = CACHE_PREFIX + "__BUILD_ID__";
const FONT_CACHE = CACHE_PREFIX + "fonts-v2"; // v2: only successful responses are kept

// Every file this release caches, with its SHA-256, filled in by
// scripts/build.js. A download that doesn't match (for example a deploy that
// changed mid-install) fails the install, and the browser tries again later.
const APP_FILES = __ASSETS__;

// The page has its libraries built in; only the fonts come from outside.
// They are cached as they load, never as part of an install.
const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

async function sha256(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, "0")).join("");
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const fetched = await Promise.all(Object.keys(APP_FILES).map(async url => {
      const res = await fetch(new Request(url, { cache: "reload" }));
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      if ((await sha256(await res.clone().arrayBuffer())) !== APP_FILES[url]) throw new Error(`${url}: not this release`);
      return [url, res];
    }));
    // Only cached once every file has arrived and checked out, so a release
    // is either complete or not there at all.
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(fetched.map(([url, res]) => cache.put(url, res)));
    // No skipWaiting: an open app keeps its release until every window is
    // closed, so a page never mixes two releases. The next launch is new.
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Only this app's own older releases, never other apps' caches on the same site.
    await Promise.all(keys
      .filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME && k !== FONT_CACHE)
      .map(k => caches.delete(k)));
    // The site's first web releases used "ledger-…" cache names with no scope.
    // Remove one only when it is clearly this app's: it holds this scope's
    // page, and every file from this site in it is inside this scope.
    const scope = self.registration.scope;
    await Promise.all(keys.filter(k => k.startsWith("ledger-")).map(async k => {
      const local = (await (await caches.open(k)).keys()).map(r => r.url).filter(u => new URL(u).origin === location.origin);
      const hasPage = local.some(u => u === scope || u === scope + "index.html");
      if (hasPage && local.every(u => u.startsWith(scope))) await caches.delete(k);
    }));
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
      if (cached && cached.ok) return cached;
      if (cached) event.waitUntil(cache.delete(req).catch(() => {})); // never reuse a failed load
      // CORS mode so the status can be checked: only a real success is kept,
      // and a failed load is simply tried again next time.
      const res = await fetch(req.mode === "no-cors" ? new Request(req.url, { mode: "cors", credentials: "omit" }) : req);
      if (res.ok) {
        event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      }
      return res;
    })());
  }
});
