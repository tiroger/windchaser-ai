import type { Metadata } from "next";
import { Suspense } from "react";

import PrChances, { PrChancesSkeleton } from "@/components/training/PrChances";
import SectionHeader from "@/components/training/SectionHeader";
import SegmentLeaderboards from "@/components/training/SegmentLeaderboards";
import { loadLeaderboards, loadPrChances } from "@/lib/training/pr-chances-data";

import "../segments.css";

export const metadata: Metadata = { title: "Segments" };

/** The forecast is the slow part, so it streams in after the leaderboards. */
async function Chances() {
  try {
    const data = await loadPrChances();
    return <PrChances data={data} nowMs={Date.parse(data.generatedAt)} />;
  } catch (error) {
    console.error("[training] could not compute PR chances", error);
    return (
      <article className="panel">
        <span className="label">PR chances · next 7 days</span>
        <p className="t-error">The forecast could not be read right now.</p>
      </article>
    );
  }
}

export default async function SegmentsPage() {
  const boards = await loadLeaderboards().catch((error) => {
    console.error("[training] could not load segment leaderboards", error);
    return [];
  });
  return (
    <>
      <SectionHeader
        title="Segments"
        description="When this week's wind brings a PR within reach, and your records with the wind taken out."
      />
      <div className="t-stack">
        <Suspense fallback={<PrChancesSkeleton />}>
          <Chances />
        </Suspense>
        <SegmentLeaderboards boards={boards} />
      </div>
    </>
  );
}
