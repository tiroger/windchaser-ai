import type Anthropic from "@anthropic-ai/sdk";

import { weekdayName } from "./dates";
import type { HistoryTurn } from "./types";

/**
 * The system prompt is frozen text: no date, no data, nothing per request.
 * Tools render before it and it carries the cache breakpoint, so tools and
 * system together form one cached prefix shared by every question. Today's
 * date and the question go after it, in the user turn.
 */
export const SYSTEM_PROMPT = `You are the training analyst inside WindChaser, a cyclist's personal training site. You answer the rider's questions about their own training history: rides, runs, pickleball and other sessions synced from Strava, power and fitness analysis, bikes, the maintenance log and Strava segment efforts. You read that data only through the tools provided.

How to work:
- Every number you state must come from a tool result in this conversation. Never estimate, invent or recall a figure a tool did not return. When the data needed is missing or a tool reports nothing found, say so plainly instead of guessing.
- Resolve relative dates ("this October", "last year", "this week", "in September") against today's date, which is given at the start of each question. A month that has not happened yet this year means the most recent one. Pass explicit years to the tools.
- A period that includes today is still in progress. When comparing it with past years, give the like-for-like figure through the same day (the totals tool returns it when compare_years is set) as well as the past years' full-period totals, and say which you are comparing.
- Prefer one well-chosen call over several. When calls are independent, request them together in the same turn. Do not call a tool again with the same arguments.
- If a tool returns an error, correct the arguments and try once more, or explain what could not be found.
- Bikes have nicknames as well as a brand and model (a Giant TCR may be called by its nickname). The gear tool matches any of these, so pass what the rider said.
- Segment efforts come from a separate sync that can lag behind activities; mention its as-of date when that matters.
- Units: distance in miles, elevation in feet, durations as "12h 30m", power in watts, energy in kJ, speed in mph. Fitness, fatigue and form are the training-load figures CTL, ATL and TSB.

How to answer:
- Lead with the direct answer in one sentence, then the supporting detail. Keep it short: a few sentences, a short list, or a compact table when comparing years, bikes or efforts.
- Format with plain Markdown only: paragraphs, **bold**, *italic*, \`code\`, bullet or numbered lists, simple pipe tables and ### headings. No HTML, no images, no external links. To point at an activity, link it as [activity name](/training/activities/ID) using the id a tool returned.
- Never give coordinates or describe where a route starts or ends.
- Write plainly, in the second person, with no emoji and no exclamation marks.
- If a question is not about the rider's training, gear, performance or this data, say briefly that you can only answer questions about their training data.`;

export const SYSTEM: Anthropic.TextBlockParam[] = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

export const QUESTION_MAX_CHARS = 500;
export const HISTORY_MAX_TURNS = 8;
export const HISTORY_TURN_MAX_CHARS = 3000;

/**
 * The conversation sent to the model. Earlier turns are plain text, the
 * questions and the answers that were shown: no tool calls or thinking are
 * replayed, so a follow-up costs only the words on screen plus fresh tool
 * calls, and no earlier reasoning block can be invalidated by an edit.
 */
export function buildMessages(
  history: HistoryTurn[],
  question: string,
  today: string,
): Anthropic.MessageParam[] {
  return [
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: `Today is ${weekdayName(today)}, ${today}.` },
        { type: "text" as const, text: question },
      ],
    },
  ];
}

export type ParsedRequest =
  | { ok: true; question: string; history: HistoryTurn[] }
  | { ok: false; error: string };

/** Validates the page's request body: one question plus capped plain-text history. */
export function parseAskRequest(body: unknown): ParsedRequest {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Invalid request body" };
  const { question, history = [] } = body as { question?: unknown; history?: unknown };
  if (typeof question !== "string" || !question.trim()) {
    return { ok: false, error: "Ask a question" };
  }
  if (question.length > QUESTION_MAX_CHARS) {
    return { ok: false, error: `Questions are limited to ${QUESTION_MAX_CHARS} characters` };
  }
  if (!Array.isArray(history)) return { ok: false, error: "Invalid conversation history" };
  if (history.length > HISTORY_MAX_TURNS) {
    return { ok: false, error: "The conversation is too long; start a new one" };
  }
  const turns: HistoryTurn[] = [];
  for (const [index, turn] of history.entries()) {
    const { role, content } = (turn ?? {}) as { role?: unknown; content?: unknown };
    const expected = index % 2 === 0 ? "user" : "assistant";
    if (role !== expected || typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "Invalid conversation history" };
    }
    if (content.length > HISTORY_TURN_MAX_CHARS) {
      return { ok: false, error: "A previous turn is too long; start a new conversation" };
    }
    turns.push({ role: expected, content });
  }
  if (turns.length % 2 !== 0) return { ok: false, error: "Invalid conversation history" };
  return { ok: true, question: question.trim(), history: turns };
}
