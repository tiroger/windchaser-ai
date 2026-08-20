export type LatLon = [number, number];

export interface Segment {
  id: number;
  name: string;
  source: "starred" | "discovered";
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
  temperature_c: number[];
  humidity_pct: number[];
  pressure_hpa: number[];
  precip_mm: number[];
  precip_prob: number[];
  wind_speed_ms: number[];
  wind_from_deg: number[];
  gust_ms: number[];
}

export interface Region {
  id: string;
  name: string;
  lat: number;
  lon: number;
  starred_count: number;
  discovered_count?: number;
}

export interface Bundle {
  generated_at: string;
  is_sample?: boolean;
  live?: boolean;
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
