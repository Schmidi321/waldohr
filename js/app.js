// Orchestrierung: verdrahtet Audio -> Erkennung -> Speicher -> UI.
import { AudioEngine, enhanceSamples, enhanceBlob } from './audio.js';
import { createRecognizer, MockRecognizer, encodeWav } from './recognizer.js';
import { addDetection, allDetections, seedIfEmpty, computeStats, migrateGeo, cleanupFakeGeo, todayNearbyDetections, deleteByIds, clearAll, qualifyingDetections, addAttachment, allAttachments, latestAudioAttachmentsByKey, deleteAttachment } from './db.js';
import { initUI, renderAll, liveAdd, renderMap, setLivePos, registerRecording, unregisterRecording, clearRecordings, renderLive, showInfoToast, sharePhotoCard, updateRouteMap, openTimingModal, updatePeerMarker, getMicDeviceId } from './ui.js';
import { fetchWeather, fetchPhotoWeather, fetchTomorrowMorning, fetchMoonTimes, fetchTodayHours, weatherEmoji, weatherLabel, windDirLabel, moonPhase, moonPhaseLabel, uvLabel, moonCalendar, reverseGeocode } from './weather.js';
import { routeTracker } from './route.js';
import { checkAlarms, getFotoWecker, getDauerUeberwachung, getSunriseFull } from './alarm.js';
import { openCamera } from './camera.js';
import { initOrni } from './ornithologie.js';
import { exportBackup, importBackup } from './backup.js';
import { renderQR, scanQR, createOfferer, createAnswerer, waitForOpen, monitorQuality } from './pairing.js';
import * as locate from './locate.js';
import * as chat from './chat.js';
import * as session from './session.js';
import * as filetransfer from './filetransfer.js';
import * as hub from './peerhub.js';

// ---- In-App Lightbox für Fotos ----
function openPhotoLightbox(url) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center';
  const img = document.createElement('img');
  img.src = url;
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:6px';
  const close = document.createElement('button');
  close.innerHTML = '&times;';
  close.style.cssText = 'position:absolute;top:max(16px,env(safe-area-inset-top));right:16px;background:rgba(0,0,0,.6);border:none;color:#fff;font-size:28px;line-height:1;width:40px;height:40px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center';
  const dismiss = () => { ov.remove(); try { document.removeEventListener('keydown', onKey); } catch {} };
  const onKey = e => { if (e.key === 'Escape') dismiss(); };
  close.onclick = dismiss;
  ov.onclick = e => { if (e.target === ov) dismiss(); };
  document.addEventListener('keydown', onKey);
  ov.append(img, close);
  document.body.appendChild(ov);
}

// ---- Dauerüberwachung Timer ----
let _duTimeout = null, _duInterval = null;
function startDauerUeberwachung() {
  stopDauerUeberwachung();
  const du = getDauerUeberwachung();
  if (!du.enabled) return;
  const ms = du.durationMin * 60 * 1000;
  const end = Date.now() + ms;
  _duInterval = setInterval(() => {
    const rem = Math.max(0, Math.ceil((end - Date.now()) / 60000));
    if (audio.running) setUI('mic', 'Lauscht… noch ' + rem + ' Min');
  }, 30000);
  _duTimeout = setTimeout(() => {
    stopDauerUeberwachung();
    showInfoToast('⏱ Dauerüberwachung', 'Zeitlimit erreicht — Lauschen gestoppt.', '⏱');
    if (audio.running) { audio.stop(); detectionActive = false; setUI('off'); stopSession(); }
  }, ms);
}
function stopDauerUeberwachung() {
  if (_duTimeout) { clearTimeout(_duTimeout); _duTimeout = null; }
  if (_duInterval) { clearInterval(_duInterval); _duInterval = null; }
}

let alarmCtx = null;
function warmAlarmCtx() {
  if (!alarmCtx || alarmCtx.state === 'closed') {
    try { alarmCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  } else if (alarmCtx.state === 'suspended') {
    alarmCtx.resume().catch(() => {});
  }
}
async function playFotoAlarm(vibrateOnly) {
  try { if ('vibrate' in navigator) navigator.vibrate([400, 200, 400, 200, 800, 200, 1200]); } catch {}
  if (vibrateOnly) return;
  warmAlarmCtx();
  if (!alarmCtx) return;
  try {
    if (alarmCtx.state === 'suspended') await alarmCtx.resume();
    const t = alarmCtx.currentTime;
    // C5→E5→G5→C6, zweimal wiederholt
    [[523.25,0],[659.25,.28],[783.99,.56],[1046.5,.84],[523.25,1.5],[659.25,1.78],[783.99,2.06],[1046.5,2.34]].forEach(([freq, delay]) => {
      const osc = alarmCtx.createOscillator();
      const gain = alarmCtx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + delay);
      gain.gain.linearRampToValueAtTime(0.32, t + delay + 0.03);
      gain.gain.linearRampToValueAtTime(0, t + delay + 0.22);
      osc.connect(gain); gain.connect(alarmCtx.destination);
      osc.start(t + delay); osc.stop(t + delay + 0.25);
    });
  } catch (e) { console.warn('alarm audio', e); }
}

const body = document.body;
const statusTxt = document.getElementById('statusTxt');

const audio = new AudioEngine();
let rec = null;
let detectionActive = false;

// Chip bleibt bewusst knapp ("GPS") — der volle Status (Genauigkeit, "verweigert" etc.)
// steckt im title-Tooltip, die Farbe signalisiert den Zustand auf einen Blick.
const locChip = document.getElementById('locChip');
const setLoc = (state, detail) => {
  const el = document.getElementById('locTxt'); if (el) el.textContent = 'GPS';
  if (locChip) { locChip.className = 'chip loc-' + state; locChip.title = detail || ''; }
};

// Standort-Erfassung: läuft unabhängig vom Mikro, sobald die App startet (nicht erst beim
// Lauschen) — Karte & Kompass-Richtung sollen auch ohne aktives Mikro die Position kennen.
const geo = {
  watchId: null, pos: null,
  start() {
    if (!('geolocation' in navigator)) { setLoc('off', 'kein GPS'); return; }
    if (this.watchId != null) return;
    setLoc('searching', 'Standort: suche…');
    this.watchId = navigator.geolocation.watchPosition(
      p => {
        const had = !!this.pos;
        this.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        setLoc('active', 'Standort ±' + Math.round(p.coords.accuracy) + ' m');
        setLivePos(this.pos);   // live fürs Kompass-Feature, ohne vollen Re-Render
        if (!had) refresh();   // erster Fix: "Heute hier" sofort aktualisieren
      },
      e => { console.warn('geo', e); setLoc('off', e.code === 1 ? 'GPS verweigert' : 'kein GPS'); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 }
    );
  },
  stop() { if (this.watchId != null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; } setLoc('off', 'Standort aus'); }
};

// Beim Veröffentlichen mit der SW-Cache-Version (sw.js) gleich halten.
const APP_VERSION = 'v91';
function wireSplash() {
  const splash = document.getElementById('splash');
  const btn = document.getElementById('splashContinue');
  if (!splash) return;
  const ver = document.getElementById('splashVer');
  if (ver) ver.textContent = APP_VERSION;
  const hide = () => splash.classList.add('hide');
  if (btn) {
    setTimeout(() => btn.classList.add('show'), 2000);
    btn.addEventListener('click', () => {
      navigator.geolocation.getCurrentPosition(() => {}, () => {});
      navigator.mediaDevices.getUserMedia({ audio: true }).then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
      hide();
    }, { once: true });
  } else {
    setTimeout(hide, 3000);
  }
}

async function boot() {
  initUI();
  initOrni();
  routeTracker.init(geo);
  routeTracker.onUpdate = pts => updateRouteMap(pts);
  try { await seedIfEmpty(); } catch (e) { console.warn('seed', e); }
  try { await migrateGeo(); } catch (e) { console.warn('migrateGeo', e); }
  try { const n = await cleanupFakeGeo(); if (n) console.info(n + ' Fund(e) hatten eine falsche Fake-Position (Bug) — Koordinaten entfernt.'); } catch (e) { console.warn('cleanupFakeGeo', e); }
  await refresh();
  hydrateAttachments();
  geo.start();
  checkAlarms(geo.pos?.lat, geo.pos?.lng, onAlarm);
  setInterval(() => checkAlarms(geo.pos?.lat, geo.pos?.lng, onAlarm), 60000);

  rec = await createRecognizer();
  if (rec.id === 'birdnet') statusTxt.textContent = 'BirdNET-Modell wird geladen…';
  else if (rec.id === 'birdnet-server') statusTxt.textContent = 'Verbinde mit BirdNET-Server…';
  try { await rec.load(); }
  catch (e) { console.warn('Recognizer-Fallback auf Mock:', e); rec = new MockRecognizer(); await rec.load(); }
  updateServerStatusChip();

  audio.onWindow = onWindow;
  setUI('off');
  startSpectrogram();
  registerSW();

  wireSplash();
}

// Während der Nutzer gerade mit dem Finger auf dem Bildschirm scrollt, NICHT die Listen/Karten
// neu aufbauen — sonst wird das gerade berührte DOM-Element ersetzt und die Wischgeste bricht ab
// (spürbar v. a. auf der Statistik-Seite, die bei jeder neuen Erkennung sonst sofort neu rendert).
let touching = false, pendingRefresh = false;
document.addEventListener('touchstart', () => { touching = true; }, { passive: true });
document.addEventListener('touchend', () => { touching = false; if (pendingRefresh) { pendingRefresh = false; refresh(); } }, { passive: true });
document.addEventListener('touchcancel', () => { touching = false; }, { passive: true });

async function refresh() {
  if (touching) { pendingRefresh = true; return; }
  let dets = [];
  try { dets = await allDetections(); } catch (e) { console.warn('read', e); }
  // Statistik, Sammlung & Karte zeigen nur Funde ab 75% Konfidenz (Rauschen raus).
  const qualifying = qualifyingDetections(dets);
  renderAll(computeStats(qualifying), qualifying, geo.pos);
  renderMap(qualifying);
}

// Kompass-Heading: passiv mithören — auf iOS greift das erst nach der Kompass-Freigabe im Detail-Sheet.
let compassHeading = null;
(function() {
  const ev = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(ev, e => {
    if (typeof e.webkitCompassHeading === 'number') compassHeading = Math.round(e.webkitCompassHeading);
    else if (e.absolute && typeof e.alpha === 'number') compassHeading = Math.round((360 - e.alpha) % 360);
  }, { passive: true });
})();

function onAlarm(type) {
  if (type === 'fotowecker') {
    showInfoToast('📷 Fotografen-Wecker', 'Zeit fürs Sonnenaufgang-Shooting! Viel Licht!', '📷');
    playFotoAlarm(getFotoWecker().vibrateOnly);
    return;
  }
  if (type === 'nacht-end') {
    showInfoToast('🦉 Nacht-Modus beendet', 'Geplante Endzeit erreicht — Lauschen gestoppt.', '🦉');
    if (audio.running) { stopDauerUeberwachung(); audio.stop(); detectionActive = false; setUI('off'); stopSession(); }
    return;
  }
  const isMC = type === 'morgenchor';
  const icon = isMC ? '🌅' : '🦉';
  const title = isMC ? '🌅 Morgenchor-Alarm' : '🦉 Nacht-Modus';
  showInfoToast(title, isMC ? 'Sonnenaufgang naht — Lauschen gestartet!' : 'Geplante Zeit — Lauschen gestartet!', icon);
  if (!audio.running) {
    tryFullscreen();
    audio.start(getMicDeviceId())
      .then(() => { geo.start(); detectionActive = true; setUI('mic'); if (recBtn) recBtn.classList.add('rec-on'); routeTracker.start(); updateRouteToggleBtn(true); startDauerUeberwachung(); })
      .catch(e => {
        console.warn('alarm mic', e);
        showInfoToast(title, 'Mikrofon-Freigabe nötig — tippe zum Starten.', icon, () => toggleDetection(), 'Lauschen starten');
      });
  }
}

// BirdNET-Server-Verbindungsstatus (nur relevant im Server-Modus — Mock/On-Device brauchen kein
// Netzwerk und bleiben unsichtbar). Der Server-Modus hat anders als die anderen KEINEN robusten
// Fallback zur Laufzeit (nur einmal beim Start geprüft), darum hier bei jedem Erkennungsversuch
// neu bewertet — sonst merkt der Nutzer eine wegbrechende Verbindung (WLAN, Server down) nicht,
// außer dass plötzlich keine Funde mehr kommen.
function updateServerStatusChip() {
  const chip = document.getElementById('serverStatusChip');
  if (!chip) return;
  if (!rec || rec.id !== 'birdnet-server') { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.remove('loc-active', 'loc-searching', 'srv-err');
  if (rec.status === 'ok') { chip.classList.add('loc-active'); chip.title = 'BirdNET-Server verbunden'; }
  else if (rec.status === 'error') { chip.classList.add('srv-err'); chip.title = 'BirdNET-Server nicht erreichbar — Verbindung/Empfang prüfen'; }
  else { chip.classList.add('loc-searching'); chip.title = 'Verbinde mit BirdNET-Server…'; }
}

async function onWindow(samples, sampleRate) {
  if (!rec || !detectionActive) return;
  if (rec.setGeo) rec.setGeo(geo.pos);   // Standort für bessere Treffer (Server-Modus)
  let r = null;
  try { r = await rec.classify(samples, sampleRate); } catch (e) { console.warn('classify', e); }
  updateServerStatusChip();
  if (!r) return;
  const det = {
    key: r.key, species: r.name, sci: r.sci, rarity: r.rarity, confidence: r.confidence,
    ts: Date.now(), source: r.source || 'mic'
  };
  if (geo.pos) { det.lat = geo.pos.lat; det.lng = geo.pos.lng; }
  if (compassHeading !== null) det.heading = compassHeading;
  try { const w = await fetchWeather(geo.pos?.lat, geo.pos?.lng); if (w) det.weather = w; } catch {}
  try { det.id = await addDetection(det); } catch (e) { console.warn('store', e); }
  liveAdd(det);
  maybeAutoRecord(det, samples, sampleRate);
  if (locate.isActive()) {
    if (geo.pos) locate.setLocalPos(geo.pos);
    locate.reportDetection(det);
  }
  refresh();
}

// ---- Automatische Aufnahme: ab einer einstellbaren Konfidenz (Default 85 %) wird der gerade
// klassifizierte Ausschnitt direkt als WAV gespeichert — aber nur einmal pro Art und Kalendertag,
// gegen Datenflut bei häufigen Arten. Tagesliste in localStorage, damit es auch über einen Reload
// hinweg gilt.
function getAutoRecordConfidence() {
  try { const v = parseFloat(localStorage.getItem('waldohr.autoRecConf')); return isNaN(v) ? 0.85 : v; }
  catch { return 0.85; }
}
function getAutoRecordDuration() {
  try { const v = parseInt(localStorage.getItem('waldohr.autoRecDur'), 10); return [3, 5, 10].includes(v) ? v : 3; }
  catch { return 3; }
}
const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
function autoRecordedToday() {
  try { return JSON.parse(localStorage.getItem('waldohr.autorec.' + todayKey()) || '[]'); } catch { return []; }
}
function markAutoRecorded(key) {
  try {
    const list = autoRecordedToday();
    if (!list.includes(key)) { list.push(key); localStorage.setItem('waldohr.autorec.' + todayKey(), JSON.stringify(list)); }
  } catch {}
}

function _makeAudioIcon(audioEl) {
  const el = document.createElement('div'); el.className = 'rec-media-icon'; el.style.cursor = 'pointer';
  el.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="22" height="22"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg><svg viewBox="0 0 8 6" fill="currentColor" width="8" height="6" style="margin-top:3px;opacity:.55"><path d="M0 0l8 3-8 3z"/></svg><span class="_aDur" style="font-size:9px;color:var(--faint);font-variant-numeric:tabular-nums;line-height:1.3;margin-top:2px;display:block;text-align:center"></span></div>';
  if (audioEl) {
    const ds = el.querySelector('._aDur');
    audioEl.addEventListener('loadedmetadata', () => { const s = Math.floor(audioEl.duration); if (isFinite(s) && s > 0 && ds) ds.textContent = Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }, { once: true });
  }
  el.onclick = () => {
    const row = el.closest('.rec-row');
    const a = row?.querySelector('audio');
    if (!a) return;
    _openAudioPlayerModal(a, row);
  };
  return el;
}

function _openAudioPlayerModal(audioEl, row) {
  window.__waldohrSuspendMicForPlayback?.();
  const label = row?.querySelector('.rec-label')?.textContent || 'Aufnahme';
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:250;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;background:rgba(2,8,6,.75);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)';
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:relative;width:100%;max-width:480px;background:linear-gradient(160deg,#0a2518,#061a0f);border-radius:24px 24px 0 0;border-top:1px solid var(--stroke);padding:16px 20px calc(30px + env(safe-area-inset-bottom))';
  const fmtT = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  sheet.innerHTML = `
    <div style="width:36px;height:4px;border-radius:4px;background:var(--stroke-strong);margin:0 auto 14px"></div>
    <div style="text-align:center;font-size:14px;font-weight:700;color:var(--ink);margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
    <canvas id="_apWave" style="width:100%;height:64px;border-radius:12px;background:rgba(163,230,53,.04);border:1px solid var(--stroke);display:block;margin-bottom:10px;cursor:pointer"></canvas>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:14px;font-variant-numeric:tabular-nums">
      <span id="_apCur">0:00</span><span id="_apDur">–:––</span>
    </div>
    <div style="display:flex;justify-content:center">
      <button id="_apPlay" style="width:56px;height:56px;border-radius:50%;background:var(--lime);border:none;color:#04130d;display:flex;align-items:center;justify-content:center;cursor:pointer">
        <svg viewBox="0 0 24 24" fill="#04130d" width="22" height="22"><path d="M8 5v14l11-7z"/></svg>
      </button>
    </div>
    <button id="_apClose" style="position:absolute;top:14px;right:14px;background:rgba(0,0,0,.3);border:none;color:var(--muted);font-size:22px;line-height:1;width:34px;height:34px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center">&times;</button>`;
  ov.appendChild(sheet);
  document.body.appendChild(ov);
  const wvCv = document.getElementById('_apWave');
  const curEl = document.getElementById('_apCur');
  const durEl = document.getElementById('_apDur');
  const playBtn = document.getElementById('_apPlay');
  const closeBtn = document.getElementById('_apClose');
  let peaks = null, _rafId = null;
  const playIcon = '<svg viewBox="0 0 24 24" fill="#04130d" width="22" height="22"><path d="M8 5v14l11-7z"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 24 24" fill="#04130d" width="20" height="20"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  function drawWave(pos) {
    const dpr = window.devicePixelRatio || 1;
    const W = wvCv.offsetWidth * dpr, H = 64 * dpr;
    if (wvCv.width !== W) { wvCv.width = W; wvCv.height = H; }
    const ctx = wvCv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!peaks) return;
    const bars = Math.floor(W / 3);
    for (let i = 0; i < bars; i++) {
      const pi = Math.floor(i / bars * peaks.length);
      const v = peaks[pi] || 0;
      const bh = Math.max(2, v * H * 0.82);
      const x = i * (W / bars);
      ctx.fillStyle = i / bars < pos ? 'rgba(163,230,53,.85)' : 'rgba(163,230,53,.22)';
      ctx.fillRect(x, (H - bh) / 2, Math.max(1, W / bars - 1), bh);
    }
    const cx = pos * W;
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.fillRect(cx - 1, 0, 2, H);
  }
  function tick() {
    if (audioEl.paused) return;
    const pos = audioEl.currentTime / (audioEl.duration || 1);
    drawWave(pos);
    curEl.textContent = fmtT(audioEl.currentTime);
    _rafId = requestAnimationFrame(tick);
  }
  // Decode for waveform
  fetch(audioEl.src).then(r => r.arrayBuffer()).then(ab => {
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    return tmp.decodeAudioData(ab).then(buf => { tmp.close().catch(() => {}); return buf; });
  }).then(buf => {
    durEl.textContent = fmtT(buf.duration);
    const ch = buf.getChannelData(0), n = 200, bs = Math.floor(ch.length / n);
    peaks = [];
    for (let i = 0; i < n; i++) {
      let mx = 0;
      for (let j = 0; j < bs; j++) { const v = Math.abs(ch[i * bs + j]); if (v > mx) mx = v; }
      peaks.push(mx);
    }
    const mx = Math.max(...peaks, 0.01);
    peaks = peaks.map(p => p / mx);
    drawWave(audioEl.paused ? audioEl.currentTime / (buf.duration || 1) : 0);
  }).catch(() => {});
  if (audioEl.readyState >= 1) durEl.textContent = fmtT(audioEl.duration);
  else audioEl.addEventListener('loadedmetadata', () => { durEl.textContent = fmtT(audioEl.duration); }, { once: true });
  playBtn.onclick = () => {
    if (audioEl.paused) {
      audioEl.play().catch(() => {});
      playBtn.innerHTML = pauseIcon;
      _rafId = requestAnimationFrame(tick);
    } else {
      audioEl.pause();
      playBtn.innerHTML = playIcon;
      cancelAnimationFrame(_rafId); _rafId = null;
      drawWave(audioEl.currentTime / (audioEl.duration || 1));
    }
  };
  audioEl.addEventListener('ended', () => {
    playBtn.innerHTML = playIcon;
    cancelAnimationFrame(_rafId); _rafId = null;
    drawWave(1);
    window.__waldohrResumeMicAfterPlayback?.();
  }, { once: true });
  wvCv.addEventListener('click', e => {
    const pos = (e.clientX - wvCv.getBoundingClientRect().left) / wvCv.offsetWidth;
    audioEl.currentTime = pos * audioEl.duration;
    drawWave(pos); curEl.textContent = fmtT(audioEl.currentTime);
  });
  const dismiss = () => {
    audioEl.pause();
    cancelAnimationFrame(_rafId); _rafId = null;
    ov.remove();
    window.__waldohrResumeMicAfterPlayback?.();
  };
  closeBtn.onclick = dismiss;
  ov.addEventListener('click', e => { if (e.target === ov) dismiss(); });
}

