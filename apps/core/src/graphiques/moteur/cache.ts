// SPDX-License-Identifier: MIT
/** apps/core/src/graphiques/moteur/cache.ts — cache des options ECharts `<tmp>/elpis_charts/<compte>/<id>.json` : écriture au format que relisent `incrustation.ts` et `office` (port de chart_tools.py, persistance). */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { encoderUtf8Py, ErreurPython, intPy, pyJsonDumps } from "@elpis/commun";
import { pyPath } from "@elpis/config";

import { baseGraphiques, idGraphiqueSur, lireCacheGraphique, nomSur } from "../incrustation";

/** `_safe_username`. */
export const safeUsername = nomSur;

/** `_charts_base` : `CHART_CACHE_DIR`, sinon `<tmp>/elpis_charts`. */
export const chartsBase = baseGraphiques;

/** Nombre de configs gardées par compte (`TOOL_CHART_CACHE_MAX`, au moins 50 ; vide ou illisible : 1000). */
function chartCacheMax(): number {
  const brut = process.env["TOOL_CHART_CACHE_MAX"];
  try {
    return Math.max(50, brut ? Number(intPy(brut)) : 1000);
  } catch {
    return 1000;
  }
}

/** `Path.unlink()` dont l'échec est ignoré. */
function supprimerSiPresent(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    return;
  }
}

/** `_chmod_cross_writable` : 0700 (dossier) ou 0600 (fichier), sans suivre les liens, sans jamais échouer. */
function chmodPrive(p: string, dossier: boolean): void {
  try {
    if (lstatSync(p).isSymbolicLink()) return;
    chmodSync(p, dossier ? 0o700 : 0o600);
  } catch {
    return;
  }
}

/** `_charts_dir` : dossier du compte, créé au besoin, base et compte en 0700. */
export function chartsDir(username: string | null | undefined): string {
  const base = chartsBase();
  const d = `${pyPath(base)}/${safeUsername(username ?? "")}`;
  mkdirSync(d, { recursive: true });
  chmodPrive(base, true);
  chmodPrive(d, true);
  return d;
}

/** `_prune_charts` : supprime les configs les plus anciennes au-delà de `keep`. */
export function pruneCharts(d: string, keep: number = chartCacheMax()): void {
  try {
    const fichiers = readdirSync(d)
      .filter((nom) => nom.endsWith(".json"))
      .map((nom) => ({ nom, mtime: statSync(path.join(d, nom)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    for (const { nom } of fichiers.slice(0, keep === 0 ? 0 : Math.max(0, fichiers.length - keep)))
      supprimerSiPresent(path.join(d, nom));
  } catch {
    return;
  }
}

function jsonStrict(cfg: unknown, triee: boolean): string {
  try {
    return pyJsonDumps(cfg, { ensureAscii: false, sortKeys: triee, allowNan: false });
  } catch (e) {
    if (e instanceof RangeError)
      throw new ErreurPython("ValueError", "Out of range float values are not JSON compliant");
    throw e;
  }
}

/** `_save_chart_config` : écrit l'option (si absente) et rend son identifiant, les 12 premiers hexa du SHA-1 de sa forme triée ; ValueError (nombre non fini, texte non encodable) ou erreur du système de fichiers. */
export function saveChartConfig(cfg: unknown, username: string | null | undefined): string {
  const payload = jsonStrict(cfg, true);
  const chartId = createHash("sha1").update(encoderUtf8Py(payload)).digest("hex").slice(0, 12);
  const d = chartsDir(username);
  const chemin = path.join(d, `${chartId}.json`);
  if (!existsSync(chemin)) {
    const tmp = `${chemin}.tmp`;
    try {
      writeFileSync(tmp, encoderUtf8Py(jsonStrict(cfg, false)));
      renameSync(tmp, chemin);
    } catch (e) {
      supprimerSiPresent(tmp);
      throw e;
    }
    chmodPrive(chemin, false);
    pruneCharts(d);
  }
  return chartId;
}

/** Ressource `chart://<compte>/<id>` : texte de l'option, ou l'enveloppe `chart_not_found`. */
export function chartResource(username: string, chartId: string): string {
  const octets = lireCacheGraphique(safeUsername(username), idGraphiqueSur(chartId));
  if (octets === null) return pyJsonDumps({ ok: false, error: "chart_not_found", chart_id: chartId });
  return octets.toString("utf-8");
}
