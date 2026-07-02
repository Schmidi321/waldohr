import { getDauerUeberwachung, setDauerUeberwachung } from './alarm.js';
import { allDetections, qualifyingDetections } from './db.js';
import { routeTracker } from './route.js';

const $ = id => document.getElementById(id);
const todayStr = () => new Date().toISOString().slice(0, 10);

// ---- CSV / download helpers ----
function _csvBlob(rows) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  return new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
}
function _dlBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  if (window.__waldohr?.openDownload) {
    window.__waldohr.openDownload(url, name, null);
  } else {
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }
}

function _showStartPopup(label) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;pointer-events:none';
  ov.innerHTML = `<div style="background:linear-gradient(160deg,#0c2a1a,#061a0f);border:1px solid var(--stroke);border-radius:24px;padding:22px 28px;text-align:center;max-width:240px;width:84%;box-shadow:0 20px 60px rgba(0,0,0,.6)"><div style="font-size:36px;margin-bottom:8px">🎙</div><div style="font-size:16px;font-weight:700;color:var(--lime);font-family:'Outfit',sans-serif">${label}</div><div style="font-size:12px;color:var(--muted);margin-top:4px">Überwachung aktiv</div></div>`;
  document.body.appendChild(ov);
  setTimeout(() => ov.remove(), 3000);
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
let _duInterval = null;
const LS_TRIGGER = 'waldohr.trigger';
function _getTrigger() { try { return JSON.parse(localStorage.getItem(LS_TRIGGER)) || { enabled: false, level: 20 }; } catch { return { enabled: false, level: 20 }; } }
function _setTrigger(v) { try { localStorage.setItem(LS_TRIGGER, JSON.stringify(v)); } catch {} }

function _initDU() {
  const du = getDauerUeberwachung();
  const enabled = $('orniDuEnabled');
  const presetsEl = $('orniDuPresets');
  const countdown = $('duCountdown');
  const timerEl = $('duTimer');
  const stopBtn = $('duStop');
  if (!enabled || !presetsEl) return;
  enabled.checked = du.enabled;
  presetsEl.querySelectorAll('.du-preset').forEach(b =>
    b.classList.toggle('on', parseInt(b.dataset.min) === du.durationMin)
  );
  const fmtTime = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const banner = document.getElementById('pkBanner');
  const bannerTimer = document.getElementById('pkBannerTimer');
  const bannerLabel = document.querySelector('#pkBanner .pk-label');
  const bannerStop = document.getElementById('pkBannerStop');

  // Trigger settings
  const trigToggle = $('duTriggerEnabled');
  const trigConfig = $('duTriggerConfig');
  const trigSlider = $('duTriggerLevel');
  const trigVal = $('duTriggerVal');
  const tr = _getTrigger();
  if (trigToggle) trigToggle.checked = tr.enabled;
  if (trigConfig) trigConfig.hidden = !tr.enabled;
  if (trigSlider) trigSlider.value = tr.level;
  const levelLabel = v => v <= 10 ? 'Sehr hoch' : v <= 20 ? 'Hoch' : v <= 30 ? 'Mittel' : v <= 40 ? 'Niedrig' : 'Sehr niedrig';
  if (trigVal) trigVal.textContent = levelLabel(tr.level);
  if (trigToggle) trigToggle.addEventListener('change', e => {
    const cur = _getTrigger();
    _setTrigger({ ...cur, enabled: e.target.checked });
    if (trigConfig) trigConfig.hidden = !e.target.checked;
  });
  if (trigSlider) trigSlider.addEventListener('input', () => {
    const v = parseInt(trigSlider.value);
    if (trigVal) trigVal.textContent = levelLabel(v);
    const cur = _getTrigger(); _setTrigger({ ...cur, level: v });
  });

  function _endDU() {
    clearInterval(_duInterval); _duInterval = null;
    if (countdown) countdown.hidden = true;
    if (banner) banner.hidden = true;
    if (bannerLabel) bannerLabel.textContent = 'Punkt-Zählung';
    if (window.__waldohr) { window.__waldohr.stopDetection(); window.__waldohr.stopTriggerRec?.(); }
    enabled.checked = false;
    setDauerUeberwachung({ enabled: false, durationMin: parseInt(presetsEl.querySelector('.du-preset.on')?.dataset.min ?? '30') });
  }

  const save = () => {
    const preset = presetsEl.querySelector('.du-preset.on');
    setDauerUeberwachung({ enabled: enabled.checked, durationMin: parseInt(preset?.dataset.min ?? '30') });
  };

  function _startDU() {
    if (_duInterval) return;
    // ZUERST sofort sichtbares Feedback (Timer/Banner/Countdown), DANN erst die langsame
    // Mikrofon-Initialisierung — sonst wirkt der Klick sekundenlang wie ohne Reaktion.
    _showStartPopup('Dauerüberwachung');
    const preset = presetsEl.querySelector('.du-preset.on');
    let remaining = parseInt(preset?.dataset.min ?? '30') * 60;
    if (timerEl) timerEl.textContent = fmtTime(remaining);
    if (countdown) countdown.hidden = false;
    if (banner) {
      if (bannerLabel) bannerLabel.textContent = 'Dauerüberwachung';
      if (bannerTimer) bannerTimer.textContent = fmtTime(remaining);
      banner.hidden = false;
    }
    _duInterval = setInterval(() => {
      remaining--;
      const ts = fmtTime(remaining);
      if (timerEl) timerEl.textContent = ts;
      if (bannerTimer) bannerTimer.textContent = ts;
      if (remaining <= 0) _endDU();
    }, 1000);
    if (window.__waldohr) {
      window.__waldohr.startDetection().catch(e => console.warn('du start', e));
      window.__waldohr.switchTab('v-listen');
      const trig = _getTrigger();
      if (trig.enabled) setTimeout(() => window.__waldohr.startTriggerRec?.(trig.level), 1200);
    }
  }

  enabled.addEventListener('change', e => {
    save();
    if (e.target.checked) _startDU(); else _endDU();
  });

  // Preset buttons: only select duration, don't start detection
  presetsEl.querySelectorAll('.du-preset').forEach(b => b.addEventListener('click', () => {
    presetsEl.querySelectorAll('.du-preset').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    save();
  }));

  if (stopBtn) stopBtn.addEventListener('click', _endDU);
  // Banner stop also handles DU
  if (bannerStop) bannerStop.addEventListener('click', () => { if (_duInterval) _endDU(); });
}

