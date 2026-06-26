// Orchestrierung: verdrahtet Audio -> Erkennung -> Speicher -> UI.
import { AudioEngine, enhanceSamples, enhanceBlob } from './audio.js';
import { createRecognizer, MockRecognizer, encodeWav } from './recognizer.js';
import { addDetection, allDetections, seedIfEmpty, computeStats, migrateGeo, cleanupFakeGeo, todayNearbyDetections, deleteByIds, clearAll, qualifyingDetections, addAttachment, allAttachments, latestAudioAttachmentsByKey, deleteAttachment } from './db.js';
import { initUI, renderAll, liveAdd, renderMap, setLivePos, registerRecording, unregisterRecording, clearRecordings, renderLive, showInfoToast, sharePhotoCard, updateRouteMap, openTimingModal } from './ui.js';
import { fetchWeather, fetchPhotoWeather, fetchTomorrowMorning, fetchMoonTimes, fetchTodayHours, weatherEmoji, weatherLabel, windDirLabel, moonPhase, moonPhaseLabel, uvLabel, moonCalendar, reverseGeocode } from './weather.js';
import { routeTracker } from './route.js';
import { checkAlarms, getFotoWecker, getDauerUeberwachung, getSunriseFull } from './alarm.js';
import { openCamera } from './camera.js';
import { initOrni } from './ornithologie.js';

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

function wireSplash() {
  const splash = document.getElementById('splash');
  const btn = document.getElementById('splashContinue');
  if (!splash) return;
  const hide = () => splash.classList.add('hide');
  if (btn) {
    setTimeout(() => btn.classList.add('show'), 2000);
    btn.addEventListener('click', hide, { once: true });
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
    audio.start()
      .then(() => { geo.start(); detectionActive = true; setUI('mic'); if (recBtn) recBtn.classList.add('rec-on'); routeTracker.start(); updateRouteToggleBtn(true); startDauerUeberwachung(); })
      .catch(e => {
        console.warn('alarm mic', e);
        showInfoToast(title, 'Mikrofon-Freigabe nötig — tippe zum Starten.', icon, () => toggleDetection(), 'Lauschen starten');
      });
  }
}

