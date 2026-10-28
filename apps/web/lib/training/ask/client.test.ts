import { describe, expect, it } from "vitest";

import { applyEvent, BODY_BUDGET_BYTES, historyFor, modelLabel, parseSse, type Turn } from "./client";
import type { AskEvent } from "./types";

const fresh = (): Turn => ({ id: "1", question: "q", answer: "", steps: [], status: "streaming" });

describe("applyEvent", () => {
  it("builds the trace and answer from the event stream", () => {
    const events: AskEvent[] = [
      { type: "start", provider: "bedrock", model: "anthropic.claude-opus-5-5" },
      { type: "round", round: 1 },
      { type: "text", delta: "Let me check." },
      { type: "narration" },
      { type: "tool", id: "t1", name: "totals", input: { period: "year" } },
      { type: "tool_result", id: "t1", ok: true, summary: "12 sessions", ms: 4 },
      { type: "round", round: 2 },
      { type: "text", delta: "You did " },
      { type: "text", delta: "12 sessions." },
      { type: "done", stop_reason: "end_turn", rounds: 2, truncated: false, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } },
    ];
    const turn = events.reduce(applyEvent, fresh());
    expect(turn).toMatchObject({ status: "done", answer: "You did 12 sessions.", rounds: 2, provider: "bedrock" });
    expect(turn.steps).toEqual([
      { kind: "note", text: "Let me check." },
      { kind: "tool", id: "t1", name: "totals", input: { period: "year" }, status: "ok", summary: "12 sessions", ms: 4 },
    ]);
  });

  it("records refusals and errors", () => {
    expect(applyEvent(fresh(), { type: "refusal", message: "declined", category: null })).toMatchObject({ status: "refusal", message: "declined" });
    expect(applyEvent(fresh(), { type: "error", message: "boom" })).toMatchObject({ status: "error" });
  });
});

describe("parseSse", () => {
  it("returns complete events and keeps the partial remainder", () => {
    const { events, rest } = parseSse('data: {"type":"round","round":1}\n\ndata: {"type":"text","delta":"a"}\n\ndata: {"type":"te');
    expect(events).toEqual([{ type: "round", round: 1 }, { type: "text", delta: "a" }]);
    expect(rest).toBe('data: {"type":"te');
  });
});

describe("historyFor", () => {
  it("sends finished turns only, oldest dropped to fit the budget", () => {
    const turn = (id: string, answer: string, status: Turn["status"] = "done"): Turn => ({ id, question: `q${id}`, answer, steps: [], status });
    const turns = [turn("1", "x".repeat(1400)), turn("2", "refused", "refusal"), turn("3", "y".repeat(1400)), turn("4", "z".repeat(1400)), turn("5", "w".repeat(1400))];
    const history = historyFor(turns, "next?");
    expect(history.length % 2).toBe(0);
    expect(history.map((entry) => entry.content.slice(0, 2))).not.toContain("q2");
    expect(history.at(-1)?.content.startsWith("w")).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify({ question: "next?", history })).length).toBeLessThanOrEqual(BODY_BUDGET_BYTES);
  });
});

describe("modelLabel", () => {
  it("reads model ids as names", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelLabel("anthropic.claude-sonnet-5")).toBe("Claude Sonnet 5");
  });
});