// ---- Punkt-Zählung (5-min BirdLife-Standard) ----
let _pkInterval = null, _pkStartTs = 0, _pkWasDetecting = false;
const PK_SECS = 5 * 60;

function _initPunktZaehlung() {
  const startBtn = $('pkStart');
  const timerEl = $('pkTimer');
  const speciesEl = $('pkSpecies');
  if (!startBtn || !timerEl) return;

  const banner = document.getElementById('pkBanner');
  const bannerTimer = document.getElementById('pkBannerTimer');
  const bannerStop = document.getElementById('pkBannerStop');

  function _endPk() {
    clearInterval(_pkInterval);
    _pkInterval = null;
    startBtn.textContent = 'Zählung starten';
    startBtn.classList.remove('primary');
    timerEl.textContent = '5:00';
    if (banner) banner.hidden = true;
    if (!_pkWasDetecting && window.__waldohr) window.__waldohr.stopDetection();
    if (window.__waldohr) window.__waldohr.switchTab('v-orni');
  }

  startBtn.onclick = () => {
    if (_pkInterval) { _endPk(); return; }

    _pkStartTs = Date.now();
    _pkWasDetecting = window.__waldohr ? window.__waldohr.isDetecting() : false;

    _showStartPopup('Punkt-Zählung');
    startBtn.textContent = 'Stoppen';
    startBtn.classList.add('primary');
    if (speciesEl) { speciesEl.hidden = true; speciesEl.innerHTML = ''; }
    if (banner) { banner.hidden = false; if (bannerTimer) bannerTimer.textContent = '5:00'; }

    if (window.__waldohr) {
      window.__waldohr.startDetection().catch(e => console.warn('pk start', e));
      window.__waldohr.switchTab('v-listen');
    }

    let remaining = PK_SECS;
    _pkInterval = setInterval(async () => {
      remaining--;
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      const ts = m + ':' + String(s).padStart(2, '0');
      timerEl.textContent = ts;
      if (bannerTimer) bannerTimer.textContent = ts;
      if (remaining <= 0) {
        const startTs = _pkStartTs;
        _endPk();
        await _showPkResults(speciesEl, startTs);
      }
    }, 1000);
  };

  if (bannerStop) bannerStop.onclick = () => { if (_pkInterval) _endPk(); };
}

