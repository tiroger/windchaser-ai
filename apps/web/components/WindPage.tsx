"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import "@/app/styles/wind-modes.css";
import Masthead from "@/components/Masthead";
import { DayChips, rankingDay } from "@/components/RouteDays";
import SegmentsView from "@/components/SegmentsView";
import { useRouteRanking } from "@/components/training/RouteSketch";
import { useTheme } from "@/components/ThemeToggle";
import { haversineM } from "@/lib/geo";
import type { Bundle, LatLon } from "@/lib/types";
import { parseWindState, windHref, type WindMode, type WindState } from "@/lib/wind-url";

// The planner brings maps and charts with it; Segments mode never needs them.
const RoutesView = dynamic(() => import("@/components/RoutesView"), {
  ssr: false,
  loading: () => (
    <main className="loading">
      <div className="spinner" aria-hidden="true" />
    </main>
  ),
});

type Located = { status: "idle" | "asking" | "granted" | "denied"; at: LatLon | null };

const MODE_LABELS: Record<WindMode, string> = { segments: "Segments", routes: "Routes" };

/**
 * The wind page: what the coming week's wind means for the rider, in two
 * modes. Segments ranks the segments they ride and leads with the week's best
 * chances at a PR; Routes ranks their saved routes and opens the ride
 * planner. Mode and selection live in the URL (lib/wind-url.ts).
 */
export default function WindPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const state = useMemo(() => parseWindState(searchParams), [searchParams]);
  const [theme] = useTheme();

  const navigate = useCallback(
    (changes: Partial<WindState>, replace = false) => {
      const href = windHref({ ...state, ...changes });
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [router, state],
  );

  const [located, setLocated] = useState<Located>({ status: "idle", at: null });
  const [bundle, setBundle] = useState<(Bundle & { notice?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wantsSegments = state.mode === "segments";

  // Ask for position the first time Segments mode is shown; the answer
  // decides which region loads and where discovery searches.
  useEffect(() => {
    if (!wantsSegments || located.status !== "idle") return;
    if (!("geolocation" in navigator)) {
      const id = setTimeout(() => setLocated({ status: "denied", at: null }), 0);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setLocated({ status: "asking", at: null }), 0);
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocated({ status: "granted", at: [pos.coords.latitude, pos.coords.longitude] }),
      () => setLocated({ status: "denied", at: null }),
      { timeout: 8000, maximumAge: 300000 },
    );
    return () => clearTimeout(id);
  }, [wantsSegments, located.status]);

  useEffect(() => {
    if (located.status === "idle" || located.status === "asking") return;
    const params = located.at ? `?lat=${located.at[0]}&lon=${located.at[1]}` : "";
    let cancelled = false;
    fetch(`/api/opportunities${params}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `Request failed (${r.status})`);
        return json as Bundle & { notice?: string };
      })
      .then((data) => {
        if (cancelled) return;
        setBundle(data);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [located]);

  // Nearest region to the rider, else the one they ride most (the server
  // orders regions that way). Derived, so a late position is followed.
  const autoRegionId = useMemo(() => {
    if (!bundle || bundle.regions.length === 0) return null;
    const here = located.at;
    if (!here) return bundle.regions[0].id;
    return bundle.regions
      .map((r) => ({ id: r.id, d: haversineM(here, [r.lat, r.lon]) }))
      .sort((a, b) => a.d - b.d)[0].id;
  }, [bundle, located.at]);
  const regionId =
    state.region && bundle?.regions.some((r) => r.id === state.region) ? state.region : autoRegionId;
  const regionName = bundle?.regions.find((r) => r.id === regionId)?.name ?? "your area";

  const segmentsMode = state.mode === "segments";
  // Shared with Routes mode's own request: one ranking per day per page view.
  const todayRanking = useRouteRanking(segmentsMode ? null : "today");
  const { day } = rankingDay(state.day, todayRanking);

  return (
    <div className="shell">
      <Masthead heading>
        <span className="masthead-spacer" />
        {segmentsMode && bundle && (
          <>
            <span
              className={`status ${bundle.sources?.segments === "saved" ? "is-saved" : "is-live"}`}
              title={
                bundle.sources?.segments === "saved"
                  ? "Segments come from the last saved bundle"
                  : "Segments fetched from Strava"
              }
            >
              <span className="dot" />
              Segments
            </span>
            <span
              className={`status ${bundle.sources?.forecast === "saved" ? "is-saved" : "is-live"}`}
              title={
                bundle.sources?.forecast === "saved"
                  ? "Forecast comes from the last saved bundle"
                  : "Forecast fetched from Open-Meteo"
              }
            >
              <span className="dot" />
              Forecast
            </span>
          </>
        )}
      </Masthead>

      <nav className="wind-bar" aria-label="Wind view">
        <div className="mode-switch" role="tablist" aria-label="What to plan">
          {(Object.keys(MODE_LABELS) as WindMode[]).map((mode) => (
            <Link
              key={mode}
              role="tab"
              aria-selected={state.mode === mode}
              href={windHref({ mode })}
              scroll={false}
            >
              {MODE_LABELS[mode]}
            </Link>
          ))}
        </div>
        {segmentsMode && bundle && (
          <div className="chip-row wind-regions" role="group" aria-label="Riding region">
            {bundle.regions
              .filter((r) => (r.segment_count ?? r.starred_count) > 0 || r.id === "here")
              .map((r) => (
                <button
                  key={r.id}
                  className="chip"
                  aria-pressed={r.id === regionId}
                  onClick={() => navigate({ region: r.id, segment: null })}
                >
                  {r.name}
                  <span className="count">{r.segment_count ?? r.starred_count}</span>
                </button>
              ))}
          </div>
        )}
        {!segmentsMode && <DayChips day={day} onDay={(value) => navigate({ day: value, route: null, start: null })} />}
      </nav>

      {segmentsMode ? (
        error ? (
          <main className="loading">
            <h1 style={{ fontSize: "1.4rem" }}>Could not load your segments</h1>
            <p style={{ color: "var(--ink-2)", maxWidth: "44ch" }}>{error}</p>
          </main>
        ) : !bundle ? (
          <main className="loading">
            <div className="spinner" aria-hidden="true" />
            <p style={{ color: "var(--ink-2)" }}>
              {located.status === "asking" || located.status === "idle"
                ? "Finding where you are…"
                : "Loading segments and forecasts…"}
            </p>
          </main>
        ) : (
          <SegmentsView
            bundle={bundle}
            regionId={regionId}
            regionName={regionName}
            selectedId={state.segment}
            onSelect={(id) => navigate({ segment: id })}
            here={located.at}
            theme={theme}
          />
        )
      ) : (
        <RoutesView
          day={state.day}
          routeId={state.route}
          start={state.start}
          onRoute={(route, start) => navigate({ route, start })}
        />
      )}
    </div>
  );
}
