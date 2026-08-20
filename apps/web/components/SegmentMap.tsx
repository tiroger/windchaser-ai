"use client";

import {
  GeoJSONSource,
  LngLatBounds,
  type MapLayerMouseEvent,
  MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef } from "react";

import WindCanvas from "@/components/WindCanvas";
import { compassLabel, formatDuration } from "@/lib/geo";
import type { Evaluation, LatLon, Segment } from "@/lib/types";

/** CARTO dark basemap: MapLibre-native vector tiles, no API key required. */
const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/**
 * MapLibre fetches and parses vector tiles inside a Web Worker. Turbopack does
 * not resolve the worker module from the package, and constructs it against the
 * page URL instead, so the worker dies on load and no tile is ever requested --
 * the map renders an empty canvas with no error. Serving the worker from
 * /public and naming it explicitly fixes it. `npm run sync:maplibre-worker`
 * (wired into predev/prebuild) keeps the copy matched to the installed version.
 */
if (typeof window !== "undefined") {
  setWorkerUrl("/maplibre-gl-worker.mjs");
}

type GeoJson = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    id: number;
    properties: Record<string, string | number>;
    geometry: { type: "LineString"; coordinates: number[][] };
  }>;
};

interface Props {
  segments: Segment[];
  evaluations: Map<number, Evaluation>;
  selectedId: number | null;
  onSelect: (id: number) => void;
  here: LatLon | null;
  wind: { speed: number; fromDeg: number; gust?: number } | null;
}

function scoreColor(score: number, gated: boolean): string {
  if (gated) return "#6B7480";
  // Single-hue ramp from muted wind blue up to the open-window green.
  if (score >= 0.62) return "#1FAE72";
  if (score >= 0.45) return "#4FA88C";
  if (score >= 0.28) return "#3B87CC";
  return "#3E5F7E";
}

