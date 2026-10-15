// Service Worker â€” cacht die App-Shell, damit Waldohr offline startet.
const CACHE = 'waldohr-v113';
const ASSETS = [
  '.', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
  'js/app.js', 'js/ui.js', 'js/db.js', 'js/audio.js', 'js/recognizer.js', 'js/species.js', 'js/species-extra.js', 'js/gemini.js',
  'js/weather.js', 'js/route.js', 'js/alarm.js', 'js/camera.js', 'js/scan.js', 'js/util.js', 'js/ornithologie.js', 'js/backup.js',
  'docs/help/camera-zoom.png',
  // Selbst gehostete Schriften (statt Google Fonts) â€” offline verfÃ¼gbar wie der Rest der App-Shell.
  'fonts/outfit-latin-500-normal.woff2', 'fonts/outfit-latin-ext-500-normal.woff2',
  'fonts/outfit-latin-600-normal.woff2', 'fonts/outfit-latin-ext-600-normal.woff2',
  'fonts/outfit-latin-700-normal.woff2', 'fonts/outfit-latin-ext-700-normal.woff2',
  'fonts/inter-latin-400-normal.woff2', 'fonts/inter-latin-ext-400-normal.woff2', 'fonts/inter-latin-400-italic.woff2',
  'fonts/inter-latin-500-normal.woff2', 'fonts/inter-latin-ext-500-normal.woff2',
  'fonts/inter-latin-600-normal.woff2', 'fonts/inter-latin-ext-600-normal.woff2'
];

self.addEventListener('install', e => {
  // Bewusst kein cache.addAll(): das respektiert den normalen HTTP-Cache des Browsers, der bei
  // einem Update sonst eine veraltete Version in den neuen, versionierten Cache Ã¼bernehmen
  // kÃ¶nnte â€” { cache: 'reload' } erzwingt pro Datei einen frischen Netzwerk-Abruf.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(url => fetch(url, { cache: 'reload' }).then(res => {
        // res.ok prÃ¼fen: fetch() lehnt nur bei Netzwerkfehlern ab, nicht bei 404/500 â€”
        // ohne diese PrÃ¼fung wÃ¼rde eine fehlerhafte Antwort dauerhaft (bis zum nÃ¤chsten
        // Cache-Versionsbump) als "gÃ¼ltige" Datei gecacht. Lieber Install fehlschlagen
        // lassen (und retryen), als einen unvollstÃ¤ndigen Cache stillschweigend zu Ã¼bernehmen.
        if (!res.ok) throw new Error(`Precache fehlgeschlagen fÃ¼r ${url}: ${res.status}`);
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
      // Nur ok-Antworten cachen â€” sonst wÃ¼rde ein transienter 404/500 dauerhaft
      // (bis zum nÃ¤chsten Cache-Versionsbump) als "gÃ¼ltige" Antwort gecacht bleiben.
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => {
      // Fallback auf die App-Shell nur bei Navigations-Requests: sonst wÃ¼rde ein
      // fehlgeschlagener Fetch einer Nicht-HTML-Ressource (z.B. Modell-/Labels-Datei)
      // stillschweigend HTML mit Status 200 zurÃ¼ckliefern, statt den Fehler durchzureichen.
      if (req.mode === 'navigate') return caches.match('index.html');
      return Response.error();
    }))
  );
});
