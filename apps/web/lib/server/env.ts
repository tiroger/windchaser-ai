import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads credentials from the repository root .env so a single file serves both
 * the Python fixture script and the web app. Values never leave the server.
 *
 * On AWS these come from Secrets Manager instead; this loader is the local
 * development equivalent, not the deployed path.
 */
let cached: Record<string, string> | null = null;

function loadFile(): Record<string, string> {
  if (cached) return cached;
  const out: Record<string, string> = {};

  // Development convenience only. In a deployed environment these values are
  // injected as environment variables from Secrets Manager, and reading files
  // at runtime would force the whole project into the server bundle.
  if (process.env.NODE_ENV === "production") {
    cached = out;
    return out;
  }

  for (const candidate of [
    join(process.cwd(), ".env.local"),
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", "..", ".env"),
  ]) {
    try {
      for (const raw of readFileSync(/*turbopackIgnore: true*/ candidate, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) continue;
        const key = line.slice(0, line.indexOf("=")).trim();
        const value = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key && value && !(key in out)) out[key] = value;
      }
    } catch {
      // Missing file is fine; try the next candidate.
    }
  }
  cached = out;
  return out;
}

/** Prefers process env, then .env, then the unprefixed my-strava naming. */
export function readEnv(name: string): string | undefined {
  const file = loadFile();
  const legacy = name.replace(/^STRAVA_/, "");
  return (
    process.env[name] ||
    file[name] ||
    process.env[legacy] ||
    file[legacy] ||
    undefined
  );
}

export function hasStravaCredentials(): boolean {
  return Boolean(
    readEnv("STRAVA_CLIENT_ID") &&
      readEnv("STRAVA_CLIENT_SECRET") &&
      readEnv("STRAVA_REFRESH_TOKEN"),
  );
}
