"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { REVIEW_YEAR_COOKIE } from "@/app/training/year/constants";
import {
  formatNumber,
  isDistanceSport,
  SPORT_LABELS,
  type SportFilter,
} from "@/lib/training/activity-types";
import {
  EARTH_CIRCUMFERENCE_MI,
  EVEREST_FT,
  hourLabel,
  MONTH_NAMES,
  weekStart,
  type YearReviewData,
} from "@/lib/training/metrics/year-review";
import { withSport } from "@/lib/training/sections";

import ShareCard from "./YearReviewCard";
import {
  AroundTheWorld,
  Climbing,
  Clock,
  Seasons,
  Weekdays,
  YearBarcode,
} from "./YearReviewCharts";
import { Chapter, CountUp, dateRange, shortDate } from "./YearReviewParts";
import YearRing from "./YearReviewRing";
import { BiggestDays, Court, GearRaceChart, Places, VersusLastYear } from "./YearReviewStories";

/** A Tour de France is about 3,400 km. */
const TOUR_MI = 2_100;
const DAY_NAMES = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

function yearHref(year: number, filter: SportFilter, defaultYear: number): string {
  const base = withSport("/training/year", filter);
  if (year === defaultYear) return base;
  return `${base}${base.includes("?") ? "&" : "?"}year=${year}`;
}

