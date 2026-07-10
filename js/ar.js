// AR-Peilung: legt die Richtungs-Auswertung der gemeinsamen Ruf-Ortung (js/locate.js) als
// Overlay über das live Kamerabild — Kamera + Kompass statt WebXR, damit es auch auf iOS Safari
// funktioniert. Beim Schwenken wandern die Markierungen entsprechend der Blickrichtung durchs Bild.
//
// Physik-Ehrlichkeit: mit ZWEI Empfängern liegt die Schallquelle (Fernfeld-Näherung) auf einem
// von zwei Strahlen, gespiegelt an der Verbindungslinie der Handys — welcher der beiden stimmt,
// kann erst ein drittes Gerät auflösen. Deshalb werden hier bewusst BEIDE möglichen Richtungs-
// zonen gezeichnet (plus der sicher bekannte Partner-Marker aus GPS), keine fake-eindeutige
// Pfeilrichtung. Eine Entfernung gibt es mit zwei Geräten prinzipiell nicht — nur "näher bei
// dir/beim Partner" aus dem Vorzeichen der Laufzeitdifferenz.

import { bearingDeg, haversineKm } from './db.js';

const SOUND_SPEED_MPS = 343;
const FOV_DEG = 60; // angenommenes horizontales Kamera-Sichtfeld (typisch 55-70°)

let _el = null, _video = null, _canvas = null, _stream = null;
let _raf = null, _heading = null, _headingRaw = null, _orientHandler = null, _orientEv = null;
let _data = null;

function _needsPermission() {
  return typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
}

function _startOrientation() {
  _orientEv = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  _orientHandler = e => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading; // iOS
    else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;
    else if (typeof e.alpha === 'number') h = (360 - e.alpha) % 360; // Fallback: relativ statt absolut
    if (h == null) return;
    _headingRaw = h;
    // Zirkulärer Tiefpass gegen Kompass-Zittern
    if (_heading == null) _heading = h;
    else {
      let d = ((h - _heading + 540) % 360) - 180;
      _heading = (_heading + d * 0.15 + 360) % 360;
    }
  };
  window.addEventListener(_orientEv, _orientHandler, { passive: true });
}

// Relative Peilung (-180..180) zur Blickrichtung -> x-Position auf dem Bildschirm.
function _bearingToX(bearing, w) {
  const rel = ((bearing - _heading + 540) % 360) - 180;
  return { x: w / 2 + (rel / (FOV_DEG / 2)) * (w / 2), rel };
}

