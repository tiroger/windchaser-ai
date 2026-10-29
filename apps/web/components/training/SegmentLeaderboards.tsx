"use client";

import Link from "next/link";
import { useState } from "react";

import { formatDuration } from "@/lib/geo";
import { formatNumber } from "@/lib/training/activity-types";
import type { Leaderboard } from "@/lib/training/pr-chances-data";

import { rideDate } from "./loop-format";
import ModeToggle from "./ModeToggle";
import { netWind, ROUGH_NOTE, STILL_AIR_NOTE, type TimeMode } from "./segment-format";

/**
 * Your fastest efforts on each segment you ride often, ranked by recorded time
 * or by still-air time. Switching shows whose records the wind wrote.
 */
export default function SegmentLeaderboards({ boards }: { boards: Leaderboard[] }) {
  const [mode, setMode] = useState<TimeMode>("still");
  const still = mode === "still";
  const home = boards.filter((board) => board.nearHome);
  const away = boards.filter((board) => !board.nearHome);
  return (
    <article className="panel" id="leaderboards">
      <div className="t-card-head">
        <div>
          <span className="label">Your leaderboards</span>
          <h2 className="t-card-title">
            Fastest efforts {still ? "in still air" : "as recorded"}
            {home.length > 0 && `, ${home.length} ${home.length === 1 ? "segment" : "segments"} near home`}
          </h2>
        </div>
        <ModeToggle mode={mode} onChange={setMode} label="Rank leaderboards by" />
      </div>
      {boards.length === 0 ? (
        <p className="t-empty">No segment has three or more recorded efforts yet.</p>
      ) : (
        <>
          <BoardGrid boards={home} still={still} />
          {away.length > 0 && (
            <details className="t-lb-away">
              <summary>
                {home.length ? "Elsewhere" : "All segments"}: {away.length} more{" "}
                {away.length === 1 ? "segment" : "segments"}
              </summary>
              <BoardGrid boards={away} still={still} />
            </details>
          )}
        </>
      )}
      <p className="t-note">{STILL_AIR_NOTE}</p>
    </article>
  );
}

function BoardGrid({ boards, still }: { boards: Leaderboard[]; still: boolean }) {
  return (
    <ul className="t-lb-grid">
      {boards.map((board) => {
        const entries = still ? board.stillAir : board.recorded;
        return (
          <li key={board.segmentId} className="t-lb-card">
            <h3>{board.name}</h3>
            <p className="t-lb-meta">
              {board.distanceM !== null && `${formatNumber(board.distanceM / 1609.344, 2)} mi`}
              {board.averageGrade !== null && ` · ${formatNumber(board.averageGrade, 1)}%`}
              {` · ${board.efforts} efforts · last ${rideDate(board.lastRidden)}`}
            </p>
            {entries.length === 0 ? (
              <p className="t-lb-note">No effort here has a still-air time yet.</p>
            ) : (
              <ol>
                {entries.map((entry, index) => {
                  const wind = netWind(entry.tailwindMs);
                  const main = still ? entry.stillAirSeconds! : entry.elapsedSeconds;
                  const other = still ? entry.elapsedSeconds : entry.stillAirSeconds;
                  return (
                    <li key={`${entry.date}-${entry.elapsedSeconds}-${index}`}>
                      <span className="t-lb-rank num">{index + 1}</span>
                      <span className="t-lb-date">
                        {entry.activityId ? (
                          <Link href={`/training/activities/${entry.activityId}#segments`}>
                            {rideDate(entry.date, true)}
                          </Link>
                        ) : (
                          rideDate(entry.date, true)
                        )}
                        {wind && <small>{wind}</small>}
                      </span>
                      <span className="t-lb-time num">
                        {still ? "≈ " : ""}
                        {formatDuration(main)}
                        {other !== null && (
                          <small>
                            {still ? `${formatDuration(other)} recorded` : `≈ ${formatDuration(other)} still`}
                          </small>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
            {still && board.check === "worse" && <p className="t-lb-note is-rough">{ROUGH_NOTE}</p>}
            {still && board.adjusted < board.efforts && (
              <p className="t-lb-note">
                {board.efforts - board.adjusted} of {board.efforts} efforts have no still-air time yet.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
