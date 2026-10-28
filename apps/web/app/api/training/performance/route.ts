import { NextResponse } from "next/server";

import { loadPerformance } from "@/lib/training/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** FTP history, power curves, the five-point profile, and training load. */
export async function GET() {
  try {
    return NextResponse.json(await loadPerformance(), {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch (error) {
    console.error("[training] could not build performance summary", error);
    return NextResponse.json({ error: "Could not load performance data" }, { status: 503 });
  }
}
