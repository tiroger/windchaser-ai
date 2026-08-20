"use client";

import {
  GeoJSONSource,
  LngLatBounds,
  type MapLayerMouseEvent,
  MapLibreMap,
  type MapMouseEvent,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";

import WindCanvas from "@/components/WindCanvas";
import { compassLabel, formatDuration } from "@/lib/geo";
import type { Theme } from "@/components/ThemeToggle";
import type { Evaluation, LatLon, Segment } from "@/lib/types";

/** CARTO basemaps: MapLibre-native vector tiles, no API key required. */
const STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
} as const;

/** Line colours per theme, matching the validated token palette. */
const RAMP = {
  dark: { open: "#1FAE72", mid: "#3B87CC", low: "#3E5F7E", gated: "#6B727C" },
  light: { open: "#128857", mid: "#2F6FA9", low: "#7C93A8", gated: "#A8ADB5" },
} as const;

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
  /** null clears the selection and returns the map to the whole region. */
  onSelect: (id: number | null) => void;
  here: LatLon | null;
  wind: { speed: number; fromDeg: number; gust?: number } | null;
  theme: Theme;
}

function scoreColor(score: number, gated: boolean, theme: Theme): string {
  const ramp = RAMP[theme];
  if (gated) return ramp.gated;
  if (score >= 0.62) return ramp.open;
  if (score >= 0.42) return ramp.mid;
  return ramp.low;
}

