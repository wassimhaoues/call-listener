import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import TranscriptLog from "../src/components/TranscriptLog.jsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows a placeholder until the first transcript arrives", () => {
  render(<TranscriptLog entries={[]} />);
  expect(screen.getByText("Waiting for audio…")).toBeInTheDocument();
});

it("labels candidate and interviewer turns and renders text safely", () => {
  render(
    <TranscriptLog
      entries={[
        { id: 1, role: "interviewer", text: "<img src=x onerror=alert(1)>" },
        { id: 2, role: "candidate", text: "My answer" },
      ]}
    />
  );
  expect(screen.queryByText("Waiting for audio…")).toBeNull();
  expect(screen.getByText("Interviewer")).toBeInTheDocument();
  expect(screen.getByText("Candidate")).toBeInTheDocument();
  expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  expect(screen.queryByRole("img")).toBeNull();
});

function scrollerFor(container, { scrollHeight, clientHeight, scrollTop }) {
  const scroller = container.firstElementChild;
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: clientHeight });
  scroller.scrollTop = scrollTop;
  scroller.scrollTo = vi.fn();
  return scroller;
}

it("follows new entries only when the reader is near the bottom", () => {
  vi.stubGlobal("requestAnimationFrame", (callback) => callback());
  const first = [{ id: 1, role: "candidate", text: "One" }];
  const second = [...first, { id: 2, role: "interviewer", text: "Two" }];
  const third = [...second, { id: 3, role: "candidate", text: "Three" }];

  const { container, rerender } = render(<TranscriptLog entries={first} />);
  const scroller = scrollerFor(container, { scrollHeight: 500, clientHeight: 200, scrollTop: 250 });
  rerender(<TranscriptLog entries={second} />);
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "smooth" });

  scroller.scrollTo.mockClear();
  scroller.scrollTop = 0; // reader scrolled up to review earlier turns
  rerender(<TranscriptLog entries={third} />);
  expect(scroller.scrollTo).not.toHaveBeenCalled();
});

it("keeps following new entries once the transcript is at its cap", () => {
  vi.stubGlobal("requestAnimationFrame", (callback) => callback());
  const first = [{ id: 1, role: "candidate", text: "One" }, { id: 2, role: "candidate", text: "Two" }];
  const shifted = [first[1], { id: 3, role: "interviewer", text: "Three" }];

  const { container, rerender } = render(<TranscriptLog entries={first} />);
  const scroller = scrollerFor(container, { scrollHeight: 500, clientHeight: 200, scrollTop: 290 });
  rerender(<TranscriptLog entries={shifted} />);
  expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "smooth" });
});