export default function SegmentMap({
  segments,
  evaluations,
  selectedId,
  onSelect,
  here,
  wind,
}: Props) {
  const holder = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  // The load handler fires after data has usually arrived, so it must read the
  // latest features rather than the empty set captured when the map was built.
  const geojsonRef = useRef<GeoJson | null>(null);

  const geojson = useMemo(() => {
    return {
      type: "FeatureCollection" as const,
      features: segments.map((s) => {
        const ev = evaluations.get(s.id);
        const gated = (ev?.gates.length ?? 0) > 0;
        return {
          type: "Feature" as const,
          id: s.id,
          properties: {
            id: s.id,
            name: s.name,
            score: ev?.score ?? 0,
            colour: scoreColor(ev?.score ?? 0, gated),
            selected: s.id === selectedId ? 1 : 0,
            predicted: ev ? formatDuration(ev.predicted_time_s) : "—",
            pr: s.pr_elapsed_time ? formatDuration(s.pr_elapsed_time) : "no PR",
          },
          geometry: {
            type: "LineString" as const,
            // GeoJSON is [lon, lat]; Strava gives [lat, lon].
            coordinates: s.points.map(([lat, lon]) => [lon, lat]),
          },
        };
      }),
    };
  }, [segments, evaluations, selectedId]);

  // Create the map once.
  useEffect(() => {
    if (!holder.current || map.current) return;
    const instance = new MapLibreMap({
      container: holder.current,
      style: STYLE,
      center: [-73.9, 41],
      zoom: 10,
      attributionControl: { compact: true },
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.current = instance;

    instance.on("error", (e) => {
      console.error("[map]", e.error?.message ?? e);
    });

    instance.on("load", () => {
      instance.addSource("segments", {
        type: "geojson",
        data: geojsonRef.current ?? geojson,
      });

      instance.addLayer({
        id: "segments-halo",
        type: "line",
        source: "segments",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "colour"],
          "line-width": ["case", ["==", ["get", "selected"], 1], 12, 8],
          "line-opacity": 0.18,
          "line-blur": 3,
        },
      });

      instance.addLayer({
        id: "segments-line",
        type: "line",
        source: "segments",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ["get", "colour"],
          "line-width": ["case", ["==", ["get", "selected"], 1], 4.5, 2.5],
          "line-opacity": ["case", ["==", ["get", "selected"], 1], 1, 0.85],
        },
      });

      const popup = new Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 12,
      });

      instance.on("mouseenter", "segments-line", (e: MapLayerMouseEvent) => {
        instance.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string>;
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `<strong style="font-size:13px">${p.name}</strong><br>` +
              `<span style="font-family:var(--font-mono),monospace;font-size:11px;color:#A6AEBA">` +
              `${p.predicted} predicted · PR ${p.pr}</span>`,
          )
          .addTo(instance);
      });
      instance.on("mouseleave", "segments-line", () => {
        instance.getCanvas().style.cursor = "";
        popup.remove();
      });
      instance.on("click", "segments-line", (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (f) onSelectRef.current(Number(f.properties?.id));
      });

      ready.current = true;
      // Signals to tests (and to diagnosis) that style + layers are live.
      holder.current?.setAttribute("data-map-ready", "true");
      fitTo(instance, geojsonRef.current ?? geojson);
    });

    return () => {
      instance.remove();
      map.current = null;
      ready.current = false;
    };
    // Intentionally created once; data updates flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push data updates.
  useEffect(() => {
    geojsonRef.current = geojson;
    const instance = map.current;
    if (!instance || !ready.current) return;
    const source = instance.getSource("segments") as GeoJSONSource | undefined;
    if (source) source.setData(geojson);
  }, [geojson]);

  // Refit when the visible set changes region.
  const boundsKey = segments.map((s) => s.id).join(",");
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    fitTo(instance, geojsonRef.current ?? geojson);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey]);

  // Rider position marker.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !here) return;
    const el = document.createElement("div");
    el.style.cssText =
      "width:12px;height:12px;border-radius:50%;background:#FF7A2F;" +
      "box-shadow:0 0 0 4px rgba(255,122,47,0.25);border:1.5px solid #101317";
    el.setAttribute("aria-label", "Your position");
    const marker = new Marker({ element: el })
      .setLngLat([here[1], here[0]])
      .addTo(instance);
    return () => {
      marker.remove();
    };
  }, [here]);

  const windTo = wind ? (wind.fromDeg + 180) % 360 : null;

  return (
    <div className="map-wrap">
      <div ref={holder} style={{ position: "absolute", inset: 0 }} />
      {windTo !== null && wind && (
        <WindCanvas speed={wind.speed} travelDeg={windTo} gust={wind.gust} />
      )}
      <div className="map-overlay">
        <div className="legend">
          <div className="legend-row">
            <span className="legend-swatch" style={{ background: "#1FAE72" }} />
            <span>Window open</span>
          </div>
          <div className="legend-row">
            <span className="legend-swatch" style={{ background: "#3B87CC" }} />
            <span>Marginal</span>
          </div>
          <div className="legend-row">
            <span className="legend-swatch" style={{ background: "#6B7480" }} />
            <span>Blocked by a gate</span>
          </div>
          {wind && (
            <div className="legend-row" style={{ marginTop: "0.5rem", color: "#6B7480" }}>
              Wind {wind.speed.toFixed(1)} m/s from {compassLabel(wind.fromDeg)}
            </div>
          )}
        </div>
        {wind && <Compass fromDeg={wind.fromDeg} />}
      </div>
    </div>
  );
}

function fitTo(
  instance: MapLibreMap,
  data: { features: Array<{ geometry: { coordinates: number[][] } }> },
) {
  const coords = data.features.flatMap((f) => f.geometry.coordinates);
  if (coords.length === 0) return;
  const bounds = coords.reduce(
    (b, c) => b.extend(c as [number, number]),
    new LngLatBounds(
      coords[0] as [number, number],
      coords[0] as [number, number],
    ),
  );
  instance.fitBounds(bounds, { padding: 70, duration: 600, maxZoom: 14 });
}

function Compass({ fromDeg }: { fromDeg: number }) {
  const travel = (fromDeg + 180) % 360;
  return (
    <div className="compass" title={`Wind from ${compassLabel(fromDeg)}`}>
      <svg width="52" height="52" viewBox="-26 -26 52 52" role="img"
           aria-label={`Wind from ${compassLabel(fromDeg)}, blowing toward ${compassLabel(travel)}`}>
        <circle r="22" fill="none" stroke="#2C3441" strokeWidth="1" />
        {["N", "E", "S", "W"].map((label, i) => (
          <text
            key={label}
            x={0}
            y={-17}
            transform={`rotate(${i * 90})`}
            textAnchor="middle"
            fontSize="6.5"
            fill="#6B7480"
            fontFamily="var(--font-mono), monospace"
          >
            {label}
          </text>
        ))}
        <g transform={`rotate(${travel})`}>
          <path
            d="M0,-12 L3.6,7 L0,4 L-3.6,7 Z"
            fill="#58A6E8"
          />
        </g>
      </svg>
    </div>
  );
}
