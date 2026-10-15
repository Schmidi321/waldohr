"use strict";
// Erkennungs-Schicht mit austauschbarer Engine.
//  - MockRecognizer:  liefert sofort plausible Treffer (Demo/Entwicklung).
//  - BirdNetRecognizer: Offline-Erkennung, BirdNET v2.4 direkt auf dem Handy (TF.js im Worker).
//  - ServerRecognizer:  BirdNET auf dem eigenen Server; nutzt im Funkloch das Offline-Modell.
// createRecognizer() wählt automatisch (siehe dort).
import { SPECIES, ensureSpecies } from './species.js';
import { roundCoord } from './util.js';
import { MODEL_CACHE, modelBase, vendorBase, offlineModelInstalled, nativeModelFiles } from './offline-model.js';

const WEIGHTS = [
  ['buchfink', 5], ['kohlmeise', 4], ['amsel', 4], ['rotkehlchen', 3],
  ['zaunkoenig', 2], ['buntspecht', 2], ['eisvogel', 1], ['reh', 1]
];

function rms(samples) {
  let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / samples.length);
}

// Liefert ZUFÄLLIGE Treffer — darf nie unbemerkt "echte" Funde erzeugen. Darum trägt jedes
// Ergebnis source:'mock' (app.js übernimmt r.source in den gespeicherten Fund) und die Instanz
// ein fallbackReason ('no-server' | 'invalid-url' | 'unreachable' | 'model-error'), damit die
// App dem Nutzer sagen kann, WARUM gerade nur Demo-Treffer kommen.
export class MockRecognizer {
  constructor(fallbackReason = 'no-server') { this.ready = false; this.id = 'mock'; this.fallbackReason = fallbackReason; }
  async load() { this.ready = true; return true; }

  async classify(samples) {
    if (rms(samples) < 0.012) return null;          // zu leise -> kein Treffer
    if (Math.random() < 0.45) return null;          // nicht jedes Fenster trifft
    const total = WEIGHTS.reduce((a, [, w]) => a + w, 0);
    let r = Math.random() * total, key = 'amsel';
    for (const [k, w] of WEIGHTS) { r -= w; if (r <= 0) { key = k; break; } }
    const sp = SPECIES[key];
    return { key, name: sp.name, sci: sp.sci, rarity: sp.rarity,
             confidence: +(0.74 + Math.random() * 0.24).toFixed(2), source: 'mock' };
  }
}

// Offline-Erkennung: BirdNET v2.4 läuft direkt auf dem Gerät (Web Worker js/birdnet-worker.js,
// TF.js + WASM). Das Modell lädt der Nutzer einmalig in den Einstellungen herunter (offline-model.js).
// Gemessen: ~0,2 s pro 3-s-Fenster am PC, ~0,4–0,6 s im gedrosselten Handy-Profil; Treffer identisch
// zum BirdNET-Server.
export class BirdNetRecognizer {
  constructor() {
    this.id = 'birdnet'; this.ready = false; this.busy = false;
    this.labels = []; this.minConf = 0.25;   // wie der Server-Aufruf (min_conf=0.25)
    this.sigLen = 144000;                    // 3 s @ 48 kHz (BirdNET v2.4 Audio-Eingang)
    this.worker = null; this._seq = 0; this._wait = new Map(); this._areaKey = null;
    this.backend = null;
  }

  async _loadLabels() {
    const r = await fetch('models/birdnet/labels.txt');
    if (!r.ok) throw new Error('BirdNET-Labels fehlen');
    return (await r.text()).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }

  load() {
    if (this._loading) return this._loading;   // idempotent: createRecognizer() lädt vor, app.js ruft nochmal
    this._loading = (async () => {
      this.labels = await this._loadLabels();
      const w = new Worker(new URL('./birdnet-worker.js', import.meta.url));
      this.worker = w;
      w.onmessage = e => {
        const m = e.data || {};
        if (m.type === 'ready' || (m.type === 'error' && m.op === 'init')) { const p = this._wait.get('init'); this._wait.delete('init'); p?.(m); return; }
        if (m.type === 'area') { console.info('BirdNET offline: ' + m.count + ' Arten für Ort/Woche'); return; }
        if (m.type === 'error' && m.op === 'area') { console.warn('BirdNET Range-Filter', m.message); return; }
        const p = this._wait.get(m.id); if (p) { this._wait.delete(m.id); p(m); }
      };
      w.onerror = e => { console.warn('BirdNET-Worker', e.message); };
      // App-Hülle (Capacitor): Modell liegt im Dateisystem -> Dateien hier lesen und ohne Kopie an
      // den Worker übergeben. Browser: files = null, der Worker liest selbst aus Cache Storage.
      const files = await nativeModelFiles();
      const m = await new Promise((res, rej) => {
        const to = setTimeout(() => { this._wait.delete('init'); rej(new Error('BirdNET-Modell lädt nicht (Zeitüberschreitung)')); }, 90000);
        this._wait.set('init', v => { clearTimeout(to); res(v); });
        w.postMessage({ type: 'init', cacheName: files ? null : MODEL_CACHE, files, base: modelBase(), vendor: vendorBase() },
          files ? Object.values(files) : []);
      });
      if (m.type !== 'ready') throw new Error(m.message || 'BirdNET-Modell nicht nutzbar');
      this.backend = m.backend;
      console.info('BirdNET offline bereit (' + m.backend + ', ' + m.ms + ' ms)');
      this.ready = true;
      return true;
    })();
    this._loading.catch(() => { this.dispose(); });
    return this._loading;
  }

