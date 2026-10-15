# BirdNET-Modell

## Stand (2026-10-15): Offline-Erkennung läuft im Browser ✅
Die App nutzt die **offizielle TF.js-Fassung** von BirdNET v2.4 aus der Zenodo-Veröffentlichung
(record 15050749, `BirdNET_v2.4_tfjs.zip`, 75 MB, SHA-256 in `js/offline-model.js` gepinnt).
Der Nutzer lädt sie in den Einstellungen → „Offline-Erkennung“ einmalig herunter; sie landet in
Cache Storage (`waldohr-birdnet-v24`), **nicht** im Repo (Lizenz CC BY-NC(-SA) 4.0 = nicht-kommerziell).

- Rechnet in `js/birdnet-worker.js` (Web Worker, TF.js 4.22.0 + WASM aus `vendor/tfjs-4.22.0/`).
- Der Custom-Layer `MelSpecLayerSimple` ist nachgebaut, die STFT aber durch eine eigene Radix-2-FFT
  ersetzt: `tf.signal.stft` rechnet die FFT als O(n²)-DFT (~15 s pro Fenster). Mit eigener FFT:
  ~0,2 s/Fenster (PC, wasm), ~0,4–0,6 s im Handy-Profil mit 4–6× CPU-Drosselung.
- Treffer und Konfidenzen identisch zum HF-Server (16 Testclips, 8 Arten).
- Range-Filter (Meta-Modell `mdata/`, lat/lon/Woche, Schwelle 0,03) läuft ebenfalls im Worker.
- Mit eingetragenem Server: Server zuerst, im Funkloch automatisch das Handy-Modell (Retry nach 60 s).

Labels: `labels.txt` (deutsch, 6522 Zeilen) hat exakt dieselbe Reihenfolge wie `labels.json` im ZIP.

## Historie: Die `.tflite` läuft NICHT im Browser (Befund 2026-06-20)
BirdNET v2.4 als `.tflite` enthält **STFT/RFFT-Ops**, die die TFLite-**WASM**-Laufzeit
(`@tensorflow/tfjs-tflite`) nicht ausführen kann → `predict` bricht mit `Aborted()` ab.
Die lokale `model.tflite` (gitignored) wird von der App nicht mehr verwendet.

## Alt: Erwartete Dateien (tflite-Weg, überholt)

Variante A – TFLite (empfohlen, einfachste):
```
models/birdnet/model.tflite     ← BirdNET v2.4 Audio-Modell (FP16 oder FP32)
models/birdnet/labels.txt       ← eine Zeile je Klasse, Format "Wissenschaftlich_Trivialname"
```

Variante B – TensorFlow.js GraphModel (falls die .tflite-Ops im Browser nicht laufen):
```
models/birdnet/model.json + group1-shard*.bin   ← per tensorflowjs_converter erzeugt
models/birdnet/labels.txt
```

`labels.txt` hat für V2.4 genau **6522 Zeilen**, z. B.:
```
Turdus merula_Common Blackbird
Erithacus rubecula_European Robin
```
(Eine deutsche Label-Datei geht auch – dann steht hinter dem „_" der deutsche Name.)

## Woher bekomme ich das Modell?

BirdNET (Cornell Lab / TU Chemnitz) liegt **nicht** im Git-Repo, sondern kommt über die
Python-Pakete. Schnellster Weg:

```bash
pip install birdnet-analyzer        # bzw. das Paket "birdnet"
# Modell + Labels liegen danach im installierten Paket (Ordner ".../checkpoints/V2.4/"):
#   BirdNET_GLOBAL_6K_V2.4_Model_FP16.tflite   -> hierher als model.tflite kopieren
#   BirdNET_GLOBAL_6K_V2.4_Labels*.txt         -> hierher als labels.txt kopieren
python -c "import birdnet_analyzer,os; print(os.path.dirname(birdnet_analyzer.__file__))"
```
Den ausgegebenen Paketpfad öffnen, die beiden Dateien suchen und wie oben benannt
hierher kopieren. Alternativ über die BirdNET-Analyzer-GUI (lädt die Modelle herunter)
oder einen HuggingFace-Spiegel von „BirdNET GLOBAL 6K V2.4".

## Technische Annahmen des Adapters (`js/recognizer.js`)

- Eingang: **roher Audio-Waveform**, 48 kHz mono, 3 s = **144000 Samples**, Form `[1, 144000]`.
  (BirdNET v2.4 berechnet das Mel-Spektrogramm intern – kein eigenes Pre-Processing nötig.)
  Das Mikro-Fenster wird automatisch auf 144000 Samples resampelt.
- Ausgang: Logits über alle Klassen → **Sigmoid** → Top-1 über `minConf` (Standard 0,3).
- Label wird an `_` getrennt; bekannte Arten nutzen den Waldohr-Katalog, unbekannte
  bekommen automatisch einen generischen Eintrag (siehe `ensureSpecies` in `species.js`).

## Stolpersteine

- **Ops/RFFT:** Nutzt die `.tflite` TF-Select-Ops (FFT), die das tfjs-tflite-WASM nicht
  kennt, schlägt `predict` fehl → dann Variante B (GraphModel) verwenden.
- **Offline:** Das Modell (~25–50 MB) wird vom Service Worker aktuell **nicht** gecacht.
  Für Offline-Betrieb die Dateien in `sw.js` zur `ASSETS`-Liste hinzufügen (nur wenn sie
  wirklich vorliegen – sonst schlägt die SW-Installation fehl).
- **Performance:** Inferenz läuft im Main-Thread (~alle 1,5 s). Bei Rucklern später in
  einen Web Worker auslagern.
