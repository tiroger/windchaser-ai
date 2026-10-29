"use client";

import type { EChartsOption } from "echarts";

import "@/app/training/load.css";

import { formatCalendarDate } from "@/lib/training/activity-types";
import { alpha } from "@/lib/training/color";
import {
  FOCUS_CATEGORIES,
  FOCUS_LABELS,
  LOAD_SOURCES,
  SOURCE_LABELS,
  ratioStatus,
  type ExerciseLoadSource,
  type FocusCategory,
  type RatioStatus,
} from "@/lib/training/metrics/load";
import { LOAD_RATIO } from "@/lib/training/metrics/load-params";
import type { PerformanceSummary } from "@/lib/training/metrics/performance";

import Chart, { axisText, splitLine, tooltip, useChartPalette } from "./Chart";
import { DATE_AXIS_LABELS, rideDate } from "./loop-format";

const RATIO_LABELS: Record<RatioStatus, string> = {
  low: "Low",
  optimal: "Optimal",
  high: "High",
  veryHigh: "Very high",
};

/** One CSS class per category; the colours are the data tokens in load.css. */
const FOCUS_CLASS: Record<FocusCategory, string> = {
  lowAerobic: "is-low",
  highAerobic: "is-high",
  anaerobic: "is-anaerobic",
};

type Shares = Record<ExerciseLoadSource, { activities: number; load: number }>;

/** "62% second-by-second heart rate · 30% average heart rate · 8% power only" */
function SourceNote({ shares, unscored }: { shares: Shares; unscored?: number }) {
  const total = LOAD_SOURCES.reduce((sum, source) => sum + shares[source].load, 0);
  if (total <= 0) return null;
  const parts = LOAD_SOURCES.filter((source) => shares[source].load > 0).map((source) => {
    const share = Math.round((shares[source].load / total) * 100);
    const count = shares[source].activities;
    return `${share}% ${SOURCE_LABELS[source].toLowerCase()} (${count} ${count === 1 ? "activity" : "activities"})`;
  });
  const estimated = shares.garmin.load < total;
  return (
    <p className="t-note t-load-sources">
      {estimated ? <b>Estimated.</b> : null} Load source: {parts.join(" · ")}.
      {unscored ? ` ${unscored} without heart rate or power have no load.` : ""}
    </p>
  );
}

/**
 * Garmin-style training load: acute and chronic load with the optimal band,
 * the load ratio, the four-week load focus, and VO2max with its trend.
 */
export default function ExerciseLoadCards({ performance }: { performance: PerformanceSummary }) {
  return (
    <div className="t-grid t-grid-wide">
      <LoadCard performance={performance} />
      <div className="t-stack">
        <FocusCard performance={performance} />
        <Vo2maxCard performance={performance} />
      </div>
    </div>
  );
}

