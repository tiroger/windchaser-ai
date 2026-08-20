import {
  generateBriefing,
  type BriefingEvaluation,
  type BriefingInput,
  type BriefingSegment,
} from "@/lib/server/briefing";

export const dynamic = "force-dynamic";

interface Payload {
  regionName: string;
  athleteName: string | null;
  timezone: string;
  blockedCount: number;
  ranked: Array<{
    segment: BriefingSegment;
    evaluation: BriefingEvaluation;
    whenIso: string;
  }>;
}

export async function POST(request: Request) {
  let payload: Payload;
  try {
    payload = (await request.json()) as Payload;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(payload.ranked)) {
    return Response.json({ error: "ranked must be an array" }, { status: 400 });
  }

  const input: BriefingInput = {
    regionName: payload.regionName ?? "your area",
    athleteName: payload.athleteName ?? null,
    now: new Date(),
    timezone: payload.timezone || "UTC",
    // The model only ever sees the top few. Everything it says must be
    // traceable to this evidence.
    ranked: payload.ranked.slice(0, 5),
    blockedCount: Number(payload.blockedCount) || 0,
  };

  try {
    const briefing = await generateBriefing(input);
    return Response.json(briefing);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
