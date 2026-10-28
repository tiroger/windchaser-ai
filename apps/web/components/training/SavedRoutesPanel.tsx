"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { formatCalendarDate, formatHours, formatNumber } from "@/lib/training/activity-types";
import type { RouteProfile, SavedRoute } from "@/lib/training/metrics/route-profile";

import RouteAnalysis, { TrackStats, type RouteTrack } from "./RouteAnalysis";

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
  const setSelectedId = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("route", id);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };
  // Profiles by route ID; null marks one that is not available yet.
  const [profiles, setProfiles] = useState<Record<string, RouteProfile | null>>({});

  const visible = useMemo(
    () => routes.filter((route) => route.name.toLowerCase().includes(query.toLowerCase())),
    [query, routes],
  );
  const selected = visible.find((route) => route.id === selectedId) ?? visible[0];
  const routeId = selected?.id;

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
        <div className="t-list t-scroll-list">
          {visible.map((route) => (
            <button
              className="t-row"
              aria-pressed={route.id === selected?.id}
              key={route.id}
              type="button"
              onClick={() => setSelectedId(route.id)}
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
                </small>
              </span>
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
        />
      )}
    </section>
  );
}

function RouteDetail({
  route,
  profile,
  loading,
}: {
  route: SavedRoute;
  profile: RouteProfile | null | undefined;
  loading: boolean;
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
