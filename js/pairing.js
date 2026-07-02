// Geräte-Kopplung über WebRTC + QR-Code — WaldOhr hat keinen eigenen Server, daher läuft der
// komplette Verbindungsaufbau (SDP-Signalisierung) über einen manuellen QR-Code-Austausch:
// Handy A zeigt einen QR-Code (Angebot), Handy B scannt ihn und zeigt seinerseits einen QR-Code
// (Antwort) zurück, den Handy A scannt. Danach verbinden sich beide Geräte direkt (Peer-to-Peer,
// verschlüsselt) über einen RTCDataChannel — keine Daten laufen über einen fremden Server, nur
// öffentliche STUN-Server helfen beim Auffinden der Netzwerkadresse (NAT-Traversal).
import { qrcode } from './vendor/qrcode.mjs';

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const ICE_GATHER_TIMEOUT_MS = 4000; // Notnagel, falls 'complete' nie feuert (z.B. kein Netz)

// ---- QR-Code erzeugen: rendert direkt auf ein <canvas> (kein SVG/DataURL-Umweg nötig) ----
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
  const cell = Math.max(2, Math.floor(240 / count));
  const margin = cell * 2;
  const size = count * cell + margin * 2;
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
    }
  }
  return { typeNumber, size };
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

function encodeDesc(desc) {
  return JSON.stringify({ t: desc.type, s: desc.sdp });
}
function decodeDesc(text) {
  const o = JSON.parse(text);
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
  const qrText = encodeDesc(pc.localDescription);
  return {
    pc, dc, qrText,
    async applyAnswer(answerText) {
      const desc = decodeDesc(answerText);
      await pc.setRemoteDescription(desc);
    },
  };
}

// ---- Seite B: eingescanntes Angebot annehmen, eigene Antwort als QR zurückgeben ----
// WICHTIG: gibt sofort zurück, sobald die Antwort fertig ist (als QR anzeigbar) — wartet NICHT
// auf das 'ondatachannel'-Event, denn das feuert erst, wenn die Verbindung schon steht. Die
// Verbindung kann aber erst stehen, nachdem Seite A diese Antwort gescannt hat -> sonst Deadlock.
export async function createAnswerer(offerText) {
  const desc = decodeDesc(offerText);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const dcPromise = new Promise(res => { pc.ondatachannel = e => res(e.channel); });
  await pc.setRemoteDescription(desc);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceComplete(pc);
  const qrText = encodeDesc(pc.localDescription);
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
