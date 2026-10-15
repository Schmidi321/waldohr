// Rendering: Erkennungs-Karte, Sammlung, Statistik-Diagramme, Detail-Sheet, Navigation.
import { SPECIES, SPECIES_LIST, ensureSpecies } from './species.js';
import { gemini } from './gemini.js';
import { todayNearby, todayNearbyDetections, groupByLocation, haversineKm, bearingDeg, computeStats, getQualifyConfidence, setQualifyConfidence } from './db.js';
import { getMorgenchor, setMorgenchor, getNachtModus, setNachtModus, getFotoWecker, setFotoWecker, getSunriseFull, getDauerUeberwachung } from './alarm.js';
import { weatherLabel } from './weather.js';
import { esc, roundCoord } from './util.js';

const $ = id => document.getElementById(id);
const DEFAULT_GRAD = ['#0e5840', '#0a4733'];
// Linien-Icons aus dem Sprite in index.html (#i-…) — ein einheitlicher Satz statt Emoji.
export const icon = (name, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const CAMERA_ICON = icon('camera');
// Kartenfarben je Kategorie — identisch mit der Legende (.dot-* in styles.css).
const MAP_COLORS = { fav: '#60a5fa', rare: '#fbbf24', mammal: '#fb7185', common: '#34d399' };
const fmtHM = d => d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
// Lesbares Kurzdatum ("15. Okt.") statt ISO-Datum in Zeiträumen/KPIs.
export const fmtShortDate = ts => new Date(ts).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });

function avatarSVG(key, size) {
  const sp = SPECIES[key] || SPECIES.amsel;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" style="color:${sp.accent};width:${size}px;height:${size}px">${sp.icon}</svg>`;
}
function grad(key) { return (SPECIES[key] || {}).grad || DEFAULT_GRAD; }

// Relative Zeitangabe für "zuletzt gehört" (Sammlung-Karte + Detail-Sheet).
function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return 'vor ' + min + ' Min.';
  const h = Math.floor(min / 60);
  if (h < 24) return 'vor ' + h + ' Std.';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: sameYear ? undefined : 'numeric' }) +
    ', ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

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
        // Commons liefert Artist als HTML-Schnipsel: per DOMParser (führt nichts aus) zu reinem Text
        // machen — dekodiert dabei auch Entities wie &amp;, da die Anzeige jetzt per textContent läuft.
        const strip = h => { try { return (new DOMParser().parseFromString(String(h || ''), 'text/html').body.textContent || '').trim(); } catch { return String(h || '').replace(/<[^>]+>/g, '').trim(); } };
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
    // Bild-URL kommt aus der Wikipedia-API (bzw. dem localStorage-Cache) — als CSS-String mit
    // escapten Anführungszeichen einsetzen, damit sie nicht aus url('…') ausbrechen kann.
    el.style.backgroundImage = `url(${JSON.stringify(String(w.img))})`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    // has-img blendet Silhouette + Anfangsbuchstaben aus (CSS), statt nur das SVG zu verstecken.
    el.classList.add('has-img');
    const svg = el.querySelector('svg'); if (svg) svg.style.opacity = '0';
  });
}

// "Neu" gibt es nur noch beim allerersten Fund einer Art (Lifer) — vorher trug JEDE häufige Art
// das Etikett, es sagte also nichts mehr aus. Selten/Säuger bleiben als Hinweis immer stehen.
function rarityTag(r, lifer) {
  if (r === 'rare') return '<span class="tag rare">selten</span>';
  if (r === 'mammal') return '<span class="tag mammal">Säuger</span>';
  return lifer ? '<span class="tag new">neu</span>' : '';
}
// Erster Fund je Art über ALLE gespeicherten (qualifizierenden) Funde — Grundlage für "neu".
function firstSeenMap(dets) {
  const m = new Map();
  for (const d of dets) { const t = m.get(d.key); if (t == null || d.ts < t) m.set(d.key, d.ts); }
  return m;
}
let FIRST_SEEN = new Map();
function badge(s) {
  if (s.rarity === 'rare') return '<span class="badge rare">selten</span>';
  if (s.rarity === 'mammal') return '<span class="badge mammal">Säuger</span>';
  const first = FIRST_SEEN.get(s.key);
  if (first != null && Date.now() - first < 2 * 864e5) return '<span class="badge new">neu</span>';
  return '';
}