/** The year picker: each year as a bar of its hours, the chosen one lit. */
function YearPicker({ review, defaultYear }: { review: YearReviewData; defaultYear: number }) {
  const listRef = useRef<HTMLOListElement>(null);
  const max = Math.max(1, ...review.years.map((entry) => entry.hours));
  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>("[aria-current]");
    if (list && current) {
      list.scrollLeft = current.offsetLeft - list.clientWidth / 2 + current.offsetWidth / 2;
    }
  }, [review.year]);
  return (
    <nav className="yr-picker" aria-label="Choose a year">
      <ol ref={listRef}>
        {review.years.map((entry) => (
          <li key={entry.year}>
            <Link
              href={yearHref(entry.year, review.filter, defaultYear)}
              aria-current={entry.year === review.year ? "page" : undefined}
              onClick={() => {
                document.cookie = `${REVIEW_YEAR_COOKIE}=${entry.year}; path=/training; samesite=lax`;
              }}
              title={`${entry.year}: ${formatNumber(entry.activities)} activities, ${formatNumber(entry.hours)} hours`}
            >
              <span
                className="yr-picker-bar"
                style={{ "--h": Math.max(0.06, entry.hours / max).toFixed(3) } as React.CSSProperties}
              />
              <span className="num">{entry.year}</span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

type ChapterEntry = { id: string; label: string };

/** The summary with its figures set in the mono face; bare years stay as text. */
function Highlighted({ text }: { text: string }) {
  return text.split(/(\d(?:[\d,.]*\d)?%?)/).map((part, index) =>
    index % 2 && !/^\d{4}$/.test(part) ? (
      <strong key={index} className="num">
        {part}
      </strong>
    ) : (
      part
    ),
  );
}

/**
 * The Year in review: a long scroll of chapters, each one visual and one line
 * of copy, built from aggregates the server computed for one year and sport.
 */
export default function YearReview({
  review,
  defaultYear,
}: {
  review: YearReviewData;
  defaultYear: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(false);
  const [current, setCurrent] = useState<string>("hero");
  const { year, filter, totals, window } = review;
  const distanceSport = isDistanceSport(filter) && totals.distance >= 1;
  const empty = totals.activities === 0;

  // Reveals: content is visible without JavaScript; once the page is live,
  // anything below the fold waits for the scroll to reach it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    setLive(true);
    if (typeof IntersectionObserver === "undefined") return;
    const reveal = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // An attribute rather than a class: React owns className and
            // would drop the class on the element's next render.
            entry.target.setAttribute("data-shown", "");
            reveal.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    root.querySelectorAll("[data-reveal]").forEach((node) => reveal.observe(node));

    const chapters = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length) {
          setCurrent((visible[0].target as HTMLElement).dataset.chapter ?? "hero");
        }
      },
      { rootMargin: "-45% 0px -54% 0px" },
    );
    root.querySelectorAll("[data-chapter]").forEach((node) => chapters.observe(node));
    return () => {
      reveal.disconnect();
      chapters.disconnect();
    };
  }, [year, filter]);

  // The progress bar runs on a scroll timeline where the browser has one.
  useEffect(() => {
    if (CSS.supports?.("animation-timeline: scroll()")) return;
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - innerHeight;
      root.style.setProperty("--scroll", String(max > 0 ? scrollY / max : 0));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);

  const chapters: ChapterEntry[] = [];
  const add = (id: string, label: string) => {
    chapters.push({ id, label });
    return chapters.length;
  };

  const fraction = totals.distance / EARTH_CIRCUMFERENCE_MI;
  const everests = totals.elevation / EVEREST_FT;
  const topDay = review.weekdays.reduce(
    (best, day) => (day.hours > best.hours ? day : best),
    review.weekdays[0],
  );
  const weekHours = review.weekdays.reduce((sum, day) => sum + day.hours, 0);
  const longest = review.bigDays.find((day) => day.key === "longest");
  const gearTotal = review.gear.entries.reduce((sum, entry) => sum + entry.total, 0);
  const gearLeader = review.gear.entries[0];
  const headline = review.comparisons[0];

  const stats: Array<{ label: string; value: number; unit?: string }> = distanceSport
    ? [
        { label: "Distance", value: totals.distance, unit: "mi" },
        { label: "Moving time", value: totals.hours, unit: "h" },
        { label: "Elevation", value: totals.elevation, unit: "ft" },
        { label: filter === "All" ? "Activities" : SPORT_LABELS[filter], value: totals.activities },
      ]
    : [
        { label: "Sessions", value: totals.activities },
        { label: "Hours", value: totals.hours, unit: "h" },
        { label: "Active days", value: totals.activeDays },
        {
          label: "Average session",
          value: totals.activities ? (totals.hours * 60) / totals.activities : 0,
          unit: "min",
        },
      ];

  const sections: React.ReactNode[] = [];
  if (!empty) {
    if (distanceSport) {
      sections.push(
        <Chapter
          key="world"
          id="world"
          number={add("world", "Around the world")}
          kicker="Around the world"
          title={
            fraction >= 1
              ? `${fraction.toFixed(2)} times around the Earth`
              : `${(fraction * 100).toFixed(1)}% of the way around the Earth`
          }
          copy={`${formatNumber(totals.distance)} miles: about ${(totals.distance / TOUR_MI).toFixed(1)} Tours de France laid end to end.`}
          layout="split"
        >
          <AroundTheWorld distance={totals.distance} />
        </Chapter>,
      );
      if (totals.elevation >= 1000) {
        sections.push(
          <Chapter
            key="climb"
            id="climb"
            number={add("climb", "Climbing")}
            kicker="Climbing"
            title={`${formatNumber(totals.elevation)} ft of up`}
            copy={
              everests >= 1
                ? `Enough to climb Everest from sea level ${everests.toFixed(1)} times over.`
                : `${Math.round(everests * 100)}% of the way up Everest from sea level.`
            }
            layout="split-reverse"
          >
            <Climbing elevation={totals.elevation} />
          </Chapter>,
        );
      }
    }

    sections.push(
      <Chapter
        key="ring"
        id="ring"
        number={add("ring", "The ring")}
        kicker="The year as a ring"
        title={`${formatNumber(totals.activeDays)} days out of ${formatNumber(window.lastIndex + 1)}`}
        copy={
          review.streak && review.streak.length > 1
            ? `Each bar is a day, as long as its hours. The longest streak, ${review.streak.length} days from ${dateRange(review.streak.start, review.streak.end)}, is traced inside the ring.`
            : "Each bar is a day, as long as its hours, coloured by sport."
        }
      >
        <YearRing days={review.ring} window={window} streak={review.streak} rest={review.rest} />
      </Chapter>,
    );

    if (review.clock.peakHour !== null) {
      sections.push(
        <Chapter
          key="clock"
          id="clock"
          number={add("clock", "When")}
          kicker="When you move"
          title={`Your hour is ${hourLabel(review.clock.peakHour)}`}
          copy={
            weekHours > 0
              ? `${DAY_NAMES[topDay.day]} carried ${Math.round((topDay.hours / weekHours) * 100)}% of the year's hours.`
              : undefined
          }
        >
          <div className="yr-when">
            <Clock clock={review.clock} />
            <Weekdays weekdays={review.weekdays} />
          </div>
        </Chapter>,
      );
    }

    if (review.stream.peak) {
      sections.push(
        <Chapter
          key="seasons"
          id="seasons"
          number={add("seasons", "Seasons")}
          kicker="Seasons"
          title={
            review.busiestMonth !== null
              ? `${MONTH_NAMES[review.busiestMonth]} was peak season`
              : "The shape of the year"
          }
          copy={`Weekly hours by sport. The busiest week began ${shortDate(weekStart(year, review.stream.peak.week))} and held ${formatNumber(review.stream.peak.hours, 1)} hours.`}
        >
          <Seasons stream={review.stream} year={year} />
        </Chapter>,
      );
    }

    if (review.bigDays.length) {
      sections.push(
        <Chapter
          key="days"
          id="days"
          number={add("days", "Big days")}
          kicker="Biggest days"
          title="The days that stood out"
          copy={
            longest
              ? `${longest.activity.name}, ${shortDate(longest.activity.date)}, was the longest at ${longest.display}. Open a card for the details.`
              : "Open a card for the details."
          }
        >
          <BiggestDays days={review.bigDays} />
        </Chapter>,
      );
    }

    if (review.places && review.places.routes.length > 1) {
      sections.push(
        <Chapter
          key="places"
          id="places"
          number={add("places", "Places")}
          kicker="Favourite places"
          title={`${formatNumber(review.places.routes.length)} routes, one sketch`}
          copy={`Every local route laid over the others; the brightest lines are the roads you kept coming back to.${review.places.elsewhere ? ` ${review.places.elsewhere} more happened further afield.` : ""}`}
          layout="split-reverse"
        >
          <Places sketch={review.places} ring={review.ring} />
        </Chapter>,
      );
    }

    if (gearLeader) {
      sections.push(
        <Chapter
          key="gear"
          id="gear"
          number={add("gear", "Gear")}
          kicker="Gear"
          title={`${gearLeader.name} did the most work`}
          copy={`${formatNumber(gearLeader.total)} miles, ${Math.round((gearLeader.total / gearTotal) * 100)}% of the year's miles on named gear. Press play to race it again.`}
          layout="split"
        >
          <GearRaceChart race={review.gear} year={year} />
        </Chapter>,
      );
    }

    if (review.court) {
      const court = review.court;
      sections.push(
        <Chapter
          key="court"
          id="court"
          number={add("court", "Pickleball")}
          kicker="Pickleball"
          title={`${formatNumber(court.sessions)} sessions on the court`}
          copy={`Every ball is a session, sized by its length${court.busiestMonth !== null ? `; ${MONTH_NAMES[court.busiestMonth]} was the busiest month` : ""}.${court.previousSessions ? ` ${court.sessions >= court.previousSessions ? "Up" : "Down"} from ${court.previousSessions} in ${year - 1}${window.partial ? " at this point" : ""}.` : ""}`}
        >
          <Court court={court} />
        </Chapter>,
      );
    }

    if (headline) {
      sections.push(
        <Chapter
          key="versus"
          id="versus"
          number={add("versus", "Versus")}
          kicker={`Versus ${year - 1}`}
          title={
            headline.change === null
              ? `${year} against ${year - 1}`
              : `${Math.abs(Math.round(headline.change * 100))}% ${headline.change >= 0 ? "more" : "less"} ${headline.label.toLowerCase()} than ${year - 1}`
          }
          copy={
            window.partial
              ? `Both years counted to ${shortDate(window.through)}; the dashed line is ${year - 1}.`
              : `Running totals month by month; the dashed line is ${year - 1}.`
          }
        >
          <VersusLastYear
            comparisons={review.comparisons}
            year={year}
            months={window.partial ? Number(window.through.slice(5, 7)) : 12}
          />
        </Chapter>,
      );
    }

    sections.push(
      <Chapter
        key="card"
        id="card"
        number={add("card", "Card")}
        kicker="The year on one card"
        title={window.partial ? `${year}, so far` : `That was ${year}`}
        copy="Save it as an image, share it, then go and start the next one."
      >
        <ShareCard review={review} filter={filter} />
      </Chapter>,
    );
  }

  return (
    <div className={`yr${live ? " is-live" : ""}`} ref={rootRef}>
      <div className="yr-progress" aria-hidden="true">
        <span />
      </div>

      <header className="yr-hero" data-chapter="hero">
        <div className="yr-hero-top">
          <span className="yr-kicker">Year in review · {SPORT_LABELS[filter]}</span>
          <YearPicker review={review} defaultYear={defaultYear} />
        </div>
        <h1 className="yr-title">
          <span className="sr-only">Year in review, {year}</span>
          <span className="yr-year" aria-hidden="true">
            {String(year)
              .split("")
              .map((digit, index) => (
                <span key={`${year}-${index}`} style={{ "--i": index } as React.CSSProperties}>
                  {digit}
                </span>
              ))}
          </span>
          {window.partial && <span className="yr-so-far">so far</span>}
        </h1>
        <p className="yr-summary">
          <Highlighted text={review.summary} />
        </p>
        {!empty && (
          <dl className="yr-totals">
            {stats.map((stat, index) => (
              <div key={stat.label} style={{ "--i": index } as React.CSSProperties}>
                <dt>{stat.label}</dt>
                <dd>
                  <CountUp className="num" value={stat.value} delay={250 + index * 110} />
                  {stat.unit && <span className="yr-unit">{stat.unit}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {!empty && <YearBarcode days={review.ring} window={window} />}
        {chapters.length > 0 && (
          <a className="yr-cue" href={`#yr-${chapters[0].id}`}>
            <span>Scroll through the year</span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M4 9l4 4 4-4" />
            </svg>
          </a>
        )}
      </header>

      {chapters.length > 0 && (
        <nav className="yr-index" aria-label="Chapters">
          <ol>
            {chapters.map((chapter, index) => (
              <li key={chapter.id}>
                <a
                  href={`#yr-${chapter.id}`}
                  aria-current={current === chapter.id ? "true" : undefined}
                >
                  <span className="yr-index-label">{chapter.label}</span>
                  <span className="num">{String(index + 1).padStart(2, "0")}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}

      {sections}
    </div>
  );
}
