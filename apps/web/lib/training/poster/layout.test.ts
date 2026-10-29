import { describe, expect, it } from "vitest";

import {
  fitTitleSize,
  fitToGpu,
  formatCoords,
  frameStats,
  isLatin,
  POSTER_ASPECT,
  posterFilename,
  posterLayout,
  posterSize,
  roundCoord,
  subtitleText,
  titleText,
  trackedWidth,
} from "./layout";

describe("poster size", () => {
  it.each([false, true])("is 3:4 portrait, and the map fills it exactly (small: %s)", (small) => {
    const size = posterSize(small);
    expect(size.width / size.height).toBeCloseTo(POSTER_ASPECT, 6);
    expect(size.cssWidth / size.cssHeight).toBeCloseTo(POSTER_ASPECT, 6);
    expect(size.cssWidth * size.pixelRatio).toBe(size.width);
    expect(size.cssHeight * size.pixelRatio).toBe(size.height);
  });

  it("prints at 12 × 16 in, 300 dpi, and halves that on a phone", () => {
    expect(posterSize(false)).toMatchObject({ width: 3600, height: 4800 });
    expect(posterSize(true)).toMatchObject({ width: 1800, height: 2400 });
  });

  it("scales down to what the GPU can draw, keeping the aspect and the layout size", () => {
    const fitted = fitToGpu(posterSize(false), 4096);
    expect(fitted.height).toBe(4096);
    expect(fitted.width).toBe(3072);
    expect(fitted.cssWidth).toBe(1800);
    expect(fitted.cssWidth * fitted.pixelRatio).toBeCloseTo(fitted.width, 0);
    expect(fitToGpu(posterSize(false), 16384)).toEqual(posterSize(false));
  });
});

describe("poster layout", () => {
  const layout = posterLayout(3600, 4800);

  it("fades the top and bottom quarters", () => {
    expect(layout.fades.top).toEqual([0, 1200]);
    expect(layout.fades.bottom).toEqual([3600, 4800]);
  });

  it("stacks title, rule, subtitle and coordinates up from the foot, inside the fade", () => {
    expect(layout.title.y).toBe(4128); // 14% up
    expect(layout.divider.y).toBe(4200); // 12.5% up
    expect(layout.subtitle.y).toBe(4320); // 10% up
    expect(layout.coords.y).toBe(4464); // 7% up
    expect(layout.title.y).toBeGreaterThan(layout.fades.bottom[0]);
    expect(layout.coords.y).toBeLessThan(layout.attribution.y);
    expect(layout.divider.x1 + layout.divider.x2).toBe(3600);
  });

  it("sizes type as maptoposter's 60/22/14 pt on a 12 in page", () => {
    expect(layout.title.size).toBe(250);
    expect(layout.coords.size).toBe(58);
    expect(layout.subtitle.size).toBeLessThan(layout.title.size);
    expect(layout.attribution.size).toBeGreaterThanOrEqual(9);
    // Half the width, half the type.
    expect(posterLayout(1800, 2400).title.size).toBe(125);
    expect(layout.attribution.x).toBeLessThan(3600);
  });

  it("keeps a short title at full size and shrinks a long one to fit", () => {
    const perChar = (chars: number) => (size: number) => trackedWidth(Array(chars).fill(size * 0.6), size, 0.38);
    expect(fitTitleSize(perChar(5), layout.title)).toBe(layout.title.size);
    const long = fitTitleSize(perChar(24), layout.title);
    expect(long).toBeLessThan(layout.title.size);
    expect(perChar(24)(long)).toBeLessThanOrEqual(layout.title.maxWidth);
    expect(fitTitleSize(perChar(400), layout.title)).toBe(layout.title.minSize);
  });

  it("adds tracking between characters, not after the last", () => {
    expect(trackedWidth([10, 10, 10], 100, 0.5)).toBe(130);
    expect(trackedWidth([], 100, 0.5)).toBe(0);
  });
});

describe("poster text", () => {
  it("capitalises and spaces Latin titles, leaves other scripts as written", () => {
    expect(titleText("  san   francisco ")).toEqual({ text: "SAN FRANCISCO", tracking: true });
    expect(titleText("Zürich")).toEqual({ text: "ZÜRICH", tracking: true });
    expect(titleText("東京")).toEqual({ text: "東京", tracking: false });
    expect(isLatin("2026")).toBe(true);
  });

  it("rounds the centre to two decimals with hemispheres", () => {
    expect(roundCoord(37.77493)).toBe(37.77);
    expect(roundCoord(-122.41942)).toBe(-122.42);
    expect(formatCoords([-122.41942, 37.77493])).toBe("37.77° N / 122.42° W");
    expect(formatCoords([151.2093, -33.8688])).toBe("33.87° S / 151.21° E");
    expect(formatCoords([0.004, 0.004])).toBe("0.00° N / 0.00° E");
  });

  it("never prints more than two decimals of a coordinate", () => {
    expect(formatCoords([-122.123456, 37.987654])).not.toMatch(/\d\.\d{3}/);
  });

  it("states the year filter, route count and miles", () => {
    expect(subtitleText({ year: "all", routes: 1204, miles: 21345.6 })).toBe(
      "ALL YEARS · 1,204 ROUTES · 21,346 MI",
    );
    expect(subtitleText({ year: "2025", routes: 1, miles: 30.2 })).toBe("2025 · 1 ROUTE · 30 MI");
  });

  it("counts the routes, and their miles, that reach into the frame", () => {
    const routes = [
      { miles: 30, coordinates: [[-122.3, 37.8], [-122.2, 37.9]] },
      { miles: 12, coordinates: [[-121, 36], [-122.25, 37.85]] },
      { miles: 50, coordinates: [[-73.9, 40.7]] },
    ];
    expect(frameStats(routes, [-122.5, 37.5, -122, 38])).toEqual({ routes: 2, miles: 42 });
  });

  it("names the file after the title and theme", () => {
    expect(posterFilename("San Francisco Bay Area", "Midnight Blue")).toBe(
      "windchaser-san-francisco-bay-area-midnight-blue.png",
    );
    expect(posterFilename("Zürich!", "noir")).toBe("windchaser-zurich-noir.png");
    expect(posterFilename("東京", "noir")).toBe("windchaser-heatmap-noir.png");
  });
});
