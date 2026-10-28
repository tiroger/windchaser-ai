"use client";

import type { EChartsOption } from "echarts";
import Link from "next/link";
import { useMemo, useState } from "react";

import "@/app/training/loops.css";
import { compassLabel, formatDelta, formatDuration } from "@/lib/geo";
import { formatNumber } from "@/lib/training/activity-types";
import type { EffortWeather, SegmentEffortRow } from "@/lib/training/segments";

import Chart, { axisText, splitLine, tooltip, useChartPalette } from "./Chart";
import { ordinal, rideDate } from "./loop-format";

const MPH_PER_MS = 2.23694;

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

function RankBadge({ rank, of }: { rank: number; of: number }) {
  if (rank === 1) return <span className="t-badge is-pr">PR</span>;
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
  return (
    <article className="panel t-segments" id="segments">
      <span className="label">Segments</span>
      <h2 className="t-card-title">
        {segments.length
          ? `${segments.length} tracked segment ${segments.length === 1 ? "effort" : "efforts"}`
          : "No tracked segments"}
      </h2>
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
                  </span>
                  <span className="t-seg-time num">{formatDuration(row.elapsedSeconds)}</span>
                  <span className="t-seg-badge">
                    <RankBadge rank={row.rank} of={row.efforts} />
                  </span>
                  <span className="t-seg-delta num">
                    {row.deltaSeconds === 0 ? (
                      <small>{row.efforts > 1 ? `best of ${row.efforts}` : "first effort"}</small>
                    ) : (
                      <>
                        {formatDelta(row.deltaSeconds)}
                        <small>PR {rideDate(row.prDate)}</small>
                      </>
                    )}
                  </span>
                  <span className="t-seg-chevron" aria-hidden="true">
                    {isOpen ? "−" : "+"}
                  </span>
                </button>
                {isOpen && (
                  <div className="t-seg-history" id={`segment-history-${index}`}>
                    <SegmentHistory row={row} activityId={activityId} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="t-note">
        Ranked against every effort WindChaser has recorded on each segment. Weather is the hourly
        reanalysis for when you rode it.
      </p>
    </article>
  );
}

function SegmentHistory({ row, activityId }: { row: SegmentEffortRow; activityId: string }) {
  const palette = useChartPalette();
  const option = useMemo<EChartsOption>(() => {
    const text = axisText(palette);
    const point = (entry: SegmentEffortRow["history"][number]) => ({
      value: [entry.date, entry.elapsedSeconds] as [string, number],
      entry,
    });
    const isThis = (entry: SegmentEffortRow["history"][number]) =>
      entry.activityId === activityId && entry.elapsedSeconds === row.elapsedSeconds;
    return {
      grid: { top: 12, left: 46, right: 12, bottom: 24 },
      tooltip: {
        ...tooltip(palette),
        trigger: "item",
        formatter: (params: unknown) => {
          const { data } = params as {
            data: { entry: SegmentEffortRow["history"][number]; value: [string, number] };
          };
          const delta = data.value[1] - row.prSeconds;
          return `<strong>${rideDate(data.entry.date, true)}</strong><br/>${formatDuration(
            data.value[1],
          )}${delta === 0 ? " · PR" : ` · ${formatDelta(delta)}`}`;
        },
      },
      xAxis: {
        type: "time",
        axisLabel: { ...text, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        inverse: true,
        axisLabel: { ...text, formatter: (value: number) => formatDuration(value) },
        splitLine: splitLine(palette),
      },
      series: [
        {
          name: "Efforts",
          type: "line",
          data: row.history.map(point),
          showSymbol: true,
          symbolSize: 7,
          lineStyle: { color: palette.line, width: 1.5 },
          itemStyle: { color: palette.ink3, borderColor: palette.surface, borderWidth: 1.5 },
          markLine: {
            symbol: "none",
            silent: true,
            lineStyle: { color: palette.ink3, type: "dashed" },
            label: {
              position: "insideStartTop",
              formatter: `PR ${formatDuration(row.prSeconds)}`,
              color: palette.ink2,
              fontSize: 10,
              fontFamily: palette.fontMono,
            },
            data: [{ yAxis: row.prSeconds }],
          },
        },
        {
          name: "This effort",
          type: "line",
          data: row.history.filter(isThis).map(point),
          showSymbol: true,
          symbolSize: 12,
          lineStyle: { opacity: 0 },
          itemStyle: { color: palette.accent, borderColor: palette.surface, borderWidth: 2 },
          z: 3,
        },
      ],
    };
  }, [activityId, palette, row]);

  const first = row.history[0];
  return (
    <>
      <Chart
        option={option}
        height={150}
        label={`${row.name}: elapsed time of every effort, faster higher`}
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
      </p>
    </>
  );
}