async function onWindow(samples, sampleRate) {
  if (!rec || !detectionActive) return;
  if (rec.setGeo) rec.setGeo(geo.pos);   // Standort für bessere Treffer (Server-Modus)
  let r = null;
  try { r = await rec.classify(samples, sampleRate); } catch (e) { console.warn('classify', e); }
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

function _makeAudioIcon() {
  const el = document.createElement('div'); el.className = 'rec-media-icon';
  el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="22" height="22"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
  return el;
}

async function _saveAutoRecRow(det, blob, mime) {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = det.species.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const gpsTag = geo.pos ? '_' + geo.pos.lat.toFixed(4) + '_' + geo.pos.lng.toFixed(4) : '';
  const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'm4a' : 'webm';
  const url = URL.createObjectURL(blob);
  const row = document.createElement('div'); row.className = 'rec-row';
  const a = document.createElement('audio'); a.controls = true; a.src = url; a.preload = 'metadata';
  wireAudioRouting(a);
  const lb = document.createElement('span'); lb.className = 'rec-label auto'; lb.textContent = det.species + ' · auto';
  const dl = makeDownloadBtn(url, prefix + '_' + stamp + gpsTag + '.' + ext, det.species);
  let attId = null;
  try { attId = await addAttachment({ detId: det.id ?? null, key: det.key, label: det.species, kind: 'audio', blob, mime }); }
  catch (e) { console.warn('addAttachment', e); }
  const del = makeDeleteBtn(row, url, det.key, attId);
  row.append(_makeAudioIcon(), lb, _spacer(), dl, _makeScissorsBtn(row), del, a);
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
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 6 9M20 20 6 15"/></svg>';
  btn.onclick = () => _toggleTrimPanel(row);
  return btn;
}

async function _toggleTrimPanel(row) {
  const existing = row.querySelector('.rec-trim-panel');
  if (existing) { existing.remove(); return; }
  const audio = row.querySelector('audio');
  if (!audio?.src) return;
  const panel = document.createElement('div'); panel.className = 'rec-trim-panel';
  panel.innerHTML = '<span class="tr-lbl">Lade…</span>';
  row.appendChild(panel);
  let decoded;
  try {
    const ab = await fetch(audio.src).then(r => r.arrayBuffer());
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    decoded = await new Promise((res, rej) => tmp.decodeAudioData(ab, res, rej));
    tmp.close().catch(() => {});
  } catch { panel.innerHTML = '<span class="tr-lbl" style="color:var(--rose)">Fehler</span>'; return; }
  const dur = decoded.duration.toFixed(1);
  panel.innerHTML = `<span class="tr-lbl">Von</span><input type="number" class="tr-inp tr-s" min="0" max="${dur}" step="0.1" value="0"><span class="tr-lbl">bis</span><input type="number" class="tr-inp tr-e" min="0" max="${dur}" step="0.1" value="${dur}"><span class="tr-lbl">Sek</span><button class="tr-go">✂ Zuschneiden</button>`;
  panel.querySelector('.tr-go').onclick = async () => {
    const start = Math.max(0, parseFloat(panel.querySelector('.tr-s').value) || 0);
    const end = Math.min(decoded.duration, parseFloat(panel.querySelector('.tr-e').value) || decoded.duration);
    if (start >= end) return;
    const sr = decoded.sampleRate;
    const trimmed = decoded.getChannelData(0).slice(Math.floor(start * sr), Math.floor(end * sr));
    const wav = encodeWav(trimmed, sr);
    const newUrl = URL.createObjectURL(wav);
    if (audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    audio.src = newUrl; audio.load();
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

// Teilen-Button für Foto-Zeilen: öffnet Mixer (Foto-Karte teilen ODER Foto+Audio→Video).
function makeShareBtn(url, key, label) {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.title = 'Teilen'; btn.className = 'rec-dl'; btn.style.color = 'var(--muted)';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
  btn.onclick = ev => { ev.stopPropagation(); openShareMixer(url, key, label); };
  return btn;
}

// Baut eine Aufnahme/Foto-Zeile aus einem gespeicherten Anhang (nach Reload) — selbe Optik wie
// frisch erzeugte Zeilen, aber aus dem in IndexedDB gesicherten Blob statt einer Live-Aufnahme.
function attachmentRow(a) {
  const url = URL.createObjectURL(a.blob);
  const row = document.createElement('div'); row.className = 'rec-row';
  if (a.kind === 'audio') {
    const el = document.createElement('audio'); el.controls = true; el.src = url; el.preload = 'metadata';
    wireAudioRouting(el);
    row.appendChild(_makeAudioIcon());
    row.appendChild(el);
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
  if (a.kind === 'audio') row.appendChild(_makeScissorsBtn(row));
  row.appendChild(makeDeleteBtn(row, url, a.key, a.id));
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
    audio.start().then(() => { geo.start(); detectionActive = true; setUI('mic'); if (recBtn) recBtn.classList.add('rec-on'); routeTracker.start(); updateRouteToggleBtn(true); startDauerUeberwachung(); })
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
  try { await audio.start(); geo.start(); setUI('mic-ready'); routeTracker.start(); updateRouteToggleBtn(true); startDauerUeberwachung(); }
  catch (e) { console.warn('mic', e); setUI('off', 'Mikro nicht erlaubt'); }
});

// ---- Tonaufnahme (manuell) ----
const recBtn = document.getElementById('recBtn');
if (recBtn && !window.MediaRecorder) recBtn.style.display = 'none';
const recorder = {
  mr: null, chunks: [], timer: null, t0: 0,
  fmt() { const s = Math.floor((Date.now() - this.t0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); },
  setBtn(on) {
    const cb = document.getElementById('clipBtn'); if (cb) cb.classList.toggle('rec-on', on);
  },
  async toggle(label, key) {
    if (this.mr && this.mr.state === 'recording') { this.mr.stop(); return; }
    if (!audio.running) {
      tryFullscreen();
      try { await audio.start(); geo.start(); }
      catch (e) { console.warn('mic', e); statusTxt.textContent = 'Mikro nicht erlaubt'; return; }
    }
    if (!audio.stream) return;
    let type = '';
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { type = t; break; }
    }
    try { this.mr = type ? new MediaRecorder(audio.stream, { mimeType: type }) : new MediaRecorder(audio.stream); }
    catch (e) { console.warn('rec', e); return; }
    this.chunks = []; this.label = label || null; this.key = key || null;
    this.mr.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mr.onstop = () => { this.setBtn(false); this.save(); };
    this.mr.start();
    this.t0 = Date.now(); this.setBtn(true);
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
    const a = document.createElement('audio'); a.controls = true; a.src = url; a.preload = 'metadata';
    wireAudioRouting(a);
    const dl = makeDownloadBtn(url, name, this.label);
    row.appendChild(_makeAudioIcon());
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
      const goldenBegin = new Date(sun.sunset.getTime() - 45 * 60000);
      html += `<div class="pw-row"><span class="pw-icon">🌇</span><span class="pw-lbl">Goldene Stunde ↓</span><span class="pw-val">${fmt(goldenBegin)} – ${fmt(sun.sunset)}</span></div>`;
      html += `<div class="pw-row"><span class="pw-icon">🌆</span><span class="pw-lbl">Sonnenuntergang</span><span class="pw-val">${fmt(sun.sunset)}</span></div>`;
      if (sun.civilEnd) html += `<div class="pw-row"><span class="pw-icon">🌙</span><span class="pw-lbl">Blaue Stunde ↓</span><span class="pw-val">${fmt(sun.sunset)} – ${fmt(sun.civilEnd)}</span></div>`;
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
  if (moonTimes?.moonrise) html += `<div class="pw-row"><span class="pw-icon">🌙</span><span class="pw-lbl">Mondaufgang</span><span class="pw-val">${fmt(moonTimes.moonrise)}</span></div>`;
  if (moonTimes?.moonset) html += `<div class="pw-row"><span class="pw-icon">🌑</span><span class="pw-lbl">Monduntergang</span><span class="pw-val">${fmt(moonTimes.moonset)}</span></div>`;
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
window.__waldohr = {
  startDetection: async () => {
    if (!audio.running) {
      await audio.start();
      geo.start();
    }
    detectionActive = true;
    setUI('mic');
    if (recBtn) recBtn.classList.add('rec-on');
  },
  stopDetection: () => {
    detectionActive = false;
    setUI(audio.running ? 'mic-ready' : 'off');
    if (recBtn) recBtn.classList.remove('rec-on');
  },
  isDetecting: () => audio.running && detectionActive,
  switchTab: v => { document.querySelector(`.nav button[data-v="${v}"]`)?.click(); },
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
      const lvl = body.classList.contains('listening') ? Math.min(1, Math.max(0, ...last)) : 0;
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

boot();
