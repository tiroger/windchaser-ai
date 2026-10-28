"use client";

import { useRef, useState } from "react";

import { formatNumber, SPORT_LABELS, type SportFilter } from "@/lib/training/activity-types";
import type { YearReviewData } from "@/lib/training/metrics/year-review";

import { RingBars } from "./YearReviewRing";
import { KIND_COLOR, KIND_NAMES } from "./YearReviewParts";

const W = 1080;
const H = 1350;

/** Properties that decide how the card paints; copied inline before export. */
const PAINT = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-dasharray",
  "opacity",
  "stop-color",
  "stop-opacity",
  "font-family",
  "font-size",
  "font-weight",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
];

async function toDataUrl(url: string): Promise<string> {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * @font-face rules for the families the card uses, with their files inlined.
 * An SVG drawn into a canvas cannot load anything, so without these the PNG
 * would fall back to a system face.
 */
async function embeddedFonts(families: Set<string>): Promise<string> {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(list)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
      if (!families.has(family)) continue;
      const src = rule.style.getPropertyValue("src");
      const match = /url\(["']?([^"')]+)["']?\)/.exec(src);
      if (!match) continue;
      try {
        const data = await toDataUrl(new URL(match[1], sheet.href ?? location.href).href);
        const weight = rule.style.getPropertyValue("font-weight") || "100 900";
        rules.push(
          `@font-face{font-family:"${family}";src:url(${data}) format("woff2");font-weight:${weight};font-style:normal;}`,
        );
      } catch {
        // A face that cannot be fetched falls back to the system font.
      }
    }
  }
  return rules.join("");
}

