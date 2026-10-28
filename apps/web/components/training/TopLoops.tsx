import Link from "next/link";

import "@/app/training/loops.css";
import { formatDuration } from "@/lib/geo";
import { formatNumber, getActivityKind } from "@/lib/training/activity-types";
import type { LoopSummary } from "@/lib/training/loops";

import { rideDate } from "./loop-format";
import SportIcon, { sportTone } from "./SportIcon";

/**
 * The routes ridden most often, each opening its latest ride with the loop's
 * full history. Matching happens on the server; these carry no coordinates.
 */
export default function TopLoops({ loops }: { loops: LoopSummary[] }) {
  if (!loops.length) return null;
  return (
    <section className="panel t-top-loops" aria-labelledby="top-loops-title">
      <div className="t-card-head">
        <div>
          <span className="label">Your loops</span>
          <h2 className="t-card-title" id="top-loops-title">
            Most-ridden routes
          </h2>
        </div>
        <p className="t-note t-top-loops-note">Matched by GPS track, not by name.</p>
      </div>
      <ul className="t-loop-cards">
        {loops.map((loop) => (
          <li key={loop.id}>
            <Link className="t-loop-card" href={`/training/activities/${loop.latest.id}#loop`}>
              <span className="t-loop-card-head">
                <span className={`t-icon-chip is-small ${sportTone(getActivityKind(loop.type))}`}>
                  <SportIcon type={loop.type} />
                </span>
                <strong>{loop.name}</strong>
              </span>
              <span className="t-loop-card-count">
                <b className="num">{loop.count}</b> times · {formatNumber(loop.distance, 1)} mi
              </span>
              <dl>
                <div>
                  <dt>Best</dt>
                  <dd className="num">
                    {loop.best ? formatDuration(loop.best.movingSeconds) : "—"}
                    {loop.best && <small>{rideDate(loop.best.date)}</small>}
                  </dd>
                </div>
                <div>
                  <dt>Latest</dt>
                  <dd className="num">{rideDate(loop.latest.date)}</dd>
                </div>
              </dl>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
