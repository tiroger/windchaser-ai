import type { Activity } from "./activity-types";

/** An activity with every optional field empty, overridable per test. */
export function activity(overrides: Partial<Activity> & Pick<Activity, "id" | "date">): Activity {
  return {
    name: "Activity",
    type: "Ride",
    distance: 0,
    moving_time: 1,
    total_elevation_gain: 0,
    average_speed: 0,
    average_heartrate: null,
    max_heartrate: null,
    average_watts: null,
    weighted_average_watts: null,
    max_watts: null,
    kilojoules: null,
    suffer_score: null,
    kudos_count: 0,
    gear_id: null,
    hasRoute: false,
    ...overrides,
  };
}
