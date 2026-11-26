// FILE: src/layout/AppShell.jsx
import React, { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useUI } from "@/ui/UIContext.jsx";
import { Activity, Moon, Sun } from "lucide-react";

export default function AppShell() {
  const { title, actions, toggleTheme, theme, setTitle, setActions } = useUI();
  const { pathname } = useLocation();
  const nav = useNavigate();

  // Default title per route (pages can override in useEffect)
  useEffect(() => {
    const routeTitle =
      pathname === "/"
        ? "Setup"
        : pathname === "/context"
        ? "Call Context"
        : pathname === "/conversation"
        ? "Live Conversation"
        : pathname === "/novbcable"
        ? "Audio Device Check"
        : pathname === "/autherror"
        ? "Authentication"
        : pathname === "/unsupported"
        ? "Unsupported OS"
        : pathname === "/diagnostics"
        ? "Diagnostics"
        : pathname === "/connecting"
        ? "Connecting"
        : "Call Listener";
    setTitle(routeTitle);
    if (pathname !== "/conversation") setActions(null);
  }, [pathname, setTitle, setActions]);

  return (
    <div className="h-screen w-screen app-bg app-text overflow-hidden">
      {/* Top Bar */}
      <header className="app-drag h-12 flex items-center justify-between px-3 border-b border-subtle">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: "var(--accent)" }}
          />
          <span className="text-sm font-semibold">{title}</span>
        </div>

        <div className="app-no-drag flex items-center gap-2">
          {actions}
          {pathname !== "/diagnostics" && (
            <button
              className="btn btn-ghost h-8 px-2"
              onClick={() => nav("/diagnostics")}
              aria-label="Open diagnostics"
              title="Diagnostics"
            >
              <Activity size={16} />
            </button>
          )}
          <button
            className="btn btn-ghost h-8 px-2"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </header>

      {/* Content area */}
      <main className="h-[calc(100vh-48px)] p-3">
        <div className="h-full w-full rounded-xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
