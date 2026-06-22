// Rendering: Erkennungs-Karte, Sammlung, Statistik-Diagramme, Detail-Sheet, Navigation.
import { SPECIES, SPECIES_LIST, ensureSpecies } from './species.js';
import { gemini } from './gemini.js';
import { todayNearby, todayNearbyDetections, groupByLocation, haversineKm, bearingDeg, computeStats } from './db.js';

const $ = id => document.getElementById(id);
const DEFAULT_GRAD = ['#0e5840', '#0a4733'];
const CAMERA_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

function avatarSVG(key, size) {
  const sp = SPECIES[key] || SPECIES.amsel;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" style="color:${sp.accent};width:${size}px;height:${size}px">${sp.icon}</svg>`;
}
function grad(key) { return (SPECIES[key] || {}).grad || DEFAULT_GRAD; }

// ---- Artbilder + Kurztext (Wikipedia-Summary, gecacht) ----
// Liefert sowohl das Vorschaubild als auch einen echten Auszugstext (extract) — letzterer
// füllt für generische BirdNET-Arten den Steckbrief mit echtem Inhalt statt eines Platzhalters,
// kostenlos und ohne Gemini-API-Key nötig.
const WIKI_CACHE = new Map();
async function fetchSpeciesWiki(sci) {
  if (!sci) return null;
  if (WIKI_CACHE.has(sci)) return WIKI_CACHE.get(sci);
  const cacheKey = 'waldohr.wiki.' + sci;
  try { const cached = localStorage.getItem(cacheKey); if (cached) { const v = JSON.parse(cached); WIKI_CACHE.set(sci, v); return v; } } catch {}
  const out = { img: null, extract: null };
  try {
    const r = await fetch('https://de.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(sci.replace(/ /g, '_')));
    if (r.ok) { const j = await r.json(); out.img = (j.thumbnail && j.thumbnail.source) || null; out.extract = j.extract || null; }
  } catch {}
  WIKI_CACHE.set(sci, out);
  try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch {}
  return out;
}
// ---- Bildnachweis (Urheber + Lizenz) von Wikimedia Commons ----
// Commons lässt nur frei lizenzierte Bilder zu (CC-BY, CC-BY-SA, CC0 o.ä.) — die meisten davon
// verlangen aber eine Namensnennung. Nur fürs Detail-Sheet abgefragt (dort ist das Foto am
// prominentesten), nicht für jeden kleinen Avatar in Listen.
const CREDIT_CACHE = new Map();
async function fetchImageCredit(imgUrl) {
  if (!imgUrl) return null;
  if (CREDIT_CACHE.has(imgUrl)) return CREDIT_CACHE.get(imgUrl);
  const cacheKey = 'waldohr.credit.' + imgUrl;
  try { const cached = localStorage.getItem(cacheKey); if (cached) { const v = JSON.parse(cached); CREDIT_CACHE.set(imgUrl, v); return v; } } catch {}
  let out = null;
  try {
    // Bei /thumb/-URLs ist das letzte Segment die größenpräfigierte Variante (z.B. "330px-Foo.jpg"),
    // nicht der echte Commons-Dateiname — Präfix abschneiden, um die Originaldatei zu treffen.
    const filename = decodeURIComponent(imgUrl.split('/').pop()).replace(/^\d+px-/, '');
    const r = await fetch('https://commons.wikimedia.org/w/api.php?action=query&titles=' +
      encodeURIComponent('File:' + filename) + '&prop=imageinfo&iiprop=extmetadata&format=json&origin=*');
    if (r.ok) {
      const j = await r.json();
      const pages = j.query && j.query.pages;
      const page = pages && Object.values(pages)[0];
      const meta = page && page.imageinfo && page.imageinfo[0] && page.imageinfo[0].extmetadata;
      if (meta) {
        const strip = h => (h || '').replace(/<[^>]+>/g, '').trim();
        out = {
          artist: strip(meta.Artist && meta.Artist.value),
          license: (meta.LicenseShortName && meta.LicenseShortName.value) || '',
          pageUrl: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(filename)
        };
      }
    }
  } catch {}
  CREDIT_CACHE.set(imgUrl, out);
  try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch {}
  return out;
}

// Setzt das Bild nachträglich auf einem Avatar-Element, sobald es geladen ist (Element kann inzwischen entfernt sein).
function applySpeciesImage(el, sci) {
  if (!el || !sci) return;
  fetchSpeciesWiki(sci).then(w => {
    if (!w || !w.img || !el.isConnected) return;
    el.style.backgroundImage = `url('${w.img}')`;
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

  // Einstellungen (Gemini-Key + Xeno-canto-Key + BirdNET-Server)
  const settings = $('settingsModal');
  const closeSettings = () => settings.classList.remove('open');
  $('gearBtn').onclick = () => {
    $('geminiKey').value = gemini.getKey();
    $('xcKey').value = xcKeyGet();
    const sv = serverUrlGet();
    $('serverUrl').value = sv;
    $('serverStat').textContent = sv ? 'gesetzt ✓' : 'nicht gesetzt (Demo)';
    settings.classList.add('open');
  };
  $('settingsScrim').onclick = closeSettings;
  $('settingsClose').onclick = closeSettings;
  $('settingsSave').onclick = () => {
    gemini.setKey($('geminiKey').value);
    xcKeySet($('xcKey').value);
    const before = serverUrlGet();
    const after = serverUrlSet($('serverUrl').value);
    closeSettings();
    if (after !== before) location.reload();   // Recognizer wird beim Start gewählt
  };

  // Beobachtungsliste — Schnellzugriff (Stern-Icon im Topbar) UND Settings-Eintrag öffnen dieselbe Liste.
  const favModal = $('favModal');
  const favSearch = $('favSearch');
  const openFavList = () => { if (favSearch) favSearch.value = ''; renderFavList(); favModal.classList.add('open'); };
  const favOpenBtn = $('favOpenBtn');
  if (favOpenBtn && favModal) favOpenBtn.onclick = () => { closeSettings(); openFavList(); };
  const favQuickBtn = $('favQuickBtn');
  if (favQuickBtn && favModal) favQuickBtn.onclick = openFavList;
  const favScrim = $('favScrim'); if (favScrim) favScrim.onclick = () => favModal.classList.remove('open');
  const favClose = $('favClose'); if (favClose) favClose.onclick = () => favModal.classList.remove('open');
  if (favSearch) {
    let t = null;
    favSearch.oninput = () => { clearTimeout(t); t = setTimeout(() => renderFavList(favSearch.value), 150); };
  }

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

  // Statistik: "Global" / "Heute hier"
  const statToggle = $('statToggle');
  if (statToggle) {
    statToggle.querySelectorAll('button').forEach(b => b.onclick = () => {
      statToggle.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      statMode = b.dataset.mode;
      renderStatsForMode();
    });
  }
}

function serverUrlGet() { try { return localStorage.getItem('waldohr.server') || ''; } catch { return ''; } }
function serverUrlSet(v) {
  v = (v || '').trim().replace(/\/$/, '');
  try { v ? localStorage.setItem('waldohr.server', v) : localStorage.removeItem('waldohr.server'); } catch {}
  return v;
}
function xcKeyGet() { try { return localStorage.getItem('waldohr.xc') || ''; } catch { return ''; } }
function xcKeySet(v) { v = (v || '').trim(); try { v ? localStorage.setItem('waldohr.xc', v) : localStorage.removeItem('waldohr.xc'); } catch {} return v; }

// ---- Beobachtungsliste: eigene Auswahl an Arten/Tieren, die wie "selten" einen Alarm auslösen ----
function loadFavorites() { try { return JSON.parse(localStorage.getItem('waldohr.favorites') || '[]'); } catch { return []; } }
function saveFavorites() { try { localStorage.setItem('waldohr.favorites', JSON.stringify([...FAVORITES])); } catch {} }
const FAVORITES = new Set(loadFavorites());

// Komplette BirdNET-Artenliste (6500+ Arten weltweit) — lazy nachgeladen aus dem Modell-Ordner
// (252 KB Text), erst sobald in der Beobachtungsliste tatsächlich gesucht wird, nicht beim Boot.
let allSpeciesPromise = null;
function loadAllSpecies() {
  if (!allSpeciesPromise) {
    allSpeciesPromise = fetch('models/birdnet/labels.txt').then(r => r.text()).then(text =>
      text.trim().split('\n').reduce((arr, line) => {
        const i = line.indexOf('_');
        if (i === -1) return arr;
        arr.push({ sci: line.slice(0, i).trim(), name: line.slice(i + 1).trim() });
        return arr;
      }, [])
    ).catch(e => { console.warn('labels.txt', e); return []; });
  }
  return allSpeciesPromise;
}

function favRow(entry) {
  const key = entry.key || '';
  const sp = key ? SPECIES[key] : null;
  const g = (sp && sp.grad) || DEFAULT_GRAD;
  const on = key && FAVORITES.has(key);
  return `<div class="favrow" data-sci="${entry.sci || ''}" data-name="${(entry.name || '').replace(/"/g, '&quot;')}" data-key="${key}">
    <div class="ph" style="background:linear-gradient(140deg,${g[0]},${g[1]})">${avatarSVG(key, 20)}</div>
    <div class="favmeta"><div class="nm">${entry.name}</div><div class="lt">${entry.sci || ''}</div></div>
    <button class="favstar${on ? ' on' : ''}">${on ? '★' : '☆'}</button>
  </div>`;
}

// Arten aus der vollen BirdNET-Liste werden erst beim ersten Markieren in den echten
// Katalog übernommen (ensureSpecies) — der Key bleibt dadurch identisch zu dem, den eine
// spätere Live-Erkennung derselben Art erzeugen würde.
function wireFavRows(list) {
  list.querySelectorAll('.favrow').forEach(row => {
    const btn = row.querySelector('.favstar');
    btn.onclick = () => {
      let key = row.dataset.key;
      if (!key) {
        key = ensureSpecies({ sci: row.dataset.sci, name: row.dataset.name });
        row.dataset.key = key;
        row.querySelector('.ph').innerHTML = avatarSVG(key, 20);
      }
      if (FAVORITES.has(key)) FAVORITES.delete(key); else FAVORITES.add(key);
      saveFavorites();
      btn.classList.toggle('on');
      btn.textContent = FAVORITES.has(key) ? '★' : '☆';
      renderMap(lastMapDets);   // Kartenfarben sofort an die neue Auswahl anpassen
    };
  });
}

async function renderFavList(query) {
  const list = $('favList'); if (!list) return;
  query = (query || '').trim().toLowerCase();

  if (!query) {
    // Ohne Suche: eigene Auswahl zuerst, dann die kuratierten/bereits gehörten Arten.
    const all = [...SPECIES_LIST].sort((a, b) =>
      (FAVORITES.has(b.key) ? 1 : 0) - (FAVORITES.has(a.key) ? 1 : 0) || a.name.localeCompare(b.name, 'de'));
    list.innerHTML = all.map(favRow).join('');
    wireFavRows(list);
    return;
  }

  list.innerHTML = '<div class="favhint">Suche…</div>';
  const allSpecies = await loadAllSpecies();
  const matches = allSpecies.filter(s => s.name.toLowerCase().includes(query) || s.sci.toLowerCase().includes(query)).slice(0, 150);
  // Bereits katalogisierte Treffer bekommen ihren echten Key (richtiges Icon + Favoriten-Status).
  const merged = matches.map(s => SPECIES_LIST.find(sp => sp.sci.toLowerCase() === s.sci.toLowerCase()) || s);
  list.innerHTML = merged.length ? merged.map(favRow).join('') : '<div class="favhint">Keine Art gefunden.</div>';
  wireFavRows(list);
}

// ---- Live-Liste „jetzt zu hören" ----
const LIVE = new Map();
const LIVE_TTL = 15000;
export function liveAdd(det) {
  const isNew = !LIVE.has(det.key);
  const e = LIVE.get(det.key) || { key: det.key, count: 0 };
  e.name = det.species; e.sci = det.sci; e.rarity = det.rarity;
  e.conf = det.confidence; e.ts = Date.now(); e.count++;
  LIVE.set(det.key, e);
  renderLive();
  // Fotografen-Funktion: einmalig beim Eintreffen alarmieren (selten ODER auf der Beobachtungsliste),
  // nicht bei jedem weiteren Erkennungsfenster derselben Art.
  if (isNew && (det.rarity !== 'common' || FAVORITES.has(det.key))) rareAlert(det);
}

// ---- Seltenheits-/Beobachtungs-Alarm: vibriert + zeigt einen Toast, wenn gerade eine relevante Art auftaucht ----
let rareToastTimer = null;
function rareAlert(det) {
  const toast = $('rareToast'); if (!toast) return;
  if (navigator.vibrate) { try { navigator.vibrate([120, 70, 120]); } catch {} }
  const isMammal = det.rarity === 'mammal';
  const isRare = det.rarity !== 'common';
  const icon = isMammal ? '🦌' : isRare ? '✨' : '⭐';
  const title = isMammal ? 'Seltenes Tier!' : isRare ? 'Seltene Art!' : 'Beobachtete Art!';
  toast.innerHTML = `<span class="rt-ico">${icon}</span>
    <div class="rt-txt"><div class="rt-t">${title}</div><div class="rt-s">${det.species} ist gerade hier</div></div>
    <button class="rt-cam" title="Foto aufnehmen">${CAMERA_ICON}</button>`;
  toast.className = 'rare-toast show' + (isMammal ? ' mammal' : !isRare ? ' fav' : '');
  toast.onclick = () => { openModal(det.key); toast.classList.remove('show'); };
  const camBtn = toast.querySelector('.rt-cam');
  if (camBtn) camBtn.onclick = ev => {
    ev.stopPropagation();
    if (typeof window.__waldohrCapturePhoto === 'function') window.__waldohrCapturePhoto(det.species);
    toast.classList.remove('show');
  };
  clearTimeout(rareToastTimer);
  rareToastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
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
      <button class="lr-photo" title="Foto aufnehmen">${CAMERA_ICON}</button>
      <button class="lr-rec" title="Diesen Ruf aufnehmen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg></button>`;
    ['.lr-av', '.lr-meta', '.lr-conf'].forEach(sel => { const el = row.querySelector(sel); if (el) el.onclick = () => openModal(e.key); });
    const recBtn = row.querySelector('.lr-rec');
    recBtn.onclick = ev => { ev.stopPropagation(); if (typeof window.__waldohrRecordSpecies === 'function') window.__waldohrRecordSpecies(e.name); };
    const photoBtn = row.querySelector('.lr-photo');
    photoBtn.onclick = ev => { ev.stopPropagation(); if (typeof window.__waldohrCapturePhoto === 'function') window.__waldohrCapturePhoto(e.name); };
    applySpeciesImage(row.querySelector('.lr-av'), e.sci);
    list.appendChild(row);
  }
}

export function renderAll(stats, dets, pos) {
  renderCollection(stats, dets || [], pos || null);
  lastStatDets = dets || []; lastStatPos = pos || null;
  renderStatsForMode();
}

let statMode = 'here', lastStatDets = [], lastStatPos = null;
function renderStatsForMode() {
  const stats = statMode === 'here' ? computeStats(todayNearbyDetections(lastStatDets, lastStatPos)) : computeStats(lastStatDets);
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
export function setLivePos(pos) { livePos = pos; updateCompassUI(); updateUserMarker(); }

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

let mapInst = null, markersLayer = null, userMarker = null, lastMapDets = [];
export async function renderMap(dets) {
  lastMapDets = dets;
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  const geo = dets.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
  const empty = document.getElementById('mapEmpty');
  const count = document.getElementById('mapCount');
  if (count) count.textContent = geo.length + (geo.length === 1 ? ' Fund' : ' Funde');
  // Eigene Position zeigen, auch ganz ohne verortete Funde — nicht hinter dem Leerzustand verstecken.
  if (empty) empty.hidden = !!geo.length || !!livePos;
  // Nur abbrechen, wenn die Karte noch nie initialisiert wurde — sonst müssen alte Pins
  // weichen können (z.B. nach "Datenbank zurücksetzen"), auch ohne aktuellen GPS-Fix.
  if (!geo.length && !livePos && !mapInst) return;

  let L;
  try { L = await loadLeaflet(); } catch (e) { console.warn('leaflet', e); return; }
  if (!mapEl.isConnected) return;

  if (!mapInst) {
    const initCenter = geo.length ? [geo[geo.length - 1].lat, geo[geo.length - 1].lng] : [livePos.lat, livePos.lng];
    mapInst = L.map(mapEl, { attributionControl: true }).setView(initCenter, 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende'
    }).addTo(mapInst);
    markersLayer = L.layerGroup().addTo(mapInst);
  }
  markersLayer.clearLayers();
  // Funde von Arten aus der Beobachtungsliste heben sich farblich ab — unabhängig von ihrer Seltenheit.
  const colorFor = d => FAVORITES.has(d.key) ? '#a3e635' : d.rarity === 'rare' ? '#fbbf24' : d.rarity === 'mammal' ? '#fb7185' : '#34d399';
  const bounds = [];
  for (const d of geo.slice(-200)) {
    const m = L.circleMarker([d.lat, d.lng], { radius: 7, color: colorFor(d), weight: 2, fillColor: colorFor(d), fillOpacity: .8 });
    m.on('click', () => openModal(d.key));
    m.addTo(markersLayer);
    bounds.push([d.lat, d.lng]);
  }
  if (bounds.length > 1) mapInst.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  else if (bounds.length === 1) mapInst.setView(bounds[0], 15);
  else if (livePos) mapInst.setView([livePos.lat, livePos.lng], 14);
  updateUserMarker();
  setTimeout(() => mapInst && mapInst.invalidateSize(), 60);
}

// "Du bist hier"-Marker — eigene aktuelle Position, unabhängig von den Fund-Pins.
function updateUserMarker() {
  if (!mapInst || !window.L || !livePos) return;
  const L = window.L;
  if (!userMarker) {
    const icon = L.divIcon({ className: 'you-marker', html: '<span class="you-pulse"></span><span class="you-dot"></span>', iconSize: [20, 20], iconAnchor: [10, 10] });
    userMarker = L.marker([livePos.lat, livePos.lng], { icon, interactive: false, zIndexOffset: 1000 }).addTo(mapInst);
  } else {
    userMarker.setLatLng([livePos.lat, livePos.lng]);
  }
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

// ---- Echter Vogelruf (Xeno-canto API v3, braucht eigenen kostenlosen Key), gecacht ----
// Macht "Ruf anhören" tatsächlich funktionsfähig (vorher: Button ohne jede Funktion).
const AUDIO_CACHE = new Map();
async function fetchSpeciesAudio(sci) {
  if (!sci) return null;
  const key = xcKeyGet();
  if (!key) return null;
  if (AUDIO_CACHE.has(sci)) return AUDIO_CACHE.get(sci);
  const cacheKey = 'waldohr.audio.' + sci;
  try { const cached = localStorage.getItem(cacheKey); if (cached) { const v = cached === '-' ? null : cached; AUDIO_CACHE.set(sci, v); return v; } } catch {}
  let url = null;
  try {
    const r = await fetch('https://xeno-canto.org/api/3/recordings?query=' + encodeURIComponent(`sp:"${sci}" q:A`) + '&key=' + encodeURIComponent(key));
    if (r.ok) {
      const j = await r.json();
      const rec = j.recordings && j.recordings.find(x => x.file || x.fileUrl || x.audio);
      if (rec) { url = rec.file || rec.fileUrl || rec.audio; if (url.startsWith('//')) url = 'https:' + url; }
    } else console.warn('xeno-canto', r.status, await r.text().catch(() => ''));
  } catch (e) { console.warn('xeno-canto', e); }
  AUDIO_CACHE.set(sci, url);
  try { localStorage.setItem(cacheKey, url || '-'); } catch {}
  return url;
}
let callAudio = null;
function stopCallAudio() {
  if (callAudio) { callAudio.pause(); callAudio = null; }
  const icon = $('mPlayIcon'), label = $('mPlayLabel');
  if (icon) icon.innerHTML = '<path d="M6 4l14 8-14 8z"/>';
  if (label) label.textContent = 'Ruf anhören';
}
async function togglePlayCall(sci) {
  if (callAudio && !callAudio.paused) { stopCallAudio(); return; }
  if (!xcKeyGet()) {
    const label = $('mPlayLabel'); if (label) label.textContent = 'Xeno-canto-Key fehlt (⚙ Einstellungen)';
    setTimeout(() => { if (label) label.textContent = 'Ruf anhören'; }, 3000);
    return;
  }
  const label = $('mPlayLabel'); if (label) label.textContent = 'Suche Aufnahme …';
  const url = await fetchSpeciesAudio(sci);
  if (!url) { if (label) label.textContent = 'Keine Aufnahme gefunden'; setTimeout(() => { if (label) label.textContent = 'Ruf anhören'; }, 2500); return; }
  callAudio = new Audio(url);
  callAudio.onended = stopCallAudio;
  callAudio.onerror = () => { if (label) label.textContent = 'Wiedergabe fehlgeschlagen'; };
  try { await callAudio.play(); } catch (e) { console.warn('play', e); if (label) label.textContent = 'Wiedergabe fehlgeschlagen'; return; }
  if (label) label.textContent = 'Spielt … (Xeno-canto)';
  const icon = $('mPlayIcon'); if (icon) icon.innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
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

  stopCallAudio();
  const playBtn = $('mPlayBtn'); if (playBtn) playBtn.onclick = () => togglePlayCall(sp.sci);

  // Bildnachweis: nur einblenden, wenn ein Foto geladen wurde und Commons Urheber/Lizenz liefert.
  const creditEl = $('mPhotoCredit');
  if (creditEl) { creditEl.hidden = true; creditEl.onclick = null; }

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

  const token = ++modalToken;
  let textSource = 'catalog';

  if (sp.sci) {
    fetchSpeciesWiki(sp.sci).then(w => {
      if (token !== modalToken || !w || !w.img) return;
      fetchImageCredit(w.img).then(c => {
        if (token !== modalToken || !creditEl || !c || (!c.artist && !c.license)) return;
        creditEl.innerHTML = `📷 ${c.artist || 'Wikimedia Commons'}${c.license ? ' · ' + c.license : ''}`;
        creditEl.onclick = () => c.pageUrl && window.open(c.pageUrl, '_blank');
        creditEl.hidden = false;
      });
    });
  }

  // Generische BirdNET-Arten (key beginnt mit "x_") haben nur einen Platzhalter-Steckbrief —
  // Wikipedia-Auszug liefert echten Inhalt, kostenlos & ohne API-Key. Gemini (falls vorhanden) gewinnt immer.
  if (key.startsWith('x_') && sp.sci) {
    fetchSpeciesWiki(sp.sci).then(w => {
      if (token !== modalToken || textSource === 'gemini' || !w || !w.extract) return;
      $('mSteckbrief').textContent = w.extract;
      textSource = 'wiki';
    });
  }

  // Optionale Gemini-Anreicherung (gecacht, läuft nur 1× pro Art/Gerät; danach kommt's aus dem localStorage-Cache).
  if (gemini.hasKey() && sp.sci) {
    if (badge) { badge.hidden = false; badge.textContent = '✨ Gemini …'; }
    gemini.enrich(sp.sci, sp.name).then(res => {
      if (token !== modalToken) return;
      if (!res) { if (badge) badge.hidden = true; return; }
      $('mMeaning').textContent = res.meaning;
      $('mSteckbrief').textContent = res.steckbrief;
      textSource = 'gemini';
      if (badge) badge.textContent = '✨ erklärt von Gemini';
    });
  }
}
function closeSheet() { $('sheet').classList.remove('open'); stopOrientation(); stopCallAudio(); curTargetGeo = null; }
