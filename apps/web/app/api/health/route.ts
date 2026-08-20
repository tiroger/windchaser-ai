import { calibrationTable } from "@/lib/server/calibration";
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
    APP_DATA_BUCKET: process.env.APP_DATA_BUCKET ?? null,
    CALIBRATION_S3_KEY: process.env.CALIBRATION_S3_KEY ?? null,
    LIVE_AI_ENABLED: process.env.LIVE_AI_ENABLED ?? null,
    AWS_REGION: process.env.AWS_REGION ?? null,
    NODE_ENV: process.env.NODE_ENV ?? null,
  };

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

  const table = await calibrationTable();
  const fitted = Object.values(table).filter((e) => e.power_w).length;

  return Response.json(
    {
      status: credentials.resolved ? "ok" : "degraded",
      env,
      credentials,
      calibration: {
        segments: Object.keys(table).length,
        with_fitted_power: fitted,
      },
      elapsed_ms: Date.now() - started,
    },
    { status: credentials.resolved ? 200 : 503 },
  );
}
