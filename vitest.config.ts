import { defineConfig } from "vitest/config";

// Separate from vite.config.ts: that file's `server.port`/`strictPort`
// settings exist purely for Tauri's fixed-port dev server contract and have
// no meaning for a test run, so keeping the test config standalone avoids
// pulling in Tauri-specific wiring plain unit tests don't need.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
