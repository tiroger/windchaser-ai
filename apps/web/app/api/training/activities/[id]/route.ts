import { NextResponse } from "next/server";

import { loadPublicActivityDetail } from "@/lib/training/data";
import { revalidatedJson } from "@/lib/training/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Route and second-by-second detail for one activity, ends trimmed for privacy. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^\d{1,20}$/.test(id)) {
    return NextResponse.json({ error: "Invalid activity ID" }, { status: 400 });
  }
  try {
    const detail = await loadPublicActivityDetail(id);
    if (!detail) return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    return revalidatedJson(request, detail);
  } catch (error) {
    console.error("[training] could not load activity detail", error);
    return NextResponse.json({ error: "Could not load activity" }, { status: 503 });
  }
}
