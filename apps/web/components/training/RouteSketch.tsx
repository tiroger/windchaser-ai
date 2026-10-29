"use client";

import { useEffect, useState } from "react";

import type { RankingDay, RouteRanking, Sketch } from "@/lib/training/route-ranking";

const MPH = 2.236936;

/**
 * Wind colours on the token pair the planner uses: tailwind toward the open
 * hue, headwind toward effort, grey when it barely matters. Bands match the
 * planner's map legend (2, 5 and 10 mph).
 */
export function sketchColour(tailMs: number): string {
  const mph = Math.abs(tailMs) * MPH;
  if (mph < 2) return "var(--ink-3)";
  const strength = mph < 5 ? 45 : mph < 10 ? 72 : 100;
  return `color-mix(in srgb, ${tailMs > 0 ? "var(--data-open)" : "var(--data-effort)"} ${strength}%, var(--ink-3))`;
}

/**
 * A route's shape coloured by the wind it meets, drawn from the server's
 * relative sketch: the privacy-trimmed track only, with gaps where it is
 * hidden, so neither end is ever drawn.
 */
export function RouteSketch({ sketch, label, className }: { sketch: Sketch; label: string; className?: string }) {
  const pad = 6;
  const runs: Array<{ colour: string; points: Array<[number, number]> }> = [];
  let open = false;
  sketch.points.forEach((point, i) => {
    if (!point) {
      open = false;
      return;
    }
    const colour = sketchColour(sketch.tail[i] ?? 0);
    const last = runs[runs.length - 1];
    if (open && last.colour === colour) {
      last.points.push(point);
      return;
    }
    // A new colour starts where the last one ended, so the line has no breaks.
    const previous = open ? last.points[last.points.length - 1] : null;
    runs.push({ colour, points: previous ? [previous, point] : [point] });
    open = true;
  });
  const lines = runs.map((run) => ({
    colour: run.colour,
    points: run.points.map(([x, y]) => `${x},${y}`).join(" "),
  }));
  return (
    <svg
      className={`t-rd-sketch ${className ?? ""}`}
      viewBox={`${-pad} ${-pad} ${sketch.width + pad * 2} ${sketch.height + pad * 2}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="xMidYMid meet"
    >
      {lines.map((line, i) => (
        <polyline
          key={i}
          points={line.points}
          fill="none"
          style={{ stroke: line.colour }}
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

// ------------------------------------------------------------- fetching --

export type RankingLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: RouteRanking };

// One request per day per page view, shared by every component that asks.
const requests = new Map<string, Promise<RouteRanking>>();

function request(day: RankingDay, sport: string): Promise<RouteRanking> {
  const key = `${day}|${sport}`;
  let pending = requests.get(key);
  if (!pending) {
    pending = fetch(`/api/training/route-ranking?day=${day}&sport=${sport}`).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
      return body as RouteRanking;
    });
    requests.set(key, pending);
    pending.catch(() => requests.delete(key));
  }
  return pending;
}

/** The ranking for a day, or null to fetch nothing. */
export function useRouteRanking(day: RankingDay | null, sport = "ride"): RankingLoad | null {
  const [load, setLoad] = useState<{ key: string; value: RankingLoad } | null>(null);
  const key = day ? `${day}|${sport}` : null;
  useEffect(() => {
    if (!day || !key) return;
    let cancelled = false;
    request(day, sport)
      .then((data) => !cancelled && setLoad({ key, value: { status: "ready", data } }))
      .catch(
        (error: Error) => !cancelled && setLoad({ key, value: { status: "error", message: error.message } }),
      );
    return () => {
      cancelled = true;
    };
  }, [day, sport, key]);
  if (!key) return null;
  return load?.key === key ? load.value : { status: "loading" };
}

// ---------------------------------------------------------------- words --

/** "+8 min", "−3 min" or "±0", for a badge. */
export function savedBadge(savedS: number): { text: string; tone: "is-faster" | "is-slower" | "" } {
  const minutes = Math.round(Math.abs(savedS) / 60);
  if (minutes === 0) return { text: "±0 min", tone: "" };
  return savedS > 0 ? { text: `+${minutes} min`, tone: "is-faster" } : { text: `−${minutes} min`, tone: "is-slower" };
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();
export function formatClock(epochS: number, timeZone: string): string {
  let format = clockFormats.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
    } catch {
      format = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
    }
    clockFormats.set(timeZone, format);
  }
  return format.format(epochS * 1000);
}
