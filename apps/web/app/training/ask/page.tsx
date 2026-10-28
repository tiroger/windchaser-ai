import type { Metadata } from "next";

import AskPanel from "@/components/training/AskPanel";
import SectionHeader from "@/components/training/SectionHeader";
import { liveAiEnabled } from "@/lib/server/briefing";
import { askModel, askProviders } from "@/lib/training/ask/provider";

import "./ask.css";

export const metadata: Metadata = { title: "Ask" };

export default function AskPage() {
  return (
    <>
      <SectionHeader
        title="Ask"
        description="Questions about your training, answered by Claude from your synced data. Every tool call behind an answer is shown with it."
      />
      <AskPanel available={liveAiEnabled() && askProviders().length > 0} model={askModel()} />
    </>
  );
}
