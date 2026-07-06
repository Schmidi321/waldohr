// Gemeinsame Ruf-Ortung zwischen gekoppelten Handys (js/peerhub.js bündelt eine oder mehrere
// Verbindungen). Jedes Gerät meldet allen anderen jede Erkennung und seine Position; wenn zwei
// Geräte denselben Ruf im selben Zeitfenster hören, wird aus dem Zeitversatz und der GPS-Position
// beider Geräte eine grobe Einschätzung berechnet, welches Gerät näher dran ist und aus welcher
// Himmelsrichtung der Ruf ungefähr kam.
//
// Wichtige Einschränkung (bewusst konservativ kommuniziert statt falsch-genau): aus nur zwei
// Empfängern lässt sich physikalisch keine eindeutige Peilung berechnen, sondern nur eine grobe
// Aussage (näher an welchem Gerät + ob eher quer oder eher entlang der Verbindungslinie) — für
// eine echte Richtung bräuchte es einen dritten Referenzpunkt. Der feine Uhren-Abgleich (für genau
// diese Zeitversatz-Peilung) läuft bewusst NICHT über die Zentrale weitergeleitet (siehe
// js/peerhub.js), sondern nur zwischen direkt verbundenen Geräten — bei über die Zentrale
// weitergeleiteten Positionen/Funden (Speiche-zu-Speiche im Stern-Modell) gibt es darum Entfernung
// + Peilung (aus GPS, siehe getPeerGeoInfo), aber keine "wer hat zuerst gehört"-Feinauswertung.
import { bearingDeg, haversineKm } from './db.js';
import * as hub from './peerhub.js';
import { gccPhat, encodeSnippet, decodeSnippet, bytesToB64, b64ToBytes, resampleLinear, CORR_RATE } from './tdoa.js';

const SOUND_SPEED_MPS = 343; // Schallgeschwindigkeit in Luft, ~20°C
const MATCH_WINDOW_MS = 4000; // wie weit zeitlich zwei Erkennungen noch als "derselbe Ruf" gelten
const RECENT_KEEP_MS = 8000;
const SNIP_CHUNK = 12 * 1024; // Bytes pro Datenkanal-Nachricht (Base64 bleibt unter der sicheren 16-KB-Grenze)
const CORR_MIN_CONF = 1.3;    // darunter gilt die Kreuzkorrelation als nicht eindeutig -> grober Fallback
const CORR_THROTTLE_MS = 30000; // pro Art+Partner höchstens alle 30 s ein Schnipsel-Austausch (128 KB je Richtung)

let _active = false;
let _myPos = null;
const _peerPos = new Map(); // peerId -> {lat,lng}
const _clockOffsetMs = new Map(); // peerId -> Offset (nur für DIREKT verbundene Geräte)
const _syncedPeers = new Set();
let _recentLocal = [];
let _onResult = null, _onPeerPos = null, _onCalibEvent = null;
let _unsubMsg = null, _unsubPeerList = null;

// ---- Zustand für den präzisen Pfad (Kreuzkorrelation + Klatsch-Kalibrierung) ----
let _lastWindows = [];   // letzte Roh-Audio-Fenster {samples,rate,endMs} — für die Kalibrierung
let _lastWindowAt = 0;   // wann zuletzt ein Fenster ankam (= läuft das eigene Mikrofon?)
const _calibBias = new Map();    // peerId -> systematischer Versatz in ms (Uhrrest + Eingangslatenz-Differenz)
const _pendingSnips = new Map(); // "peer:key:ts" -> {hdr,parts,got,resolve,timer}
const _lastCorrAt = new Map();   // "peer:key" -> ts der letzten Korrelation (Drossel)
let _calibWaiter = null;         // wartet auf das erste Fenster, das den Klatsch-Zeitraum abdeckt
let _calibErrReason = null;      // Fehlergrund vom Partner während einer laufenden Kalibrierung

