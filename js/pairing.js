// Geräte-Kopplung über WebRTC + QR-Code — WaldOhr hat keinen eigenen Server, daher läuft der
// komplette Verbindungsaufbau (SDP-Signalisierung) über einen manuellen QR-Code-Austausch:
// Handy A zeigt einen QR-Code (Angebot), Handy B scannt ihn und zeigt seinerseits einen QR-Code
// (Antwort) zurück, den Handy A scannt. Danach verbinden sich beide Geräte direkt (Peer-to-Peer,
// verschlüsselt) über einen RTCDataChannel — keine Daten laufen über einen fremden Server, nur
// öffentliche STUN-Server helfen beim Auffinden der Netzwerkadresse (NAT-Traversal).
import { qrcode } from './vendor/qrcode.mjs';

// Nur EIN STUN-Server statt zwei: die meisten Handys/Netze brauchen für die reine
// NAT-Adressermittlung nur einen Server, ein zweiter verdoppelt nur die Anzahl der gefundenen
// (redundanten) srflx-Kandidaten in der SDP und damit unnötig die Größe des QR-Codes.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];
const ICE_GATHER_TIMEOUT_MS = 4000; // Notnagel, falls 'complete' nie feuert (z.B. kein Netz)

// ---- QR-Code erzeugen: rendert direkt auf ein <canvas> (kein SVG/DataURL-Umweg nötig) ----
// HARTE Regel: der Code muss immer komplett auf den Bildschirm passen — ein abgeschnittener
// QR-Code lässt sich grundsätzlich nicht scannen, das ist wichtiger als eine großzügige Zellgröße.
// Zellgröße wird darum so groß wie irgend möglich innerhalb der verfügbaren Breite gewählt
// (Minimum 3px als allerletzter Notnagel bei sehr vielen Modulen).
export function renderQR(text, canvas) {
  let qr, typeNumber = 1;
  for (;;) {
    try {
      qr = qrcode(typeNumber, 'L');
      qr.addData(text);
      qr.make();
      break;
    } catch (e) {
      if (String(e).includes('overflow') && typeNumber < 40) { typeNumber++; continue; }
      throw e;
    }
  }
  const count = qr.getModuleCount();
  const availableWidth = Math.max(180, Math.min(320, (window.innerWidth || 360) - 60));
  const marginModules = 3; // in Zell-Einheiten, Ruhezone rundum fürs sichere Erkennen
  const cell = Math.max(3, Math.floor(availableWidth / (count + marginModules * 2)));
  const margin = cell * marginModules;
  const size = count * cell + margin * 2;
  canvas.width = size; canvas.height = size;
  // KEIN CSS-Downscaling auf einen festen Wert — das würde die Zellgröße wieder verwischen.
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
    }
  }
  return { typeNumber, size, moduleCount: count };
}

// ---- Nutzlast verkleinern: SDP-Text ist stark repetitiv (viele ähnliche Kandidaten-Zeilen) und
// komprimiert dadurch sehr gut — spart oft 50-70%, macht den QR-Code deutlich weniger dicht.
// CompressionStream ist inzwischen breit unterstützt (Chrome/Edge 80+, Firefox 113+, Safari 16.4+);
// falls doch nicht vorhanden, fällt der Code automatisch auf unkomprimierten Text zurück.
async function gzipToBase64(text) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(text));
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } catch { return null; }
}
async function gunzipFromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

