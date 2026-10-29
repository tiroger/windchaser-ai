export type LatLon = [number, number];

/**
 * Where a candidate segment came from. A segment can come from several at
 * once (starred and ridden, say); `source` is the strongest of them and
 * `sources` lists them all.
 */
export type SegmentSource = "starred" | "tracked" | "discovered";

/** How much, and how lately, the rider rides a segment. */
export interface SegmentRiding {
  /** Efforts on record: the effort history's, or the usage count. */
  attempts: number;
  /** UTC ISO time of the latest effort, when known. */
  last_ridden: string | null;
  /**
   * Efforts weighted by age, each counting half as much every
   * RECENCY_HALF_LIFE_DAYS: where the rider rides now, rather than ever.
   */
  recent: number;
}

/** One still-air entry on a segment's leaderboard. */
export interface StillAirEntry {
  date: string;
  activity_id: string | null;
  still_air_s: number;
  elapsed_s: number;
}

/**
 * The rider's record on a segment they have history on, as the wind view
 * shows it. Names, times, dates and activity IDs only.
 */
export interface SegmentRecord {
  /** Strava's PR: the fastest elapsed time. */
  pr_elapsed_s: number;
  pr_date: string;
  pr_activity_id: string | null;
  /** The record was ridden easily or with a stop; see isSoftRecord. */
  soft: boolean;
  /** Typical miss of the model on this segment, seconds. */
  model_error_s: number;
  /** "attempts" when measured on this segment's own hard efforts; else the backtest's figure. */
  model_error_source: "attempts" | "backtest";
  still_air: {
    best_s: number;
    best_date: string;
    best_activity_id: string | null;
    /** Efforts with a still-air time. */
    count: number;
    /** Where the PR effort ranks among them, 1 being fastest. */
    pr_rank: number | null;
    /** Whether still air tracks the power meter here; "worse" reads as rough. */
    check: "better" | "worse" | "unchecked";
    /** Fastest few in still air. */
    top: StillAirEntry[];
  } | null;
}

export interface Segment {
  id: number;
  name: string;
  source: SegmentSource;
  sources?: SegmentSource[];
  riding?: SegmentRiding | null;
  record?: SegmentRecord | null;
  distance_m: number;
  average_grade: number;
  maximum_grade: number;
  elevation_high: number;
  elevation_low: number;
  total_elevation_gain: number;
  climb_category: number;
  city: string | null;
  state: string | null;
  effort_count: number | null;
  athlete_count: number | null;
  star_count: number | null;
  pr_elapsed_time: number | null;
  pr_date: string | null;
  effort_count_personal: number | null;
  points: LatLon[];
  region_id: string;
  cell_id: string;
  /** Power fitted across recorded attempts in their real weather, when known. */
  calibrated_power_w?: number | null;
  /** How many attempts the fit is based on. */
  attempt_count?: number | null;
  /** Best moving time on record. Like-for-like with a predicted moving time. */
  best_moving_time_s?: number | null;
  /** Real gradient profile, so grade varies along the segment. */
  elevation_profile?: ElevationProfile | null;
  /** Rider-level model, used when this segment has no fit of its own. */
  rider_model?: RiderModel | null;
}

/**
 * What this rider can hold, learned across every recorded attempt rather than
 * per segment, so it applies to segments they have never ridden.
 *
 * Mass and frontal area are fitted too. They are assumed constants elsewhere,
 * and getting them wrong is invisible in a per-segment fit -- the error is
 * absorbed into that segment's power -- but fatal to a model meant to carry
 * between a climb and a flat, where the two constants dominate in turn.
 */
export interface RiderModel {
  /** Power available for an effort of unbounded length. */
  cp_w: number;
  /** Finite work available above it, spent over the effort's duration. */
  w_prime_j: number;
  /**
   * Extra power per unit of gradient. Behavioural, not physical: gravity is
   * already in the physics. A climb compels a steady effort where a flat
   * allows coasting and drafting, and this rider holds roughly 35 W more on
   * one than the other at equal duration.
   */
  grade_w: number;
  /**
   * The gradients this rider actually has recorded efforts on. The term above
   * is a description of their behaviour within that range and an extrapolation
   * outside it, so it is clamped here rather than continued: unclamped, a
   * segment half again as steep as anything in the history was credited with
   * more power over forty minutes than this rider holds over thirty-one.
   */
  grade_min: number;
  grade_max: number;
  mass_kg: number;
  cda: number;
}

export interface ElevationProfile {
  distance_m: number[];
  altitude_m: number[];
}

export interface ForecastCell {
  cell_id: string;
  latitude: number;
  longitude: number;
  timezone: string;
  utc_offset_seconds: number;
  issued_at: string;
  time: string[];
  // The provider returns null for hours it has no value for, so the reader
  // defaults them rather than the writer inventing a zero wind.
  temperature_c: (number | null)[];
  humidity_pct: (number | null)[];
  pressure_hpa: (number | null)[];
  precip_mm: (number | null)[];
  precip_prob: (number | null)[];
  wind_speed_ms: (number | null)[];
  wind_from_deg: (number | null)[];
  gust_ms: (number | null)[];
}

export interface Region {
  id: string;
  name: string;
  lat: number;
  lon: number;
  starred_count: number;
  discovered_count?: number;
  tracked_count?: number;
  /** Every candidate segment in the region, whatever its source. */
  segment_count?: number;
  /** Recency-weighted riding across the region; regions are ordered by it. */
  recent?: number;
}

export interface Bundle {
  generated_at: string;
  is_sample?: boolean;
  live?: boolean;
  /** Strava and the forecast provider degrade independently. */
  sources?: { segments: "live" | "saved"; forecast: "live" | "saved" };
  athlete: {
    firstname: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    weight_kg: number | null;
    ftp: number | null;
  };
  centre: { lat: number; lon: number };
  regions: Region[];
  segments: Segment[];
  forecast_cells: Record<string, ForecastCell>;
  /** Where the discovered segments came from, as a quiet note for the page. */
  discovery?: { source: "live" | "saved" | "none"; note: string | null };
}

/** Rider parameters feeding the constant-power model. */
export interface Rider {
  power_w: number;
  mass_kg: number;
  cda: number;
  crr: number;
  drivetrain_efficiency: number;
}

export interface SectionResult {
  /** Metres from the segment start to the beginning of this section. */
  offset_m: number;
  distance_m: number;
  bearing_deg: number;
  grade: number;
  tailwind_ms: number;
  crosswind_ms: number;
  speed_ms: number;
  time_s: number;
}

export interface GateFailure {
  gate: string;
  detail: string;
}

export interface Evaluation {
  segment_id: number;
  hour_index: number;
  calibrated_power_w: number;
  predicted_time_s: number;
  still_air_time_s: number;
  delta_vs_still_air_s: number;
  effective_tailwind_ms: number;
  mean_crosswind_ms: number;
  sigma_s: number;
  p_beat: number | null;
  margin: number;
  score: number;
  gates: GateFailure[];
  sections: SectionResult[];
  weather: {
    wind_speed_ms: number;
    wind_from_deg: number;
    gust_ms: number;
    temperature_c: number;
    precip_mm: number;
    precip_prob: number;
    air_density: number;
  };
}