async function _saveAutoRecRow(det, blob, mime) {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = det.species.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const gpsTag = geo.pos ? '_' + geo.pos.lat.toFixed(4) + '_' + geo.pos.lng.toFixed(4) : '';
  const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'm4a' : 'webm';
  const url = URL.createObjectURL(blob);
  const row = document.createElement('div'); row.className = 'rec-row';
  const a = document.createElement('audio'); a.src = url; a.preload = 'metadata'; a.hidden = true;
  wireAudioRouting(a);
  const lb = document.createElement('span'); lb.className = 'rec-label auto'; lb.textContent = det.species + ' · auto';
  const dl = makeDownloadBtn(url, prefix + '_' + stamp + gpsTag + '.' + ext, det.species);
  let attId = null;
  try { attId = await addAttachment({ detId: det.id ?? null, key: det.key, label: det.species, kind: 'audio', blob, mime }); }
  catch (e) { console.warn('addAttachment', e); }
  const del = makeDeleteBtn(row, url, det.key, attId);
  row.append(_makeAudioIcon(a), lb, _spacer(), dl, _makeScissorsBtn(row), del, a);
  const list = document.getElementById('recList'); if (list) list.prepend(row);
  registerRecording(det.key, url);
  if (!galleryModal || !galleryModal.classList.contains('open')) galleryBadgeAdd(1);
}

async function maybeAutoRecord(det, samples, sampleRate) {
  if (det.confidence < getAutoRecordConfidence()) return;
  if (autoRecordedToday().includes(det.key)) return;
  markAutoRecorded(det.key);
  const dur = getAutoRecordDuration();
  const gpsStr = geo.pos ? geo.pos.lat.toFixed(5) + ',' + geo.pos.lng.toFixed(5) : '';

  if (dur > 3 && audio.stream) {
    let mime = '';
    for (const t of ['audio/webm;codecs=opus', 'audio/webm']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
    }
    const chunks = [];
    let mr;
    try { mr = mime ? new MediaRecorder(audio.stream, { mimeType: mime }) : new MediaRecorder(audio.stream); } catch {}
    if (mr) {
      mr.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
      mr.onstop = async () => {
        const raw = new Blob(chunks, { type: mime || 'audio/webm' });
        try {
          const { samples: s2, sampleRate: sr2 } = await enhanceBlob(raw);
          const wavBlob = encodeWav(s2, sr2, { name: det.species, comment: gpsStr || undefined });
          await _saveAutoRecRow(det, wavBlob, 'audio/wav');
        } catch { await _saveAutoRecRow(det, raw, mime || 'audio/webm'); }
      };
      mr.start();
      setTimeout(() => { try { if (mr.state === 'recording') mr.stop(); } catch {} }, dur * 1000);
      return;
    }
  }

  let enhanced = samples;
  try { enhanced = await enhanceSamples(samples, sampleRate); } catch (e) { console.warn('enhance', e); }
  const blob = encodeWav(enhanced, sampleRate, {
    name: det.species,
    date: new Date().toISOString().slice(0, 10) + ' ' + new Date().toLocaleTimeString('de-DE'),
    comment: gpsStr || undefined
  });
  await _saveAutoRecRow(det, blob, 'audio/wav');
}

// ---- Herunterladen-Sheet: styled bottom-sheet statt nativer Browser-Dialog ----
function openDownloadSheet(url, filename, label) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:150;display:flex;flex-direction:column;justify-content:flex-end';
  const scrim = document.createElement('div');
  scrim.style.cssText = 'position:absolute;inset:0;background:rgba(2,8,6,.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)';
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:relative;z-index:1;width:100%;max-width:480px;margin:0 auto;background:linear-gradient(160deg,#0a2518,#061a0f);border-radius:24px 24px 0 0;border-top:1px solid var(--stroke);padding:0 20px calc(24px + env(safe-area-inset-bottom))';
  const ext = (filename.split('.').pop() || '').toUpperCase();
  const ico = /^(JPG|JPEG|PNG|HEIC)$/.test(ext) ? '🖼' : /^(WAV|M4A|MP3|OGG|WEBM)$/.test(ext) ? '🎵' : /^(MP4|MOV)$/.test(ext) ? '🎬' : '📄';
  sheet.innerHTML = `
    <div style="width:36px;height:4px;border-radius:4px;background:var(--stroke-strong);margin:12px auto 16px"></div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;padding:12px;background:var(--glass);border:1px solid var(--stroke);border-radius:16px">
      <div style="font-size:26px;width:40px;text-align:center;flex-shrink:0">${ico}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${filename}</div>
        ${label ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${label}</div>` : ''}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <a id="_dsDown" href="${url}" download="${filename}" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;background:#a3e635;color:#04130d;border-radius:16px;font-weight:700;font-size:15px;text-decoration:none;font-family:inherit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="17" height="17"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Herunterladen
      </a>
      <button id="_dsShare" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;background:var(--glass-strong);color:var(--ink);border:1px solid var(--stroke);border-radius:16px;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit;width:100%">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="17" height="17"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        Teilen
      </button>
      <button id="_dsCancel" style="padding:12px;background:transparent;color:var(--muted);border:none;font-size:14px;cursor:pointer;font-family:inherit;width:100%">Abbrechen</button>
    </div>`;
  const dismiss = () => ov.remove();
  scrim.onclick = dismiss;
  ov.append(scrim, sheet);
  document.body.appendChild(ov);
  sheet.querySelector('#_dsCancel').onclick = dismiss;
  sheet.querySelector('#_dsDown').onclick = () => setTimeout(dismiss, 350);
  const shareBtn = sheet.querySelector('#_dsShare');
  if (navigator.share) {
    shareBtn.onclick = async () => {
      try {
        const blob = await fetch(url).then(r => r.blob());
        await navigator.share({ files: [new File([blob], filename, { type: blob.type })], title: label || 'WaldOhr' });
        dismiss();
      } catch (e) { if (e?.name !== 'AbortError') console.warn('share', e); }
    };
  } else {
    shareBtn.style.display = 'none';
  }
}

function makeDownloadBtn(url, filename, label) {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'rec-dl'; btn.title = 'Herunterladen';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  btn.onclick = ev => { ev.stopPropagation(); openDownloadSheet(url, filename, label); };
  return btn;
}

// Löschen-Button für eine Aufnahme/Foto-Zeile: entfernt die Zeile, gibt die Object-URL frei,
// löscht das kleine Abspiel-Badge auf der Sammlungskarte (falls verknüpft) und den dauerhaft
// gespeicherten Anhang in der Datenbank.
function makeDeleteBtn(row, url, key, attId) {
  const del = document.createElement('button');
  del.className = 'rec-del'; del.type = 'button'; del.title = 'Löschen';
  del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>';
  del.onclick = ev => {
    ev.stopPropagation();
    row.remove();
    try { URL.revokeObjectURL(url); } catch {}
    if (key) unregisterRecording(key);
    if (attId != null) deleteAttachment(attId).catch(e => console.warn('deleteAttachment', e));
  };
  return del;
}

function _makeScissorsBtn(row) {
  const btn = document.createElement('button');
  btn.className = 'rec-dl'; btn.title = 'Zuschneiden';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/></svg>';
  btn.onclick = () => _toggleTrimPanel(row);
  return btn;
}

async function _toggleTrimPanel(row) {
  const existing = row.querySelector('.rec-trim-panel');
  if (existing) {
    const a = row.querySelector('audio'); if (a) a.pause();
    existing.remove(); return;
  }
  const audioEl = row.querySelector('audio');
  if (!audioEl?.src) return;
  const panel = document.createElement('div'); panel.className = 'rec-trim-panel';
  panel.innerHTML = '<span class="tr-lbl">Lade…</span>';
  row.appendChild(panel);
  let decoded;
  try {
    const ab = await fetch(audioEl.src).then(r => r.arrayBuffer());
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    decoded = await new Promise((res, rej) => tmp.decodeAudioData(ab, res, rej));
    tmp.close().catch(() => {});
  } catch { panel.innerHTML = '<span class="tr-lbl" style="color:var(--rose)">Fehler</span>'; return; }
  const dur = decoded.duration;
  let startFrac = 0, endFrac = 1;
  panel.innerHTML = `<div class="tr-tl-wrap"><div class="tr-tl"><div class="tr-kept"></div><div class="tr-pos"></div><div class="tr-handle tr-hs"></div><div class="tr-handle tr-he"></div></div></div><div class="tr-times"><span class="tr-val tr-sv">0.0s</span><span class="tr-curtime"></span><span class="tr-val tr-ev">${dur.toFixed(1)}s</span></div><div style="display:flex;gap:6px;flex:0 0 100%;margin-top:4px"><button class="tr-play">&#9654;</button><button class="tr-go" style="flex:1">&#9986; Zuschneiden</button></div>`;
  const tl = panel.querySelector('.tr-tl');
  const kept = panel.querySelector('.tr-kept');
  const posEl = panel.querySelector('.tr-pos');
  const hs = panel.querySelector('.tr-hs');
  const he = panel.querySelector('.tr-he');
  const sv = panel.querySelector('.tr-sv');
  const ev = panel.querySelector('.tr-ev');
  const curTime = panel.querySelector('.tr-curtime');
  const playBtn = panel.querySelector('.tr-play');
  let _playRaf = null;
  function updateUI() {
    hs.style.left = (startFrac * 100) + '%';
    he.style.left = (endFrac * 100) + '%';
    kept.style.left = (startFrac * 100) + '%';
    kept.style.width = ((endFrac - startFrac) * 100) + '%';
    sv.textContent = (startFrac * dur).toFixed(1) + 's';
    ev.textContent = (endFrac * dur).toFixed(1) + 's';
  }
  updateUI();
  function _stopPreview() {
    if (_playRaf) { cancelAnimationFrame(_playRaf); _playRaf = null; }
    posEl.style.display = 'none';
    playBtn.innerHTML = '&#9654;';
  }
  function _tickPreview() {
    const ct = audioEl.currentTime;
    posEl.style.left = (dur > 0 ? ct / dur * 100 : 0) + '%';
    posEl.style.display = 'block';
    if (curTime) curTime.textContent = ct.toFixed(1) + 's';
    if (!audioEl.paused && ct < endFrac * dur - 0.05) {
      _playRaf = requestAnimationFrame(_tickPreview);
    } else {
      if (ct >= endFrac * dur - 0.05) { audioEl.pause(); audioEl.currentTime = startFrac * dur; }
      _stopPreview();
    }
  }
  playBtn.addEventListener('click', () => {
    if (!audioEl.paused) { audioEl.pause(); _stopPreview(); return; }
    audioEl.currentTime = startFrac * dur;
    audioEl.play().catch(() => {});
    playBtn.innerHTML = '&#9646;&#9646;';
    _playRaf = requestAnimationFrame(_tickPreview);
  });
  audioEl.addEventListener('ended', _stopPreview);
  function makeDrag(handle, isStart) {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const mv = e2 => {
        const rect = tl.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
        if (isStart) startFrac = Math.min(frac, endFrac - 0.02);
        else endFrac = Math.max(frac, startFrac + 0.02);
        updateUI();
      };
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', () => handle.removeEventListener('pointermove', mv), { once: true });
    });
  }
  makeDrag(hs, true);
  makeDrag(he, false);
  panel.querySelector('.tr-go').onclick = async () => {
    audioEl.pause(); _stopPreview();
    const start = startFrac * dur;
    const end = endFrac * dur;
    if (start >= end) return;
    const sr = decoded.sampleRate;
    const trimmed = decoded.getChannelData(0).slice(Math.floor(start * sr), Math.floor(end * sr));
    const wav = encodeWav(trimmed, sr);
    const newUrl = URL.createObjectURL(wav);
    if (audioEl.src.startsWith('blob:')) URL.revokeObjectURL(audioEl.src);
    audioEl.src = newUrl; audioEl.load();
    panel.remove();
  };
}

// ---- Video-Lightbox ----
function openVideoLightbox(url) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.95);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px';
  const vid = document.createElement('video');
  vid.src = url; vid.controls = true; vid.autoplay = true;
  vid.style.cssText = 'max-width:100%;max-height:calc(100vh - 80px);border-radius:8px';
  const close = document.createElement('button');
  close.innerHTML = '&times;';
  close.style.cssText = 'position:absolute;top:max(16px,env(safe-area-inset-top));right:16px;background:rgba(0,0,0,.6);border:none;color:#fff;font-size:28px;line-height:1;width:40px;height:40px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center';
  const dismiss = () => { vid.pause(); ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') dismiss(); };
  close.onclick = dismiss;
  ov.onclick = e => { if (e.target === ov) dismiss(); };
  document.addEventListener('keydown', onKey);
  ov.append(vid, close);
  document.body.appendChild(ov);
}

