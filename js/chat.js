// Kurznachrichten (Text + Sprachnachrichten/Walkie-Talkie) zwischen zwei gekoppelten Handys über
// den bestehenden RTCDataChannel (js/pairing.js stellt die Verbindung her) — läuft direkt
// Gerät-zu-Gerät, braucht kein Internet mehr, sobald die Kopplung einmal steht.
const MAX_LEN = 300;
const MAX_HISTORY = 100;
const MAX_VOICE_SEC = 15; // Sicherheitsgrenze: Datenkanal-Nachrichten dürfen nicht beliebig groß werden

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
  const msg = { kind: 'text', text: trimmed, ts: Date.now(), from: 'me' };
  _pushHistory(msg);
  try { _dc.send(JSON.stringify({ type: 'chat', text: trimmed, ts: msg.ts })); } catch {}
  return msg;
}

// Sprachnachricht senden (Blob aus MediaRecorder, z.B. audio/webm). Wird als Base64 über den
// Datenkanal geschickt — dafür bewusst kurz gehalten (MAX_VOICE_SEC), damit die Nachricht nicht
// an evtl. Größenlimits des Datenkanals stößt.
export async function sendVoice(blob, durationSec) {
  if (!blob || !isActive()) return null;
  const b64 = await _blobToBase64(blob);
  const ts = Date.now();
  try { _dc.send(JSON.stringify({ type: 'chatvoice', data: b64, mime: blob.type || 'audio/webm', dur: Math.round(durationSec || 0), ts })); }
  catch (e) { console.warn('voice send', e); return null; }
  const msg = { kind: 'voice', blob, url: URL.createObjectURL(blob), durationSec: Math.round(durationSec || 0), ts, from: 'me' };
  _pushHistory(msg);
  return msg;
}

function _pushHistory(msg) {
  _history.push(msg);
  if (_history.length > MAX_HISTORY) _history.shift();
}

function _blobToBase64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onloadend = () => res(String(reader.result).split(',')[1] || '');
    reader.onerror = () => rej(reader.error);
    reader.readAsDataURL(blob);
  });
}
function _base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'audio/webm' });
}

function _handle(e) {
  let raw; try { raw = JSON.parse(e.data); } catch { return; }
  if (raw.type === 'chat' && typeof raw.text === 'string') {
    // Partner-Text ist fremder Input -> beim Anzeigen unbedingt textContent statt innerHTML
    // verwenden (nie als HTML interpretieren), auch wenn hier nur roh gespeichert wird.
    const msg = { kind: 'text', text: String(raw.text).slice(0, MAX_LEN), ts: raw.ts || Date.now(), from: 'peer' };
    _pushHistory(msg);
    if (_onMessage) _onMessage(msg);
    return;
  }
  if (raw.type === 'chatvoice' && typeof raw.data === 'string') {
    let blob; try { blob = _base64ToBlob(raw.data, raw.mime); } catch { return; }
    if (!blob.size) return;
    const msg = { kind: 'voice', blob, url: URL.createObjectURL(blob), durationSec: Math.min(MAX_VOICE_SEC, raw.dur || 0), ts: raw.ts || Date.now(), from: 'peer' };
    _pushHistory(msg);
    if (_onMessage) _onMessage(msg);
  }
}

export const MAX_VOICE_SECONDS = MAX_VOICE_SEC;
