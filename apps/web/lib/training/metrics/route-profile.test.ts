import { describe, expect, it } from "vitest";
import { findClimbs, gradeColor, GRADE_SCALE, gradeWindow, smoothedGrades, summarizeRange } from "./route-profile";

// A mile of flat, two miles climbing 5% (528 ft), then a mile descending 5%.
const distance = Array.from({ length: 401 }, (_, index) => index * 0.01);
const altitude = distance.map((miles) =>
  miles <= 1 ? 100 : miles <= 3 ? 100 + (miles - 1) * 264 : 628 - (miles - 3) * 264,
);

describe("route profile", () => {
  const grades = smoothedGrades(distance, altitude);

  it("measures grade across a distance window", () => {
    expect(grades[50]).toBeCloseTo(0);
    expect(grades[200]).toBeCloseTo(5);
    expect(grades[350]).toBeCloseTo(-5);
  });

  it("colours gradients from the VeloViewer-style scale", () => {
    expect(gradeColor(0)).toBe(GRADE_SCALE[3].color);
    expect(gradeColor(6)).toBe(GRADE_SCALE[6].color);
    expect(gradeColor(-10)).toBe(GRADE_SCALE[0].color);
  });

  it("keeps every band legible as a line on both themes' grounds", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    // WindChaser's --ground in each theme.
    for (const band of GRADE_SCALE) {
      expect(contrast(band.light, "#fafaf9")).toBeGreaterThanOrEqual(2.5);
      expect(contrast(band.dark, "#0b0d10")).toBeGreaterThanOrEqual(3);
    }
    expect(gradeColor(4, "light")).toBe(GRADE_SCALE[5].light);
    expect(gradeColor(4, "dark")).toBe(GRADE_SCALE[5].dark);
  });

  it("finds the sustained climb and categorizes it", () => {
    const climbs = findClimbs(distance, altitude, grades);
    expect(climbs).toHaveLength(1);
    expect(climbs[0].start).toBeCloseTo(1);
    expect(climbs[0].length).toBeCloseTo(2);
    expect(climbs[0].gain).toBeCloseTo(528);
    expect(climbs[0].averageGrade).toBeCloseTo(5);
    // 3219 m x 5% = 16,093: category 3.
    expect(climbs[0].category).toBe("3");
  });

  it("summarizes a selected range like VeloViewer", () => {
    const range = summarizeRange(distance, altitude, 300, 100);
    expect(range.distance).toBeCloseTo(2);
    expect(range.gain).toBeCloseTo(528);
    expect(range.grade).toBeCloseTo(5);
  });
});

describe("sparse saved-route profiles", () => {
  // A 120-mile route downsampled to 2,000 points: one every 0.06 mi.
  const sparse = Array.from({ length: 2000 }, (_, index) => index * 0.06);
  const flat = sparse.map(() => 100);
  flat[1000] = 160; // One GPS altitude glitch.

  it("measures grade over at least four samples", () => {
    expect(gradeWindow(sparse)).toBeCloseTo(0.24);
    expect(gradeWindow(distance)).toBeCloseTo(0.1);
  });

  it("does not turn a single glitch into a wall", () => {
    const naive = Math.max(...smoothedGrades(sparse, flat));
    const adaptive = Math.max(...smoothedGrades(sparse, flat, gradeWindow(sparse)));
    expect(naive).toBeGreaterThan(15);
    expect(adaptive).toBeLessThan(5);
  });
});

