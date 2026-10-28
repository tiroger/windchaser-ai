import type { Metadata } from "next";
import { cookies } from "next/headers";

import YearReview from "@/components/training/YearReview";
import {
  activityYear,
  calendarDate,
  localIsoDate,
  matchesFilter,
  SPORT_LABELS,
} from "@/lib/training/activity-types";
import { loadPublicHeatmap, loadTrainingData } from "@/lib/training/data";
import { buildYearReview, defaultReviewYear } from "@/lib/training/metrics/year-review";
import { parseSport } from "@/lib/training/sections";

import { REVIEW_YEAR_COOKIE } from "./constants";
import "./year.css";

export const metadata: Metadata = { title: "Year in review" };

function parseYear(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const year = Number(raw);
  return Number.isInteger(year) && year > 1900 ? year : undefined;
}

/**
 * One year told as a long scroll. Every aggregate is computed here, so the
 * browser receives the year's shape (days, hours, sketches) rather than the
 * full activity list and its routes.
 *
 * The year comes from ?year=, then from the year last chosen in this browser
 * session (the sport filter's links do not carry ?year=, and switching sport
 * should not jump to another year), then from the default: the most recent
 * complete year, or the current one in December.
 */
export default async function YearPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string | string[]; year?: string | string[] }>;
}) {
  const params = await searchParams;
  const filter = parseSport(params.sport);
  const [data, routes, jar] = await Promise.all([
    loadTrainingData(),
    loadPublicHeatmap(),
    cookies(),
  ]);
  const activities = data.activities.filter((activity) => matchesFilter(activity, filter));
  const today = calendarDate(localIsoDate())!;
  const years = [
    ...new Set(
      activities
        .map(activityYear)
        .filter((year): year is number => year !== undefined && year <= today.year),
    ),
  ];
  const requested = parseYear(params.year) ?? parseYear(jar.get(REVIEW_YEAR_COOKIE)?.value);
  const year =
    requested && years.includes(requested) ? requested : defaultReviewYear(years, today);

  if (!year) {
    return (
      <div className="yr yr-empty-page">
        <span className="yr-kicker">Year in review</span>
        <h1>Nothing to review yet</h1>
        <p>{SPORT_LABELS[filter]} have no history to tell a year from.</p>
      </div>
    );
  }

  const review = buildYearReview({ activities, gear: data.gear, routes, filter, year, today });
  return <YearReview review={review} defaultYear={defaultReviewYear(years, today)!} />;
}
