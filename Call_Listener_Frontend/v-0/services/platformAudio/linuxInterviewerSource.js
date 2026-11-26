// services/platformAudio/linuxInterviewerSource.js
//
// Chromium's PulseAudio backend hides real monitor sources, so on a stock
// PipeWire/PulseAudio desktop the app cannot see "Monitor of <speakers>".
// At app startup (and again on request) this module loads one module-remap-source
// that mirrors the monitor of the current default output. The sound server
// lists it as an ordinary input, so Setup can offer it as interviewer audio.
//
// It changes nothing else: the default input and output stay as they are, and
// only a module carrying our own source name is ever unloaded (on exit, or at
// startup after a crash).
const { execFile } = require("node:child_process");
const fs = require("node:fs");

const SOURCE_NAME = "call_listener_interviewer";
// Setup recognises this label through its "Monitor of …" pattern.
const SOURCE_LABEL = "Monitor of system output (Call Listener)";
const COMMAND_TIMEOUT_MS = 5_000;
// PulseAudio/PipeWire node names: no spaces or quotes, so they cannot break
// out of the module argument.
const SINK_NAME = /^[\w.:@+-]{1,200}$/;

// pactl is run from a fixed system directory, never looked up through PATH.
const PACTL_PATHS = ["/usr/bin/pactl", "/bin/pactl"];

function findPactl(exists = fs.existsSync) {
  return PACTL_PATHS.find((candidate) => exists(candidate)) || null;
}

function runPactl(args) {
  const pactl = findPactl();
  if (!pactl) return Promise.reject(Object.assign(new Error("pactl not found"), { code: "ENOENT" }));
  return new Promise((resolve, reject) => {
    execFile(pactl, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

function errorCode(error) {
  return error?.code === "ENOENT" ? "pactl-unavailable" : "pactl-failed";
}

/** IDs of loaded modules that carry our source name. */
function ownModuleIds(shortModules) {
  return shortModules
    .split("\n")
    .filter((line) => line.includes("module-remap-source") && line.includes(`source_name=${SOURCE_NAME}`))
    .map((line) => line.split("\t")[0].trim())
    .filter((id) => /^\d+$/.test(id));
}

function createLinuxInterviewerSource({ run = runPactl, logger = console } = {}) {
  async function unloadOwn() {
    const ids = ownModuleIds(await run(["list", "short", "modules"]));
    await Promise.all(ids.map((id) => run(["unload-module", id])));
    return ids.length;
  }

  return {
    sourceLabel: SOURCE_LABEL,

    /**
     * Create (or re-create, to follow the current default output) the
     * interviewer source. Resolves { ok: true, label } or { ok: false, code }.
     */
    async create() {
      try {
        const sink = (await run(["get-default-sink"])).trim();
        if (!SINK_NAME.test(sink)) return { ok: false, code: "no-default-output" };
        await unloadOwn();
        const description = String.raw`\"${SOURCE_LABEL}\"`;
        await run([
          "load-module",
          "module-remap-source",
          `master=${sink}.monitor`,
          `source_name=${SOURCE_NAME}`,
          `source_properties="node.description=${description} device.description=${description}"`,
        ]);
        return { ok: true, label: SOURCE_LABEL };
      } catch (error) {
        const code = errorCode(error);
        logger.warn?.(`[audio] interviewer source could not be created (${code})`);
        return { ok: false, code };
      }
    },

    /** Remove our source if present. Never throws. */
    async remove() {
      try {
        return { ok: true, removed: await unloadOwn() };
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
    },
  };
}

module.exports = { createLinuxInterviewerSource, findPactl, ownModuleIds, SOURCE_NAME, SOURCE_LABEL };
