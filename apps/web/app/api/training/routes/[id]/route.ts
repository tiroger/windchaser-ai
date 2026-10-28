import { loadActivityRoute } from "@/lib/training/data";
import { publicPolyline } from "@/lib/training/polyline";
import { revalidatedJson } from "@/lib/training/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^\d{1,20}$/.test(id)) {
    return NextResponse.json({ error: "Invalid activity ID" }, { status: 400 });
  }
  try {
    const polyline = publicPolyline(await loadActivityRoute(id));
    if (!polyline) {
      return NextResponse.json({ error: "Route not found" }, { status: 404 });
    }
    return revalidatedJson(request, { polyline });
  } catch (error) {
    console.error("[training] could not load activity route", error);
    return NextResponse.json({ error: "Could not load route" }, { status: 503 });
  }
}