// Von app.js EINMAL beim Start aufgerufen (nicht pro Verbindung). onPeerPos(peerId, pos|null)
// wird bei jedem Positions-Update bzw. beim Trennen eines Partners aufgerufen. onCalibEvent
// ({kind:'ping'|'done'}) informiert die UI, wenn der PARTNER einen Feinabgleich startet/abschließt.
export function attach(onResult, onPeerPos, onCalibEvent) {
  detach();
  _active = true;
  _onResult = onResult || null;
  _onPeerPos = onPeerPos || null;
  _onCalibEvent = onCalibEvent || null;
  _recentLocal = [];
  _peerPos.clear(); _clockOffsetMs.clear(); _syncedPeers.clear();
  _lastWindows = []; _lastWindowAt = 0;
  _calibBias.clear(); _pendingSnips.clear(); _lastCorrAt.clear();
  _calibWaiter = null; _calibErrReason = null;
  _unsubMsg = hub.onMessage((msg, fromId) => _onMessage(msg, fromId));
  _unsubPeerList = hub.onPeerListChange(() => _syncNewPeers());
  _syncNewPeers();
}

export function detach() {
  if (_unsubMsg) _unsubMsg();
  if (_unsubPeerList) _unsubPeerList();
  _unsubMsg = null; _unsubPeerList = null;
  _active = false;
  _peerPos.clear(); _clockOffsetMs.clear(); _syncedPeers.clear();
  for (const p of _pendingSnips.values()) { clearTimeout(p.timer); p.resolve(null); }
  _pendingSnips.clear(); _calibBias.clear(); _lastCorrAt.clear();
  _lastWindows = []; _calibWaiter = null;
  _onResult = null; _onPeerPos = null; _onCalibEvent = null;
}

// Von app.js bei JEDEM Audio-Fenster aufgerufen (auch ohne aktive Erkennung), solange gekoppelt —
// hält die letzten Roh-Fenster für die Klatsch-Kalibrierung vor und bedient wartende Abnehmer.
export function feedWindow(win) {
  if (!_active || !win || !win.samples || typeof win.endMs !== 'number') return;
  _lastWindowAt = Date.now();
  _lastWindows.push(win);
  if (_lastWindows.length > 4) _lastWindows.shift();
  if (_calibWaiter && win.endMs >= _calibWaiter.untilMs) {
    const w = _calibWaiter; _calibWaiter = null;
    clearTimeout(w.timer);
    w.resolve(win);
  }
}

export function isActive() {
  return _active && hub.isActive();
}

// Eigene Position an ALLE gekoppelten Geräte melden (für die Basislinien-Peilung nötig).
export function setLocalPos(pos) {
  if (!pos) return;
  _myPos = { lat: pos.lat, lng: pos.lng };
  hub.broadcast({ type: 'pos', lat: pos.lat, lng: pos.lng });
}

// Für die ständige Distanz-/Richtungsanzeige im Karten-Tab — Entfernung + Peilung zu EINEM
// bestimmten Partner, unabhängig von einem gemeinsamen Fund-Ereignis.
export function getPeerGeoInfo(peerId) {
  const pos = _peerPos.get(peerId);
  if (!_myPos || !pos) return null;
  return {
    baselineM: Math.round(haversineKm(_myPos, pos) * 1000),
    bearingToPeer: Math.round(bearingDeg(_myPos, pos)),
  };
}

// Dieselbe Info für ALLE aktuell bekannten Partner (für nummerierte Karten-Marker + Klick-Popup).
export function getAllPeerGeoInfo() {
  const out = [];
  for (const peerId of _peerPos.keys()) {
    const info = getPeerGeoInfo(peerId);
    if (info) out.push({ peerId, ...info });
  }
  return out;
}

function _syncNewPeers() {
  for (const { id } of hub.peerList()) {
    if (!_syncedPeers.has(id)) { _syncedPeers.add(id); _syncClock(id); }
  }
}

// ---- Uhren-Abgleich: NTP-ähnliches Ping-Pong, nimmt den Durchlauf mit geringster Laufzeit ----
// relay:false -> läuft NIE über die Zentrale weiter (siehe js/peerhub.js), ist nur zwischen genau
// diesen zwei direkt verbundenen Geräten aussagekräftig.
async function _syncClock(peerId) {
  let best = null;
  for (let i = 0; i < 5; i++) {
    if (!isActive()) break;
    const t0 = Date.now();
    const result = await new Promise(res => {
      const unsub = hub.onMessage((msg, fromId) => {
        if (fromId !== peerId || msg.type !== 'pong' || msg.t0 !== t0) return;
        unsub();
        const t2 = Date.now(), rtt = t2 - t0;
        res({ offset: msg.t1 - (t0 + rtt / 2), rtt });
      });
      hub.sendTo(peerId, { type: 'ping', t0, relay: false });
      setTimeout(() => { unsub(); res(null); }, 2000);
    });
    if (result && (!best || result.rtt < best.rtt)) best = result;
    await new Promise(r => setTimeout(r, 150));
  }
  if (best) _clockOffsetMs.set(peerId, best.offset);
}

