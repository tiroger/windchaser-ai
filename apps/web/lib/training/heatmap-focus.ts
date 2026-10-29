/** Half-size, in degrees, of the area a heatmap frames around its focus (~150 km). */
const FOCUS_LNG = 1.8;
const FOCUS_LAT = 1.4;
const RECENT_ROUTES = 200;

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Whether a [lng, lat] point lies within the framed area around a focus. */
export const nearFocus = ([lng, lat]: number[], [lng0, lat0]: number[]) =>
  Math.abs(lng - lng0) < FOCUS_LNG && Math.abs(lat - lat0) < FOCUS_LAT;

/**
 * Where the rider mostly rides lately: the recent start with the most recent
 * starts around it, then the median of those neighbours. A median of all
 * starts taken per axis fails a rider who has lived on two coasts -- it pairs
 * one coast's latitude with the other's longitude and frames neither.
 */
export function homeFocus(routes: { date: string; start: number[] }[]): number[] | null {
  const recent = [...routes]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, RECENT_ROUTES)
    .map((route) => route.start);
  if (!recent.length) return null;
  let best = recent[0];
  let bestCount = 0;
  for (const candidate of recent) {
    const count = recent.filter((start) => nearFocus(start, candidate)).length;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  const cluster = recent.filter((start) => nearFocus(start, best));
  return [median(cluster.map(([lng]) => lng)), median(cluster.map(([, lat]) => lat))];
}

