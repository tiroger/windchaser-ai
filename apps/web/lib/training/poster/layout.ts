/**
 * The poster's geometry, after maptoposter's: a 3:4 portrait page, the map
 * full bleed, fades over its top and bottom quarters, and the lettering
 * stacked near the foot. Everything is a fraction of the page, so a phone's
 * smaller poster is the same design at a lower resolution.
 */

export const POSTER_ASPECT = 3 / 4;

export type PosterSize = {
  /** Output pixels. */
  width: number;
  height: number;
  /** The offscreen map's CSS size; with `pixelRatio` it fills the output. */
  cssWidth: number;
  cssHeight: number;
  pixelRatio: number;
  /** Line and label widths relative to the on-screen map. */
  lineScale: number;
};

/**
 * 3600 × 4800 (12 × 16 in at 300 dpi) normally; 1800 × 2400 on a small screen,
 * where a 69-megapixel canvas could exhaust a phone's memory. The map is laid
 * out larger than the on-screen one, so it shows a zoom level more detail.
 */
export function posterSize(small: boolean): PosterSize {
  return small
    ? { width: 1800, height: 2400, cssWidth: 1200, cssHeight: 1600, pixelRatio: 1.5, lineScale: 1.25 }
    : { width: 3600, height: 4800, cssWidth: 1800, cssHeight: 2400, pixelRatio: 2, lineScale: 1.5 };
}

/** Lowers the pixel ratio, and the output with it, to what WebGL can draw. */
export function fitToGpu(size: PosterSize, maxRender: number): PosterSize {
  const largest = Math.max(size.width, size.height);
  if (largest <= maxRender) return size;
  const scale = maxRender / largest;
  return {
    ...size,
    width: Math.floor(size.width * scale),
    height: Math.floor(size.height * scale),
    pixelRatio: size.pixelRatio * scale,
  };
}

export type PosterLayout = {
  width: number;
  height: number;
  fades: { top: [number, number]; bottom: [number, number] };
  title: { y: number; size: number; minSize: number; maxWidth: number; tracking: number };
  divider: { y: number; x1: number; x2: number; thickness: number };
  subtitle: { y: number; size: number; tracking: number };
  coords: { y: number; size: number };
  attribution: { x: number; y: number; size: number };
};

/**
 * maptoposter's placements, measured up from the bottom edge: the title's
 * baseline at 14%, a short rule at 12.5%, the subtitle at 10% and the
 * coordinates at 7%. Its 60/22/14 pt type on a 12 in page becomes fractions of
 * the width here.
 */
export function posterLayout(width: number, height: number): PosterLayout {
  const fromBottom = (fraction: number) => Math.round(height * (1 - fraction));
  const em = (points: number) => Math.round((width * points) / 864);
  return {
    width,
    height,
    fades: { top: [0, Math.round(height * 0.25)], bottom: [Math.round(height * 0.75), height] },
    title: {
      y: fromBottom(0.14),
      size: em(60),
      minSize: em(18),
      maxWidth: Math.round(width * 0.86),
      tracking: 0.38,
    },
    divider: {
      y: fromBottom(0.125),
      x1: Math.round(width * 0.4),
      x2: Math.round(width * 0.6),
      thickness: Math.max(1, Math.round(width / 864)),
    },
    subtitle: { y: fromBottom(0.1), size: em(20), tracking: 0.12 },
    coords: { y: fromBottom(0.07), size: em(14) },
    attribution: {
      x: Math.round(width * 0.98),
      y: Math.round(height * 0.985),
      size: Math.max(9, em(6.5)),
    },
  };
}

/**
 * Whether a title is mostly Latin letters, which maptoposter capitalises and
 * letter-spaces; other scripts are drawn as written.
 */
export function isLatin(text: string): boolean {
  const letters = Array.from(text).filter((char) => /\p{L}/u.test(char));
  if (!letters.length) return true;
  const latin = letters.filter((char) => /\p{Script=Latin}/u.test(char));
  return latin.length / letters.length > 0.8;
}

/** The title as drawn: capitals with tracking for Latin script. */
export function titleText(title: string): { text: string; tracking: boolean } {
  const trimmed = title.trim().replace(/\s+/g, " ");
  return isLatin(trimmed)
    ? { text: trimmed.toLocaleUpperCase("en-US"), tracking: true }
    : { text: trimmed, tracking: false };
}

/**
 * The largest type size, no bigger than the layout's, at which the title fits
 * its width. `measure` gives the drawn width at a size, tracking included.
 */
export function fitTitleSize(
  measure: (size: number) => number,
  { size, minSize, maxWidth }: { size: number; minSize: number; maxWidth: number },
): number {
  const natural = measure(size);
  if (natural <= maxWidth) return size;
  // Width scales linearly with size, so one proportional step lands it.
  return Math.max(minSize, Math.floor((size * maxWidth) / natural));
}

/** Width of text drawn with extra space after every character but the last. */
export function trackedWidth(chars: number[], size: number, tracking: number): number {
  if (!chars.length) return 0;
  return chars.reduce((sum, width) => sum + width, 0) + (chars.length - 1) * size * tracking;
}

/** Rounded to two decimals (about a kilometre): never more precise than that. */
export const roundCoord = (value: number) => Math.round(value * 100) / 100;

/** "37.78° N / 122.27° W" for a [lng, lat] centre. */
export function formatCoords([lng, lat]: number[]): string {
  const ns = `${Math.abs(roundCoord(lat)).toFixed(2)}° ${lat >= 0 ? "N" : "S"}`;
  const ew = `${Math.abs(roundCoord(lng)).toFixed(2)}° ${lng >= 0 ? "E" : "W"}`;
  return `${ns} / ${ew}`;
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "2025 · 214 ROUTES · 6,120 MI", or "ALL YEARS · …". */
export function subtitleText({
  year,
  routes,
  miles,
}: {
  year: string;
  routes: number;
  miles: number;
}): string {
  const when = year === "all" ? "All years" : year;
  const count = `${integer.format(routes)} ${routes === 1 ? "route" : "routes"}`;
  return [when, count, `${integer.format(miles)} mi`].join(" · ").toLocaleUpperCase("en-US");
}

/**
 * The routes a poster frame shows, any part of them inside it, and their
 * miles. `bounds` is [west, south, east, north].
 */
export function frameStats(
  routes: Array<{ miles: number; coordinates: number[][] }>,
  [west, south, east, north]: [number, number, number, number],
): { routes: number; miles: number } {
  let count = 0;
  let miles = 0;
  for (const route of routes) {
    if (
      route.coordinates.some(
        ([lng, lat]) => lng >= west && lng <= east && lat >= south && lat <= north,
      )
    ) {
      count += 1;
      miles += route.miles;
    }
  }
  return { routes: count, miles };
}

/** A filename-safe slug of the title and theme. */
export function posterFilename(title: string, theme: string): string {
  const slug = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  return `windchaser-${slug(title) || "heatmap"}-${slug(theme) || "poster"}.png`;
}
