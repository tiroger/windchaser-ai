import type { Metadata } from "next";

import GaragePanel from "@/components/training/GaragePanel";
import SectionHeader from "@/components/training/SectionHeader";
import { loadTrainingData } from "@/lib/training/data";

export const metadata: Metadata = { title: "Garage" };

export default async function GaragePage() {
  const data = await loadTrainingData();
  return (
    <>
      <SectionHeader title="Garage" description="Bikes, shoes, and what each is due next." />
      <GaragePanel gear={data.gear} activities={data.activities} initialRecords={data.maintenance} />
    </>
  );
}
