// Kurznachrichten zwischen zwei gekoppelten Handys über den bestehenden RTCDataChannel
// (js/pairing.js stellt die Verbindung her) — läuft direkt Gerät-zu-Gerät, braucht kein Internet
// mehr, sobald die Kopplung einmal steht (nützlich im Funkloch/Wald).
const MAX_LEN = 300;
const MAX_HISTORY = 100;

let _dc = null;
let _onMessageBound = null;
let _onMessage = null;
let _history = [];

// Von app.js aufgerufen, sobald der Datenkanal zum Partner offen ist (parallel zu locate.attach).
export function attach(dc, onMessage) {
  detach();
  _dc = dc;
  _onMessage = onMessage || null;
  _history = [];
  _onMessageBound = e => _handle(e);
  dc.addEventListener('message', _onMessageBound);
}

export function detach() {
  if (_dc && _onMessageBound) _dc.removeEventListener('message', _onMessageBound);
  _dc = null; _onMessageBound = null; _onMessage = null;
}

export function isActive() {
  return !!(_dc && _dc.readyState === 'open');
}

export function getHistory() {
  return _history.slice();
}

export function send(text) {
  const trimmed = String(text || '').trim().slice(0, MAX_LEN);
  if (!trimmed || !isActive()) return null;
  const msg = { text: trimmed, ts: Date.now(), from: 'me' };
  _pushHistory(msg);
  try { _dc.send(JSON.stringify({ type: 'chat', text: trimmed, ts: msg.ts })); } catch {}
  return msg;
}

function _pushHistory(msg) {
  _history.push(msg);
  if (_history.length > MAX_HISTORY) _history.shift();
}

function _handle(e) {
  let raw; try { raw = JSON.parse(e.data); } catch { return; }
  if (raw.type !== 'chat' || typeof raw.text !== 'string') return;
  // Partner-Text ist fremder Input -> beim Anzeigen unbedingt textContent statt innerHTML
  // verwenden (nie als HTML interpretieren), auch wenn hier nur roh gespeichert wird.
  const msg = { text: String(raw.text).slice(0, MAX_LEN), ts: raw.ts || Date.now(), from: 'peer' };
  _pushHistory(msg);
  if (_onMessage) _onMessage(msg);
}
