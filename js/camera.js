// Kamera-Modi: photo | video | tele-wide | front-back
// Dual-Kamera stacked Foto, Auto-Zoom beim Filmen, stufenloser Zoom.
let _stream = null, _videoTrack = null;
let _stream2 = null, _videoTrack2 = null;
let _analyser = null, _audioCtx = null, _meterFreqs = null, _meterRaf = null;
let _mr = null, _mrChunks = [];
let _mode = 'photo';
let _zoomSupported = false, _zoomMin = 1, _zoomMax = 1;
let _onCapture = null;
let _zoomDir = 'none', _zoomSpeed = 'slow', _zoomAnimTimer = null;
let _azDelayTimer = null, _intervalTimer = null, _burstActive = false;
let _intervalCountdown = null, _intervalNext = 0;
let _facingMode = 'environment';

// ---- Geräte aufzählen (Labels erst nach Genehmigung verfügbar) ----
async function _enumerateDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const allCams = all.filter(d => d.kind === 'videoinput');
    const mics = all.filter(d => d.kind === 'audioinput');
    const camSel = document.getElementById('camCamSelect');
    if (camSel && allCams.length) {
      // Nur Rückkameras (kein Frontkamera/Selfie)
      const back = allCams.filter(d => !d.label.toLowerCase().match(/front|facetime|user|selfie/));
      const ultraWide = back.find(d => d.label.toLowerCase().match(/ultra/));
      const wide = back.find(d => !d.label.toLowerCase().match(/ultra|telephoto|tele|[23]\.?[0-9]?x\b/)) || back[0];
      const tele = back.find(d => d.label.toLowerCase().match(/telephoto|tele|[23]\.?[0-9]?x\b/) && d !== wide);
      const chosen = [ultraWide, wide, tele].filter(Boolean);
      if (!chosen.length) chosen.push(...allCams.slice(0, 3));
      camSel.innerHTML = chosen.map(d => {
        const lbl = d.label.toLowerCase();
        const name = lbl.match(/ultra/) ? '📷 Ultra-Weit (0.5×)' : lbl.match(/telephoto|tele|[23]\.?[0-9]?x\b/) ? '🔭 Tele' : '📷 Normal (1×)';
        return `<option value="${d.deviceId}">${name}</option>`;
      }).join('');
      camSel.style.display = chosen.length > 1 ? '' : 'none';
    }
    const micSel = document.getElementById('camMicSelect');
    if (micSel && mics.length) {
      micSel.innerHTML = mics.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Mikrofon ' + (i + 1)}</option>`).join('');
      micSel.style.display = mics.length > 1 ? '' : 'none';
    }
  } catch (e) { console.warn('enumerate', e); }
}

// ---- Auto-Zoom ----
function _applyZoom(v) {
  if (_zoomSupported && _videoTrack) {
    try { _videoTrack.applyConstraints({ advanced: [{ zoom: v }] }); } catch {}
  } else {
    const vid = document.getElementById('camVideo');
    if (vid) vid.style.transform = `scale(${Math.max(1, v / (_zoomMin || 1))})`;
  }
  const sl = document.getElementById('camZoom'); if (sl) sl.value = v;
  const zv = document.getElementById('camZoomVal'); if (zv) zv.textContent = v.toFixed(1) + '×';
}

function _stopZoomAnim() {
  if (_azDelayTimer) { clearTimeout(_azDelayTimer); _azDelayTimer = null; }
  if (_zoomAnimTimer) { cancelAnimationFrame(_zoomAnimTimer); _zoomAnimTimer = null; }
}

function _smoothStopZoom() {
  _stopZoomAnim();
  const vid = document.getElementById('camVideo');
  if (vid) { vid.style.transition = 'transform 0.4s ease-out'; setTimeout(() => { if (vid) vid.style.transition = ''; }, 420); }
}

function _playShutter() {
  if (localStorage.getItem('waldohr.shutterSound') === 'off') return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = 'square'; osc.frequency.setValueAtTime(1400, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(280, ctx.currentTime + 0.06);
    osc.connect(gain); osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.07);
    osc.onended = () => { try { ctx.close(); } catch {} };
  } catch {}
}

