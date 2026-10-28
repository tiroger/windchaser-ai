import { loadDataVersion } from "@/lib/training/data";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(
      { version: await loadDataVersion() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[training] could not read data version", error);
    return NextResponse.json({ error: "Could not read data version" }, { status: 503 });
  }
}
