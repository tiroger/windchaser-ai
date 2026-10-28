"use client";

/**
 * A page that failed to render, inside the Training frame so the masthead and
 * section tabs still work. The detail goes to the console, not the page.
 */
export default function TrainingError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="panel t-failure" role="alert">
      <h1>This page could not be shown</h1>
      <p>Something went wrong reading the training data. It is usually temporary.</p>
      <button className="t-button" type="button" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
