"use strict";
// Offline-Erkennung: lädt die offizielle TF.js-Fassung von BirdNET v2.4 EINMAL von Zenodo
// (Cornell Lab / TU Chemnitz) aufs Gerät und legt sie in Cache Storage ab. Das Modell steht unter
// einer NICHT-kommerziellen Lizenz (CC BY-NC(-SA) 4.0) — darum liegt es bewusst nicht im Git-Repo,
// sondern kommt direkt von der Originalquelle.
// Ablauf: ZIP laden (mit Fortschritt) -> SHA-256 prüfen -> nur die nötigen Dateien entpacken
// (DecompressionStream 'deflate-raw') -> in den Cache -> zuletzt Marker "installed.json".
// Fehlt der Marker, gilt das Modell als nicht installiert (abgebrochene Downloads zählen nicht).

export const MODEL_CACHE = 'waldohr-birdnet-v24';   // sw.js lässt alle 'waldohr-birdnet-*' beim Update stehen
const ZIP_URL = 'https://zenodo.org/api/records/15050749/files/BirdNET_v2.4_tfjs.zip/content';
const ZIP_BYTES = 75044113;
const ZIP_SHA256 = 'f81af091fe334b15ad3f82766b3340ed768b0a6acd274ab10e8fc32d19410655';
export const MODEL_MB = Math.round(ZIP_BYTES / 1e6);   // 75
const STORE_MB = 83;                                   // entpackt + TF.js, grob fürs UI

// Gleiche absolute URLs im Hauptthread und im Worker (der Worker bekommt sie per init-Nachricht).
export const modelBase = () => new URL('birdnet-offline/', document.baseURI).href;
export const vendorBase = () => new URL('vendor/tfjs-4.22.0/', document.baseURI).href;
const VENDOR_FILES = ['tf.min.js', 'tf-backend-wasm.min.js', 'tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm'];
const MARKER = 'installed.json';

export async function offlineModelInstalled() {
  try {
    if (!('caches' in self) || !(await caches.has(MODEL_CACHE))) return false;   // open() würde ihn leer anlegen
    const c = await caches.open(MODEL_CACHE);
    return !!(await c.match(modelBase() + MARKER));
  } catch { return false; }
}

function hex(buf) { return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join(''); }

// Minimaler ZIP-Leser (Central Directory) — genügt für das Zenodo-Archiv (deflate/stored, kein Zip64).
function zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP-Verzeichnis nicht gefunden');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [], dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP-Eintrag defekt');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    // Daten beginnen nach dem LOKALEN Header, dessen Extra-Feld anders lang sein kann.
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    out.push({ name, method, start, end: start + csize });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const TYPES = { json: 'application/json', bin: 'application/octet-stream', js: 'text/javascript', wasm: 'application/wasm', txt: 'text/plain; charset=utf-8' };
const typeOf = name => TYPES[name.split('.').pop()] || 'application/octet-stream';

