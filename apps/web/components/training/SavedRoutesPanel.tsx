"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import "@/app/styles/route-day.css";
import { formatCalendarDate, formatHours, formatNumber } from "@/lib/training/activity-types";
import type { RouteProfile, SavedRoute } from "@/lib/training/metrics/route-profile";
import { DAY_LABELS, RANKING_DAYS, type RankedRoute, type RankingDay } from "@/lib/training/route-ranking";
import { routePlannerHref } from "@/lib/wind-url";

import RouteAnalysis, { TrackStats, type RouteTrack } from "./RouteAnalysis";
import { savedBadge, useRouteRanking } from "./RouteSketch";

type Sort = "name" | RankingDay;

const SORT_LABELS: Record<Sort, string> = {
  name: "Strava order",
  today: "Best for today",
  tomorrow: "Best for tomorrow",
  weekend: "Best for the weekend",
};

function parseSort(value: string | null): Sort {
  return RANKING_DAYS.find((day) => day === value) ?? "name";
}

const SUB_TYPES: Record<NonNullable<SavedRoute["sub_type"]>, string> = {
  road: "Road",
  mtb: "Mountain bike",
  cx: "Cyclocross",
  trail: "Trail",
  mixed: "Mixed surface",
};

/**
 * The routes saved on Strava, each analysed like a ride: profile, gradient
 * map and climbs. The list comes with the page; a route's profile is fetched
 * when it is opened, since each is a few thousand points.
 */
