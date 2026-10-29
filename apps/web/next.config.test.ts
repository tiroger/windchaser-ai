import { expect, test } from "vitest";

import config from "./next.config";

test("the retired Training Segments page redirects to the wind page's Segments mode", async () => {
  const redirects = await config.redirects!();
  expect(redirects).toContainEqual({
    source: "/training/segments",
    destination: "/?mode=segments",
    permanent: true,
  });
});
