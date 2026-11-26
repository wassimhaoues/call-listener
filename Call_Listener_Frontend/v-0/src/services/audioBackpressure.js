export const MAX_WEBSOCKET_BUFFERED_BYTES = 512 * 1024;

// `connected` is false while the session is reconnecting (or the new socket
// is open but not yet resumed): audio from that gap is dropped, never queued
// for a later socket.
export function shouldSendAudio({
  paused,
  connected = true,
  readyState,
  openState,
  bufferedAmount,
}) {
  return (
    !paused &&
    connected &&
    readyState === openState &&
    bufferedAmount <= MAX_WEBSOCKET_BUFFERED_BYTES
  );
}
