import { getDauerUeberwachung, setDauerUeberwachung } from './alarm.js';
import { allDetections, qualifyingDetections, todayNearbyDetections } from './db.js';
import { routeTracker } from './route.js';
import { showInfoToast, updateScheduleChip, icon, fmtShortDate } from './ui.js';
import { esc, csvCell } from './util.js';

const $ = id => document.getElementById(id);
// Lokales Kalenderdatum statt UTC (toISOString) — sonst rutscht ein Fund kurz nach lokaler
// Mitternacht (UTC+1/+2) noch auf den Vortag: falsche Gruppierung in _groupByDateSpecies und
// falsches Datum in eBird/ornitho/NABU-Exporten.
function _localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const todayStr = () => _localDateStr(new Date());

// Alles, was hier per innerHTML gerendert wird und nicht hart im Code steht, geht durch esc()
// aus util.js: Sitzungsnamen (freier Nutzer-Text aus dem Namensfeld) UND Artnamen (kommen vom
// BirdNET-Server oder aus einer importierten — evtl. manipulierten — Sicherung).

// localStorage.setItem kann bei vollem Speicher (QuotaExceededError) werfen — wurde bisher an
// mehreren Stellen mit bloßem catch{} verschluckt, die Sitzung ging dann kommentarlos verloren.
// Wenigstens sichtbar machen, damit klar ist, dass nichts gespeichert wurde.
function _warnStorageFail(what) {
  showInfoToast('⚠️ Nicht gespeichert', what + ' — der Speicherplatz im Browser ist voll.', '⚠️');
}

// GPS-Punkte werden alle 10s aufgezeichnet — bei langen/vielen Transekten wächst
// waldohr.tx.sessions unbegrenzt (nur Session-ANZAHL ist gedeckelt, nicht die Byte-Größe) und
// reißt schneller an die localStorage-Quote. Vor dem Speichern gleichmäßig auf max.
// _MAX_TX_POINTS verdünnen — die GPX-Route bleibt brauchbar, nur feinkörniger geglättet.
const _MAX_TX_POINTS = 300;
function _capPoints(points) {
  if (!points || points.length <= _MAX_TX_POINTS) return points;
  const step = points.length / _MAX_TX_POINTS;
  const out = [];
  for (let i = 0; i < _MAX_TX_POINTS; i++) out.push(points[Math.floor(i * step)]);
  return out;
}

// ---- CSV / download helpers ----
// csvCell() entschärft Formel-Präfixe (= + - @) gegen CSV-Injection in Excel — Artnamen können
// aus fremder Quelle stammen. Reine Zahlen (z.B. negative Längengrade westlich von Greenwich)
// sind aber keine Formel und dürfen NICHT mit ' verfälscht werden, sonst importieren eBird/
// ornitho die Koordinate als Text.
const _NUM_RE = /^-?\d+(\.\d+)?$/;
const _cell = v => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && _NUM_RE.test(v))
  ? '"' + v + '"' : csvCell(v);
