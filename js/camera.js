// Kamera-Modi: photo | video | tele-wide | front-back
// Dual-Kamera stacked Foto, Auto-Zoom beim Filmen, stufenloser Zoom.
let _stream = null, _videoTrack = null;
let _stream2 = null, _videoTrack2 = null;
let _analyser = null, _audioCtx = null, _meterFreqs = null, _meterRaf = null;
let _mr = null, _mrChunks = [];
let _mode = 'photo';
let _zoomSupported = false, _zoomMin = 1, _zoomMax = 1;
let _onCapture = null;
let _zoomDir = 'none', _zoomSpeed = 'slow';
let _azDelayTimer = null, _intervalTimer = null, _burstActive = false;
let _intervalCountdown = null, _intervalNext = 0;
let _facingMode = 'environment';
let _lapseTimer = null, _lapseFrames = [], _lapseIntervalSec = 2;
// Zoom-Modell: _viewZoom ist der logische Soll-Zoom (Anzeige + Aufnahme), _hwZoom der zuletzt
// tatsächlich an die Kamera-Hardware übergebene Wert. Die Differenz wird digital gerendert
// (CSS-Scale in der Vorschau, Canvas-Crop in der Aufnahme) — so kann der Hardware-Zoom selten
// oder (während einer Aufnahme) gar nicht nachgeführt werden, ohne dass das Bild springt.
let _viewZoom = 1, _hwZoom = 1;
// Canvas-Aufnahme-Pipeline: Videoaufnahmen zeichnen nicht den rohen Kamera-Track auf, sondern
// einen Canvas-Kompositor mit framegenauem Digital-Zoom (s. _startCanvasRecPipeline).
let _recCanvasStream = null;

// ---- Gemeinsame Animations-Schleife für Zoom-Fahrt UND Aufnahme-Zeichnen ----
//
// Früher zwei UNABHÄNGIGE requestAnimationFrame-Schleifen: eine animierte den Zoom-Wert (CSS-
// Vorschau), die andere zeichnete unabhängig davon denselben Zoom-Wert auf den Aufnahme-Canvas.
// Zwei separate Schleifen auf demselben State sind eine klassische Quelle für Mikro-Ruckler durch
// Zeitversatz zwischen den beiden Callback-Ausführungen — genau das "stockt beim Zoomen"-Symptom.
// Jetzt EINE Schleife: sie treibt pro Frame zuerst den Zoom-Wert an (falls eine Fahrt läuft) und
// zeichnet danach mit GENAU demselben, gerade aktualisierten Wert auf den Aufnahme-Canvas (falls
// aufgenommen wird) — beides immer exakt synchron. Das Canvas-Zeichnen selbst ist zusätzlich auf
// ~30fps gedrosselt (an captureStream(30) gekoppelt): mehr als 30 Zeichenaufrufe/Sekunde erzeugen
// KEINE zusätzlichen Ausgabeframes, kosten auf Geräten mit hoher Bildwiederholrate (90/120Hz) aber
// unnötig CPU/GPU-Zeit — genau die Art Dauerlast, die auf schwächeren Handys zu spürbarem
// Systemruckeln führt, auch in der Vorschau.
const REC_DRAW_INTERVAL_MS = 1000 / 30;
let _masterRaf = null;
let _zoomAnimActive = false, _zoomFrom = 1, _zoomTo = 1, _zoomT0 = 0, _zoomDur = 1, _zoomLastHwSync = 0;
let _recCtx = null, _recVW = 0, _recVH = 0, _recCW = 0, _recCH = 0, _recLastDraw = 0;

function _ensureMasterLoop() {
  if (_masterRaf) return;
  const tick = now => {
    if (_zoomAnimActive) {
      const p = Math.min(1, (now - _zoomT0) / _zoomDur);
      const v = _zoomFrom * Math.pow(_zoomTo / _zoomFrom, p);
      _renderZoom(v);
      if (p >= 1 || now - _zoomLastHwSync > 450) { _zoomLastHwSync = now; _syncHwZoom(v); }
      if (p >= 1) _zoomAnimActive = false;
    }
    if (_recCtx && now - _recLastDraw >= REC_DRAW_INTERVAL_MS) {
      _recLastDraw = now;
      const video = document.getElementById('camVideo');
      if (video) {
        const d = Math.max(1, _viewZoom / (_hwZoom || 1));
        const sw = _recVW / d, sh = _recVH / d;
        _recCtx.drawImage(video, (_recVW - sw) / 2, (_recVH - sh) / 2, sw, sh, 0, 0, _recCW, _recCH);
      }
    }
    _masterRaf = (_zoomAnimActive || _recCtx) ? requestAnimationFrame(tick) : null;
  };
  _masterRaf = requestAnimationFrame(tick);
}
function _cancelMasterLoop() {
  if (_masterRaf) { cancelAnimationFrame(_masterRaf); _masterRaf = null; }
}

// Bucketet rohe Kamera-Devices auf einen von fünf sprechenden Namen (Ultra-Weit/Haupt/Tele/Makro/
// generisch) UND dedupliziert dabei nach diesem angezeigten Namen. Nötig, weil viele Android-
// Geräte dieselbe physische Linse mehrfach als eigenständiges enumerateDevices()-Objekt melden
// (zusätzliche logische Kamera-IDs für HDR/Video-Varianten o.ä., alle mit sehr ähnlichem Label) —
// ohne Dedup erschien z.B. "Hauptkamera" mehrfach identisch in der Auswahl. Generische (nicht
// erkannte) Linsen werden NICHT gegeneinander dedupliziert, da nicht sicher ist, ob es dieselbe
// oder tatsächlich verschiedene Linsen sind — im Zweifel lieber getrennt anzeigen.
function _dedupeLenses(devices) {
  const seenCategory = new Set();
  const seenLabel = new Set();
  let mainAssigned = false, genericN = 0;
  const out = [];
  for (const d of devices) {
    const rawLabel = d.label || '';
    const lbl = rawLabel.toLowerCase();
    let category = null;
    if (/ultra/.test(lbl)) category = '📷 Ultra-Weit';
    else if (/telephoto|tele|[3-9](\.\d)?x\b/.test(lbl)) category = '🔭 Tele';
    else if (/macro/.test(lbl)) category = '🌸 Makro';
    // Eindeutiges Schlüsselwort (Ultra/Tele/Makro) -> zuverlässiges Signal, per Kategorie dedupen.
    if (category) {
      if (seenCategory.has(category)) continue;
      seenCategory.add(category);
      out.push({ deviceId: d.deviceId, name: category });
      continue;
    }
    // Kein eindeutiges Schlüsselwort — v.a. Android, wo ALLE Rücklinsen oft nur generisch
    // "Camera 0, facing back"/"Camera 1, facing back" o.ä. heißen. Ein Substring-Match auf
    // "back"/"rear"/"main" würde die dann fälschlich als EIN Gerät kollabieren und echte
    // zusätzliche Linsen (Weitwinkel/Tele ohne Namen) verstecken — darum hier nur bei
    // WORTWÖRTLICH identischem Rohtext als Duplikat werten.
    if (rawLabel && seenLabel.has(rawLabel)) continue;
    if (rawLabel) seenLabel.add(rawLabel);
    let name;
    if (!mainAssigned) { name = '📷 Haupt'; mainAssigned = true; }
    else { genericN++; name = '📷 Kamera ' + (genericN + 1); }
    out.push({ deviceId: d.deviceId, name });
  }
  return out;
}

