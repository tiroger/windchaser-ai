"use client";

import type { EChartsOption } from "echarts";

import { formatMetric, type CalendarDate, type MetricKey } from "@/lib/training/activity-types";
import { alpha, mix } from "@/lib/training/color";
import { MONTH_TICKS, type Progression } from "@/lib/training/metrics/progression";

import Chart, { axisText, splitLine, tooltip, useChartPalette } from "./Chart";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function positionLabel(position: number): string {
  let month = 0;
  while (month < 11 && MONTH_TICKS[month + 1] <= position) month++;
  return `${MONTHS[month]} ${position - MONTH_TICKS[month] + 1}`;
}

/**
 * Cumulative totals by day of year, one line per year: the highlighted year in
 * the accent, last year in secondary ink, every other year faint behind them.
 * The current year's monthly totals sit underneath as a wash of bars.
 */
export default function ProgressionChart({
  progression,
  metric,
  highlightYear,
  today,
  height = 300,
}: {
  progression: Progression;
  metric: MetricKey;
  highlightYear: number;
  today: CalendarDate;
  height?: number;
}) {
  const palette = useChartPalette();
  const { series, onPace, todayPosition, currentMonthly } = progression;
  if (!series.length) {
    return <div className="t-chart-empty">No activities to chart yet.</div>;
  }
  const isCurrent = highlightYear === today.year;
  const previousYear = highlightYear - 1;
  const text = axisText(palette);
  const earlier = mix(palette.ink3, palette.surface, 0.55);

  const lines = series.map((entry) => {
    const highlighted = entry.year === highlightYear;
    const previous = entry.year === previousYear;
    const color = highlighted ? palette.accent : previous ? palette.ink2 : earlier;
    return {
      name: String(entry.year),
      type: "line" as const,
      showSymbol: false,
      z: highlighted ? 5 : previous ? 4 : 2,
      lineStyle: { width: highlighted ? 3 : previous ? 1.6 : 1, color },
      itemStyle: { color },
      areaStyle: highlighted ? { color: alpha(palette.accent, 0.07) } : undefined,
      emphasis: { focus: "series" as const, lineStyle: { width: 3 } },
      endLabel: {
        show: highlighted || previous,
        formatter: `{a}`,
        color,
        fontFamily: palette.fontMono,
        fontSize: highlighted ? 12 : 10,
        fontWeight: highlighted ? 600 : 400,
      },
      data: entry.cumulative.map((value, index) => [index + 1, Math.round(value * 10) / 10]),
      markLine:
        highlighted && isCurrent && onPace !== null
          ? {
              symbol: "none",
              silent: true,
              lineStyle: { color: palette.ink3, type: "dashed" as const, width: 1 },
              label: {
                formatter: `On pace for ${formatMetric(onPace, metric)}`,
                color: palette.ink,
                fontSize: 11,
                fontWeight: 500,
                position: "insideEndTop" as const,
              },
              data: [{ xAxis: todayPosition }],
            }
          : undefined,
    };
  });

  const option: EChartsOption = {
    animationDuration: 400,
    grid: { top: 26, left: 56, right: 48, bottom: 28 },
    tooltip: {
      ...tooltip(palette),
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: palette.ink3 } },
      formatter: (items) => {
        const list = (Array.isArray(items) ? items : [items]).filter(
          (item) => item.seriesType === "line" && Array.isArray(item.value),
        );
        if (!list.length) return "";
        const position = (list[0].value as number[])[0];
        const rows = list
          .map((item) => ({
            name: item.seriesName ?? "",
            value: (item.value as number[])[1],
            marker: item.marker,
          }))
          .sort((a, b) =>
            a.name === String(highlightYear)
              ? -1
              : b.name === String(highlightYear)
                ? 1
                : b.value - a.value,
          )
          .slice(0, 8)
          .map((row) => `${row.marker} ${row.name}: <b>${formatMetric(row.value, metric)}</b>`);
        return [`<b>${positionLabel(position)}</b>`, ...rows].join("<br/>");
      },
    },
    xAxis: [
      {
        type: "value",
        min: 1,
        max: 365,
        axisLine: { lineStyle: { color: palette.line } },
        splitLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          ...text,
          customValues: MONTH_TICKS,
          formatter: (value: number) => MONTHS[MONTH_TICKS.indexOf(value)] ?? "",
        },
      },
      { type: "category", data: MONTHS, show: false },
    ],
    yAxis: {
      type: "value",
      min: 0,
      splitLine: splitLine(palette),
      axisLabel: {
        ...text,
        formatter: (value: number) =>
          metric === "time" ? `${Math.round(value)}h` : value.toLocaleString("en-US"),
      },
    },
    series: [
      ...(isCurrent
        ? [
            {
              name: "This month",
              type: "bar" as const,
              xAxisIndex: 1,
              silent: true,
              barCategoryGap: "8%",
              itemStyle: { color: alpha(palette.accent, 0.14), borderRadius: [3, 3, 0, 0] },
              data: currentMonthly.map((value) => Math.round(value * 10) / 10),
              z: 1,
            },
          ]
        : []),
      ...lines,
    ],
  };

  return (
    <Chart
      option={option}
      height={height}
      label={`Cumulative ${metric} by day of year for ${series.map((s) => s.year).join(", ")}, ${highlightYear} highlighted.`}
    />
  );
}
