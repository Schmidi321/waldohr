// Richtungs-Scan mit EINEM Handy: findet grob, aus welcher Richtung ein Ruf kommt.
//
// Prinzip (Körperschatten): Handy flach vor die Brust, Oberkante nach vorn, langsam im Kreis drehen.
// Der Oberkörper schirmt Schall von HINTEN ab — bei Vogelstimmen (2–9 kHz) 5–15 dB. Pegel im
// Vogelband + Kompass-Blickrichtung → die lauteste Richtung zeigt grob zur Quelle (realistisch
// ±30–45°, ehrlich als "grobe Richtung" kommuniziert, dafür sofort und ohne Zubehör).
//
// Knackpunkt Gesangspausen: Strophen 1,5–3 s, Pausen 2–6 s, ein 15°-Sektor wird pro Runde nur ~0,8 s
// angeschaut. Ein naiver Pegel je Sektor misst darum v.a., OB der Vogel gerade sang — und meldete in
// der Simulation auch bei richtungsloser Quelle stets "deutlich". Deshalb:
//  1. Nur Frames, in denen der Sänger aktiv ist, zählen (Pegel ≥ ACT_DB über laufendem Rauschboden
//     oder tonale Spitze im Teilband; breitbandige Böen/Rascheln und Ausklingen zählen nicht).
//  2. Aktive Frames → 125-ms-"Ticks" → Strophen ("Segmente"). Lautstärke-Unterschiede ZWISCHEN
//     Strophen (Vogel dreht den Kopf) sind Störgröße, keine Richtung — das Modell schätzt sie mit.
//  3. Richtung aus robuster Kosinus-Anpassung L(θ) = a + X·cos θ + Y·sin θ über zwei Wege (zwischen
//     den Strophen + Pegelverlauf INNERHALB jeder Strophe beim Weiterdrehen) → echte Signifikanz z²
//     statt eines Kontrasts, den Zufall genauso erzeugt. Schwellen per Simulation kalibriert.
//  4. Ohne Ruf-Daten aus mindestens MIN_BINS von 12 Richtungen (30°) gibt es kein Ergebnis.

const SECTOR_DEG = 15, SECTORS = 360 / SECTOR_DEG, DEG = Math.PI / 180;
const BANDS = [[1500, 10000], [1500, 2600], [2600, 4200], [4200, 6600], [6600, 10000]];
const DIRS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const TICK_S = 0.125;        // Bündelung ~ Silbenlänge: Ticks grob unabhängig, egal bei welcher Bildrate
const ACT_DB = 6;            // so weit über dem Rauschboden gilt ein Band als "Sänger aktiv"
const TONAL_DB = 15;         // Spitze über Band-Median: reines Rauschen schafft das praktisch nie
const FLOOR_RISE = 1;        // dB/s — Boden steigt langsam, damit eine 3-s-Strophe ihn nicht "hochzieht"
const FLOOR_FALL_S = 0.25;   // fällt schnell, aber nicht sprunghaft (ein Ausreißer-Frame reißt ihn nicht runter)
const PEAK_DROP = 20;        // dB unter dem jüngsten Spitzenpegel zählt nicht mehr (Aus-/Nachklingen)
const PEAK_FALL = 6;         // dB/s — so schnell vergisst der Spitzenpegel-Merker
const SEG_GAP_S = 0.5;       // längere Lücke = neue Strophe
const SEG_SPAN_DEG = 90;     // durchgehender Sänger: spätestens alle 90° neues Segment, sonst gäbe es nur eines
const MAX_TICKS = 2000;      // ~4 min Gesang je Band; ältere fallen raus (Auswertung bleibt so < ~5 ms Desktop)
const MIN_BINS = 8;          // von 12 Richtungen à 30° müssen so viele Ruf-Daten haben
const MIN_SEGS = 4;
const SIG_S_PRIOR = 2;       // dB — Mindest-Streuung zwischen Strophen (falls die Daten zufällig weniger zeigen)
const SS_DOF_LOSS = 2;       // Freiheitsgrad-Abzug bei der Strophen-Streuung (s. _fit)
const W_INFL = 2;            // benachbarte Ticks hängen zusammen (Silben, Glättung): ohne Aufschlag war z² ~2× zu optimistisch
const SIG_W_MIN = 1;         // dB — sonst wird ein sehr gleichmäßiger Ton überempfindlich
const HUBER = 2.5;           // Ausreißer-Grenze in σ (s. _fit)
const C_PRIOR = 2;           // dB/s — Crescendo innerhalb der Strophe (z.B. Buchfink) als Störgröße, leicht gebremst
const Z2_OK = 8;             // z² (2 Freiheitsgrade), kalibriert: richtungslose Quelle ~1–2 % (auch bei ±4 dB Strophen-Schwankung)
const Z2_GOOD = 16;          // z ≈ 4 → Peilungs-Streuung ~15°, daher "deutlich" = ±30°
const AMP_GOOD = 1.5;        // dB halbe Vorne-hinten-Differenz für "deutlich"

