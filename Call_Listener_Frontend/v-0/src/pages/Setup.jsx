// FILE: src/pages/Setup.jsx
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUI } from "@/ui/UIContext.jsx";
import Button from "@/components/ui/Button.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";

export default function Setup() {
  const nav = useNavigate();
  const { setTitle } = useUI();
  const [mics, setMics] = useState([]);
  const [sysIns, setSysIns] = useState([]);
  const [micId, setMicId] = useState(localStorage.getItem("micId") || "");
  const [sysId, setSysId] = useState(localStorage.getItem("sysId") || "");
  const [note, setNote] = useState("");
  const [systemAudio, setSystemAudio] = useState({
    supported: true,
    strategy: "vb-cable",
  });
  // Navigate away if we're offline; also react to going offline while on this page.

  useEffect(() => {
    const goIfOffline = () => {
      if (!navigator.onLine) nav("/autherror");
    };
    localStorage.setItem("lastPage", "/");
    // initial check
    goIfOffline();

    // react to offline events
    window.addEventListener("offline", goIfOffline);
    return () => window.removeEventListener("offline", goIfOffline);
  }, [nav]);

  useEffect(() => setTitle("Setup"), [setTitle]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const capabilities = await window.callApi?.getPlatformCapabilities?.();
        if (!cancelled && capabilities?.systemAudio) {
          setSystemAudio(capabilities.systemAudio);
        }
      } catch {
        // Keep the Windows-compatible default when capability IPC is unavailable.
      }
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setNote(
          "Microphone permission not granted — device labels may be hidden."
        );
      }
      try {
        const devs = (await navigator.mediaDevices.enumerateDevices()) || [];
        const inputs = devs.filter((d) => d.kind === "audioinput");
        const vb = inputs.find((d) =>
          /vb.*cable|stereo mix|loopback/i.test(d.label || "")
        );
        setMics(inputs);
        setSysIns(inputs);
        if (!micId && inputs[0]) setMicId(inputs[0].deviceId);
        if (!sysId && (vb || inputs[1] || inputs[0])) {
          setSysId((vb || inputs[1] || inputs[0]).deviceId);
        }
      } catch {
        setNote(
          "Cannot enumerate audio devices — check Windows privacy settings."
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { cancelled = true; };
  }, []);

  function next() {
    if (!micId)
      return alert("Please select a microphone.");
    if (systemAudio.supported && !sysId)
      return alert("Please select a system audio device.");
    if (systemAudio.supported && micId === sysId)
      return alert("Microphone and system audio devices must be different.");

    const micLabel = mics.find((d) => d.deviceId === micId)?.label || "Mic";
    const sysLabel = systemAudio.supported
      ? sysIns.find((d) => d.deviceId === sysId)?.label || "System"
      : "Interviewer audio unavailable";

    localStorage.setItem("micId", micId);
    localStorage.setItem("micLabel", micLabel);
    localStorage.setItem("systemAudioEnabled", String(systemAudio.supported));
    if (systemAudio.supported) {
      localStorage.setItem("sysId", sysId);
      localStorage.setItem("sysLabel", sysLabel);
    } else {
      localStorage.removeItem("sysId");
      localStorage.setItem("sysLabel", sysLabel);
    }

    nav("/context");
  }

  return (
    <div className="h-full grid place-items-center">
      <Card className="w-full h-full flex flex-col overflow-y-auto">
        <CardHeader>Device Setup</CardHeader>
        <CardBody className="flex-1 flex flex-col gap-4 overflow-y-auto">
          <p className="text-sm text-[var(--text-2)]">
            Choose your recording devices. The app listens to your microphone
            and, when available, interviewer audio from your system.
          </p>

          {note && (
            <p
              className="text-sm px-3 py-2 rounded-lg"
              style={{ background: "var(--muted)" }}
            >
              {note}
            </p>
          )}

          {!systemAudio.supported && (
            <p
              className="text-sm px-3 py-2 rounded-lg"
              style={{ background: "var(--muted)" }}
            >
              System audio is not available on this device yet. You can start
              in microphone-only mode; interviewer capture will be added after
              the Linux PipeWire route is qualified.
            </p>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            <div className="panel p-4">
              <div className="text-sm font-medium mb-2">Microphone</div>
              <select
                className="select"
                value={micId}
                onChange={(e) => setMicId(e.target.value)}
              >
                {mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </option>
                ))}
              </select>
            </div>

            {systemAudio.supported && (
              <div className="panel p-4">
              <div className="text-sm font-medium mb-2">
                System Audio (VB-Cable / Stereo Mix)
              </div>
              <select
                className="select"
                value={sysId}
                onChange={(e) => setSysId(e.target.value)}
              >
                {sysIns.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </option>
                ))}
              </select>
              </div>
            )}
          </div>

          <div className="mt-auto flex justify-end">
            <Button onClick={next}>Next</Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
