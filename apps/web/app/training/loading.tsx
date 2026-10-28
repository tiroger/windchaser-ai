/** Shown inside the frame while a page's data is read. */
export default function TrainingLoading() {
  return (
    <div className="loading t-loading">
      <div className="spinner" aria-hidden="true" />
      <p className="label">Loading…</p>
    </div>
  );
}
