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
import { gccPhatAsync, encodeSnippet, decodeSnippet, bytesToB64, b64ToBytes, resampleLinear, CORR_RATE, solve2D, playChirp } from './tdoa.js';

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
let _micController = null;       // von app.js gesetzt: schaltet das eigene Mikrofon bei Bedarf ein
let _resyncTimer = null;         // periodischer Uhren-Re-Sync (Drift-Kompensation)

// app.js reicht hier eine Funktion herein, die das Mikrofon startet (falls aus) und true liefert,
// sobald es läuft — damit die Kalibrierung das Lauschen auf allen Handys selbst anschalten kann,
// statt es vom Nutzer vorauszusetzen.
export function setMicController(fn) { _micController = fn; }

async function _ensureMicOn() {
  if (micRecentlyActive()) return true;
  if (!_micController) return false;
  try { await _micController(); } catch { return false; }
  // Auf das erste echte Audio-Fenster warten (Mikrofon-Warmlauf), max. ~2,5 s
  for (let i = 0; i < 25; i++) {
    if (micRecentlyActive()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return micRecentlyActive();
}
const _recentTdoa = new Map();   // key -> [{peerId,tdoaMs,calibrated,ts,peerPos}] — Sammelbecken für den 3-Geräte-Fix
const _lastFixAt = new Map();    // key -> ts (Drossel für Fix-Popups)

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
  _resyncTimer = setInterval(_resyncAll, 60000);
}

export function detach() {
  if (_unsubMsg) _unsubMsg();
  if (_unsubPeerList) _unsubPeerList();
  _unsubMsg = null; _unsubPeerList = null;
  if (_resyncTimer) { clearInterval(_resyncTimer); _resyncTimer = null; }
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
    if (!_syncedPeers.has(id)) { _syncedPeers.add(id); _syncClock(id, 5); }
  }
}

// Periodischer Re-Sync ALLER Partner: Quarzuhren driften 10–50 ppm — nach einer halben Stunde
// im Feld wäre der einmalige Offset vom Koppeln um Dutzende Millisekunden weg und würde jede
// Laufzeitmessung (und still den Feinabgleich) vergiften. Alle 60 s mit 3 Runden nachziehen.
function _resyncAll() {
  for (const { id } of hub.peerList()) {
    if (_clockOffsetMs.has(id) && !_syncBusy.has(id)) _syncClock(id, 3);
  }
}

