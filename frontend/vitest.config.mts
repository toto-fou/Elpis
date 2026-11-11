// SPDX-License-Identifier: MIT
/** frontend/vitest.config.mts — projet Vitest « web » : modules et SFC du frontend sous happy-dom (Q11). */
import { defineProject, mergeConfig } from "vitest/config";

import vite from "./vite.config.mts";

export default mergeConfig(
  vite,
  defineProject({
    test: {
      name: "web",
      root: import.meta.dirname,
      include: ["test/**/*.test.ts"],
      environment: "happy-dom",
      setupFiles: ["test/preparation-dom.ts"],
      // Aucun serveur sous les tests : une iframe (aperçu du chat, de l'éditeur) ne charge pas sa page.
      environmentOptions: { happyDOM: { settings: { disableIframePageLoading: true } } },
    },
  }),
);
