import { SPORT_LABELS, type SportFilter, type SportKind } from "@/lib/training/activity-types";

/**
 * The Training section's pages, in navigation order. Real routes, so the back
 * button, a shared link and a reload all land where the rider was.
 */
export const TRAINING_SECTIONS = [
  { href: "/training", label: "Overview", filtered: true },
  { href: "/training/activities", label: "Activities", filtered: true },
  { href: "/training/routes", label: "Routes", filtered: true },
  { href: "/training/saved-routes", label: "Saved routes", filtered: false },
  { href: "/training/heatmap", label: "Heatmap", filtered: true },
  { href: "/training/performance", label: "Performance", filtered: false },
  { href: "/training/garage", label: "Garage", filtered: false },
  { href: "/training/year", label: "Year in review", filtered: true },
] as const;

const KINDS = Object.keys(SPORT_LABELS).filter((key) => key !== "All") as SportKind[];

/**
 * The sport filter from ?sport=. Anything unrecognised reads as All rather
 * than an error: a stale or hand-edited link should still show something.
 */
export function parseSport(value: string | string[] | undefined): SportFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  return KINDS.find((kind) => kind === raw) ?? "All";
}

/** A Training URL carrying the filter, omitting it when it is the default. */
export function withSport(href: string, sport: SportFilter): string {
  return sport === "All" ? href : `${href}?sport=${encodeURIComponent(sport)}`;
}
