import type { Metadata } from "next";

import HeatmapPanel from "@/components/training/HeatmapPanel";
import SectionHeader from "@/components/training/SectionHeader";
import { parseSport } from "@/lib/training/sections";

export const metadata: Metadata = { title: "Heatmap" };

export default async function HeatmapPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string | string[] }>;
}) {
  const filter = parseSport((await searchParams).sport);
  return (
    <>
      <SectionHeader title="Heatmap" description="Every route at once; the roads you use most glow brightest." />
      <HeatmapPanel filter={filter} />
    </>
  );
}