function _csvBlob(rows) {
  const csv = rows.map(r => r.map(_cell).join(',')).join('\n');
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
  ov.innerHTML = `<div style="background:#0a2a1f;border:1px solid var(--stroke-strong);border-radius:24px;padding:22px 28px;text-align:center;max-width:240px;width:84%;box-shadow:0 20px 60px rgba(0,0,0,.6)"><div style="width:52px;height:52px;margin:0 auto 10px;border-radius:16px;display:grid;place-items:center;background:rgba(163,230,53,.14);color:var(--lime)">${icon('mic')}</div><div style="font-size:18px;font-weight:600;color:var(--ink);font-family:'Outfit',sans-serif">${esc(label)}</div><div style="font-size:13px;color:var(--muted);margin-top:4px">Lauschen läuft</div></div>`;
  document.body.appendChild(ov);
  setTimeout(() => ov.remove(), 3000);
}
function _groupByDateSpecies(dets) {
  const map = new Map();
  for (const d of dets) {
    const date = _localDateStr(new Date(d.ts));
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
      _localDateStr(dt),
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
let _duInterval = null, _duMicWasRunning = true; // s. _micRunning() unten
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
    if (window.__waldohr) { window.__waldohr.stopDetection({ releaseMic: !_duMicWasRunning }); window.__waldohr.stopTriggerRec?.(); }
    _duMicWasRunning = true;
    enabled.checked = false;
    setDauerUeberwachung({ enabled: false, durationMin: parseInt(presetsEl.querySelector('.du-preset.on')?.dataset.min ?? '30') });
    updateScheduleChip();   // Zeitplan-Chip unter dem Orb sofort auf den neuen Stand
  }

  const save = () => {
    const preset = presetsEl.querySelector('.du-preset.on');
    setDauerUeberwachung({ enabled: enabled.checked, durationMin: parseInt(preset?.dataset.min ?? '30') });
  };

  function _startDU() {
    if (_duInterval) return;
    _duMicWasRunning = _micRunning();
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
let _pkInterval = null, _pkStartTs = 0, _pkWasDetecting = false, _pkMicWasRunning = true;

// Mikrofon-Zustand VOR dem Start einer Zählung merken: stopDetection() allein hält das Mikro
// offen (rote Aufnahme-Anzeige, Akku) — auch wenn der Nutzer es vor der Zählung gar nicht an
// hatte. Beim Stop gibt { releaseMic: true } es dann wieder frei, aber NUR, wenn wir es selbst
// geöffnet haben. Default true = im Zweifel nicht freigeben (fremdes Mikro nicht abwürgen).
function _micRunning() {
  try { return window.__waldohr?.isMicRunning ? !!window.__waldohr.isMicRunning() : true; } catch { return true; }
}
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
    // Ruhezustand = Primär-Button (Verlauf); während der Zählung ein klar roter "Stoppen"-Zustand.
    startBtn.textContent = 'Zählung starten';
    startBtn.classList.add('primary'); startBtn.classList.remove('running');
    timerEl.textContent = '5:00';
    if (banner) banner.hidden = true;
    if (!_pkWasDetecting && window.__waldohr) window.__waldohr.stopDetection({ releaseMic: !_pkMicWasRunning });
    _pkMicWasRunning = true;
    if (window.__waldohr) window.__waldohr.switchTab('v-orni');
  }

  startBtn.onclick = () => {
    if (_pkInterval) { _endPk(); return; }

    _pkStartTs = Date.now();
    _pkWasDetecting = window.__waldohr ? window.__waldohr.isDetecting() : false;
    _pkMicWasRunning = _micRunning();

    _showStartPopup('Punkt-Zählung');
    startBtn.textContent = 'Zählung stoppen';
    startBtn.classList.remove('primary'); startBtn.classList.add('running');
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
  } catch { _warnStorageFail('Punkt-Zählung'); return -1; }
}

// ---- Transekt-Zählung (feste Route, freie Dauer) ----
let _txInterval = null, _txStartTs = 0, _txWasDetecting = false, _txMicWasRunning = true;

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
    startBtn.classList.add('primary'); startBtn.classList.remove('running');
    if (!_txWasDetecting && window.__waldohr) window.__waldohr.stopDetection({ releaseMic: !_txMicWasRunning });
    _txMicWasRunning = true;
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

    // Teilt sich den Tracker mit dem Route-Button (Karten-Tab) — läuft dort schon eine
    // Aufzeichnung, nicht einfach übernehmen/überschreiben, sondern klar sagen, wo zuerst stoppen.
    if (routeTracker._timer) {
      showInfoToast('Route läuft bereits', 'Erst im Karten-Tab beenden, dann kannst du eine Transekt-Zählung starten.', 'route');
      return;
    }

    _txStartTs = Date.now();
    _txWasDetecting = window.__waldohr ? window.__waldohr.isDetecting() : false;
    _txMicWasRunning = _micRunning();

    _showStartPopup('Transekt-Zählung');
    startBtn.textContent = 'Transekt beenden';
    startBtn.classList.remove('primary'); startBtn.classList.add('running');
    if (speciesEl) { speciesEl.hidden = true; speciesEl.innerHTML = ''; }
    timerEl.textContent = '0:00';
    if (distEl) distEl.textContent = '0 m zurückgelegt';

    routeTracker.start('transekt');
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
    sessions.unshift({ name: '', ts: Date.now(), startTs, endTs, species, distKm, points: _capPoints(points) });
    if (sessions.length > 50) sessions.length = 50;
    localStorage.setItem('waldohr.tx.sessions', JSON.stringify(sessions));
    return 0;
  } catch { _warnStorageFail('Transekt-Sitzung'); return -1; }
}

