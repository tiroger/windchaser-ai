import Overview from "@/components/training/Overview";
import SectionHeader from "@/components/training/SectionHeader";
import { matchesFilter, SPORT_LABELS } from "@/lib/training/activity-types";
import { loadTrainingData } from "@/lib/training/data";
import { parseSport } from "@/lib/training/sections";

export default async function TrainingOverviewPage({
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
        title="Training"
        description={`${SPORT_LABELS[filter]}: this year against every other, goals, and the days you got out.`}
      />
      <Overview activities={activities} filter={filter} settings={data.settings} />
    </>
  );
}
