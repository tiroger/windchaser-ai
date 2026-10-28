import type { Metadata } from "next";
import { notFound } from "next/navigation";

import ActivityDetail from "@/components/training/ActivityDetail";
import {
  loadPerformance,
  loadPublicActivityDetail,
  loadTrainingData,
} from "@/lib/training/data";

type Params = Promise<{ id: string }>;

const VALID_ID = /^\d{1,20}$/;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id } = await params;
  if (!VALID_ID.test(id)) return { title: "Activity" };
  const data = await loadTrainingData().catch(() => null);
  return { title: data?.activities.find((activity) => activity.id === id)?.name ?? "Activity" };
}

/**
 * One activity. The route and streams are loaded and privacy-trimmed on the
 * server, through the same function the API uses, so the page arrives whole.
 */
export default async function ActivityPage({ params }: { params: Params }) {
  const { id } = await params;
  if (!VALID_ID.test(id)) notFound();
  const [data, detail, performance] = await Promise.all([
    loadTrainingData(),
    loadPublicActivityDetail(id),
    loadPerformance().catch((error) => {
      console.error("[training] could not build performance summary", error);
      return null;
    }),
  ]);
  const activity = data.activities.find((entry) => entry.id === id);
  if (!activity || !detail) notFound();
  // Only what this activity reads: the full model carries a load for every
  // activity and a year of daily fitness, none of which this page shows.
  const slim = performance && {
    ftp: performance.ftp,
    ftpHistory: performance.ftpHistory,
    heartRate: performance.heartRate,
    weightKg: performance.weightKg,
    loads: performance.loads[id] ? { [id]: performance.loads[id] } : {},
  };
  return <ActivityDetail activity={activity} gear={data.gear} performance={slim} detail={detail} />;
}
