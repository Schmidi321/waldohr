// Rendering: Erkennungs-Karte, Sammlung, Statistik-Diagramme, Detail-Sheet, Navigation.
import { SPECIES } from './species.js';
import { gemini } from './gemini.js';
import { todayNearby, groupByLocation, haversineKm, bearingDeg } from './db.js';

const $ = id => document.getElementById(id);
const DEFAULT_GRAD = ['#0e5840', '#0a4733'];

function avatarSVG(key, size) {
  const sp = SPECIES[key] || SPECIES.amsel;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" style="color:${sp.accent};width:${size}px;height:${size}px">${sp.icon}</svg>`;
}
function grad(key) { return (SPECIES[key] || {}).grad || DEFAULT_GRAD; }

// ---- Artbilder (Wikipedia-Thumbnail, gecacht) — rein optionale Verschönerung ----
const IMG_CACHE = new Map();
async function fetchSpeciesImage(sci) {
  if (!sci) return null;
  if (IMG_CACHE.has(sci)) return IMG_CACHE.get(sci);
  const cacheKey = 'waldohr.img.' + sci;
  try { const cached = localStorage.getItem(cacheKey); if (cached) { IMG_CACHE.set(sci, cached); return cached; } } catch {}
  let url = null;
  try {
    const r = await fetch('https://de.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(sci.replace(/ /g, '_')));
    if (r.ok) { const j = await r.json(); url = (j.thumbnail && j.thumbnail.source) || null; }
  } catch {}
  if (url) { IMG_CACHE.set(sci, url); try { localStorage.setItem(cacheKey, url); } catch {} }
  return url;
}
// Setzt das Bild nachträglich auf einem Avatar-Element, sobald es geladen ist (Element kann inzwischen entfernt sein).
function applySpeciesImage(el, sci) {
  if (!el || !sci) return;
  fetchSpeciesImage(sci).then(url => {
    if (!url || !el.isConnected) return;
    el.style.backgroundImage = `url('${url}')`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    const svg = el.querySelector('svg'); if (svg) svg.style.opacity = '0';
  });
}

function rarityTag(r) {
  if (r === 'rare') return '<span class="tag rare">selten</span>';
  if (r === 'mammal') return '<span class="tag rare" style="color:var(--rose);border-color:#fb718555;background:#7c1d2e33">Säuger</span>';
  return '<span class="tag new">neu</span>';
}
function badge(s) {
  if (s.rarity === 'rare') return '<span class="badge" style="background:#7c2d1233;color:var(--amber)">selten</span>';
  if (s.rarity === 'mammal') return '<span class="badge" style="background:#7c1d2e33;color:var(--rose)">Säuger</span>';
  if (Date.now() - s.last < 2 * 864e5) return '<span class="badge" style="background:#16653433;color:var(--lime)">neu</span>';
  return '';
}

export function initUI() {
  const nav = document.querySelectorAll('.nav button');
  nav.forEach(b => b.onclick = () => {
    nav.forEach(x => x.classList.remove('on')); b.classList.add('on');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $('v-' + b.dataset.v).classList.add('active');
    if (b.dataset.v === 'map') invalidateMapSize();
  });
  $('sheetScrim').onclick = closeSheet;
  $('sheetClose').onclick = closeSheet;
  const compassBtn = $('mCompassBtn');
  if (compassBtn) compassBtn.onclick = activateCompass;

  // Einstellungen (Gemini-Key + BirdNET-Server)
  const settings = $('settingsModal');
  const closeSettings = () => settings.classList.remove('open');
  $('gearBtn').onclick = () => {
    $('geminiKey').value = gemini.getKey();
    const sv = serverUrlGet();
    $('serverUrl').value = sv;
    $('serverStat').textContent = sv ? 'gesetzt ✓' : 'nicht gesetzt (Demo)';
    settings.classList.add('open');
  };
  $('settingsScrim').onclick = closeSettings;
  $('settingsClose').onclick = closeSettings;
  $('settingsSave').onclick = () => {
    gemini.setKey($('geminiKey').value);
    const before = serverUrlGet();
    const after = serverUrlSet($('serverUrl').value);
    closeSettings();
    if (after !== before) location.reload();   // Recognizer wird beim Start gewählt
  };

  setInterval(renderLive, 2000);   // abgelaufene Einträge entfernen

  // Sammlung: "Heute hier" / "Global nach Ort"
  const toggle = $('collToggle');
  if (toggle) {
    toggle.querySelectorAll('button').forEach(b => b.onclick = () => {
      toggle.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      collMode = b.dataset.mode;
      $('collHere').hidden = collMode !== 'here';
      $('collGlobal').hidden = collMode !== 'global';
      renderCollStats();
    });
  }
}

function serverUrlGet() { try { return localStorage.getItem('waldohr.server') || ''; } catch { return ''; } }
function serverUrlSet(v) {
  v = (v || '').trim().replace(/\/$/, '');
  try { v ? localStorage.setItem('waldohr.server', v) : localStorage.removeItem('waldohr.server'); } catch {}
  return v;
}

// ---- Live-Liste „jetzt zu hören" ----
const LIVE = new Map();
const LIVE_TTL = 15000;
export function liveAdd(det) {
  const e = LIVE.get(det.key) || { key: det.key, count: 0 };
  e.name = det.species; e.sci = det.sci; e.rarity = det.rarity;
  e.conf = det.confidence; e.ts = Date.now(); e.count++;
  LIVE.set(det.key, e);
  renderLive();
}
function renderLive() {
  const list = $('liveList'); if (!list) return;
  const now = Date.now();
  for (const [k, e] of LIVE) if (now - e.ts > LIVE_TTL) LIVE.delete(k);
  const arr = [...LIVE.values()].sort((a, b) => b.ts - a.ts);
  const cnt = $('liveCount'); if (cnt) cnt.textContent = arr.length;
  const empty = $('liveEmpty');
  list.querySelectorAll('.live-row').forEach(r => r.remove());
  if (!arr.length) { if (empty) empty.style.display = ''; return; }
  if (empty) empty.style.display = 'none';
  for (const e of arr) {
    const g = grad(e.key), fresh = now - e.ts < 2500;
    const row = document.createElement('div');
    row.className = 'live-row' + (fresh ? ' fresh' : '');
    row.innerHTML = `<div class="lr-av" style="background:linear-gradient(140deg,${g[0]},${g[1]})">${avatarSVG(e.key, 24)}</div>
      <div class="lr-meta"><div class="lr-nm">${e.name} ${rarityTag(e.rarity)}</div><div class="lr-lt">${e.sci}</div></div>
      <div class="lr-conf">${Math.round(e.conf * 100)}%</div>
      <button class="lr-rec" title="Diesen Ruf aufnehmen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg></button>`;
    ['.lr-av', '.lr-meta', '.lr-conf'].forEach(sel => { const el = row.querySelector(sel); if (el) el.onclick = () => openModal(e.key); });
    const recBtn = row.querySelector('.lr-rec');
    recBtn.onclick = ev => { ev.stopPropagation(); if (typeof window.__waldohrRecordSpecies === 'function') window.__waldohrRecordSpecies(e.name); };
    applySpeciesImage(row.querySelector('.lr-av'), e.sci);
    list.appendChild(row);
  }
}

export function renderAll(stats, dets, pos) {
  renderCollection(stats, dets || [], pos || null);
  renderStats(stats);
  drawDayChart(stats.hourly);
}

function speciesCard(s) {
  const g = grad(s.key);
  return `<div class="spc" data-key="${s.key}">${badge(s)}
    <div class="ph" style="background:linear-gradient(140deg,${g[0]},${g[1]})">${avatarSVG(s.key, 34)}</div>
    <div class="nm">${s.name}</div><div class="lt">${s.sci}</div>
    <div class="cnt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>${s.count}× gehört</div>
  </div>`;
}

let collMode = 'here';
let lastCollStats = null, lastCollDets = [], lastCollPos = null;
let livePos = null;
// Wird bei jedem GPS-Update aufgerufen (auch ohne vollen Re-Render) — fürs Kompass-Feature.
export function setLivePos(pos) { livePos = pos; updateCompassUI(); }

function renderCollStats() {
  if (!lastCollStats) return;
  let n, total, rare;
  if (collMode === 'here') {
    const here = todayNearby(lastCollDets, lastCollPos);
    n = here.length; total = here.reduce((a, s) => a + s.count, 0); rare = here.filter(s => s.rarity !== 'common').length;
  } else {
    n = lastCollStats.speciesCount; total = lastCollStats.total; rare = lastCollStats.rareCount;
  }
  $('collStats').innerHTML = `
    <div class="stat"><div class="n">${n}</div><div class="l">Arten gehört</div></div>
    <div class="stat"><div class="n">${total}</div><div class="l">Aufnahmen</div></div>
    <div class="stat"><div class="n">${rare}</div><div class="l">seltene</div></div>`;
}

function renderCollection(stats, dets, pos) {
  lastCollStats = stats; lastCollDets = dets; lastCollPos = pos;
  renderCollStats();

  // "Heute hier" — heutige Funde in der Nähe des aktuellen Standorts
  const hereGrid = $('hereGrid');
  if (hereGrid) {
    const here = todayNearby(dets, pos);
    hereGrid.innerHTML = here.map(s => speciesCard(s)).join('') ||
      `<div class="lt" style="color:var(--faint);grid-column:1/-1">${pos ? 'Heute hier noch nichts entdeckt.' : 'Standort aktivieren, um Funde in deiner Nähe zu sehen.'}</div>`;
    hereGrid.querySelectorAll('.spc').forEach(el => {
      el.onclick = () => openModal(el.dataset.key);
      applySpeciesImage(el.querySelector('.ph'), (SPECIES[el.dataset.key] || {}).sci);
    });
  }

  // "Global nach Ort" — alle Funde, zuletzt entdeckt + nach Fundort gruppiert
  const recent = [...stats.perSpecies].sort((a, b) => b.last - a.last).slice(0, 8);
  $('collGrid').innerHTML = recent.map(s => speciesCard(s)).join('') || '<div class="lt" style="color:var(--faint)">Noch nichts gehört.</div>';
  document.querySelectorAll('#collGrid .spc').forEach(el => {
    el.onclick = () => openModal(el.dataset.key);
    applySpeciesImage(el.querySelector('.ph'), (SPECIES[el.dataset.key] || {}).sci);
  });

  const locList = $('locList');
  if (locList) {
    const groups = groupByLocation(dets);
    locList.innerHTML = groups.map((g, i) => `
      <div class="locrow">
        <div class="lr-head">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>
          <span class="nm">Fundort ${i + 1}</span>
          <span class="cnt">${g.speciesCount} Arten · ${g.total}×</span>
        </div>
        <div class="lr-species">${g.perSpecies.map(s => `<span class="lr-chip" data-key="${s.key}">${s.name} ×${s.count}</span>`).join('')}</div>
      </div>`).join('') || '<div class="lt" style="color:var(--faint)">Noch keine verorteten Funde.</div>';
    locList.querySelectorAll('.lr-chip').forEach(el => el.onclick = () => openModal(el.dataset.key));
  }
}

function renderStats(stats) {
  const ico = {
    rec:'<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    bird:'<path d="M3 12a9 9 0 0 1 9-9"/><path d="M7 12a5 5 0 0 1 5-5"/><circle cx="12" cy="12" r="1.6"/>',
    fire:'<path d="M12 3c2 3 4 5 4 8a4 4 0 0 1-8 0c0-1 .5-2 1-3 .5 2 2 2 2 0 0-2-1-4 1-5z"/>',
    plus:'<path d="M12 5v14M5 12h14"/>'
  };
  const kpi = (n, label, icon, gradCls) =>
    `<div class="kpi"><div class="n${gradCls ? ' grad' : ''}">${n}</div><div class="l"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>${label}</div></div>`;
  $('kpis').innerHTML =
    kpi(stats.total, 'Aufnahmen gesamt', ico.rec, true) +
    kpi(stats.speciesCount, 'Arten', ico.bird, true) +
    kpi(stats.streak, 'Tage in Serie', ico.fire, false) +
    kpi('+' + stats.newThisWeek, 'neu diese Woche', ico.plus, true);

  const top = stats.perSpecies.slice(0, 5);
  const tmax = Math.max(1, ...top.map(s => s.count));
  $('topSpecies').innerHTML = top.map((s, i) =>
    `<div class="row"><span class="nm">${s.name}</span>
      <div class="track"><div class="fill" style="width:${Math.round(s.count / tmax * 100)}%;animation-delay:${(0.05 + i * 0.07).toFixed(2)}s"></div></div>
      <span class="vv">${s.count}</span></div>`
  ).join('') || '<div class="lt" style="color:var(--faint)">Noch keine Daten</div>';

  const wmax = Math.max(1, ...stats.week.map(d => d.count));
  $('weekBars').innerHTML = stats.week.map((d, i) => {
    const hi = d.count === wmax && d.count > 0 ? ' hi' : '';
    return `<div class="col"><span class="vv">${d.count}</span>
      <i class="bar${hi}" style="height:${Math.round(d.count / wmax * 100)}%;animation-delay:${(0.05 + i * 0.06).toFixed(2)}s"></i>
      <span class="d">${d.label}</span></div>`;
  }).join('');
}

function smooth(p) {
  let d = `M${p[0][0].toFixed(1)},${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] || p[i], b = p[i], c = p[i + 1], e = p[i + 2] || c;
    const c1x = b[0] + (c[0] - a[0]) / 6, c1y = b[1] + (c[1] - a[1]) / 6;
    const c2x = c[0] - (e[0] - b[0]) / 6, c2y = c[1] - (e[1] - b[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${c[0].toFixed(1)},${c[1].toFixed(1)}`;
  }
  return d;
}

