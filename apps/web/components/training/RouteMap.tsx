"use client";

import { LngLatBounds, MapLibreMap, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";

import { alpha } from "@/lib/training/color";
import { homeFocus, nearFocus as near } from "@/lib/training/heatmap-focus";
import { decodePolyline } from "@/lib/training/polyline";
import { buildPosterStyle, heatPaint, STANDARD_HEAT_OPACITY } from "@/lib/training/poster/style";
import { posterTheme } from "@/lib/training/poster/themes";

import { useChartPalette } from "./Chart";
import { BASEMAPS } from "./mapStyle";

/** `date` (YYYY-MM-DD) lets a heatmap tell recent riding from old. */
export type MapRoute = { id: string; polyline: string; date?: string };

/** Where a heatmap is looking: [lng, lat], and [west, south, east, north]. */
export type MapView = { center: [number, number]; bounds: [number, number, number, number]; zoom: number };

type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { id: string };
    geometry: { type: "LineString"; coordinates: number[][] };
  }>;
};

/**
 * Bounds covering the routes, or for a heatmap only those starting within
 * ~150 km of its focus, so rides elsewhere don't zoom out to the continent.
 * The focus is the rider's position when given and some routes start near it,
 * otherwise where they have ridden most lately.
 */
function toGeoJson(
  routes: MapRoute[],
  focusOnHome: boolean,
  position: number[] | null,
): { data: FeatureCollection; bounds: LngLatBounds | null } {
  let bounds: LngLatBounds | null = null;
  const lines = routes.map((route) => ({
    route,
    coordinates: decodePolyline(route.polyline).map(([lat, lng]) => [lng, lat]),
  }));
  const starts = lines
    .filter((line) => line.coordinates.length)
    .map((line) => ({ date: line.route.date ?? "", start: line.coordinates[0] }));
  const center = !focusOnHome
    ? null
    : position && starts.some(({ start }) => near(start, position))
      ? position
      : homeFocus(starts);
  const framed: number[][] = [];
  const features = lines.flatMap(({ route, coordinates }) => {
    if (coordinates.length < 2) return [];
    if (!center) {
      for (const [lng, lat] of coordinates) {
        bounds = bounds ? bounds.extend([lng, lat]) : new LngLatBounds([lng, lat], [lng, lat]);
      }
    } else if (near(coordinates[0], center)) {
      framed.push(...coordinates);
    }
    return [
      {
        type: "Feature" as const,
        properties: { id: route.id },
        geometry: { type: "LineString" as const, coordinates },
      },
    ];
  });
  if (framed.length) {
    // The middle 96% of the heatmap's points: a handful of long rides away
    // from home would otherwise shrink the roads ridden every week to a speck.
    const [west, east] = spread(framed.map(([lng]) => lng));
    const [south, north] = spread(framed.map(([, lat]) => lat));
    bounds = new LngLatBounds([west, south], [east, north]);
  }
  return { data: { type: "FeatureCollection", features }, bounds };
}

function spread(values: number[]): [number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return [at(0.02), at(0.98)];
}

/**
 * One route drawn boldly, or many drawn faintly so that overlapping rides
 * build into a heatmap. Route ends arrive already trimmed for privacy.
 *
 * A theme change rebuilds the map on the other basemap rather than swapping
 * the style in place: the layers, colours and framing all depend on it, and a
 * rebuild re-derives them from one path instead of two. A rebuild keeps the
 * view the rider had.
 *
 * A heatmap can be drawn on one of the poster themes instead of the site's
 * basemap (`mapTheme`), with the theme's own heat colour.
 */
export default function RouteMap({
  routes,
  variant,
  onSelect,
  onView,
  height = 420,
  mapTheme = "standard",
  labels = false,
}: {
  routes: MapRoute[];
  variant: "route" | "heat";
  onSelect?: (id: string) => void;
  /** Told where the map is looking whenever it settles. */
  onView?: (view: MapView) => void;
  height?: number;
  mapTheme?: string;
  labels?: boolean;
}) {
  const palette = useChartPalette();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const onSelectRef = useRef(onSelect);
  const heatmap = variant === "heat";
  const [position, setPosition] = useState<number[] | null>(null);
  const geo = useMemo(() => toGeoJson(routes, heatmap, position), [routes, heatmap, position]);

  // Frame where the rider is, as the wind view does -- but only when they have
  // already allowed it. A heatmap is no reason to raise a permission prompt.
  useEffect(() => {
    if (!heatmap || !navigator.permissions || !("geolocation" in navigator)) return;
    let cancelled = false;
    navigator.permissions
      .query({ name: "geolocation" })
      .then((status) => {
        if (status.state !== "granted" || cancelled) return;
        navigator.geolocation.getCurrentPosition(
          (pos) => !cancelled && setPosition([pos.coords.longitude, pos.coords.latitude]),
          () => undefined,
          { timeout: 8000, maximumAge: 300000 },
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [heatmap]);
  const geoRef = useRef(geo);
  const onViewRef = useRef(onView);
  /** The last settled view, so a rebuild for a new theme stays where it was. */
  const camera = useRef<{ center: [number, number]; zoom: number } | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelect;
    onViewRef.current = onView;
  }, [onSelect, onView]);

  useEffect(() => {
    if (!container.current) return;
    const holder = container.current;
    const theme = variant === "heat" ? posterTheme(mapTheme) : null;
    const instance = new MapLibreMap({
      container: holder,
      style: theme ? buildPosterStyle(theme, { labels }) : BASEMAPS[palette.theme],
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
        // Overlap is the signal, so each heat line stays faint.
        paint: heat
          ? theme
            ? heatPaint(theme.heat.color, theme.heat.opacity)
            : heatPaint(palette.accent, STANDARD_HEAT_OPACITY[light ? "light" : "dark"])
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
      if (camera.current) {
        instance.jumpTo(camera.current);
      } else if (geoRef.current.bounds) {
        instance.fitBounds(geoRef.current.bounds, { padding: 36, duration: 0, maxZoom: 14 });
      }
      report();
      instance.on("moveend", report);
      holder.setAttribute("data-map-ready", "true");
    });

    function report() {
      const center = instance.getCenter();
      const bounds = instance.getBounds();
      camera.current = { center: [center.lng, center.lat], zoom: instance.getZoom() };
      onViewRef.current?.({
        center: [center.lng, center.lat],
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        zoom: instance.getZoom(),
      });
    }

    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
    };
  }, [variant, palette, mapTheme, labels]);

  useEffect(() => {
    geoRef.current = geo;
    const instance = map.current;
    const source = instance?.getSource("routes") as GeoJSONSource | undefined;
    if (!instance || !source) return;
    source.setData(geo.data);
    if (geo.bounds) instance.fitBounds(geo.bounds, { padding: 36, duration: 400, maxZoom: 14 });
  }, [geo]);

  const ground = variant === "heat" ? posterTheme(mapTheme)?.bg : undefined;
  return (
    <div
      ref={container}
      className="t-map"
      data-map-theme={variant === "heat" ? mapTheme : undefined}
      style={{ height, ...(ground ? { background: ground } : {}) }}
    />
  );
}