// ---- Geräte aufzählen (Labels erst nach Genehmigung verfügbar) ----
async function _enumerateDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const allCams = all.filter(d => d.kind === 'videoinput');
    const mics = all.filter(d => d.kind === 'audioinput');
    const camSel = document.getElementById('camCamSelect');
    if (camSel && allCams.length) {
      // ALLE Rückkameras listen, sobald es mehr als eine gibt — nicht nur die sauber als
      // Ultra/Normal/Tele erkannten (die Labels fehlen auf vielen Geräten, dann blieb die
      // Auswahl unsichtbar). Gleiche Lektion wie bei der QR-Scan-Linsenwahl: eine defekte oder
      // unscharfe Hauptlinse macht die Auswahl erst richtig wichtig.
      const back = allCams.filter(d => !d.label.toLowerCase().match(/front|facetime|user|selfie/));
      const pool = back.length ? back : allCams.slice(0, 3);
      const chosen = _dedupeLenses(pool);
      camSel.innerHTML = chosen.map(c => `<option value="${c.deviceId}">${c.name}</option>`).join('');
      camSel.style.display = chosen.length > 1 ? '' : 'none';
    }
    const micSel = document.getElementById('camMicSelect');
    if (micSel && mics.length) {
      micSel.innerHTML = mics.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Mikrofon ' + (i + 1)}</option>`).join('');
      micSel.style.display = mics.length > 1 ? '' : 'none';
    }
  } catch (e) { console.warn('enumerate', e); }
}

// ---- Zoom-Rendering ----
function _isRecording() { return !!(_mr && _mr.state === 'recording'); }

// Digital-Zoom-Obergrenze für Geräte OHNE Hardware-Zoom (v.a. iOS Safari, das caps.zoom nicht
// anbietet): dort zoomt WaldOhr rein digital (CSS-Vorschau + Canvas-Crop in der Aufnahme).
// 4× ist die Grenze, bei der ein 4K-Stream im Full-HD-Aufnahme-Canvas noch brauchbar scharf bleibt.
const DIGITAL_MAX = 4;
function _zoomRange() {
  return _zoomSupported ? { min: _zoomMin, max: _zoomMax } : { min: 1, max: DIGITAL_MAX };
}

// Zoom-Bereich für eine Fahrt WÄHREND EINER AUFNAHME: die Hardware bleibt dort zwingend eingefroren
// (s. _syncHwZoom weiter unten, `_isRecording()`-Guard) — die Fahrt läuft also IMMER rein digital,
// auch auf Geräten MIT Hardware-Zoom. Viele Android-Handys melden dort aber einen riesigen
// Hardware-Bereich (8×, 10× oder mehr, oft ein Hybrid aus mehreren Linsen) — als reiner Digital-Crop
// wäre das weit jenseits von brauchbar scharf und würde die Aufnahme zum Fahrtende hin extrem
// verwaschen/verpixeln. Denselben DIGITAL_MAX-Deckel wie beim "kein Hardware-Zoom"-Fall (iOS)
// anwenden, statt den vollen (nur theoretisch nutzbaren) Hardware-Bereich als Ziel zu nehmen.
function _recZoomRange() {
  const r = _zoomRange();
  return { min: r.min, max: Math.min(r.max, DIGITAL_MAX) };
}

// Logischen Zoom setzen: Vorschau (CSS) und Slider sofort, framegenau, ohne die Kamera-Pipeline
// anzufassen. Der sichtbare Digital-Faktor ist immer relativ zum aktuellen Hardware-Stand —
// dadurch stimmen Vorschau und (Canvas-)Aufnahme exakt überein und nichts springt.
function _renderZoom(v) {
  const r = _zoomRange();
  _viewZoom = Math.max(r.min, Math.min(r.max, v));
  const vid = document.getElementById('camVideo');
  if (vid) vid.style.transform = `scale(${Math.max(1, _viewZoom / (_hwZoom || 1))})`;
  const sl = document.getElementById('camZoom'); if (sl) sl.value = _viewZoom;
  const zv = document.getElementById('camZoomVal'); if (zv) zv.textContent = _viewZoom.toFixed(1) + '×';
}

// Hardware-Zoom tatsächlich nachführen. Jeder applyConstraints()-Aufruf ist auf vielen Handys
// eine spürbare Unterbrechung der Kamera-Pipeline (Frame-Drop) — deshalb passiert das NIE
// während einer laufenden Videoaufnahme (dort zoomt der Canvas-Kompositor rein digital) und
// außerhalb von Aufnahmen nur gedrosselt.
function _syncHwZoom(v) {
  if (!_zoomSupported || !_videoTrack || _isRecording()) return;
  try { _videoTrack.applyConstraints({ advanced: [{ zoom: v }] }); _hwZoom = v; } catch {}
  _renderZoom(_viewZoom); // Digital-Anteil neu berechnen (schrumpft nach dem Sync auf ~1)
}

// Gedrosselter Hardware-Sync fürs Slider-Ziehen/Pinchen: das input-Event feuert dutzendfach pro
// Sekunde — jeder direkte applyConstraints-Aufruf wäre ein Mini-Ruckler in der VORSCHAU. Die
// CSS-Vorschau läuft framegenau sofort (_renderZoom), die Hardware zieht erst nach, wenn der
// Finger kurz ruht (trailing 180 ms).
let _hwSyncTimer = null;
function _syncHwZoomThrottled(v) {
  if (_hwSyncTimer) clearTimeout(_hwSyncTimer);
  _hwSyncTimer = setTimeout(() => { _hwSyncTimer = null; _syncHwZoom(_viewZoom); }, 180);
}

function _applyZoom(v, immediate) {
  _renderZoom(v);
  if (immediate) _syncHwZoom(_viewZoom);
  else _syncHwZoomThrottled(_viewZoom);
}

function _stopZoomAnim() {
  if (_azDelayTimer) { clearTimeout(_azDelayTimer); _azDelayTimer = null; }
  // NUR die Zoom-Fahrt beenden — die gemeinsame Schleife (_masterRaf) läuft von selbst weiter,
  // solange noch aufgezeichnet wird (_recCtx gesetzt), und stoppt sich sonst selbst.
  _zoomAnimActive = false;
}

function _smoothStopZoom() {
  _stopZoomAnim();
  const vid = document.getElementById('camVideo');
  if (vid) { vid.style.transition = 'transform 0.4s ease-out'; setTimeout(() => { if (vid) vid.style.transition = ''; }, 420); }
}

function _playShutter() {
  if (localStorage.getItem('waldohr.shutterSound') !== 'on') return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const rate = ctx.sampleRate;
    const dur = 0.14;
    const buf = ctx.createBuffer(1, Math.floor(dur * rate), rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
      const t = i / rate;
      const env = Math.exp(-t * 55);
      ch[i] = (Math.random() * 2 - 1) * env * 0.35;
      ch[i] += Math.sin(2 * Math.PI * 160 * t) * Math.exp(-t * 90) * 0.65;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.0, ctx.currentTime);
    src.connect(gain); gain.connect(ctx.destination);
    src.start(ctx.currentTime);
    src.onended = () => { try { ctx.close(); } catch {} };
  } catch {}
}

