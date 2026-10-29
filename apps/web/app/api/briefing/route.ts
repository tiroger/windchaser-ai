import { sanitizePayload } from "@/lib/briefing-evidence";
import { generateBriefing, type BriefingInput } from "@/lib/server/briefing";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // The body comes from a browser on a public route: counts are capped again,
  // names clipped and numbers made finite (lib/briefing-evidence.ts).
  const payload = sanitizePayload(raw);
  if (!payload) {
    return Response.json({ error: "ranked must be an array" }, { status: 400 });
  }

  const input: BriefingInput = {
    regionName: payload.regionName,
    athleteName: payload.athleteName,
    now: new Date(),
    timezone: payload.timezone,
    // The model only ever sees this. Everything it says must be traceable to it.
    ranked: payload.ranked,
    blockedCount: payload.blockedCount,
    nearMisses: payload.nearMisses,
    route: payload.route,
  };

  try {
    const briefing = await generateBriefing(input);
    return Response.json(briefing);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
