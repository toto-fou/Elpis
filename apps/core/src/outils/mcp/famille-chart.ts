// SPDX-License-Identifier: MIT
/** apps/core/src/outils/mcp/famille-chart.ts — famille `chart` servie en processus : 30 outils `chart_<type>` et ressource `chart://` (port de llm_core/tools/chart_tools.py). */
import {
  egalPy,
  ErreurPython,
  estDict,
  intPy,
  messageErreurOs,
  pyJsonDumps,
  stripPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { py } from "@elpis/http";
import type { SchemaPy } from "@elpis/http";
import {
  err,
  getChatId,
  getUsername,
  ok,
  outilDuGolden,
  safeUsername as safeUsernameToolkit,
  tokenIdentity,
} from "@elpis/outils-mcp";
import type {
  ContexteAppel,
  DefinitionOutil,
  DefinitionRessource,
  FamilleAEnregistrer,
  Golden,
} from "@elpis/outils-mcp";
import golden from "@elpis/outils-mcp/goldens/chart.json" with { type: "json" };

import {
  chartResource,
  PARAM_DEFAULTS,
  PER_TYPE,
  runChart,
  safeUsername,
  saveChartConfig,
} from "../../graphiques/moteur/index";

export const MAX_ROWS_DEFAUT = 10000;
export const MAX_CELLS_DEFAUT = 60000;

/** `max(1, int(os.environ.get(nom, défaut) or défaut))` ; une valeur illisible donne le défaut (Python ne démarrerait pas). */
function entierEnv(nom: string, defaut: number): number {
  try {
    return Math.max(1, Number(intPy(stripPy(process.env[nom] ?? "") || defaut)));
  } catch {
    return defaut;
  }
}

/** `MAX_ROWS` et `MAX_CELLS` (`TOOL_CHART_MAX_ROWS`, `TOOL_CHART_MAX_CELLS`), lus à l'appel. */
export function limites(): { rows: number; cells: number } {
  return {
    rows: entierEnv("TOOL_CHART_MAX_ROWS", MAX_ROWS_DEFAUT),
    cells: entierEnv("TOOL_CHART_MAX_CELLS", MAX_CELLS_DEFAUT),
  };
}

/** `_too_big` : tableau de plus de `rows` lignes ou de plus de `cells` cellules (toute autre forme passe au moteur). */
export function tooBig(
  data: unknown,
  rows: number = limites().rows,
  cells: number = limites().cells,
): boolean {
  if (!Array.isArray(data)) return false;
  if (data.length > rows) return true;
  let total = 0;
  for (const ligne of data) if (estDict(ligne)) total += Object.keys(ligne).length;
  return total > cells;
}

/** `str(OSError)` d'une erreur du système de fichiers de Node (`'source' -> 'cible'` pour un renommage). */
function messageOs(e: Error): string {
  const { path: chemin, dest } = e as Error & { path?: unknown; dest?: unknown };
  const base = messageErreurOs(e, typeof chemin === "string" ? chemin : "");
  return typeof dest === "string" ? `${base} -> '${dest}'` : base;
}

function estErreurOs(e: unknown): e is Error {
  const code = (e as { code?: unknown } | null)?.code;
  return e instanceof Error && typeof code === "string" && /^E[A-Z0-9]+$/u.test(code);
}

/** `_finish` : refus des tableaux trop grands, moteur, sauvegarde de l'option, puis `ref` pour le modèle. */
export function finish(kind: string, args: Dict, ctx: ContexteAppel | null): Dict {
  const username = getUsername(ctx);
  const session = `${username}:${getChatId(ctx)}`;
  const { rows, cells } = limites();
  if (tooBig(args["data"], rows, cells))
    return err("invalid_chart_spec", `data is too large (max ${rows} rows / ${cells} cells)`, {
      fix: "Aggregate or downsample the rows before charting.",
    });
  const [result, option] = runChart({ type: kind, ...args }, session);
  if (!veritePy(result["ok"])) return result;
  let chartId: string;
  try {
    chartId = saveChartConfig(option, username);
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "ValueError")
      return err("invalid_chart_spec", "chart contains non-finite numbers (NaN/Infinity)", {
        fix: "All numeric values must be finite.",
      });
    if (estErreurOs(e))
      return err("chart_write_failed", `Could not save the chart: ${messageOs(e)}`, {
        fix:
          "Retry; if it persists, an admin should check that the chart " +
          "cache directory is writable by the tool process.",
      });
    throw e;
  }
  const { ok: _ok, ...reste } = result;
  return ok({ ref: `!${chartId}`, chart_id: chartId, ...reste });
}

const BOOLEENS = new Set(["horizontal", "show_values", "trend"]);

/** Signature Python de `chart_<type>` : `data` requis, `title: str`, trois booléens, le reste `Any` (lecture tolérante du moteur). */
function signatureChart(options: readonly string[]): Record<string, SchemaPy<unknown>> {
  const signature: Record<string, SchemaPy<unknown>> = { data: py.any(), title: py.str().defaut("") };
  for (const nom of options)
    signature[nom] = BOOLEENS.has(nom)
      ? py.bool().defaut(PARAM_DEFAULTS[nom] as boolean)
      : py.any().defaut(PARAM_DEFAULTS[nom]);
  return signature;
}

/** Seuls les arguments réellement donnés partent au moteur (une valeur par défaut produirait des « corrections » parasites) ; les `Any` gardent leur forme reçue. */
function argumentsMoteur(noms: readonly string[], valeurs: Dict, brut: Dict): Dict {
  const args: Dict = {};
  for (const nom of noms) {
    const reçu = !BOOLEENS.has(nom) && nom !== "title" && Object.hasOwn(brut, nom);
    const v = reçu ? brut[nom] : valeurs[nom];
    if (Object.hasOwn(PARAM_DEFAULTS, nom) && egalPy(v, PARAM_DEFAULTS[nom])) continue;
    if (v !== null && v !== undefined) args[nom] = v;
  }
  return args;
}

/** Les 30 outils `chart_<type>`, définitions figées par le golden. */
export function outilsChart(): DefinitionOutil[] {
  return [...PER_TYPE].map(([kind, [, , options]]) => {
    const signature = signatureChart(options);
    const noms = Object.keys(signature);
    return outilDuGolden(golden as unknown as Golden, `chart_${kind}`, {
      signature,
      motsClesSeuls: true,
      traiter: (valeurs, ctx, brut) => finish(kind, argumentsMoteur(noms, valeurs, brut), ctx),
    });
  });
}

/** Ressource `chart://<compte>/<id>` : un jeton client ne lit que les graphiques de son compte (écart « plus strict »). */
function lireGraphique(username: string, chartId: string): string {
  const proprietaire = tokenIdentity();
  if (proprietaire && safeUsername(safeUsernameToolkit(proprietaire)) !== safeUsername(username))
    return pyJsonDumps({ ok: false, error: "chart_not_found", chart_id: chartId });
  return chartResource(username, chartId);
}

export function ressourcesChart(): DefinitionRessource[] {
  return [
    {
      nom: "chart_resource",
      modele: "chart://{username}/{chart_id}",
      description: "A previously generated chart option (ECharts), as JSON.",
      mimeType: "application/json",
      tags: ["chart"],
      lire: (p) => lireGraphique(p["username"] ?? "", p["chart_id"] ?? ""),
    },
  ];
}

/** La famille `chart` pour une vague d'enregistrement sur le serveur MCP en processus de main. */
export function familleChart(): FamilleAEnregistrer {
  return ["chart", outilsChart(), ressourcesChart()];
}
