import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import { LAST_ROUND_NOTE, runAskLoop, type AskProvider, type AskRequest } from "./loop";
import type { AskEvent, ToolOutcome } from "./types";

type Block = Anthropic.ContentBlock;

function message(content: Block[], stop_reason: Anthropic.StopReason, extra: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    },
    ...extra,
  } as Anthropic.Message;
}

const text = (value: string) => ({ type: "text", text: value, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Block;

/** A provider that plays back scripted replies and records every request. */
function scripted(replies: Array<Anthropic.Message | Error>, name = "bedrock") {
  const requests: AskRequest[] = [];
  const provider: AskProvider = {
    name,
    model: "anthropic.claude-opus-5-5",
    async stream(request, onText) {
      // Snapshot: the loop keeps appending to the same array.
      requests.push({ ...request, messages: structuredClone(request.messages) });
      const reply = replies.shift();
      if (!reply) throw new Error("no scripted reply left");
      if (reply instanceof Error) throw reply;
      for (const block of reply.content) if (block.type === "text") onText(block.text);
      return reply;
    },
  };
  return { provider, requests };
}

async function run(providers: AskProvider[], execute?: (name: string, input: unknown) => Promise<ToolOutcome>, maxRounds?: number) {
  const events: AskEvent[] = [];
  const log = vi.fn();
  await runAskLoop({
    providers,
    system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
    tools: [],
    messages: [{ role: "user", content: "How far did I ride?" }],
    execute: execute ?? (async () => ({ ok: true, result: { miles: 10 }, summary: "10 mi" })),
    emit: (event) => events.push(event),
    maxRounds,
    log,
  });
  return { events, log };
}

describe("runAskLoop", () => {
  it("streams a direct answer and reports usage", async () => {
    const { provider, requests } = scripted([message([text("You rode 10 miles.")], "end_turn")]);
    const { events, log } = await run([provider]);
    expect(events.map((event) => event.type)).toEqual(["round", "start", "text", "done"]);
    expect(events.at(-1)).toMatchObject({ stop_reason: "end_turn", rounds: 1, usage: { input_tokens: 100, cache_read_input_tokens: 50 } });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ provider: "bedrock", round: 1, cache_read_input_tokens: 50 }));
    expect(requests[0]).toMatchObject({ output_config: { effort: "medium" }, cache_control: { type: "ephemeral" } });
    expect(requests[0]).not.toHaveProperty("tool_choice");
    expect(requests[0]).not.toHaveProperty("thinking");
  });

  it("runs parallel tool calls and returns every result in one user message", async () => {
    const { provider, requests } = scripted([
      message([text("Checking."), toolUse("t1", "totals", { period: "year" }), toolUse("t2", "goals_status", {})], "tool_use"),
      message([text("Done.")], "end_turn"),
    ]);
    const execute = vi.fn(async (name: string): Promise<ToolOutcome> =>
      name === "goals_status" ? { ok: false, error: "goals unavailable" } : { ok: true, result: { sessions: 3 }, summary: "3 sessions" },
    );
    const { events } = await run([provider], execute);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual([
      "round", "start", "text", "narration", "tool", "tool", "tool_result", "tool_result", "round", "text", "done",
    ]);
    const second = requests[1].messages;
    expect(second).toHaveLength(3);
    expect(second[1].role).toBe("assistant");
    expect(second[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ sessions: 3 }) },
        { type: "tool_result", tool_use_id: "t2", content: "goals unavailable", is_error: true },
      ],
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "t2", ok: false, summary: "goals unavailable" }));
  });

  it("turns a thrown tool into an is_error result", async () => {
    const { provider, requests } = scripted([
      message([toolUse("t1", "totals", {})], "tool_use"),
      message([text("Sorry.")], "end_turn"),
    ]);
    await run([provider], async () => {
      throw new Error("boom");
    });
    const results = requests[1].messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(results[0]).toMatchObject({ is_error: true, content: "totals failed unexpectedly." });
  });

  it("stops at the round cap, warning the model before the last round", async () => {
    const replies = Array.from({ length: 10 }, (_, index) => message([toolUse(`t${index}`, "totals", {})], "tool_use"));
    const { provider, requests } = scripted(replies);
    const execute = vi.fn(async (): Promise<ToolOutcome> => ({ ok: true, result: {}, summary: "ok" }));
    const { events } = await run([provider], execute, 8);

    expect(requests).toHaveLength(8);
    expect(execute).toHaveBeenCalledTimes(7);
    const lastUser = requests[7].messages.at(-1)!.content as Array<{ type: string; text?: string }>;
    expect(lastUser.at(-1)).toEqual({ type: "text", text: LAST_ROUND_NOTE });
    const earlierUser = requests[6].messages.at(-1)!.content as Array<{ type: string }>;
    expect(earlierUser.every((block) => block.type === "tool_result")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/Stopped after 8 rounds/) });
  });

  it("reports a refusal without running that turn's tools", async () => {
    const { provider } = scripted([
      message([toolUse("t1", "totals", {})], "refusal", { stop_details: { type: "refusal", category: "bio", explanation: null } }),
    ]);
    const execute = vi.fn();
    const { events } = await run([provider], execute);
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "refusal", category: "bio" });
  });

  it("never runs a tool call cut off by max_tokens, but keeps a truncated answer", async () => {
    const cut = scripted([message([toolUse("t1", "totals", { period: "ye" })], "max_tokens")]);
    const execute = vi.fn();
    const first = await run([cut.provider], execute);
    expect(execute).not.toHaveBeenCalled();
    expect(first.events.at(-1)).toMatchObject({ type: "error" });

    const long = scripted([message([text("A long answer")], "max_tokens")]);
    const second = await run([long.provider]);
    expect(second.events.at(-1)).toMatchObject({ type: "done", truncated: true });
  });

  it("falls back to the next provider only before any output", async () => {
    const bedrock = scripted([new Error("model not enabled")]);
    const anthropic = scripted([message([text("From the API.")], "end_turn")], "anthropic");
    const { events } = await run([bedrock.provider, anthropic.provider]);
    expect(events).toContainEqual({ type: "start", provider: "anthropic", model: "anthropic.claude-opus-5-5" });
    expect(events.at(-1)).toMatchObject({ type: "done" });

    // Once a provider has answered a round, a later failure is not retried elsewhere.
    const flaky = scripted([message([toolUse("t1", "totals", {})], "tool_use"), new Error("dropped")]);
    const spare = scripted([message([text("unused")], "end_turn")], "anthropic");
    await expect(run([flaky.provider, spare.provider])).rejects.toThrow("dropped");
    expect(spare.requests).toHaveLength(0);
  });
});
