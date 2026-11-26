import React from "react";

export const AUTO_SCROLL_THRESHOLD = 80;

const ROLE_LABELS = { candidate: "Candidate", interviewer: "Interviewer" };
const INTERIM_ROLES = ["interviewer", "candidate"];
const NO_INTERIM = Object.freeze({ candidate: "", interviewer: "" });

// What changes the bottom of the log: the newest entry (not the length: once
// the transcript reaches its cap, an append drops the oldest entry and the
// length stays equal) and the in-progress interim lines.
function bottomKey({ entries, interim = NO_INTERIM }) {
  return [entries.at(-1)?.id ?? "", interim.interviewer, interim.candidate].join("\u0000");
}

function bubbleClass(isCandidate, isInterim) {
  const classes = ["inline-block rounded-xl px-3 py-2"];
  classes.push(isCandidate ? "bg-[var(--accent-50)]" : "bg-[var(--muted)]");
  if (isInterim) classes.push("italic text-[var(--text-2)] opacity-80");
  return classes.join(" ");
}

function TranscriptLine({ role, text, isInterim = false }) {
  const isCandidate = role === "candidate";
  const label = isInterim ? `${ROLE_LABELS[role]} (speaking…)` : ROLE_LABELS[role];
  return (
    <div
      className={isCandidate ? "mb-3 max-w-[85%] ml-auto text-right" : "mb-3 max-w-[85%]"}
      data-interim={isInterim || undefined}
    >
      <div className="text-xs text-[var(--text-2)] mb-1">{label}</div>
      <span className={bubbleClass(isCandidate, isInterim)}>
        {isInterim ? `${text}…` : text}
      </span>
    </div>
  );
}

// Renders transcript entries as plain text, followed by at most one
// in-progress (interim) line per speaker, shown dimmed and italic until the
// final transcript replaces it. It is a class component only for
// getSnapshotBeforeUpdate: whether the reader was near the bottom must be
// measured before new content changes the scroll height.
export default class TranscriptLog extends React.Component {
  constructor(props) {
    super(props);
    this.scrollerRef = React.createRef();
  }

  getSnapshotBeforeUpdate(prevProps) {
    const scroller = this.scrollerRef.current;
    const hasContent = this.props.entries.length > 0 || this.interimLines().length > 0;
    if (!scroller || !hasContent || bottomKey(this.props) === bottomKey(prevProps)) {
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

  interimLines() {
    const interim = this.props.interim ?? NO_INTERIM;
    return INTERIM_ROLES.filter((role) => typeof interim[role] === "string" && interim[role]).map(
      (role) => ({ role, text: interim[role] })
    );
  }

  render() {
    const { entries } = this.props;
    const interimLines = this.interimLines();
    const isEmpty = entries.length === 0 && interimLines.length === 0;
    return (
      <div
        ref={this.scrollerRef}
        className="h-full overflow-auto no-scrollbar p-4"
      >
        <div>
          {isEmpty && <em className="text-[var(--text-2)]">Waiting for audio…</em>}
          {entries.map((entry) => (
            <TranscriptLine key={entry.id} role={entry.role} text={entry.text} />
          ))}
          {interimLines.map((line) => (
            <TranscriptLine key={`interim-${line.role}`} role={line.role} text={line.text} isInterim />
          ))}
        </div>
      </div>
    );
  }
}
