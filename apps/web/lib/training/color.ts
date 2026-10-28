/**
 * Colour helpers shared by charts, maps and server-rendered icons. Pure, so a
 * server component may import them; the theme-reading hook lives in
 * components/training/Chart.tsx.
 */

/**
 * WindChaser's tokens, resolved to concrete colours for a canvas.
 *
 * ECharts paints to a canvas, which cannot read a CSS variable, so every chart
 * colour is read from the document at render time instead of being written
 * down a second time here. That keeps the stylesheet the single source of the
 * palette: retune a token and the charts follow, in both themes.
 */
export type ChartPalette = {
  theme: "light" | "dark";
  ground: string;
  surface: string;
  surface2: string;
  surface3: string;
  line: string;
  lineSoft: string;
  ink: string;
  ink2: string;
  ink3: string;
  accent: string;
  effort: string;
  open: string;
  wind: string;
  warn: string;
  alert: string;
  fontSans: string;
  fontMono: string;
};

function channels(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** A token colour at reduced opacity, as rgba() a canvas understands. */
export function alpha(hex: string, opacity: number): string {
  const rgb = channels(hex);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${opacity})` : hex;
}

/** Linear blend of two token colours, t = 0 giving `from`. */
export function mix(from: string, to: string, t: number): string {
  const a = channels(from);
  const b = channels(to);
  if (!a || !b) return from;
  const out = a.map((value, index) => Math.round(value + (b[index] - value) * t));
  return `#${out.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

