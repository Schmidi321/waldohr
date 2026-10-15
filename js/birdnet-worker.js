"use strict";
// Offline-Erkennung: BirdNET v2.4 (offizielle TF.js-Fassung von Zenodo) in einem Web Worker, damit
// die ~0,2–1 s Rechenzeit pro 3-s-Fenster die Oberfläche nicht ruckeln lässt.
// Modell-Dateien liegen in Cache Storage (offline-model.js lädt sie einmalig herunter), TF.js selbst
// liegt unter vendor/ und wird ebenfalls aus diesem Cache gelesen — so läuft alles ohne Netz, auch
// wenn ein Browser den Worker nicht über den Service Worker leitet.
//
// Nachrichten:  init {cacheName, files?, base, vendor} -> ready {backend, ms} | error {message}
//               area {lat, lon, week}          -> area {count}
//               classify {id, samples}         -> result {id, top:[{i, c}]}

const SIG_LEN = 144000;          // 3 s @ 48 kHz
const AREA_MIN = 0.03;           // Range-Filter-Schwelle wie birdnetlib (sf_thresh) auf dem Server
let tf = null, cache = null, cfg = null, model = null, meta = null, allowed = null;

// TF.js-/WASM-Datei aus dem Offline-Cache als blob:-URL — fällt aufs Netz zurück, falls (noch) nicht drin.
async function cachedUrl(name, type) {
  const url = new URL(name, cfg.vendor).href;
  const hit = cache && await cache.match(url);
  if (!hit) return url;
  return URL.createObjectURL(new Blob([await hit.arrayBuffer()], { type }));
}
// fetch-Ersatz für tf.loadLayersModel/loadGraphModel: liest Modell-Dateien nur aus dem Cache —
// bzw. in der App-Hülle aus den mitgeschickten Puffern (cfg.files, je Datei einmal verbraucht).
async function cacheFetch(u) {
  u = String(u);
  if (cfg.files) {
    const name = u.startsWith(cfg.base) ? u.slice(cfg.base.length) : u;
    const buf = cfg.files[name];
    if (buf) { delete cfg.files[name]; return new Response(buf); }
  } else {
    const hit = cache && await cache.match(u);
    if (hit) return hit;
  }
  return new Response(null, { status: 404, statusText: 'nicht im Offline-Speicher: ' + u });
}

