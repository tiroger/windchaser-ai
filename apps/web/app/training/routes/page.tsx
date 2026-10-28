import type { Metadata } from "next";

import RouteExplorer from "@/components/training/RouteExplorer";
import SectionHeader from "@/components/training/SectionHeader";
import { matchesFilter } from "@/lib/training/activity-types";
import { loadTrainingData } from "@/lib/training/data";
import { parseSport } from "@/lib/training/sections";

export const metadata: Metadata = { title: "Routes" };

export default async function RoutesPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string | string[] }>;
}) {
  const filter = parseSport((await searchParams).sport);
  const data = await loadTrainingData();
  const activities = data.activities
    .filter((activity) => activity.hasRoute && matchesFilter(activity, filter))
    .sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <SectionHeader title="Routes" description="Every activity recorded with GPS, one at a time." />
      <RouteExplorer activities={activities} />
    </>
  );
}