// ---- Video-Vorschaubild (56×56 Thumbnail + Play-Icon) ----
function _makeVideoThumb(url) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:0 0 56px;width:56px;height:56px;border-radius:11px;overflow:hidden;position:relative;background:#04130d;cursor:pointer;flex-shrink:0';
  const vid = document.createElement('video');
  vid.src = url; vid.preload = 'metadata'; vid.muted = true;
  vid.style.cssText = 'width:56px;height:56px;object-fit:cover;display:block';
  vid.onloadedmetadata = () => { try { vid.currentTime = 0.15; } catch {} };
  const ply = document.createElement('div');
  ply.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none';
  ply.innerHTML = '<div style="width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" fill="white" width="11" height="11"><path d="M8 5v14l11-7z"/></svg></div>';
  wrap.append(vid, ply);
  return wrap;
}

// ---- Spacer: schiebt Icons nach rechts ----
function _spacer() { const s = document.createElement('span'); s.style.flex = '1'; return s; }

// ---- Foto+Audio Mixer: Photo + Tonaufnahme → Video rendern (client-side, kein Server) ----
async function _renderPhotoAudioVideo(photoBlob, audioBlob, onProgress) {
  const W = 1440, H = 1440;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // Foto zeichnen (object-fit: cover, zentriert)
  const pUrl = URL.createObjectURL(photoBlob);
  await new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const ir = img.width / img.height, cr = W / H;
      let sw, sh, sx, sy;
      if (ir > cr) { sh = img.height; sw = sh * cr; sx = (img.width - sw) / 2; sy = 0; }
      else { sw = img.width; sh = sw / cr; sx = 0; sy = (img.height - sh) / 2; }
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
      URL.revokeObjectURL(pUrl); res();
    };
    img.onerror = () => { URL.revokeObjectURL(pUrl); rej(new Error('Foto konnte nicht geladen werden')); };
    img.src = pUrl;
  });

  // WaldOhr-Branding-Overlay unten
  const ov = ctx.createLinearGradient(0, H - 220, 0, H);
  ov.addColorStop(0, 'rgba(6,26,15,0)'); ov.addColorStop(1, 'rgba(6,26,15,.88)');
  ctx.fillStyle = ov; ctx.fillRect(0, H - 220, W, 220);
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 24;
  ctx.fillStyle = 'rgba(163,230,53,.97)'; ctx.font = '700 82px system-ui,sans-serif';
  ctx.fillText('🌿 WaldOhr', W / 2, H - 98);
  ctx.shadowBlur = 12;
  ctx.fillStyle = 'rgba(255,255,255,.65)'; ctx.font = '500 34px system-ui,sans-serif';
  ctx.fillText(new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }), W / 2, H - 44);
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

  // Audio dekodieren
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const arrBuf = await audioBlob.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrBuf);
  const duration = audioBuffer.duration;

  const dest = audioCtx.createMediaStreamDestination();
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(dest);

  // Canvas-Stream + Audio-Track zusammenführen
  const videoStream = cv.captureStream(2);
  const combined = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);

  let mime = '';
  for (const t of ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
  }

  return new Promise((res, rej) => {
    const mr = mime ? new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 8_000_000 }) : new MediaRecorder(combined);
    const chunks = [];
    mr.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
    mr.onstop = () => {
      clearInterval(progTimer);
      try { audioCtx.close(); } catch {}
      res({ blob: new Blob(chunks, { type: mime || 'video/webm' }), mime: mime || 'video/webm', duration });
    };
    mr.onerror = e => { clearInterval(progTimer); rej(e); };

    const t0 = Date.now();
    const progTimer = setInterval(() => {
      const pct = Math.min(95, Math.round((Date.now() - t0) / 1000 / duration * 100));
      if (onProgress) onProgress(pct);
    }, 300);

    src.start(0);
    mr.start();
    setTimeout(() => { try { mr.stop(); } catch {} try { src.stop(); } catch {} }, duration * 1000 + 400);
  });
}

async function openShareMixer(photoUrl, key, label) {
  const modal = document.getElementById('mixerModal');
  if (!modal) {
    try { await sharePhotoCard(photoUrl, key, label, geo.pos); } catch (e) { if (e?.name !== 'AbortError') console.warn('share', e); }
    return;
  }
  modal._photoUrl = photoUrl; modal._key = key; modal._label = label;
  modal._selAudioBlob = null;

  const directBtn = document.getElementById('mixerDirectShare');
  const renderBtn = document.getElementById('mixerRenderBtn');
  const prog = document.getElementById('mixerProgress');
  const progFill = document.getElementById('mixerProgFill');
  const progLabel = document.getElementById('mixerProgLabel');

  // Zustand zurücksetzen
  if (renderBtn) { renderBtn.disabled = true; renderBtn.textContent = '🎬 Video rendern & teilen'; }
  if (prog) prog.hidden = true;
  if (directBtn) directBtn.disabled = false;

  // Direkt-Teilen
  if (directBtn) {
    directBtn.onclick = async () => {
      modal.hidden = true;
      try { await sharePhotoCard(photoUrl, key, label, geo.pos); } catch (e) { if (e?.name !== 'AbortError') console.warn('share', e); }
    };
  }

  // Audio-Liste laden
  const audioList = document.getElementById('mixerAudioList');
  if (audioList) {
    audioList.innerHTML = '<div style="color:var(--faint);font-size:12px;padding:10px 0">Lade Aufnahmen…</div>';
    try {
      const all = await allAttachments();
      const audios = all.filter(a => a.kind === 'audio');
      if (!audios.length) {
        audioList.innerHTML = '<div style="color:var(--faint);font-size:12px;padding:10px 0">Keine Tonaufnahmen vorhanden — zuerst über REC aufnehmen.</div>';
      } else {
        audioList.innerHTML = '';
        for (const att of audios) {
          const row = document.createElement('div');
          row.className = 'mixer-audio-row';
          const lbl = att.label || 'Aufnahme';
          const when = att.ts ? new Date(att.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
          row.innerHTML = `<span class="mr-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v4M8 23h8"/></svg></span><span class="mr-label">${lbl}</span><span class="mr-dur">${when}</span>`;
          row.onclick = () => {
            audioList.querySelectorAll('.mixer-audio-row').forEach(r => r.classList.remove('on'));
            row.classList.add('on');
            modal._selAudioBlob = att.blob;
            if (renderBtn) renderBtn.disabled = false;
          };
          audioList.appendChild(row);
        }
      }
    } catch (e) {
      console.warn('mixer load', e);
      audioList.innerHTML = '<div style="color:var(--faint);font-size:12px;padding:10px 0">Fehler beim Laden der Aufnahmen.</div>';
    }
  }

  // Render-Button
  if (renderBtn) {
    renderBtn.onclick = async () => {
      if (!modal._selAudioBlob) return;
      if (prog) prog.hidden = false;
      if (progFill) progFill.style.width = '0%';
      if (progLabel) progLabel.textContent = 'Foto wird geladen…';
      renderBtn.disabled = true;
      if (directBtn) directBtn.disabled = true;
      try {
        const photoBlob = await fetch(modal._photoUrl).then(r => r.blob());
        if (progLabel) progLabel.textContent = 'Audio wird dekodiert…';
        const { blob: vidBlob, mime } = await _renderPhotoAudioVideo(photoBlob, modal._selAudioBlob, pct => {
          if (progFill) progFill.style.width = pct + '%';
          if (progLabel) progLabel.textContent = 'Rendering… ' + pct + '%';
        });
        if (progFill) progFill.style.width = '100%';
        if (progLabel) progLabel.textContent = 'Fertig!';
        modal.hidden = true;

        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const fname = 'waldohr-' + stamp + '.' + ext;
        const file = new File([vidBlob], fname, { type: mime });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ title: 'WaldOhr – ' + (modal._label || 'Video'), files: [file] });
        } else {
          const a = document.createElement('a'); a.href = URL.createObjectURL(vidBlob);
          a.download = fname; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 8000);
        }
      } catch (e) {
        console.warn('mixer render', e);
        if (progLabel) progLabel.textContent = 'Fehler: ' + (e?.message || 'Rendering fehlgeschlagen');
        if (renderBtn) renderBtn.disabled = false;
        if (directBtn) directBtn.disabled = false;
      }
    };
  }

  // Scrim schließt Modal
  const scrim = document.getElementById('mixerScrim');
  if (scrim) scrim.onclick = () => { modal.hidden = true; };

  modal.hidden = false;
}

function makeReelBtn(url, mime) {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.title = 'Teilen / Reel'; btn.className = 'rec-dl'; btn.style.color = 'var(--muted)';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
  btn.onclick = ev => { ev.stopPropagation(); _openVideoReelModal(url, mime); };
  return btn;
}

