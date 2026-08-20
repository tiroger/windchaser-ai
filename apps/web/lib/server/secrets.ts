import "server-only";

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * Runtime credential resolution.
 *
 * Locally these come from a .env file. Deployed, they come from Secrets
 * Manager, read with the app's own compute role. Terraform creates the secret
 * but never its value, per section 11 of the project plan, so nothing here is
 * recoverable from state or from a plan output.
 *
 * Cached for the life of the container. A rotated credential is picked up on
 * the next cold start rather than the next request, which is the right trade
 * for a value that changes rarely and is read constantly.
 */

interface StravaCredentials {
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_REFRESH_TOKEN: string;
}

let cached: Partial<StravaCredentials> | null = null;
let inFlight: Promise<Partial<StravaCredentials>> | null = null;

async function load(): Promise<Partial<StravaCredentials>> {
  const arn = process.env.STRAVA_SECRET_ARN;
  if (!arn) return {};

  const client = new SecretsManagerClient({
    // Amplify sets AWS_REGION in the compute runtime. A custom variable is not
    // an option: Amplify rejects any environment variable starting with "AWS".
    region: process.env.AWS_REGION || "us-east-1",
  });

  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    if (!result.SecretString) return {};
    const parsed = JSON.parse(result.SecretString) as Record<string, string>;
    // Accept the unprefixed names too, matching the .env the fixture scripts read.
    return {
      STRAVA_CLIENT_ID: parsed.STRAVA_CLIENT_ID ?? parsed.CLIENT_ID,
      STRAVA_CLIENT_SECRET: parsed.STRAVA_CLIENT_SECRET ?? parsed.CLIENT_SECRET,
      STRAVA_REFRESH_TOKEN: parsed.STRAVA_REFRESH_TOKEN ?? parsed.REFRESH_TOKEN,
    };
  } catch (error) {
    // A missing or unreadable secret is a configuration problem, not a crash.
    // The API route already degrades to the saved bundle when Strava is
    // unreachable, and that is the honest behaviour here too.
    console.error(
      "[secrets] could not read Strava credentials:",
      error instanceof Error ? error.message : error,
    );
    return {};
  }
}

/** Resolves the secret once per container, coalescing concurrent callers. */
export async function stravaCredentials(): Promise<Partial<StravaCredentials>> {
  if (cached) return cached;
  if (!inFlight) {
    inFlight = load().then((value) => {
      cached = value;
      inFlight = null;
      return value;
    });
  }
  return inFlight;
}

export function secretsConfigured(): boolean {
  return Boolean(process.env.STRAVA_SECRET_ARN);
}
