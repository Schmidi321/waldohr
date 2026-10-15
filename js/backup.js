// Sicherung & Wiederherstellung: WaldOhr hat keinen eigenen Server, alles liegt nur lokal in
// IndexedDB auf diesem Gerät. Dieser Export packt Funde + eigene Aufnahmen/Fotos/Videos in eine
// einzelne JSON-Datei, die der Nutzer selbst irgendwo sichern kann (Cloud-Ordner, E-Mail an sich
// selbst usw.) und später über importBackup() wiederherstellen kann.
import { allDetections, allAttachments, importRecords } from './db.js';

const BACKUP_VERSION = 1;

// ---- Import-Validierung ----
// Eine Sicherungsdatei ist FREMDE Eingabe: der Nutzer kann eine manipulierte Datei zugeschickt
// bekommen ("hier meine Funde vom Wochenende"). Die Felder landen später an vielen Stellen per
// innerHTML in der Seite, und der Anhang-MIME-Typ geht direkt in new Blob({type}) — ein
// text/html-Blob hinter einem Download-/Öffnen-Link liefe als Seite auf UNSEREM Origin (Zugriff
// auf IndexedDB, Gemini-Key usw.). Darum: nur bekannte Felder mit geprüftem Typ übernehmen,
// alles andere verwerfen, und VOR dem ersten Schreibzugriff komplett prüfen.
const MAX_FILE_BYTES = 500 * 1024 * 1024;   // größere Dateien gar nicht erst einlesen (Speicher!)
const MAX_DETECTIONS = 100000;
const MAX_ATTACHMENTS = 10000;
const MAX_NAME = 120;                        // species / sci / label
const MAX_NOTE = 2000;
const KEY_RE = /^[a-z0-9_]{1,80}$/;
// Passen auf KEY_RE, wären als Objekt-Schlüssel aber Prototype-Pollution-Vektoren.
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RARITIES = new Set(['common', 'rare', 'mammal']);
const DIRS = new Set(['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW']);
const SOURCE_RE = /^[a-z0-9_-]{1,32}$/;
// Pro Anhang-Art nur Medien-Typen, die der Browser NIE als Dokument/Script ausführt.
// heic/heif: iOS-Fotos aus dem nativen Datei-Input (app.js nimmt file.type ungefiltert).
const MIME_ALLOW = {
  audio: /^audio\/(wav|webm|mp4|mpeg|ogg)$/,
  photo: /^image\/(jpeg|png|webp|heic|heif)$/,
  video: /^video\/(mp4|webm)$/,
};
// Fehlender MIME-Typ (MediaRecorder liefert manchmal raw.type === '') -> sicherer Standard je Art.
const MIME_DEFAULT = { audio: 'audio/webm', photo: 'image/jpeg', video: 'video/webm' };
// Zeitstempel zwischen 2000 und 2100 — schützt Datumsrechnungen/Gruppierungen vor Unsinn.
const TS_MIN = 946684800000, TS_MAX = 4102444800000;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
// Artnamen enthalten nie spitze Klammern oder Steuerzeichen — solche Werte sind manipuliert.
// Abgelehnt statt nur escaped (Defense in Depth, falls irgendwo ein Sink das esc() vergisst).
const isName = (v, max = MAX_NAME) => typeof v === 'string' && v.length <= max && !/[<>\u0000-\u001f\u007f]/.test(v);
const isKey = v => typeof v === 'string' && KEY_RE.test(v) && !RESERVED_KEYS.has(v);
const isTs = v => isNum(v) && v >= TS_MIN && v <= TS_MAX;
const isOldId = v => Number.isSafeInteger(v) && v >= 0;

