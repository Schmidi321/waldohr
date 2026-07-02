// Direkte Foto-/Video-Übertragung ans gekoppelte Partner-Handy — läuft über denselben
// RTCDataChannel wie Chat/Ortung, komplett ohne Internet. Da ein einzelner Sendevorgang auf einem
// Datenkanal nicht beliebig groß sein darf (Kompatibilität zwischen Browsern/Geräten), wird die
// Datei in kleine Stücke zerlegt und auf der Empfängerseite wieder zusammengesetzt.
const CHUNK_SIZE = 16 * 1024; // sichere Größe, die auf allen gängigen WebRTC-Implementierungen funktioniert
const MAX_FILE_SIZE = 25 * 1024 * 1024; // Sicherheitsgrenze, damit eine Übertragung nicht endlos dauert/Speicher sprengt
const BUFFER_HIGH = 1 * 1024 * 1024; // ab hier abwarten, bevor weitere Stücke gesendet werden

let _dc = null;
let _onMessageBound = null;
let _onIncoming = null;
let _onProgress = null;
let _incoming = new Map(); // transferId -> { chunks, mime, kind, name, total, received }

export function attach(dc, onIncoming, onProgress) {
  detach();
  _dc = dc;
  _onIncoming = onIncoming || null;
  _onProgress = onProgress || null;
  _onMessageBound = e => _handle(e);
  dc.addEventListener('message', _onMessageBound);
}

export function detach() {
  if (_dc && _onMessageBound) _dc.removeEventListener('message', _onMessageBound);
  _dc = null; _onMessageBound = null;
  _onIncoming = null; _onProgress = null;
  _incoming.clear();
}

export function isActive() {
  return !!(_dc && _dc.readyState === 'open');
}

function _send(obj) {
  if (!isActive()) throw new Error('nicht verbunden');
  _dc.send(JSON.stringify(obj));
}

function _waitForBufferLow() {
  return new Promise(res => {
    if (!_dc || _dc.bufferedAmount < BUFFER_HIGH) { res(); return; }
    _dc.bufferedAmountLowThreshold = Math.floor(BUFFER_HIGH / 2);
    const onLow = () => { _dc.removeEventListener('bufferedamountlow', onLow); res(); };
    _dc.addEventListener('bufferedamountlow', onLow);
  });
}

function _chunkToBase64(chunkBlob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onloadend = () => res(String(reader.result).split(',')[1] || '');
    reader.onerror = () => rej(reader.error);
    reader.readAsDataURL(chunkBlob);
  });
}

// kind: 'photo' | 'video'. Meldet Fortschritt über onProgress({direction:'send', sent, total}).
export async function sendFile(blob, kind, name) {
  if (!isActive()) throw new Error('nicht verbunden');
  if (blob.size > MAX_FILE_SIZE) throw new Error('Datei zu groß (max. 25 MB)');
  const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const totalChunks = Math.max(1, Math.ceil(blob.size / CHUNK_SIZE));
  _send({ type: 'filestart', id, kind, name: name || '', mime: blob.type || '', size: blob.size, chunks: totalChunks });
  for (let i = 0; i < totalChunks; i++) {
    await _waitForBufferLow();
    if (!isActive()) throw new Error('Verbindung während der Übertragung verloren');
    const chunkBlob = blob.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const data = await _chunkToBase64(chunkBlob);
    _send({ type: 'filechunk', id, i, data });
    if (_onProgress) _onProgress({ direction: 'send', sent: i + 1, total: totalChunks });
  }
  _send({ type: 'fileend', id });
}

function _base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function _handle(e) {
  let raw; try { raw = JSON.parse(e.data); } catch { return; }
  if (raw.type === 'filestart') {
    if (typeof raw.size === 'number' && raw.size > MAX_FILE_SIZE) return; // ignoriert überdimensionierte/fehlerhafte Ankündigung
    _incoming.set(raw.id, {
      chunks: new Array(raw.chunks), kind: raw.kind === 'video' ? 'video' : 'photo',
      name: typeof raw.name === 'string' ? raw.name : '', mime: raw.mime || '', total: raw.chunks, received: 0,
    });
    return;
  }
  if (raw.type === 'filechunk') {
    const t = _incoming.get(raw.id);
    if (!t || raw.i < 0 || raw.i >= t.total) return;
    t.chunks[raw.i] = _base64ToBytes(raw.data);
    t.received++;
    if (_onProgress) _onProgress({ direction: 'receive', sent: t.received, total: t.total });
    return;
  }
  if (raw.type === 'fileend') {
    const t = _incoming.get(raw.id);
    _incoming.delete(raw.id);
    if (!t || t.chunks.some(c => !c)) { if (t) console.warn('filetransfer: unvollständige Übertragung, verworfen'); return; }
    const blob = new Blob(t.chunks, { type: t.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    if (_onIncoming) _onIncoming({ blob, url, kind: t.kind, name: t.name, mime: t.mime });
  }
}
