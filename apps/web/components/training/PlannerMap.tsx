"use client";

import { LngLatBounds, MapLibreMap, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef } from "react";

import type { Theme } from "@/components/ThemeToggle";
import { alpha } from "@/lib/training/color";

import { BASEMAPS } from "./mapStyle";

type Line = {
  type: "Feature";
  properties: { color: string };
  geometry: { type: "LineString"; coordinates: number[][] };
};
type Lines = { type: "FeatureCollection"; features: Line[] };

/** Runs of visible points sharing a colour, as line features. */
function colouredLines(latlng: Array<[number, number] | null>, colors: string[]): Lines {
  const features: Line[] = [];
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
  latlng.forEach((point, index) => {
    if (!point) {
      flush();
      run = [];
      return;
    }
    const color = colors[index] ?? runColor;
    if (run.length && color !== runColor) {
      flush();
      run = [run[run.length - 1]];
    }
    runColor = color;
    run.push([point[1], point[0]]);
  });
  flush();
  return { type: "FeatureCollection", features };
}

/**
 * The route drawn in whatever colours the planner hands it, one per point:
 * gradient, or the wind each stretch meets in the chosen hour. Recolouring
 * replaces the line's data in place, so picking another hour does not reload
 * the basemap or move the view. Points near home arrive as null.
 */
export default function PlannerMap({
  latlng,
  colors,
  theme,
  ink,
  ground,
  label,
  height = 380,
}: {
  latlng: Array<[number, number] | null>;
  colors: string[];
  theme: Theme;
  ink: string;
  ground: string;
  label: string;
  height?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const lines = useMemo(() => colouredLines(latlng, colors), [latlng, colors]);
  const latest = useRef(lines);

  useEffect(() => {
    latest.current = lines;
    const source = map.current?.getSource("route") as GeoJSONSource | undefined;
    source?.setData(lines);
  }, [lines]);

  useEffect(() => {
    if (!container.current) return;
    const holder = container.current;
    const instance = new MapLibreMap({
      container: holder,
      style: BASEMAPS[theme],
      center: [-122.27, 37.8],
      zoom: 9,
      attributionControl: { compact: true },
      // Scrolling the page past the map must not zoom it.
      scrollZoom: false,
      cooperativeGestures: false,
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.current = instance;
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(holder);

    instance.on("error", (event) => {
      console.error("[planner map]", event.error?.message ?? event);
    });

    instance.on("load", () => {
      instance.addSource("route", { type: "geojson", data: latest.current });
      // The casing separates the colours from the roads underneath: a dark
      // edge on the dark basemap, the ink at low strength on the light one.
      instance.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": theme === "dark" ? ground : alpha(ink, 0.5),
          "line-width": 8,
          "line-opacity": theme === "dark" ? 0.8 : 0.5,
        },
      });
      instance.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 4.5 },
      });
      const visible = latlng.filter((point): point is [number, number] => point !== null);
      if (visible.length) {
        const bounds = visible.reduce(
          (box, [lat, lng]) => box.extend([lng, lat]),
          new LngLatBounds([visible[0][1], visible[0][0]], [visible[0][1], visible[0][0]]),
        );
        instance.fitBounds(bounds, { padding: 32, duration: 0, maxZoom: 14 });
      }
      holder.setAttribute("data-map-ready", "true");
    });

    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
    };
  }, [latlng, theme, ink, ground]);

  return <div ref={container} className="t-map" style={{ height }} role="img" aria-label={label} />;
}