export function drawDayChart(hourly) {
  const line = $('dayLine'); if (!line) return;
  const fallback = [.05,.04,.04,.05,.2,.55,.95,.85,.65,.5,.42,.38,.35,.36,.4,.45,.5,.55,.7,.82,.7,.45,.2,.1];
  const sum = hourly.reduce((a, b) => a + b, 0);
  const src = sum > 0 ? hourly : fallback;
  const max = Math.max(1, ...src);
  const act = src.map(v => v / max);
  const L = 14, R = 306, T = 16, B = 96;
  const pts = act.map((v, i) => [L + (i / (act.length - 1)) * (R - L), B - v * (B - T)]);
  const d = smooth(pts);
  line.setAttribute('d', d);
  $('dayArea').setAttribute('d', d + ` L${R},104 L${L},104 Z`);
  let mi = 0; act.forEach((v, i) => { if (v > act[mi]) mi = i; });
  const pk = $('dayPeak'); pk.setAttribute('cx', pts[mi][0].toFixed(1)); pk.setAttribute('cy', pts[mi][1].toFixed(1));
}

// ---- Echte Karte (Leaflet + OpenStreetMap), lazy geladen erst wenn die Kartenansicht gebraucht wird ----
let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      link.setAttribute('data-leaflet', '');
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error('Leaflet konnte nicht geladen werden'));
    document.head.appendChild(script);
  });
  return leafletPromise;
}