function _onMessage(msg, fromId) {
  if (!_active) return;
  if (msg.type === 'ping') { hub.sendTo(fromId, { type: 'pong', t0: msg.t0, t1: Date.now(), relay: false }); return; }
  if (msg.type === 'pos') {
    _peerPos.set(fromId, { lat: msg.lat, lng: msg.lng });
    if (_onPeerPos) _onPeerPos(fromId, _peerPos.get(fromId));
    return;
  }
  if (msg.type === 'snipReq') { _serveSnippet(fromId, msg); return; }
  if (msg.type === 'snipHdr' || msg.type === 'snipChunk') { _collectSnippet(fromId, msg); return; }
  if (msg.type === 'calib') { _serveCalib(fromId, msg); return; }
  if (msg.type === 'calibDone') {
    if (typeof msg.bias === 'number' && Math.abs(msg.bias) < 500) {
      _calibBias.set(fromId, msg.bias);
      if (_onCalibEvent) _onCalibEvent({ kind: 'done', peerId: fromId });
    }
    return;
  }
  if (msg.type === 'calibErr') { _calibErrReason = msg.reason || 'unbekannt'; return; }
  if (msg.type === 'detection') { _handlePeerDetection(msg, fromId); }
}

// Von app.js bei jeder neuen lokalen Erkennung aufgerufen — merkt sie sich kurz (inkl. des rohen
// Audio-Fensters, aus dem die Erkennung stammt) und meldet sie allen gekoppelten Geräten, damit
// die bei einem eigenen Treffer den Vergleich machen können. `snip:true` signalisiert dem Partner,
// dass zu dieser Erkennung ein Audio-Schnipsel für die präzise Korrelation abrufbar ist.
export function reportDetection(det, win) {
  const now = det.ts;
  _recentLocal = _recentLocal.filter(d => now - d.ts < RECENT_KEEP_MS);
  _recentLocal.push({ key: det.key, species: det.species, ts: det.ts, win: win || null });
  hub.broadcast({ type: 'detection', key: det.key, species: det.species, ts: det.ts, snip: !!win });
}

function _handlePeerDetection(msg, fromId) {
  const match = _recentLocal.find(d => d.key === msg.key);
  if (!match) return;

  // Ohne Uhren-Abgleich mit genau diesem Gerät (z.B. Speiche-zu-Speiche im Stern-Modell, über die
  // Zentrale weitergeleitet) lässt sich kein verlässlicher Zeitversatz berechnen -> ehrlich nur
  // den Treffer selbst melden, ohne "wer war näher"/Peilungs-Detail vorzutäuschen.
  const offset = _clockOffsetMs.get(fromId);
  if (offset == null) {
    if (Math.abs(match.ts - msg.ts) > MATCH_WINDOW_MS * 3) return; // grobe Plausibilitätsgrenze ohne Abgleich
    if (_onResult) _onResult({ species: match.species, key: match.key, peerId: fromId, deltaMs: null, firstHeard: null, bearingToPeer: null, baselineM: null, sideHint: null, thetaDeg: null });
    return;
  }

  const remoteTsLocal = msg.ts - offset; // Partner-Zeitstempel in lokale Zeitbasis umrechnen
  if (Math.abs(match.ts - remoteTsLocal) > MATCH_WINDOW_MS) return;

  // Präziser Pfad: rohe Audio-Fenster austauschen und kreuzkorrelieren (js/tdoa.js) — die
  // Erkennungs-Zeitstempel selbst sind durch die 3s-Fenster ±1500 ms unscharf und taugen nur als
  // grober Fallback. Gedrosselt, weil ein Austausch ~128 KB je Richtung kostet.
  const throttleKey = fromId + ':' + msg.key;
  if (match.win && msg.snip && Date.now() - (_lastCorrAt.get(throttleKey) || 0) > CORR_THROTTLE_MS) {
    _lastCorrAt.set(throttleKey, Date.now());
    _preciseTdoa(fromId, msg, match).then(p => {
      if (p) _emitResult(match, fromId, p.tdoaMs, { method: 'corr', corrConf: p.confidence, calibrated: p.calibrated });
      else _emitResult(match, fromId, match.ts - remoteTsLocal, { method: 'clock' });
    });
    return;
  }
  _emitResult(match, fromId, match.ts - remoteTsLocal, { method: 'clock' });
}

