"use client";

import type { RankingLoad } from "@/components/training/RouteSketch";
import { DAY_LABELS, RANKING_DAYS, type RankingDay } from "@/lib/training/route-ranking";

/**
 * The day routes are ranked for: the rider's choice, else today, or tomorrow
 * once today's daylight is gone.
 */
export function rankingDay(
  choice: RankingDay | null,
  today: RankingLoad | null,
): { day: RankingDay; rolledOver: boolean } {
  const todayEmpty = today?.status === "ready" && today.data.routes.length === 0;
  return { day: choice ?? (todayEmpty ? "tomorrow" : "today"), rolledOver: choice === null && todayEmpty };
}

/** Today, Tomorrow, Weekend: the wind bar's control in Routes mode. */
export function DayChips({ day, onDay }: { day: RankingDay; onDay: (day: RankingDay) => void }) {
  return (
    <div className="chip-row" role="group" aria-label="Day to rank routes for">
      {RANKING_DAYS.map((value) => (
        <button key={value} type="button" className="chip" aria-pressed={day === value} onClick={() => onDay(value)}>
          {DAY_LABELS[value]}
        </button>
      ))}
    </div>
  );
}