// Zählung je Art über Map statt Plain-Object: d.key kann aus einer importierten Sicherung oder
// vom BirdNET-Server stammen — '__proto__'/'constructor' als Schlüssel würde ein {} verbiegen.
function _countBySpecies(dets) {
  const byKey = new Map();
  for (const d of dets) {
    let e = byKey.get(d.key);
    if (!e) { e = { name: d.species, count: 0 }; byKey.set(d.key, e); }
    e.count++;
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

async function _showTxResults(el, startTs, summary, points) {
  if (!el) return;
  const endTs = Date.now();
  const all = await allDetections();
  const inWindow = all.filter(d => d.ts >= startTs && d.ts <= endTs);
  const qual = qualifyingDetections(inWindow);
  const list = _countBySpecies(qual);
  const distKm = summary?.distKm || 0;
  const sessionIdx = _saveTxSession(startTs, endTs, list, distKm, points);
  const fmtDist = km => km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(2) + ' km';
  const nameInput = `<input id="txSessionName" class="field" type="text" placeholder="Sitzungsname (optional)" aria-label="Sitzungsname">`;
  const distLine = `<div class="res-dist">${fmtDist(distKm)} zurückgelegt</div>`;
  if (!list.length) {
    el.innerHTML = nameInput + distLine + '<div class="res-empty">Keine Rufe auf der Strecke erkannt</div>';
  } else {
    el.innerHTML = nameInput + distLine
      + '<div class="res-h">Ergebnis</div>'
      + list.map(s => `<div class="res-row"><span>${esc(s.name)}</span><b>${s.count}×</b></div>`).join('');
  }
  el.hidden = false;
  if (sessionIdx >= 0) {
    const inp = el.querySelector('#txSessionName');
    if (inp) inp.oninput = () => {
      try {
        const sessions = JSON.parse(localStorage.getItem('waldohr.tx.sessions') || '[]');
        if (sessions[sessionIdx] != null) { sessions[sessionIdx].name = inp.value; localStorage.setItem('waldohr.tx.sessions', JSON.stringify(sessions)); }
      } catch { _warnStorageFail('Sitzungsname'); }
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
  const list = _countBySpecies(qual);
  const sessionIdx = _savePkSession(startTs, list);
  const nameInput = `<input id="pkSessionName" class="field" type="text" placeholder="Sitzungsname (optional)" aria-label="Sitzungsname">`;
  if (!list.length) {
    el.innerHTML = nameInput + '<div class="res-empty">Keine Rufe im Zeitfenster erkannt</div>';
  } else {
    el.innerHTML = nameInput
      + '<div class="res-h">Ergebnis</div>'
      + list.map(s => `<div class="res-row"><span>${esc(s.name)}</span><b>${s.count}×</b></div>`).join('');
  }
  el.hidden = false;
  if (sessionIdx >= 0) {
    const inp = el.querySelector('#pkSessionName');
    if (inp) inp.oninput = () => {
      try {
        const sessions = JSON.parse(localStorage.getItem('waldohr.pk.sessions') || '[]');
        if (sessions[sessionIdx] != null) { sessions[sessionIdx].name = inp.value; localStorage.setItem('waldohr.pk.sessions', JSON.stringify(sessions)); }
      } catch { _warnStorageFail('Sitzungsname'); }
    };
  }
  _showPkEndPopup(list.length);
}

function _showPkEndPopup(count, subtitle) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(2,8,6,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)';
  ov.innerHTML = `<div style="background:#0a2a1f;border:1px solid var(--stroke-strong);border-radius:24px;padding:26px 24px 20px;text-align:center;max-width:280px;width:88%">
    <div style="width:56px;height:56px;margin:0 auto 10px;border-radius:16px;display:grid;place-items:center;background:rgba(163,230,53,.14);color:var(--lime)">${icon('check')}</div>
    <div style="font-size:44px;font-weight:600;color:var(--ink);font-family:'Outfit',sans-serif;line-height:1.1">${count}</div>
    <div style="font-size:15px;color:var(--ink);font-family:'Outfit',sans-serif;margin-bottom:2px">${count === 1 ? 'Art' : 'Arten'}</div>
    <div style="font-size:13px;color:var(--muted);margin-bottom:18px">${esc(subtitle || 'in 5 Minuten erkannt')}</div>
    <button id="_pkPopupBtn" class="btn primary" style="width:100%">Zu den Protokollen</button>
  </div>`;
  document.body.appendChild(ov);
  // Nur EINMAL weiterleiten: vorher feuerte der 6-s-Timer auch nach einem Tipp auf den Knopf noch
  // und riss den Nutzer zurück zu "Protokolle", obwohl er längst woanders war.
  let done = false, timer = null;
  const go = () => {
    if (done) return;
    done = true; clearTimeout(timer);
    ov.remove();
    document.querySelector('#orniToggle button[data-tab="protokolle"]')?.click();
  };
  ov.querySelector('#_pkPopupBtn').onclick = go;
  timer = setTimeout(go, 6000);
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
    list.innerHTML = '<div class="empty-note">Noch keine Zählungen gespeichert.<br>Starte eine Punkt- oder Transekt-Zählung unter „Zählungen“.</div>';
    return;
  }
  const fmtDist = km => km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(2) + ' km';
  list.innerHTML = '';
  merged.forEach((s, i) => {
    const isTx = s._type === 'tx';
    const d = new Date(s.ts);
    const dateStr = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const label = esc(s.name || ((isTx ? 'Transekt vom ' : 'Punkt-Zählung vom ') + dateStr));
    const n = s.species ? s.species.length : 0;

    const card = document.createElement('div');
    card.className = 'card prot-card';

    const header = document.createElement('div');
    header.className = 'prot-head';
    header.setAttribute('role', 'button'); header.tabIndex = 0; header.setAttribute('aria-expanded', 'false');
    header.innerHTML = `<span class="tile">${icon(isTx ? 'route' : 'target')}</span>
    <div>
      <div class="prot-title">${label}</div>
      <div class="prot-meta">${dateStr} · ${timeStr}${isTx ? ' · ' + fmtDist(s.distKm || 0) : ''}</div>
    </div>
    <div class="prot-count">${n} ${n === 1 ? 'Art' : 'Arten'}</div>
    <button class="prot-del-btn" title="Sitzung löschen" aria-label="Sitzung löschen">${icon('trash')}</button>`;

    const body = document.createElement('div');
    body.hidden = true;
    body.className = 'prot-body';

    header.addEventListener('click', async e => {
      if (e.target.closest('.prot-del-btn') || e.target.closest('.prot-gpx-btn')) return;
      header.setAttribute('aria-expanded', String(body.hidden));
      if (body.hidden) {
        body.hidden = false;
        body.innerHTML = '<div class="res-empty">Lade…</div>';
        try {
          const allDets = qualifyingDetections(await allDetections());
          const winStart = s.startTs || s.ts - PK_SECS * 1000;
          const winEnd = isTx ? (s.endTs || s.ts) : winStart + PK_SECS * 1000;
          const inWindow = allDets.filter(det => det.ts >= winStart && det.ts <= winEnd);
          let html = '';
          if (isTx && s.points?.length) {
            html += `<button class="btn ghost small prot-gpx-btn">${icon('route')}GPX-Route exportieren</button>`;
          }
          if (!inWindow.length) {
            html += '<div class="res-empty">Keine Erkennungen im Zeitfenster gefunden</div>';
          } else {
            const bySpecies = new Map(); // Map statt {}: s. _countBySpecies (Prototype Pollution)
            for (const det of inWindow) {
              let e = bySpecies.get(det.key);
              if (!e) { e = { name: det.species, times: [] }; bySpecies.set(det.key, e); }
              e.times.push(new Date(det.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
            }
            html += [...bySpecies.values()].map(sp =>
              `<div class="prot-sp"><b>${esc(sp.name)}</b><span>${sp.times.map(esc).join(' · ')}</span></div>`
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
        } catch { body.innerHTML = '<div class="res-empty">Fehler beim Laden</div>'; }
      } else {
        body.hidden = true;
      }
    });

    header.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === header) { e.preventDefault(); header.click(); } });
    header.querySelector('.prot-del-btn').addEventListener('click', e => {
      e.stopPropagation();
      try {
        const key = isTx ? 'waldohr.tx.sessions' : 'waldohr.pk.sessions';
        let ss = JSON.parse(localStorage.getItem(key) || '[]');
        ss.splice(s._idx, 1);
        localStorage.setItem(key, JSON.stringify(ss));
        _renderProtokolle();
      } catch { _warnStorageFail('Löschen'); }
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
    selEl.innerHTML = `<div class="card sess-box">
      <div class="ch">Punkt-Zählungen <em>optional eingrenzen</em></div>
      <label class="sess-row">
        <input type="checkbox" id="duExportAll" checked>
        <span><b style="color:var(--ink)">Alle Funde</b></span>
        <b>${sessions.length} Sitzung${sessions.length !== 1 ? 'en' : ''}</b>
      </label>
      ${sessions.map((s, i) => {
        const d = new Date(s.ts);
        const label = esc(s.name || ('Punkt-Zählung ' + d.toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric' }) + ' ' + d.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })));
        return `<label class="sess-row">
          <input type="checkbox" class="du-sess-chk" data-idx="${i}" disabled>
          <span>${label}</span>
          <b>${s.species ? s.species.length : 0} Arten</b>
        </label>`;
      }).join('')}
    </div>`;
    const exportBtns = container.querySelector('.export-btns');
    if (exportBtns) container.insertBefore(selEl, exportBtns);
    else container.insertBefore(selEl, container.firstChild);
    document.getElementById('duExportAll')?.addEventListener('change', function() {
      container.querySelectorAll('.du-sess-chk').forEach(c => { c.disabled = this.checked; if (this.checked) c.checked = false; });
      _updateSummary();
    });
    container.querySelectorAll('.du-sess-chk').forEach(c => c.addEventListener('change', () => _updateSummary()));
  }

  // Bereich "Heute hier" (heutige Funde im Umkreis von 3 km um die eigene Position) oder "Alles" —
  // der EINZIGE Export der App (der doppelte in der Statistik ist entfallen).
  const scopeEl = $('orniScope');
  const scope = () => scopeEl?.querySelector('button.on')?.dataset.scope || 'all';
  if (scopeEl && !scopeEl._wired) {
    scopeEl._wired = true;
    scopeEl.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      scopeEl.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      _renderExportSection();
    }));
  }

  function getSelectedDets() {
    let base = allDets;
    if (scope() === 'here') {
      let pos = null; try { pos = window.__waldohr?.getPos?.() || null; } catch {}
      base = todayNearbyDetections(allDets, pos);
    }
    const allChk = document.getElementById('duExportAll');
    if (!allChk || allChk.checked || !sessions.length) return base;
    const checked = [...container.querySelectorAll('.du-sess-chk:checked')];
    if (!checked.length) return base;
    const ranges = checked.map(c => {
      const s = sessions[parseInt(c.dataset.idx)];
      return { start: s.startTs, end: s.startTs + 5 * 60 * 1000 };
    });
    return base.filter(d => ranges.some(r => d.ts >= r.start && d.ts <= r.end));
  }

  // Zusammenfassung über dem Export: Arten, Beobachtungen, Zeitraum (lesbares Datum, kein ISO).
  function _updateSummary() {
    const sum = $('orniExportSummary'); if (!sum) return;
    const dets = getSelectedDets();
    const species = new Set(dets.map(d => d.key)).size;
    let lo = Infinity, hi = -Infinity; for (const d of dets) { if (d.ts < lo) lo = d.ts; if (d.ts > hi) hi = d.ts; }
    const a = dets.length ? fmtShortDate(lo) : '–', b = dets.length ? fmtShortDate(hi) : '';
    const range = !dets.length ? '–' : a === b ? a : a + ' – ' + b;
    const kpi = (n, l, sm) => `<div class="kpi"><div class="n${sm ? ' sm' : ''}">${esc(n)}</div><div class="l">${l}</div></div>`;
    sum.innerHTML = kpi(species, species === 1 ? 'Art' : 'Arten') + kpi(dets.length, 'Beobachtungen') + kpi(range, 'Zeitraum', true);
    container.querySelectorAll('.export-btn').forEach(b => { b.disabled = !dets.length; });
  }
  _updateSummary();

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