function _openVideoReelModal(url, mime) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:250;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;background:rgba(0,0,0,.88)';
  const sheet = document.createElement('div');
  sheet.style.cssText = 'position:relative;width:100%;max-width:480px;background:linear-gradient(160deg,#0a1a12,#060f0a);border-radius:24px 24px 0 0;border-top:1px solid var(--stroke);padding:14px 16px calc(22px + env(safe-area-inset-bottom));max-height:92vh;overflow-y:auto;scrollbar-width:none';
  const fmtT = s => Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
  const playIco = '<svg viewBox="0 0 24 24" fill="#04130d" width="22" height="22"><path d="M8 5v14l11-7z"/></svg>';
  const pauseIco = '<svg viewBox="0 0 24 24" fill="#04130d" width="22" height="22"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  // iOS Safari (und manche WebViews) implementieren HTMLVideoElement.captureStream() nicht —
  // dort ist clientseitiges Neu-Encodieren (Trimmen/Mischen) technisch unmöglich. Statt eines
  // Fehlers beim Export erkennen wir das vorher und bieten Original-Teilen als Fallback an.
  const probeVid = document.createElement('video');
  const supportsCapture = typeof probeVid.captureStream === 'function' || typeof probeVid.mozCaptureStream === 'function';
  const unsupportedNote = supportsCapture ? '' : `<div style="background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);border-radius:12px;padding:10px 12px;font-size:12px;color:#fbbf24;margin-bottom:12px">⚠️ Dein Browser unterstützt kein Zuschneiden/Mischen von Videos. Du kannst das Original trotzdem teilen.</div>`;
  sheet.innerHTML = `
    <div style="width:36px;height:4px;border-radius:4px;background:var(--stroke-strong);margin:0 auto 12px"></div>
    <h3 style="font-size:16px;font-weight:700;margin:0 0 10px;text-align:center;color:var(--ink)">🎬 Reel erstellen</h3>
    <div style="position:relative;margin-bottom:8px">
      <video id="_rvVid" src="${url}" playsinline style="width:100%;border-radius:12px;max-height:200px;object-fit:contain;background:#000;display:block"></video>
      <button id="_rvPlay" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:54px;height:54px;border-radius:50%;background:rgba(163,230,53,.92);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.45)">${playIco}</button>
    </div>
    <div id="_rvDurInfo" style="text-align:center;font-size:11px;color:var(--muted);margin-bottom:8px">Lade Video…</div>
    <div id="_rvTrimWrap" style="position:relative;height:36px;background:rgba(163,230,53,.08);border-radius:10px;border:1px solid rgba(163,230,53,.2);margin-bottom:8px;touch-action:none">
      <div id="_rvKept" style="position:absolute;top:0;bottom:0;left:0;width:100%;background:rgba(163,230,53,.18);border-radius:10px"></div>
      <div id="_rvPos" style="position:absolute;top:0;bottom:0;width:2px;background:rgba(255,255,255,.85);display:none;z-index:3"></div>
      <div id="_rvHs" style="position:absolute;top:-3px;bottom:-3px;width:14px;left:0;margin-left:-7px;background:var(--lime);border-radius:5px;cursor:ew-resize;z-index:2;touch-action:none"></div>
      <div id="_rvHe" style="position:absolute;top:-3px;bottom:-3px;width:14px;right:0;margin-right:-7px;background:var(--lime);border-radius:5px;cursor:ew-resize;z-index:2;touch-action:none"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:12px;font-variant-numeric:tabular-nums">
      <span id="_rvSLbl">0:00</span><span id="_rvELbl">0:00</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span style="font-size:13px;color:var(--ink);white-space:nowrap">🔊 Originalton</span>
      <input type="range" id="_rvVol" min="0" max="100" value="100" style="flex:1;accent-color:var(--lime)">
      <span id="_rvVolLbl" style="font-size:12px;color:var(--muted);width:38px;text-align:right;font-variant-numeric:tabular-nums">100%</span>
    </div>
    <div style="font-size:13px;color:var(--ink);margin-bottom:6px">🎵 Tonaufnahme hinzufügen</div>
    <div id="_rvAudioList" style="max-height:150px;overflow-y:auto;margin-bottom:12px;scrollbar-width:none;display:flex;flex-direction:column;gap:6px">
      <div style="color:var(--faint);font-size:12px;padding:8px 0">Lade Aufnahmen…</div>
    </div>
    ${unsupportedNote}
    <button id="_rvExport" style="width:100%;padding:14px;border-radius:16px;background:var(--lime);color:#04130d;font-weight:700;font-size:15px;cursor:pointer;border:none;font-family:inherit;margin-bottom:6px">${supportsCapture ? '🎬 Reel exportieren' : '📤 Original teilen'}</button>
    <div id="_rvProgress" style="display:none;margin-bottom:8px">
      <div class="mixer-prog-track"><div id="_rvProgFill" class="mixer-prog-fill" style="width:0%"></div></div>
      <div id="_rvProgLabel" class="mixer-prog-label" style="margin-top:5px;text-align:center;font-size:12px;color:var(--muted)">Exportiere…</div>
    </div>
    <button id="_rvClose" style="width:100%;padding:11px;background:transparent;color:var(--muted);border:none;font-size:13px;cursor:pointer;font-family:inherit">Abbrechen</button>`;
  ov.appendChild(sheet);
  document.body.appendChild(ov);
  const vid = document.getElementById('_rvVid');
  const playBtn = document.getElementById('_rvPlay');
  const durInfo = document.getElementById('_rvDurInfo');
  const trimWrap = document.getElementById('_rvTrimWrap');
  const kept = document.getElementById('_rvKept');
  const posLine = document.getElementById('_rvPos');
  const hs = document.getElementById('_rvHs');
  const he = document.getElementById('_rvHe');
  const sLbl = document.getElementById('_rvSLbl');
  const eLbl = document.getElementById('_rvELbl');
  const volSlider = document.getElementById('_rvVol');
  const volLbl = document.getElementById('_rvVolLbl');
  const audioListEl = document.getElementById('_rvAudioList');
  const exportBtn = document.getElementById('_rvExport');
  const closeBtn = document.getElementById('_rvClose');
  const progress = document.getElementById('_rvProgress');
  const progFill = document.getElementById('_rvProgFill');
  const progLabel = document.getElementById('_rvProgLabel');
  let duration = 0, startFrac = 0, endFrac = 1, _vidRaf = null;
  let origVol = 1, selAudioBlob = null, selAudioBuffer = null;

  vid.volume = origVol;
  volSlider.addEventListener('input', () => {
    origVol = volSlider.value / 100;
    vid.volume = origVol;
    volLbl.textContent = volSlider.value + '%';
  });

  function updateTrim() {
    hs.style.left = (startFrac * 100) + '%';
    he.style.right = ((1 - endFrac) * 100) + '%';
    kept.style.left = (startFrac * 100) + '%';
    kept.style.width = ((endFrac - startFrac) * 100) + '%';
    sLbl.textContent = fmtT(startFrac * duration);
    eLbl.textContent = fmtT(endFrac * duration);
  }
  vid.addEventListener('loadedmetadata', () => {
    duration = vid.duration; durInfo.textContent = 'Dauer: ' + fmtT(duration); eLbl.textContent = fmtT(duration);
  }, { once: true });

  function curDur() { return duration || vid.duration || 0; }
  function setPlayIcon(playing) { playBtn.innerHTML = playing ? pauseIco : playIco; playBtn.style.opacity = playing ? '0' : '1'; }
  function togglePlay() {
    const dur = curDur();
    if (vid.paused) {
      if (vid.currentTime < startFrac * dur || vid.currentTime >= endFrac * dur - 0.02) vid.currentTime = startFrac * dur;
      vid.play().catch(() => {});
      setPlayIcon(true);
      if (!_vidRaf) _vidRaf = requestAnimationFrame(tickVid);
    } else { vid.pause(); setPlayIcon(false); }
  }
  // Sicherheitsnetz: stoppt zuverlässig am Trim-Ende, auch wenn der rAF gedrosselt wird
  vid.addEventListener('timeupdate', () => {
    const dur = curDur(); if (!dur || vid.paused) return;
    if (vid.currentTime >= endFrac * dur - 0.01) { vid.pause(); vid.currentTime = startFrac * dur; setPlayIcon(false); }
    else if (vid.currentTime < startFrac * dur - 0.05) { vid.currentTime = startFrac * dur; }
  });
  playBtn.addEventListener('click', togglePlay);
  vid.addEventListener('click', togglePlay);
  function tickVid() {
    const dur = curDur();
    if (vid.paused) { posLine.style.display = 'none'; _vidRaf = null; setPlayIcon(false); return; }
    if (dur && vid.currentTime >= endFrac * dur - 0.01) { vid.pause(); vid.currentTime = startFrac * dur; posLine.style.display = 'none'; _vidRaf = null; setPlayIcon(false); return; }
    const rel = dur ? (vid.currentTime / dur - startFrac) / Math.max(0.0001, (endFrac - startFrac)) : 0;
    posLine.style.left = Math.max(0, Math.min(100, rel * 100)) + '%'; posLine.style.display = 'block';
    _vidRaf = requestAnimationFrame(tickVid);
  }
  function makeDrag(handle, isStart) {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault(); handle.setPointerCapture(e.pointerId);
      if (!vid.paused) { vid.pause(); setPlayIcon(false); }
      const mv = e2 => {
        const rect = trimWrap.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (e2.clientX - rect.left) / rect.width));
        // Live-Vorschau: Videobild folgt dem gezogenen Griff direkt
        if (isStart) { startFrac = Math.min(f, endFrac - 0.02); vid.currentTime = startFrac * duration; }
        else { endFrac = Math.max(f, startFrac + 0.02); vid.currentTime = endFrac * duration; }
        updateTrim();
      };
      handle.addEventListener('pointermove', mv);
      handle.addEventListener('pointerup', () => handle.removeEventListener('pointermove', mv), { once: true });
    });
  }
  makeDrag(hs, true); makeDrag(he, false);

  // Tonaufnahmen zum Mitschneiden laden (gleiche Auswahl wie bei Fotos)
  (async () => {
    try {
      const all = await allAttachments();
      const audios = all.filter(a => a.kind === 'audio');
      audioListEl.innerHTML = '';
      const noneRow = document.createElement('div');
      noneRow.className = 'mixer-audio-row on';
      noneRow.innerHTML = '<span class="mr-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M3 3l18 18M9 9v3a3 3 0 0 0 4.5 2.6M12 4v2M15 6v.5"/></svg></span><span class="mr-label">Kein zusätzlicher Ton</span>';
      noneRow.onclick = () => {
        audioListEl.querySelectorAll('.mixer-audio-row').forEach(r => r.classList.remove('on'));
        noneRow.classList.add('on'); selAudioBlob = null; selAudioBuffer = null;
      };
      audioListEl.appendChild(noneRow);
      if (!audios.length) {
        const hint = document.createElement('div');
        hint.style.cssText = 'color:var(--faint);font-size:12px;padding:6px 0';
        hint.textContent = 'Keine Tonaufnahmen vorhanden — zuerst über REC aufnehmen.';
        audioListEl.appendChild(hint);
      }
      for (const att of audios) {
        const row = document.createElement('div');
        row.className = 'mixer-audio-row';
        const lbl = att.label || 'Aufnahme';
        const when = att.ts ? new Date(att.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
        row.innerHTML = `<span class="mr-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v4M8 23h8"/></svg></span><span class="mr-label"></span><span class="mr-dur"></span>`;
        row.querySelector('.mr-label').textContent = lbl;
        row.querySelector('.mr-dur').textContent = when;
        row.onclick = () => {
          audioListEl.querySelectorAll('.mixer-audio-row').forEach(r => r.classList.remove('on'));
          row.classList.add('on'); selAudioBlob = att.blob; selAudioBuffer = null;
        };
        audioListEl.appendChild(row);
      }
    } catch (e) {
      console.warn('reel audio load', e);
      audioListEl.innerHTML = '<div style="color:var(--faint);font-size:12px;padding:6px 0">Fehler beim Laden der Aufnahmen.</div>';
    }
  })();

  exportBtn.onclick = async () => {
    vid.pause(); setPlayIcon(false);
    exportBtn.disabled = true; progress.style.display = 'block';
    if (progFill) progFill.style.width = '0%';
    if (progLabel) progLabel.textContent = 'Wird vorbereitet…';

    if (!supportsCapture) {
      // Kein Trimmen/Mischen möglich -> Original-Datei unverändert teilen/herunterladen.
      try {
        if (progLabel) progLabel.textContent = 'Bereite Original zum Teilen vor…';
        const origBlob = await fetch(url).then(r => r.blob());
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const ext = (mime || '').includes('mp4') ? 'mp4' : 'webm';
        const fname = 'waldohr-video-' + stamp + '.' + ext;
        const file = new File([origBlob], fname, { type: mime || 'video/webm' });
        if (progFill) progFill.style.width = '100%';
        if (progLabel) progLabel.textContent = 'Fertig!';
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ title: 'WaldOhr Video', files: [file] });
        } else {
          const a = document.createElement('a'); a.href = URL.createObjectURL(origBlob); a.download = fname; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 8000);
        }
        ov.remove();
      } catch (e) {
        console.warn('fallback share', e);
        if (progLabel) progLabel.textContent = 'Fehler: ' + (e?.message || 'Teilen fehlgeschlagen');
        exportBtn.disabled = false;
      }
      return;
    }

    const dur0 = duration || vid.duration || 0;
    const startTime = startFrac * dur0, endTime = endFrac * dur0, trimDur = Math.max(0.1, endTime - startTime);
    let audioCtx = null, srcVid = null;
    try {
      // Quell-Video NICHT stummschalten: captureStream() liefert dann Video + Originalton in einem
      // Stream (bewährter Weg). Lautstärke/Clip werden über WebAudio auf den erfassten Tonspur-Track
      // gelegt — decodeAudioData scheitert an Video-Containern, createMediaStreamSource nicht.
      srcVid = document.createElement('video');
      srcVid.src = url; srcVid.preload = 'auto'; srcVid.playsInline = true; srcVid.muted = false;
      srcVid.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
      document.body.appendChild(srcVid);
      // play() SOFORT auslösen — noch innerhalb der Klick-Nutzergeste. Vorher wurde erst nach
      // mehreren await-Schritten (loadeddata/seeked, bis zu 5,5 s) play() aufgerufen — auf echten
      // Handys ist die Nutzergeste dann abgelaufen, die Autoplay-Policy blockiert die unstumme
      // Wiedergabe still, es kommen keine Frames rein und die Aufnahme bleibt leer.
      let playErr = null;
      const playPromise = srcVid.play().catch(err => { playErr = err; });
      await new Promise((res, rej) => {
        srcVid.addEventListener('loadeddata', res, { once: true });
        srcVid.addEventListener('error', () => rej(new Error('Video konnte nicht geladen werden')), { once: true });
        setTimeout(res, 4000);
      });
      await playPromise;
      if (playErr) throw new Error('Wiedergabe vom Browser blockiert — bitte erneut versuchen');
      srcVid.pause();
      srcVid.currentTime = startTime;
      await new Promise(res => { srcVid.addEventListener('seeked', res, { once: true }); setTimeout(res, 1500); });

      const videoTrack = srcVid.captureStream().getVideoTracks()[0];

      // Ton komplett über WebAudio: Originalton via MediaElementSource (lautstärkegeregelt) +
      // optionaler Clip. decodeAudioData scheitert an Video-Containern und die Tonspur ist im
      // Element-captureStream nicht enthalten — MediaElementSource ist der zuverlässige Weg.
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }
      const dest = audioCtx.createMediaStreamDestination();
      try {
        const elSrc = audioCtx.createMediaElementSource(srcVid);
        const g = audioCtx.createGain(); g.gain.value = origVol;
        elSrc.connect(g); g.connect(dest);
      } catch (err) { console.warn('orig audio route', err); }
      let clipSrc = null;
      if (selAudioBlob) {
        try {
          if (!selAudioBuffer) selAudioBuffer = await audioCtx.decodeAudioData(await selAudioBlob.arrayBuffer());
          clipSrc = audioCtx.createBufferSource(); clipSrc.buffer = selAudioBuffer; clipSrc.loop = true;
          clipSrc.connect(dest);
        } catch (err) { console.warn('clip decode', err); }
      }

      const combined = new MediaStream(videoTrack ? [videoTrack, ...dest.stream.getAudioTracks()] : dest.stream.getAudioTracks());

      let exportMime = '';
      for (const t of ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { exportMime = t; break; }
      }
      const mr = exportMime ? new MediaRecorder(combined, { mimeType: exportMime }) : new MediaRecorder(combined);
      const chunks = [];
      mr.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
      const t0 = Date.now();
      const progInterval = setInterval(() => {
        const pct = Math.min(95, Math.round((Date.now() - t0) / 1000 / trimDur * 100));
        if (progFill) progFill.style.width = pct + '%';
        if (progLabel) progLabel.textContent = 'Exportiere… ' + pct + '%';
      }, 300);
      await new Promise((res, rej) => {
        mr.onstop = () => { clearInterval(progInterval); res(); };
        mr.onerror = e => { clearInterval(progInterval); rej(e); };
        mr.start();
        srcVid.play().catch(() => {});
        try { if (clipSrc) clipSrc.start(0); } catch {}
        setTimeout(() => {
          try { mr.stop(); } catch {}
          try { srcVid.pause(); } catch {}
          try { if (clipSrc) clipSrc.stop(); } catch {}
        }, trimDur * 1000 + 300);
      });
      if (progFill) progFill.style.width = '100%';
      if (progLabel) progLabel.textContent = 'Fertig!';
      const blob = new Blob(chunks, { type: exportMime || 'video/webm' });
      if (!blob.size) throw new Error('Aufnahme leer');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const ext = (exportMime || '').includes('mp4') ? 'mp4' : 'webm';
      const fname = 'waldohr-reel-' + stamp + '.' + ext;
      const file = new File([blob], fname, { type: exportMime || 'video/webm' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ title: 'WaldOhr Reel', files: [file] });
      } else {
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 8000);
      }
      try { audioCtx.close(); } catch {}
      if (srcVid) srcVid.remove();
      ov.remove();
    } catch (e) {
      console.warn('reel export', e);
      try { if (audioCtx) audioCtx.close(); } catch {}
      if (srcVid) { try { srcVid.remove(); } catch {} }
      if (progLabel) progLabel.textContent = 'Fehler: ' + (e?.message || 'Export fehlgeschlagen');
      exportBtn.disabled = false;
    }
  };
  const dismiss = () => { if (_vidRaf) cancelAnimationFrame(_vidRaf); vid.pause(); ov.remove(); };
  closeBtn.onclick = dismiss;
  ov.addEventListener('click', e => { if (e.target === ov) dismiss(); });
}

// Teilen-Button für Foto-Zeilen: öffnet Mixer (Foto-Karte teilen ODER Foto+Audio→Video).
function makeShareBtn(url, key, label) {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.title = 'Teilen'; btn.className = 'rec-dl'; btn.style.color = 'var(--muted)';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
  btn.onclick = ev => { ev.stopPropagation(); openShareMixer(url, key, label); };
  return btn;
}

// Sende-Button für Foto-/Video-Zeilen: schickt die Datei direkt ans gekoppelte Partner-Handy,
// komplett ohne Internet, über den bestehenden WebRTC-Datenkanal (js/filetransfer.js).
function makeSendToPartnerBtn(blob, kind, label) {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.title = 'Ans Partner-Handy senden'; btn.className = 'rec-dl'; btn.style.color = 'var(--muted)';
  const idleIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="10" y1="18" x2="14" y2="18"/></svg>';
  btn.innerHTML = idleIcon;
  btn.onclick = async ev => {
    ev.stopPropagation();
    if (!filetransfer.isActive()) { showInfoToast('📲 Nicht gekoppelt', 'Erst ein Partner-Handy koppeln, dann senden.', '📲'); return; }
    btn.disabled = true; btn.textContent = '⏳';
    try {
      await filetransfer.sendFile(blob, kind, label || '');
      const n = hub.peerCount();
      const dest = n > 1 ? 'an alle ' + n + ' gekoppelten Handys' : 'ans Partner-Handy';
      showInfoToast('📲 Gesendet', (kind === 'video' ? 'Video' : 'Foto') + ' ' + dest + ' geschickt.', '✅');
    } catch (e) {
      showInfoToast('📲 Fehler', e?.message || 'Senden fehlgeschlagen.', '⚠️');
    } finally {
      btn.disabled = false; btn.innerHTML = idleIcon;
    }
  };
  return btn;
}

// Baut eine Aufnahme/Foto-Zeile aus einem gespeicherten Anhang (nach Reload) — selbe Optik wie
// frisch erzeugte Zeilen, aber aus dem in IndexedDB gesicherten Blob statt einer Live-Aufnahme.
function attachmentRow(a) {
  const url = URL.createObjectURL(a.blob);
  const row = document.createElement('div'); row.className = 'rec-row';
  let _audioEl = null;
  if (a.kind === 'audio') {
    _audioEl = document.createElement('audio'); _audioEl.src = url; _audioEl.preload = 'metadata'; _audioEl.hidden = true;
    wireAudioRouting(_audioEl);
    row.appendChild(_makeAudioIcon(_audioEl));
  } else if (a.kind === 'video') {
    const thumb = _makeVideoThumb(url);
    thumb.onclick = () => openVideoLightbox(url);
    row.appendChild(thumb);
  } else {
    const img = document.createElement('img'); img.className = 'photo-thumb'; img.src = url; img.alt = a.label || 'Foto';
    img.onclick = () => openPhotoLightbox(url);
    row.appendChild(img);
  }
  if (a.label) {
    const lb = document.createElement('span'); lb.className = 'rec-label';
    lb.textContent = a.label;
    row.appendChild(lb);
  }
  const mime = a.mime || '';
  const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'm4a' : mime.includes('webm') ? 'webm'
    : mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'bin';
  const stamp = new Date(a.ts).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = (a.label || 'waldohr').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  row.appendChild(_spacer());
  const dl = makeDownloadBtn(url, prefix + '_' + stamp + '.' + ext, a.label);
  row.appendChild(dl);
  if (a.kind === 'photo') row.appendChild(makeShareBtn(url, a.key, a.label));
  if (a.kind === 'video') row.appendChild(makeReelBtn(url, mime));
  if (a.kind === 'photo' || a.kind === 'video') row.appendChild(makeSendToPartnerBtn(a.blob, a.kind, a.label));
  if (a.kind === 'audio') row.appendChild(_makeScissorsBtn(row));
  row.appendChild(makeDeleteBtn(row, url, a.key, a.id));
  if (_audioEl) row.appendChild(_audioEl);
  return row;
}

// Baut die Liste eigener Aufnahmen/Fotos + die kleinen Abspiel-Badges auf den Sammlungskarten
// aus der Datenbank neu auf — beim Boot UND nach jedem Löschen, damit beides synchron bleibt.
async function hydrateAttachments() {
  const list = document.getElementById('recList');
  if (list) list.innerHTML = '';
  clearRecordings();
  try {
    const latestAudio = await latestAudioAttachmentsByKey();
    for (const a of latestAudio) registerRecording(a.key, URL.createObjectURL(a.blob));
  } catch (e) { console.warn('hydrate badges', e); }
  try {
    const all = await allAttachments();
    if (list) for (const a of all) list.appendChild(attachmentRow(a));
  } catch (e) { console.warn('hydrate recList', e); }
}

// ---- Mikrofon-Steuerung ----
// 'off': alles aus  |  'mic-ready': Mikro läuft, aber keine Erkennung  |  'mic': REC aktiv + Erkennung
function setUI(mode, msg) {
  body.classList.remove('listening', 'mic-ready');
  if (mode === 'off') { statusTxt.textContent = msg || 'Tippe zum Lauschen'; renderLive(); return; }
  if (mode === 'mic-ready') { body.classList.add('mic-ready'); statusTxt.textContent = msg || 'Mikrofon bereit – REC drücken'; renderLive(); return; }
  body.classList.add('listening');
  statusTxt.textContent = msg || 'Lauscht über dein Mikrofon…';
  renderLive();
}

// Vollbildmodus: nur per Nutzergeste auslösbar. Bisher hing das nur am Mikro-Tap —
// jetzt auf jeden ersten Tap irgendwo in der App, damit Vollbild zuverlässig ankommt,
// egal welchen Button der Nutzer zuerst antippt.
function tryFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen().catch(() => {});
}
document.addEventListener('click', tryFullscreen);

const routeToggleBtn = document.getElementById('routeToggleBtn');
function updateRouteToggleBtn(active) {
  if (routeToggleBtn) routeToggleBtn.classList.toggle('active', active);
}

function stopSession() {
  const s = routeTracker.stop();
  updateRouteToggleBtn(false);
  if (s && s.pointCount >= 2) {
    const dist = s.distKm < 1 ? Math.round(s.distKm * 1000) + ' m' : s.distKm.toFixed(2) + ' km';
    showInfoToast('Route beendet', dist + ' · ' + s.pointCount + ' GPS-Punkte', '📍', () => {
      const gpx = routeTracker.exportGpx(); if (!gpx) return;
      const a = document.createElement('a'); a.href = 'data:application/gpx+xml;charset=utf-8,' + encodeURIComponent(gpx); a.download = 'waldohr-route-' + new Date().toISOString().slice(0, 10) + '.gpx'; a.click();
    }, 'GPX exportieren');
  }
  updateRouteMap([]);
}

// Timing-Knopf (neben Galerie): öffnet Alarme/Zeitplanung-Modal.
const timingBtn = document.getElementById('timingBtn');
if (timingBtn) timingBtn.onclick = () => { warmAlarmCtx(); openTimingModal(geo.pos); };

// Route-Toggle im Karte-Tab: Route manuell starten/stoppen ohne Mikro.
if (routeToggleBtn) routeToggleBtn.onclick = () => {
  if (routeTracker._timer) {
    stopSession();
  } else {
    geo.start();
    routeTracker.start();
    updateRouteToggleBtn(true);
    showInfoToast('Route gestartet', 'GPS-Track wird aufgezeichnet.', '📍');
  }
};

