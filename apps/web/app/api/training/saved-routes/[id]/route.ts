import { NextResponse } from "next/server";

import { loadPublicRouteProfile } from "@/lib/training/data";
import { revalidatedJson } from "@/lib/training/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A saved route's elevation profile and track. Distance and altitude are
 * complete; coordinates near either end are withheld, so the profile still
 * covers the whole route while the map never shows where it starts.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^\d{1,25}$/.test(id)) {
    return NextResponse.json({ error: "Invalid route ID" }, { status: 400 });
  }
  try {
    const profile = await loadPublicRouteProfile(id);
    if (!profile) {
      return NextResponse.json({ error: "Route profile not synced yet" }, { status: 404 });
    }
    return revalidatedJson(request, profile);
  } catch (error) {
    console.error("[training] could not load route profile", error);
    return NextResponse.json({ error: "Could not load route profile" }, { status: 503 });
  }
}