function _captureFrameOnly() {
  const video = document.getElementById('camVideo');
  const cv = document.getElementById('camCanvas');
  if (!video || !cv) return Promise.resolve();
  _playShutter();
  return new Promise(resolve => {
    cv.width = video.videoWidth || 1280; cv.height = video.videoHeight || 720;
    cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
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
        _captureFrameOnly();
        _intervalNext = 3;
        if (_intervalCountdown) _intervalCountdown.textContent = _intervalNext;
      }
    }, 1000);
    if (btn) btn.classList.add('on');
  }
}

function _startZoomAnim() {
  _stopZoomAnim();
  if (_zoomDir === 'none') return;
  const maxZ = _zoomSupported ? _zoomMax : 3;
  const minZ = _zoomSupported ? _zoomMin : 1;
  const dur = _zoomSpeed === 'fast' ? 7000 : 28000;
  const from = _zoomDir === 'in' ? minZ : maxZ;
  const to   = _zoomDir === 'in' ? maxZ : minZ;
  if (from === to) return;
  const vid = document.getElementById('camVideo');
  const t0 = performance.now();
  const tick = now => {
    const p = Math.min(1, (now - t0) / dur);
    // Logarithmische Interpolation → wahrgenommene Zoom-Geschwindigkeit konstant
    const v = from * Math.pow(to / from, p);
    // CSS scale für flüssige Animation ohne physischen Linsenwechsel-Sprung
    if (vid) vid.style.transform = `scale(${Math.max(1, v / (minZ || 1))})`;
    const sl = document.getElementById('camZoom'); if (sl) sl.value = v;
    const zv = document.getElementById('camZoomVal'); if (zv) zv.textContent = v.toFixed(1) + '×';
    if (p < 1) { _zoomAnimTimer = requestAnimationFrame(tick); }
    else { _zoomAnimTimer = null; }
  };
  _zoomAnimTimer = requestAnimationFrame(tick);
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
    const cb = _onCapture; _close();
    if (cb) cb({ blob, mime: 'image/jpeg', kind: 'photo' });
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
  const _zvl0 = document.getElementById('camZoomVal');
  if (_zvl0) _zvl0.textContent = '1.0×';
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
    _stream = await navigator.mediaDevices.getUserMedia({
      video: { ...videoC, width: { ideal: 4096 }, height: { ideal: 2160 } },
      audio: false
    });
  }

  const video = document.getElementById('camVideo');
  if (video) { video.srcObject = _stream; video.play().catch(() => {}); }

  _videoTrack = _stream.getVideoTracks()[0];
  _zoomSupported = false;
  const zoomWrap   = document.getElementById('camZoomWrap');
  const zoomSlider = document.getElementById('camZoom');
  if (_videoTrack && _videoTrack.getCapabilities) {
    try {
      const caps = _videoTrack.getCapabilities();
      if (caps.zoom) {
        _zoomMin = caps.zoom.min; _zoomMax = caps.zoom.max; _zoomSupported = true;
        if (zoomSlider) {
          zoomSlider.min = _zoomMin; zoomSlider.max = _zoomMax;
          zoomSlider.step = (_zoomMax - _zoomMin) / 50; zoomSlider.value = _zoomMin;
        }
        const zv = document.getElementById('camZoomVal'); if (zv) zv.textContent = _zoomMin.toFixed(1) + '×';
      }
    } catch {}
  }
  if (zoomWrap) zoomWrap.hidden = !_zoomSupported;
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

// ---- Aufräumen ----
function _cleanup() {
  _stopMeter(); _stopZoomAnim();
  _burstActive = false;
  if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; }
  if (_intervalCountdown) { _intervalCountdown.remove(); _intervalCountdown = null; } _intervalNext = 0;
  if (_mr && _mr.state === 'recording') _mr.stop();
  _mr = null; _mrChunks = [];
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
  document.getElementById('camModeDual')?.classList.toggle('on', _mode === 'tele-wide');
  document.getElementById('camModeFrontBack')?.classList.toggle('on', _mode === 'front-back');
  const cap = document.getElementById('camCapture');
  if (cap) cap.className = 'cam-shutter' + (_mode === 'video' ? ' video' : '');
  // Auto-Zoom: Toggle-Button nur im Video-Modus sichtbar; Panel bleibt collapsed beim Moduswechsel
  const azToggle = document.getElementById('camAzToggle');
  if (azToggle) azToggle.hidden = _mode !== 'video';
  if (_mode !== 'video') {
    const azWrap = document.getElementById('camAutoZoomWrap');
    if (azWrap) azWrap.hidden = true;
    if (azToggle) azToggle.classList.remove('active');
    if (_intervalTimer) { clearInterval(_intervalTimer); _intervalTimer = null; const ib = document.getElementById('camInterval'); if (ib) ib.classList.remove('on'); }
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
  cv.width  = video.videoWidth  || 1280;
  cv.height = video.videoHeight || 720;
  cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
  cv.toBlob(blob => {
    if (!blob) return;
    const cb = _onCapture; _close();
    if (cb) cb({ blob, mime: 'image/jpeg', kind: 'photo' });
  }, 'image/jpeg', 0.95);
}

