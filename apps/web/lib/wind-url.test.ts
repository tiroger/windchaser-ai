import { describe, expect, it } from "vitest";

import { parseWindState, routePlannerHref, windHref } from "./wind-url";

const parse = (query: string) => parseWindState(new URLSearchParams(query));

describe("wind page URL state", () => {
  it("defaults to Segments mode with nothing selected", () => {
    expect(parse("")).toEqual({ mode: "segments", region: null, segment: null, day: null, route: null, start: null });
    expect(windHref({})).toBe("/");
    expect(parse("mode=segments").mode).toBe("segments");
  });

  it("round-trips a selected segment in a chosen region", () => {
    const href = windHref({ mode: "segments", region: "r1", segment: 229781 });
    expect(href).toBe("/?region=r1&segment=229781");
    expect(parse(href.slice(2))).toMatchObject({ mode: "segments", region: "r1", segment: 229781 });
  });

  it("round-trips a route's planner at a start on a day", () => {
    const href = routePlannerHref("2495066", "2026-10-31T09:00", "weekend");
    expect(href).toBe("/?mode=routes&day=weekend&route=2495066&start=2026-10-31T09%3A00");
    expect(parse(href.slice(2))).toEqual({
      mode: "routes",
      region: null,
      segment: null,
      day: "weekend",
      route: "2495066",
      start: "2026-10-31T09:00",
    });
  });

  it("writes only the current mode's keys, so a mode starts afresh", () => {
    const state = parse("mode=routes&route=9&start=2026-10-31T09:00&segment=5&region=r2");
    expect(windHref({ ...state, mode: "segments" })).toBe("/?region=r2&segment=5");
    expect(windHref({ ...state, mode: "routes", route: null })).toBe("/?mode=routes");
  });

  it("reads anything unrecognised as the default rather than failing", () => {
    expect(parse("mode=weather&segment=abc&day=someday&start=9am&route=../../x")).toEqual({
      mode: "segments",
      region: null,
      segment: null,
      day: null,
      route: null,
      start: null,
    });
  });
});
