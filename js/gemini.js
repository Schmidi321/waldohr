"use strict";
// Optionale Gemini-Anreicherung: erklärt Ruf-Bedeutung + Steckbrief je Art.
// Nutzt den EIGENEN API-Key des Nutzers (localStorage 'waldohr.gemini'); Aufruf direkt
// Browser -> Google. Ergebnisse werden lokal gecacht (nach 1. Abruf offline verfügbar).
// Key wird NICHT mit deployt – jeder nutzt seinen eigenen, nur auf dem Gerät gespeichert.

const LS_KEY = 'waldohr.gemini';
const LS_MODEL = 'waldohr.gemini.model';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export const gemini = {
  getKey() { try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; } },
  setKey(k) { try { (k && k.trim()) ? localStorage.setItem(LS_KEY, k.trim()) : localStorage.removeItem(LS_KEY); } catch {} },
  hasKey() { return !!this.getKey(); },
  model() { try { return localStorage.getItem(LS_MODEL) || DEFAULT_MODEL; } catch { return DEFAULT_MODEL; } },

  _cacheGet(sci) { try { return JSON.parse(localStorage.getItem('waldohr.gem.' + sci) || 'null'); } catch { return null; } },
  _cacheSet(sci, v) { try { localStorage.setItem('waldohr.gem.' + sci, JSON.stringify(v)); } catch {} },

  // -> { meaning, steckbrief } | null
  async enrich(sci, name) {
    if (sci) { const c = this._cacheGet(sci); if (c) return c; }
    const key = this.getKey();
    if (!key) return null;
    const prompt =
      `Du bist Ornithologe. Art: ${name}${sci ? ' (wissenschaftlich: ' + sci + ')' : ''}.\n` +
      `"meaning": Erkläre in 2-3 Sätzen anschaulich für Laien, was Ruf/Gesang dieser Art ` +
      `typischerweise bedeutet (Reviergesang, Warnruf, Balz, Kontaktruf …).\n` +
      `"steckbrief": 1-2 Sätze (Größe, Lebensraum, Besonderheit).\n` +
      `Auf Deutsch, sachlich korrekt; bei Unsicherheit vorsichtig formulieren.`;
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { meaning: { type: 'STRING' }, steckbrief: { type: 'STRING' } },
          required: ['meaning', 'steckbrief']
        }
      }
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model()}:generateContent?key=${encodeURIComponent(key)}`;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { console.warn('gemini', r.status, await r.text().catch(() => '')); return null; }
      const data = await r.json();
      const txt = data && data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      if (!txt) return null;
      const out = JSON.parse(txt);
      if (!out.meaning) return null;
      if (sci) this._cacheSet(sci, out);
      return out;
    } catch (e) { console.warn('gemini', e); return null; }
  }
};
