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
"""
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8800"))
ANALYZER = None  # wird beim Start geladen (None = Stub-Modus)

if os.environ.get("WALDOHR_NOMODEL") != "1":
    try:
        from birdnetlib.analyzer import Analyzer
        print("Lade BirdNET-Modell (einmalig) ...", flush=True)
        ANALYZER = Analyzer()
        print("BirdNET bereit.", flush=True)
    except Exception as e:  # noqa: BLE001
        print("WARNUNG: birdnetlib/TensorFlow nicht verfuegbar -> Stub-Modus.", flush=True)
        print("  Installieren:  pip install -r server/requirements.txt", flush=True)
        print(f"  Grund: {e}", flush=True)


def _cors(h):
    h.send_header("Access-Control-Allow-Origin", "*")
    h.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
    h.send_header("Access-Control-Allow-Headers", "Content-Type")


class Handler(BaseHTTPRequestHandler):
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
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length)
        path = None
        try:
            from birdnetlib import Recording
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(data)
                path = f.name
            kw = {"min_conf": float(q.get("min_conf", ["0.25"])[0])}
            if "lat" in q and "lon" in q:
                kw["lat"] = float(q["lat"][0])
                kw["lon"] = float(q["lon"][0])
            if "week" in q:
                kw["week_48"] = int(q["week"][0])
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
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": str(e)})
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass


def main():
    mode = "ECHT (BirdNET geladen)" if ANALYZER is not None else "STUB (kein Modell)"
    print(f"Waldohr-Backend [{mode}] auf http://localhost:{PORT}  (Strg+C beendet)", flush=True)
    try:
        ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.", flush=True)
        sys.exit(0)


if __name__ == "__main__":
    main()
