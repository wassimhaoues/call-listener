// FILE: src/components/StatusBar.jsx
import React from "react";

export default function StatusBar({ left, right }) {
  return (
    <div className="h-10 flex items-center justify-between px-3 border-t border-subtle">
      <div className="text-xs text-[var(--text-2)] flex items-center gap-4">
        {left}
      </div>
      <div className="text-xs text-[var(--text-2)]">{right}</div>
    </div>
  );
}
