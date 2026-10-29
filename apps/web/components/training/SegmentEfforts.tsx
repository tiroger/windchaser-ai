"use client";

import type { EChartsOption } from "echarts";
import Link from "next/link";
import { useMemo, useState } from "react";

import "@/app/training/loops.css";
import "@/app/training/segments.css";
import { compassLabel, formatDelta, formatDuration } from "@/lib/geo";
import { formatNumber } from "@/lib/training/activity-types";
import type { EffortWeather, SegmentEffortRow } from "@/lib/training/segments";

import Chart, { axisText, splitLine, tooltip, useChartPalette } from "./Chart";
import { DATE_AXIS_LABELS, durationAxis, ordinal, rideDate } from "./loop-format";
import ModeToggle from "./ModeToggle";
import {
  MPH_PER_MS,
  netWind,
  REASON_TEXT,
  ROUGH_NOTE,
  STILL_AIR_NOTE,
  type TimeMode,
} from "./segment-format";

function weatherText(weather: EffortWeather | null): string | null {
  if (!weather) return null;
  const parts: string[] = [];
  if (weather.wind_speed_ms !== null && weather.wind_speed_ms !== undefined) {
    const direction =
      weather.wind_from_deg !== null && weather.wind_from_deg !== undefined
        ? ` ${compassLabel(weather.wind_from_deg)}`
        : "";
    parts.push(`${Math.round(weather.wind_speed_ms * MPH_PER_MS)} mph${direction}`);
  }
  if (weather.temperature_c !== null && weather.temperature_c !== undefined) {
    parts.push(`${Math.round(weather.temperature_c)}°C`);
  }
  if (weather.precip_mm) parts.push(`${formatNumber(weather.precip_mm, 1)} mm rain`);
  return parts.length ? parts.join(" · ") : null;
}

function RankBadge({ rank, of, still }: { rank: number; of: number; still?: boolean }) {
  if (rank === 1) return <span className="t-badge is-pr">{still ? "Best" : "PR"}</span>;
  if (rank <= 3) return <span className={`t-badge is-rank-${rank}`}>{ordinal(rank)}</span>;
  return (
    <span className="t-seg-rank num">
      {ordinal(rank)} <small>of {of}</small>
    </span>
  );
}

/**
 * This activity's efforts on the segments WindChaser tracks, each ranked
 * against every effort you have on it, expandable to that segment's history.
 */