  dispose() {
    try { this.worker?.terminate(); } catch {}
    this.worker = null; this.ready = false;
    for (const p of this._wait.values()) p({ type: 'error', message: 'beendet' });
    this._wait.clear();
  }

  // Range-Filter wie auf dem Server: nur Arten, die an diesem Ort in dieser Kalenderwoche vorkommen.
  // Neu berechnet nur bei anderer 0,1°-Zelle oder Woche.
  setGeo(pos) {
    if (!this.ready || !pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return;
    const lat = roundCoord(pos.lat, 1), lon = roundCoord(pos.lng, 1), week = week48();
    const key = lat + ',' + lon + ',' + week;
    if (key === this._areaKey) return;
    this._areaKey = key;
    this.worker.postMessage({ type: 'area', lat, lon, week });
  }

  // Beliebiges 3-s-Fenster linear auf genau 144000 Samples (≈48 kHz) bringen.
  _resample(samples) {
    const dst = this.sigLen;
    if (samples.length === dst) return samples.slice();   // Kopie: wird an den Worker übergeben
    const out = new Float32Array(dst);
    const ratio = (samples.length - 1) / (dst - 1);
    for (let i = 0; i < dst; i++) {
      const x = i * ratio, i0 = x | 0, f = x - i0;
      const a = samples[i0] || 0;
      const b = (i0 + 1 < samples.length) ? samples[i0 + 1] : a;
      out[i] = a + (b - a) * f;
    }
    return out;
  }

  async classify(samples) {
    if (!this.ready || this.busy || !this.worker) return null;   // langsames Handy: Fenster überspringen statt stauen
    this.busy = true;
    try {
      const data = this._resample(samples);
      const id = ++this._seq;
      const m = await new Promise(res => {
        this._wait.set(id, res);
        this.worker.postMessage({ type: 'classify', id, samples: data }, [data.buffer]);
      });
      if (m.type !== 'result') { console.warn('birdnet classify', m.message); return null; }
      const top = (m.top || [])[0];
      if (!top || top.c < this.minConf) return null;
      const label = this.labels[top.i] || '';
      const us = label.indexOf('_');             // Format "Wissenschaftlich_Deutsch"
      const sci = us >= 0 ? label.slice(0, us) : label;
      const name = us >= 0 ? label.slice(us + 1) : label;
      if (!sci) return null;
      const key = ensureSpecies({ sci, name });
      const sp = SPECIES[key];
      return { key, name: sp.name, sci: sp.sci, rarity: sp.rarity, confidence: +top.c.toFixed(2), source: 'birdnet' };
    } finally { this.busy = false; }
  }
}

// 16-bit-PCM-Mono-WAV aus Float32-Samples bauen (fürs Hochladen ans Backend, auch für die
// automatische Aufnahme in app.js wiederverwendet).
// Optionaler meta-Parameter: { name, date, comment } → RIFF LIST/INFO chunk (INAM/ICRD/ICMT).
export function encodeWav(samples, sampleRate, meta) {
  // Baut den optionalen LIST/INFO-Chunk für Vogelname, Datum, GPS-Kommentar.
  let infoBuf = null;
  if (meta) {
    const enc = new TextEncoder();
    const fields = [];
    if (meta.name)    fields.push(['INAM', enc.encode(meta.name)]);
    if (meta.date)    fields.push(['ICRD', enc.encode(meta.date)]);
    if (meta.comment) fields.push(['ICMT', enc.encode(meta.comment)]);
    if (fields.length) {
      const subBytes = fields.reduce((a, [, b]) => a + 8 + b.length + (b.length % 2), 0);
      infoBuf = new Uint8Array(12 + subBytes); // 'LIST'(4)+size(4)+'INFO'(4)+subchunks
      const idv = new DataView(infoBuf.buffer);
      const ws4 = (o, s) => { for (let i = 0; i < 4; i++) infoBuf[o + i] = s.charCodeAt(i); };
      ws4(0, 'LIST'); idv.setUint32(4, 4 + subBytes, true); ws4(8, 'INFO');
      let o = 12;
      for (const [id, bytes] of fields) {
        ws4(o, id); o += 4;
        idv.setUint32(o, bytes.length, true); o += 4;
        infoBuf.set(bytes, o); o += bytes.length;
        if (bytes.length % 2) { infoBuf[o] = 0; o += 1; }
      }
    }
  }
  const n = samples.length, extra = infoBuf ? infoBuf.length : 0;
  const buf = new ArrayBuffer(44 + n * 2 + extra), dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 2 + extra, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); ws(36, 'data'); dv.setUint32(40, n * 2, true);
  let o = 44; for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
  if (infoBuf) new Uint8Array(buf).set(infoBuf, o);
  return new Blob([buf], { type: 'audio/wav' });
}
const week48 = () => { const d = new Date(); return d.getMonth() * 4 + Math.min(3, ((d.getDate() - 1) / 7) | 0) + 1; };

