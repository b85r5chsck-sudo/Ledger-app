// __BUILD_ID__ is replaced by scripts/build.js on every build, so devices
// always pick up a new release.
const CACHE_VERSION = "ledger-__BUILD_ID__";

const APP_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./client-config.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

// Libraries the page loads from CDNs, cached so the app works offline.
const CDN_FILES = [
  "https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css",
  "https://cdn.tailwindcss.com",
  "https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js",
  "https://unpkg.com/docx@8.5.0/build/index.umd.js"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(APP_FILES);
    // CDN files are best effort: one failing must not block install.
    await Promise.all(CDN_FILES.map(async url => {
      try {
        const res = await fetch(new Request(url, { mode: "no-cors" }));
        await cache.put(url, res);
      } catch (e) {}
    }));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // The page itself: network first so updates show up, cache when offline.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put("./index.html", res.clone());
        return res;
      } catch (e) {
        return (await caches.match("./index.html")) || (await caches.match("./"));
      }
    })());
    return;
  }

  // Everything else (icons, CDN libraries, and anything Tailwind pulls in):
  // cache first, then network, saving what we fetch for next time.
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: url.origin === location.origin });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === "opaque")) {
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return cached || Response.error();
    }
  })());
});