// ---- Uhren-Abgleich: NTP-ähnliches Ping-Pong, nimmt den Durchlauf mit geringster Laufzeit ----
// relay:false -> läuft NIE über die Zentrale weiter (siehe js/peerhub.js), ist nur zwischen genau
// diesen zwei direkt verbundenen Geräten aussagekräftig.
const _syncBusy = new Set();
async function _syncClock(peerId, rounds) {
  if (_syncBusy.has(peerId)) return;
  _syncBusy.add(peerId);
  try {
    let best = null;
    for (let i = 0; i < rounds; i++) {
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
    // Miese Verbindung (hoher RTT) -> alten Offset behalten statt einen schlechteren einzubauen.
    if (!best || best.rtt > 400) return;
    const old = _clockOffsetMs.get(peerId);
    _clockOffsetMs.set(peerId, best.offset);
    // Kalibrier-Bias konsistent halten: der rohe TDOA enthält +offset, d.h. ändert sich der
    // Offset um δ, wandert der Roh-TDOA um +δ mit — der beim Feinabgleich gemessene Bias muss
    // denselben Schritt machen, sonst wäre die Kalibrierung nach jedem Re-Sync wertlos.
    if (old != null && _calibBias.has(peerId)) {
      _calibBias.set(peerId, _calibBias.get(peerId) + (best.offset - old));
    }
  } finally { _syncBusy.delete(peerId); }
}

function _onMessage(msg, fromId) {
  if (!_active) return;
  if (msg.type === 'ping') { hub.sendTo(fromId, { type: 'pong', t0: msg.t0, t1: Date.now(), relay: false }); return; }
  if (msg.type === 'pos') {
    // Fremder Input: nur endliche, plausible Koordinaten übernehmen — sonst vergiftet ein
    // fehlerhaftes (oder bösartiges) Gerät alle Basislinien-/Fix-Berechnungen mit NaN.
    if (!Number.isFinite(msg.lat) || !Number.isFinite(msg.lng) || Math.abs(msg.lat) > 90 || Math.abs(msg.lng) > 180) return;
    _peerPos.set(fromId, { lat: msg.lat, lng: msg.lng });
    if (_onPeerPos) _onPeerPos(fromId, _peerPos.get(fromId));
    return;
  }
  if (msg.type === 'snipReq') { _serveSnippet(fromId, msg); return; }
  if (msg.type === 'snipHdr' || msg.type === 'snipChunk') { _collectSnippet(fromId, msg); return; }
  // Zentrale startet den geführten Feinabgleich -> Popup öffnen + eigenes Mikrofon anschalten.
  if (msg.type === 'calibPrep') {
    if (_onCalibEvent) _onCalibEvent({ kind: 'prep', peerId: fromId });
    _ensureMicOn();
    return;
  }
  if (msg.type === 'calibCount') {
    // n landet in der UI in innerHTML -> hier hart auf eine kleine Ganzzahl zwingen (fremder Input!)
    const n = Math.max(1, Math.min(9, Math.round(Number(msg.n)) || 1));
    if (_onCalibEvent) _onCalibEvent({ kind: 'count', n, peerId: fromId });
    return;
  }
  if (msg.type === 'calibEnd') {
    if (_onCalibEvent) _onCalibEvent({ kind: 'end', peerId: fromId });
    return;
  }
  if (msg.type === 'calib') { _serveCalib(fromId, msg); if (_onCalibEvent) _onCalibEvent({ kind: 'clap', peerId: fromId }); return; }
  if (msg.type === 'calibDone') {
    if (typeof msg.bias === 'number' && Math.abs(msg.bias) < 500) {
      _calibBias.set(fromId, msg.bias);
      if (_onCalibEvent) _onCalibEvent({ kind: 'done', peerId: fromId });
    }
    return;
  }
  if (msg.type === 'calibErr') { _calibErrReason = msg.reason || 'unbekannt'; return; }
  if (msg.type === 'fix2d') {
    // 3-Geräte-Fix von der Zentrale. Partner-Strings sind fremder Input -> nur validierte Felder
    // übernehmen; die Anzeige (app.js) escaped den Artnamen zusätzlich.
    if (typeof msg.lat !== 'number' || typeof msg.lng !== 'number' || Math.abs(msg.lat) > 90 || Math.abs(msg.lng) > 180) return;
    if (_onResult) {
      _onResult({
        method: 'fix', key: String(msg.key || ''), species: String(msg.species || 'Unbekannt').slice(0, 60),
        lat: msg.lat, lng: msg.lng, uncertM: Math.min(Math.max(Math.round(msg.uncertM) || 50, 10), 500),
        dirSpreadDeg: Math.min(Math.max(Math.round(msg.dirSpreadDeg) || 15, 6), 45),
        rangeMinM: Math.max(Math.round(msg.rangeMinM) || 0, 0), rangeMaxM: Math.min(Math.max(Math.round(msg.rangeMaxM) || 0, 0), 2000),
        calibrated: !!msg.calibrated, nPhones: Math.max(3, Math.min(6, Math.round(msg.nPhones) || 3)), peerId: fromId,
      });
    }
    return;
  }
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
  // Bei sich wiederholenden Rufen liegen mehrere eigene Fenster derselben Art im Puffer — das
  // ZEITLICH NÄCHSTE zum Partner-Zeitstempel nehmen (maximale Signal-Überlappung), nicht das
  // älteste, das .find() liefern würde.
  const offsetGuess = _clockOffsetMs.get(fromId) ?? 0;
  let match = null, bestDt = Infinity;
  for (const d of _recentLocal) {
    if (d.key !== msg.key) continue;
    const dt = Math.abs(d.ts - (msg.ts - offsetGuess));
    if (dt < bestDt) { bestDt = dt; match = d; }
  }
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
      if (p) {
        _emitResult(match, fromId, p.tdoaMs, { method: 'corr', corrConf: p.confidence, calibrated: p.calibrated });
        _collectForFix(fromId, match, p);
      }
      else _emitResult(match, fromId, match.ts - remoteTsLocal, { method: 'clock' });
    });
    return;
  }
  _emitResult(match, fromId, match.ts - remoteTsLocal, { method: 'clock' });
}

