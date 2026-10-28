import { NextResponse } from "next/server";

import { loadActivityRecord } from "@/lib/training/data";
import { revalidatedJson } from "@/lib/training/http";
import { loadActivitySegments } from "@/lib/training/loops-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** This activity's efforts on tracked segments, ranked against every effort on each. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ activityId: string }> },
) {
  const { activityId } = await params;
  if (!/^\d{1,20}$/.test(activityId)) {
    return NextResponse.json({ error: "Invalid activity ID" }, { status: 400 });
  }
  try {
    if (!(await loadActivityRecord(activityId))) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    }
    return revalidatedJson(request, { segments: await loadActivitySegments(activityId) });
  } catch (error) {
    console.error("[training] could not load segment efforts", error);
    return NextResponse.json({ error: "Could not load segment efforts" }, { status: 503 });
  }
}