let mapInst = null, markersLayer = null;
export async function renderMap(dets) {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  const geo = dets.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
  const empty = document.getElementById('mapEmpty');
  const count = document.getElementById('mapCount');
  if (count) count.textContent = geo.length + (geo.length === 1 ? ' Fund' : ' Funde');
  if (empty) empty.hidden = !!geo.length;
  if (!geo.length) return;

  let L;
  try { L = await loadLeaflet(); } catch (e) { console.warn('leaflet', e); return; }
  if (!mapEl.isConnected) return;

  if (!mapInst) {
    mapInst = L.map(mapEl, { attributionControl: true }).setView([geo[geo.length - 1].lat, geo[geo.length - 1].lng], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende'
    }).addTo(mapInst);
    markersLayer = L.layerGroup().addTo(mapInst);
  }
  markersLayer.clearLayers();
  const colorFor = d => d.rarity === 'rare' ? '#fbbf24' : d.rarity === 'mammal' ? '#fb7185' : '#34d399';
  const bounds = [];
  for (const d of geo.slice(-200)) {
    const m = L.circleMarker([d.lat, d.lng], { radius: 7, color: colorFor(d), weight: 2, fillColor: colorFor(d), fillOpacity: .8 });
    m.on('click', () => openModal(d.key));
    m.addTo(markersLayer);
    bounds.push([d.lat, d.lng]);
  }
  if (bounds.length > 1) mapInst.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  else mapInst.setView(bounds[0], 15);
  setTimeout(() => mapInst && mapInst.invalidateSize(), 60);
}

