import { isMapThemeId, STANDARD, type MapThemeId } from "./themes";

export const THEME_KEY = "windchaser-heatmap-theme";
export const LABELS_KEY = "windchaser-heatmap-labels";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * The heatmap's remembered choices. localStorage can throw rather than return
 * null (Safari's private mode, storage blocked by policy, a sandboxed frame),
 * so every access is guarded and a choice made in this tab is kept in memory
 * whether or not it could be stored.
 */
export function createPreferences(storage: () => StorageLike | null) {
  const memory = new Map<string, string>();
  const read = (key: string): string | null => {
    if (memory.has(key)) return memory.get(key)!;
    try {
      return storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string): boolean => {
    memory.set(key, value);
    try {
      const target = storage();
      if (!target) return false;
      target.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  };
  return {
    theme(): MapThemeId {
      const stored = read(THEME_KEY);
      return isMapThemeId(stored) ? stored : STANDARD;
    },
    setTheme: (id: MapThemeId) => write(THEME_KEY, isMapThemeId(id) ? id : STANDARD),
    labels: (): boolean => read(LABELS_KEY) === "1",
    setLabels: (on: boolean) => write(LABELS_KEY, on ? "1" : "0"),
  };
}

/** The page's preferences, over window.localStorage when there is one. */
export const preferences = createPreferences(() =>
  typeof window === "undefined" ? null : window.localStorage,
);
