"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import ThemeToggle, { useTheme } from "@/components/ThemeToggle";

/**
 * The one header every page shares: wordmark, the Wind / Training switch, the
 * page's own controls, and the theme toggle.
 *
 * Shared rather than copied so the two halves of the app cannot drift into
 * looking like two products, which is what merging them was for (ADR-0004).
 * Page controls arrive as children and keep their own markup; the wind view
 * passes its region chips and source pills exactly as it rendered them before.
 *
 * The theme toggle reads the same external store as every other useTheme
 * caller, so a page that also needs the theme (the wind map, the charts) stays
 * in step with the toggle here without the value being passed down.
 */
export default function Masthead({
  heading = false,
  children,
}: {
  /** Render the wordmark as the page's h1. The wind view has no other title. */
  heading?: boolean;
  children?: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const [theme, setTheme] = useTheme();
  const inTraining = pathname === "/training" || pathname.startsWith("/training/");
  const Name = heading ? "h1" : "span";

  return (
    <header className="masthead">
      <div className="wordmark">
        <svg className="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M2 8h11.5a3.2 3.2 0 1 0-3.1-4"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
          <path
            d="M2 13h15.4a3.4 3.4 0 1 1-3.3 4.3"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            opacity="0.55"
          />
        </svg>
        <Name className="wordmark-name">WindChaser</Name>
      </div>

      <nav className="app-switch" aria-label="WindChaser sections">
        {/* "page" on the exact page, "true" anywhere beneath it: the Training
            link stays marked while a rider is three levels into an activity. */}
        <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
          Wind
        </Link>
        <Link
          href="/training"
          aria-current={pathname === "/training" ? "page" : inTraining ? "true" : undefined}
        >
          Training
        </Link>
      </nav>

      {children}

      <ThemeToggle theme={theme} onChange={setTheme} />
    </header>
  );
}
