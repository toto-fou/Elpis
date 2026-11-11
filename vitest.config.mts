// SPDX-License-Identifier: MIT
/** vitest.config.mts — tests TypeScript de l'espace de travail : projet core (apps/*, packages/*) et projet web (frontend/). */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      {
        test: {
          name: "core",
          include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
          environment: "node",
          globalSetup: ["./vitest.mise-en-place.mts"],
          setupFiles: ["./vitest.garde-travail.mts"],
          testTimeout: 20_000,
        },
      },
      "./frontend/vitest.config.mts",
    ],
  },
});