let _el = null, _canvas = null, _raf = null, _evalTimer = null, _session = 0;
let _ctx = null, _ownCtx = false, _stream = null, _ownStream = false, _src = null, _an = null, _spec = null;
let _heading = null, _headingAbsolute = true, _sawAbs = false, _lockAbs = null, _orientHandler = null;
let _bands = null, _segCounter = 0, _lastT = null, _lastActT = -1e9, _nowT = 0, _live = null;
let _ev = null, _result = null, _mode = 'intro', _species = '', _engine = null, _enoughNotified = false;

// ---- Kompass --------------------------------------------------------------------------------
// Beide Ereignisse abonnieren: Android liefert den echten Kompass als deviceorientationabsolute,
// Handys ohne Magnetometer nur relatives deviceorientation (dann ohne Himmelsrichtungen, aber die
// relative Führung "nach links/rechts drehen" funktioniert trotzdem). Absolute Daten haben Vorrang;
// nach dem Start wird die Art festgeschrieben, sonst springt der Bezug mitten im Scan.
async function _startCompass(tok) {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return 'denied'; } catch { return 'denied'; }
  }
  if (tok !== _session) return 'stale';
  _sawAbs = false; _lockAbs = null; _heading = null;
  _orientHandler = e => {
    let h = null, abs = false;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) { h = e.webkitCompassHeading; abs = true; }
    else if (typeof e.alpha === 'number') { h = (360 - e.alpha) % 360; abs = e.type === 'deviceorientationabsolute' || e.absolute === true; }
    if (h == null) return;
    if (_lockAbs != null ? abs !== _lockAbs : (_sawAbs && !abs)) return;
    if (abs && !_sawAbs) { _sawAbs = true; _heading = null; }   // Wechsel relativ → absolut: nicht ineinander filtern
    _headingAbsolute = abs;
    // Leichter zirkulärer Tiefpass: genug gegen Zittern, aber wenig Verzögerung — sonst landen die
    // Pegel beim Drehen im falschen Sektor.
    _heading = _heading == null ? h : (_heading + (((h - _heading + 540) % 360) - 180) * 0.35 + 360) % 360;
  };
  window.addEventListener('deviceorientationabsolute', _orientHandler, { passive: true });
  window.addEventListener('deviceorientation', _orientHandler, { passive: true });
  return 'ok';
}
function _stopCompass() {
  if (_orientHandler) for (const t of ['deviceorientationabsolute', 'deviceorientation']) window.removeEventListener(t, _orientHandler);
  _orientHandler = null; _heading = null;
}

// ---- Audio ----------------------------------------------------------------------------------
// Läuft das Lauschen schon, wird dessen Mikrofon mitbenutzt (zwei gleichzeitige Mikrofon-Zugriffe
// verträgt v.a. iOS nicht); sonst ein eigener, unverarbeiteter Zugriff. Automatische Pegelregelung
// MUSS aus sein, sie würde genau die Lautstärkeunterschiede glattbügeln, die gemessen werden.
// Gibt ein lokales Objekt zurück statt globale Variablen zu setzen: wird der Scan während des
// (langsamen) getUserMedia geschlossen, kann der Aufrufer den Zugriff sauber wieder freigeben.
async function _startAudio(engine) {
  const a = {};
  if (engine?.running && engine.ctx && engine.stream && engine.ctx.state !== 'closed') {
    a.ctx = engine.ctx; a.stream = engine.stream; a.ownCtx = false; a.ownStream = false;
  } else {
    a.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    a.ownStream = true;
    try { a.ctx = new (window.AudioContext || window.webkitAudioContext)(); a.ownCtx = true; }
    catch (e) { a.stream.getTracks().forEach(t => t.stop()); throw e; }
  }
  try {
    if (a.ctx.state === 'suspended') await a.ctx.resume();
    a.src = a.ctx.createMediaStreamSource(a.stream);
    a.an = a.ctx.createAnalyser();
    a.an.fftSize = 2048; a.an.smoothingTimeConstant = 0.5;
    a.src.connect(a.an);
  } catch (e) { _releaseAudio(a); throw e; }
  return a;
}
function _releaseAudio(a) {
  try { a.src?.disconnect(); } catch {}
  if (a.ownStream && a.stream) a.stream.getTracks().forEach(t => t.stop());
  if (a.ownCtx && a.ctx) { try { a.ctx.close(); } catch {} }
}
function _stopAudio() {
  _releaseAudio({ src: _src, stream: _stream, ctx: _ctx, ownStream: _ownStream, ownCtx: _ownCtx });
  _src = _an = _spec = _ctx = _stream = null;
}
// Das Lauschen (Dauerüberwachung, Nacht-Modus) kann das geteilte Mikrofon jederzeit beenden; dann
// käme nur noch Stille an und der Scan würde "−120 dB" als Messwerte sammeln.
function _micDead() {
  if (!_ctx || _ctx.state === 'closed') return true;
  const tr = _stream?.getAudioTracks?.() || [];
  return tr.length > 0 && tr.every(t => t.readyState === 'ended');
}