export default function SegmentMap({
  segments,
  evaluations,
  selectedId,
  onSelect,
  here,
  wind,
  theme,
}: Props) {
  const holder = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  // The ref above is read inside callbacks; this mirrors it as state so the
  // framing effect below re-runs once the layers actually exist. A selection
  // made before the map finished loading would otherwise never be framed.
  const [mapReady, setMapReady] = useState(false);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);
  // The load handler fires after data has usually arrived, so it must read the
  // latest features rather than the empty set captured when the map was built.
  const geojsonRef = useRef<GeoJson | null>(null);
  const themeRef = useRef<Theme>(theme);

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
            colour: scoreColor(ev?.score ?? 0, gated, theme),
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
  }, [segments, evaluations, selectedId, theme]);

  // Create the map once.
  useEffect(() => {
    if (!holder.current || map.current) return;
    const instance = new MapLibreMap({
      container: holder.current,
      style: STYLES[themeRef.current],
      center: [-73.9, 41],
      zoom: 10,
      attributionControl: { compact: true },
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.current = instance;

    instance.on("error", (e) => {
      console.error("[map]", e.error?.message ?? e);
    });

    const addLayers = () => {
      if (instance.getSource("segments")) return;
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
              `<span style="font-family:var(--font-mono),monospace;font-size:11px;color:var(--ink-2)">` +
              `${p.predicted} predicted · PR ${p.pr}</span>`,
          )
          .addTo(instance);
      });
      instance.on("mouseleave", "segments-line", () => {
        instance.getCanvas().style.cursor = "";
        popup.remove();
      });
      // One handler for the whole map rather than one bound to the line layer.
      // The halo is several times wider than the line it surrounds, so hit
      // testing against the line alone made clicks that plainly landed on a
      // segment read as clicks on empty map -- which, now that empty map
      // clears the selection, would have thrown the rider's choice away.
      instance.on("click", (e: MapMouseEvent) => {
        const hit = instance.queryRenderedFeatures(e.point, {
          layers: ["segments-line", "segments-halo"],
        })[0];
        const id = hit?.properties?.id;
        onSelectRef.current(id === undefined ? null : Number(id));
      });

      ready.current = true;
      setMapReady(true);
      // Signals to tests that style and layers are live, and how many segment
      // features the source is actually carrying. The theme toggle replaces the
      // whole style, so this is what proves the layers came back.
      holder.current?.setAttribute("data-map-ready", "true");
      holder.current?.setAttribute(
        "data-map-segments",
        String((geojsonRef.current ?? geojson).features.length),
      );
    };

    instance.on("load", () => {
      addLayers();
      fitTo(instance, geojsonRef.current ?? geojson);
    });

    // setStyle replaces the whole style, taking our layers with it.
    instance.on("styledata", () => {
      if (instance.isStyleLoaded()) addLayers();
    });

    return () => {
      instance.remove();
      map.current = null;
      ready.current = false;
    };
    // Intentionally created once; data updates flow through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the basemap when the theme changes; layers are re-added on styledata.
  useEffect(() => {
    themeRef.current = theme;
    const instance = map.current;
    if (!instance || !ready.current) return;
    instance.setStyle(STYLES[theme]);
  }, [theme]);

  // Push data updates.
  useEffect(() => {
    geojsonRef.current = geojson;
    const instance = map.current;
    if (!instance || !ready.current) return;
    const source = instance.getSource("segments") as GeoJSONSource | undefined;
    if (source) {
      source.setData(geojson);
      holder.current?.setAttribute(
        "data-map-segments",
        String(geojson.features.length),
      );
    }
  }, [geojson]);

  // Refit when the visible set changes region.
  const boundsKey = segments.map((s) => s.id).join(",");
  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    fitTo(instance, geojsonRef.current ?? geojson);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey]);

  /**
   * Frame the selected segment.
   *
   * A segment is a kilometre or two of road on a map showing a whole riding
   * region, so selecting one and leaving the camera alone leaves the rider
   * hunting for what they just picked. Deselecting pulls back out to the
   * region, because zooming in without a way back is a trap.
   */
  const framedSelection = useRef<number | null>(null);
  useEffect(() => {
    const instance = map.current;
    const data = geojsonRef.current;
    if (!instance || !mapReady || !data) return;

    if (selectedId === null) {
      // Only pull back out if a segment was actually framed. Otherwise this
      // fires on first load and on every region change, fighting the refit
      // that already covers those.
      if (framedSelection.current !== null) fitTo(instance, data);
    } else {
      const feature = data.features.find((f) => f.id === selectedId);
      // Closer than the regional fit: one segment should fill the frame rather
      // than sit as a short stroke in the middle of it.
      if (feature) fitTo(instance, { features: [feature] }, { maxZoom: 15.5 });
    }
    framedSelection.current = selectedId;
  }, [selectedId, mapReady]);

  // Rider position marker.
  useEffect(() => {
    const instance = map.current;
    if (!instance || !here) return;
    const el = document.createElement("div");
    el.style.cssText =
      "width:12px;height:12px;border-radius:50%;background:var(--accent);" +
      "box-shadow:0 0 0 4px var(--accent-wash);border:2px solid var(--surface)";
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
        <WindCanvas
          speed={wind.speed}
          travelDeg={windTo}
          gust={wind.gust}
          theme={theme}
        />
      )}
      <div className="map-overlay">
        <div className="legend">
          <div className="legend-row">
            <span className="legend-swatch" style={{ background: "var(--data-open)" }} />
            <span>Window open</span>
          </div>
          <div className="legend-row">
            <span className="legend-swatch" style={{ background: "var(--data-wind)" }} />
            <span>Marginal</span>
          </div>
          <div className="legend-row">
            <span className="legend-swatch" style={{ background: "var(--ink-3)" }} />
            <span>Blocked by a gate</span>
          </div>
          {wind && (
            <div className="legend-note">
              Wind {wind.speed.toFixed(1)} m/s from {compassLabel(wind.fromDeg)}
            </div>
          )}
        </div>
        {wind && <Compass fromDeg={wind.fromDeg} />}
        {selectedId !== null && (
          <button
            type="button"
            className="map-reset"
            onClick={() => onSelect(null)}
          >
            Show all segments
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The legend and compass sit over the top-left corner, so geometry framed flush
 * to the edges disappears underneath them. Each side is clamped to a share of
 * the container because fitBounds cannot satisfy padding wider than the space
 * it has to fit into, which a phone-width map reaches easily.
 */
function framePadding(instance: MapLibreMap) {
  const { clientWidth, clientHeight } = instance.getContainer();
  const cap = (want: number, extent: number) =>
    Math.max(16, Math.min(want, Math.round(extent * 0.3)));
  return {
    top: cap(56, clientHeight),
    bottom: cap(56, clientHeight),
    left: cap(200, clientWidth),
    right: cap(72, clientWidth),
  };
}

/** A camera flight is exactly the kind of motion the setting asks us to stop. */
function frameDuration(): number {
  if (typeof window === "undefined") return 0;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700;
}

function fitTo(
  instance: MapLibreMap,
  data: { features: Array<{ geometry: { coordinates: number[][] } }> },
  options: { maxZoom?: number } = {},
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
  instance.fitBounds(bounds, {
    padding: framePadding(instance),
    duration: frameDuration(),
    maxZoom: options.maxZoom ?? 14,
  });
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
            fill="var(--ink-3)"
            fontFamily="var(--font-mono), monospace"
          >
            {label}
          </text>
        ))}
        <g transform={`rotate(${travel})`}>
          <path
            d="M0,-12 L3.6,7 L0,4 L-3.6,7 Z"
            fill="var(--wind)"
          />
        </g>
      </svg>
    </div>
  );
}