// ---- QR-Code aus der Kamera scannen ----
// Nutzt das vorhandene <video>-Element der Kamera-Vorschau; liest per rAF-Schleife Frames aus und
// versucht sie mit jsQR (vendor/jsQR.js, global als window.jsQR geladen) zu dekodieren.
export function scanQR(videoEl, onResult) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let raf = null, stopped = false;
  function tick() {
    if (stopped) return;
    if (videoEl.readyState >= 2 && videoEl.videoWidth) {
      cv.width = videoEl.videoWidth; cv.height = videoEl.videoHeight;
      ctx.drawImage(videoEl, 0, 0, cv.width, cv.height);
      const img = ctx.getImageData(0, 0, cv.width, cv.height);
      const code = window.jsQR ? window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
      if (code && code.data) { stopped = true; onResult(code.data); return; }
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
  return () => { stopped = true; if (raf) cancelAnimationFrame(raf); };
}

function waitIceComplete(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(res => {
    let done = false;
    const finish = () => { if (done) return; done = true; pc.removeEventListener('icegatheringstatechange', check); res(); };
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
  });
}

// Behält nur 'host'-Kandidaten (direkte LAN-Adressen) und verwirft srflx/relay-Kandidaten aus
// dem STUN-Server. Das ist der größte Posten in der SDP (jede Zeile ~100-150 Zeichen, oft 4-8
// Stück) und für den Einsatzzweck vertretbar: zwei Handys, die man zum Koppeln nebeneinanderhält,
// sind so gut wie immer im selben WLAN — dafür reichen Host-Kandidaten. Bei getrennten Netzen
// (unterschiedliches WLAN/Mobilfunk) würde die Verbindung dann allerdings nicht zustande kommen.
function trimCandidates(sdp) {
  return sdp.split('\r\n').filter(line => !line.startsWith('a=candidate:') || / typ host /.test(line)).join('\r\n');
}

// 'g:'-Präfix = gzip+base64, 'p:'-Präfix = unkomprimierter Klartext (Fallback ohne
// CompressionStream-Unterstützung) — Präfix nötig, da Sende- und Empfangsgerät unterschiedliche
// Browser sein können und der Encoder nicht weiß, ob die Gegenseite dekomprimieren kann.
async function encodeDesc(desc) {
  const json = JSON.stringify({ t: desc.type, s: trimCandidates(desc.sdp) });
  const gz = await gzipToBase64(json);
  if (gz && gz.length < json.length) return 'g:' + gz;
  return 'p:' + json;
}
async function decodeDesc(text) {
  let json;
  if (text.startsWith('g:')) json = await gunzipFromBase64(text.slice(2));
  else if (text.startsWith('p:')) json = text.slice(2);
  else json = text; // defensiv: älteres Format ohne Präfix
  const o = JSON.parse(json);
  if (!o || !o.t || !o.s) throw new Error('Ungültiger Kopplungs-Code');
  return { type: o.t, sdp: o.s };
}

// ---- Seite A: Angebot erstellen (zeigt QR, wartet dann auf die gescannte Antwort) ----
export async function createOfferer() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const dc = pc.createDataChannel('waldohr-pair', { ordered: true });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceComplete(pc);
  const qrText = await encodeDesc(pc.localDescription);
  return {
    pc, dc, qrText,
    async applyAnswer(answerText) {
      const desc = await decodeDesc(answerText);
      await pc.setRemoteDescription(desc);
    },
  };
}

// ---- Seite B: eingescanntes Angebot annehmen, eigene Antwort als QR zurückgeben ----
// WICHTIG: gibt sofort zurück, sobald die Antwort fertig ist (als QR anzeigbar) — wartet NICHT
// auf das 'ondatachannel'-Event, denn das feuert erst, wenn die Verbindung schon steht. Die
// Verbindung kann aber erst stehen, nachdem Seite A diese Antwort gescannt hat -> sonst Deadlock.
export async function createAnswerer(offerText) {
  const desc = await decodeDesc(offerText);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const dcPromise = new Promise(res => { pc.ondatachannel = e => res(e.channel); });
  await pc.setRemoteDescription(desc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceComplete(pc);
  const qrText = await encodeDesc(pc.localDescription);
  return { pc, dc: dcPromise, qrText };
}

// Wartet, bis der Datenkanal offen ist (bei beiden Seiten aufrufen, nachdem die QR-Codes
// ausgetauscht wurden) — löst mit dem geöffneten RTCDataChannel auf oder wirft bei Timeout/Fehler.
// Nimmt sowohl einen fertigen RTCDataChannel als auch ein Promise darauf entgegen (Seite B liefert
// aus createAnswerer() ein Promise, da der Kanal erst bei echter Verbindung entsteht).
export async function waitForOpen(dcOrPromise, timeoutMs = 15000) {
  const dc = await dcOrPromise;
  return new Promise((res, rej) => {
    if (dc.readyState === 'open') { res(dc); return; }
    const to = setTimeout(() => rej(new Error('Verbindung nicht zustande gekommen (Timeout)')), timeoutMs);
    dc.addEventListener('open', () => { clearTimeout(to); res(dc); }, { once: true });
    dc.addEventListener('error', e => { clearTimeout(to); rej(e); }, { once: true });
  });
}
