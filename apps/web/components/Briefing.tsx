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
      <div className="briefing-rule" aria-hidden="true" />
      <div className="briefing-body">
        <p className="eyebrow">Conditions briefing</p>
        {loading && !briefing ? (
          <p className="briefing-headline is-loading">Reading the forecast…</p>
        ) : briefing ? (
          <>
            <h2 className="briefing-headline">{briefing.headline}</h2>
            <p className="briefing-text">{briefing.body}</p>
            <p className="briefing-source">
              <span
                className={`src-dot ${briefing.source === "template" ? "is-template" : "is-model"}`}
              />
              {SOURCE_LABEL[briefing.source] ?? briefing.source}
              {briefing.model ? ` · ${briefing.model}` : ""}
              <span className="sep">·</span>
              evidence {briefing.evidence_hash}
            </p>
          </>
        ) : (
          <p className="briefing-text">No briefing available.</p>
        )}
      </div>
    </section>
  );
}
