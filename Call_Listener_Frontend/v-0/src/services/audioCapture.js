// Pure helpers for live audio capture: device validation, getUserMedia
// constraints, level metering, and the ScriptProcessor PCM16 fallback.

export const CAPTURE_SAMPLE_RATE = 48000;
export const SILENT_DB_LABEL = "–∞ dB";
export const SILENT_LEVEL = Object.freeze({ db: SILENT_DB_LABEL, pct: 0 });
const METER_FLOOR_DB = -60;

export function getDeviceSelectionError({ micId, sysId, systemAudioEnabled }) {
  if (!micId || (systemAudioEnabled && !sysId)) {
    return "Missing device selections.";
  }
  if (systemAudioEnabled && micId === sysId) {
    return "Microphone and system audio devices must be different.";
  }
  return null;
}

// The candidate microphone keeps browser voice processing; the interviewer
// (system) loopback must stay unprocessed.
export function microphoneConstraints(deviceId) {
  return {
    audio: {
      deviceId: { exact: deviceId },
      channelCount: 1,
      sampleRate: CAPTURE_SAMPLE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

export function systemAudioConstraints(deviceId) {
  return {
    audio: {
      deviceId: { exact: deviceId },
      channelCount: 1,
      sampleRate: CAPTURE_SAMPLE_RATE,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };
}

export function rmsToDb(rms) {
  return !rms || rms <= 1e-7 ? -Infinity : 20 * Math.log10(rms);
}

export function dbToPct(db) {
  if (db === -Infinity) return 0;
  const clamped = Math.max(METER_FLOOR_DB, Math.min(0, db));
  return ((clamped - METER_FLOOR_DB) / (0 - METER_FLOOR_DB)) * 100;
}

export function rmsToLevel(rms) {
  const db = rmsToDb(rms);
  return {
    db: db === -Infinity ? SILENT_DB_LABEL : `${db.toFixed(1)} dB`,
    pct: dbToPct(db),
  };
}

// Same conversion as the AudioWorklet: clamp to [-1, 1], scale to PCM16.
export function floatToPcm16(input) {
  const len = input.length;
  const pcm = new Int16Array(len);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    sum += s * s;
    pcm[i] = (s * 0x7fff) | 0;
  }
  return { pcm, rms: Math.sqrt(sum / len) };
}
