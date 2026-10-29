import { Suspense } from "react";

import WindPage from "@/components/WindPage";

/**
 * The wind view. Its mode and selection live in the query string, which a
 * client component reads; the boundary lets the shell render first.
 */
export default function Page() {
  return (
    <Suspense
      fallback={
        <main className="loading">
          <div className="spinner" aria-hidden="true" />
        </main>
      }
    >
      <WindPage />
    </Suspense>
  );
}
