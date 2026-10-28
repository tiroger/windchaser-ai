import "server-only";

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * Owner-mode credentials, from the windchaser/{env}/web secret named by
 * WEB_SECRET_ARN. Kept apart from the Strava secret: the web runtime is the
 * only reader, and rotating the owner passphrase should never touch the token
 * both workers depend on.
 *
 * Validated on read, so a value pasted in too short fails the first unlock with
 * a clear message instead of weakening the session signature silently.
 */
export type WebSecret = {
  admin_passphrase: string;
  admin_session_secret: string;
};

const minimumLengths: Record<keyof WebSecret, number> = {
  admin_passphrase: 16,
  admin_session_secret: 32,
};

const client = new SecretsManagerClient({
  region: process.env.AWS_REGION || "us-east-1",
});
let cached: Promise<WebSecret> | undefined;

function parseWebSecret(text: string): WebSecret {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Web secret must contain a JSON object");
  }
  const secret = value as Record<string, unknown>;
  for (const [key, minimum] of Object.entries(minimumLengths)) {
    const field = secret[key];
    if (typeof field !== "string" || field.length < minimum) {
      throw new Error(
        `Web secret ${key} must be a string of at least ${minimum} characters`,
      );
    }
  }
  return {
    admin_passphrase: secret.admin_passphrase as string,
    admin_session_secret: secret.admin_session_secret as string,
  };
}

/**
 * Local development only: TRAINING_DEV_OWNER_SECRET, a JSON value with the
 * same two fields, stands in for Secrets Manager when WEB_SECRET_ARN is unset,
 * so owner-only pages can be exercised under `next dev`. The NODE_ENV check
 * is replaced with a constant by `next build`, which removes this branch from
 * every production bundle; a deployment cannot turn it on.
 */
function devOwnerSecret(): string | undefined {
  if (process.env.NODE_ENV !== "development" || process.env.WEB_SECRET_ARN) return undefined;
  return process.env.TRAINING_DEV_OWNER_SECRET || undefined;
}

/** Resolves the secret once per container; a failure is retried on the next call. */
export function getWebSecret(): Promise<WebSecret> {
  if (!cached) {
    const dev = devOwnerSecret();
    if (dev) {
      cached = Promise.resolve().then(() => parseWebSecret(dev));
      return cached;
    }
    const secretArn = process.env.WEB_SECRET_ARN;
    if (!secretArn) return Promise.reject(new Error("WEB_SECRET_ARN is not configured"));
    cached = client
      .send(new GetSecretValueCommand({ SecretId: secretArn }))
      .then((response) => {
        if (!response.SecretString) {
          throw new Error("Web secret has no SecretString");
        }
        return parseWebSecret(response.SecretString);
      })
      .catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
  }
  return cached;
}

export function webSecretConfigured(): boolean {
  return Boolean(process.env.WEB_SECRET_ARN || devOwnerSecret());
}
