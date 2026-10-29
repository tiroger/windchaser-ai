import type { MapOptions } from "maplibre-gl";

import type { PosterTheme, RoadTier } from "./themes";

/** MapLibre's style document, named from MapOptions so nothing new is imported. */
export type StyleSpecification = Exclude<MapOptions["style"], string | undefined>;
export type LayerSpecification = StyleSpecification["layers"][number];
type Paint = Record<string, unknown>;

/**
 * OpenFreeMap's planet tiles: OpenStreetMap in the OpenMapTiles schema, free,
 * with no key. Its terms ask for the OpenMapTiles and OpenStreetMap credit
 * (OpenFreeMap's own is optional, and given here anyway).
 */
export const OPENFREEMAP_TILEJSON = "https://tiles.openfreemap.org/planet";
export const OPENFREEMAP_GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
export const OPENFREEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
/** The same credit as plain text, for a poster. */
export const OPENFREEMAP_CREDIT = "OpenFreeMap · © OpenMapTiles · Data © OpenStreetMap contributors";
export const CARTO_CREDIT = "© CARTO · Data © OpenStreetMap contributors";

/**
 * maptoposter's road hierarchy: line widths relative to a residential street,
 * and the tier that colours each OpenMapTiles `class`. Drawn from the least
 * important up, so motorways sit on top.
 */
export const ROAD_CLASSES: ReadonlyArray<{
  id: string;
  classes: string[];
  tier: RoadTier;
  width: number;
}> = [
  { id: "road-path", classes: ["path", "track"], tier: "default", width: 0.4 },
  { id: "road-minor", classes: ["minor", "service"], tier: "residential", width: 0.4 },
  { id: "road-tertiary", classes: ["tertiary"], tier: "tertiary", width: 0.6 },
  { id: "road-secondary", classes: ["secondary"], tier: "secondary", width: 0.8 },
  { id: "road-primary", classes: ["trunk", "primary"], tier: "primary", width: 1.0 },
  { id: "road-motorway", classes: ["motorway"], tier: "motorway", width: 1.2 },
];

/**
 * A line width that grows with zoom: `base` px at zoom 8, scaled up to street
 * level, so a road's weight relative to the others never changes.
 */
export function zoomWidth(base: number, scale = 1) {
  const at = (factor: number) => Math.round(base * factor * scale * 1000) / 1000;
  return ["interpolate", ["exponential", 1.4], ["zoom"], 8, at(0.6), 12, at(1.6), 16, at(6)];
}

const lines = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
const polygons = ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false];

/**
 * A poster style built in code over OpenFreeMap's vector tiles, in
 * maptoposter's order: background, water, parks, roads. The routes go above
 * (see heatPaint), and the poster's fades and lettering are drawn on the
 * canvas afterwards. Street names are left off unless `labels` is set.
 */
export function buildPosterStyle(
  theme: PosterTheme,
  { labels = false, lineScale = 1 }: { labels?: boolean; lineScale?: number } = {},
): StyleSpecification {
  const source = "openfreemap";
  const layers: Array<{ id: string; type: string; [key: string]: unknown }> = [
    { id: "background", type: "background", paint: { "background-color": theme.bg } },
    {
      id: "water",
      type: "fill",
      source,
      "source-layer": "water",
      filter: polygons,
      paint: { "fill-color": theme.water, "fill-antialias": false },
    },
    {
      id: "waterway",
      type: "line",
      source,
      "source-layer": "waterway",
      filter: lines,
      paint: { "line-color": theme.water, "line-width": zoomWidth(0.5, lineScale) },
    },
    {
      id: "parks",
      type: "fill",
      source,
      "source-layer": "park",
      filter: polygons,
      paint: { "fill-color": theme.parks },
    },
    {
      // Woods and grass read as parks too, as maptoposter's landuse=grass does.
      id: "landcover",
      type: "fill",
      source,
      "source-layer": "landcover",
      filter: ["all", polygons, ["match", ["get", "class"], ["wood", "grass"], true, false]],
      paint: { "fill-color": theme.parks, "fill-opacity": 0.7 },
    },
    ...ROAD_CLASSES.map((road) => ({
      id: road.id,
      type: "line",
      source,
      "source-layer": "transportation",
      filter: [
        "all",
        lines,
        ["match", ["get", "class"], road.classes, true, false],
        ["!=", ["get", "brunnel"], "tunnel"],
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": theme.roads[road.tier],
        "line-width": zoomWidth(road.width, lineScale),
        "line-opacity": theme.roadOpacity,
      },
    })),
  ];
  if (labels) {
    const text = {
      "text-color": theme.text,
      "text-halo-color": theme.bg,
      "text-halo-width": 1.4,
      "text-opacity": 0.85,
    };
    layers.push(
      {
        id: "label-road",
        type: "symbol",
        source,
        "source-layer": "transportation_name",
        minzoom: 12,
        filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary"], true, false],
        layout: {
          "symbol-placement": "line",
          "text-field": ["coalesce", ["get", "name_en"], ["get", "name"]],
          "text-font": ["Noto Sans Regular"],
          "text-size": 10 * lineScale,
          "text-letter-spacing": 0.08,
        },
        paint: text,
      },
      {
        id: "label-place",
        type: "symbol",
        source,
        "source-layer": "place",
        filter: ["match", ["get", "class"], ["city", "town"], true, false],
        layout: {
          "text-field": ["upcase", ["coalesce", ["get", "name_en"], ["get", "name"]]],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["match", ["get", "class"], "city", 12 * lineScale, 10 * lineScale],
          "text-letter-spacing": 0.25,
          "text-max-width": 8,
        },
        paint: text,
      },
    );
  }
  return {
    version: 8,
    name: `WindChaser ${theme.name}`,
    ...(labels ? { glyphs: OPENFREEMAP_GLYPHS } : {}),
    sources: {
      [source]: { type: "vector", url: OPENFREEMAP_TILEJSON, attribution: OPENFREEMAP_ATTRIBUTION },
    },
    layers: layers as LayerSpecification[],
  };
}

/**
 * The heat line: faint enough that only roads ridden again and again build up
 * to full colour. Widths follow the zoom like the roads, scaled with them.
 */
export function heatPaint(
  color: string,
  [low, high]: [number, number],
  lineScale = 1,
): Paint {
  return {
    "line-color": color,
    "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, low, 13, high],
    "line-width": [
      "interpolate",
      ["linear"],
      ["zoom"],
      8,
      Math.round(1.1 * lineScale * 100) / 100,
      14,
      Math.round(2.6 * lineScale * 100) / 100,
    ],
  };
}

/** The standard basemap's heat: a light basemap needs a little more to register. */
export const STANDARD_HEAT_OPACITY = {
  light: [0.22, 0.4] as [number, number],
  dark: [0.16, 0.3] as [number, number],
};
