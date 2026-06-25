// GPS-Routen-Recorder: zeichnet Track während einer Hörsession auf, berechnet Distanz, exportiert GPX.
import { haversineKm } from './db.js';

export const routeTracker = {
  points: [],  // [{lat, lng, ts}]
  distKm: 0,
  _timer: null,
  _geo: null,
  onUpdate: null,  // optional callback(points) after each snap

  init(geo) { this._geo = geo; },

  start() {
    if (this._timer) return;
    this.points = [];
    this.distKm = 0;
    this._snap();
    this._timer = setInterval(() => this._snap(), 30000);
  },

  stop() {
    if (!this._timer) return null;
    clearInterval(this._timer);
    this._timer = null;
    this._snap();
    return this.getSummary();
  },

  _snap() {
    const pos = this._geo && this._geo.pos;
    if (!pos) return;
    const { lat, lng } = pos;
    const prev = this.points[this.points.length - 1];
    if (prev) this.distKm += haversineKm(prev, { lat, lng });
    this.points.push({ lat, lng, ts: Date.now() });
    if (this.onUpdate) this.onUpdate(this.points);
  },

  getSummary() {
    return { distKm: this.distKm, pointCount: this.points.length };
  },

  exportGpx() {
    if (!this.points.length) return null;
    const date = new Date().toLocaleDateString('de-DE');
    const pts = this.points.map(p => {
      const t = new Date(p.ts).toISOString();
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}"><time>${t}</time></trkpt>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<gpx version="1.1" creator="WaldOhr" xmlns="http://www.topografix.com/GPX/1/1">\n`
      + `  <trk><name>WaldOhr-Route ${date}</name><trkseg>\n`
      + pts + '\n'
      + `  </trkseg></trk>\n</gpx>`;
  },
};
