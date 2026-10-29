"use client";

import Link from "next/link";
import { useState } from "react";

import "@/app/training/route-day.css";
import { formatHours, formatNumber } from "@/lib/training/activity-types";
import {
  DAY_LABELS,
  RANKING_DAYS,
  type RankedRoute,
  type RankingDay,
  type RouteRanking,
} from "@/lib/training/route-ranking";

import { formatClock, plannerHref, RouteSketch, savedBadge, useRouteRanking } from "./RouteSketch";

/**
 * The overview's pick of the saved routes for the wind: the route the
 * forecast favours most on the chosen day, at its best start, and the two
 * after it. Each opens the ride planner at that hour.
 */
export default function RouteOfTheDay() {
  // Null until the rider picks: then today, or tomorrow once today is over.
  const [choice, setChoice] = useState<RankingDay | null>(null);
  const today = useRouteRanking("today");
  const todayEmpty = today?.status === "ready" && today.data.routes.length === 0;
  const day: RankingDay = choice ?? (todayEmpty ? "tomorrow" : "today");
  const shown = useRouteRanking(day === "today" ? null : day) ?? today;
  const rolledOver = choice === null && todayEmpty;

  return (
    <article className="panel t-rd" aria-busy={shown?.status === "loading"}>
      <div className="t-card-head">
        <div>
          <span className="label">Route of the day · saved routes</span>
          <h2 className="t-card-title">
            {day === "weekend" ? "Best for the wind this weekend" : `Best for the wind ${DAY_LABELS[day].toLowerCase()}`}
          </h2>
        </div>
        <div className="chip-row" role="group" aria-label="Day to rank routes for">
          {RANKING_DAYS.map((value) => (
            <button
              key={value}
              type="button"
              className="chip"
              aria-pressed={day === value}
              onClick={() => setChoice(value)}
            >
              {DAY_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
      {rolledOver && <p className="t-rd-note">No daylight left to start a ride today, so this is tomorrow.</p>}
      {shown?.status === "loading" && <div className="t-rd-loading">Reading the forecast along every route…</div>}
      {shown?.status === "error" && (
        <p className="t-empty">
          {shown.message === "Forecast unavailable"
            ? "The forecast is unavailable right now. Try again in a few minutes."
            : "Routes could not be ranked right now."}
        </p>
      )}
      {shown?.status === "ready" && <Pick data={shown.data} day={day} />}
    </article>
  );
}

function Pick({ data, day }: { data: RouteRanking; day: RankingDay }) {
  const [top, ...rest] = data.routes;
  if (!top) {
    return (
      <p className="t-empty">
        {day === "today"
          ? "No daylight left to start a ride today."
          : "No saved route has a profile and a forecast for this day yet."}
      </p>
    );
  }
  const next = rest.slice(0, 2);
  return (
    <>
      {data.summary.message && <p className="t-rd-note is-light">{data.summary.message}</p>}
      <div className="t-rd-body">
        <Link className="t-rd-top" href={plannerHref(top.id, top.start)}>
          <div className="t-rd-sketch-frame">
            {top.sketch ? (
              <RouteSketch sketch={top.sketch} label={`${top.name}, coloured by the wind at ${top.start_label}`} />
            ) : (
              <span className="t-rd-nosketch">Track hidden near home</span>
            )}
          </div>
          <div className="t-rd-main">
            <span className="t-rd-when">{top.start_label} start</span>
            <h3 className="t-rd-name">
              {top.starred && <span className="t-star">★ </span>}
              {top.name}
            </h3>
            <p className="t-rd-meta">
              {formatNumber(top.distance_mi, 1)} mi · {formatNumber(top.elevation_ft)} ft · at {top.watts} W
            </p>
            <p className={`t-rd-headline ${savedBadge(top.saved_s).tone}`}>{top.headline}</p>
            <Facts route={top} />
            {top.degraded && (
              <p className="t-rd-flag">Part of the forecast for this route is missing; nearby points stand in.</p>
            )}
          </div>
        </Link>
        {next.length > 0 && (
          <div className="t-rd-next">
            <span className="label">Then</span>
            <ol className="t-rd-list">
              {next.map((route, i) => (
                <li key={route.id}>
                  <NextRow route={route} rank={i + 2} />
                </li>
              ))}
            </ol>
            <Link className="t-link" href={`/training/saved-routes?sort=${day}`}>
              All {data.routes.length} routes by the wind <span aria-hidden="true">→</span>
            </Link>
          </div>
        )}
      </div>
      <SketchLegend />
    </>
  );
}

function Facts({ route }: { route: RankedRoute }) {
  const badge = savedBadge(route.saved_s);
  const tempF = Math.round(route.temp_c * 1.8 + 32);
  const pct = Math.abs(route.saved_pct).toFixed(1);
  return (
    <dl className="t-rd-facts">
      <div>
        <dt>Moving</dt>
        <dd className="num">{formatHours(route.time_s / 3600)}</dd>
      </div>
      <div>
        <dt>Calm air</dt>
        <dd className="num">{formatHours(route.calm_s / 3600)}</dd>
      </div>
      <div>
        <dt>Wind effect</dt>
        <dd className={badge.tone}>
          <span className="num">{badge.text}</span>
          {badge.tone && ` · ${pct}% ${route.saved_s > 0 ? "faster" : "slower"}`}
        </dd>
      </div>
      <div>
        <dt>Tailwind</dt>
        <dd>
          <span className="num">{Math.round(route.tail_share * 100)}%</span> of the route
        </dd>
      </div>
      <div>
        <dt>At the start</dt>
        <dd>
          <span className="num">{tempF}°F</span> · <span className="num">{route.precip_pct}%</span> rain
        </dd>
      </div>
      <div>
        <dt>Back by</dt>
        <dd className={route.before_sunset ? "" : "is-slower"}>
          <span className="num">{formatClock(route.finish_epoch, route.timezone)}</span>
          {route.sunset_epoch !== null &&
            (route.before_sunset
              ? " · before sunset"
              : ` · sunset ${formatClock(route.sunset_epoch, route.timezone)}`)}
        </dd>
      </div>
    </dl>
  );
}

function NextRow({ route, rank }: { route: RankedRoute; rank: number }) {
  const badge = savedBadge(route.saved_s);
  return (
    <Link className="t-rd-row" href={plannerHref(route.id, route.start)}>
      <span className="t-rd-rank num" aria-hidden="true">
        {rank}
      </span>
      {route.sketch ? (
        <RouteSketch sketch={route.sketch} label={`${route.name} shape`} className="is-mini" />
      ) : (
        <span className="t-rd-sketch is-mini" aria-hidden="true" />
      )}
      <span className="t-row-text">
        <strong>{route.name}</strong>
        <small>
          {formatNumber(route.distance_mi, 1)} mi · {route.start_label} · {formatHours(route.time_s / 3600)}
        </small>
      </span>
      <span className={`t-rd-badge num ${badge.tone}`}>{badge.text}</span>
    </Link>
  );
}

function SketchLegend() {
  return (
    <p className="t-rd-legend">
      <span>
        <i style={{ background: "var(--data-open)" }} /> tailwind
      </span>
      <span>
        <i style={{ background: "var(--data-effort)" }} /> headwind
      </span>
      <span>
        <i style={{ background: "var(--ink-3)" }} /> cross or calm
      </span>
      <span className="t-rd-legend-note">
        Moving time at your default power against the same ride in calm air. Ends hidden for privacy.
      </span>
    </p>
  );
}
