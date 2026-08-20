import { dirname } from "path";
import { fileURLToPath } from "url";

import { FlatCompat } from "@eslint/eslintrc";
import { defineConfig, globalIgnores } from "eslint/config";

// eslint-config-next 15 ships a legacy eslintrc config with no flat-config
// subpath exports, unlike 16. FlatCompat bridges it.
const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const eslintConfig = defineConfig([
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored MapLibre worker bundle, copied from node_modules by
    // scripts-sync-maplibre.mjs. Not our source.
    "public/maplibre-gl-*.mjs",
  ]),
]);

export default eslintConfig;
