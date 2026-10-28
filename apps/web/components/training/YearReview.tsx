"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  activityYear,
  formatCalendarDate,
  formatHours,
  formatNumber,
  isDistanceSport,
  METRIC_LABELS,
  metricsFor,
  type Activity,
  type MetricKey,
  type SportFilter,
} from "@/lib/training/activity-types";
import { progression } from "@/lib/training/metrics/progression";

import ActiveDays from "./ActiveDays";
import ProgressionChart from "./ProgressionChart";
import { useTraining } from "./TrainingProvider";

const EARTH_CIRCUMFERENCE_MI = 24_901;

type Best = { label: string; value: string; activity: Activity };

function bestBy(
  activities: Activity[],
  label: string,
  score: (activity: Activity) => number | null,
  format: (value: number) => string,
): Best | null {
  let top: { activity: Activity; value: number } | null = null;
  for (const activity of activities) {
    const value = score(activity);
    if (value !== null && value > 0 && (!top || value > top.value)) top = { activity, value };
  }
  return top ? { label, value: format(top.value), activity: top.activity } : null;
}

/** One season against every other: totals, personal bests, and the calendar. */
export default function YearReview({
  activities,
  filter,
}: {
  activities: Activity[];
  filter: SportFilter;
}) {
  const { today } = useTraining();
  const metrics = metricsFor(filter);
  const [metricChoice, setMetric] = useState<MetricKey>(metrics[0]);
  const metric = metrics.includes(metricChoice) ? metricChoice : metrics[0];
  const years = useMemo(
    () =>
      Array.from(
        new Set(activities.map(activityYear).filter((year): year is number => !!year)),
      ).sort((a, b) => b - a),
    [activities],
  );
  const [selectedYear, setSelectedYear] = useState<number | undefined>();
  const year = selectedYear && years.includes(selectedYear) ? selectedYear : years[0];
  const yearActivities = activities.filter((activity) => activityYear(activity) === year);
  const result = useMemo(() => progression(activities, metric, today), [activities, metric, today]);

  if (!year) {
    return <div className="panel t-empty">No activity history is available yet.</div>;
  }

  const sum = (pick: (activity: Activity) => number | null) =>
    yearActivities.reduce((total, activity) => total + (pick(activity) ?? 0), 0);
  const distance = sum((activity) => activity.distance);
  const hours = sum((activity) => activity.moving_time);
  const energy = sum((activity) => activity.kilojoules);
  const kudos = sum((activity) => activity.kudos_count);
  const heartRates = yearActivities.flatMap((activity) =>
    activity.average_heartrate ? [activity.average_heartrate] : [],
  );
  const distanceSport = isDistanceSport(filter);

  const stats: Array<[string, string, string?]> = distanceSport
    ? [
        ["Activities", formatNumber(yearActivities.length)],
        [
          "Distance",
          `${formatNumber(distance)} mi`,
          filter === "All" || filter === "Ride"
            ? `${((distance / EARTH_CIRCUMFERENCE_MI) * 100).toFixed(1)}% around the Earth`
            : undefined,
        ],
        ["Moving time", formatHours(hours)],
        ["Elevation", `${formatNumber(sum((activity) => activity.total_elevation_gain))} ft`],
        [
          "Calories",
          energy ? `${formatNumber(energy)} kcal` : "—",
          energy ? "from rides with power" : undefined,
        ],
        ["Kudos", formatNumber(kudos)],
      ]
    : [
        ["Sessions", formatNumber(yearActivities.length)],
        ["Time played", formatHours(hours)],
        [
          "Average session",
          yearActivities.length ? formatHours(hours / yearActivities.length) : "—",
        ],
        [
          "Average heart rate",
          heartRates.length
            ? `${Math.round(heartRates.reduce((a, b) => a + b, 0) / heartRates.length)} bpm`
            : "—",
        ],
        [
          "Active days",
          formatNumber(new Set(yearActivities.map((activity) => activity.date.slice(0, 10))).size),
        ],
        ["Kudos", formatNumber(kudos)],
      ];

  const sessionsPerDay = new Map<string, Activity[]>();
  for (const activity of yearActivities) {
    const day = activity.date.slice(0, 10);
    sessionsPerDay.set(day, [...(sessionsPerDay.get(day) ?? []), activity]);
  }
  const busiest = [...sessionsPerDay.values()].sort((a, b) => b.length - a.length)[0];

  const bests = (
    distanceSport
      ? [
          bestBy(yearActivities, "Longest distance", (a) => a.distance, (v) => `${formatNumber(v, 1)} mi`),
          bestBy(yearActivities, "Longest time", (a) => a.moving_time, formatHours),
          bestBy(yearActivities, "Most elevation", (a) => a.total_elevation_gain, (v) => `${formatNumber(v)} ft`),
          bestBy(
            yearActivities,
            "Fastest average (10+ mi)",
            (a) => (a.distance >= 10 ? a.average_speed : null),
            (v) => `${v.toFixed(1)} mph`,
          ),
          bestBy(yearActivities, "Peak power", (a) => a.max_watts, (v) => `${formatNumber(v)} W`),
          bestBy(yearActivities, "Highest Relative Effort", (a) => a.suffer_score, (v) => formatNumber(v)),
        ]
      : [
          bestBy(yearActivities, "Longest session", (a) => a.moving_time, formatHours),
          busiest && busiest.length > 1
            ? { label: "Most sessions in a day", value: String(busiest.length), activity: busiest[0] }
            : null,
          bestBy(
            yearActivities,
            "Hardest session (avg HR)",
            (a) => a.average_heartrate,
            (v) => `${Math.round(v)} bpm`,
          ),
          bestBy(yearActivities, "Highest Relative Effort", (a) => a.suffer_score, (v) => formatNumber(v)),
          bestBy(yearActivities, "Most kudos", (a) => a.kudos_count, formatNumber),
        ]
  ).filter((best): best is Best => best !== null);

  return (
    <section className="t-stack">
      <div className="t-grid t-grid-wide">
        <article className="panel">
          <div className="t-card-head">
            <div>
              <span className="label">Your own baseline</span>
              <h2 className="t-card-title">{year} against every other year</h2>
            </div>
            <label className="t-select">
              <span>Year</span>
              <select
                onChange={(event) => setSelectedYear(Number(event.target.value))}
                value={year}
              >
                {years.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="chip-row t-spaced" role="group" aria-label="Comparison metric">
            {metrics.map((value) => (
              <button
                aria-pressed={metric === value}
                className="chip"
                key={value}
                onClick={() => setMetric(value)}
                type="button"
              >
                {METRIC_LABELS[value]}
              </button>
            ))}
          </div>
          <ProgressionChart
            progression={result}
            metric={metric}
            highlightYear={year}
            today={today}
            height={400}
          />
        </article>
        <article className="panel">
          <span className="label">Season snapshot</span>
          <h2 className="t-card-title">{year} in numbers</h2>
          <div className="t-stats is-two">
            {stats.map(([label, value, note]) => (
              <span key={label}>
                <small>{label}</small>
                <strong className="num">{value}</strong>
                {note && <em>{note}</em>}
              </span>
            ))}
          </div>
          <div className="t-subhead">Personal bests · {year}</div>
          <div className="t-list">
            {bests.map((best) => (
              <Link
                className="t-row"
                key={best.label}
                href={`/training/activities/${best.activity.id}`}
              >
                <span className="t-row-text">
                  <strong>{best.label}</strong>
                  <small>
                    {best.activity.name} ·{" "}
                    {formatCalendarDate(best.activity.date, { month: "short", day: "numeric" })}
                  </small>
                </span>
                <span className="t-row-figure num">{best.value}</span>
              </Link>
            ))}
          </div>
        </article>
      </div>
      <article className="panel">
        <span className="label">Active days · {year}</span>
        <ActiveDays activities={activities} year={year} today={today} />
      </article>
    </section>
  );
}