// Je Teilband: Leistungssumme (dB) und ob ein tonaler Spitzenwert drinsteckt (das Gesamtband erbt
// die Aktivität seiner Teilbänder — sein eigener Median wäre bei Straßenlärm-Gefälle über 2,7
// Oktaven nicht aussagekräftig).
function _measure() {
  _an.getFloatFrequencyData(_spec);
  const hz = _ctx.sampleRate / _an.fftSize;
  return BANDS.map(([lo, hi], b) => {
    const i0 = Math.max(1, Math.floor(lo / hz)), i1 = Math.min(_spec.length, Math.ceil(hi / hz));
    let p = 0, peak = -200;
    for (let i = i0; i < i1; i++) { const v = Math.max(-200, _spec[i]); p += 10 ** (v / 10); if (v > peak) peak = v; }
    const s = b > 0 ? _spec.slice(i0, i1).sort() : null;
    return { lv: p > 0 ? 10 * Math.log10(p) : -120, tonal: !!s && peak - Math.max(-200, s[s.length >> 1]) >= TONAL_DB };
  });
}

// ---- Messung ----------------------------------------------------------------------------------
function _resetData() {
  _bands = BANDS.map(() => ({ floor: null, peak: -Infinity, tick: { t0: null, f: 0, n: 0, y: 0, snr: 0, c: 0, s: 0 }, ticks: [], segId: -1, segT: -1e9, segH0: 0 }));
  _ev = null; _result = null; _lastT = null; _lastActT = -1e9; _live = null; _enoughNotified = false;
}
function _angDist(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }

// Ein Analyser-Frame: Rauschboden nachführen (zeitbasiert über dt, damit 30 und 120 fps gleich
// reagieren), aktive Frames in den laufenden Tick sammeln, fertige Ticks den Strophen zuordnen.
function _ingest(m, heading, t, dt) {
  const hc = Math.cos(heading * DEG), hs = Math.sin(heading * DEG), snrs = [];
  let loud = 0;
  for (let b = 0; b < BANDS.length; b++) {
    const B = _bands[b], lv = m[b].lv;
    if (B.floor == null) B.floor = lv;
    else if (lv < B.floor) B.floor += (lv - B.floor) * (1 - Math.exp(-dt / FLOOR_FALL_S));
    else B.floor += Math.min(lv - B.floor, FLOOR_RISE * dt);
    snrs[b] = lv - B.floor;
    if (b > 0 && snrs[b] >= ACT_DB) loud++;
  }
  // Rascheln, Böen, Schritte heben ALLE Teilbänder gleichzeitig an — Gesang sitzt in einem oder
  // zwei. Breitbandige, nicht-tonale Ereignisse zählen nicht; sie erzeugten in der Simulation sonst
  // Schein-Richtungen.
  const broadband = loud >= 3;
  let anyAct = false;
  for (let b = BANDS.length - 1; b >= 0; b--) {
    const B = _bands[b], lv = m[b].lv, snr = snrs[b];
    // Ausklingen nach dem Ruf (Analyser-Glättung, Nachhall) liegt rasch weit unter der Spitze, in sehr
    // ruhiger Umgebung aber noch über dem Boden — ohne diese Grenze wären das lauter Ausreißer. Ein
    // breitbandiger Knall soll den Merker nicht hochreißen.
    B.peak = broadband ? B.peak - PEAK_FALL * dt : Math.max(lv, B.peak - PEAK_FALL * dt);
    const act = b === 0 ? anyAct : (m[b].tonal || (snr >= ACT_DB && !broadband)) && lv >= B.peak - PEAK_DROP;
    anyAct ||= act;
    const T = B.tick;
    if (T.t0 == null) T.t0 = t;
    T.f++;
    if (act) { T.n++; T.y += lv; T.snr += snr; T.c += hc; T.s += hs; }
    if (t - T.t0 >= TICK_S) {
      // Tick zählt erst, wenn ein Drittel seiner Frames aktiv war — einzelne Knackser bleiben draußen
      if (T.n * 3 >= T.f) {
        const h = (Math.atan2(T.s, T.c) / DEG + 360) % 360;
        if (t - B.segT > SEG_GAP_S || _angDist(h, B.segH0) > SEG_SPAN_DEG) { B.segId = ++_segCounter; B.segH0 = h; }
        B.segT = t;
        B.ticks.push({ seg: B.segId, h, t: t - TICK_S / 2, y: T.y / T.n, snr: T.snr / T.n });
        if (B.ticks.length > MAX_TICKS) B.ticks.splice(0, MAX_TICKS >> 2);
        if (b === 0) _lastActT = t;
      }
      T.t0 = t; T.f = T.n = T.y = T.snr = T.c = T.s = 0;
    }
    if (b === 0) _live = { snr, act };
  }
}

