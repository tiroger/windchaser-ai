import { describe, expect, it } from "vitest";

import { createPreferences, LABELS_KEY, THEME_KEY } from "./preference";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const throwing = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("heatmap preferences", () => {
  it("defaults to the standard map without labels", () => {
    const prefs = createPreferences(() => memoryStorage());
    expect(prefs.theme()).toBe("standard");
    expect(prefs.labels()).toBe(false);
  });

  it("remembers a theme and the labels choice", () => {
    const storage = memoryStorage();
    const prefs = createPreferences(() => storage);
    expect(prefs.setTheme("blueprint")).toBe(true);
    prefs.setLabels(true);
    expect(storage.values.get(THEME_KEY)).toBe("blueprint");
    expect(storage.values.get(LABELS_KEY)).toBe("1");
    // A fresh page reads them back.
    const again = createPreferences(() => storage);
    expect(again.theme()).toBe("blueprint");
    expect(again.labels()).toBe(true);
  });

  it("ignores a stored value that is not a theme", () => {
    const storage = memoryStorage();
    storage.setItem(THEME_KEY, "neon_cyberpunk");
    expect(createPreferences(() => storage).theme()).toBe("standard");
  });

  it("falls back to the default when storage throws, and keeps the choice in memory", () => {
    const prefs = createPreferences(() => throwing);
    expect(prefs.theme()).toBe("standard");
    expect(prefs.setTheme("noir")).toBe(false);
    expect(prefs.theme()).toBe("noir");
    expect(prefs.setLabels(true)).toBe(false);
    expect(prefs.labels()).toBe(true);
  });

  it("survives the storage getter itself throwing, or there being none", () => {
    const blocked = createPreferences(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(blocked.theme()).toBe("standard");
    expect(blocked.setTheme("terracotta")).toBe(false);
    expect(blocked.theme()).toBe("terracotta");
    const none = createPreferences(() => null);
    expect(none.theme()).toBe("standard");
    expect(none.setTheme("noir")).toBe(false);
  });
});
