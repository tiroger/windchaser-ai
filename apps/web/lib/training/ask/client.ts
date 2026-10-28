import { clip } from "./markdown";
import type { AskEvent, HistoryTurn, UsageTotals } from "./types";

/**
 * The Ask page's conversation state and the pieces of the wire protocol it
 * needs, kept free of React so they can be tested directly.
 */

export type ToolStep = {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  status: "running" | "ok" | "error";
  summary?: string;
  ms?: number;
};

/** Text the model wrote between tool calls: shown in the trace, not as the answer. */
export type NoteStep = { kind: "note"; text: string };

export type Step = ToolStep | NoteStep;

export type Turn = {
  id: string;
  question: string;
  answer: string;
  steps: Step[];
  status: "streaming" | "done" | "error" | "refusal";
  message?: string;
  provider?: string;
  model?: string;
  rounds?: number;
  usage?: UsageTotals;
  truncated?: boolean;
};

export function applyEvent(turn: Turn, event: AskEvent): Turn {
  switch (event.type) {
    case "start":
      return { ...turn, provider: event.provider, model: event.model };
    case "round":
      return { ...turn, rounds: event.round };
    case "text":
      return { ...turn, answer: turn.answer + event.delta };
    case "narration":
      return turn.answer.trim()
        ? { ...turn, steps: [...turn.steps, { kind: "note", text: turn.answer.trim() }], answer: "" }
        : { ...turn, answer: "" };
    case "tool":
      return {
        ...turn,
        steps: [...turn.steps, { kind: "tool", id: event.id, name: event.name, input: event.input, status: "running" }],
      };
    case "tool_result":
      return {
        ...turn,
        steps: turn.steps.map((step) =>
          step.kind === "tool" && step.id === event.id
            ? { ...step, status: event.ok ? "ok" : "error", summary: event.summary, ms: event.ms }
            : step,
        ),
      };
    case "done":
      return { ...turn, status: "done", rounds: event.rounds, usage: event.usage, truncated: event.truncated };
    case "refusal":
      return { ...turn, status: "refusal", message: event.message };
    case "error":
      return { ...turn, status: "error", message: event.message };
  }
}

/** Splits buffered SSE text into complete events and the unfinished remainder. */
export function parseSse(buffer: string): { events: AskEvent[]; rest: string } {
  const chunks = buffer.split("\n\n");
  const rest = chunks.pop() ?? "";
  const events: AskEvent[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)) as AskEvent);
      } catch {
        // A malformed line is skipped rather than ending the answer.
      }
    }
  }
  return { events, rest };
}

/** Matches the server's caps; the byte budget keeps the request small at the edge. */
export const HISTORY_PAIRS = 4;
export const ANSWER_CLIP = 1500;
export const BODY_BUDGET_BYTES = 5500;

/**
 * Earlier questions and the answers shown for them, oldest dropped first until
 * the request fits. Failed or refused turns are left out: they hold no facts.
 */
export function historyFor(turns: Turn[], question: string): HistoryTurn[] {
  const pairs = turns
    .filter((turn) => turn.status === "done" && turn.answer.trim())
    .slice(-HISTORY_PAIRS)
    .map((turn): [HistoryTurn, HistoryTurn] => [
      { role: "user", content: turn.question },
      { role: "assistant", content: clip(turn.answer, ANSWER_CLIP) },
    ]);
  const size = (list: Array<[HistoryTurn, HistoryTurn]>) =>
    new TextEncoder().encode(JSON.stringify({ question, history: list.flat() })).length;
  while (pairs.length && size(pairs) > BODY_BUDGET_BYTES) pairs.shift();
  return pairs.flat();
}

export function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** Compact one-line JSON for the trace. */
export function formatArgs(input: unknown): string {
  const text = JSON.stringify(input ?? {});
  return text === "{}" ? "no arguments" : text;
}

/** "claude-opus-5-5" reads as "Claude Opus 5.5". */
export function modelLabel(model: string): string {
  const parts = model.replace(/^anthropic\./, "").split("-").filter((part) => part !== "claude");
  const name = parts.filter((part) => !/^\d+$/.test(part));
  const version = parts.filter((part) => /^\d+$/.test(part)).join(".");
  const words = name.map((part) => part.charAt(0).toUpperCase() + part.slice(1));
  return ["Claude", ...words, version].filter(Boolean).join(" ");
}