function _sample(now) {
  if (_mode !== 'scan' || !_bands) return;
  if (_micDead()) { _micLost(); return; }
  const t = now / 1000, dt = _lastT == null ? 0 : Math.min(0.2, Math.max(0, t - _lastT));
  _lastT = _nowT = t;
  if (_heading != null) _ingest(_measure(), _heading, t, dt);
}

// ---- Auswertung -------------------------------------------------------------------------------
function _median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
function _inv4(A) {   // Gauß-Jordan mit Pivotsuche; null bei (fast) singulärer Matrix
  const M = A.map((r, i) => [...r, ...[0, 1, 2, 3].map(j => +(i === j))]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 8; j++) M[c][j] /= d;
    for (let r = 0; r < 4; r++) if (r !== c) { const f = M[r][c]; if (f) for (let j = 0; j < 8; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map(r => r.slice(4));
}

// Gemischtes Modell je Tick: y = a + u_Strophe + X·cos θ + Y·sin θ + c·t_rel + e.
// Zerlegt in "innerhalb" (um den Strophen-Mittelwert bereinigt: Strophen-Lautstärke fällt raus)
// und "zwischen" (Strophen-Mittelwerte, Gewicht 1/(σs² + σw²/n)) — beide Teile sind orthogonal und
// werden in denselben Normalgleichungen addiert; σw/σs werden aus den Residuen nachgeschätzt.
// Robust nach Huber (Pseudo-Beobachtungen, Ausreißer auf HUBER·σ gestutzt): Ein-/Ausklingen am
// Strophenrand, fremde Rufe oder ein Knacken dürfen die Anpassung nicht kippen.
function _fit(ticks) {
  const segs = new Map();
  for (const k of ticks) {
    let g = segs.get(k.seg);
    if (!g) segs.set(k.seg, g = { n: 0, c: 0, s: 0, t: 0, y: 0, yb: 0, list: [] });
    const c = Math.cos(k.h * DEG), s = Math.sin(k.h * DEG);
    g.n++; g.c += c; g.s += s; g.t += k.t; g.y += k.y; g.list.push([c, s, k.t, k.y, k.y]);   // [.., y roh, y gestutzt]
  }
  if (segs.size < MIN_SEGS) return null;
  for (const g of segs.values()) { g.c /= g.n; g.s /= g.n; g.t /= g.n; g.y /= g.n; g.yb = g.y; }
  let sw2 = 9, ss2 = SIG_S_PRIOR ** 2, beta = null, inv = null;
  const clip = (e, lim) => Math.max(-lim, Math.min(lim, e));
  const within = (v, g) => beta[1] * (v[0] - g.c) + beta[2] * (v[1] - g.s) + beta[3] * (v[2] - g.t);
  for (let it = 0; it < 4; it++) {
    const A = [0, 1, 2, 3].map(() => [0, 0, 0, 0]), r = [0, 0, 0, 0];
    const add = (x, w, y) => { for (let i = 0; i < 4; i++) { if (!x[i]) continue; r[i] += w * x[i] * y; for (let j = 0; j < 4; j++) A[i][j] += w * x[i] * x[j]; } };
    for (const g of segs.values()) {
      for (const v of g.list) add([0, v[0] - g.c, v[1] - g.s, v[2] - g.t], 1 / (sw2 * W_INFL), v[4] - g.y);
      add([1, g.c, g.s, 0], 1 / (ss2 + sw2 * W_INFL / g.n), g.yb);
    }
    A[3][3] += 1 / C_PRIOR ** 2;
    if (!(inv = _inv4(A))) return null;
    beta = inv.map(row => row.reduce((acc, v, j) => acc + v * r[j], 0));
    // σw robust über den Median der Abweichungen (MAD), dann Ticks stutzen und Strophen-Mittel neu bilden
    const abs = [];
    for (const g of segs.values()) for (const v of g.list) abs.push(Math.abs(v[3] - g.y - within(v, g)));
    const mad = 1.4826 * _median(abs);
    sw2 = Math.max(SIG_W_MIN ** 2, mad * mad * abs.length / Math.max(1, abs.length - segs.size - 3));
    let rb = 0;
    for (const g of segs.values()) {
      let sum = 0;
      for (const v of g.list) { const p = within(v, g); v[4] = g.y + p + clip(v[3] - g.y - p, HUBER * Math.sqrt(sw2)); sum += v[4]; }
      g.y = sum / g.n;
      const sd = Math.sqrt(ss2 + sw2 / g.n), fitB = beta[0] + beta[1] * g.c + beta[2] * g.s, eb = clip(g.y - fitB, HUBER * sd);
      g.yb = fitB + eb;
      rb += eb * eb - sw2 / g.n;
    }
    // Bei nur 5–15 Strophen ist die Schätzung selbst unsicher; der Abzug weiterer Freiheitsgrade
    // (Erwartungswert statt Punktschätzung) verhindert, dass zufällig "ruhige" Läufe überschätzt werden.
    ss2 = Math.max(SIG_S_PRIOR ** 2, rb / Math.max(1, segs.size - 3 - SS_DOF_LOSS));
  }
  const [X, Y] = [beta[1], beta[2]], c11 = inv[1][1], c12 = inv[1][2], c22 = inv[2][2], det = c11 * c22 - c12 * c12;
  if (!(det > 0)) return null;
  return { bearing: (Math.atan2(Y, X) / DEG + 360) % 360, amp: Math.hypot(X, Y), z2: (X * X * c22 - 2 * X * Y * c12 + Y * Y * c11) / det };
}

// Band-Wahl NICHT nach dem stärksten Richtungsunterschied (das würde bei 5 Bändern den Zufall
// "herauspicken"), sondern nach Ruf-Aktivität — bei richtungsloser Quelle richtungsunabhängig, also
// keine versteckte Mehrfachprüfung. Bei Gleichstand (Ein-/Ausschwingen eines Tons streut ins
// Nachbarband) entscheidet der Pegel: Der Sänger steckt dort, wo die meiste Energie ist.
function _evaluate() {
  if (!_bands) return null;
  const sc = _bands.map(B => {
    let s = 0, y = 0;
    for (const k of B.ticks) { s += 1 + Math.min(30, Math.max(0, k.snr)) / 30; y += k.y; }
    return { s, y: B.ticks.length ? y / B.ticks.length : -Infinity };
  });
  const best = Math.max(...sc.map(v => v.s));
  let bi = -1;
  sc.forEach((v, b) => { if (best > 0 && v.s >= 0.9 * best && (bi < 0 || v.y > sc[bi].y)) bi = b; });
  if (bi < 0) return { quality: 'unklar', bins: 0, ticks: 0, lv: null };
  const ticks = _bands[bi].ticks, per = Array.from({ length: SECTORS }, () => []);
  for (const k of ticks) per[Math.floor(k.h / SECTOR_DEG) % SECTORS].push(k.y);
  let bins = 0;
  for (let i = 0; i < SECTORS; i += 2) if (per[i].length + per[i + 1].length >= 2) bins++;
  // Anzeige: Median je 15°-Sektor, mit den Nachbarn geglättet (Körperschatten ist breit)
  const raw = per.map(a => a.length >= 2 ? _median(a) : null);
  const lv = raw.map((v, s) => {
    if (v == null) return null;
    const nb = [raw[(s + SECTORS - 1) % SECTORS], raw[(s + 1) % SECTORS]].filter(x => x != null);
    return (v * 2 + nb.reduce((a, x) => a + x, 0)) / (2 + nb.length);
  });
  const fit = bins >= MIN_BINS ? _fit(ticks) : null;
  const quality = !fit ? 'unklar' : fit.z2 >= Z2_GOOD && fit.amp >= AMP_GOOD ? 'deutlich' : fit.z2 >= Z2_OK ? 'erkennbar' : 'unklar';
  return { quality, bins, ticks: ticks.length, band: bi, lv, bearing: fit?.bearing ?? null, z2: fit?.z2 ?? 0, amp: fit?.amp ?? 0 };
}

// ---- Darstellung --------------------------------------------------------------------------
const _dirName = b => DIRS[Math.round(b / 45) % 8];
function _wedge(g, c, r0, r1, a0, a1) { g.beginPath(); g.arc(c, c, r1, a0, a1); g.arc(c, c, r0, a1, a0, true); g.closePath(); g.fill(); }

function _draw() {
  const size = _canvas?.clientWidth;
  if (!size) return;
  const dpr = window.devicePixelRatio || 1, px = Math.round(size * dpr);
  if (_canvas.width !== px) { _canvas.width = px; _canvas.height = px; }
  const g = _canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  const c = size / 2, rOut = c - 22, rIn = rOut * 0.32, head = _heading ?? 0, ev = _ev;
  // Bildschirm-Winkel: oben = aktuelle Blickrichtung (Kopf-oben-Darstellung), so zeigt die
  // Anzeige immer relativ zu dir und dreht sich beim Drehen mit.
  const toScreen = bearing => ((bearing - head) - 90) * DEG;
  g.lineWidth = 1; g.strokeStyle = 'rgba(236,253,245,.12)';
  for (const r of [rIn, (rIn + rOut) / 2, rOut]) { g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke(); }
  const covered = ev?.lv ? ev.lv.filter(v => v != null) : [];
  if (covered.length) {
    const min = Math.min(...covered), span = Math.max(3, Math.max(...covered) - min);
    ev.lv.forEach((v, s) => {
      const a0 = toScreen(s * SECTOR_DEG), a1 = toScreen((s + 1) * SECTOR_DEG);
      if (v == null) { g.fillStyle = 'rgba(236,253,245,.04)'; _wedge(g, c, rIn, rOut, a0, a1); return; }
      const f = (v - min) / span;
      g.fillStyle = `rgba(163,230,53,${0.18 + 0.62 * f})`;
      _wedge(g, c, rIn, rIn + (rOut - rIn) * (0.15 + 0.85 * f), a0, a1);
    });
  } else { g.fillStyle = 'rgba(236,253,245,.04)'; _wedge(g, c, rIn, rOut, 0, Math.PI * 2); }
  // Live-Pegel in Blickrichtung (oben): zeigt sofort, dass der Scan hört — hell, wenn der Ruf zählt
  if (_mode === 'scan' && _live) {
    g.fillStyle = _live.act ? 'rgba(103,232,249,.85)' : 'rgba(103,232,249,.3)';
    _wedge(g, c, rIn, rIn + (rOut - rIn) * Math.max(0.06, Math.min(1, _live.snr / 25)), -97.5 * DEG, -82.5 * DEG);
  }
  // Himmelsrichtungen (nur mit echtem, absolutem Kompass sinnvoll) — außerhalb des Rings
  if (_headingAbsolute && _heading != null) {
    g.font = '700 13px Outfit, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    [['N', 0], ['O', 90], ['S', 180], ['W', 270]].forEach(([n, b]) => {
      const a = toScreen(b);
      g.fillStyle = n === 'N' ? '#fb7185' : 'rgba(236,253,245,.7)';
      g.fillText(n, c + Math.cos(a) * (rOut + 12), c + Math.sin(a) * (rOut + 12));
    });
  }
  // Ergebnis-Pfeil (im Scan halbtransparent als Zwischenstand, im Führungsmodus voll)
  const target = _mode === 'guide' && _result ? _result.bearing : (ev && ev.quality !== 'unklar' ? ev.bearing : null);
  if (target != null) {
    g.save(); g.translate(c, c); g.rotate(toScreen(target));
    g.fillStyle = _mode === 'guide' ? '#a3e635' : 'rgba(163,230,53,.55)';
    g.beginPath(); g.moveTo(rOut - 4, 0); g.lineTo(rIn + 6, -11); g.lineTo(rIn + 18, 0); g.lineTo(rIn + 6, 11); g.closePath(); g.fill();
    g.restore();
  }
  // Blickrichtungs-Kerbe: sitzt auf dem Außenring, INNEN — die Himmelsrichtung oben (z.B. "N")
  // bleibt außen frei lesbar statt unter einer Marke zu verschwinden.
  g.fillStyle = '#ecfdf5';
  g.beginPath(); g.moveTo(c, c - rOut + 11); g.lineTo(c - 7, c - rOut - 1); g.lineTo(c + 7, c - rOut - 1); g.closePath(); g.fill();
}

