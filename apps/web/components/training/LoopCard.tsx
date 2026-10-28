"use client";

import type { EChartsOption } from "echarts";
import Link from "next/link";
import { useMemo, useState } from "react";

import "@/app/training/loops.css";
import { formatDuration } from "@/lib/geo";
import { formatNumber, getActivityKind } from "@/lib/training/activity-types";
import type { LoopDetail, LoopRide } from "@/lib/training/loops";
import type { ActivityStream } from "@/lib/training/metrics/performance";

import Chart, { axisText, splitLine, tooltip, useChartPalette } from "./Chart";
import LoopCompare from "./LoopCompare";
import { DATE_AXIS_LABELS, durationAxis, ordinal, rideDate } from "./loop-format";

type Metric = "time" | "speed" | "power";

const METRICS: Array<{ key: Metric; label: string; read: (ride: LoopRide) => number | null }> = [
  { key: "time", label: "Moving time", read: (ride) => ride.movingSeconds },
  { key: "speed", label: "Avg speed", read: (ride) => ride.averageSpeed },
  { key: "power", label: "Normalized power", read: (ride) => ride.normalizedPower },
];

/** How many rides the ranking shows before "Show all". */
const COLLAPSED_ROWS = 8;

/** The verb for repeating this sport's loop: ridden, run, walked. */
function doneVerb(type: string): string {
  const kind = getActivityKind(type);
  if (kind === "Run") return "Run";
  if (kind === "Walk") return "Walked";
  if (kind === "Swim") return "Swum";
  return "Ridden";
}

/**
 * "This loop": every time the activity's route has been ridden, charted over
 * the years and ranked fastest first, with a second ride to overlay.
 */
