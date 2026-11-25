// FILE: src/components/Meter.jsx
import React from "react";

export default function Meter({ label, pct, db }) {
  return (
    <div className="min-w-[220px] flex items-center gap-3">
      <span className="text-xs text-[var(--text-2)] min-w-[90px] truncate">
        {label}
      </span>
      <div
        className="relative h-2 w-full rounded-full"
        style={{ background: "var(--muted)" }}
      >
        <div
          className="absolute left-0 top-0 h-full transition-[width] duration-75"
          style={{
            width: `${(pct || 0).toFixed(1)}%`,
            background:
              "linear-gradient(90deg,#7cb342,#fdd835,#ef6c00,#d32f2f)",
          }}
        />
      </div>
      <span className="text-xs text-[var(--text-2)] min-w-[60px] text-right font-mono">
        {db}
      </span>
    </div>
  );
}
