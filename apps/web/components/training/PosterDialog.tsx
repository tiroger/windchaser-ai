"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import {
  fitToGpu,
  formatCoords,
  frameStats,
  posterFilename,
  posterSize,
  subtitleText,
} from "@/lib/training/poster/layout";
import { posterTitle } from "@/lib/training/poster/place";
import { formatNumber } from "@/lib/training/activity-types";
import { decodePolyline } from "@/lib/training/polyline";
import {
  buildPosterStyle,
  CARTO_CREDIT,
  heatPaint,
  OPENFREEMAP_CREDIT,
  STANDARD_HEAT_OPACITY,
} from "@/lib/training/poster/style";
import { MAP_THEME_OPTIONS, posterTheme, standardInk } from "@/lib/training/poster/themes";

import { useChartPalette } from "./Chart";
import { BASEMAPS } from "./mapStyle";
import {
  canvasBlob,
  composePoster,
  gpuLimit,
  loadPosterFonts,
  renderPosterMap,
  siteFonts,
  type PosterInk,
} from "./poster-render";
import type { MapView } from "./RouteMap";

export type PosterRoute = { id: string; miles: number; polyline: string };

const PREVIEW_WIDTH = 720;
const HEAT_BOOST = 1.25;

type Rendered = {
  map: HTMLCanvasElement;
  center: [number, number];
  routes: number;
  miles: number;
  title: string;
  ms: number;
};

/**
 * "Download poster": the heatmap as it is on screen, redrawn offscreen at
 * print size, composed in maptoposter's manner, previewed, then saved as a
 * PNG. The title starts as the area's name and can be retyped. Nothing on it
 * is more precise than the map: routes arrive with their ends trimmed, and
 * the centre is printed to two decimals.
 */
