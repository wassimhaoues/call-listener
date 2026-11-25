const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const SVV_ZIP_URL_X64 = "https://www.nirsoft.net/utils/soundvolumeview-x64.zip";
const SVV_ZIP_URL_X86 = "https://www.nirsoft.net/utils/soundvolumeview.zip";

/**
 * Download with progress callback and AbortSignal.
 */
function downloadFile(url, dest, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
      let done = 0;
      res.on("data", (chunk) => {
        done += chunk.length;
        if (onProgress && total)
          onProgress({ done, total, percent: (done / total) * 100 });
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(dest)));
    });
    req.on("error", (err) => {
      file.close();
      fs.unlink(dest, () => reject(err));
    });
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        req.destroy();
        return reject(new Error("ABORTED"));
      }
      signal.addEventListener("abort", () => {
        aborted = true;
        try {
          req.destroy();
        } catch {}
        try {
          file.close();
        } catch {}
        fs.unlink(dest, () => reject(new Error("ABORTED")));
      });
    }
  });
}

function extractZipWithPowershell(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const ps =
      `powershell -NoProfile -Command "` +
      `$ErrorActionPreference='Stop'; ` +
      `New-Item -ItemType Directory -Force -Path '${destDir.replace(
        /'/g,
        "''"
      )}'; ` +
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' ` +
      `-DestinationPath '${destDir.replace(/'/g, "''")}' -Force; "`;
    exec(ps, { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(stderr || String(err)));
      resolve();
    });
  });
}

async function installSVVWithProgress(destDir, { onDownload, signal } = {}) {
  const arch =
    process.arch === "x64" || process.env.PROCESSOR_ARCHITEW6432
      ? "x64"
      : "x86";
  const url = arch === "x64" ? SVV_ZIP_URL_X64 : SVV_ZIP_URL_X86;
  const tmpZip = path.join(os.tmpdir(), `svv_${Date.now()}.zip`);
  try {
    await downloadFile(url, tmpZip, { onProgress: onDownload, signal });
    await extractZipWithPowershell(tmpZip, destDir);
    let resolved = path.join(destDir, "SoundVolumeView.exe");
    if (!fs.existsSync(resolved)) {
      for (const e of fs.readdirSync(destDir, { withFileTypes: true })) {
        if (e.isFile() && e.name.toLowerCase() === "soundvolumeview.exe") {
          resolved = path.join(destDir, e.name);
          break;
        }
        if (e.isDirectory()) {
          const maybe = path.join(destDir, e.name, "SoundVolumeView.exe");
          if (fs.existsSync(maybe)) {
            resolved = maybe;
            break;
          }
        }
      }
    }
    if (!fs.existsSync(resolved))
      throw new Error("Extracted, but SoundVolumeView.exe not found.");
    return resolved;
  } finally {
    try {
      fs.unlinkSync(tmpZip);
    } catch {}
  }
}

module.exports = { installSVVWithProgress };
