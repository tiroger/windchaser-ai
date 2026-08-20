"use client";

import type { Briefing } from "@/lib/server/briefing";

const SOURCE_LABEL: Record<string, string> = {
  bedrock: "Bedrock",
  anthropic: "Claude API",
  template: "Deterministic template",
};

export default function BriefingPanel({
  briefing,
  loading,
}: {
  briefing: Briefing | null;
  loading: boolean;
}) {
  return (
    <section className="briefing" aria-live="polite">
      <span className="label">Conditions briefing</span>
      {loading && !briefing ? (
        <h2 className="briefing-headline is-loading">Reading the forecast…</h2>
      ) : briefing ? (
        <>
          <h2 className="briefing-headline">{briefing.headline}</h2>
          <p className="briefing-text">{briefing.body}</p>
          <p className="briefing-source">
            <span
              className={`src-dot ${
                briefing.source === "template" ? "is-template" : "is-model"
              }`}
            />
            {SOURCE_LABEL[briefing.source] ?? briefing.source}
            {briefing.model ? ` · ${briefing.model}` : ""}
            <span className="sep">·</span>
            {briefing.evidence_hash}
          </p>
        </>
      ) : (
        <p className="briefing-text">No briefing available.</p>
      )}
    </section>
  );
}
