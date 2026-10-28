import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { liveAiEnabled } from "@/lib/server/briefing";
import { adminCookieName, ownerModeActive } from "@/lib/training/admin-session";
import { loadAskData } from "@/lib/training/ask/load";
import { runAskLoop } from "@/lib/training/ask/loop";
import { buildMessages, parseAskRequest, SYSTEM } from "@/lib/training/ask/prompt";
import { askEffort, askProviders } from "@/lib/training/ask/provider";
import { globalLimiter, sessionLimiter } from "@/lib/training/ask/rate-limit";
import { runTool, TOOL_DEFINITIONS } from "@/lib/training/ask/tools";
import type { AskEvent } from "@/lib/training/ask/types";
import { sameOrigin } from "@/lib/training/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wall-clock budget for one answer, tool calls included. */
const ANSWER_TIMEOUT_MS = 120_000;
const BODY_MAX_BYTES = 32_000;

function failure(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return "The model is busy right now. Try again in a minute.";
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return "The model provider rejected this server's credentials.";
  }
  if (error instanceof Anthropic.APIError) return "The model could not be reached. Try again shortly.";
  return "Something went wrong while answering. Try again.";
}

/**
 * Ask: one question about the owner's training, answered by Claude with tools
 * over the real data and streamed back as server-sent events.
 *
 * Owner-only and same-origin, like every other route that spends or writes.
 * Each question is bounded: question length, history length, a per-session
 * and per-instance hourly limit, a round cap and a wall-clock timeout, all
 * behind the LIVE_AI_ENABLED switch.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request) || !(await ownerModeActive())) {
    return NextResponse.json({ error: "Owner mode required" }, { status: 403 });
  }
  if (!liveAiEnabled()) {
    return NextResponse.json(
      { error: "Ask is switched off on this deployment (LIVE_AI_ENABLED is false)." },
      { status: 503 },
    );
  }
  const providers = askProviders();
  if (!providers.length) {
    return NextResponse.json({ error: "No model provider is configured here." }, { status: 503 });
  }

  const text = await request.text();
  if (Buffer.byteLength(text) > BODY_MAX_BYTES) {
    return NextResponse.json({ error: "Request too large; start a new conversation" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const parsed = parseAskRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // The signed cookie identifies the session; only its hash is kept.
  const session = (await cookies()).get(adminCookieName)?.value ?? "";
  const key = createHash("sha256").update(session).digest("base64url");
  for (const limiter of [sessionLimiter, globalLimiter]) {
    const allowed = limiter.take(key);
    if (!allowed.ok) {
      return NextResponse.json(
        { error: `Question limit reached. Try again in ${Math.ceil(allowed.retryAfterSeconds / 60)} minutes.` },
        { status: 429, headers: { "Retry-After": String(allowed.retryAfterSeconds) } },
      );
    }
  }

  let data;
  try {
    data = await loadAskData();
  } catch (error) {
    console.error("[ask] could not load training data", error);
    return NextResponse.json({ error: "Training data could not be loaded right now." }, { status: 503 });
  }

  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, request.signal, AbortSignal.timeout(ANSWER_TIMEOUT_MS)]);
  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (event: AskEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false;
        }
      };
      try {
        await runAskLoop({
          providers,
          system: SYSTEM,
          tools: TOOL_DEFINITIONS,
          messages: buildMessages(parsed.history, parsed.question, data.today),
          execute: (name, input) => runTool(name, input, data),
          emit,
          effort: askEffort(),
          signal,
          log: (entry) => console.info(`[ask] usage ${JSON.stringify(entry)}`),
        });
      } catch (error) {
        console.error("[ask] answer failed", error);
        emit({
          type: "error",
          message: signal.aborted ? "The answer took too long and was stopped." : failure(error),
        });
      } finally {
        console.info(`[ask] answered in ${Date.now() - started} ms`);
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by a disconnecting client.
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
