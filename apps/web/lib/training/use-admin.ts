"use client";

import { useCallback, useMemo, useState } from "react";

export type AdminSession = {
  authenticated: boolean;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => Promise<void>;
};

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    return ((await response.json()) as { error?: string }).error ?? fallback;
  } catch {
    return fallback;
  }
}

/** Owner mode, shared by every panel that can edit: maintenance, goals, settings. */
export function useAdmin(initiallyAuthenticated: boolean): AdminSession {
  const [authenticated, setAuthenticated] = useState(initiallyAuthenticated);

  const unlock = useCallback(async (passphrase: string) => {
    const response = await fetch("/api/training/admin/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase }),
    });
    if (!response.ok) throw new Error(await errorMessage(response, "Could not unlock owner mode"));
    setAuthenticated(true);
  }, []);

  const lock = useCallback(async () => {
    const response = await fetch("/api/training/admin/session", { method: "DELETE" });
    if (!response.ok) throw new Error(await errorMessage(response, "Could not lock owner mode"));
    setAuthenticated(false);
  }, []);

  return useMemo(() => ({ authenticated, unlock, lock }), [authenticated, unlock, lock]);
}

/** JSON write to an owner-only endpoint, surfacing the server's error message. */
export async function ownerRequest<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorMessage(response, "The change could not be saved"));
  return (await response.json()) as T;
}