function _savePkSession(startTs, species) {
  try {
    const sessions = JSON.parse(localStorage.getItem('waldohr.pk.sessions') || '[]');
    sessions.unshift({ name: '', ts: Date.now(), startTs, species });
    if (sessions.length > 100) sessions.length = 100;
    localStorage.setItem('waldohr.pk.sessions', JSON.stringify(sessions));
    return 0; // index of the newly saved session
  } catch { return -1; }
}

// ---- Transekt-Zählung (feste Route, freie Dauer) ----
let _txInterval = null, _txStartTs = 0, _txWasDetecting = false;

function _initTransekt() {
  const startBtn = $('txStart');
  const timerEl = $('txTimer');
  const distEl = $('txDist');
  const speciesEl = $('txSpecies');
  if (!startBtn || !timerEl) return;

  const fmtTime = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const fmtDist = km => km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(2) + ' km';

  function _endTx() {
    clearInterval(_txInterval);
    _txInterval = null;
    startBtn.textContent = 'Transekt starten';
    startBtn.classList.remove('primary');
    if (!_txWasDetecting && window.__waldohr) window.__waldohr.stopDetection();
    if (window.__waldohr) window.__waldohr.switchTab('v-orni');
  }

  startBtn.onclick = async () => {
    if (_txInterval) {
      const startTs = _txStartTs;
      const summary = routeTracker.stop();
      const points = routeTracker.points.slice();
      _endTx();
      timerEl.textContent = '0:00';
      if (distEl) distEl.textContent = '0 m zurückgelegt';
      await _showTxResults(speciesEl, startTs, summary, points);
      return;
    }

    _txStartTs = Date.now();
    _txWasDetecting = window.__waldohr ? window.__waldohr.isDetecting() : false;

    _showStartPopup('Transekt-Zählung');
    startBtn.textContent = 'Stoppen';
    startBtn.classList.add('primary');
    if (speciesEl) { speciesEl.hidden = true; speciesEl.innerHTML = ''; }
    timerEl.textContent = '0:00';
    if (distEl) distEl.textContent = '0 m zurückgelegt';

    routeTracker.start();
    if (window.__waldohr) {
      window.__waldohr.startDetection().catch(e => console.warn('tx start', e));
      window.__waldohr.switchTab('v-listen');
    }

    let elapsed = 0;
    _txInterval = setInterval(() => {
      elapsed++;
      timerEl.textContent = fmtTime(elapsed);
      if (distEl) distEl.textContent = fmtDist(routeTracker.distKm) + ' zurückgelegt';
    }, 1000);
  };
}

function _saveTxSession(startTs, endTs, species, distKm, points) {
  try {
    const sessions = JSON.parse(localStorage.getItem('waldohr.tx.sessions') || '[]');
    sessions.unshift({ name: '', ts: Date.now(), startTs, endTs, species, distKm, points });
    if (sessions.length > 50) sessions.length = 50;
    localStorage.setItem('waldohr.tx.sessions', JSON.stringify(sessions));
    return 0;
  } catch { return -1; }
}

