"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { formatNumber, getActivityKind, type SportFilter } from "@/lib/training/activity-types";

const RouteMap = dynamic(() => import("./RouteMap"), {
  ssr: false,
  loading: () => <div className="t-map is-loading" style={{ height: 560 }}>Loading map…</div>,
});

type HeatRoute = { id: string; type: string; date: string; polyline: string };

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

  return (
    <section className="panel">
      <div className="t-card-head">
        <div>
          <span className="label">Where you go</span>
          <h2 className="t-card-title">
            {routes ? `${formatNumber(visible.length)} routes` : "Heatmap"}
          </h2>
        </div>
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
      </div>
      {routes ? (
        <RouteMap routes={visible} variant="heat" height={560} onSelect={open} />
      ) : (
        <div className="t-map is-loading" style={{ height: 560 }}>
          {failed ? "Routes could not be loaded." : "Loading routes…"}
        </div>
      )}
      <p className="t-note">
        Brighter lines are roads ridden more often. Click a route to open it. The first and last
        500 m of every route are hidden to keep home private.
      </p>
    </section>
  );
}
