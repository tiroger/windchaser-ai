import type { Metadata } from "next";

import PerformancePanel from "@/components/training/PerformancePanel";
import SectionHeader from "@/components/training/SectionHeader";
import { loadPerformance, loadTrainingData } from "@/lib/training/data";

export const metadata: Metadata = { title: "Performance" };

export default async function PerformancePage() {
  const [data, performance] = await Promise.all([loadTrainingData(), loadPerformance()]);
  return (
    <>
      <SectionHeader
        title="Performance"
        description="Threshold, power curve and training load, from power where there is power and heart rate where there is not."
      />
      <PerformancePanel performance={performance} settings={data.settings} />
    </>
  );
}
