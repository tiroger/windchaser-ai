"use client";

import type { EChartsOption } from "echarts";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { formatDuration } from "@/lib/geo";
import { formatNumber } from "@/lib/training/activity-types";
import { binByDistance, type LoopRide } from "@/lib/training/loops";
import type { ActivityStream, StreamSamples } from "@/lib/training/metrics/performance";

import Chart, { axisText, splitLine, tooltip, useChartPalette } from "./Chart";
import { ordinal, rideDate } from "./loop-format";

type Channel = {
  key: "altitude" | "velocity" | "watts" | "heartrate";
  label: string;
  unit: string;
  digits: number;
};

const CHANNELS: Channel[] = [
  { key: "altitude", label: "Elevation", unit: "ft", digits: 0 },
  { key: "velocity", label: "Speed", unit: "mph", digits: 1 },
  { key: "watts", label: "Power", unit: "W", digits: 0 },
  { key: "heartrate", label: "Heart rate", unit: "bpm", digits: 0 },
];

/** Bins across the longer ride: fine enough for climbs, coarse enough to calm power. */
const BINS = 160;

function usable(samples: StreamSamples | undefined, key: Channel["key"]): boolean {
  const values = samples?.[key];
  return !!samples?.distance && !!values && values.filter((value) => value !== null).length >= 10;
}

type Loaded =
  { status: "loading" } | { status: "ready"; stream: ActivityStream | null } | { status: "error" };

/**
 * Two rides of one loop side by side: the summary differences, and, where both
 * have second-by-second data, elevation, speed, power and heart rate against
 * distance.
 */