// "Gespeichert!"-Feedback am Galerie-Icon statt die Kamera zu verlassen — void offsetWidth
// erzwingt einen Reflow, damit die Animation bei schnell aufeinanderfolgenden Fotos jedes Mal
// wieder von vorn abspielt (sonst würde ein bereits laufendes CSS-Keyframe einfach weiterlaufen).
function _flashGallery() {
  const btn = document.getElementById('camGalleryBtn');
  if (!btn) return;
  btn.classList.remove('cam-flash'); void btn.offsetWidth;
  btn.classList.add('cam-flash');
  setTimeout(() => btn.classList.remove('cam-flash'), 520);
}

function _flashBtn(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.background = 'var(--rose, #fb7185)';
  el.style.color = '#fff';
  setTimeout(() => { el.style.background = ''; el.style.color = ''; }, 160);
}

// Zeichnet den AKTUELL SICHTBAREN Ausschnitt (inkl. Digital-Zoom-Anteil) auf den Canvas — Fotos,
// Serienbilder und Zeitraffer-Frames entsprechen damit exakt der Vorschau. Vorher wurde immer der
// volle Sensor-Frame gespeichert: wer digital gezoomt hatte (iOS generell, oder zwischen zwei
// gedrosselten Hardware-Syncs), bekam ein UNgezoomtes Foto, das nicht zur Anzeige passte.
// Der Canvas wird auf die Crop-Größe gesetzt (echte Pixel, kein künstliches Hochskalieren).
function _drawZoomedFrame(cv, video) {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const d = Math.max(1, _viewZoom / (_hwZoom || 1));
  const sw = Math.round(vw / d / 2) * 2, sh = Math.round(vh / d / 2) * 2;
  cv.width = sw; cv.height = sh;
  cv.getContext('2d').drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, sw, sh);
}

function _captureFrameOnly() {
  const video = document.getElementById('camVideo');
  const cv = document.getElementById('camCanvas');
  if (!video || !cv) return Promise.resolve();
  _playShutter();
  return new Promise(resolve => {
    _drawZoomedFrame(cv, video);
    cv.toBlob(blob => { if (blob && _onCapture) _onCapture({ blob, mime: 'image/jpeg', kind: 'photo' }); resolve(); }, 'image/jpeg', 0.92);
  });
}

async function _doBurst() {
  if (_burstActive) return;
  _burstActive = true;
  const cap = document.getElementById('camBurst');
  if (cap) cap.classList.add('on');
  const end = Date.now() + 2000;
  while (Date.now() < end && _burstActive) {
    _flashBtn('camBurst');
    await _captureFrameOnly();
    await new Promise(r => setTimeout(r, 120));
  }
  _burstActive = false;
  if (cap) cap.classList.remove('on');
}

function _toggleInterval() {
  const btn = document.getElementById('camInterval');
  if (_intervalTimer) {
    clearInterval(_intervalTimer); _intervalTimer = null;
    if (btn) btn.classList.remove('on');
    if (_intervalCountdown) { _intervalCountdown.remove(); _intervalCountdown = null; }
    _intervalNext = 0;
  } else {
    _flashBtn('camInterval');
    _captureFrameOnly();
    _intervalNext = 3;
    const wrap = document.querySelector('#cameraModal .cam-video-wrap');
    if (wrap) {
      _intervalCountdown = document.createElement('div');
      _intervalCountdown.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:10;background:rgba(0,0,0,.52);border-radius:50%;width:72px;height:72px;display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:900;color:#fff;font-family:Outfit,sans-serif;transition:opacity .2s';
      _intervalCountdown.textContent = _intervalNext;
      wrap.appendChild(_intervalCountdown);
    }
    _intervalTimer = setInterval(() => {
      _intervalNext--;
      if (_intervalCountdown) _intervalCountdown.textContent = _intervalNext;
      if (_intervalNext <= 0) {
        _flashBtn('camInterval');
        _captureFrameOnly();
        _intervalNext = 3;
        if (_intervalCountdown) _intervalCountdown.textContent = _intervalNext;
      }
    }, 1000);
    if (btn) btn.classList.add('on');
  }
}

// forceFullSweep=true (beim Start einer AUFNAHME): die Fahrt läuft immer von echtem Start- bis
// Ziel-Endpunkt über die volle Dauer — unabhängig davon, wo der Zoom gerade steht. Sonst hätte
// z.B. ein vorheriges manuelles Vorzoomen oder ein bereits durchgelaufener Vorschau-Schwenk (per
// "3s"-Knopf) zur Folge, dass "from" schon (nahe) am Ziel liegt und die AUFGEZEICHNETE Fahrt quasi
// nicht mehr stattfindet — die fertige Aufnahme wäre dann von der ersten bis zur letzten Sekunde
// praktisch auf demselben (dem letzten) Zoom-Stand. Genau das war der gemeldete Fehler ("ist man
// direkt schon im letzten Zoomstufe"). Ohne forceFullSweep (manueller Vorschau-Start über den
// "3s"-Knopf, keine Aufnahme) bleibt das alte Verhalten: vom AKTUELLEN Zoom aus starten, kein
// Sprung ans Bereichs-Ende, Dauer skaliert mit der verbleibenden Strecke.
function _startZoomAnim(forceFullSweep) {
  _stopZoomAnim();
  if (_zoomDir === 'none') return;
  const full = _zoomRange();
  // Während einer Aufnahme läuft die Fahrt zwingend rein digital (s. _recZoomRange oben) — der
  // volle Hardware-Bereich ist dort nur eine theoretische Zahl, keine tatsächlich nutzbare Schärfe.
  const { min: minZ, max: maxZ } = forceFullSweep ? _recZoomRange() : full;
  const to = _zoomDir === 'in' ? maxZ : minZ;
  const from = forceFullSweep ? (_zoomDir === 'in' ? minZ : maxZ) : Math.max(minZ, Math.min(maxZ, _viewZoom));
  if (Math.abs(Math.log(to / from)) < 0.01) return;
  const fullDur = _zoomSpeed === 'fast' ? 7000 : 28000;
  _zoomDur = forceFullSweep ? fullDur : fullDur * Math.abs(Math.log(to / from)) / Math.log(full.max / full.min || 2);
  _zoomFrom = from; _zoomTo = to; _zoomT0 = performance.now(); _zoomLastHwSync = 0;
  _zoomAnimActive = true;
  _ensureMasterLoop();
}

