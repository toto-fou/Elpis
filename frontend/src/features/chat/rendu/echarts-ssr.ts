// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/echarts-ssr.ts — entrée du bundle CommonJS `frontend/dist/echarts-ssr.cjs` : rendu SVG d'un graphique sans DOM, pour les outils docx/pptx. */
import * as echarts from "echarts";

import { HEIGHT, TOKENS, prepare, themeObject } from "./graphiques";
import type { OptionBrute } from "./graphiques";

export interface TacheRendu {
  option?: OptionBrute;
  width?: number;
  height?: number;
}

export type ResultatRendu = { svg: string } | { error: string };

// Police sans guillemets : le SVG serveur ne les échappe pas dans l'attribut style (XML refusé par LibreOffice).
const FONT = "Segoe UI, Liberation Sans, DejaVu Sans, Arial, sans-serif";

(globalThis as { echarts?: unknown }).echarts = echarts;
const theme = themeObject(TOKENS.light);
theme["textStyle"] = Object.assign({}, theme["textStyle"], { fontFamily: FONT });
echarts.registerTheme("elpis-light", theme);

export function renderOne(job: TacheRendu): ResultatRendu {
  const raw: OptionBrute = job.option || {};
  const kind = raw._elpis?.kind ?? "";
  const width = job.width || 640;
  const height = job.height || Math.round((width * (HEIGHT[kind] || 360)) / 640);
  const chart = echarts.init(null, "elpis-light", { renderer: "svg", ssr: true, width, height });
  try {
    const o = prepare(raw, {});
    o["animation"] = false;
    delete o["dataZoom"];
    delete o["toolbox"];
    o["backgroundColor"] = TOKENS.light.surface;
    chart.setOption(o);
    return { svg: chart.renderToSVGString() };
  } catch (e) {
    return { error: String((e instanceof Error && e.message) || e) };
  } finally {
    chart.dispose();
  }
}
