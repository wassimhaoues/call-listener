/**
 * Map platform probes to renderer-safe capture capabilities.
 *
 * The main process supplies probes later; this module deliberately performs no
 * shell commands and never changes an operating-system audio setting.
 */
function getPlatformCapabilities({
  platform = process.platform,
  hasPipeWire = false,
  hasDisplayServer = false,
} = {}) {
  if (platform === "win32") {
    return {
      appSupported: true,
      systemAudio: {
        supported: true,
        strategy: "vb-cable",
        requiresCandidateConsent: false,
      },
    };
  }

  if (platform === "linux") {
    const desktopAudioReady = hasPipeWire && hasDisplayServer;
    return {
      appSupported: true,
      systemAudio: {
        supported: desktopAudioReady,
        strategy: desktopAudioReady ? "pipewire-desktop" : "unavailable",
        fallback: "monitor-source",
        requiresCandidateConsent: true,
      },
    };
  }

  return {
    appSupported: false,
    systemAudio: {
      supported: false,
      strategy: "unavailable",
    },
  };
}

module.exports = { getPlatformCapabilities };
