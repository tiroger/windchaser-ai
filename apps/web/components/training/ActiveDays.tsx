"use client";

import type { EChartsOption } from "echarts";

import {
  formatCalendarDate,
  formatHours,
  formatNumber,
  SPORT_LABELS,
  type Activity,
  type CalendarDate,
} from "@/lib/training/activity-types";
import { mix } from "@/lib/training/color";
import { activeDays } from "@/lib/training/metrics/active-days";

import Chart, { axisText, tooltip, useChartPalette } from "./Chart";
import { sportColor } from "./SportIcon";

/**
 * A year as a calendar, GitHub style: each day shaded by active hours, with
 * the streaks and the sport mix beside it.
 */
export default function ActiveDays({
  activities,
  year,
  today,
  compact = false,
}: {
  activities: Activity[];
  year: number;
  today: CalendarDate;
  compact?: boolean;
}) {
  const palette = useChartPalette();
  const summary = activeDays(activities, year, today);
  const maxHours = Math.max(1, ...summary.days.map((day) => day.hours));
  const text = axisText(palette);

  const calendar: EChartsOption = {
    tooltip: {
      ...tooltip(palette),
      formatter: (item) => {
        const [date, hours, count] = (item as unknown as { value: [string, number, number] }).value;
        return `<b>${formatCalendarDate(date, { weekday: "short", month: "short", day: "numeric" })}</b><br/>${count} ${count === 1 ? "activity" : "activities"} · ${formatHours(hours)}`;
      },
    },
    visualMap: {
      show: false,
      min: 0,
      max: maxHours,
      // From a faint wash of the accent to the accent itself, then past it
      // toward the ink: darker on light ground, brighter on dark.
      inRange: {
        color: [
          mix(palette.accent, palette.surface2, 0.78),
          mix(palette.accent, palette.surface2, 0.45),
          palette.accent,
          mix(palette.accent, palette.ink, 0.35),
        ],
      },
    },
    calendar: {
      top: 22,
      left: 30,
      right: 6,
      bottom: 4,
      range: String(year),
      cellSize: ["auto", 13],
      splitLine: { show: false },
      itemStyle: { color: palette.surface2, borderColor: palette.surface, borderWidth: 2 },
      dayLabel: { ...text, firstDay: 1, nameMap: ["S", "M", "T", "W", "T", "F", "S"] },
      monthLabel: { ...text },
      yearLabel: { show: false },
    },
    series: [
      {
        type: "heatmap",
        coordinateSystem: "calendar",
        data: summary.days.map((day) => [day.date, Math.round(day.hours * 100) / 100, day.count]),
      },
    ],
  };

  const pie: EChartsOption = {
    tooltip: {
      ...tooltip(palette),
      formatter: (item) => {
        const entry = item as { name: string; value: number; percent: number };
        return `${entry.name}: <b>${entry.value}</b> (${entry.percent}%)`;
      },
    },
    series: [
      {
        type: "pie",
        radius: ["58%", "82%"],
        padAngle: 2,
        itemStyle: { borderRadius: 3 },
        label: { show: false },
        data: summary.byKind.map((entry) => ({
          name: SPORT_LABELS[entry.kind],
          value: entry.count,
          itemStyle: { color: sportColor(entry.kind, palette) },
        })),
      },
    ],
  };

  const percent = summary.daysElapsed ? summary.activeDays / summary.daysElapsed : 0;
  return (
    <div className={`t-active-days ${compact ? "is-compact" : ""}`}>
      <div className="t-figures">
        <span>
          <strong className="num">{summary.activeDays}</strong>
          <small>
            of {summary.daysElapsed} days active ({Math.round(percent * 100)}%)
          </small>
        </span>
        <span>
          <strong className="num">{summary.longestStreak}</strong>
          <small>day longest streak</small>
        </span>
        {year === today.year && (
          <span>
            <strong className="num">{summary.currentStreak}</strong>
            <small>day current streak</small>
          </span>
        )}
      </div>
      <div className="t-active-days-body">
        <Chart option={calendar} height={128} label={`Calendar of active days in ${year}`} />
        {summary.byKind.length > 1 && (
          <div className="t-sport-mix">
            <Chart option={pie} height={112} label={`Activities by sport in ${year}`} />
            <ul>
              {summary.byKind.slice(0, 5).map((entry) => (
                <li key={entry.kind}>
                  <i style={{ background: sportColor(entry.kind, palette) }} />
                  {SPORT_LABELS[entry.kind]}
                  <b className="num">{formatNumber(entry.count)}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
