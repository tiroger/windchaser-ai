import { describe, expect, it } from "vitest";

import {
  buildPosterStyle,
  heatPaint,
  OPENFREEMAP_ATTRIBUTION,
  OPENFREEMAP_CREDIT,
  OPENFREEMAP_TILEJSON,
  ROAD_CLASSES,
  zoomWidth,
} from "./style";
import { POSTER_THEMES, posterTheme } from "./themes";

const noir = posterTheme("noir")!;
type AnyLayer = { id: string; type: string; paint?: Record<string, unknown>; filter?: unknown };
const layers = (labels = false) =>
  buildPosterStyle(noir, { labels }).layers as unknown as AnyLayer[];

describe("poster style", () => {
  it("draws maptoposter's layers in its order: ground, water, parks, roads", () => {
    const ids = layers().map((layer) => layer.id);
    const at = (id: string) => ids.indexOf(id);
    for (const id of ["background", "water", "waterway", "parks", "landcover"]) {
      expect(ids).toContain(id);
    }
    expect(at("background")).toBe(0);
    expect(at("water")).toBeLessThan(at("parks"));
    expect(at("parks")).toBeLessThan(at("road-path"));
    // Least important roads first, so motorways land on top.
    const roads = ids.filter((id) => id.startsWith("road-"));
    expect(roads).toEqual(ROAD_CLASSES.map((road) => road.id));
    expect(roads.at(-1)).toBe("road-motorway");
  });

  it("reads OpenMapTiles' layers and road classes", () => {
    const style = buildPosterStyle(noir);
    const sourceLayers = (style.layers as unknown as Array<{ "source-layer"?: string }>)
      .map((layer) => layer["source-layer"])
      .filter(Boolean);
    expect(new Set(sourceLayers)).toEqual(
      new Set(["water", "waterway", "park", "landcover", "transportation"]),
    );
    const classes = ROAD_CLASSES.flatMap((road) => road.classes).sort();
    expect(classes).toEqual(
      ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "track", "path"].sort(),
    );
  });

  it("weights roads by class as maptoposter does", () => {
    const width = Object.fromEntries(ROAD_CLASSES.flatMap((road) => road.classes.map((c) => [c, road.width])));
    expect(width).toMatchObject({
      motorway: 1.2,
      trunk: 1.0,
      primary: 1.0,
      secondary: 0.8,
      tertiary: 0.6,
      minor: 0.4,
    });
    const motorway = layers().find((layer) => layer.id === "road-motorway")!;
    expect(motorway.paint!["line-width"]).toEqual(zoomWidth(1.2));
    // Twice the line scale, twice the width at every stop.
    const scaled = buildPosterStyle(noir, { lineScale: 2 }).layers as unknown as AnyLayer[];
    const stops = (value: unknown) => (value as number[]).slice(3).filter((_, i) => i % 2 === 1);
    expect(stops(scaled.find((l) => l.id === "road-motorway")!.paint!["line-width"])).toEqual(
      stops(zoomWidth(1.2)).map((v) => Math.round(v * 2 * 1000) / 1000),
    );
  });

  it("paints with the theme's colours", () => {
    for (const theme of POSTER_THEMES) {
      const style = buildPosterStyle(theme).layers as unknown as AnyLayer[];
      const paint = (id: string) => style.find((layer) => layer.id === id)!.paint!;
      expect(paint("background")["background-color"]).toBe(theme.bg);
      expect(paint("water")["fill-color"]).toBe(theme.water);
      expect(paint("parks")["fill-color"]).toBe(theme.parks);
      expect(paint("road-motorway")["line-color"]).toBe(theme.roads.motorway);
      expect(paint("road-primary")["line-color"]).toBe(theme.roads.primary);
      expect(paint("road-minor")["line-color"]).toBe(theme.roads.residential);
      expect(paint("road-path")["line-color"]).toBe(theme.roads.default);
      expect(paint("road-secondary")["line-opacity"]).toBe(theme.roadOpacity);
    }
  });

  it("credits OpenFreeMap, OpenMapTiles and OpenStreetMap", () => {
    const style = buildPosterStyle(noir);
    const source = style.sources.openfreemap as { url: string; attribution: string };
    expect(source.url).toBe(OPENFREEMAP_TILEJSON);
    for (const text of [source.attribution, OPENFREEMAP_ATTRIBUTION, OPENFREEMAP_CREDIT]) {
      expect(text).toMatch(/OpenFreeMap/);
      expect(text).toMatch(/OpenMapTiles/);
      expect(text).toMatch(/OpenStreetMap/);
    }
  });

  it("leaves street names off unless asked, and loads glyphs only then", () => {
    const plain = buildPosterStyle(noir);
    expect(plain.glyphs).toBeUndefined();
    expect(layers().some((layer) => layer.type === "symbol")).toBe(false);
    const labelled = buildPosterStyle(noir, { labels: true });
    expect(labelled.glyphs).toMatch(/^https:\/\/tiles\.openfreemap\.org\/fonts\//);
    const ids = layers(true).map((layer) => layer.id);
    expect(ids.slice(-2)).toEqual(["label-road", "label-place"]);
  });

  it("draws the heat faint at low zoom, stronger close in, scaled with the roads", () => {
    const paint = heatPaint("#ff0000", [0.2, 0.4], 2);
    expect(paint["line-color"]).toBe("#ff0000");
    expect(paint["line-opacity"]).toEqual(["interpolate", ["linear"], ["zoom"], 8, 0.2, 13, 0.4]);
    expect(paint["line-width"]).toEqual(["interpolate", ["linear"], ["zoom"], 8, 2.2, 14, 5.2]);
  });
});
