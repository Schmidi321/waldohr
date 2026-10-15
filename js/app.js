// Orchestrierung: verdrahtet Audio -> Erkennung -> Speicher -> UI.
import { AudioEngine, enhanceSamples, enhanceBlob } from './audio.js';
import { createRecognizer, MockRecognizer, encodeWav } from './recognizer.js';
import { initOfflineModelSettings, isNativeApp } from './offline-model.js';
import { addDetection, allDetections, seedIfEmpty, computeStats, migrateGeo, cleanupFakeGeo, todayNearbyDetections, deleteByIds, clearAll, qualifyingDetections, addAttachment, allAttachments, latestAudioAttachmentsByKey, deleteAttachment, haversineKm } from './db.js';
import { initUI, renderAll, liveAdd, renderMap, setLivePos, registerRecording, unregisterRecording, clearRecordings, renderLive, showInfoToast, sharePhotoCard, updateRouteMap, openTimingModal, getMicDeviceId, setManualPosHandler, showManualPos, updateScheduleChip, showFotoSegment, isFotoSegment, icon } from './ui.js';
import { fetchWeather, fetchPhotoWeather, fetchTomorrowMorning, fetchMoonTimes, fetchTodayHours, weatherLabel, windDirLabel, moonPhaseLabel, uvLabel, moonCalendar, reverseGeocode } from './weather.js';
import { routeTracker } from './route.js';
import { checkAlarms, getFotoWecker, getDauerUeberwachung, getSunriseFull } from './alarm.js';
import { openCamera } from './camera.js';
import { openScan } from './scan.js';
import { initOrni } from './ornithologie.js';
import { exportBackup, importBackup } from './backup.js';
import { esc, roundCoord } from './util.js';

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
    if (audio.running) { audio.stop(); detectionActive = false; setUI('off'); }
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
// Manuell auf der Karte gesetzte eigene Position: überschreibt GPS für die Koordinaten neuer
// Funde, solange man steht — GPS liegt gerade im Wald oft etliche Meter daneben.
let manualPos = null;
// Die für Fund-Koordinaten und die Karte maßgebliche eigene Position: manuell gesetzt hat Vorrang, sonst GPS.
function myPos() { return manualPos || geo.pos; }

const geo = {
  watchId: null, pos: null, rawPos: null, accuracy: null,
  _buf: [],  // jüngste Rohfixes {lat,lng,acc,t} zur Mittelung im Stand
  // GPS-Mittelung: Fotografen stehen meist still — dann schwankt der reine GPS-Punkt trotzdem um
  // mehrere Meter. Solange die letzten Fixes eng beieinander liegen (Stand), wird accuracy-gewichtet
  // gemittelt (ruhigerer, genauerer Punkt). Bewegt man sich (neuer Fix weit weg vom Mittel), wird
  // der Puffer verworfen und dem neuen Punkt sofort gefolgt — kein "Nachziehen".
  _averaged(lat, lng, acc) {
    const now = Date.now();
    const cur = { lat, lng, acc: acc || 20, t: now };
    // Mittelpunkt der bisherigen Fixes zum Vergleich
    if (this._buf.length) {
      let sl = 0, sn = 0; for (const f of this._buf) { sl += f.lat; sn += f.lng; }
      const c = { lat: sl / this._buf.length, lng: sn / this._buf.length };
      if (haversineKm(c, cur) * 1000 > 20) this._buf = []; // deutlich bewegt -> neu anfangen
    }
    this._buf.push(cur);
    this._buf = this._buf.filter(f => now - f.t < 60000).slice(-40);
    let wsLat = 0, wsLng = 0, wsum = 0;
    for (const f of this._buf) { const w = 1 / Math.max(25, f.acc * f.acc); wsLat += f.lat * w; wsLng += f.lng * w; wsum += w; }
    return { lat: wsLat / wsum, lng: wsLng / wsum };
  },
  start() {
    if (!('geolocation' in navigator)) { setLoc('off', 'kein GPS'); return; }
    if (this.watchId != null) return;
    setLoc('searching', 'Standort: suche…');
    this.watchId = navigator.geolocation.watchPosition(
      p => {
        const had = !!this.pos;
        this.rawPos = { lat: p.coords.latitude, lng: p.coords.longitude };
        this.accuracy = p.coords.accuracy;
        this.pos = this._averaged(this.rawPos.lat, this.rawPos.lng, p.coords.accuracy);
        const nAvg = this._buf.length;
        setLoc('active', 'Standort ±' + Math.round(p.coords.accuracy) + ' m' + (nAvg > 3 ? ' · ⌀' + nAvg : ''));
        // Läuft man deutlich vom manuell gesetzten Punkt weg, ist dieser veraltet -> automatisch lösen.
        if (manualPos && haversineKm(manualPos, this.rawPos) * 1000 > 30) { manualPos = null; showManualPos(null); showInfoToast('📍 Manuelle Position gelöst', 'Du hast dich bewegt — es zählt wieder das echte GPS.', '📍'); }
        setLivePos(myPos());   // live fürs Kompass-Feature, ohne vollen Re-Render
        if (!had) { refresh(); updateScheduleChip(); }   // erster Fix: "Heute hier" + Morgenchor-Startzeit sofort aktualisieren
      },
      e => { console.warn('geo', e); setLoc('off', e.code === 1 ? 'GPS verweigert' : 'kein GPS'); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 }
    );
  },
  stop() { if (this.watchId != null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; } setLoc('off', 'Standort aus'); }
};

// Beim Veröffentlichen mit der SW-Cache-Version (sw.js) gleich halten.
const APP_VERSION = 'v116';
function wireSplash() {
  const splash = document.getElementById('splash');
  const btn = document.getElementById('splashContinue');
  if (!splash) return;
  const ver = document.getElementById('splashVer');
  if (ver) ver.textContent = APP_VERSION;
  const aboutVer = document.getElementById('aboutVer');
  if (aboutVer) aboutVer.textContent = APP_VERSION;
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

async function initRecognizer() {
  const old = rec;
  const next = await createRecognizer();
  try { await next.load(); rec = next; }
  catch (e) {
    console.warn('Recognizer-Fallback auf Mock:', e);
    // Grund explizit setzen (nicht nur per Konstruktor-Argument): so stimmt der Demo-Hinweis auch,
    // falls recognizer.js den Vertrag (fallbackReason) noch nicht oder anders umsetzt.
    const reason = next.id === 'birdnet-server' ? 'unreachable' : 'model-error';
    next.dispose?.();
    rec = new MockRecognizer(reason); rec.fallbackReason = reason;
    await rec.load();
  }
  if (old && old !== rec) old.dispose?.();   // alten Worker (Offline-Modell) freigeben
  updateServerStatusChip();
  updateDemoHint();
}

async function boot() {
  initUI();
  initOrni();
  routeTracker.init(geo);
  routeTracker.onUpdate = pts => updateRouteMap(pts);
  // Manuelle Positions-Korrektur von der Karte: pos=null hebt sie wieder auf.
  setManualPosHandler(pos => {
    manualPos = pos;
    setLivePos(myPos());
    if (pos) showInfoToast('📍 Position gesetzt', 'Deine Position wurde manuell gesetzt — neue Funde bekommen diese Koordinaten. Bewegst du dich, gilt wieder GPS.', '📍');
    else showInfoToast('📍 GPS aktiv', 'Manuelle Position aufgehoben — es zählt wieder das echte GPS.', '📍');
    refresh();
  });
  try { await seedIfEmpty(); } catch (e) { console.warn('seed', e); }
  try { await migrateGeo(); } catch (e) { console.warn('migrateGeo', e); }
  try { const n = await cleanupFakeGeo(); if (n) console.info(n + ' Fund(e) hatten eine falsche Fake-Position (Bug) — Koordinaten entfernt.'); } catch (e) { console.warn('cleanupFakeGeo', e); }
  await refresh();
  hydrateAttachments();
  geo.start();
  checkAlarms(geo.pos?.lat, geo.pos?.lng, onAlarm);
  setInterval(() => checkAlarms(geo.pos?.lat, geo.pos?.lng, onAlarm), 60000);

  await initRecognizer();
  // Einstellungen → Offline-Erkennung: nach Download/Entfernen den Erkenner ohne Neustart tauschen.
  initOfflineModelSettings(initRecognizer);

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
    if (audio.running) { stopDauerUeberwachung(); audio.stop(); detectionActive = false; setUI('off'); }
    return;
  }
  const isMC = type === 'morgenchor';
  const icon = isMC ? '🌅' : '🦉';
  const title = isMC ? '🌅 Morgenchor-Alarm' : '🦉 Nacht-Modus';
  showInfoToast(title, isMC ? 'Sonnenaufgang naht — Lauschen gestartet!' : 'Geplante Zeit — Lauschen gestartet!', icon);
  if (!audio.running) {
    tryFullscreen();
    audio.start(getMicDeviceId())
      .then(() => { geo.start(); detectionActive = true; setUI('mic'); startDauerUeberwachung(); })
      .catch(e => {
        console.warn('alarm mic', e);
        showInfoToast(title, 'Mikrofon-Freigabe nötig — tippe zum Starten.', icon, () => toggleDetection(), 'Lauschen starten');
      });
  } else if (!detectionActive) {
    // Mikro lief schon (z. B. für einen Tonclip), aber ohne Erkennung — jetzt mit einschalten.
    detectionActive = true; setUI('mic');
  }
}

