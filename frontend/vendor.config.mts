// SPDX-License-Identifier: MIT
/** frontend/vendor.config.mts — bundles UMD chargés à la demande (`ensureVendor`) : fichiers des paquets npm, émis hachés par Vite. */
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

/** Clé `vendor/…` (celle de frontend/src/platform/vendor.ts) → paquet npm et fichier distribué, copié tel quel. */
export const VENDOR_NPM: Readonly<Record<string, readonly [paquet: string, fichier: string]>> = {
  "vendor/mermaid.min.js": ["mermaid", "dist/mermaid.min.js"],
  "vendor/highlight.min.js": ["@highlightjs/cdn-assets", "highlight.min.js"],
  "vendor/chart.js": ["chart.js", "dist/chart.umd.js"],
  "vendor/chartjs-adapter-date-fns.bundle.min.js": [
    "chartjs-adapter-date-fns",
    "dist/chartjs-adapter-date-fns.bundle.min.js",
  ],
  "vendor/chartjs-plugin-datalabels.min.js": [
    "chartjs-plugin-datalabels",
    "dist/chartjs-plugin-datalabels.min.js",
  ],
  "vendor/chartjs-plugin-annotation.min.js": [
    "chartjs-plugin-annotation",
    "dist/chartjs-plugin-annotation.min.js",
  ],
  "vendor/chartjs-chart-treemap.min.js": ["chartjs-chart-treemap", "dist/chartjs-chart-treemap.min.js"],
  "vendor/chartjs-chart-sankey.min.js": ["chartjs-chart-sankey", "dist/chartjs-chart-sankey.min.js"],
  "vendor/chartjs-chart-matrix.min.js": ["chartjs-chart-matrix", "dist/chartjs-chart-matrix.min.js"],
  "vendor/chartjs-chart-boxplot.umd.min.js": ["@sgratzl/chartjs-chart-boxplot", "build/index.umd.min.js"],
  "vendor/chartjs-chart-financial.js": ["chartjs-chart-financial", "dist/chartjs-chart-financial.js"],
  "vendor/echarts.min.js": ["echarts", "dist/echarts.min.js"],
  "vendor/echarts-langFR.js": ["echarts", "i18n/langFR.js"],
};

const ICI = dirname(fileURLToPath(import.meta.url));
const MODULE = "virtual:elpis-vendor";

/** Dossier d'un paquet installé, cherché comme Node (node_modules des parents) sans passer par son champ `exports`. */
export function dossierPaquet(paquet: string, depuis = ICI): string {
  for (let d = depuis; ; d = dirname(d)) {
    const candidat = join(d, "node_modules", paquet);
    if (existsSync(join(candidat, "package.json"))) return candidat;
    if (dirname(d) === d) throw new Error(`paquet npm introuvable : ${paquet}`);
  }
}

/** `virtual:elpis-vendor` : carte clé historique → URL de l'asset haché, sans inclure le code dans l'entrée. */
export function vendorElpis(): Plugin {
  const resolu = join(ICI, "virtual-elpis-vendor.js");
  return {
    name: "elpis-vendor",
    resolveId: (id) => (id === MODULE ? resolu : null),
    load(id) {
      if (id !== resolu) return null;
      const cles = Object.keys(VENDOR_NPM);
      const imports = cles.map((cle, i) => {
        const [paquet, fichier] = VENDOR_NPM[cle] ?? ["", ""];
        const chemin = relative(ICI, join(dossierPaquet(paquet), fichier))
          .split("\\")
          .join("/");
        return `import u${i} from ${JSON.stringify("./" + chemin + "?url")};`;
      });
      const carte = cles.map((cle, i) => `  ${JSON.stringify(cle)}: u${i},`);
      return `${imports.join("\n")}\nexport default {\n${carte.join("\n")}\n};\n`;
    },
  };
}
