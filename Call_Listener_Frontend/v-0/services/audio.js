// services/audio.js
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const { parseCsvLine } = require("../utils/csv.js");
const {
  assertDeviceId,
  assertExecutablePath,
  isSafeDeviceId,
} = require("./audioCommandGuards.js");

class AudioRouteManager {
  /**
   * @param {{ svvPath:string, vbCableInstaller:string, userDataDir:string, logger:Console }} cfg
   */
  constructor(cfg) {
    this.svv = assertExecutablePath(cfg.svvPath, "SoundVolumeView.exe");
    this.vbCableInstaller = cfg.vbCableInstaller;
    this.userDataDir = cfg.userDataDir;
    this.log = cfg.logger || console;

    this.statePath = path.join(this.userDataDir, "audio_state.json");
    this.active = false;
    this.defaultPlaybackCmdId = null;
    this._pollTimer = null;
  }

  isActive() {
    return this.active;
  }

  // --- Helpers ----------------------------------------------------------------

  _readState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch {
      return null;
    }
  }
  _writeState(obj) {
    fs.writeFileSync(this.statePath, JSON.stringify(obj, null, 2));
  }
  _rmState() {
    try {
      fs.unlinkSync(this.statePath);
    } catch {}
  }

  // --- VB-Cable detection -----------------------------------------------------

  async detectVBCable() {
    const stdout = await new Promise((resolve, reject) => {
      execFile(this.svv, ["/scomma"], { windowsHide: true }, (err, out) => {
        if (err) return reject(err);
        resolve(out);
      });
    });

    const lines = String(stdout).split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error("Empty SoundVolumeView output");

    const headers = parseCsvLine(lines[0]);
    const idxName = headers.indexOf("Device Name");
    if (idxName === -1) throw new Error("Missing 'Device Name' column");

    const found = lines.some((line, i) => {
      if (i === 0) return false;
      const cols = parseCsvLine(line);
      return /vb-audio virtual cable/i.test(cols[idxName]);
    });

    this.log.log(
      found ? "[audio] VB-Cable detected" : "[audio] VB-Cable not found"
    );
    return found;
  }

  // --- Default render device --------------------------------------------------

  async _getDefaultRenderCmdId() {
    const tmpFile = path.join(os.tmpdir(), `svv_${Date.now()}.csv`);
    await new Promise((resolve, reject) => {
      execFile(this.svv, ["/scomma", tmpFile], { windowsHide: true }, (err) =>
        err ? reject(err) : resolve()
      );
    });

    let data = "";
    try {
      data = fs.readFileSync(tmpFile, "utf8");
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }

    const lines = data.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) throw new Error("Empty SoundVolumeView export");
    const headers = parseCsvLine(lines[0]);
    const idxDefault = headers.indexOf("Default");
    const idxCmdID = headers.indexOf("Command-Line Friendly ID");
    const idxDeviceName = headers.indexOf("Device Name");
    if (idxDefault === -1 || idxCmdID === -1) {
      throw new Error("Missing expected columns in SVV CSV");
    }

    const defLine = lines.find((line, i) => {
      if (i === 0) return false;
      const cols = parseCsvLine(line);
      return cols[idxDefault]?.trim() === "Render";
    });
    if (!defLine) throw new Error("No default Render device found");

    const cols = parseCsvLine(defLine);
    const cmdId = cols[idxCmdID]?.trim();
    const name = cols[idxDeviceName]?.trim();
    if (!cmdId) throw new Error("Failed to extract Command-Line Friendly ID");

    this.log.log(`[audio] default playback: ${name} (${cmdId})`);
    return assertDeviceId(cmdId);
  }

  // --- Public control ---------------------------------------------------------

  async enable() {
    this.log.log("[audio] enabling VB-Cable routing...");

    const defaultCmdId = await this._getDefaultRenderCmdId();
    this.defaultPlaybackCmdId = defaultCmdId;

    this._writeState({ pendingRestore: true, defaultDevice: defaultCmdId });
    this._startWatchdog(defaultCmdId);

    // listen on cable
    await new Promise((resolve, reject) => {
      execFile(
        this.svv,
        ["/SetListenToThisDevice", "VB-Audio Virtual Cable", "1"],
        { windowsHide: true },
        (err) => (err ? reject(err) : resolve())
      );
    });

    // route through default device
    await new Promise((resolve, reject) => {
      execFile(
        this.svv,
        ["/SetPlaybackThroughDevice", "VB-Audio Virtual Cable", defaultCmdId],
        { windowsHide: true },
        (err) => (err ? reject(err) : resolve())
      );
    });

    this.log.log(`[audio] VB-Cable now monitored through '${defaultCmdId}'`);
    this.active = true;
  }

  async disable() {
    await new Promise((resolve, reject) => {
      execFile(
        this.svv,
        ["/SetListenToThisDevice", "VB-Audio Virtual Cable", "0"],
        { windowsHide: true },
        (err) => (err ? reject(err) : resolve())
      );
    });
    this._rmState();
    this.active = false;
    this.log.log("[audio] VB-Cable monitoring disabled");
  }

  async setDefault(deviceNameOrCmdId) {
    assertDeviceId(deviceNameOrCmdId);
    await new Promise((resolve, reject) => {
      execFile(
        this.svv,
        ["/SetDefault", deviceNameOrCmdId, "all"],
        { windowsHide: true },
        (err) => (err ? reject(err) : resolve())
      );
    });
    this.log.log(`[audio] set default playback: ${deviceNameOrCmdId}`);
  }

  async gracefulExit() {
    this.log.log("[audio] gracefulExit start");
    try {
      const state = this._readState();
      if (this.active && state?.defaultDevice) {
        this.log.log("[audio] restoring default device:", state.defaultDevice);
        await this.setDefault(state.defaultDevice);
      }
      await this.disable().catch(() => {});
    } catch (e) {
      this.log.error("[audio] gracefulExit error:", e);
    } finally {
      this.log.log("[audio] gracefulExit done");
    }
  }

  async recoverIfDirty() {
    const s = this._readState();
    if (s?.pendingRestore && s.defaultDevice && !isSafeDeviceId(s.defaultDevice)) {
      // The state file lives on disk; never pass an unexpected value to SVV.
      this.log.warn("[audio] ignoring invalid saved default device");
      s.defaultDevice = null;
    }
    if (s?.pendingRestore && !s.defaultDevice) {
      await new Promise((resolve) => {
        execFile(
          this.svv,
          ["/SetListenToThisDevice", "VB-Audio Virtual Cable", "0"],
          { windowsHide: true },
          () => {
            this._rmState();
            resolve();
          }
        );
      });
      return;
    }
    if (s?.pendingRestore && s.defaultDevice) {
      this.log.log("[audio] recovering from previous crash...");
      await new Promise((resolve) => {
        execFile(
          this.svv,
          ["/SetDefault", s.defaultDevice, "all"],
          { windowsHide: true },
          () => {
            execFile(
              this.svv,
              ["/SetListenToThisDevice", "VB-Audio Virtual Cable", "0"],
              { windowsHide: true },
              () => {
                this._rmState();
                resolve();
              }
            );
          }
        );
      });
    }
  }

  pollForCable(onDetect, everyMs = 3000) {
    clearInterval(this._pollTimer);
    this._pollTimer = setInterval(async () => {
      try {
        const ok = await this.detectVBCable();
        if (ok) {
          clearInterval(this._pollTimer);
          this._pollTimer = null;
          onDetect?.();
        }
      } catch {
        // ignore transient errors
      }
    }, everyMs);
  }

  // --- Installer --------------------------------------------------------------

  async offerInstall() {
    // This requires 'dialog' from main; use dynamic import to avoid circular require
    const { dialog } = require("electron");
    const ret = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Install", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      title: "VB-Audio Virtual Cable not found",
      message: "VB-CABLE is required to capture system audio.",
      detail: "We'll start the official VB-CABLE installer with admin rights.",
    });
    if (ret.response !== 0) return false;

    let installer;
    try {
      installer = assertExecutablePath(
        this.vbCableInstaller,
        "VBCABLE_Setup_x64.exe"
      );
    } catch (err) {
      dialog.showErrorBox("Installer failed to launch", String(err));
      return false;
    }
    // PowerShell single-quoted literal: only ' needs escaping (as '').
    const quoted = installer.replace(/'/g, "''");
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process -FilePath '${quoted}' -Verb runAs`,
      ],
      { windowsHide: true },
      (err) => {
        if (err) dialog.showErrorBox("Installer failed to launch", String(err));
      }
    );
    return true;
  }

  // --- Watchdog ---------------------------------------------------------------

  _startWatchdog(defaultDevice) {
    // try unpacked path first
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "watchdog.js"
    );
    const asar = path.join(__dirname, "..", "watchdog.js");
    const watchdogPath = fs.existsSync(unpacked) ? unpacked : asar;
    if (!fs.existsSync(watchdogPath)) {
      this.log.warn("[audio] watchdog not found; skipping");
      return;
    }

    // Prefer using the embedded Node runtime Electron ships with:
    const nodeExe = process.execPath; // Electron exe; runs JavaScript too
    const args = [
      watchdogPath,
      String(process.pid),
      assertDeviceId(defaultDevice),
      this.svv,
    ];

    try {
      const child = spawn(nodeExe, args, {
        // Without this, a packaged Electron executable starts a second app
        // instance (which the single-instance lock quits) instead of running
        // watchdog.js, so crash restoration never happens.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      this.log.log("[audio] watchdog started");
    } catch (e) {
      this.log.warn("[audio] watchdog spawn failed:", e);
    }
  }
}

module.exports = { AudioRouteManager };
