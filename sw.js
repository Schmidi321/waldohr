// Service Worker — cacht die App-Shell, damit Waldohr offline startet.
const CACHE = 'waldohr-v15';
const ASSETS = [
  '.', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/ui.js', 'js/db.js', 'js/audio.js', 'js/recognizer.js', 'js/species.js', 'js/gemini.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return; // Fonts/CDN: normales Netz

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
