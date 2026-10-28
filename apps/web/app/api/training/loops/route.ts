import { NextResponse } from "next/server";

import { getActivityKind } from "@/lib/training/activity-types";
import { revalidatedJson } from "@/lib/training/http";
import { loadTopLoops } from "@/lib/training/loops-data";
import { parseSport } from "@/lib/training/sections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The most-ridden loops: `?limit=` (1–50, default 12) and `?sport=` as on the pages. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limitText = params.get("limit") ?? "12";
  if (!/^\d{1,2}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 50) {
    return NextResponse.json({ error: "limit must be between 1 and 50" }, { status: 400 });
  }
  const filter = parseSport(params.get("sport") ?? undefined);
  try {
    const loops = await loadTopLoops(
      Number(limitText),
      (type) => filter === "All" || getActivityKind(type) === filter,
    );
    return revalidatedJson(request, { loops });
  } catch (error) {
    console.error("[training] could not load loops", error);
    return NextResponse.json({ error: "Could not load loops" }, { status: 503 });
  }
}
