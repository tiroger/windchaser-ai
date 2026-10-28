"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyEvent,
  historyFor,
  modelLabel,
  parseSse,
  type Turn,
} from "@/lib/training/ask/client";
import type { AskEvent } from "@/lib/training/ask/types";

import AskMarkdown from "./AskMarkdown";
import AskTrace from "./AskTrace";
import { useTraining } from "./TrainingProvider";

const SUGGESTIONS = [
  "How does this October compare with my best year?",
  "When did I last wax the TCR chain?",
  "What's my FTP trend this year?",
  "How many pickleball hours in September?",
  "Am I on track for my distance goal?",
  "What was my longest ride this year?",
];

const QUESTION_MAX = 500;
const STORAGE_KEY = "windchaser-ask-conversation";

function readStored(): Turn[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const turns = raw ? (JSON.parse(raw) as Turn[]) : [];
    // An answer cut off by a reload is shown as such, not as still streaming.
    return turns.map((turn) =>
      turn.status === "streaming" ? { ...turn, status: "error", message: "Interrupted before it finished." } : turn,
    );
  } catch {
    return [];
  }
}

function errorFor(status: number, message: string | undefined): string {
  if (status === 403) return "Owner mode has ended. Unlock it again with Owner at the top of the page.";
  return message ?? "The question could not be sent. Try again.";
}

/**
 * Ask: questions about the rider's own training, answered by Claude with
 * tools over the real data. Owner-only, because every question is a paid
 * model call; visitors see what it is and how to unlock it.
 */
export default function AskPanel({ available, model }: { available: boolean; model: string }) {
  const { admin } = useTraining();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const restored = useRef(false);

  // The conversation survives moving between Training pages in this tab.
  useEffect(() => {
    if (!restored.current) {
      restored.current = true;
      const stored = readStored();
      // Read after hydration: the server render has no storage to match.
      if (stored.length) setTurns(stored);
      return;
    }
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns));
    } catch {
      // Storage unavailable (private mode); the conversation just won't persist.
    }
  }, [turns]);

  useEffect(() => () => abort.current?.abort(), []);

  const update = useCallback((id: string, change: (turn: Turn) => Turn) => {
    setTurns((current) => current.map((turn) => (turn.id === id ? change(turn) : turn)));
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;
      const id = `${Date.now()}`;
      const history = historyFor(turns, text);
      setTurns((current) => [...current, { id, question: text, answer: "", steps: [], status: "streaming" }]);
      setDraft("");
      setBusy(true);
      const controller = new AbortController();
      abort.current = controller;
      try {
        const response = await fetch("/api/training/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: text, history }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          let message: string | undefined;
          try {
            message = ((await response.json()) as { error?: string }).error;
          } catch {
            // Not JSON: fall back to the generic message.
          }
          update(id, (turn) => ({ ...turn, status: "error", message: errorFor(response.status, message) }));
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          if (parsed.events.length) {
            update(id, (turn) => parsed.events.reduce<Turn>((next, event: AskEvent) => applyEvent(next, event), turn));
          }
        }
        update(id, (turn) =>
          turn.status === "streaming"
            ? { ...turn, status: "error", message: "The connection closed before the answer finished." }
            : turn,
        );
      } catch (error) {
        const stopped = controller.signal.aborted;
        update(id, (turn) => ({
          ...turn,
          status: stopped && turn.answer ? "done" : "error",
          message: stopped ? "Stopped." : error instanceof Error ? error.message : "The question could not be sent.",
        }));
      } finally {
        abort.current = null;
        setBusy(false);
        input.current?.focus();
      }
    },
    [busy, turns, update],
  );

  if (!admin.authenticated) {
    return (
      <section className="panel t-ask-locked">
        <span className="label">Owner only</span>
        <h2>Ask about your training</h2>
        <p>
          Ask answers questions like how this month compares with your best year, when a chain was last
          waxed or how your FTP has moved, by having Claude call tools over your synced data. Every
          question is a paid model call, so it is available in owner mode only.
        </p>
        <p className="t-note">Unlock with the Owner button at the top of the page.</p>
      </section>
    );
  }

  if (!available) {
    return (
      <section className="panel t-ask-locked">
        <span className="label">Unavailable</span>
        <h2>Ask is switched off here</h2>
        <p>
          Live model calls are disabled on this deployment (LIVE_AI_ENABLED), or no model provider is
          configured. The rest of Training is unaffected.
        </p>
      </section>
    );
  }

  const latest = turns[turns.length - 1];

  return (
    <section className="t-ask" aria-label="Ask about your training">
      {turns.length === 0 ? (
        <div className="panel t-ask-intro">
          <p>
            Ask about your rides, totals, goals, power, bikes, maintenance or segments. Answers come from
            your synced data through the tools listed under each one.
          </p>
          <div className="chip-row t-ask-suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} className="chip" type="button" onClick={() => void ask(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="t-ask-head">
          <span className="label">
            {turns.length} question{turns.length === 1 ? "" : "s"}
          </span>
          <button
            className="t-link"
            type="button"
            onClick={() => {
              abort.current?.abort();
              setTurns([]);
              input.current?.focus();
            }}
          >
            New conversation
          </button>
        </div>
      )}

      <ol className="t-ask-thread" aria-live="polite">
        {turns.map((turn) => (
          <li key={turn.id} className="t-ask-turn">
            <p className="t-ask-question">{turn.question}</p>
            <article className={`panel t-ask-answer is-${turn.status}`} aria-busy={turn.status === "streaming"}>
              <AskTrace turn={turn} />
              {turn.answer ? (
                <AskMarkdown source={turn.answer} />
              ) : turn.status === "streaming" ? (
                <p className="t-ask-pending">
                  {turn.steps.some((step) => step.kind === "tool" && step.status === "running")
                    ? "Reading your data…"
                    : "Thinking…"}
                </p>
              ) : null}
              {turn.truncated && <p className="t-note">The answer hit its length limit and was cut short.</p>}
              {(turn.status === "error" || turn.status === "refusal") && (
                <p className="t-error" role="alert">
                  {turn.message}
                </p>
              )}
            </article>
          </li>
        ))}
      </ol>

      <form
        className="t-ask-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <label className="sr-only" htmlFor="t-ask-input">
          Your question
        </label>
        <textarea
          ref={input}
          id="t-ask-input"
          className="t-input t-ask-input"
          rows={2}
          maxLength={QUESTION_MAX}
          placeholder={latest ? "Ask a follow-up…" : "Ask about your training…"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void ask(draft);
            }
          }}
        />
        <div className="t-ask-actions">
          <span className="t-ask-hint">
            {draft.length > QUESTION_MAX - 100
              ? `${QUESTION_MAX - draft.length} characters left`
              : `${modelLabel(model)} · Enter to send`}
          </span>
          {busy ? (
            <button className="t-button is-quiet" type="button" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className="t-button" type="submit" disabled={!draft.trim()}>
              Ask
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