function LoadCard({ performance }: { performance: PerformanceSummary }) {
  const palette = useChartPalette();
  const text = axisText(palette);
  const { series, seriesSources, recentSources, unscored } = performance.exercise;
  const current = series[series.length - 1];
  const status = current?.ratio != null ? ratioStatus(current.ratio) : null;

  const lower = series.map((point) => point.chronic * LOAD_RATIO.optimalFrom);
  const width = series.map((point) => point.chronic * (LOAD_RATIO.highFrom - LOAD_RATIO.optimalFrom));
  const option: EChartsOption = {
    grid: { top: 30, left: 40, right: 14, bottom: 26 },
    legend: {
      top: 0,
      right: 0,
      textStyle: text,
      itemWidth: 14,
      itemHeight: 3,
      data: ["Acute", "Chronic", "Optimal range"],
    },
    tooltip: {
      ...tooltip(palette),
      trigger: "axis",
      formatter: (items) => {
        const list = Array.isArray(items) ? items : [items];
        const index = list[0]?.dataIndex ?? 0;
        const point = series[index];
        if (!point) return "";
        return [
          `<b>${formatCalendarDate(point.date, { month: "short", day: "numeric" })}</b>`,
          `Acute <b>${Math.round(point.acute)}</b> · chronic <b>${Math.round(point.chronic)}</b>`,
          point.ratio != null ? `Ratio <b>${point.ratio.toFixed(1)}</b> (${RATIO_LABELS[ratioStatus(point.ratio)]})` : "",
          point.load ? `That day <b>${Math.round(point.load)}</b>` : "",
        ]
          .filter(Boolean)
          .join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: series.map((point) => point.date),
      boundaryGap: false,
      axisLabel: {
        ...text,
        formatter: (value: string) => formatCalendarDate(value, { month: "short" }),
        // One label per month, on the first.
        interval: (_index: number, value: string) => value.endsWith("-01"),
      },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.line } },
    },
    yAxis: { type: "value", axisLabel: text, splitLine: splitLine(palette) },
    series: [
      {
        name: "Optimal range base",
        type: "line",
        stack: "band",
        data: lower,
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        tooltip: { show: false },
      },
      {
        name: "Optimal range",
        type: "line",
        stack: "band",
        data: width,
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        itemStyle: { color: alpha(palette.open, 0.5) },
        areaStyle: { color: alpha(palette.open, 0.13) },
      },
      {
        name: "Chronic",
        type: "line",
        showSymbol: false,
        data: series.map((point) => point.chronic),
        lineStyle: { color: palette.wind, width: 2 },
        itemStyle: { color: palette.wind },
      },
      {
        name: "Acute",
        type: "line",
        showSymbol: false,
        data: series.map((point) => point.acute),
        lineStyle: { color: palette.accent, width: 2 },
        itemStyle: { color: palette.accent },
      },
    ],
  };

  return (
    <article className="panel">
      <span className="label">Training load · Garmin scale</span>
      <h2 className="t-card-title">Acute and chronic load</h2>
      {current ? (
        <>
          <div className="t-figures">
            <span>
              <strong className="num">{Math.round(current.acute)}</strong>
              <small>Acute (7-day)</small>
            </span>
            <span>
              <strong className="num">{Math.round(current.chronic)}</strong>
              <small>Chronic (28-day)</small>
            </span>
            {current.ratio != null && status && (
              <span>
                <strong className="num">{current.ratio.toFixed(1)}</strong>
                <small>
                  Load ratio ·{" "}
                  <span className={`t-ratio-chip is-${status}`}>{RATIO_LABELS[status]}</span>
                </small>
              </span>
            )}
          </div>
          <Chart
            option={option}
            height={230}
            label="Acute and chronic training load over the last six months, with the optimal range for acute load"
          />
          <SourceNote shares={recentSources} />
          <details className="t-load-more">
            <summary>Last six months by source</summary>
            <SourceNote shares={seriesSources} unscored={unscored} />
          </details>
        </>
      ) : (
        <p className="t-empty">No activities with heart rate or power yet.</p>
      )}
    </article>
  );
}

function FocusCard({ performance }: { performance: PerformanceSummary }) {
  const { focus, recentSources } = performance.exercise;
  const total = focus.total;
  return (
    <article className="panel">
      <span className="label">Load focus · last 4 weeks</span>
      <h2 className="t-card-title">
        {total > 0
          ? focus.focus === "balanced"
            ? "Balanced"
            : `${FOCUS_LABELS[focus.focus]} focus`
          : "No load yet"}
      </h2>
      {total > 0 && (
        <>
          <div className="t-focus-bar" role="img" aria-label="Share of four-week load by category">
            {FOCUS_CATEGORIES.filter((category) => focus.byCategory[category] > 0).map((category) => (
              <span
                key={category}
                className={FOCUS_CLASS[category]}
                style={{ flexGrow: focus.byCategory[category] }}
              />
            ))}
          </div>
          <ul className="t-focus-legend">
            {FOCUS_CATEGORIES.map((category) => (
              <li key={category}>
                <i className={FOCUS_CLASS[category]} aria-hidden />
                <span>{FOCUS_LABELS[category]}</span>
                <strong className="num">{Math.round(focus.byCategory[category])}</strong>
                <em className="num">{Math.round((focus.byCategory[category] / total) * 100)}%</em>
              </li>
            ))}
          </ul>
          <p className="t-note">
            Each activity counts under its main training benefit, predicted from heart rate (or
            power) as Garmin labels it. {recentSources.garmin.load < total ? "Estimated." : ""}
          </p>
        </>
      )}
    </article>
  );
}

