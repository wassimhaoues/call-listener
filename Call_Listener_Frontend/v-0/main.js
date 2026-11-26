// main.js
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const https = require("https");
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  dialog,
  powerMonitor,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const { autoUpdater } = require("electron-updater");

// ---- Runtime flags & paths ---------------------------------------------------
const isDev = process.env.NODE_ENV === "development" && !app.isPackaged;
const gotLock = app.requestSingleInstanceLock();

const APP_ID = "com.coworky.calllistener";
const BACKEND_HOST = process.env.CALL_HOST || (isDev ? "127.0.0.1" : "call.coworky.org");
const BACKEND_PROTOCOL = process.env.CALL_PROTOCOL || (isDev ? "http" : "https");
const BACKEND_PORT = Number(process.env.CALL_PORT || (isDev ? 3000 : 443));
const WS_PROTOCOL = process.env.CALL_WS_PROTOCOL || (isDev ? "ws" : "wss");
const WS_PORT = Number(process.env.CALL_WS_PORT || (isDev ? 4000 : 443));
const ELECTRON_KEY = process.env.ELECTRON_KEY || "dev-electron-only";
const userDataDir = app.getPath("userData");

const getAssetPath = (...p) =>
  isDev ? path.join(__dirname, ...p) : path.join(process.resourcesPath, ...p);

let svvPath = getAssetPath("bin", "SoundVolumeView.exe");
const userBinDir = isDev
  ? path.join(__dirname, "bin")
  : path.join(process.resourcesPath, "bin");
console.log("[paths] svvPath:", svvPath);
console.log("[paths] userBinDir:", userBinDir);

const vbCableInstaller = getAssetPath(
  "bin",
  "VB_Cable",
  "VBCABLE_Setup_x64.exe"
);
const iconPng = getAssetPath("icon.png");
const trayIco = getAssetPath("tray.ico");

// ---- Services ---------------------------------------------------------------
const { AuthManager } = require("./services/auth");
const { AudioRouteManager } = require("./services/audio");
const { hardenSessionSecurity } = require("./services/security");
const { makeTrayTemplate } = require("./services/tray");
const { installSVVWithProgress } = require("./services/SoundVolumeInstaller");
const { createProgressWindow } = require("./services/progressWindow");
const { getPlatformCapabilities } = require("./services/platformCapabilities");
const { getOrCreateInstallationId } = require("./services/installationId");
// ---- Globals (main process) --------------------------------------------------
let mainWindow = null;
let tray = null;
let quitting = false;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function findAsset(relPath) {
  const tries = [
    path.join(__dirname, relPath), // inside app.asar
    path.join(process.resourcesPath, relPath), // extraResources
    path.join(__dirname, "build", relPath), // dev build folder
  ];
  for (const p of tries) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}
