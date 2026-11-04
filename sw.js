// Bewaart alleen de app zelf (HTML, CSS, JS, iconen), zodat hij snel opent.
// Gegevens van GitHub en Bitvavo gaan nooit via deze cache: die worden altijd vers opgehaald.
const VERSION = "meekijk-v8";
const SHELL = ["./", "index.html", "style.css", "app.js?v=8", "style.css?v=8", "core.js?v=8", "market.js?v=8", "vendor/lightweight-charts.mjs?v=8", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // API's: niet aankomen
  // Eerst het netwerk (nieuwe versie direct zichtbaar), bij geen verbinding de bewaarde versie.
  // "no-cache": altijd bij GitHub navragen of er een nieuwere versie is (anders tot 10 minuten de oude).
  e.respondWith(fetch(new Request(e.request.url, { cache: "no-cache", credentials: "same-origin" })).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match("index.html"))));
});
