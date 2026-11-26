import { vi } from "vitest";

// Minimal WebSocket double: tests drive lifecycle events explicitly.
export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    if (this.readyState === FakeWebSocket.CONNECTING) {
      throw new Error("InvalidStateError");
    }
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSING;
  }

  get sentMessages() {
    return this.sent.map((data) => JSON.parse(data));
  }

  serverOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverSend(data) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  serverClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  static latest() {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  static reset() {
    FakeWebSocket.instances = [];
  }
}

export function createFakeTrack() {
  return { stop: vi.fn() };
}

export function createFakeStream() {
  const tracks = [createFakeTrack()];
  return { tracks, getTracks: () => tracks };
}

export function createFakeNode() {
  return {
    connect: vi.fn((target) => target),
    port: { postMessage: vi.fn(), onmessage: null },
  };
}

// Installs AudioContext, AudioWorkletNode, and getUserMedia doubles.
export function installFakeAudio({ workletFails = false } = {}) {
  const contexts = [];
  const workletNodes = [];
  const scriptProcessors = [];
  const streams = [];

  class FakeAudioContext {
    constructor(options) {
      this.options = options;
      this.state = "suspended";
      this.destination = {};
      this.audioWorklet = {
        addModule: vi.fn(async () => {
          if (workletFails) throw new Error("worklet unavailable");
        }),
      };
      this.resume = vi.fn(async () => {
        this.state = "running";
      });
      this.close = vi.fn(async () => {
        this.state = "closed";
      });
      this.sources = [];
      contexts.push(this);
    }

    createMediaStreamSource(stream) {
      const source = { stream, connect: vi.fn((target) => target) };
      this.sources.push(source);
      return source;
    }

    createGain() {
      return { gain: { value: 1 }, connect: vi.fn((target) => target) };
    }

    createScriptProcessor() {
      const processor = { connect: vi.fn((target) => target), onaudioprocess: null };
      scriptProcessors.push(processor);
      return processor;
    }
  }

  class FakeAudioWorkletNode {
    constructor(ctx, name, options) {
      Object.assign(this, createFakeNode());
      this.name = name;
      this.options = options;
      workletNodes.push(this);
    }
  }

  const getUserMedia = vi.fn(async () => {
    const stream = createFakeStream();
    streams.push(stream);
    return stream;
  });

  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  const previousMediaDevices = navigator.mediaDevices;
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices: vi.fn(async () => []) },
  });

  return {
    contexts,
    workletNodes,
    scriptProcessors,
    streams,
    getUserMedia,
    restore() {
      vi.unstubAllGlobals();
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: previousMediaDevices,
      });
    },
  };
}