// Liefert einen frisch aufgebauten, sauberen Fund-Datensatz oder null (= Fund verwerfen).
// Pflichtfelder bzw. sicherheitsrelevante Felder ungültig -> ganzer Fund weg; rein
// beschreibende Zusatzfelder (heading, weather, dir, distance, source) ungültig -> nur das Feld weg.
function sanitizeDetection(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (!isKey(d.key) || !isTs(d.ts) || !isName(d.species) || !d.species) return null;
  const rec = { key: d.key, species: d.species, ts: d.ts };
  if (d.sci != null) { if (!isName(d.sci)) return null; rec.sci = d.sci; }
  // Fehlende/ungültige Seltenheit -> 'common' statt verwerfen (steuert nur Farbe/Badge).
  rec.rarity = RARITIES.has(d.rarity) ? d.rarity : 'common';
  if (d.confidence != null) {
    if (!isNum(d.confidence) || d.confidence < 0 || d.confidence > 1) return null;
    rec.confidence = d.confidence;
  }
  if (d.lat != null || d.lng != null) {
    if (!isNum(d.lat) || !isNum(d.lng) || Math.abs(d.lat) > 90 || Math.abs(d.lng) > 180) return null;
    rec.lat = d.lat; rec.lng = d.lng;
  }
  if (typeof d.source === 'string' && SOURCE_RE.test(d.source)) rec.source = d.source;
  if (isNum(d.heading) && d.heading >= 0 && d.heading <= 360) rec.heading = d.heading;
  if (DIRS.has(d.dir)) rec.dir = d.dir;
  if (isNum(d.distance) && d.distance >= 0 && d.distance <= 100000) rec.distance = d.distance;
  // weather = { temp, wmo } aus weather.js fetchWeather() — Objekt neu aufbauen, nie durchreichen.
  const w = d.weather;
  if (w && typeof w === 'object' && isNum(w.temp) && Math.abs(w.temp) <= 80
      && Number.isInteger(w.wmo) && w.wmo >= 0 && w.wmo <= 99) {
    rec.weather = { temp: w.temp, wmo: w.wmo };
  }
  return rec;
}

