// MapLibre's worker is an ES module that imports a sibling shared chunk, so both
// files must sit next to each other under /public. Kept in sync with the
// installed version by predev/prebuild.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("public", { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(`node_modules/maplibre-gl/dist/${f}`, `public/${f}`);
  console.log("synced", f);
}
