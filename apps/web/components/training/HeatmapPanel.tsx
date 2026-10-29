"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { formatNumber, getActivityKind, type SportFilter } from "@/lib/training/activity-types";
import { preferences } from "@/lib/training/poster/preference";
import { MAP_THEME_OPTIONS, posterTheme, STANDARD } from "@/lib/training/poster/themes";

import type { MapView } from "./RouteMap";

const RouteMap = dynamic(() => import("./RouteMap"), {
  ssr: false,
  loading: () => <div className="t-map is-loading" style={{ height: 560 }}>Loading map…</div>,
});
const PosterDialog = dynamic(() => import("./PosterDialog"), { ssr: false });

type HeatRoute = { id: string; type: string; date: string; miles: number; polyline: string };

// The map theme and labels live in localStorage, read the way the site theme
// is: outside React, so the server's render (Standard) and the client's agree.
const CHANGED = "windchaser-heatmap-prefs";
const subscribe = (onChange: () => void) => {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
};
const announce = () => window.dispatchEvent(new Event(CHANGED));

/**
 * Every route at once, faint enough that the roads ridden most glow brightest.
 *
 * The routes are fetched by the browser rather than rendered into the page:
 * they are the heaviest thing in Training, and the API's ETag turns a return
 * visit into an empty 304 instead of the whole set again.
 */
export default function HeatmapPanel({ filter }: { filter: SportFilter }) {
  const router = useRouter();
  const [routes, setRoutes] = useState<HeatRoute[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [year, setYear] = useState("all");
  const [posterOpen, setPosterOpen] = useState(false);
  const view = useRef<MapView | null>(null);
  /** The poster needs to know where the map is looking, so waits for it. */
  const [mapReady, setMapReady] = useState(false);
  const mapTheme = useSyncExternalStore(subscribe, preferences.theme, () => STANDARD);
  const labels = useSyncExternalStore(subscribe, preferences.labels, () => false);
  const poster = posterTheme(mapTheme);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/training/heatmap")
      .then(async (response) => {
        if (!response.ok) throw new Error("Routes unavailable");
        return (await response.json()) as HeatRoute[];
      })
      .then((value) => !cancelled && setRoutes(value))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const years = useMemo(
    () =>
      Array.from(new Set((routes ?? []).map((route) => route.date.slice(0, 4))))
        .sort()
        .reverse(),
    [routes],
  );
  const visible = useMemo(
    () =>
      (routes ?? []).filter(
        (route) =>
          (year === "all" || route.date.startsWith(year)) &&
          (filter === "All" || getActivityKind(route.type) === filter),
      ),
    [filter, routes, year],
  );
  const open = useCallback((id: string) => router.push(`/training/activities/${id}`), [router]);
  const onView = useCallback((next: MapView) => {
    view.current = next;
    setMapReady(true);
  }, []);

  return (
    <section className="panel">
      <div className="t-card-head">
        <div>
          <span className="label">Where you go</span>
          <h2 className="t-card-title">
            {routes ? `${formatNumber(visible.length)} routes` : "Heatmap"}
          </h2>
        </div>
        <div className="t-heat-controls">
          <label className="t-select">
            <span>Map style</span>
            <select
              value={mapTheme}
              onChange={(event) => {
                preferences.setTheme(event.target.value);
                announce();
              }}
            >
              {MAP_THEME_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <label className="t-select">
            <span>Year</span>
            <select value={year} onChange={(event) => setYear(event.target.value)}>
              <option value="all">All years</option>
              {years.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          {poster && (
            <label className="t-heat-labels">
              <input
                type="checkbox"
                checked={labels}
                onChange={(event) => {
                  preferences.setLabels(event.target.checked);
                  announce();
                }}
              />
              <span>Labels</span>
            </label>
          )}
          <button
            type="button"
            className="t-button"
            onClick={() => setPosterOpen(true)}
            disabled={!mapReady || !visible.length}
            aria-haspopup="dialog"
          >
            Download poster
          </button>
        </div>
      </div>
      {routes ? (
        <RouteMap
          routes={visible}
          variant="heat"
          height={560}
          onSelect={open}
          onView={onView}
          mapTheme={mapTheme}
          labels={labels}
        />
      ) : (
        <div className="t-map is-loading" style={{ height: 560 }}>
          {failed ? "Routes could not be loaded." : "Loading routes…"}
        </div>
      )}
      <p className="t-note">
        Brighter lines are roads ridden more often. Click a route to open it. The first and last
        500 m of every route are hidden to keep home private, on the map and on the poster.
      </p>
      {posterOpen && (
        <PosterDialog
          open={posterOpen}
          onClose={() => setPosterOpen(false)}
          mapTheme={mapTheme}
          labels={labels}
          routes={visible}
          year={year}
          view={view.current}
        />
      )}
    </section>
  );
}
