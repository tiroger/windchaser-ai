import type { Metadata } from "next";

import SectionHeader from "@/components/training/SectionHeader";
import YearReview from "@/components/training/YearReview";
import { matchesFilter, SPORT_LABELS } from "@/lib/training/activity-types";
import { loadTrainingData } from "@/lib/training/data";
import { parseSport } from "@/lib/training/sections";

export const metadata: Metadata = { title: "Year in review" };

export default async function YearPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string | string[] }>;
}) {
  const filter = parseSport((await searchParams).sport);
  const data = await loadTrainingData();
  const activities = data.activities.filter((activity) => matchesFilter(activity, filter));
  return (
    <>
      <SectionHeader
        title="Year in review"
        description={`${SPORT_LABELS[filter]}: a season against your own baseline.`}
      />
      <YearReview activities={activities} filter={filter} />
    </>
  );
}
