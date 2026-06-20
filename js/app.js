// Orchestrierung: verdrahtet Audio -> Erkennung -> Speicher -> UI.
import { AudioEngine } from './audio.js';
import { createRecognizer, MockRecognizer } from './recognizer.js';
import { addDetection, allDetections, seedIfEmpty, computeStats, migrateGeo } from './db.js';
import { initUI, renderAll, liveAdd, renderMap } from './ui.js';

const body = document.body;
const statusTxt = document.getElementById('statusTxt');
const micIcon = document.getElementById('micIcon');
const DIRS = ['N','NO','O','SO','S','SW','W','NW'];

const audio = new AudioEngine();
let rec = null;

const setLoc = (t) => { const el = document.getElementById('locTxt'); if (el) el.textContent = t; };

// Standort-Erfassung: hält die aktuelle Position, solange das Mikro läuft.
const geo = {
  watchId: null, pos: null,
  start() {
    if (!('geolocation' in navigator)) { setLoc('kein GPS'); return; }
    if (this.watchId != null) return;
    setLoc('Standort: suche…');
    this.watchId = navigator.geolocation.watchPosition(
      p => { this.pos = { lat: p.coords.latitude, lng: p.coords.longitude }; setLoc('Standort ±' + Math.round(p.coords.accuracy) + ' m'); },
      e => { console.warn('geo', e); setLoc(e.code === 1 ? 'GPS verweigert' : 'kein GPS'); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 }
    );
  },
  stop() { if (this.watchId != null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; } setLoc('Standort aus'); }
};

async function boot() {
  initUI();
  try { await seedIfEmpty(); } catch (e) { console.warn('seed', e); }
  try { await migrateGeo(); } catch (e) { console.warn('migrateGeo', e); }
  await refresh();

  rec = await createRecognizer();
  if (rec.id === 'birdnet') statusTxt.textContent = 'BirdNET-Modell wird geladen…';
  else if (rec.id === 'birdnet-server') statusTxt.textContent = 'Verbinde mit BirdNET-Server…';
  try { await rec.load(); }
  catch (e) { console.warn('Recognizer-Fallback auf Mock:', e); rec = new MockRecognizer(); await rec.load(); }

  audio.onWindow = onWindow;
  setUI('demo');
  startSpectrogram();
  registerSW();
}

async function refresh() {
  let dets = [];
  try { dets = await allDetections(); } catch (e) { console.warn('read', e); }
  renderAll(computeStats(dets));
  renderMap(dets);
}

async function onWindow(samples, sampleRate) {
  if (!rec) return;
  if (rec.setGeo) rec.setGeo(geo.pos);   // Standort für bessere Treffer (Server-Modus)
  let r = null;
  try { r = await rec.classify(samples, sampleRate); } catch (e) { console.warn('classify', e); }
  if (!r) return;
  const det = {
    key: r.key, species: r.name, sci: r.sci, rarity: r.rarity, confidence: r.confidence,
    dir: DIRS[(Math.random() * 8) | 0], distance: 10 + ((Math.random() * 70) | 0),
    ts: Date.now(), source: r.source || 'mic'
  };
  if (geo.pos) { det.lat = geo.pos.lat; det.lng = geo.pos.lng; }
  try { await addDetection(det); } catch (e) { console.warn('store', e); }
  liveAdd(det);
  refresh();
}

// ---- Mikrofon-Steuerung ----
function setIcon(stop) {
  micIcon.innerHTML = stop
    ? '<rect x="7" y="7" width="10" height="10" rx="2"/>'
    : '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/>';
}
function setUI(mode) {
  if (mode === 'off') { body.classList.remove('listening'); statusTxt.textContent = 'Tippe zum Lauschen'; setIcon(false); return; }
  body.classList.add('listening'); setIcon(mode === 'mic');
  statusTxt.textContent = mode === 'mic' ? 'Lauscht über dein Mikrofon…' : 'Demo-Vorschau · tippe fürs echte Mikro';
}

document.getElementById('micBtn').onclick = async () => {
  if (audio.running) { audio.stop(); geo.stop(); setUI('off'); return; }
  try { await audio.start(); geo.start(); setUI('mic'); }
  catch (e) { console.warn('mic', e); setUI('demo'); statusTxt.textContent = 'Mikro nicht erlaubt – Demo läuft'; }
};

// ---- Spektrogramm (echtes Mikro oder Demo-Fallback) ----
function startSpectrogram() {
  const cv = document.getElementById('spec'), cx = cv.getContext('2d');
  const levelFill = document.getElementById('levelFill');
  const COL = 80, n = 48, cols = []; let t = 0;
  const size = () => { cv.width = cv.clientWidth * devicePixelRatio; cv.height = cv.clientHeight * devicePixelRatio; };
  size(); addEventListener('resize', size);

  const color = v => v < .3 ? `rgba(16,80,60,${.3 + v})`
    : v < .6 ? `rgba(52,211,153,${v + .2})`
    : v < .82 ? `rgba(163,230,53,${v})`
    : `rgba(251,191,36,${v})`;

  function frame() {
    t += .08;
    if (body.classList.contains('listening')) {
      let colv = [];
      if (audio.running && audio.analyser) {
        audio.analyser.getByteFrequencyData(audio.freq);
        const usable = Math.floor(audio.freq.length * .55);
        for (let i = 0; i < n; i++) {
          const lo = Math.floor(Math.pow(i / n, 1.7) * usable);
          const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / n, 1.7) * usable));
          let m = 0; for (let j = lo; j < hi; j++) if (audio.freq[j] > m) m = audio.freq[j];
          colv.push((m / 255) * 1.15);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const base = Math.sin(t * 1.4 + i * .5) * .4 + .4;
          const chirp = Math.exp(-Math.pow(i - 12 - 8 * Math.sin(t * .6), 2) / 8) * Math.max(0, Math.sin(t * 3));
          colv.push(Math.min(1, base * .5 + chirp + Math.random() * .18));
        }
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

function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
