"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import BriefingPanel from "@/components/Briefing";
import OpportunityRail, { type RankedRow } from "@/components/OpportunityRail";
import Scrubber from "@/components/Scrubber";
import SegmentDetail from "@/components/SegmentDetail";
import SegmentMap from "@/components/SegmentMap";
import ThemeToggle, { useTheme } from "@/components/ThemeToggle";
import { haversineM } from "@/lib/geo";
import { evaluate } from "@/lib/physics";
import type { Briefing } from "@/lib/server/briefing";
import type { Bundle, Evaluation, LatLon } from "@/lib/types";

type Located = { status: "idle" | "asking" | "granted" | "denied"; at: LatLon | null };

export default function Page() {
  const [bundle, setBundle] = useState<(Bundle & { notice?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [located, setLocated] = useState<Located>({ status: "asking", at: null });
  // null means "follow the automatic choice"; a value means the rider picked.
  const [regionOverride, setRegionOverride] = useState<string | null>(null);
  const [hourOverride, setHourOverride] = useState<number | null>(null);
  // Captured once at mount: reading the clock during render is impure.
  const [mountedAt] = useState(() => Date.now());
  const [theme, setTheme] = useTheme();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);

  // Ask for position first; the answer decides which region loads.
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      const id = setTimeout(() => setLocated({ status: "denied", at: null }), 0);
      return () => clearTimeout(id);
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setLocated({
          status: "granted",
          at: [pos.coords.latitude, pos.coords.longitude],
        }),
      () => setLocated({ status: "denied", at: null }),
      { timeout: 8000, maximumAge: 300000 },
    );
  }, []);

  useEffect(() => {
    if (located.status === "asking") return;
    const params = located.at
      ? `?lat=${located.at[0]}&lon=${located.at[1]}`
      : "";
    fetch(`/api/opportunities${params}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `Request failed (${r.status})`);
        return json as Bundle & { notice?: string };
      })
      .then((data) => {
        setBundle(data);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [located]);

  // Nearest region to the rider, else the largest. Derived, not stored, so it
  // tracks a late-arriving position without a second render pass.
  const autoRegionId = useMemo(() => {
    if (!bundle || bundle.regions.length === 0) return null;
    const here = located.at;
    if (!here) return bundle.regions[0].id;
    return bundle.regions
      .map((r) => ({ id: r.id, d: haversineM(here, [r.lat, r.lon]) }))
      .sort((a, b) => a.d - b.d)[0].id;
  }, [bundle, located.at]);

  const regionId = regionOverride ?? autoRegionId;

  const segments = useMemo(
    () => (bundle && regionId ? bundle.segments.filter((s) => s.region_id === regionId) : []),
    [bundle, regionId],
  );

  const cellForSegment = useCallback(
    (cellIdValue: string) => bundle?.forecast_cells[cellIdValue] ?? null,
    [bundle],
  );

  const times = useMemo(() => {
    const first = segments[0] && cellForSegment(segments[0].cell_id);
    return first?.time ?? [];
  }, [segments, cellForSegment]);

  const timezone = useMemo(() => {
    const first = segments[0] && cellForSegment(segments[0].cell_id);
    return first?.timezone ?? "UTC";
  }, [segments, cellForSegment]);

  // Default to the next whole hour rather than the start of the forecast file.
  const defaultHourIndex = useMemo(() => {
    if (times.length === 0) return 0;
    const idx = times.findIndex((t) => new Date(t).getTime() >= mountedAt);
    return idx >= 0 ? idx : 0;
  }, [times, mountedAt]);

  const hourIndex = Math.min(
    hourOverride ?? defaultHourIndex,
    Math.max(0, times.length - 1),
  );

  /** Full 7-day scan: every segment, every hour. */
  const matrix = useMemo(() => {
    const out = new Map<number, Evaluation[]>();
    for (const seg of segments) {
      const cell = cellForSegment(seg.cell_id);
      if (!cell) continue;
      const series: Evaluation[] = [];
      for (let h = 0; h < cell.time.length; h++) {
        series.push(evaluate(seg, cell, h));
      }
      out.set(seg.id, series);
    }
    return out;
  }, [segments, cellForSegment]);

  const currentEvaluations = useMemo(() => {
    const out = new Map<number, Evaluation>();
    for (const [id, series] of matrix) {
      const ev = series[Math.min(hourIndex, series.length - 1)];
      if (ev) out.set(id, ev);
    }
    return out;
  }, [matrix, hourIndex]);

  /** Best window per segment across the whole forecast, ranked. */
  const ranked = useMemo<RankedRow[]>(() => {
    const rows: RankedRow[] = [];
    for (const seg of segments) {
      const series = matrix.get(seg.id);
      if (!series || series.length === 0) continue;
      let bestIndex = 0;
      for (let i = 1; i < series.length; i++) {
        if (series[i].score > series[bestIndex].score) bestIndex = i;
      }
      rows.push({
        segment: seg,
        evaluation: series[bestIndex],
        hourIndex: bestIndex,
        whenIso: times[bestIndex] ?? times[0] ?? new Date().toISOString(),
      });
    }
    return rows.sort((a, b) => b.evaluation.score - a.evaluation.score);
  }, [segments, matrix, times]);

  const blockedCount = useMemo(
    () =>
      [...matrix.values()].reduce(
        (n, series) => n + series.filter((e) => e.gates.length > 0).length,
        0,
      ),
    [matrix],
  );

  const scoreCurve = useMemo(() => {
    if (selectedId) {
      const series = matrix.get(selectedId);
      if (series) return series.map((e) => e.score);
    }
    // With nothing selected, show the best score available at each hour.
    return times.map((_, h) => {
      let best: number | null = null;
      for (const series of matrix.values()) {
        const s = series[h]?.score;
        if (s !== undefined && (best === null || s > best)) best = s;
      }
      return best;
    });
  }, [selectedId, matrix, times]);

  const regionName =
    bundle?.regions.find((r) => r.id === regionId)?.name ?? "your area";

  // One briefing per evidence set, not per interaction.
  const briefingKey = ranked
    .slice(0, 5)
    .map((r) => `${r.segment.id}:${r.hourIndex}:${Math.round(r.evaluation.score * 50)}`)
    .join("|");
  const lastBriefingKey = useRef<string>("");

  useEffect(() => {
    if (!bundle || ranked.length === 0 || briefingKey === lastBriefingKey.current) return;
    lastBriefingKey.current = briefingKey;
    setBriefingLoading(true);
    fetch("/api/briefing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        regionName,
        athleteName: bundle.athlete.firstname,
        timezone,
        blockedCount,
        ranked: ranked.slice(0, 5).map((r) => ({
          segment: r.segment,
          evaluation: r.evaluation,
          whenIso: r.whenIso,
        })),
      }),
    })
      .then((r) => r.json())
      .then((b: Briefing) => setBriefing(b))
      .catch(() => setBriefing(null))
      .finally(() => setBriefingLoading(false));
  }, [briefingKey, bundle, ranked, regionName, timezone, blockedCount]);

  const selectedSegment = segments.find((s) => s.id === selectedId) ?? null;
  const selectedEvaluation = selectedId ? currentEvaluations.get(selectedId) : null;
  const currentWind = (() => {
    const seg = selectedSegment ?? segments[0];
    if (!seg) return null;
    const cell = cellForSegment(seg.cell_id);
    if (!cell) return null;
    const i = Math.min(hourIndex, cell.time.length - 1);
    return {
      speed: cell.wind_speed_ms[i] ?? 0,
      fromDeg: cell.wind_from_deg[i] ?? 0,
      gust: cell.gust_ms[i] ?? 0,
    };
  })();

  if (error) {
    return (
      <main className="loading">
        <h1 style={{ fontSize: "1.4rem" }}>Could not load your segments</h1>
        <p style={{ color: "var(--ink-2)", maxWidth: "44ch" }}>{error}</p>
      </main>
    );
  }

  if (!bundle) {
    return (
      <main className="loading">
        <div className="spinner" aria-hidden="true" />
        <p style={{ color: "var(--ink-2)" }}>
          {located.status === "asking"
            ? "Finding where you are…"
            : "Loading segments and forecasts…"}
        </p>
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div className="wordmark">
          <svg className="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M2 8h11.5a3.2 3.2 0 1 0-3.1-4"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
            <path
              d="M2 13h15.4a3.4 3.4 0 1 1-3.3 4.3"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              opacity="0.55"
            />
          </svg>
          <h1>WindChaser</h1>
        </div>

        <div className="chip-row" role="group" aria-label="Riding region">
          {bundle.regions
            .filter((r) => r.starred_count > 0 || r.id === "here")
            .map((r) => (
              <button
                key={r.id}
                className="chip"
                aria-pressed={r.id === regionId}
                onClick={() => {
                  setRegionOverride(r.id);
                  setHourOverride(null);
                  setSelectedId(null);
                }}
              >
                {r.name}
                <span className="count">{r.starred_count}</span>
              </button>
            ))}
        </div>

        <span className="masthead-spacer" />

        <span className={`status ${bundle.live ? "is-live" : "is-saved"}`}>
          <span className="dot" />
          {bundle.live ? "Live data" : "Saved bundle"}
        </span>
        <ThemeToggle theme={theme} onChange={setTheme} />
      </header>

      <div className="workspace">
        <aside className="rail">
          <div className="rail-head">
            <h2>{regionName}</h2>
            <span className="label">
              {ranked.length} segments, ranked by chance of a personal best
            </span>
          </div>
          <BriefingPanel briefing={briefing} loading={briefingLoading} />
          <OpportunityRail
            rows={ranked}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onJumpToHour={setHourOverride}
          />
        </aside>

        <main className="stage">
          <SegmentMap
            segments={segments}
            evaluations={currentEvaluations}
            selectedId={selectedId}
            onSelect={setSelectedId}
            here={located.at}
            wind={currentWind}
            theme={theme}
          />
          <Scrubber
            times={times}
            scores={scoreCurve}
            hourIndex={hourIndex}
            onChange={setHourOverride}
            timezone={timezone}
          />
        </main>
      </div>

      {selectedSegment && selectedEvaluation ? (
        <SegmentDetail segment={selectedSegment} evaluation={selectedEvaluation} />
      ) : (
        <p className="empty">
          Select a segment on the map or in the list to see the full evidence.
        </p>
      )}

      {bundle.notice && (
        <p className="empty" style={{ color: "var(--warn)" }}>
          {bundle.notice}
        </p>
      )}
    </div>
  );
}
