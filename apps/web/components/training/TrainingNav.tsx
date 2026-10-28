"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import { SPORT_LABELS, type SportKind } from "@/lib/training/activity-types";
import { parseSport, TRAINING_SECTIONS, withSport } from "@/lib/training/sections";

/**
 * Section tabs and the sport filter, under the shared masthead.
 *
 * Both are links. The filter lives in the URL (?sport=) rather than in state,
 * so it survives a reload, travels in a shared link, and is carried from one
 * section to the next; sections that show every sport the same way simply do
 * not offer it.
 */
export default function TrainingNav({ kinds }: { kinds: SportKind[] }) {
  const pathname = usePathname() ?? "/training";
  const sport = parseSport(useSearchParams()?.get("sport") ?? undefined);

  const current = [...TRAINING_SECTIONS]
    .reverse()
    .find((section) => pathname === section.href || pathname.startsWith(`${section.href}/`));
  // An activity's own page has no list to filter.
  const showFilter = !!current?.filtered && !/^\/training\/activities\/[^/]+/.test(pathname);

  return (
    <div className="t-subnav">
      <nav className="t-tabs" aria-label="Training sections">
        {TRAINING_SECTIONS.map((section) => {
          const exact = pathname === section.href;
          const within = current?.href === section.href;
          return (
            <Link
              key={section.href}
              href={section.filtered ? withSport(section.href, sport) : section.href}
              aria-current={exact ? "page" : within ? "true" : undefined}
            >
              {section.label}
            </Link>
          );
        })}
      </nav>

      {showFilter && kinds.length > 1 && (
        <nav className="t-filter chip-row" aria-label="Filter by sport">
          {(["All", ...kinds] as const).map((kind) => (
            <Link
              key={kind}
              className="chip"
              href={withSport(pathname, kind)}
              aria-current={sport === kind ? "true" : undefined}
              scroll={false}
            >
              {kind === "All" ? "All" : SPORT_LABELS[kind]}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
