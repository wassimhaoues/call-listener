// watchdog.js
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const mainPid = Number.parseInt(process.argv[2], 10);
const svv = process.argv[4];
// Kept self-contained: this file runs unpacked, outside app.asar.
function isSafeArg(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/^[/-]/.test(value) &&
    !/["\u0000-\u001f]/.test(value)
  );
}
const defaultDevice = isSafeArg(process.argv[3]) ? process.argv[3] : null;
if (
  !Number.isInteger(mainPid) ||
  typeof svv !== "string" ||
  !path.isAbsolute(svv) ||
  path.basename(svv).toLowerCase() !== "soundvolumeview.exe"
) {
  process.exit(1);
}

// Log to userData\watchdog.log if available
let logPath = "watchdog.log";
try {
  const userData = require("electron").app.getPath("userData");
  logPath = path.join(userData, "watchdog.log");
} catch {
  // electron not available in this context; fallback to CWD
}
try {
  fs.appendFileSync(
    logPath,
    `[${new Date().toISOString()}] Watchdog started for PID ${mainPid}\n`
  );
} catch {}

function restoreAudio() {
  if (defaultDevice) {
    execFile(svv, ["/SetDefault", defaultDevice, "all"], { windowsHide: true });
  }
  execFile(svv, ["/SetListenToThisDevice", "VB-Audio Virtual Cable", "0"], {
    windowsHide: true,
  });
  setTimeout(() => process.exit(0), 1000);
}

// check every 3 seconds whether main process still alive
const interval = setInterval(() => {
  try {
    process.kill(mainPid, 0); // throws if dead
  } catch {
    clearInterval(interval);
    restoreAudio();
  }
}, 3000);

process.on("exit", () => clearInterval(interval));