export default function PosterDialog({
  open,
  onClose,
  mapTheme,
  labels,
  routes,
  year,
  view,
}: {
  open: boolean;
  onClose: () => void;
  mapTheme: string;
  labels: boolean;
  routes: PosterRoute[];
  year: string;
  view: MapView | null;
}) {
  const palette = useChartPalette();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Once the rider types, the derived title no longer replaces theirs. */
  const edited = useRef(false);

  const theme = posterTheme(mapTheme);
  const themeName = MAP_THEME_OPTIONS.find((option) => option.id === mapTheme)?.name ?? "Standard";
  const ink: PosterInk & { heat: string } = useMemo(() => {
    if (theme) return { bg: theme.bg, text: theme.text, gradient: theme.gradient, heat: theme.heat.color };
    return standardInk(palette.theme, palette.accent);
  }, [theme, palette]);
  const credit = theme ? OPENFREEMAP_CREDIT : CARTO_CREDIT;
  const size = useMemo(() => {
    if (typeof window === "undefined") return posterSize(false);
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    const small = window.matchMedia("(max-width: 720px)").matches || memory <= 4;
    return fitToGpu(posterSize(small), gpuLimit());
    // Measured once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      // The title on a desktop, ready to retype; on a touch screen the close
      // button, so the keyboard does not open over the preview.
      const touch = window.matchMedia("(pointer: coarse)").matches;
      (touch ? closeButton : titleInput).current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  // Draw the map once per opening; the title only recomposes the lettering.
  useEffect(() => {
    if (!open || !view) return;
    const controller = new AbortController();
    const lines = routes
      .map((route) => ({
        id: route.id,
        miles: route.miles,
        coordinates: decodePolyline(route.polyline).map(([lat, lng]) => [lng, lat]),
      }))
      .filter((line) => line.coordinates.length > 1);
    const started = performance.now();
    const fonts = siteFonts();
    const name = posterTitle(view.bounds);
    setTitle(name);
    Promise.all([
      renderPosterMap({
        style: theme ? buildPosterStyle(theme, { labels, lineScale: size.lineScale }) : BASEMAPS[palette.theme],
        routes: {
          type: "FeatureCollection",
          features: lines.map((line) => ({
            type: "Feature",
            properties: { id: line.id },
            geometry: { type: "LineString", coordinates: line.coordinates },
          })),
        },
        // Routes a little bolder than on screen: on a print they are the subject.
        heat: theme
          ? heatPaint(theme.heat.color, theme.heat.opacity, size.lineScale * HEAT_BOOST)
          : heatPaint(palette.accent, STANDARD_HEAT_OPACITY[palette.theme], size.lineScale * HEAT_BOOST),
        bounds: view.bounds,
        size,
        signal: controller.signal,
      }),
      loadPosterFonts(fonts),
    ])
      .then(([result]) => {
        const stats = frameStats(lines, result.bounds);
        setRendered({
          map: result.canvas,
          center: result.center,
          routes: stats.routes,
          miles: stats.miles,
          title: name,
          ms: Math.round(performance.now() - started),
        });
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        console.error("[heatmap] poster render failed", error);
        setFailed(error.message || "The poster could not be drawn.");
      });
    return () => {
      controller.abort();
      edited.current = false;
      setRendered(null);
      setFailed(null);
      setPreview(null);
      setTitle("");
    };
    // The poster is of the map as it was when the dialog opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Release the full-size pixels as soon as they are replaced or the dialog closes.
  useEffect(
    () => () => {
      if (rendered) rendered.map.width = rendered.map.height = 0;
    },
    [rendered],
  );

  const describe = rendered
    ? `Poster preview, ${themeName} theme, titled “${title.trim() || "untitled"}”: a heatmap of ` +
      `${formatNumber(rendered.routes)} routes and ${formatNumber(rendered.miles)} miles from ` +
      `${year === "all" ? "all years" : year}, centred at ${formatCoords(rendered.center).replace(" / ", ", ")}.`
    : "";
  const subtitle = rendered ? subtitleText({ year, routes: rendered.routes, miles: rendered.miles }) : "";
  const coords = rendered ? formatCoords(rendered.center) : "";

  // A small preview, recomposed as the title is typed.
  useEffect(() => {
    if (!rendered) return;
    let url: string | null = null;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = PREVIEW_WIDTH;
      canvas.height = Math.round((PREVIEW_WIDTH * size.height) / size.width);
      composePoster(canvas, rendered.map, { ink, title, subtitle, coords, credit, fonts: siteFonts() });
      const blob = await canvasBlob(canvas);
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setPreview(url);
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000);
    };
  }, [rendered, title, subtitle, coords, credit, ink, size]);

  const download = async () => {
    if (!rendered) return;
    setSaving(true);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(size.width);
    canvas.height = Math.round(size.height);
    try {
      composePoster(canvas, rendered.map, { ink, title, subtitle, coords, credit, fonts: siteFonts() });
      const blob = await canvasBlob(canvas);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = posterFilename(title || rendered.title, themeName);
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    } catch (error) {
      console.error("[heatmap] poster export failed", error);
      setFailed("The image could not be saved in this browser.");
    } finally {
      canvas.width = canvas.height = 0;
      setSaving(false);
    }
  };

  const status = failed
    ? failed
    : !rendered
      ? "Drawing the map at poster size…"
      : `${Math.round(size.width)} × ${Math.round(size.height)} PNG, ${themeName} theme.`;

  return (
    <dialog
      ref={dialog}
      className="t-poster-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="t-poster-body">
        <div className="t-poster-frame" style={{ background: ink.bg, aspectRatio: `${size.width} / ${size.height}` }}>
          {preview ? (
            // A data preview of a canvas: next/image cannot optimise it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt={describe}
              data-render-ms={rendered?.ms}
            />
          ) : (
            <div className="t-poster-wait" style={{ color: ink.text }} aria-hidden="true">
              {failed ? "No preview" : "Rendering…"}
            </div>
          )}
        </div>
        <div className="t-poster-side">
          <div>
            <span className="label">Heatmap poster</span>
            <h2 id={titleId} className="t-card-title">
              Download poster
            </h2>
          </div>
          <label className="t-select is-block t-poster-title">
            <span>Title</span>
            <input
              ref={titleInput}
              className="t-input"
              value={title}
              onChange={(event) => {
                edited.current = true;
                setTitle(event.target.value);
              }}
              maxLength={40}
              placeholder={rendered ? rendered.title : "Naming the area…"}
            />
          </label>
          <dl className="t-poster-facts">
            <div>
              <dt>Routes in frame</dt>
              <dd>
                {rendered
                  ? `${formatNumber(rendered.routes)} of ${formatNumber(routes.length)}`
                  : "…"}
              </dd>
            </div>
            <div>
              <dt>Subtitle</dt>
              <dd>{subtitle || "…"}</dd>
            </div>
            <div>
              <dt>Centre</dt>
              <dd>{coords || "…"}</dd>
            </div>
          </dl>
          <p className="t-note" role="status">
            {status}
          </p>
          <p className="t-note">
            The poster frames the map as it is now, taller to fit a 3:4 page. Route ends stay hidden,
            and the centre is rounded to about a kilometre.
          </p>
          <div className="t-poster-actions">
            <button type="button" className="t-button" onClick={download} disabled={!rendered || saving}>
              {saving ? "Saving…" : "Download PNG"}
            </button>
            <button ref={closeButton} type="button" className="t-button is-quiet" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
