"use client";

import Link from "next/link";

import "@/app/styles/route-day.css";
import { formatHours, formatNumber } from "@/lib/training/activity-types";
import { DAY_LABELS, type RankingDay } from "@/lib/training/route-ranking";
import { routePlannerHref, windHref } from "@/lib/wind-url";

import { RouteSketch, savedBadge, useRouteRanking } from "./RouteSketch";

/**
 * The overview's nudge toward the wind page: today's best saved route for the
 * wind (tomorrow's once today's daylight is gone), at its best start. The
 * full ranking, the other days and the ride planner live in the wind page's
 * Routes mode; this card links there rather than repeating them.
 */
export default function RouteOfTheDay() {
  const today = useRouteRanking("today");
  const todayEmpty = today?.status === "ready" && today.data.routes.length === 0;
  const day: RankingDay = todayEmpty ? "tomorrow" : "today";
  const shown = useRouteRanking(todayEmpty ? "tomorrow" : null) ?? today;
  const top = shown?.status === "ready" ? shown.data.routes[0] : undefined;
  const badge = top ? savedBadge(top.saved_s) : null;

  return (
    <article className="panel t-rd" aria-busy={shown?.status === "loading"}>
      <div className="t-card-head">
        <div>
          <span className="label">Route of the day · saved routes</span>
          <h2 className="t-card-title">Best for the wind {DAY_LABELS[day].toLowerCase()}</h2>
        </div>
        <Link className="t-link" href={windHref({ mode: "routes", day: todayEmpty ? "tomorrow" : null })}>
          All routes by the wind <span aria-hidden="true">→</span>
        </Link>
      </div>
      {shown?.status === "loading" && <div className="t-rd-loading">Reading the forecast along every route…</div>}
      {shown?.status === "error" && (
        <p className="t-empty">
          {shown.message === "Forecast unavailable"
            ? "The forecast is unavailable right now. Try again in a few minutes."
            : "Routes could not be ranked right now."}
        </p>
      )}
      {shown?.status === "ready" && !top && (
        <p className="t-empty">No saved route has a profile and a forecast for {DAY_LABELS[day].toLowerCase()} yet.</p>
      )}
      {top && badge && (
        <>
          <Link className="t-rd-row" href={routePlannerHref(top.id, top.start, todayEmpty ? "tomorrow" : null)}>
            {top.sketch ? (
              <RouteSketch sketch={top.sketch} label={`${top.name}, coloured by the wind at ${top.start_label}`} className="is-mini" />
            ) : (
              <span className="t-rd-sketch is-mini" aria-hidden="true" />
            )}
            <span className="t-row-text">
              <strong>
                {top.starred && <span className="t-star">★ </span>}
                {top.name}
              </strong>
              <small>
                {top.start_label} start · {formatNumber(top.distance_mi, 1)} mi · {formatHours(top.time_s / 3600)} at{" "}
                {top.watts} W
              </small>
            </span>
            <span className={`t-rd-badge num ${badge.tone}`}>{badge.text}</span>
          </Link>
          <p className="t-rd-note is-light">
            {top.headline.replace(/\.?$/, ".")} Open it to plan the ride hour by hour on the wind page.
          </p>
        </>
      )}
    </article>
  );
}
