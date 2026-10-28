"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useTransition,
} from "react";

import { calendarDate, type CalendarDate } from "@/lib/training/activity-types";
import type { Settings } from "@/lib/training/settings";
import { ownerRequest, useAdmin, type AdminSession } from "@/lib/training/use-admin";
import { useToday } from "@/lib/training/use-today";

type TrainingContextValue = {
  admin: AdminSession;
  /** The viewer's local date once hydrated; the server's before. */
  todayIso: string;
  today: CalendarDate;
  /** Writes the owner's settings, then re-renders the pages from the server. */
  saveSettings: (next: Settings) => Promise<void>;
  /** True while a save's re-render is in flight. */
  refreshing: boolean;
  /**
   * Whether this tab has moved between pages inside the app, so browser
   * history has somewhere in it to go back to. Read at click time.
   */
  canGoBack: () => boolean;
};

const TrainingContext = createContext<TrainingContextValue | null>(null);

/** How often an open page asks whether Strava sent anything new. */
const POLL_MS = 60_000;

/**
 * State that outlives a page change within Training: owner mode, today's date,
 * and the poll that keeps an open tab current.
 *
 * It sits in the layout, which Next keeps mounted across navigation, so
 * unlocking owner mode on the overview still holds on the garage. Data itself
 * is not held here: every page renders from the server, and a change (a new
 * ride, a saved goal) is picked up by refreshing that render rather than by
 * patching client copies that could disagree with it.
 */
export default function TrainingProvider({
  initialAdmin,
  serverToday,
  dataVersion,
  children,
}: {
  initialAdmin: boolean;
  serverToday: string;
  dataVersion: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const admin = useAdmin(initialAdmin);
  const todayIso = useToday(serverToday);
  const today = useMemo(
    () => calendarDate(todayIso) ?? { year: 1970, month: 0, day: 1 },
    [todayIso],
  );
  const [refreshing, startRefresh] = useTransition();

  const pathname = usePathname();
  const firstPath = useRef(pathname);
  const moved = useRef(false);
  useEffect(() => {
    if (pathname !== firstPath.current) moved.current = true;
  }, [pathname]);
  const canGoBack = useCallback(() => moved.current, []);

  // A small version check; the page re-renders only when an object changed.
  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch("/api/training/data-version", { cache: "no-store" });
        if (!response.ok) return;
        const { version } = (await response.json()) as { version?: string };
        if (version && version !== dataVersion) startRefresh(() => router.refresh());
      } catch {
        // Offline or a transient error; try again on the next tick.
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [dataVersion, router]);

  const saveSettings = useCallback(
    async (next: Settings) => {
      await ownerRequest<Settings>("/api/training/settings", "PUT", next);
      startRefresh(() => router.refresh());
    },
    [router],
  );

  const value = useMemo(
    () => ({ admin, todayIso, today, saveSettings, refreshing, canGoBack }),
    [admin, todayIso, today, saveSettings, refreshing, canGoBack],
  );

  return <TrainingContext.Provider value={value}>{children}</TrainingContext.Provider>;
}

export function useTraining(): TrainingContextValue {
  const value = useContext(TrainingContext);
  if (!value) throw new Error("useTraining must be used inside TrainingProvider");
  return value;
}