export function initUI() {
  const nav = document.querySelectorAll('.nav button');
  nav.forEach(b => b.onclick = () => {
    nav.forEach(x => { x.classList.remove('on'); x.removeAttribute('aria-current'); });
    b.classList.add('on'); b.setAttribute('aria-current', 'page');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const view = $('v-' + b.dataset.v);
    view.classList.add('active');
    // Eine gemeinsame Kopfzeile für alle Tabs: nur der Titel wechselt (data-title der View).
    const title = $('viewTitle'); if (title) title.textContent = view.dataset.title || '';
    if (b.dataset.v === 'map') {
      invalidateMapSize();
      if (mapNeedsRender) renderMap(lastMapDets);   // während "unsichtbar" übersprungenes volles Rendern nachholen
    }
    // app.js hängt sich hier an (Foto-Tab: Galerie-Badge löschen, Licht & Wetter laden).
    document.dispatchEvent(new CustomEvent('waldohr:tab', { detail: b.dataset.v }));
  });
  $('sheetScrim').onclick = closeSheet;
  $('sheetClose').onclick = closeSheet;
  const compassBtn = $('mCompassBtn');
  if (compassBtn) compassBtn.onclick = activateCompass;

  // Segment-Umschalter (Funde, Foto): blendet die Panels data-seg → #<prefix><Seg> um.
  wireSegments('fundeSeg', { arten: 'fundeArten', orte: 'fundeOrte', stat: 'fundeStat' }, seg => {
    fundeSeg = seg;
    if (seg === 'stat') renderStatsForMode();
  });
  wireSegments('fotoSeg', { galerie: 'fotoGalerie', licht: 'fotoLicht', wecker: 'fotoWecker', tipps: 'fotoTipps' }, seg => {
    document.dispatchEvent(new CustomEvent('waldohr:fotoseg', { detail: seg }));
    if (seg === 'wecker') initFotoWecker(livePos || lastCollPos);
  });

  // Einstellungen: speichern SOFORT (change/blur). Früher gab es einen "Speichern"-Knopf, und das
  // Schließen über den Hintergrund verwarf Eingaben still. Nur die Server-URL braucht "Übernehmen",
  // weil der Erkenner beim Start gewählt wird (App lädt neu).
  const settings = $('settingsModal');
  const closeSettings = () => settings.classList.remove('open');
  const openSettings = () => {
    $('geminiKey').value = gemini.getKey();
    $('xcKey').value = xcKeyGet();
    const sv = serverUrlGet();
    $('serverUrl').value = sv;
    $('serverStat').textContent = sv ? 'gesetzt' : 'nicht gesetzt (Demo-Modus)';
    populateMicSelect();
    settings.classList.add('open');
    const sh = settings.querySelector('.sheet'); if (sh) sh.scrollTop = 0;
  };
  $('gearBtn').onclick = openSettings;
  $('settingsScrim').onclick = closeSettings;
  $('settingsClose').onclick = closeSettings;
  $('geminiKey').addEventListener('change', e => { gemini.setKey(e.target.value); showInfoToast('Gespeichert', e.target.value.trim() ? 'Gemini-Key ist hinterlegt.' : 'Gemini-Key entfernt.', 'check'); });
  $('xcKey').addEventListener('change', e => { xcKeySet(e.target.value); showInfoToast('Gespeichert', e.target.value.trim() ? 'Xeno-canto-Key ist hinterlegt.' : 'Xeno-canto-Key entfernt.', 'check'); });
  $('serverApply').onclick = () => {
    const before = serverUrlGet();
    const after = serverUrlSet($('serverUrl').value);
    if (after === before) { showInfoToast('Keine Änderung', 'Die Server-Adresse ist bereits aktiv.', 'info'); return; }
    location.reload();
  };

  // Suchliste (bisher "Beobachtungsliste") — Stern in Funde und im Arten-Sheet.
  const favModal = $('favModal');
  const favSearch = $('favSearch');
  const openFavList = () => { if (favSearch) favSearch.value = ''; renderFavList(); favModal.classList.add('open'); };
  const favQuickBtn = $('favQuickBtn');
  if (favQuickBtn && favModal) favQuickBtn.onclick = openFavList;
  const favScrim = $('favScrim'); if (favScrim) favScrim.onclick = () => favModal.classList.remove('open');
  const favClose = $('favClose'); if (favClose) favClose.onclick = () => favModal.classList.remove('open');
  if (favSearch) {
    let t = null;
    favSearch.oninput = () => { clearTimeout(t); t = setTimeout(() => renderFavList(favSearch.value), 150); };
  }

  // Hilfe & Anleitung: "?" im Einstellungs-Kopf UND Eintrag unter "Über & Hilfe".
  const helpModal = $('helpModal');
  const closeHelp = () => { if (helpModal) helpModal.classList.remove('open'); };
  const openHelp = () => {
    closeSettings();
    // Immer eingeklappt starten (alle <details> zu), damit die Abschnitts-Übersicht sichtbar ist,
    // und wieder nach oben scrollen — sonst zeigt das Sheet die Scroll-Position vom letzten Mal.
    helpModal.querySelectorAll('.help-sec[open]').forEach(d => d.removeAttribute('open'));
    helpModal.classList.add('open');
    const sheet = helpModal.querySelector('.sheet'); if (sheet) sheet.scrollTop = 0;
  };
  ['helpOpenBtn', 'helpOpenBtn2'].forEach(id => { const b = $(id); if (b && helpModal) b.onclick = openHelp; });
  const helpScrim = $('helpScrim'); if (helpScrim) helpScrim.onclick = closeHelp;
  const helpClose = $('helpClose'); if (helpClose) helpClose.onclick = closeHelp;
  // Beim Aufklappen den Kopf des Abschnitts an den oberen Rand holen, damit nicht der halbe
  // Inhalt oberhalb der Sichtgrenze verschwindet (das Sheet selbst ist der Scroll-Container).
  if (helpModal) {
    helpModal.querySelectorAll('.help-sec').forEach(sec => {
      sec.addEventListener('toggle', () => {
        if (!sec.open) return;
        const sheet = helpModal.querySelector('.sheet');
        const sum = sec.querySelector('summary');
        if (sheet && sum) sheet.scrollTo({ top: sec.offsetTop - sum.offsetHeight - 4, behavior: 'smooth' });
      });
    });
  }

  // "Automatisch lauschen" (Morgenchor, Nacht-Modus; Dauerüberwachung verdrahtet ornithologie.js).
  const timingModal = $('timingModal');
  const closeTimingModal = () => timingModal && timingModal.classList.remove('open');
  const timingScrim = $('timingScrim'); if (timingScrim) timingScrim.onclick = closeTimingModal;
  const timingClose = $('timingClose'); if (timingClose) timingClose.onclick = closeTimingModal;
  // Jede Gruppe speichert NUR ihren eigenen Teil: Morgenchor/Nacht-Modus im Sheet, der Fotografen-
  // Wecker im Foto-Tab. Ein gemeinsames Speichern aller Felder hätte sonst z. B. beim Umschalten des
  // Weckers die (evtl. noch nie befüllten) Morgenchor-Felder als "aus" mitgeschrieben.
  // parseInt(x)||default würde eine echte 0 (":00"-Minuten, "00:"-Stunde) durch den Default ersetzen
  // (0 ist falsy) — der NaN-Check erhält echte Nullen.
  const numOr = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
  const saveMc = () => { setMorgenchor({ enabled: $('mcEnabled').checked, offsetMin: numOr($('mcOffset').value, 15) }); updateScheduleChip(); };
  const saveNm = () => {
    const s = ($('nmTime').value || '22:00').split(':'), e = ($('nmEndTime').value || '23:30').split(':');
    setNachtModus({ enabled: $('nmEnabled').checked, hour: numOr(s[0], 22), minute: numOr(s[1], 0), endEnabled: $('nmEndEnabled').checked, endHour: numOr(e[0], 23), endMinute: numOr(e[1], 30) });
    updateScheduleChip();
  };
  const saveFw = () => {
    const p = ($('fwTime').value || '05:30').split(':');
    setFotoWecker({ enabled: $('fwEnabled').checked, hour: numOr(p[0], 5), minute: numOr(p[1], 30), vibrateOnly: $('fwVibrateOnly').checked });
  };
  syncTimingControls();
  $('mcEnabled').addEventListener('change', saveMc);
  ['nmEnabled', 'nmEndEnabled', 'nmTime', 'nmEndTime'].forEach(id => $(id).addEventListener('change', saveNm));
  ['fwEnabled', 'fwVibrateOnly', 'fwTime'].forEach(id => $(id).addEventListener('change', saveFw));
  const mcOffsetEl = $('mcOffset');
  mcOffsetEl.addEventListener('input', () => {
    // Wert-Anzeige neben dem Regler — stand früher als inline oninput="…" in index.html, das eine
    // künftige Content-Security-Policy (ohne 'unsafe-inline') blockieren würde.
    $('mcOffsetVal').textContent = mcOffsetEl.value + ' Min';
    saveMc();
  });
  // Dauerüberwachung schaltet ornithologie.js — der Zeitplan-Chip soll trotzdem sofort mitziehen.
  const duEn = $('orniDuEnabled'); if (duEn) duEn.addEventListener('change', () => setTimeout(updateScheduleChip, 0));
  const duStop = $('duStop'); if (duStop) duStop.addEventListener('click', () => setTimeout(updateScheduleChip, 0));
  const srCard = $('fwSunriseCard');
  if (srCard) srCard.onclick = () => {
    const popup = $('fwDetailPopup'); if (!popup) return;
    popup.hidden = !popup.hidden;
    srCard.setAttribute('aria-expanded', String(!popup.hidden));
  };

  setInterval(renderLive, 2000);   // abgelaufene Einträge entfernen
  setInterval(updateScheduleChip, 60000);
  initWakeLockToggle();
  initShutterToggle();
  initLeftHandToggle();
  initSensitivitySliders();
  updateScheduleChip();

  // Funde: Bereich "Heute hier" / "Alle" gilt für Arten, Orte UND Statistik gemeinsam.
  const toggle = $('collToggle');
  if (toggle) {
    toggle.querySelectorAll('button').forEach(b => b.onclick = () => {
      toggle.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      collMode = statMode = b.dataset.mode;
      $('collHere').hidden = collMode !== 'here';
      $('collGlobal').hidden = collMode !== 'global';
      renderCollStats();
      renderLocList();
      renderStatsForMode();
    });
  }
  // Überlaufmenü schließen, sobald irgendwo anders getippt wird.
  document.addEventListener('click', e => {
    document.querySelectorAll('details.menu[open]').forEach(m => { if (!m.contains(e.target) || e.target.closest('.menu-item')) m.removeAttribute('open'); });
  });

  // Arten-Sheet: Aktionen (Suchliste, Richtung, Foto) — die Art steht in curSheet.
  $('mFavBtn').onclick = () => {
    if (!curSheet) return;
    toggleFavorite(curSheet.key);
    updateSheetFav();
  };
  $('mScanBtn').onclick = () => {
    if (!curSheet) return;
    const name = curSheet.name;
    closeSheet();   // Scan-Overlay liegt unter den Sheets — erst schließen
    if (typeof window.__waldohrScanDirection === 'function') window.__waldohrScanDirection(name);
  };
  $('mPhotoBtn').onclick = () => {
    if (!curSheet) return;
    const { name, key } = curSheet;
    closeSheet();
    if (typeof window.__waldohrCapturePhoto === 'function') window.__waldohrCapturePhoto(name, key);
  };
}

// Segment-Umschalter: Buttons mit data-seg → zeigen genau ein Panel (IDs aus map).
function wireSegments(segId, map, onChange) {
  const seg = $(segId); if (!seg) return;
  seg.querySelectorAll('button').forEach(b => b.onclick = () => {
    seg.querySelectorAll('button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    for (const [k, id] of Object.entries(map)) { const p = $(id); if (p) p.hidden = k !== b.dataset.seg; }
    if (onChange) onChange(b.dataset.seg);
  });
}
// Von app.js: Foto-Tab gezielt auf ein Segment stellen (z. B. "galerie" nach einem Video).
export function showFotoSegment(seg) {
  const b = document.querySelector(`#fotoSeg button[data-seg="${seg}"]`);
  if (b && !b.classList.contains('on')) b.click();
}
export function isFotoSegment(seg) {
  return !!document.querySelector(`#fotoSeg button.on[data-seg="${seg}"]`);
}

// ---- "Automatisch lauschen": Formular aus dem Speicher füllen + Status-Chip unter dem Orb ----
function syncTimingControls() {
  const mc = getMorgenchor();
  $('mcEnabled').checked = !!mc.enabled;
  $('mcOffset').value = mc.offsetMin; $('mcOffsetVal').textContent = mc.offsetMin + ' Min';
  const nm = getNachtModus();
  $('nmEnabled').checked = !!nm.enabled;
  $('nmTime').value = String(nm.hour).padStart(2, '0') + ':' + String(nm.minute).padStart(2, '0');
  $('nmEndTime').value = String(nm.endHour ?? 23).padStart(2, '0') + ':' + String(nm.endMinute ?? 30).padStart(2, '0');
  $('nmEndEnabled').checked = !!nm.endEnabled;
  const fw = getFotoWecker();
  $('fwEnabled').checked = !!fw.enabled;
  $('fwTime').value = String(fw.hour).padStart(2, '0') + ':' + String(fw.minute).padStart(2, '0');
  $('fwVibrateOnly').checked = !!fw.vibrateOnly;
}
let _sunCache = { key: '', sunrise: null };
async function _sunriseFor(pos) {
  if (!pos || pos.lat == null) return null;
  const key = new Date().toDateString() + '|' + pos.lat.toFixed(1) + '|' + pos.lng.toFixed(1);
  if (_sunCache.key === key) return _sunCache.full;
  try { const full = await getSunriseFull(pos.lat, pos.lng); _sunCache = { key, full }; return full; } catch { return null; }
}
// Kurzer Zustandstext: "Zeitplan: aus" · "Morgenchor 06:58" · "Nacht-Modus 22:00" · "Dauer 30 Min".
export async function updateScheduleChip() {
  const el = $('scheduleTxt'); if (!el) return;
  const parts = [];
  const du = getDauerUeberwachung();
  if (du && du.enabled) parts.push('Dauer ' + (du.durationMin >= 60 ? (du.durationMin / 60) + ' Std' : du.durationMin + ' Min'));
  const mc = getMorgenchor();
  let mcStart = null;
  const full = await _sunriseFor(livePos || lastCollPos);
  if (full && full.sunrise) mcStart = new Date(full.sunrise.getTime() - (mc.offsetMin || 0) * 60000);
  if (mc.enabled) parts.push('Morgenchor ' + (mcStart ? fmtHM(mcStart) : 'an'));
  const nm = getNachtModus();
  if (nm.enabled) parts.push('Nacht ' + String(nm.hour).padStart(2, '0') + ':' + String(nm.minute).padStart(2, '0'));
  el.textContent = parts.length ? parts.join(' · ') : 'Zeitplan: aus';
  $('timingBtn')?.classList.toggle('is-set', parts.length > 0);
  const info = $('mcStartInfo');
  if (info) info.textContent = mcStart ? 'Start heute um ' + fmtHM(mcStart) + ' Uhr (Sonnenaufgang ' + fmtHM(full.sunrise) + ')' : 'Startzeit erscheint, sobald dein Standort bekannt ist.';
}

// ---- Display anbleiben (Wake Lock) ----
let wakeLock = null;
async function applyWakeLock(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { console.warn('wakeLock', e); }
}
function wakeLockGet() { try { return localStorage.getItem('waldohr.wakelock') === '1'; } catch { return false; } }
function initWakeLockToggle() {
  const toggle = $('wakeLockToggle'); if (!toggle) return;
  toggle.checked = wakeLockGet();
  if (toggle.checked) applyWakeLock(true);
  toggle.onchange = () => {
    try { localStorage.setItem('waldohr.wakelock', toggle.checked ? '1' : '0'); } catch {}
    applyWakeLock(toggle.checked);
  };
  // Wake Lock wird vom Browser automatisch freigegeben, sobald der Tab in den Hintergrund
  // geht — bei Rückkehr in den Vordergrund, falls noch aktiviert, neu anfordern.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLockGet()) applyWakeLock(true);
  });
}

