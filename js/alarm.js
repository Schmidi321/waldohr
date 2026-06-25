// Morgenchor-Alarm + Nacht-Modus + Fotografen-Wecker: automatisches Lauschen & Wecken.
const LS_MC = 'waldohr.morgenchor';
const LS_NM = 'waldohr.nacht';
const LS_FW = 'waldohr.fotowecker';

// --- Morgenchor (Alarm vor Sonnenaufgang) ---
export function getMorgenchor() {
  try { return JSON.parse(localStorage.getItem(LS_MC)) || { enabled: false, offsetMin: 15 }; }
  catch { return { enabled: false, offsetMin: 15 }; }
}
export function setMorgenchor(cfg) {
  try { localStorage.setItem(LS_MC, JSON.stringify(cfg)); } catch {}
}

// --- Nacht-Modus (fester Start + optionales Ende) ---
export function getNachtModus() {
  try { return JSON.parse(localStorage.getItem(LS_NM)) || { enabled: false, hour: 22, minute: 0, endEnabled: false, endHour: 23, endMinute: 30 }; }
  catch { return { enabled: false, hour: 22, minute: 0, endEnabled: false, endHour: 23, endMinute: 30 }; }
}
export function setNachtModus(cfg) {
  try { localStorage.setItem(LS_NM, JSON.stringify(cfg)); } catch {}
}

// --- Fotografen-Wecker (Weckzeit für Sonnenaufgang-Shooting) ---
export function getFotoWecker() {
  try { return JSON.parse(localStorage.getItem(LS_FW)) || { enabled: false, hour: 5, minute: 30 }; }
  catch { return { enabled: false, hour: 5, minute: 30 }; }
}
export function setFotoWecker(cfg) {
  try { localStorage.setItem(LS_FW, JSON.stringify(cfg)); } catch {}
}

let _sunriseCache = null; // { dateStr, sunrise: Date }

export async function getSunrise(lat, lng) {
  const dateStr = new Date().toISOString().slice(0, 10);
  if (_sunriseCache && _sunriseCache.dateStr === dateStr) return _sunriseCache.sunrise;
  try {
    const r = await fetch(
      `https://api.sunrise-sunset.org/json?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&date=${dateStr}&formatted=0`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== 'OK') return null;
    const sunrise = new Date(j.results.sunrise);
    _sunriseCache = { dateStr, sunrise };
    return sunrise;
  } catch { return null; }
}

const _fired = {}; // type => dateStr

export async function checkAlarms(lat, lng, onFire) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Morgenchor
  const mc = getMorgenchor();
  if (mc.enabled && _fired.morgenchor !== todayStr && lat != null && lng != null) {
    const sunrise = await getSunrise(lat, lng);
    if (sunrise) {
      const target = new Date(sunrise.getTime() - mc.offsetMin * 60000);
      const tMin = target.getHours() * 60 + target.getMinutes();
      if (Math.abs(nowMin - tMin) <= 1) { _fired.morgenchor = todayStr; onFire('morgenchor'); }
    }
  }

  // Nacht-Modus Start
  const nm = getNachtModus();
  if (nm.enabled && _fired.nacht !== todayStr) {
    const tMin = nm.hour * 60 + nm.minute;
    if (Math.abs(nowMin - tMin) <= 1) { _fired.nacht = todayStr; onFire('nacht'); }
  }

  // Nacht-Modus Ende
  if (nm.enabled && nm.endEnabled && _fired['nacht-end'] !== todayStr) {
    const tMin = nm.endHour * 60 + nm.endMinute;
    if (Math.abs(nowMin - tMin) <= 1) { _fired['nacht-end'] = todayStr; onFire('nacht-end'); }
  }

  // Fotografen-Wecker
  const fw = getFotoWecker();
  if (fw.enabled && _fired.fotowecker !== todayStr) {
    const tMin = fw.hour * 60 + fw.minute;
    if (Math.abs(nowMin - tMin) <= 1) { _fired.fotowecker = todayStr; onFire('fotowecker'); }
  }
}
