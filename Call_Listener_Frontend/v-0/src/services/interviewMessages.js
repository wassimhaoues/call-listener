// Client → server message encoders for the live interview WebSocket.
// See docs/protocols/websocket.md; the wire shapes here must not drift.

const BASE64_CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + BASE64_CHUNK_SIZE)
    );
  }
  return btoa(binary);
}

// Optional server features this client understands, advertised at the top
// level of every context message. The server ignores names it doesn't know.
// `resume` opts into resumable sessions: sequenced server messages, a session
// ID, and `{ resume }` after an unexpected disconnect.
export const CLIENT_CAPABILITIES = Object.freeze(["stream", "resume"]);

export function encodeContextMessage(context) {
  const isObject = context && typeof context === "object" && !Array.isArray(context);
  return JSON.stringify({
    context: isObject ? { ...context, capabilities: [...CLIENT_CAPABILITIES] } : context,
  });
}

export function encodeAudioMessage(source, buffer) {
  return JSON.stringify({ source, chunk: bytesToBase64(new Uint8Array(buffer)) });
}

export function encodeInterviewerQuestionMessage(question) {
  return JSON.stringify({ interviewer_question: question });
}

// Must be the first frame on a reconnected socket.
export function encodeResumeMessage(sessionId, lastSeq) {
  return JSON.stringify({ resume: { sessionId, lastSeq } });
}

export function encodeEndMessage() {
  return JSON.stringify({ end: true });
}