async function _showTxResults(el, startTs, summary, points) {
  if (!el) return;
  const endTs = Date.now();
  const all = await allDetections();
  const inWindow = all.filter(d => d.ts >= startTs && d.ts <= endTs);
  const qual = qualifyingDetections(inWindow);
  const byKey = {};
  for (const d of qual) {
    if (!byKey[d.key]) byKey[d.key] = { name: d.species, count: 0 };
    byKey[d.key].count++;
  }
  const list = Object.values(byKey).sort((a, b) => b.count - a.count);
  const distKm = summary?.distKm || 0;
  const sessionIdx = _saveTxSession(startTs, endTs, list, distKm, points);
  const fmtDist = km => km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(2) + ' km';
  const nameInput = `<input id="txSessionName" type="text" placeholder="Sitzungsname (optional)" style="width:100%;box-sizing:border-box;background:var(--glass);border:1px solid var(--stroke);border-radius:12px;padding:10px 14px;color:var(--ink);font-size:13px;font-family:inherit;outline:none;margin-bottom:10px">`;
  const distLine = `<div style="font-size:12px;color:var(--muted);text-align:center;margin-bottom:10px">${fmtDist(distKm)} zurückgelegt</div>`;
  if (!list.length) {
    el.innerHTML = nameInput + distLine + '<div style="color:var(--faint);font-size:13px;text-align:center;padding:12px 0">Keine Rufe auf der Strecke erkannt</div>';
  } else {
    el.innerHTML = nameInput + distLine
      + '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Ergebnis</div>'
      + list.map(s => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--stroke);font-size:14px"><span>${s.name}</span><span style="color:var(--lime);font-weight:700;font-size:15px">${s.count}×</span></div>`).join('');
  }
  el.hidden = false;
  if (sessionIdx >= 0) {
    const inp = el.querySelector('#txSessionName');
    if (inp) inp.oninput = () => {
      try {
        const sessions = JSON.parse(localStorage.getItem('waldohr.tx.sessions') || '[]');
        if (sessions[sessionIdx] != null) { sessions[sessionIdx].name = inp.value; localStorage.setItem('waldohr.tx.sessions', JSON.stringify(sessions)); }
      } catch {}
    };
  }
  _showPkEndPopup(list.length, 'auf ' + fmtDist(distKm) + ' Strecke erkannt');
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
  const sessionIdx = _savePkSession(startTs, list);
  const nameInput = `<input id="pkSessionName" type="text" placeholder="Sitzungsname (optional)" style="width:100%;box-sizing:border-box;background:var(--glass);border:1px solid var(--stroke);border-radius:12px;padding:10px 14px;color:var(--ink);font-size:13px;font-family:inherit;outline:none;margin-bottom:10px">`;
  if (!list.length) {
    el.innerHTML = nameInput + '<div style="color:var(--faint);font-size:13px;text-align:center;padding:12px 0">Keine Rufe im Zeitfenster erkannt</div>';
  } else {
    el.innerHTML = nameInput
      + '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Ergebnis</div>'
      + list.map(s => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--stroke);font-size:14px"><span>${s.name}</span><span style="color:var(--lime);font-weight:700;font-size:15px">${s.count}×</span></div>`).join('');
  }
  el.hidden = false;
  if (sessionIdx >= 0) {
    const inp = el.querySelector('#pkSessionName');
    if (inp) inp.oninput = () => {
      try {
        const sessions = JSON.parse(localStorage.getItem('waldohr.pk.sessions') || '[]');
        if (sessions[sessionIdx] != null) { sessions[sessionIdx].name = inp.value; localStorage.setItem('waldohr.pk.sessions', JSON.stringify(sessions)); }
      } catch {}
    };
  }
  _showPkEndPopup(list.length);
}

function _showPkEndPopup(count, subtitle) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(2,8,6,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)';
  ov.innerHTML = `<div style="background:linear-gradient(160deg,#0c2a1a,#061a0f);border:1px solid var(--stroke);border-radius:24px;padding:28px 28px 22px;text-align:center;max-width:270px;width:88%">
    <div style="font-size:44px;margin-bottom:6px">🎯</div>
    <div style="font-size:26px;font-weight:700;color:var(--lime);font-family:'Outfit',sans-serif;margin-bottom:4px">${count} ${count === 1 ? 'Art' : 'Arten'}</div>
    <div style="font-size:13px;color:var(--muted);margin-bottom:18px">${subtitle || 'in 5 Minuten erkannt'}</div>
    <button id="_pkPopupBtn" style="width:100%;padding:13px;border-radius:14px;background:var(--lime);color:#04130d;font-weight:700;font-size:15px;border:none;cursor:pointer;font-family:'Outfit',sans-serif">Zu Protokollen →</button>
  </div>`;
  document.body.appendChild(ov);
  const go = () => {
    ov.remove();
    document.querySelector('#orniToggle button[data-tab="protokolle"]')?.click();
  };
  ov.querySelector('#_pkPopupBtn').onclick = go;
  setTimeout(go, 6000);
}

