import type { WindChance } from "@/lib/chances";
import type { RankedRoute, RankingDay } from "@/lib/training/route-ranking";
import type { Evaluation, Segment } from "@/lib/types";

/**
 * The evidence the briefing is written from, as the wind page posts it.
 *
 * Every number here is copied from something the page already computed -- an
 * evaluation, the week's chances, a segment's still-air record, the route
 * ranking -- and nothing is derived that the model could not have been handed
 * directly. The model may only restate these (lib/server/briefing.ts).
 *
 * Small on purpose. Amplify's compute rejects a POST body over roughly 6 KB
 * at the edge, before the route runs, which is how the briefing once failed
 * silently in production; so only the fields read are sent, names are
 * clipped, counts are capped, and numbers are rounded to what is shown.
 */

/** Amplify's edge limit, with headroom. */
export const BRIEFING_BODY_LIMIT = 6000;
export const MAX_BRIEFED_SEGMENTS = 5;
export const MAX_NEAR_MISSES = 3;
export const MAX_NAME = 80;

export interface BriefingStillAir {
  /** The rider's best in still air, seconds (elapsed basis, like Strava's PR). */
  best_s: number;
  /** Strava's PR, elapsed seconds, for comparison. */
  pr_s: number;
  /** Where the PR ranks among the still-air times; null when it has none. */
  pr_rank: number | null;
  /** Efforts with a still-air time. */
  count: number;
  /** Still air tracks the power meter worse than raw time here. */
  rough: boolean;
}

export interface BriefingSegment {
  id: number;
  name: string;
  distance_m: number;
  average_grade: number;
  target_time_s: number | null;
  still_air?: BriefingStillAir | null;
}

export interface BriefingEvaluation {
  predicted_time_s: number;
  p_beat: number | null;
  score: number;
  effective_tailwind_ms: number;
  mean_crosswind_ms: number;
  weather: {
    wind_speed_ms: number;
    wind_from_deg: number;
    gust_ms: number;
    temperature_c: number;
    precip_prob: number;
  };
}

export interface BriefingRanked {
  segment: BriefingSegment;
  evaluation: BriefingEvaluation;
  whenIso: string;
}

/** A segment whose best rideable hour this week falls short of the record. */
export interface BriefingNearMiss {
  name: string;
  /** Forecast wall-clock hour, "YYYY-MM-DDTHH:MM". */
  when: string;
  predicted_s: number;
  target_s: number;
  /** Predicted minus record, seconds; positive is slower. */
  gap_s: number;
  p_beat: number;
}

/** The saved route the wind favours most on the day. */
export interface BriefingRoute {
  name: string;
  day: RankingDay;
  distance_mi: number;
  /** "Tomorrow 12 PM", as the ranking labels it. */
  start_label: string;
  predicted_s: number;
  calm_s: number;
  /** Calm minus predicted; positive is faster. */
  saved_s: number;
  /** Share of the route with a tailwind, whole percent. */
  tail_pct: number;
  before_sunset: boolean;
}

export interface BriefingPayload {
  regionName: string;
  athleteName: string | null;
  timezone: string;
  blockedCount: number;
  ranked: BriefingRanked[];
  nearMisses: BriefingNearMiss[];
  route: BriefingRoute | null;
}

const clip = (text: string) => (text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text);
const r0 = (value: number) => Math.round(value);
const r1 = (value: number) => Math.round(value * 10) / 10;
const r2 = (value: number) => Math.round(value * 100) / 100;

function stillAirOf(segment: Segment): BriefingStillAir | null {
  const record = segment.record;
  const still = record?.still_air;
  if (!record || !still) return null;
  return {
    best_s: r1(still.best_s),
    pr_s: r0(record.pr_elapsed_s),
    pr_rank: still.pr_rank,
    count: still.count,
    rough: still.check === "worse",
  };
}

/** One ranked window, as the briefing reads it. */
export function briefedRow(row: { segment: Segment; evaluation: Evaluation; whenIso: string }): BriefingRanked {
  const { segment, evaluation } = row;
  const target = segment.best_moving_time_s ?? segment.pr_elapsed_time;
  return {
    segment: {
      id: segment.id,
      name: clip(segment.name),
      distance_m: r0(segment.distance_m),
      average_grade: r1(segment.average_grade),
      target_time_s: target ? r0(target) : null,
      still_air: stillAirOf(segment),
    },
    evaluation: {
      predicted_time_s: r1(evaluation.predicted_time_s),
      p_beat: evaluation.p_beat === null ? null : r2(evaluation.p_beat),
      score: r2(evaluation.score),
      effective_tailwind_ms: r1(evaluation.effective_tailwind_ms),
      mean_crosswind_ms: r1(evaluation.mean_crosswind_ms),
      weather: {
        wind_speed_ms: r1(evaluation.weather.wind_speed_ms),
        wind_from_deg: r0(evaluation.weather.wind_from_deg),
        gust_ms: r1(evaluation.weather.gust_ms),
        temperature_c: r1(evaluation.weather.temperature_c),
        precip_prob: r0(evaluation.weather.precip_prob),
      },
    },
    whenIso: row.whenIso.slice(0, 16),
  };
}

