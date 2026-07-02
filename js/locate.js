// Gemeinsame Ruf-Ortung zwischen zwei gekoppelten Handys (js/pairing.js stellt die Verbindung
// her). Beide Geräte melden sich gegenseitig jede Erkennung; wenn beide denselben Ruf im selben
// Zeitfenster hören, wird aus dem Zeitversatz und der GPS-Position beider Geräte eine grobe
// Einschätzung berechnet, welches Gerät näher dran ist und aus welcher Himmelsrichtung der Ruf
// ungefähr kam.
//
// Wichtige Einschränkung (bewusst konservativ kommuniziert statt falsch-genau): aus nur zwei
// Empfängern lässt sich physikalisch keine eindeutige Peilung berechnen, sondern nur eine grobe
// Aussage (näher an welchem Gerät + ob eher quer oder eher entlang der Verbindungslinie) — für
// eine echte Richtung bräuchte es einen dritten Referenzpunkt.
import { bearingDeg, haversineKm } from './db.js';

const SOUND_SPEED_MPS = 343; // Schallgeschwindigkeit in Luft, ~20°C
const MATCH_WINDOW_MS = 4000; // wie weit zeitlich zwei Erkennungen noch als "derselbe Ruf" gelten
const RECENT_KEEP_MS = 8000;

let _dc = null;
let _clockOffsetMs = 0; // wird zu Partner-Zeitstempeln addiert, um sie in lokale Zeit umzurechnen
let _myPos = null, _peerPos = null;
let _recentLocal = [];
let _onResult = null, _onPeerPos = null;
let _onMessageBound = null;

// Von app.js aufgerufen, sobald der Datenkanal zum Partner offen ist. onPeerPos(null) wird beim
// detach() ausgelöst, damit z.B. der Kartenmarker des Partners wieder verschwindet.
export function attach(dc, onResult, onPeerPos) {
  detach();
  _dc = dc;
  _onResult = onResult || null;
  _onPeerPos = onPeerPos || null;
  _recentLocal = [];
  _clockOffsetMs = 0;
  _peerPos = null;
  _onMessageBound = e => _onMessage(e);
  dc.addEventListener('message', _onMessageBound);
  syncClock();
}

export function detach() {
  if (_dc && _onMessageBound) _dc.removeEventListener('message', _onMessageBound);
  _dc = null; _onMessageBound = null;
  _peerPos = null;
  if (_onPeerPos) _onPeerPos(null);
  _onResult = null; _onPeerPos = null;
}

export function isActive() {
  return !!(_dc && _dc.readyState === 'open');
}

function _send(obj) {
  if (_dc && _dc.readyState === 'open') { try { _dc.send(JSON.stringify(obj)); } catch {} }
}

// Eigene Position ans andere Gerät melden (für die Basislinien-Peilung nötig).
export function setLocalPos(pos) {
  if (!pos) return;
  _myPos = { lat: pos.lat, lng: pos.lng };
  _send({ type: 'pos', lat: pos.lat, lng: pos.lng });
}

// ---- Uhren-Abgleich: NTP-ähnliches Ping-Pong, nimmt den Durchlauf mit geringster Laufzeit ----
async function syncClock() {
  let best = null;
  for (let i = 0; i < 5; i++) {
    if (!isActive()) break;
    const t0 = Date.now();
    const result = await new Promise(res => {
      const onPong = e => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type !== 'pong' || msg.t0 !== t0) return;
        _dc.removeEventListener('message', onPong);
        const t2 = Date.now(), rtt = t2 - t0;
        res({ offset: msg.t1 - (t0 + rtt / 2), rtt });
      };
      _dc.addEventListener('message', onPong);
      _send({ type: 'ping', t0 });
      setTimeout(() => { _dc.removeEventListener('message', onPong); res(null); }, 2000);
    });
    if (result && (!best || result.rtt < best.rtt)) best = result;
    await new Promise(r => setTimeout(r, 150));
  }
  if (best) _clockOffsetMs = best.offset;
}

function _onMessage(e) {
  let msg; try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.type === 'ping') { _send({ type: 'pong', t0: msg.t0, t1: Date.now() }); return; }
  if (msg.type === 'pos') {
    _peerPos = { lat: msg.lat, lng: msg.lng };
    if (_onPeerPos) _onPeerPos(_peerPos);
    return;
  }
  if (msg.type === 'detection') { _handlePeerDetection(msg); }
}

// Von app.js bei jeder neuen lokalen Erkennung aufgerufen — merkt sie sich kurz und meldet sie
// dem Partner, damit der bei einem eigenen Treffer den Vergleich machen kann (und umgekehrt).
export function reportDetection(det) {
  const now = det.ts;
  _recentLocal = _recentLocal.filter(d => now - d.ts < RECENT_KEEP_MS);
  _recentLocal.push({ key: det.key, species: det.species, ts: det.ts });
  _send({ type: 'detection', key: det.key, species: det.species, ts: det.ts });
}

function _handlePeerDetection(msg) {
  // _clockOffsetMs = "wie weit die Partner-Uhr der eigenen voraus ist" (aus syncClock: t1 - (t0+rtt/2)
  // beim Ping VON hier AUS betrachtet) -> zum Umrechnen in die eigene Zeitbasis muss das abgezogen
  // werden (Partner-Zeitstempel MINUS Offset), nicht addiert.
  const remoteTsLocal = msg.ts - _clockOffsetMs; // Partner-Zeitstempel in lokale Zeitbasis umrechnen
  const match = _recentLocal.find(d => d.key === msg.key && Math.abs(d.ts - remoteTsLocal) <= MATCH_WINDOW_MS);
  if (!match) return;

  const deltaMs = match.ts - remoteTsLocal; // >0: ich habe SPÄTER gehört als der Partner -> Partner ist näher
  const firstHeard = deltaMs > 30 ? 'peer' : deltaMs < -30 ? 'me' : 'both';

  let bearingToPeer = null, baselineM = null, sideHint = null;
  if (_myPos && _peerPos) {
    baselineM = Math.round(haversineKm(_myPos, _peerPos) * 1000);
    bearingToPeer = Math.round(bearingDeg(_myPos, _peerPos));
    if (baselineM > 1) {
      const sinTheta = Math.max(-1, Math.min(1, (SOUND_SPEED_MPS * (Math.abs(deltaMs) / 1000)) / baselineM));
      const thetaDeg = Math.asin(sinTheta) * 180 / Math.PI;
      sideHint = thetaDeg < 20 ? 'eher mittig zwischen euch' : thetaDeg > 60 ? 'eher seitlich, nah an der Verbindungslinie' : 'irgendwo dazwischen';
    }
  }

  if (_onResult) {
    _onResult({
      species: match.species, key: match.key,
      deltaMs: Math.round(Math.abs(deltaMs)), firstHeard,
      bearingToPeer, baselineM, sideHint,
    });
  }
}
