// FILE: src/pages/Diagnostics.jsx
import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUI } from "@/ui/UIContext.jsx";
import Button from "@/components/ui/Button.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import { readInterviewerSourceKind } from "@/services/interviewerSource.js";

const DISPLAY_SERVER_LABELS = {
  x11: "X11",
  wayland: "Wayland",
  unknown: "Unknown",
  "n/a": "n/a",
};

const SEVERITY_LABELS = { error: "Error", warning: "Warning", info: "Note" };

function describeOs(os) {
  const family = os?.family ?? "Unknown";
  const arch = os?.arch ? " (" + os.arch + ")" : "";
  const support = os?.supported ? "" : " — unsupported";
  return family + arch + support;
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 border-b border-subtle last:border-b-0">
      <dt className="text-sm text-[var(--text-2)]">{label}</dt>
      <dd className="text-sm font-medium text-right">{value}</dd>
    </div>
  );
}

export default function Diagnostics() {
  const nav = useNavigate();
  const { setTitle } = useUI();
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | unavailable

  useEffect(() => setTitle("Diagnostics"), [setTitle]);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const result = await window.callApi?.getDiagnostics?.({
        interviewerSource: readInterviewerSourceKind(),
      });
      if (result && typeof result === "object") {
        setData(result);
        setStatus("ready");
      } else {
        setStatus("unavailable");
      }
    } catch {
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const adapter = data?.audioAdapter || {};
  const errors = Array.isArray(data?.errors) ? data.errors : [];

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-2xl mx-auto space-y-3">
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span>Platform and audio</span>
            <div className="flex gap-2">
              <Button variant="ghost" className="h-8 px-3" onClick={load}>
                Refresh
              </Button>
              <Button variant="ghost" className="h-8 px-3" onClick={() => nav(-1)}>
                Back
              </Button>
            </div>
          </CardHeader>
          <CardBody>
            {status === "loading" && (
              <p className="text-sm text-[var(--text-2)]">Collecting diagnostics…</p>
            )}
            {status === "unavailable" && (
              <p role="alert" className="text-sm text-[var(--text-2)]">
                Diagnostics are unavailable. Restart the app and try again.
              </p>
            )}
            {status === "ready" && (
              <dl>
                <Row
                  label="Operating system"
                  value={describeOs(data.os)}
                />
                <Row
                  label="Display server"
                  value={DISPLAY_SERVER_LABELS[data.displayServer] || "Unknown"}
                />
                <Row label="Capture strategy" value={data.capture?.label ?? "Unknown"} />
                <Row
                  label="System audio route"
                  value={data.capture?.systemAudio ? "Available" : "Not available"}
                />
                <Row
                  label="Interviewer source"
                  value={data.capture?.interviewerSource?.label ?? "Not chosen yet"}
                />
                <Row
                  label="Audio adapter"
                  value={`${adapter.kind ?? "unknown"} · ${adapter.state ?? "unknown"}`}
                />
                {adapter.controlsOsRouting && (
                  <Row
                    label="System audio routing"
                    value={adapter.routingActive ? "Active" : "Inactive"}
                  />
                )}
                <Row label="App version" value={data.versions?.app ?? "unknown"} />
                <Row label="Electron version" value={data.versions?.electron ?? "unknown"} />
              </dl>
            )}
          </CardBody>
        </Card>

        {status === "ready" && (
          <Card>
            <CardHeader>Issues</CardHeader>
            <CardBody>
              {errors.length === 0 ? (
                <p className="text-sm text-[var(--text-2)]">No problems detected.</p>
              ) : (
                <ul className="space-y-3" aria-label="Diagnostic issues">
                  {errors.map((err) => (
                    <li key={err.code} data-severity={err.severity}>
                      <p className="text-sm font-medium">
                        {SEVERITY_LABELS[err.severity] || "Note"}: {err.message}
                      </p>
                      <p className="text-sm text-[var(--text-2)]">{err.action}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}

        <p className="text-xs text-[var(--text-2)] px-1">
          This screen never shows your computer name, user name, installation
          ID, file paths, or network addresses.
        </p>
      </div>
    </div>
  );
}
