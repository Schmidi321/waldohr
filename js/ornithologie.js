import { getDauerUeberwachung, setDauerUeberwachung } from './alarm.js';
import { allDetections, qualifyingDetections } from './db.js';

const $ = id => document.getElementById(id);
const todayStr = () => new Date().toISOString().slice(0, 10);

// ---- CSV / download helpers ----
function _csvBlob(rows) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  return new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
}
function _dlBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}
function _groupByDateSpecies(dets) {
  const map = new Map();
  for (const d of dets) {
    const date = new Date(d.ts).toISOString().slice(0, 10);
    const k = date + '__' + d.key;
    if (!map.has(k)) map.set(k, { species: d.species, sci: d.sci || '', key: d.key, date, count: 0, firstTs: d.ts, lat: d.lat, lng: d.lng });
    const g = map.get(k);
    g.count++;
    if (d.ts < g.firstTs) { g.firstTs = d.ts; if (d.lat != null) g.lat = d.lat; if (d.lng != null) g.lng = d.lng; }
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.species.localeCompare(b.species));
}

// ---- Export functions ----
function _exportEbird(dets) {
  const groups = _groupByDateSpecies(dets);
  const rows = [['Common Name', 'Scientific Name', 'Count', 'Date', 'Start Time', 'Duration (Min)', 'All Obs Reported', 'Location', 'Latitude', 'Longitude', 'Protocol', 'Checklist Comments']];
  for (const g of groups) {
    const time = new Date(g.firstTs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    rows.push([g.species, g.sci, g.count, g.date, time, '60', 'Y', 'WaldOhr', g.lat?.toFixed(6) ?? '', g.lng?.toFixed(6) ?? '', 'Stationary', 'WaldOhr app']);
  }
  _dlBlob(_csvBlob(rows), 'waldohr-ebird-' + todayStr() + '.csv');
}
function _exportOrnitho(dets) {
  const groups = _groupByDateSpecies(dets);
  const rows = [['Art', 'Wissenschaftlicher Name', 'Anzahl', 'Datum', 'Uhrzeit', 'Breitengrad', 'Längengrad', 'Ort', 'Quelle']];
  for (const g of groups) {
    const time = new Date(g.firstTs).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    rows.push([g.species, g.sci, g.count, g.date, time, g.lat?.toFixed(6) ?? '', g.lng?.toFixed(6) ?? '', 'WaldOhr', 'WaldOhr app']);
  }
  _dlBlob(_csvBlob(rows), 'waldohr-ornitho-' + todayStr() + '.csv');
}
function _exportBirdnetNotebook(dets) {
  const rows = [['Species', 'Scientific Name', 'Confidence', 'Timestamp', 'Date', 'Time', 'Latitude', 'Longitude', 'Source', 'App']];
  const sorted = [...dets].sort((a, b) => a.ts - b.ts);
  for (const d of sorted) {
    const dt = new Date(d.ts);
    rows.push([
      d.species, d.sci || '',
      d.confidence != null ? d.confidence.toFixed(2) : '',
      d.ts,
      dt.toISOString().slice(0, 10),
      dt.toTimeString().slice(0, 8),
      d.lat?.toFixed(6) ?? '', d.lng?.toFixed(6) ?? '',
      d.source || 'mic', 'WaldOhr'
    ]);
  }
  _dlBlob(_csvBlob(rows), 'waldohr-birdnet-notebook-' + todayStr() + '.csv');
}
function _exportNabu(dets) {
  const groups = _groupByDateSpecies(dets);
  const eintraege = groups.map(g => ({
    art: g.species,
    wissenschaftlich: g.sci,
    anzahl: g.count,
    datum: g.date,
    uhrzeit: new Date(g.firstTs).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
    koordinaten: g.lat != null ? { lat: parseFloat(g.lat.toFixed(6)), lng: parseFloat(g.lng.toFixed(6)) } : null,
    quelle: 'WaldOhr'
  }));
  const json = JSON.stringify({ version: '1.0', exportiert: new Date().toISOString(), eintraege }, null, 2);
  _dlBlob(new Blob([json], { type: 'application/json' }), 'waldohr-nabu-' + todayStr() + '.json');
}

// ---- Dauerüberwachung ----
function _initDU() {
  const du = getDauerUeberwachung();
  const enabled = $('orniDuEnabled');
  const presetsEl = $('orniDuPresets');
  if (!enabled || !presetsEl) return;
  enabled.checked = du.enabled;
  presetsEl.querySelectorAll('.du-preset').forEach(b =>
    b.classList.toggle('on', parseInt(b.dataset.min) === du.durationMin)
  );
  const save = () => {
    const preset = presetsEl.querySelector('.du-preset.on');
    setDauerUeberwachung({ enabled: enabled.checked, durationMin: parseInt(preset?.dataset.min ?? '30') });
  };
  enabled.addEventListener('change', save);
  presetsEl.querySelectorAll('.du-preset').forEach(b => b.addEventListener('click', () => {
    presetsEl.querySelectorAll('.du-preset').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    save();
  }));
}

// ---- Punkt-Zählung (5-min BirdLife-Standard) ----
let _pkInterval = null, _pkStartTs = 0;
const PK_SECS = 5 * 60;

function _initPunktZaehlung() {
  const startBtn = $('pkStart');
  const timerEl = $('pkTimer');
  const speciesEl = $('pkSpecies');
  if (!startBtn || !timerEl) return;

  startBtn.onclick = async () => {
    if (_pkInterval) {
      clearInterval(_pkInterval);
      _pkInterval = null;
      startBtn.textContent = 'Zählung starten';
      startBtn.classList.remove('primary');
      timerEl.textContent = '5:00';
      if (speciesEl) speciesEl.hidden = true;
      return;
    }
    _pkStartTs = Date.now();
    startBtn.textContent = 'Stoppen';
    startBtn.classList.add('primary');
    if (speciesEl) { speciesEl.hidden = true; speciesEl.innerHTML = ''; }
    let remaining = PK_SECS;
    _pkInterval = setInterval(async () => {
      remaining--;
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      timerEl.textContent = m + ':' + String(s).padStart(2, '0');
      if (remaining <= 0) {
        clearInterval(_pkInterval);
        _pkInterval = null;
        startBtn.textContent = 'Zählung starten';
        startBtn.classList.remove('primary');
        await _showPkResults(speciesEl, _pkStartTs);
      }
    }, 1000);
  };
}

async function _showPkResults(el, startTs) {
  if (!el) return;
  const endTs = startTs + PK_SECS * 1000;
  const all = await allDetections();
  const inWindow = all.filter(d => d.ts >= startTs && d.ts <= endTs);
  const qual = qualifyingDetections(inWindow);
  const byKey = {};
  for (const d of qual) {
    if (!byKey[d.key]) byKey[d.key] = { name: d.species, count: 0 };
    byKey[d.key].count++;
  }
  const list = Object.values(byKey).sort((a, b) => b.count - a.count);
  if (!list.length) {
    el.innerHTML = '<div style="color:var(--faint);font-size:13px;text-align:center;padding:12px 0">Keine Rufe im Zeitfenster erkannt</div>';
  } else {
    el.innerHTML = '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Ergebnis</div>'
      + list.map(s => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--stroke);font-size:14px"><span>${s.name}</span><span style="color:var(--lime);font-weight:700;font-size:15px">${s.count}×</span></div>`).join('');
  }
  el.hidden = false;
}

// ---- Export-Tab ----
async function _renderExportSection() {
  const dets = qualifyingDetections(await allDetections());
  const wire = (id, fn) => { const el = $(id); if (el) el.onclick = () => fn(dets); };
  wire('orniEbirdBtn', _exportEbird);
  wire('orniOrnithoBtn', _exportOrnitho);
  wire('orniBirdnetBtn', _exportBirdnetNotebook);
  wire('orniNabuBtn', _exportNabu);
}

// ---- Sub-tab switching + init ----
export function initOrni() {
  const toggle = $('orniToggle');
  const panels = { monitoring: $('orniMonitoring'), protokolle: $('orniProtokolle'), export: $('orniExport') };
  if (toggle) {
    toggle.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      toggle.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      Object.values(panels).forEach(p => { if (p) p.hidden = true; });
      const panel = panels[b.dataset.tab];
      if (panel) panel.hidden = false;
      if (b.dataset.tab === 'export') _renderExportSection();
    }));
  }
  _initDU();
  _initPunktZaehlung();
}
