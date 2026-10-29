import { NextResponse } from "next/server";

import { routeRanking } from "@/lib/server/route-ranking";
import { revalidatedJson } from "@/lib/training/http";
import { RANKING_DAYS, RANKING_SPORTS, type RankingDay, type RankingSport } from "@/lib/training/route-ranking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Miles as a plain number from 0 to 1000; null when absent, undefined when invalid. */
function milesParam(value: string | null): number | null | undefined {
  if (value === null || value === "") return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(value)) return undefined;
  const miles = Number(value);
  return miles <= 1000 ? miles : undefined;
}

/**
 * Route of the day: every saved route ranked by what the forecast does to it
 * on the chosen day (today's remaining daylight, tomorrow, or the weekend),
 * at the planner's default power. Rides only unless sport=all. Sketches use
 * relative units built from the privacy-trimmed track, never coordinates.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const day = (params.get("day") ?? "today") as RankingDay;
  if (!RANKING_DAYS.includes(day)) {
    return NextResponse.json({ error: "day must be today, tomorrow or weekend" }, { status: 400 });
  }
  const sport = (params.get("sport") || "ride") as RankingSport;
  if (!RANKING_SPORTS.includes(sport)) {
    return NextResponse.json({ error: `sport must be one of ${RANKING_SPORTS.join(", ")}` }, { status: 400 });
  }
  const minMiles = milesParam(params.get("minMiles"));
  const maxMiles = milesParam(params.get("maxMiles"));
  if (minMiles === undefined || maxMiles === undefined) {
    return NextResponse.json({ error: "minMiles and maxMiles must be miles from 0 to 1000" }, { status: 400 });
  }
  const started = performance.now();
  try {
    const { ranking, cached } = await routeRanking({ day, sport, minMiles, maxMiles });
    const response = revalidatedJson(request, ranking);
    response.headers.set(
      "Server-Timing",
      `ranking;dur=${(performance.now() - started).toFixed(1)};desc="${cached ? "cached" : "computed"}"`,
    );
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "Forecast unavailable") {
      return NextResponse.json({ error: "Forecast unavailable" }, { status: 503 });
    }
    console.error("[training] could not rank routes", error);
    return NextResponse.json({ error: "Could not rank routes" }, { status: 503 });
  }
}