export default function LoopCompare({
  current,
  other,
  others,
  onSelect,
  stream,
}: {
  current: LoopRide;
  other: LoopRide;
  others: LoopRide[];
  onSelect: (id: string) => void;
  stream: ActivityStream | null;
}) {
  const palette = useChartPalette();
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const otherState: Loaded = other.hasStreams
    ? (loaded[other.id] ?? { status: "loading" })
    : { status: "ready", stream: null };

  useEffect(() => {
    if (!other.hasStreams || loaded[other.id]) return;
    let cancelled = false;
    const id = other.id;
    fetch(`/api/training/activities/${encodeURIComponent(id)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return ((await response.json()) as { stream: ActivityStream | null }).stream;
      })
      .then(
        (fetched): Loaded => ({ status: "ready", stream: fetched }),
        (): Loaded => ({ status: "error" }),
      )
      .then((state) => {
        if (!cancelled) setLoaded((all) => ({ ...all, [id]: state }));
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, other.hasStreams, other.id]);

  const otherStream = otherState.status === "ready" ? otherState.stream : null;
  const channels = useMemo(
    () =>
      CHANNELS.filter(
        (channel) =>
          usable(stream?.samples, channel.key) && usable(otherStream?.samples, channel.key),
      ),
    [otherStream, stream],
  );

  const charts = useMemo(() => {
    if (!stream || !otherStream) return [];
    const text = axisText(palette);
    const lastDistance = (samples: StreamSamples) =>
      Math.max(0, ...(samples.distance ?? []).map((value) => value ?? 0));
    const span = Math.max(lastDistance(stream.samples), lastDistance(otherStream.samples));
    const bin = Math.max(0.02, span / BINS);
    return channels.map((channel): [Channel, EChartsOption] => {
      const series = (samples: StreamSamples) =>
        binByDistance(samples.distance, samples[channel.key], bin);
      return [
        channel,
        {
          grid: { top: 10, left: 44, right: 12, bottom: 24 },
          tooltip: {
            ...tooltip(palette),
            trigger: "axis",
            valueFormatter: (value) =>
              value === null || value === undefined
                ? "—"
                : `${formatNumber(Number(value), channel.digits)} ${channel.unit}`,
          },
          xAxis: {
            type: "value",
            max: "dataMax",
            axisLabel: { ...text, formatter: (value: number) => `${value} mi` },
            splitLine: { show: false },
          },
          yAxis: {
            type: "value",
            scale: true,
            axisLabel: text,
            splitLine: splitLine(palette),
          },
          series: [
            {
              name: rideDate(other.date, true),
              type: "line",
              showSymbol: false,
              data: series(otherStream.samples),
              lineStyle: { color: palette.wind, width: 1.5 },
              itemStyle: { color: palette.wind },
            },
            {
              name: "This ride",
              type: "line",
              showSymbol: false,
              data: series(stream.samples),
              lineStyle: { color: palette.accent, width: 2 },
              itemStyle: { color: palette.accent },
            },
          ],
        },
      ];
    });
  }, [channels, other.date, otherStream, palette, stream]);

  const detailNote = !stream
    ? "This ride has no second-by-second data yet, so only the summary is compared."
    : otherState.status === "loading"
      ? null
      : otherState.status === "error"
        ? `The ${rideDate(other.date, true)} ride's detail could not be loaded.`
        : !otherStream
          ? `The ${rideDate(other.date, true)} ride has no second-by-second data yet, so only the summary is compared.`
          : channels.length === 0
            ? "The two rides share no recorded channel to overlay."
            : null;

  return (
    <section className="t-loop-compare-panel" id="loop-compare" aria-label="Compare two rides">
      <div className="t-card-head">
        <div>
          <span className="t-subhead">Compare two rides</span>
          <div className="t-legend t-loop-legend">
            <span>
              <i className="t-loop-line is-current" /> This ride · {rideDate(current.date, true)}
            </span>
            <span>
              <i className="t-loop-line is-other" />{" "}
              <Link href={`/training/activities/${other.id}#loop`}>
                {rideDate(other.date, true)}
              </Link>
              {other.rank &&
                ` · ${other.rank === 1 ? "fastest" : `${ordinal(other.rank)} fastest`}`}
            </span>
          </div>
        </div>
        <label className="t-select">
          <span>Compare with</span>
          <select value={other.id} onChange={(event) => onSelect(event.target.value)}>
            {others.map((ride) => (
              <option key={ride.id} value={ride.id}>
                {rideDate(ride.date, true)}
                {ride.movingSeconds ? ` · ${formatDuration(ride.movingSeconds)}` : ""}
                {ride.rank === 1 ? " · best" : ""}
                {ride.hasStreams ? "" : " · summary only"}
              </option>
            ))}
          </select>
        </label>
      </div>

      <DeltaTable current={current} other={other} />

      {detailNote && <p className="t-note">{detailNote}</p>}
      {otherState.status === "loading" && stream && <p className="t-note">Loading ride detail…</p>}
      {charts.length > 0 && (
        <div className="t-loop-overlays">
          {charts.map(([channel, option]) => (
            <div key={channel.key}>
              <span className="t-subhead">
                {channel.label} <small>({channel.unit})</small>
              </span>
              <Chart
                option={option}
                height={150}
                label={`${channel.label} against distance, this ride and ${rideDate(other.date, true)}`}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

type Row = {
  label: string;
  help?: string;
  current: number | null;
  other: number | null;
  format: (value: number) => string;
  /** Formats the difference, current minus other. */
  delta: (difference: number) => string;
};

function signed(value: number, digits: number, unit: string): string {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return `±0 ${unit}`.trim();
  return `${rounded > 0 ? "+" : "−"}${formatNumber(Math.abs(rounded), digits)} ${unit}`.trim();
}

function powerPerBeat(ride: LoopRide): number | null {
  const watts = ride.normalizedPower ?? ride.averageWatts;
  return watts && ride.averageHeartrate ? watts / ride.averageHeartrate : null;
}

function DeltaTable({ current, other }: { current: LoopRide; other: LoopRide }) {
  const rows: Row[] = [
    {
      label: "Moving time",
      current: current.movingSeconds,
      other: other.movingSeconds,
      format: formatDuration,
      delta: (difference) =>
        Math.round(difference) === 0
          ? "same"
          : `${formatDuration(Math.abs(difference))} ${difference < 0 ? "faster" : "slower"}`,
    },
    {
      label: "Avg speed",
      current: current.averageSpeed,
      other: other.averageSpeed,
      format: (value) => `${formatNumber(value, 1)} mph`,
      delta: (difference) => signed(difference, 1, "mph"),
    },
    {
      label: "Normalized power",
      current: current.normalizedPower,
      other: other.normalizedPower,
      format: (value) => `${Math.round(value)} W`,
      delta: (difference) => signed(difference, 0, "W"),
    },
    {
      label: "Avg heart rate",
      current: current.averageHeartrate,
      other: other.averageHeartrate,
      format: (value) => `${Math.round(value)} bpm`,
      delta: (difference) => signed(difference, 0, "bpm"),
    },
    {
      label: "Power at heart rate",
      help: "Normalized (or average) power per beat; higher means more output for the same effort",
      current: powerPerBeat(current),
      other: powerPerBeat(other),
      format: (value) => `${value.toFixed(2)} W/bpm`,
      delta: (difference) => signed(difference, 2, "W/bpm"),
    },
  ];
  return (
    <div className="t-table-scroll">
      <table className="t-table t-loop-delta">
        <thead>
          <tr>
            <th />
            <th className="is-num">This ride</th>
            <th className="is-num">{rideDate(other.date, true)}</th>
            <th className="is-num">Difference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} title={row.help}>
              <td>{row.label}</td>
              <td className="is-num">{row.current !== null ? row.format(row.current) : "—"}</td>
              <td className="is-num">{row.other !== null ? row.format(row.other) : "—"}</td>
              <td className="is-num t-loop-diff">
                {row.current !== null && row.other !== null
                  ? row.delta(row.current - row.other)
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
