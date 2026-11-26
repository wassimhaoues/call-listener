import React from "react";

export const AUTO_SCROLL_THRESHOLD = 80;

const ROLE_LABELS = { candidate: "Candidate", interviewer: "Interviewer" };

// Renders transcript entries as plain text. It is a class component only for
// getSnapshotBeforeUpdate: whether the reader was near the bottom must be
// measured before new entries change the scroll height.
export default class TranscriptLog extends React.Component {
  constructor(props) {
    super(props);
    this.scrollerRef = React.createRef();
  }

  getSnapshotBeforeUpdate(prevProps) {
    const scroller = this.scrollerRef.current;
    // Compare the newest entry, not the length: once the transcript reaches
    // its cap, an append drops the oldest entry and the length stays equal.
    const newestId = this.props.entries.at(-1)?.id;
    if (!scroller || newestId === undefined || newestId === prevProps.entries.at(-1)?.id) {
      return false;
    }
    const distanceFromBottom =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    return distanceFromBottom < AUTO_SCROLL_THRESHOLD;
  }

  componentDidUpdate(prevProps, prevState, stickToBottom) {
    const scroller = this.scrollerRef.current;
    if (!stickToBottom || !scroller) return;
    requestAnimationFrame(() =>
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" })
    );
  }

  render() {
    const { entries } = this.props;
    return (
      <div
        ref={this.scrollerRef}
        className="h-full overflow-auto no-scrollbar p-4"
      >
        <div>
          {entries.length === 0 ? (
            <em className="text-[var(--text-2)]">Waiting for audio…</em>
          ) : (
            entries.map((entry) => {
              const isCandidate = entry.role === "candidate";
              return (
                <div
                  key={entry.id}
                  className={`mb-3 max-w-[85%] ${
                    isCandidate ? "ml-auto text-right" : ""
                  }`}
                >
                  <div className="text-xs text-[var(--text-2)] mb-1">
                    {ROLE_LABELS[entry.role]}
                  </div>
                  <span
                    className={
                      "inline-block rounded-xl px-3 py-2 " +
                      (isCandidate ? "bg-[var(--accent-50)]" : "bg-[var(--muted)]")
                    }
                  >
                    {entry.text}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }
}
