import "server-only";

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * JSON that browsers must revalidate on every use. The ETag is a hash of the
 * body, so an unchanged response costs an empty 304, and any change, whether
 * new data or a deploy that alters it, is seen immediately rather than after
 * a cache lifetime.
 */
export function revalidatedJson(request: Request, body: unknown): Response {
  const text = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(text).digest("base64url").slice(0, 27)}"`;
  const headers = { "Cache-Control": "no-cache", ETag: etag };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new NextResponse(text, { headers: { ...headers, "Content-Type": "application/json" } });
}
