"use client";

import { useSyncExternalStore } from "react";
import { localIsoDate } from "@/lib/training/activity-types";

const subscribe = () => () => {};

// Renders the server's date during hydration, then the viewer's local date,
// so "today" never causes a hydration mismatch across timezones.
export function useToday(serverToday: string): string {
  return useSyncExternalStore(subscribe, () => localIsoDate(), () => serverToday);
}