function initShutterToggle() {
  const toggle = $('shutterSoundToggle'); if (!toggle) return;
  toggle.checked = localStorage.getItem('waldohr.shutterSound') === 'on';
  toggle.onchange = () => {
    try { localStorage.setItem('waldohr.shutterSound', toggle.checked ? 'on' : 'off'); } catch {}
  };
}

function initLeftHandToggle() {
  const toggle = $('leftHandToggle'); if (!toggle) return;
  const on = localStorage.getItem('waldohr.leftHand') === 'on';
  toggle.checked = on;
  document.body.classList.toggle('left-hand', on);
  toggle.onchange = () => {
    document.body.classList.toggle('left-hand', toggle.checked);
    try { localStorage.setItem('waldohr.leftHand', toggle.checked ? 'on' : 'off'); } catch {}
  };
}

// Mikrofon-Auswahl fürs Lauschen (externe Mikros, z.B. per USB-C/Bluetooth angeschlossen) —
// separat von der Kamera-Mikrofonauswahl (js/camera.js), da für Video-Aufnahmen gedacht.
const LS_MIC = 'waldohr.micDevice';
export function getMicDeviceId() { try { return localStorage.getItem(LS_MIC) || ''; } catch { return ''; } }
async function populateMicSelect() {
  const sel = $('micDeviceSelect'); if (!sel) return;
  const saved = getMicDeviceId();
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all.filter(d => d.kind === 'audioinput');
    // new Option() statt innerHTML-Template: Geräte-Label/-ID liefert das Betriebssystem bzw. das
    // angeschlossene (Bluetooth-)Gerät selbst — frei wählbarer Text, der sonst als HTML landen würde.
    sel.replaceChildren(new Option('Automatisch (Standard)', ''),
      ...mics.map((d, i) => new Option(d.label || 'Mikrofon ' + (i + 1), d.deviceId)));
    sel.value = mics.some(d => d.deviceId === saved) ? saved : '';
  } catch (e) { console.warn('mic enumerate', e); }
  sel.onchange = () => { try { localStorage.setItem(LS_MIC, sel.value); } catch {} };
}

