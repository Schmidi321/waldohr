// Orchestrierung: verdrahtet Audio -> Erkennung -> Speicher -> UI.
import { AudioEngine, enhanceSamples, enhanceBlob } from './audio.js';
import { createRecognizer, MockRecognizer, encodeWav } from './recognizer.js';
import { addDetection, allDetections, seedIfEmpty, computeStats, migrateGeo, cleanupFakeGeo, todayNearbyDetections, deleteByIds, clearAll, qualifyingDetections, addAttachment, allAttachments, latestAudioAttachmentsByKey, deleteAttachment } from './db.js';
import { initUI, renderAll, liveAdd, renderMap, setLivePos, registerRecording, unregisterRecording, clearRecordings, renderLive, showInfoToast, sharePhotoCard, updateRouteMap, openTimingModal } from './ui.js';
import { fetchWeather } from './weather.js';
import { routeTracker } from './route.js';
import { checkAlarms, getFotoWecker } from './alarm.js';
import { openCamera } from './camera.js';

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
    if (audio.running) { audio.stop(); detectionActive = false; setUI('off'); stopSession(); }
    return;
  }
  const isMC = type === 'morgenchor';
  showInfoToast(isMC ? '🌅 Morgenchor-Alarm' : '🦉 Nacht-Modus', isMC ? 'Sonnenaufgang naht — Lauschen gestartet!' : 'Geplante Zeit — Lauschen gestartet!', isMC ? '🌅' : '🦉');
  if (!audio.running) {
    tryFullscreen();
    audio.start().then(() => { geo.start(); detectionActive = true; setUI('mic'); if (recBtn) recBtn.classList.add('rec-on'); routeTracker.start(); updateRouteToggleBtn(true); }).catch(e => console.warn('alarm mic', e));
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
async function maybeAutoRecord(det, samples, sampleRate) {
  if (det.confidence < getAutoRecordConfidence()) return;
  if (autoRecordedToday().includes(det.key)) return;
  markAutoRecorded(det.key);
  let enhanced = samples;
  try { enhanced = await enhanceSamples(samples, sampleRate); } catch (e) { console.warn('enhance', e); }
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = det.species.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const gpsStr = geo.pos ? geo.pos.lat.toFixed(5) + ',' + geo.pos.lng.toFixed(5) : '';
  const blob = encodeWav(enhanced, sampleRate, {
    name: det.species,
    date: now.toISOString().slice(0, 10) + ' ' + now.toLocaleTimeString('de-DE'),
    comment: gpsStr || undefined
  });
  const url = URL.createObjectURL(blob);
  const gpsTag = geo.pos ? '_' + geo.pos.lat.toFixed(4) + '_' + geo.pos.lng.toFixed(4) : '';
  const row = document.createElement('div'); row.className = 'rec-row';
  const a = document.createElement('audio'); a.controls = true; a.src = url; a.preload = 'metadata';
  wireAudioRouting(a);
  const lb = document.createElement('span'); lb.className = 'rec-label auto'; lb.textContent = det.species + ' · auto';
  const dl = document.createElement('a'); dl.className = 'rec-dl'; dl.href = url; dl.download = prefix + '_' + stamp + gpsTag + '.wav'; dl.textContent = '⬇'; dl.title = 'Herunterladen';
  let attId = null;
  try { attId = await addAttachment({ detId: det.id ?? null, key: det.key, label: det.species, kind: 'audio', blob, mime: 'audio/wav' }); }
  catch (e) { console.warn('addAttachment', e); }
  const del = makeDeleteBtn(row, url, det.key, attId);
  row.append(a, lb, dl, del);
  const list = document.getElementById('recList'); if (list) list.prepend(row);
  registerRecording(det.key, url);
  if (!galleryModal || !galleryModal.classList.contains('open')) galleryBadgeAdd(1);
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

// Teilen-Button für Foto-Zeilen: baut Share-Karte mit eigenem Foto und öffnet nativen Share-Dialog.
function makeShareBtn(url, key, label) {
  const btn = document.createElement('button');
  btn.type = 'button'; btn.title = 'Teilen'; btn.className = 'rec-dl'; btn.style.color = 'var(--muted)';
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
  btn.onclick = async ev => {
    ev.stopPropagation();
    const orig = btn.innerHTML; btn.disabled = true; btn.textContent = '⏳';
    try { await sharePhotoCard(url, key, label, geo.pos); }
    catch (e) { if (e && e.name !== 'AbortError') console.warn('share', e); }
    finally { btn.innerHTML = orig; btn.disabled = false; }
  };
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
    row.appendChild(el);
  } else {
    const img = document.createElement('img'); img.className = 'photo-thumb'; img.src = url; img.alt = a.label || 'Foto';
    img.onclick = () => window.open(url, '_blank');
    row.appendChild(img);
  }
  if (a.label) {
    const lb = document.createElement('span'); lb.className = 'rec-label';
    if (a.kind === 'photo') lb.style.flex = '1';
    lb.textContent = a.label;
    row.appendChild(lb);
  }
  const mime = a.mime || '';
  const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'm4a' : mime.includes('webm') ? 'webm'
    : mime.includes('png') ? 'png' : mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'bin';
  const stamp = new Date(a.ts).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = (a.label || 'waldohr').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const dl = document.createElement('a'); dl.className = 'rec-dl'; dl.href = url; dl.download = prefix + '_' + stamp + '.' + ext; dl.textContent = '⬇'; dl.title = 'Herunterladen';
  row.appendChild(dl);
  if (a.kind === 'photo') row.appendChild(makeShareBtn(url, a.key, a.label));
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
    audio.start().then(() => { geo.start(); detectionActive = true; setUI('mic'); if (recBtn) recBtn.classList.add('rec-on'); routeTracker.start(); updateRouteToggleBtn(true); })
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
    audio.stop(); detectionActive = false; setUI('off');
    stopSession();
    return;
  }
  tryFullscreen();
  try { await audio.start(); geo.start(); setUI('mic-ready'); routeTracker.start(); updateRouteToggleBtn(true); }
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
    const dl = document.createElement('a'); dl.className = 'rec-dl'; dl.href = url; dl.download = name; dl.textContent = '⬇'; dl.title = 'Herunterladen';
    row.appendChild(a);
    if (this.label) { const lb = document.createElement('span'); lb.className = 'rec-label'; lb.textContent = this.label; row.appendChild(lb); }
    row.appendChild(dl);
    let attId = null;
    try { attId = await addAttachment({ key: this.key, label: this.label, kind: 'audio', blob: saveBlob, mime }); }
    catch (e) { console.warn('addAttachment', e); }
    row.appendChild(makeDeleteBtn(row, url, this.key, attId));
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
// Aufnahme-Knopf direkt an einer Live-Zeile -> beschriftet die Aufnahme mit dem Artnamen und
// verknüpft sie mit dem Art-Key, damit sie als kleines Icon in der Sammlung auftaucht.
window.__waldohrRecordSpecies = (name, key) => recorder.toggle(name, key);

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
    const vid = document.createElement('video');
    vid.src = url; vid.controls = true; vid.style.cssText = 'flex:1;max-width:100%;border-radius:8px;min-width:0';
    row.appendChild(vid);
  } else {
    const img = document.createElement('img'); img.className = 'photo-thumb'; img.src = url; img.alt = label || 'Foto';
    img.onclick = () => window.open(url, '_blank');
    row.appendChild(img);
  }
  if (label) { const lb = document.createElement('span'); lb.className = 'rec-label'; lb.style.flex = '1'; lb.textContent = label; row.appendChild(lb); }
  const dl = document.createElement('a'); dl.className = 'rec-dl'; dl.href = url; dl.download = prefix + '_' + stamp + '.' + ext; dl.textContent = '⬇'; dl.title = 'Herunterladen';
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
