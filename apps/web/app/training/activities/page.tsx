import type { Metadata } from "next";

import ActivityTable from "@/components/training/ActivityTable";
import SectionHeader from "@/components/training/SectionHeader";
import { matchesFilter, SPORT_LABELS } from "@/lib/training/activity-types";
import { loadPerformance, loadTrainingData } from "@/lib/training/data";
import { parseSport } from "@/lib/training/sections";

export const metadata: Metadata = { title: "Activities" };

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string | string[] }>;
}) {
  const filter = parseSport((await searchParams).sport);
  const [data, performance] = await Promise.all([
    loadTrainingData(),
    // Load is a column here. A failure to score it should cost the column,
    // not the list.
    loadPerformance().catch((error) => {
      console.error("[training] could not score activity load", error);
      return null;
    }),
  ]);
  const activities = data.activities.filter((activity) => matchesFilter(activity, filter));
  return (
    <>
      <SectionHeader
        title="Activities"
        description={`${SPORT_LABELS[filter]}, newest first, with training load where it can be scored.`}
      />
      <ActivityTable activities={activities} loads={performance?.loads} expanded />
    </>
  );
}