function _drawWedge(ctx, xCenter, w, h, halfWidthPx, color) {
  const grad = ctx.createLinearGradient(xCenter - halfWidthPx, 0, xCenter + halfWidthPx, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.5, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(xCenter - halfWidthPx, 0, halfWidthPx * 2, h);
  ctx.fillStyle = 'rgba(163,230,53,.85)';
  ctx.fillRect(xCenter - 1, 0, 2, h);
}

function _edgeArrow(ctx, side, y, w, label) {
  const x = side === 'left' ? 26 : w - 26;
  ctx.save();
  ctx.fillStyle = 'rgba(163,230,53,.92)';
  ctx.beginPath();
  if (side === 'left') { ctx.moveTo(x - 12, y); ctx.lineTo(x + 8, y - 10); ctx.lineTo(x + 8, y + 10); }
  else { ctx.moveTo(x + 12, y); ctx.lineTo(x - 8, y - 10); ctx.lineTo(x - 8, y + 10); }
  ctx.closePath(); ctx.fill();
  ctx.font = '600 12px Inter, sans-serif';
  ctx.textAlign = side === 'left' ? 'left' : 'right';
  ctx.fillText(label, side === 'left' ? x + 14 : x - 14, y + 4);
  ctx.restore();
}

function _drawRibbon(ctx, w) {
  // Kompassband oben: Striche alle 15°, Beschriftung an den Haupt-/Zwischenrichtungen
  const names = { 0: 'N', 45: 'NO', 90: 'O', 135: 'SO', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  ctx.save();
  ctx.fillStyle = 'rgba(4,19,13,.55)';
  ctx.fillRect(0, 0, w, 56);
  for (let b = 0; b < 360; b += 15) {
    const { x, rel } = _bearingToX(b, w);
    if (Math.abs(rel) > FOV_DEG * 0.75) continue;
    const major = b % 45 === 0;
    ctx.fillStyle = major ? 'rgba(236,253,245,.9)' : 'rgba(236,253,245,.35)';
    ctx.fillRect(x - 1, 34, 2, major ? 14 : 8);
    if (names[b] != null) {
      ctx.font = '700 13px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(names[b], x, 26);
    }
  }
  // Blickrichtungs-Marke in der Mitte
  ctx.fillStyle = '#a3e635';
  ctx.beginPath(); ctx.moveTo(w / 2, 52); ctx.lineTo(w / 2 - 7, 62); ctx.lineTo(w / 2 + 7, 62); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function _render() {
  if (!_canvas || !_el) return;
  const ctx = _canvas.getContext('2d');
  // Backing-Store nur bei tatsächlicher Größenänderung neu setzen — sonst wird bei jedem der
  // 60 Frames/s ein volles Canvas-Reset erzwungen, obwohl das Handy meist ruhig gehalten wird.
  const w = _canvas.clientWidth, h = _canvas.clientHeight;
  if (_canvas.width !== w) _canvas.width = w;
  if (_canvas.height !== h) _canvas.height = h;
  ctx.clearRect(0, 0, w, h);

  if (_heading == null) {
    ctx.fillStyle = 'rgba(4,19,13,.6)';
    ctx.fillRect(0, 0, w, 56);
    ctx.fillStyle = 'rgba(236,253,245,.8)';
    ctx.font = '600 13px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Warte auf Kompass…', w / 2, 34);
    _raf = requestAnimationFrame(_render);
    return;
  }

  _drawRibbon(ctx, w);
  const d = _data;
  if (d) {
    // Partner-Marker (aus GPS sicher bekannt — dient auch als Plausibilitäts-Anker)
    if (d.bearingToPeer != null) {
      const { x, rel } = _bearingToX(d.bearingToPeer, w);
      const label = 'Partner' + (d.baselineM != null ? ' · ' + d.baselineM + ' m' : '');
      if (Math.abs(rel) <= FOV_DEG * 0.75) {
        ctx.save();
        ctx.strokeStyle = 'rgba(103,232,249,.9)';
        ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, 66); ctx.lineTo(x, h * 0.62); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(103,232,249,.95)';
        ctx.font = '600 12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🤝 ' + label, x, h * 0.62 + 18);
        ctx.restore();
      } else {
        ctx.fillStyle = 'rgba(103,232,249,.92)';
        _edgeArrow(ctx, rel < 0 ? 'left' : 'right', h * 0.5, w, label);
      }
    }
    // Die beiden möglichen Ruf-Richtungen
    for (const cand of d.candidates) {
      const { x, rel } = _bearingToX(cand.bearing, w);
      const halfPx = (cand.halfWidthDeg / (FOV_DEG / 2)) * (w / 2);
      if (Math.abs(rel) <= FOV_DEG * 0.75 + cand.halfWidthDeg) {
        _drawWedge(ctx, x, w, h, Math.max(30, halfPx), 'rgba(163,230,53,.16)');
        ctx.save();
        ctx.fillStyle = 'rgba(163,230,53,.95)';
        ctx.font = '700 15px Outfit, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🐦 ' + d.species, x, h * 0.34);
        ctx.font = '600 11px Inter, sans-serif';
        ctx.fillStyle = 'rgba(236,253,245,.75)';
        ctx.fillText(cand.label, x, h * 0.34 + 17);
        ctx.restore();
      } else {
        _edgeArrow(ctx, rel < 0 ? 'left' : 'right', h * 0.34, w, d.species);
      }
    }
  }
  _raf = requestAnimationFrame(_render);
}

