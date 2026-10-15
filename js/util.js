// Kleine gemeinsame Helfer, die mehrere Module brauchen.

// Für JEDEN Text, der per innerHTML / Template-String in die Seite kommt und nicht hart im Code
// steht: Artnamen (vom BirdNET-Server oder aus einem importierten Backup), Labels, Sitzungsnamen,
// Geräte-Bezeichnungen. Escaped auch Anführungszeichen, damit Werte in Attributen (data-key="…")
// nicht ausbrechen können.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// CSV-Zelle für Exporte (eBird, ornitho, Notizbuch): in Anführungszeichen, und Werte, die mit
// = + - @ (oder Tab/CR) beginnen, mit ' entschärfen — sonst führt Excel sie als Formel aus.
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// Koordinaten vergröbern, bevor sie an Dritte gehen oder in geteilten Dateien landen.
// 2 Nachkommastellen ≈ 1 km, 1 ≈ 11 km.
export function roundCoord(v, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(Number(v) * f) / f;
}
