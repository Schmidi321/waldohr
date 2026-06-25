// Morgenchor-Alarm + Nacht-Modus: automatisches Starten des Lauschens zu geplanten Zeiten.
const LS_MC = 'waldohr.morgenchor';
const LS_NM = 'waldohr.nacht';

// --- Morgenchor (Alarm vor Sonnenaufgang) ---
export function getMorgenchor() {
  try { return JSON.parse(localStorage.getItem(LS_MC)) || { enabled: false, offsetMin: 15 }; }
  catch { return { enabled: false, offsetMin: 15 }; }
}
export function setMorgenchor(cfg) {
  try { localStorage.setItem(LS_MC, JSON.stringify(cfg)); } catch {}
}

// --- Nacht-Modus (fester Startzeitpunkt) ---
export function getNachtModus() {
  try { return JSON.parse(localStorage.getItem(LS_NM)) || { enabled: false, hour: 22, minute: 0 }; }
  catch { return { enabled: false, hour: 22, minute: 0 }; }
}
export function setNachtModus(cfg) {
  try { localStorage.setItem(LS_NM, JSON.stringify(cfg)); } catch {}
}

let _sunriseCache = null; // { dateStr, sunrise: Date }

async function getSunrise(lat, lng) {
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

// Tracks which alarms already fired today so we don't repeat in the same minute-check.
const _fired = {}; // 'morgenchor' | 'nacht' => dateStr

export async function checkAlarms(lat, lng, onFire) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Morgenchor
  const mc = getMorgenchor();
  if (mc.enabled && _fired.morgenchor !== todayStr) {
    if (lat != null && lng != null) {
      const sunrise = await getSunrise(lat, lng);
      if (sunrise) {
        const target = new Date(sunrise.getTime() - mc.offsetMin * 60000);
        const tMin = target.getHours() * 60 + target.getMinutes();
        if (Math.abs(nowMin - tMin) <= 1) {
          _fired.morgenchor = todayStr;
          onFire('morgenchor');
        }
      }
    }
  }

  // Nacht-Modus
  const nm = getNachtModus();
  if (nm.enabled && _fired.nacht !== todayStr) {
    const tMin = nm.hour * 60 + nm.minute;
    if (Math.abs(nowMin - tMin) <= 1) {
      _fired.nacht = todayStr;
      onFire('nacht');
    }
  }
}
