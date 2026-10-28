"use client";

import type { EChartsOption } from "echarts";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo } from "react";

import {
  formatCalendarDate,
  formatHours,
  formatNumber,
  getActivityKind,
  sportLabel,
  type Activity,
  type Gear,
} from "@/lib/training/activity-types";
import { alpha } from "@/lib/training/color";
import {
  ftpOn,
  HEART_RATE_ZONES,
  POWER_ZONES,
  rideMetrics,
  timeInZones,
  type ActivityStream,
  type PerformanceSummary,
} from "@/lib/training/metrics/performance";

import Chart, { axisText, splitLine, tooltip, useChartPalette } from "./Chart";
import RouteAnalysis, { TrackStats, type RouteTrack } from "./RouteAnalysis";
import SportIcon, { sportTone } from "./SportIcon";
import { useTraining } from "./TrainingProvider";

const RouteMap = dynamic(() => import("./RouteMap"), {
  ssr: false,
  loading: () => <div className="t-map is-loading">Loading map…</div>,
});

export type ActivityDetailData = { polyline: string | null; stream: ActivityStream | null };

/** The part of the performance model one activity needs: thresholds on its date and its load. */
export type ActivityPerformance = Pick<
  PerformanceSummary,
  "ftp" | "ftpHistory" | "heartRate" | "weightKg" | "loads"
>;

const PEAK_DURATIONS: Array<[number, string]> = [
  [5, "5 sec"],
  [15, "15 sec"],
  [60, "1 min"],
  [300, "5 min"],
  [1200, "20 min"],
  [3600, "1 hour"],
];

/**
 * One activity in full: headline stats, the route with its gradient profile
 * and climbs, power and heart-rate analysis, zones and peak power.
 *
 * Everything arrives from the server render, privacy-trimmed there, so the
 * page opens complete instead of loading in a second round trip.
 */
