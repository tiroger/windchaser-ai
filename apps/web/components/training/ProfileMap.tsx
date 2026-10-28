"use client";

import {
  LngLatBounds,
  MapLibreMap,
  Marker,
  NavigationControl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef } from "react";

import { alpha } from "@/lib/training/color";
import { gradeColor, type GradeTheme } from "@/lib/training/metrics/route-profile";

import { useChartPalette } from "./Chart";
import { BASEMAPS } from "./mapStyle";

type Feature<G> = { type: "Feature"; properties: Record<string, string | number>; geometry: G };
type LineString = { type: "LineString"; coordinates: number[][] };
type Polygon = { type: "Polygon"; coordinates: number[][][] };
type Collection<G> = { type: "FeatureCollection"; features: Array<Feature<G>> };

const EMPTY: Collection<LineString> = { type: "FeatureCollection", features: [] };
const METERS_PER_DEGREE = 111_320;

/** Runs of visible points sharing a gradient colour, as coloured line features. */
function gradientLines(
  latlng: Array<[number, number] | null>,
  grades: number[],
  theme: GradeTheme,
): Collection<LineString> {
  const features: Array<Feature<LineString>> = [];
  let run: number[][] = [];
  let runColor = "";
  const flush = () => {
    if (run.length > 1) {
      features.push({
        type: "Feature",
        properties: { color: runColor },
        geometry: { type: "LineString", coordinates: run },
      });
    }
  };
  for (let index = 0; index < latlng.length; index++) {
    const point = latlng[index];
    if (!point) {
      flush();
      run = [];
      continue;
    }
    const color = gradeColor(grades[index] ?? 0, theme);
    const coordinate = [point[1], point[0]];
    if (run.length && color !== runColor) {
      flush();
      // Start the next run at the previous point so the line has no gaps.
      run = [run[run.length - 1]];
    }
    runColor = color;
    run.push(coordinate);
  }
  flush();
  return { type: "FeatureCollection", features };
}

function selectionLine(
  latlng: Array<[number, number] | null>,
  selection: [number, number] | null,
): Collection<LineString> {
  if (!selection) return EMPTY;
  const [a, b] = [Math.min(...selection), Math.max(...selection)];
  const coordinates = latlng
    .slice(a, b + 1)
    .flatMap((point) => (point ? [[point[1], point[0]]] : []));
  return coordinates.length > 1
    ? {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }],
      }
    : EMPTY;
}

/**
 * The route as a thin wall whose height is elevation, VeloViewer style: each
 * segment becomes a narrow extruded quad coloured by its gradient. Height is
 * exaggerated so the climbing reads at the scale of the whole route.
 */
