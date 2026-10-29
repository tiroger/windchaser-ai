import { MapLibreMap, type MapOptions } from "maplibre-gl";

import {
  fitTitleSize,
  posterLayout,
  titleText,
  trackedWidth,
  type PosterSize,
} from "@/lib/training/poster/layout";

import "./mapStyle";

type LineFeatures = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: { type: "LineString"; coordinates: number[][] };
  }>;
};

/** The largest canvas side WebGL can draw here, or 4096 when it cannot say. */
export function gpuLimit(): number {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return 4096;
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const limit = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, dims[0], dims[1]);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return limit || 4096;
  } catch {
    return 4096;
  }
}

/**
 * Draws the heatmap again on a map nobody sees, at poster size: the same
 * style, routes and heat, framed to contain the view the rider had. Resolves
 * once every tile and glyph has drawn, with a copy of the pixels; the map
 * itself is always removed, on success, failure or abort.
 */
export async function renderPosterMap({
  style,
  routes,
  heat,
  bounds,
  size,
  signal,
  timeoutMs = 60000,
}: {
  style: MapOptions["style"];
  routes: LineFeatures;
  heat: Record<string, unknown>;
  bounds: [number, number, number, number];
  size: PosterSize;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ canvas: HTMLCanvasElement; bounds: [number, number, number, number]; center: [number, number] }> {
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  Object.assign(holder.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${size.cssWidth}px`,
    height: `${size.cssHeight}px`,
    pointerEvents: "none",
  });
  document.body.appendChild(holder);
  let map: MapLibreMap | null = null;
  try {
    map = new MapLibreMap({
      container: holder,
      style,
      bounds,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: size.pixelRatio,
      maxCanvasSize: [Math.ceil(size.width), Math.ceil(size.height)],
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    const instance = map;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The map took too long to draw")), timeoutMs);
      const fail = (message: string) => {
        clearTimeout(timer);
        reject(new Error(message));
      };
      signal?.addEventListener("abort", () => fail("Cancelled"), { once: true });
      instance.once("load", () => {
        // Framed again once the container's real size is known: the frame
        // contains the view the rider had, so a wide view sets the width.
        instance.resize();
        instance.fitBounds(bounds, { padding: 0, duration: 0 });
        instance.addSource("routes", { type: "geojson", data: routes as never });
        instance.addLayer({
          id: "routes",
          type: "line",
          source: "routes",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: heat as never,
        });
        instance.once("idle", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    });
    await document.fonts.ready;
    const source = instance.getCanvas();
    const copy = document.createElement("canvas");
    copy.width = Math.round(size.width);
    copy.height = Math.round(size.height);
    copy.getContext("2d")!.drawImage(source, 0, 0, copy.width, copy.height);
    const frame = instance.getBounds();
    const center = instance.getCenter();
    return {
      canvas: copy,
      bounds: [frame.getWest(), frame.getSouth(), frame.getEast(), frame.getNorth()],
      center: [center.lng, center.lat],
    };
  } finally {
    map?.remove();
    holder.remove();
  }
}

export type PosterInk = { bg: string; text: string; gradient: string };

/** The site's fonts by name, as the canvas needs them. */
export function siteFonts(): { sans: string; mono: string } {
  const style = getComputedStyle(document.documentElement);
  const sans = style.getPropertyValue("--font-sans").trim();
  const mono = style.getPropertyValue("--font-mono").trim();
  return {
    sans: `${sans ? `${sans}, ` : ""}ui-sans-serif, system-ui, sans-serif`,
    mono: `${mono ? `${mono}, ` : ""}ui-monospace, monospace`,
  };
}

/** Waits for the weights the poster draws with, so the first export is not a fallback face. */
export async function loadPosterFonts(fonts: { sans: string; mono: string }): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`700 64px ${fonts.sans}`),
      document.fonts.load(`300 64px ${fonts.sans}`),
      document.fonts.load(`400 64px ${fonts.mono}`),
    ]);
  } catch {
    // A face that cannot load falls back to the system's.
  }
  await document.fonts.ready;
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Draws text centred on `x` with extra space between its characters. */
function drawTracked(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number) {
  const chars = Array.from(text);
  const size = parseFloat(ctx.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "16");
  const widths = chars.map((char) => ctx.measureText(char).width);
  let cursor = x - trackedWidth(widths, size, tracking) / 2;
  ctx.textAlign = "left";
  chars.forEach((char, index) => {
    ctx.fillText(char, cursor, y);
    cursor += widths[index] + size * tracking;
  });
}

/**
 * The poster, composed in maptoposter's order over the map: fades top and
 * bottom into the ground colour, then the letter-spaced title, a short rule,
 * the subtitle, the coordinates, and the map credit in the corner.
 */
export function composePoster(
  target: HTMLCanvasElement,
  map: CanvasImageSource,
  {
    ink,
    title,
    subtitle,
    coords,
    credit,
    fonts,
  }: {
    ink: PosterInk;
    title: string;
    subtitle: string;
    coords: string;
    credit: string;
    fonts: { sans: string; mono: string };
  },
): void {
  const { width, height } = target;
  const layout = posterLayout(width, height);
  const ctx = target.getContext("2d")!;
  ctx.fillStyle = ink.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(map, 0, 0, width, height);

  for (const [from, to, solidAt] of [
    [layout.fades.top[0], layout.fades.top[1], "start"],
    [layout.fades.bottom[0], layout.fades.bottom[1], "end"],
  ] as const) {
    const fade = ctx.createLinearGradient(0, from, 0, to);
    fade.addColorStop(0, withAlpha(ink.gradient, solidAt === "start" ? 1 : 0));
    fade.addColorStop(1, withAlpha(ink.gradient, solidAt === "start" ? 0 : 1));
    ctx.fillStyle = fade;
    ctx.fillRect(0, from, width, to - from);
  }

  ctx.fillStyle = ink.text;
  ctx.textBaseline = "alphabetic";
  const heading = titleText(title);
  if (heading.text) {
    const tracking = heading.tracking ? layout.title.tracking : 0;
    const measure = (size: number) => {
      ctx.font = `700 ${size}px ${fonts.sans}`;
      return trackedWidth(Array.from(heading.text).map((char) => ctx.measureText(char).width), size, tracking);
    };
    const size = fitTitleSize(measure, layout.title);
    ctx.font = `700 ${size}px ${fonts.sans}`;
    drawTracked(ctx, heading.text, width / 2, layout.title.y, tracking);
  }

  ctx.fillRect(
    layout.divider.x1,
    layout.divider.y - layout.divider.thickness / 2,
    layout.divider.x2 - layout.divider.x1,
    layout.divider.thickness,
  );

  ctx.font = `300 ${layout.subtitle.size}px ${fonts.sans}`;
  drawTracked(ctx, subtitle, width / 2, layout.subtitle.y, layout.subtitle.tracking);

  ctx.globalAlpha = 0.7;
  ctx.font = `400 ${layout.coords.size}px ${fonts.mono}`;
  ctx.textAlign = "center";
  ctx.fillText(coords, width / 2, layout.coords.y);

  ctx.globalAlpha = 0.6;
  ctx.font = `400 ${layout.attribution.size}px ${fonts.sans}`;
  ctx.textAlign = "right";
  ctx.fillText(credit, layout.attribution.x, layout.attribution.y);
  ctx.globalAlpha = 1;
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image could not be encoded"))), "image/png"),
  );
}