function initSensitivitySliders() {
  const qs = $('qualifySlider'), qv = $('qualifyVal');
  const as = $('autoRecSlider'), av = $('autoRecVal');
  if (!qs || !as) return;
  const curQ = Math.round(getQualifyConfidence() * 100);
  qs.value = curQ; if (qv) qv.textContent = curQ + '%';
  const curA = (() => { try { const v = parseFloat(localStorage.getItem('waldohr.autoRecConf')); return isNaN(v) ? 85 : Math.round(v * 100); } catch { return 85; } })();
  as.value = curA; if (av) av.textContent = curA + '%';
  qs.oninput = () => {
    const v = parseInt(qs.value, 10); if (qv) qv.textContent = v + '%';
    setQualifyConfidence(v / 100);
  };
  as.oninput = () => {
    const v = parseInt(as.value, 10); if (av) av.textContent = v + '%';
    try { localStorage.setItem('waldohr.autoRecConf', String(v / 100)); } catch {}
  };
  const durPresets = $('autoRecDurPresets');
  if (durPresets) {
    const curDur = (() => { try { const v = parseInt(localStorage.getItem('waldohr.autoRecDur'), 10); return [3, 5, 10, 60].includes(v) ? v : 3; } catch { return 3; } })();
    durPresets.querySelectorAll('.du-preset').forEach(btn => {
      btn.classList.toggle('on', parseInt(btn.dataset.dur, 10) === curDur);
      btn.onclick = () => {
        durPresets.querySelectorAll('.du-preset').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        try { localStorage.setItem('waldohr.autoRecDur', btn.dataset.dur); } catch {}
      };
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
  // Namen/sci stammen aus labels.txt bzw. dem (per Server/Backup erweiterbaren) Katalog -> überall esc(),
  // auch in den data-Attributen (dataset liest sie beim Markieren wieder unescaped zurück).
  return `<div class="favrow" data-sci="${esc(entry.sci)}" data-name="${esc(entry.name)}" data-key="${esc(key)}">
    <div class="ph" style="background:linear-gradient(140deg,${g[0]},${g[1]})">${avatarSVG(key, 20)}</div>
    <div class="favmeta"><div class="nm">${esc(entry.name)}</div><div class="lt">${esc(entry.sci)}</div></div>
    <button class="favstar${on ? ' on' : ''}" aria-pressed="${on}" aria-label="Auf die Suchliste">${icon(on ? 'star-fill' : 'star')}</button>
  </div>`;
}
// Suchliste umschalten (Liste, Arten-Sheet) — Kartenfarben ziehen sofort mit.
function toggleFavorite(key) {
  if (FAVORITES.has(key)) FAVORITES.delete(key); else FAVORITES.add(key);
  saveFavorites();
  renderMap(lastMapDets);
  return FAVORITES.has(key);
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
      const on = toggleFavorite(key);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.innerHTML = icon(on ? 'star-fill' : 'star');
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
// Arten, die in dieser Sitzung zum allerersten Mal gehört wurden (Lifer) — bleiben "neu", auch wenn
// die Zeile nach 15 s ausläuft und die Art später wiederkommt.
const LIFERS = new Set();
export function liveAdd(det) {
  const isNew = !LIVE.has(det.key);
  // Lifer = noch kein gespeicherter Fund dieser Art VOR dieser Erkennung. lastCollDets ist hier noch
  // der Stand vor dem refresh(), enthält den gerade gespeicherten Fund also nicht.
  if (isNew && !det.demo && !LIFERS.has(det.key) && !lastCollDets.some(d => d.key === det.key && d.ts < det.ts - 1000)) LIFERS.add(det.key);
  const e = LIVE.get(det.key) || { key: det.key, count: 0 };
  e.name = det.species; e.sci = det.sci; e.rarity = det.rarity;
  e.conf = det.confidence; e.ts = Date.now(); e.count++;
  // Demo-Treffer (Mock-Erkenner, zufällige Arten) sichtbar als solche markieren.
  e.demo = !!det.demo;
  LIVE.set(det.key, e);
  renderLive();
  // Fotografen-Funktion: einmalig beim Eintreffen alarmieren (selten ODER auf der Beobachtungsliste),
  // nicht bei jedem weiteren Erkennungsfenster derselben Art. Nie für Demo-Treffer — ein
  // "Seltene Art!"-Alarm für einen zufällig gewürfelten Eisvogel wäre schlicht falsch.
  if (isNew && !det.demo && (det.rarity !== 'common' || FAVORITES.has(det.key))) rareAlert(det);
}

// ---- Seltenheits-/Beobachtungs-Alarm: vibriert + zeigt einen Toast, wenn gerade eine relevante Art auftaucht ----
let rareToastTimer = null;
function rareAlert(det) {
  const toast = $('rareToast'); if (!toast) return;
  if (navigator.vibrate) { try { navigator.vibrate([120, 70, 120]); } catch {} }
  const isMammal = det.rarity === 'mammal';
  const isRare = det.rarity !== 'common';
  const ico = isMammal ? 'paw' : isRare ? 'sparkle' : 'star';
  const title = isMammal ? 'Seltenes Tier!' : isRare ? 'Seltene Art!' : 'Art von deiner Suchliste!';
  toast.innerHTML = `<span class="rt-ico">${icon(ico)}</span>
    <div class="rt-txt"><div class="rt-t">${title}</div><div class="rt-s">${esc(det.species)} ist gerade hier</div></div>
    <button class="rt-cam" title="Foto aufnehmen" aria-label="Foto aufnehmen">${CAMERA_ICON}</button>`;
  toast.className = 'rare-toast show' + (isMammal ? ' mammal' : !isRare ? ' fav' : '');
  toast.onclick = () => { openModal(det.key); toast.classList.remove('show'); };
  const camBtn = toast.querySelector('.rt-cam');
  if (camBtn) camBtn.onclick = ev => {
    ev.stopPropagation();
    if (typeof window.__waldohrCapturePhoto === 'function') window.__waldohrCapturePhoto(det.species, det.key);
    toast.classList.remove('show');
  };
  clearTimeout(rareToastTimer);
  rareToastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
}

// Schlichte Bestätigung für nicht-art-bezogene Aktionen (z. B. "Daten gelöscht") — selber
// Toast wie der Seltenheits-Alarm, aber neutral eingefärbt und ohne Kamera-Knopf/Klick-Ziel.
// Optionaler actionCb + actionLabel zeigt einen kleinen Button im Toast.
// Alle Texte reiner Text (esc): Aufrufer reichen u. a. Artnamen, Dateinamen und Sitzungsnamen durch.
// Aufrufer reichen teils noch Emoji als Icon (und am Titelanfang) durch — die werden hier auf die
// Linien-Icons abgebildet bzw. entfernt, damit Toasts überall gleich aussehen.
const TOAST_ICONS = { '📍': 'pin', '🗑️': 'trash', '🗑': 'trash', '💾': 'disk', '⚠️': 'alert', '⚠': 'alert', '⏱': 'timer', '🌅': 'sunrise', '🦉': 'moon', '📷': 'camera', '🗺️': 'route', 'ℹ️': 'info' };
const ICON_NAMES = new Set(['pin', 'trash', 'disk', 'alert', 'timer', 'sunrise', 'moon', 'camera', 'route', 'info', 'check', 'download', 'share', 'mic', 'sparkle', 'star']);
export function showInfoToast(title, sub, ico = 'info', actionCb, actionLabel) {
  const toast = $('rareToast'); if (!toast) return;
  const name = ICON_NAMES.has(ico) ? ico : (TOAST_ICONS[ico] || 'info');
  title = String(title ?? '').replace(/^[\p{Extended_Pictographic}️‍\s]+/u, '');
  let actionHtml = '';
  if (actionCb && actionLabel) actionHtml = `<button class="rt-action">${esc(actionLabel)}</button>`;
  toast.innerHTML = `<span class="rt-ico">${icon(name)}</span>
    <div class="rt-txt"><div class="rt-t">${esc(title)}</div><div class="rt-s">${esc(sub)}</div>${actionHtml}</div>`;
  toast.className = 'rare-toast show info';
  const dur = actionCb ? 8000 : 3500;
  if (actionCb) {
    const btn = toast.querySelector('.rt-action');
    if (btn) btn.onclick = ev => { ev.stopPropagation(); actionCb(); toast.classList.remove('show'); };
  }
  toast.onclick = () => toast.classList.remove('show');
  clearTimeout(rareToastTimer);
  rareToastTimer = setTimeout(() => toast.classList.remove('show'), dur);
}
export function renderLive() {
  const list = $('liveList'); if (!list) return;
  const now = Date.now();
  for (const [k, e] of LIVE) if (now - e.ts > LIVE_TTL) LIVE.delete(k);
  const arr = [...LIVE.values()].sort((a, b) => b.ts - a.ts);
  const cnt = $('liveCount'); if (cnt) cnt.textContent = arr.length;
  const empty = $('liveEmpty');
  list.querySelectorAll('.live-row').forEach(r => r.remove());
  // Der Hinweis "Tippe unten das Mikrofon…" macht keinen Sinn mehr, sobald gelauscht wird.
  // Der Hinweis "Tippe auf den Kreis…" macht keinen Sinn mehr, sobald gelauscht wird — dann
  // stattdessen sagen, dass gerade gehört wird.
  if (!arr.length) {
    if (empty) { empty.style.display = ''; empty.textContent = document.body.classList.contains('listening') ? 'Lauscht … noch keine Art erkannt.' : 'Tippe auf den Kreis – erkannte Arten erscheinen hier.'; }
    return;
  }
  if (empty) empty.style.display = 'none';
  // Läuft gerade eine Ruf-Aufnahme für eine Art (app.js setzt body.dataset.recKey), leuchtet deren Knopf.
  const recKey = document.body.dataset.recKey || '';
  for (const e of arr) {
    const g = grad(e.key), fresh = now - e.ts < 2500;
    const row = document.createElement('div');
    row.className = 'live-row' + (fresh ? ' fresh' : '') + (e.demo ? ' is-demo' : '');
    const tag = e.demo ? '<span class="tag demo" title="Demo-Modus: zufällige Art, wird nicht gespeichert">Demo</span>' : rarityTag(e.rarity, LIFERS.has(e.key));
    const recOn = recKey && recKey === e.key;
    row.innerHTML = `<div class="lr-av" style="background:linear-gradient(140deg,${g[0]},${g[1]})">${avatarSVG(e.key, 22)}</div>
      <div class="lr-meta"><div class="lr-nm">${esc(e.name)}</div><div class="lr-sub">${tag}<span class="lr-lt">${esc(e.sci)}</span></div></div>
      <div class="lr-conf">${Math.round(e.conf * 100)} %</div>
      <div class="lr-acts">
        <button class="lr-scan lr-act" title="Richtung finden" aria-label="Richtung finden: ${esc(e.name)}">${icon('compass')}</button>
        <button class="lr-photo lr-act" title="Foto aufnehmen" aria-label="Foto von ${esc(e.name)}">${CAMERA_ICON}</button>
        <button class="lr-rec lr-act${recOn ? ' on' : ''}" title="${recOn ? 'Aufnahme stoppen' : 'Diesen Ruf aufnehmen'}" aria-label="Ruf von ${esc(e.name)} aufnehmen" aria-pressed="${recOn}">${icon(recOn ? 'rec' : 'mic')}</button>
      </div>`;
    ['.lr-av', '.lr-meta', '.lr-conf'].forEach(sel => { const el = row.querySelector(sel); if (el) el.onclick = () => openModal(e.key, { conf: e.conf, demo: e.demo }); });
    // Demo-Treffer: keine art-beschrifteten Aufnahmen/Fotos anbieten — die würden mit einem frei
    // erfundenen Artnamen dauerhaft in Galerie & Sammlung landen.
    // (style.display statt hidden: .lr-rec/.lr-photo setzen display:grid und schlagen [hidden].)
    if (e.demo) { row.querySelector('.lr-rec').style.display = 'none'; row.querySelector('.lr-photo').style.display = 'none'; }
    const recBtn = row.querySelector('.lr-rec');
    recBtn.onclick = ev => { ev.stopPropagation(); if (typeof window.__waldohrRecordSpecies === 'function') window.__waldohrRecordSpecies(e.name, e.key); };
    row.querySelector('.lr-scan').onclick = ev => { ev.stopPropagation(); if (typeof window.__waldohrScanDirection === 'function') window.__waldohrScanDirection(e.name); };
    const photoBtn = row.querySelector('.lr-photo');
    photoBtn.onclick = ev => { ev.stopPropagation(); if (typeof window.__waldohrCapturePhoto === 'function') window.__waldohrCapturePhoto(e.name, e.key); };
    applySpeciesImage(row.querySelector('.lr-av'), e.sci);
    list.appendChild(row);
  }
}

export function renderAll(stats, dets, pos) {
  FIRST_SEEN = firstSeenMap(dets || []);
  renderCollection(stats, dets || [], pos || null);
  lastStatDets = dets || []; lastStatPos = pos || null;
  // Statistik nur rendern, wenn sie zu sehen ist (spart Arbeit bei jeder neuen Erkennung);
  // beim Umschalten auf "Statistik" rendert wireSegments sie nach.
  if (fundeSeg === 'stat') renderStatsForMode();
}

let statMode = 'here', lastStatDets = [], lastStatPos = null, fundeSeg = 'arten';
function statScopeDets() { return statMode === 'here' ? todayNearbyDetections(lastStatDets, lastStatPos) : lastStatDets; }
function renderStatsForMode() {
  const dets = statScopeDets();
  const stats = computeStats(dets);
  renderStats(stats);
  drawDayChart(stats.hourly);
  // Echter Zeitraum statt eines festen "Juni 2026".
  const per = $('statPeriod');
  if (per) {
    if (!dets.length) per.textContent = statMode === 'here' ? 'Heute hier noch keine Funde.' : 'Noch keine Funde.';
    else {
      let lo = Infinity, hi = -Infinity; for (const d of dets) { if (d.ts < lo) lo = d.ts; if (d.ts > hi) hi = d.ts; }
      const a = fmtShortDate(lo), b = fmtShortDate(hi);
      per.textContent = (statMode === 'here' ? 'Heute im Umkreis von 3 km · ' : 'Zeitraum: ') + (a === b ? a : a + ' – ' + b) + ' · ' + dets.length + ' Erkennungen';
    }
  }
}

// Eigene Aufnahmen (manuell + automatisch) je Art — session-only, damit sie sofort als kleines
// Icon auf der Sammlungskarte auftauchen, antippbar zum direkten Abspielen.
// Vertrag: die übergebene blob:-URL GEHÖRT ab jetzt dem Badge (wird hier beim Ersetzen/Entfernen
// freigegeben) — app.js reicht darum immer eine eigene URL rein, nie die der Galerie-Zeile. Sonst
// würde das Löschen/Zuschneiden einer Zeile dem Badge die URL unter den Füßen wegziehen (oder umgekehrt).
const RECORDINGS = new Map();
export function registerRecording(key, url) {
  if (!key || !url) return;
  const old = RECORDINGS.get(key);
  // Ersetzte Badge-URL freigeben — vorher blieb pro neuer Aufnahme derselben Art ein Blob hängen.
  if (old && old.url !== url) { try { URL.revokeObjectURL(old.url); } catch {} }
  RECORDINGS.set(key, { url, ts: Date.now() });
  refreshRecordingBadges();
}
export function unregisterRecording(key) {
  if (!key || !RECORDINGS.has(key)) return;
  try { URL.revokeObjectURL(RECORDINGS.get(key).url); } catch {}
  RECORDINGS.delete(key);
  refreshRecordingBadges();
}
export function clearRecordings() {
  // Vor dem Leeren die gehaltenen blob:-URLs freigeben — sonst bleibt bei jedem erneuten Hydrieren
  // (Backup-Import, DB-Reset) der gesamte vorherige Blob-Speicher unrevoked im Speicher hängen.
  for (const r of RECORDINGS.values()) { try { URL.revokeObjectURL(r.url); } catch {} }
  RECORDINGS.clear();
  refreshRecordingBadges();
}
function refreshRecordingBadges() {
  document.querySelectorAll('.spc').forEach(el => {
    const has = RECORDINGS.has(el.dataset.key);
    let b = el.querySelector('.rec-badge');
    if (has && !b) {
      b = document.createElement('button');
      b.className = 'rec-badge';
      b.title = 'Eigene Aufnahme abspielen';
      b.setAttribute('aria-label', 'Eigene Aufnahme abspielen');
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
      b.onclick = async ev => {
        ev.stopPropagation();
        const r = RECORDINGS.get(el.dataset.key);
        if (!r) return;
        if (typeof window.__waldohrSuspendMicForPlayback === 'function') await window.__waldohrSuspendMicForPlayback();
        const a = new Audio(r.url);
        const resume = () => { if (typeof window.__waldohrResumeMicAfterPlayback === 'function') window.__waldohrResumeMicAfterPlayback(); };
        a.onended = resume; a.onerror = resume;
        a.play().catch(resume);
      };
      el.appendChild(b);
    } else if (!has && b) { b.remove(); }
  });
}

// Artkarte: Wikimedia-Bild (nachgeladen) oder getönte Silhouette mit Anfangsbuchstaben; EINE
// Kennzahlenzeile (Anzahl · zuletzt) statt zweier.
function speciesCard(s) {
  const g = grad(s.key);
  const geo = lastGeoForKey(s.key);
  const ini = esc(String(s.name || '?').trim().charAt(0).toUpperCase());
  return `<div class="spc" data-key="${esc(s.key)}" role="button" tabindex="0" aria-label="${esc(s.name)}, ${s.count}× gehört">
    <div class="ph" style="background:linear-gradient(140deg,${g[0]},${g[1]})"><span class="ph-ini" aria-hidden="true">${ini}</span>${avatarSVG(s.key, 64)}</div>
    ${badge(s)}
    <div class="spc-body">
      <div class="nm">${esc(s.name)}</div><div class="lt">${esc(s.sci)}</div>
      <div class="spc-meta"><b>${s.count}×</b> · ${relTime(s.last)}${geo ? icon('pin') : ''}</div>
    </div>
  </div>`;
}
function wireCards(root) {
  root.querySelectorAll('.spc').forEach(el => {
    el.onclick = () => openModal(el.dataset.key);
    el.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openModal(el.dataset.key); } };
    applySpeciesImage(el.querySelector('.ph'), (SPECIES[el.dataset.key] || {}).sci);
  });
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
    <div class="stat"><div class="n">${n}</div><div class="l">Arten</div></div>
    <div class="stat"><div class="n">${total}</div><div class="l">Erkennungen</div></div>
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
      `<div class="empty-note">${pos ? 'Heute hier noch nichts entdeckt. Starte das Lauschen im Tab Lauschen.' : 'Standort aktivieren, um Funde in deiner Nähe zu sehen.'}</div>`;
    wireCards(hereGrid);
  }

  // "Alle" — jede Art, zuletzt gehörte zuerst (früher nur die letzten 8)
  const all = [...stats.perSpecies].sort((a, b) => b.last - a.last);
  const collGrid = $('collGrid');
  collGrid.innerHTML = all.map(s => speciesCard(s)).join('') || '<div class="empty-note">Noch nichts gehört.</div>';
  wireCards(collGrid);

  refreshRecordingBadges();
  renderLocList();
}

// Fundorte (gruppiert ~600 m) — folgt dem Bereich "Heute hier" / "Alle".
function renderLocList() {
  const locList = $('locList'); if (!locList) return;
  const dets = collMode === 'here' ? todayNearbyDetections(lastCollDets, lastCollPos) : lastCollDets;
  const groups = groupByLocation(dets);
  locList.innerHTML = groups.map((g, i) => `
    <div class="locrow">
      <div class="lr-head">
        ${icon('pin')}
        <span class="nm">Fundort ${i + 1} <span class="cnt">· ${relTime(g.last)}</span></span>
        <span class="cnt">${g.speciesCount} ${g.speciesCount === 1 ? 'Art' : 'Arten'} · ${g.total}×</span>
      </div>
      <div class="lr-species">${g.perSpecies.map(s => `<button class="lr-chip" data-key="${esc(s.key)}">${esc(s.name)}<b>×${s.count}</b></button>`).join('')}</div>
    </div>`).join('') || `<div class="empty-note">${collMode === 'here' ? 'Heute hier noch keine verorteten Funde.' : 'Noch keine verorteten Funde.'}</div>`;
  locList.querySelectorAll('.lr-chip').forEach(el => el.onclick = () => openModal(el.dataset.key));
}

function renderStats(stats) {
  const kpi = (n, label, ico) =>
    `<div class="kpi"><div class="n">${n}</div><div class="l">${icon(ico)}${label}</div></div>`;
  $('kpis').innerHTML =
    kpi(stats.total, 'Erkennungen', 'listen') +
    kpi(stats.speciesCount, stats.speciesCount === 1 ? 'Art' : 'Arten', 'grid') +
    kpi(stats.streak, stats.streak === 1 ? 'Tag in Serie' : 'Tage in Serie', 'clock') +
    kpi(stats.newThisWeek, 'Erkennungen diese Woche', 'sparkle');

  const top = stats.perSpecies.slice(0, 10);
  const tmax = Math.max(1, ...top.map(s => s.count));
  $('topSpecies').innerHTML = top.map((s, i) =>
    `<div class="row"><span class="nm">${esc(s.name)}</span>
      <div class="track"><div class="fill" style="width:${Math.round(s.count / tmax * 100)}%;animation-delay:${(0.05 + i * 0.07).toFixed(2)}s"></div></div>
      <span class="vv">${s.count}</span></div>`
  ).join('') || '<div class="empty-note">Noch keine Daten</div>';

  // 14 Tage: flache Balken, der stärkste Tag in Lime (kein Amber, keine Sonntags-Färbung mehr);
  // Beschriftung nur jeden zweiten Tag + heute, damit nichts gequetscht wird.
  const days14 = stats.last14 || stats.week;
  const wmax = Math.max(1, ...days14.map(d => d.count));
  $('weekBars').innerHTML = days14.map((d, i) => {
    const hi = d.count === wmax && d.count > 0 ? ' hi' : '';
    const last = i === days14.length - 1;
    const lbl = last ? 'heute' : ((days14.length - 1 - i) % 2 === 0 ? d.label : '');
    return `<div class="col${last ? ' today' : ''}" title="${d.weekday} ${d.label}: ${d.count}"><span class="vv">${d.count || ''}</span>
      <i class="bar${hi}" style="height:${Math.round(d.count / wmax * 100)}%;animation-delay:${(0.02 + i * 0.03).toFixed(2)}s"></i>
      <span class="d">${lbl}</span></div>`;
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
  // Keine erfundene Beispielkurve mehr: ohne Daten eine flache Linie und ein ehrlicher Hinweis.
  const sum = hourly.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...hourly);
  const act = hourly.map(v => v / max);
  const L = 14, R = 306, T = 16, B = 96;
  const pts = act.map((v, i) => [L + (i / (act.length - 1)) * (R - L), B - v * (B - T)]);
  const d = smooth(pts);
  line.setAttribute('d', d);
  $('dayArea').setAttribute('d', d + ` L${R},104 L${L},104 Z`);
  let mi = 0; act.forEach((v, i) => { if (v > act[mi]) mi = i; });
  const pk = $('dayPeak'); pk.setAttribute('cx', pts[mi][0].toFixed(1)); pk.setAttribute('cy', pts[mi][1].toFixed(1));
  pk.style.display = sum ? '' : 'none';
  // Echte Spitzenstunde statt des festen Texts "Spitze: Morgenchor".
  const lbl = $('dayPeakLbl');
  if (lbl) lbl.textContent = sum ? 'Spitze: ' + mi + '–' + (mi + 1) + ' Uhr' : 'noch keine Daten';
}

// Download eines Blobs (Share-Karte ohne Web-Share) — revoked die object URL nach dem Klick.
function _dlBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

// ---- Echte Karte (Leaflet + OpenStreetMap), lazy geladen erst wenn die Kartenansicht gebraucht wird ----
let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  // Subresource Integrity: unpkg ist ein fremdes CDN — ohne integrity würde ein dort manipuliertes
  // leaflet.js mit vollen Rechten in der App laufen (IndexedDB, Mikro-Stream, Standort). Hashes selbst
  // aus den 1.9.4-Dateien berechnet, identisch mit den offiziellen Werten auf leafletjs.com/download.
  // Bei einem Versions-Update MÜSSEN beide Hashes mitgezogen werden, sonst lädt die Karte nicht.
  // crossOrigin='' (anonymous) ist Pflicht, sonst prüft der Browser SRI bei Cross-Origin gar nicht.
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
      link.crossOrigin = '';
      link.setAttribute('data-leaflet', '');
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    script.crossOrigin = '';
    script.onload = () => resolve(window.L);
    // Promise zurücksetzen, damit ein späterer Tab-Wechsel (z. B. wieder mit Netz) neu versucht.
    script.onerror = () => { leafletPromise = null; script.remove(); reject(new Error('Leaflet konnte nicht geladen werden')); };
    document.head.appendChild(script);
  });
  return leafletPromise;
}

