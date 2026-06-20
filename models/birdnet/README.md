# BirdNET-Modell

## ⚠️ Befund (2026-06-20): BirdNET läuft NICHT im Browser
Das echte Modell ist hier installiert (`model.tflite` 26 MB FP16 + `labels.txt` de, von
Zenodo record 15050749). ABER: BirdNET v2.4 enthält **STFT/RFFT-Ops** für sein internes
Spektrogramm, die die TFLite-**WASM**-Laufzeit (`@tensorflow/tfjs-tflite`) nicht ausführen
kann → das Modell lädt zwar (XNNPACK-Delegate), `predict` bricht aber mit `Aborted()` ab.
Bestätigt im Browser-Test. Das ist eine harte Runtime-Grenze, kein Konfigurationsfehler.

Deshalb wird die `.tflite` **nicht automatisch** aktiviert; die App bleibt auf Mock.
Mit `localStorage.setItem('waldohr.birdnet','1')` lässt es sich erzwingen – ein Warmup-
Selbsttest in `load()` fängt den Abbruch ab und fällt wieder auf Mock zurück.

### Wege zu echter BirdNET-Erkennung
- **Server-seitig** (zuverlässig): kleines Python-/Node-Backend mit dem `birdnet`-Paket
  (führt dieselbe `.tflite` nativ aus, wo STFT/RFFT funktionieren). PWA schickt 3-s-Clips
  hin. Braucht Netz (kein Offline im Wald) – passt als optionale Online-Anreicherung.
- **Native App** (Capacitor/RN): native TFLite kann die Signal-Ops → echtes On-Device-Offline.
- **GraphModel-Konvertierung**: nur sinnvoll, wenn ein Front-end ohne STFT genutzt wird
  (Mel-Spektrogramm in JS vorrechnen, klassifizierer-only Modell). Aufwändig.

Sobald hier ein **TF.js-GraphModel** (`model.json`) liegt, aktiviert die App es automatisch.

## Erwartete Dateien

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
