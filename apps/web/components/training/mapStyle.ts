import { setWorkerUrl } from "maplibre-gl";

import type { Theme } from "@/components/ThemeToggle";

/**
 * Basemaps shared by Training's maps, the same CARTO styles the wind map uses:
 * MapLibre-native vector tiles with no API key, dark-matter and positron to
 * match the two themes.
 */
export const BASEMAPS: Record<Theme, string> = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
};

// MapLibre parses tiles in a Web Worker the bundler cannot resolve from the
// package, so it is served from /public (see scripts-sync-maplibre.mjs and the
// note in components/SegmentMap.tsx). Idempotent; whichever map loads first
// sets it.
if (typeof window !== "undefined") setWorkerUrl("/maplibre-gl-worker.mjs");