let mapInst = null, markersLayer = null, userMarker = null, lastMapDets = [], mapCenteredOnLive = false, mapNeedsRender = false;
// Ob der Karten-Tab gerade sichtbar ist (initUI toggelt "active" auf #v-map beim Tab-Wechsel).
function _isMapTabVisible() { const v = document.getElementById('v-map'); return !!v && v.classList.contains('active'); }
// Manuelle Positions-Korrektur (eigener Standort per Tippen auf die Karte)
let _manualPosHandler = null, _manualMode = false, _manualMarker = null;
export function setManualPosHandler(fn) { _manualPosHandler = fn; }
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
  // app.js ruft renderMap() nach JEDER qualifizierenden Erkennung auf — der teure Teil (bis zu 200
  // circleMarker + Popup-DOM neu aufbauen) lohnt sich nicht, solange der Karten-Tab gar nicht zu
  // sehen ist (Nutzer auf Sammlung/Statistik). lastMapDets ist oben schon aktualisiert, also holt
  // der nav-Handler in initUI beim Tab-Wechsel das volle Rendern einmalig nach (mapNeedsRender).
  if (!_isMapTabVisible()) { mapNeedsRender = true; return; }
  mapNeedsRender = false;
  // Nur abbrechen, wenn die Karte noch nie initialisiert wurde — sonst müssen alte Pins
  // weichen können (z.B. nach "Datenbank zurücksetzen"), auch ohne aktuellen GPS-Fix.
  if (!geo.length && !livePos && !mapInst) return;

  let L;
  try { L = await loadLeaflet(); } catch (e) { console.warn('leaflet', e); return; }
  if (!mapEl.isConnected) return;

  const recentGeo = geo.slice(-200);
  const isNewMap = !mapInst;
  if (isNewMap) {
    const initCenter = livePos ? [livePos.lat, livePos.lng] : [geo[geo.length - 1].lat, geo[geo.length - 1].lng];
    mapInst = L.map(mapEl, { attributionControl: true }).setView(initCenter, 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende'
    }).addTo(mapInst);
    markersLayer = L.layerGroup().addTo(mapInst);
    if (livePos) mapCenteredOnLive = true;
    else if (recentGeo.length > 1) mapInst.fitBounds(recentGeo.map(d => [d.lat, d.lng]), { padding: [28, 28], maxZoom: 16 });
    _setupManualPosControl(L);
    // Liegt kein einziger Fund im sichtbaren Ausschnitt, einen Hinweis mit "Alle Funde zeigen" einblenden.
    mapInst.on('moveend zoomend', _checkMapOutside);
    const fitBtn = $('mapFitBtn'); if (fitBtn) fitBtn.onclick = fitAllFinds;
    // Im Positions-setzen-Modus setzt ein Tippen auf die Karte die eigene Position.
    mapInst.on('click', e => {
      if (!_manualMode) return;
      _manualMode = false;
      const pos = { lat: e.latlng.lat, lng: e.latlng.lng };
      showManualPos(pos);
      if (_manualPosHandler) _manualPosHandler(pos);
    });
  }

  markersLayer.clearLayers();
  // Funde von Arten aus der Suchliste heben sich farblich ab (Himmelblau, unabhängig von der Seltenheit) —
  // vorher Lime, das neben dem Grün der häufigen Arten kaum zu unterscheiden war.
  const colorFor = d => FAVORITES.has(d.key) ? MAP_COLORS.fav : MAP_COLORS[d.rarity] || MAP_COLORS.common;
  for (const d of recentGeo) {
    const m = L.circleMarker([d.lat, d.lng], { radius: 7, color: '#04130d', weight: 1.5, fillColor: colorFor(d), fillOpacity: .95 });
    // Erst Name als Vorschau (Leaflet-Popup) statt direkt das volle Detail-Fenster zu öffnen —
    // bei dicht liegenden Punkten sieht man so, welchen man erwischt hat, bevor man reinklickt.
    const popupEl = document.createElement('button');
    popupEl.className = 'map-pin-popup';
    const dot = document.createElement('span'); dot.className = 'mp-dot'; dot.style.background = colorFor(d);
    const nameSpan = document.createElement('span'); nameSpan.className = 'mp-name'; nameSpan.textContent = d.species || 'Unbekannt';
    const chev = document.createElement('span'); chev.innerHTML = icon('chev');
    popupEl.append(dot, nameSpan, chev);
    popupEl.onclick = () => openModal(d.key);
    m.bindPopup(popupEl, { closeButton: false, offset: [0, -4], className: 'map-pin-popup-wrap' });
    m.addTo(markersLayer);
  }

  // Sobald die eigene Position das erste Mal eintrifft (z.B. weil GPS verzögert reagiert hat),
  // einmalig dorthin zentrieren. Danach NICHT mehr automatisch nachführen — sonst reißt die Karte
  // bei jedem neuen Fund/GPS-Tick die Ansicht weg, während der Nutzer sie selbst bedient. Das war
  // der eigentliche Bug: vorher wurde bei jedem Render auf die Fund-Pins gefittet, wodurch die
  // eigene Position nie sichtbar im Bild blieb.
  if (!mapCenteredOnLive && livePos) {
    mapInst.setView([livePos.lat, livePos.lng], 14);
    mapCenteredOnLive = true;
  }
  updateUserMarker();
  setTimeout(() => { if (mapInst) { mapInst.invalidateSize(); _checkMapOutside(); } }, 60);
}

