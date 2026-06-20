---
title: Waldohr BirdNET
emoji: 🌲
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Waldohr BirdNET-Backend (HuggingFace Space)

Echte Vogel-Erkennung über HTTPS, vom Handy erreichbar. Läuft BirdNET v2.4 nativ (birdnetlib),
weil die STFT/RFFT-Ops im Browser nicht funktionieren.

## So bringst du es online (einmalig, kostenlos)

1. Account auf **huggingface.co** anlegen (falls nicht vorhanden).
2. **New → Space** → Name z. B. `waldohr-birdnet`, **SDK: Docker**, **Public**, „Create Space".
3. Im neuen Space **Files → Add file → Upload files** und diese 4 Dateien hochladen:
   `Dockerfile`, `server.py`, `requirements.txt`, `README.md` → Commit.
4. Der Space baut nun (~5–10 Min, „Building"). Wenn „Running": läuft auf
   `https://<dein-name>-waldohr-birdnet.hf.space`.
5. In der App (⚙ → „Echte Erkennung (BirdNET-Server)") **genau diese URL** eintragen → Speichern.
   Die App lädt neu und nutzt echtes BirdNET. Standort (falls erlaubt) verbessert die Treffer.

## Test
- `https://…hf.space/health` → `{"ok": true, "model": true}`
- Erste Anfrage kann etwas dauern (Space „wacht auf"); danach ~1–3 s pro 3-Sek-Clip.

## Hinweise
- Free-Tier schläft bei Inaktivität ein und braucht beim ersten Aufruf ~30 s zum Aufwachen.
- CORS ist offen (`*`), damit die GitHub-Pages-App zugreifen darf.
- Kosten: CPU-Basic ist kostenlos.
