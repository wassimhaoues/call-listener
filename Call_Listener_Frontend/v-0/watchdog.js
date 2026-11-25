// watchdog.js
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const mainPid = parseInt(process.argv[2], 10);
const defaultDevice = process.argv[3];
const svv = process.argv[4];

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