/** Renders the on-page SVG card to a PNG with the current theme's colours. */
async function downloadPng(svg: SVGSVGElement, filename: string) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const source = [svg, ...Array.from(svg.querySelectorAll<SVGElement>("*"))];
  const target = [clone, ...Array.from(clone.querySelectorAll<SVGElement>("*"))];
  const families = new Set<string>();
  source.forEach((element, index) => {
    const style = getComputedStyle(element);
    const copy = target[index];
    for (const property of PAINT) {
      const value = style.getPropertyValue(property);
      if (value) copy.style.setProperty(property, value);
    }
    copy.style.setProperty("animation", "none");
    copy.style.setProperty("transition", "none");
    copy.removeAttribute("class");
    style
      .getPropertyValue("font-family")
      .split(",")
      .forEach((family) => families.add(family.replace(/["']/g, "").trim()));
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(W));
  clone.setAttribute("height", String(H));
  const fonts = await embeddedFonts(families);
  if (fonts) {
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = fonts;
    clone.insertBefore(style, clone.firstChild);
  }
  const markup = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    canvas.getContext("2d")!.drawImage(image, 0, 0, W, H);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("The image could not be encoded");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function cardStats(review: YearReviewData): Array<[string, string]> {
  const { totals, filter, streak } = review;
  const distance = filter !== "Pickleball" && filter !== "Training" && totals.distance >= 1;
  return distance
    ? [
        [formatNumber(totals.distance), "miles"],
        [formatNumber(totals.hours, 0), "hours"],
        [formatNumber(totals.elevation), "feet climbed"],
        [formatNumber(totals.activities), filter === "All" ? "activities" : SPORT_LABELS[filter].toLowerCase()],
      ]
    : [
        [formatNumber(totals.activities), "sessions"],
        [formatNumber(totals.hours, 0), "hours"],
        [formatNumber(totals.activeDays), "active days"],
        [String(streak?.length ?? 0), "day streak"],
      ];
}

/** Chapter twelve: the year on one card, and a button that saves it as a PNG. */
export default function ShareCard({ review, filter }: { review: YearReviewData; filter: SportFilter }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [state, setState] = useState<"idle" | "working" | "failed" | "copied">("idle");
  const ring = { size: 700, inner: 168, length: 148 };
  const stats = cardStats(review);
  const mixTotal = review.mix.reduce((sum, entry) => sum + entry.hours, 0) || 1;
  let mixX = 80;

  const save = async () => {
    if (!svgRef.current) return;
    setState("working");
    try {
      await downloadPng(
        svgRef.current,
        `windchaser-${review.year}${filter === "All" ? "" : `-${filter.toLowerCase()}`}.png`,
      );
      setState("idle");
    } catch (error) {
      console.error("[year] card export failed", error);
      setState("failed");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(review.summary);
      setState("copied");
      setTimeout(() => setState("idle"), 1800);
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="yr-share">
      <div className="yr-card-frame" data-reveal>
        <svg
          ref={svgRef}
          className="yr-card"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Summary card for ${review.year}: ${stats.map(([value, label]) => `${value} ${label}`).join(", ")}.`}
        >
          <defs>
            <radialGradient id="yr-card-glow" cx="85%" cy="8%" r="70%">
              <stop offset="0%" style={{ stopColor: "var(--accent)", stopOpacity: 0.22 }} />
              <stop offset="100%" style={{ stopColor: "var(--accent)", stopOpacity: 0 }} />
            </radialGradient>
            <radialGradient id="yr-card-glow-2" cx="10%" cy="100%" r="60%">
              <stop offset="0%" style={{ stopColor: "var(--data-wind)", stopOpacity: 0.14 }} />
              <stop offset="100%" style={{ stopColor: "var(--data-wind)", stopOpacity: 0 }} />
            </radialGradient>
          </defs>
          <rect className="yr-card-bg" width={W} height={H} rx={0} />
          <rect width={W} height={H} fill="url(#yr-card-glow)" />
          <rect width={W} height={H} fill="url(#yr-card-glow-2)" />
          <text className="yr-card-kicker" x={80} y={118}>
            WINDCHASER · YEAR IN REVIEW
          </text>
          <text className="yr-card-kicker is-right" x={W - 80} y={118} textAnchor="end">
            {SPORT_LABELS[filter].toUpperCase()}
          </text>
          <text className="yr-card-year" x={68} y={370}>
            {review.year}
          </text>
          {review.window.partial && (
            <text className="yr-card-note" x={80} y={430}>
              so far · through {new Date(`${review.window.through}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}
            </text>
          )}
          <g transform={`translate(${W - ring.size - 10} ${330})`}>
            <circle className="yr-card-ring-disc" cx={ring.size / 2} cy={ring.size / 2} r={ring.inner - 16} />
            <RingBars days={review.ring} window={review.window} geometry={ring} />
            <text className="yr-card-ring-value" x={ring.size / 2} y={ring.size / 2 + 14} textAnchor="middle">
              {formatNumber(review.totals.activeDays)}
            </text>
            <text className="yr-card-ring-label" x={ring.size / 2} y={ring.size / 2 + 52} textAnchor="middle">
              active days
            </text>
          </g>
          {stats.map(([value, label], index) => {
            const x = 80;
            const y = 560 + index * 128;
            return (
              <g key={label}>
                <text className="yr-card-stat" x={x} y={y}>
                  {value}
                </text>
                <text className="yr-card-stat-label" x={x + 4} y={y + 38}>
                  {label}
                </text>
              </g>
            );
          })}
          <g>
            {review.mix.map((entry) => {
              const width = ((W - 160) * entry.hours) / mixTotal;
              const x = mixX;
              mixX += width;
              return (
                <rect
                  key={entry.kind}
                  x={x}
                  y={1130}
                  width={Math.max(0, width - 4)}
                  height={14}
                  rx={7}
                  style={{ fill: KIND_COLOR[entry.kind] }}
                />
              );
            })}
            {review.mix.slice(0, 4).map((entry, index) => (
              <g key={entry.kind} transform={`translate(${80 + index * 240} 1190)`}>
                <circle cx={8} cy={-8} r={8} style={{ fill: KIND_COLOR[entry.kind] }} />
                <text className="yr-card-legend" x={26} y={0}>
                  {KIND_NAMES[entry.kind]} · {Math.round((entry.hours / mixTotal) * 100)}%
                </text>
              </g>
            ))}
          </g>
          {review.streak && (
            <text className="yr-card-foot" x={80} y={1272}>
              Longest streak {review.streak.length} days
              {review.busiestMonth !== null ? ` · biggest month ${new Date(Date.UTC(2000, review.busiestMonth, 1)).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })}` : ""}
            </text>
          )}
        </svg>
      </div>
      <div className="yr-share-side" data-reveal>
        <p className="yr-share-summary">{review.summary}</p>
        <div className="yr-share-actions">
          <button type="button" className="yr-button is-primary" onClick={save} disabled={state === "working"}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13h10" />
            </svg>
            {state === "working" ? "Rendering…" : "Download image"}
          </button>
          <button type="button" className="yr-button" onClick={copy}>
            {state === "copied" ? "Copied" : "Copy summary"}
          </button>
        </div>
        <p className="yr-muted" role="status">
          {state === "failed"
            ? "That did not work in this browser. A screenshot of the card works too."
            : "A 1080 × 1350 PNG in the current theme, sized for a post or a story."}
        </p>
      </div>
    </div>
  );
}
