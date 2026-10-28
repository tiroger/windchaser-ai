import type { Activity, Gear, MaintenanceRecord } from "@/lib/training/activity-types";
import type { StreamsIndex } from "@/lib/training/metrics/performance";
import type { Settings } from "@/lib/training/settings";

/** A segment from efforts.json, without its geometry. */
export type EffortSegment = {
  id: number;
  name: string;
  distance_m: number;
  average_grade: number;
  /** The rider's PR on the segment as Strava reported it at sync time. */
  pr_elapsed_time: number | null;
};

export type EffortWeather = {
  wind_speed_ms: number | null;
  wind_from_deg: number | null;
  gust_ms: number | null;
  temperature_c: number | null;
};

/** One effort from efforts.json. start_date is UTC, unlike activity dates. */
export type SegmentEffort = {
  segment_id: number;
  start_date: string;
  elapsed_time_s: number;
  moving_time_s: number;
  distance_m: number;
  average_watts: number | null;
  device_watts: boolean;
  average_heartrate: number | null;
  /** Rounded "lat,lon" of the forecast cell; used only to guess the timezone. */
  cell_id: string | null;
  weather: EffortWeather | null;
};

export type EffortsData = {
  generated_at: string | null;
  segments: Record<string, EffortSegment>;
  efforts: SegmentEffort[];
};

/**
 * Everything the tools read, loaded once per question. Efforts are a separate,
 * larger object that only the segment tool needs, so they load on demand.
 */
export type AskData = {
  /** The server's local date, YYYY-MM-DD. */
  today: string;
  activities: Activity[];
  gear: Gear[];
  maintenance: MaintenanceRecord[];
  settings: Settings;
  streamsIndex: StreamsIndex;
  efforts: () => Promise<EffortsData>;
};

export type ToolOutcome =
  | { ok: true; result: unknown; summary: string }
  | { ok: false; error: string };

export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** What the API route streams to the page, one per SSE data line. */
export type AskEvent =
  | { type: "start"; provider: string; model: string }
  | { type: "round"; round: number }
  | { type: "text"; delta: string }
  /** Text streamed in this round preceded tool calls: it was narration, not the answer. */
  | { type: "narration" }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; summary: string; ms: number }
  | {
      type: "done";
      stop_reason: string;
      rounds: number;
      usage: UsageTotals;
      truncated: boolean;
    }
  | { type: "refusal"; message: string; category: string | null }
  | { type: "error"; message: string };

/** One prior turn the page sends back for context: plain text only. */
export type HistoryTurn = { role: "user" | "assistant"; content: string };
