import type { Metadata } from "next";
import { Suspense } from "react";

import Masthead from "@/components/Masthead";
import OwnerControl from "@/components/training/OwnerControl";
import TrainingNav from "@/components/training/TrainingNav";
import TrainingProvider from "@/components/training/TrainingProvider";
import {
  formatCalendarDate,
  getActivityKind,
  localIsoDate,
  type SportKind,
} from "@/lib/training/activity-types";
import { ownerModeActive } from "@/lib/training/admin-session";
import { loadTrainingData, type TrainingData } from "@/lib/training/data";

import "./training.css";

// Every page reads live data and the owner cookie; nothing here is static.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Training · WindChaser", template: "%s · Training · WindChaser" },
  description: "Rides, routes, fitness and equipment, synced from Strava.",
};

/**
 * The Training section's frame: the shared masthead with sync status and owner
 * mode, then section tabs and the sport filter, then the page.
 *
 * Data is loaded here as well as in each page. React's cache() makes that one
 * read per request, and the layout needs it for the filter's sports, the sync
 * line and the version the open page polls against.
 */
export default async function TrainingLayout({ children }: { children: React.ReactNode }) {
  let data: TrainingData | null = null;
  let failure: string | null = null;
  try {
    data = await loadTrainingData();
  } catch (error) {
    // Shown in place of the page rather than as a crash: the wind view and
    // the masthead still work when the training objects cannot be read.
    console.error("[training] could not load training data", error);
    failure = "Training data could not be loaded right now.";
  }
  const owner = await ownerModeActive();

  const counts = new Map<SportKind, number>();
  for (const activity of data?.activities ?? []) {
    const kind = getActivityKind(activity.type);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([kind]) => kind);
  const latest = (data?.activities ?? []).reduce<string | null>(
    (top, activity) => (!top || activity.date > top ? activity.date : top),
    null,
  );

  return (
    <TrainingProvider
      initialAdmin={owner}
      serverToday={localIsoDate()}
      dataVersion={data?.version ?? ""}
    >
      <div className="shell training">
        <Masthead>
          <span className="masthead-spacer" />
          <span
            className={`status ${latest ? "is-live" : "is-saved"}`}
            title="New activities arrive from Strava within a minute of upload"
          >
            <span className="dot" />
            {latest
              ? `Latest ${formatCalendarDate(latest, { month: "short", day: "numeric" })}`
              : "Waiting for the first sync"}
          </span>
          <OwnerControl />
        </Masthead>

        {/* useSearchParams needs a boundary; the tabs render without the
            filter for the instant before it resolves. */}
        <Suspense fallback={<div className="t-subnav" />}>
          <TrainingNav kinds={kinds} />
        </Suspense>

        <main className="t-main">
          {failure ? (
            <div className="panel t-failure" role="alert">
              <h1>Training is unavailable</h1>
              <p>{failure} The wind view is unaffected.</p>
            </div>
          ) : (
            children
          )}
        </main>

        <footer className="t-footer">
          <span>Synced from Strava. New activities arrive within a minute of upload.</span>
          <span>The first and last 500 m of every route are hidden.</span>
        </footer>
      </div>
    </TrainingProvider>
  );
}
