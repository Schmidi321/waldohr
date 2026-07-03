// Gemeinsamer Session-Bericht: fragt bei allen gekoppelten Handys (js/peerhub.js — eins oder
// mehrere, im Stern-Modell auch über die Zentrale weitergeleitet) die Funde seit einem
// Startzeitpunkt ab und führt sie mit den eigenen zu einem gemeinsamen Bericht zusammen — läuft
// komplett über den bestehenden Datenkanal, kein Server nötig.
//
// Anfrage UND Antwort laufen bewusst als Broadcast (nicht gezielt adressiert): im Stern-Modell
// leitet die Zentrale jede Broadcast-Nachricht automatisch an alle anderen weiter, wodurch eine
// Antwort einer Speiche ganz von selbst auch bei der fragenden Speiche ankommt — ganz ohne dass
// hier eine geräteübergreifende Adressierung nachgebaut werden müsste.
import * as hub from './peerhub.js';

let _unsub = null;
let _sessionStartTs = null;
let _detectionsProvider = null; // von app.js gesetzt: (startTs) => Promise<Array<det>>

export function attach() {
  detach();
  _unsub = hub.onMessage((msg, fromId) => _handle(msg, fromId));
}

export function detach() {
  if (_unsub) _unsub();
  _unsub = null;
}

export function isActive() {
  return hub.isActive();
}

// Von app.js beim erfolgreichen Koppeln aufgerufen — merkt sich den Startzeitpunkt der Session,
// damit der spätere Bericht nicht die komplette Fund-Historie einschließt.
export function startSession() { _sessionStartTs = Date.now(); }
export function getSessionStart() { return _sessionStartTs || Date.now(); }

// Von app.js gesetzt: liefert die EIGENEN Funde seit einem Zeitpunkt, wenn ein anderes Gerät danach fragt.
export function setDetectionsProvider(fn) { _detectionsProvider = fn; }

// Fragt ALLE gekoppelten Geräte nach deren Funden seit startTs — löst mit einer Liste
// {peerId, dets}[] auf (leer, wenn niemand innerhalb des Timeouts geantwortet hat).
export function requestAllPeerDetections(startTs, timeoutMs = 8000) {
  return new Promise(res => {
    if (!isActive()) { res([]); return; }
    const reqId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const results = new Map(); // peerId -> dets
    const unsub = hub.onMessage((msg, fromId) => {
      if (msg.type === 'sessionresp' && msg.reqId === reqId) results.set(fromId, msg.dets || []);
    });
    hub.broadcast({ type: 'sessionreq', startTs, reqId });
    setTimeout(() => {
      unsub();
      res([...results.entries()].map(([peerId, dets]) => ({ peerId, dets })));
    }, timeoutMs);
  });
}

async function _handle(msg) {
  if (msg.type === 'sessionreq') {
    const dets = _detectionsProvider ? await _detectionsProvider(msg.startTs) : [];
    hub.broadcast({ type: 'sessionresp', dets, reqId: msg.reqId });
  }
}
