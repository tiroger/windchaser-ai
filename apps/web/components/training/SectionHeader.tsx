/**
 * A Training page's title. The masthead's wordmark is not a heading here, so
 * this h1 is the page's one top-level heading.
 */
export default function SectionHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="t-head">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </header>
  );
}