function toggleDetection() {
  if (!audio.running) {
    tryFullscreen();
    audio.start(getMicDeviceId()).then(() => { geo.start(); detectionActive = true; setUI('mic'); if (recBtn) recBtn.classList.add('rec-on'); routeTracker.start(); updateRouteToggleBtn(true); startDauerUeberwachung(); })
      .catch(e => { console.warn('mic', e); setUI('off', 'Mikro nicht erlaubt'); });
    return;
  }
  detectionActive = !detectionActive;
  setUI(detectionActive ? 'mic' : 'mic-ready');
  if (recBtn) recBtn.classList.toggle('rec-on', detectionActive);
}

const orbBtn = document.getElementById('orbBtn');
if (orbBtn) orbBtn.addEventListener('click', async ev => {
  if (ev.target.closest('.rec-pill')) return;
  if (audio.running) {
    if (recorder.mr && recorder.mr.state === 'recording') recorder.mr.stop();
    stopDauerUeberwachung(); audio.stop(); detectionActive = false; setUI('off');
    stopSession();
    return;
  }
  tryFullscreen();
  try { await audio.start(getMicDeviceId()); geo.start(); setUI('mic-ready'); routeTracker.start(); updateRouteToggleBtn(true); startDauerUeberwachung(); }
  catch (e) { console.warn('mic', e); setUI('off', 'Mikro nicht erlaubt'); }
});

// ---- Tonaufnahme (manuell) ----
const recBtn = document.getElementById('recBtn');
if (recBtn && !window.MediaRecorder) recBtn.style.display = 'none';

let _recPopupEl = null, _recPopupTimer = null, _recLevelRaf = null, _recPopupT0 = 0;
function _showRecPopup(state) {
  // state: 'preparing' | 'recording'
  if (!_recPopupEl) {
    _recPopupT0 = Date.now();
    _recPopupEl = document.createElement('div');
    _recPopupEl.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;pointer-events:none';
    _recPopupEl.innerHTML = `<div style="background:linear-gradient(160deg,#200808,#100404);border:1px solid rgba(239,68,68,.35);border-radius:24px;padding:28px 32px 22px;text-align:center;min-width:200px;box-shadow:0 12px 40px rgba(0,0,0,.6)">
      <div class="rec-popup-mic" style="color:#ef4444;margin-bottom:12px">
        <svg viewBox="0 0 24 24" fill="#ef4444" stroke="#ef4444" stroke-width="0.5" width="56" height="56"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="#ef4444" stroke-width="1.8"/><line x1="12" y1="19" x2="12" y2="23" stroke="#ef4444" stroke-width="1.8"/><line x1="8" y1="23" x2="16" y2="23" stroke="#ef4444" stroke-width="1.8"/></svg>
      </div>
      <div id="_recPopupTime" style="font-size:30px;font-weight:700;color:#ef4444;font-family:'Outfit',sans-serif;letter-spacing:2px">0:00</div>
      <div id="_recPopupStatus" style="font-size:12px;color:rgba(239,68,68,.6);margin-top:6px;letter-spacing:.5px">Vorbereitung…</div>
      <div style="width:140px;height:6px;background:rgba(239,68,68,.12);border-radius:4px;margin:12px auto 0;overflow:hidden"><div id="_recLevelFill" style="height:100%;width:0%;border-radius:4px;background:linear-gradient(90deg,#22c55e,#a3e635);transition:width 80ms linear"></div></div>
    </div>`;
    document.body.appendChild(_recPopupEl);
    if (!_recPopupTimer) _recPopupTimer = setInterval(() => {
      const el = document.getElementById('_recPopupTime');
      if (!el) return;
      const s = Math.floor((Date.now() - _recPopupT0) / 1000);
      el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 500);
    if (!_recLevelRaf) {
      const drawLevel = () => {
        const fill = document.getElementById('_recLevelFill');
        if (!fill) { _recLevelRaf = null; return; }
        if (audio.analyser) {
          const data = new Uint8Array(audio.analyser.frequencyBinCount);
          audio.analyser.getByteFrequencyData(data);
          let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
          const lvl = Math.min(1, (sum / data.length / 255) * 3.5);
          fill.style.width = Math.round(lvl * 100) + '%';
        }
        if (_recPopupEl) _recLevelRaf = requestAnimationFrame(drawLevel);
        else _recLevelRaf = null;
      };
      _recLevelRaf = requestAnimationFrame(drawLevel);
    }
  }
  if (state === 'recording') {
    const s = document.getElementById('_recPopupStatus');
    if (s) s.textContent = 'Aufnahme läuft';
  }
}
function _hideRecPopup() {
  if (_recPopupEl) { _recPopupEl.remove(); _recPopupEl = null; }
  if (_recPopupTimer) { clearInterval(_recPopupTimer); _recPopupTimer = null; }
  if (_recLevelRaf) { cancelAnimationFrame(_recLevelRaf); _recLevelRaf = null; }
}

const recorder = {
  mr: null, chunks: [], timer: null, t0: 0,
  fmt() { const s = Math.floor((Date.now() - this.t0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); },
  setBtn(on) {
    const cb = document.getElementById('clipBtn'); if (cb) cb.classList.toggle('rec-on', on);
  },
  async toggle(label, key) {
    if (this.mr && this.mr.state === 'recording') { this.mr.stop(); return; }
    if (!audio.running) {
      // Popup ZUERST anzeigen, dem Browser per setTimeout sicher einen Render-Tick geben und ERST
      // DANN die (auf manchen Handys >10 s langsame) Mikrofon-Initialisierung starten. setTimeout
      // statt requestAnimationFrame, weil rAF auf manchen Geräten (Fullscreen-/Render-Pausen)
      // sekundenlang aussetzen kann — dann erschiene das Popup gar nicht.
      _showRecPopup('preparing');
      await new Promise(r => setTimeout(r, 60));
      try { await audio.start(getMicDeviceId()); geo.start(); }
      catch (e) { console.warn('mic', e); statusTxt.textContent = 'Mikro nicht erlaubt'; _hideRecPopup(); return; }
    }
    if (!audio.stream) { _hideRecPopup(); return; }
    let type = '';
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { type = t; break; }
    }
    try { this.mr = type ? new MediaRecorder(audio.stream, { mimeType: type }) : new MediaRecorder(audio.stream); }
    catch (e) {
      console.warn('rec', e);
      if (statusTxt) statusTxt.textContent = 'Aufnahme nicht möglich';
      _hideRecPopup();
      setTimeout(() => { if (statusTxt && statusTxt.textContent === 'Aufnahme nicht möglich') statusTxt.textContent = ''; }, 3000);
      return;
    }
    this.chunks = []; this.label = label || null; this.key = key || null;
    this.mr.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.onstop = () => { this.setBtn(false); _hideRecPopup(); this.save(); };
    this.mr.start();
    this.t0 = Date.now(); this.setBtn(true); _showRecPopup('recording');
  },
  async save() {
    if (!this.chunks.length) return;
    const raw = new Blob(this.chunks, { type: this.chunks[0].type || 'audio/webm' });
    // Aufnahme lauter & klarer machen: tiefes Rauschen raus, Pegel normalisieren, als WAV sichern.
    let url, ext, saveBlob, mime;
    try {
      const { samples, sampleRate } = await enhanceBlob(raw);
      saveBlob = encodeWav(samples, sampleRate); mime = 'audio/wav';
      url = URL.createObjectURL(saveBlob); ext = 'wav';
    } catch (e) {
      console.warn('enhance', e);
      saveBlob = raw; mime = raw.type;
      url = URL.createObjectURL(raw); ext = raw.type.includes('mp4') ? 'm4a' : 'webm';
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const prefix = this.label ? this.label.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'waldohr';
    const name = prefix + '_' + stamp + '.' + ext;
    const row = document.createElement('div'); row.className = 'rec-row';
    const a = document.createElement('audio'); a.src = url; a.preload = 'metadata'; a.hidden = true;
    wireAudioRouting(a);
    const dl = makeDownloadBtn(url, name, this.label);
    row.appendChild(_makeAudioIcon(a));
    if (this.label) { const lb = document.createElement('span'); lb.className = 'rec-label'; lb.textContent = this.label; row.appendChild(lb); }
    row.appendChild(_spacer());
    row.appendChild(dl);
    row.appendChild(_makeScissorsBtn(row));
    let attId = null;
    try { attId = await addAttachment({ key: this.key, label: this.label, kind: 'audio', blob: saveBlob, mime }); }
    catch (e) { console.warn('addAttachment', e); }
    row.appendChild(makeDeleteBtn(row, url, this.key, attId));
    row.appendChild(a);
    const list = document.getElementById('recList'); if (list) list.prepend(row);
    if (this.key) registerRecording(this.key, url);
    if (!galleryModal || !galleryModal.classList.contains('open')) galleryBadgeAdd(1);
  }
};
if (recBtn) recBtn.onclick = () => toggleDetection();
const clipBtn = document.getElementById('clipBtn');
if (clipBtn && !window.MediaRecorder) clipBtn.style.display = 'none';
if (clipBtn) clipBtn.onclick = () => recorder.toggle();
const photoFab = document.getElementById('photoFab');
if (photoFab) photoFab.onclick = () => openCamera(capture => _saveCapture({ ...capture, label: null, key: null }));
const galleryModal = document.getElementById('galleryModal');
const galleryBtn = document.getElementById('galleryBtn');
const galleryClose = document.getElementById('galleryClose');
const galleryScrim = document.getElementById('galleryScrim');

const LS_BADGE = 'waldohr.gallery.newCount';
function galleryBadgeAdd(n) {
  try {
    const cur = parseInt(localStorage.getItem(LS_BADGE)) || 0;
    const next = cur + n;
    localStorage.setItem(LS_BADGE, next);
    const el = document.getElementById('galleryBadge');
    if (el) { el.textContent = next > 9 ? '9+' : next; el.hidden = false; }
  } catch {}
}
function galleryBadgeClear() {
  try { localStorage.setItem(LS_BADGE, '0'); } catch {}
  const el = document.getElementById('galleryBadge');
  if (el) el.hidden = true;
}
// Restore badge count from previous session
(function() {
  const n = parseInt(localStorage.getItem(LS_BADGE)) || 0;
  if (n > 0) {
    const el = document.getElementById('galleryBadge');
    if (el) { el.textContent = n > 9 ? '9+' : n; el.hidden = false; }
  }
})();

const openGallery = () => { galleryModal && galleryModal.classList.add('open'); galleryBadgeClear(); };
const closeGallery = () => galleryModal && galleryModal.classList.remove('open');
if (galleryBtn) galleryBtn.onclick = openGallery;
if (galleryClose) galleryClose.onclick = closeGallery;
if (galleryScrim) galleryScrim.onclick = closeGallery;

// ---- Foto-Wetter Popup ----
const photoWeatherBtn = document.getElementById('photoWeatherBtn');
const photoWeatherModal = document.getElementById('photoWeatherModal');
const photoWeatherScrim = document.getElementById('photoWeatherScrim');
if (photoWeatherScrim) photoWeatherScrim.onclick = () => photoWeatherModal?.classList.remove('open');
if (photoWeatherBtn) photoWeatherBtn.onclick = async () => {
  photoWeatherModal?.classList.add('open');
  const content = document.getElementById('photoWeatherContent');
  const locEl = document.getElementById('pwLocation');
  if (!content) return;
  content.innerHTML = '<div class="pw-loading">Lade Wetterdaten…</div>';
  if (locEl) locEl.textContent = '';
  const lat = geo.pos?.lat, lng = geo.pos?.lng;

  // Location name (async, fills in when ready)
  if (lat != null && locEl) {
    reverseGeocode(lat, lng).then(name => { if (name && locEl) locEl.textContent = '📍 ' + name; });
  }

  const [pw, sun, moonTimes, todaySlots] = await Promise.all([
    fetchPhotoWeather(lat, lng),
    lat != null ? getSunriseFull(lat, lng) : Promise.resolve(null),
    lat != null ? fetchMoonTimes(lat, lng) : Promise.resolve(null),
    lat != null ? fetchTodayHours(lat, lng) : Promise.resolve(null),
  ]);
  const fmt = d => d instanceof Date ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
  const fmtDate = d => d instanceof Date ? d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '–';
  let html = '';
  if (sun) {
    const sr = sun.sunrise;
    const blueEnd = sr ? new Date(sr.getTime() - 20 * 60000) : null;
    const goldenEnd = sr ? new Date(sr.getTime() + 45 * 60000) : null;
    html += '<div class="pw-section">Licht-Zeiten</div>';
    if (sun.civilBegin) html += `<div class="pw-row"><span class="pw-icon">🌙</span><span class="pw-lbl">Blaue Stunde</span><span class="pw-val">${fmt(sun.civilBegin)} – ${blueEnd ? fmt(blueEnd) : '–'}</span></div>`;
    if (sr) html += `<div class="pw-row"><span class="pw-icon">🌄</span><span class="pw-lbl">Sonnenaufgang</span><span class="pw-val">${fmt(sr)}</span></div>`;
    if (sr) html += `<div class="pw-row"><span class="pw-icon">🌅</span><span class="pw-lbl">Goldene Stunde</span><span class="pw-val">${fmt(sr)} – ${goldenEnd ? fmt(goldenEnd) : '–'}</span></div>`;
    if (sun.sunset) {
      html += '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1.5px;padding:6px 0 2px;opacity:.7">Abends</div>';
      const goldenBegin = new Date(sun.sunset.getTime() - 45 * 60000);
      html += `<div class="pw-row"><span class="pw-icon">🌇</span><span class="pw-lbl">Goldene Stunde</span><span class="pw-val">${fmt(goldenBegin)} – ${fmt(sun.sunset)}</span></div>`;
      html += `<div class="pw-row"><span class="pw-icon">🌆</span><span class="pw-lbl">Sonnenuntergang</span><span class="pw-val">${fmt(sun.sunset)}</span></div>`;
      if (sun.civilEnd) html += `<div class="pw-row"><span class="pw-icon">🌙</span><span class="pw-lbl">Blaue Stunde</span><span class="pw-val">${fmt(sun.sunset)} – ${fmt(sun.civilEnd)}</span></div>`;
    }
  }
  if (pw) {
    const fogRisk = pw.visKm < 1 ? 'Nebel' : pw.visKm < 5 && pw.humidity > 85 ? 'Dunst' : pw.humidity > 92 ? 'Nebelgefahr' : null;
    const tip = pw.cloudcover < 20 && pw.windKmh < 10 ? 'Optimale Bedingungen für Langzeitbelichtung!'
      : pw.cloudcover > 70 ? 'Weiches Diffuslicht durch Bewölkung — ideal für Porträtfotos.'
      : pw.windKmh > 25 ? 'Starker Wind — kurze Belichtungszeit wählen.'
      : 'Gute Bedingungen für Naturfotografie.';
    html += '<div class="pw-section">Aktuell</div>';
    html += `<div class="pw-row"><span class="pw-icon">${weatherEmoji(pw.wmo)}</span><span class="pw-lbl">${weatherLabel(pw.wmo)}</span><span class="pw-val">${pw.temp}°C</span></div>`;
    html += `<div class="pw-row"><span class="pw-icon">💨</span><span class="pw-lbl">Wind</span><span class="pw-val">${pw.windKmh} km/h ${windDirLabel(pw.windDir)}</span></div>`;
    html += `<div class="pw-row"><span class="pw-icon">💧</span><span class="pw-lbl">Luftfeuchte</span><span class="pw-val">${pw.humidity}%${pw.humidity > 85 ? ' ⚠' : ''}</span></div>`;
    if (fogRisk) html += `<div class="pw-row"><span class="pw-icon">🌫️</span><span class="pw-lbl">Nebel</span><span class="pw-val" style="color:var(--amber)">${fogRisk} · ${pw.visKm} km</span></div>`;
    else         html += `<div class="pw-row"><span class="pw-icon">👁</span><span class="pw-lbl">Sichtweite</span><span class="pw-val">${pw.visKm} km</span></div>`;
    html += `<div class="pw-row"><span class="pw-icon">☁️</span><span class="pw-lbl">Bewölkung</span><span class="pw-val">${pw.cloudcover}%</span></div>`;
    html += `<div class="pw-row"><span class="pw-icon">☀️</span><span class="pw-lbl">UV-Index</span><span class="pw-val">${pw.uvIndex} – ${uvLabel(pw.uvIndex)}</span></div>`;
    html += `<div class="pw-tip">💡 ${tip}</div>`;
    if (todaySlots?.length) {
      html += '<div class="tmw-slots" style="margin-top:8px">'
        + todaySlots.map(s => {
            const fog = s.visKm < 2 ? ' 🌫️' : s.visKm < 5 ? ' 🌁' : '';
            return `<div class="tmw-slot"><div class="tmw-h">${s.hour}:00</div><div class="tmw-ico">${weatherEmoji(s.wmo)}${fog}</div><div class="tmw-temp">${s.temp > 0 ? '+' : ''}${s.temp}°</div><div class="tmw-cc">${s.cloudcover}%☁️</div><div class="tmw-rain">${s.precipProb > 0 ? '💧' + s.precipProb + '%' : ''}</div></div>`;
          }).join('') + '</div>';
    }
  }
  // Mond-Kalender
  const mc = moonCalendar();
  html += '<div class="pw-section">Mond</div>';
  html += `<div class="pw-row"><span class="pw-icon">${moonPhaseLabel(mc.phase).split(' ')[1] || '🌙'}</span><span class="pw-lbl">Phase</span><span class="pw-val">${moonPhaseLabel(mc.phase).replace(/\s[\S]+$/, '')} · ${mc.ageInDays} Tage</span></div>`;
  const mrStr = moonTimes === null ? 'GPS nötig' : (moonTimes.moonrise ? fmt(moonTimes.moonrise) : 'Heute nicht');
  const msStr = moonTimes === null ? 'GPS nötig' : (moonTimes.moonset ? fmt(moonTimes.moonset) : 'Heute nicht');
  html += `<div class="pw-row"><span class="pw-icon">🌙</span><span class="pw-lbl">Mondaufgang</span><span class="pw-val">${mrStr}</span></div>`;
  html += `<div class="pw-row"><span class="pw-icon">🌑</span><span class="pw-lbl">Monduntergang</span><span class="pw-val">${msStr}</span></div>`;
  html += `<div class="pw-row"><span class="pw-icon">🌕</span><span class="pw-lbl">Nächster Vollmond</span><span class="pw-val">${fmtDate(mc.nextFull)} (in ${mc.daysToFull} d)</span></div>`;
  html += `<div class="pw-row"><span class="pw-icon">🌑</span><span class="pw-lbl">Nächster Neumond</span><span class="pw-val">${fmtDate(mc.nextNew)} (in ${mc.daysToNew} d)</span></div>`;

  if (!pw && !sun) html = '<div class="pw-loading">GPS benötigt – Standort erlauben, dann erneut öffnen.</div>';
  content.innerHTML = html;

  // Morgen-Früh-Prognose nachreichen
  if (lat != null) {
    const tmwEl = document.createElement('div');
    tmwEl.innerHTML = '<div class="pw-section" style="margin-top:10px">Morgen früh</div><div class="pw-loading">Prognose wird geladen …</div>';
    content.appendChild(tmwEl);
    fetchTomorrowMorning(lat, lng).then(slots => {
      if (!slots || !slots.length) { tmwEl.innerHTML = '<div class="pw-section" style="margin-top:10px">Morgen früh</div><div class="pw-loading">Keine Prognose verfügbar.</div>'; return; }
      tmwEl.innerHTML = '<div class="pw-section" style="margin-top:10px">Morgen früh</div><div class="tmw-slots">'
        + slots.map(s => {
            const fog = s.visKm < 2 ? ' 🌫️' : s.visKm < 5 ? ' 🌁' : '';
            return `<div class="tmw-slot"><div class="tmw-h">${s.hour}:00</div><div class="tmw-ico">${weatherEmoji(s.wmo)}${fog}</div><div class="tmw-temp">${s.temp > 0 ? '+' : ''}${s.temp}°</div><div class="tmw-cc">${s.cloudcover}%☁️</div><div class="tmw-rain">${s.precipProb > 0 ? '💧' + s.precipProb + '%' : ''}</div></div>`;
          }).join('') + '</div>';
    }).catch(() => { tmwEl.remove(); });
  }
};

// Aufnahme-Knopf direkt an einer Live-Zeile -> beschriftet die Aufnahme mit dem Artnamen und
// verknüpft sie mit dem Art-Key, damit sie als kleines Icon in der Sammlung auftaucht.
window.__waldohrRecordSpecies = (name, key) => recorder.toggle(name, key);

// API for Punkt-Zählung cross-tab flow (ornithologie.js)
let _triggerRaf = null, _triggerMr = null;
window.__waldohr = {
  startDetection: async () => {
    detectionActive = true;
    setUI('mic');
    if (recBtn) recBtn.classList.add('rec-on');
    if (!audio.running) {
      // Erst die UI (Timer/Banner) zeichnen lassen, dann das blockierende getUserMedia starten.
      // setTimeout statt rAF (rAF kann auf manchen Handys sekundenlang aussetzen).
      await new Promise(r => setTimeout(r, 60));
      try { await audio.start(getMicDeviceId()); geo.start(); }
      catch (e) { detectionActive = false; setUI('off'); if (recBtn) recBtn.classList.remove('rec-on'); throw e; }
    }
  },
  stopDetection: () => {
    detectionActive = false;
    setUI(audio.running ? 'mic-ready' : 'off');
    if (recBtn) recBtn.classList.remove('rec-on');
  },
  isDetecting: () => audio.running && detectionActive,
  switchTab: v => { document.querySelector(`.nav button[data-v="${v}"]`)?.click(); },
  openDownload: (url, filename, label) => openDownloadSheet(url, filename, label),
  startTriggerRec: (threshold) => {
    if (_triggerRaf) return;
    const tFreq = new Uint8Array(audio.analyser?.frequencyBinCount || 512);
    let tMr = null, tChunks = [], tSilenceAt = null;
    const SILENCE_MS = 3000;
    let tType = '';
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { tType = t; break; }
    }
    function tStartRec() {
      if (tMr && tMr.state === 'recording') return;
      if (!audio.stream) return;
      tChunks = [];
      try { tMr = tType ? new MediaRecorder(audio.stream, { mimeType: tType }) : new MediaRecorder(audio.stream); _triggerMr = tMr; }
      catch { return; }
      tMr.ondataavailable = e => { if (e.data?.size) tChunks.push(e.data); };
      tMr.onstop = async () => {
        _triggerMr = null;
        if (recBtn) recBtn.classList.remove('rec-on');
        if (!tChunks.length) return;
        const raw = new Blob(tChunks, { type: tChunks[0].type || 'audio/webm' });
        let saveBlob, mime, url, ext;
        try {
          const { samples, sampleRate } = await enhanceBlob(raw);
          saveBlob = encodeWav(samples, sampleRate); mime = 'audio/wav';
          url = URL.createObjectURL(saveBlob); ext = 'wav';
        } catch { saveBlob = raw; mime = raw.type; url = URL.createObjectURL(raw); ext = 'webm'; }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const name = 'trigger_' + stamp + '.' + ext;
        const row = document.createElement('div'); row.className = 'rec-row';
        const a = document.createElement('audio'); a.src = url; a.preload = 'metadata'; a.hidden = true;
        wireAudioRouting(a);
        const dl = makeDownloadBtn(url, name, 'Trigger');
        row.appendChild(_makeAudioIcon(a));
        const lb = document.createElement('span'); lb.className = 'rec-label'; lb.textContent = 'Trigger'; row.appendChild(lb);
        row.appendChild(_spacer()); row.appendChild(dl); row.appendChild(_makeScissorsBtn(row));
        let attId = null;
        try { attId = await addAttachment({ key: null, label: 'Trigger', kind: 'audio', blob: saveBlob, mime }); } catch {}
        row.appendChild(makeDeleteBtn(row, url, null, attId)); row.appendChild(a);
        const list = document.getElementById('recList'); if (list) list.prepend(row);
        if (!galleryModal || !galleryModal.classList.contains('open')) galleryBadgeAdd(1);
      };
      tMr.start();
      if (recBtn) recBtn.classList.add('rec-on');
      setTimeout(() => { if (tMr && tMr.state === 'recording') { tMr.stop(); tMr = null; tSilenceAt = null; } }, 60000);
    }
    function tTick() {
      _triggerRaf = requestAnimationFrame(tTick);
      if (!audio.analyser) return;
      audio.analyser.getByteFrequencyData(tFreq);
      let sum = 0; for (let i = 0; i < tFreq.length; i++) sum += tFreq[i];
      const avg = sum / tFreq.length;
      if (avg > threshold) {
        tSilenceAt = null;
        if (!tMr || tMr.state !== 'recording') tStartRec();
      } else if (tMr && tMr.state === 'recording') {
        if (!tSilenceAt) tSilenceAt = Date.now();
        if (Date.now() - tSilenceAt >= SILENCE_MS) { tMr.stop(); tMr = null; tSilenceAt = null; }
      }
    }
    tTick();
  },
  stopTriggerRec: () => {
    if (_triggerRaf) { cancelAnimationFrame(_triggerRaf); _triggerRaf = null; }
    if (_triggerMr && _triggerMr.state === 'recording') _triggerMr.stop();
    _triggerMr = null;
  },
};

// ---- Kamera-Aufnahme: Foto oder Video, über eigene Kamera-UI ----
// Natives <input capture> bleibt als Fallback erhalten (camera.js greift darauf zurück falls getUserMedia verweigert).
const photoInput = document.getElementById('photoInput');
async function _saveCapture({ blob, mime, kind, label, key }) {
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'waldohr';
  const ext = mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : 'jpg';
  const row = document.createElement('div'); row.className = 'rec-row';
  if (kind === 'video') {
    const thumb = _makeVideoThumb(url);
    thumb.onclick = () => openVideoLightbox(url);
    row.appendChild(thumb);
  } else {
    const img = document.createElement('img'); img.className = 'photo-thumb'; img.src = url; img.alt = label || 'Foto';
    img.onclick = () => openPhotoLightbox(url);
    row.appendChild(img);
  }
  if (label) { const lb = document.createElement('span'); lb.className = 'rec-label'; lb.textContent = label; row.appendChild(lb); }
  row.appendChild(_spacer());
  const dl = makeDownloadBtn(url, prefix + '_' + stamp + '.' + ext, label);
  row.appendChild(dl);
  if (kind === 'photo') row.appendChild(makeShareBtn(url, key, label));
  if (kind === 'video') row.appendChild(makeReelBtn(url, mime));
  row.appendChild(makeSendToPartnerBtn(blob, kind, label));
  let attId = null;
  try { attId = await addAttachment({ key: key || null, label: label || null, kind, blob, mime }); }
  catch (e) { console.warn('addAttachment', e); }
  row.appendChild(makeDeleteBtn(row, url, key || null, attId));
  const list = document.getElementById('recList'); if (list) list.prepend(row);
  openGallery();
  if (!galleryModal || !galleryModal.classList.contains('open')) galleryBadgeAdd(1);
}
// Natives Input als letzter Fallback (wenn getUserMedia blockiert wird)
if (photoInput) {
  let _fallbackLabel = null, _fallbackKey = null;
  photoInput.onchange = async () => {
    const file = photoInput.files?.[0]; photoInput.value = '';
    if (!file) return;
    await _saveCapture({ blob: file, mime: file.type || 'image/jpeg', kind: 'photo', label: _fallbackLabel, key: _fallbackKey });
    _fallbackLabel = null; _fallbackKey = null;
  };
  photoInput._setFallback = (l, k) => { _fallbackLabel = l; _fallbackKey = k; };
}
// Kamera-Knopf an Live-Zeile / Seltenheits-Toast → öffnet eigene Kamera-UI
window.__waldohrCapturePhoto = (name, key) => {
  openCamera(capture => _saveCapture({ ...capture, label: name || null, key: key || null }));
};

// ---- Wiedergabe über Lautsprecher statt Hörer ----
// Läuft das Mikro noch (laufende Erkennung), routen iOS/Android die Audioausgabe beim
// gleichzeitigen Abspielen oft leise über den Hörer statt den Lautsprecher (geteilte
// "Aufnahme+Wiedergabe"-Audiosession). Pausiert den AudioContext kurz fürs Abspielen einer
// Referenz-/eigenen Aufnahme — verhindert nebenbei auch, dass das eigene Mikro die gerade
// abgespielte Aufnahme als neue Live-Erkennung missversteht.
window.__waldohrSuspendMicForPlayback = async () => {
  try { if (audio.ctx && audio.ctx.state === 'running') { await audio.ctx.suspend(); return true; } } catch (e) { console.warn('suspend', e); }
  return false;
};
window.__waldohrResumeMicAfterPlayback = async () => {
  try { if (audio.ctx && audio.ctx.state === 'suspended') await audio.ctx.resume(); } catch (e) { console.warn('resume', e); }
};
// Verdrahtet ein <audio controls>-Element (eigene Aufnahmen) mit derselben Lautsprecher-Logik.
function wireAudioRouting(a) {
  a.onplay = () => window.__waldohrSuspendMicForPlayback();
  a.onpause = a.onended = () => window.__waldohrResumeMicAfterPlayback();
}

// ---- Spektrogramm (nur echtes Mikro) ----
function startSpectrogram() {
  const cv = document.getElementById('spec'), cx = cv.getContext('2d');
  const levelFill = document.getElementById('levelFill');
  const COL = 80, n = 48, cols = [];
  const size = () => { cv.width = cv.clientWidth * devicePixelRatio; cv.height = cv.clientHeight * devicePixelRatio; };
  size(); addEventListener('resize', size);

  const color = v => v < .3 ? `rgba(16,80,60,${.3 + v})`
    : v < .6 ? `rgba(52,211,153,${v + .2})`
    : v < .82 ? `rgba(163,230,53,${v})`
    : `rgba(251,191,36,${v})`;

  function frame() {
    if (body.classList.contains('listening') && audio.running && audio.analyser) {
      const colv = [];
      audio.analyser.getByteFrequencyData(audio.freq);
      const usable = Math.floor(audio.freq.length * .55);
      for (let i = 0; i < n; i++) {
        const lo = Math.floor(Math.pow(i / n, 1.7) * usable);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / n, 1.7) * usable));
        let m = 0; for (let j = lo; j < hi; j++) if (audio.freq[j] > m) m = audio.freq[j];
        colv.push((m / 255) * 1.15);
      }
      cols.push(colv);
    } else cols.push(new Array(n).fill(0));
    if (cols.length > COL) cols.shift();

    if (levelFill) {
      const last = cols[cols.length - 1];
      const lvl = body.classList.contains('listening') ? Math.min(1, Math.max(0, ...last) * 1.5) : 0;
      levelFill.style.width = Math.round(lvl * 100) + '%';
    }

    const w = cv.width, h = cv.height, cw = w / COL;
    cx.clearRect(0, 0, w, h);
    for (let c = 0; c < cols.length; c++) {
      const v = cols[c], bh = h / v.length;
      for (let i = 0; i < v.length; i++) {
        if (v[i] < .04) continue;
        cx.fillStyle = color(v[i]);
        cx.fillRect(c * cw, h - (i + 1) * bh, cw + 1, bh + 1);
      }
    }
    requestAnimationFrame(frame);
  }
  frame();
}

