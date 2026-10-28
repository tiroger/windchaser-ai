import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AskProvider } from "@/lib/training/ask/loop";
import { askData } from "@/lib/training/ask/test-data";
import type { AskEvent } from "@/lib/training/ask/types";

const owner = vi.hoisted(() => ({ active: true, cookie: "123.signature" }));
const providers = vi.hoisted(() => ({ list: [] as AskProvider[] }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (owner.cookie ? { value: owner.cookie } : undefined) }),
}));
vi.mock("@/lib/training/admin-session", () => ({
  adminCookieName: "windchaser-owner",
  ownerModeActive: async () => owner.active,
}));
vi.mock("@/lib/training/ask/load", () => ({ loadAskData: async () => askData() }));
vi.mock("@/lib/training/ask/provider", () => ({
  askProviders: () => providers.list,
  askEffort: () => "medium",
}));

const { POST } = await import("./route");

function request(body: unknown, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  return new Request("http://localhost/api/training/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function reply(content: Anthropic.ContentBlock[], stop_reason: Anthropic.StopReason): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "m",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as Anthropic.Message;
}

function provider(replies: Anthropic.Message[]): AskProvider {
  return {
    name: "bedrock",
    model: "anthropic.claude-opus-5-5",
    async stream(_request, onText) {
      const next = replies.shift()!;
      for (const block of next.content) if (block.type === "text") onText(block.text);
      return next;
    },
  };
}

async function events(response: Response): Promise<AskEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as AskEvent);
}

let cookieCounter = 0;

beforeEach(() => {
  owner.active = true;
  // A fresh session per test, so the hourly limit does not carry over.
  owner.cookie = `session-${++cookieCounter}`;
  process.env.LIVE_AI_ENABLED = "true";
  providers.list = [provider([reply([{ type: "text", text: "Hello.", citations: null }], "end_turn")])];
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LIVE_AI_ENABLED;
});

describe("POST /api/training/ask", () => {
  it("refuses visitors without owner mode", async () => {
    owner.active = false;
    const response = await POST(request({ question: "How far?" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Owner mode required" });
  });

  it("refuses cross-site requests even with an owner session", async () => {
    const response = await POST(request({ question: "How far?" }, { "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
  });

  it("is unavailable when LIVE_AI_ENABLED is false", async () => {
    process.env.LIVE_AI_ENABLED = "false";
    const response = await POST(request({ question: "How far?" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/LIVE_AI_ENABLED/);
  });

  it("is unavailable without a model provider", async () => {
    providers.list = [];
    expect((await POST(request({ question: "How far?" }))).status).toBe(503);
  });

  it("rejects malformed and oversized requests", async () => {
    expect((await POST(request("{not json"))).status).toBe(400);
    expect((await POST(request({ question: "x".repeat(501) }))).status).toBe(400);
    expect((await POST(request({ question: "q", padding: "x".repeat(40_000) }))).status).toBe(413);
  });

  it("streams the answer as server-sent events", async () => {
    providers.list = [
      provider([
        reply([{ type: "tool_use", id: "t1", name: "totals", input: { period: "month", year: 2026, month: 10 } }], "tool_use"),
        reply([{ type: "text", text: "You rode 100 miles.", citations: null }], "end_turn"),
      ]),
    ];
    const response = await POST(request({ question: "How far this October?" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const stream = await events(response);
    expect(stream).toContainEqual(expect.objectContaining({ type: "tool", name: "totals" }));
    expect(stream).toContainEqual(expect.objectContaining({ type: "tool_result", ok: true }));
    expect(stream).toContainEqual({ type: "text", delta: "You rode 100 miles." });
    expect(stream.at(-1)).toMatchObject({ type: "done", rounds: 2 });
  });

  it("limits each owner session to 30 questions an hour", async () => {
    for (let i = 0; i < 30; i++) {
      providers.list = [provider([reply([{ type: "text", text: "ok", citations: null }], "end_turn")])];
      const response = await POST(request({ question: `Question ${i}` }));
      expect(response.status).toBe(200);
      await response.text();
    }
    const limited = await POST(request({ question: "One more" }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