// ---- 3-Geräte-Fix: hat die Zentrale für DENSELBEN Ruf präzise Laufzeitdifferenzen zu zwei
// verschiedenen Partnern, schneiden sich die beiden Hyperbeln in einem Punkt — daraus wird eine
// echte 2D-Position (js/tdoa.js solve2D) berechnet und an alle Partner verteilt. Läuft bewusst
// nur auf der Zentrale: nur sie hat den direkten Uhren-Abgleich zu allen Beteiligten. ----
function _collectForFix(fromId, match, p) {
  const peerPos = _peerPos.get(fromId);
  if (!_myPos || !peerPos || !hub.isHost()) return;
  const now = Date.now();
  const list = (_recentTdoa.get(match.key) || []).filter(e => now - e.ts < 8000 && e.peerId !== fromId);
  list.push({ peerId: fromId, tdoaMs: p.tdoaMs, calibrated: p.calibrated, ts: now, peerPos: { ...peerPos } });
  _recentTdoa.set(match.key, list);
  if (list.length < 2) return;
  if (now - (_lastFixAt.get(match.key) || 0) < 20000) return;

  // Lokales ebenes Koordinatensystem (Meter) um die eigene Position
  const lat0 = _myPos.lat, lng0 = _myPos.lng;
  const mPerLng = 111320 * Math.cos(lat0 * Math.PI / 180), mPerLat = 110540;
  const toXY = pos => ({ x: (pos.lng - lng0) * mPerLng, y: (pos.lat - lat0) * mPerLat });
  // ALLE frischen Partner-Messungen nutzen (bis zu 3 -> 4 Stationen): jede zusätzliche Hyperbel
  // überbestimmt das System und drückt Richtungs- UND Entfernungs-Unsicherheit deutlich.
  const used = list.slice(-3);
  const stations = [{ x: 0, y: 0 }, ...used.map(e => toXY(e.peerPos))];
  const allCalib = used.every(e => e.calibrated);
  // Konvention: tdoaMs = Ankunft bei MIR minus Ankunft beim Partner -> i=0 (ich), j=Partner
  // sigmaMs = realistische TDOA-Messunsicherheit: kalibriert bleiben nur Korrelations- und
  // Uhrenrest-Fehler (~6 ms), unkalibriert dominiert die unbekannte Mikrofonlatenz-Differenz.
  const sol = solve2D(stations,
    used.map((e, idx) => ({ i: 0, j: idx + 1, dtMs: e.tdoaMs })),
    { sigmaMs: allCalib ? 6 : 45 });
  // Gate auf RICHTUNGS-Genauigkeit statt absoluten Radius: bei entfernter Quelle ist die
  // Entfernung geometriebedingt immer unscharf (flacher Hyperbel-Schnitt), die Richtung aber
  // brauchbar — und genau die zählt für Fotografen. Der feste Zuschlag deckt den GPS-Fehler der
  // Empfänger-Positionen ab (verschiebt die Peilung, ist im Residuum unsichtbar). Inkonsistente
  // Messungen (Residuum) raus; unkalibriert scheitert das Gate fast immer -> dann bleibt es
  // ehrlich bei den paarweisen Richtungszonen.
  const GPS_DIR_DEG = 12;
  if (!sol || sol.dirSpreadDeg + GPS_DIR_DEG > 40 || sol.residual > (allCalib ? 45 : 180)) return;
  _lastFixAt.set(match.key, now);
  _recentTdoa.delete(match.key);

  const fix = {
    key: match.key, species: match.species,
    lat: lat0 + sol.y / mPerLat, lng: lng0 + sol.x / mPerLng,
    uncertM: Math.max(sol.uncertM, 15), dirSpreadDeg: Math.min(sol.dirSpreadDeg + GPS_DIR_DEG, 40),
    rangeMinM: sol.rangeMinM, rangeMaxM: sol.rangeMaxM,
    calibrated: allCalib, nPhones: stations.length,
  };
  hub.broadcast({ type: 'fix2d', ...fix, relay: false });
  if (_onResult) _onResult({ method: 'fix', ...fix, peerId: null });
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
    // Im Worker rechnen: blockiert weder UI noch die Mikrofon-Verarbeitung (beide Puffer sind
    // Einweg-Kopien und werden transferiert).
    const corr = await gccPhatAsync(local16, snip.samples, CORR_RATE, { centerMs: eR - eL, halfMs: maxTdoaMs });
    if (!corr || corr.confidence < CORR_MIN_CONF) return null;
    let tdoaMs = (eL - eR) + corr.lagMs;
    const bias = _calibBias.get(fromId);
    if (bias != null) tdoaMs -= bias;
    return { tdoaMs, confidence: corr.confidence, calibrated: bias != null };
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

// Geführter Feinabgleich, von der Zentrale aus mit EINEM Knopfdruck für ALLE Partner:
//  1. Partner-Popups öffnen (calibPrep) — dort startet das Mikrofon automatisch.
//  2. Eigenes Mikrofon sicherstellen, kurz warmlaufen lassen.
//  3. 3-2-1-Countdown auf allen Geräten, dann EIN gemeinsamer Klatscher.
//  4. Alle Partner-Schnipsel um denselben Klatsch-Zeitpunkt holen und je den Bias bestimmen.
// So muss der Nutzer nur einmal klatschen (Geräte liegen zusammen) und nichts vorab einschalten.
export async function startCalibration(onStatus) {
  const peers = hub.peerList().filter(p => _clockOffsetMs.get(p.id) != null);
  if (!peers.length) { onStatus?.({ phase: 'err', text: 'Kein direkt verbundener Partner mit Uhren-Abgleich — erst koppeln und kurz warten.' }); return false; }

  // 1. Partner vorbereiten (Popup + Mikro an)
  for (const p of peers) hub.sendTo(p.id, { type: 'calibPrep', relay: false });
  onStatus?.({ phase: 'prep', text: 'Alle Handys flach nebeneinander legen…' });

  // 2. Eigenes Mikrofon anschalten + warmlaufen
  if (!(await _ensureMicOn())) {
    for (const p of peers) hub.sendTo(p.id, { type: 'calibEnd', relay: false });
    onStatus?.({ phase: 'err', text: 'Eigenes Mikrofon ließ sich nicht starten.' });
    return false;
  }
  await new Promise(r => setTimeout(r, 800)); // Partner-Mikros ebenfalls warmlaufen lassen

  // 3. Countdown auf allen Geräten
  for (let n = 3; n >= 1; n--) {
    onStatus?.({ phase: 'count', text: 'Gleich klatschen … ' + n });
    for (const p of peers) hub.sendTo(p.id, { type: 'calibCount', n, relay: false });
    await new Promise(r => setTimeout(r, 800));
  }
  _calibErrReason = null;
  const at = Date.now() + 250; // gemeinsamer Ton-Zeitpunkt, minimal in der Zukunft
  for (const p of peers) hub.sendTo(p.id, { type: 'calib', at, relay: false });
  onStatus?.({ phase: 'clap', text: '🔊 Kalibrier-Ton…' });
  // Chirp-Kalibrierung (Stufe 4): statt eines menschlichen Klatschers spielt die Zentrale einen
  // kurzen, breitbandigen Frequenz-Sweep ab (js/tdoa.js playChirp). Alle Handys liegen nebeneinander
  // und hören denselben Ton — die scharfe Autokorrelation eines Chirps liefert einen deutlich
  // saubereren Peak als ein Klatschen und braucht keine menschliche Aktion im richtigen Moment.
  // Ein zusätzliches Klatschen stört nicht (die Korrelation nimmt den stärksten Transienten).
  playChirp();

  // Eigenes Fenster um den Klatsch-Zeitpunkt abwarten
  const win = await new Promise(res => {
    if (_calibWaiter) { res(null); return; }
    const timer = setTimeout(() => { _calibWaiter = null; res(null); }, 9000);
    _calibWaiter = { untilMs: at + 2400, timer, resolve: res };
  });
  if (!win) {
    for (const p of peers) hub.sendTo(p.id, { type: 'calibEnd', relay: false });
    onStatus?.({ phase: 'err', text: 'Kein eigenes Audio-Fenster erhalten — nochmal versuchen.' });
    return false;
  }

  // 4. Je Partner den Klatscher vergleichen
  onStatus?.({ phase: 'work', text: 'Vergleiche die Aufnahmen…' });
  const results = [];
  for (const peer of peers) results.push(await _correlateClap(peer.id, peer.label, at, win));
  for (const p of peers) hub.sendTo(p.id, { type: 'calibEnd', relay: false });

  const okCount = results.filter(r => r.ok).length;
  if (okCount === peers.length) {
    onStatus?.({ phase: 'ok', text: '✅ Feinabgleich fertig — ' + okCount + ' Partner abgeglichen. Die Ortung ist jetzt deutlich genauer.' });
    return true;
  }
  if (okCount > 0) {
    onStatus?.({ phase: 'ok', text: '✅ ' + okCount + ' von ' + peers.length + ' Partnern abgeglichen. Für den Rest nochmal versuchen (näher zusammen, lauter klatschen).' });
    return true;
  }
  const why = results[0]?.reason;
  onStatus?.({ phase: 'err', text: why === 'mic' ? 'Partner-Mikrofon war nicht bereit — nochmal versuchen.' : why === 'conf' ? 'Klatschen nicht klar erkannt — Handys näher zusammen, lauter klatschen.' : 'Feinabgleich nicht geklappt — nochmal versuchen.' });
  return false;
}

// Ein bereits aufgenommener eigener Klatsch-Ausschnitt (win) wird mit dem Partner-Ausschnitt um
// denselben Zeitpunkt (at) verglichen -> systematischer Versatz (Bias) dieses Gerätepaars.
async function _correlateClap(peerId, label, at, win) {
  _calibErrReason = null;
  const snip = await _requestSnippet(peerId, { key: '_calib', ts: at });
  if (_calibErrReason || !snip) return { ok: false, reason: _calibErrReason || 'nosnip', label };
  const offset = _clockOffsetMs.get(peerId);
  if (offset == null) return { ok: false, reason: 'sync', label };
  const eL = win.endMs, eR = snip.endMs - offset;
  const local16 = resampleLinear(win.samples, win.rate, CORR_RATE);
  // Chirp/Klatschen ist breitbandig — Band nach unten öffnen, Suchfenster eng (Geräte nebeneinander)
  const corr = await gccPhatAsync(local16, snip.samples, CORR_RATE, { centerMs: eR - eL, halfMs: 500, bandLo: 700 });
  if (!corr || corr.confidence < 1.4) return { ok: false, reason: 'conf', label };
  const bias = (eL - eR) + corr.lagMs;
  if (Math.abs(bias) > 450) return { ok: false, reason: 'bias', label };
  _calibBias.set(peerId, bias);
  hub.sendTo(peerId, { type: 'calibDone', bias: -bias, relay: false }); // Vorzeichen aus Partnersicht gespiegelt
  return { ok: true, bias: Math.round(bias), label };
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