// ---- "Heute hier" zurücksetzen ----
const hereResetBtn = document.getElementById('hereResetBtn');
if (hereResetBtn) hereResetBtn.onclick = async () => {
  let dets = [];
  try { dets = await allDetections(); } catch (e) { console.warn('read', e); }
  const ids = todayNearbyDetections(dets, geo.pos).map(d => d.id).filter(id => id != null);
  if (!ids.length) return;
  if (!confirm(ids.length + ' heutige Funde hier löschen?')) return;
  try { await deleteByIds(ids); } catch (e) { console.warn('delete', e); }
  await hydrateAttachments();
  refresh();
  showInfoToast('Funde gelöscht', ids.length + ' heutige Fund(e) hier wurden entfernt.', '🗑️');
};

// ---- Sicherung (Export/Import der kompletten lokalen Datenbank) ----
const backupExportBtn = document.getElementById('backupExportBtn');
const backupImportBtn = document.getElementById('backupImportBtn');
const backupImportFile = document.getElementById('backupImportFile');
const backupStatus = document.getElementById('backupStatus');
if (backupExportBtn) backupExportBtn.onclick = async () => {
  backupExportBtn.disabled = true;
  if (backupStatus) { backupStatus.hidden = false; backupStatus.textContent = 'Sicherung wird erstellt…'; }
  try {
    const res = await exportBackup((done, total) => {
      if (backupStatus) backupStatus.textContent = `Sicherung wird erstellt… ${done}/${total}`;
    });
    if (backupStatus) backupStatus.textContent = `✅ Fertig: ${res.detCount} Funde, ${res.attCount} Anhänge (${res.filename})`;
  } catch (e) {
    console.warn('backup export', e);
    if (backupStatus) backupStatus.textContent = 'Fehler beim Erstellen der Sicherung: ' + (e?.message || '');
  } finally {
    backupExportBtn.disabled = false;
  }
};
if (backupImportBtn) backupImportBtn.onclick = () => backupImportFile?.click();
if (backupImportFile) backupImportFile.onchange = async () => {
  const file = backupImportFile.files?.[0];
  backupImportFile.value = '';
  if (!file) return;
  if (!confirm('Sicherung "' + file.name + '" wiederherstellen? Die enthaltenen Funde & Anhänge werden zu den vorhandenen Daten HINZUGEFÜGT (nichts wird gelöscht).')) return;
  if (backupStatus) { backupStatus.hidden = false; backupStatus.textContent = 'Sicherung wird eingelesen…'; }
  try {
    const res = await importBackup(file, (done, total) => {
      if (backupStatus) backupStatus.textContent = `Anhänge werden wiederhergestellt… ${done}/${total}`;
    });
    await hydrateAttachments();
    refresh();
    if (backupStatus) backupStatus.textContent = `✅ Wiederhergestellt: ${res.detCount} Funde, ${res.attCount} Anhänge`;
    showInfoToast('Sicherung wiederhergestellt', res.detCount + ' Funde, ' + res.attCount + ' Anhänge importiert.', '💾');
  } catch (e) {
    console.warn('backup import', e);
    if (backupStatus) backupStatus.textContent = 'Fehler: ' + (e?.message || 'Wiederherstellung fehlgeschlagen');
  }
};

// ---- Gesamte Datenbank zurücksetzen ----
const dbResetBtn = document.getElementById('dbResetBtn');
if (dbResetBtn) dbResetBtn.onclick = async () => {
  if (!confirm('Wirklich ALLE Funde unwiderruflich löschen? Das betrifft die komplette Datenbank (Karte, Sammlung, Statistik, eigene Aufnahmen & Fotos).')) return;
  try { await clearAll(); } catch (e) { console.warn('clearAll', e); }
  await hydrateAttachments();
  refresh();
  showInfoToast('Daten gelöscht', 'Alle Funde, Aufnahmen und Fotos wurden entfernt.', '🗑️');
};

