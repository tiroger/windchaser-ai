import "server-only";

import { createHmac } from "node:crypto";
import { cookies } from "next/headers";

import { getWebSecret, webSecretConfigured } from "@/lib/training/secrets";
import { safeEqual } from "@/lib/training/security";

/**
 * Owner mode: a passphrase exchanged for a signed, HTTP-only cookie.
 *
 * The cookie carries only an expiry and its HMAC, so there is no session store
 * to keep and nothing a script on the page can read. Rotating
 * admin_session_secret signs everyone out.
 */
const COOKIE_NAME = "windchaser-owner";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function signature(expiresAt: string, secret: string): string {
  return createHmac("sha256", secret).update(expiresAt).digest("base64url");
}

export async function verifyAdminPassphrase(passphrase: string): Promise<boolean> {
  const secret = await getWebSecret();
  return safeEqual(passphrase, secret.admin_passphrase);
}

export async function createAdminCookie(): Promise<{
  value: string;
  maxAge: number;
}> {
  const secret = await getWebSecret();
  const maxAge = SESSION_TTL_SECONDS;
  const expiresAt = String(Math.floor(Date.now() / 1000) + maxAge);
  return {
    value: `${expiresAt}.${signature(expiresAt, secret.admin_session_secret)}`,
    maxAge,
  };
}

export async function isAdminSessionValid(): Promise<boolean> {
  const jar = await cookies();
  const value = jar.get(COOKIE_NAME)?.value;
  if (!value) return false;
  const [expiresAt, suppliedSignature, ...extra] = value.split(".");
  if (
    !expiresAt ||
    !suppliedSignature ||
    extra.length > 0 ||
    !/^\d+$/.test(expiresAt) ||
    Number(expiresAt) <= Math.floor(Date.now() / 1000)
  ) {
    return false;
  }
  const secret = await getWebSecret();
  return safeEqual(
    suppliedSignature,
    signature(expiresAt, secret.admin_session_secret),
  );
}

/**
 * For rendering: whether to show owner controls. A missing or unreadable
 * secret means nobody is the owner, never an error page for a public visitor.
 */
export async function ownerModeActive(): Promise<boolean> {
  if (!webSecretConfigured()) return false;
  try {
    return await isAdminSessionValid();
  } catch (error) {
    console.error("[training] could not verify owner session", error);
    return false;
  }
}

export const adminCookieName = COOKIE_NAME;
export const adminSessionTtlSeconds = SESSION_TTL_SECONDS;
