// Rendering: Erkennungs-Karte, Sammlung, Statistik-Diagramme, Detail-Sheet, Navigation.
import { SPECIES } from './species.js';
import { gemini } from './gemini.js';
import { todayNearby, groupByLocation } from './db.js';

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
  });
  $('sheetScrim').onclick = closeSheet;
  $('sheetClose').onclick = closeSheet;

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
      $('collHere').hidden = b.dataset.mode !== 'here';
      $('collGlobal').hidden = b.dataset.mode !== 'global';
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

function renderCollection(stats, dets, pos) {
  $('collStats').innerHTML = `
    <div class="stat"><div class="n">${stats.speciesCount}</div><div class="l">Arten gehört</div></div>
    <div class="stat"><div class="n">${stats.total}</div><div class="l">Aufnahmen</div></div>
    <div class="stat"><div class="n">${stats.rareCount}</div><div class="l">seltene</div></div>`;

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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function renderMap(dets) {
  const map = document.getElementById('map');
  if (!map) return;
  map.querySelectorAll('.pin').forEach(p => p.remove());

  const geo = dets.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
  const empty = document.getElementById('mapEmpty');
  const count = document.getElementById('mapCount');
  if (count) count.textContent = geo.length + (geo.length === 1 ? ' Fund' : ' Funde');
  if (!geo.length) { if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const d of geo) {
    if (d.lat < minLat) minLat = d.lat; if (d.lat > maxLat) maxLat = d.lat;
    if (d.lng < minLng) minLng = d.lng; if (d.lng > maxLng) maxLng = d.lng;
  }
  const padLat = ((maxLat - minLat) || 0.001) * 0.15, padLng = ((maxLng - minLng) || 0.001) * 0.15;
  minLat -= padLat; maxLat += padLat; minLng -= padLng; maxLng += padLng;
  const sLat = (maxLat - minLat) || 0.001, sLng = (maxLng - minLng) || 0.001;

  for (const d of geo.slice(-50)) {
    const x = clamp((d.lng - minLng) / sLng * 100, 4, 96);
    const y = clamp((1 - (d.lat - minLat) / sLat) * 100, 5, 95);
    const cls = d.rarity === 'rare' ? ' amber' : d.rarity === 'mammal' ? ' rose' : '';
    const pin = document.createElement('div');
    pin.className = 'pin' + cls;
    pin.style.left = x.toFixed(1) + '%';
    pin.style.top = y.toFixed(1) + '%';
    const label = d.rarity !== 'common' ? `<span class="lbl">${d.species}</span>` : '';
    pin.innerHTML = `<span class="dot"></span>${label}`;
    pin.addEventListener('click', () => openModal(d.key));
    map.appendChild(pin);
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
function closeSheet() { $('sheet').classList.remove('open'); }
