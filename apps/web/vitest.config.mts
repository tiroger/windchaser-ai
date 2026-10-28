import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// "@" mirrors the tsconfig path alias. "server-only" throws outside a React
// server environment, so tests of server modules see an empty stand-in.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
});
