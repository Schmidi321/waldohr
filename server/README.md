# Waldohr BirdNET-Backend (server-seitige Erkennung)

Echtes BirdNET läuft nicht im Browser (STFT/RFFT-Ops, siehe `../models/birdnet/README.md`).
Dieses kleine Backend führt BirdNET **nativ** aus; die PWA schickt 3-Sekunden-Clips hin.

## Einrichten & starten

```bash
# im Ordner waldohr/
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate

pip install -r server/requirements.txt        # zieht TensorFlow (~1 GB), dauert etwas
python server/analyze_server.py               # startet auf http://localhost:8800
```

Beim ersten Start lädt birdnetlib das BirdNET-Modell herunter (einmalig).

## In der App aktivieren

App öffnen (`http://localhost:8781` o. ä.), Browser-Konsole:
```js
localStorage.setItem('waldohr.server', 'http://localhost:8800');
location.reload();
```
Danach „Lauschen“ → Mikro erlauben: erkannte Arten kommen jetzt von **echtem BirdNET**
(inkl. Standort-Filter, wenn GPS erlaubt ist). Zurück zur Demo:
`localStorage.removeItem('waldohr.server')`.

## Verkabelung testen ohne TensorFlow (Stub-Modus)

```bash
WALDOHR_NOMODEL=1 python server/analyze_server.py      # /health=ok, /analyze=503
```
Windows PowerShell: `$env:WALDOHR_NOMODEL=1; python server/analyze_server.py`

## API

- `GET /health` → `{"ok": true, "model": true|false}`
- `POST /analyze?min_conf=0.25[&lat=..&lon=..&week=1..48]` — Body: WAV (3 s, mono)
  → `{"results": [{"sci","common","confidence"}, …]}` (Top 5)

## Hinweise

- **Nicht offline:** Dieses Backend braucht Netz/Server – passt als „zu Hause/online"-Modus
  oder für „aufnehmen & später auswerten". Für echtes Offline im Wald bräuchte es eine
  native App (siehe Modell-README).
- **CORS** ist offen (`*`), damit die PWA von einem anderen Port zugreifen kann.
- Latenz: pro 3-s-Fenster ein Roundtrip; der Client schickt immer nur eine Anfrage
  gleichzeitig (kein Stau).
