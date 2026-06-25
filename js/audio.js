// Mikrofon-Engine: liefert (1) Frequenzdaten fürs Spektrogramm und
// (2) 3-Sekunden-PCM-Fenster für die Erkennung (onWindow-Callback).

export class AudioEngine {
  constructor() {
    this.ctx = null; this.analyser = null; this.freq = null;
    this.stream = null; this.proc = null; this.sink = null;
    this.running = false; this.sampleRate = 48000;
    this.onWindow = null;
    this._ring = null; this._w = 0; this._count = 0; this._lastEmit = 0;
    this._need = 0; this._hop = 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.sampleRate = this.ctx.sampleRate;

    const src = this.ctx.createMediaStreamSource(this.stream);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.72;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    src.connect(this.analyser);

    // PCM-Fenster für den Recognizer
    this._need = Math.floor(this.sampleRate * 3);    // 3-Sekunden-Fenster
    this._hop  = Math.floor(this.sampleRate * 1.5);  // alle 1,5 s ein Treffer-Check
    this._ring = new Float32Array(this._need);
    this._w = 0; this._count = 0; this._lastEmit = 0;

    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = e => this._push(e.inputBuffer.getChannelData(0));
    // ScriptProcessor muss in die Verarbeitungskette; über Gain 0 -> kein hörbares Echo
    this.sink = this.ctx.createGain(); this.sink.gain.value = 0;
    src.connect(this.proc); this.proc.connect(this.sink); this.sink.connect(this.ctx.destination);

    this.running = true;
  }

  _push(inp) {
    for (let i = 0; i < inp.length; i++) {
      this._ring[this._w] = inp[i];
      this._w = (this._w + 1) % this._need;
      this._count++;
      if (this._count >= this._need && this._count - this._lastEmit >= this._hop) {
        this._lastEmit = this._count;
        this._emit();
      }
    }
  }

  _emit() {
    if (!this.onWindow) return;
    const out = new Float32Array(this._need);
    for (let i = 0; i < this._need; i++) out[i] = this._ring[(this._w + i) % this._need];
    this.onWindow(out, this.sampleRate);
  }

  stop() {
    try { if (this.proc) this.proc.disconnect(); } catch {}
    try { if (this.sink) this.sink.disconnect(); } catch {}
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
    this.analyser = null; this.freq = null; this.running = false;
  }
}

// ---- Aufnahmen lauter & klarer machen ----
// Hochpassfilter schneidet tiefes Windrauschen/Grummeln raus (Vogelstimmen liegen fast immer
// deutlich darüber), anschließende Spitzenpegel-Normalisierung macht die Aufnahme insgesamt
// lauter, ohne stille Aufnahmen zu extrem hochzuziehen (Boost gedeckelt).
export async function enhanceSamples(samples, sampleRate) {
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offline = new OfflineCtx(1, samples.length, sampleRate);
  const buf = offline.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  const src = offline.createBufferSource();
  src.buffer = buf;
  const hp = offline.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 500;
  src.connect(hp); hp.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const data = rendered.getChannelData(0);
  // Reine Spitzenpegel-Normalisierung bringt bei leisen Aufnahmen wenig: ein einzelner kurzer
  // Knall (Windstoß, Klick) reicht, um den Boost zu deckeln, während der eigentliche, leise
  // Vogelruf kaum lauter wird. Stattdessen auf einen Ziel-Effektivpegel (RMS) hochziehen — das
  // hebt die tatsächliche Lautheit der Aufnahme an — und nur als Schutz gegen Übersteuerung
  // zusätzlich am Spitzenpegel deckeln.
  let peak = 0, sumSq = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; sumSq += data[i] * data[i]; }
  const rms = Math.sqrt(sumSq / data.length);
  const TARGET_RMS = 0.25, PEAK_CEIL = 0.95;
  let boost = rms > 0.0005 ? Math.min(TARGET_RMS / rms, 24) : 1;
  if (peak * boost > PEAK_CEIL) boost = PEAK_CEIL / peak;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.max(-1, Math.min(1, data[i] * boost));
  return out;
}

// Mischt mehrkanalige Aufnahmen (z.B. Stereo) zu einem Kanal.
function mixToMono(buf) {
  const out = new Float32Array(buf.length);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

// Für manuelle Aufnahmen (MediaRecorder-Blob, z.B. webm/opus) — dekodiert, optimiert,
// liefert rohe Samples zum erneuten Enkodieren (z.B. via encodeWav).
export async function enhanceBlob(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const audioBuf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const mono = audioBuf.numberOfChannels > 1 ? mixToMono(audioBuf) : audioBuf.getChannelData(0);
  const enhanced = await enhanceSamples(mono, audioBuf.sampleRate);
  try { ctx.close(); } catch {}
  return { samples: enhanced, sampleRate: audioBuf.sampleRate };
}