// ---- Dual-Kamera Stream starten ----
async function _startDualStream(mode) {
  _stopMeter(); _stopZoomAnim();
  if (_stream)  { _stream.getTracks().forEach(t => t.stop());  _stream = null; }
  if (_stream2) { _stream2.getTracks().forEach(t => t.stop()); _stream2 = null; }
  const pip = document.getElementById('camVideo2');
  if (pip) { pip.srcObject = null; pip.hidden = true; }

  let c1, c2;
  if (mode === 'front-back') {
    c1 = { video: { facingMode: { exact: 'environment' }, width: { ideal: 4096 }, height: { ideal: 2160 } }, audio: false };
    c2 = { video: { facingMode: { exact: 'user' },        width: { ideal: 4096 }, height: { ideal: 2160 } }, audio: false };
  } else { // tele-wide
    let cams = [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      cams = all.filter(d => d.kind === 'videoinput' && !d.label.toLowerCase().match(/front|facetime|user/));
    } catch {}
    if (cams.length >= 2) {
      const wI = cams.findIndex(c => c.label.toLowerCase().match(/ultra.*wide|wide angle|weitwinkel/));
      const tI = cams.findIndex(c => c.label.toLowerCase().match(/tele|telephoto|zoom|[23]x\b/));
      const cam1 = cams[wI >= 0 ? wI : 0];
      const fallback2 = cams.find(c => c.deviceId !== cam1.deviceId);
      const cam2 = tI >= 0 && cams[tI].deviceId !== cam1.deviceId ? cams[tI] : fallback2;
      c1 = { video: { deviceId: { exact: cam1.deviceId }, width: { ideal: 4096 }, height: { ideal: 2160 } }, audio: false };
      c2 = cam2 ? { video: { deviceId: { exact: cam2.deviceId }, width: { ideal: 4096 }, height: { ideal: 2160 } }, audio: false } : null;
    } else {
      c1 = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 2160 } }, audio: false };
      c2 = null;
    }
  }

  try { _stream = await navigator.mediaDevices.getUserMedia(c1); }
  catch { _stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }); }
  const v1 = document.getElementById('camVideo');
  if (v1) { v1.srcObject = _stream; v1.play().catch(() => {}); }
  _videoTrack = _stream.getVideoTracks()[0];

  if (c2) {
    try {
      _stream2 = await navigator.mediaDevices.getUserMedia(c2);
      _videoTrack2 = _stream2.getVideoTracks()[0];
      if (pip) { pip.srcObject = _stream2; pip.play().catch(() => {}); pip.hidden = false; }
    } catch (e) {
      console.warn('Zweite Kamera nicht verfügbar:', e);
      _stream2 = null; _videoTrack2 = null;
    }
  }
}

// ---- Dual-Foto: beide Kameras vertikal gestapelt ----
async function _takeDualPhoto() {
  const v1  = document.getElementById('camVideo');
  const v2  = document.getElementById('camVideo2');
  const cv  = document.getElementById('camCanvas');
  if (!v1 || !cv) return;
  const W1 = v1.videoWidth || 1280, H1 = v1.videoHeight || 720;
  const has2 = _stream2 && v2 && !v2.hidden && v2.videoWidth > 0;
  const ctx = cv.getContext('2d');
  if (has2) {
    const W2 = v2.videoWidth, H2 = v2.videoHeight;
    const W = Math.max(W1, W2);
    cv.width = W; cv.height = H1 + H2;
    ctx.drawImage(v1, 0, 0, W1, H1);
    // Zweite Kamera zentriert darunter
    ctx.drawImage(v2, (W - W2) / 2, H1, W2, H2);
    // Trennlinie
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillRect(0, H1, W, 2);
  } else {
    // Fallback: gleiche Kamera — oben normal, unten 2× digital gezoomt
    cv.width = W1; cv.height = H1 * 2;
    ctx.drawImage(v1, 0, 0, W1, H1);
    const sw = W1 / 2, sh = H1 / 2;
    ctx.drawImage(v1, (W1 - sw) / 2, (H1 - sh) / 2, sw, sh, 0, H1, W1, H1);
    ctx.fillStyle = 'rgba(255,255,255,.25)';
    ctx.fillRect(0, H1, W1, 2);
  }
  cv.toBlob(blob => {
    if (!blob) return;
    // Bewusst NICHT _close(): nach einem Dual-Foto bleibt man ebenfalls in der Kamera, wie beim
    // normalen Fotomodus (siehe _takePhoto) — nur das Galerie-Icon blinkt als Bestätigung.
    _flashGallery();
    if (_onCapture) _onCapture({ blob, mime: 'image/jpeg', kind: 'photo' });
  }, 'image/jpeg', 0.95);
}

// ---- Stream starten / wechseln ----
async function _startStream(camId, micId) {
  _stopMeter(); _stopZoomAnim();
  // Reset zoom display immediately to avoid visual jump on camera switch
  const _vid0 = document.getElementById('camVideo');
  if (_vid0) _vid0.style.transform = '';
  const _zsl0 = document.getElementById('camZoom');
  if (_zsl0) _zsl0.value = parseFloat(_zsl0.min) || 1;
  if (_stream)  { _stream.getTracks().forEach(t => t.stop());  _stream = null; }
  if (_stream2) { _stream2.getTracks().forEach(t => t.stop()); _stream2 = null; }
  const pip = document.getElementById('camVideo2');
  if (pip) { pip.srcObject = null; pip.hidden = true; }

  const videoC = camId ? { deviceId: { exact: camId } } : { facingMode: { ideal: _facingMode } };
  const audioC = micId ? { deviceId: { exact: micId } } : true;
  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      video: { ...videoC, width: { ideal: 4096 }, height: { ideal: 2160 } },
      audio: audioC
    });
  } catch (_) {
    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { ...videoC, width: { ideal: 4096 }, height: { ideal: 2160 } },
        audio: false
      });
    } catch (_2) {
      // Eine bestimmte Linsen-deviceId kann ungültig sein (z.B. veraltete Auswahl nach einem
      // Geräte-/Berechtigungswechsel) — dann auf "irgendeine passende Kamera" zurückfallen statt
      // komplett zu scheitern (das gemeldete Android-Symptom "gar keine Kamera mehr angezeigt").
      if (!camId) throw _2;
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: _facingMode }, width: { ideal: 4096 }, height: { ideal: 2160 } },
        audio: false
      });
    }
  }

  const video = document.getElementById('camVideo');
  if (video) { video.srcObject = _stream; video.play().catch(() => {}); }

  _videoTrack = _stream.getVideoTracks()[0];
  _zoomSupported = false;
  _zoomMin = 1; _zoomMax = 1;
  const zoomWrap   = document.getElementById('camZoomWrap');
  const zoomSlider = document.getElementById('camZoom');
  if (_videoTrack && _videoTrack.getCapabilities) {
    try {
      const caps = _videoTrack.getCapabilities();
      if (caps.zoom) { _zoomMin = caps.zoom.min; _zoomMax = caps.zoom.max; _zoomSupported = true; }
    } catch {}
  }
  // Ohne Hardware-Zoom (v.a. iOS Safari) läuft der Zoom rein digital (CSS-Vorschau + Canvas-Crop
  // in Aufnahme/Fotos) — der Slider bleibt also IMMER verfügbar, nur die Spanne unterscheidet sich.
  const r = _zoomRange();
  if (zoomSlider) {
    zoomSlider.min = r.min; zoomSlider.max = r.max;
    zoomSlider.step = (r.max - r.min) / 50 || 0.1; zoomSlider.value = r.min;
  }
  // Frischer Stream startet ungezoomt — logisches Zoom-Modell darauf zurücksetzen.
  _hwZoom = _zoomMin || 1;
  _viewZoom = _hwZoom;
  if (zoomWrap) zoomWrap.hidden = false;
  _setupMeter();
}