// deltaMs > 0: ich habe SPÄTER gehört als der Partner -> Partner ist näher. Die Schwelle für eine
// "wer war näher"-Aussage hängt von der Messmethode ab: kreuzkorreliert + kalibriert sind wenige ms
// belastbar, unkalibriert bleibt die unbekannte Eingangslatenz-Differenz der Geräte (~±60 ms),
// die groben Fenster-Zeitstempel behalten die bisherige 30-ms-Heuristik.
function _emitResult(match, fromId, deltaMs, extra) {
  if (!_onResult || !_active) return;
  const th = extra.method === 'corr' ? (extra.calibrated ? 8 : 60) : 30;
  const firstHeard = deltaMs > th ? 'peer' : deltaMs < -th ? 'me' : 'both';

  let bearingToPeer = null, baselineM = null, sideHint = null, thetaDeg = null;
  const peerPos = _peerPos.get(fromId);
  if (_myPos && peerPos) {
    baselineM = Math.round(haversineKm(_myPos, peerPos) * 1000);
    bearingToPeer = Math.round(bearingDeg(_myPos, peerPos));
    if (baselineM > 1) {
      const sinTheta = Math.max(-1, Math.min(1, (SOUND_SPEED_MPS * (Math.abs(deltaMs) / 1000)) / baselineM));
      thetaDeg = Math.round(Math.asin(sinTheta) * 180 / Math.PI);
      sideHint = thetaDeg < 20 ? 'eher mittig zwischen euch' : thetaDeg > 60 ? 'eher seitlich, nah an der Verbindungslinie' : 'irgendwo dazwischen';
    }
  }

  _onResult({
    species: match.species, key: match.key, peerId: fromId,
    deltaMs: Math.round(Math.abs(deltaMs)), deltaSignedMs: Math.round(deltaMs), firstHeard,
    bearingToPeer, baselineM, sideHint, thetaDeg,
    method: extra.method, corrConf: extra.corrConf || null, calibrated: !!extra.calibrated,
  });
}

// ---- Präziser Pfad: Partner-Schnipsel anfordern, kreuzkorrelieren, Kalibrier-Bias abziehen ----
//
// Zeitrechnung: lokales Fenster endet bei eL (lokale Uhr), Partner-Fenster bei eR' = endMs - offset
// (in lokale Zeitbasis umgerechnet). GCC-PHAT liefert lagMs = Signalposition(lokal) -
// Signalposition(Partner) innerhalb der Fenster; die Laufzeitdifferenz der Ankunft ist damit
// TDOA = (eL - eR') + lagMs. Die Peaksuche wird um genau diesen Fenster-Versatz zentriert
// (centerMs = eR' - eL) und auf die physikalisch mögliche Schall-Laufzeit über die Basislinie
// begrenzt — ein Peak außerhalb davon wäre garantiert falsch.
async function _preciseTdoa(fromId, msg, match) {
  try {
    const snip = await _requestSnippet(fromId, { key: msg.key, ts: msg.ts });
    if (!snip || !_active) return null;
    const offset = _clockOffsetMs.get(fromId);
    if (offset == null) return null;
    const eL = match.win.endMs;
    const eR = snip.endMs - offset;
    const local16 = resampleLinear(match.win.samples, match.win.rate, CORR_RATE);
    const peerPos = _peerPos.get(fromId);
    const baselineM = (_myPos && peerPos) ? haversineKm(_myPos, peerPos) * 1000 : null;
    const maxTdoaMs = baselineM ? Math.min(baselineM / SOUND_SPEED_MPS * 1000 + 250, 1200) : 1200;
    const { lagMs, confidence } = gccPhat(local16, snip.samples, CORR_RATE, { centerMs: eR - eL, halfMs: maxTdoaMs });
    if (confidence < CORR_MIN_CONF) return null;
    let tdoaMs = (eL - eR) + lagMs;
    const bias = _calibBias.get(fromId);
    if (bias != null) tdoaMs -= bias;
    return { tdoaMs, confidence, calibrated: bias != null };
  } catch (e) { console.warn('locate corr', e); return null; }
}

