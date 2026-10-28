import { NextResponse } from "next/server";

import {
  adminCookieName,
  createAdminCookie,
  ownerModeActive,
  verifyAdminPassphrase,
} from "@/lib/training/admin-session";
import { sameOrigin } from "@/lib/training/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner mode. POST exchanges the passphrase for a signed HTTP-only cookie;
 * DELETE clears it. Both refuse cross-site requests: SameSite=Strict already
 * keeps the cookie off them, and the Sec-Fetch-Site check stops a page
 * elsewhere from even attempting a passphrase guess through a visitor.
 */
export async function GET() {
  return NextResponse.json({ authenticated: await ownerModeActive() });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Same-origin request required" }, { status: 403 });
  }

  let passphrase: unknown;
  try {
    ({ passphrase } = await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof passphrase !== "string" || passphrase.length < 1 || passphrase.length > 256) {
    return NextResponse.json({ error: "Invalid passphrase" }, { status: 400 });
  }

  let session: { value: string; maxAge: number };
  try {
    if (!(await verifyAdminPassphrase(passphrase))) {
      return NextResponse.json({ error: "Incorrect passphrase" }, { status: 401 });
    }
    session = await createAdminCookie();
  } catch (error) {
    // No secret configured (local development) or Secrets Manager unreachable.
    console.error("[training] owner mode unavailable", error);
    return NextResponse.json({ error: "Owner mode is not available here" }, { status: 503 });
  }

  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(adminCookieName, session.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: session.maxAge,
  });
  return response;
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Same-origin request required" }, { status: 403 });
  }
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(adminCookieName, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
