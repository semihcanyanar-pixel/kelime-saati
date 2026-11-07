// Kelime Saati — service worker (çevrimdışı çalışma)
const CACHE = "kelime-saati-v43";
const ASSETS = ["./", "./index.html", "./words.json", "./kaliplar.json", "./widget.js", "./manifest.json", "./firebase-config.js", "./icon-180.png", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png"];

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

  // Google Fonts, Firebase SDK (sürümlü adres) ve Unsplash görselleri: önce önbellek, çevrimdışı da çalışsın
  if (url.hostname.includes("fonts.g") || url.hostname === "images.unsplash.com" ||
      (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  if (url.origin !== location.origin) return;

  // Kendi dosyalarımız: önce ağ (güncel kalsın); 4 sn'de cevap gelmezse ya da ağ yoksa önbellek
  // Önbellek anahtarı sorgusuz adres (?w=kelime gibi her bağlantı ayrı kayıt oluşturmasın)
  const key = url.search ? new Request(url.origin + url.pathname) : req;
  const cached = () => caches.match(key, { ignoreSearch: true });
  const net = fetch(req, { cache: "no-cache" }).then(res => {   // tarayıcı önbelleğini atla, her açılışta en güncel dosya
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  });
  e.waitUntil(net.catch(() => {}));
  e.respondWith((async () => {
    try {
      const slow = new Promise(r => setTimeout(r, 4000)).then(cached);
      return (await Promise.race([net, slow])) || await net;
    } catch (err) {
      return (await cached()) || (await caches.match("./index.html")) || Response.error();
    }
  })());
});
