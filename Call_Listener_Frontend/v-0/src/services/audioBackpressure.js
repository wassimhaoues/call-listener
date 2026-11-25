export const MAX_WEBSOCKET_BUFFERED_BYTES = 512 * 1024;

export function shouldSendAudio({
  paused,
  readyState,
  openState,
  bufferedAmount,
}) {
  return (
    !paused &&
    readyState === openState &&
    bufferedAmount <= MAX_WEBSOCKET_BUFFERED_BYTES
  );
}
