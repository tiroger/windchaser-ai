import { describe, expect, it } from "vitest";

import {
  isMapThemeId,
  MAP_THEME_OPTIONS,
  POSTER_THEMES,
  posterTheme,
  ROAD_TIERS,
  STANDARD,
  standardInk,
} from "./themes";

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** WCAG relative luminance, enough to check a heat colour stands off its ground. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("poster themes", () => {
  it("offers six maptoposter themes after Standard", () => {
    expect(POSTER_THEMES).toHaveLength(6);
    expect(MAP_THEME_OPTIONS[0]).toEqual({ id: STANDARD, name: "Standard" });
    expect(MAP_THEME_OPTIONS.map((option) => option.id).slice(1)).toEqual(
      POSTER_THEMES.map((theme) => theme.id),
    );
    expect(new Set(POSTER_THEMES.map((theme) => theme.id)).size).toBe(POSTER_THEMES.length);
  });

  it.each(POSTER_THEMES.map((theme) => [theme.id, theme] as const))(
    "%s has every key a map and a poster need",
    (_, theme) => {
      expect(theme.name).toBeTruthy();
      expect(theme.description).toBeTruthy();
      expect(theme.source).toMatch(/^themes\/[a-z_]+\.json$/);
      expect(typeof theme.dark).toBe("boolean");
      for (const colour of [theme.bg, theme.text, theme.gradient, theme.water, theme.parks, theme.heat.color]) {
        expect(colour).toMatch(HEX);
      }
      expect(Object.keys(theme.roads).sort()).toEqual([...ROAD_TIERS].sort());
      for (const tier of ROAD_TIERS) expect(theme.roads[tier]).toMatch(HEX);
      expect(theme.roadOpacity).toBeGreaterThan(0);
      expect(theme.roadOpacity).toBeLessThanOrEqual(1);
      const [low, high] = theme.heat.opacity;
      expect(low).toBeGreaterThan(0);
      expect(high).toBeGreaterThan(low);
      expect(high).toBeLessThanOrEqual(1);
    },
  );

  it.each(POSTER_THEMES.map((theme) => [theme.id, theme] as const))(
    "%s: the heat stands off the ground and the title is legible",
    (_, theme) => {
      expect(contrast(theme.heat.color, theme.bg)).toBeGreaterThan(3);
      expect(contrast(theme.text, theme.bg)).toBeGreaterThan(4.5);
      expect(theme.dark).toBe(luminance(theme.bg) < 0.2);
    },
  );

  it("recognises only known theme ids", () => {
    expect(isMapThemeId("standard")).toBe(true);
    expect(isMapThemeId("noir")).toBe(true);
    expect(isMapThemeId("neon")).toBe(false);
    expect(isMapThemeId(null)).toBe(false);
    expect(posterTheme("standard")).toBeNull();
  });

  it("composes the standard map's poster in the site's theme", () => {
    expect(standardInk("dark", "#ff7a2f")).toMatchObject({ dark: true, heat: "#ff7a2f" });
    expect(standardInk("light", "#c45314")).toMatchObject({ dark: false, heat: "#c45314" });
  });
});
