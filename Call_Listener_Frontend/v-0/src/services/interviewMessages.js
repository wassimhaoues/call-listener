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

export function encodeContextMessage(context) {
  return JSON.stringify({ context });
}

export function encodeAudioMessage(source, buffer) {
  return JSON.stringify({ source, chunk: bytesToBase64(new Uint8Array(buffer)) });
}

export function encodeInterviewerQuestionMessage(question) {
  return JSON.stringify({ interviewer_question: question });
}

export function encodeEndMessage() {
  return JSON.stringify({ end: true });
}