export function briefedNearMiss(chance: WindChance): BriefingNearMiss {
  return {
    name: clip(chance.segment.name),
    when: chance.time.slice(0, 16),
    predicted_s: r1(chance.predictedSeconds),
    target_s: r1(chance.predictedSeconds - chance.gapSeconds),
    gap_s: r1(chance.gapSeconds),
    p_beat: r2(chance.pBeat),
  };
}

export function briefedRoute(route: RankedRoute, day: RankingDay): BriefingRoute {
  return {
    name: clip(route.name),
    day,
    distance_mi: r1(route.distance_mi),
    start_label: clip(route.start_label),
    predicted_s: r0(route.time_s),
    calm_s: r0(route.calm_s),
    saved_s: r0(route.saved_s),
    tail_pct: r0(route.tail_share * 100),
    before_sunset: route.before_sunset,
  };
}

/**
 * The body the wind page posts. Soft records are left out of the windows and
 * the near misses alike: any hard ride beats one, so it is not evidence about
 * the wind.
 */
export function briefingPayload(input: {
  regionName: string;
  athleteName: string | null;
  timezone: string;
  blockedCount: number;
  ranked: Array<{ segment: Segment; evaluation: Evaluation; whenIso: string }>;
  closest: WindChance[];
  route: { route: RankedRoute; day: RankingDay } | null;
}): BriefingPayload {
  const real = <T extends { segment: Segment }>(rows: T[]) => rows.filter((r) => !r.segment.record?.soft);
  return {
    regionName: clip(input.regionName),
    athleteName: input.athleteName ? clip(input.athleteName) : null,
    timezone: input.timezone,
    blockedCount: input.blockedCount,
    ranked: real(input.ranked).slice(0, MAX_BRIEFED_SEGMENTS).map(briefedRow),
    nearMisses: real(input.closest).slice(0, MAX_NEAR_MISSES).map(briefedNearMiss),
    route: input.route ? briefedRoute(input.route.route, input.route.day) : null,
  };
}

/** Bytes on the wire, as Amplify counts them. */
export function bodyBytes(payload: unknown): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? clip(value) : fallback;

/**
 * The payload as the server accepts it: the route is public and the body
 * comes from a browser, so counts are capped again, names clipped and every
 * number made finite. Anything malformed is dropped rather than refused.
 */
export function sanitizePayload(raw: unknown): BriefingPayload | null {
  const body = raw as Partial<BriefingPayload> | null;
  if (!body || !Array.isArray(body.ranked)) return null;
  const ranked = body.ranked.slice(0, MAX_BRIEFED_SEGMENTS).flatMap((row): BriefingRanked[] => {
    const s = row?.segment;
    const e = row?.evaluation;
    if (!s || !e || !e.weather) return [];
    const still = s.still_air;
    return [
      {
        segment: {
          id: finite(s.id),
          name: text(s.name, "Segment"),
          distance_m: finite(s.distance_m),
          average_grade: finite(s.average_grade),
          target_time_s: s.target_time_s === null ? null : finite(s.target_time_s, 0) || null,
          still_air: still
            ? {
                best_s: finite(still.best_s),
                pr_s: finite(still.pr_s),
                pr_rank: still.pr_rank === null ? null : finite(still.pr_rank),
                count: finite(still.count),
                rough: still.rough === true,
              }
            : null,
        },
        evaluation: {
          predicted_time_s: finite(e.predicted_time_s),
          p_beat: e.p_beat === null ? null : finite(e.p_beat),
          score: finite(e.score),
          effective_tailwind_ms: finite(e.effective_tailwind_ms),
          mean_crosswind_ms: finite(e.mean_crosswind_ms),
          weather: {
            wind_speed_ms: finite(e.weather.wind_speed_ms),
            wind_from_deg: finite(e.weather.wind_from_deg),
            gust_ms: finite(e.weather.gust_ms),
            temperature_c: finite(e.weather.temperature_c),
            precip_prob: finite(e.weather.precip_prob),
          },
        },
        whenIso: text(row.whenIso).slice(0, 16),
      },
    ];
  });
  const nearMisses = (Array.isArray(body.nearMisses) ? body.nearMisses : [])
    .slice(0, MAX_NEAR_MISSES)
    .flatMap((m): BriefingNearMiss[] =>
      m && typeof m.name === "string"
        ? [
            {
              name: text(m.name),
              when: text(m.when).slice(0, 16),
              predicted_s: finite(m.predicted_s),
              target_s: finite(m.target_s),
              gap_s: finite(m.gap_s),
              p_beat: finite(m.p_beat),
            },
          ]
        : [],
    );
  const r = body.route;
  const route: BriefingRoute | null =
    r && typeof r.name === "string"
      ? {
          name: text(r.name),
          day: r.day === "tomorrow" || r.day === "weekend" ? r.day : "today",
          distance_mi: finite(r.distance_mi),
          start_label: text(r.start_label),
          predicted_s: finite(r.predicted_s),
          calm_s: finite(r.calm_s),
          saved_s: finite(r.saved_s),
          tail_pct: finite(r.tail_pct),
          before_sunset: r.before_sunset === true,
        }
      : null;
  return {
    regionName: text(body.regionName, "your area") || "your area",
    athleteName: typeof body.athleteName === "string" ? text(body.athleteName) : null,
    timezone: text(body.timezone, "UTC") || "UTC",
    blockedCount: finite(body.blockedCount),
    ranked,
    nearMisses,
    route,
  };
}