// Alle verorteten Funde ins Bild holen (Knopf unter "Position setzen" und im Leerhinweis).
function fitAllFinds() {
  if (!mapInst) return;
  const pts = lastMapDets.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number').slice(-200).map(d => [d.lat, d.lng]);
  if (!pts.length) { if (livePos) mapInst.setView([livePos.lat, livePos.lng], 14); return; }
  if (pts.length === 1) mapInst.setView(pts[0], 16);
  else mapInst.fitBounds(pts, { padding: [32, 32], maxZoom: 16 });
}
function _checkMapOutside() {
  const hint = $('mapOutside'); if (!hint || !mapInst) return;
  const geo = lastMapDets.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
  if (!geo.length) { hint.hidden = true; return; }
  const b = mapInst.getBounds();
  hint.hidden = geo.some(d => b.contains([d.lat, d.lng]));
}

// Mini-Männchen-Icon fürs "Du bist hier": Pulsring + Figur + Richtungspfeil
// (Pfeil wird nur eingeblendet/gedreht, sobald sich die Position tatsächlich ändert).
const PERSON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="6.5" r="4.2"/><path d="M12 13c-4.7 0-8.5 2.8-8.5 6.3V22h17v-2.7c0-3.5-3.8-6.3-8.5-6.3z"/></svg>';
function _walkerIconHtml() {
  return `<span class="you-pulse"></span><span class="map-heading-arrow"></span><span class="you-figure">${PERSON_SVG}</span>`;
}

