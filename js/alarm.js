// Morgenchor + Nacht-Modus + Fotografen-Wecker: automatisches Lauschen & Wecken.
const LS_MC = 'waldohr.morgenchor';
const LS_NM = 'waldohr.nacht';
const LS_FW = 'waldohr.fotowecker';

export function getMorgenchor() {
  try { return JSON.parse(localStorage.getItem(LS_MC)) || { enabled: false, offsetMin: 15 }; }
  catch { return { enabled: false, offsetMin: 15 }; }
}
export function setMorgenchor(cfg) {
  try { localStorage.setItem(LS_MC, JSON.stringify(cfg)); } catch {}
}

export function getNachtModus() {
  try { return JSON.parse(localStorage.getItem(LS_NM)) || { enabled: false, hour: 22, minute: 0, endEnabled: false, endHour: 23, endMinute: 30 }; }
  catch { return { enabled: false, hour: 22, minute: 0, endEnabled: false, endHour: 23, endMinute: 30 }; }
}
export function setNachtModus(cfg) {
  try { localStorage.setItem(LS_NM, JSON.stringify(cfg)); } catch {}
}

// vibrateOnly: kein Ton, nur Vibration
export function getFotoWecker() {
  try { return JSON.parse(localStorage.getItem(LS_FW)) || { enabled: false, hour: 5, minute: 30, vibrateOnly: false }; }
  catch { return { enabled: false, hour: 5, minute: 30, vibrateOnly: false }; }
}
export function setFotoWecker(cfg) {
  try { localStorage.setItem(LS_FW, JSON.stringify(cfg)); } catch {}
}

let _sunriseCache = null; // { dateStr, sunrise, full }

export async function getSunrise(lat, lng) {
  const data = await getSunriseFull(lat, lng);
  return data ? data.sunrise : null;
}

export async function getSunriseFull(lat, lng) {
  const dateStr = new Date().toISOString().slice(0, 10);
  if (_sunriseCache?.dateStr === dateStr && _sunriseCache.full) return _sunriseCache.full;
  try {
    const r = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&date=${dateStr}&formatted=0`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== 'OK') return null;
    const res = j.results;
    const full = {
      sunrise: new Date(res.sunrise),
      civilBegin: new Date(res.civil_twilight_begin),
      nauticalBegin: new Date(res.nautical_twilight_begin),
      astronomicalBegin: new Date(res.astronomical_twilight_begin),
      sunset: new Date(res.sunset),
      civilEnd: new Date(res.civil_twilight_end),
      nauticalEnd: new Date(res.nautical_twilight_end),
    };
    _sunriseCache = { dateStr, sunrise: full.sunrise, full };
    return full;
  } catch { return null; }
}

const _fired = {};

export async function checkAlarms(lat, lng, onFire) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const mc = getMorgenchor();
  if (mc.enabled && _fired.morgenchor !== todayStr && lat != null && lng != null) {
    const full = await getSunriseFull(lat, lng);
    if (full) {
      const target = new Date(full.sunrise.getTime() - mc.offsetMin * 60000);
      const tMin = target.getHours() * 60 + target.getMinutes();
      if (Math.abs(nowMin - tMin) <= 1) { _fired.morgenchor = todayStr; onFire('morgenchor'); }
    }
  }

  const nm = getNachtModus();
  if (nm.enabled && _fired.nacht !== todayStr) {
    if (Math.abs(nowMin - (nm.hour * 60 + nm.minute)) <= 1) { _fired.nacht = todayStr; onFire('nacht'); }
  }
  if (nm.enabled && nm.endEnabled && _fired['nacht-end'] !== todayStr) {
    if (Math.abs(nowMin - (nm.endHour * 60 + nm.endMinute)) <= 1) { _fired['nacht-end'] = todayStr; onFire('nacht-end'); }
  }

  const fw = getFotoWecker();
  if (fw.enabled && _fired.fotowecker !== todayStr) {
    if (Math.abs(nowMin - (fw.hour * 60 + fw.minute)) <= 1) { _fired.fotowecker = todayStr; onFire('fotowecker'); }
  }
}

const LS_DU = 'waldohr.dauerub';
export function getDauerUeberwachung() {
  try { return JSON.parse(localStorage.getItem(LS_DU)) || { enabled: false, durationMin: 30 }; }
  catch { return { enabled: false, durationMin: 30 }; }
}
export function setDauerUeberwachung(cfg) {
  try { localStorage.setItem(LS_DU, JSON.stringify(cfg)); } catch {}
}
