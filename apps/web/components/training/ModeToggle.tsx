"use client";

import { MODE_LABELS, type TimeMode } from "./segment-format";

/** Recorded or still-air time, as a pair of chips. */
export default function ModeToggle({
  mode,
  onChange,
  label,
}: {
  mode: TimeMode;
  onChange: (mode: TimeMode) => void;
  label: string;
}) {
  return (
    <div className="chip-row t-sa-toggle" role="group" aria-label={label}>
      {(Object.keys(MODE_LABELS) as TimeMode[]).map((value) => (
        <button
          key={value}
          type="button"
          className="chip"
          aria-pressed={mode === value}
          onClick={() => onChange(value)}
        >
          {MODE_LABELS[value]}
        </button>
      ))}
    </div>
  );
}