// ---- Video aufnehmen / stoppen ----
function _toggleVideo() {
  if (_mr && _mr.state === 'recording') {
    _stopZoomAnim(); _mr.stop(); return;
  }
  if (!_stream) return;
  let mime = '';
  for (const t of ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
  }
  try { _mr = mime ? new MediaRecorder(_stream, { mimeType: mime }) : new MediaRecorder(_stream); }
  catch (e) { console.warn('cam mr', e); return; }
  _mrChunks = [];
  _mr.ondataavailable = e => { if (e.data?.size) _mrChunks.push(e.data); };
  _mr.onstop = () => {
    const blob = new Blob(_mrChunks, { type: mime || 'video/webm' });
    _mrChunks = [];
    const cb = _onCapture; _close();
    if (cb) cb({ blob, mime: mime || 'video/webm', kind: 'video' });
  };
  _mr.start();
  _startZoomAnim();
  const ind = document.getElementById('camRecIndicator'); if (ind) ind.hidden = false;
  const cap = document.getElementById('camCapture'); if (cap) cap.classList.add('recording');
}

// ---- Öffentliche API ----
export function openCamera(onCapture) {
  const modal = document.getElementById('cameraModal');
  if (!modal) return;
  _onCapture = onCapture;
  _mode = 'photo';
  modal.classList.add('open');
  _updateModeUI();

  if (!modal._camWired) {
    modal._camWired = true;

    document.getElementById('camClose')?.addEventListener('click', _close);

    document.getElementById('camAzToggle')?.addEventListener('click', () => {
      const wrap = document.getElementById('camAutoZoomWrap');
      const btn  = document.getElementById('camAzToggle');
      if (!wrap) return;
      wrap.hidden = !wrap.hidden;
      if (btn) btn.classList.toggle('active', !wrap.hidden);
    });

    document.getElementById('camModePhoto')?.addEventListener('click', () => {
      _mode = 'photo'; _updateModeUI();
      // Wenn vorher Dual war, normalen Stream neustarten
      if (_stream2) {
        _stream2.getTracks().forEach(t => t.stop()); _stream2 = null;
        const pip = document.getElementById('camVideo2');
        if (pip) { pip.srcObject = null; pip.hidden = true; }
      }
    });
    document.getElementById('camModeVideo')?.addEventListener('click', () => {
      _mode = 'video'; _updateModeUI();
      if (_stream2) {
        _stream2.getTracks().forEach(t => t.stop()); _stream2 = null;
        const pip = document.getElementById('camVideo2');
        if (pip) { pip.srcObject = null; pip.hidden = true; }
      }
    });
    document.getElementById('camCapture')?.addEventListener('click', () => {
      if (_mode === 'video') _toggleVideo();
      else _takePhoto();
    });

    document.getElementById('camFlip')?.addEventListener('click', async () => {
      const micSel = document.getElementById('camMicSelect');
      _facingMode = _facingMode === 'environment' ? 'user' : 'environment';
      await _startStream(null, micSel?.value || null).catch(e => console.warn('flip', e));
    });

    document.getElementById('camZoom')?.addEventListener('input', async function () {
      const v = parseFloat(this.value);
      const zv = document.getElementById('camZoomVal'); if (zv) zv.textContent = v.toFixed(1) + '×';
      if (_zoomSupported && _videoTrack) {
        try { await _videoTrack.applyConstraints({ advanced: [{ zoom: v }] }); } catch {}
      } else {
        const vid = document.getElementById('camVideo'); if (vid) vid.style.transform = `scale(${v})`;
      }
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
    camSel?.addEventListener('change', () => _startStream(camSel.value || null, micSel?.value || null).catch(console.warn));
    micSel?.addEventListener('change', () => _startStream(camSel?.value || null, micSel.value || null).catch(console.warn));
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
