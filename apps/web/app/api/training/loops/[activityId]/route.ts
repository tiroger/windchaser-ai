import { NextResponse } from "next/server";

import { loadActivityRecord } from "@/lib/training/data";
import { revalidatedJson } from "@/lib/training/http";
import { loadActivityLoop } from "@/lib/training/loops-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The loop an activity belongs to, its rides ranked fastest first, or
 * `{loop: null}` when it has never been ridden again. IDs and metrics only.
 */
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
    return revalidatedJson(request, { loop: await loadActivityLoop(activityId) });
  } catch (error) {
    console.error("[training] could not load activity loop", error);
    return NextResponse.json({ error: "Could not load loop" }, { status: 503 });
  }
}