// Bewegt einen Marker weich von seiner aktuellen Position zur neuen (statt hart zu springen) und
// dreht den kleinen Richtungspfeil in die Bewegungsrichtung. Bei der allerersten Platzierung
// (kein vorheriger Punkt) wird direkt gesetzt, ohne zu gleiten (nichts, wovon man "herkommen" könnte).
// Pro Marker aktive Glide-"Generation" (WeakMap, kein Leak): trifft ein neues Ziel ein, während
// die vorige Glide-Animation (~900ms) noch läuft, würde der ältere Tick-Loop den Marker sonst
// wieder auf sein inzwischen veraltetes Ziel zurückspringen lassen (sichtbares Rückwärts-Zucken).
const _glideGen = new WeakMap();
function _glideMarker(marker, fromPos, toPos, durMs = 900) {
  if (!fromPos) { marker.setLatLng([toPos.lat, toPos.lng]); _glideGen.set(marker, (_glideGen.get(marker) || 0) + 1); return; }
  const el = marker.getElement();
  const arrow = el && el.querySelector('.map-heading-arrow');
  const distM = haversineKm(fromPos, toPos) * 1000;
  if (arrow && distM > 1.5) {
    const brg = bearingDeg(fromPos, toPos);
    arrow.style.transform = `rotate(${brg}deg)`;
    arrow.classList.add('visible');
  }
  const gen = (_glideGen.get(marker) || 0) + 1;
  _glideGen.set(marker, gen);
  const t0 = performance.now();
  const tick = now => {
    if (_glideGen.get(marker) !== gen) return; // von einem neueren Glide für denselben Marker abgelöst
    const p = Math.min(1, (now - t0) / durMs);
    const lat = fromPos.lat + (toPos.lat - fromPos.lat) * p;
    const lng = fromPos.lng + (toPos.lng - fromPos.lng) * p;
    marker.setLatLng([lat, lng]);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// "Du bist hier"-Marker — eigene aktuelle Position, unabhängig von den Fund-Pins.
let _lastUserPos = null;
function updateUserMarker() {
  if (!mapInst || !window.L || !livePos) return;
  const L = window.L;
  if (!userMarker) {
    const icon = L.divIcon({ className: 'you-marker', html: _walkerIconHtml(), iconSize: [26, 26], iconAnchor: [13, 13] });
    userMarker = L.marker([livePos.lat, livePos.lng], { icon, interactive: false, zIndexOffset: 1000 }).addTo(mapInst);
    _lastUserPos = livePos;
  } else {
    _glideMarker(userMarker, _lastUserPos, livePos);
    _lastUserPos = livePos;
  }
}

// ---- Manuelle Positions-Korrektur ----
// Eigener Leaflet-Control-Button: aktiviert den Setz-Modus; das nächste Tippen auf die Karte legt
// die eigene Position fest (überschreibt den GPS-Fehler, z. B. für die Koordinaten neuer Funde).
let _manualBtnEl = null;
function _setupManualPosControl(L) {
  const Ctl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      // Zwei Knöpfe untereinander: Position setzen (Stecknadel) und darunter "Alle Funde zeigen".
      const wrap = L.DomUtil.create('div', 'map-ctl');
      const el = L.DomUtil.create('button', 'map-manual-btn', wrap);
      el.type = 'button';
      el.title = 'Eigene Position manuell setzen';
      el.setAttribute('aria-label', 'Eigene Position manuell setzen');
      el.innerHTML = icon('pin');
      const fit = L.DomUtil.create('button', 'map-manual-btn map-fit-btn', wrap);
      fit.type = 'button';
      fit.title = 'Alle Funde zeigen';
      fit.setAttribute('aria-label', 'Alle Funde zeigen');
      fit.innerHTML = icon('frame');
      fit.onclick = fitAllFinds;
      L.DomEvent.disableClickPropagation(wrap);
      el.onclick = () => {
        // Ist bereits eine manuelle Position gesetzt -> Klick hebt sie auf (zurück zu GPS).
        if (_manualMarker) { showManualPos(null); if (_manualPosHandler) _manualPosHandler(null); return; }
        _manualMode = !_manualMode;
        _updateManualBtn();
      };
      _manualBtnEl = el;
      return wrap;
    },
  });
  mapInst.addControl(new Ctl());
  _updateManualBtn();
}
function _updateManualBtn() {
  if (!_manualBtnEl) return;
  _manualBtnEl.classList.toggle('arming', _manualMode);
  _manualBtnEl.classList.toggle('set', !!_manualMarker);
  _manualBtnEl.title = _manualMarker ? 'Manuelle Position — tippen zum Aufheben (zurück zu GPS)'
    : _manualMode ? 'Jetzt auf die Karte tippen…' : 'Eigene Position manuell setzen';
}
// Von app.js aufgerufen, wenn die manuelle Position gesetzt/aufgehoben wurde — Marker aktualisieren.
export function showManualPos(pos) {
  if (!mapInst || !window.L) { _manualMode = false; return; }
  const L = window.L;
  if (_manualMarker) { _manualMarker.remove(); _manualMarker = null; }
  if (pos) {
    const pinIcon = L.divIcon({ className: 'manual-pos-marker', html: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>', iconSize: [30, 30], iconAnchor: [15, 28] });
    _manualMarker = L.marker([pos.lat, pos.lng], { icon: pinIcon, interactive: false, zIndexOffset: 1100 }).addTo(mapInst);
  }
  _updateManualBtn();
}

let routeLayer = null;
export function updateRouteMap(points) {
  if (!mapInst || !window.L) return;
  const L = window.L;
  if (routeLayer) { routeLayer.remove(); routeLayer = null; }
  if (!points || points.length < 2) return;
  routeLayer = L.polyline(points.map(p => [p.lat, p.lng]), {
    color: '#a3e635', weight: 3, opacity: 0.8,
  }).addTo(mapInst);
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
// Wie lastGeoForKey, aber auch ohne GPS-Koordinaten — liefert immer den letzten Fund für die
// Uhrzeit, der Ort wird nur angezeigt, wenn vorhanden.
function lastDetForKey(key) {
  let best = null;
  for (const d of lastCollDets) {
    if (d.key !== key) continue;
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
// Deckt die Lücke zwischen Tap und dem Setzen von callAudio ab: solange fetchSpeciesAudio noch
// nicht zurück ist, steht callAudio noch auf null, also würde ein zweiter schneller Tap den
// paused-Guard unten ebenfalls passieren und ein eigenes, konkurrierendes Audio-Objekt erzeugen.
let callBusy = false;
function stopCallAudio() {
  if (callAudio) { callAudio.pause(); callAudio = null; }
  if (typeof window.__waldohrResumeMicAfterPlayback === 'function') window.__waldohrResumeMicAfterPlayback();
  const icon = $('mPlayIcon'), label = $('mPlayLabel');
  if (icon) icon.innerHTML = '<path d="M6 4l14 8-14 8z"/>';
  if (label) label.textContent = 'Ruf anhören';
}
async function togglePlayCall(sci) {
  if (callAudio && !callAudio.paused) { stopCallAudio(); return; }
  if (callBusy) return;   // vorherige Anfrage noch in Flight — zweiten Tap ignorieren statt zu überlagern
  if (!xcKeyGet()) {
    const label = $('mPlayLabel'); if (label) label.textContent = 'Xeno-canto-Key fehlt (Einstellungen)';
    setTimeout(() => { if (label) label.textContent = 'Ruf anhören'; }, 3000);
    return;
  }
  callBusy = true;
  const label = $('mPlayLabel'); if (label) label.textContent = 'Suche Aufnahme …';
  const url = await fetchSpeciesAudio(sci);
  if (!url) { callBusy = false; if (label) label.textContent = 'Keine Aufnahme gefunden'; setTimeout(() => { if (label) label.textContent = 'Ruf anhören'; }, 2500); return; }
  // Mikro kurz pausieren: sonst routen iOS/Android die Wiedergabe leise über den Hörer statt
  // den Lautsprecher (geteilte Aufnahme+Wiedergabe-Audiosession), und das eigene Mikro würde
  // die abgespielte Referenzaufnahme sonst als neue Live-Erkennung missverstehen.
  if (typeof window.__waldohrSuspendMicForPlayback === 'function') await window.__waldohrSuspendMicForPlayback();
  // Lokale Referenz statt direkt mit callAudio zu arbeiten: so kann onended/onerror einer
  // inzwischen überholten Instanz nicht mehr die NEUERE, noch laufende callAudio-Referenz nullen.
  const audio = new Audio(url);
  callAudio = audio;
  callBusy = false;
  audio.onended = () => { if (callAudio === audio) stopCallAudio(); };
  audio.onerror = () => { if (label) label.textContent = 'Wiedergabe fehlgeschlagen'; if (callAudio === audio) stopCallAudio(); };
  try { await audio.play(); } catch (e) { console.warn('play', e); if (label) label.textContent = 'Wiedergabe fehlgeschlagen'; if (callAudio === audio) stopCallAudio(); return; }
  if (label) label.textContent = 'Spielt … (Xeno-canto)';
  const icon = $('mPlayIcon'); if (icon) icon.innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
}

// ---- Share-Karte (Canvas, 1080×1080, Instagram/WhatsApp-tauglich) ----
function _rRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
function _wrapText(ctx, text, x, y, maxW, lh) {
  const words = text.split(' '); let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, y); line = w; y += lh; }
    else { line = t; }
  }
  if (line) ctx.fillText(line, x, y);
}
async function buildShareCard(sp, imgUrl, credit, pos) {
  const W = 1080, H = 1080;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#061a0f'); bg.addColorStop(0.65, '#04130d'); bg.addColorStop(1, '#020d09');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  // Subtle lime grid
  ctx.strokeStyle = 'rgba(163,230,53,0.04)'; ctx.lineWidth = 1;
  for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  // Bird image
  const IY = 54, IH = 560;
  if (imgUrl) {
    await new Promise(res => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => {
        const ir = img.width / img.height;
        let iw = W - 120, ih = IH;
        if (iw / ih > ir) iw = ih * ir; else ih = iw / ir;
        const ix = (W - iw) / 2, iy = IY + (IH - ih) / 2;
        ctx.save(); _rRect(ctx, ix, iy, iw, ih, 22); ctx.clip();
        ctx.drawImage(img, ix, iy, iw, ih);
        const fade = ctx.createLinearGradient(0, iy + ih * 0.55, 0, iy + ih);
        fade.addColorStop(0, 'rgba(4,19,13,0)'); fade.addColorStop(1, 'rgba(4,19,13,0.5)');
        ctx.fillStyle = fade; ctx.fillRect(ix, iy, iw, ih);
        ctx.restore(); res();
      };
      img.onerror = res; img.src = imgUrl;
    });
  }
  // Lime accent line
  ctx.fillStyle = 'rgba(163,230,53,0.65)'; ctx.fillRect(80, 640, W - 160, 3);
  ctx.textAlign = 'center';
  // Species name
  ctx.fillStyle = '#fff'; ctx.font = 'bold 86px Outfit, sans-serif';
  _wrapText(ctx, sp.name || '', W / 2, 716, W - 100, 98);
  // Scientific name
  ctx.fillStyle = 'rgba(163,230,53,0.88)'; ctx.font = 'italic 38px Inter, sans-serif';
  ctx.fillText(sp.sci || '', W / 2, 800);
  // Location + date
  const dateStr = new Date().toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
  ctx.font = '28px Inter, sans-serif';
  // pos kommt hier schon vergröbert (bzw. null bei schützenswerten Arten) aus sharePhotoCard.
  if (pos) {
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('📍 ' + _fmtSharePos(pos) + ' · ' + dateStr, W / 2, 870);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(dateStr, W / 2, 870);
  }
  // Separator
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(80, 928); ctx.lineTo(W - 80, 928); ctx.stroke();
  // Branding
  ctx.fillStyle = 'rgba(163,230,53,0.9)'; ctx.font = '600 32px Outfit, sans-serif';
  ctx.fillText('🌿 WaldOhr', W / 2, 982);
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '22px Inter, sans-serif';
  ctx.fillText('Tierstimmen erkennen', W / 2, 1016);
  // Photo credit
  if (credit && credit.artist) {
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.font = '18px Inter, sans-serif';
    ctx.fillText('Foto: ' + credit.artist + (credit.license ? ' · ' + credit.license : ''), W / 2, 1055);
  }
  return new Promise(res => cv.toBlob(res, 'image/jpeg', 0.93));
}

let modalToken = 0;
// Die gerade im Arten-Sheet gezeigte Art (für Suchliste/Richtung/Foto-Aktionen).
let curSheet = null;
function updateSheetFav() {
  const b = $('mFavBtn'); if (!b || !curSheet) return;
  const on = FAVORITES.has(curSheet.key);
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('svg').outerHTML = icon(on ? 'star-fill' : 'star');
  b.querySelector('span').textContent = on ? 'Auf Suchliste' : 'Suchliste';
}
// opts.conf: Erkennungssicherheit (nur aus der Live-Liste bekannt) · opts.demo: Demo-Treffer
function openModal(key, opts = {}) {
  const sp = SPECIES[key] || SPECIES.amsel;
  const g = sp.grad || DEFAULT_GRAD;
  curSheet = { key, name: sp.name };
  $('mName').textContent = sp.name;
  $('mSci').textContent = sp.sci;
  // Konfidenz als Zahl neben dem Balken — früher stand hier fest 96 %, egal woher man kam.
  const confRow = $('mConfRow');
  if (confRow) {
    const has = typeof opts.conf === 'number';
    confRow.hidden = !has;
    if (has) {
      const pct = Math.round(opts.conf * 100);
      $('mConfFill').style.width = pct + '%';
      $('mConfVal').textContent = pct + ' %';
      confRow.title = 'Erkennungssicherheit ' + pct + ' %';
    }
  }
  updateSheetFav();
  // Demo-Treffer: kein art-beschriftetes Foto (der Artname ist zufällig gewürfelt).
  const photoBtn = $('mPhotoBtn'); if (photoBtn) photoBtn.hidden = !!opts.demo;
  const wiki = $('mWikiLink');
  if (wiki) wiki.href = 'https://de.wikipedia.org/wiki/' + encodeURIComponent(String(sp.sci || sp.name || '').replace(/ /g, '_'));
  const av = $('mAvatar');
  av.style.background = `linear-gradient(140deg,${g[0]},${g[1]})`;
  av.style.backgroundImage = ''; av.style.backgroundSize = ''; av.style.backgroundPosition = '';
  av.innerHTML = avatarSVG(key, 34);
  av.style.cursor = 'pointer'; av.title = 'Bild vergrößern';
  av.onclick = () => {
    const bg = av.style.backgroundImage;
    if (!bg || !bg.includes('url(')) return;
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/); if (!m) return;
    const full = m[1].replace(/\/thumb\//, '/').replace(/\/\d+px-[^/]+$/, '');
    let ov = document.getElementById('_imgOv');
    if (!ov) {
      ov = document.createElement('div'); ov.id = '_imgOv';
      ov.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(2,8,6,.68);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:zoom-out';
      const img = document.createElement('img');
      img.style.cssText = 'max-width:92%;max-height:80vh;object-fit:contain;border-radius:18px;box-shadow:0 12px 60px rgba(0,0,0,.75)';
      const cr = document.createElement('div'); cr.id = '_imgCredit';
      cr.style.cssText = 'margin-top:10px;font-size:11px;color:rgba(255,255,255,.4);text-align:center;max-width:85%;cursor:default;padding:0 8px';
      ov.append(img, cr);
      ov.onclick = e => { if (e.target === ov || e.target === img) ov.remove(); };
      document.body.appendChild(ov);
    }
    ov.querySelector('img').src = full;
    const crEl = document.getElementById('_imgCredit');
    if (crEl) {
      const c = av._credit;
      if (c && (c.artist || c.license)) {
        crEl.textContent = 'Foto: ' + (c.artist || 'Wikimedia Commons') + (c.license ? ' · ' + c.license : '');
        crEl.style.cursor = c.pageUrl ? 'pointer' : 'default';
        crEl.onclick = c.pageUrl ? e => { e.stopPropagation(); window.open(c.pageUrl, '_blank', 'noopener,noreferrer'); } : null;
      } else {
        crEl.textContent = 'Wikimedia Commons';
      }
    }
    if (!ov.isConnected) document.body.appendChild(ov);
  };
  applySpeciesImage(av, sp.sci);
  $('mMeaning').innerHTML = sp.meaning;
  $('mSteckbrief').textContent = sp.steckbrief;
  const badge = $('mAi'); if (badge) badge.hidden = true;
  const photoTipBlock = $('mPhotoTipBlock'); if (photoTipBlock) photoTipBlock.hidden = true;
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

  // Letzter Fund: Uhrzeit immer, Ort nur wenn verortet — unabhängig vom eigenen Live-Standort.
  const lastBlock = $('mLastBlock');
  if (lastBlock) {
    const lastDet = lastDetForKey(key);
    if (lastDet) {
      lastBlock.hidden = false;
      const when = relTime(lastDet.ts);
      const where = (typeof lastDet.lat === 'number' && typeof lastDet.lng === 'number')
        ? lastDet.lat.toFixed(4) + '° N, ' + lastDet.lng.toFixed(4) + '° O' : null;
      const dirs = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
      const dir = (typeof lastDet.heading === 'number')
        ? 'Blick nach ' + dirs[Math.round(lastDet.heading / 45) % 8] + ' (' + lastDet.heading + '°)' : null;
      const wx = lastDet.weather
        ? lastDet.weather.temp + ' °C, ' + weatherLabel(lastDet.weather.wmo) : null;
      $('mLastInfo').textContent = [when, where, dir, wx].filter(Boolean).join(' · ');
    } else {
      lastBlock.hidden = true;
    }
  }

  const token = ++modalToken;
  let textSource = 'catalog';

  if (sp.sci) {
    fetchSpeciesWiki(sp.sci).then(w => {
      if (token !== modalToken || !w || !w.img) return;
      fetchImageCredit(w.img).then(c => {
        if (token !== modalToken || !c) return;
        av._credit = c;
        if (!creditEl || (!c.artist && !c.license)) return;
        // textContent statt innerHTML: Urheber/Lizenz sind freier Text aus der Commons-API (bzw. dem
        // localStorage-Cache) — das HTML-Strippen in fetchImageCredit ist kein Escaping.
        creditEl.textContent = `Foto: ${c.artist || 'Wikimedia Commons'}${c.license ? ' · ' + c.license : ''}`;
        creditEl.onclick = () => c.pageUrl && window.open(c.pageUrl, '_blank', 'noopener,noreferrer');
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
    if (badge) { badge.hidden = false; badge.textContent = 'Gemini …'; }
    gemini.enrich(sp.sci, sp.name).then(res => {
      if (token !== modalToken) return;
      if (!res) { if (badge) badge.hidden = true; return; }
      $('mMeaning').textContent = res.meaning;
      $('mSteckbrief').textContent = res.steckbrief;
      textSource = 'gemini';
      if (badge) badge.textContent = 'erklärt von Gemini';
      if (res.photoTip) {
        const b = $('mPhotoTipBlock'), p = $('mPhotoTip');
        if (b && p) { p.textContent = res.photoTip; b.hidden = false; }
      }
    });
  }
}
function closeSheet() { $('sheet').classList.remove('open'); stopOrientation(); stopCallAudio(); curTargetGeo = null; curSheet = null; }

// "Automatisch lauschen" öffnen: Formular frisch aus dem Speicher (Dauerüberwachung kann
// inzwischen von selbst geendet haben) + Startzeit des Morgenchors.
export async function openTimingModal() {
  const modal = $('timingModal');
  if (!modal) return;
  syncTimingControls();
  updateScheduleChip();
  modal.classList.add('open');
  const sh = modal.querySelector('.sheet'); if (sh) sh.scrollTop = 0;
}

// Fotografen-Wecker (Foto-Tab → Wecker): Sonnenaufgang + Dämmerungsphasen für heute.
export function initFotoWecker(pos) {
  syncTimingControls();
  const srEl = $('fwSunriseTime');
  if (!srEl) return;
  if (!pos || pos.lat == null) { srEl.textContent = '–:–'; return; }
  if (srEl.textContent === '–:–') srEl.textContent = '…';
  _sunriseFor(pos).then(full => {
    if (!full) { srEl.textContent = '–:–'; return; }
    srEl.textContent = fmtHM(full.sunrise);
    const golden = new Date(full.sunrise.getTime() + 60 * 60000);
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('fwPhaseAstro', fmtHM(full.astronomicalBegin));
    set('fwPhaseNaut', fmtHM(full.nauticalBegin));
    set('fwPhaseCivil', fmtHM(full.civilBegin));
    set('fwPhaseSunrise', fmtHM(full.sunrise));
    set('fwPhaseGolden', fmtHM(full.sunrise) + '–' + fmtHM(golden));
  }).catch(() => { srEl.textContent = '–:–'; });
}

// Galerie-Share: eigenes Foto → Share-Karte → nativer Share-Dialog.
// Wird von app.js aus den Foto-Zeilen der Galerie aufgerufen.
// Geteilte Bilder/Texte verlassen das Gerät dauerhaft (Social Media, Messenger) — darum nie die
// präzise Position: auf 2 Nachkommastellen (≈ 1 km) vergröbert, und bei allem außer häufigen Arten
// (selten / Säuger) ganz weggelassen, damit sich Brut- und Rückzugsplätze nicht ablesen lassen.
// In der App/DB und in den Ornithologie-Exporten bleiben die genauen Koordinaten erhalten.
function _sharePos(pos, sp) {
  if (!pos || typeof pos.lat !== 'number' || typeof pos.lng !== 'number') return null;
  if (sp && sp.rarity && sp.rarity !== 'common') return null;
  return { lat: roundCoord(pos.lat, 2), lng: roundCoord(pos.lng, 2) };
}
function _fmtSharePos(p) { return p.lat.toFixed(2) + '° N, ' + p.lng.toFixed(2) + '° O'; }

export async function sharePhotoCard(photoUrl, key, label, rawPos) {
  const sp = SPECIES[key] || { name: label || 'Unbekannte Art', sci: '' };
  const pos = _sharePos(rawPos, SPECIES[key]);
  const blob = await buildShareCard(sp, photoUrl, { artist: 'Eigenes Foto' }, pos);
  const fname = 'waldohr-' + (sp.name || label || 'vogel').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.jpg';
  const file = blob ? new File([blob], fname, { type: 'image/jpeg' }) : null;
  const appUrl = location.origin + location.pathname;
  const locTxt = pos ? '\n📍 ' + _fmtSharePos(pos) : '';
  const title = 'WaldOhr – ' + (sp.name || label || '');
  const text = (sp.name || label || '') + (sp.sci ? ' (' + sp.sci + ')' : '') + ' – eigenes Foto! 📸'
    + locTxt + '\n\n#WaldOhr #Ornithologie #Vogelbeobachtung #Natur'
    + '\n\nErstellt mit WaldOhr 🌿 – ' + appUrl;
  if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ title, text, files: [file] });
  } else if (navigator.share) {
    await navigator.share({ title, text, url: appUrl });
  } else if (blob) {
    _dlBlob(blob, fname);   // wie beim eBird/Ornitho-Export: revoked die object URL nach Klick statt sie zu leaken
  }
}
