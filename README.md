# 🌲 Waldohr — Tierstimmen erkennen

Mobile-first **PWA**, die Tierlaute (v. a. Vögel) am Ruf erkennt, auf einer Karte verortet,
Funde sammelt und Statistiken zeigt. Dunkles „Nachtwald"-Design, läuft offline.

## Features
- 🎧 **Lauschen** — Live-Mikrofon-Spektrogramm, Erkennung, Richtungs-Radar
- 🗺️ **Fundkarte** — GPS-verortete Funde (offline, ohne externen Kartendienst)
- 🏆 **Sammlung** & 📊 **Statistik** (häufigste Arten, Wochenverlauf, Tagesaktivität)
- ✨ **Gemini-Anreicherung** (optional, eigener API-Key) — erklärt Ruf-Bedeutung & Steckbrief
- Installierbar als PWA (Service Worker, Offline-Shell)

## Erkennung
- **Standard:** Demo-Modus (Mock) — funktioniert ohne Setup.
- **Echtes BirdNET:** läuft **nicht** im Browser (das Modell nutzt STFT/RFFT-Ops, die die
  TFLite-WASM-Laufzeit nicht ausführt). Zwei Wege:
  - **Server-seitig** — `server/` (Python + birdnetlib), dann in der App-Konsole
    `localStorage.setItem('waldohr.server','http://localhost:8800')`.
  - Details: [`models/birdnet/README.md`](models/birdnet/README.md), [`server/README.md`](server/README.md)

## Lokal starten
```bash
python -m http.server 8781      # oder:  node scripts/serve.mjs
```
Dann http://localhost:8781 öffnen. Mikrofon & GPS brauchen `localhost` oder HTTPS.

## Stack
Vanilla HTML/CSS/JS (ES-Module), kein Build-Schritt. Funde in IndexedDB.
`js/`: `app` (Orchestrierung) · `audio` (Mikro/FFT) · `recognizer` (Mock/BirdNET/Server) ·
`db` (Speicher+Statistik) · `ui` (Rendering) · `species` (Katalog) · `gemini` (Anreicherung).