export default function LoopCard({
  loop,
  activityId,
  stream,
}: {
  loop: LoopDetail;
  activityId: string;
  stream: ActivityStream | null;
}) {
  const palette = useChartPalette();
  const available = METRICS.filter(
    (metric) => loop.rides.filter((ride) => metric.read(ride) !== null).length >= 2,
  );
  const [metricKey, setMetricKey] = useState<Metric>("time");
  const metric = available.find((entry) => entry.key === metricKey) ?? available[0];
  const [expanded, setExpanded] = useState(false);
  const current = loop.rides.find((ride) => ride.id === activityId);
  const best = loop.rides[0];
  const others = loop.rides.filter((ride) => ride.id !== activityId);
  // The default comparison is the record, or the runner-up when this is it.
  const [compareId, setCompareId] = useState(others[0]?.id ?? "");
  const compare = others.find((ride) => ride.id === compareId) ?? null;
  const firstYear = loop.since.slice(0, 4);
  const timed = loop.rides.filter((ride) => ride.rank !== null).length;

  const option = useMemo<EChartsOption | null>(() => {
    if (!metric) return null;
    const text = axisText(palette);
    const isTime = metric.key === "time";
    const format = (value: number) =>
      isTime
        ? formatDuration(value)
        : metric.key === "speed"
          ? `${formatNumber(value, 1)} mph`
          : `${Math.round(value)} W`;
    const chronological = [...loop.rides]
      .filter((ride) => metric.read(ride) !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
    const point = (ride: LoopRide) => ({
      value: [ride.date, metric.read(ride)!] as [string, number],
      ride,
    });
    const highlighted = chronological.filter((ride) => ride.id === activityId);
    return {
      grid: { top: 14, left: isTime ? 52 : 44, right: 14, bottom: 26 },
      tooltip: {
        ...tooltip(palette),
        trigger: "item",
        formatter: (params: unknown) => {
          const { data } = params as { data: { ride: LoopRide; value: [string, number] } };
          const ride = data.ride;
          const tags = [
            ride.id === activityId ? "this ride" : null,
            ride.rank === 1 ? "fastest" : ride.rank ? `${ordinal(ride.rank)} fastest` : null,
          ].filter(Boolean);
          return `<strong>${rideDate(ride.date, true)}</strong><br/>${format(data.value[1])}${
            tags.length ? `<br/><span style="color:${palette.ink3}">${tags.join(" · ")}</span>` : ""
          }`;
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
        ...(isTime
          ? durationAxis(
              chronological.map((ride) => ride.movingSeconds!),
              60,
            )
          : {}),
        axisLabel: {
          ...text,
          formatter: (value: number) =>
            isTime ? formatDuration(value).replace(/:\d\d$/, "") : String(value),
        },
        splitLine: splitLine(palette),
        name: isTime ? "h:mm" : metric.key === "speed" ? "mph" : "W",
        nameTextStyle: text,
        nameGap: 6,
        nameLocation: "end",
      },
      series: [
        {
          name: metric.label,
          type: "line",
          data: chronological.map(point),
          showSymbol: true,
          symbolSize: 8,
          lineStyle: { color: palette.line, width: 1.5 },
          itemStyle: { color: palette.ink3, borderColor: palette.surface, borderWidth: 2 },
          emphasis: { scale: 1.4 },
          z: 2,
        },
        {
          name: "This ride",
          type: "line",
          data: highlighted.map(point),
          showSymbol: true,
          symbolSize: 13,
          lineStyle: { opacity: 0 },
          itemStyle: { color: palette.accent, borderColor: palette.surface, borderWidth: 2 },
          z: 3,
        },
      ],
    };
  }, [activityId, loop.rides, metric, palette]);

  const rows = expanded ? loop.rides : loop.rides.slice(0, COLLAPSED_ROWS);
  const currentHidden = !expanded && current && !rows.includes(current);

  return (
    <article className="panel t-loop" id="loop">
      <div className="t-card-head">
        <div>
          <span className="label">This loop</span>
          <h2 className="t-card-title">
            {doneVerb(loop.type)} {loop.count} times since {firstYear}
          </h2>
          <p className="t-loop-sub">
            {loop.name} · {formatNumber(loop.distance, 1)} mi
            {current?.rank && timed > 1 && (
              <>
                {" · "}
                <b>
                  {current.rank === 1
                    ? "Your fastest"
                    : `${ordinal(current.rank)} fastest of ${timed}`}
                </b>
              </>
            )}
          </p>
        </div>
        {available.length > 1 && (
          <div className="chip-row" role="group" aria-label="Chart metric">
            {available.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="chip"
                aria-pressed={entry.key === metric?.key}
                onClick={() => setMetricKey(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {option && (
        <>
          <Chart
            option={option}
            height={200}
            label={`${metric!.label} on each ride of this loop, by date`}
          />
          <div className="t-legend t-loop-legend" aria-hidden="true">
            <span>
              <i className="t-loop-dot is-current" /> This ride
            </span>
            <span>
              <i className="t-loop-dot" /> Other rides
            </span>
          </div>
        </>
      )}

      <div className="t-table-scroll">
        <table className="t-table t-loop-table">
          <thead>
            <tr>
              <th className="is-num">#</th>
              <th>Date</th>
              <th className="is-num">Time</th>
              <th className="is-num">Avg speed</th>
              <th className="is-num">NP</th>
              <th className="is-num">Avg HR</th>
              {/* An absolutely positioned visually-hidden label would escape the
                  scroll container and widen the page on phones. */}
              <th aria-label="Compare" />
            </tr>
          </thead>
          <tbody>
            {rows.map((ride) => (
              <LoopRow
                key={ride.id}
                ride={ride}
                isCurrent={ride.id === activityId}
                isBest={ride === best && ride.rank === 1}
                isCompared={ride.id === compare?.id}
                onCompare={() => {
                  setCompareId(ride.id);
                  requestAnimationFrame(() =>
                    document
                      .getElementById("loop-compare")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" }),
                  );
                }}
              />
            ))}
            {currentHidden && current && (
              <LoopRow
                ride={current}
                isCurrent
                isBest={false}
                isCompared={false}
                onCompare={() => {}}
              />
            )}
          </tbody>
        </table>
      </div>
      {loop.rides.length > COLLAPSED_ROWS && (
        <button type="button" className="t-more" onClick={() => setExpanded((open) => !open)}>
          {expanded ? "Show fewer" : `Show all ${loop.rides.length} rides`}
          <span>{expanded ? "↑" : "↓"}</span>
        </button>
      )}
      <p className="t-note">
        Rides are matched by GPS track: same start and finish, the same roads in the same direction,
        and a distance within 10%. Ranked by average speed, since recorded distance varies a little
        from ride to ride.
      </p>

      {current && compare && (
        <LoopCompare
          current={current}
          other={compare}
          others={others}
          onSelect={setCompareId}
          stream={stream}
        />
      )}
    </article>
  );
}

function LoopRow({
  ride,
  isCurrent,
  isBest,
  isCompared,
  onCompare,
}: {
  ride: LoopRide;
  isCurrent: boolean;
  isBest: boolean;
  isCompared: boolean;
  onCompare: () => void;
}) {
  return (
    <tr className={isCurrent ? "is-current" : undefined}>
      <td className="is-num">{ride.rank ?? "—"}</td>
      <td>
        {isCurrent ? (
          <span className="t-loop-date">{rideDate(ride.date, true)}</span>
        ) : (
          <Link className="t-loop-date" href={`/training/activities/${ride.id}#loop`}>
            {rideDate(ride.date, true)}
          </Link>
        )}
        {isBest && <span className="t-badge is-pr">Best</span>}
        {isCurrent && <span className="t-badge">This ride</span>}
      </td>
      <td className="is-num">{ride.movingSeconds ? formatDuration(ride.movingSeconds) : "—"}</td>
      <td className="is-num">{ride.averageSpeed ? formatNumber(ride.averageSpeed, 1) : "—"}</td>
      <td className="is-num">
        {ride.normalizedPower ? `${Math.round(ride.normalizedPower)} W` : "—"}
      </td>
      <td className="is-num">{ride.averageHeartrate ? Math.round(ride.averageHeartrate) : "—"}</td>
      <td className="t-loop-action">
        {!isCurrent && (
          <button
            type="button"
            className="t-loop-compare"
            aria-pressed={isCompared}
            onClick={onCompare}
          >
            {isCompared ? "Comparing" : "Compare"}
          </button>
        )}
      </td>
    </tr>
  );
}