// Erkennungs-Chip in der Kopfzeile: Demo (gelb/rot), Offline (grün, Handy rechnet selbst) oder
// BirdNET-Server-Verbindungsstatus. Der Server-Modus hat ohne Offline-Modell KEINEN robusten
// Fallback zur Laufzeit (nur einmal beim Start geprüft), darum hier bei jedem Erkennungsversuch
// neu bewertet — sonst merkt der Nutzer eine wegbrechende Verbindung (WLAN, Server down) nicht,
// außer dass plötzlich keine Funde mehr kommen.
function updateServerStatusChip() {
  const chip = document.getElementById('serverStatusChip');
  if (!chip) return;
  const txt = document.getElementById('serverChipTxt');
  const setTxt = t => { if (txt) txt.textContent = t; };
  chip.classList.remove('loc-active', 'loc-searching', 'srv-err', 'srv-demo');
  // Demo-Fallback, obwohl ein Server eingetragen ist (nicht erreichbar / Adresse ungültig): Chip rot
  // zeigen statt verstecken — sonst sähe es aus, als gäbe es gar kein Server-Problem.
  if (isDemoMode() && (rec.fallbackReason === 'unreachable' || rec.fallbackReason === 'invalid-url')) {
    chip.hidden = false; chip.classList.add('srv-err'); setTxt('Demo');
    chip.title = rec.fallbackReason === 'invalid-url' ? 'BirdNET-Server-Adresse ungültig — Demo-Modus' : 'BirdNET-Server nicht erreichbar — Demo-Modus';
    return;
  }
  // Reiner Demo-Modus (kein Server eingetragen): gelber "Demo"-Chip in der Kopfzeile — auf jedem Tab
  // sichtbar, nicht nur im Lauschen-Hinweis. Antippen öffnet die Einstellungen (s. unten).
  if (isDemoMode()) {
    chip.hidden = false; chip.classList.add('srv-demo'); setTxt('Demo');
    chip.title = 'Demo-Modus — für echte Erkennung Offline-Erkennung herunterladen oder BirdNET-Server eintragen (Einstellungen)';
    return;
  }
  // Offline-Erkennung (BirdNET rechnet auf dem Handy): grüner "Offline"-Chip — sowohl ohne Server
  // als auch, wenn der Server gerade nicht erreichbar ist (Funkloch) und das Handy übernimmt.
  if (rec && (rec.id === 'birdnet' || (rec.id === 'birdnet-server' && rec.status === 'offline'))) {
    chip.hidden = false; chip.classList.add('loc-active'); setTxt('Offline');
    chip.title = rec.id === 'birdnet' ? 'Offline-Erkennung: BirdNET läuft direkt auf dem Handy — kein Internet nötig'
      : 'Kein Server erreichbar — BirdNET erkennt offline auf dem Handy weiter';
    return;
  }
  if (!rec || rec.id !== 'birdnet-server') { chip.hidden = true; return; }
  chip.hidden = false; setTxt('BirdNET');
  if (rec.status === 'ok') { chip.classList.add('loc-active'); chip.title = 'BirdNET-Server verbunden'; }
  else if (rec.status === 'error') { chip.classList.add('srv-err'); chip.title = 'BirdNET-Server nicht erreichbar — Verbindung/Empfang prüfen'; }
  else { chip.classList.add('loc-searching'); chip.title = 'Verbinde mit BirdNET-Server…'; }
}
// Server-/Demo-Chip: führt direkt zu den Einstellungen (dort unter "Dienste & Schlüssel").
document.getElementById('serverStatusChip')?.addEventListener('click', () => {
  document.getElementById('gearBtn')?.click();
  const adv = document.querySelector('#settingsModal .setgroup-adv'); if (adv) adv.open = true;
});

// ---- Demo-Modus (Mock-Erkenner) ----
// Ohne BirdNET-Server/-Modell würfelt der Mock zufällige Arten. Das muss dauerhaft sichtbar sein
// (kein wegklickbarer Toast) und darf die echten Daten nicht verfälschen: Demo-Treffer erscheinen
// nur markiert in der Live-Liste — kein DB-Eintrag, keine Auto-Aufnahme, kein Seltenheits-Alarm.
function isDemoMode() { return !!rec && rec.id === 'mock'; }
const DEMO_HINTS = {
  'unreachable': 'BirdNET-Server nicht erreichbar — Demo-Modus. Erkannte Arten sind zufällig und werden nicht gespeichert. Tipp: Einstellungen → Offline-Erkennung herunterladen, dann klappt es auch ohne Empfang.',
  'invalid-url': 'BirdNET-Server-Adresse ungültig — Demo-Modus. Bitte in den Einstellungen korrigieren (https://…).',
  'model-error': 'Offline-Erkennung konnte nicht geladen werden — Demo-Modus. Erkannte Arten sind zufällig und werden nicht gespeichert.',
};
const DEMO_HINT_DEFAULT = 'Demo-Modus — erkannte Arten sind zufällig. Für echte Erkennung in den Einstellungen die Offline-Erkennung herunterladen oder einen BirdNET-Server eintragen.';
function updateDemoHint() {
  let el = document.getElementById('demoHint');
  if (!isDemoMode()) { if (el) el.hidden = true; return; }
  if (!el) {
    // Element erst hier erzeugen — direkt unter der Statuszeile im Lauschen-Tab, wo man beim Start
    // des Mikros ohnehin hinschaut. Optik: eigene, gelb getönte .demo-hint-Box mit Warn-Icon.
    el = document.createElement('div');
    el.id = 'demoHint'; el.className = 'demo-hint'; el.setAttribute('role', 'status');
    el.innerHTML = icon('alert') + '<span></span>';
    const anchor = document.querySelector('#v-listen .status');
    if (anchor) anchor.after(el); else document.getElementById('v-listen')?.prepend(el);
  }
  // Text per textContent (nicht innerHTML) — die Texte sind fest, aber so bleibt es auch künftig sicher.
  el.querySelector('span').textContent = DEMO_HINTS[rec.fallbackReason] || DEMO_HINT_DEFAULT;
  el.hidden = false;
}

