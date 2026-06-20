#!/usr/bin/env python3
"""Waldohr BirdNET-Backend für HuggingFace Spaces (Docker).

POST /analyze  (Body: WAV, optional ?min_conf&lat&lon&week) -> {results:[{sci,common,confidence}]}
GET  /health   -> {ok, model}
GET  /         -> kleine Statusseite

Führt BirdNET v2.4 nativ über birdnetlib aus (STFT/RFFT funktionieren hier, anders als im Browser).
"""
import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "7860"))
ANALYZER = None

try:
    from birdnetlib.analyzer import Analyzer
    print("Lade BirdNET-Modell (einmalig) ...", flush=True)
    ANALYZER = Analyzer()
    print("BirdNET bereit.", flush=True)
except Exception as e:  # noqa: BLE001
    print("WARNUNG: birdnetlib nicht verfügbar -> Stub:", e, flush=True)


def _cors(h):
    h.send_header("Access-Control-Allow-Origin", "*")
    h.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
    h.send_header("Access-Control-Allow-Headers", "Content-Type")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code); _cors(self)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); _cors(self); self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self._json(200, {"ok": True, "model": ANALYZER is not None})
        if path == "/":
            html = b"<h2>Waldohr BirdNET</h2><p>POST WAV an /analyze</p>"
            self.send_response(200); _cors(self)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers(); self.wfile.write(html); return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path != "/analyze":
            return self._json(404, {"error": "not found"})
        if ANALYZER is None:
            return self._json(503, {"error": "BirdNET nicht geladen"})
        q = parse_qs(urlparse(self.path).query)
        data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        path = None
        try:
            from birdnetlib import Recording
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(data); path = f.name
            kw = {"min_conf": float(q.get("min_conf", ["0.25"])[0])}
            if "lat" in q and "lon" in q:
                kw["lat"] = float(q["lat"][0]); kw["lon"] = float(q["lon"][0])
            if "week" in q:
                kw["week_48"] = int(q["week"][0])
            rec = Recording(ANALYZER, path, **kw)
            rec.analyze()
            dets = sorted(rec.detections, key=lambda d: d["confidence"], reverse=True)
            results = [{"sci": d["scientific_name"], "common": d["common_name"],
                        "confidence": round(float(d["confidence"]), 3)} for d in dets[:5]]
            self._json(200, {"results": results})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": str(e)})
        finally:
            if path:
                try: os.unlink(path)
                except OSError: pass


if __name__ == "__main__":
    print(f"Waldohr-Backend auf :{PORT} ({'echt' if ANALYZER else 'stub'})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