// Server-seitige Erkennung: schickt 3-s-WAV ans Python-BirdNET-Backend (echtes BirdNET).
// Mit installierter Offline-Erkennung (offline = BirdNetRecognizer) springt sie automatisch aufs
// Handy-Modell um, sobald der Server nicht antwortet (kein Empfang im Wald), und probiert den
// Server alle RETRY_MS wieder — kommt der Empfang zurück, läuft die Erkennung wieder über ihn.
const RETRY_MS = 60000;
const FAILED = Symbol('server-failed');
export class ServerRecognizer {
  constructor(url, offline = null) {
    this.url = url.replace(/\/$/, ''); this.id = 'birdnet-server'; this.ready = false; this.busy = false; this.geo = null;
    this.offline = offline; this.serverDownUntil = 0;
    // Live-Verbindungsstatus fürs Icon in der App — Server-Modus hat (anders als Mock/On-Device)
    // eine echte Netzwerkabhängigkeit, die auch NACH dem Start noch wegbrechen kann (WLAN-Hänger,
    // Server neugestartet, ...), darum bei jedem Klassifizierungsversuch neu bewertet.
    this.status = 'unknown'; // 'ok' | 'error' | 'unknown' | 'offline' (Server weg, Handy-Modell rechnet)
  }
  async load() {
    if (this.ready) return true; // idempotent: createRecognizer() prüft schon, app.js ruft load() nochmal
    try {
      // Timeout, weil createRecognizer() beim App-Start darauf wartet — ein Server, der Pakete nur
      // schluckt (WLAN ohne Internet, falsche IP), würde sonst den Boot minutenlang blockieren.
      const r = await fetch(this.url + '/health', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('BirdNET-Server nicht erreichbar');
      this.ready = true; this.status = 'ok';
      // Offline-Modell schon im Hintergrund laden, damit der Wechsel beim Funkloch sofort klappt.
      this.offline?.load().catch(e => { console.warn('Offline-Modell', e); this.offline = null; });
      return true;
    } catch (e) {
      if (!this.offline) throw e;
      console.warn('BirdNET-Server nicht erreichbar — Offline-Erkennung:', e);
      await this.offline.load();                    // wirft, wenn auch das Modell nicht geht
      this.ready = true; this.status = 'offline'; this.serverDownUntil = Date.now() + RETRY_MS;
      return true;
    }
  }
  dispose() { this.offline?.dispose(); }
  setGeo(pos) { this.geo = pos; this.offline?.setGeo(pos); }
  async classify(samples, sampleRate) {
    if (!this.ready) return null;
    const off = this.offline && this.offline.ready ? this.offline : null;
    const skipServer = off && (Date.now() < this.serverDownUntil || navigator.onLine === false);
    if (!skipServer) {
      if (this.busy) return null;                   // nur eine Anfrage gleichzeitig
      const r = await this._classifyServer(samples, sampleRate);
      if (r !== FAILED) return r;
      if (!off) return null;
      this.serverDownUntil = Date.now() + RETRY_MS;
    }
    this.status = 'offline';
    return off.classify(samples, sampleRate);
  }
  async _classifyServer(samples, sampleRate) {
    this.busy = true;
    try {
      let q = '?min_conf=0.25';
      // Nur auf 0,1° (≈ 11 km) gerundet: BirdNETs Range-Filter arbeitet ohnehin auf einem groben
      // Raster (Artenliste je Region/Woche), mehr Genauigkeit bringt keine besseren Treffer —
      // verrät dem (evtl. fremden) Server aber sonst alle 3 s den exakten Standort.
      if (this.geo && Number.isFinite(this.geo.lat) && Number.isFinite(this.geo.lng)) {
        q += `&lat=${roundCoord(this.geo.lat, 1)}&lon=${roundCoord(this.geo.lng, 1)}&week=${week48()}`;
      }
      // Timeout: bei schwachem Empfang hängt eine Anfrage sonst minutenlang und blockiert alle
      // folgenden Fenster (busy) — dann lieber als Fehler werten (und ggf. offline weiterrechnen).
      const r = await fetch(this.url + '/analyze' + q, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: encodeWav(samples, sampleRate || 48000), signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) { this.status = 'error'; return FAILED; }
      this.status = 'ok';
      const top = ((await r.json()).results || [])[0];
      if (!top) return null;
      // Server-Antwort ist fremde Eingabe: Konfidenz muss eine Zahl 0..1 sein, Namen Strings.
      const conf = +top.confidence;
      if (!Number.isFinite(conf) || conf < 0 || conf > 1) return null;
      if (typeof top.sci !== 'string' && typeof top.common !== 'string') return null;
      const key = ensureSpecies({ sci: String(top.sci ?? '').slice(0, 120), name: String(top.common ?? '').slice(0, 120) });
      const sp = SPECIES[key];
      return { key, name: sp.name, sci: sp.sci, rarity: sp.rarity, confidence: +conf.toFixed(2), source: 'birdnet-server' };
    } catch (e) { console.warn('server classify', e); this.status = 'error'; return FAILED; }
    finally { this.busy = false; }
  }
}

// Nutzer-konfigurierte Server-URL prüfen: nur https:// — oder http:// auf das eigene Gerät
// (lokaler Entwicklungs-/Heimserver). Klartext-http ins Netz würde jede 3-s-Aufnahme samt
// Standort unverschlüsselt durchs (Café-)WLAN schicken, und aus der https-PWA heraus blockt der
// Browser Mixed Content ohnehin. Gibt die normalisierte Basis-URL (ohne Query/Hash/Slash am
// Ende) zurück oder null.
export function validateServerUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.username || u.password) return null; // keine Zugangsdaten in der URL (landen sonst in Logs)
  const localHttp = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  if (u.protocol !== 'https:' && !localHttp) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