async function onWindow(samples, sampleRate) {
  if (!rec || !detectionActive) return;
  if (rec.setGeo) rec.setGeo(geo.pos);   // Standort für den BirdNET-Range-Filter (Server und offline)
  let r = null;
  try { r = await rec.classify(samples, sampleRate); } catch (e) { console.warn('classify', e); }
  updateServerStatusChip();
  // Zwischen Start und Ende von classify() (im Server-Modus ein echter Netzwerk-Roundtrip) kann
  // der Nutzer das Lauschen bereits gestoppt haben — sonst würde ein spät eintreffender Treffer
  // trotzdem noch gespeichert werden.
  if (!r || !detectionActive) return;
  // Demo-Treffer nur anzeigen (markiert), sonst nichts: weder speichern noch Auto-Aufnahme noch Refresh.
  if (isDemoMode() || r.source === 'mock') {
    liveAdd({ key: r.key, species: r.name, sci: r.sci, rarity: r.rarity, confidence: r.confidence, ts: Date.now(), source: 'mock', demo: true });
    return;
  }
  const det = {
    key: r.key, species: r.name, sci: r.sci, rarity: r.rarity, confidence: r.confidence,
    ts: Date.now(), source: r.source || 'mic'
  };
  { const mp = myPos(); if (mp) { det.lat = mp.lat; det.lng = mp.lng; } }
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
  // Muss mit den in den Einstellungen wählbaren Presets übereinstimmen (index.html/ui.js kennen
  // auch 60 Sek) — sonst wird eine gewählte 60s-Aufnahme hier still auf 3s zurückgestuft.
  try { const v = parseInt(localStorage.getItem('waldohr.autoRecDur'), 10); return [3, 5, 10, 60].includes(v) ? v : 3; }
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
  el.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="22" height="22"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg><svg viewBox="0 0 8 6" fill="currentColor" width="8" height="6" style="margin-top:3px;opacity:.55"><path d="M0 0l8 3-8 3z"/></svg><span class="_aDur" style="font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums;line-height:1.3;margin-top:2px;display:block;text-align:center"></span></div>';
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
    <div style="text-align:center;font-size:14px;font-weight:700;color:var(--ink);margin-bottom:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</div>
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
  // KEINE Koordinaten mehr im Dateinamen: heruntergeladene/geteilte Dateien wandern weiter (Messenger,
  // Foren) und verrieten sonst metergenau den Fundort — bei seltenen Arten Brutplatz-Schutz. Die
  // genaue Position bleibt in der Datenbank am Fund (det.lat/lng) erhalten.
  const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'm4a' : 'webm';
  const url = URL.createObjectURL(blob);
  const ts = Date.now();
  const row = document.createElement('div'); row.className = 'rec-row';
  const a = document.createElement('audio'); a.src = url; a.preload = 'metadata'; a.hidden = true;
  wireAudioRouting(a);
  const lb = document.createElement('span'); lb.className = 'rec-label auto'; lb.textContent = det.species + ' · auto';
  const dl = makeDownloadBtn(url, prefix + '_' + stamp + '.' + ext, det.species);
  let attId = null;
  try { attId = await addAttachment({ detId: det.id ?? null, key: det.key, label: det.species, kind: 'audio', blob, mime, ts }); }
  catch (e) { console.warn('addAttachment', e); }
  _bindRecRow(row, { url, name: prefix + '_' + stamp + '.' + ext, attId, meta: { detId: det.id ?? null, key: det.key, label: det.species, kind: 'audio', ts } });
  const del = makeDeleteBtn(row, url, det.key, attId);
  row.append(_makeAudioIcon(a), lb, _spacer(), dl, _makeScissorsBtn(row), del, a);
  const list = document.getElementById('recList'); if (list) list.prepend(row);
  // Eigene URL fürs Sammlungs-Badge (gehört ab dann ui.js, s. registerRecording).
  registerRecording(det.key, URL.createObjectURL(blob));
  if (!isGalleryVisible()) galleryBadgeAdd(1);
}

async function maybeAutoRecord(det, samples, sampleRate) {
  if (det.confidence < getAutoRecordConfidence()) return;
  if (autoRecordedToday().includes(det.key)) return;
  markAutoRecorded(det.key);
  const dur = getAutoRecordDuration();
  // WAV-Kommentar reist mit der Datei mit (Download/Teilen) -> nur auf ≈ 1 km vergröbert (2 Stellen),
  // bei seltenen Arten/Säugern gar nicht (Brut-/Rückzugsplatz-Schutz, wie bei der Share-Karte).
  const gpsStr = geo.pos && det.rarity === 'common' ? roundCoord(geo.pos.lat, 2).toFixed(2) + ',' + roundCoord(geo.pos.lng, 2).toFixed(2) : '';

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
  const ico = /^(JPG|JPEG|PNG|HEIC)$/.test(ext) ? 'camera' : /^(WAV|M4A|MP3|OGG|WEBM)$/.test(ext) ? 'mic' : /^(MP4|MOV)$/.test(ext) ? 'film' : 'file';
  sheet.innerHTML = `
    <div style="width:40px;height:5px;border-radius:5px;background:var(--stroke-strong);margin:12px auto 16px"></div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;padding:12px;background:var(--glass);border:1px solid var(--stroke);border-radius:16px">
      <div style="width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex-shrink:0;background:rgba(163,230,53,.1);color:var(--lime)">${icon(ico)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(filename)}</div>
        ${label ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(label)}</div>` : ''}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <a id="_dsDown" href="${esc(url)}" download="${esc(filename)}" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;background:#a3e635;color:#04130d;border-radius:16px;font-weight:700;font-size:15px;text-decoration:none;font-family:inherit">
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
  // URL/Dateiname zum Klick-Zeitpunkt von der Zeile lesen (nicht die beim Erzeugen eingefangenen):
  // nach dem Zuschneiden hat die Zeile eine neue blob:-URL (WAV), die alte ist da schon freigegeben.
  btn.onclick = ev => {
    ev.stopPropagation();
    const row = btn.closest('.rec-row');
    openDownloadSheet(row?._recUrl || url, row?._dlName || filename, label);
  };
  return btn;
}

// Aktueller Zustand einer Aufnahme/Foto-Zeile — EINE Quelle für Download, Löschen, Zuschneiden und
// Badge-Abgleich. Vorher hatte jeder Button die URL/ID beim Erzeugen fest eingefangen; nach dem
// Zuschneiden zeigten Download/Löschen dann auf eine bereits freigegebene URL bzw. die alte DB-ID.
//   url  : blob:-URL, die NUR dieser Zeile gehört (Badges bekommen eigene, s. registerRecording)
//   name : Download-Dateiname
//   attId: ID des Anhangs in IndexedDB (null, falls Speichern fehlschlug)
//   meta : { detId, key, label, kind, ts } — zum Neuanlegen des Anhangs nach dem Zuschneiden
function _bindRecRow(row, { url, name, attId, meta }) {
  row._recUrl = url; row._dlName = name; row._attId = attId ?? null; row._meta = meta || {};
}

// Sammlungs-Badge einer Art nach Löschen/Zuschneiden mit der DB abgleichen: es zeigt immer die
// neueste noch vorhandene Aufnahme der Art — vorher verschwand es beim Löschen IRGENDEINER
// Aufnahme, auch wenn noch andere derselben Art existierten.
async function _resyncBadge(key) {
  if (!key) return;
  try {
    const latest = (await latestAudioAttachmentsByKey()).find(a => a.key === key);
    if (latest) registerRecording(key, URL.createObjectURL(latest.blob));
    else unregisterRecording(key);
  } catch (e) { console.warn('resync badge', e); unregisterRecording(key); }
}