// Aus dem Locate-Ergebnis die beiden möglichen Peilungen berechnen (Fernfeld-Näherung):
// cos(alpha) = c*dt / Basislinie, alpha = Winkel zur Achse "ich -> Partner"; Kandidaten sind
// bearingToPeer ± alpha (Spiegelung an der Verbindungslinie).
function _candidatesFrom(r) {
  // 3-Geräte-Fix: eindeutige Position bekannt -> EINE Zone mit Richtung + Entfernung von der
  // eigenen Position aus. Zonenbreite aus der Orts-Unsicherheit auf die Entfernung projiziert.
  if (r.method === 'fix') {
    if (!r.myPos || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return null;
    const distM = Math.max(5, Math.round(haversineKm(r.myPos, r) * 1000));
    const bearing = (bearingDeg(r.myPos, r) + 360) % 360;
    // Zonenbreite aus der Richtungs-Unsicherheit des Fixes (Näherung: von der Zentrale aus
    // berechnet, die Geräte stehen nah beieinander im Vergleich zur Quelle)
    const halfWidth = Math.max(8, Math.min(45, (r.dirSpreadDeg || 15) + 4));
    // Entfernung ehrlich: reicht die Unsicherheits-Zone bis an den Suchrand, ist nach oben
    // nichts belastbar -> "mind. X m" statt einer erfundenen Obergrenze.
    const rangeTxt = !(r.rangeMinM && r.rangeMaxM) ? '~' + distM + ' m'
      : r.rangeMaxM >= 450 ? 'mind. ' + r.rangeMinM + ' m'
      : r.rangeMaxM > r.rangeMinM * 1.3 ? '~' + r.rangeMinM + '–' + r.rangeMaxM + ' m'
      : '~' + distM + ' m';
    return [{ bearing, halfWidthDeg: halfWidth, label: rangeTxt, distM }];
  }
  if (r.bearingToPeer == null || r.baselineM == null || r.baselineM < 2 || typeof r.deltaSignedMs !== 'number') return null;
  const cosA = Math.max(-1, Math.min(1, (SOUND_SPEED_MPS * (r.deltaSignedMs / 1000)) / r.baselineM));
  const alpha = Math.acos(cosA) * 180 / Math.PI;
  // Unsicherheit: GPS-Positionsfehler dominiert (±15°), unkalibrierte Latenz-Differenz kommt oben drauf
  const halfWidth = r.calibrated ? 16 : 26;
  const b1 = (r.bearingToPeer + alpha + 360) % 360;
  const b2 = (r.bearingToPeer - alpha + 360) % 360;
  const near = Math.abs(((b1 - b2 + 540) % 360) - 180) < halfWidth; // Zonen überlappen -> nur eine zeigen
  const cands = [{ bearing: b1, halfWidthDeg: halfWidth, label: near ? 'Richtungszone' : 'Möglichkeit 1 von 2' }];
  if (!near) cands.push({ bearing: b2, halfWidthDeg: halfWidth, label: 'Möglichkeit 2 von 2' });
  return cands;
}

export function canShowAR(r) {
  // tooClose (s. locate.js MIN_BASELINE_M): die Basislinie ist zu kurz, um dem GPS-Rauschen eine
  // verlässliche Richtung zu entlocken — AR würde dann eine Pfeilrichtung zeigen, die reines
  // GPS-Rauschen ist, nicht der tatsächliche Peilfehler.
  return !!(r && !r.tooClose && (r.method === 'corr' || r.method === 'fix') && _candidatesFrom(r));
}

export function openAR(r) {
  const candidates = _candidatesFrom(r);
  if (!candidates) return;
  closeAR();
  _data = {
    species: r.species, candidates,
    bearingToPeer: r.bearingToPeer, baselineM: r.baselineM,
  };
  const isFix = r.method === 'fix';
  const whoTxt = isFix ? 'eindeutig geortet (' + (r.nPhones || 3) + ' Handys)'
    : r.firstHeard === 'me' ? 'vermutlich näher an DIR'
    : r.firstHeard === 'peer' ? 'vermutlich näher am PARTNER' : 'etwa mittig zwischen euch';
  const hintTxt = isFix
    ? 'Schwenke das Handy: die grüne Zone zeigt Richtung und ungefähre Entfernung zum Ruf.'
    : 'Schwenke das Handy: die grünen Zonen zeigen, aus welcher Richtung der Ruf kam.' + (candidates.length > 1 ? ' Zwei Zonen, weil zwei Mikrofone die Spiegelung nicht auflösen können — ein drittes Handy würde sie eindeutig machen.' : '') + (r.calibrated ? '' : ' Tipp: der 🎯 Feinabgleich macht die Zonen schmaler.');

  _el = document.createElement('div');
  _el.id = 'arOverlay';
  _el.style.cssText = 'position:fixed;inset:0;z-index:400;background:#04130d;overflow:hidden';
  _el.innerHTML = `
    <video id="arVideo" autoplay playsinline muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>
    <canvas id="arCanvas" style="position:absolute;inset:0;width:100%;height:100%"></canvas>
    <button id="arClose" aria-label="Schließen" style="position:absolute;top:calc(10px + env(safe-area-inset-top));right:12px;z-index:2;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(4,19,13,.55);color:#ecfdf5;font-size:20px;backdrop-filter:blur(8px)">✕</button>
    <div style="position:absolute;left:0;right:0;bottom:calc(14px + env(safe-area-inset-bottom));z-index:2;text-align:center;padding:0 18px">
      <div style="display:inline-block;background:rgba(4,19,13,.62);border:1px solid rgba(163,230,53,.25);border-radius:16px;padding:10px 16px;backdrop-filter:blur(8px)">
        <div style="font-family:Outfit,sans-serif;font-weight:700;font-size:15px;color:#a3e635">🐦 ${String(r.species).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))} — ${whoTxt}</div>
        <div style="font-size:11px;color:rgba(236,253,245,.72);margin-top:4px;line-height:1.45">${hintTxt}</div>
      </div>
    </div>
    <button id="arCompassBtn" hidden style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:3;padding:12px 22px;border-radius:16px;border:none;background:#a3e635;color:#04130d;font-weight:700;font-family:Outfit,sans-serif;font-size:14px">🧭 Kompass aktivieren</button>`;
  document.body.appendChild(_el);
  _video = _el.querySelector('#arVideo');
  _canvas = _el.querySelector('#arCanvas');
  _el.querySelector('#arClose').onclick = closeAR;

  // Kamera (nur Video, Rückseite) — bewusst NICHT abgewartet: Kompassband und Zonen stehen
  // sofort, das Kamerabild kommt nach der Freigabe dazu. Schlägt es fehl (verweigert/kein
  // Gerät), bleibt die Peilung auf dunklem Grund voll benutzbar.
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    .then(stream => {
      if (!_el) { stream.getTracks().forEach(t => t.stop()); return; } // inzwischen geschlossen
      _stream = stream;
      if (_video) { _video.srcObject = stream; _video.play().catch(() => {}); }
    })
    .catch(e => console.warn('AR Kamera', e));

  // Kompass: iOS braucht eine Nutzer-Geste für die Freigabe
  if (_needsPermission()) {
    const btn = _el.querySelector('#arCompassBtn');
    btn.hidden = false;
    btn.onclick = async () => {
      try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return; } catch { return; }
      btn.hidden = true;
      _startOrientation();
    };
  } else {
    _startOrientation();
  }
  _render();
}

export function closeAR() {
  if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
  if (_orientHandler) { window.removeEventListener(_orientEv, _orientHandler); _orientHandler = null; }
  if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  if (_el) { _el.remove(); _el = null; }
  _video = null; _canvas = null; _heading = null; _headingRaw = null; _data = null;
}
