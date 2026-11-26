// services/windowLifecycle.js
// Pure decisions for closing the main window while an interview may still be
// capturing audio. Kept free of Electron so the rules are unit-testable.

/**
 * What a window close should do.
 * - Quitting: let the close through.
 * - No tray (Linux microphone-only mode, or a tray that failed to start):
 *   hiding would leave an invisible app that may still hold the microphone,
 *   so the close goes through and the app quits.
 * - Otherwise hide to the tray, and tell the candidate once per interview
 *   that capture continues in the background.
 *
 * @returns {{ action: "close" | "hide", notify: boolean }}
 */
function decideWindowClose({ isQuitting, hasTray, interviewActive, alreadyNotified }) {
  if (isQuitting || !hasTray) return { action: "close", notify: false };
  return { action: "hide", notify: Boolean(interviewActive) && !alreadyNotified };
}

const INTERVIEW_ACTIVE_TOOLTIP = "Call Listener — interview in progress (listening)";
const IDLE_TOOLTIP = "Call Listener";

function trayTooltip(interviewActive) {
  return interviewActive ? INTERVIEW_ACTIVE_TOOLTIP : IDLE_TOOLTIP;
}

const HIDDEN_INTERVIEW_NOTICE = Object.freeze({
  title: "Call Listener is still listening",
  body: "Your interview is still running in the background. Open Call Listener from the tray to stop it.",
});

module.exports = { decideWindowClose, trayTooltip, HIDDEN_INTERVIEW_NOTICE };
