import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  discoverNear,
  discoveryNotice,
  DiscoveryUnavailableError,
  EXPLORE_RADIUS_KM,
  REFUSED_BACKOFF_MS,
  resetDiscovery,
} from "./discovery";

/** Google's reference polyline: three points, enough for a segment line. */
const LINE = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
const TOKEN = "access-token-that-must-never-be-logged";

type Call = { url: URL; auth: string | null };

function stravaStub(explore: (url: URL) => Response) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth });
    if (url.pathname === "/oauth/token") {
      return Response.json({ access_token: TOKEN, expires_at: Math.floor(Date.now() / 1000) + 21600 });
    }
    if (url.pathname === "/api/v3/segments/explore") return explore(url);
    const detail = url.pathname.match(/\/api\/v3\/segments\/(\d+)$/);
    if (detail) {
      return Response.json({
        id: Number(detail[1]),
        name: `Discovered ${detail[1]}`,
        distance: 1200,
        average_grade: 3,
        city: "Oakland",
        state: "CA",
        map: { polyline: LINE },
        athlete_segment_stats: {},
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  resetDiscovery();
  vi.stubEnv("STRAVA_CLIENT_ID", "1");
  vi.stubEnv("STRAVA_CLIENT_SECRET", "client-secret");
  vi.stubEnv("STRAVA_REFRESH_TOKEN", "refresh-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("discoverNear", () => {
  it("searches a box centred on the rider's position, not a region's centre", async () => {
    const calls = stravaStub(() => Response.json({ segments: [{ id: 41 }, { id: 42 }, { id: 43 }] }));
    const oakland: [number, number] = [37.8, -122.27];

    const found = await discoverNear(oakland, new Set([42]));

    const explore = calls.find((c) => c.url.pathname.endsWith("/segments/explore"))!;
    expect(explore.url.searchParams.get("activity_type")).toBe("riding");
    const [south, west, north, east] = explore.url.searchParams.get("bounds")!.split(",").map(Number);
    expect((south + north) / 2).toBeCloseTo(oakland[0], 6);
    expect((west + east) / 2).toBeCloseTo(oakland[1], 6);
    expect((north - south) / 2).toBeCloseTo(EXPLORE_RADIUS_KM / 111, 6);
    // A segment already known is skipped without a detail read.
    expect(found.map((s) => s.id)).toEqual([41, 43]);
    expect(found.every((s) => s.source === "discovered")).toBe(true);
    expect(calls.some((c) => c.url.pathname.endsWith("/segments/42"))).toBe(false);
  });

  it("serves a repeat in the same forecast cell from cache", async () => {
    const calls = stravaStub(() => Response.json({ segments: [{ id: 41 }] }));
    await discoverNear([37.8, -122.27], new Set());
    const before = calls.length;
    const again = await discoverNear([37.801, -122.271], new Set());
    expect(calls.length).toBe(before);
    expect(again.map((s) => s.id)).toEqual([41]);
  });

  it("logs a refusal with its class, status and Strava's message, never the token, then stands down", async () => {
    const calls = stravaStub(() =>
      Response.json({ message: "Authorization Error", errors: [] }, { status: 401 }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = Date.parse("2026-10-28T12:00:00Z");
    const clock = { now: () => now };

    const failure = await discoverNear([37.8, -122.27], new Set(), clock).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: "StravaApiError", status: 401, stravaMessage: "Authorization Error" });

    const line = logged.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(line).toContain("[discovery]");
    expect(line).toContain("StravaApiError status=401 path=/segments/explore message=Authorization Error");
    // The cell, not the rider's precise position, and nothing secret.
    expect(line).toContain("37.80,-122.30");
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain("refresh-token");
    expect(line).not.toContain("client-secret");
    expect(line).not.toContain("-122.27");
    expect(discoveryNotice(failure)).toBe(
      "Nearby segment discovery is unavailable: Strava refused the request (401, “Authorization Error”).",
    );

    // Asking again straight away would spend a read on the same refusal.
    const explores = () => calls.filter((c) => c.url.pathname.endsWith("/segments/explore")).length;
    const again = await discoverNear([37.8, -122.27], new Set(), clock).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(DiscoveryUnavailableError);
    expect(explores()).toBe(1);

    now += REFUSED_BACKOFF_MS + 1;
    await discoverNear([37.8, -122.27], new Set(), clock).catch(() => null);
    expect(explores()).toBe(2);
  });

  it("does not back off from a failure that may pass", async () => {
    const calls = stravaStub(() => new Response("upstream", { status: 502 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await discoverNear([37.8, -122.27], new Set()).catch(() => null);
    await discoverNear([37.8, -122.27], new Set()).catch(() => null);
    expect(calls.filter((c) => c.url.pathname.endsWith("/segments/explore")).length).toBe(2);
  });
});