// Nach Tab-Wechsel auf die Kartenansicht: Leaflet kannte die Containergröße evtl. noch nicht (display:none beim Init).
export function invalidateMapSize() {
  if (mapInst) setTimeout(() => mapInst.invalidateSize(), 80);
}

// ---- Kompass: Richtung & Entfernung zum letzten Fund einer Art (Detail-Sheet) ----
// Echte Peilung aus DeviceOrientationEvent + Bearing-Formel — kein Fake mehr wie das alte zufällige `dir`-Feld.
let curTargetGeo = null;
let curHeading = null;
let orientationHandler = null, orientationEvName = null;

function compassSupported() { return typeof DeviceOrientationEvent !== 'undefined'; }
function needsPermission() { return compassSupported() && typeof DeviceOrientationEvent.requestPermission === 'function'; }

function getHeading(e) {
  if (typeof e.webkitCompassHeading === 'number') return e.webkitCompassHeading;   // iOS Safari
  if (e.absolute && typeof e.alpha === 'number') return (360 - e.alpha) % 360;     // Android/Chrome
  return null;
}
function startOrientation() {
  if (orientationHandler) return;
  orientationHandler = e => { const h = getHeading(e); if (h != null) { curHeading = h; updateCompassUI(); } };
  orientationEvName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(orientationEvName, orientationHandler);
}
function stopOrientation() {
  if (!orientationHandler) return;
  window.removeEventListener(orientationEvName, orientationHandler);
  orientationHandler = null; curHeading = null;
}
async function activateCompass() {
  if (needsPermission()) {
    try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return; }
    catch (e) { console.warn('compass perm', e); return; }
  }
  startOrientation();
  const btn = $('mCompassBtn'); if (btn) btn.hidden = true;
}
function lastGeoForKey(key) {
  let best = null;
  for (const d of lastCollDets) {
    if (d.key !== key || typeof d.lat !== 'number' || typeof d.lng !== 'number') continue;
    if (!best || d.ts > best.ts) best = d;
  }
  return best;
}
function updateCompassUI() {
  const block = $('mDirBlock');
  if (!block || block.hidden || !curTargetGeo) return;
  const cur = livePos || lastCollPos;
  if (!cur) return;
  const distM = haversineKm(cur, curTargetGeo) * 1000;
  $('mDirDist').textContent = distM < 1000 ? Math.round(distM) + ' m' : (distM / 1000).toFixed(1) + ' km';
  const bearing = bearingDeg(cur, curTargetGeo);
  const arrow = $('mCompassArrow');
  if (curHeading != null) {
    arrow.style.transform = `rotate(${(bearing - curHeading + 360) % 360}deg)`;
    $('mDirSub').textContent = 'Kompass aktiv — Pfeil zeigt zum Fund';
  } else {
    arrow.style.transform = `rotate(${bearing}deg)`;
    $('mDirSub').textContent = 'Peilung ab Norden · Kompass für Live-Pfeil aktivieren';
  }
}

