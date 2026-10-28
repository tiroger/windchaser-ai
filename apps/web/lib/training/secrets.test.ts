import { afterEach, describe, expect, it, vi } from "vitest";

const secret = JSON.stringify({
  admin_passphrase: "local-test-passphrase",
  admin_session_secret: "local-session-secret-of-32-characters!",
});

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import("./secrets");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("development owner secret", () => {
  it("stands in for Secrets Manager under next dev when no ARN is set", async () => {
    const secrets = await load({ NODE_ENV: "development", WEB_SECRET_ARN: "", TRAINING_DEV_OWNER_SECRET: secret });
    expect(secrets.webSecretConfigured()).toBe(true);
    await expect(secrets.getWebSecret()).resolves.toMatchObject({ admin_passphrase: "local-test-passphrase" });
  });

  it("is ignored in production builds", async () => {
    const secrets = await load({ NODE_ENV: "production", WEB_SECRET_ARN: "", TRAINING_DEV_OWNER_SECRET: secret });
    expect(secrets.webSecretConfigured()).toBe(false);
    await expect(secrets.getWebSecret()).rejects.toThrow("WEB_SECRET_ARN is not configured");
  });

  it("never overrides a configured secret ARN", async () => {
    const secrets = await load({ NODE_ENV: "development", WEB_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:1:secret:x", TRAINING_DEV_OWNER_SECRET: secret });
    expect(secrets.webSecretConfigured()).toBe(true);
    // The ARN path is taken: the dev value is not returned.
    const send = vi.fn().mockRejectedValue(new Error("no network in tests"));
    const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
    vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(send);
    await expect(secrets.getWebSecret()).rejects.toThrow("no network in tests");
  });

  it("still validates the stand-in's lengths", async () => {
    const secrets = await load({ NODE_ENV: "development", WEB_SECRET_ARN: "", TRAINING_DEV_OWNER_SECRET: '{"admin_passphrase":"short","admin_session_secret":"x"}' });
    await expect(secrets.getWebSecret()).rejects.toThrow(/at least 16 characters/);
  });
});
