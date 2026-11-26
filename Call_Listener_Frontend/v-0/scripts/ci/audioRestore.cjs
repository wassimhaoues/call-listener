// Windows-only audio restoration check, driven against real SoundVolumeView
// and VB-Cable on a CI runner. Run with the Electron binary in node mode so
// process.execPath matches the packaged app:
//   ELECTRON_RUN_AS_NODE=1 electron scripts/ci/audioRestore.cjs <svvPath> <outDir>
//
// Scenarios:
//   1. enable() then gracefulExit() restores the default device, disables
//      "listen to this device", and removes the pending-restore state file.
//   2. A process that enabled routing is killed (crash); the detached
//      watchdog must restore audio. The child clears ELECTRON_RUN_AS_NODE so
//      the watchdog spawn path behaves as it does in the packaged app.
//   3. recoverIfDirty() on next start clears any leftover pending state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
// In node mode Electron may not define resourcesPath; audio.js joins it when
// locating an unpacked watchdog, then falls back to the source watchdog.js.
if (!process.resourcesPath) process.resourcesPath = os.tmpdir();
const { AudioRouteManager } = require("../../services/audio.js");
const { parseCsvLine } = require("../../utils/csv.js");

const LISTEN_PROPERTY = "{24dbb0fc-9311-4b3d-9cf0-18ff155639d4},1";
const CABLE = /vb-audio virtual cable/i;

const svvPath = path.resolve(process.argv[2] || "bin/SoundVolumeView.exe");
const outDir = path.resolve(process.argv[3] || "ci-audio-results");
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeManager(userDataDir) {
  return new AudioRouteManager({
    svvPath,
    vbCableInstaller: "",
    userDataDir,
    logger: console,
  });
}

function exportDevices() {
  const csv = path.join(os.tmpdir(), `svv_check_${Date.now()}.csv`);
  execFileSync(svvPath, ["/scomma", csv], { windowsHide: true });
  const lines = fs.readFileSync(csv, "utf8").split(/\r?\n/).filter(Boolean);
  fs.unlinkSync(csv);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, cols[i]]));
  });
}

/** Returns true/false for the cable capture endpoint's listen flag, or null if unreadable. */
function readListenState() {
  const capture = exportDevices().find(
    (d) =>
      d.Type === "Device" &&
      d.Direction === "Capture" &&
      CABLE.test(d["Device Name"] || "")
  );
  const key = capture?.["Registry Key"];
  if (!key) return null;
  try {
    const out = execFileSync(
      "reg",
      ["query", `${key}\\Properties`, "/v", LISTEN_PROPERTY],
      { encoding: "utf8", windowsHide: true }
    );
    const hex = out.match(/REG_BINARY\s+([0-9A-F]+)/i)?.[1];
    if (!hex || hex.length < 20) return null;
    // PROPVARIANT VT_BOOL: value lives at byte offset 8 (0xFFFF = true).
    return hex.slice(16, 20).toUpperCase() === "FFFF";
  } catch {
    return null;
  }
}

async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack || error) });
    console.error(`FAIL ${name}\n${error?.stack || error}`);
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runCrashChild(userDataDir) {
  const childEnv = { ...process.env, CRASH_CHILD: "1" };
  const child = spawn(process.execPath, [__filename, svvPath, outDir, userDataDir], {
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const statePath = path.join(userDataDir, "audio_state.json");
  await waitFor(() => fs.existsSync(statePath), 30000, "child to enable routing");
  await waitFor(() => readListenState() === true, 15000, "listen to turn on in child");
  const killedAt = Date.now();
  child.kill(); // TerminateProcess on Windows: no cleanup handlers run.
  await new Promise((resolve) => child.once("exit", resolve));
  return killedAt;
}

async function crashChildMain() {
  // Match the packaged app: Electron is not in node mode for its own children.
  delete process.env.ELECTRON_RUN_AS_NODE;
  const mgr = makeManager(process.argv[4]);
  await mgr.enable();
  console.log("[child] routing enabled; waiting to be killed");
  setInterval(() => {}, 1000);
}

async function main() {
  const devices = exportDevices().filter((d) => d.Type === "Device");
  fs.writeFileSync(path.join(outDir, "devices.json"), JSON.stringify(devices, null, 2));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "call-listener-audio-"));
  const statePath = path.join(userDataDir, "audio_state.json");
  const mgr = makeManager(userDataDir);
  let originalDefault;

  await scenario("VB-Cable is detected", async () => {
    assert.equal(await mgr.detectVBCable(), true);
    originalDefault = await mgr._getDefaultRenderCmdId();
    console.log(`listen state before tests: ${readListenState()}`);
  });

  await scenario("graceful exit restores routing", async () => {
    await mgr.enable();
    assert.equal(fs.existsSync(statePath), true, "pending-restore state written");
    await waitFor(() => readListenState() === true, 15000, "listen to turn on");
    await mgr.gracefulExit();
    assert.equal(fs.existsSync(statePath), false, "state file removed");
    assert.equal(await mgr._getDefaultRenderCmdId(), originalDefault);
    assert.equal(readListenState(), false, "listen disabled after exit");
  });

  await scenario("watchdog restores routing after a crash", async () => {
    const killedAt = await runCrashChild(userDataDir);
    await waitFor(() => readListenState() === false, 15000, "watchdog to disable listen");
    console.log(`watchdog restored listen ${Date.now() - killedAt} ms after crash`);
    assert.equal(await mgr._getDefaultRenderCmdId(), originalDefault);
  });

  await scenario("recoverIfDirty clears leftover state", async () => {
    if (!fs.existsSync(statePath)) {
      fs.writeFileSync(
        statePath,
        JSON.stringify({ pendingRestore: true, defaultDevice: originalDefault })
      );
    }
    await makeManager(userDataDir).recoverIfDirty();
    assert.equal(fs.existsSync(statePath), false);
    const listenAfter = readListenState();
    if (listenAfter !== null) assert.equal(listenAfter, false);
  });

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} audio scenarios passed`);
  process.exit(failed.length ? 1 : 0);
}

if (process.env.CRASH_CHILD === "1") {
  crashChildMain().catch((error) => {
    console.error(error);
    process.exit(2);
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
