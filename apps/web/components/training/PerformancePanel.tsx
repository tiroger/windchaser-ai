"use client";

import type { EChartsOption } from "echarts";
import { useState } from "react";

import { formatCalendarDate } from "@/lib/training/activity-types";
import { alpha } from "@/lib/training/color";
import type { CurvePoint, PerformanceSummary } from "@/lib/training/metrics/performance";
import type { Settings } from "@/lib/training/settings";

import Chart, { axisText, splitLine, tooltip, useChartPalette } from "./Chart";
import { useTraining } from "./TrainingProvider";

const WINDOWS = [
  { key: "last28", label: "Last 4 weeks" },
  { key: "last90", label: "Last 90 days" },
  { key: "year", label: "This year" },
  { key: "allTime", label: "All time" },
] as const;

const CURVE_TICKS = [1, 5, 15, 60, 300, 1200, 3600, 14400];
const KEY_DURATIONS: Array<[number, string]> = [
  [5, "5 s"],
  [60, "1 min"],
  [300, "5 min"],
  [1200, "20 min"],
  [3600, "1 hr"],
  [7200, "2 hr"],
];
const PROFILE_LABELS = [
  "15 s sprint",
  "1 min anaerobic",
  "5 min VO2max",
  "20 min threshold",
  "1 hr endurance",
];

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function formLabel(form: number): string {
  if (form > 5) return "Fresh";
  if (form >= -10) return "Neutral";
  if (form >= -30) return "Productive training";
  return "Overreaching risk";
}

/**
 * Fitness from the power and heart-rate data: FTP and its history, fitness,
 * fatigue and form, the power curve, the five-point profile, the settings
 * they depend on, and how each is calculated.
 */
