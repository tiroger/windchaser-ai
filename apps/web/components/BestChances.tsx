"use client";

import { compassLabel, formatDelta, formatDuration } from "@/lib/geo";
import type { WeekChances, WindChance } from "@/lib/chances";
import { REACH_FRACTION, REACH_MIN_SECONDS } from "@/lib/training/pr-chances";

const MPH_PER_MS = 2.23694;
const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** "YYYY-MM-DD" in a zone, for an instant. */
function zoneDate(epochMs: number, timeZone: string): string {
  let format = dayFormats.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      format = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
    }
    dayFormats.set(timeZone, format);
  }
  return format.format(epochMs);
}

/** "Today 9 AM", "Tomorrow 4 PM", "Sat, Nov 1, 4 PM", from a forecast wall-clock hour. */
export function whenLabel(time: string, timeZone: string, nowMs: number): string {
  const date = time.slice(0, 10);
  const hour = Number(time.slice(11, 13));
  const clock = `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
  if (date === zoneDate(nowMs, timeZone)) return `Today ${clock}`;
  if (date === zoneDate(nowMs + 86_400_000, timeZone)) return `Tomorrow ${clock}`;
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
  return `${weekday} ${clock}`;
}

/** "6 mph tailwind", "calm": the net wind along the segment at rider height. */
function netWind(tailwindMs: number): string {
  if (Math.abs(tailwindMs) < 0.45) return "calm";
  const mph = Math.max(1, Math.round(Math.abs(tailwindMs) * MPH_PER_MS));
  return `${mph} mph ${tailwindMs > 0 ? "tailwind" : "headwind"}`;
}

function ChanceRow({
  chance,
  timezone,
  nowMs,
  selected,
  onPick,
}: {
  chance: WindChance;
  timezone: string;
  nowMs: number;
  selected: boolean;
  onPick: (chance: WindChance) => void;
}) {
  const soft = Boolean(chance.segment.record?.soft);
  // A soft record is beaten by any hard ride; no reason to colour it as a win.
  const beats = chance.gapSeconds < 0 && !soft;
  return (
    <li>
      <button
        type="button"
        className="chance"
        aria-pressed={selected}
        onClick={() => onPick(chance)}
        title={`${Math.round(chance.windSpeedMs * MPH_PER_MS)} mph wind from ${compassLabel(chance.windFromDeg)}`}
      >
        <span className="chance-when mono">{whenLabel(chance.time, timezone, nowMs)}</span>
        <span className="chance-name">{chance.segment.name}</span>
        <span className="chance-facts">
          <span className={chance.tailwindMs > 0.45 ? "is-tail" : undefined}>{netWind(chance.tailwindMs)}</span>
          {" · "}
          <span className="mono">{formatDuration(chance.predictedSeconds)}</span>
          {" vs "}
          <span className="mono">{formatDuration(chance.predictedSeconds - chance.gapSeconds)}</span>
        </span>
        <span className={`chance-gap mono${beats ? " is-beat" : ""}`}>
          {Math.round(chance.gapSeconds) === 0 ? "±0s" : formatDelta(chance.gapSeconds)}
          <small>{Math.round(chance.pBeat * 100)}%</small>
        </span>
      </button>
    </li>
  );
}

/**
 * The coming week's daylight hours when a segment's predicted time comes
 * within reach of the record, best first; then the nearest misses, and
 * records soft enough that any hard ride should beat them. Picking one
 * selects the segment at that hour.
 */
export default function BestChances({
  week,
  timezone,
  nowMs,
  selectedId,
  onPick,
}: {
  week: WeekChances;
  timezone: string;
  nowMs: number;
  selectedId: number | null;
  onPick: (chance: WindChance) => void;
}) {
  const { chances, closest, soft } = week;
  const reach = `${Math.round(REACH_FRACTION * 100)}% (or ${REACH_MIN_SECONDS} s)`;
  const row = (chance: WindChance) => (
    <ChanceRow
      key={`${chance.segmentId}-${chance.time}`}
      chance={chance}
      timezone={timezone}
      nowMs={nowMs}
      selected={chance.segmentId === selectedId}
      onPick={onPick}
    />
  );
  return (
    <section className="chances" aria-labelledby="chances-title">
      <div className="chances-head">
        <span className="label">Best chances this week</span>
        <h3 id="chances-title">
          {chances.length
            ? `${chances.length} ${chances.length === 1 ? "hour" : "hours"} within reach of a PR`
            : "No PR within reach this week"}
        </h3>
      </div>
      {chances.length > 0 ? (
        <ul className="chance-list">{chances.map(row)}</ul>
      ) : (
        <p className="chances-note">
          No daylight hour this week brings a predicted time within {reach} of your record on these segments.
        </p>
      )}
      {closest.length > 0 && (
        <details className="chances-more" open={chances.length === 0}>
          <summary>Closest otherwise · {closest.length}</summary>
          <ul className="chance-list is-quiet">{closest.map(row)}</ul>
        </details>
      )}
      {soft.length > 0 && (
        <details className="chances-more">
          <summary>Soft records · {soft.length}</summary>
          <p className="chances-note">
            Set well below the power you hold there now, or with a stop in it: any hard effort should beat{" "}
            {soft.length === 1 ? "it" : "them"}, so {soft.length === 1 ? "it is" : "they are"} not ranked as a
            chance.
          </p>
          <ul className="chance-list is-quiet">{soft.map(row)}</ul>
        </details>
      )}
      <p className="chances-note">
        The same evaluation as the list below: daylight hours, no rain likely and no wind or gust warning,
        within {reach} of your record. The percentage is the chance of beating it.
      </p>
    </section>
  );
}
