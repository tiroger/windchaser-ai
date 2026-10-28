"use client";

import ReactEChartsCore from "echarts-for-react/lib/core";
import { BarChart, HeatmapChart, LineChart, PieChart, RadarChart } from "echarts/charts";
import {
  AriaComponent,
  CalendarComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  RadarComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsOption } from "echarts";
import { CanvasRenderer } from "echarts/renderers";
import { useMemo } from "react";

import { useTheme, type Theme } from "@/components/ThemeToggle";
import type { ChartPalette } from "@/lib/training/color";

// Only the chart types Training draws; the full ECharts bundle is several
// times larger.
echarts.use([
  AriaComponent,
  BarChart,
  CalendarComponent,
  CanvasRenderer,
  GridComponent,
  HeatmapChart,
  LegendComponent,
  LineChart,
  MarkLineComponent,
  PieChart,
  RadarChart,
  RadarComponent,
  TooltipComponent,
  VisualMapComponent,
]);

const TOKENS: Record<Exclude<keyof ChartPalette, "theme" | "fontSans" | "fontMono">, string> = {
  ground: "--ground",
  surface: "--surface",
  surface2: "--surface-2",
  surface3: "--surface-3",
  line: "--line",
  lineSoft: "--line-soft",
  ink: "--ink",
  ink2: "--ink-2",
  ink3: "--ink-3",
  accent: "--accent",
  effort: "--data-effort",
  open: "--data-open",
  wind: "--data-wind",
  warn: "--warn",
  alert: "--alert",
};

/** What the server renders with: the dark tokens, which are the server's theme. */
const SERVER_PALETTE: ChartPalette = {
  theme: "dark",
  ground: "#0b0d10",
  surface: "#14171c",
  surface2: "#1b1f26",
  surface3: "#232830",
  line: "#242932",
  lineSoft: "#1a1e24",
  ink: "#f2f3f5",
  ink2: "#9da4ae",
  ink3: "#6b727c",
  accent: "#ff7a2f",
  effort: "#de5f18",
  open: "#1fae72",
  wind: "#3b87cc",
  warn: "#e0a22e",
  alert: "#e5646a",
  fontSans: "ui-sans-serif, system-ui, sans-serif",
  fontMono: "ui-monospace, monospace",
};

function readPalette(theme: Theme): ChartPalette {
  if (typeof window === "undefined") return SERVER_PALETTE;
  const style = getComputedStyle(document.documentElement);
  const palette = { ...SERVER_PALETTE, theme };
  for (const [key, token] of Object.entries(TOKENS)) {
    const value = style.getPropertyValue(token).trim();
    if (value) palette[key as keyof typeof TOKENS] = value;
  }
  const sans = style.getPropertyValue("--font-sans").trim();
  const mono = style.getPropertyValue("--font-mono").trim();
  if (sans) palette.fontSans = `${sans}, ui-sans-serif, sans-serif`;
  if (mono) palette.fontMono = `${mono}, ui-monospace, monospace`;
  return palette;
}

/**
 * The current theme's palette. Recomputed when the theme changes; the toggle
 * stamps data-theme before it notifies, so the read sees the new values.
 */
export function useChartPalette(): ChartPalette {
  const [theme] = useTheme();
  return useMemo(() => readPalette(theme), [theme]);
}

/** Axis and legend text: the mono face WindChaser uses for every measured value. */
export function axisText(palette: ChartPalette) {
  return { color: palette.ink3, fontSize: 10, fontFamily: palette.fontMono };
}

/** Tooltips drawn as WindChaser's raised surface. */
export function tooltip(palette: ChartPalette) {
  return {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: palette.ink, fontSize: 12, fontFamily: palette.fontSans },
    extraCssText:
      palette.theme === "dark"
        ? "box-shadow: 0 10px 30px rgb(0 0 0 / 0.35); border-radius: 8px;"
        : "box-shadow: 0 8px 24px rgb(16 18 22 / 0.08); border-radius: 8px;",
  };
}

/** Dashed horizontal rules: present enough to read values against, no more. */
export function splitLine(palette: ChartPalette) {
  return { lineStyle: { color: palette.line, type: "dashed" as const } };
}

export default function Chart({
  option,
  height,
  label,
}: {
  option: EChartsOption;
  height: number;
  label: string;
}) {
  const palette = useChartPalette();
  return (
    <div className="t-chart" role="img" aria-label={label}>
      <ReactEChartsCore
        echarts={echarts}
        option={{
          aria: { enabled: true, label: { description: label } },
          textStyle: { fontFamily: palette.fontSans },
          ...option,
        }}
        style={{ height, width: "100%" }}
        notMerge
        lazyUpdate
        opts={{ renderer: "canvas" }}
      />
    </div>
  );
}
