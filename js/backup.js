// Sicherung & Wiederherstellung: WaldOhr hat keinen eigenen Server, alles liegt nur lokal in
// IndexedDB auf diesem Gerät. Dieser Export packt Funde + eigene Aufnahmen/Fotos/Videos in eine
// einzelne JSON-Datei, die der Nutzer selbst irgendwo sichern kann (Cloud-Ordner, E-Mail an sich
// selbst usw.) und später über importBackup() wiederherstellen kann.
import { allDetections, allAttachments, addDetection, addAttachment } from './db.js';

const BACKUP_VERSION = 1;

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

export async function importBackup(file, onProgress) {
  const text = await file.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('Ungültige Backup-Datei (kein JSON)'); }
  if (!payload || payload.app !== 'WaldOhr' || !Array.isArray(payload.detections)) {
    throw new Error('Keine gültige WaldOhr-Sicherung');
  }
  // Alte Fund-IDs -> neue IDs merken, damit importierte Anhänge wieder korrekt mit ihrem Fund
  // verknüpft sind (IndexedDB vergibt beim Einfügen neue autoIncrement-IDs).
  const idMap = new Map();
  for (const d of payload.detections) {
    const { id: oldId, ...rest } = d;
    const newId = await addDetection(rest);
    if (oldId != null) idMap.set(oldId, newId);
  }
  const atts = payload.attachments || [];
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i];
    const blob = base64ToBlob(a.dataBase64, a.mime);
    const detId = a.detId != null && idMap.has(a.detId) ? idMap.get(a.detId) : null;
    await addAttachment({ detId, key: a.key, label: a.label, kind: a.kind, blob, mime: a.mime, note: a.note, ts: a.ts });
    if (onProgress) onProgress(i + 1, atts.length);
  }
  return { detCount: payload.detections.length, attCount: atts.length };
}
