"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

import { useTheme } from "@/components/ThemeToggle";
import { formatNumber } from "@/lib/training/activity-types";
import { findClimbs, GRADE_SCALE, smoothedGrades } from "@/lib/training/metrics/route-profile";

import ElevationProfile from "./ElevationProfile";

const ProfileMap = dynamic(() => import("./ProfileMap"), {
  ssr: false,
  loading: () => <div className="t-map is-loading">Loading map…</div>,
});

export type RouteTrack = {
  /** Miles from the start. */
  distance: number[];
  /** Feet. */
  altitude: number[];
  /** Null where hidden near home or not recorded. */
  latlng: Array<[number, number] | null> | null;
};

/** Grade at every point plus a separate half-mile figure for "steepest". */
export function useTrackAnalysis(track: RouteTrack) {
  const grades = useMemo(() => smoothedGrades(track.distance, track.altitude), [track]);
  const climbs = useMemo(
    () => findClimbs(track.distance, track.altitude, grades),
    [grades, track],
  );
  const steepest = useMemo(
    () => Math.max(...smoothedGrades(track.distance, track.altitude, 0.5)),
    [track],
  );
  return { grades, climbs, steepest };
}

/**
 * Elevation profile, gradient map (2D or VeloViewer-style 3D) and climb
 * breakdown for any track, kept in step: hovering the profile moves a cursor
 * on the map, and dragging or picking a climb highlights it on both.
 */
export default function RouteAnalysis({
  track,
  mapFallback,
}: {
  track: RouteTrack;
  mapFallback?: React.ReactNode;
}) {
  const [theme] = useTheme();
  const { grades, climbs } = useTrackAnalysis(track);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [spinning, setSpinning] = useState(false);
  const hasTrack = !!track.latlng?.some(Boolean);

  return (
    <>
      <article className="panel">
        <div className="t-card-head">
          <div>
            <span className="label">Elevation profile</span>
            <h2 className="t-card-title">Hover to read, drag to measure</h2>
          </div>
          {selection && (
            <button className="t-link" type="button" onClick={() => setSelection(null)}>
              Clear selection
            </button>
          )}
        </div>
        <ElevationProfile
          distance={track.distance}
          altitude={track.altitude}
          grades={grades}
          hoverIndex={hoverIndex}
          onHover={setHoverIndex}
          selection={selection}
          onSelect={setSelection}
        />
        <div className="t-grade-legend" aria-label="Gradient colours">
          {GRADE_SCALE.map((band) => (
            <span key={band.label}>
              <i style={{ background: band[theme] }} />
              {band.label}
            </span>
          ))}
        </div>
      </article>

      <div className="t-grid t-grid-map">
        <article className="panel">
          <div className="t-card-head">
            <div>
              <span className="label">{mode === "3d" ? "3D profile" : "Map"}</span>
              <h2 className="t-card-title">
                {mode === "3d"
                  ? "Right-drag or Ctrl-drag to rotate"
                  : "Coloured by gradient"}
              </h2>
            </div>
            {hasTrack && (
              <div className="chip-row" role="group" aria-label="Map view">
                {(["2d", "3d"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="chip"
                    aria-pressed={mode === value}
                    onClick={() => {
                      setMode(value);
                      if (value === "2d") setSpinning(false);
                    }}
                  >
                    {value.toUpperCase()}
                  </button>
                ))}
                {mode === "3d" && (
                  <button
                    type="button"
                    className="chip"
                    aria-pressed={spinning}
                    onClick={() => setSpinning((value) => !value)}
                  >
                    Spin
                  </button>
                )}
              </div>
            )}
          </div>
          {hasTrack ? (
            <ProfileMap
              latlng={track.latlng!}
              distance={track.distance}
              altitude={track.altitude}
              grades={grades}
              hoverIndex={hoverIndex}
              selection={selection}
              mode={mode}
              spinning={spinning}
            />
          ) : (
            (mapFallback ?? <div className="t-map is-loading">No GPS track for this one.</div>)
          )}
          <p className="t-note">The first and last 500 m are hidden to keep home private.</p>
        </article>
        <article className="panel">
          <span className="label">
            Breakdown · {climbs.length} {climbs.length === 1 ? "climb" : "climbs"}
          </span>
          {climbs.length ? (
            <div className="t-table-scroll">
              <table className="t-table t-climbs">
                <thead>
                  <tr>
                    <th>Climb</th>
                    <th className="is-num">Starts</th>
                    <th className="is-num">Length</th>
                    <th className="is-num">Avg</th>
                    <th className="is-num">Max</th>
                    <th className="is-num">Gain</th>
                  </tr>
                </thead>
                <tbody>
                  {climbs.map((climb, index) => {
                    const chosen =
                      selection?.[0] === climb.startIndex && selection?.[1] === climb.endIndex;
                    return (
                      <tr
                        key={climb.startIndex}
                        className={chosen ? "is-selected" : ""}
                        onClick={() => setSelection([climb.startIndex, climb.endIndex])}
                      >
                        <td>
                          <button
                            type="button"
                            className={`t-climb-cat cat-${climb.category ?? "none"}`}
                            aria-pressed={chosen}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelection([climb.startIndex, climb.endIndex]);
                            }}
                          >
                            {climb.category
                              ? climb.category === "HC"
                                ? "HC"
                                : `Cat ${climb.category}`
                              : `#${index + 1}`}
                          </button>
                        </td>
                        <td className="is-num">{formatNumber(climb.start, 1)} mi</td>
                        <td className="is-num">{formatNumber(climb.length, 1)} mi</td>
                        <td className="is-num">{climb.averageGrade.toFixed(1)}%</td>
                        <td className="is-num">{climb.maxGrade.toFixed(1)}%</td>
                        <td className="is-num">{formatNumber(climb.gain)} ft</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="t-empty">No sustained climbs: nothing gains 150 ft at 3% or steeper.</p>
          )}
          <p className="t-note">
            Pick a climb to highlight it on the profile and map. Categories follow Strava’s
            length × grade scale.
          </p>
        </article>
      </div>
    </>
  );
}

/** Highest point, steepest half mile and categorized climbs for any track. */
export function TrackStats({ track }: { track: RouteTrack }) {
  const { climbs, steepest } = useTrackAnalysis(track);
  return (
    <>
      <span>
        <small>Highest point</small>
        <strong className="num">{formatNumber(Math.max(...track.altitude))} ft</strong>
      </span>
      <span>
        <small>Steepest half mile</small>
        <strong className="num">{steepest.toFixed(1)}%</strong>
      </span>
      <span>
        <small>Categorized climbs</small>
        <strong className="num">{climbs.filter((climb) => climb.category).length}</strong>
      </span>
    </>
  );
}