function _setText(sel, text) { const n = _el?.querySelector(sel); if (n && n.textContent !== text) n.textContent = text; }
function _updateStatus() {
  if (_mode === 'scan') {
    const ev = _ev, bins = ev ? ev.bins : 0, waiting = _nowT - _lastActT > 3;
    _setText('.scan-progress', `Ruf-Daten aus ${bins * 30}° von 360°`);
    if (!_enoughNotified && bins >= MIN_BINS) { _enoughNotified = true; try { navigator.vibrate?.(40); } catch {} }
    if (!ev || ev.ticks === 0 || (bins < MIN_BINS && waiting)) _setText('.scan-status', 'Warte auf Gesang … langsam weiterdrehen');
    else if (bins < MIN_BINS) _setText('.scan-status', 'Noch zu wenig Ruf-Daten — weiterdrehen, während der Vogel singt.');
    else if (ev.quality === 'unklar') _setText('.scan-status', 'Noch keine klare Richtung — eine weitere Runde drehen.');
    else _setText('.scan-status', `Am lautesten: ${_headingAbsolute ? _dirName(ev.bearing) + ' · ' : ''}Richtung ${ev.quality}`);
    const done = _el?.querySelector('.scan-done');
    if (done) done.disabled = !(ev && ev.quality !== 'unklar');
  } else if (_mode === 'guide' && _result && _heading != null) {
    const diff = ((_result.bearing - _heading + 540) % 360) - 180;
    _setText('.scan-status', Math.abs(diff) <= 15 ? 'Geradeaus ✓' : `${Math.round(Math.abs(diff))}° nach ${diff > 0 ? 'rechts' : 'links'} drehen`);
  }
}

