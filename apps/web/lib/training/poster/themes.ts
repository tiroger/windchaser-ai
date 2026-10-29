/**
 * Poster themes for the heatmap, adapted from maptoposter's theme files.
 *
 * Background, text, gradient, water, park and road colours are maptoposter's
 * (MIT, Copyright (c) 2026 Ankur Gupta; full notice in THIRD_PARTY_NOTICES
 * beside this file). What is ours: the heat line each theme carries, chosen
 * to stand out from that theme's roads, and how strongly the roads are drawn
 * beneath it, since here the roads are the backdrop rather than the subject.
 */

/** Road tiers as maptoposter colours them. */
export const ROAD_TIERS = [
  "motorway",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "default",
] as const;
export type RoadTier = (typeof ROAD_TIERS)[number];

export type PosterTheme = {
  id: string;
  name: string;
  description: string;
  /** The maptoposter theme file the colours come from. */
  source: string;
  /** Whether the background is dark, for the controls drawn over it. */
  dark: boolean;
  bg: string;
  text: string;
  /** The colour the poster's top and bottom fade into. */
  gradient: string;
  water: string;
  parks: string;
  roads: Record<RoadTier, string>;
  /** Roads sit under the routes; below 1 they recede so the heat reads. */
  roadOpacity: number;
  heat: {
    color: string;
    /** Line opacity at zoom 8 and zoom 13; overlap builds the heat. */
    opacity: [number, number];
  };
};

export const POSTER_THEMES: readonly PosterTheme[] = [
  {
    id: "noir",
    name: "Noir",
    description: "Black ground, white roads, routes in ember orange",
    source: "themes/noir.json",
    dark: true,
    bg: "#000000",
    text: "#FFFFFF",
    gradient: "#000000",
    water: "#0A0A0A",
    parks: "#111111",
    roads: {
      motorway: "#FFFFFF",
      primary: "#E0E0E0",
      secondary: "#B0B0B0",
      tertiary: "#808080",
      residential: "#505050",
      default: "#808080",
    },
    roadOpacity: 0.42,
    heat: { color: "#FF6A2B", opacity: [0.2, 0.38] },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    description: "Drafting blue with pale roads, routes in amber",
    source: "themes/blueprint.json",
    dark: true,
    bg: "#1A3A5C",
    text: "#E8F4FF",
    gradient: "#1A3A5C",
    water: "#0F2840",
    parks: "#1E4570",
    roads: {
      motorway: "#E8F4FF",
      primary: "#C5DCF0",
      secondary: "#9FC5E8",
      tertiary: "#7BAED4",
      residential: "#5A96C0",
      default: "#7BAED4",
    },
    roadOpacity: 0.45,
    heat: { color: "#FFC24D", opacity: [0.22, 0.4] },
  },
  {
    id: "japanese_ink",
    name: "Japanese Ink",
    description: "Ink wash on rice paper, routes in vermilion",
    source: "themes/japanese_ink.json",
    dark: false,
    bg: "#FAF8F5",
    text: "#2C2C2C",
    gradient: "#FAF8F5",
    water: "#E8E4E0",
    parks: "#F0EDE8",
    roads: {
      motorway: "#8B2500",
      primary: "#4A4A4A",
      secondary: "#6A6A6A",
      tertiary: "#909090",
      residential: "#B8B8B8",
      default: "#909090",
    },
    roadOpacity: 0.5,
    heat: { color: "#D13B1F", opacity: [0.24, 0.44] },
  },
  {
    id: "warm_beige",
    name: "Warm Beige",
    description: "Sepia atlas, routes in deep rust",
    source: "themes/warm_beige.json",
    dark: false,
    bg: "#F5F0E8",
    text: "#6B5B4F",
    gradient: "#F5F0E8",
    water: "#DDD5C8",
    parks: "#E8E4D8",
    roads: {
      motorway: "#8B7355",
      primary: "#A08B70",
      secondary: "#B5A48E",
      tertiary: "#C9BBAA",
      residential: "#D9CFC2",
      default: "#C9BBAA",
    },
    roadOpacity: 0.75,
    heat: { color: "#9A3412", opacity: [0.24, 0.44] },
  },
  {
    id: "midnight_blue",
    name: "Midnight Blue",
    description: "Navy and gold, routes in warm light",
    source: "themes/midnight_blue.json",
    dark: true,
    bg: "#0A1628",
    text: "#D4AF37",
    gradient: "#0A1628",
    water: "#061020",
    parks: "#0F2235",
    roads: {
      motorway: "#D4AF37",
      primary: "#C9A227",
      secondary: "#A8893A",
      tertiary: "#8B7355",
      residential: "#6B5B4F",
      default: "#8B7355",
    },
    roadOpacity: 0.4,
    heat: { color: "#FFE7A3", opacity: [0.2, 0.38] },
  },
  {
    id: "terracotta",
    name: "Terracotta",
    description: "Clay and cream, routes in deep teal",
    source: "themes/terracotta.json",
    dark: false,
    bg: "#F5EDE4",
    text: "#8B4513",
    gradient: "#F5EDE4",
    water: "#A8C4C4",
    parks: "#E8E0D0",
    roads: {
      motorway: "#A0522D",
      primary: "#B8653A",
      secondary: "#C9846A",
      tertiary: "#D9A08A",
      residential: "#E5C4B0",
      default: "#D9A08A",
    },
    roadOpacity: 0.7,
    heat: { color: "#145A66", opacity: [0.24, 0.44] },
  },
];

/** "standard" is the site's own CARTO basemap; the rest are poster themes. */
export type MapThemeId = "standard" | (typeof POSTER_THEMES)[number]["id"];
export const STANDARD = "standard";

export const MAP_THEME_OPTIONS: ReadonlyArray<{ id: string; name: string }> = [
  { id: STANDARD, name: "Standard" },
  ...POSTER_THEMES.map(({ id, name }) => ({ id, name })),
];

export function posterTheme(id: string): PosterTheme | null {
  return POSTER_THEMES.find((theme) => theme.id === id) ?? null;
}

export function isMapThemeId(value: unknown): value is MapThemeId {
  return value === STANDARD || POSTER_THEMES.some((theme) => theme.id === value);
}

/**
 * The colours a poster is composed with when the map is the standard CARTO
 * basemap: its background (dark-matter or positron), the site's ink, and the
 * site's accent for the routes.
 */
export function standardInk(siteTheme: "light" | "dark", accent: string) {
  return siteTheme === "dark"
    ? { bg: "#0E0E0E", text: "#F2F3F5", gradient: "#0E0E0E", heat: accent, dark: true }
    : { bg: "#FAFAF8", text: "#16181C", gradient: "#FAFAF8", heat: accent, dark: false };
}
