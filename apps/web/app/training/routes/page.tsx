import type { Metadata } from "next";

import RouteExplorer from "@/components/training/RouteExplorer";
import SectionHeader from "@/components/training/SectionHeader";
import { getActivityKind, matchesFilter } from "@/lib/training/activity-types";
import { loadTrainingData } from "@/lib/training/data";
import { loadTopLoops } from "@/lib/training/loops-data";
import { parseSport } from "@/lib/training/sections";

export const metadata: Metadata = { title: "Routes" };

export default async function RoutesPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string | string[] }>;
}) {
  const filter = parseSport((await searchParams).sport);
  const [data, loops] = await Promise.all([
    loadTrainingData(),
    // Loops of three or more rides, so the list is of routes truly repeated.
    loadTopLoops(6, (type) => filter === "All" || getActivityKind(type) === filter)
      .then((top) => top.filter((loop) => loop.count >= 3))
      .catch((error) => {
        console.error("[training] could not match loops", error);
        return [];
      }),
  ]);
  const activities = data.activities
    .filter((activity) => activity.hasRoute && matchesFilter(activity, filter))
    .sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <SectionHeader title="Routes" description="Every activity recorded with GPS, one at a time." />
      <RouteExplorer activities={activities} loops={loops} />
    </>
  );
}
