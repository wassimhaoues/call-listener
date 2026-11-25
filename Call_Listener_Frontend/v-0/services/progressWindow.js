// --- ProgressWindow helper (main process) ---
const { BrowserWindow } = require("electron");

function createProgressWindow(parent) {
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 420,
    height: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Installing SoundVolumeView",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: { sandbox: true },
  });

  const html = `
  <!doctype html><html><head><meta charset="utf-8">
  <style>
    body { font-family: system-ui, Segoe UI, Arial; margin: 16px; color: #222; }
    h1 { font-size: 16px; margin: 0 0 8px; }
    #detail { font-size: 12px; color: #666; margin: 6px 0 12px; white-space: pre-wrap; }
    .bar { width:100%; height:10px; background:#eee; border-radius:8px; overflow:hidden; }
    .fill { height:100%; width:0%; background: linear-gradient(90deg,#7cb342,#fdd835,#ef6c00,#d32f2f); transition: width .15s linear; }
    .row { display:flex; justify-content: flex-end; gap:8px; margin-top:14px; }
    button { padding:6px 12px; font-size:13px; border-radius:6px; border:1px solid #ddd; background:#fff; cursor:pointer; }
  </style></head>
  <body>
    <h1 id="title">Downloading…</h1>
    <div id="detail">Preparing…</div>
    <div class="bar"><div id="fill" class="fill"></div></div>
    <div class="row">
      <button id="cancelBtn">Cancel</button>
    </div>
    <script>
      const fill = document.getElementById('fill');
      const title = document.getElementById('title');
      const detail = document.getElementById('detail');
      const btn = document.getElementById('cancelBtn');

      window.addEventListener('message', (e) => {
        const msg = e.data || {};
        if (msg.type === 'status') {
          if (msg.title) title.textContent = msg.title;
          if (msg.detail != null) detail.textContent = msg.detail;
          if (typeof msg.percent === 'number') {
            fill.style.width = Math.max(0, Math.min(100, msg.percent)).toFixed(1) + '%';
          }
          if (msg.indeterminate) {
            fill.style.transition = 'none';
            fill.style.width = '100%';
            fill.style.background = 'repeating-linear-gradient(90deg,#ddd 0,#ddd 10px,#eee 10px,#eee 20px)';
          }
        }
      });

      btn.onclick = () => {
        window.parent.postMessage({ type: 'cancel' }, '*');
      };
    </script>
  </body></html>`;

  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.once("ready-to-show", () => win.show());

  const api = {
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
    setStatus: ({ title, detail, percent, indeterminate }) => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send("message", {
        type: "status",
        title,
        detail,
        percent,
        indeterminate,
      });
      // Fallback for data-URL: use executeJavaScript via window.postMessage
      win.webContents
        .executeJavaScript(
          `window.postMessage(${JSON.stringify({
            type: "status",
            title,
            detail,
            percent,
            indeterminate,
          })}, "*");`
        )
        .catch(() => {});
    },
    onCancel: (handler) => {
      const listener = (event) => {
        // from child window via postMessage
        if (event && event.data && event.data.type === "cancel") handler();
      };
      // Listen using webContents 'ipc-message' won't fire from data URL; use event from 'console' fallback
      win.webContents.on("console-message", () => {}); // no-op; keep process alive
      win.webContents.on("did-finish-load", () => {
        // Hook browser-level message events
        win.webContents.executeJavaScript(`
          window.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'cancel') { console.log('__CANCEL__'); }
          });
        `);
      });
      // Hacky but effective: watch for the console token
      win.webContents.on("console-message", (_e, _level, message) => {
        if (message === "__CANCEL__") handler();
      });
    },
    get window() {
      return win;
    },
  };
  return api;
}

module.exports.createProgressWindow = createProgressWindow;
