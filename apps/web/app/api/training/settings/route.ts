import { ConflictError, saveSettings } from "@/lib/training/data";
import { ownerModeActive } from "@/lib/training/admin-session";
import { sameOrigin } from "@/lib/training/security";
import { parseSettings } from "@/lib/training/settings";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Replaces the owner's goals and athlete settings. */
export async function PUT(request: Request) {
  if (!sameOrigin(request) || !(await ownerModeActive())) {
    return NextResponse.json({ error: "Admin session required" }, { status: 403 });
  }
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const settings = parseSettings(input);
  if (!settings) {
    return NextResponse.json({ error: "Settings are out of range" }, { status: 400 });
  }
  try {
    await saveSettings(settings);
    return NextResponse.json(settings);
  } catch (error) {
    if (error instanceof ConflictError) {
      return NextResponse.json(
        { error: "Settings changed elsewhere. Reload and try again." },
        { status: 409 },
      );
    }
    console.error("[training] could not save settings", error);
    return NextResponse.json({ error: "Could not save settings" }, { status: 503 });
  }
}
