import { describe, expect, it } from "vitest";

const { decideWindowClose, trayTooltip, HIDDEN_INTERVIEW_NOTICE } = require("../services/windowLifecycle.js");
const { makeTrayTemplate } = require("../services/tray.js");

const base = { isQuitting: false, hasTray: true, interviewActive: false, alreadyNotified: false };

describe("decideWindowClose", () => {
  it("lets the close through while quitting", () => {
    expect(decideWindowClose({ ...base, isQuitting: true, interviewActive: true })).toEqual({ action: "close", notify: false });
  });

  it("closes instead of hiding when there is no tray to come back from", () => {
    expect(decideWindowClose({ ...base, hasTray: false, interviewActive: true })).toEqual({ action: "close", notify: false });
  });

  it("hides to the tray, notifying once per active interview", () => {
    expect(decideWindowClose(base)).toEqual({ action: "hide", notify: false });
    expect(decideWindowClose({ ...base, interviewActive: true })).toEqual({ action: "hide", notify: true });
    expect(decideWindowClose({ ...base, interviewActive: true, alreadyNotified: true })).toEqual({ action: "hide", notify: false });
  });
});

describe("tray status", () => {
  it("shows the interview state in the tooltip and as a disabled first menu entry", () => {
    expect(trayTooltip(true)).toMatch(/interview in progress/);
    expect(trayTooltip(false)).toBe("Call Listener");
    const handlers = { isActive: () => false, onOpen() {}, onToggleRouting() {}, onQuit() {} };
    const active = makeTrayTemplate({ ...handlers, isInterviewActive: () => true });
    expect(active[0]).toEqual({ label: "Interview in progress — listening", enabled: false });
    const idle = makeTrayTemplate(handlers);
    expect(idle[0].label).toBe("Open");
    expect(HIDDEN_INTERVIEW_NOTICE.body).not.toMatch(/http|token/i);
  });
});
