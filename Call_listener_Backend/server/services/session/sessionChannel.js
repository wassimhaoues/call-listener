import { createReplayBuffer } from "./replayBuffer.js";

const OPEN = 1;
const CLOSED = 3;

/**
 * Committed messages are the ones a resuming client must not miss: final
 * transcripts, final or failed suggestions, and errors. Transient progress
 * (`thinking`, streamed deltas) is sequenced but never replayed.
 */
export function isCommittedMessage(message) {
  return (
    Object.hasOwn(message, "transcript") ||
    Object.hasOwn(message, "ai_reply") ||
    Object.hasOwn(message, "error")
  );
}

/**
 * The session's outbound path. It exposes the subset of the `ws` socket API
 * the message handler and stream manager use (`OPEN`, `readyState`,
 * `send(string)`), so they keep working unchanged while the physical socket
 * is swapped on resume.
 *
 * Without sequencing (clients that did not advertise `resume`) it forwards
 * frames to the attached socket byte for byte. With sequencing, every frame
 * gets a monotonically increasing `seq`, committed frames are retained in a
 * bounded replay buffer, and frames sent while no socket is attached are
 * kept for replay instead of being dropped.
 */
export class SessionChannel {
  constructor({ replayLimits } = {}) {
    this.OPEN = OPEN;
    this.socket = null;
    this.sequencing = false;
    this.seq = 0;
    this.replay = createReplayBuffer(replayLimits);
  }

  get readyState() {
    if (this.sequencing) return OPEN;
    return this.socket ? this.socket.readyState : CLOSED;
  }

  attach(socket) {
    this.socket = socket;
  }

  detach() {
    this.socket = null;
  }

  enableSequencing() {
    this.sequencing = true;
  }

  send(data) {
    if (!this.sequencing) {
      this.forward(data);
      return;
    }
    const message = JSON.parse(data);
    this.seq += 1;
    const framed = JSON.stringify({ ...message, seq: this.seq });
    if (isCommittedMessage(message)) this.replay.push(this.seq, framed);
    this.forward(framed);
  }

  /** Session-control frames (`session`, `resumed`, `notice`) are never sequenced or replayed. */
  sendControl(payload) {
    this.forward(JSON.stringify(payload));
  }

  /** Replay retained committed frames after `lastSeq` to the attached socket. */
  replaySince(lastSeq) {
    const { messages, truncated } = this.replay.since(lastSeq);
    for (const data of messages) this.forward(data);
    return { replayed: messages.length, truncated };
  }

  forward(data) {
    const socket = this.socket;
    if (socket && socket.readyState === socket.OPEN) socket.send(data);
  }
}