let modalToken = 0;
function openModal(key) {
  const sp = SPECIES[key] || SPECIES.amsel;
  const g = sp.grad || DEFAULT_GRAD;
  $('mName').textContent = sp.name;
  $('mSci').textContent = sp.sci;
  const av = $('mAvatar');
  av.style.background = `linear-gradient(140deg,${g[0]},${g[1]})`;
  av.style.backgroundImage = ''; av.style.backgroundSize = ''; av.style.backgroundPosition = '';
  av.innerHTML = avatarSVG(key, 34);
  applySpeciesImage(av, sp.sci);
  $('mMeaning').innerHTML = sp.meaning;
  $('mSteckbrief').textContent = sp.steckbrief;
  const badge = $('mAi'); if (badge) badge.hidden = true;
  $('sheet').classList.add('open');

  // Richtungsanzeige: nur sichtbar, wenn es einen verorteten Fund dieser Art gibt UND wir selbst einen Standort haben.
  curTargetGeo = lastGeoForKey(key);
  const dirBlock = $('mDirBlock');
  const cur = livePos || lastCollPos;
  if (dirBlock) {
    if (curTargetGeo && cur) {
      dirBlock.hidden = false;
      const btn = $('mCompassBtn');
      if (needsPermission() && !orientationHandler) { if (btn) btn.hidden = false; }
      else { if (btn) btn.hidden = true; if (!orientationHandler) startOrientation(); }
      updateCompassUI();
    } else {
      dirBlock.hidden = true;
    }
  }

  // Optionale Gemini-Anreicherung (gecacht); ältere Anfrage verwerfen via Token.
  if (gemini.hasKey() && sp.sci) {
    const token = ++modalToken;
    if (badge) { badge.hidden = false; badge.textContent = '✨ Gemini …'; }
    gemini.enrich(sp.sci, sp.name).then(res => {
      if (token !== modalToken) return;
      if (!res) { if (badge) badge.hidden = true; return; }
      $('mMeaning').textContent = res.meaning;
      $('mSteckbrief').textContent = res.steckbrief;
      if (badge) badge.textContent = '✨ erklärt von Gemini';
    });
  }
}
function closeSheet() { $('sheet').classList.remove('open'); stopOrientation(); curTargetGeo = null; }
