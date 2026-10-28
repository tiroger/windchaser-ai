import { NextResponse } from "next/server";

import { loadPublicSavedRoutes } from "@/lib/training/data";
import { revalidatedJson } from "@/lib/training/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The athlete's public saved routes, ends trimmed for privacy. */
export async function GET(request: Request) {
  try {
    return revalidatedJson(request, await loadPublicSavedRoutes());
  } catch (error) {
    console.error("[training] could not load saved routes", error);
    return NextResponse.json({ error: "Could not load saved routes" }, { status: 503 });
  }
}