export default function SegmentEfforts({
  activityId,
  segments,
}: {
  activityId: string;
  segments: SegmentEffortRow[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [mode, setMode] = useState<TimeMode>("recorded");
  const hasStillAir = segments.some((row) => row.stillAir && row.stillAir.count > 0);
  const anyRough = segments.some((row) => row.stillAir?.check === "worse");
  return (
    <article className="panel t-segments" id="segments">
      <div className="t-card-head">
        <div>
          <span className="label">Segments</span>
          <h2 className="t-card-title">
            {segments.length
              ? `${segments.length} tracked segment ${segments.length === 1 ? "effort" : "efforts"}`
              : "No tracked segments"}
          </h2>
        </div>
        {hasStillAir && <ModeToggle mode={mode} onChange={setMode} label="Rank segment efforts by" />}
      </div>
      {segments.length === 0 ? (
        <p className="t-empty">
          This activity crossed none of the segments WindChaser tracks, or its efforts have not been
          recorded yet.
        </p>
      ) : (
        <ul className="t-seg-list">
          {segments.map((row, index) => {
            const isOpen = open === index;
            const weather = weatherText(row.weather);
            const still = row.stillAir;
            const inStill = mode === "still" && !!still;
            const shownTime = inStill ? still.seconds : row.elapsedSeconds;
            const wind = netWind(still?.tailwindMs ?? null);
            const rough = still?.check === "worse";
            return (
              <li key={`${row.segmentId}-${index}`} className={isOpen ? "is-open" : undefined}>
                <button
                  type="button"
                  className="t-seg-row"
                  aria-expanded={isOpen}
                  aria-controls={`segment-history-${index}`}
                  onClick={() => setOpen(isOpen ? null : index)}
                >
                  <span className="t-seg-name">
                    <strong>{row.name}</strong>
                    <small>
                      {row.distance !== null && `${formatNumber(row.distance / 1609.344, 2)} mi`}
                      {row.averageGrade !== null && ` · ${formatNumber(row.averageGrade, 1)}%`}
                      {weather && ` · ${weather}`}
                    </small>
                    {still && (
                      <small className="t-sa-line">
                        {still.seconds === null ? (
                          still.reason && REASON_TEXT[still.reason]
                        ) : (
                          <>
                            {inStill
                              ? `${formatDuration(row.elapsedSeconds)} recorded`
                              : `≈ ${formatDuration(still.seconds)} still air`}
                            {wind && ` · ${wind}`}
                            {rough && (
                              <span className="t-sa-rough" title={ROUGH_NOTE}>
                                {" "}
                                · rough here
                              </span>
                            )}
                          </>
                        )}
                      </small>
                    )}
                  </span>
                  <span className="t-seg-time num">
                    {shownTime === null ? "—" : `${inStill ? "≈" : ""}${formatDuration(shownTime)}`}
                  </span>
                  <span className="t-seg-badge">
                    {inStill ? (
                      still.rank !== null && <RankBadge rank={still.rank} of={still.count} still />
                    ) : (
                      <RankBadge rank={row.rank} of={row.efforts} />
                    )}
                  </span>
                  <span className="t-seg-delta num">
                    {inStill ? <StillDelta row={row} /> : <RecordedDelta row={row} />}
                  </span>
                  <span className="t-seg-chevron" aria-hidden="true">
                    {isOpen ? "−" : "+"}
                  </span>
                </button>
                {isOpen && (
                  <div className="t-seg-history" id={`segment-history-${index}`}>
                    <SegmentHistory key={mode} row={row} activityId={activityId} initialMode={mode} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {segments.length > 0 && (
        <p className="t-note">
          Ranked against every effort WindChaser has recorded on each segment. Weather is the
          hourly reanalysis for when you rode it.
          {hasStillAir && ` ${STILL_AIR_NOTE}`}
          {anyRough && ` “Rough here”: ${ROUGH_NOTE}`}
        </p>
      )}
    </article>
  );
}

function RecordedDelta({ row }: { row: SegmentEffortRow }) {
  if (row.deltaSeconds === 0) {
    return <small>{row.efforts > 1 ? `best of ${row.efforts}` : "first effort"}</small>;
  }
  return (
    <>
      {formatDelta(row.deltaSeconds)}
      <small>PR {rideDate(row.prDate)}</small>
    </>
  );
}

function StillDelta({ row }: { row: SegmentEffortRow }) {
  const still = row.stillAir;
  if (!still || still.seconds === null || still.bestSeconds === null) {
    return <small>{still?.count ? `${still.count} adjusted` : "not adjusted"}</small>;
  }
  const delta = still.seconds - still.bestSeconds;
  if (Math.round(delta) === 0) {
    return <small>{still.count > 1 ? `best of ${still.count}` : "first effort"}</small>;
  }
  return (
    <>
      {formatDelta(delta)}
      <small>best {still.bestDate ? rideDate(still.bestDate) : ""}</small>
    </>
  );
}

type HistoryPoint = SegmentEffortRow["history"][number];

function SegmentHistory({
  row,
  activityId,
  initialMode,
}: {
  row: SegmentEffortRow;
  activityId: string;
  initialMode: TimeMode;
}) {
  const palette = useChartPalette();
  const canStill = !!row.stillAir && row.stillAir.count > 0;
  const [mode, setMode] = useState<TimeMode>(canStill ? initialMode : "recorded");
  const still = mode === "still";
  const best = still ? (row.stillAir?.bestSeconds ?? null) : row.prSeconds;

  const option = useMemo<EChartsOption>(() => {
    const text = axisText(palette);
    const valueOf = (entry: HistoryPoint) => (still ? entry.stillAirSeconds : entry.elapsedSeconds);
    const shown = row.history.filter((entry) => valueOf(entry) !== null);
    const point = (entry: HistoryPoint) => ({
      value: [entry.date, valueOf(entry)!] as [string, number],
      entry,
    });
    const isThis = (entry: HistoryPoint) =>
      entry.activityId === activityId && entry.elapsedSeconds === row.elapsedSeconds;
    const values = shown.map((entry) => valueOf(entry)!);
    return {
      grid: { top: 22, left: 46, right: 12, bottom: 24 },
      tooltip: {
        ...tooltip(palette),
        trigger: "item",
        formatter: (params: unknown) => {
          const { data } = params as { data: { entry: HistoryPoint; value: [string, number] } };
          const entry = data.entry;
          const lines = [`<strong>${rideDate(entry.date, true)}</strong>`];
          lines.push(`${formatDuration(entry.elapsedSeconds)} recorded`);
          if (entry.stillAirSeconds !== null) {
            lines.push(`≈ ${formatDuration(entry.stillAirSeconds)} still air`);
          }
          if (best !== null) {
            const delta = data.value[1] - best;
            lines.push(Math.round(delta) === 0 ? (still ? "best still air" : "PR") : `${formatDelta(delta)} vs ${still ? "best" : "PR"}`);
          }
          return lines.join("<br/>");
        },
      },
      xAxis: {
        type: "time",
        axisLabel: { ...text, hideOverlap: true, formatter: DATE_AXIS_LABELS },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        inverse: true,
        ...durationAxis(values),
        axisLabel: { ...text, formatter: (value: number) => formatDuration(value) },
        splitLine: splitLine(palette),
      },
      series: [
        {
          name: still ? "Still air" : "Efforts",
          type: "line",
          data: shown.map(point),
          showSymbol: true,
          symbolSize: 7,
          lineStyle: { color: palette.line, width: 1.5 },
          itemStyle: {
            color: still ? palette.wind : palette.ink3,
            borderColor: palette.surface,
            borderWidth: 1.5,
          },
          markLine:
            best === null
              ? undefined
              : {
                  symbol: "none",
                  silent: true,
                  lineStyle: { color: palette.ink3, type: "dashed" },
                  label: {
                    position: "insideStartTop",
                    formatter: `${still ? "Best still air" : "PR"} ${formatDuration(best)}`,
                    color: palette.ink2,
                    fontSize: 10,
                    fontFamily: palette.fontMono,
                  },
                  data: [{ yAxis: best }],
                },
        },
        {
          name: "This effort",
          type: "line",
          data: shown.filter(isThis).map(point),
          showSymbol: true,
          symbolSize: 12,
          lineStyle: { opacity: 0 },
          itemStyle: { color: palette.accent, borderColor: palette.surface, borderWidth: 2 },
          z: 3,
        },
      ],
    };
  }, [activityId, best, palette, row, still]);

  const first = row.history[0];
  const pending = row.history.length - (row.stillAir?.count ?? 0);
  return (
    <>
      {canStill && (
        <div className="t-sa-chart-head">
          <ModeToggle mode={mode} onChange={setMode} label={`${row.name} history shows`} />
        </div>
      )}
      <Chart
        option={option}
        height={150}
        label={`${row.name}: ${still ? "still-air" : "elapsed"} time of every effort, faster higher`}
      />
      <p className="t-note">
        {row.efforts} {row.efforts === 1 ? "effort" : "efforts"}
        {first && ` since ${rideDate(first.date)}`}, faster higher. PR{" "}
        {formatDuration(row.prSeconds)} on{" "}
        {row.prActivityId && row.prActivityId !== activityId ? (
          <Link className="t-link" href={`/training/activities/${row.prActivityId}#segments`}>
            {rideDate(row.prDate, true)}
          </Link>
        ) : (
          rideDate(row.prDate, true)
        )}
        .
        {row.stillAir?.bestSeconds != null && (
          <>
            {" "}
            Best in still air ≈ {formatDuration(row.stillAir.bestSeconds)}
            {row.stillAir.bestDate && (
              <>
                {" "}
                on{" "}
                {row.stillAir.bestActivityId && row.stillAir.bestActivityId !== activityId ? (
                  <Link
                    className="t-link"
                    href={`/training/activities/${row.stillAir.bestActivityId}#segments`}
                  >
                    {rideDate(row.stillAir.bestDate, true)}
                  </Link>
                ) : (
                  rideDate(row.stillAir.bestDate, true)
                )}
              </>
            )}
            .
          </>
        )}
        {still && pending > 0 && ` ${pending} without a still-air time are left out.`}
        {row.stillAir?.impliedWatts != null &&
          ` This effort: ≈ ${row.stillAir.impliedWatts} W steady${
            row.measuredWatts ? `, ${Math.round(row.measuredWatts)} W on your power meter` : ""
          }.`}
        {still && row.stillAir?.check === "worse" && ` ${ROUGH_NOTE}`}
      </p>
    </>
  );
}