export default function PerformancePanel({
  performance,
  settings,
}: {
  performance: PerformanceSummary;
  settings: Settings;
}) {
  const { admin, saveSettings } = useTraining();
  const palette = useChartPalette();
  const text = axisText(palette);
  const [curveWindow, setCurveWindow] = useState<(typeof WINDOWS)[number]["key"]>("last90");

  const { ftp, weightKg, curves, profile, fitness, coverage, heartRate } = performance;
  const current = fitness[fitness.length - 1];
  const weekAgo = fitness[fitness.length - 8];
  const rawRamp = current && weekAgo ? current.fitness - weekAgo.fitness : null;
  // Rounded before signing, so a flat week reads 0.0 rather than -0.0.
  const ramp = rawRamp === null ? null : Math.round(rawRamp * 10) / 10 || 0;
  const selected = curves[curveWindow];
  const perKg = (watts: number | null | undefined) =>
    watts && weightKg ? `${(watts / weightKg).toFixed(2)} W/kg` : "";

  const curveSeries = (points: CurvePoint[], name: string, color: string, dashed = false) => ({
    name,
    type: "line" as const,
    showSymbol: false,
    smooth: 0.2,
    data: points.map((point) => [point.duration, point.watts]),
    lineStyle: {
      color,
      width: dashed ? 1.3 : 2.6,
      type: dashed ? ("dashed" as const) : ("solid" as const),
    },
    itemStyle: { color },
  });

  const curveOption: EChartsOption = {
    grid: { top: 28, left: 50, right: 18, bottom: 28 },
    legend: { top: 0, right: 0, textStyle: text, itemWidth: 14, itemHeight: 3 },
    tooltip: {
      ...tooltip(palette),
      trigger: "axis",
      formatter: (items) => {
        const list = Array.isArray(items) ? items : [items];
        const duration = (list[0]?.value as number[])?.[0];
        return [
          `<b>${durationLabel(duration)}</b>`,
          ...list.map((item) => {
            const watts = (item.value as number[])[1];
            return `${item.marker} ${item.seriesName}: <b>${watts} W</b> ${perKg(watts)}`;
          }),
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "log",
      logBase: 10,
      min: 1,
      max: 14400,
      axisLabel: {
        ...text,
        customValues: CURVE_TICKS,
        formatter: (value: number) => durationLabel(value),
      },
      axisTick: { customValues: CURVE_TICKS },
      axisLine: { lineStyle: { color: palette.line } },
      splitLine: { show: true, ...splitLine(palette), customValues: CURVE_TICKS } as never,
    },
    yAxis: {
      type: "value",
      axisLabel: { ...text, formatter: "{value} W" },
      splitLine: splitLine(palette),
    },
    series: [
      ...(curveWindow !== "allTime"
        ? [curveSeries(curves.allTime, "All-time best", palette.ink3, true)]
        : []),
      curveSeries(
        selected,
        WINDOWS.find((entry) => entry.key === curveWindow)!.label,
        palette.accent,
      ),
    ],
  };

  const profileMax = profile.durations.map(
    (_, index) => Math.max(profile.recent[index] ?? 0, profile.previous[index] ?? 0, 1) * 1.15,
  );
  const radarOption: EChartsOption = {
    legend: { bottom: 0, textStyle: text, itemWidth: 12, itemHeight: 3 },
    tooltip: { ...tooltip(palette) },
    radar: {
      radius: "62%",
      center: ["50%", "46%"],
      indicator: PROFILE_LABELS.map((name, index) => ({ name, max: profileMax[index] })),
      axisName: { color: palette.ink2, fontSize: 10, fontFamily: palette.fontSans },
      splitLine: { lineStyle: { color: palette.line } },
      splitArea: { areaStyle: { color: [palette.surface, palette.surface2] } },
      axisLine: { lineStyle: { color: palette.line } },
    },
    series: [
      {
        type: "radar",
        symbolSize: 4,
        data: [
          {
            name: "Previous 12 weeks",
            value: profile.previous.map((value) => value ?? 0),
            lineStyle: { color: palette.wind, width: 1.3 },
            itemStyle: { color: palette.wind },
            areaStyle: { color: alpha(palette.wind, 0.08) },
          },
          {
            name: "Last 4 weeks",
            value: profile.recent.map((value) => value ?? 0),
            lineStyle: { color: palette.accent, width: 2.2 },
            itemStyle: { color: palette.accent },
            areaStyle: { color: alpha(palette.accent, 0.16) },
          },
        ],
      },
    ],
  };

  const fitnessOption: EChartsOption = {
    grid: { top: 30, left: 40, right: 14, bottom: 26 },
    legend: { top: 0, right: 0, textStyle: text, itemWidth: 14, itemHeight: 3 },
    tooltip: {
      ...tooltip(palette),
      trigger: "axis",
      valueFormatter: (value) => Math.round(Number(value)).toString(),
    },
    xAxis: {
      type: "category",
      data: fitness.map((point) => point.date),
      axisLabel: {
        ...text,
        formatter: (value: string) => formatCalendarDate(value, { month: "short" }),
        interval: 30,
      },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.line } },
    },
    yAxis: { type: "value", axisLabel: text, splitLine: splitLine(palette) },
    series: [
      {
        name: "Form",
        type: "bar",
        barWidth: "70%",
        itemStyle: { color: alpha(palette.open, 0.45) },
        data: fitness.map((point) => ({
          value: Math.round(point.form),
          itemStyle: {
            color: point.form >= 0 ? alpha(palette.open, 0.45) : alpha(palette.alert, 0.4),
          },
        })),
      },
      {
        name: "Fitness",
        type: "line",
        showSymbol: false,
        data: fitness.map((point) => point.fitness),
        lineStyle: { color: palette.wind, width: 2.2 },
        itemStyle: { color: palette.wind },
      },
      {
        name: "Fatigue",
        type: "line",
        showSymbol: false,
        data: fitness.map((point) => point.fatigue),
        lineStyle: { color: palette.alert, width: 1.2 },
        itemStyle: { color: palette.alert },
      },
    ],
  };

  const historyOption: EChartsOption = {
    grid: { top: 10, left: 38, right: 8, bottom: 20 },
    tooltip: { ...tooltip(palette), trigger: "axis", valueFormatter: (value) => `${value} W` },
    xAxis: {
      type: "category",
      data: performance.ftpHistory.map((point) => point.date),
      axisLabel: { ...text, formatter: (value: string) => value.slice(0, 4), interval: 51 },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.line } },
    },
    yAxis: {
      type: "value",
      scale: true,
      splitNumber: 3,
      axisLabel: text,
      splitLine: splitLine(palette),
    },
    series: [
      {
        type: "line",
        showSymbol: false,
        step: "end",
        data: performance.ftpHistory.map((point) => point.ftp),
        lineStyle: { color: palette.accent, width: 1.6 },
        itemStyle: { color: palette.accent },
        areaStyle: { color: alpha(palette.accent, 0.08) },
      },
    ],
  };

  return (
    <section className="t-stack">
      <div className="t-grid t-grid-narrow-first">
        <article className="panel">
          <span className="label">Functional threshold power</span>
          {ftp ? (
            <>
              <div className="hero-number t-hero">
                <span className="big">{ftp.ftp}</span>
                <span className="unit">W</span>
                {weightKg && <span className="t-hero-aside num">{(ftp.ftp / weightKg).toFixed(2)} W/kg</span>}
              </div>
              <p className="t-note">
                {ftp.source === "override"
                  ? "Set by you in athlete settings."
                  : `Estimated from the last 90 days${ftp.cp ? ` · critical power ${ftp.cp} W, W′ ${(ftp.wPrime! / 1000).toFixed(1)} kJ` : ""}${ftp.best20 ? ` · best 20 min ${ftp.best20} W` : ""}.`}
              </p>
            </>
          ) : (
            <p className="t-empty">
              No hard efforts with power in the last 90 days yet. Detail data syncs in the
              background.
            </p>
          )}
          {performance.ftpHistory.length > 1 && (
            <Chart option={historyOption} height={110} label="Estimated FTP by week" />
          )}
        </article>

        <article className="panel">
          <span className="label">Fitness · fatigue · form</span>
          {current ? (
            <div className="t-figures">
              <span>
                <strong className="num is-wind">{Math.round(current.fitness)}</strong>
                <small>Fitness (42-day load)</small>
              </span>
              <span>
                <strong className="num is-alert">{Math.round(current.fatigue)}</strong>
                <small>Fatigue (7-day load)</small>
              </span>
              <span>
                <strong className={`num ${current.form >= 0 ? "is-open" : "is-alert"}`}>
                  {Math.round(current.form)}
                </strong>
                <small>Form · {formLabel(current.form)}</small>
              </span>
              {ramp !== null && (
                <span>
                  <strong className="num">
                    {ramp >= 0 ? "+" : ""}
                    {ramp.toFixed(1)}
                  </strong>
                  <small>Fitness ramp, 7 days</small>
                </span>
              )}
            </div>
          ) : (
            <p className="t-empty">No training load yet.</p>
          )}
          {fitness.length > 0 && (
            <Chart
              option={fitnessOption}
              height={210}
              label="Fitness, fatigue and form over the last year"
            />
          )}
        </article>
      </div>

      <div className="t-grid t-grid-wide">
        <article className="panel">
          <div className="t-card-head">
            <div>
              <span className="label">Mean-maximal power</span>
              <h2 className="t-card-title">Power curve</h2>
            </div>
            <div className="chip-row" role="group" aria-label="Power curve window">
              {WINDOWS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className="chip"
                  aria-pressed={curveWindow === entry.key}
                  onClick={() => setCurveWindow(entry.key)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          {selected.length ? (
            <>
              <Chart option={curveOption} height={250} label="Best average power for every duration" />
              <div className="t-key-durations">
                {KEY_DURATIONS.map(([seconds, label]) => {
                  const point = selected.find((entry) => entry.duration === seconds);
                  return (
                    <span key={seconds}>
                      <small>{label}</small>
                      <strong className="num">{point ? `${point.watts} W` : "—"}</strong>
                      <em>{point ? perKg(point.watts) : ""}</em>
                    </span>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="t-empty">No rides with power in this window.</p>
          )}
        </article>

        <article className="panel">
          <span className="label">Five-point power profile</span>
          <h2 className="t-card-title">Last 4 weeks against the 12 before</h2>
          {profile.recent.some(Boolean) || profile.previous.some(Boolean) ? (
            <Chart
              option={radarOption}
              height={280}
              label="Best power at five key durations, recent against previous"
            />
          ) : (
            <p className="t-empty">No recent power data.</p>
          )}
        </article>
      </div>

      <div className="t-grid t-grid-wide">
        <AthleteSettingsCard
          settings={settings}
          observedMaxHr={heartRate.maxHrSource === "observed" ? heartRate.maxHr : null}
          canEdit={admin.authenticated}
          onSave={saveSettings}
        />
        <article className="panel t-method">
          <span className="label">How these are calculated</span>
          <ul>
            <li>
              <b>Detail coverage.</b> {coverage.withStreams} of {coverage.activities} activities
              have second-by-second data, {coverage.withPower} rides with power. Older activities
              backfill a few dozen at a time.
            </li>
            <li>
              <b>Power curve.</b> Your best average power for each duration, from 1 Hz data with
              pauses removed and only full windows counted.
            </li>
            <li>
              <b>FTP.</b> The lower of critical power (a work–time model fitted to your best 3–20
              minute efforts) and 95% of your best 20 minutes, over a trailing 90 days. Each ride is
              scored against the FTP you had at the time.
            </li>
            <li>
              <b>Training load.</b> Rides with power use TSS (an hour at FTP scores 100).
              Activities with heart rate, such as pickleball and runs, use Banister TRIMP
              calibrated against your own rides; anything else assumes an easy effort.
            </li>
            <li>
              <b>Fitness, fatigue, form.</b> 42- and 7-day exponentially weighted averages of daily
              load; form is yesterday’s fitness minus fatigue.
            </li>
            <li>
              <b>Calories.</b> On rides with power, kilojoules of work roughly equal kilocalories
              burned, because the body is about 24% efficient.
            </li>
          </ul>
        </article>
      </div>
    </section>
  );
}

function AthleteSettingsCard({
  settings,
  observedMaxHr,
  canEdit,
  onSave,
}: {
  settings: Settings;
  observedMaxHr: number | null;
  canEdit: boolean;
  onSave: (settings: Settings) => Promise<void>;
}) {
  const athlete = settings.athlete;
  const [draft, setDraft] = useState({
    weightKg: athlete.weightKg?.toString() ?? "",
    restingHr: athlete.restingHr.toString(),
    maxHr: athlete.maxHr?.toString() ?? "",
    ftpOverride: athlete.ftpOverride?.toString() ?? "",
  });
  const [status, setStatus] = useState<{ error?: string; notice?: string }>({});
  const field = (value: string) => (value.trim() === "" ? null : Number(value));

  async function save() {
    setStatus({});
    try {
      await onSave({
        ...settings,
        athlete: {
          weightKg: field(draft.weightKg),
          restingHr: Number(draft.restingHr),
          maxHr: field(draft.maxHr),
          ftpOverride: field(draft.ftpOverride),
        },
      });
      setStatus({ notice: "Saved. Load and zones now use these values." });
    } catch (reason) {
      setStatus({ error: reason instanceof Error ? reason.message : "Could not save settings" });
    }
  }

  const rows: Array<[keyof typeof draft, string, string]> = [
    ["weightKg", "Weight (kg)", "For W/kg"],
    ["restingHr", "Resting heart rate", "For TRIMP"],
    [
      "maxHr",
      "Max heart rate",
      observedMaxHr ? `Blank uses highest recorded, ${observedMaxHr}` : "Blank uses highest recorded",
    ],
    ["ftpOverride", "FTP override (W)", "Blank uses the estimate"],
  ];

  return (
    <article className="panel">
      <span className="label">Athlete settings</span>
      <form
        className="t-settings"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {rows.map(([key, label, help]) => (
          <label key={key}>
            {label}
            <input
              className="t-input"
              inputMode="decimal"
              value={draft[key]}
              disabled={!canEdit}
              onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
            />
            <small>{help}</small>
          </label>
        ))}
        {canEdit ? (
          <button className="t-button" type="submit">
            Save settings
          </button>
        ) : (
          <p className="t-note">Unlock owner mode to change these.</p>
        )}
      </form>
      {status.error && <p className="t-error">{status.error}</p>}
      {status.notice && <p className="t-notice">{status.notice}</p>}
    </article>
  );
}
