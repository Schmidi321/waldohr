// Open-Meteo (kostenlos, kein API-Key): aktuelles Wetter + Morgen-Prognose.
const TTL = 10 * 60 * 1000;
let _cache = null;
let _tmwCache = null; // { lat, lng, ts, slots }

const WMO_EMOJI = {
  0:'☀️',1:'🌤️',2:'⛅',3:'☁️',
  45:'🌫️',48:'🌫️',
  51:'🌦️',53:'🌦️',55:'🌧️',56:'🌧️',57:'🌧️',
  61:'🌦️',63:'🌧️',65:'🌧️',66:'🌧️',67:'🌧️',
  71:'🌨️',73:'❄️',75:'❄️',77:'🌨️',
  80:'🌦️',81:'🌧️',82:'⛈️',
  85:'🌨️',86:'❄️',95:'⛈️',96:'⛈️',99:'⛈️',
};
const WMO_TEXT = {
  0:'Klarer Himmel',1:'Überwiegend klar',2:'Teilbewölkt',3:'Bedeckt',
  45:'Nebel',48:'Eisnebel',
  51:'Leichter Nieselregen',53:'Nieselregen',55:'Starker Nieselregen',
  61:'Leichter Regen',63:'Regen',65:'Starker Regen',
  71:'Leichter Schneefall',73:'Schneefall',75:'Starker Schneefall',
  80:'Regenschauer',81:'Kräftige Schauer',82:'Heftige Schauer',
  95:'Gewitter',96:'Gewitter mit Hagel',99:'Starkes Gewitter',
};

export function weatherEmoji(wmo) { return WMO_EMOJI[wmo] ?? '🌡️'; }
export function weatherLabel(wmo) { return WMO_TEXT[wmo] ?? ''; }

export async function fetchWeather(lat, lng) {
  if (lat == null || lng == null) return null;
  const now = Date.now();
  if (_cache && now - _cache.ts < TTL
      && Math.abs(_cache.lat - lat) < 0.05 && Math.abs(_cache.lng - lng) < 0.05) {
    return _cache.data;
  }
  try {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lat.toFixed(4) + '&longitude=' + lng.toFixed(4)
      + '&current=temperature_2m,weathercode&timezone=auto';
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j = await res.json();
    const c = j.current;
    if (!c) return null;
    const data = { temp: Math.round(c.temperature_2m), wmo: c.weathercode };
    _cache = { lat, lng, ts: now, data };
    return data;
  } catch { return null; }
}

// Erweitertes Foto-Wetter: Wind, Feuchte, UV, Sicht, Bewölkung.
let _pwCache = null;
export async function fetchPhotoWeather(lat, lng) {
  if (lat == null || lng == null) return null;
  const now = Date.now();
  if (_pwCache && now - _pwCache.ts < TTL
      && Math.abs(_pwCache.lat - lat) < 0.05 && Math.abs(_pwCache.lng - lng) < 0.05) {
    return _pwCache.data;
  }
  try {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lat.toFixed(4) + '&longitude=' + lng.toFixed(4)
      + '&current=temperature_2m,weathercode,wind_speed_10m,wind_direction_10m,'
      + 'relative_humidity_2m,visibility,cloudcover,uv_index'
      + '&timezone=auto';
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    const c = j.current;
    if (!c) return null;
    const data = {
      temp: Math.round(c.temperature_2m),
      wmo: c.weathercode,
      windKmh: Math.round(c.wind_speed_10m ?? 0),
      windDir: Math.round(c.wind_direction_10m ?? 0),
      humidity: Math.round(c.relative_humidity_2m ?? 0),
      visKm: Math.round((c.visibility ?? 10000) / 1000),
      cloudcover: Math.round(c.cloudcover ?? 0),
      uvIndex: Math.round(c.uv_index ?? 0),
    };
    _pwCache = { lat, lng, ts: now, data };
    return data;
  } catch { return null; }
}

