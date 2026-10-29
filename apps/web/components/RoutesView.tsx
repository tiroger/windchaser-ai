"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";

import "@/app/styles/route-day.css";
import "@/app/styles/wind-routes.css";
import {
  formatClock,
  RouteSketch,
  savedBadge,
  useRouteRanking,
  type RankingLoad,
} from "@/components/training/RouteSketch";
import { formatHours, formatNumber } from "@/lib/training/activity-types";
import type { RouteProfile, SavedRoute } from "@/lib/training/metrics/route-profile";
import { DAY_LABELS, type RankedRoute, type RankingDay } from "@/lib/training/route-ranking";

import { rankingDay } from "./RouteDays";

const RoutePlanner = dynamic(() => import("@/components/training/RoutePlanner"), {
  ssr: false,
  loading: () => <div className="t-map is-loading">Loading the planner…</div>,
});

/**
 * Routes mode: the saved routes ranked for the wind on a day (today's
 * remaining daylight, tomorrow, or the weekend), each at its best start, and
 * the ride planner for the one picked.
 *
 * The day, the route and the start live in the URL, so a ranked route links
 * straight to its planner and the back button returns to the ranking.
 */
export default function RoutesView({
  day: dayChoice,
  routeId,
  start,
  onRoute,
}: {
  /** Null until the rider picks: then today, or tomorrow once today is over. */
  day: RankingDay | null;
  routeId: string | null;
  start: string | null;
  onRoute: (route: string | null, start: string | null) => void;
}) {
  const today = useRouteRanking("today");
  const { day, rolledOver } = rankingDay(dayChoice, today);
  const shown = useRouteRanking(day === "today" ? null : day) ?? today;
  const routes = shown?.status === "ready" ? shown.data.routes : [];
  const selected = routeId ? (routes.find((r) => r.id === routeId) ?? null) : null;

  // Stacked on a phone, the planner sits above the ranking; a route picked
  // far down the list would otherwise open out of sight.
  useEffect(() => {
    if (routeId && window.matchMedia("(max-width: 980px)").matches) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [routeId]);

  return (
    <div className="workspace wind-routes">
      <aside className="rail">
        <div className="rail-head">
          <h2>Your saved routes</h2>
          <span className="label">
            Ranked by what the wind does to them {day === "weekend" ? "this weekend" : DAY_LABELS[day].toLowerCase()}
          </span>
        </div>
        {rolledOver && <p className="routes-note">No daylight left to start a ride today, so this is tomorrow.</p>}
        <RouteList load={shown} day={day} selectedId={routeId} onRoute={onRoute} />
      </aside>

      <main className="stage routes-stage">
        {routeId ? (
          <PlannerPanel key={routeId} routeId={routeId} ranked={selected} start={start ?? selected?.start ?? null} onClose={() => onRoute(null, null)} />
        ) : shown?.status === "ready" && routes[0] ? (
          <TopPick route={routes[0]} day={day} message={shown.data.summary.message} onOpen={() => onRoute(routes[0].id, routes[0].start)} />
        ) : (
          <div className="routes-placeholder">
            {shown?.status === "error"
              ? "The forecast is unavailable right now. Try again in a few minutes."
              : shown?.status === "ready"
                ? day === "today"
                  ? "No daylight left to start a ride today."
                  : "No saved route has a profile and a forecast for this day yet."
                : "Reading the forecast along every route…"}
          </div>
        )}
      </main>
    </div>
  );
}

function RouteList({
  load,
  day,
  selectedId,
  onRoute,
}: {
  load: RankingLoad | null;
  day: RankingDay;
  selectedId: string | null;
  onRoute: (route: string, start: string) => void;
}) {
  if (!load || load.status === "loading") {
    return <p className="routes-note">Reading the forecast along every route…</p>;
  }
  if (load.status === "error") {
    return (
      <p className="routes-note">
        {load.message === "Forecast unavailable"
          ? "The forecast is unavailable right now. Try again in a few minutes."
          : "Routes could not be ranked right now."}
      </p>
    );
  }
  const { routes, summary } = load.data;
  if (!routes.length) {
    return (
      <p className="routes-note">
        {day === "today" ? "No daylight left to start a ride today." : "No saved route could be ranked for this day."}
      </p>
    );
  }
  return (
    <>
      {summary.message && <p className="routes-note is-light">{summary.message}</p>}
      <ol className="rail-list route-list">
        {routes.map((route, i) => {
          const badge = savedBadge(route.saved_s);
          return (
            <li key={route.id}>
              <button
                type="button"
                className="card route-card"
                aria-pressed={route.id === selectedId}
                onClick={() => onRoute(route.id, route.start)}
              >
                <span className="route-rank mono" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="route-text">
                  <span className="card-name">
                    {route.starred && <span className="route-star">★ </span>}
                    {route.name}
                  </span>
                  <span className="card-meta">
                    <span className="mono">{route.start_label}</span>
                    <span className="sep">·</span>
                    <span className="mono">{formatNumber(route.distance_mi, 1)} mi</span>
                    <span className="sep">·</span>
                    <span className="mono">{formatHours(route.time_s / 3600)}</span>
                  </span>
                </span>
                <span className={`route-badge mono ${badge.tone}`} title="Moving time saved against calm air">
                  {badge.text}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <p className="routes-note">
        Badges: moving time at your default power against the same ride in calm air, at each route&apos;s best
        start.
      </p>
    </>
  );
}

function TopPick({
  route,
  day,
  message,
  onOpen,
}: {
  route: RankedRoute;
  day: RankingDay;
  message: string | null;
  onOpen: () => void;
}) {
  const badge = savedBadge(route.saved_s);
  const tempF = Math.round(route.temp_c * 1.8 + 32);
  const pct = Math.abs(route.saved_pct).toFixed(1);
  return (
    <article className="panel top-pick">
      <span className="label">
        {day === "weekend" ? "Best for the wind this weekend" : `Best for the wind ${DAY_LABELS[day].toLowerCase()}`}
      </span>
      <div className="top-pick-body">
        <div className="top-pick-sketch">
          {route.sketch ? (
            <RouteSketch sketch={route.sketch} label={`${route.name}, coloured by the wind at ${route.start_label}`} />
          ) : (
            <span className="routes-note">Track hidden near home</span>
          )}
        </div>
        <div className="top-pick-main">
          <span className="top-pick-when mono">{route.start_label} start</span>
          <h3 className="top-pick-name">
            {route.starred && <span className="route-star">★ </span>}
            {route.name}
          </h3>
          <p className="top-pick-meta">
            {formatNumber(route.distance_mi, 1)} mi · {formatNumber(route.elevation_ft)} ft · at {route.watts} W
          </p>
          <p className={`top-pick-headline ${badge.tone}`}>{route.headline}</p>
          <dl className="top-pick-facts">
            <div>
              <dt>Moving</dt>
              <dd className="mono">{formatHours(route.time_s / 3600)}</dd>
            </div>
            <div>
              <dt>Calm air</dt>
              <dd className="mono">{formatHours(route.calm_s / 3600)}</dd>
            </div>
            <div>
              <dt>Wind effect</dt>
              <dd className={badge.tone}>
                <span className="mono">{badge.text}</span>
                {badge.tone && ` · ${pct}% ${route.saved_s > 0 ? "faster" : "slower"}`}
              </dd>
            </div>
            <div>
              <dt>Tailwind</dt>
              <dd>
                <span className="mono">{Math.round(route.tail_share * 100)}%</span> of the route
              </dd>
            </div>
            <div>
              <dt>At the start</dt>
              <dd>
                <span className="mono">{tempF}°F</span> · <span className="mono">{route.precip_pct}%</span> rain
              </dd>
            </div>
            <div>
              <dt>Back by</dt>
              <dd className={route.before_sunset ? "" : "is-slower"}>
                <span className="mono">{formatClock(route.finish_epoch, route.timezone)}</span>
                {route.sunset_epoch !== null &&
                  (route.before_sunset ? " · before sunset" : ` · sunset ${formatClock(route.sunset_epoch, route.timezone)}`)}
              </dd>
            </div>
          </dl>
          {route.degraded && (
            <p className="routes-note">Part of the forecast for this route is missing; nearby points stand in.</p>
          )}
          {message && <p className="routes-note is-light">{message}</p>}
          <SketchLegend />
          <button type="button" className="now-button top-pick-open" onClick={onOpen}>
            Plan this ride →
          </button>
        </div>
      </div>
    </article>
  );
}

type ProfileLoad = { status: "loading" } | { status: "missing" } | { status: "ready"; profile: RouteProfile };

/** The planner for one saved route, with its name from the ranking or the route list. */
function PlannerPanel({
  routeId,
  ranked,
  start,
  onClose,
}: {
  routeId: string;
  ranked: RankedRoute | null;
  start: string | null;
  onClose: () => void;
}) {
  const [profile, setProfile] = useState<ProfileLoad>({ status: "loading" });
  const [listed, setListed] = useState<SavedRoute | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/training/saved-routes/${encodeURIComponent(routeId)}`)
      .then(async (response) => (response.ok ? ((await response.json()) as RouteProfile) : null))
      .catch(() => null)
      .then((value) => {
        if (!cancelled) setProfile(value ? { status: "ready", profile: value } : { status: "missing" });
      });
    return () => {
      cancelled = true;
    };
  }, [routeId]);

  // A route linked from elsewhere may not be in this day's ranking (a run, or
  // one far from home); its name then comes from the saved-route list.
  useEffect(() => {
    if (ranked) return;
    let cancelled = false;
    fetch("/api/training/saved-routes")
      .then(async (response) => (response.ok ? ((await response.json()) as SavedRoute[]) : []))
      .catch(() => [] as SavedRoute[])
      .then((list) => {
        if (!cancelled) setListed(list.find((r) => r.id === routeId) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [ranked, routeId]);

  const name = ranked?.name ?? listed?.name ?? "Saved route";
  const distance = ranked?.distance_mi ?? listed?.distance ?? null;
  const elevation = ranked?.elevation_ft ?? listed?.elevation_gain ?? null;
  const isRun = listed?.type === "run";

  return (
    <div className="planner-stack">
      <div className="planner-head">
        <button type="button" className="chip" onClick={onClose}>
          ← All routes
        </button>
        <div className="planner-title">
          <span className="label">Saved route</span>
          <h2>
            {(ranked?.starred || listed?.starred) && <span className="route-star">★ </span>}
            {name}
          </h2>
          {distance !== null && (
            <p className="top-pick-meta">
              {formatNumber(distance, 1)} mi{elevation !== null ? ` · ${formatNumber(elevation)} ft` : ""}
              {" · "}
              <Link href={`/training/saved-routes?route=${encodeURIComponent(routeId)}`}>profile and climbs</Link>
            </p>
          )}
        </div>
      </div>
      {profile.status === "loading" && <div className="t-map is-loading">Loading the route…</div>}
      {profile.status === "missing" && (
        <p className="routes-placeholder">
          This route&apos;s elevation profile has not synced yet; it arrives with the next daily sync.
        </p>
      )}
      {profile.status === "ready" &&
        (isRun ? (
          <p className="routes-placeholder">The planner models riding, so it does not run on run routes.</p>
        ) : (
          <RoutePlanner routeId={routeId} profile={profile.profile} start={start} />
        ))}
    </div>
  );
}

function SketchLegend() {
  return (
    <p className="routes-legend">
      <span>
        <i style={{ background: "var(--data-open)" }} /> tailwind
      </span>
      <span>
        <i style={{ background: "var(--data-effort)" }} /> headwind
      </span>
      <span>
        <i style={{ background: "var(--ink-3)" }} /> cross or calm
      </span>
      <span className="routes-legend-note">Ends hidden for privacy.</span>
    </p>
  );
}
