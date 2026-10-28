"use client";

import { LngLatBounds, MapLibreMap, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef } from "react";

import { alpha } from "@/lib/training/color";
import { decodePolyline } from "@/lib/training/polyline";

import { useChartPalette } from "./Chart";
import { BASEMAPS } from "./mapStyle";

export type MapRoute = { id: string; polyline: string };

type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { id: string };
    geometry: { type: "LineString"; coordinates: number[][] };
  }>;
};

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Bounds covering the routes, or for a heatmap only those starting within
 * ~150 km of the median start, so a few rides abroad don't zoom out to the world.
 */
function toGeoJson(
  routes: MapRoute[],
  focusOnHome: boolean,
): { data: FeatureCollection; bounds: LngLatBounds | null } {
  let bounds: LngLatBounds | null = null;
  const lines = routes.map((route) => ({
    route,
    coordinates: decodePolyline(route.polyline).map(([lat, lng]) => [lng, lat]),
  }));
  const starts = lines
    .filter((line) => line.coordinates.length)
    .map((line) => line.coordinates[0]);
  const center =
    focusOnHome && starts.length > 2
      ? [median(starts.map(([lng]) => lng)), median(starts.map(([, lat]) => lat))]
      : null;
  const features = lines.flatMap(({ route, coordinates }) => {
    if (coordinates.length < 2) return [];
    const [lng0, lat0] = coordinates[0];
    const nearby =
      !center || (Math.abs(lng0 - center[0]) < 1.8 && Math.abs(lat0 - center[1]) < 1.4);
    if (nearby) {
      for (const [lng, lat] of coordinates) {
        bounds = bounds ? bounds.extend([lng, lat]) : new LngLatBounds([lng, lat], [lng, lat]);
      }
    }
    return [
      {
        type: "Feature" as const,
        properties: { id: route.id },
        geometry: { type: "LineString" as const, coordinates },
      },
    ];
  });
  return { data: { type: "FeatureCollection", features }, bounds };
}

/**
 * One route drawn boldly, or many drawn faintly so that overlapping rides
 * build into a heatmap. Route ends arrive already trimmed for privacy.
 *
 * A theme change rebuilds the map on the other basemap rather than swapping
 * the style in place: the layers, colours and framing all depend on it, and a
 * rebuild re-derives them from one path instead of two.
 */
export default function RouteMap({
  routes,
  variant,
  onSelect,
  height = 420,
}: {
  routes: MapRoute[];
  variant: "route" | "heat";
  onSelect?: (id: string) => void;
  height?: number;
}) {
  const palette = useChartPalette();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  const geo = useMemo(() => toGeoJson(routes, variant === "heat"), [routes, variant]);
  const geoRef = useRef(geo);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!container.current) return;
    const holder = container.current;
    const instance = new MapLibreMap({
      container: holder,
      style: BASEMAPS[palette.theme],
      center: [-122.27, 37.8],
      zoom: 9,
      attributionControl: { compact: true },
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.current = instance;
    // The container is often measured before layout settles, and changes with
    // the viewport; without this the canvas keeps its first, wrong size.
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(holder);
    const heat = variant === "heat";
    const light = palette.theme === "light";

    instance.on("error", (event) => {
      console.error("[training map]", event.error?.message ?? event);
    });

    instance.on("load", () => {
      instance.addSource("routes", { type: "geojson", data: geoRef.current.data });
      if (!heat) {
        instance.addLayer({
          id: "route-casing",
          type: "line",
          source: "routes",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": palette.accent, "line-opacity": 0.25, "line-width": 9 },
        });
      }
      instance.addLayer({
        id: "routes",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: heat
          ? {
              "line-color": palette.accent,
              // Overlap is the signal, so each line stays faint; a light
              // basemap needs a little more to register at all.
              "line-opacity": [
                "interpolate",
                ["linear"],
                ["zoom"],
                8,
                light ? 0.22 : 0.16,
                13,
                light ? 0.4 : 0.3,
              ],
              "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.1, 14, 2.6],
            }
          : { "line-color": palette.accent, "line-width": 3.4 },
      });
      if (heat) {
        // A wider invisible layer makes thin lines easy to click.
        instance.addLayer({
          id: "routes-hit",
          type: "line",
          source: "routes",
          paint: { "line-color": alpha(palette.ink, 0), "line-opacity": 0, "line-width": 10 },
        });
        instance.on("click", "routes-hit", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onSelectRef.current?.(id);
        });
        instance.on("mouseenter", "routes-hit", () => {
          instance.getCanvas().style.cursor = "pointer";
        });
        instance.on("mouseleave", "routes-hit", () => {
          instance.getCanvas().style.cursor = "";
        });
      }
      if (geoRef.current.bounds) {
        instance.fitBounds(geoRef.current.bounds, { padding: 36, duration: 0, maxZoom: 14 });
      }
      holder.setAttribute("data-map-ready", "true");
    });

    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
    };
  }, [variant, palette]);

  useEffect(() => {
    geoRef.current = geo;
    const instance = map.current;
    const source = instance?.getSource("routes") as GeoJSONSource | undefined;
    if (!instance || !source) return;
    source.setData(geo.data);
    if (geo.bounds) instance.fitBounds(geo.bounds, { padding: 36, duration: 400, maxZoom: 14 });
  }, [geo]);

  return <div ref={container} className="t-map" style={{ height }} />;
}
