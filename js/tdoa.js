// Laufzeitdifferenz-Messung (TDOA) zwischen zwei Aufnahmen desselben Rufs per Kreuzkorrelation.
// Warum nötig: die Erkennungs-Zeitstempel stammen aus 3-Sekunden-Fenstern und sind damit um bis zu
// ±1500 ms unscharf — bei 343 m/s Schallgeschwindigkeit entspricht schon 1 ms rund 34 cm. Erst der
// Vergleich der ROHEN Audio-Wellenformen beider Geräte (GCC-PHAT) liefert eine Laufzeitdifferenz,
// mit der eine Peilung physikalisch überhaupt Sinn ergibt.
//
// GCC-PHAT statt einfacher Kreuzkorrelation: die Phasen-Normierung (PHAT) macht das Verfahren
// robust gegen unterschiedliche Lautstärken/Frequenzgänge der beiden Handy-Mikrofone und gegen
// Hall — es zählt nur noch, WANN die Signalanteile ankommen, nicht wie laut sie sind.

export const CORR_RATE = 16000; // gemeinsame Abtastrate für den Austausch (Nyquist 8 kHz deckt Vogelrufe ab)

// Lineare Interpolation reicht für Korrelationszwecke (kein Hörmaterial) und vermeidet einen
// asynchronen OfflineAudioContext-Umweg. Geräte laufen nativ oft mit 44100 vs. 48000 Hz.
export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(samples);
  const n = Math.floor(samples.length * toRate / fromRate);
  const out = new Float32Array(n);
  const step = fromRate / toRate;
  for (let i = 0; i < n; i++) {
    const pos = i * step, i0 = Math.floor(pos), frac = pos - i0;
    const a = samples[i0] || 0;
    const b = i0 + 1 < samples.length ? samples[i0 + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// ---- Übertragungsformat: 16-bit-PCM als Base64, klein genug für den Datenkanal ----

export function encodeSnippet(samples, fromRate) {
  const f = resampleLinear(samples, fromRate, CORR_RATE);
  const i16 = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    i16[i] = Math.round(v * 32767);
  }
  return new Uint8Array(i16.buffer);
}

export function decodeSnippet(bytes) {
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32767;
  return f;
}

export function bytesToB64(u8) {
  let s = '';
  const STEP = 0x8000; // String.fromCharCode-Argumentlimit nicht sprengen
  for (let i = 0; i < u8.length; i += STEP) s += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
  return btoa(s);
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ---- FFT (iterativ, radix-2, in-place) — bewusst ohne Fremdbibliothek ----

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wR = Math.cos(ang), wI = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1, curI = 0;
      for (let k = 0; k < half; k++) {
        const uR = re[i + k], uI = im[i + k];
        const xR = re[i + k + half], xI = im[i + k + half];
        const vR = xR * curR - xI * curI;
        const vI = xR * curI + xI * curR;
        re[i + k] = uR + vR; im[i + k] = uI + vI;
        re[i + k + half] = uR - vR; im[i + k + half] = uI - vI;
        const nR = curR * wR - curI * wI;
        curI = curR * wI + curI * wR;
        curR = nR;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// ---- 2D-Ortung aus mehreren Laufzeitdifferenzen (ab 3 Geräten) ----
//
// stations: [{x,y}] Empfänger-Positionen in Metern (lokales ebenes Koordinatensystem),
// tdoas: [{i,j,dtMs}] gemessene Differenzen "Ankunft bei Station i minus Ankunft bei Station j".
// Jede Messung definiert eine Hyperbel; gesucht ist der Punkt mit minimaler Summe der quadrierten
// Residuen. Bewusst eine robuste zweistufige Gittersuche statt Gauß-Newton: keine Startwert-/
// Konvergenzprobleme bei verrauschten Messungen, und die Zellen nahe am Optimum liefern gratis
// eine ehrliche Unsicherheits-Angabe (uncertM). sigmaMs = angenommene Messunsicherheit; Zellen
// mit Residuum <= min + (2*sigma)² pro Messung zählen zur Unsicherheits-Zone.
export function solve2D(stations, tdoas, opts = {}) {
  if (!stations || stations.length < 3 || !tdoas || tdoas.length < 2) return null;
  const sigmaMs = opts.sigmaMs ?? 20;
  const cx = stations.reduce((a, s) => a + s.x, 0) / stations.length;
  const cy = stations.reduce((a, s) => a + s.y, 0) / stations.length;
  let maxBase = 0;
  for (let a = 0; a < stations.length; a++) {
    for (let b = a + 1; b < stations.length; b++) {
      maxBase = Math.max(maxBase, Math.hypot(stations[a].x - stations[b].x, stations[a].y - stations[b].y));
    }
  }
  const R = Math.max(4 * maxBase, 300); // Suchradius um den Schwerpunkt

  const err = (x, y) => {
    let s = 0;
    for (const t of tdoas) {
      const di = Math.hypot(x - stations[t.i].x, y - stations[t.i].y);
      const dj = Math.hypot(x - stations[t.j].x, y - stations[t.j].y);
      const e = (di - dj) / 343 * 1000 - t.dtMs;
      s += e * e;
    }
    return s;
  };

  const scan = (x0, y0, half, step) => {
    let best = { e: Infinity, x: x0, y: y0 };
    for (let y = y0 - half; y <= y0 + half; y += step) {
      for (let x = x0 - half; x <= x0 + half; x += step) {
        const e = err(x, y);
        if (e < best.e) best = { e, x, y };
      }
    }
    return best;
  };

  const coarseStep = Math.max(4, R / 60);
  const coarse = scan(cx, cy, R, coarseStep);
  const fine = scan(coarse.x, coarse.y, coarseStep * 4, Math.max(0.5, coarseStep / 10));

  // Unsicherheits-Zone: alle Zellen, deren Residuum noch mit der Messunsicherheit vereinbar ist.
  // WICHTIG: bei kleinen Empfänger-Dreiecken und entfernter Quelle schneiden sich die Hyperbeln
  // sehr flach -> die Zone ist ein langes, schmales Tal ENTLANG der Blickrichtung. Die RICHTUNG
  // (von Station 0 aus gesehen) ist dann trotzdem gut bestimmt, nur die Entfernung nicht — darum
  // werden Richtungs- und Entfernungs-Unsicherheit getrennt ausgewiesen, statt beides in einen
  // nutzlos großen Radius zu stopfen.
  const tol = fine.e + tdoas.length * Math.pow(2 * sigmaMs, 2);
  const bestBearing = Math.atan2(fine.x - stations[0].x, fine.y - stations[0].y);
  const bestRange = Math.hypot(fine.x - stations[0].x, fine.y - stations[0].y);
  let uncertM = 0, dirSpread = 0, rangeMin = bestRange, rangeMax = bestRange;
  const uStep = Math.max(2, R / 60);
  for (let y = cy - R; y <= cy + R; y += uStep) {
    for (let x = cx - R; x <= cx + R; x += uStep) {
      if (err(x, y) > tol) continue;
      uncertM = Math.max(uncertM, Math.hypot(x - fine.x, y - fine.y));
      const b = Math.atan2(x - stations[0].x, y - stations[0].y);
      let db = Math.abs(b - bestBearing) * 180 / Math.PI;
      if (db > 180) db = 360 - db;
      dirSpread = Math.max(dirSpread, db);
      const rg = Math.hypot(x - stations[0].x, y - stations[0].y);
      rangeMin = Math.min(rangeMin, rg); rangeMax = Math.max(rangeMax, rg);
    }
  }

  return {
    x: fine.x, y: fine.y, residual: Math.sqrt(fine.e / tdoas.length),
    uncertM: Math.round(uncertM), dirSpreadDeg: Math.round(dirSpread),
    rangeMinM: Math.round(rangeMin), rangeMaxM: Math.round(rangeMax),
  };
}

// GCC-PHAT: liefert die Verschiebung lagMs, um die Signal b gegenüber Signal a verzögert ist —
// d.h. ein Ereignis an Position pA in a und pB in b ergibt lagMs = (pA - pB) / rate * 1000.
// opts.centerMs/halfMs schränken die Peaksuche auf den physikalisch möglichen Bereich ein (bekannte
// Fenster-Zeitversätze + maximale Schall-Laufzeit über die Basislinie) — das verhindert, dass ein
// zufälliger Nebenpeak außerhalb des Möglichen gewinnt. confidence = Hauptpeak / zweitstärkster
// Peak (mindestens 5 ms entfernt); Werte nahe 1 bedeuten "nicht eindeutig".
export function gccPhat(a, b, rate, opts = {}) {
  const centerMs = opts.centerMs ?? 0;
  const halfMs = Math.min(Math.abs(opts.halfMs ?? 1200), 2500);
  const bandLo = opts.bandLo ?? 900, bandHi = opts.bandHi ?? 7500;
  return _gccPhatImpl(a, b, rate, centerMs, halfMs, bandLo, bandHi);
}

function _gccPhatImpl(a, b, rate, centerMs, halfMs, bandLo, bandHi) {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;

  const aRe = new Float64Array(n), aIm = new Float64Array(n);
  const bRe = new Float64Array(n), bIm = new Float64Array(n);
  aRe.set(a); bRe.set(b);
  fft(aRe, aIm, false);
  fft(bRe, bIm, false);

  // Kreuzspektrum A·conj(B), PHAT-normiert, außerhalb des Vogelruf-Bands genullt (schneidet
  // Wind/Rumpeln unten und Alias-Reste oben weg).
  const cRe = new Float64Array(n), cIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const f = (k <= n / 2 ? k : n - k) * rate / n;
    if (f < bandLo || f > bandHi) continue;
    const xr = aRe[k] * bRe[k] + aIm[k] * bIm[k];
    const xi = aIm[k] * bRe[k] - aRe[k] * bIm[k];
    const mag = Math.hypot(xr, xi) || 1e-12;
    cRe[k] = xr / mag;
    cIm[k] = xi / mag;
  }
  fft(cRe, cIm, true); // Ergebnis: Korrelation über der Verschiebung (negative Lags am Array-Ende)

  const at = t => cRe[((t % n) + n) % n];
  const cSamp = Math.round(centerMs * rate / 1000);
  const hSamp = Math.round(halfMs * rate / 1000);
  let best = -Infinity, bestLag = cSamp;
  for (let t = cSamp - hSamp; t <= cSamp + hSamp; t++) {
    const v = at(t);
    if (v > best) { best = v; bestLag = t; }
  }
  const excl = Math.max(1, Math.round(rate * 0.005));
  let second = 1e-9;
  for (let t = cSamp - hSamp; t <= cSamp + hSamp; t++) {
    if (Math.abs(t - bestLag) <= excl) continue;
    const v = at(t);
    if (v > second) second = v;
  }
  // Parabel-Interpolation um den Peak für Sub-Sample-Genauigkeit
  const y0 = at(bestLag - 1), y1 = best, y2 = at(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const frac = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
  const lag = bestLag + (Math.abs(frac) < 1 ? frac : 0);

  return { lagMs: lag * 1000 / rate, confidence: best / second, peak: best };
}

// ---- GCC-PHAT im Web Worker ----
//
// Warum: die Korrelation rechnet 100–400 ms — und der Hauptthread verarbeitet gleichzeitig das
// Mikrofon (ScriptProcessor läuft dort!). Eine blockierende Korrelation kann also genau die
// Audio-Fenster zerhacken, die als Nächstes gemessen werden sollen. Der Worker wird inline aus
// einem Blob gebaut (keine eigene Datei -> kein zusätzlicher Service-Worker-Cache-Eintrag, läuft
// auch offline); die Sample-Puffer werden transferiert statt kopiert. Fällt der Worker aus
// (exotische Browser, CSP), rechnet gccPhatAsync einmalig synchron weiter wie bisher.
let _worker = null; // null = noch nicht versucht, false = nicht verfügbar
let _wNextId = 0;
const _wPending = new Map();

function _getWorker() {
  if (_worker !== null) return _worker;
  try {
    const src = fft.toString() + '\n' + _gccPhatImpl.toString() + '\n' +
      'self.onmessage = e => {' +
      '  const d = e.data;' +
      '  try {' +
      '    const res = _gccPhatImpl(new Float32Array(d.a), new Float32Array(d.b), d.rate, d.centerMs, d.halfMs, d.bandLo, d.bandHi);' +
      '    self.postMessage({ id: d.id, res });' +
      '  } catch (err) { self.postMessage({ id: d.id, err: String(err) }); }' +
      '};';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    _worker = new Worker(url);
    // URL bewusst NICHT sofort revoken: das Blob-Skript wird asynchron geladen, ein sofortiges
    // revokeObjectURL kann es in manchen Browsern wegziehen. Ein URL pro Session ist kein Leck.
    _worker.onmessage = e => {
      const p = _wPending.get(e.data.id);
      if (!p) return;
      _wPending.delete(e.data.id);
      if (e.data.err) p.reject(new Error(e.data.err)); else p.resolve(e.data.res);
    };
    _worker.onerror = () => {
      for (const p of _wPending.values()) p.reject(new Error('worker error'));
      _wPending.clear();
      try { _worker.terminate(); } catch {}
      _worker = false; // künftige Aufrufe: synchroner Fallback
    };
  } catch { _worker = false; }
  return _worker;
}

// Asynchrone Variante von gccPhat. WICHTIG: transferiert die Puffer von a und b in den Worker —
// der Aufrufer darf beide Arrays danach nicht mehr verwenden. Liefert null bei Worker-Fehlern
// mitten im Flug (selten; Puffer sind dann bereits transferiert, kein Sync-Fallback möglich).
export function gccPhatAsync(a, b, rate, opts = {}) {
  const centerMs = opts.centerMs ?? 0;
  const halfMs = Math.min(Math.abs(opts.halfMs ?? 1200), 2500);
  const bandLo = opts.bandLo ?? 900, bandHi = opts.bandHi ?? 7500;
  const w = _getWorker();
  if (!w) return Promise.resolve(_gccPhatImpl(a, b, rate, centerMs, halfMs, bandLo, bandHi));
  return new Promise((resolve, reject) => {
    const id = ++_wNextId;
    _wPending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, a: a.buffer, b: b.buffer, rate, centerMs, halfMs, bandLo, bandHi }, [a.buffer, b.buffer]);
    } catch (e) { _wPending.delete(id); reject(e); }
  }).catch(e => { console.warn('gccPhatAsync', e); return null; });
}