// Auswertung 4×/s statt in jedem Frame: hält die Bildrate (und damit die Abtastung) auf schwachen
// Handys stabil; Zeichnen und "Richtung übernehmen" nutzen dasselbe zwischengespeicherte Ergebnis.
function _timer() { if (_mode === 'scan') _ev = _evaluate(); _updateStatus(); }
function _loop(ts) { _sample(ts ?? performance.now()); _draw(); _raf = _el ? requestAnimationFrame(_loop) : null; }

// ---- Ablauf ----------------------------------------------------------------------------------
function _show(mode) {
  _mode = mode;
  if (!_el) return;
  _el.dataset.mode = mode;
  if (mode === 'scan') _setText('.scan-hint', 'Langsam einmal ganz im Kreis drehen (ca. 20 s), Handy flach vor der Brust. Gezählt wird nur, während der Vogel singt — weitere Runden machen es genauer.');
  else if (mode === 'guide') {
    const r = _result;
    _setText('.scan-hint', `Grobe Richtung${_headingAbsolute ? ': ' + _dirName(r.bearing) + ' (' + Math.round(r.bearing) + '°)' : ''} · etwa ±${r.quality === 'deutlich' ? 30 : 45}°. Der Pfeil zeigt dorthin — in Pfeilrichtung gehen und erneut scannen, wenn du näher dran bist.`);
  }
  _updateStatus();
}