function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---- Ergebnis-Popup der gemeinsamen Ruf-Ortung (js/locate.js) ----
// Kompass-Visualisierung: zeigt die Verbindungslinie zwischen den beiden Handys (Norden oben,
// zuverlässig aus GPS berechnet) mit einem Leuchtpunkt an der näheren Seite. BEWUSST keine
// einzelne "Pfeil zeigt genau zum Vogel"-Darstellung — mit nur zwei Empfängern ist die Vorne-
// /Hinten-Seite der Basislinie physikalisch nicht auflösbar (bräuchte einen dritten Referenzpunkt),
// eine scheinbar präzise Pfeilrichtung wäre also die Hälfte der Zeit einfach falsch.
function _compassSvg(r) {
  const size = 140, cx = size / 2, cy = size / 2, R = 54;
  const rad = deg => (deg - 90) * Math.PI / 180; // 0° = oben (Norden)
  const peerAngle = r.bearingToPeer;
  const px = cx + R * Math.cos(rad(peerAngle)), py = cy + R * Math.sin(rad(peerAngle));
  const meCloser = r.firstHeard === 'me', peerCloser = r.firstHeard === 'peer';
  const meR = 8 + (meCloser ? 5 : 0), peerR = 8 + (peerCloser ? 5 : 0);
  const ticks = [0, 90, 180, 270].map(a => {
    const x1 = cx + (R + 6) * Math.cos(rad(a)), y1 = cy + (R + 6) * Math.sin(rad(a));
    const x2 = cx + (R + 14) * Math.cos(rad(a)), y2 = cy + (R + 14) * Math.sin(rad(a));
    const lx = cx + (R + 24) * Math.cos(rad(a)), ly = cy + (R + 24) * Math.sin(rad(a));
    const label = ['N', 'O', 'S', 'W'][a / 90];
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--faint)" stroke-width="1.5"/><text x="${lx}" y="${ly + 4}" text-anchor="middle" font-size="11" fill="var(--faint)" font-family="Inter,sans-serif">${label}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block;margin:6px auto">
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--stroke)" stroke-width="1.5"/>
    ${ticks}
    <line x1="${cx}" y1="${cy}" x2="${px}" y2="${py}" stroke="var(--lime)" stroke-width="2" stroke-dasharray="${peerCloser || meCloser ? '0' : '3,3'}" opacity=".7"/>
    <circle cx="${cx}" cy="${cy}" r="${meR}" fill="${meCloser ? '#67e8f9' : 'var(--glass-strong)'}" stroke="#04130d" stroke-width="2"/>
    <circle cx="${px}" cy="${py}" r="${peerR}" fill="${peerCloser ? 'var(--amber,#fbbf24)' : 'var(--glass-strong)'}" stroke="#04130d" stroke-width="2"/>
    <text x="${cx}" y="${cy + meR + 13}" text-anchor="middle" font-size="9" fill="var(--muted)" font-family="Inter,sans-serif">Du</text>
    <text x="${px}" y="${py + peerR + 13}" text-anchor="middle" font-size="9" fill="var(--muted)" font-family="Inter,sans-serif">Partner</text>
  </svg>`;
}

function showLocateResult(r) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(2,8,6,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)';
  const partnerLabel = hub.peerCount() > 1 ? 'Partner ' + r.peerId : 'dein Partner';
  // Ohne direkten Uhren-Abgleich (z.B. Speiche-zu-Speiche im Stern-Modell, über die Zentrale
  // weitergeleitet) gibt es ehrlich keine "wer war näher"-Aussage — lieber das offen zeigen als
  // eine falsche Vermutung ("gleichzeitig") vorzutäuschen.
  const whoLine = r.firstHeard === 'me' ? '💡 Du hast ihn zuerst gehört — Quelle vermutlich näher an dir'
    : r.firstHeard === 'peer' ? `💡 ${partnerLabel} hat ihn zuerst gehört — Quelle vermutlich näher an ${hub.peerCount() > 1 ? 'ihm/ihr' : 'ihm'}`
    : r.firstHeard === 'both' ? '💡 Fast gleichzeitig gehört — Quelle vermutlich mittig zwischen euch'
    : `💡 Auch von ${partnerLabel} gehört — ohne direkten Uhren-Abgleich lässt sich nicht sagen, wer näher dran war.`;
  const hasGeo = r.bearingToPeer != null && r.baselineM != null;
  const compassBlock = hasGeo
    ? `${_compassSvg(r)}<div style="font-size:11px;color:var(--faint);margin-top:2px">Nur die Seite (näher an dir/Partner) ist zuverlässig — eine genaue Pfeilrichtung würde mehr Präzision vortäuschen, als zwei Mikrofone hergeben. ${r.sideHint || ''}</div>`
    : `<div style="font-size:12px;color:var(--muted);margin-top:10px">Kein GPS bei einem der Geräte — keine Peilung möglich.</div>`;
  const deltaLine = r.deltaMs != null ? 'gemeinsam geortet — Zeitversatz ' + r.deltaMs + ' ms' : 'gemeinsam geortet mit ' + partnerLabel;
  ov.innerHTML = `<div style="background:linear-gradient(160deg,#0c2a1a,#061a0f);border:1px solid var(--stroke);border-radius:24px;padding:26px 26px 20px;text-align:center;max-width:280px;width:88%">
    <div style="font-size:18px;font-weight:700;color:var(--lime);font-family:'Outfit',sans-serif;margin-bottom:4px">${r.species}</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px">${deltaLine}</div>
    <div style="font-size:13px;color:var(--ink);line-height:1.4">${whoLine}</div>
    ${r.firstHeard != null ? compassBlock : ''}
    <button id="_locResultClose" style="width:100%;margin-top:14px;padding:11px;border-radius:14px;background:var(--lime);color:#04130d;font-weight:700;font-size:14px;border:none;cursor:pointer;font-family:'Outfit',sans-serif">Alles klar</button>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#_locResultClose').onclick = close;
  setTimeout(close, 14000);
}

// Gemeinsamer Session-Bericht: führt die eigenen Funde seit Sessionbeginn mit denen des Partners
// zusammen. Partner-Daten kommen über den Datenkanal (js/session.js) -> IMMER per textContent
// rendern, nie per innerHTML, genau wie beim Chat (fremder Input ist nicht vertrauenswürdig).
function showSessionReport(myDets, peerResults) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(2,8,6,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)';
  const card = document.createElement('div');
  card.style.cssText = "background:linear-gradient(160deg,#0c2a1a,#061a0f);border:1px solid var(--stroke);border-radius:24px;padding:22px 22px 18px;max-width:340px;width:90%;max-height:80vh;display:flex;flex-direction:column;font-family:'Outfit',sans-serif";
  const title = document.createElement('div');
  title.style.cssText = 'font-size:18px;font-weight:700;color:var(--lime)';
  title.textContent = '📋 Gemeinsamer Bericht';
  const sub = document.createElement('div');
  sub.style.cssText = "font-size:12px;color:var(--muted);margin:4px 0 12px;font-family:'Inter',sans-serif";
  sub.textContent = peerResults.length
    ? 'Funde von dir + ' + peerResults.length + ' Partner-Handy' + (peerResults.length === 1 ? '' : 's') + ' zusammengeführt'
    : 'Kein Partner hat geantwortet — zeigt nur deine eigenen Funde';

  // Artname -> Map(Quelle -> Anzahl); Quelle ist 'me' oder eine peerId.
  const tally = new Map();
  const addDets = (dets, source) => {
    for (const d of dets) {
      const sp = typeof d.species === 'string' && d.species ? d.species : 'Unbekannt';
      let bySource = tally.get(sp);
      if (!bySource) { bySource = new Map(); tally.set(sp, bySource); }
      bySource.set(source, (bySource.get(source) || 0) + 1);
    }
  };
  addDets(myDets, 'me');
  for (const { peerId, dets } of peerResults) addDets(dets, peerId);
  const totalFor = bySource => [...bySource.values()].reduce((a, b) => a + b, 0);
  const sorted = [...tally.entries()].sort((a, b) => totalFor(b[1]) - totalFor(a[1]));

  const list = document.createElement('div');
  list.style.cssText = "overflow-y:auto;display:flex;flex-direction:column;gap:8px;font-family:'Inter',sans-serif";
  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'font-size:13px;color:var(--muted);text-align:center;padding:20px 0';
    empty.textContent = 'Noch keine Funde in dieser Session.';
    list.appendChild(empty);
  }
  for (const [species, bySource] of sorted) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px;background:var(--glass);border-radius:12px;padding:9px 12px';
    const nameSpan = document.createElement('span'); nameSpan.style.cssText = 'color:var(--ink)'; nameSpan.textContent = species;
    const countSpan = document.createElement('span'); countSpan.style.cssText = 'color:var(--muted);font-size:11.5px;white-space:nowrap';
    const parts = ['du ' + (bySource.get('me') || 0)];
    for (const { peerId } of peerResults) parts.push('Partner ' + peerId + ' ' + (bySource.get(peerId) || 0));
    countSpan.textContent = totalFor(bySource) + '× (' + parts.join(', ') + ')';
    row.append(nameSpan, countSpan);
    list.appendChild(row);
  }

  const totalAll = myDets.length + peerResults.reduce((a, p) => a + p.dets.length, 0);
  const totalLine = document.createElement('div');
  totalLine.style.cssText = "font-size:11.5px;color:var(--faint);margin:10px 0 2px;font-family:'Inter',sans-serif";
  totalLine.textContent = 'Insgesamt ' + totalAll + ' Funde, ' + sorted.length + ' Arten';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Schließen';
  closeBtn.style.cssText = "width:100%;margin-top:12px;padding:11px;border-radius:14px;background:var(--lime);color:#04130d;font-weight:700;font-size:14px;border:none;cursor:pointer;font-family:'Outfit',sans-serif";
  closeBtn.onclick = () => ov.remove();

  card.append(title, sub, list, totalLine, closeBtn);
  ov.appendChild(card);
  document.body.appendChild(ov);
}

