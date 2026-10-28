"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { formatNumber, type SportKind } from "@/lib/training/activity-types";

/**
 * Small pieces the Year in review's chapters share: sport colours as tokens,
 * the motion preference, in-view detection, tweens and count-ups.
 *
 * Every animated value renders its final state on the server and for anyone
 * who prefers reduced motion; only a browser that will animate resets it to
 * the start, just before the first paint after hydration.
 */

/** Each sport's colour as a token expression; mirrors SportIcon's sportColor. */
export const KIND_COLOR: Record<SportKind, string> = {
  Ride: "var(--data-effort)",
  Run: "var(--data-wind)",
  Pickleball: "var(--data-open)",
  Walk: "var(--warn)",
  Swim: "color-mix(in srgb, var(--data-wind) 50%, var(--data-open))",
  Training: "var(--alert)",
  Other: "var(--ink-3)",
};

export const KIND_NAMES: Record<SportKind, string> = {
  Ride: "Riding",
  Run: "Running",
  Pickleball: "Pickleball",
  Walk: "Walking",
  Swim: "Swimming",
  Training: "Training",
  Other: "Other",
};

export const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeMotion(onChange: () => void) {
  const media = window.matchMedia(REDUCED);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/** True once the element has scrolled into view; it stays true. */
export function useInView<T extends Element>(
  threshold = 0.25,
  rootMargin = "0px 0px -8% 0px",
): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold, rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, rootMargin]);
  return [ref, inView];
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * 0 → 1 over `duration` once `active`, eased. Final (1) on the server and
 * under reduced motion.
 */
export function useTween(
  active: boolean,
  duration: number,
  { delay = 0, ease = easeOutCubic }: { delay?: number; ease?: (t: number) => number } = {},
): number {
  const reduced = useReducedMotion();
  const [progress, setProgress] = useState(1);
  const done = useRef(false);
  useIsoLayoutEffect(() => {
    if (!reduced && !done.current) setProgress(0);
  }, [reduced]);
  useEffect(() => {
    if (!active || reduced || done.current) return;
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      setProgress(ease(t));
      if (t < 1) frame = requestAnimationFrame(tick);
      else done.current = true;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, reduced, duration, delay, ease]);
  return reduced ? 1 : progress;
}

/**
 * A number that counts up from zero when it scrolls into view. Its width is
 * reserved from the final value so the line does not reflow as it counts;
 * screen readers get the final value only.
 */
export function CountUp({
  value,
  digits = 0,
  duration = 1700,
  delay = 0,
  format,
  className,
}: {
  value: number;
  digits?: number;
  duration?: number;
  delay?: number;
  format?: (value: number) => string;
  className?: string;
}) {
  const [ref, inView] = useInView<HTMLSpanElement>(0.4, "0px");
  const progress = useTween(inView, duration, { delay, ease: easeOutExpo });
  const show = format ?? ((v: number) => formatNumber(v, digits));
  const final = show(value);
  return (
    <span className={className} ref={ref}>
      {/* The final value holds the width; the counting value sits over it. */}
      <span aria-hidden="true" className="yr-count">
        <span className="yr-count-final">{final}</span>
        <span className="yr-count-live">{progress >= 1 ? final : show(value * progress)}</span>
      </span>
      <span className="sr-only">{final}</span>
    </span>
  );
}

/** Width of an element, for SVGs drawn at their real pixel size. */
export function useWidth<T extends Element>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useIsoLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(Math.round(node.getBoundingClientRect().width) || fallback);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}

/**
 * One chapter: a numbered kicker, a headline, one line of copy, and the
 * visual. The chapter's id is its anchor in the chapter index.
 */
export function Chapter({
  id,
  number,
  kicker,
  title,
  copy,
  layout = "stacked",
  children,
  aside,
}: {
  id: string;
  number: number;
  kicker: string;
  title: ReactNode;
  copy?: ReactNode;
  layout?: "stacked" | "split" | "split-reverse";
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section
      className={`yr-chapter is-${layout}`}
      id={`yr-${id}`}
      aria-labelledby={`yr-${id}-title`}
      data-chapter={id}
      data-number={String(number).padStart(2, "0")}
    >
      <header className="yr-copy" data-reveal>
        <span className="yr-kicker">
          <span className="num">{String(number).padStart(2, "0")}</span>
          {kicker}
        </span>
        <h2 id={`yr-${id}-title`}>{title}</h2>
        {copy && <p>{copy}</p>}
        {aside}
      </header>
      <div className="yr-visual" data-reveal>
        {children}
      </div>
    </section>
  );
}

/** Points on a circle with 0 at twelve o'clock, clockwise. */
export function polar(cx: number, cy: number, radius: number, angle: number): [number, number] {
  return [cx + radius * Math.sin(angle), cy - radius * Math.cos(angle)];
}

/** An arc path around (cx, cy) between two clockwise angles. */
export function arcPath(cx: number, cy: number, radius: number, from: number, to: number): string {
  const [x1, y1] = polar(cx, cy, radius, from);
  const [x2, y2] = polar(cx, cy, radius, to);
  const large = to - from > Math.PI ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** A thin wedge between two radii and two angles, as straight edges. */
export function wedgePath(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  from: number,
  to: number,
): string {
  const points = [
    polar(cx, cy, inner, from),
    polar(cx, cy, outer, from),
    polar(cx, cy, outer, to),
    polar(cx, cy, inner, to),
  ];
  return `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`;
}

/** An annular sector with true arcs, for wedges too wide to draw straight. */
export function sectorPath(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  from: number,
  to: number,
): string {
  const large = to - from > Math.PI ? 1 : 0;
  const [x1, y1] = polar(cx, cy, outer, from);
  const [x2, y2] = polar(cx, cy, outer, to);
  const [x3, y3] = polar(cx, cy, inner, to);
  const [x4, y4] = polar(cx, cy, inner, from);
  const f = (n: number) => n.toFixed(2);
  return `M${f(x1)} ${f(y1)}A${outer} ${outer} 0 ${large} 1 ${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}A${inner} ${inner} 0 ${large} 0 ${f(x4)} ${f(y4)}Z`;
}

/** Catmull-Rom through the points as cubic Béziers, for smooth series. */
export function smoothPath(points: Array<[number, number]>, move = true): string {
  if (!points.length) return "";
  const fmt = (n: number) => n.toFixed(1);
  let d = move ? `M${fmt(points[0][0])} ${fmt(points[0][1])}` : `L${fmt(points[0][0])} ${fmt(points[0][1])}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${fmt(c1[0])} ${fmt(c1[1])} ${fmt(c2[0])} ${fmt(c2[1])} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d;
}

export function shortDate(iso: string, withWeekday = false): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(withWeekday ? { weekday: "short" } : {}),
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, day));
}

export function dateRange(start: string, end: string): string {
  if (start === end) return shortDate(start);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth
    ? `${shortDate(start)}–${Number(end.slice(8, 10))}`
    : `${shortDate(start)} – ${shortDate(end)}`;
}