// Zurück zum Startbildschirm mit Meldung (Fehler, Mikro weg) — der Start-Knopf bekommt passenden Text.
function _backToIntro(status, hint, btnText) {
  if (_evalTimer) { clearInterval(_evalTimer); _evalTimer = null; }
  _stopAudio(); _stopCompass();
  _ev = null; _live = null;
  _show('intro');
  _setText('.scan-status', status);
  _setText('.scan-hint', hint || '');
  const btn = _el?.querySelector('.scan-start');
  if (btn) { btn.disabled = false; btn.textContent = btnText; }
}
const _micLost = () => _backToIntro('Mikrofon wurde beendet — Scan neu starten.', 'Das Mikrofon wurde von der App oder vom System beendet (z.B. Dauerüberwachung, Nacht-Modus, Anruf).', 'Scan neu starten');

// Sitzungsmarke nach JEDEM await prüfen: Schließen + Neu-Öffnen während der Wartezeiten darf den
// alten Start nicht in die neue Sitzung weiterlaufen lassen (sonst zweiter Timer, verwaistes Mikro).
async function _begin() {
  const tok = _session, btn = _el?.querySelector('.scan-start');
  if (btn) btn.disabled = true;
  _setText('.scan-status', 'Starte Kompass und Mikrofon …');
  _setText('.scan-hint', '');
  _stopCompass();
  const compass = await _startCompass(tok);
  if (tok !== _session) return;
  if (compass === 'denied') {
    _backToIntro('Kein Zugriff auf Kompass und Bewegung.', 'iPhone: Einstellungen › Safari › Bewegung & Ausrichtung erlauben (oder Safari ganz schließen und neu öffnen), dann erneut versuchen.', 'Erneut versuchen');
    return;
  }
  let a;
  try { a = await _startAudio(_engine); }
  catch (e) {
    if (tok !== _session) return;
    console.warn('scan audio', e);
    _backToIntro('Mikrofon nicht verfügbar.', 'Bitte den Mikrofon-Zugriff für diese Seite erlauben.', 'Erneut versuchen');
    return;
  }
  if (tok !== _session) { _releaseAudio(a); return; }
  _stopAudio();
  ({ ctx: _ctx, stream: _stream, ownCtx: _ownCtx, ownStream: _ownStream, src: _src, an: _an } = a);
  _spec = new Float32Array(_an.frequencyBinCount);
  // Kein Kompass-Ereignis innerhalb kurzer Zeit = Gerät ohne Kompass (z.B. Laptop)
  await new Promise(r => setTimeout(r, 800));
  if (tok !== _session) return;
  if (_heading == null) { _backToIntro('Dieses Gerät meldet keinen Kompass — der Scan funktioniert nur auf dem Handy.', '', 'Erneut versuchen'); return; }
  _lockAbs = _headingAbsolute = _sawAbs;
  _resetData(); _show('scan');
  if (btn) btn.disabled = false;
  clearInterval(_evalTimer);
  _evalTimer = setInterval(_timer, 250);
}

