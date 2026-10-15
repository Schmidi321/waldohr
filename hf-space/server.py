#!/usr/bin/env python3
"""Waldohr BirdNET-Backend für HuggingFace Spaces (Docker).

POST /analyze  (Body: WAV, optional ?min_conf&lat&lon&week) -> {results:[{sci,common,confidence}]}
GET  /health   -> {ok, model}
GET  /         -> kleine Statusseite

Führt BirdNET v2.4 nativ über birdnetlib aus (STFT/RFFT funktionieren hier, anders als im Browser).
"""
import json
import math
import os
import re
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "7860"))
ANALYZER = None

# Öffentlicher Space: jeder kann POSTen. 3 s WAV mono 48 kHz/16 bit sind ~290 KB — 2 MB Obergrenze
# lässt Luft für andere Raten, verhindert aber, dass jemand GB-Uploads in den RAM/Temp-Ordner schiebt.
MAX_BODY = 2 * 1024 * 1024
# BirdNET-Inferenz ist CPU-/RAM-lastig; ThreadingHTTPServer startet je Request einen Thread —
# ohne Deckel legen ein paar parallele Clients den kleinen HF-Container lahm (OOM).
ANALYZE_SLOTS = threading.BoundedSemaphore(2)
# CORS nur für die echte App (GitHub Pages) und lokale Entwicklung — sonst könnte jede fremde
# Website den Space im Browser ihrer Besucher als kostenlose BirdNET-API mitbenutzen.
ALLOWED_ORIGINS = {"https://schmidi321.github.io"}
LOCAL_ORIGIN_RE = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d{1,5})?$")

try:
    from birdnetlib.analyzer import Analyzer
    print("Lade BirdNET-Modell (einmalig) ...", flush=True)
    ANALYZER = Analyzer()
    print("BirdNET bereit.", flush=True)
except Exception as e:  # noqa: BLE001
    print("WARNUNG: birdnetlib nicht verfügbar -> Stub:", e, flush=True)


def _cors(h):
    origin = h.headers.get("Origin", "")
    if origin in ALLOWED_ORIGINS or LOCAL_ORIGIN_RE.match(origin):
        h.send_header("Access-Control-Allow-Origin", origin)
        h.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        h.send_header("Access-Control-Allow-Headers", "Content-Type")
    # Antwort hängt vom Origin ab -> Caches/Proxies dürfen sie nicht origin-übergreifend teilen.
    h.send_header("Vary", "Origin")


def _finite(v, lo, hi):
    """float aus Query-Parameter; ValueError bei NaN/inf/außerhalb [lo, hi]."""
    x = float(v)
    if not math.isfinite(x) or x < lo or x > hi:
        raise ValueError("out of range")
    return x


class Handler(BaseHTTPRequestHandler):
    # Socket-Timeout: ein Client, der Content-Length ankündigt und dann nur tröpfelt
    # (Slowloris), blockiert sonst ewig einen Thread.
    timeout = 30

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
        # Größe VOR dem Lesen prüfen — rfile.read(n) würde n Bytes blind in den RAM holen.
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self._json(411, {"error": "Content-Length fehlt"})
        if length < 1 or length > MAX_BODY:
            return self._json(413, {"error": "Audio leer oder zu groß (max. 2 MB)"})
        try:
            kw = {"min_conf": _finite(q.get("min_conf", ["0.25"])[0], 0.0, 1.0)}
            if "lat" in q and "lon" in q:
                kw["lat"] = _finite(q["lat"][0], -90, 90); kw["lon"] = _finite(q["lon"][0], -180, 180)
            if "week" in q:
                w = int(q["week"][0])
                if not (1 <= w <= 48 or w == -1):
                    raise ValueError("week")
                kw["week_48"] = w
        except (ValueError, TypeError):
            return self._json(400, {"error": "Ungültige Parameter"})
        data = self.rfile.read(length)
        # Kurz warten statt sofort 503: die App schickt pro Client ohnehin nur eine Anfrage
        # gleichzeitig, kurze Überlappungen mehrerer Nutzer sollen nicht gleich fehlschlagen.
        if not ANALYZE_SLOTS.acquire(timeout=5):
            return self._json(503, {"error": "Server ausgelastet, bitte gleich nochmal"})
        path = None
        try:
            from birdnetlib import Recording
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(data); path = f.name
            rec = Recording(ANALYZER, path, **kw)
            rec.analyze()
            dets = sorted(rec.detections, key=lambda d: d["confidence"], reverse=True)
            results = [{"sci": d["scientific_name"], "common": d["common_name"],
                        "confidence": round(float(d["confidence"]), 3)} for d in dets[:5]]
            self._json(200, {"results": results})
        except Exception:  # noqa: BLE001
            # Details (Pfade, Bibliotheks-Interna) nur ins Server-Log, nicht an den Client.
            traceback.print_exc()
            self._json(500, {"error": "Analyse fehlgeschlagen"})
        finally:
            ANALYZE_SLOTS.release()
            if path:
                try: os.unlink(path)
                except OSError: pass


if __name__ == "__main__":
    print(f"Waldohr-Backend auf :{PORT} ({'echt' if ANALYZER else 'stub'})", flush=True)
    # 0.0.0.0 ist hier richtig: im HF-Docker-Container muss der Port nach außen erreichbar sein.
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
