// Service Worker — cacht die App-Shell, damit Waldohr offline startet.
const CACHE = 'waldohr-v112';
const ASSETS = [
  '.', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
  'js/app.js', 'js/ui.js', 'js/db.js', 'js/audio.js', 'js/recognizer.js', 'js/species.js', 'js/species-extra.js', 'js/gemini.js',
  'js/weather.js', 'js/route.js', 'js/alarm.js', 'js/camera.js', 'js/ornithologie.js', 'js/backup.js', 'js/pairing.js',
  'js/locate.js', 'js/tdoa.js', 'js/ar.js', 'js/chat.js', 'js/session.js', 'js/filetransfer.js', 'js/peerhub.js', 'js/vendor/jsQR.js', 'js/vendor/qrcode.mjs',
  'docs/help/lauschen-hero.png', 'docs/help/camera-zoom.png', 'docs/help/pairing-connected.png', 'docs/help/chat-window.png', 'docs/help/ar-view.png'
];

self.addEventListener('install', e => {
  // Bewusst kein cache.addAll(): das respektiert den normalen HTTP-Cache des Browsers, der bei
  // einem Update sonst eine veraltete Version in den neuen, versionierten Cache übernehmen
  // könnte — { cache: 'reload' } erzwingt pro Datei einen frischen Netzwerk-Abruf.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(url => fetch(url, { cache: 'reload' }).then(res => {
        // res.ok prüfen: fetch() lehnt nur bei Netzwerkfehlern ab, nicht bei 404/500 —
        // ohne diese Prüfung würde eine fehlerhafte Antwort dauerhaft (bis zum nächsten
        // Cache-Versionsbump) als "gültige" Datei gecacht. Lieber Install fehlschlagen
        // lassen (und retryen), als einen unvollständigen Cache stillschweigend zu übernehmen.
        if (!res.ok) throw new Error(`Precache fehlgeschlagen für ${url}: ${res.status}`);
        return c.put(url, res);
      }))))
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
      // Nur ok-Antworten cachen — sonst würde ein transienter 404/500 dauerhaft
      // (bis zum nächsten Cache-Versionsbump) als "gültige" Antwort gecacht bleiben.
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => {
      // Fallback auf die App-Shell nur bei Navigations-Requests: sonst würde ein
      // fehlgeschlagener Fetch einer Nicht-HTML-Ressource (z.B. Modell-/Labels-Datei)
      // stillschweigend HTML mit Status 200 zurückliefern, statt den Fehler durchzureichen.
      if (req.mode === 'navigate') return caches.match('index.html');
      return Response.error();
    }))
  );
});
