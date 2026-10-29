/**
 * Forecast wall-clock times as instants. Pure, so the wind view can run it in
 * the browser over the same forecast cells the server reads.
 */

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** Milliseconds a zone is ahead of UTC at an instant. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  let format = offsetFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormats.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(epochMs).map((p) => [p.type, p.value]));
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Epoch seconds for a forecast's wall-clock time. The provider's single UTC
 * offset is only right until the next daylight-saving change, which a
 * seven-day forecast crosses twice a year.
 */
export function localToEpoch(local: string, timeZone: string, fallbackOffsetS: number): number {
  const wall = Date.parse(`${local}:00Z`);
  try {
    const first = wall - zoneOffsetMs(wall, timeZone);
    return Math.round((wall - zoneOffsetMs(first, timeZone)) / 1000);
  } catch {
    return Math.round(wall / 1000) - fallbackOffsetS;
  }
}