// ---- Audio-Frequenz-Meter ----
function _setupMeter() {
  const audioTracks = _stream ? _stream.getAudioTracks() : [];
  const cv = document.getElementById('camMeter');
  if (!audioTracks.length || !cv) return;
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = _audioCtx.createMediaStreamSource(_stream);
    _analyser = _audioCtx.createAnalyser(); _analyser.fftSize = 64;
    src.connect(_analyser);
    _meterFreqs = new Uint8Array(_analyser.frequencyBinCount);
    cv.style.display = ''; _drawMeter(cv);
  } catch (e) { console.warn('cam meter', e); if (cv) cv.style.display = 'none'; }
}

function _drawMeter(cv) {
  const ctx = cv.getContext('2d');
  function frame() {
    if (!_analyser || !_meterFreqs) return;
    const modal = document.getElementById('cameraModal');
    if (!modal || !modal.classList.contains('open')) return;
    _analyser.getByteFrequencyData(_meterFreqs);
    const w = cv.width, h = cv.height, bars = _meterFreqs.length, bw = (w / bars) - 1;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < bars; i++) {
      const v = _meterFreqs[i] / 255, bh = Math.max(2, v * h);
      const hue = Math.round(120 - v * 120);
      ctx.fillStyle = `hsla(${hue},75%,55%,${0.5 + v * 0.5})`;
      ctx.fillRect(Math.round(i * (bw + 1)), h - bh, Math.max(1, Math.round(bw)), bh);
    }
    _meterRaf = requestAnimationFrame(frame);
  }
  frame();
}

function _stopMeter() {
  if (_meterRaf) { cancelAnimationFrame(_meterRaf); _meterRaf = null; }
  try { if (_audioCtx && _audioCtx.state !== 'closed') _audioCtx.close(); } catch {}
  _audioCtx = null; _analyser = null; _meterFreqs = null;
}