export default function SavedRoutesPanel({ routes }: { routes: SavedRoute[] }) {
  const [query, setQuery] = useState("");
  // The selected route lives in the URL (?route=), so a route can be linked to
  // and the back button returns to the previous one.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("route");
  // ?start= opens the planner at that hour, ?sort= orders the list by the wind.
  const startParam = searchParams.get("start");
  const sort = parseSort(searchParams.get("sort"));
  const navigate = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };
  // Profiles by route ID; null marks one that is not available yet.
  const [profiles, setProfiles] = useState<Record<string, RouteProfile | null>>({});

  const ranking = useRouteRanking(sort === "name" ? null : sort);
  const ranked = useMemo(() => {
    if (ranking?.status !== "ready") return null;
    return new Map(ranking.data.routes.map((route, index) => [route.id, { route, index }]));
  }, [ranking]);

  const visible = useMemo(() => {
    const matching = routes.filter((route) => route.name.toLowerCase().includes(query.toLowerCase()));
    if (!ranked) return matching;
    // Ranked routes in ranking order, then the rest (runs, routes without a
    // window) in their usual order.
    const rank = (route: SavedRoute) => ranked.get(route.id)?.index ?? Number.MAX_SAFE_INTEGER;
    return [...matching].sort((a, b) => rank(a) - rank(b));
  }, [query, routes, ranked]);
  const selected = visible.find((route) => route.id === selectedId) ?? visible[0];
  const routeId = selected?.id;
  // The planner opens at the hour asked for, or at the ranked window.
  const selectedStart =
    (selected && selected.id === selectedId ? startParam : null) ??
    (selected ? (ranked?.get(selected.id)?.route.start ?? null) : null);

  useEffect(() => {
    if (!routeId || routeId in profiles) return;
    let cancelled = false;
    fetch(`/api/training/saved-routes/${encodeURIComponent(routeId)}`)
      .then(async (response) => (response.ok ? ((await response.json()) as RouteProfile) : null))
      .catch(() => null)
      .then((profile) => {
        if (!cancelled) setProfiles((current) => ({ ...current, [routeId]: profile }));
      });
    return () => {
      cancelled = true;
    };
  }, [profiles, routeId]);

  if (!routes.length) {
    return (
      <div className="panel t-empty">
        No saved routes yet. Public routes you create or save on Strava appear after the next
        daily sync.
      </div>
    );
  }

  return (
    <section className="t-saved">
      <aside className="panel t-saved-list">
        <span className="label">Your routes · {routes.length}</span>
        <label className="t-search">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" strokeLinecap="round" />
          </svg>
          <input
            aria-label="Search saved routes"
            placeholder="Search routes"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="t-select t-saved-sort">
          <select
            aria-label="Sort routes"
            value={sort}
            onChange={(event) => navigate({ sort: event.target.value === "name" ? null : event.target.value })}
          >
            {(["name", ...RANKING_DAYS] as Sort[]).map((value) => (
              <option key={value} value={value}>
                {SORT_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        {sort !== "name" && <RankingStatus load={ranking} day={sort} />}
        <div className="t-list t-scroll-list">
          {visible.map((route) => (
            <button
              className="t-row"
              aria-pressed={route.id === selected?.id}
              key={route.id}
              type="button"
              onClick={() =>
                navigate({ route: route.id, start: ranked?.get(route.id)?.route.start ?? null })
              }
            >
              <span className="t-row-text">
                <strong>
                  {route.starred && (
                    <span className="t-star" aria-label="Starred">
                      ★{" "}
                    </span>
                  )}
                  {route.name}
                </strong>
                <small>
                  {formatNumber(route.distance, 1)} mi · {formatNumber(route.elevation_gain)} ft
                  {route.sub_type ? ` · ${SUB_TYPES[route.sub_type]}` : ""}
                  {ranked?.has(route.id) ? ` · ${ranked.get(route.id)!.route.start_label}` : ""}
                </small>
              </span>
              {ranked?.has(route.id) && <SavedBadge route={ranked.get(route.id)!.route} />}
            </button>
          ))}
          {!visible.length && <div className="t-empty">No routes match.</div>}
        </div>
      </aside>
      {selected && (
        <RouteDetail
          key={selected.id}
          route={selected}
          profile={profiles[selected.id]}
          loading={!(selected.id in profiles)}
          start={selectedStart}
        />
      )}
    </section>
  );
}

function RouteDetail({
  route,
  profile,
  loading,
  start,
}: {
  route: SavedRoute;
  profile: RouteProfile | null | undefined;
  loading: boolean;
  start: string | null;
}) {
  const kicker = [
    route.type === "run" ? "Run route" : "Ride route",
    route.sub_type ? SUB_TYPES[route.sub_type] : null,
    route.updated_at
      ? `updated ${formatCalendarDate(route.updated_at, { month: "short", day: "numeric", year: "numeric" })}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="t-stack">
      <article className="panel">
        <span className="label">{kicker}</span>
        <h2 className="t-detail-heading">
          {route.starred && <span className="t-star">★ </span>}
          {route.name}
        </h2>
        {route.description && <p className="t-note">{route.description}</p>}
        <RouteStats route={route} track={profile ?? undefined} />
      </article>
      {route.type !== "run" && (
        // Planning against the forecast is the wind page's job; this page
        // keeps the route's own analysis.
        <article className="panel">
          <div className="t-card-head">
            <div>
              <span className="label">Ride planner · next 7 days</span>
              <h2 className="t-card-title">When to ride it</h2>
            </div>
            <Link className="t-link" href={routePlannerHref(route.id, start)}>
              Plan it on the wind page <span aria-hidden="true">→</span>
            </Link>
          </div>
          <p className="t-note">
            Predicted moving time for every start hour of the week at a power you choose, and the route coloured
            by the wind you would meet.
          </p>
        </article>
      )}
      {profile ? (
        <RouteAnalysis track={profile} />
      ) : (
        <article className="panel">
          <div className="t-map is-loading" style={{ height: 220 }}>
            {loading
              ? "Loading profile…"
              : "This route’s elevation profile has not synced yet; it arrives with the next daily sync."}
          </div>
        </article>
      )}
    </div>
  );
}

function RouteStats({ route, track }: { route: SavedRoute; track?: RouteTrack }) {
  const stats: Array<[string, string]> = [
    ["Distance", `${formatNumber(route.distance, 1)} mi`],
    ["Elevation gain", `${formatNumber(route.elevation_gain)} ft`],
    [
      "Climbing rate",
      route.distance ? `${formatNumber(route.elevation_gain / route.distance)} ft/mi` : "—",
    ],
  ];
  if (route.estimated_moving_time) {
    stats.push(["Strava estimate", formatHours(route.estimated_moving_time / 3600)]);
  }
  return (
    <div className="t-stats">
      {stats.map(([label, value]) => (
        <span key={label}>
          <small>{label}</small>
          <strong className="num">{value}</strong>
        </span>
      ))}
      {track && <TrackStats track={track} />}
    </div>
  );
}

/** Minutes saved against calm air at the route's best start that day. */
function SavedBadge({ route }: { route: RankedRoute }) {
  const badge = savedBadge(route.saved_s);
  const notes = [
    `${badge.text} against calm air at ${route.start_label}`,
    route.rain_max_pct >= 30 ? `${route.rain_max_pct}% rain` : null,
    route.before_sunset ? null : "finishes after sunset",
    route.degraded ? "part of the forecast missing" : null,
  ].filter(Boolean);
  return (
    <span className={`t-rd-badge num ${badge.tone}`} title={notes.join(", ")}>
      {badge.text}
      {(!route.before_sunset || route.rain_max_pct >= 30) && <span aria-hidden="true"> *</span>}
    </span>
  );
}

function RankingStatus({ load, day }: { load: ReturnType<typeof useRouteRanking>; day: RankingDay }) {
  if (!load || load.status === "loading") return <p className="t-saved-status">Ranking by the forecast…</p>;
  if (load.status === "error") return <p className="t-saved-status">The forecast is unavailable; routes keep their order.</p>;
  const { routes, summary } = load.data;
  if (!routes.length) {
    return (
      <p className="t-saved-status">
        {day === "today" ? "No daylight left to start a ride today." : "No route could be ranked for this day."}
      </p>
    );
  }
  return (
    <p className={`t-saved-status ${summary.light ? "is-light" : ""}`}>
      {summary.message ??
        `${routes.length} rides near home, ranked for ${DAY_LABELS[day].toLowerCase()} by the share of ride time the wind saves. Badges: minutes against calm air at each one\u2019s best start.`}
    </p>
  );
}