function _requestSnippet(peerId, ref) {
  return new Promise(res => {
    const rk = peerId + ':' + ref.key + ':' + ref.ts;
    const timer = setTimeout(() => { _pendingSnips.delete(rk); res(null); }, 9000);
    _pendingSnips.set(rk, { hdr: null, parts: null, got: 0, resolve: res, timer });
    hub.sendTo(peerId, { type: 'snipReq', key: ref.key, ts: ref.ts, relay: false });
  });
}

function _serveSnippet(fromId, msg) {
  const entry = _recentLocal.find(d => d.key === msg.key && d.ts === msg.ts && d.win);
  if (entry) _sendSnippet(fromId, { key: msg.key, ts: msg.ts }, entry.win);
}

function _sendSnippet(peerId, ref, win) {
  const bytes = encodeSnippet(win.samples, win.rate);
  const chunks = Math.ceil(bytes.length / SNIP_CHUNK);
  hub.sendTo(peerId, { type: 'snipHdr', key: ref.key, ts: ref.ts, endMs: win.endMs, rate: CORR_RATE, bytes: bytes.length, chunks, relay: false });
  for (let i = 0; i < chunks; i++) {
    hub.sendTo(peerId, { type: 'snipChunk', key: ref.key, ts: ref.ts, i, data: bytesToB64(bytes.subarray(i * SNIP_CHUNK, (i + 1) * SNIP_CHUNK)), relay: false });
  }
}

function _collectSnippet(fromId, msg) {
  const rk = fromId + ':' + msg.key + ':' + msg.ts;
  const p = _pendingSnips.get(rk);
  if (!p) return;
  if (msg.type === 'snipHdr') {
    if (typeof msg.bytes !== 'number' || msg.bytes <= 0 || msg.bytes > 400000 || !Number.isInteger(msg.chunks) || msg.chunks < 1 || msg.chunks > 64) return;
    p.hdr = msg; p.parts = new Array(msg.chunks); p.got = 0;
    return;
  }
  if (!p.hdr || !Number.isInteger(msg.i) || msg.i < 0 || msg.i >= p.hdr.chunks || p.parts[msg.i]) return;
  try { p.parts[msg.i] = b64ToBytes(msg.data); } catch { return; }
  p.got++;
  if (p.got === p.hdr.chunks) {
    clearTimeout(p.timer);
    _pendingSnips.delete(rk);
    const total = p.parts.reduce((a, c) => a + c.length, 0);
    if (total !== p.hdr.bytes) { p.resolve(null); return; }
    const all = new Uint8Array(total);
    let o = 0;
    for (const part of p.parts) { all.set(part, o); o += part.length; }
    p.resolve({ samples: decodeSnippet(all), endMs: p.hdr.endMs, rate: p.hdr.rate });
  }
}

// ---- Klatsch-Kalibrierung: misst den systematischen Versatz zwischen zwei Geräten ----
//
// Beide Handys liegen beim QR-Koppeln ohnehin nebeneinander — ein gemeinsam gehörtes Klatschen
// erreicht dann beide Mikrofone praktisch gleichzeitig (<1 ms bei <30 cm). Der trotzdem gemessene
// TDOA-Wert ist also in Summe der Fehler aus Uhren-Restversatz + Eingangslatenz-Differenz der
// beiden Audio-Pipelines — genau der Bias, der später bei echten Funden abgezogen werden muss.
export function calibrationBias(peerId) { return _calibBias.get(peerId) ?? null; }
export function micRecentlyActive() { return Date.now() - _lastWindowAt < 3000; }

export async function startCalibration(onStatus) {
  const peers = hub.peerList().filter(p => _clockOffsetMs.get(p.id) != null);
  if (!peers.length) { onStatus?.({ phase: 'err', text: 'Kein direkt verbundener Partner mit Uhren-Abgleich.' }); return false; }
  if (!micRecentlyActive()) { onStatus?.({ phase: 'err', text: 'Eigenes Mikrofon ist aus — erst den Lauschmodus starten.' }); return false; }
  let okAll = true;
  for (const peer of peers) {
    okAll = (await _calibrateWith(peer.id, peer.label, onStatus)) && okAll;
  }
  return okAll;
}

