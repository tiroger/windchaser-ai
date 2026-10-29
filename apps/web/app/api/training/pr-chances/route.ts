import { NextResponse } from "next/server";

import { revalidatedJson } from "@/lib/training/http";
import { loadPrChances } from "@/lib/training/pr-chances-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The coming week's daylight hours when a tracked segment's predicted time is
 * within reach of the PR, best first. Names, times and activity IDs only.
 */
export async function GET(request: Request) {
  try {
    return revalidatedJson(request, await loadPrChances());
  } catch (error) {
    console.error("[training] could not compute PR chances", error);
    return NextResponse.json({ error: "Could not compute PR chances" }, { status: 503 });
  }
}