export default function ActivityDetail({
  activity,
  gear,
  performance,
  detail,
}: {
  activity: Activity;
  gear: Gear[];
  performance: ActivityPerformance | null;
  detail: ActivityDetailData;
}) {
  const palette = useChartPalette();
  const text = axisText(palette);
  const stream = detail.stream;
  const samples = useMemo(() => stream?.samples ?? {}, [stream]);
  const track = useMemo<RouteTrack | null>(() => {
    const { distance, altitude, latlng } = samples;
    if (!distance || !altitude) return null;
    const keep = distance.flatMap((miles, index) =>
      miles !== null && altitude[index] !== null && altitude[index] !== undefined ? [index] : [],
    );
    if (keep.length < 10) return null;
    return {
      distance: keep.map((index) => distance[index]!),
      altitude: keep.map((index) => altitude[index]!),
      latlng: latlng ? keep.map((index) => latlng[index] ?? null) : null,
    };
  }, [samples]);
  const summary = stream?.summary ?? null;
  const ftp = performance
    ? performance.ftp?.source === "override"
      ? performance.ftp.ftp
      : ftpOn(performance.ftpHistory, activity.date.slice(0, 10))
    : null;
  const heartRate = performance?.heartRate ?? { restingHr: 49, maxHr: 190 };
  const metrics = summary ? rideMetrics(summary, ftp, heartRate) : null;
  const load = performance?.loads[activity.id];
  const bike = gear.find((item) => item.id === activity.gear_id);
  const kind = getActivityKind(activity.type);
  const weight = performance?.weightKg ?? null;

  const stats: Array<[string, string]> = [];
  if (activity.distance > 0) stats.push(["Distance", `${formatNumber(activity.distance, 1)} mi`]);
  stats.push(["Moving time", formatHours(activity.moving_time)]);
  if (activity.total_elevation_gain > 0) {
    stats.push(["Elevation", `${formatNumber(activity.total_elevation_gain)} ft`]);
  }
  if (activity.average_speed > 0 && kind !== "Pickleball") {
    stats.push(["Average speed", `${formatNumber(activity.average_speed, 1)} mph`]);
  }
  if (activity.average_heartrate) {
    stats.push([
      "Heart rate",
      `${Math.round(activity.average_heartrate)} avg · ${Math.round(activity.max_heartrate ?? 0)} max`,
    ]);
  }
  if (activity.average_watts) stats.push(["Power", `${Math.round(activity.average_watts)} W avg`]);
  if (activity.kilojoules) {
    stats.push([
      "Energy",
      `${formatNumber(activity.kilojoules)} kJ ≈ ${formatNumber(activity.kilojoules)} kcal`,
    ]);
  }
  if (load) stats.push(["Training load", `${Math.round(load.tss)} (${load.source})`]);
  if (activity.suffer_score) stats.push(["Relative Effort", formatNumber(activity.suffer_score)]);
  stats.push(["Kudos", formatNumber(activity.kudos_count)]);

  const analysis: Array<[string, string, string]> = [];
  if (metrics) {
    if (summary?.normalized_power) {
      analysis.push([
        "Normalized Power",
        `${Math.round(summary.normalized_power)} W`,
        "30-second rolling power, weighted for physiological cost",
      ]);
    }
    if (metrics.intensity) {
      analysis.push([
        "Intensity Factor",
        metrics.intensity.toFixed(2),
        `Normalized Power ÷ FTP (${ftp} W on this date)`,
      ]);
    }
    if (metrics.tss) {
      analysis.push([
        "Training Stress Score",
        Math.round(metrics.tss).toString(),
        "An hour at FTP scores 100; uses moving time only",
      ]);
    }
    if (metrics.variabilityIndex) {
      analysis.push([
        "Variability Index",
        metrics.variabilityIndex.toFixed(2),
        "Normalized ÷ average power; near 1.0 means steady",
      ]);
    }
    if (metrics.efficiencyFactor) {
      analysis.push([
        "Efficiency Factor",
        metrics.efficiencyFactor.toFixed(2),
        "Normalized Power per heartbeat; rises as aerobic fitness improves",
      ]);
    }
    if (metrics.decoupling !== null) {
      analysis.push([
        "Aerobic decoupling",
        `${metrics.decoupling.toFixed(1)}%`,
        "Drop in power per heartbeat from first to second half; under 5% suggests good endurance",
      ]);
    }
    if (metrics.trimp) {
      analysis.push([
        "TRIMP",
        Math.round(metrics.trimp).toString(),
        `Banister heart-rate impulse, resting ${heartRate.restingHr} / max ${heartRate.maxHr} bpm`,
      ]);
    }
  }

  const time = samples.time ?? [];
  const minutes = time.map((seconds) =>
    seconds === null ? null : Math.round((seconds / 60) * 10) / 10,
  );
  const profile: EChartsOption | null =
    samples.distance && samples.altitude
      ? {
          grid: { top: 12, left: 46, right: 12, bottom: 26 },
          tooltip: {
            ...tooltip(palette),
            trigger: "axis",
            valueFormatter: (value) => `${formatNumber(Number(value))} ft`,
          },
          xAxis: {
            type: "value",
            axisLabel: { ...text, formatter: (value: number) => `${value} mi` },
            splitLine: { show: false },
            max: "dataMax",
          },
          yAxis: { type: "value", scale: true, axisLabel: text, splitLine: splitLine(palette) },
          series: [
            {
              type: "line",
              showSymbol: false,
              data: samples.distance.map((distance, index) => [distance, samples.altitude![index]]),
              lineStyle: { color: palette.ink2, width: 1.4 },
              areaStyle: { color: alpha(palette.ink2, 0.12) },
            },
          ],
        }
      : null;

  const effort: EChartsOption | null =
    samples.watts || samples.heartrate
      ? {
          grid: { top: 34, left: 42, right: 42, bottom: 26 },
          legend: { top: 0, left: "center", textStyle: text, itemWidth: 12, itemHeight: 3 },
          tooltip: { ...tooltip(palette), trigger: "axis" },
          xAxis: {
            type: "value",
            max: "dataMax",
            axisLabel: { ...text, formatter: (value: number) => `${Math.round(value)} min` },
            splitLine: { show: false },
          },
          yAxis: [
            {
              type: "value",
              name: "W",
              nameTextStyle: text,
              axisLabel: text,
              splitLine: splitLine(palette),
            },
            {
              type: "value",
              name: "bpm",
              nameTextStyle: text,
              axisLabel: text,
              splitLine: { show: false },
              scale: true,
            },
          ],
          series: [
            ...(samples.watts
              ? [
                  {
                    name: "Power",
                    type: "line" as const,
                    showSymbol: false,
                    sampling: "lttb" as const,
                    data: samples.watts.map((watts, index) => [minutes[index], watts]),
                    lineStyle: { color: palette.effort, width: 1 },
                    itemStyle: { color: palette.effort },
                    markLine: ftp
                      ? {
                          symbol: "none",
                          silent: true,
                          lineStyle: { color: palette.ink3, type: "dashed" as const },
                          label: {
                            // Inside the plot: the default end position runs
                            // past the right axis and gets clipped.
                            position: "insideEndTop" as const,
                            formatter: `FTP ${ftp} W`,
                            color: palette.ink2,
                            fontSize: 10,
                            fontFamily: palette.fontMono,
                          },
                          data: [{ yAxis: ftp }],
                        }
                      : undefined,
                  },
                ]
              : []),
            ...(samples.heartrate
              ? [
                  {
                    name: "Heart rate",
                    type: "line" as const,
                    yAxisIndex: 1,
                    showSymbol: false,
                    data: samples.heartrate.map((bpm, index) => [minutes[index], bpm]),
                    lineStyle: { color: palette.alert, width: 1.2 },
                    itemStyle: { color: palette.alert },
                  },
                ]
              : []),
          ],
        }
      : null;

  const powerZones =
    samples.watts && ftp ? timeInZones(time, samples.watts, ftp, POWER_ZONES) : null;
  const hrZones = samples.heartrate
    ? timeInZones(time, samples.heartrate, heartRate.maxHr, HEART_RATE_ZONES)
    : null;
  const bests = summary?.power_bests ?? {};
  const routeMap = (height: number) =>
    detail.polyline ? (
      <RouteMap routes={[{ id: activity.id, polyline: detail.polyline }]} variant="route" height={height} />
    ) : undefined;

  return (
    <section className="t-stack">
      <article className="panel">
        <BackLink />
        <div className="t-detail-title">
          <span className={`t-icon-chip is-large ${sportTone(kind)}`}>
            <SportIcon type={activity.type} />
          </span>
          <div>
            <h1>{activity.name}</h1>
            <p>
              {formatCalendarDate(activity.date, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              {" · "}
              {sportLabel(activity.type)}
              {bike && ` · ${bike.name}`}
            </p>
          </div>
        </div>
        <div className="t-stats">
          {stats.map(([label, value]) => (
            <span key={label}>
              <small>{label}</small>
              <strong className="num">{value}</strong>
            </span>
          ))}
          {track && <TrackStats track={track} />}
        </div>
      </article>

      {track && <RouteAnalysis track={track} mapFallback={routeMap(460)} />}

      <div className="t-grid t-grid-even">
        {activity.hasRoute && !track && (
          <article className="panel">
            <span className="label">Route</span>
            {routeMap(330) ?? (
              <div className="t-map is-loading">Route is within the hidden area around home.</div>
            )}
            <p className="t-note">The first and last 500 m are hidden to keep home private.</p>
          </article>
        )}
        <article className="panel">
          <span className="label">Analysis</span>
          {!stream && (
            <p className="t-empty">
              Second-by-second data for this activity has not been synced yet. The worker
              backfills older activities a few dozen at a time.
            </p>
          )}
          {analysis.length > 0 && (
            <dl className="t-analysis">
              {analysis.map(([label, value, help]) => (
                <div key={label} title={help}>
                  <dt>{label}</dt>
                  <dd className="num">{value}</dd>
                  <small>{help}</small>
                </div>
              ))}
            </dl>
          )}
          {Object.keys(bests).length > 0 && (
            <div className="t-table-scroll">
              <table className="t-table t-peaks">
                <thead>
                  <tr>
                    <th>Peak power</th>
                    <th className="is-num">Watts</th>
                    {weight && <th className="is-num">W/kg</th>}
                    {ftp && <th className="is-num">% FTP</th>}
                  </tr>
                </thead>
                <tbody>
                  {PEAK_DURATIONS.filter(([seconds]) => bests[String(seconds)]).map(
                    ([seconds, label]) => {
                      const watts = bests[String(seconds)];
                      return (
                        <tr key={seconds}>
                          <td>{label}</td>
                          <td className="is-num">{watts}</td>
                          {weight && <td className="is-num">{(watts / weight).toFixed(2)}</td>}
                          {ftp && (
                            <td className="is-num">{Math.round((watts / ftp) * 100)}%</td>
                          )}
                        </tr>
                      );
                    },
                  )}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </div>

      {(effort || (profile && !track)) && (
        <div className="t-grid t-grid-even">
          {effort && (
            <article className="panel">
              <span className="label">Effort</span>
              <Chart option={effort} height={240} label="Power and heart rate over the activity" />
            </article>
          )}
          {profile && !track && (
            <article className="panel">
              <span className="label">Elevation profile</span>
              <Chart option={profile} height={240} label="Elevation over distance" />
            </article>
          )}
        </div>
      )}

      {(powerZones || hrZones) && (
        <div className="t-grid t-grid-even">
          {powerZones && ftp && (
            <ZoneBars
              title={`Power zones · FTP ${ftp} W`}
              zones={POWER_ZONES.map((zone) => zone.name)}
              seconds={powerZones}
              tone="is-power"
            />
          )}
          {hrZones && (
            <ZoneBars
              title={`Heart rate zones · max ${heartRate.maxHr} bpm`}
              zones={HEART_RATE_ZONES.map((zone) => zone.name)}
              seconds={hrZones}
              tone="is-heart"
            />
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Back to wherever the rider came from (the heatmap, a year's best, the log),
 * which browser history already knows. A direct visit has no such history, so
 * the link itself goes to the activity list.
 */
function BackLink() {
  const { canGoBack } = useTraining();
  return (
    <Link
      className="t-link t-back"
      href="/training/activities"
      onClick={(event) => {
        if (canGoBack()) {
          event.preventDefault();
          window.history.back();
        }
      }}
    >
      ← Back
    </Link>
  );
}

function ZoneBars({
  title,
  zones,
  seconds,
  tone,
}: {
  title: string;
  zones: string[];
  seconds: number[];
  tone: "is-power" | "is-heart";
}) {
  const total = seconds.reduce((sum, value) => sum + value, 0) || 1;
  const top = seconds.indexOf(Math.max(...seconds));
  return (
    <article className="panel">
      <span className="label">{title}</span>
      <ul className={`t-zones ${tone}`}>
        {zones.map((zone, index) => (
          <li key={zone} className={index === top ? "is-top" : ""}>
            <span>
              Z{index + 1} {zone}
            </span>
            <span className="bar-track">
              <i style={{ width: `${(seconds[index] / total) * 100}%` }} />
            </span>
            <b className="num">{formatHours(seconds[index] / 3600)}</b>
          </li>
        ))}
      </ul>
    </article>
  );
}
