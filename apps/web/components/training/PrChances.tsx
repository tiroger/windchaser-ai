import Link from "next/link";

import { compassLabel, formatDelta, formatDuration } from "@/lib/geo";
import { formatNumber } from "@/lib/training/activity-types";
import type { ChanceView, PrChancesData } from "@/lib/training/pr-chances-data";
import { REACH_FRACTION, REACH_MIN_SECONDS } from "@/lib/training/pr-chances";

import { rideDate } from "./loop-format";
import { MPH_PER_MS, netWind } from "./segment-format";

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** "YYYY-MM-DD" in a zone, for an instant. */
function zoneDate(epochMs: number, timeZone: string): string {
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(timeZone, format);
  }
  return format.format(epochMs);
}

/** "Tomorrow 9 AM", "Sat 4 PM", from a forecast wall-clock hour. */
export function whenLabel(time: string, timeZone: string, nowMs: number): string {
  const date = time.slice(0, 10);
  const hour = Number(time.slice(11, 13));
  const clock = `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
  const today = zoneDate(nowMs, timeZone);
  const tomorrow = zoneDate(nowMs + 86_400_000, timeZone);
  if (date === today) return `Today ${clock}`;
  if (date === tomorrow) return `Tomorrow ${clock}`;
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${weekday}, ${clock}`;
}

function ChanceRow({ chance, timezone, nowMs }: { chance: ChanceView; timezone: string; nowMs: number }) {
  const wind = netWind(chance.tailwindMs);
  // A soft record is beaten by any hard ride; no reason to colour it as a win.
  const beats = chance.gapSeconds < 0 && !chance.softRecord;
  return (
    <li>
      <div>
        <span className="t-pc-when">{whenLabel(chance.time, timezone, nowMs)}</span>
        <span className="t-pc-name">
          <a
            href={`https://www.strava.com/segments/${chance.segmentId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {chance.name}
          </a>
        </span>
        <p className="t-pc-facts">
          {wind && <span className={chance.tailwindMs > 0 ? "is-tail" : undefined}>{wind}</span>}
          {` (${Math.round(chance.windSpeedMs * MPH_PER_MS)} mph ${compassLabel(chance.windFromDeg)})`}
          {" · "}predicted <span className="num">{formatDuration(chance.predictedSeconds)}</span>
          {", "}PR <span className="num">{formatDuration(chance.prSeconds)}</span>
          {chance.bestStillAirSeconds !== null && (
            <>
              {" · "}best still air <span className="num">≈ {formatDuration(chance.bestStillAirSeconds)}</span>
            </>
          )}
        </p>
        <p className="t-pc-confidence">
          {Math.round(chance.pBeat * 100)}% chance of a PR at ≈ {chance.watts} W ·{" "}
          {chance.errorSource === "attempts"
            ? `the model typically misses your hard efforts here by ${chance.errorSeconds} s`
            : `the model's backtest error is about ${chance.errorSeconds} s on a segment like this`}
          {chance.distanceM !== null &&
            ` · ${formatNumber(chance.distanceM / 1609.344, 2)} mi${
              chance.averageGrade !== null ? ` at ${formatNumber(chance.averageGrade, 1)}%` : ""
            }`}
        </p>
        <div className="t-pc-links">
          {chance.prActivityId && (
            <Link className="t-link" href={`/training/activities/${chance.prActivityId}#segments`}>
              PR ride, {rideDate(chance.prDate, true)}
            </Link>
          )}
          <Link className="t-link" href="/">
            Wind view
          </Link>
        </div>
      </div>
      <div className={`t-pc-gap num${beats ? " is-beat" : ""}`}>
        <strong>{Math.round(chance.gapSeconds) === 0 ? "±0s" : formatDelta(chance.gapSeconds)}</strong>
        <small>vs PR</small>
      </div>
    </li>
  );
}

/**
 * The coming week's daylight hours when a segment's predicted time is within
 * reach of the PR, best first; then the nearest misses, and records soft
 * enough that any hard ride should beat them.
 */
export default function PrChances({ data, nowMs }: { data: PrChancesData; nowMs: number }) {
  const { chances, closest, soft, timezone } = data;
  const reach = `${Math.round(REACH_FRACTION * 100)}% (or ${REACH_MIN_SECONDS} s)`;
  return (
    <article className="panel" id="pr-chances">
      <span className="label">PR chances · next 7 days</span>
      <h2 className="t-card-title">
        {chances.length
          ? `${chances.length} ${chances.length === 1 ? "hour" : "hours"} within reach of a PR`
          : "No PR within reach this week"}
      </h2>
      {chances.length > 0 ? (
        <ul className="t-pc-list">
          {chances.map((chance) => (
            <ChanceRow key={`${chance.segmentId}-${chance.time}`} chance={chance} timezone={timezone} nowMs={nowMs} />
          ))}
        </ul>
      ) : (
        <p className="t-note">
          No daylight hour this week brings a predicted time within {reach} of a PR on the segments you ride
          near home.
        </p>
      )}

      {closest.length > 0 && (
        <>
          <h3 className="t-subhead t-pc-sub">Closest otherwise</h3>
          <ul className="t-pc-list is-quiet">
            {closest.map((chance) => (
              <ChanceRow key={`${chance.segmentId}-${chance.time}`} chance={chance} timezone={timezone} nowMs={nowMs} />
            ))}
          </ul>
        </>
      )}

      {soft.length > 0 && (
        <>
          <h3 className="t-subhead t-pc-sub">Soft records</h3>
          <p className="t-note">
            You have never ridden {soft.length === 1 ? "this segment" : "these segments"} hard: the record was
            set well below the power you hold there now, or with a stop in it. Any hard effort should beat{" "}
            {soft.length === 1 ? "it" : "them"}, so they are not ranked as chances.
          </p>
          <ul className="t-pc-list is-quiet">
            {soft.map((chance) => (
              <ChanceRow key={`${chance.segmentId}-${chance.time}`} chance={chance} timezone={timezone} nowMs={nowMs} />
            ))}
          </ul>
        </>
      )}

      <p className="t-note">
        Predicted times are the wind view&apos;s: its forecast and physics, at the power your calibration says
        you hold for an effort that long on that gradient: a fit across your attempts on the segment in their
        real weather where there are enough, otherwise your rider-level curve. It is not adjusted further for
        current form: attempts already count half as much every two years, and the backtests show a shorter
        window makes predictions more optimistic on thinly ridden segments. Daylight hours only, without rain
        likely or a wind or gust warning. Within reach means within {reach} of the PR; the chance allows for
        forecast spread and day-to-day variation. Forecast for {data.forecastSegments} segments near where you
        last rode, from {data.cells} forecast {data.cells === 1 ? "cell" : "cells"}
        {data.failedCells > 0 && ` (${data.failedCells} unavailable)`}.
      </p>
    </article>
  );
}

export function PrChancesSkeleton() {
  return (
    <article className="panel" aria-busy="true">
      <span className="label">PR chances · next 7 days</span>
      <h2 className="t-card-title">Reading the forecast…</h2>
      <div className="t-pc-skeleton" />
    </article>
  );
}
