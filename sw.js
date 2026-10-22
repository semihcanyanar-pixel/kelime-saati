// Kelime Saati — service worker (çevrimdışı çalışma)
const CACHE = "kelime-saati-v26";
const ASSETS = ["./", "./index.html", "./words.json", "./widget.js", "./manifest.json", "./firebase-config.js", "./icon-180.png", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: önce önbellek
  if (url.hostname.includes("fonts.g")) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
    return;
  }

  if (url.origin !== location.origin) return;

  // Kendi dosyalarımız: önce ağ (güncel kalsın), olmazsa önbellek
  e.respondWith(
    fetch(req, { cache: "no-cache" }).then(res => {   // tarayıcı önbelleğini atla, her açılışta en güncel dosya
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match("./index.html")))
  );
});
