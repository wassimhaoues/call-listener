//src/worklets/pcm-processor.js
class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.source = options?.processorOptions?.source || "mic";
    this.meterHz = 30;
    this.clipThresh = 0.98;
    this._lastMeterT = 0;
    this._seq = 0; // optional: sequence number for debug
    this.batchDurationSeconds = 0.02;
    this.batchSamples = options?.processorOptions?.batchSamples || Math.round(sampleRate * this.batchDurationSeconds);
    this.pending = new Int16Array(this.batchSamples);
    this.pendingOffset = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "flush") this.flush();
    };
  }

  flush() {
    if (!this.pendingOffset) return;
    const chunk = this.pending.slice(0, this.pendingOffset);
    this.port.postMessage(
      { type: "chunk", source: this.source, buffer: chunk.buffer, seq: this._seq++ },
      [chunk.buffer]
    );
    this.pending = new Int16Array(this.batchSamples);
    this.pendingOffset = 0;
  }

  process(inputs /* [[Float32Array]] */) {
    const ch0 = inputs[0]?.[0];
    if (!ch0) return true;

    const len = ch0.length;
    let sum = 0;
    let clip = false;

    // Convert to Int16 + meter
    const out = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      let s = ch0[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      if (!clip && (s >= this.clipThresh || s <= -this.clipThresh)) clip = true;
      sum += s * s;
      out[i] = (s * 0x7fff) | 0;
    }

    // Throttled meter
    const now = currentTime;
    if (now - this._lastMeterT >= 1 / this.meterHz) {
      const rms = Math.sqrt(sum / len);
      this.port.postMessage({ type: "meter", source: this.source, rms, clip });
      this._lastMeterT = now;
    }

    // Batch 20 ms of PCM before crossing the renderer boundary. This lowers
    // WebSocket message overhead while preserving linear16 sample ordering.
    let offset = 0;
    while (offset < out.length) {
      const available = this.batchSamples - this.pendingOffset;
      const take = Math.min(available, out.length - offset);
      this.pending.set(out.subarray(offset, offset + take), this.pendingOffset);
      this.pendingOffset += take;
      offset += take;
      if (this.pendingOffset === this.batchSamples) this.flush();
    }

    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