// MIME-Typ auf Basis-Typ (+ optional harmlosen codecs-Parameter) reduzieren und gegen die
// Allowlist der jeweiligen Anhang-Art prüfen. null = nicht erlaubt.
function sanitizeMime(kind, mime) {
  if (mime == null || mime === '') return MIME_DEFAULT[kind];
  if (typeof mime !== 'string' || mime.length > 100) return null;
  const m = /^([a-z]+\/[a-z0-9.+-]+)\s*(?:;\s*codecs\s*=\s*("?)([a-z0-9.,\s-]+)\2\s*)?$/i.exec(mime.trim());
  if (!m) return null;
  const base = m[1].toLowerCase();
  if (!MIME_ALLOW[kind].test(base)) return null;
  return m[3] ? `${base};codecs=${m[3].replace(/\s+/g, '').toLowerCase()}` : base;
}

// Anhang prüfen + Base64 dekodieren. Liefert { oldDetId, rec } oder null.
function sanitizeAttachment(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  if (!Object.prototype.hasOwnProperty.call(MIME_ALLOW, a.kind)) return null;
  const mime = sanitizeMime(a.kind, a.mime);
  if (!mime || !isTs(a.ts) || typeof a.dataBase64 !== 'string' || !a.dataBase64) return null;
  if (a.key != null && !isKey(a.key)) return null;
  if (a.label != null && !isName(a.label)) return null;
  // Notiz darf Zeilenumbrüche/Tabs enthalten, sonst gleiche Regeln wie Namen.
  if (a.note != null && !(typeof a.note === 'string' && a.note.length <= MAX_NOTE && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(a.note))) return null;
  if (a.detId != null && !isOldId(a.detId)) return null;
  const blob = base64ToBlob(a.dataBase64, mime); // wirft bei kaputtem Base64 -> Aufrufer zählt als übersprungen
  return {
    oldDetId: a.detId ?? null,
    rec: { key: a.key ?? null, label: a.label ?? null, kind: a.kind, blob, mime, note: a.note ?? null, ts: a.ts },
  };
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onloadend = () => res(String(reader.result).split(',')[1] || '');
    reader.onerror = () => rej(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

export async function exportBackup(onProgress) {
  const detections = await allDetections();
  const rawAttachments = await allAttachments();
  const attachments = [];
  for (let i = 0; i < rawAttachments.length; i++) {
    const a = rawAttachments[i];
    const dataBase64 = await blobToBase64(a.blob);
    attachments.push({ detId: a.detId, key: a.key, label: a.label, kind: a.kind, mime: a.mime, note: a.note, ts: a.ts, dataBase64 });
    if (onProgress) onProgress(i + 1, rawAttachments.length);
  }
  const payload = { app: 'WaldOhr', version: BACKUP_VERSION, exportedAt: new Date().toISOString(), detections, attachments };
  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/json' });
  const stamp = new Date().toISOString().slice(0, 10);
  const fname = `waldohr-backup-${stamp}.json`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  return { detCount: detections.length, attCount: attachments.length, sizeBytes: blob.size, filename: fname };
}

// Rückgabe: { detCount, attCount } = tatsächlich NEU geschriebene Funde/Anhänge (das zeigt
// app.js an), dazu detSkipped/attSkipped (ungültig verworfen) und detDuplicates/attDuplicates
// (schon vorhanden, z.B. dieselbe Sicherung zweimal eingespielt).
export async function importBackup(file, onProgress) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('Datei zu groß (über 500 MB) — keine gültige WaldOhr-Sicherung oder zu viele Anhänge.');
  }
  const text = await file.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('Ungültige Backup-Datei (kein JSON)'); }
  if (!payload || typeof payload !== 'object' || payload.app !== 'WaldOhr' || !Array.isArray(payload.detections)) {
    throw new Error('Keine gültige WaldOhr-Sicherung');
  }
  if (isNum(payload.version) && payload.version > BACKUP_VERSION) {
    throw new Error('Sicherung stammt aus einer neueren WaldOhr-Version — bitte App aktualisieren.');
  }
  const rawAtts = payload.attachments == null ? [] : payload.attachments;
  if (!Array.isArray(rawAtts)) throw new Error('Keine gültige WaldOhr-Sicherung (Anhänge beschädigt)');
  if (payload.detections.length > MAX_DETECTIONS) {
    throw new Error(`Zu viele Funde in der Sicherung (max. ${MAX_DETECTIONS.toLocaleString('de-DE')}).`);
  }
  if (rawAtts.length > MAX_ATTACHMENTS) {
    throw new Error(`Zu viele Anhänge in der Sicherung (max. ${MAX_ATTACHMENTS.toLocaleString('de-DE')}).`);
  }

  // 1) ALLES prüfen, bevor irgendetwas geschrieben wird. Die alte Fund-ID bleibt nur als
  //    Zuordnungshilfe für die Anhänge erhalten (IndexedDB vergibt beim Einfügen neue IDs).
  const dets = [];
  let detSkipped = 0;
  for (const d of payload.detections) {
    const rec = sanitizeDetection(d);
    if (!rec) { detSkipped++; continue; }
    dets.push({ oldId: isOldId(d.id) ? d.id : null, rec });
  }
  // Ein einzelner kaputter Anhang (abgeschnittenes/verändertes Base64, falscher Typ) wird
  // übersprungen und gezählt statt den ganzen Import abzubrechen.
  const atts = [];
  let attSkipped = 0;
  for (let i = 0; i < rawAtts.length; i++) {
    let a = null;
    try { a = sanitizeAttachment(rawAtts[i]); } catch (e) { console.warn('Anhang übersprungen (defekt):', e); }
    if (a) atts.push(a); else attSkipped++;
    rawAtts[i] = null; // Base64-String freigeben, sonst liegt die Datei doppelt im Speicher
    if (onProgress) onProgress(i + 1, rawAtts.length);
  }
  if (!dets.length && !atts.length && (payload.detections.length || rawAtts.length)) {
    throw new Error('Sicherung enthält keine gültigen Funde oder Anhänge.');
  }

  // 2) In EINER Transaktion schreiben (alles oder nichts), Duplikate gegen den Bestand filtern.
  const r = await importRecords(dets, atts);
  return {
    detCount: r.detAdded, attCount: r.attAdded,
    detSkipped, attSkipped, detDuplicates: r.detDuplicates, attDuplicates: r.attDuplicates,
  };
}
