import { describe, expect, it } from "vitest";
import { safeEqual, sameOrigin } from "./security";

// Behind Amplify the request URL carries an internal host, never the public one.
const request = (headers: Record<string, string>) =>
  new Request("https://internal.lambda-url.example/api/admin/session", { method: "POST", headers });

describe("request security helpers", () => {
  it("trusts the browser's Sec-Fetch-Site header", () => {
    expect(sameOrigin(request({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(request({ "sec-fetch-site": "cross-site", origin: "https://dashboard.example" }))).toBe(false);
    expect(sameOrigin(request({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it("falls back to comparing Origin with the host the client addressed", () => {
    const forwarded = { "x-forwarded-host": "dashboard.example", host: "internal.lambda-url.example" };
    expect(sameOrigin(request({ ...forwarded, origin: "https://dashboard.example" }))).toBe(true);
    expect(sameOrigin(request({ ...forwarded, origin: "https://attacker.example" }))).toBe(false);
    expect(sameOrigin(request({ host: "dashboard.example", origin: "https://dashboard.example" }))).toBe(true);
  });

  it("rejects requests without either signal, and opaque origins", () => {
    expect(sameOrigin(request({ host: "dashboard.example" }))).toBe(false);
    expect(sameOrigin(request({ host: "dashboard.example", origin: "null" }))).toBe(false);
  });

  it("compares secrets of different lengths safely", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
    expect(safeEqual("secret", "secret-but-longer")).toBe(false);
  });
});
