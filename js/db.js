// On-device-Speicher (IndexedDB) für Funde + Statistik-Berechnung.
import { SPECIES } from './species.js';

const DB_NAME = 'waldohr', DB_VER = 1, STORE = 'detections';
let _db = null;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('species', 'key', { unique: false });
        s.createIndex('ts', 'ts', { unique: false });
      }
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function db() { return _db || (await open()); }

export async function addDetection(d) {
  const database = await db();
  return new Promise((res, rej) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add({ ts: Date.now(), ...d });
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function allDetections() {
  const database = await db();
  return new Promise((res, rej) => {
    const tx = database.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

export async function clearAll() {
  const database = await db();
  return new Promise((res, rej) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ---- Demo-Daten beim allerersten Start, damit Sammlung & Statistik leben ----
export async function seedIfEmpty() {
  const existing = await allDetections();
  if (existing.length > 0) return;

  const counts = { buchfink:34, kohlmeise:22, amsel:18, rotkehlchen:12, zaunkoenig:7, buntspecht:5, reh:2, eisvogel:1 };
  // Tagesaktivität (Morgenchor-Spitze) als Gewichtung für die Uhrzeit
  const act = [.05,.04,.04,.05,.2,.55,.95,.85,.65,.5,.42,.38,.35,.36,.4,.45,.5,.55,.7,.82,.7,.45,.2,.1];
  const cum = []; let s = 0; for (const v of act) { s += v; cum.push(s); }
  const pickHour = () => { const r = Math.random() * s; return cum.findIndex(c => c >= r); };
  const dirs = ['N','NO','O','SO','S','SW','W','NW'];
  const base = DEMO_BASE; // Demo-Standort (Nationalpark Eifel)

  for (const key in counts) {
    const sp = SPECIES[key]; if (!sp) continue;
    for (let i = 0; i < counts[key]; i++) {
      const d = new Date();
      d.setDate(d.getDate() - Math.floor(Math.random() * 14));
      d.setHours(pickHour(), Math.floor(Math.random() * 60), 0, 0);
      await addDetection({
        key, species: sp.name, sci: sp.sci, rarity: sp.rarity,
        confidence: +(0.78 + Math.random() * 0.2).toFixed(2),
        dir: dirs[(Math.random() * 8) | 0], distance: 10 + ((Math.random() * 70) | 0),
        lat: base.lat + (Math.random() - 0.5) * 0.006,
        lng: base.lng + (Math.random() - 0.5) * 0.006,
        ts: d.getTime(), source: 'seed'
      });
    }
  }
}

// Vorhandene Funde ohne Koordinaten (aus früherem Seed) nachträglich verorten,
// damit die Karte sofort gefüllt ist. Echte Funde bekommen später echtes GPS.
const DEMO_BASE = { lat: 50.60, lng: 6.40 };
export async function migrateGeo() {
  const dets = await allDetections();
  const missing = dets.filter(d => typeof d.lat !== 'number' || typeof d.lng !== 'number');
  if (!missing.length) return;
  const database = await db();
  await new Promise((res, rej) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const d of missing) {
      d.lat = DEMO_BASE.lat + (Math.random() - 0.5) * 0.006;
      d.lng = DEMO_BASE.lng + (Math.random() - 0.5) * 0.006;
      store.put(d);
    }
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ---- Aggregation für die Diagramme ----
const dayKey = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

function startOfWeek() {
  const n = new Date(); const day = (n.getDay() + 6) % 7; // 0 = Montag
  n.setHours(0, 0, 0, 0); n.setDate(n.getDate() - day); return n;
}

export function computeStats(dets) {
  const map = {}, hourly = new Array(24).fill(0), perDay = {};
  const weekStart = startOfWeek().getTime();
  let newThisWeek = 0;

  for (const d of dets) {
    const t = new Date(d.ts);
    const k = d.key || d.species;
    if (!map[k]) map[k] = { key: k, name: d.species, sci: d.sci, rarity: d.rarity, count: 0, last: 0 };
    map[k].count++; if (d.ts > map[k].last) map[k].last = d.ts;
    hourly[t.getHours()]++;
    perDay[dayKey(t)] = (perDay[dayKey(t)] || 0) + 1;
    if (d.ts >= weekStart) newThisWeek++;
  }

  const perSpecies = Object.values(map).sort((a, b) => b.count - a.count);
  const labels = ['Mo','Di','Mi','Do','Fr','Sa','So'];
  const ws = startOfWeek();
  const week = labels.map((label, i) => {
    const d = new Date(ws); d.setDate(ws.getDate() + i);
    return { label, count: perDay[dayKey(d)] || 0 };
  });

  // Serie: aufeinanderfolgende Tage mit mindestens einem Fund (heute oder gestern als Start)
  const present = new Set(Object.keys(perDay));
  let streak = 0; const cur = new Date(); cur.setHours(0, 0, 0, 0);
  if (!present.has(dayKey(cur))) cur.setDate(cur.getDate() - 1);
  while (present.has(dayKey(cur))) { streak++; cur.setDate(cur.getDate() - 1); }

  return {
    total: dets.length,
    speciesCount: perSpecies.length,
    rareCount: perSpecies.filter(x => x.rarity !== 'common').length,
    newThisWeek, streak, perSpecies, week, hourly
  };
}

// ---- Standort-Aggregation: "Heute hier" + "Global nach Ort" ----
function isToday(ts) {
  const d = new Date(ts), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Rohe Treffer für "Heute hier" (inkl. id, fürs Löschen).
export function todayNearbyDetections(dets, pos, radiusKm = 3) {
  const today = dets.filter(d => isToday(d.ts));
  return pos
    ? today.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number' && haversineKm(pos, d) <= radiusKm)
    : today;
}

// Heutige Funde in der Nähe der aktuellen Position (für "neu hier angekommen").
export function todayNearby(dets, pos, radiusKm = 3) {
  const near = todayNearbyDetections(dets, pos, radiusKm);
  const map = {};
  for (const d of near) {
    const k = d.key || d.species;
    if (!map[k]) map[k] = { key: k, name: d.species, sci: d.sci, rarity: d.rarity, count: 0, last: 0 };
    map[k].count++; if (d.ts > map[k].last) map[k].last = d.ts;
  }
  return Object.values(map).sort((a, b) => b.last - a.last);
}

// Löscht einzelne Funde anhand ihrer ID (z. B. zum Zurücksetzen von "Heute hier").
export async function deleteByIds(ids) {
  if (!ids.length) return;
  const database = await db();
  return new Promise((res, rej) => {
    const tx = database.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// Alle Funde nach Fundort gruppiert (greedy Clustering, ~600m Radius).
export function groupByLocation(dets) {
  const geo = dets.filter(d => typeof d.lat === 'number' && typeof d.lng === 'number');
  const clusters = [];
  for (const d of geo) {
    let c = clusters.find(c => haversineKm(c, d) <= 0.6);
    if (!c) { c = { lat: d.lat, lng: d.lng, n: 0, dets: [] }; clusters.push(c); }
    c.lat = (c.lat * c.n + d.lat) / (c.n + 1);
    c.lng = (c.lng * c.n + d.lng) / (c.n + 1);
    c.n++; c.dets.push(d);
  }
  return clusters.map(c => {
    const map = {};
    let last = 0;
    for (const d of c.dets) {
      const k = d.key || d.species;
      if (!map[k]) map[k] = { key: k, name: d.species, sci: d.sci, rarity: d.rarity, count: 0 };
      map[k].count++; if (d.ts > last) last = d.ts;
    }
    const perSpecies = Object.values(map).sort((a, b) => b.count - a.count);
    return { lat: c.lat, lng: c.lng, total: c.dets.length, speciesCount: perSpecies.length, perSpecies, last };
  }).sort((a, b) => b.last - a.last);
}
