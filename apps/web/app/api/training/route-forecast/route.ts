import { NextResponse } from "next/server";

import { PlannerError, routeForecast } from "@/lib/server/route-forecast";
import { revalidatedJson } from "@/lib/training/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whole watts in a range any rider might hold for hours; null when absent. */
function wattsParam(value: string | null): number | null | undefined {
  if (value === null || value === "") return null;
  if (!/^\d{2,3}$/.test(value)) return undefined;
  const watts = Number(value);
  return watts >= 50 && watts <= 600 ? watts : undefined;
}

/**
 * The ride planner for one saved route: predicted moving time for every hour
 * of the coming week, the best windows, and the wind along the route in the
 * chosen one. Coordinates within 500 m of either end are never included.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get("id") ?? "";
  if (!/^\d{1,25}$/.test(id)) {
    return NextResponse.json({ error: "Invalid route ID" }, { status: 400 });
  }
  const watts = wattsParam(params.get("watts"));
  if (watts === undefined) {
    return NextResponse.json({ error: "watts must be a whole number from 50 to 600" }, { status: 400 });
  }
  const hourText = params.get("hour");
  if (hourText !== null && !/^\d{1,3}$/.test(hourText)) {
    return NextResponse.json({ error: "Invalid hour" }, { status: 400 });
  }
  try {
    const forecast = await routeForecast(id, {
      watts,
      hour: hourText === null ? null : Number(hourText),
    });
    return revalidatedJson(request, forecast);
  } catch (error) {
    if (error instanceof PlannerError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[training] could not plan route", error);
    return NextResponse.json({ error: "Could not plan this route" }, { status: 503 });
  }
}
