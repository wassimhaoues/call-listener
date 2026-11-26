// FILE: src/components/InterviewerSourcePicker.jsx
import React from "react";
import Button from "@/components/ui/Button.jsx";

export const NO_INTERVIEWER_SOURCE = "";
// Label of the source the app adds itself on Linux (linuxInterviewerSource.js).
export const APP_SOURCE_LABEL = "Monitor of system output (Call Listener)";

function ScanMessage({ scan, labelsVisible, monitorCount }) {
  if (scan === "scanning") {
    return <p className="text-sm text-[var(--text-2)]">Looking for system output sources…</p>;
  }
  if (scan === "error") {
    return (
      <p className="text-sm text-[var(--text-2)]">
        Audio devices could not be listed. Select Refresh to try again, or
        continue with typed interviewer questions.
      </p>
    );
  }
  if (scan === "denied") {
    return (
      <p className="text-sm text-[var(--text-2)]">
        Audio access was not granted, so device names stay hidden. Allow
        microphone access for Call Listener and try again, or continue with
        typed interviewer questions.
      </p>
    );
  }
  if (labelsVisible && monitorCount === 0) {
    return (
      <p className="text-sm text-[var(--text-2)]">
        No system output monitor sources are visible to Call Listener. Many
        Linux setups do not show them to apps, and translated names are not
        recognised yet. You can continue in microphone-only mode and type the
        interviewer’s questions.
      </p>
    );
  }
  return null;
}

/**
 * Optional Linux interviewer source: a PipeWire/PulseAudio monitor of a
 * system output, chosen explicitly by the candidate. "None" (typed interviewer
 * questions) is the default and is never replaced automatically.
 */
const CREATE_FAILURES = {
  "pactl-unavailable":
    "The source could not be added because the pactl tool is missing. Install pulseaudio-utils (or pipewire-pulse) and try again.",
  "no-default-output": "No default output device was found. Connect your speakers or headset and try again.",
  "not-found":
    "The source was added but Call Listener cannot see it yet. Select Refresh, or restart Call Listener.",
};
const CREATE_FAILED_DEFAULT = "The source could not be added. Select Refresh to try again, or type the interviewer’s questions.";

/**
 * Offer to add a system output source when none is visible. Only shown when
 * the main process provides onCreateSource (Linux).
 */
function CreateSourceOffer({ onCreateSource, createState }) {
  const creating = createState === "creating";
  const failure = createState?.startsWith("failed:") ? createState.slice(7) : null;
  return (
    <div className="flex flex-col gap-2 items-start">
      <p className="text-sm">
        Call Listener can add a source that mirrors your default speakers or
        headset, so the interviewer can be transcribed. Your default devices
        stay as they are, and the source is removed when you quit.
      </p>
      <Button variant="secondary" onClick={onCreateSource} disabled={creating}>
        {creating ? "Adding…" : "Add system output source"}
      </Button>
      {failure && (
        <p role="alert" className="text-sm text-[var(--text-2)]">
          {CREATE_FAILURES[failure] || CREATE_FAILED_DEFAULT}
        </p>
      )}
    </div>
  );
}

export default function InterviewerSourcePicker({
  monitors,
  value,
  onChange,
  labelsVisible,
  scan,
  onAllowAccess,
  onRefresh,
  onCreateSource,
  createState = "idle",
}) {
  const busy = scan === "scanning";
  const showPicker = labelsVisible && monitors.length > 0;
  const offerCreate =
    typeof onCreateSource === "function" && labelsVisible && monitors.length === 0 && scan === "ready";
  return (
    <section className="panel p-4 flex flex-col gap-3" aria-labelledby="interviewer-source-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="interviewer-source-title" className="text-sm font-medium">
          Interviewer audio (system output) — optional
        </h2>
        {labelsVisible && (
          <Button variant="ghost" className="h-8 px-3" onClick={onRefresh} disabled={busy}>
            Refresh
          </Button>
        )}
      </div>
      <p className="text-sm text-[var(--text-2)]">
        PipeWire and PulseAudio can expose a “Monitor of …” source for an
        output device. If one is listed, choose the monitor of the speakers or headset you hear the
        interviewer through to have the interviewer transcribed. It captures
        everything that output plays, including notifications. Keep “None” to
        use your microphone only and type the interviewer’s questions.
      </p>

      {!labelsVisible && (
        <div className="flex flex-col gap-2 items-start">
          <p className="text-sm">
            Device names are hidden until Call Listener can access your audio
            devices. This asks once for audio permission; nothing is recorded.
          </p>
          <Button variant="secondary" onClick={onAllowAccess} disabled={busy}>
            Allow audio access
          </Button>
        </div>
      )}

      <div aria-live="polite">
        <ScanMessage scan={scan} labelsVisible={labelsVisible} monitorCount={monitors.length} />
      </div>

      {offerCreate && <CreateSourceOffer onCreateSource={onCreateSource} createState={createState} />}

      {showPicker && (
        <label className="flex flex-col gap-1 text-sm">
          <span>Interviewer source</span>
          <select
            className="select"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value={NO_INTERVIEWER_SOURCE}>None — type the interviewer’s questions</option>
            {monitors.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {showPicker && monitors.find((d) => d.deviceId === value)?.label === APP_SOURCE_LABEL && (
        <p className="text-sm text-[var(--text-2)]">
          Call Listener added this source when it started. It mirrors your
          default speakers or headset, so play the call there. Your default
          devices are unchanged, and the source is removed when you quit.
        </p>
      )}
    </section>
  );
}