async function _calibrateWith(peerId, label, onStatus) {
  _calibErrReason = null;
  const at = Date.now() + 1200;
  hub.sendTo(peerId, { type: 'calib', at, relay: false });
  onStatus?.({ phase: 'clap', text: 'Handys nebeneinander — jetzt 1× laut klatschen! 👏' });
  const win = await new Promise(res => {
    if (_calibWaiter) { res(null); return; } // es läuft schon eine Kalibrierung
    const timer = setTimeout(() => { _calibWaiter = null; res(null); }, 9000);
    _calibWaiter = { untilMs: at + 2400, timer, resolve: res };
  });
  if (!win) {
    onStatus?.({ phase: 'err', text: _calibErrReason === 'mic' ? 'Partner-Mikrofon ist aus — dort den Lauschmodus starten.' : 'Kein Audio-Fenster erhalten — läuft das Mikrofon?' });
    return false;
  }
  onStatus?.({ phase: 'work', text: 'Vergleiche die Aufnahmen…' });
  const snip = await _requestSnippet(peerId, { key: '_calib', ts: at });
  if (_calibErrReason || !snip) {
    onStatus?.({ phase: 'err', text: _calibErrReason === 'mic' ? 'Partner-Mikrofon ist aus — dort den Lauschmodus starten.' : 'Partner-Aufnahme nicht erhalten — nochmal versuchen.' });
    return false;
  }
  const offset = _clockOffsetMs.get(peerId);
  if (offset == null) { onStatus?.({ phase: 'err', text: 'Uhren-Abgleich fehlt.' }); return false; }
  const eL = win.endMs, eR = snip.endMs - offset;
  const local16 = resampleLinear(win.samples, win.rate, CORR_RATE);
  // Klatschen ist breitbandig — Band nach unten öffnen, Suchfenster eng (Geräte liegen nebeneinander)
  const { lagMs, confidence } = gccPhat(local16, snip.samples, CORR_RATE, { centerMs: eR - eL, halfMs: 500, bandLo: 700 });
  if (confidence < 1.4) { onStatus?.({ phase: 'err', text: 'Klatschen nicht eindeutig erkannt — näher an die Handys, nochmal.' }); return false; }
  const bias = (eL - eR) + lagMs;
  if (Math.abs(bias) > 450) { onStatus?.({ phase: 'err', text: 'Abgleich unplausibel (' + Math.round(bias) + ' ms) — nochmal versuchen.' }); return false; }
  _calibBias.set(peerId, bias);
  hub.sendTo(peerId, { type: 'calibDone', bias: -bias, relay: false }); // Vorzeichen: aus Partnersicht gespiegelt
  onStatus?.({ phase: 'ok', text: '✅ Feinabgleich mit ' + label + ': Versatz ' + Math.round(bias) + ' ms ausgeglichen — Ortung ist jetzt deutlich genauer.' });
  return true;
}

// Partnerseite der Kalibrierung: auf Anforderung das Fenster rund um den Klatsch-Zeitpunkt
// zurückschicken. Läuft das eigene Mikrofon nicht, ehrlich ablehnen statt still scheitern.
function _serveCalib(fromId, msg) {
  const offset = _clockOffsetMs.get(fromId);
  if (offset == null) { hub.sendTo(fromId, { type: 'calibErr', reason: 'sync', relay: false }); return; }
  if (!micRecentlyActive()) { hub.sendTo(fromId, { type: 'calibErr', reason: 'mic', relay: false }); return; }
  if (_calibWaiter) { hub.sendTo(fromId, { type: 'calibErr', reason: 'busy', relay: false }); return; }
  const atLocal = msg.at - offset; // Klatsch-Zeitpunkt in die eigene Uhr umrechnen
  const timer = setTimeout(() => { _calibWaiter = null; }, 9000);
  _calibWaiter = { untilMs: atLocal + 2400, timer, resolve: win => _sendSnippet(fromId, { key: '_calib', ts: msg.at }, win) };
  if (_onCalibEvent) _onCalibEvent({ kind: 'ping', peerId: fromId });
}