export function windDirLabel(deg) {
  const dirs = ['N','NO','O','SO','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

export function moonPhase() {
  const ref = new Date(2000, 0, 6).getTime();
  const cycle = 29.530588853;
  const phase = ((Date.now() - ref) / 86400000 % cycle + cycle) % cycle;
  return phase / cycle;
}

export function moonPhaseLabel(p) {
  if (p < 0.03 || p > 0.97) return 'Neumond 🌑';
  if (p < 0.22) return 'Zunehmende Sichel 🌒';
  if (p < 0.28) return 'Erstes Viertel 🌓';
  if (p < 0.47) return 'Zunehmend 🌔';
  if (p < 0.53) return 'Vollmond 🌕';
  if (p < 0.72) return 'Abnehmend 🌖';
  if (p < 0.78) return 'Letztes Viertel 🌗';
  return 'Abnehmende Sichel 🌘';
}

// Mond-Kalender: Alter, nächster Vollmond/Neumond.
export function moonCalendar() {
  const now = Date.now();
  const REF = new Date(2000, 0, 6, 18, 14, 0).getTime();
  const CYCLE = 29.530588853 * 86400000;
  const elapsed = ((now - REF) % CYCLE + CYCLE) % CYCLE;
  const p = elapsed / CYCLE; // 0=Neu, 0.5=Voll
  const ageD = elapsed / 86400000;
  const daysToFull = p < 0.5 ? (0.5 - p) * 29.530588853 : (1.5 - p) * 29.530588853;
  const daysToNew  = (1 - p) * 29.530588853;
  return {
    phase: p,
    ageInDays: Math.round(ageD * 10) / 10,
    daysToFull: Math.ceil(daysToFull),
    nextFull: new Date(now + daysToFull * 86400000),
    daysToNew: Math.ceil(daysToNew),
    nextNew: new Date(now + daysToNew * 86400000),
  };
}

// Reverse-Geocoding (Nominatim, kostenlos).
let _geoNameCache = null;
export async function reverseGeocode(lat, lng) {
  if (lat == null || lng == null) return null;
  if (_geoNameCache && Math.abs(_geoNameCache.lat - lat) < 0.02 && Math.abs(_geoNameCache.lng - lng) < 0.02)
    return _geoNameCache.name;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}&format=json&zoom=12`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'de' }, signal: AbortSignal.timeout(6000) });
    const j = await res.json();
    const a = j.address || {};
    const name = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county || '';
    _geoNameCache = { lat, lng, name };
    return name || null;
  } catch { return null; }
}

export function uvLabel(idx) {
  if (idx <= 2) return 'niedrig';
  if (idx <= 5) return 'moderat';
  if (idx <= 7) return 'hoch';
  if (idx <= 10) return 'sehr hoch';
  return 'extrem';
}

// Mondaufgang/-untergang für heute via Open-Meteo daily.
let _moonTimesCache = null;
export async function fetchMoonTimes(lat, lng) {
  if (lat == null || lng == null) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (_moonTimesCache?.dateStr === today
      && Math.abs(_moonTimesCache.lat - lat) < 0.05 && Math.abs(_moonTimesCache.lng - lng) < 0.05)
    return _moonTimesCache.data;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lat.toFixed(4) + '&longitude=' + lng.toFixed(4)
      + '&daily=moonrise,moonset&timezone=auto&forecast_days=1';
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j = await res.json();
    const mr = j.daily?.moonrise?.[0];
    const ms = j.daily?.moonset?.[0];
    const data = { moonrise: mr ? new Date(mr) : null, moonset: ms ? new Date(ms) : null };
    _moonTimesCache = { dateStr: today, lat, lng, data };
    return data;
  } catch { return null; }
}

// Stündliche Slots für die aktuelle + nächste Stunden (Jetzt-Vorschau).
let _todayCache = null;
export async function fetchTodayHours(lat, lng) {
  if (lat == null || lng == null) return null;
  const now = Date.now();
  if (_todayCache && now - _todayCache.ts < TTL
      && Math.abs(_todayCache.lat - lat) < 0.05 && Math.abs(_todayCache.lng - lng) < 0.05)
    return _todayCache.slots;
  try {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lat.toFixed(4) + '&longitude=' + lng.toFixed(4)
      + '&hourly=temperature_2m,precipitation_probability,cloudcover,weathercode,visibility'
      + '&timezone=auto&forecast_days=1';
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    const times = j.hourly.time;
    const today = new Date().toISOString().slice(0, 10);
    const nowH = new Date().getHours();
    const slots = [nowH, nowH + 1, nowH + 2, nowH + 3, nowH + 4, nowH + 5].filter(h => h < 24).map(h => {
      const t = today + 'T' + String(h).padStart(2, '0') + ':00';
      const i = times.indexOf(t);
      if (i < 0) return null;
      return {
        hour: h,
        temp: Math.round(j.hourly.temperature_2m[i]),
        precipProb: Math.round(j.hourly.precipitation_probability[i] ?? 0),
        cloudcover: Math.round(j.hourly.cloudcover[i] ?? 0),
        wmo: j.hourly.weathercode[i] ?? 0,
        visKm: Math.round((j.hourly.visibility[i] ?? 10000) / 1000),
      };
    }).filter(Boolean);
    _todayCache = { lat, lng, ts: now, slots };
    return slots;
  } catch { return null; }
}

// Stündliche Prognose für morgen früh (6–9 Uhr): Wolken, Regen, Temperatur, Sicht, Nebel.
export async function fetchTomorrowMorning(lat, lng) {
  if (lat == null || lng == null) return null;
  const now = Date.now();
  if (_tmwCache && now - _tmwCache.ts < TTL
      && Math.abs(_tmwCache.lat - lat) < 0.05 && Math.abs(_tmwCache.lng - lng) < 0.05) {
    return _tmwCache.slots;
  }
  try {
    const url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lat.toFixed(4) + '&longitude=' + lng.toFixed(4)
      + '&hourly=temperature_2m,precipitation_probability,cloudcover,weathercode,visibility'
      + '&timezone=auto&forecast_days=2';
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = await res.json();
    const times = j.hourly.time;
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const slots = [5, 6, 7, 8, 9, 10].map(h => {
      const t = tomorrow + 'T' + String(h).padStart(2, '0') + ':00';
      const i = times.indexOf(t);
      if (i < 0) return null;
      return {
        hour: h,
        temp: Math.round(j.hourly.temperature_2m[i]),
        precipProb: Math.round(j.hourly.precipitation_probability[i] ?? 0),
        cloudcover: Math.round(j.hourly.cloudcover[i] ?? 0),
        wmo: j.hourly.weathercode[i] ?? 0,
        visKm: Math.round((j.hourly.visibility[i] ?? 10000) / 1000),
      };
    }).filter(Boolean);
    _tmwCache = { lat, lng, ts: now, slots };
    return slots;
  } catch { return null; }
}
