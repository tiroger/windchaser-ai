"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import BestChances from "@/components/BestChances";
import BriefingPanel from "@/components/Briefing";
import GradientProfile from "@/components/GradientProfile";
import OpportunityRail, { type RankedRow } from "@/components/OpportunityRail";
import Scrubber from "@/components/Scrubber";
import SegmentDetail from "@/components/SegmentDetail";
import SegmentMap from "@/components/SegmentMap";
import type { Theme } from "@/components/ThemeToggle";
import { rideableHours, weekChances, type WindChance } from "@/lib/chances";
import { evaluate } from "@/lib/physics";
import type { Briefing } from "@/lib/server/briefing";
import { rankScore } from "@/lib/segment-candidates";
import type { Bundle, Evaluation, LatLon, Segment } from "@/lib/types";

/**
 * Segments mode: the week's best chances at a PR, then every segment the
 * rider rides in the region ranked by its best window, the map, the scrubber
 * and the evidence for the one selected.
 *
 * The chances and the ranking read one matrix of evaluations -- every
 * segment, every forecast hour -- so they cannot disagree about a segment's
 * time, its probability or which hours count.
 */
export default function SegmentsView({
  bundle,
  regionId,
  regionName,
  selectedId,
  onSelect,
  here,
  theme,
}: {
  bundle: Bundle & { notice?: string };
  regionId: string | null;
  regionName: string;
  selectedId: number | null;
  /** Changes the selection in the URL. */
  onSelect: (id: number | null) => void;
  here: LatLon | null;
  theme: Theme;
}) {
  const [hourOverride, setHourOverride] = useState<number | null>(null);
  // Reading the clock during render is impure, so it lives in state and ticks
  // on an interval. That keeps "now" genuinely now on a page left open, rather
  // than frozen at whenever it was loaded.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);

  // A new region starts at now, not at the last region's chosen hour.
  const [shownRegion, setShownRegion] = useState(regionId);
  if (shownRegion !== regionId) {
    setShownRegion(regionId);
    setHourOverride(null);
  }

  const segments = useMemo(
    () => (regionId ? bundle.segments.filter((s) => s.region_id === regionId) : []),
    [bundle, regionId],
  );

  const cellForSegment = useCallback(
    (cellIdValue: string) => bundle.forecast_cells[cellIdValue] ?? null,
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

  /** The hour the rider is actually in, or the closest the forecast covers. */
  const nowIndex = useMemo(() => {
    if (times.length === 0) return 0;
    const idx = times.findIndex((t) => new Date(t).getTime() >= nowMs);
    return idx >= 0 ? idx : times.length - 1;
  }, [times, nowMs]);

  const hourIndex = Math.min(hourOverride ?? nowIndex, Math.max(0, times.length - 1));

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

  // The clock only matters here to the hour, so the heavy derivations below
  // recompute hourly rather than on every one-minute tick.
  const hourMs = Math.floor(nowMs / 3_600_000) * 3_600_000;

  /**
   * Best window per segment among the hours it can actually be ridden in --
   * daylight, not wet, no gate failed, not past -- the same hours the chances
   * are chosen from. A segment with none this week falls back to its best
   * hour of all. Ranked by score, weighted toward what the rider rides now.
   */
  const ranked = useMemo<RankedRow[]>(() => {
    const rows: Array<RankedRow & { rank: number }> = [];
    for (const seg of segments) {
      const series = matrix.get(seg.id);
      if (!series || series.length === 0) continue;
      let hours = rideableHours(seg, matrix, cellForSegment, hourMs);
      if (hours.length === 0) hours = series.map((_, i) => i);
      let bestIndex = hours[0];
      for (const i of hours) {
        if (series[i].score > series[bestIndex].score) bestIndex = i;
      }
      rows.push({
        segment: seg,
        evaluation: series[bestIndex],
        hourIndex: bestIndex,
        whenIso: times[bestIndex] ?? times[0] ?? new Date(hourMs).toISOString(),
        rank: rankScore(series[bestIndex].score, seg.riding),
      });
    }
    // A soft record scores near certain at every hour, which says nothing
    // about the wind; those go last, as the chances list them apart.
    const soft = (row: RankedRow) => (row.segment.record?.soft ? 1 : 0);
    return rows.sort((a, b) => soft(a) - soft(b) || b.rank - a.rank || b.evaluation.score - a.evaluation.score);
  }, [segments, matrix, times, cellForSegment, hourMs]);

  const week = useMemo(
    () => weekChances(segments, matrix, cellForSegment, hourMs),
    [segments, matrix, cellForSegment, hourMs],
  );

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
    // With nothing selected, the best score at each hour among the segments
    // whose power is fitted from their own recorded attempts. Across every
    // segment, one soft record scores near the maximum at every hour and the
    // band paints one flat colour; across calibrated ones it tracks the wind.
    const trusted = segments.filter((s) => s.calibrated_power_w);
    const contributing = trusted.length > 0 ? trusted : segments;
    const ids = new Set(contributing.map((s) => s.id));

    return times.map((_, h) => {
      let best: number | null = null;
      for (const [id, series] of matrix) {
        if (!ids.has(id)) continue;
        const s = series[h]?.score;
        if (s !== undefined && (best === null || s > best)) best = s;
      }
      return best;
    });
  }, [selectedId, matrix, times, segments]);

  // The briefing reads the real chances only, never a soft record.
  const briefed = useMemo(() => ranked.filter((r) => !r.segment.record?.soft), [ranked]);

  // One briefing per evidence set, not per interaction.
  const briefingKey = briefed
    .slice(0, 5)
    .map((r) => `${r.segment.id}:${r.hourIndex}:${Math.round(r.evaluation.score * 50)}`)
    .join("|");
  const lastBriefingKey = useRef<string>("");

  useEffect(() => {
    if (briefed.length === 0 || briefingKey === lastBriefingKey.current) return;
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
        // Only the facts the briefing reads: Amplify rejects a POST body over
        // roughly 6 KB at the edge.
        ranked: briefed.slice(0, 5).map((r) => ({
          segment: {
            id: r.segment.id,
            name: r.segment.name,
            distance_m: r.segment.distance_m,
            average_grade: r.segment.average_grade,
            target_time_s: r.segment.best_moving_time_s ?? r.segment.pr_elapsed_time,
          },
          evaluation: {
            predicted_time_s: r.evaluation.predicted_time_s,
            p_beat: r.evaluation.p_beat,
            score: r.evaluation.score,
            effective_tailwind_ms: r.evaluation.effective_tailwind_ms,
            mean_crosswind_ms: r.evaluation.mean_crosswind_ms,
            weather: {
              wind_speed_ms: r.evaluation.weather.wind_speed_ms,
              wind_from_deg: r.evaluation.weather.wind_from_deg,
              gust_ms: r.evaluation.weather.gust_ms,
              temperature_c: r.evaluation.weather.temperature_c,
              precip_prob: r.evaluation.weather.precip_prob,
            },
          },
          whenIso: r.whenIso,
        })),
      }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`briefing failed with ${r.status}`);
        return (await r.json()) as Briefing;
      })
      .then((b) => setBriefing(b))
      .catch((e) => {
        console.error("[briefing]", e);
        setBriefing(null);
      })
      .finally(() => setBriefingLoading(false));
  }, [briefingKey, bundle, briefed, regionName, timezone, blockedCount]);

  /**
   * Selecting a segment means going to its best window, wherever it was
   * selected from: the rail, the map, a shared link or the back button. A
   * chance goes to its own hour instead. The scrubber's return-to-now undoes
   * either in one click.
   *
   * The selection lives in the URL, so the hour follows it here, during
   * render, rather than in each place that can change it.
   */
  const [pendingHour, setPendingHour] = useState<number | null>(null);
  const [seenSelection, setSeenSelection] = useState<number | null>(null);
  if (selectedId !== seenSelection && ranked.length > 0) {
    setSeenSelection(selectedId);
    setPendingHour(null);
    if (selectedId !== null) {
      const best = ranked.find((row) => row.segment.id === selectedId);
      setHourOverride(pendingHour ?? best?.hourIndex ?? null);
    }
  }

  const selectSegment = useCallback(
    (id: number | null) => {
      if (id !== null && id === selectedId) {
        const best = ranked.find((row) => row.segment.id === id);
        if (best) setHourOverride(best.hourIndex);
        return;
      }
      onSelect(id);
    },
    [ranked, onSelect, selectedId],
  );

  const pickChance = useCallback(
    (chance: WindChance) => {
      if (chance.segmentId === selectedId) {
        setHourOverride(chance.hourIndex);
        return;
      }
      setPendingHour(chance.hourIndex);
      onSelect(chance.segmentId);
    },
    [onSelect, selectedId],
  );

  const trustedCount = useMemo(
    () => segments.filter((s) => s.calibrated_power_w).length,
    [segments],
  );

  const selectedSegment: Segment | null = segments.find((s) => s.id === selectedId) ?? null;
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

  return (
    <>
      <div className="workspace">
        <aside className="rail">
          <div className="rail-head">
            <h2>{regionName}</h2>
            <span className="label">
              {ranked.length} segments, ranked by your chance of a PR
            </span>
          </div>
          <BestChances
            week={week}
            timezone={timezone}
            nowMs={hourMs}
            selectedId={selectedId}
            onPick={pickChance}
          />
          <BriefingPanel briefing={briefing} loading={briefingLoading} />
          <OpportunityRail rows={ranked} selectedId={selectedId} onSelect={selectSegment} />
        </aside>

        <main className="stage">
          <SegmentMap
            segments={segments}
            evaluations={currentEvaluations}
            selectedId={selectedId}
            onSelect={selectSegment}
            here={here}
            wind={currentWind}
            theme={theme}
          />
          {selectedSegment && <GradientProfile segment={selectedSegment} theme={theme} />}

          <Scrubber
            times={times}
            scores={scoreCurve}
            hourIndex={hourIndex}
            nowIndex={nowIndex}
            onChange={setHourOverride}
            onReturnToNow={() => setHourOverride(null)}
            timezone={timezone}
            legend={
              selectedSegment
                ? `shading: ${selectedSegment.name}`
                : trustedCount > 0
                  ? `shading: best of ${trustedCount} calibrated segments`
                  : "shading: best available"
            }
          />
        </main>
      </div>

      {selectedSegment && selectedEvaluation ? (
        <SegmentDetail segment={selectedSegment} evaluation={selectedEvaluation} />
      ) : (
        <p className="empty">Select a segment on the map or in the list to see the full evidence.</p>
      )}

      {bundle.notice && (
        <p className="empty" style={{ color: "var(--warn)" }}>
          {bundle.notice}
        </p>
      )}
    </>
  );
}
