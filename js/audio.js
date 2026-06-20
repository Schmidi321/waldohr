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
