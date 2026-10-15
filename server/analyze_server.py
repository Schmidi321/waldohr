#!/usr/bin/env python3
"""Waldohr BirdNET-Backend.

Nimmt 3-Sekunden-Audio (WAV) per POST /analyze entgegen und gibt die erkannten
Arten als JSON zurueck. Fuehrt BirdNET v2.4 *nativ* aus (ueber birdnetlib) - dort
funktionieren die STFT/RFFT-Ops, die im Browser scheitern.

Start:
    pip install -r server/requirements.txt        # zieht TensorFlow (~1 GB)
    python server/analyze_server.py               # Standard-Port 8800

Verkabelung testen ohne TensorFlow (Stub-Modus, /analyze antwortet 503):
    WALDOHR_NOMODEL=1 python server/analyze_server.py

In der App aktivieren (Browser-Konsole):
    localStorage.setItem('waldohr.server','http://localhost:8800'); location.reload()

Standardmaessig nur auf 127.0.0.1 erreichbar. Fuer Zugriff aus dem Heimnetz (z.B. Handy):
    WALDOHR_BIND=0.0.0.0 python server/analyze_server.py      (oder --public)
Achtung: die App akzeptiert http:// nur fuer localhost — vom Handy aus braucht es https
(Reverse-Proxy/Tunnel davor).
"""
import json
import math
import os
import re
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8800"))
# Default nur Loopback: ein versehentlich im Cafe-/Hotel-WLAN offener BirdNET-Server ist eine
# fremd nutzbare CPU-Last-Quelle. 0.0.0.0 nur bewusst per Umgebungsvariable oder --public.
BIND = "0.0.0.0" if "--public" in sys.argv[1:] else os.environ.get("WALDOHR_BIND", "127.0.0.1")
ANALYZER = None  # wird beim Start geladen (None = Stub-Modus)

# 3 s WAV mono 48 kHz/16 bit sind ~290 KB — 2 MB Obergrenze, damit niemand GB-Uploads in RAM/Temp schiebt.
MAX_BODY = 2 * 1024 * 1024
# BirdNET ist CPU-/RAM-lastig, ThreadingHTTPServer startet je Request einen Thread -> deckeln.
ANALYZE_SLOTS = threading.BoundedSemaphore(2)
# CORS nur für die echte App (GitHub Pages) und lokale Entwicklung (http://localhost:<port>).
ALLOWED_ORIGINS = {"https://schmidi321.github.io"}
LOCAL_ORIGIN_RE = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d{1,5})?$")

if os.environ.get("WALDOHR_NOMODEL") != "1":
    try:
        from birdnetlib.analyzer import Analyzer
        print("Lade BirdNET-Modell (einmalig) ...", flush=True)
        ANALYZER = Analyzer(lang="de")  # deutsche Artnamen statt Englisch
        print("BirdNET bereit.", flush=True)
    except Exception as e:  # noqa: BLE001
        print("WARNUNG: birdnetlib/TensorFlow nicht verfuegbar -> Stub-Modus.", flush=True)
        print("  Installieren:  pip install -r server/requirements.txt", flush=True)
        print(f"  Grund: {e}", flush=True)


def _cors(h):
    # Origin nur zurueckspiegeln, wenn er erlaubt ist — sonst kann jede Website, die der Nutzer
    # gerade offen hat, im Hintergrund den lokalen Server ansprechen und Antworten lesen.
    origin = h.headers.get("Origin", "")
    if origin in ALLOWED_ORIGINS or LOCAL_ORIGIN_RE.match(origin):
        h.send_header("Access-Control-Allow-Origin", origin)
        h.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        h.send_header("Access-Control-Allow-Headers", "Content-Type")
    h.send_header("Vary", "Origin")


def _finite(v, lo, hi):
    """float aus Query-Parameter; ValueError bei NaN/inf/ausserhalb [lo, hi]."""
    x = float(v)
    if not math.isfinite(x) or x < lo or x > hi:
        raise ValueError("out of range")
    return x


class Handler(BaseHTTPRequestHandler):
    timeout = 30  # Slowloris-Schutz: tröpfelnde Clients blockieren sonst ewig einen Thread

    def log_message(self, *args):  # leise
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        _cors(self)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        _cors(self)
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            return self._json(200, {"ok": True, "model": ANALYZER is not None})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/analyze":
            return self._json(404, {"error": "not found"})
        if ANALYZER is None:
            return self._json(503, {"error": "BirdNET nicht geladen (Stub-Modus / Abhaengigkeiten fehlen)"})

        q = parse_qs(u.query)
        # Groesse VOR dem Lesen pruefen — rfile.read(n) holt sonst n Bytes blind in den RAM.
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self._json(411, {"error": "Content-Length fehlt"})
        if length < 1 or length > MAX_BODY:
            return self._json(413, {"error": "Audio leer oder zu gross (max. 2 MB)"})
        try:
            kw = {"min_conf": _finite(q.get("min_conf", ["0.25"])[0], 0.0, 1.0)}
            if "lat" in q and "lon" in q:
                kw["lat"] = _finite(q["lat"][0], -90, 90)
                kw["lon"] = _finite(q["lon"][0], -180, 180)
            if "week" in q:
                w = int(q["week"][0])
                if not (1 <= w <= 48 or w == -1):
                    raise ValueError("week")
                kw["week_48"] = w
        except (ValueError, TypeError):
            return self._json(400, {"error": "Ungueltige Parameter"})
        data = self.rfile.read(length)
        if not ANALYZE_SLOTS.acquire(timeout=5):
            return self._json(503, {"error": "Server ausgelastet, bitte gleich nochmal"})
        path = None
        try:
            from birdnetlib import Recording
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(data)
                path = f.name
            rec = Recording(ANALYZER, path, **kw)
            rec.analyze()
            dets = sorted(rec.detections, key=lambda d: d["confidence"], reverse=True)
            results = [
                {
                    "sci": d["scientific_name"],
                    "common": d["common_name"],
                    "confidence": round(float(d["confidence"]), 3),
                }
                for d in dets[:5]
            ]
            self._json(200, {"results": results})
        except Exception:  # noqa: BLE001
            # Details (Pfade, Bibliotheks-Interna) nur ins Server-Log, nicht an den Client.
            traceback.print_exc()
            self._json(500, {"error": "Analyse fehlgeschlagen"})
        finally:
            ANALYZE_SLOTS.release()
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass


def main():
    mode = "ECHT (BirdNET geladen)" if ANALYZER is not None else "STUB (kein Modell)"
    print(f"Waldohr-Backend [{mode}] auf http://{BIND}:{PORT}  (Strg+C beendet)", flush=True)
    try:
        ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.", flush=True)
        sys.exit(0)


if __name__ == "__main__":
    main()