function resolveResource(relPath) {
  const devPath = path.join(__dirname, "build", relPath); // dev
  const prodPath = path.join(process.resourcesPath, relPath); // prod
  return fs.existsSync(prodPath) ? prodPath : devPath;
}
// --- NEW: SPA routing helper (HashRouter) ------------------------------------
async function gotoRoute(route = "/") {
  if (!mainWindow) return;
  if (isDev) {
    await mainWindow.loadURL(`http://127.0.0.1:5173/#${route}`);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
    await mainWindow.webContents.executeJavaScript(
      `location.hash = "${route}"`
    );
  }
}
async function ensureSVVPresentWithUI(parentWindow) {
  // Already present?
  if (svvPath && fs.existsSync(svvPath)) return svvPath;
  const svvUserPath = path.join(userBinDir, "SoundVolumeView.exe");
  if (fs.existsSync(svvUserPath)) {
    svvPath = svvUserPath;
    return svvPath;
  }

  // Ask to download
  const { response } = await dialog.showMessageBox(parentWindow, {
    type: "warning",
    buttons: ["Download & Install", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "SoundVolumeView is required",
    message: "SoundVolumeView is needed to route and monitor system audio.",
    detail:
      "We can download it now from NirSoft and install it to your user profile.",
  });
  if (response !== 0) {
    app.quit();
    return;
  }

  // Progress UI
  const pw = createProgressWindow(parentWindow);
  const abortCtrl = new AbortController();
  let closed = false;

  pw.onCancel(() => {
    if (!closed) abortCtrl.abort();
  });

  try {
    pw.setStatus({
      title: "Downloading…",
      detail: "Fetching SoundVolumeView.zip",
      percent: 0,
    });
    const installedPath = await installSVVWithProgress(userBinDir, {
      signal: abortCtrl.signal,
      onDownload: ({ percent, done, total }) => {
        pw.setStatus({
          title: "Downloading…",
          detail: total
            ? `Downloaded ${(done / 1024 / 1024).toFixed(1)} / ${(
                total /
                1024 /
                1024
              ).toFixed(1)} MB`
            : "Downloading…",
          percent: total ? percent : undefined,
        });
      },
    });

    pw.setStatus({
      title: "Extracting…",
      detail: "Unpacking files…",
      indeterminate: true,
    });

    svvPath = installedPath;
    pw.close();
    closed = true;

    const { response: r2 } = await dialog.showMessageBox(parentWindow, {
      type: "info",
      buttons: ["Restart now", "Continue"],
      defaultId: 0,
      cancelId: 1,
      title: "SoundVolumeView installed",
      message: "Installation complete.",
      detail:
        "Restart is recommended to ensure the new tool is fully picked up.",
    });
    if (r2 === 0) {
      app.relaunch();
      app.exit(0);
      return;
    }
    return svvPath;
  } catch (e) {
    pw.close();
    closed = true;
    if (e && e.message === "ABORTED") {
      await dialog.showMessageBox(parentWindow, {
        type: "warning",
        buttons: ["OK"],
        title: "Installation cancelled",
        message: "The application will now exit.",
      });
      app.quit();
      return;
    }
    await dialog.showMessageBox(parentWindow, {
      type: "error",
      buttons: ["OK"],
      title: "Install failed",
      message: "Could not install SoundVolumeView.",
      detail: String(e?.message || e),
    });
    app.quit();
  }
}
async function quitApp(audioMgr) {
  if (quitting) return;
  quitting = true;
  app.isQuiting = true;
  try {
    await audioMgr?.gracefulExit();
  } catch (e) {
    console.error("[quitApp] gracefulExit error:", e);
  } finally {
    app.quit();
  }
}
async function createWindow(authMgr, audioMgr, capabilities) {
  console.log(isDev ? "[boot] dev mode" : "[boot] production mode");

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    backgroundColor: "#ffffff",
    resizable: true,
    minimizable: true,
    maximizable: true,
    autoHideMenuBar: !isDev,
    icon: resolveResource("icon.png") || iconPng,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: isDev,
    },
  });

  // close-to-tray behavior
  mainWindow.on("close", (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Lock down devtools/context menu in production
  if (!isDev) {
    mainWindow.removeMenu();
    mainWindow.webContents.on("before-input-event", (event, input) => {
      const isToggle =
        input.type === "keyDown" &&
        (input.key === "F12" ||
          (input.control && input.shift && input.key.toUpperCase() === "I"));
      if (isToggle) event.preventDefault();
    });
    mainWindow.webContents.on("devtools-opened", () => {
      mainWindow.webContents.closeDevTools();
    });
    mainWindow.webContents.on("context-menu", (e) => e.preventDefault());
  }

  // External link hardening
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  mainWindow.webContents.setZoomFactor(1);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (
      !url.startsWith("http://127.0.0.1:5173") &&
      !url.startsWith("file://")
    ) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  // ---- Renderer-safe APIs ----------------------------------------------------
  ipcMain.handle("auth:getWsUrl", async () => authMgr.makeSignedWsUrl());
  ipcMain.handle("platform:getCapabilities", () => capabilities);
  ipcMain.handle("models:list", async () => {
    try {
      return await authMgr.fetchModels();
    } catch (e) {
      console.error("[models] catalog fetch failed:", e?.message || e);
      return null;
    }
  });

  // ---- Auth gate (do NOT expose token to renderer) --------------------------
  try {
    await authMgr.ensure();
  } catch (e) {
    console.error("[auth] token fetch failed:", e);
    await gotoRoute("/autherror"); // <<<< replaced
    return;
  }

  // ---- Platform gate --------------------------------------------------------
  if (!capabilities.appSupported) {
    console.log("[gate] unsupported platform:", process.platform);
    await gotoRoute("/unsupported");
    return;
  }

  // Linux reaches the candidate workspace in microphone-only mode until the
  // PipeWire desktop-audio route has passed its explicit capture qualification.
  if (process.platform !== "win32") {
    await gotoRoute("/");
    return;
  }

  // ---- Audio gate -----------------------------------------------------------
  try {
    await audioMgr.recoverIfDirty(); // restore if previous crash
    const cableOk = await audioMgr.detectVBCable();
    if (!cableOk) {
      console.warn(
        "[audio] VB-Cable not detected; offering install and polling..."
      );
      await gotoRoute("/novbcable"); // <<<< replaced
      audioMgr.offerInstall(); // non-blocking
      audioMgr.pollForCable(async () => {
        await audioMgr.enable();
        await audioMgr.setDefault(
          "VB-Audio Virtual Cable\\Device\\CABLE Input\\Render"
        );
        await gotoRoute("/"); // <<<< enter app once cable appears
      }, 3000);
      return;
    }

    await audioMgr.enable();
    await audioMgr.setDefault(
      "VB-Audio Virtual Cable\\Device\\CABLE Input\\Render"
    );

    await gotoRoute("/"); // <<<< normal entry
  } catch (e) {
    console.error("[audio] startup error:", e);
    await gotoRoute("/novbcable"); // <<<< replaced
  }
}
function createTray(audioMgr) {
  try {
    let trayPath =
      findAsset("tray.ico") ||
      findAsset("build/icon.ico") ||
      findAsset("icon.png");
    let img = trayPath ? nativeImage.createFromPath(trayPath) : null;
    if (!img || img.isEmpty()) {
      console.warn(
        "[tray] No valid tray icon found; skipping tray to avoid crash."
      );
      return; // do not create the tray; keep the app running
    }

    tray = new Tray(img);
    tray.setToolTip("Call Listener");
    tray.setContextMenu(
      Menu.buildFromTemplate(
        makeTrayTemplate({
          isActive: () => audioMgr.isActive(),
          onOpen: () => mainWindow?.show(),
          onToggleRouting: async () => {
            if (audioMgr.isActive()) await audioMgr.disable();
            else await audioMgr.enable();
            tray?.setContextMenu(
              Menu.buildFromTemplate(
                makeTrayTemplate({
                  isActive: () => audioMgr.isActive(),
                  onOpen: () => mainWindow?.show(),
                  onToggleRouting: async () => {
                    if (audioMgr.isActive()) await audioMgr.disable();
                    else await audioMgr.enable();
                  },
                  onQuit: () => quitApp(audioMgr),
                })
              )
            );
          },
          onQuit: () => quitApp(audioMgr),
        })
      )
    );
    tray.on("click", () => mainWindow?.show());
  } catch (e) {
    console.error("[tray] creation failed:", e);
    // Don’t crash the app — just run without a tray
  }
}
// ---- App bootstrap ----------------------------------------------------------
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

if (isDev) {
  process.on("SIGINT", () => quitApp(audioMgrRef));
  process.on("SIGTERM", () => quitApp(audioMgrRef));
}

// Harden session immediately on ready
let audioMgrRef = null;
app.whenReady().then(async () => {
  // Auto-update signal
  try {
    if (app.isPackaged) {
      const updCfg = path.join(process.resourcesPath, "app-update.yml");
      if (fs.existsSync(updCfg)) {
        autoUpdater.autoDownload = true;
        autoUpdater.checkForUpdatesAndNotify().catch((e) => {
          console.warn("[updates] check skipped:", e?.message || e);
        });
      } else {
        console.log("[updates] no app-update.yml → skipping updater");
      }
    }
  } catch (e) {
    console.warn("[updates] disabled:", e?.message || e);
  }
  // Security
  hardenSessionSecurity(session.defaultSession, {
    isDev,
    devKey: ELECTRON_KEY,
    devOrigin: "http://127.0.0.1:5173",
    prodWsOrigins: [`https://${BACKEND_HOST}`, `wss://${BACKEND_HOST}`],
  });
  const capabilities = getPlatformCapabilities({ platform: process.platform });
  const installationId = getOrCreateInstallationId(userDataDir);
  const authMgr = new AuthManager({
    requestClient: BACKEND_PROTOCOL === "https" ? https : http,
    appId: APP_ID,
    backendHost: BACKEND_HOST,
    backendProtocol: BACKEND_PROTOCOL,
    backendPort: BACKEND_PORT,
    wsProtocol: WS_PROTOCOL,
    wsPort: WS_PORT,
    electronSession: session.defaultSession,
    deviceId: installationId,
  });

  let audioMgr = null;
  if (process.platform === "win32") {
    const bootstrapWin = new BrowserWindow({ show: false });
    await ensureSVVPresentWithUI(bootstrapWin);
    if (!svvPath || !fs.existsSync(svvPath)) {
      dialog.showErrorBox("Setup error", "SoundVolumeView is required.");
      app.quit();
      return;
    }
    audioMgr = new AudioRouteManager({
      svvPath,
      vbCableInstaller,
      userDataDir,
      logger: console,
    });
  }
  audioMgrRef = audioMgr;

  await createWindow(authMgr, audioMgr, capabilities);
  if (audioMgr) createTray(audioMgr);

  if (audioMgr) {
    powerMonitor.on("suspend", async () => {
      console.log("[power] suspend: disabling cable listen");
      await audioMgr.disable().catch(() => {});
    });
    powerMonitor.on("resume", async () => {
      console.log("[power] resume: restoring cable listen");
      await audioMgr.enable().catch(() => {});
    });
  }
});

// Last-resort guards
process.on("uncaughtException", async (err) => {
  console.error("[uncaughtException]", err);
  await quitApp(audioMgrRef);
});
process.on("unhandledRejection", async (reason) => {
  console.error("[unhandledRejection]", reason);
  await quitApp(audioMgrRef);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", async () => {
  if (!quitting) {
    quitting = true;
    app.isQuiting = true;
    try {
      await audioMgrRef?.gracefulExit();
    } catch (e) {
      console.error("[before-quit] gracefulExit error:", e);
    }
  }
});