// ---- Wake-Lock: Display anlassen, solange die Kamera offen ist ----
// Beim Ansitz vergehen oft Minuten ohne Berührung — ginge das Display aus, würde eine laufende
// Video-/Zeitraffer-Aufnahme mitten drin abbrechen. Re-Acquire nach Tab-Wechsel (der Browser
// gibt den Lock beim Verstecken automatisch frei).
let _wakeLock = null;
async function _acquireWakeLock() {
  try { if ('wakeLock' in navigator) _wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function _releaseWakeLock() {
  try { _wakeLock?.release(); } catch {}
  _wakeLock = null;
}
function _onVisibility() {
  const modal = document.getElementById('cameraModal');
  if (document.visibilityState === 'visible' && modal?.classList.contains('open')) _acquireWakeLock();
}

// ---- Aufräumen ----
function _cleanup() {
  _stopMeter(); _stopZoomAnim(); _stopRecTimer();
  _releaseWakeLock();
  document.removeEventListener('visibilitychange', _onVisibility);
  if (_hwSyncTimer) { clearTimeout(_hwSyncTimer); _hwSyncTimer = null; }
  _burstActive = false;
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
  if (_intervalCountdown) { _intervalCountdown.remove(); _intervalCountdown = null; } _intervalNext = 0;
  if (_lapseTimer) { clearInterval(_lapseTimer); _lapseTimer = null; } _lapseFrames = [];
  const building = document.getElementById('camLapseBuilding'); if (building) building.hidden = true;
  if (_mr && _mr.state === 'recording') _mr.stop();
  _mr = null; _mrChunks = [];
  _stopCanvasRecPipeline();
  _cancelMasterLoop(); // defensiv: verhindert einen einzelnen verspäteten Tick nach dem Schließen
  if (_stream)  { _stream.getTracks().forEach(t => t.stop());  _stream = null; }
  if (_stream2) { _stream2.getTracks().forEach(t => t.stop()); _stream2 = null; }
  _videoTrack = null; _videoTrack2 = null;
  const video = document.getElementById('camVideo');
  if (video) { video.srcObject = null; video.style.transform = ''; }
  const pip = document.getElementById('camVideo2');
  if (pip) { pip.srcObject = null; pip.hidden = true; }
  const ind = document.getElementById('camRecIndicator'); if (ind) ind.hidden = true;
  const cap = document.getElementById('camCapture'); if (cap) cap.classList.remove('recording');
}

function _close() {
  _cleanup();
  const modal = document.getElementById('cameraModal');
  if (modal) modal.classList.remove('open');
}

// ---- Modus-UI ----
function _updateModeUI() {
  const isDual = _mode === 'tele-wide' || _mode === 'front-back';
  document.getElementById('camModePhoto')?.classList.toggle('on', _mode === 'photo');
  document.getElementById('camModeVideo')?.classList.toggle('on', _mode === 'video');
  document.getElementById('camModeLapse')?.classList.toggle('on', _mode === 'lapse');
  document.getElementById('camModeDual')?.classList.toggle('on', _mode === 'tele-wide');
  document.getElementById('camModeFrontBack')?.classList.toggle('on', _mode === 'front-back');
  const cap = document.getElementById('camCapture');
  if (cap) cap.className = 'cam-shutter' + (_mode === 'video' || _mode === 'lapse' ? ' video' : '');
  // Auto-Zoom: Toggle-Button nur im Video-Modus sichtbar; Panel bleibt collapsed beim Moduswechsel
  const azToggle = document.getElementById('camAzToggle');
  if (azToggle) azToggle.hidden = _mode !== 'video';
  if (_mode !== 'video') {
    const azWrap = document.getElementById('camAutoZoomWrap');
    if (azWrap) azWrap.hidden = true;
    if (azToggle) azToggle.classList.remove('active');
    if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; const ib = document.getElementById('camInterval'); if (ib) ib.classList.remove('on'); }
  }
  // Zeitraffer-Intervallauswahl nur im Zeitraffer-Modus sichtbar
  const lapseWrap = document.getElementById('camLapseWrap');
  if (lapseWrap) lapseWrap.hidden = _mode !== 'lapse';
  if (_mode !== 'lapse' && _lapseTimer) {
    clearInterval(_lapseTimer); _lapseTimer = null; _lapseFrames = [];
    const ind = document.getElementById('camRecIndicator'); if (ind) { ind.hidden = true; ind.textContent = '⏺ REC'; }
    const cap2 = document.getElementById('camCapture'); if (cap2) cap2.classList.remove('recording');
  }
  // Burst/Interval nur im Fotomodus sichtbar
  const photoExtras = document.getElementById('camPhotoExtras');
  if (photoExtras) photoExtras.style.display = _mode === 'photo' ? 'flex' : 'none';
  // Flip-Button bei Dual ausblenden (macht dort keinen Sinn)
  const flip = document.getElementById('camFlip');
  if (flip) flip.style.visibility = isDual ? 'hidden' : '';
}

// ---- Foto aufnehmen ----
async function _takePhoto() {
  if (_mode === 'tele-wide' || _mode === 'front-back') return _takeDualPhoto();
  const video = document.getElementById('camVideo');
  const cv    = document.getElementById('camCanvas');
  if (!video || !cv) return;
  _drawZoomedFrame(cv, video); // gespeichert wird exakt der sichtbare (gezoomte) Ausschnitt
  cv.toBlob(blob => {
    if (!blob) return;
    // Bewusst NICHT _close(): im Fotomodus soll man nach dem Auslösen in der Kamera bleiben, um
    // ohne erneutes Öffnen mehrere Fotos hintereinander machen zu können — statt wegzunavigieren
    // blinkt nur das Galerie-Icon oben kurz als "gespeichert"-Bestätigung.
    _flashGallery();
    if (_onCapture) _onCapture({ blob, mime: 'image/jpeg', kind: 'photo' });
  }, 'image/jpeg', 0.95);
}

// ---- Video aufnehmen / stoppen ----
//
// Aufgenommen wird NICHT der rohe Kamera-Track, sondern ein Canvas-Kompositor: das <video>-Bild
// wird pro Frame mit dem aktuellen Digital-Zoom-Ausschnitt auf einen Canvas gezeichnet und
// dessen captureStream() (+ Mikrofon-Ton) an den MediaRecorder gegeben. Warum: Zoomen über
// track.applyConstraints() unterbricht auf vielen Handys jedes Mal kurz die Kamera-Pipeline —
// beim alten Direkt-Recording summierten sich diese Frame-Drops über die Zoomdauer zu heftigem
// Stottern in der fertigen Aufnahme. Im Canvas-Weg wird die Pipeline während der Aufnahme gar
// nicht mehr angefasst (Zoom läuft rein digital, framegenau) — der Stream wird mit bis zu 4K
// angefordert, der Aufnahme-Canvas ist auf Full-HD gedeckelt, dadurch bleibt auch ein kräftiger
// Digital-Zoom scharf. Einziger Hardware-Eingriff: VOR dem Aufnahmestart wird der Zoom einmal
// auf Minimum gestellt (voller Sensorausschnitt als Digital-Reserve) und der kurze Ruckler
// davon bewusst abgewartet, bevor der Recorder startet.
function _startCanvasRecPipeline() {
  const video = document.getElementById('camVideo');
  if (!video || !video.videoWidth || typeof document.createElement('canvas').captureStream !== 'function') return null;
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.min(1, 1920 / Math.max(vw, vh));
  const cw = Math.round(vw * scale / 2) * 2, ch = Math.round(vh * scale / 2) * 2; // gerade Maße für die Encoder
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  // Zeichnen läuft jetzt über die gemeinsame Schleife (_ensureMasterLoop) statt einer eigenen
  // rAF-Kette — dort mit der Zoom-Fahrt exakt synchron UND auf ~30fps gedrosselt (s. oben).
  _recCtx = cv.getContext('2d');
  // Canvas2D interpoliert beim Hochskalieren standardmäßig oft nur mit 'low' (browserabhängig,
  // spec-Default) — bei starkem Digital-Zoom (Quell-Crop deutlich kleiner als das Aufnahme-Canvas)
  // macht 'high' (bikubisch-ähnlich) einen sichtbaren Unterschied in der Schärfe der Aufnahme.
  _recCtx.imageSmoothingEnabled = true;
  _recCtx.imageSmoothingQuality = 'high';
  _recVW = vw; _recVH = vh; _recCW = cw; _recCH = ch; _recLastDraw = 0;
  _ensureMasterLoop();
  const stream = cv.captureStream(30);
  for (const t of _stream.getAudioTracks()) stream.addTrack(t);
  return stream;
}

function _stopCanvasRecPipeline() {
  _recCtx = null; // Master-Loop stoppt sich selbst, sobald weder Zoom-Fahrt noch Aufnahme aktiv ist
  // Nur den Canvas-Videotrack beenden — die Audio-Tracks gehören weiter dem Kamera-Stream!
  if (_recCanvasStream) { _recCanvasStream.getVideoTracks().forEach(t => t.stop()); _recCanvasStream = null; }
}

// Laufzeit-Anzeige während der Aufnahme ("⏺ 1:07") — Nutzer erwarten bei Video einen Timer.
let _recTimerInt = null, _recT0 = 0;
function _startRecTimer() {
  const ind = document.getElementById('camRecIndicator');
  _recT0 = Date.now();
  const tick = () => {
    if (!ind) return;
    const s = Math.floor((Date.now() - _recT0) / 1000);
    ind.textContent = '⏺ ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  tick();
  _recTimerInt = setInterval(tick, 1000);
}
function _stopRecTimer() {
  if (_recTimerInt) { clearInterval(_recTimerInt); _recTimerInt = null; }
  const ind = document.getElementById('camRecIndicator'); if (ind) ind.textContent = '⏺ REC';
}

async function _toggleVideo() {
  if (_mr && _mr.state === 'recording') {
    _stopZoomAnim(); _mr.stop(); return;
  }
  if (!_stream) return;
  // Hardware-Zoom einmalig aufs Minimum: voller Sensorausschnitt = maximale Digital-Reserve,
  // und der Pipeline-Ruckler davon passiert VOR dem Aufnahmestart statt mittendrin.
  // Reihenfolge wichtig: erst die Hardware umstellen und den Inhaltswechsel abwarten, DANN das
  // Zoom-Modell (_hwZoom) und die CSS-Vorschau umrechnen — sonst zeigt die Vorschau für einen
  // Augenblick doppelt gezoomt (CSS-Faktor springt hoch, während der Track noch gezoomt liefert).
  if (_zoomSupported && _videoTrack && _hwZoom !== _zoomMin) {
    try { _videoTrack.applyConstraints({ advanced: [{ zoom: _zoomMin }] }); } catch {}
    await new Promise(r => setTimeout(r, 350));
    _hwZoom = _zoomMin;
    _renderZoom(_viewZoom);
  }
  // Ist eine Kamerafahrt-Richtung gewählt, den sichtbaren Zoom VOR dem Aufnahmestart auf den
  // wahren Start-Endpunkt zurücksetzen (min bei "Rein", max bei "Raus") — sonst würde die Fahrt
  // dort weitermachen, wo ein vorheriger manueller/Vorschau-Zoom gerade stand, im schlimmsten Fall
  // schon am Ziel (dann zeigt die AUFNAHME von Anfang an den Endzustand, ohne jede Bewegung).
  if (_zoomDir !== 'none') {
    // Selber Deckel wie _startZoomAnim(true) gleich danach — sonst würde die Vorschau hier schon
    // kurz auf den vollen (ungedeckelten) Hardware-Maximalwert springen, bevor die eigentliche
    // Fahrt überhaupt beginnt (bei "Raus" besonders sichtbar: ein harter Zoom-Sprung im Bild,
    // noch bevor die Aufnahme lief).
    const { min: minZ, max: maxZ } = _recZoomRange();
    _renderZoom(_zoomDir === 'in' ? minZ : maxZ);
  }
  _recCanvasStream = _startCanvasRecPipeline();
  const recStream = _recCanvasStream || _stream; // Fallback: altes Direkt-Recording (z.B. sehr alte Browser)
  let mime = '';
  for (const t of ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
  }
  // Bitrate explizit setzen: die Browser-Defaults sind für Full-HD-Naturaufnahmen mit viel
  // Blattwerk-Detail zu niedrig (Matsch beim Zoomen) — 8 MBit/s Video ist ein guter Kompromiss.
  const opts = { videoBitsPerSecond: 8e6, audioBitsPerSecond: 128e3 };
  if (mime) opts.mimeType = mime;
  try { _mr = new MediaRecorder(recStream, opts); }
  catch (e) {
    console.warn('cam mr opts', e);
    try { _mr = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream); }
    catch (e2) { console.warn('cam mr', e2); _stopCanvasRecPipeline(); return; }
  }
  _mrChunks = [];
  _mr.ondataavailable = e => { if (e.data?.size) _mrChunks.push(e.data); };
  _mr.onstop = () => {
    _stopRecTimer();
    _stopCanvasRecPipeline();
    const blob = new Blob(_mrChunks, { type: mime || 'video/webm' });
    _mrChunks = [];
    const cb = _onCapture; _close();
    if (cb) cb({ blob, mime: mime || 'video/webm', kind: 'video' });
  };
  _mr.start();
  _startZoomAnim(true); // true = immer volle Fahrt über die gesamte Aufnahme (siehe oben)
  _startRecTimer();
  const ind = document.getElementById('camRecIndicator'); if (ind) ind.hidden = false;
  const cap = document.getElementById('camCapture'); if (cap) cap.classList.add('recording');
}

// ---- Zeitraffer: Einzelbilder in festem Intervall sammeln, danach zu Video zusammensetzen ----
function _toggleLapse() {
  if (_lapseTimer) {
    clearInterval(_lapseTimer); _lapseTimer = null;
    const ind = document.getElementById('camRecIndicator'); if (ind) { ind.hidden = true; ind.textContent = '⏺ REC'; }
    const cap = document.getElementById('camCapture'); if (cap) cap.classList.remove('recording');
    _buildLapseVideo();
    return;
  }
  if (!_stream) return;
  _lapseFrames = [];
  _captureLapseFrame();
  _lapseTimer = setInterval(_captureLapseFrame, _lapseIntervalSec * 1000);
  const ind = document.getElementById('camRecIndicator'); if (ind) { ind.hidden = false; ind.textContent = '⏺ 1 Bild'; }
  const cap = document.getElementById('camCapture'); if (cap) cap.classList.add('recording');
}

function _captureLapseFrame() {
  const video = document.getElementById('camVideo');
  const cv = document.getElementById('camCanvas');
  if (!video || !cv) return;
  _drawZoomedFrame(cv, video); // Zeitraffer-Frames folgen ebenfalls dem sichtbaren Zoom
  cv.toBlob(blob => {
    if (!blob) return;
    _lapseFrames.push(blob);
    const ind = document.getElementById('camRecIndicator');
    if (ind && !ind.hidden) ind.textContent = '⏺ ' + _lapseFrames.length + (_lapseFrames.length === 1 ? ' Bild' : ' Bilder');
  }, 'image/jpeg', 0.85);
}

function _blobToImage(blob) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Bild konnte nicht geladen werden')); };
    img.src = url;
  });
}

