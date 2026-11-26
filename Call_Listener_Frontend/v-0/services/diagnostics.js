// services/diagnostics.js
//
// Pure builder for the renderer diagnostics page. It whitelists fields and
// maps error codes to fixed copy, so no host identifier (hostname, username,
// installation ID, home/user paths, IP addresses) or raw error message can
// reach the renderer. Inputs are passed in; nothing is read from the host here.

const OS_FAMILIES = { win32: "Windows", linux: "Linux", darwin: "macOS" };

const CAPTURE_STRATEGIES = {
  "system-and-microphone": "System audio and microphone (VB-Cable)",
  "microphone-only": "Microphone only",
  unavailable: "Unavailable",
};

// Fixed, actionable copy per error code. Unknown codes fall back to a generic
// entry rather than echoing the code's source text.
const ERROR_CATALOG = {
  "unsupported-platform": {
    severity: "error",
    message: "This operating system is not supported.",
    action: "Use Windows, or Ubuntu 24.04 for the Linux preview.",
  },
  "sound-tool-missing": {
    severity: "error",
    message: "SoundVolumeView is missing, so system audio cannot be routed.",
    action: "Restart the app and accept the SoundVolumeView download.",
  },
  "vb-cable-missing": {
    severity: "error",
    message: "VB-Audio Virtual Cable was not detected.",
    action: "Install VB-CABLE (administrator rights required), then wait on the Audio Device Check page.",
  },
  "startup-failed": {
    severity: "error",
    message: "Audio routing could not be prepared at startup.",
    action: "Check that VB-CABLE is installed and enabled in Windows Sound settings, then restart the app.",
  },
  "routing-failed": {
    severity: "warning",
    message: "Changing audio routing failed.",
    action: "Use the tray menu to start routing again, or restart the app.",
  },
  "stream-stop-failed": {
    severity: "warning",
    message: "An audio stream did not stop cleanly.",
    action: "Restart the app if the microphone indicator stays on.",
  },
  "system-audio-unavailable": {
    severity: "info",
    message: "Interviewer (system) audio capture is not available on Linux yet.",
    action: "Continue in microphone-only mode and type the interviewer's questions.",
  },
};

const UNKNOWN_ERROR = {
  severity: "warning",
  message: "An unexpected audio error occurred.",
  action: "Restart the app. If it persists, report it with this screen's details.",
};

const SAFE_TOKEN = /^[a-z0-9][a-z0-9.+-]{0,63}$/i;

/** Keep only short machine tokens (versions, enum values); drop anything else. */
function safeToken(value, fallback = "unknown") {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : fallback;
}

function detectDisplayServer(platform, env = {}) {
  if (platform !== "linux") return "n/a";
  const session = String(env.XDG_SESSION_TYPE || "").toLowerCase();
  if (session === "wayland" || session === "x11") return session;
  if (env.WAYLAND_DISPLAY) return "wayland";
  if (env.DISPLAY) return "x11";
  return "unknown";
}

function describeError(code) {
  const entry = ERROR_CATALOG[code] || UNKNOWN_ERROR;
  return { code: ERROR_CATALOG[code] ? code : "unknown", ...entry };
}

/**
 * @param {object} input
 * @param {string} input.platform        process.platform
 * @param {string} [input.arch]          process.arch
 * @param {object} [input.env]           environment (only display vars are read)
 * @param {object} input.capabilities    getPlatformCapabilities() result
 * @param {object} input.audio           platformAudio.describe() result
 * @param {string} [input.appVersion]
 * @param {string} [input.electronVersion]
 */
function buildDiagnostics({
  platform,
  arch,
  env,
  capabilities,
  audio = {},
  appVersion,
  electronVersion,
} = {}) {
  const appSupported = Boolean(capabilities?.appSupported);
  const strategyKey = CAPTURE_STRATEGIES[audio.captureStrategy]
    ? audio.captureStrategy
    : "unavailable";

  const codes = [];
  if (!appSupported) codes.push("unsupported-platform");
  if (audio.lastErrorCode && !codes.includes(audio.lastErrorCode)) {
    codes.push(audio.lastErrorCode);
  }
  if (appSupported && strategyKey === "microphone-only") {
    codes.push("system-audio-unavailable");
  }

  return {
    os: {
      family: OS_FAMILIES[platform] || "Other",
      arch: safeToken(arch),
      supported: appSupported,
    },
    displayServer: detectDisplayServer(platform, env),
    capture: {
      strategy: strategyKey,
      label: CAPTURE_STRATEGIES[strategyKey],
      systemAudio: Boolean(audio.systemAudioAvailable),
    },
    audioAdapter: {
      kind: safeToken(audio.kind),
      state: safeToken(audio.state),
      controlsOsRouting: Boolean(audio.controlsOsRouting),
      routingActive: Boolean(audio.routingActive),
    },
    versions: {
      app: safeToken(appVersion),
      electron: safeToken(electronVersion),
    },
    errors: codes.map(describeError),
  };
}

module.exports = { buildDiagnostics, detectDisplayServer, ERROR_CATALOG };
