import { describe, expect, it } from "vitest";
import {
  MAX_WEBSOCKET_BUFFERED_BYTES,
  shouldSendAudio,
} from "../src/services/audioBackpressure.js";

const openAudio = (overrides = {}) => ({
  paused: false,
  readyState: 1,
  openState: 1,
  bufferedAmount: 0,
  ...overrides,
});

describe("shouldSendAudio", () => {
  it("permits audio for an open websocket below the buffer limit", () => {
    expect(shouldSendAudio(openAudio())).toBe(true);
    expect(
      shouldSendAudio(openAudio({ bufferedAmount: MAX_WEBSOCKET_BUFFERED_BYTES }))
    ).toBe(true);
  });

  it("blocks audio while paused, disconnected, or over the buffer limit", () => {
    expect(shouldSendAudio(openAudio({ paused: true }))).toBe(false);
    expect(shouldSendAudio(openAudio({ readyState: 3 }))).toBe(false);
    expect(
      shouldSendAudio(
        openAudio({ bufferedAmount: MAX_WEBSOCKET_BUFFERED_BYTES + 1 })
      )
    ).toBe(false);
  });
});
