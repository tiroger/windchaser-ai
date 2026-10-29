"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import {
  activityYear,
  formatCalendarDate,
  formatHours,
  formatMetric,
  formatNumber,
  getActivityKind,
  isDistanceSport,
  METRIC_LABELS,
  metricsFor,
  SPORT_LABELS,
  sportLabel,
  type Activity,
  type MetricKey,
  type SportFilter,
} from "@/lib/training/activity-types";
import { progression } from "@/lib/training/metrics/progression";
import { withSport } from "@/lib/training/sections";
import type { Settings } from "@/lib/training/settings";

import ActiveDays from "./ActiveDays";
import ActivityTable from "./ActivityTable";
import GoalsCard from "./GoalsCard";
import ProgressionChart from "./ProgressionChart";
import RouteOfTheDay from "./RouteOfTheDay";
import SportIcon, { sportTone } from "./SportIcon";
import { useTraining } from "./TrainingProvider";

/**
 * The Training overview: headline totals, this year against every other,
 * goals, the active-days calendar, recent activity and the log, all for the
 * sport chosen in the filter.
 */
export default function Overview({
  activities,
  filter,
  settings,
}: {
  activities: Activity[];
  filter: SportFilter;
  settings: Settings;
}) {
  const { today, admin, saveSettings } = useTraining();
  const metrics = metricsFor(filter);
  const [metricChoice, setMetric] = useState<MetricKey>(metrics[0]);
  const metric = metrics.includes(metricChoice) ? metricChoice : metrics[0];
  const result = useMemo(() => progression(activities, metric, today), [activities, metric, today]);
  const headline = useMemo(
    () => progression(activities, metrics[0], today),
    [activities, metrics, today],
  );
  const distanceSport = isDistanceSport(filter);

  const saveGoal = useCallback(
    async (key: string, value: number | null) => {
      const goals = { ...settings.goals };
      if (value === null) delete goals[key];
      else goals[key] = value;
      await saveSettings({ ...settings, goals });
    },
    [saveSettings, settings],
  );

  const totals = activities.reduce(
    (sum, activity) => ({
      distance: sum.distance + activity.distance,
      hours: sum.hours + activity.moving_time,
      elevation: sum.elevation + activity.total_elevation_gain,
      longest: Math.max(sum.longest, activity.moving_time),
    }),
    { distance: 0, hours: 0, elevation: 0, longest: 0 },
  );
  const yearToDate = headline.current?.total ?? 0;
  const change =
    headline.lastYearToDate && headline.lastYearToDate > 0
      ? Math.round(((yearToDate - headline.lastYearToDate) / headline.lastYearToDate) * 100)
      : null;
  const recent = [...activities].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  const firstYear = activities.length
    ? activityYear(activities.reduce((a, b) => (a.date < b.date ? a : b)))
    : undefined;
  const noun = filter === "All" ? "activities" : SPORT_LABELS[filter].toLowerCase();

  return (
    <>
      <section className="t-tiles" aria-label="Training totals">
        <Tile
          label={distanceSport ? "Total distance" : "Sessions"}
          value={distanceSport ? formatNumber(totals.distance) : formatNumber(activities.length)}
          unit={distanceSport ? "mi" : ""}
          detail={`${formatNumber(activities.length)} ${noun} since ${firstYear ?? "—"}`}
        />
        <Tile
          label="Active time"
          value={formatHours(totals.hours)}
          detail={`Average ${formatHours(activities.length ? totals.hours / activities.length : 0)} per activity`}
        />
        <Tile
          label={distanceSport ? "Elevation gain" : "Longest session"}
          value={distanceSport ? formatNumber(totals.elevation) : formatHours(totals.longest)}
          unit={distanceSport ? "ft" : ""}
          detail={
            distanceSport
              ? `${formatNumber(totals.elevation / 29_032, 1)} times up Everest`
              : "Personal best duration"
          }
        />
        <Tile
          label={`${today.year} so far`}
          value={metrics[0] === "time" ? formatHours(yearToDate) : formatNumber(yearToDate)}
          unit={metrics[0] === "distance" ? "mi" : metrics[0] === "sessions" ? "sessions" : ""}
          detail={
            change === null
              ? headline.onPace
                ? `On pace for ${formatMetric(headline.onPace, metrics[0])}`
                : "Nothing recorded yet this year"
              : `${change >= 0 ? "+" : ""}${change}% vs ${today.year - 1} by this date`
          }
          tone={change === null ? undefined : change >= 0 ? "is-up" : "is-down"}
        />
      </section>

      {/* Saved routes are rides: the pick shows for rides and for everything. */}
      {(filter === "All" || filter === "Ride") && <RouteOfTheDay />}

      <section className="t-grid t-grid-wide">
        <article className="panel">
          <div className="t-card-head">
            <div>
              <span className="label">Year over year</span>
              <h2 className="t-card-title">
                Cumulative {METRIC_LABELS[metric].toLowerCase()} by day of the year
              </h2>
            </div>
            <div className="chip-row" role="group" aria-label="Progression metric">
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
          </div>
          <p className="t-legend">
            <span><i className="t-swatch is-current" /> {today.year}</span>
            <span><i className="t-swatch is-previous" /> {today.year - 1}</span>
            <span><i className="t-swatch is-earlier" /> earlier years</span>
            <span><i className="t-swatch is-month" /> {today.year} by month</span>
          </p>
          <ProgressionChart
            progression={result}
            metric={metric}
            highlightYear={today.year}
            today={today}
          />
        </article>
        <GoalsCard
          activities={activities}
          filter={filter}
          today={today}
          goals={settings.goals}
          canEdit={admin.authenticated}
          onSaveGoal={saveGoal}
        />
      </section>

      <section className="t-grid t-grid-wide">
        <article className="panel">
          <span className="label">Active days · {today.year}</span>
          <ActiveDays activities={activities} year={today.year} today={today} compact />
        </article>
        <article className="panel">
          <div className="t-card-head">
            <div>
              <span className="label">Keep the momentum</span>
              <h2 className="t-card-title">
                Recent {filter === "All" ? "activity" : SPORT_LABELS[filter].toLowerCase()}
              </h2>
            </div>
            <Link className="t-link" href={withSport("/training/activities", filter)}>
              View all <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="t-list">
            {recent.map((activity) => (
              <Link
                className="t-row"
                key={activity.id}
                href={`/training/activities/${activity.id}`}
              >
                <span className={`t-icon-chip ${sportTone(getActivityKind(activity.type))}`}>
                  <SportIcon type={activity.type} />
                </span>
                <span className="t-row-text">
                  <strong>{activity.name}</strong>
                  <small>
                    {formatCalendarDate(activity.date, { month: "short", day: "numeric" })} ·{" "}
                    {sportLabel(activity.type)}
                  </small>
                </span>
                <span className="t-row-figure num">
                  {activity.distance > 0 ? (
                    <>
                      {formatNumber(activity.distance, 1)} <small>mi</small>
                    </>
                  ) : (
                    formatHours(activity.moving_time)
                  )}
                </span>
              </Link>
            ))}
            {!recent.length && (
              <div className="t-empty">No activities yet. They appear after the first sync.</div>
            )}
          </div>
        </article>
      </section>

      <ActivityTable activities={activities} />
    </>
  );
}

function Tile({
  label,
  value,
  unit,
  detail,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  detail: string;
  tone?: "is-up" | "is-down";
}) {
  return (
    <article className="panel t-tile">
      <span className="label">{label}</span>
      <div className="t-tile-value num">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div className={`t-tile-detail ${tone ?? ""}`}>{detail}</div>
    </article>
  );
}
