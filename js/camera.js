// Benutzerdefinierte Kamera: live Vorschau, Audio-Histogram, stufenloser Zoom, Foto + Video, Geräteauswahl.
let _stream = null, _videoTrack = null;
let _analyser = null, _audioCtx = null, _meterFreqs = null, _meterRaf = null;
let _mr = null, _mrChunks = [];
let _mode = 'photo'; // 'photo' | 'video'
let _zoomSupported = false, _zoomMin = 1, _zoomMax = 1;
let _onCapture = null;

// ---- Geräte aufzählen (Labels erst nach Genehmigung verfügbar) ----
async function _enumerateDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const cams = all.filter(d => d.kind === 'videoinput');
    const mics = all.filter(d => d.kind === 'audioinput');
    const camSel = document.getElementById('camCamSelect');
    const micSel = document.getElementById('camMicSelect');
    if (camSel && cams.length) {
      camSel.innerHTML = cams.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Kamera ' + (i + 1)}</option>`).join('');
      camSel.style.display = cams.length > 1 ? '' : 'none';
    }
    if (micSel && mics.length) {
      micSel.innerHTML = mics.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Mikrofon ' + (i + 1)}</option>`).join('');
      micSel.style.display = mics.length > 1 ? '' : 'none';
    }
  } catch (e) { console.warn('enumerate', e); }
}

// ---- Stream starten / wechseln ----
async function _startStream(camId, micId) {
  _stopMeter();
  if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }

  const videoC = camId ? { deviceId: { exact: camId } } : { facingMode: { ideal: 'environment' } };
  const audioC = micId ? { deviceId: { exact: micId } } : true;

  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      video: { ...videoC, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: audioC
    });
  } catch (_) {
    // Ohne Audio nochmals versuchen (Mikro-Verweigerung soll Kamera nicht blockieren)
    _stream = await navigator.mediaDevices.getUserMedia({
      video: { ...videoC, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
  }

  const video = document.getElementById('camVideo');
  if (video) { video.srcObject = _stream; video.play().catch(() => {}); }

  // Zoom-Fähigkeiten abfragen
  _videoTrack = _stream.getVideoTracks()[0];
  _zoomSupported = false;
  const zoomWrap = document.getElementById('camZoomWrap');
  const zoomSlider = document.getElementById('camZoom');
  if (_videoTrack && _videoTrack.getCapabilities) {
    try {
      const caps = _videoTrack.getCapabilities();
      if (caps.zoom) {
        _zoomMin = caps.zoom.min; _zoomMax = caps.zoom.max;
        _zoomSupported = true;
        if (zoomSlider) { zoomSlider.min = _zoomMin; zoomSlider.max = _zoomMax; zoomSlider.step = (_zoomMax - _zoomMin) / 50; zoomSlider.value = _zoomMin; }
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
    _analyser = _audioCtx.createAnalyser();
    _analyser.fftSize = 64;
    src.connect(_analyser);
    _meterFreqs = new Uint8Array(_analyser.frequencyBinCount);
    cv.style.display = '';
    _drawMeter(cv);
  } catch (e) {
    console.warn('cam meter', e);
    if (cv) cv.style.display = 'none';
  }
}

function _drawMeter(cv) {
  const ctx = cv.getContext('2d');
  function frame() {
    if (!_analyser || !_meterFreqs) return;
    const modal = document.getElementById('cameraModal');
    if (!modal || !modal.classList.contains('open')) return;
    _analyser.getByteFrequencyData(_meterFreqs);
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const bars = _meterFreqs.length;
    const bw = (w / bars) - 1;
    for (let i = 0; i < bars; i++) {
      const v = _meterFreqs[i] / 255;
      const bh = Math.max(2, v * h);
      // grün → gelb → rot
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
  _stopMeter();
  if (_mr && _mr.state === 'recording') { _mr.stop(); }
  _mr = null; _mrChunks = [];
  if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  _videoTrack = null;
  const video = document.getElementById('camVideo');
  if (video) { video.srcObject = null; video.style.transform = ''; }
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
  document.getElementById('camModePhoto')?.classList.toggle('on', _mode === 'photo');
  document.getElementById('camModeVideo')?.classList.toggle('on', _mode === 'video');
  const cap = document.getElementById('camCapture');
  if (cap) { cap.className = 'cam-shutter' + (_mode === 'video' ? ' video' : ''); }
}

// ---- Foto aufnehmen ----
async function _takePhoto() {
  const video = document.getElementById('camVideo');
  const cv = document.getElementById('camCanvas');
  if (!video || !cv) return;
  cv.width = video.videoWidth || 1280;
  cv.height = video.videoHeight || 720;
  cv.getContext('2d').drawImage(video, 0, 0, cv.width, cv.height);
  cv.toBlob(blob => {
    if (!blob) return;
    const cb = _onCapture;
    _close();
    if (cb) cb({ blob, mime: 'image/jpeg', kind: 'photo' });
  }, 'image/jpeg', 0.93);
}

// ---- Video aufnehmen / stoppen ----
function _toggleVideo() {
  if (_mr && _mr.state === 'recording') {
    _mr.stop();
    return;
  }
  if (!_stream) return;
  let mime = '';
  for (const t of ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
  }
  try {
    _mr = mime ? new MediaRecorder(_stream, { mimeType: mime }) : new MediaRecorder(_stream);
  } catch (e) { console.warn('cam mr', e); return; }
  _mrChunks = [];
  _mr.ondataavailable = e => { if (e.data?.size) _mrChunks.push(e.data); };
  _mr.onstop = () => {
    const blob = new Blob(_mrChunks, { type: mime || 'video/webm' });
    _mrChunks = [];
    const cb = _onCapture;
    _close();
    if (cb) cb({ blob, mime: mime || 'video/webm', kind: 'video' });
  };
  _mr.start();
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

  // Einmalig verdrahten
  if (!modal._camWired) {
    modal._camWired = true;

    document.getElementById('camClose')?.addEventListener('click', _close);

    document.getElementById('camModePhoto')?.addEventListener('click', () => { _mode = 'photo'; _updateModeUI(); });
    document.getElementById('camModeVideo')?.addEventListener('click', () => { _mode = 'video'; _updateModeUI(); });

    document.getElementById('camCapture')?.addEventListener('click', () => {
      if (_mode === 'photo') _takePhoto(); else _toggleVideo();
    });

    document.getElementById('camFlip')?.addEventListener('click', async () => {
      const camSel = document.getElementById('camCamSelect');
      const micSel = document.getElementById('camMicSelect');
      const opts = camSel ? [...camSel.options] : [];
      const idx = opts.findIndex(o => o.selected);
      const nextId = opts.length > 1 ? opts[(idx + 1) % opts.length].value : null;
      await _startStream(nextId, micSel?.value || null).catch(e => console.warn('flip', e));
    });

    document.getElementById('camZoom')?.addEventListener('input', async function () {
      const v = parseFloat(this.value);
      const zv = document.getElementById('camZoomVal'); if (zv) zv.textContent = v.toFixed(1) + '×';
      if (_zoomSupported && _videoTrack) {
        try { await _videoTrack.applyConstraints({ advanced: [{ zoom: v }] }); } catch {}
      } else {
        // Digitaler Zoom als CSS-Fallback
        const vid = document.getElementById('camVideo'); if (vid) vid.style.transform = `scale(${v})`;
      }
    });

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
      // Fallback: native Kamera-Input öffnen
      const inp = document.getElementById('photoInput');
      if (inp) inp.click();
    });
}