const COMPASS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor" stroke-linejoin="round"/></svg>';

// species: optionaler Artname für die Überschrift; engine: laufende AudioEngine (wird mitbenutzt).
export function openScan({ species = '', engine = null } = {}) {
  closeScan();
  _species = String(species || '').trim(); _engine = engine;
  _el = document.createElement('div');
  _el.className = 'scan-modal';
  _el.dataset.mode = _mode = 'intro';
  _el.innerHTML = `
    <div class="scan-top">
      <div><div class="scan-title">${COMPASS_SVG}<span></span></div><div class="scan-sub"></div></div>
      <button class="scan-close" aria-label="Schließen">✕</button>
    </div>
    <canvas class="scan-dial" aria-hidden="true"></canvas>
    <div class="scan-progress"></div>
    <div class="scan-status" role="status" aria-live="polite"></div>
    <ol class="scan-steps">
      <li>Handy flach vor die Brust, Oberkante nach vorn.</li>
      <li>Langsam einmal im Kreis drehen (ca. 20 s) — am besten, während der Vogel singt.</li>
      <li>„Richtung übernehmen“ — der Pfeil zeigt dorthin.</li>
    </ol>
    <div class="scan-hint"></div>
    <div class="scan-actions">
      <button class="btn scan-start">Scan starten</button><button class="btn scan-done" disabled>Richtung übernehmen</button><button class="btn ghost scan-again">Neu scannen</button>
    </div>`;
  // Artname nur als Text einsetzen (kommt aus Erkennung/Nutzereingabe)
  _el.querySelector('.scan-title span').textContent = _species ? 'Richtung: ' + _species : 'Lautesten Ruf finden';
  _el.querySelector('.scan-sub').textContent = _species ? 'Grobe Richtung des Rufs — mit einem Handy' : 'Grobe Richtung eines Rufs — ohne Zubehör';
  document.body.appendChild(_el);
  _canvas = _el.querySelector('.scan-dial');
  _el.querySelector('.scan-close').onclick = closeScan; _el.querySelector('.scan-start').onclick = _begin;
  // Übernimmt das zwischengespeicherte Ergebnis — genau das angezeigte, nie ein "unklares"
  _el.querySelector('.scan-done').onclick = () => {
    if (!_ev || _ev.quality === 'unklar' || _ev.bearing == null) return;
    _result = { ..._ev };
    try { navigator.vibrate?.([30, 40, 30]); } catch {}
    _show('guide');
  };
  _el.querySelector('.scan-again').onclick = () => { _resetData(); _show('scan'); };
  _raf = requestAnimationFrame(_loop);
}

export function closeScan() {
  _session++;
  if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
  if (_evalTimer) { clearInterval(_evalTimer); _evalTimer = null; }
  _stopAudio(); _stopCompass();
  _el?.remove();
  _el = _canvas = _bands = _ev = _result = _engine = _live = null; _mode = 'intro';
}