// Löschen-Button für eine Aufnahme/Foto-Zeile: entfernt die Zeile, gibt die Object-URL frei,
// löscht den dauerhaft gespeicherten Anhang in der Datenbank und gleicht danach das kleine
// Abspiel-Badge auf der Sammlungskarte ab.
function makeDeleteBtn(row, url, key, attId) {
  const del = document.createElement('button');
  del.className = 'rec-del'; del.type = 'button'; del.title = 'Löschen';
  del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>';
  del.onclick = async ev => {
    ev.stopPropagation();
    // Zeilen-Zustand hat Vorrang (nach Zuschneiden: neue URL + neue Anhang-ID).
    const curUrl = row._recUrl || url;
    const curId = row._attId !== undefined ? row._attId : attId;
    const k = row._meta?.key ?? key;
    row.remove();
    try { URL.revokeObjectURL(curUrl); } catch {}
    if (curId != null) { try { await deleteAttachment(curId); } catch (e) { console.warn('deleteAttachment', e); } }
    // Erst NACH dem Löschen in der DB abgleichen, sonst fände die Abfrage den Anhang noch.
    await _resyncBadge(k);
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
    // Öffnen+Schließen ohne dass die Wiedergabe je zu Ende lief würde den 'ended'-Listener von
    // unten sonst für immer am (dauerhaften) Audio-Element hängen lassen — jedes erneute Öffnen
    // hängte dann einen weiteren dazu (nie entfernt, {once:true} greift ja nur NACH dem Feuern).
    if (a?._trimStopPreview) { a.removeEventListener('ended', a._trimStopPreview); a._trimStopPreview = null; }
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
  audioEl.addEventListener('ended', _stopPreview, { once: true });
  audioEl._trimStopPreview = _stopPreview; // Referenz für den manuellen Schließen-Pfad oben
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
    const oldUrl = row._recUrl || audioEl.src;
    audioEl.src = newUrl; audioEl.load();
    // Dauer-Anzeige am Audio-Icon auf die neue Länge bringen (der Listener dort feuert nur einmal).
    audioEl.addEventListener('loadedmetadata', () => {
      const ds = row.querySelector('._aDur'); const s = Math.floor(audioEl.duration);
      if (ds && isFinite(s) && s > 0) ds.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, { once: true });
    // Zeilen-Zustand umstellen: Download/Löschen lesen ab jetzt die neue URL; Endung jetzt immer .wav.
    row._recUrl = newUrl;
    if (row._dlName) row._dlName = row._dlName.replace(/\.[a-z0-9]+$/i, '') + '.wav';
    // Die alte URL gehört nur dieser Zeile (Badges haben eigene) -> gefahrlos freigeben.
    if (oldUrl && oldUrl !== newUrl && oldUrl.startsWith('blob:')) { try { URL.revokeObjectURL(oldUrl); } catch {} }
    panel.remove();
    // Zuschnitt dauerhaft speichern — vorher lebte er nur bis zum nächsten Reload. db.js kennt kein
    // Update, darum: neuen Anhang (mit Original-Zeitstempel, damit die Sortierung gleich bleibt)
    // ZUERST anlegen, erst danach den alten löschen — scheitert das Anlegen, bleibt das Original.
    const meta = row._meta || {};
    try {
      const newId = await addAttachment({ detId: meta.detId ?? null, key: meta.key ?? null, label: meta.label ?? null, kind: 'audio', blob: wav, mime: 'audio/wav', ts: meta.ts ?? Date.now() });
      const oldId = row._attId;
      row._attId = newId;
      if (oldId != null) await deleteAttachment(oldId);
      // Galt das Badge der Art dieser Aufnahme, soll es jetzt den Zuschnitt abspielen.
      if (meta.key) await _resyncBadge(meta.key);
    } catch (e) { console.warn('trim persist', e); }
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
  if (renderBtn) { renderBtn.disabled = true; renderBtn.textContent = 'Video erstellen & teilen'; }
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
        audioList.innerHTML = '<div style="color:var(--faint);font-size:13px;padding:10px 0">Keine Tonaufnahmen vorhanden — zuerst einen Ruf aufnehmen (Live-Liste oder Galerie → Tonclip).</div>';
      } else {
        audioList.innerHTML = '';
        for (const att of audios) {
          const row = document.createElement('div');
          row.className = 'mixer-audio-row';
          const lbl = att.label || 'Aufnahme';
          const when = att.ts ? new Date(att.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
          row.innerHTML = `<span class="mr-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v4M8 23h8"/></svg></span><span class="mr-label">${esc(lbl)}</span><span class="mr-dur">${esc(when)}</span>`;
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
  const unsupportedNote = supportsCapture ? '' : `<div style="background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);border-radius:12px;padding:10px 12px;font-size:12px;color:#fbbf24;margin-bottom:12px">Dein Browser unterstützt kein Zuschneiden/Mischen von Videos. Du kannst das Original trotzdem teilen.</div>`;
  sheet.innerHTML = `
    <div style="width:36px;height:4px;border-radius:4px;background:var(--stroke-strong);margin:0 auto 12px"></div>
    <h3 style="font-family:'Outfit',sans-serif;font-size:18px;font-weight:600;margin:0 0 10px;text-align:center;color:var(--ink)">Reel erstellen</h3>
    <div style="position:relative;margin-bottom:8px">
      <video id="_rvVid" src="${esc(url)}" playsinline style="width:100%;border-radius:12px;max-height:200px;object-fit:contain;background:#000;display:block"></video>
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
      <span style="font-size:13px;color:var(--ink);white-space:nowrap">Originalton</span>
      <input type="range" id="_rvVol" min="0" max="100" value="100" style="flex:1;accent-color:var(--lime)">
      <span id="_rvVolLbl" style="font-size:12px;color:var(--muted);width:38px;text-align:right;font-variant-numeric:tabular-nums">100%</span>
    </div>
    <div style="font-size:13px;color:var(--ink);margin-bottom:6px">Tonaufnahme hinzufügen</div>
    <div id="_rvAudioList" style="max-height:150px;overflow-y:auto;margin-bottom:12px;scrollbar-width:none;display:flex;flex-direction:column;gap:6px">
      <div style="color:var(--faint);font-size:12px;padding:8px 0">Lade Aufnahmen…</div>
    </div>
    ${unsupportedNote}
    <button id="_rvExport" style="width:100%;padding:14px;border-radius:16px;background:var(--lime);color:#04130d;font-weight:700;font-size:15px;cursor:pointer;border:none;font-family:inherit;margin-bottom:6px">${supportsCapture ? 'Reel exportieren' : 'Original teilen'}</button>
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

// Baut eine Aufnahme/Foto-Zeile aus einem gespeicherten Anhang (nach Reload) — selbe Optik wie
// frisch erzeugte Zeilen, aber aus dem in IndexedDB gesicherten Blob statt einer Live-Aufnahme.
function attachmentRow(a, url) {
  if (!url) url = URL.createObjectURL(a.blob);
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
  // Endung nach Art des Anhangs (kind), nicht nur nach MIME: 'video/mp4' enthält "mp4" und bekam
  // früher die Audio-Endung .m4a — das Video ließ sich dann nach dem Download nicht mehr öffnen.
  const ext = a.kind === 'video' ? (mime.includes('mp4') ? 'mp4' : mime.includes('quicktime') ? 'mov' : 'webm')
    : a.kind === 'audio' ? (mime.includes('wav') ? 'wav' : mime.includes('mp4') || mime.includes('aac') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('webm') ? 'webm' : 'bin')
    : (mime.includes('png') ? 'png' : mime.includes('heic') ? 'heic' : mime.includes('webp') ? 'webp' : 'jpg');
  const stamp = new Date(a.ts || Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = (a.label || 'waldohr').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const dlName = prefix + '_' + stamp + '.' + ext;
  _bindRecRow(row, { url, name: dlName, attId: a.id, meta: { detId: a.detId ?? null, key: a.key ?? null, label: a.label ?? null, kind: a.kind, ts: a.ts } });
  row.appendChild(_spacer());
  const dl = makeDownloadBtn(url, dlName, a.label);
  row.appendChild(dl);
  if (a.kind === 'photo') row.appendChild(makeShareBtn(url, a.key, a.label));
  if (a.kind === 'video') row.appendChild(makeReelBtn(url, mime));
  if (a.kind === 'audio') row.appendChild(_makeScissorsBtn(row));
  row.appendChild(makeDeleteBtn(row, url, a.key, a.id));
  if (_audioEl) row.appendChild(_audioEl);
  return row;
}

// Baut die Liste eigener Aufnahmen/Fotos + die kleinen Abspiel-Badges auf den Sammlungskarten
// aus der Datenbank neu auf — beim Boot UND nach jedem Löschen, damit beides synchron bleibt.
async function hydrateAttachments() {
  const list = document.getElementById('recList');
  // Blob-URLs ALLER bisher gerenderten Zeilen VOR dem Neuaufbau freigeben (Backup-Import, DB-Reset).
  // Gelesen aus dem Zeilen-Zustand statt einer separaten Liste: so sind auch live erzeugte und
  // zugeschnittene Zeilen (neue URL) erfasst, die eine Merkliste nie gekannt hätte.
  if (list) for (const r of list.querySelectorAll('.rec-row')) { if (r._recUrl) { try { URL.revokeObjectURL(r._recUrl); } catch {} } }
  if (list) list.innerHTML = '';
  clearRecordings(); // revoked die Badge-URLs bereits selbst (s. ui.js)
  try {
    const latestAudio = await latestAudioAttachmentsByKey();
    for (const a of latestAudio) registerRecording(a.key, URL.createObjectURL(a.blob));
  } catch (e) { console.warn('hydrate badges', e); }
  try {
    const all = await allAttachments();
    if (list) for (const a of all) list.appendChild(attachmentRow(a, URL.createObjectURL(a.blob)));
  } catch (e) { console.warn('hydrate recList', e); }
}

// ---- Mikrofon-Steuerung ----
// 'off': alles aus  |  'mic-ready': Mikro läuft, aber keine Erkennung (intern, z. B. nach einem
// Tonclip oder Zählungsende)  |  'mic': Mikro + Erkennung. Der Orb zeigt den ECHTEN Zustand — früher
// stand dort statisch "Lauschmodus / aktiv", auch wenn gar nichts lief.
const orbBig = document.getElementById('orbBig'), orbSub = document.getElementById('orbSub');
let _listenT0 = 0, _listenTimer = null;
const _fmtRun = ms => { const s = Math.floor(ms / 1000); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); };
function _orb(big, sub, pressed, label) {
  if (orbBig) orbBig.textContent = big;
  if (orbSub) orbSub.textContent = sub;
  const orb = document.getElementById('orbBtn');
  if (orb) { orb.setAttribute('aria-pressed', String(pressed)); orb.setAttribute('aria-label', label); }
}
function setUI(mode, msg) {
  body.classList.remove('listening', 'mic-ready');
  if (mode !== 'mic') { clearInterval(_listenTimer); _listenTimer = null; _listenT0 = 0; }
  // Die Statuszeile zeigt nur noch echte Meldungen (Fehler, Laden, Restzeit) — der Grundzustand
  // steht schon im Orb, doppelt ("Tippe zum Lauschen" + "Antippen") war nur Rauschen.
  if (mode === 'off') {
    statusTxt.textContent = msg || '';
    _orb('Antippen', 'zum Lauschen', false, 'Lauschen starten');
    renderLive(); return;
  }
  if (mode === 'mic-ready') {
    body.classList.add('mic-ready');
    statusTxt.textContent = msg || 'Mikrofon an, Erkennung pausiert';
    _orb('Bereit', 'Tippen zum Erkennen', false, 'Erkennung starten');
    renderLive(); return;
  }
  body.classList.add('listening');
  statusTxt.textContent = msg || '';
  // Laufzeit im Orb: zählt ab dem ersten 'mic', bleibt bei weiteren setUI('mic', …)-Aufrufen erhalten.
  if (!_listenT0) _listenT0 = Date.now();
  const tick = () => _orb('Lauscht', _fmtRun(Date.now() - _listenT0), true, 'Lauschen stoppen');
  tick();
  if (!_listenTimer) _listenTimer = setInterval(tick, 1000);
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
  const t = document.getElementById('routeTxt'); if (t) t.textContent = active ? 'Route stoppen' : 'Route aufzeichnen';
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

// Zeitplan-Chip unter dem Orb: öffnet "Automatisch lauschen". warmAlarmCtx() nutzt die Nutzergeste,
// um den AudioContext für spätere Alarmtöne freizuschalten (Browser blockieren Ton ohne Geste).
const timingBtn = document.getElementById('timingBtn');
if (timingBtn) timingBtn.onclick = () => { warmAlarmCtx(); openTimingModal(); };
// Der Fotografen-Wecker lebt jetzt im Foto-Tab — gleiche Freischaltung beim Einschalten dort.
document.getElementById('fwEnabled')?.addEventListener('change', warmAlarmCtx);

// Route-Toggle im Karte-Tab: Route manuell starten/stoppen ohne Mikro. Teilt sich den Tracker mit
// der Transekt-Zählung (Ornithologie-Tab) — läuft die gerade, hier nicht einfach mitbeenden/
// überschreiben, sondern klar sagen, wo man zuerst stoppen muss.
if (routeToggleBtn) routeToggleBtn.onclick = () => {
  if (routeTracker._timer) {
    if (routeTracker.owner !== 'route') {
      showInfoToast('🗺️ Transekt-Zählung läuft', 'Erst dort beenden, dann lässt sich die Route separat starten.', '🗺️');
      return;
    }
    stopSession();
  } else {
    geo.start();
    if (!routeTracker.start('route')) {
      showInfoToast('🗺️ Transekt-Zählung läuft', 'Erst dort beenden, dann lässt sich die Route separat starten.', '🗺️');
      return;
    }
    updateRouteToggleBtn(true);
    showInfoToast('Route gestartet', 'GPS-Track wird aufgezeichnet.', '📍');
  }
};

// EIN Start statt Orb + REC: ein Tipp startet Mikrofon UND Erkennung, der nächste stoppt beides
// (inkl. laufendem Tonclip, der dabei noch gespeichert wird). Lief das Mikro schon ohne Erkennung
// ('mic-ready', z. B. während eines Tonclips), schaltet der Tipp nur die Erkennung dazu.
let _orbBusy = false;
async function toggleDetection() {
  if (_orbBusy) return;   // getUserMedia kann Sekunden dauern — Doppeltipp nicht doppelt starten
  if (audio.running && detectionActive) {
    if (recorder.mr && recorder.mr.state === 'recording') recorder.mr.stop();
    stopDauerUeberwachung(); audio.stop(); detectionActive = false; setUI('off');
    return;
  }
  if (audio.running) { detectionActive = true; setUI('mic'); return; }
  tryFullscreen();
  _orbBusy = true;
  _orb('Startet …', 'Mikrofon', false, 'Lauschen startet');
  try { await audio.start(getMicDeviceId()); geo.start(); detectionActive = true; setUI('mic'); startDauerUeberwachung(); }
  catch (e) { console.warn('mic', e); setUI('off', 'Mikrofon nicht erlaubt — bitte in den Browser-Einstellungen freigeben'); }
  finally { _orbBusy = false; }
}

const orbBtn = document.getElementById('orbBtn');
if (orbBtn) {
  orbBtn.addEventListener('click', () => toggleDetection());
  // role="button" auf einem div: Enter/Leertaste wie bei einem echten Button.
  orbBtn.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleDetection(); } });
}

// ---- Tonaufnahme (manuell) ----

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

// Nach einem Clip, für den der Recorder das Mikro selbst eingeschaltet hat, es wieder freigeben —
// außer jemand nutzt es inzwischen (Lauschen per Orb/REC/Punkt-Zählung gestartet). Vorher lief das
// Mikro nach so einem Clip unsichtbar weiter (UI zeigte "aus", Mikro-Indikator des Systems an).
function _releaseMicIfUnused() {
  if (!audio.running || detectionActive || body.classList.contains('mic-ready') || body.classList.contains('listening')) return;
  audio.stop(); setUI('off');
}

const recorder = {
  mr: null, chunks: [], timer: null, t0: 0, starting: false,
  fmt() { const s = Math.floor((Date.now() - this.t0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); },
  setBtn(on) {
    const cb = document.getElementById('clipBtn'); if (cb) cb.classList.toggle('rec-on', on);
    // Die Live-Zeile der aufgenommenen Art zeigt den aktiven Zustand (ui.js liest body.dataset.recKey).
    if (on && this.key) body.dataset.recKey = this.key; else delete body.dataset.recKey;
    renderLive();
  },
  async toggle(label, key) {
    if (this.mr && this.mr.state === 'recording') { this.mr.stop(); return; }
    // Während der (teils sekundenlangen) Mikro-Initialisierung einen zweiten Tap ignorieren —
    // sonst starteten zwei parallele audio.start()/MediaRecorder.
    if (this.starting) return;
    let startedMic = false;
    if (!audio.running) {
      // Popup ZUERST anzeigen, dem Browser per setTimeout sicher einen Render-Tick geben und ERST
      // DANN die (auf manchen Handys >10 s langsame) Mikrofon-Initialisierung starten. setTimeout
      // statt requestAnimationFrame, weil rAF auf manchen Geräten (Fullscreen-/Render-Pausen)
      // sekundenlang aussetzen kann — dann erschiene das Popup gar nicht.
      this.starting = true;
      _showRecPopup('preparing');
      await new Promise(r => setTimeout(r, 60));
      try { await audio.start(getMicDeviceId()); geo.start(); startedMic = true; }
      catch (e) { console.warn('mic', e); statusTxt.textContent = 'Mikro nicht erlaubt'; _hideRecPopup(); return; }
      finally { this.starting = false; }
    }
    if (!audio.stream) { _hideRecPopup(); if (startedMic) _releaseMicIfUnused(); return; }
    let type = '';
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { type = t; break; }
    }
    try { this.mr = type ? new MediaRecorder(audio.stream, { mimeType: type }) : new MediaRecorder(audio.stream); }
    catch (e) {
      console.warn('rec', e);
      if (statusTxt) statusTxt.textContent = 'Aufnahme nicht möglich';
      _hideRecPopup();
      if (startedMic) _releaseMicIfUnused();
      setTimeout(() => { if (statusTxt && statusTxt.textContent === 'Aufnahme nicht möglich') statusTxt.textContent = ''; }, 3000);
      return;
    }
    // Pro Aufnahme eigene Puffer/Beschriftung (Closure statt this.*): save() wartet auf enhanceBlob —
    // ein schnell nachgestarteter zweiter Clip überschrieb vorher this.chunks/label/key, und der
    // erste wurde mit Ton/Namen des zweiten (oder gar nicht) gespeichert.
    const mr = this.mr, chunks = [], recLabel = label || null, recKey = key || null;
    this.chunks = chunks; this.label = recLabel; this.key = recKey;
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      this.setBtn(false); _hideRecPopup();
      if (startedMic) _releaseMicIfUnused();
      this.save(chunks, recLabel, recKey);
    };
    mr.start();
    this.t0 = Date.now(); this.setBtn(true); _showRecPopup('recording');
  },
  async save(chunks = this.chunks, label = this.label, key = this.key) {
    if (!chunks.length) return;
    const raw = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
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
    const prefix = label ? label.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'waldohr';
    const name = prefix + '_' + stamp + '.' + ext;
    const ts = Date.now();
    const row = document.createElement('div'); row.className = 'rec-row';
    const a = document.createElement('audio'); a.src = url; a.preload = 'metadata'; a.hidden = true;
    wireAudioRouting(a);
    const dl = makeDownloadBtn(url, name, label);
    row.appendChild(_makeAudioIcon(a));
    if (label) { const lb = document.createElement('span'); lb.className = 'rec-label'; lb.textContent = label; row.appendChild(lb); }
    row.appendChild(_spacer());
    row.appendChild(dl);
    row.appendChild(_makeScissorsBtn(row));
    let attId = null;
    try { attId = await addAttachment({ key, label, kind: 'audio', blob: saveBlob, mime, ts }); }
    catch (e) { console.warn('addAttachment', e); }
    _bindRecRow(row, { url, name, attId, meta: { detId: null, key, label, kind: 'audio', ts } });
    row.appendChild(makeDeleteBtn(row, url, key, attId));
    row.appendChild(a);
    const list = document.getElementById('recList'); if (list) list.prepend(row);
    // Eigene URL fürs Badge — die Zeilen-URL darf beim Löschen/Zuschneiden freigegeben werden.
    if (key) registerRecording(key, URL.createObjectURL(saveBlob));
    if (!isGalleryVisible()) galleryBadgeAdd(1);
  }
};
const clipBtn = document.getElementById('clipBtn');
if (clipBtn && !window.MediaRecorder) clipBtn.style.display = 'none';
if (clipBtn) clipBtn.onclick = () => recorder.toggle();
const photoFab = document.getElementById('photoFab');
// "Kamera öffnen" im Foto-Tab. Nach dem Auslösen bleibt die Kamera bewusst offen (mehrere Fotos
// hintereinander); das Galerie-Icon in der Kamera blinkt kurz als Bestätigung und führt zurück.
if (photoFab) photoFab.onclick = () => _openCameraFor(null, null);

// ---- Galerie = Foto-Tab, Segment "Galerie" ----
// Früher ein eigenes Modal; openGallery() wechselt jetzt in den Foto-Tab (auch das Galerie-Icon
// in der Kamera, s. _openCameraFor). Das Zähler-Badge sitzt am Foto-Tab der Navigation.
function isGalleryVisible() {
  return !!document.getElementById('v-foto')?.classList.contains('active') && isFotoSegment('galerie');
}
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

function openGallery() {
  showFotoSegment('galerie');
  if (!document.getElementById('v-foto')?.classList.contains('active')) document.querySelector('.nav button[data-v="foto"]')?.click();
  galleryBadgeClear();
}
// Badge löschen, sobald die Galerie tatsächlich zu sehen ist (Tab- oder Segmentwechsel).
document.addEventListener('waldohr:tab', e => {
  if (e.detail !== 'foto') return;
  if (isFotoSegment('galerie')) galleryBadgeClear();
  if (isFotoSegment('licht')) loadPhotoWeather();
});
document.addEventListener('waldohr:fotoseg', e => {
  if (e.detail === 'galerie') galleryBadgeClear();
  if (e.detail === 'licht') loadPhotoWeather();
});

// ---- Licht & Wetter (Foto-Tab, Segment "Licht") ----
// Linien-Icons statt Wetter-Emoji (die je Plattform anders aussehen). WMO-Code → Icon-Gruppe.
function wxIcon(wmo) {
  const n = wmo == null ? 3 : wmo;
  const name = n === 0 || n === 1 ? 'sun' : n === 2 ? 'partly' : n === 3 ? 'cloud' : n === 45 || n === 48 ? 'fog'
    : (n >= 71 && n <= 77) || n === 85 || n === 86 ? 'snow' : n >= 95 ? 'storm' : n >= 51 ? 'rain' : 'cloud';
  return icon(name);
}
const _pwRow = (ico, lbl, val, cls = '') => `<div class="pw-row"><span class="pw-icon${cls ? ' ' + cls : ''}">${ico}</span><span class="pw-lbl">${lbl}</span><span class="pw-val">${val}</span></div>`;
const _slot = s => `<div class="tmw-slot"><div class="tmw-h">${s.hour}:00</div><div class="tmw-ico">${wxIcon(s.visKm < 2 ? 45 : s.wmo)}</div><div class="tmw-temp">${s.temp > 0 ? '+' : ''}${s.temp}°</div><div class="tmw-cc">${s.cloudcover} % Wolken</div><div class="tmw-rain">${s.precipProb > 0 ? s.precipProb + ' % Regen' : ''}</div></div>`;
let _pwLoadedAt = 0, _pwBusy = false;
async function loadPhotoWeather(force) {
  // Nicht bei jedem Tab-Wechsel neu laden — Wetter ändert sich nicht minütlich (10 Min Puffer).
  if (_pwBusy || (!force && Date.now() - _pwLoadedAt < 10 * 60000)) return;
  const content = document.getElementById('photoWeatherContent');
  const locEl = document.getElementById('pwLocation');
  if (!content) return;
  _pwBusy = true;
  try { await _renderPhotoWeather(content, locEl); _pwLoadedAt = geo.pos ? Date.now() : 0; }
  finally { _pwBusy = false; }
}
const photoWeatherBtn = document.getElementById('photoWeatherBtn');
if (photoWeatherBtn) photoWeatherBtn.onclick = () => loadPhotoWeather(true);
async function _renderPhotoWeather(content, locEl) {
  content.innerHTML = '<div class="pw-loading">Lade Wetterdaten…</div>';
  if (locEl) locEl.textContent = '';
  const lat = geo.pos?.lat, lng = geo.pos?.lng;

  // Ortsname (asynchron, erscheint, sobald da)
  if (lat != null && locEl) {
    reverseGeocode(lat, lng).then(name => { if (name && locEl) locEl.textContent = name; });
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
    html += '<div class="pw-section">Morgens</div>';
    if (sun.civilBegin) html += _pwRow(icon('moon'), 'Blaue Stunde', `${fmt(sun.civilBegin)} – ${blueEnd ? fmt(blueEnd) : '–'}`, 'cool');
    if (sr) html += _pwRow(icon('sunrise'), 'Sonnenaufgang', fmt(sr), 'warm');
    if (sr) html += _pwRow(icon('sun'), 'Goldene Stunde', `${fmt(sr)} – ${goldenEnd ? fmt(goldenEnd) : '–'}`, 'warm');
    if (sun.sunset) {
      html += '<div class="pw-section">Abends</div>';
      const goldenBegin = new Date(sun.sunset.getTime() - 45 * 60000);
      html += _pwRow(icon('sun'), 'Goldene Stunde', `${fmt(goldenBegin)} – ${fmt(sun.sunset)}`, 'warm');
      html += _pwRow(icon('sunset'), 'Sonnenuntergang', fmt(sun.sunset), 'warm');
      if (sun.civilEnd) html += _pwRow(icon('moon'), 'Blaue Stunde', `${fmt(sun.sunset)} – ${fmt(sun.civilEnd)}`, 'cool');
    }
  }
  if (pw) {
    const fogRisk = pw.visKm < 1 ? 'Nebel' : pw.visKm < 5 && pw.humidity > 85 ? 'Dunst' : pw.humidity > 92 ? 'Nebelgefahr' : null;
    const tip = pw.cloudcover < 20 && pw.windKmh < 10 ? 'Optimale Bedingungen für Langzeitbelichtung.'
      : pw.cloudcover > 70 ? 'Weiches Diffuslicht durch Bewölkung — ideal für Porträtfotos.'
      : pw.windKmh > 25 ? 'Starker Wind — kurze Belichtungszeit wählen.'
      : 'Gute Bedingungen für Naturfotografie.';
    html += '<div class="pw-section">Jetzt</div>';
    html += _pwRow(wxIcon(pw.wmo), esc(weatherLabel(pw.wmo) || 'Wetter'), pw.temp + ' °C');
    html += _pwRow(icon('wind'), 'Wind', `${pw.windKmh} km/h ${windDirLabel(pw.windDir)}`);
    html += _pwRow(icon('drop'), 'Luftfeuchte', pw.humidity + ' %');
    if (fogRisk) html += `<div class="pw-row"><span class="pw-icon warm">${icon('fog')}</span><span class="pw-lbl">Nebel</span><span class="pw-val warn">${fogRisk} · ${pw.visKm} km</span></div>`;
    else html += _pwRow(icon('eye'), 'Sichtweite', pw.visKm + ' km');
    html += _pwRow(icon('cloud'), 'Bewölkung', pw.cloudcover + ' %');
    html += _pwRow(icon('sun'), 'UV-Index', `${pw.uvIndex} · ${uvLabel(pw.uvIndex)}`);
    html += `<div class="pw-tip">${icon('camera')}<span>${tip}</span></div>`;
    if (todaySlots?.length) html += '<div class="pw-section">Heute stündlich</div><div class="tmw-slots">' + todaySlots.map(_slot).join('') + '</div>';
  }
  // Mond-Kalender (moonPhaseLabel liefert "Name Emoji" — nur der Name wird angezeigt)
  const mc = moonCalendar();
  const phaseName = moonPhaseLabel(mc.phase).replace(/\s*[\p{Extended_Pictographic}️]+\s*$/u, '');
  html += '<div class="pw-section">Mond</div>';
  html += _pwRow(icon('moon'), 'Phase', `${phaseName} · ${mc.ageInDays} Tage`);
  const mrStr = moonTimes === null ? 'GPS nötig' : (moonTimes.moonrise ? fmt(moonTimes.moonrise) : 'heute nicht');
  const msStr = moonTimes === null ? 'GPS nötig' : (moonTimes.moonset ? fmt(moonTimes.moonset) : 'heute nicht');
  html += _pwRow(icon('moon'), 'Mondaufgang', mrStr);
  html += _pwRow(icon('moon'), 'Monduntergang', msStr);
  html += _pwRow(icon('moon'), 'Nächster Vollmond', `${fmtDate(mc.nextFull)} (in ${mc.daysToFull} T.)`);
  html += _pwRow(icon('moon'), 'Nächster Neumond', `${fmtDate(mc.nextNew)} (in ${mc.daysToNew} T.)`);

  if (!pw && !sun) html = '<div class="pw-loading">Standort benötigt — GPS erlauben, dann aktualisieren.</div>';
  content.innerHTML = html;

  // Morgen-Früh-Prognose nachreichen
  if (lat != null) {
    const tmwEl = document.createElement('div');
    tmwEl.innerHTML = '<div class="pw-section">Morgen früh</div><div class="pw-loading">Prognose wird geladen …</div>';
    content.appendChild(tmwEl);
    fetchTomorrowMorning(lat, lng).then(slots => {
      if (!slots || !slots.length) { tmwEl.innerHTML = '<div class="pw-section">Morgen früh</div><div class="pw-loading">Keine Prognose verfügbar.</div>'; return; }
      tmwEl.innerHTML = '<div class="pw-section">Morgen früh</div><div class="tmw-slots">' + slots.map(_slot).join('') + '</div>';
    }).catch(() => { tmwEl.remove(); });
  }
}

// Aufnahme-Knopf direkt an einer Live-Zeile -> beschriftet die Aufnahme mit dem Artnamen und
// verknüpft sie mit dem Art-Key, damit sie als kleines Icon in der Sammlung auftaucht.
window.__waldohrRecordSpecies = (name, key) => recorder.toggle(name, key);
// Richtungs-Scan (js/scan.js): nutzt das laufende Lausch-Mikrofon mit, sonst ein eigenes.
window.__waldohrScanDirection = name => openScan({ species: name || '', engine: audio });
document.getElementById('scanBtn')?.addEventListener('click', () => openScan({ engine: audio }));

// API for Punkt-Zählung cross-tab flow (ornithologie.js)
let _triggerRaf = null, _triggerMr = null;
window.__waldohr = {
  startDetection: async () => {
    detectionActive = true;
    setUI('mic');
    if (!audio.running) {
      // Erst die UI (Timer/Banner) zeichnen lassen, dann das blockierende getUserMedia starten.
      // setTimeout statt rAF (rAF kann auf manchen Handys sekundenlang aussetzen).
      await new Promise(r => setTimeout(r, 60));
      try { await audio.start(getMicDeviceId()); geo.start(); }
      catch (e) { detectionActive = false; setUI('off'); throw e; }
    }
  },
  // opts.releaseMic: Erkennung UND Mikrofon aus (Ende von Punkt-Zählung/Transekt, wenn vorher nicht
  // gelauscht wurde) — wie der Orb-Stopp: laufenden Clip sauber beenden (wird gespeichert), Dauer-
  // überwachung stoppen, Mikro freigeben, UI auf "aus". Ohne opts unverändert: Mikro bleibt bereit.
  stopDetection: (opts) => {
    detectionActive = false;
    if (opts && opts.releaseMic) {
      if (recorder.mr && recorder.mr.state === 'recording') recorder.mr.stop();
      // Trigger-Aufnahme hängt am selben Stream — ohne Mikro sinnlos, also mitbeenden (speichert noch).
      if (_triggerRaf) { cancelAnimationFrame(_triggerRaf); _triggerRaf = null; }
      if (_triggerMr && _triggerMr.state === 'recording') _triggerMr.stop();
      _triggerMr = null;
      stopDauerUeberwachung();
      if (audio.running) audio.stop();
      setUI('off');
      return;
    }
    setUI(audio.running ? 'mic-ready' : 'off');
  },
  isDetecting: () => audio.running && detectionActive,
  isMicRunning: () => !!audio.running,
  // Für den Feldbuch-Export "Heute hier": maßgebliche eigene Position (manuell gesetzt vor GPS).
  getPos: () => myPos() || null,
  // Akzeptiert 'listen' wie 'v-listen' (ornithologie.js übergibt die View-ID mit "v-"-Präfix, die
  // Nav-Buttons tragen data-v ohne) — vorher sprang der Start einer Zählung nie zu Lauschen.
  switchTab: v => {
    const id = String(v || '').replace(/^v-/, '');
    if (!/^[a-z0-9-]+$/i.test(id)) return;
    document.querySelector(`.nav button[data-v="${id}"]`)?.click();
  },
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
        const ts = Date.now();
        try { attId = await addAttachment({ key: null, label: 'Trigger', kind: 'audio', blob: saveBlob, mime, ts }); } catch {}
        _bindRecRow(row, { url, name, attId, meta: { detId: null, key: null, label: 'Trigger', kind: 'audio', ts } });
        row.appendChild(makeDeleteBtn(row, url, null, attId)); row.appendChild(a);
        const list = document.getElementById('recList'); if (list) list.prepend(row);
        if (!isGalleryVisible()) galleryBadgeAdd(1);
      };
      tMr.start();
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
  // Endung nach kind (wie in attachmentRow): Fotos aus dem nativen Fallback können PNG/HEIC sein.
  const ext = kind === 'video' ? (mime.includes('mp4') ? 'mp4' : mime.includes('quicktime') ? 'mov' : 'webm')
    : (mime.includes('png') ? 'png' : mime.includes('heic') ? 'heic' : mime.includes('webp') ? 'webp' : 'jpg');
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
  let attId = null;
  const ts = Date.now();
  try { attId = await addAttachment({ key: key || null, label: label || null, kind, blob, mime, ts }); }
  catch (e) { console.warn('addAttachment', e); }
  _bindRecRow(row, { url, name: prefix + '_' + stamp + '.' + ext, attId, meta: { detId: null, key: key || null, label: label || null, kind, ts } });
  row.appendChild(makeDeleteBtn(row, url, key || null, attId));
  const list = document.getElementById('recList'); if (list) list.prepend(row);
  // Nach einem Foto bleibt die Kamera bewusst offen (mehrere Fotos hintereinander) — dann darf die
  // Galerie NICHT aufgehen: sie liegt über der Kamera und verdeckt Auslöser und Zoom-Regler, die
  // Kamera wirkt "kaputt". Bestätigung gibt dort das blinkende Galerie-Icon. Nach Video/Zeitraffer
  // ist die Kamera schon geschlossen, dann zeigt die Galerie das Ergebnis direkt.
  if (!document.getElementById('cameraModal')?.classList.contains('open')) openGallery();
  if (!isGalleryVisible()) galleryBadgeAdd(1);
}
// Natives Input als letzter Fallback (wenn getUserMedia blockiert wird): camera.js klickt dann nur
// #photoInput an und kennt die Art nicht. Darum merkt sich _openCameraFor() Beschriftung/Art bei
// JEDEM Kamera-Öffnen (auch null beim freien Foto-Knopf, damit keine alte Art hängen bleibt) — vorher
// gab es dafür nur einen nie aufgerufenen photoInput._setFallback-Hook, Fallback-Fotos blieben unbeschriftet.
let _fallbackLabel = null, _fallbackKey = null;
function _openCameraFor(label, key) {
  _fallbackLabel = label || null; _fallbackKey = key || null;
  openCamera(capture => _saveCapture({ ...capture, label: label || null, key: key || null }), openGallery);
}
if (photoInput) {
  photoInput.onchange = async () => {
    const file = photoInput.files?.[0]; photoInput.value = '';
    const label = _fallbackLabel, key = _fallbackKey;
    _fallbackLabel = null; _fallbackKey = null;
    if (!file) return;
    await _saveCapture({ blob: file, mime: file.type || 'image/jpeg', kind: 'photo', label, key });
  };
}
// Kamera-Knopf an Live-Zeile / Seltenheits-Toast → öffnet eigene Kamera-UI
window.__waldohrCapturePhoto = (name, key) => _openCameraFor(name, key);

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
    if (backupStatus) backupStatus.textContent = `Fertig: ${res.detCount} Funde, ${res.attCount} Anhänge (${res.filename})`;
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
    if (backupStatus) backupStatus.textContent = `Wiederhergestellt: ${res.detCount} Funde, ${res.attCount} Anhänge`;
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
  // In der App-Hülle (Capacitor) liegen alle Dateien im App-Paket — ein Service Worker brächte dort
  // nichts außer veralteten Kopien nach einem App-Update (und wird unter iOS ohnehin nicht unterstützt).
  if (isNativeApp()) return;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