// --- Schnelle STFT ---------------------------------------------------------------------------
// tf.signal.stft rechnet die FFT als O(n²)-DFT (~15 s pro Fenster) — hier eine Radix-2-FFT in JS.
// Wie im Original-Layer (tf.cast complex->float32) zählt NUR der Realteil; geprüft: identische
// Treffer und Konfidenzen wie der BirdNET-Server.
const plans = new Map();
function plan(N) {
  let p = plans.get(N); if (p) return p;
  const bits = Math.log2(N) | 0, rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
  const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); // periodisches Hann wie tf.signal.hannWindow
  p = { rev, cos, sin, win, re: new Float64Array(N), im: new Float64Array(N) }; plans.set(N, p); return p;
}
function stftReal(x, N, step) {
  const { rev, cos, sin, win, re, im } = plan(N), bins = N / 2 + 1;
  const frames = Math.floor((x.length - N) / step) + 1, out = new Float32Array(frames * bins);
  for (let f = 0; f < frames; f++) {
    const o = f * step;
    for (let i = 0; i < N; i++) { const j = rev[i]; re[j] = x[o + i] * win[i]; im[j] = 0; }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, tstep = N / size;
      for (let s = 0; s < N; s += size) {
        for (let k = 0, t = 0; k < half; k++, t += tstep) {
          const a = s + k, b = a + half, wr = cos[t], wi = sin[t];
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
    out.set(re.subarray(0, bins), f * bins);
  }
  return { data: out, frames, bins };
}

function defineMelLayer() {
  // Nachbau des Keras-Custom-Layers aus BirdNET (Parameter kommen aus model.json).
  class MelSpecLayerSimple extends tf.layers.Layer {
    constructor(c) {
      super(c);
      this.frameStep = c.frameStep; this.frameLength = c.frameLength; this.specShape = c.specShape;
      this.melFilterbank = tf.tensor2d(c.melFilterbank);
    }
    build(s) {
      this.magScale = this.addWeight('magnitude_scaling', [], 'float32', tf.initializers.constant({ value: 1.23 }));
      super.build(s);
    }
    computeOutputShape(s) { return [s[0], this.specShape[0], this.specShape[1], 1]; }
    call(inputs) {
      return tf.tidy(() => {
        const x = inputs[0], B = x.shape[0], L = x.shape[1], all = x.dataSync(), specs = [];
        for (let b = 0; b < B; b++) {
          const src = all.subarray(b * L, (b + 1) * L);
          let mn = Infinity, mx = -Infinity;
          for (let i = 0; i < L; i++) { const v = src[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
          const xs = new Float32Array(L), d = (mx - mn) + 0.000001;   // auf -1..1 normieren (wie Original)
          for (let i = 0; i < L; i++) xs[i] = ((src[i] - mn) / d - 0.5) * 2.0;
          const r = stftReal(xs, this.frameLength, this.frameStep);
          let spec = tf.matMul(tf.tensor2d(r.data, [r.frames, r.bins]), this.melFilterbank);
          spec = spec.pow(2.0);
          spec = spec.pow(tf.div(1.0, tf.add(1.0, tf.exp(this.magScale.read()))));
          spec = tf.transpose(tf.reverse(spec, -1));
          specs.push(spec.expandDims(-1));
        }
        return tf.stack(specs);
      });
    }
    static get className() { return 'MelSpecLayerSimple'; }
  }
  tf.serialization.registerClass(MelSpecLayerSimple);
}

async function init(msg) {
  const t0 = Date.now();
  cfg = msg;
  // App-Hülle: kein Cache Storage nötig (TF.js eingebaut, Modell kommt als cfg.files).
  cache = (msg.cacheName && self.caches) ? await caches.open(msg.cacheName) : null;
  importScripts(await cachedUrl('tf.min.js', 'text/javascript'));
  importScripts(await cachedUrl('tf-backend-wasm.min.js', 'text/javascript'));
  tf = self.tf;
  tf.wasm.setWasmPaths({
    'tfjs-backend-wasm.wasm': await cachedUrl('tfjs-backend-wasm.wasm', 'application/wasm'),
    'tfjs-backend-wasm-simd.wasm': await cachedUrl('tfjs-backend-wasm-simd.wasm', 'application/wasm'),
    // Threads gibt es nur mit crossOriginIsolated (GitHub Pages: nein) — Eintrag nur der Vollständigkeit halber.
    'tfjs-backend-wasm-threaded-simd.wasm': await cachedUrl('tfjs-backend-wasm-simd.wasm', 'application/wasm'),
  });
  // WASM ist auf Handys am schnellsten und berechenbar; WebGL/CPU nur als Notnagel.
  let ok = false;
  for (const b of ['wasm', 'webgl', 'cpu']) { try { if (await tf.setBackend(b)) { await tf.ready(); ok = true; break; } } catch {} }
  if (!ok) throw new Error('Keine TF.js-Rechenart verfügbar');
  defineMelLayer();
  model = await tf.loadLayersModel(cfg.base + 'model/model.json', { fetchFunc: cacheFetch });
  const w = model.predict(tf.zeros([1, SIG_LEN])); await w.data(); w.dispose();  // Warmup
  return { backend: tf.getBackend(), ms: Date.now() - t0 };
}

// Range-Filter: welche Arten kommen an diesem Ort in dieser Woche plausibel vor (BirdNET-Meta-Modell).
async function area({ lat, lon, week }) {
  if (!meta) meta = await tf.loadGraphModel(cfg.base + 'model/mdata/model.json', { fetchFunc: cacheFetch });
  const inp = tf.tensor2d([[lat, lon, week]]);
  const out = meta.predict(inp);
  const scores = await out.data(); inp.dispose(); out.dispose();
  allowed = new Uint8Array(scores.length);
  let n = 0; for (let i = 0; i < scores.length; i++) if (scores[i] >= AREA_MIN) { allowed[i] = 1; n++; }
  return { count: n };
}

async function classify({ samples }) {
  const inp = tf.tensor2d(samples, [1, SIG_LEN]);
  const out = model.predict(inp);
  const p = await out.data(); inp.dispose(); out.dispose();   // Ausgang ist schon Sigmoid
  const top = [];
  for (let i = 0; i < p.length; i++) {
    if (allowed && !allowed[i]) continue;
    if (p[i] >= 0.1) top.push({ i, c: p[i] });
  }
  top.sort((a, b) => b.c - a.c);
  return { top: top.slice(0, 5) };
}

// Nachrichten strikt nacheinander abarbeiten (classify während init/area würde sonst ins Leere laufen).
let queue = Promise.resolve();
self.onmessage = e => {
  const msg = e.data || {};
  queue = queue.then(async () => {
    try {
      if (msg.type === 'init') self.postMessage({ type: 'ready', ...(await init(msg)) });
      else if (msg.type === 'area') self.postMessage({ type: 'area', ...(await area(msg)) });
      else if (msg.type === 'classify') self.postMessage({ type: 'result', id: msg.id, ...(await classify(msg)) });
    } catch (err) {
      self.postMessage({ type: 'error', id: msg.id, op: msg.type, message: String(err && err.message || err) });
    }
  });
};
