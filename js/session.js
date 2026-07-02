// Gemeinsamer Session-Bericht: fragt beim gekoppelten Partner-Handy alle Funde seit einem
// Startzeitpunkt ab und führt sie mit den eigenen Funden zu einem gemeinsamen Bericht zusammen —
// läuft komplett über den bestehenden Datenkanal, kein Server nötig.
let _dc = null;
let _onMessageBound = null;
let _sessionStartTs = null;
let _pendingResolve = null;
let _detectionsProvider = null; // von app.js gesetzt: (startTs) => Promise<Array<det>>

export function attach(dc) {
  detach();
  _dc = dc;
  _onMessageBound = e => _handle(e);
  dc.addEventListener('message', _onMessageBound);
}

export function detach() {
  if (_dc && _onMessageBound) _dc.removeEventListener('message', _onMessageBound);
  _dc = null; _onMessageBound = null;
  _pendingResolve = null;
}

export function isActive() {
  return !!(_dc && _dc.readyState === 'open');
}

// Von app.js beim erfolgreichen Koppeln aufgerufen — merkt sich den Startzeitpunkt der Session,
// damit der spätere Bericht nicht die komplette Fund-Historie einschließt.
export function startSession() { _sessionStartTs = Date.now(); }
export function getSessionStart() { return _sessionStartTs || Date.now(); }

// Von app.js gesetzt: liefert die EIGENEN Funde seit einem Zeitpunkt, wenn der Partner danach fragt.
export function setDetectionsProvider(fn) { _detectionsProvider = fn; }

function _send(obj) {
  if (_dc && _dc.readyState === 'open') { try { _dc.send(JSON.stringify(obj)); } catch {} }
}

// Fragt den Partner nach dessen Funden seit startTs — löst mit dessen Liste auf, oder null bei
// Timeout/keiner Verbindung (dann zeigt der Bericht eben nur die eigenen Funde).
export function requestPeerDetections(startTs, timeoutMs = 8000) {
  return new Promise(res => {
    if (!isActive()) { res(null); return; }
    const to = setTimeout(() => { if (_pendingResolve === wrapped) { _pendingResolve = null; res(null); } }, timeoutMs);
    const wrapped = data => { clearTimeout(to); res(data); };
    _pendingResolve = wrapped;
    _send({ type: 'sessionreq', startTs });
  });
}

async function _handle(e) {
  let raw; try { raw = JSON.parse(e.data); } catch { return; }
  if (raw.type === 'sessionreq') {
    const dets = _detectionsProvider ? await _detectionsProvider(raw.startTs) : [];
    _send({ type: 'sessionresp', dets });
    return;
  }
  if (raw.type === 'sessionresp') {
    if (_pendingResolve) { const r = _pendingResolve; _pendingResolve = null; r(raw.dets || []); }
  }
}
