// Service Worker — cacht die App-Shell, damit Waldohr offline startet.
const CACHE = 'waldohr-v19';
const ASSETS = [
  '.', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
  'js/app.js', 'js/ui.js', 'js/db.js', 'js/audio.js', 'js/recognizer.js', 'js/species.js', 'js/species-extra.js', 'js/gemini.js'
];

self.addEventListener('install', e => {
  // Bewusst kein cache.addAll(): das respektiert den normalen HTTP-Cache des Browsers, der bei
  // einem Update sonst eine veraltete Version in den neuen, versionierten Cache übernehmen
  // könnte — { cache: 'reload' } erzwingt pro Datei einen frischen Netzwerk-Abruf.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(url => fetch(url, { cache: 'reload' }).then(res => c.put(url, res)))))
      .then(() => self.skipWaiting())
  );
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
