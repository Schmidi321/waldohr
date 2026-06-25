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
