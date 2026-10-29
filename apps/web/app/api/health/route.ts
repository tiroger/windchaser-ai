import { calibrationTable } from "@/lib/server/calibration";
import { rateLimitState } from "@/lib/server/strava";
import { stravaConfig } from "@/lib/server/env";
import { secretsConfigured } from "@/lib/server/secrets";

export const dynamic = "force-dynamic";

/**
 * Operational health, and what the deploy workflow's smoke test asserts.
 *
 * Reports whether configuration resolved, never what it resolved to. Knowing
 * that a credential is present is operationally necessary; knowing its value is
 * not, so only presence and length are exposed.
 */
export async function GET() {
  const started = Date.now();

  const env = {
    STRAVA_SECRET_ARN: Boolean(process.env.STRAVA_SECRET_ARN),
    // The bucket name carries the account id, so presence only.
    APP_DATA_BUCKET: Boolean(process.env.APP_DATA_BUCKET),
    CALIBRATION_S3_KEY: process.env.CALIBRATION_S3_KEY ?? null,
    LIVE_AI_ENABLED: process.env.LIVE_AI_ENABLED ?? null,
    AWS_REGION: process.env.AWS_REGION ?? null,
    NODE_ENV: process.env.NODE_ENV ?? null,
  };

  // The Training section's configuration (ADR-0004), as presence flags only.
  // Key names are not secret, but the queue URL carries the account id and the
  // athlete id identifies the rider, so this reports whether each resolved and
  // leaves out what it resolved to.
  const training = Object.fromEntries(
    [
      "ACTIVITIES_S3_KEY",
      "BIKES_S3_KEY",
      "STREAMS_S3_PREFIX",
      "STREAMS_INDEX_S3_KEY",
      "SAVED_ROUTES_S3_KEY",
      "SAVED_ROUTES_S3_PREFIX",
      "MAINTENANCE_S3_KEY",
      "SETTINGS_S3_KEY",
      "WEB_SECRET_ARN",
      "TRAINING_EVENTS_QUEUE_URL",
      "STRAVA_ATHLETE_ID",
    ].map((name) => [name, Boolean(process.env[name])]),
  );

  let credentials: { resolved: boolean; source: string; detail?: string };
  try {
    const config = await stravaConfig();
    credentials = {
      resolved: Boolean(config),
      source: secretsConfigured() ? "secrets-manager" : "environment",
      detail: config
        ? `clientId ${config.clientId.length} chars, refreshToken ${config.refreshToken.length} chars`
        : "no credentials resolved",
    };
  } catch (error) {
    credentials = {
      resolved: false,
      source: secretsConfigured() ? "secrets-manager" : "environment",
      detail: error instanceof Error ? error.message : "unknown error",
    };
  }

  const { segments: table, rider } = await calibrationTable();
  const fitted = Object.values(table).filter((e) => e.power_w).length;

  return Response.json(
    {
      status: credentials.resolved ? "ok" : "degraded",
      env,
      training,
      credentials,
      calibration: {
        segments: Object.keys(table).length,
        with_fitted_power: fitted,
        // Everything else falls back to this, so its absence is the difference
        // between honest probabilities and optimistic ones. Whether it loaded is
        // operational; its parameters (the rider's mass among them) are personal
        // and stay off this public endpoint.
        rider_model: Boolean(rider),
      },
      // Null until this container has made a Strava call.
      strava_quota: rateLimitState(),
      elapsed_ms: Date.now() - started,
    },
    { status: credentials.resolved ? 200 : 503 },
  );
}
