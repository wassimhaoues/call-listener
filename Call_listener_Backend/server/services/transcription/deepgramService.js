// server/services/transcription/deepgramService.js
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import { loggers } from "../../core/logger/index.js";
import { EventEmitter } from "events";

const log = loggers.deepgram;

// How long a flushing stop waits for Deepgram's answer to `Finalize` (the
// transcript of audio it had not finalized yet) before closing anyway.
export const FINALIZE_WAIT_MS = 1_500;

export class DeepgramService extends EventEmitter {
  constructor(label, { deepgramClient, language = "fr", log = loggers.deepgram } = {}) {
    super();
    if (!deepgramClient) throw new TypeError("deepgramClient is required");
    this.label = label;
    this.deepgramClient = deepgramClient;
    if (!new Set(["fr", "en"]).has(language)) {
      throw new TypeError("language must be fr or en");
    }
    this.language = language;
    this.log = log;
    this.conn = null;
    this.keepAliveTimer = null;
    this.buffer = "";
    // Whether an interim line was emitted since the last completed utterance.
    this.interimShown = false;
  }

  async start() {
    this.log.info(`🔓 Opening Deepgram session for [${this.label}]...`);
    this.conn = this.deepgramClient.listen.live({
      model: "nova-3",
      encoding: "linear16",
      sample_rate: 48000,
      channels: 1,
      language: this.language,
      interim_results: true,
      smart_format: true,
      punctuate: true,
      vad_events: true,
      endpointing: 400,
      utterance_end_ms: 1200,
    });

    this.registerEvents();
  }

  registerEvents() {
    const { conn, label } = this;

    conn.on(LiveTranscriptionEvents.Open, () => {
      this.log.info(`🎙️ Deepgram [${label}] connection opened.`);
      this.keepAliveTimer = setInterval(() => {
        try {
          conn.keepAlive();
        } catch {
          this.log.warn(`⚠️ keepAlive failed [${label}]`);
        }
      }, 5000);
    });

    conn.on(LiveTranscriptionEvents.Close, () => {
      this.log.info(`🔒 Deepgram [${label}] closed.`);
      clearInterval(this.keepAliveTimer);
    });

    conn.on(LiveTranscriptionEvents.Error, (err) => {
      this.log.error(`❌ Deepgram [${label}] error: %o`, err);
    });

    conn.on(LiveTranscriptionEvents.Transcript, (data) => {
      if (data?.from_finalize) this.emit("finalized");
      const text = data.channel?.alternatives?.[0]?.transcript?.trim();
      if (!text) return;
      if (data.is_final) this.buffer += text + " ";
      // In-progress speech: the utterance's finalized segments so far plus
      // the current non-final hypothesis. Display-only (see StreamManager).
      const interim = data.is_final ? this.buffer : this.buffer + text;
      this.interimShown = true;
      this.emit("interim", { label, text: interim.trim() });
    });

    conn.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      const text = this.buffer.trim();
      this.buffer = "";
      if (text) {
        this.interimShown = false;
        this.log.info(`💬 [${label}] Utterance completed (${text.length} chars)`);
        this.emit("utterance", { label, text });
      } else if (this.interimShown) {
        // Speech that never produced a final segment: end its interim line.
        this.interimShown = false;
        this.emit("interim", { label, text: "" });
      }
    });
  }

  sendChunk(chunk) {
    if (!this.conn) {
      this.log.warn(
        `⚠️ Cannot send chunk — Deepgram [${this.label}] not connected.`
      );
      return;
    }
    try {
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      this.conn.send(u8);
      if (Math.random() * 100 < 2) {
        this.log.debug(`📤 Sent ${u8.byteLength} bytes to Deepgram [${this.label}]`);
      }
    } catch (e) {
      this.log.error(`❌ Failed to send chunk on [${this.label}]: %o`, e);
    }
  }

  /**
   * Ask Deepgram to finalize buffered audio, wait (bounded) for that answer,
   * and emit whatever finalized text has no `UtteranceEnd` yet as the last
   * utterance. Without this, the words spoken just before an explicit end
   * (often the candidate's final answer) never reach the transcript.
   */
  async flush({ waitMs = FINALIZE_WAIT_MS } = {}) {
    if (!this.conn) return;
    await new Promise((resolve) => {
      const timer = setTimeout(done, waitMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.once("finalized", done);
      try {
        this.conn.finalize();
      } catch {
        this.log.warn(`⚠️ Finalize failed [${this.label}]`);
        done();
      }
    });
    this.removeAllListeners("finalized");
    const text = this.buffer.trim();
    this.buffer = "";
    if (text) {
      this.interimShown = false;
      this.log.info(`💬 [${this.label}] Final utterance flushed at stop (${text.length} chars)`);
      this.emit("utterance", { label: this.label, text });
    }
  }

  async stop({ flush = false } = {}) {
    if (!this.conn) return;
    if (flush) await this.flush();
    this.log.info(`🛑 Stopping Deepgram [${this.label}] session.`);
    try {
      await this.conn.finish();
    } catch (err) {
      this.log.error(`❌ Error stopping Deepgram [${this.label}]: %o`, err);
    }
    clearInterval(this.keepAliveTimer);
  }
}