function Vo2maxCard({ performance }: { performance: PerformanceSummary }) {
  const palette = useChartPalette();
  const text = axisText(palette);
  const { vo2max } = performance;
  const massNote =
    performance.weightKg != null
      ? `${performance.weightKg} kg from athlete settings`
      : vo2max.weightKg != null
        ? `${vo2max.weightKg.toFixed(1)} kg, the fitted rider mass from route calibration; set your weight for a truer figure`
        : null;

  // A time axis, so rides sit at their dates: a month without qualifying
  // rides shows as a gap instead of collapsing to one slot.
  const option: EChartsOption = {
    grid: { top: 24, left: 34, right: 10, bottom: 22 },
    legend: { top: 0, right: 0, textStyle: text, itemWidth: 12, itemHeight: 3 },
    tooltip: {
      ...tooltip(palette),
      trigger: "item",
      formatter: (params: unknown) => {
        const { seriesName, value } = params as { seriesName: string; value: [string, number] };
        const label = seriesName === "Ride" ? "Ride" : "6-week median";
        return `<b>${rideDate(value[0], true)}</b><br/>${label} ${value[1].toFixed(1)}`;
      },
    },
    xAxis: {
      type: "time",
      axisLabel: { ...text, hideOverlap: true, formatter: DATE_AXIS_LABELS },
      axisLine: { lineStyle: { color: palette.line } },
      splitLine: { show: false },
    },
    yAxis: { type: "value", scale: true, splitNumber: 3, axisLabel: text, splitLine: splitLine(palette) },
    series: [
      {
        // Dots only: a line series with the line hidden, since the bundle
        // registers no scatter chart.
        name: "Ride",
        type: "line",
        data: vo2max.rides.map((ride) => [ride.date, ride.value]),
        showSymbol: true,
        symbolSize: 8,
        lineStyle: { opacity: 0 },
        itemStyle: { color: alpha(palette.ink3, 0.55), borderColor: palette.surface, borderWidth: 2 },
      },
      {
        name: "VO2max",
        type: "line",
        data: vo2max.trend.map((point) => [point.date, point.value]),
        showSymbol: false,
        lineStyle: { color: palette.accent, width: 2 },
        itemStyle: { color: palette.accent },
      },
    ],
  };

  return (
    <article className="panel">
      <span className="label">Cycling VO2max · estimated</span>
      {vo2max.current != null ? (
        <div className="hero-number t-hero">
          <span className="big">{vo2max.current.toFixed(0)}</span>
          <span className="unit">ml/kg/min</span>
          {vo2max.fromBestFiveMinutes != null && (
            <span className="t-hero-aside num">5-min power says {vo2max.fromBestFiveMinutes.toFixed(0)}</span>
          )}
        </div>
      ) : (
        <p className="t-empty">
          {vo2max.weightKg == null
            ? "Needs your weight in athlete settings."
            : "Needs at least three recent rides with steady power and heart rate. Detail data syncs in the background."}
        </p>
      )}
      {vo2max.trend.length > 1 && (
        <Chart option={option} height={130} label="Estimated cycling VO2max by ride and its trailing median" />
      )}
      <p className="t-note">
        Median of rides over 6 weeks: steady stretches of heart rate against power, extrapolated to
        maximum heart rate and converted with the ACSM cycling equation
        {massNote ? ` at ${massNote}` : ""}. The 5-minute figure is a cross-check from your best
        5-minute power over 90 days.
      </p>
    </article>
  );
}
