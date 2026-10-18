// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/index.ts — moteur des outils graphiques `chart_<type>` : appel tolérant → option ECharts, garde-fou anti-boucle (port de _chart/__init__.py). */
import { createHash } from "node:crypto";

import { encoderUtf8Py, pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { compileOption } from "./compile-echarts";
import type { Opt } from "./compile-echarts";
import { buildSpec, SpecError } from "./spec";

export { PARAM_DEFAULTS, PARAM_SCHEMAS, PER_TYPE, ROW_SCHEMA, toolDescription } from "./parametres";
export { compileOption, echapperHtml } from "./compile-echarts";
export type { Opt } from "./compile-echarts";
export { buildSpec, SpecError } from "./spec";
export { chartResource, chartsBase, chartsDir, pruneCharts, saveChartConfig, safeUsername } from "./cache";

const REFUS = new Map<string, number>();
const REFUS_MAX = 4096;

/** Vide la mémoire des refus (tests). */
export function reinitialiserRefus(): void {
  REFUS.clear();
}

function empreinte(session: string, args: unknown): string {
  const canon = pyJsonDumps(args, { ensureAscii: false, sortKeys: true });
  return createHash("sha1")
    .update(encoderUtf8Py(`${session}\x00${canon}`))
    .digest("hex");
}

/** `_refus` : note un refus ; au 2e envoi identique, le dit en toutes lettres (partagé avec les outils Office). */
export function refus(
  session: string | null | undefined,
  args: unknown,
  out: Dict,
  nextAction?: string,
): Dict {
  if (!session) return out;
  const k = empreinte(session, args);
  const n = (REFUS.get(k) ?? 0) + 1;
  REFUS.delete(k);
  REFUS.set(k, n);
  while (REFUS.size > REFUS_MAX) {
    const plusAncien = REFUS.keys().next();
    if (plusAncien.done) break;
    REFUS.delete(plusAncien.value);
  }
  if (n >= 2) {
    out["error"] = "repeated_call";
    out["repeated"] = n;
    out["message"] =
      `SAME call as before, already refused ${n - 1} time(s) for the same reason: do not send it again ` +
      `unchanged. ${out["message"] ?? ""}`;
    out["next_action"] =
      nextAction ||
      "Change the call as `fix` says (use `example` as a model), or tell the user what is missing and answer without a chart.";
  }
  return out;
}

/** Résultat d'un appel : retour pour le modèle, option ECharts (null si refus) et type tracé. */
export type ResultatGraphique = [Dict, Opt | null, string | null];

/** `run_chart` : exécute un appel ; le retour d'échec suit l'enveloppe d'Elpis (`ok/error/message/fix`) complétée de `example`. */
export function runChart(
  args: Dict,
  session?: string | null,
  maintenant: Date = new Date(),
): ResultatGraphique {
  let option: Opt;
  let summary: string;
  let kind: string;
  let fixes: string[];
  let warnings: string[];
  try {
    const spec = buildSpec(args);
    [option, summary] = compileOption(spec, maintenant);
    kind = spec.kind;
    fixes = spec.notes.fixes;
    warnings = spec.notes.warnings;
  } catch (e) {
    if (!(e instanceof SpecError)) throw e;
    const out: Dict = { ok: false, error: "invalid_chart_spec", message: e.message };
    if (e.fix) out["fix"] = e.fix;
    if (e.example !== null && e.example !== undefined) out["example"] = { data: e.example };
    return [refus(session, args, out), null, null];
  }
  const result: Dict = { ok: true, summary, chart_type: kind };
  if (fixes.length > 0) result["fixes"] = fixes;
  if (warnings.length > 0) result["warnings"] = warnings;
  return [result, option, kind];
}
