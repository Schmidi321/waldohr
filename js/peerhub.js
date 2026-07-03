// Verwaltet alle aktiven Partner-Verbindungen (RTCDataChannels) an einer Stelle, damit die
// anderen Module (chat/locate/session/filetransfer) nicht mehr wissen müssen, ob sie gerade mit
// EINEM Partner (2er-Kopplung) oder MEHREREN gleichzeitig (Stern-Modell) sprechen.
//
// Rollen ergeben sich automatisch aus der Anzahl Verbindungen, keine explizite Auswahl nötig: wer
// mit 2+ Handys gleichzeitig gekoppelt ist, wird zur "Zentrale" und leitet Nachrichten zwischen
// den anderen weiter (Relay) — dadurch sehen/hören sich auch die Speichen-Handys untereinander,
// obwohl jede Speiche selbst nur die eine Verbindung zur Zentrale hat. Ein `_hop`-Feld markiert
// bereits weitergeleitete Nachrichten, damit daraus keine Weiterleitungs-Schleife entstehen kann.
const _peers = new Map(); // peerId -> { dc, label }
let _nextId = 1;
const _handlers = new Set(); // (msg, originPeerId) => void
const _peerListListeners = new Set(); // () => void, feuert bei jeder Änderung der Peer-Liste

function _notifyPeerListChange() {
  for (const fn of _peerListListeners) { try { fn(); } catch {} }
}

// Registriert einen neu verbundenen Partner-Kanal, vergibt eine fortlaufende Nummer (für die
// Karten-Anzeige "Partner 1/2/3…") und meldet eingehende Nachrichten an alle angemeldeten Module.
export function addPeer(dc, label) {
  const id = _nextId++;
  const entry = { dc, label: label || ('Partner ' + id) };
  _peers.set(id, entry);
  dc.addEventListener('message', e => _onMessage(id, e));
  _notifyPeerListChange();
  return id;
}

export function removePeer(id) {
  if (_peers.delete(id)) _notifyPeerListChange();
}

export function resetAll() {
  if (_peers.size) { _peers.clear(); _notifyPeerListChange(); }
}

export function peerList() {
  return [..._peers.entries()].map(([id, p]) => ({ id, label: p.label }));
}

// Feuert bei jeder Änderung der Peer-Liste (neu verbunden/getrennt) — z.B. damit js/locate.js pro
// neuem Partner einmalig den Uhren-Abgleich anstoßen kann.
export function onPeerListChange(fn) { _peerListListeners.add(fn); return () => _peerListListeners.delete(fn); }

export function peerCount() { return _peers.size; }
export function isActive() { return _peers.size > 0; }
// "Zentrale" = hält mehr als eine gleichzeitige Verbindung -> leitet zwischen den anderen weiter.
export function isHost() { return _peers.size > 1; }

// Module melden sich EINMAL an (z.B. beim App-Start), nicht pro Verbindung — bekommen danach jede
// Nachricht von jedem aktuellen/künftigen Partner. originPeerId ist immer die ID des Geräts, das
// die Nachricht ursprünglich verschickt hat (auch bei weitergeleiteten Nachrichten über die Zentrale).
export function onMessage(fn) { _handlers.add(fn); return () => _handlers.delete(fn); }

function _send(dc, obj) {
  if (dc.readyState === 'open') { try { dc.send(JSON.stringify(obj)); } catch {} }
}

// Nachricht an einen bestimmten Partner.
export function sendTo(peerId, obj) {
  const p = _peers.get(peerId);
  if (p) _send(p.dc, obj);
}

// Nachricht an ALLE aktuell verbundenen Partner (eigener Ursprung).
export function broadcast(obj) {
  for (const { dc } of _peers.values()) _send(dc, obj);
}

// Größter Sendepuffer über ALLE aktuell verbundenen Kanäle — Backpressure-Grundlage für große
// Übertragungen (js/filetransfer.js), die auf allen Verbindungen gleichzeitig senden.
export function maxBufferedAmount() {
  let max = 0;
  for (const { dc } of _peers.values()) if (dc.bufferedAmount > max) max = dc.bufferedAmount;
  return max;
}

// Wartet, bis bei ALLEN aktuell verbundenen Kanälen der Sendepuffer wieder unter der Schwelle ist.
export function waitUntilBufferBelow(thresholdBytes) {
  return new Promise(res => {
    if (maxBufferedAmount() < thresholdBytes) { res(); return; }
    const dcs = [..._peers.values()].map(p => p.dc);
    let doneCalled = false;
    const finish = () => { if (doneCalled) return; doneCalled = true; res(); };
    for (const dc of dcs) {
      dc.bufferedAmountLowThreshold = Math.floor(thresholdBytes / 2);
      const onLow = () => {
        dc.removeEventListener('bufferedamountlow', onLow);
        if (maxBufferedAmount() < thresholdBytes) finish();
      };
      dc.addEventListener('bufferedamountlow', onLow);
    }
    setTimeout(finish, 4000); // Notnagel, falls ein Kanal währenddessen schließt
  });
}

function _onMessage(fromId, e) {
  let msg; try { msg = JSON.parse(e.data); } catch { return; }
  const originId = msg._origin ?? fromId;
  // Nur die Zentrale (2+ gleichzeitige Verbindungen) leitet weiter, und nur frische, dafür
  // vorgesehene Nachrichten (noch kein _hop, relay!==false) — verhindert sowohl Weiterleitungs-
  // Schleifen als auch, dass reine Punkt-zu-Punkt-Protokolle (z.B. locate.js' Uhren-Abgleich per
  // ping/pong) ungewollt an unbeteiligte Dritte weitergereicht werden.
  if (_peers.size > 1 && !msg._hop && msg.relay !== false) {
    const relayMsg = { ...msg, _hop: true, _origin: originId };
    for (const [id, p] of _peers) { if (id !== fromId) _send(p.dc, relayMsg); }
  }
  for (const fn of _handlers) fn(msg, originId);
}
