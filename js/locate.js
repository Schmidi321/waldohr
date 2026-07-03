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

const SOUND_SPEED_MPS = 343; // Schallgeschwindigkeit in Luft, ~20°C
const MATCH_WINDOW_MS = 4000; // wie weit zeitlich zwei Erkennungen noch als "derselbe Ruf" gelten
const RECENT_KEEP_MS = 8000;

let _active = false;
let _myPos = null;
const _peerPos = new Map(); // peerId -> {lat,lng}
const _clockOffsetMs = new Map(); // peerId -> Offset (nur für DIREKT verbundene Geräte)
const _syncedPeers = new Set();
let _recentLocal = [];
let _onResult = null, _onPeerPos = null;
let _unsubMsg = null, _unsubPeerList = null;

// Von app.js EINMAL beim Start aufgerufen (nicht pro Verbindung). onPeerPos(peerId, pos|null)
// wird bei jedem Positions-Update bzw. beim Trennen eines Partners aufgerufen.
export function attach(onResult, onPeerPos) {
  detach();
  _active = true;
  _onResult = onResult || null;
  _onPeerPos = onPeerPos || null;
  _recentLocal = [];
  _peerPos.clear(); _clockOffsetMs.clear(); _syncedPeers.clear();
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
  _onResult = null; _onPeerPos = null;
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
  if (msg.type === 'detection') { _handlePeerDetection(msg, fromId); }
}

// Von app.js bei jeder neuen lokalen Erkennung aufgerufen — merkt sie sich kurz und meldet sie
// allen gekoppelten Geräten, damit die bei einem eigenen Treffer den Vergleich machen können.
export function reportDetection(det) {
  const now = det.ts;
  _recentLocal = _recentLocal.filter(d => now - d.ts < RECENT_KEEP_MS);
  _recentLocal.push({ key: det.key, species: det.species, ts: det.ts });
  hub.broadcast({ type: 'detection', key: det.key, species: det.species, ts: det.ts });
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

  const deltaMs = match.ts - remoteTsLocal; // >0: ich habe SPÄTER gehört als der Partner -> Partner ist näher
  const firstHeard = deltaMs > 30 ? 'peer' : deltaMs < -30 ? 'me' : 'both';

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

  if (_onResult) {
    _onResult({
      species: match.species, key: match.key, peerId: fromId,
      deltaMs: Math.round(Math.abs(deltaMs)), firstHeard,
      bearingToPeer, baselineM, sideHint, thetaDeg,
    });
  }
}
