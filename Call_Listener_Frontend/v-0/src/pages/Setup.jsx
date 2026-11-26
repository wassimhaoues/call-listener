// FILE: src/pages/Setup.jsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useUI } from "@/ui/UIContext.jsx";
import Button from "@/components/ui/Button.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";
import InterviewerSourcePicker, {
  NO_INTERVIEWER_SOURCE,
} from "@/components/InterviewerSourcePicker.jsx";
import { hasDeviceLabels, partitionAudioInputs } from "@/services/monitorSources.js";
import { INTERVIEWER_SOURCE_KEY, INTERVIEWER_SOURCES } from "@/services/interviewerSource.js";

const MONITOR_SOURCE = "monitor-source";
const INTERVIEWER_UNAVAILABLE_LABEL = "Interviewer audio unavailable";
const MONITOR_SOURCE_LABEL = "Interviewer audio (system output)";

function stopStream(stream) {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {}
}

// The permission request exists only to reveal device labels; release the
// stream at once so no microphone stays open on this page.
async function requestDeviceLabels() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stopStream(stream);
}

async function listAudioInputs() {
  const devs = (await navigator.mediaDevices.enumerateDevices()) || [];
  return devs.filter((d) => d.kind === "audioinput");
}

function microphoneLabel(device, index) {
  return device.label || `Microphone ${index + 1}`;
}