// onProgress({phase:'download'|'verify'|'unpack', done, total}); signal: AbortSignal
export async function downloadOfflineModel(onProgress = () => {}, signal) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Dieser Browser kann das Modell nicht entpacken (zu alt).');
  if (!(self.crypto && crypto.subtle)) throw new Error('Sichere Verbindung (https) nötig.');
  try {
    const est = await navigator.storage?.estimate?.();
    if (est && est.quota && est.quota - est.usage < 200e6) throw new Error('Zu wenig freier Speicher auf dem Gerät (mind. 200 MB nötig).');
  } catch (e) { if (/Speicher/.test(e.message)) throw e; }

  // 1) Download mit Fortschritt in einen vorab reservierten Puffer
  const res = await fetch(ZIP_URL, { signal, cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error('Download fehlgeschlagen (HTTP ' + res.status + ')');
  const buf = new Uint8Array(ZIP_BYTES);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > ZIP_BYTES) throw new Error('Unerwartete Dateigröße — Download abgebrochen.');
    buf.set(value, got); got += value.length;
    onProgress({ phase: 'download', done: got, total: ZIP_BYTES });
  }
  if (got !== ZIP_BYTES) throw new Error('Download unvollständig (' + Math.round(got / 1e6) + ' von ' + MODEL_MB + ' MB) — bitte nochmal versuchen.');

  // 2) Echtheit prüfen: genau das veröffentlichte Zenodo-Archiv, nichts anderes
  onProgress({ phase: 'verify', done: 0, total: 1 });
  if (hex(await crypto.subtle.digest('SHA-256', buf)) !== ZIP_SHA256) throw new Error('Prüfsumme stimmt nicht — Datei beschädigt oder verändert.');

  // 3) Nur die benötigten Dateien entpacken und ablegen
  const base = modelBase();
  await caches.delete(MODEL_CACHE);           // halbfertige Reste eines früheren Versuchs weg
  const cache = await caches.open(MODEL_CACHE);
  const wanted = zipEntries(buf).filter(e => /^model\/(model\.json|group1-shard\d+of\d+\.bin|mdata\/(model\.json|group1-shard\d+of\d+\.bin))$/.test(e.name));
  if (wanted.length < 4) throw new Error('Archiv enthält das Modell nicht wie erwartet.');
  let k = 0;
  for (const e of wanted) {
    if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    let body = new Blob([buf.subarray(e.start, e.end)]).stream();
    if (e.method === 8) body = body.pipeThrough(new DecompressionStream('deflate-raw'));
    else if (e.method !== 0) throw new Error('Unbekannte ZIP-Kompression');
    await cache.put(base + e.name, new Response(body, { headers: { 'Content-Type': typeOf(e.name) } }));
    onProgress({ phase: 'unpack', done: ++k, total: wanted.length + VENDOR_FILES.length + 1 });
  }
  // TF.js (liegt im Repo) und die deutschen Artnamen ebenfalls in den Offline-Cache: der Worker liest
  // sie direkt daraus, und der Service Worker findet sie dort per caches.match() auch ohne Netz.
  const extra = VENDOR_FILES.map(f => vendorBase() + f).concat(new URL('models/birdnet/labels.txt', document.baseURI).href);
  for (const u of extra) {
    const r = await fetch(u, { signal });
    if (!r.ok) throw new Error('Datei fehlt: ' + u);
    await cache.put(u, new Response(await r.blob(), { headers: { 'Content-Type': typeOf(u) } }));
    onProgress({ phase: 'unpack', done: ++k, total: wanted.length + extra.length });
  }
  await cache.put(base + MARKER, new Response(JSON.stringify({ model: 'BirdNET_GLOBAL_6K_V2.4', sha256: ZIP_SHA256, installed: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } }));
  // Browser bitten, den Speicher nicht bei Platzmangel still zu räumen (sonst wäre das Modell im Wald plötzlich weg).
  try { await navigator.storage?.persist?.(); } catch {}
  return true;
}

export async function removeOfflineModel() { try { await caches.delete(MODEL_CACHE); } catch {} }

// ---- Einstellungen: Zeile "Offline-Erkennung" -------------------------------------------------
// onChange() wird nach Installation/Entfernen aufgerufen (app.js tauscht dann den Erkenner aus).
export function initOfflineModelSettings(onChange) {
  const stat = document.getElementById('offlineStat');
  const btn = document.getElementById('offlineBtn');
  const prog = document.getElementById('offlineProg');
  if (!stat || !btn || !prog) return;
  let ctrl = null;

  async function render() {
    prog.hidden = true;
    if (await offlineModelInstalled()) {
      stat.textContent = 'installiert (ca. ' + STORE_MB + ' MB auf dem Gerät)';
      btn.textContent = 'Entfernen'; btn.dataset.mode = 'remove';
    } else {
      stat.textContent = 'nicht installiert';
      btn.textContent = 'Herunterladen (' + MODEL_MB + ' MB)'; btn.dataset.mode = 'download';
    }
    btn.disabled = false;
  }

  btn.addEventListener('click', async () => {
    const mode = btn.dataset.mode;
    if (mode === 'cancel') { ctrl?.abort(); return; }
    if (mode === 'remove') {
      if (!confirm('Offline-Erkennung entfernen? Ohne Empfang erkennt WaldOhr dann keine Vögel mehr.')) return;
      btn.disabled = true;
      await removeOfflineModel(); await render(); onChange?.();
      return;
    }
    const cell = navigator.connection && navigator.connection.type === 'cellular';
    if (cell && !confirm('Du bist im Mobilfunknetz. Trotzdem ' + MODEL_MB + ' MB herunterladen? (Besser im WLAN)')) return;
    ctrl = new AbortController();
    btn.textContent = 'Abbrechen'; btn.dataset.mode = 'cancel';
    prog.hidden = false; prog.value = 0;
    try {
      await downloadOfflineModel(p => {
        if (p.phase === 'download') {
          prog.value = p.done / p.total * 0.9;
          stat.textContent = 'lädt … ' + Math.round(p.done / 1e6) + ' von ' + MODEL_MB + ' MB';
        } else if (p.phase === 'verify') { stat.textContent = 'prüfe Datei …'; }
        else { prog.value = 0.9 + 0.1 * p.done / p.total; stat.textContent = 'entpacke …'; }
      }, ctrl.signal);
      await render();
      stat.textContent = 'installiert — wird aktiviert …'; btn.disabled = true;
      await onChange?.();
      await render();
    } catch (e) {
      console.warn('Offline-Modell', e);
      await removeOfflineModel();
      await render();
      stat.textContent = e.name === 'AbortError' ? 'abgebrochen' : 'Fehler: ' + (e.message || e);
    } finally { ctrl = null; }
  });

  render();
}
