// SPDX-License-Identifier: MIT
// frontend/build-ssr.mjs — bundle CommonJS autonome du rendu ECharts serveur (frontend/dist/echarts-ssr.cjs), chargé par llm_core/tools/_office/echarts_ssr.cjs.
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const ici = (chemin) => fileURLToPath(new URL(chemin, import.meta.url));

await build({
  entryPoints: [ici("./src/features/chat/rendu/echarts-ssr.ts")],
  outfile: ici("./dist/echarts-ssr.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  legalComments: "none",
  logLevel: "warning",
});
