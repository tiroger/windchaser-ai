import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/training/admin-session", () => ({
  adminCookieName: "windchaser-owner",
  ownerModeActive: async () => false,
  verifyAdminPassphrase: async (passphrase: string) => passphrase === "correct horse battery",
  createAdminCookie: async () => ({ value: "123.signature", maxAge: 60 }),
}));

const { POST } = await import("./route");

function attempt(passphrase: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  return POST(
    new Request("http://localhost/api/training/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ passphrase }),
    }),
  );
}

describe("owner sign-in", () => {
  it("refuses cross-site attempts before counting them", async () => {
    expect((await attempt("guess", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("stops accepting guesses once the attempt limit is spent", async () => {
    expect((await attempt("correct horse battery")).status).toBe(200);
    for (let i = 0; i < 19; i++) expect((await attempt(`guess ${i}`)).status).toBe(401);
    const blocked = await attempt("correct horse battery");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