// ---- Kalibrier-Ton (Chirp) ----
// Lauter, obertonreicher Frequenz-Sweep 1,2 → 5 kHz (~240 ms) über einen eigenen AudioContext.
// Bewusst SÄGEZAHN statt reinem Sinus: die Obertöne machen den Ton auf den kleinen, im Mittel-/
// Hochton effizienten Handy-Lautsprechern deutlich lauter und breitbandiger (besserer Korrelations-
// peak). DynamicsCompressor + Makeup-Gain ziehen die Lautheit ans Maximum ohne hartes Clipping;
// die Hüllkurve vermeidet Knackser. Nur für die Kalibrierung, unabhängig von der Mikrofon-Engine.
export function playChirp() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const start = () => {
      const t0 = ctx.currentTime + 0.04, dur = 0.24;
      const osc = ctx.createOscillator();
      const osc2 = ctx.createOscillator(); // eine Oktave tiefer für mehr „Körper"/Pegel
      const gain = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 6; comp.ratio.value = 12; comp.attack.value = 0.002; comp.release.value = 0.1;
      const makeup = ctx.createGain(); makeup.gain.value = 1.5;
      osc.type = 'sawtooth'; osc2.type = 'sawtooth';
      osc.frequency.setValueAtTime(1200, t0);
      osc.frequency.exponentialRampToValueAtTime(5000, t0 + dur - 0.02);
      osc2.frequency.setValueAtTime(600, t0);
      osc2.frequency.exponentialRampToValueAtTime(2500, t0 + dur - 0.02);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(1.0, t0 + 0.012);
      gain.gain.setValueAtTime(1.0, t0 + dur - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain); osc2.connect(gain);
      gain.connect(comp); comp.connect(makeup); makeup.connect(ctx.destination);
      osc.start(t0); osc2.start(t0); osc.stop(t0 + dur + 0.02); osc2.stop(t0 + dur + 0.02);
      osc.onended = () => { try { ctx.close(); } catch {} };
    };
    if (ctx.state === 'suspended') ctx.resume().then(start).catch(start); else start();
  } catch (e) { console.warn('chirp', e); }
}
