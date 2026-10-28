import { NextResponse } from "next/server";

import { loadPublicHeatmap } from "@/lib/training/data";
import { revalidatedJson } from "@/lib/training/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every mapped activity's route, ends trimmed, for the heatmap.
 *
 * Fetched by the browser rather than rendered into the page: it is the largest
 * payload in the section, and the ETag lets a return visit cost an empty 304.
 */
export async function GET(request: Request) {
  try {
    return revalidatedJson(request, await loadPublicHeatmap());
  } catch (error) {
    console.error("[training] could not load heatmap routes", error);
    return NextResponse.json({ error: "Could not load routes" }, { status: 503 });
  }
}