function _renderProtokolle() {
  const list = $('orniProtList');
  if (!list) return;
  let pkSessions, txSessions;
  try { pkSessions = JSON.parse(localStorage.getItem('waldohr.pk.sessions') || '[]'); } catch { pkSessions = []; }
  try { txSessions = JSON.parse(localStorage.getItem('waldohr.tx.sessions') || '[]'); } catch { txSessions = []; }
  const merged = [
    ...pkSessions.map((s, i) => ({ ...s, _type: 'pk', _idx: i })),
    ...txSessions.map((s, i) => ({ ...s, _type: 'tx', _idx: i })),
  ].sort((a, b) => b.ts - a.ts);
  if (!merged.length) {
    list.innerHTML = '<div class="infoblock" style="margin-top:14px"><p style="color:var(--muted);font-size:13px;text-align:center;padding:8px 0">Noch keine Zählsitzungen gespeichert.<br>Starte eine Punkt- oder Transekt-Zählung im Überwachungs-Tab.</p></div>';
    return;
  }
  const fmtDist = km => km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(2) + ' km';
  list.innerHTML = '';
  merged.forEach((s, i) => {
    const isTx = s._type === 'tx';
    const d = new Date(s.ts);
    const dateStr = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const label = s.name || ((isTx ? '🗺️ Transekt vom ' : '📍 Sitzung vom ') + dateStr);

    const card = document.createElement('div');
    card.className = 'infoblock';
    card.style.marginTop = i ? '10px' : '14px';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;cursor:pointer;-webkit-tap-highlight-color:transparent';
    header.innerHTML = `<div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:14px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px">${dateStr} · ${timeStr}${isTx ? ' · ' + fmtDist(s.distKm || 0) : ''}</div>
    </div>
    <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
      <div style="font-size:17px;font-weight:700;color:var(--lime)">${s.species ? s.species.length : 0} Arten</div>
      <button class="prot-del-btn" title="Sitzung löschen" style="background:none;border:none;color:var(--rose,#ef4444);cursor:pointer;padding:4px 2px;display:flex;align-items:center;opacity:.75">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>`;

    const body = document.createElement('div');
    body.hidden = true;
    body.style.marginTop = '8px';

    header.addEventListener('click', async e => {
      if (e.target.closest('.prot-del-btn') || e.target.closest('.prot-gpx-btn')) return;
      if (body.hidden) {
        body.hidden = false;
        body.innerHTML = '<div style="color:var(--faint);font-size:12px;padding:4px 0">Lade…</div>';
        try {
          const allDets = qualifyingDetections(await allDetections());
          const winStart = s.startTs || s.ts - PK_SECS * 1000;
          const winEnd = isTx ? (s.endTs || s.ts) : winStart + PK_SECS * 1000;
          const inWindow = allDets.filter(det => det.ts >= winStart && det.ts <= winEnd);
          let html = '';
          if (isTx && s.points?.length) {
            html += `<button class="prot-gpx-btn" style="width:100%;padding:9px;border-radius:10px;background:var(--glass);border:1px solid var(--stroke);color:var(--ink);font-size:12px;cursor:pointer;font-family:inherit;margin-bottom:8px">📍 GPX-Route exportieren</button>`;
          }
          if (!inWindow.length) {
            html += '<div style="color:var(--faint);font-size:12px;padding:4px 0">Keine Erkennungen im Zeitfenster gefunden</div>';
          } else {
            const bySpecies = {};
            for (const det of inWindow) {
              if (!bySpecies[det.key]) bySpecies[det.key] = { name: det.species, times: [] };
              bySpecies[det.key].times.push(new Date(det.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
            }
            html += Object.values(bySpecies).map(sp =>
              `<div style="border-top:1px solid var(--stroke);padding:6px 0">
                <div style="font-weight:600;font-size:13px;color:var(--ink);margin-bottom:3px">${sp.name}</div>
                ${sp.times.map(t => `<div style="font-size:11px;color:var(--muted);padding:1px 0">· ${t}</div>`).join('')}
              </div>`
            ).join('');
          }
          body.innerHTML = html;
          body.querySelector('.prot-gpx-btn')?.addEventListener('click', ev => {
            ev.stopPropagation();
            const date = new Date(s.startTs || s.ts).toLocaleDateString('de-DE');
            const pts = s.points.map(p => {
              const t = new Date(p.ts).toISOString();
              return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><time>${t}</time></trkpt>`;
            }).join('\n');
            const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="WaldOhr" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>WaldOhr-Transekt ${date}</name><trkseg>\n${pts}\n  </trkseg></trk>\n</gpx>`;
            _dlBlob(new Blob([gpx], { type: 'application/gpx+xml' }), 'waldohr-transekt-' + todayStr() + '.gpx');
          });
        } catch { body.innerHTML = '<div style="color:var(--faint);font-size:12px;padding:4px 0">Fehler beim Laden</div>'; }
      } else {
        body.hidden = true;
      }
    });

    header.querySelector('.prot-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      try {
        const key = isTx ? 'waldohr.tx.sessions' : 'waldohr.pk.sessions';
        let ss = JSON.parse(localStorage.getItem(key) || '[]');
        ss.splice(s._idx, 1);
        localStorage.setItem(key, JSON.stringify(ss));
        _renderProtokolle();
      } catch {}
    });

    card.append(header, body);
    list.appendChild(card);
  });
}

// ---- Export-Tab ----
async function _renderExportSection() {
  const allDets = qualifyingDetections(await allDetections());
  let sessions = [];
  try { sessions = JSON.parse(localStorage.getItem('waldohr.pk.sessions') || '[]'); } catch {}
  const container = $('orniExport');
  if (!container) return;

  const existingSel = document.getElementById('_sessSelector');
  if (existingSel) existingSel.remove();

  if (sessions.length) {
    const selEl = document.createElement('div'); selEl.id = '_sessSelector';
    selEl.innerHTML = `<div class="infoblock" style="margin-bottom:14px">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:10px;text-transform:uppercase;letter-spacing:.8px">Sitzungen</div>
      <label style="display:flex;align-items:center;gap:10px;padding:7px 0;font-size:13px;cursor:pointer;border-bottom:1px solid var(--stroke)">
        <input type="checkbox" id="duExportAll" checked style="width:16px;height:16px;accent-color:var(--lime)">
        <span style="color:var(--ink);font-weight:600">Alle Aufnahmen</span>
        <span style="color:var(--lime);font-weight:700;margin-left:auto">${sessions.length} Sitzung${sessions.length !== 1 ? 'en' : ''}</span>
      </label>
      ${sessions.map((s, i) => {
        const d = new Date(s.ts);
        const label = s.name || ('Sitzung ' + d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' }) + ' ' + d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' }));
        return `<label style="display:flex;align-items:center;gap:10px;padding:7px 0;font-size:12px;cursor:pointer;border-bottom:1px solid var(--stroke)">
          <input type="checkbox" class="du-sess-chk" data-idx="${i}" style="width:16px;height:16px;accent-color:var(--lime)">
          <span style="flex:1;color:var(--ink)">${label}</span>
          <span style="color:var(--lime);font-weight:700">${s.species ? s.species.length : 0} Arten</span>
        </label>`;
      }).join('')}
    </div>`;
    const exportBtns = container.querySelector('.export-btns');
    if (exportBtns) container.insertBefore(selEl, exportBtns);
    else container.insertBefore(selEl, container.firstChild);
    document.getElementById('duExportAll')?.addEventListener('change', function() {
      container.querySelectorAll('.du-sess-chk').forEach(c => { c.disabled = this.checked; if (this.checked) c.checked = false; });
    });
  }

  function getSelectedDets() {
    const allChk = document.getElementById('duExportAll');
    if (!allChk || allChk.checked || !sessions.length) return allDets;
    const checked = [...container.querySelectorAll('.du-sess-chk:checked')];
    if (!checked.length) return allDets;
    const ranges = checked.map(c => {
      const s = sessions[parseInt(c.dataset.idx)];
      return { start: s.startTs, end: s.startTs + 5 * 60 * 1000 };
    });
    return allDets.filter(d => ranges.some(r => d.ts >= r.start && d.ts <= r.end));
  }

  const wire = (id, fn) => { const el = $(id); if (el) el.onclick = () => fn(getSelectedDets()); };
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
      if (b.dataset.tab === 'protokolle') _renderProtokolle();
    }));
  }
  _initDU();
  _initPunktZaehlung();
  _initTransekt();
}