// Setzt gesammelte Einzelbilder zu einem schnellen Video zusammen — läuft über
// HTMLCanvasElement.captureStream(), das (anders als HTMLVideoElement.captureStream) auch in
// Browsern ohne Video-Element-Capture-Support (z.B. iOS Safari) funktioniert.
async function _buildLapseVideo() {
  const frames = _lapseFrames; _lapseFrames = [];
  if (frames.length < 2) return;
  const building = document.getElementById('camLapseBuilding');
  if (building) building.hidden = false;
  const FPS = 8;
  try {
    const cv = document.createElement('canvas');
    const firstImg = await _blobToImage(frames[0]);
    cv.width = firstImg.width; cv.height = firstImg.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(firstImg, 0, 0);

    if (typeof cv.captureStream !== 'function') throw new Error('Zeitraffer-Erstellung wird von diesem Browser nicht unterstützt');
    const stream = cv.captureStream(FPS);
    let mime = '';
    for (const t of ['video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
    }
    const mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks = [];
    mr.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    const done = new Promise(res => { mr.onstop = res; });
    mr.start();

    const holdMs = 1000 / FPS;
    for (let i = 1; i < frames.length; i++) {
      const img = await _blobToImage(frames[i]);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      await new Promise(r => setTimeout(r, holdMs));
    }
    await new Promise(r => setTimeout(r, holdMs * 2)); // letztes Bild noch halten
    mr.stop();
    await done;

    const blob = new Blob(chunks, { type: mime || 'video/webm' });
    if (building) building.hidden = true;
    if (!blob.size) { console.warn('lapse build empty'); return; }
    const cb = _onCapture; _close();
    if (cb) cb({ blob, mime: mime || 'video/webm', kind: 'video' });
  } catch (e) {
    console.warn('lapse build', e);
    if (building) building.hidden = true;
  }
}

// ---- Öffentliche API ----
// onGalleryTap (optional): app.js reicht hier die eigene Galerie-Öffnen-Funktion herein, damit das
// Galerie-Icon in der Kamera-Kopfzeile tippbar ist (schließt die Kamera und zeigt die Aufnahmen) —
// camera.js kennt die App-Galerie selbst nicht, genau wie bei onCapture.
export function openCamera(onCapture, onGalleryTap) {
  const modal = document.getElementById('cameraModal');
  if (!modal) return;
  _onCapture = onCapture;
  const galBtn = document.getElementById('camGalleryBtn');
  if (galBtn) galBtn.onclick = onGalleryTap ? () => { _close(); onGalleryTap(); } : null;
  _mode = 'photo';
  modal.classList.add('open');
  _updateModeUI();
  _acquireWakeLock();
  document.addEventListener('visibilitychange', _onVisibility);

  // Fadenkreuz-Einstellung merkt sich über Sitzungen hinweg (wie Auslöseton/Linkshänder-Modus).
  const crosshair = document.getElementById('camCrosshair');
  const crosshairBtn = document.getElementById('camCrosshairToggle');
  const crosshairOn = localStorage.getItem('waldohr.crosshair') === 'on';
  if (crosshair) crosshair.hidden = !crosshairOn;
  if (crosshairBtn) crosshairBtn.classList.toggle('active', crosshairOn);

  if (!modal._camWired) {
    modal._camWired = true;

    document.getElementById('camClose')?.addEventListener('click', _close);

    document.getElementById('camCrosshairToggle')?.addEventListener('click', () => {
      const ch = document.getElementById('camCrosshair');
      const btn = document.getElementById('camCrosshairToggle');
      if (!ch) return;
      ch.hidden = !ch.hidden;
      if (btn) btn.classList.toggle('active', !ch.hidden);
      try { localStorage.setItem('waldohr.crosshair', ch.hidden ? 'off' : 'on'); } catch {}
    });

    document.getElementById('camAzToggle')?.addEventListener('click', () => {
      const wrap = document.getElementById('camAutoZoomWrap');
      const btn  = document.getElementById('camAzToggle');
      if (!wrap) return;
      wrap.hidden = !wrap.hidden;
      if (btn) btn.classList.toggle('active', !wrap.hidden);
    });

    // Während einer laufenden Videoaufnahme sind Moduswechsel, Kamera-Flip und Gerätewechsel
    // gesperrt: sie würden den Stream neu starten bzw. die Bedienlogik wechseln und die Aufnahme
    // stillschweigend zerstören (der Recorder hängt an den alten Tracks). Kurzes Aufblinken der
    // REC-Anzeige als Feedback, warum nichts passiert.
    function _guardRecording() {
      if (!_isRecording()) return false;
      const ind = document.getElementById('camRecIndicator');
      if (ind) { ind.style.transform = 'scale(1.25)'; setTimeout(() => { ind.style.transform = ''; }, 200); }
      return true;
    }
    const _setMode = m => {
      if (_guardRecording()) return;
      _mode = m; _updateModeUI();
      // Wenn vorher Dual war, normalen Stream neustarten
      if (_stream2) {
        _stream2.getTracks().forEach(t => t.stop()); _stream2 = null;
        const pip = document.getElementById('camVideo2');
        if (pip) { pip.srcObject = null; pip.hidden = true; }
      }
    };
    document.getElementById('camModePhoto')?.addEventListener('click', () => _setMode('photo'));
    document.getElementById('camModeVideo')?.addEventListener('click', () => _setMode('video'));
    document.getElementById('camModeLapse')?.addEventListener('click', () => _setMode('lapse'));
    [['1s', 'camLapse1s', 1], ['2s', 'camLapse2s', 2], ['5s', 'camLapse5s', 5], ['10s', 'camLapse10s', 10]].forEach(([, id, sec]) => {
      document.getElementById(id)?.addEventListener('click', () => {
        _lapseIntervalSec = sec;
        ['camLapse1s', 'camLapse2s', 'camLapse5s', 'camLapse10s'].forEach(bid => document.getElementById(bid)?.classList.remove('on'));
        document.getElementById(id)?.classList.add('on');
      });
    });
    document.getElementById('camCapture')?.addEventListener('click', () => {
      if (_mode === 'video') _toggleVideo();
      else if (_mode === 'lapse') _toggleLapse();
      else _takePhoto();
    });

    document.getElementById('camFlip')?.addEventListener('click', async () => {
      if (_guardRecording()) return;
      const micSel = document.getElementById('camMicSelect');
      _facingMode = _facingMode === 'environment' ? 'user' : 'environment';
      await _startStream(null, micSel?.value || null).catch(e => console.warn('flip', e));
    });

    // input = kontinuierlich beim Ziehen (CSS-Vorschau sofort, Hardware gedrosselt nachziehen),
    // change = Finger losgelassen (Hardware sofort final synchronisieren).
    document.getElementById('camZoom')?.addEventListener('input', function () {
      _applyZoom(parseFloat(this.value));
    });
    document.getElementById('camZoom')?.addEventListener('change', function () {
      _applyZoom(parseFloat(this.value), true);
    });

    // Auto-Zoom Richtung
    [['none','camAzOff'],['in','camAzIn'],['out','camAzOut']].forEach(([dir, id]) => {
      document.getElementById(id)?.addEventListener('click', () => {
        _zoomDir = dir;
        ['camAzOff','camAzIn','camAzOut'].forEach(bid => document.getElementById(bid)?.classList.remove('on'));
        document.getElementById(id)?.classList.add('on');
      });
    });
    // Auto-Zoom Tempo
    [['fast','camAzFast'],['slow','camAzSlow']].forEach(([speed, id]) => {
      document.getElementById(id)?.addEventListener('click', () => {
        _zoomSpeed = speed;
        ['camAzFast','camAzSlow'].forEach(bid => document.getElementById(bid)?.classList.remove('on'));
        document.getElementById(id)?.classList.add('on');
      });
    });
    // Verzögerter Zoom-Start (3s countdown)
    document.getElementById('camAzDelay')?.addEventListener('click', () => {
      _stopZoomAnim();
      const btn = document.getElementById('camAzDelay');
      let n = 3;
      if (btn) btn.textContent = '⏱ ' + n + 's';
      _azDelayTimer = setInterval(() => {
        n--;
        if (n > 0) { if (btn) btn.textContent = '⏱ ' + n + 's'; }
        else {
          clearInterval(_azDelayTimer); _azDelayTimer = null;
          if (btn) btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> 3s';
          _startZoomAnim();
        }
      }, 1000);
    });
    // Sanfter Zoom-Stop
    document.getElementById('camAzStop')?.addEventListener('click', _smoothStopZoom);
    // Serienaufnahme
    document.getElementById('camBurst')?.addEventListener('click', _doBurst);
    // Intervall-Aufnahme
    document.getElementById('camInterval')?.addEventListener('click', _toggleInterval);

    const camSel = document.getElementById('camCamSelect');
    const micSel = document.getElementById('camMicSelect');
    camSel?.addEventListener('change', () => { if (_guardRecording()) return; _startStream(camSel.value || null, micSel?.value || null).catch(console.warn); });
    micSel?.addEventListener('change', () => { if (_guardRecording()) return; _startStream(camSel?.value || null, micSel.value || null).catch(console.warn); });

    // ---- Pinch-to-Zoom auf der Vorschau (Zwei-Finger-Geste wie in jeder Kamera-App) ----
    // Läuft komplett über das Digital-Zoom-Modell: Vorschau framegenau per CSS, Hardware zieht
    // gedrosselt nach (bzw. gar nicht während einer Aufnahme -> Canvas-Kompositor zoomt).
    const wrap = document.querySelector('#cameraModal .cam-video-wrap');
    if (wrap) {
      const ptrs = new Map();
      let pinchStartDist = 0, pinchStartZoom = 1;
      const dist = () => {
        const [a, b] = [...ptrs.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
      };
      wrap.addEventListener('pointerdown', e => {
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ptrs.size === 2) { pinchStartDist = dist(); pinchStartZoom = _viewZoom; }
      });
      wrap.addEventListener('pointermove', e => {
        if (!ptrs.has(e.pointerId)) return;
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (ptrs.size === 2 && pinchStartDist > 0) {
          e.preventDefault();
          _applyZoom(pinchStartZoom * (dist() / pinchStartDist));
        }
      });
      const endPtr = e => {
        ptrs.delete(e.pointerId);
        if (ptrs.size < 2 && pinchStartDist > 0) { pinchStartDist = 0; _applyZoom(_viewZoom, true); }
      };
      wrap.addEventListener('pointerup', endPtr);
      wrap.addEventListener('pointercancel', endPtr);
      wrap.addEventListener('pointerleave', endPtr);
      wrap.style.touchAction = 'none'; // Browser-Pinch (Seiten-Zoom) auf der Vorschau unterbinden
    }
  }

  _startStream(null, null)
    .then(() => _enumerateDevices())
    .catch(e => {
      console.warn('openCamera', e);
      modal.classList.remove('open');
      const inp = document.getElementById('photoInput');
      if (inp) inp.click();
    });
}
