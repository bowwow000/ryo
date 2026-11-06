// オフライン対応（アプリ本体をキャッシュ）
const VERSION = 'v1';
const CACHE = `genba-pin-${VERSION}`;
const SHELL = [
  './', './index.html', './styles.css', './app.js', './db.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './vendor/pdfjs/pdf.min.js', './vendor/pdfjs/pdf.worker.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('genba-pin-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== location.origin) return;

  // アプリ本体: キャッシュを即返しつつ裏で更新（stale-while-revalidate）
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const key = req.mode === 'navigate' ? './index.html' : req;
      const hit = await c.match(key);
      const net = fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') c.put(key, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
