"use client";

import { useState } from "react";

import { formatArgs, formatTokens, type Turn } from "@/lib/training/ask/client";

/**
 * Every tool call behind an answer: name, arguments, a short result summary
 * and timing. Open while the answer is being worked out, folded away once it
 * is done, and always there to inspect.
 */
export default function AskTrace({ turn }: { turn: Turn }) {
  // Follows the answer (open while streaming) until the rider toggles it.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? turn.status === "streaming";

  const tools = turn.steps.filter((step) => step.kind === "tool");
  if (!turn.steps.length && !turn.usage) return null;

  const usage = turn.usage;
  const parts = [
    `${tools.length} tool call${tools.length === 1 ? "" : "s"}`,
    turn.rounds ? `${turn.rounds} round${turn.rounds === 1 ? "" : "s"}` : null,
    usage
      ? `${formatTokens(usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens)} in · ${formatTokens(usage.output_tokens)} out`
      : null,
    usage?.cache_read_input_tokens ? `${formatTokens(usage.cache_read_input_tokens)} cached` : null,
  ].filter(Boolean);

  return (
    <details
      className="t-ask-trace"
      open={open}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        if (next !== open) setChosen(next);
      }}
    >
      <summary>
        <span>How this was answered</span>
        <span className="t-ask-trace-meta num">{parts.join(" · ")}</span>
      </summary>
      <ol>
        {turn.steps.map((step, index) =>
          step.kind === "note" ? (
            <li key={index} className="t-ask-step is-note">
              <p>{step.text}</p>
            </li>
          ) : (
            <li key={step.id} className={`t-ask-step is-${step.status}`}>
              <div className="t-ask-step-head">
                <span className="t-ask-dot" aria-hidden="true" />
                <code>{step.name}</code>
                <span className="t-ask-step-status">
                  {step.status === "running" ? "running…" : step.status === "error" ? "error" : `${step.ms ?? 0} ms`}
                </span>
              </div>
              <code className="t-ask-args">{formatArgs(step.input)}</code>
              {step.summary && <p className="t-ask-summary">{step.summary}</p>}
            </li>
          ),
        )}
      </ol>
      {turn.model && (
        <p className="t-ask-model">
          {turn.model} via {turn.provider === "bedrock" ? "Amazon Bedrock" : "the Anthropic API"}
        </p>
      )}
    </details>
  );
}
