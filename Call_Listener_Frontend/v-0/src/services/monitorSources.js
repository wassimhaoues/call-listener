// Pure helpers for Linux PipeWire/PulseAudio monitor sources.
//
// PulseAudio, and PipeWire through pipewire-pulse, create a "monitor" source
// for every output device. When such a source reaches the renderer as an
// ordinary `audioinput` device, the only portable signal is its label:
//
// - "Monitor of Built-in Audio Analog Stereo" (sound-server description).
// - "Default - Monitor of …" (Chromium's virtual default entry).
// - "Remapped Monitor of …" (a module-remap-source the user created).
// - "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor" (raw source name, shown
//   when no description is available).
//
// Exposure caveat: Chromium's PulseAudio backend leaves real monitor sources
// out of enumerateDevices(). A local probe (Electron 44, PipeWire 1.0.5,
// Ubuntu X11) listed only the microphones, so on a stock setup Setup reports
// that no monitor was found. A monitor appears only when the system exposes it
// as a regular input (for example a remapped source).
//
// Locale caveat: the sound server translates "Monitor of" (for example
// "Monitor von" in German or "Moniteur de" in French). Only the English
// description and the locale-independent ".monitor" source name are recognised.
// A translated monitor is not offered as interviewer audio, but it can appear
// in the microphone list under its translated name. The default microphone
// is the first listed input (normally Chromium's "Default"), never a
// recognised monitor. Labels are empty until the page has media permission;
// callers must check `hasDeviceLabels()` first.

const MONITOR_DESCRIPTION = /\bmonitor of\s\S/i;
const MONITOR_SOURCE_NAME = /\.monitor$/i;
// Chromium's virtual entries mirror another device; never treat them as a
// distinct monitor.
const VIRTUAL_DEVICE_IDS = new Set(["default", "communications"]);

export function isMonitorSourceLabel(label) {
  if (typeof label !== "string") return false;
  const trimmed = label.trim();
  return MONITOR_DESCRIPTION.test(trimmed) || MONITOR_SOURCE_NAME.test(trimmed);
}

function isAudioInput(device) {
  return device?.kind === "audioinput" && typeof device.deviceId === "string" && device.deviceId !== "";
}

export function isMonitorSource(device) {
  return (
    isAudioInput(device) &&
    !VIRTUAL_DEVICE_IDS.has(device.deviceId) &&
    isMonitorSourceLabel(device.label)
  );
}

// True when at least one audio input carries a label, i.e. the page already
// has media permission and monitor sources can be identified.
export function hasDeviceLabels(devices) {
  return (devices || []).some((device) => isAudioInput(device) && Boolean(device.label));
}

// Splits enumerateDevices() output into candidate microphones and monitor
// sources. A monitor is never offered as a microphone, so system output can
// never be labelled as the candidate.
export function partitionAudioInputs(devices) {
  const microphones = [];
  const monitors = [];
  for (const device of devices || []) {
    if (!isAudioInput(device)) continue;
    if (isMonitorSource(device)) monitors.push(device);
    else if (!isMonitorSourceLabel(device.label)) microphones.push(device);
  }
  return { microphones, monitors };
}
