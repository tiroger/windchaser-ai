import type { Metadata } from "next";

import SavedRoutesPanel from "@/components/training/SavedRoutesPanel";
import SectionHeader from "@/components/training/SectionHeader";
import { loadPublicSavedRoutes } from "@/lib/training/data";

export const metadata: Metadata = { title: "Saved routes" };

export default async function SavedRoutesPage() {
  const routes = await loadPublicSavedRoutes();
  return (
    <>
      <SectionHeader
        title="Saved routes"
        description="Routes saved on Strava, read like a ride: gradient, climbs and the shape of the day."
      />
      <SavedRoutesPanel routes={routes} />
    </>
  );
}
