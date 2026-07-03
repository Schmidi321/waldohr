// Direkte Foto-/Video-Übertragung an ALLE gekoppelten Partner-Handys (js/peerhub.js — eins oder
// mehrere, im Stern-Modell auch über die Zentrale weitergeleitet), komplett ohne Internet. Da ein
// einzelner Sendevorgang auf einem Datenkanal nicht beliebig groß sein darf (Kompatibilität
// zwischen Browsern/Geräten), wird die Datei in kleine Stücke zerlegt und auf der Empfängerseite
// wieder zusammengesetzt.
import * as hub from './peerhub.js';

const CHUNK_SIZE = 16 * 1024; // sichere Größe, die auf allen gängigen WebRTC-Implementierungen funktioniert
const MAX_FILE_SIZE = 25 * 1024 * 1024; // Sicherheitsgrenze, damit eine Übertragung nicht endlos dauert/Speicher sprengt
const BUFFER_HIGH = 1 * 1024 * 1024; // ab hier abwarten, bevor weitere Stücke gesendet werden

let _unsub = null;
let _onIncoming = null;
let _onProgress = null;
let _incoming = new Map(); // transferId -> { chunks, mime, kind, name, total, received }

export function attach(onIncoming, onProgress) {
  detach();
  _onIncoming = onIncoming || null;
  _onProgress = onProgress || null;
  _incoming = new Map();
  _unsub = hub.onMessage((msg, fromId) => _handle(msg, fromId));
}

export function detach() {
  if (_unsub) _unsub();
  _unsub = null;
  _onIncoming = null; _onProgress = null;
  _incoming.clear();
}

export function isActive() {
  return hub.isActive();
}

function _chunkToBase64(chunkBlob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onloadend = () => res(String(reader.result).split(',')[1] || '');
    reader.onerror = () => rej(reader.error);
    reader.readAsDataURL(chunkBlob);
  });
}

// kind: 'photo' | 'video'. Geht an ALLE gerade gekoppelten Geräte. Meldet Fortschritt über
// onProgress({direction:'send', sent, total}).
export async function sendFile(blob, kind, name) {
  if (!isActive()) throw new Error('nicht verbunden');
  if (blob.size > MAX_FILE_SIZE) throw new Error('Datei zu groß (max. 25 MB)');
  const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const totalChunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));
  hub.broadcast({ type: 'filestart', id, kind, name: name || '', mime: blob.type || '', size: blob.size, chunks: totalChunks });
  for (let i = 0; i < totalChunks; i++) {
    await hub.waitUntilBufferBelow(BUFFER_HIGH);
    if (!isActive()) throw new Error('Verbindung während der Übertragung verloren');
    const chunkBlob = blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const data = await _chunkToBase64(chunkBlob);
    hub.broadcast({ type: 'filechunk', id, i, data });
    if (_onProgress) _onProgress({ direction: 'send', sent: i + 1, total: totalChunks });
  }
  hub.broadcast({ type: 'fileend', id });
}

function _base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function _handle(raw, fromId) {
  // transferId ist zufällig genug, aber falls doch zwei Geräte gleichzeitig eine eigene
  // Übertragung mit derselben id starten sollten, mit der Absender-Kennung entschärfen.
  const key = fromId + ':' + raw.id;
  if (raw.type === 'filestart') {
    if (typeof raw.size === 'number' && raw.size > MAX_FILE_SIZE) return; // ignoriert überdimensionierte/fehlerhafte Ankündigung
    _incoming.set(key, {
      chunks: new Array(raw.chunks), kind: raw.kind === 'video' ? 'video' : 'photo',
      name: typeof raw.name === 'string' ? raw.name : '', mime: raw.mime || '', total: raw.chunks, received: 0,
    });
    return;
  }
  if (raw.type === 'filechunk') {
    const t = _incoming.get(key);
    if (!t || raw.i < 0 || raw.i >= t.total) return;
    t.chunks[raw.i] = _base64ToBytes(raw.data);
    t.received++;
    if (_onProgress) _onProgress({ direction: 'receive', sent: t.received, total: t.total });
    return;
  }
  if (raw.type === 'fileend') {
    const t = _incoming.get(key);
    _incoming.delete(key);
    if (!t || t.chunks.some(c => !c)) { if (t) console.warn('filetransfer: unvollständige Übertragung, verworfen'); return; }
    const blob = new Blob(t.chunks, { type: t.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    if (_onIncoming) _onIncoming({ blob, url, kind: t.kind, name: t.name, mime: t.mime, peerId: fromId });
  }
}