// ---- Partner koppeln (WebRTC + QR) + gemeinsame Ruf-Ortung sobald verbunden ----
function initPairing() {
  const openBtn = document.getElementById('pairOpenBtn');
  const modal = document.getElementById('pairModal');
  if (!openBtn || !modal) return;
  const scrim = document.getElementById('pairScrim');
  const closeBtn = document.getElementById('pairCloseBtn');
  const choice = document.getElementById('pairChoice');
  const showBtn = document.getElementById('pairShowBtn');
  const scanBtn = document.getElementById('pairScanBtn');
  const showStep = document.getElementById('pairShowStep');
  const scanStep = document.getElementById('pairScanStep');
  const answerStep = document.getElementById('pairAnswerStep');
  const connectedStep = document.getElementById('pairConnectedStep');
  const status = document.getElementById('pairStatus');
  const qrCanvas = document.getElementById('pairQrCanvas');
  const scanVideo = document.getElementById('pairScanVideo');
  const scanCamSelect = document.getElementById('pairScanCamSelect');
  const scanStatus = document.getElementById('pairScanStatus');
  const answerQrCanvas = document.getElementById('pairAnswerQrCanvas');
  const answerStatus = document.getElementById('pairAnswerStatus');
  const showScanAnswerBtn = document.getElementById('pairShowScanAnswerBtn');
  const chatList = document.getElementById('pairChatList');
  const chatInput = document.getElementById('pairChatInput');
  const chatSend = document.getElementById('pairChatSend');

  let scanStream = null, stopScan = null, pendingPc = null, modulesAttached = false;
  // Eine Verbindung pro gekoppeltem Gerät (Stern-Modell: mehr als eine gleichzeitig möglich) —
  // peerId -> { pc, stopQuality, reconnectTimer }.
  const connections = new Map();
  const peerSignalLevels = new Map(); // peerId -> Signal-Level, fürs schwächste Glied im Chip

  function stopCamera() {
    if (stopScan) { stopScan(); stopScan = null; }
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    scanVideo.srcObject = null;
  }

  // Verbindungs-Badge oben in der Topbar (Lauschen-Tab) — zeigt Status + grobe Verbindungsqualität
  // (Paketlaufzeit, nicht echte WLAN-Signalstärke — die ist über Web-APIs nicht abfragbar). Bei
  // mehreren gekoppelten Geräten (Stern-Modell) zeigt der Text die Anzahl, das Signal-Icon das
  // schwächste Glied unter allen gleichzeitigen Verbindungen.
  const pairChip = document.getElementById('pairStatusChip');
  const pairChipTxt = document.getElementById('pairStatusTxt');
  const pairSignalIco = document.getElementById('pairSignalIco');
  function setPairChip(visible, text) {
    if (!pairChip) return;
    pairChip.hidden = !visible;
    pairChip.classList.toggle('loc-off', !visible);
    if (text && pairChipTxt) pairChipTxt.textContent = text;
  }
  function updatePairSignal(level) {
    if (!pairSignalIco) return;
    const bars = pairSignalIco.querySelectorAll('rect');
    bars.forEach((bar, i) => { bar.style.opacity = level != null && i < level ? '1' : '.35'; });
  }
  function updatePeerSignal(peerId, level) {
    peerSignalLevels.set(peerId, level);
    const levels = [...peerSignalLevels.values()].filter(l => l != null);
    updatePairSignal(levels.length ? Math.min(...levels) : null);
  }
  // Wer die "Zentrale" ist, ergibt sich rein aus der Verbindungszahl (js/peerhub.js): 2+ gleich-
  // zeitige Verbindungen -> man IST die Zentrale. Mit genau einer Verbindung sagt einem die
  // Gegenstelle per kleinem Meta-Protokoll, welche Nummer man selbst bei ihr hat und ob sie ihrer-
  // seits noch mit weiteren Geräten verbunden ist (dann ist SIE die Zentrale).
  function pairStatusText() {
    if (hub.isHost()) return 'Zentrale · ' + hub.peerCount() + ' verbunden';
    const myId = hub.myAssignedId();
    const idTxt = myId != null ? 'Du: Partner ' + myId : 'Verbunden';
    return hub.remotePeerCount() > 1 ? idTxt + ' · mit Zentrale verbunden' : idTxt;
  }
  function refreshPeerChip() {
    const n = hub.peerCount();
    setPairChip(n > 0, n > 0 ? pairStatusText() : null);
    updateMiniChips();
  }
  function renderPeerList() {
    const el = document.getElementById('pairPeerList');
    if (!el) return;
    el.innerHTML = '';
    if (hub.isHost()) {
      const head = document.createElement('div');
      head.className = 'pair-peer-row pair-peer-head';
      head.textContent = '⭐ Du bist die Zentrale';
      el.appendChild(head);
      for (const { id } of hub.peerList()) {
        const row = document.createElement('div');
        row.className = 'pair-peer-row';
        row.textContent = '🟢 Partner ' + id;
        el.appendChild(row);
      }
    } else if (hub.peerCount() === 1) {
      const row = document.createElement('div');
      row.className = 'pair-peer-row';
      const myId = hub.myAssignedId();
      const who = myId != null ? ' — du bist Partner ' + myId : '';
      row.textContent = hub.remotePeerCount() > 1 ? '🟢 Verbunden mit der Zentrale' + who : '🟢 Verbunden' + who;
      el.appendChild(row);
    }
  }
  // Mini-Symbol auf den anderen Tabs (Karte/Sammlung/Statistik/Ornithologie) — dort reicht ein
  // reines Icon ohne Text/Signalbalken, Details gibt's per Tap zurück zum Kopplungs-Fenster.
  function updateMiniChips() {
    const chips = document.querySelectorAll('.pair-mini-chip');
    const connected = hub.peerCount() > 0;
    const title = connected ? pairStatusText() : '';
    chips.forEach(chip => { chip.hidden = !connected; chip.title = title; });
  }
  document.querySelectorAll('.pair-mini-chip').forEach(chip => { chip.onclick = () => openBtn.click(); });
  hub.onTopoChange(() => { refreshPeerChip(); renderPeerList(); });
  if (pairChip) pairChip.onclick = () => {
    document.querySelector('.nav button[data-v="orni"]')?.click();
    document.querySelector('#orniToggle button[data-tab="monitoring"]')?.click();
    openBtn.click();
  };

  // Partner-Text ist fremder Input -> IMMER textContent, nie innerHTML (siehe die BirdNET-XSS-Lücke,
  // die wir schon einmal an anderer Stelle gefunden & gefixt haben — hier von Anfang an sauber).
  function appendChatBubble(msg) {
    if (!chatList) return;
    const row = document.createElement('div');
    row.className = 'pair-chat-row ' + (msg.from === 'me' ? 'me' : 'peer');
    // Bei mehr als einem gekoppelten Gerät (Stern-Modell) dazuschreiben, von wem die Nachricht
    // kam — bei nur einem Partner ist das redundant (klar, wer sonst).
    const wrap = document.createElement('div');
    wrap.className = 'pair-chat-col';
    if (msg.from !== 'me' && hub.peerCount() > 1) {
      const fromLabel = document.createElement('div');
      fromLabel.className = 'pair-chat-from';
      fromLabel.textContent = 'Partner ' + msg.from;
      wrap.appendChild(fromLabel);
    }
    if (msg.kind === 'voice') {
      const bubble = document.createElement('div');
      bubble.className = 'pair-chat-bubble pair-chat-voice';
      const audioEl = document.createElement('audio');
      audioEl.src = msg.url; audioEl.preload = 'metadata';
      const playBtn = document.createElement('button');
      playBtn.type = 'button'; playBtn.className = 'pair-chat-voice-btn';
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      playBtn.onclick = () => {
        if (audioEl.paused) { audioEl.play().catch(() => {}); playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'; }
        else { audioEl.pause(); }
      };
      audioEl.onended = () => { playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; };
      const durSpan = document.createElement('span');
      durSpan.className = 'pair-chat-voice-dur';
      durSpan.textContent = '🎙️ ' + (msg.durationSec || 0) + 's';
      bubble.append(playBtn, durSpan, audioEl);
      wrap.appendChild(bubble);
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'pair-chat-bubble';
      bubble.textContent = msg.text;
      wrap.appendChild(bubble);
    }
    row.appendChild(wrap);
    chatList.appendChild(row);
    chatList.scrollTop = chatList.scrollHeight;
  }

  function onChatMessage(msg) {
    appendChatBubble(msg);
    // Wenn das Kopplungs-Fenster gerade nicht offen ist, trotzdem kurz benachrichtigen.
    if (!modal.classList.contains('open')) {
      const preview = msg.kind === 'voice' ? '🎙️ Sprachnachricht (' + (msg.durationSec || 0) + 's)' : msg.text;
      const title = hub.peerCount() > 1 ? '💬 Nachricht von Partner ' + msg.from : '💬 Nachricht vom Partner';
      showInfoToast(title, preview, '💬');
    }
  }

  function sendChat() {
    if (!chatInput) return;
    const msg = chat.send(chatInput.value);
    if (!msg) return;
    appendChatBubble(msg);
    chatInput.value = '';
  }
  if (chatSend) chatSend.onclick = sendChat;
  if (chatInput) chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });

  // ---- Push-to-Talk: Knopf halten = aufnehmen, loslassen = sofort senden (wie Walkie-Talkie) ----
  const voiceBtn = document.getElementById('pairVoiceBtn');
  const voiceStatus = document.getElementById('pairVoiceStatus');
  const voiceTimer = document.getElementById('pairVoiceTimer');
  let voiceMr = null, voiceChunks = [], voiceStream = null, voiceOwnStream = false, voiceT0 = 0, voiceTimerInt = null, voiceMaxTimeout = null;

  async function startVoiceRecording() {
    if (voiceMr || !chat.isActive()) return;
    // Laufendes Mikro (Lauschen-Modus) wiederverwenden statt ein zweites Mal um Erlaubnis zu
    // fragen — nur wenn nötig eine eigene, separate Aufnahme anfordern.
    if (audio.running && audio.stream) { voiceStream = audio.stream; voiceOwnStream = false; }
    else {
      try { voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true }); voiceOwnStream = true; }
      catch (e) { console.warn('ptt mic', e); return; }
    }
    let type = '';
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { type = t; break; }
    }
    try { voiceMr = type ? new MediaRecorder(voiceStream, { mimeType: type }) : new MediaRecorder(voiceStream); }
    catch (e) { console.warn('ptt mr', e); if (voiceOwnStream) voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; return; }
    voiceChunks = [];
    voiceMr.ondataavailable = e => { if (e.data?.size) voiceChunks.push(e.data); };
    voiceMr.start();
    voiceT0 = Date.now();
    voiceBtn.classList.add('recording');
    if (voiceStatus) voiceStatus.hidden = false;
    voiceTimerInt = setInterval(() => {
      const s = Math.floor((Date.now() - voiceT0) / 1000);
      if (voiceTimer) voiceTimer.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 200);
    voiceMaxTimeout = setTimeout(stopVoiceRecording, chat.MAX_VOICE_SECONDS * 1000);
  }

  function stopVoiceRecording() {
    if (!voiceMr) return;
    clearInterval(voiceTimerInt); voiceTimerInt = null;
    clearTimeout(voiceMaxTimeout); voiceMaxTimeout = null;
    voiceBtn.classList.remove('recording');
    if (voiceStatus) voiceStatus.hidden = true;
    const durationSec = (Date.now() - voiceT0) / 1000;
    const mr = voiceMr; voiceMr = null;
    mr.onstop = async () => {
      if (voiceOwnStream && voiceStream) voiceStream.getTracks().forEach(t => t.stop());
      voiceStream = null;
      if (!voiceChunks.length || durationSec < 0.4) return; // zu kurz, vermutlich Fehlklick
      const blob = new Blob(voiceChunks, { type: voiceChunks[0].type || 'audio/webm' });
      const msg = await chat.sendVoice(blob, durationSec);
      if (msg) appendChatBubble(msg);
    };
    try { mr.stop(); } catch {}
  }

  if (voiceBtn) {
    voiceBtn.addEventListener('pointerdown', e => { e.preventDefault(); startVoiceRecording(); });
    voiceBtn.addEventListener('pointerup', stopVoiceRecording);
    voiceBtn.addEventListener('pointerleave', stopVoiceRecording);
    voiceBtn.addEventListener('pointercancel', stopVoiceRecording);
  }

  // Sobald eine Verbindung steht, bei js/peerhub.js registrieren — die eigentlichen Module
  // (locate/chat/session/filetransfer) werden nur EINMAL angehängt (nicht pro Gerät), da sie über
  // js/peerhub.js automatisch mit ALLEN aktuell gekoppelten Geräten sprechen. Läuft im Hintergrund
  // weiter, auch wenn der Nutzer das Kopplungs-Fenster schließt und normal weiterlauscht.
  function onPeerConnected(dc, pc) {
    const peerId = hub.addPeer(dc);
    const entry = { pc, stopQuality: null, reconnectTimer: null };
    connections.set(peerId, entry);

    if (!modulesAttached) {
      modulesAttached = true;
      locate.attach(showLocateResult, updatePeerMarker);
      chat.attach(onChatMessage);
      session.attach();
      session.startSession();
      filetransfer.attach(onFileReceived, onFileProgress);
      if (chatList) chatList.innerHTML = '';
    }
    if (geo.pos) locate.setLocalPos(geo.pos); // damit auch ein NEU dazugekoppeltes Gerät die eigene Position bekommt
    refreshPeerChip();
    renderPeerList();

    entry.stopQuality = monitorQuality(pc, ({ level }) => updatePeerSignal(peerId, level));
    // Ein kompletter, stiller Neuaufbau ist mit dem QR-Kopplungsansatz nicht möglich (kein
    // laufender Signalisierungskanal für ein neues Angebot/Antwort nach dem einmaligen Scan).
    // ABER: kurze Wackler (WLAN-Hänger, Bildschirm aus) kann WebRTC oft selbst überstehen, wenn
    // man ihm etwas Zeit gibt, statt sofort alles zu kappen — 'disconnected' heißt nicht
    // zwangsläufig 'endgültig weg', erst 'failed'/'closed' oder ein anhaltendes 'disconnected'.
    pc.addEventListener('connectionstatechange', () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
        refreshPeerChip();
      } else if (state === 'disconnected') {
        refreshPeerChip();
        if (!entry.reconnectTimer) {
          entry.reconnectTimer = setTimeout(() => {
            entry.reconnectTimer = null;
            if (pc.connectionState !== 'connected') onPeerDisconnected(peerId);
          }, 12000);
        }
      } else if (state === 'failed' || state === 'closed') {
        if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
        onPeerDisconnected(peerId);
      }
    });
  }

  function onPeerDisconnected(peerId) {
    const entry = connections.get(peerId);
    if (entry?.stopQuality) entry.stopQuality();
    connections.delete(peerId);
    peerSignalLevels.delete(peerId);
    hub.removePeer(peerId);
    updatePeerMarker(peerId, null);
    refreshPeerChip();
    renderPeerList();
    if (connections.size === 0) {
      modulesAttached = false;
      locate.detach();
      chat.detach();
      session.detach();
      filetransfer.detach();
      showInfoToast('📡 Verbindung zum Partner verloren', 'Nicht automatisch behebbar — bitte neu koppeln.', '📡', () => openBtn.click(), 'Neu koppeln');
    } else {
      showInfoToast('📡 Partner ' + peerId + ' getrennt', connections.size + ' Verbindung' + (connections.size === 1 ? '' : 'en') + ' noch aktiv.', '📡');
    }
  }

  function showStep_(name) {
    choice.hidden = name !== 'choice';
    showStep.hidden = name !== 'show';
    scanStep.hidden = name !== 'scan';
    answerStep.hidden = name !== 'answer';
    connectedStep.hidden = name !== 'connected';
    if (name !== 'scan') stopCamera();
  }

  function closeModal() {
    stopCamera();
    // Eine noch unfertige NEUE Kopplung (Schritt 'show'/'scan'/'answer') abbrechen — bereits
    // hergestellte Verbindungen laufen im Hintergrund weiter, wenn der Nutzer das Fenster nur
    // schließt, um wieder normal zu lauschen.
    if (pendingPc) { try { pendingPc.close(); } catch {} pendingPc = null; }
    showScanAnswerBtn.hidden = true;
    modal.classList.remove('open');
  }

  openBtn.onclick = () => {
    // Wenn schon mindestens eine Verbindung steht, nur den Status zeigen statt sie zu kappen —
    // nur bei einem NEUEN Kopplungsversuch (noch nicht verbunden) eine evtl. unfertige
    // Verbindung aufräumen.
    if (hub.peerCount() > 0) {
      renderPeerList();
      showStep_('connected');
    } else {
      if (pendingPc) { try { pendingPc.close(); } catch {} pendingPc = null; }
      showStep_('choice');
    }
    modal.classList.add('open');
  };
  closeBtn.onclick = closeModal;
  if (scrim) scrim.onclick = closeModal;

  // ---- Weiteres Handy koppeln (Stern-Modell) — bestehende Verbindungen bleiben unangetastet ----
  const addDeviceBtn = document.getElementById('pairAddDeviceBtn');
  if (addDeviceBtn) addDeviceBtn.onclick = () => {
    if (pendingPc) { try { pendingPc.close(); } catch {} pendingPc = null; }
    showStep_('choice');
  };

  // Auf Handys mit mehreren Rückkamera-Objektiven (Ultra-Weit/Normal/Tele) per Auswahl das
  // passende für den QR-Scan wählen lassen — Ultra-Weit fokussiert oft schlechter aus der Nähe,
  // Tele kann bei sehr kleinen/dichten Codes schärfer sein. Labels sind erst NACH einer erteilten
  // Kamera-Erlaubnis aussagekräftig, darum wird hier erst nach dem ersten Stream aufgezählt.
  let currentScanOnDecoded = null, currentScanStatusEl = null;
  async function _populateScanCamSelect() {
    if (!scanCamSelect) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const back = all.filter(d => d.kind === 'videoinput' && !/front|facetime|user|selfie/i.test(d.label));
      const ultraWide = back.find(d => /ultra/i.test(d.label));
      const wide = back.find(d => !/ultra|telephoto|tele|[23]\.?\d?x\b/i.test(d.label)) || back[0];
      const tele = back.find(d => /telephoto|tele|[23]\.?\d?x\b/i.test(d.label) && d !== wide);
      const chosen = [ultraWide, wide, tele].filter(Boolean);
      if (chosen.length < 2) { scanCamSelect.hidden = true; return; }
      const prevValue = scanCamSelect.value;
      scanCamSelect.innerHTML = chosen.map(d => {
        const name = /ultra/i.test(d.label) ? '📷 Ultra-Weit (0.5×)' : /telephoto|tele|[23]\.?\d?x\b/i.test(d.label) ? '🔭 Tele' : '📷 Normal (1×)';
        return `<option value="${d.deviceId}">${name}</option>`;
      }).join('');
      if (prevValue && chosen.some(d => d.deviceId === prevValue)) scanCamSelect.value = prevValue;
      scanCamSelect.hidden = false;
    } catch (e) { console.warn('scan cam enumerate', e); }
  }
  if (scanCamSelect) scanCamSelect.onchange = () => {
    if (currentScanOnDecoded) startScan(currentScanOnDecoded, currentScanStatusEl);
  };

  async function startScan(onDecoded, statusEl) {
    stopCamera();
    currentScanOnDecoded = onDecoded; currentScanStatusEl = statusEl;
    try {
      const camId = scanCamSelect && scanCamSelect.value ? scanCamSelect.value : null;
      const videoConstraints = camId ? { deviceId: { exact: camId } } : { facingMode: 'environment' };
      scanStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
      scanVideo.srcObject = scanStream;
      await scanVideo.play().catch(() => {});
      stopScan = scanQR(scanVideo, onDecoded);
      _populateScanCamSelect();
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Kamera nicht verfügbar: ' + (e?.message || '');
    }
  }

  // ---- Seite A: "QR-Code zeigen" (Angebot erstellen) ----
  showBtn.onclick = async () => {
    showStep_('show');
    status.textContent = 'Code wird erstellt…';
    showScanAnswerBtn.hidden = true;
    let offerer;
    try {
      offerer = await createOfferer();
      pendingPc = offerer.pc;
      renderQR(offerer.qrText, qrCanvas);
      status.textContent = 'Lass das andere Handy diesen Code scannen';
      showScanAnswerBtn.hidden = false;
    } catch (e) {
      status.textContent = 'Fehler: ' + (e?.message || 'Verbindung konnte nicht vorbereitet werden');
      return;
    }
    async function onAnswerScanned(text) {
      try {
        await offerer.applyAnswer(text);
        showStep_('connected');
        connectedStep.querySelector('#pairConnectedSub').textContent = 'Verbinde…';
        const dc = await waitForOpen(offerer.dc);
        const pc = pendingPc; pendingPc = null;
        onPeerConnected(dc, pc);
        connectedStep.querySelector('#pairConnectedSub').textContent = 'Verbunden — Ruf-Ortung läuft jetzt automatisch mit.';
      } catch (err) {
        scanStatus.textContent = 'Ungültiger Code oder Verbindung fehlgeschlagen — bitte erneut versuchen.';
        startScan(onAnswerScanned, scanStatus);
      }
    }
    showScanAnswerBtn.onclick = () => {
      showStep_('scan');
      scanStatus.textContent = 'Richte die Kamera auf den Antwort-Code…';
      startScan(onAnswerScanned, scanStatus);
    };
  };

  // ---- Seite B: "QR-Code scannen" (Angebot einlesen, Antwort zurückgeben) ----
  async function onOfferScanned(text) {
    let answerer;
    try {
      answerer = await createAnswerer(text);
    } catch (e) {
      scanStatus.textContent = 'Ungültiger Code — bitte erneut versuchen.';
      startScan(onOfferScanned, scanStatus);
      return;
    }
    pendingPc = answerer.pc;
    showStep_('answer');
    renderQR(answerer.qrText, answerQrCanvas);
    answerStatus.textContent = 'Zeig dieses Handy jetzt dem Partner — Warte auf Verbindung…';
    try {
      const dc = await waitForOpen(answerer.dc);
      const pc = pendingPc; pendingPc = null;
      onPeerConnected(dc, pc);
      showStep_('connected');
      connectedStep.querySelector('#pairConnectedSub').textContent = 'Verbunden — Ruf-Ortung läuft jetzt automatisch mit.';
    } catch (err) {
      answerStatus.textContent = 'Verbindung fehlgeschlagen: ' + (err?.message || '');
    }
  }
  scanBtn.onclick = () => {
    showStep_('scan');
    scanStatus.textContent = 'Richte die Kamera auf den Code des anderen Handys…';
    startScan(onOfferScanned, scanStatus);
  };

  // ---- Gemeinsamer Session-Bericht ----
  session.setDetectionsProvider(async startTs => {
    try { return (await allDetections()).filter(d => d.ts >= startTs).map(d => ({ species: d.species, ts: d.ts })); }
    catch { return []; }
  });
  const sessionReportBtn = document.getElementById('pairSessionReportBtn');
  if (sessionReportBtn) sessionReportBtn.onclick = async () => {
    sessionReportBtn.disabled = true;
    const orig = sessionReportBtn.textContent;
    sessionReportBtn.textContent = 'Frage Partner…';
    try {
      const startTs = session.getSessionStart();
      let myDets = [];
      try { myDets = (await allDetections()).filter(d => d.ts >= startTs); } catch {}
      const peerResults = await session.requestAllPeerDetections(startTs);
      showSessionReport(myDets, peerResults);
    } finally {
      sessionReportBtn.disabled = false;
      sessionReportBtn.textContent = orig;
    }
  };

  // ---- Foto/Video direkt an alle gekoppelten Handys (ganz ohne Internet, über den Datenkanal) ----
  function onFileProgress({ direction, sent, total }) {
    if (direction !== 'receive') return;
    if (sent === 1) showInfoToast('📲 Empfange Datei…', 'Von einem Partner-Handy — bitte warten.', '📲');
  }
  async function onFileReceived({ blob, kind, name, mime, peerId }) {
    const label = 'Von Partner ' + peerId + (name ? ': ' + name : '');
    let attId = null;
    try { attId = await addAttachment({ key: null, label, kind, blob, mime: mime || blob.type }); }
    catch (e) { console.warn('addAttachment (partner file)', e); }
    const list = document.getElementById('recList');
    if (list) list.prepend(attachmentRow({ blob, kind, label, mime: mime || blob.type, key: null, id: attId, ts: Date.now() }));
    showInfoToast('📲 Von Partner ' + peerId + ' erhalten', (kind === 'video' ? 'Video' : 'Foto') + ' angekommen — in der Galerie.', '📲');
    if (!galleryModal || !galleryModal.classList.contains('open')) galleryBadgeAdd(1);
  }
}
initPairing();

boot();
