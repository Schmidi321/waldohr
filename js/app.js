// Orchestrierung: verdrahtet Audio -> Erkennung -> Speicher -> UI.
import { AudioEngine, enhanceSamples, enhanceBlob } from './audio.js';
import { createRecognizer, MockRecognizer, encodeWav } from './recognizer.js';
import { addDetection, allDetections, seedIfEmpty, computeStats, migrateGeo, cleanupFakeGeo, todayNearbyDetections, deleteByIds, clearAll, qualifyingDetections, addAttachment, allAttachments, latestAudioAttachmentsByKey, deleteAttachment } from './db.js';
import { initUI, renderAll, liveAdd, renderMap, setLivePos, registerRecording, unregisterRecording, clearRecordings, renderLive, showInfoToast } from './ui.js';

const body = document.body;
const statusTxt = document.getElementById('statusTxt');
const micIcon = document.getElementById('micIcon');

const audio = new AudioEngine();
let rec = null;

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

async function boot() {
  const splashStart = Date.now();
  initUI();
  try { await seedIfEmpty(); } catch (e) { console.warn('seed', e); }
  try { await migrateGeo(); } catch (e) { console.warn('migrateGeo', e); }
  try { const n = await cleanupFakeGeo(); if (n) console.info(n + ' Fund(e) hatten eine falsche Fake-Position (Bug) — Koordinaten entfernt.'); } catch (e) { console.warn('cleanupFakeGeo', e); }
  await refresh();
  hydrateAttachments();
  geo.start();

  rec = await createRecognizer();
  if (rec.id === 'birdnet') statusTxt.textContent = 'BirdNET-Modell wird geladen…';
  else if (rec.id === 'birdnet-server') statusTxt.textContent = 'Verbinde mit BirdNET-Server…';
  try { await rec.load(); }
  catch (e) { console.warn('Recognizer-Fallback auf Mock:', e); rec = new MockRecognizer(); await rec.load(); }

  audio.onWindow = onWindow;
  setUI('off');
  startSpectrogram();
  registerSW();

  // Startbildschirm bleibt mindestens etwas länger sichtbar, auch wenn der Boot (Demo-Daten,
  // Recognizer) schneller fertig ist — verschwindet sofort, falls der Boot länger gedauert hat
  // als die Mindestzeit. Per Tap jederzeit sofort überspringbar.
  const MIN_SPLASH_MS = 2200;
  const splash = document.getElementById('splash');
  const hideSplash = () => { if (splash) splash.classList.add('hide'); };
  if (splash) splash.addEventListener('click', hideSplash, { once: true });
  setTimeout(hideSplash, Math.max(0, MIN_SPLASH_MS - (Date.now() - splashStart)));
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

async function onWindow(samples, sampleRate) {
  if (!rec) return;
  if (rec.setGeo) rec.setGeo(geo.pos);   // Standort für bessere Treffer (Server-Modus)
  let r = null;
  try { r = await rec.classify(samples, sampleRate); } catch (e) { console.warn('classify', e); }
  if (!r) return;
  const det = {
    key: r.key, species: r.name, sci: r.sci, rarity: r.rarity, confidence: r.confidence,
    ts: Date.now(), source: r.source || 'mic'
  };
  if (geo.pos) { det.lat = geo.pos.lat; det.lng = geo.pos.lng; }
  try { det.id = await addDetection(det); } catch (e) { console.warn('store', e); }
  liveAdd(det);
  maybeAutoRecord(det, samples, sampleRate);
  refresh();
}

// ---- Automatische Aufnahme: ab 85% Konfidenz wird der gerade klassifizierte Ausschnitt
// direkt als WAV gespeichert — aber nur einmal pro Art und Kalendertag, gegen Datenflut bei
// häufigen Arten. Tagesliste in localStorage, damit es auch über einen Reload hinweg gilt.
const AUTO_RECORD_CONFIDENCE = 0.85;
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
  if (det.confidence < AUTO_RECORD_CONFIDENCE) return;
  if (autoRecordedToday().includes(det.key)) return;
  markAutoRecorded(det.key);
  let enhanced = samples;
  try { enhanced = await enhanceSamples(samples, sampleRate); } catch (e) { console.warn('enhance', e); }
  const blob = encodeWav(enhanced, sampleRate);
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const prefix = det.species.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const row = document.createElement('div'); row.className = 'rec-row';
  const a = document.createElement('audio'); a.controls = true; a.src = url; a.preload = 'metadata';
  wireAudioRouting(a);
  const lb = document.createElement('span'); lb.className = 'rec-label auto'; lb.textContent = det.species + ' · auto';
  const dl = document.createElement('a'); dl.className = 'rec-dl'; dl.href = url; dl.download = prefix + '_' + stamp + '.wav'; dl.textContent = '⬇'; dl.title = 'Herunterladen';
  let attId = null;
  try { attId = await addAttachment({ detId: det.id ?? null, key: det.key, label: det.species, kind: 'audio', blob, mime: 'audio/wav' }); }
  catch (e) { console.warn('addAttachment', e); }
  const del = makeDeleteBtn(row, url, det.key, attId);
  row.append(a, lb, dl, del);
  const list = document.getElementById('recList'); if (list) list.prepend(row);
  registerRecording(det.key, url);
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
function setIcon(stop) {
  micIcon.innerHTML = stop
    ? '<rect x="7" y="7" width="10" height="10" rx="2"/>'
    : '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>';
}
function setUI(mode, msg) {
  if (mode === 'off') { body.classList.remove('listening'); statusTxt.textContent = msg || 'Tippe zum Lauschen'; setIcon(false); renderLive(); return; }
  body.classList.add('listening'); setIcon(true);
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

document.getElementById('micBtn').onclick = async () => {
  if (audio.running) { audio.stop(); setUI('off'); return; }
  tryFullscreen();
  try { await audio.start(); setUI('mic'); }
  catch (e) { console.warn('mic', e); setUI('off', 'Mikro nicht erlaubt'); }
};

// ---- Tonaufnahme (manuell) ----
const recBtn = document.getElementById('recBtn');
if (recBtn && !window.MediaRecorder) recBtn.style.display = 'none';
const recorder = {
  mr: null, chunks: [], timer: null, t0: 0,
  fmt() { const s = Math.floor((Date.now() - this.t0) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); },
  setBtn(on) { if (!recBtn) return; recBtn.classList.toggle('rec-on', on); if (!on) { const t = document.getElementById('recTime'); if (t) t.textContent = 'REC'; } },
  async toggle(label, key) {
    if (this.mr && this.mr.state === 'recording') { this.mr.stop(); return; }
    if (!audio.running) {
      tryFullscreen();
      try { await audio.start(); geo.start(); setUI('mic'); }
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
    this.mr.onstop = () => { clearInterval(this.timer); this.setBtn(false); this.save(); };
    this.mr.start();
    this.t0 = Date.now(); this.setBtn(true);
    this.timer = setInterval(() => { const t = document.getElementById('recTime'); if (t) t.textContent = this.fmt(); }, 500);
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
  }
};
if (recBtn) recBtn.onclick = () => recorder.toggle();
// Aufnahme-Knopf direkt an einer Live-Zeile -> beschriftet die Aufnahme mit dem Artnamen und
// verknüpft sie mit dem Art-Key, damit sie als kleines Icon in der Sammlung auftaucht.
window.__waldohrRecordSpecies = (name, key) => recorder.toggle(name, key);

// ---- Fotoaufnahme (Fotografen-Funktion): Direktbeleg-Foto zu einem Fund, öffnet die Gerätekamera ----
const photoInput = document.getElementById('photoInput');
let photoLabel = null, photoKey = null;
if (photoInput) {
  photoInput.onchange = async () => {
    const file = photoInput.files && photoInput.files[0];
    photoInput.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const prefix = photoLabel ? photoLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'waldohr';
    const name = prefix + '_' + stamp + '.jpg';
    const row = document.createElement('div'); row.className = 'rec-row';
    const img = document.createElement('img'); img.className = 'photo-thumb'; img.src = url; img.alt = photoLabel || 'Foto';
    img.onclick = () => window.open(url, '_blank');
    const dl = document.createElement('a'); dl.className = 'rec-dl'; dl.href = url; dl.download = name; dl.textContent = '⬇'; dl.title = 'Herunterladen';
    row.appendChild(img);
    if (photoLabel) { const lb = document.createElement('span'); lb.className = 'rec-label'; lb.style.flex = '1'; lb.textContent = photoLabel; row.appendChild(lb); }
    row.appendChild(dl);
    let attId = null;
    try { attId = await addAttachment({ key: photoKey, label: photoLabel, kind: 'photo', blob: file, mime: file.type }); }
    catch (e) { console.warn('addAttachment', e); }
    row.appendChild(makeDeleteBtn(row, url, null, attId));
    const list = document.getElementById('recList'); if (list) list.prepend(row);
  };
}
// Kamera-Knopf an Live-Zeile/Seltenheits-Toast -> beschriftet das Foto mit dem Artnamen.
window.__waldohrCapturePhoto = (name, key) => { photoLabel = name || null; photoKey = key || null; photoInput && photoInput.click(); };

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