function profileWalls(
  latlng: Array<[number, number] | null>,
  altitude: number[],
  grades: number[],
  theme: GradeTheme,
): Collection<Polygon> {
  const visible = latlng.flatMap((point, index) => (point ? [{ point, index }] : []));
  if (visible.length < 2) return { type: "FeatureCollection", features: [] };
  const lats = visible.map(({ point }) => point[0]);
  const lngs = visible.map(({ point }) => point[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180);
  const extent = Math.max(
    (Math.max(...lats) - Math.min(...lats)) * METERS_PER_DEGREE,
    (Math.max(...lngs) - Math.min(...lngs)) * METERS_PER_DEGREE * cos,
    200,
  );
  const heights = visible.map(({ index }) => altitude[index] * 0.3048);
  const low = Math.min(...heights);
  const range = Math.max(Math.max(...heights) - low, 1);
  const scale = (extent * 0.28) / range;
  const halfWidth = Math.max(extent / 900, 2);

  const features: Array<Feature<Polygon>> = [];
  for (let k = 0; k < visible.length - 1; k++) {
    const a = visible[k];
    const b = visible[k + 1];
    if (b.index !== a.index + 1 && b.index - a.index > 3) continue;
    const dx = (b.point[1] - a.point[1]) * cos;
    const dy = b.point[0] - a.point[0];
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    // Perpendicular offset, in degrees, for a wall a few metres thick.
    const offLat = (dx / length) * (halfWidth / METERS_PER_DEGREE);
    const offLng = ((-dy / length) * (halfWidth / METERS_PER_DEGREE)) / cos;
    const ring = [
      [a.point[1] - offLng, a.point[0] - offLat],
      [b.point[1] - offLng, b.point[0] - offLat],
      [b.point[1] + offLng, b.point[0] + offLat],
      [a.point[1] + offLng, a.point[0] + offLat],
      [a.point[1] - offLng, a.point[0] - offLat],
    ];
    features.push({
      type: "Feature",
      properties: {
        color: gradeColor(grades[a.index] ?? 0, theme),
        height: Math.round(((heights[k] + heights[k + 1]) / 2 - low) * scale + extent * 0.01),
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }
  return { type: "FeatureCollection", features };
}

function markerElement(className: string, text = ""): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return element;
}

type Casing = { casing: string; casingOpacity: number; highlight: string };

/**
 * The line under the gradient colours. On the dark basemap a near-black casing
 * separates the hues from the roads; on positron the same job is done by the
 * ink at lower strength, which also gives the pale bands an edge to read by.
 */
function casingFor(theme: GradeTheme, ink: string, ground: string): Casing {
  return theme === "dark"
    ? { casing: ground, casingOpacity: 0.75, highlight: alpha(ink, 0.35) }
    : { casing: ink, casingOpacity: 0.45, highlight: alpha(ink, 0.22) };
}

/**
 * A route coloured by gradient with distance markers and a cursor that follows
 * the elevation profile; in 3D the elevation rises as a wall along the path.
 * Points near home arrive as null and are not drawn.
 */
export default function ProfileMap({
  latlng,
  distance,
  altitude,
  grades,
  hoverIndex,
  selection,
  mode = "2d",
  spinning = false,
  height = 460,
}: {
  latlng: Array<[number, number] | null>;
  distance: number[];
  altitude: number[];
  grades: number[];
  hoverIndex: number | null;
  selection: [number, number] | null;
  mode?: "2d" | "3d";
  spinning?: boolean;
  height?: number;
}) {
  const palette = useChartPalette();
  const theme = palette.theme;
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const cursor = useRef<Marker | null>(null);
  const lines = useMemo(() => gradientLines(latlng, grades, theme), [latlng, grades, theme]);
  const walls = useMemo(
    () => profileWalls(latlng, altitude, grades, theme),
    [latlng, altitude, grades, theme],
  );
  const casing = useMemo(
    () => casingFor(theme, palette.ink, palette.ground),
    [theme, palette.ink, palette.ground],
  );
  const selected = useMemo(() => selectionLine(latlng, selection), [latlng, selection]);
  const initial = useRef({ selected, mode });

  useEffect(() => {
    initial.current = { selected, mode };
  }, [selected, mode]);

  useEffect(() => {
    if (!container.current) return;
    const holder = container.current;
    const instance = new MapLibreMap({
      container: holder,
      style: BASEMAPS[theme],
      center: [-122.27, 37.8],
      zoom: 9,
      maxPitch: 75,
      attributionControl: { compact: true },
    });
    instance.addControl(new NavigationControl({ visualizePitch: true }), "top-right");
    map.current = instance;
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(holder);
    const markers: Marker[] = [];

    instance.on("error", (event) => {
      console.error("[training map]", event.error?.message ?? event);
    });

    instance.on("load", () => {
      instance.addSource("route", { type: "geojson", data: lines });
      instance.addSource("selection", { type: "geojson", data: initial.current.selected });
      instance.addSource("walls", { type: "geojson", data: walls });
      instance.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": casing.casing,
          "line-width": 8,
          "line-opacity": casing.casingOpacity,
        },
      });
      instance.addLayer({
        id: "selection",
        type: "line",
        source: "selection",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": casing.highlight, "line-width": 13, "line-opacity": 1 },
      });
      instance.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 4.2 },
      });
      instance.addLayer({
        id: "walls",
        type: "fill-extrusion",
        source: "walls",
        layout: { visibility: "none" },
        paint: {
          "fill-extrusion-color": ["get", "color"],
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.92,
        },
      });

      const total = distance[distance.length - 1] ?? 0;
      const step = total > 60 ? 10 : total > 25 ? 5 : total > 8 ? 2 : 1;
      for (let mile = step, index = 0; mile < total; mile += step) {
        while (index < distance.length - 1 && distance[index] < mile) index++;
        const point = latlng[index];
        if (!point) continue;
        markers.push(
          new Marker({ element: markerElement("t-mile-marker", String(mile)) })
            .setLngLat([point[1], point[0]])
            .addTo(instance),
        );
      }

      const visible = latlng.filter((point): point is [number, number] => point !== null);
      if (visible.length) {
        const bounds = visible.reduce(
          (box, [lat, lng]) => box.extend([lng, lat]),
          new LngLatBounds([visible[0][1], visible[0][0]], [visible[0][1], visible[0][0]]),
        );
        instance.fitBounds(bounds, { padding: 40, duration: 0, maxZoom: 15 });
      }
      applyMode(instance, initial.current.mode, false, casing);
      holder.setAttribute("data-map-ready", "true");
    });

    return () => {
      resize.disconnect();
      markers.forEach((marker) => marker.remove());
      cursor.current?.remove();
      cursor.current = null;
      instance.remove();
      map.current = null;
    };
    // The map is rebuilt per route and per theme; mode, hover and selection
    // update it in place.
  }, [lines, walls, latlng, distance, theme, casing]);

  useEffect(() => {
    const instance = map.current;
    if (instance?.isStyleLoaded() && instance.getLayer("walls")) {
      applyMode(instance, mode, true, casing);
    }
  }, [mode, casing]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !spinning) return;
    let frame = 0;
    const turn = () => {
      instance.setBearing(instance.getBearing() + 0.18);
      frame = requestAnimationFrame(turn);
    };
    frame = requestAnimationFrame(turn);
    return () => cancelAnimationFrame(frame);
  }, [spinning]);

  useEffect(() => {
    const source = map.current?.getSource("selection") as GeoJSONSource | undefined;
    source?.setData(selected);
  }, [selected]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const point = hoverIndex === null ? null : latlng[hoverIndex];
    if (!point) {
      cursor.current?.remove();
      cursor.current = null;
      return;
    }
    if (!cursor.current) cursor.current = new Marker({ element: markerElement("t-route-cursor") });
    cursor.current.setLngLat([point[1], point[0]]).addTo(instance);
  }, [hoverIndex, latlng]);

  return <div ref={container} className="t-map" style={{ height }} />;
}

function applyMode(instance: MapLibreMap, mode: "2d" | "3d", animate: boolean, casing: Casing) {
  const three = mode === "3d";
  instance.setLayoutProperty("walls", "visibility", three ? "visible" : "none");
  // In 3D the flat line would fight the wall above it, so it fades to a trace.
  instance.setPaintProperty("route", "line-opacity", three ? 0.35 : 1);
  instance.setPaintProperty("route-casing", "line-opacity", three ? 0.15 : casing.casingOpacity);
  instance.setPaintProperty("selection", "line-opacity", three ? 0.4 : 1);
  const camera = { pitch: three ? 62 : 0, bearing: three ? -25 : 0 };
  if (animate) instance.easeTo({ ...camera, duration: 900 });
  else instance.jumpTo(camera);
}