// Liefert IMMER einen Erkenner. Kann der gewünschte (Server / Offline-Modell) nicht genutzt
// werden, kommt ein MockRecognizer mit gesetztem fallbackReason zurück — app.js muss das prüfen
// (rec.id === 'mock'), statt Zufallstreffer still als echte Funde zu speichern. Darum wird der
// echte Erkenner HIER schon geladen (load() ist idempotent, der spätere Aufruf in app.js kostet
// nichts), sonst könnte nur app.js den Fehlschlag sehen und der Grund ginge verloren.
// Reihenfolge: Server (mit Offline-Modell als Ersatz im Funkloch) > nur Offline-Modell > Demo.
// localStorage 'waldohr.birdnet' = '0' schaltet das Offline-Modell zum Testen ab.
export async function createRecognizer() {
  const ls = k => { try { return (typeof localStorage !== 'undefined') ? localStorage.getItem(k) : null; } catch { return null; } };
  const offlineOk = ls('waldohr.birdnet') !== '0' && await offlineModelInstalled();
  const serverUrl = ls('waldohr.server');     // z. B. 'https://….hf.space' oder 'http://localhost:8800'
  if (serverUrl) {
    const url = validateServerUrl(serverUrl);
    if (!url) {
      console.warn('BirdNET-Server-URL abgelehnt (nur https:// oder http://localhost):', serverUrl);
      if (!offlineOk) return new MockRecognizer('invalid-url');
    } else {
      const r = new ServerRecognizer(url, offlineOk ? new BirdNetRecognizer() : null);
      try { await r.load(); return r; }
      catch (e) { console.warn('BirdNET-Server nicht erreichbar:', e); r.dispose(); return new MockRecognizer(offlineOk ? 'model-error' : 'unreachable'); }
    }
  }
  if (!offlineOk) return new MockRecognizer('no-server');
  const r = new BirdNetRecognizer();
  try { await r.load(); return r; }
  catch (e) { console.warn('BirdNET-Modell nicht nutzbar:', e); return new MockRecognizer('model-error'); }
}
