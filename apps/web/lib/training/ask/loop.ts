import type Anthropic from "@anthropic-ai/sdk";

import type { AskEvent, ToolOutcome, UsageTotals } from "./types";

/**
 * The tool-use loop behind the Ask page.
 *
 * A manual loop rather than the SDK's beta tool runner: it has to stream text
 * and tool steps to the browser as they happen, fall back from Bedrock to the
 * Anthropic API before the first token, append a "last round" reminder and
 * stop at a hard round cap, all of which are simplest to read in one place.
 *
 * Each round is one model call. Tool calls in a round run together and their
 * results go back in a single user message; a failing call is returned as an
 * is_error result so the model can correct itself. Every stop reason is
 * handled explicitly, and a turn that stopped on max_tokens or refusal never
 * has its tool calls executed.
 */

export const MAX_ROUNDS = 8;
export const MAX_TOKENS = 16_000;

export type AskRequest = Omit<Anthropic.MessageCreateParamsNonStreaming, "model" | "stream">;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AskProvider {
  name: string;
  model: string;
  /** Streams one model call, reporting text deltas, and resolves with the final message. */
  stream(
    request: AskRequest,
    onText: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<Anthropic.Message>;
}

export type UsageLog = {
  provider: string;
  model: string;
  round: number;
  stop_reason: string | null;
} & UsageTotals;

export type AskLoopOptions = {
  providers: AskProvider[];
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  execute: (name: string, input: unknown) => Promise<ToolOutcome>;
  emit: (event: AskEvent) => void;
  effort?: Effort;
  maxRounds?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  log?: (entry: UsageLog) => void;
};

export const LAST_ROUND_NOTE =
  "That was the last round of tool calls available for this question. Answer now from the results above without calling any more tools; say what could not be checked.";

export function addUsage(total: UsageTotals, usage: Anthropic.Usage): void {
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  total.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
}

/** Short, inspectable text of a result; the full JSON goes to the model only. */
function resultContent(outcome: ToolOutcome): string {
  return outcome.ok ? JSON.stringify(outcome.result) : outcome.error;
}

export async function runAskLoop(options: AskLoopOptions): Promise<void> {
  const {
    providers,
    system,
    tools,
    execute,
    emit,
    effort = "medium",
    maxRounds = MAX_ROUNDS,
    maxTokens = MAX_TOKENS,
    signal,
    log,
  } = options;
  if (!providers.length) throw new Error("No model provider is configured");
  const messages = [...options.messages];
  const usage: UsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let provider: AskProvider | null = null;
  let candidateIndex = 0;

  for (let round = 1; round <= maxRounds; round++) {
    emit({ type: "round", round });
    const request: AskRequest = {
      max_tokens: maxTokens,
      system,
      tools,
      messages,
      // Opus 5.5 always thinks adaptively; effort is the only depth control.
      output_config: { effort },
      // Automatic caching moves a breakpoint to the end of each request, so
      // round N+1 of the loop reads round N's prefix from the cache.
      cache_control: { type: "ephemeral" },
    };

    let message: Anthropic.Message | null = null;
    let streamed = false;
    while (!message) {
      const candidate: AskProvider = provider ?? providers[candidateIndex];
      try {
        message = await candidate.stream(
          request,
          (delta) => {
            if (!delta) return;
            if (!provider) {
              provider = candidate;
              emit({ type: "start", provider: candidate.name, model: candidate.model });
            }
            streamed = true;
            emit({ type: "text", delta });
          },
          signal,
        );
        if (!provider) {
          provider = candidate;
          emit({ type: "start", provider: candidate.name, model: candidate.model });
        }
      } catch (error) {
        // Fall through to the next provider only before anything was shown.
        const canFallBack =
          !provider && !streamed && !signal?.aborted && candidateIndex + 1 < providers.length;
        if (!canFallBack) throw error;
        console.warn(
          `[ask] ${candidate.name} failed, trying ${providers[candidateIndex + 1].name}:`,
          error instanceof Error ? error.message : error,
        );
        candidateIndex += 1;
      }
    }
    const active: AskProvider = provider!;

    addUsage(usage, message.usage);
    log?.({
      provider: active.name,
      model: active.model,
      round,
      stop_reason: message.stop_reason,
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
    });

    const toolUses = message.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );

    switch (message.stop_reason) {
      case "refusal": {
        // No server-side fallbacks on Bedrock: say so clearly instead.
        const category = message.stop_details?.category ?? null;
        emit({
          type: "refusal",
          category,
          message:
            "The model declined to answer this question. Ask about your training data in different words, or start a new conversation.",
        });
        return;
      }
      case "max_tokens":
        if (toolUses.length) {
          emit({ type: "error", message: "The answer was cut off before it finished planning. Try a narrower question." });
          return;
        }
        emit({ type: "done", stop_reason: "max_tokens", rounds: round, usage, truncated: true });
        return;
      case "pause_turn":
        messages.push({ role: "assistant", content: message.content });
        continue;
      case "tool_use":
        break;
      default:
        emit({ type: "done", stop_reason: message.stop_reason ?? "end_turn", rounds: round, usage, truncated: false });
        return;
    }

    if (!toolUses.length) {
      emit({ type: "done", stop_reason: "end_turn", rounds: round, usage, truncated: false });
      return;
    }
    if (round === maxRounds) {
      emit({
        type: "error",
        message: `Stopped after ${maxRounds} rounds of tool calls without a final answer. Try a narrower question.`,
      });
      return;
    }
    if (streamed) emit({ type: "narration" });

    messages.push({ role: "assistant", content: message.content });
    for (const block of toolUses) {
      emit({ type: "tool", id: block.id, name: block.name, input: block.input });
    }
    const results = await Promise.all(
      toolUses.map(async (block): Promise<Anthropic.ToolResultBlockParam> => {
        const started = Date.now();
        let outcome: ToolOutcome;
        try {
          outcome = await execute(block.name, block.input);
        } catch (error) {
          console.error(`[ask] tool ${block.name} threw`, error);
          outcome = { ok: false, error: `${block.name} failed unexpectedly.` };
        }
        emit({
          type: "tool_result",
          id: block.id,
          ok: outcome.ok,
          summary: outcome.ok ? outcome.summary : outcome.error,
          ms: Date.now() - started,
        });
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: resultContent(outcome),
          ...(outcome.ok ? {} : { is_error: true }),
        };
      }),
    );
    const content: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = [...results];
    if (round === maxRounds - 1) content.push({ type: "text", text: LAST_ROUND_NOTE });
    messages.push({ role: "user", content });
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  }
  // Only reachable when the last round was a paused turn.
  emit({ type: "error", message: `Stopped after ${maxRounds} rounds without a final answer.` });
}
