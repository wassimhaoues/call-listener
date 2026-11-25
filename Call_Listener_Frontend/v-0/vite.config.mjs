// FILE: vite.config.mjs
import { defineConfig } from "vite";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ELECTRON_KEY = process.env.ELECTRON_KEY || "dev-electron-only";

export default defineConfig({
  root: "src",
  base: "./",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  plugins: [
    tailwindcss(),
    react(),
    {
      name: "electron-guard",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const isHMR =
            req.url?.startsWith("/@vite") ||
            req.headers.upgrade === "websocket";
          if (req.url === "/__ping" || isHMR) return next();
          const hdr = req.headers["x-electron-key"];
          if (hdr === ELECTRON_KEY) return next();
          res.statusCode = 403;
          res.end("Forbidden");
        });
      },
    },
  ],
  server: { port: 5173, host: "127.0.0.1" },
  test: {
    environment: "jsdom",
    setupFiles: [resolve(__dirname, "test/setup.js")],
    // Globs need forward slashes; path.resolve yields backslashes on Windows.
    include: [
      resolve(__dirname, "test/**/*.{test,spec}.{js,jsx}").replace(/\\/g, "/"),
    ],
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "src/index.html"),
      },
    },
  },
});
