import assert from "node:assert/strict";
import { test } from "vitest";

import { localToEpoch } from "./route-forecast";

test("forecast wall-clock times convert across a daylight-saving change", () => {
  // Pacific Daylight Time before 1 November 2026, Standard after.
  assert.equal(localToEpoch("2026-10-31T09:00", "America/Los_Angeles", -25200), Date.parse("2026-10-31T16:00:00Z") / 1000);
  assert.equal(localToEpoch("2026-11-02T09:00", "America/Los_Angeles", -25200), Date.parse("2026-11-02T17:00:00Z") / 1000);
  assert.equal(localToEpoch("2026-07-01T00:00", "UTC", 0), Date.parse("2026-07-01T00:00:00Z") / 1000);
});
