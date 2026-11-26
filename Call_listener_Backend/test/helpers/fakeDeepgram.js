import { EventEmitter } from "node:events";
import { LiveTranscriptionEvents } from "@deepgram/sdk";

/** Build a Deepgram-like `Results` event for the real DeepgramService. */
export function deepgramResults(text, { isFinal = true, speechFinal = isFinal } = {}) {
  return {
    type: "Results",
    channel_index: [0, 1],
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript: text, confidence: 0.99, words: [] }] },
  };
}

class FakeLiveConnection extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sent = [];
    this.finishCalls = 0;
  }

  send(data) {
    this.sent.push(data);
  }

  keepAlive() {}

  async finish() {
    this.finishCalls += 1;
    this.emit(LiveTranscriptionEvents.Close);
  }

  emitTranscript(text, options) {
    this.emit(LiveTranscriptionEvents.Transcript, deepgramResults(text, options));
  }

  emitUtteranceEnd() {
    this.emit(LiveTranscriptionEvents.UtteranceEnd, { type: "UtteranceEnd", channel: [0, 1] });
  }
}

/**
 * Fake `deepgramClient` for DeepgramService: `listen.live()` returns a
 * scriptable connection instead of opening a network socket.
 */
export function createFakeDeepgramClient() {
  const connections = [];
  return {
    connections,
    listen: {
      live(options) {
        const connection = new FakeLiveConnection(options);
        connections.push(connection);
        return connection;
      },
    },
  };
}
