# Audio framing: base64 JSON vs binary frames

Roadmap Phase 6 asks whether binary WebSocket framing is worth a new negotiated transport capability. This page records a synthetic measurement and the decision.

## Method

`npm run bench:framing` (backend, `scripts/bench/audioFraming.js`) encodes and decodes deterministic pseudo-random 48 kHz mono PCM16 for both channels (mic and system) in 20, 40 and 60 ms batches. It needs no network, provider or recording. It compares:

- **JSON (current):** `{ "source": "system", "chunk": "<base64 PCM16>" }` as a text frame.
- **Binary (hypothetical):** a 1-byte source tag followed by the raw PCM16 bytes.

Wire sizes include the client-to-server WebSocket header (masked, 8 bytes for these payloads). The CPU columns are the time to encode, then decode, one minute of two-channel audio in one Node process. They are an upper bound for the server side, which only decodes.

## Results (2026-11-26, Node 24.11.1, x86-64 Linux, 1 minute of audio)

| Batch | Msgs/s (2 channels) | JSON frame (B) | Binary frame (B) | JSON KiB/s | Binary KiB/s | JSON enc+dec (ms per audio-minute) | Binary enc+dec (ms per audio-minute) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20 ms | 100 | 2598 | 1929 | 253.7 | 188.4 | 33.9 | 6.7 |
| 40 ms | 50 | 5158 | 3849 | 251.9 | 187.9 | 27.3 | 5.9 |
| 60 ms | 33.3 | 7718 | 5769 | 251.2 | 187.8 | 18.8 | 2.8 |

Reading the table:

- **Bandwidth:** base64 JSON costs about 35% more bytes than binary. That is roughly 65 KiB/s, about 0.5 Mbit/s, of extra upload for a two-channel interview (2.1 vs 1.5 Mbit/s). A microphone-only session (Linux) halves both numbers.
- **CPU:** the difference is under 30 ms per minute of audio, below 0.1% of one core on either side. CPU is not a reason to change.
- **Batch length** barely changes bytes per second, because the overhead is proportional to the audio. It mainly changes the message rate, at the cost of 20–40 ms of extra latency before audio reaches Deepgram.

## Decision

Keep base64 JSON framing and 20 ms batches for now. Do not add a binary capability yet.

- The gain is bandwidth only, and 2.1 Mbit/s of upload is within what the pilot's target connections should carry. The renderer already drops audio, visibly, past 512 KiB buffered, instead of growing latency.
- A binary capability would add a second audio path to negotiate, validate, replay-protect and test across old/new client combinations, for no latency or CPU gain.
- **Revisit** if real-device measurements (Phase 0/6 gates) show audio being dropped for backpressure on a candidate's normal connection, or if upload bandwidth becomes a pilot complaint. Binary framing, which saves about 26% of upload, would then be the first change to make, ahead of lossy compression.

The Deepgram leg (server to Deepgram) already sends raw PCM bytes and is not affected by this choice.