export default function Setup() {
  const nav = useNavigate();
  const { setTitle } = useUI();
  const [mics, setMics] = useState([]);
  const [sysIns, setSysIns] = useState([]);
  const [monitors, setMonitors] = useState([]);
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [monitorScan, setMonitorScan] = useState("idle");
  const [micId, setMicId] = useState(localStorage.getItem("micId") || "");
  const [sysId, setSysId] = useState(localStorage.getItem("sysId") || "");
  const [note, setNote] = useState("");
  const [systemAudio, setSystemAudio] = useState({
    supported: true,
    strategy: "vb-cable",
  });
  const mountedRef = useRef(true);
  const monitorMode = systemAudio.selectableSource === MONITOR_SOURCE;
  const vbMode = !monitorMode && systemAudio.supported;
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

  // Linux: list microphones and monitor sources. The permission prompt only
  // runs from an explicit candidate action (requestPermission). A monitor is
  // never selected automatically; an earlier explicit choice is kept only
  // while that device is still listed.
  const refreshLinuxDevices = useCallback(async ({ requestPermission = false } = {}) => {
    setMonitorScan("scanning");
    let denied = false;
    if (requestPermission) {
      try {
        await requestDeviceLabels();
      } catch {
        denied = true;
      }
    }
    try {
      const inputs = await listAudioInputs();
      if (!mountedRef.current) return;
      const { microphones, monitors: found } = partitionAudioInputs(inputs);
      setLabelsVisible(hasDeviceLabels(inputs));
      setMics(microphones);
      setMonitors(found);
      setMicId((current) =>
        microphones.some((d) => d.deviceId === current) ? current : microphones[0]?.deviceId || ""
      );
      setSysId((current) =>
        found.some((d) => d.deviceId === current) ? current : NO_INTERVIEWER_SOURCE
      );
      setMonitorScan(denied ? "denied" : "ready");
    } catch {
      if (mountedRef.current) setMonitorScan("error");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      let capabilities;
      try {
        capabilities = await window.callApi?.getPlatformCapabilities?.();
      } catch {
        // Keep the Windows-compatible default when capability IPC is unavailable.
      }
      if (!mountedRef.current) return;
      if (capabilities?.systemAudio) setSystemAudio(capabilities.systemAudio);

      if (capabilities?.systemAudio?.selectableSource === MONITOR_SOURCE) {
        // Never restore a saved monitor: the candidate picks it on each visit.
        setSysId(NO_INTERVIEWER_SOURCE);
        await refreshLinuxDevices();
        return;
      }

      try {
        await requestDeviceLabels();
      } catch {
        setNote(
          "Microphone permission not granted — device labels may be hidden."
        );
      }
      try {
        const inputs = await listAudioInputs();
        if (!mountedRef.current) return;
        const vb = inputs.find((d) =>
          /vb.*cable|stereo mix|loopback/i.test(d.label || "")
        );
        setMics(inputs);
        setSysIns(inputs);
        setMicId((current) => current || inputs[0]?.deviceId || "");
        const fallbackSys = vb || inputs[1] || inputs[0];
        setSysId((current) => current || fallbackSys?.deviceId || "");
      } catch {
        setNote(
          "Cannot enumerate audio devices — check Windows privacy settings."
        );
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [refreshLinuxDevices]);

  function saveMonitorSelection() {
    const monitor = monitors.find((d) => d.deviceId === sysId);
    if (!monitor) {
      localStorage.setItem("systemAudioEnabled", "false");
      localStorage.removeItem("sysId");
      localStorage.setItem("sysLabel", INTERVIEWER_UNAVAILABLE_LABEL);
      localStorage.setItem(INTERVIEWER_SOURCE_KEY, INTERVIEWER_SOURCES.NONE);
      return;
    }
    localStorage.setItem("systemAudioEnabled", "true");
    localStorage.setItem("sysId", monitor.deviceId);
    localStorage.setItem("sysLabel", MONITOR_SOURCE_LABEL);
    localStorage.setItem(INTERVIEWER_SOURCE_KEY, INTERVIEWER_SOURCES.MONITOR);
  }

  function saveVbSelection() {
    const sysLabel = sysIns.find((d) => d.deviceId === sysId)?.label || "System";
    localStorage.setItem("systemAudioEnabled", "true");
    localStorage.setItem("sysId", sysId);
    localStorage.setItem("sysLabel", sysLabel);
    localStorage.setItem(INTERVIEWER_SOURCE_KEY, INTERVIEWER_SOURCES.VB_CABLE);
  }

  function saveMicrophoneOnly() {
    localStorage.setItem("systemAudioEnabled", "false");
    localStorage.removeItem("sysId");
    localStorage.setItem("sysLabel", INTERVIEWER_UNAVAILABLE_LABEL);
    localStorage.setItem(INTERVIEWER_SOURCE_KEY, INTERVIEWER_SOURCES.NONE);
  }

  function next() {
    if (!micId)
      return alert("Please select a microphone.");
    const usesSystemDevice = vbMode || (monitorMode && sysId !== NO_INTERVIEWER_SOURCE);
    if (vbMode && !sysId)
      return alert("Please select a system audio device.");
    if (usesSystemDevice && micId === sysId)
      return alert("Microphone and system audio devices must be different.");

    const micIndex = mics.findIndex((d) => d.deviceId === micId);
    const micLabel = micIndex >= 0 ? microphoneLabel(mics[micIndex], micIndex) : "Mic";
    localStorage.setItem("micId", micId);
    localStorage.setItem("micLabel", micLabel);

    if (monitorMode) saveMonitorSelection();
    else if (vbMode) saveVbSelection();
    else saveMicrophoneOnly();

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

          {!systemAudio.supported && !monitorMode && (
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
              <label className="text-sm font-medium mb-2 block" htmlFor="setup-microphone">
                Microphone
              </label>
              <select
                id="setup-microphone"
                className="select"
                value={micId}
                onChange={(e) => setMicId(e.target.value)}
              >
                {mics.map((d, index) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {monitorMode ? microphoneLabel(d, index) : d.label || d.deviceId}
                  </option>
                ))}
              </select>
            </div>

            {vbMode && (
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

            {monitorMode && (
              <InterviewerSourcePicker
                monitors={monitors}
                value={sysId}
                onChange={setSysId}
                labelsVisible={labelsVisible}
                scan={monitorScan}
                onAllowAccess={() => refreshLinuxDevices({ requestPermission: true })}
                onRefresh={() => refreshLinuxDevices()}
              />
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
