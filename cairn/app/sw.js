/* Cairn — service worker.
 *
 * Cache-first for the shell so the app opens instantly and works with no
 * network. The version string is the cache key: bump it and old caches are
 * dropped on activate, which is the whole upgrade story.
 */
const VERSION = "cairn-v2";
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js", "./engine.js", "./store.js",
  "./llm.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Fonts come from a CDN; everything else is same-origin shell.
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) =>
      hit || fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
