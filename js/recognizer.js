"use strict";
// Erkennungs-Schicht mit austauschbarer Engine.
//  - MockRecognizer:  liefert sofort plausible Treffer (Demo/Entwicklung).
//  - BirdNetRecognizer: echtes On-Device-Modell (BirdNET v2.4 via TensorFlow.js).
// createRecognizer() schaltet automatisch auf BirdNET, sobald das Modell unter
// models/birdnet/ liegt (sonst Mock). Erzwingen via localStorage 'waldohr.birdnet' = '1'|'0'.
import { SPECIES, ensureSpecies } from './species.js';

const WEIGHTS = [
  ['buchfink', 5], ['kohlmeise', 4], ['amsel', 4], ['rotkehlchen', 3],
  ['zaunkoenig', 2], ['buntspecht', 2], ['eisvogel', 1], ['reh', 1]
];

function rms(samples) {
  let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / samples.length);
}

export class MockRecognizer {
  constructor() { this.ready = false; this.id = 'mock'; }
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

// CDN-Quellen. WICHTIG: tfjs-tflite ist ein UMD+WASM-Paket und lässt sich NICHT als ESM
// (esm.sh) importieren -> per klassischem <script> laden (globals window.tf / window.tflite).
const TF_URL      = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4/dist/tf.min.js';
const TFLITE_URL  = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-tflite/dist/tf-tflite.min.js';
const TFLITE_WASM = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-tflite/dist/';

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('script fehlgeschlagen: ' + src));
    document.head.appendChild(s);
  });
}

export class BirdNetRecognizer {
  constructor(opts = {}) {
    this.base = opts.base || 'models/birdnet/';
    this.id = 'birdnet'; this.ready = false;
    this.model = null; this.labels = []; this.kind = null;
    this.minConf = 0.3;        // BirdNET-typische Mindest-Konfidenz
    this.sigLen = 144000;      // 3 s @ 48 kHz (BirdNET v2.4 Audio-Eingang)
  }

  async _exists(url) { try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; } catch { return false; } }

  async _loadLabels() {
    for (const f of ['labels.txt', 'labels.json']) {
      try {
        const r = await fetch(this.base + f); if (!r.ok) continue;
        if (f.endsWith('.json')) return await r.json();
        const txt = await r.text();
        return txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      } catch {}
    }
    throw new Error('BirdNET-Labels (labels.txt oder labels.json) fehlen in ' + this.base);
  }

  async load() {
    if (!(window.tf && window.tflite)) { await loadScript(TF_URL); await loadScript(TFLITE_URL); }
    const tf = window.tf; this.tf = tf;
    this.labels = await this._loadLabels();
    if (await this._exists(this.base + 'model.tflite')) {
      window.tflite.setWasmPath(TFLITE_WASM);
      this.model = await window.tflite.loadTFLiteModel(this.base + 'model.tflite');
      this.kind = 'tflite';
    } else {
      this.model = await tf.loadGraphModel(this.base + 'model.json');
      this.kind = 'graph';
    }
    // Warmup-Selbsttest: nicht unterstützte Ops (BirdNET nutzt STFT/RFFT, die das
    // TFLite-WASM nicht ausführen kann) lösen hier einen Fehler aus -> Fallback auf Mock.
    const warm = this.model.predict(tf.zeros([1, this.sigLen]));
    const wt = Array.isArray(warm) ? warm[0] : warm;
    await wt.data();
    if (wt.dispose) wt.dispose();
    this.ready = true;
    return true;
  }

  // Beliebiges 3-s-Fenster linear auf genau 144000 Samples (≈48 kHz) bringen.
  _resample(samples) {
    const dst = this.sigLen;
    if (samples.length === dst) return samples;
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
    if (!this.ready) return null;
    const tf = this.tf;
    const input = tf.tensor(this._resample(samples), [1, this.sigLen], 'float32');
    let out;
    try { out = this.model.predict(input); }
    catch (e) { input.dispose(); console.warn('birdnet predict', e); return null; }

    // Ausgabe normalisieren (Tensor | Array | benannte Map)
    let t = Array.isArray(out) ? out[0] : out;
    if (t && typeof t === 'object' && typeof t.data !== 'function') t = t[Object.keys(t)[0]];
    const logits = await t.data();
    input.dispose(); if (t.dispose) t.dispose();

    let bi = 0, bv = -Infinity;
    for (let i = 0; i < logits.length; i++) if (logits[i] > bv) { bv = logits[i]; bi = i; }
    const conf = 1 / (1 + Math.exp(-bv)); // Sigmoid auf das Top-Logit
    if (conf < this.minConf) return null;

    const label = this.labels[bi] || '';
    const us = label.indexOf('_');             // Format "Sci_Common"
    const sci = us >= 0 ? label.slice(0, us) : label;
    const name = us >= 0 ? label.slice(us + 1) : label;
    if (!sci) return null;

    const key = ensureSpecies({ sci, name });
    const sp = SPECIES[key];
    return { key, name: sp.name, sci: sp.sci, rarity: sp.rarity, confidence: +conf.toFixed(2), source: 'birdnet' };
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
export class ServerRecognizer {
  constructor(url) { this.url = url.replace(/\/$/, ''); this.id = 'birdnet-server'; this.ready = false; this.busy = false; this.geo = null; }
  async load() { const r = await fetch(this.url + '/health'); if (!r.ok) throw new Error('BirdNET-Server nicht erreichbar'); this.ready = true; return true; }
  setGeo(pos) { this.geo = pos; }
  async classify(samples, sampleRate) {
    if (!this.ready || this.busy) return null;   // nur eine Anfrage gleichzeitig
    this.busy = true;
    try {
      let q = '?min_conf=0.25';
      if (this.geo) q += `&lat=${this.geo.lat.toFixed(5)}&lon=${this.geo.lng.toFixed(5)}&week=${week48()}`;
      const r = await fetch(this.url + '/analyze' + q, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: encodeWav(samples, sampleRate || 48000)
      });
      if (!r.ok) return null;
      const top = ((await r.json()).results || [])[0];
      if (!top) return null;
      const key = ensureSpecies({ sci: top.sci, name: top.common });
      const sp = SPECIES[key];
      return { key, name: sp.name, sci: sp.sci, rarity: sp.rarity, confidence: +(+top.confidence).toFixed(2), source: 'birdnet-server' };
    } catch (e) { console.warn('server classify', e); return null; }
    finally { this.busy = false; }
  }
}

export async function createRecognizer() {
  const ls = k => (typeof localStorage !== 'undefined') ? localStorage.getItem(k) : null;
  const serverUrl = ls('waldohr.server');     // z. B. 'http://localhost:8800'
  if (serverUrl) return new ServerRecognizer(serverUrl);
  const force = ls('waldohr.birdnet');
  if (force === '0') return new MockRecognizer();
  if (force === '1') return new BirdNetRecognizer();
  // .tflite läuft nicht im Browser (STFT/RFFT) → nur ein TF.js-GraphModel auto-aktivieren.
  try {
    const r = await fetch('models/birdnet/model.json', { method: 'HEAD' });
    if (r.ok) return new BirdNetRecognizer();
  } catch {}
  return new MockRecognizer();
}
