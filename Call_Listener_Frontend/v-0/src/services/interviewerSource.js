// The kind of interviewer source chosen in Setup. Only this enum is stored
// for diagnostics: never a device ID or label, which can contain host details.

export const INTERVIEWER_SOURCE_KEY = "interviewerSource";

export const INTERVIEWER_SOURCES = Object.freeze({
  NONE: "none",
  MONITOR: "monitor-source",
  VB_CABLE: "vb-cable",
});

const KNOWN = new Set(Object.values(INTERVIEWER_SOURCES));

// The stored kind, or undefined when Setup has not run or the value is unknown.
export function readInterviewerSourceKind(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(INTERVIEWER_SOURCE_KEY);
    return KNOWN.has(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
