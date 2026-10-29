import { RANKING_DAYS, type RankingDay } from "@/lib/training/route-ranking";

/**
 * The wind page's state as it lives in the URL, so a link shares exactly what
 * is on screen and the back button walks back through it.
 *
 *   /?mode=segments&region=r0&segment=229781
 *   /?mode=routes&day=tomorrow&route=2495066&start=2026-10-31T09:00
 *
 * Segments is the default and is left out of the URL. Anything unrecognised
 * reads as the default rather than an error: a stale or hand-edited link
 * should still show something.
 */

export type WindMode = "segments" | "routes";
export const WIND_MODES: readonly WindMode[] = ["segments", "routes"];

export type WindState = {
  mode: WindMode;
  /** Segments mode: a region chosen by hand; null follows the rider's position. */
  region: string | null;
  /** Segments mode: the selected segment. */
  segment: number | null;
  /** Routes mode: the day routes are ranked for; null is today (or tomorrow once today is over). */
  day: RankingDay | null;
  /** Routes mode: the saved route whose planner is open. */
  route: string | null;
  /** Routes mode: wall-clock start the planner opens at, "YYYY-MM-DDTHH:MM". */
  start: string | null;
};

type Params = { get(name: string): string | null };

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function parseWindState(params: Params): WindState {
  const mode = WIND_MODES.find((m) => m === params.get("mode")) ?? "segments";
  const segment = Number(params.get("segment"));
  const region = params.get("region");
  const route = params.get("route");
  const start = params.get("start");
  return {
    mode,
    region: region && ID.test(region) ? region : null,
    segment: Number.isSafeInteger(segment) && segment > 0 ? segment : null,
    day: RANKING_DAYS.find((d) => d === params.get("day")) ?? null,
    route: route && ID.test(route) ? route : null,
    start: start && START.test(start) ? start : null,
  };
}

/**
 * The URL for a state. Only the current mode's keys are written, so switching
 * mode and back starts that mode afresh rather than carrying a stale selection.
 */
export function windHref(state: Partial<WindState>): string {
  const params = new URLSearchParams();
  const mode = state.mode ?? "segments";
  if (mode === "routes") {
    params.set("mode", "routes");
    if (state.day) params.set("day", state.day);
    if (state.route) params.set("route", state.route);
    if (state.route && state.start) params.set("start", state.start);
  } else {
    if (state.region) params.set("region", state.region);
    if (state.segment) params.set("segment", String(state.segment));
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

/** The planner for a saved route at a start, as links from elsewhere open it. */
export function routePlannerHref(route: string, start?: string | null, day?: RankingDay | null): string {
  return windHref({ mode: "routes", route, start: start ?? null, day: day ?? null });
}
