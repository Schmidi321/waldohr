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
const _topoListeners = new Set(); // () => void, feuert wenn sich die Rolle/Nummer der Gegenstelle ändert

// Von der jeweils EINZIGEN Gegenstelle zugewiesene eigene Nummer + deren Verbindungszahl — nur
// aussagekräftig, solange man selbst genau eine Verbindung hat (Speiche). Wird per kleinem
// Meta-Protokoll (_topo, s.u.) übertragen, damit z.B. eine Speiche anzeigen kann "Du bist Partner 2,
// verbunden mit der Zentrale (3 Geräte insgesamt)".
let _myId = null, _remoteTotal = null;

function _notifyPeerListChange() {
  for (const fn of _peerListListeners) { try { fn(); } catch {} }
}

// Jedem direkt verbundenen Gerät die eigene Sicht auf die Lage mitteilen: welche Nummer es bei mir
// hat + wie viele Verbindungen ich insgesamt halte (>1 heißt: ich bin gerade die Zentrale). relay:
// false, da das nur zwischen direkt verbundenen Geräten Sinn ergibt, nicht über Dritte weitergereicht.
function _broadcastTopo() {
  for (const [id, p] of _peers) _send(p.dc, { type: '_topo', yourId: id, hostTotal: _peers.size, relay: false });
}

// Registriert einen neu verbundenen Partner-Kanal, vergibt eine fortlaufende Nummer (für die
// Karten-Anzeige "Partner 1/2/3…") und meldet eingehende Nachrichten an alle angemeldeten Module.
export function addPeer(dc, label) {
  const id = _nextId++;
  const entry = { dc, label: label || ('Partner ' + id) };
  _peers.set(id, entry);
  dc.addEventListener('message', e => _onMessage(id, e));
  _notifyPeerListChange();
  _broadcastTopo();
  // Beide Seiten rufen addPeer() etwa zeitgleich auf (reagieren auf dasselbe 'open'-Ereignis) — der
  // erste, sofortige Broadcast kann die Gegenstelle daher knapp verpassen, falls die ihren eigenen
  // Message-Listener noch nicht registriert hat. Ein zweiter, verzögerter Versuch fängt das ab.
  setTimeout(_broadcastTopo, 800);
  return id;
}

export function removePeer(id) {
  if (_peers.delete(id)) {
    if (!_peers.size) { _myId = null; _remoteTotal = null; }
    _notifyPeerListChange(); _broadcastTopo();
  }
}

export function resetAll() {
  if (_peers.size) { _peers.clear(); _myId = null; _remoteTotal = null; _notifyPeerListChange(); }
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

// Eigene Nummer aus Sicht der (einzigen) Gegenstelle, bzw. wie viele Verbindungen sie insgesamt
// hält (>1 -> sie ist die Zentrale) — null, solange das noch nicht mitgeteilt wurde.
export function myAssignedId() { return _myId; }
export function remotePeerCount() { return _remoteTotal; }
export function onTopoChange(fn) { _topoListeners.add(fn); return () => _topoListeners.delete(fn); }

// Module melden sich EINMAL an (z.B. beim App-Start), nicht pro Verbindung — bekommen danach jede
// Nachricht von jedem aktuellen/künftigen Partner. originPeerId ist immer die ID des Geräts, das
// die Nachricht ursprünglich verschickt hat (auch bei weitergeleiteten Nachrichten über die Zentrale).
export function onMessage(fn) { _handlers.add(fn); return () => _handlers.delete(fn); }

// Gibt zurück, ob der Versand tatsächlich geklappt hat (Kanal offen + kein Fehler beim Senden) —
// z.B. js/chat.js braucht das für Sprachnachrichten, um bei einer zu großen Nachricht (Datenkanäle
// haben ein implementierungsabhängiges Größenlimit) nicht fälschlich "gesendet" anzuzeigen.
function _send(dc, obj) {
  if (dc.readyState !== 'open') return false;
  try { dc.send(JSON.stringify(obj)); return true; } catch { return false; }
}

// Nachricht an einen bestimmten Partner.
export function sendTo(peerId, obj) {
  const p = _peers.get(peerId);
  if (p) _send(p.dc, obj);
}

// Nachricht an ALLE aktuell verbundenen Partner (eigener Ursprung). Rückgabewert: true nur, wenn
// es mindestens einen Partner gab UND der Versand bei ALLEN geklappt hat (sonst false) — nötig,
// damit Aufrufer wie chat.js einen fehlgeschlagenen Versand (z.B. Nachricht zu groß) erkennen
// können, statt ihn stillschweigend als erfolgreich zu behandeln.
export function broadcast(obj) {
  let ok = _peers.size > 0;
  for (const { dc } of _peers.values()) { if (!_send(dc, obj)) ok = false; }
  return ok;
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
  // Meta-Protokoll für die Rollen-/Nummern-Anzeige — wird hier verarbeitet und konsumiert, nicht
  // an die App-Module (chat/locate/...) weitergereicht.
  if (msg.type === '_topo') {
    _myId = msg.yourId; _remoteTotal = msg.hostTotal;
    for (const fn of _topoListeners) { try { fn(); } catch {} }
    return;
  }
  // _origin nur übernehmen, wenn ICH SELBST gerade eine Speiche bin (genau 1 Verbindung = zur
  // Zentrale) — dann stammt _origin ehrlich aus DEREN Relay-Logik (s. unten), der ich als einziger
  // Gegenstelle ohnehin vertrauen muss. Bin ich dagegen selbst die Zentrale (2+ Verbindungen),
  // NIE einem von einer Speiche direkt gesendeten _origin trauen: `msg._hop`/`msg._origin` sind
  // nur JSON-Felder, die jede Gegenstelle beliebig selbst setzen kann — eine böswillige Speiche
  // könnte sonst mit `{_hop:true, _origin:<fremde Id>}` die Identität eines anderen Partners
  // fälschen (Peer-IDs sind kleine, erratbare Zahlen). Die Zentrale muss originId daher IMMER aus
  // der echten Verbindung (fromId) ableiten, egal was die Nachricht selbst behauptet.
  const originId = (_peers.size <= 1 && msg._origin != null) ? msg._origin : fromId;
  // Nur die Zentrale (2+ gleichzeitige Verbindungen) leitet weiter, und nur frische, dafür
  // vorgesehene Nachrichten (noch kein _hop, relay!==false) — verhindert sowohl Weiterleitungs-
  // Schleifen als auch, dass reine Punkt-zu-Punkt-Protokolle (z.B. locate.js' Uhren-Abgleich per
  // ping/pong) ungewollt an unbeteiligte Dritte weitergereicht werden.
  if (_peers.size > 1 && !msg._hop && msg.relay !== false) {
    const relayMsg = { ...msg, _hop: true, _origin: originId };
    for (const [id, p] of _peers) { if (id !== fromId) _send(p.dc, relayMsg); }
  }
  // Wie bei den topo-/Peer-Listen-Listenern oben: ein Handler, der bei kaputten/unerwarteten
  // Nachrichten wirft, darf die Zustellung an die übrigen angemeldeten Handler nicht abbrechen.
  for (const fn of _handlers) { try { fn(msg, originId); } catch (e) { console.warn('peerhub: Handler-Fehler', e); } }
}
