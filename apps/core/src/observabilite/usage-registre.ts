// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/usage-registre.ts — registre d'usage LLM, une ligne par tour : écriture best-effort, agrégats bornés dans le temps, purge (shared_infra/observability/usage_store.py). */
import {
  arrondiPy,
  estErreurPython,
  FlottantPy,
  floatPy,
  intPy,
  maxPy,
  minPy,
  prefixePy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import { greatest } from "@elpis/db";
import type { Dialecte, Executeur, Ligne, Valeur } from "@elpis/db";

import { journal } from "../journal";

const log = journal("usage");

/** Dimensions de regroupement autorisées : aucun nom de colonne ne vient d'ailleurs. */
export const GROUP_COLUMNS: Readonly<Record<string, string>> = {
  user_id: "user_id",
  source: "source",
  model: "model",
  status: "status",
  path: "path",
  connector: "connector",
};

/** Métriques agrégeables et leur expression SQL (réflexion ⊆ sortie, cache ⊆ entrée). */
export function metricExpr(metrique: string, d: Dialecte): string | undefined {
  const exprs: Readonly<Record<string, string>> = {
    tokens: "COALESCE(SUM(input_tokens + output_tokens), 0)",
    input: "COALESCE(SUM(input_tokens), 0)",
    output: "COALESCE(SUM(output_tokens), 0)",
    thinking: "COALESCE(SUM(thinking_tokens), 0)",
    response: `COALESCE(SUM(${greatest(["output_tokens - thinking_tokens", "0"], d)}), 0)`,
    cache: "COALESCE(SUM(cache_read_tokens), 0)",
    input_new: `COALESCE(SUM(${greatest(["input_tokens - cache_read_tokens", "0"], d)}), 0)`,
    turns: "COUNT(*)",
    duration_ms: "COALESCE(SUM(duration_ms), 0)",
    iterations: "COALESCE(SUM(iterations), 0)",
  };
  return Object.hasOwn(exprs, metrique) ? exprs[metrique] : undefined;
}

/** `_int` : `int(v or 0)` borné à zéro, une valeur illisible vaut 0. */
export function entierPositif(v: unknown): number {
  let n: number;
  try {
    n = intPy(veritePy(v) ? v : 0);
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return 0;
    throw e;
  }
  return n > 0 ? n : 0;
}

export interface Decoupe {
  input: number;
  cache: number;
  input_new: number;
  cache_creation: number;
  tools: number;
  output: number;
  thinking: number;
  response: number;
  cache_pct: FlottantPy;
}

/** `token_breakdown` : entrée = cache + utile (outils compris), sortie = réflexion + réponse, part du cache en % de l'entrée. */
export function tokenBreakdown(
  inputTokens: unknown = 0,
  outputTokens: unknown = 0,
  o: {
    cacheReadTokens?: unknown;
    cacheCreationTokens?: unknown;
    thinkingTokens?: unknown;
    toolTokens?: unknown;
  } = {},
): Decoupe {
  const inp = entierPositif(inputTokens);
  const out = entierPositif(outputTokens);
  const cache = minPy(entierPositif(o.cacheReadTokens ?? 0), inp);
  const tools = minPy(entierPositif(o.toolTokens ?? 0), inp);
  const think = minPy(entierPositif(o.thinkingTokens ?? 0), out);
  return {
    input: inp,
    cache,
    input_new: inp - cache,
    cache_creation: entierPositif(o.cacheCreationTokens ?? 0),
    tools,
    output: out,
    thinking: think,
    response: out - think,
    cache_pct: new FlottantPy(inp ? arrondiPy((100.0 * cache) / inp, 1) : 0.0),
  };
}

export interface LigneUsage {
  userId?: unknown;
  source?: string | null;
  originId?: unknown;
  parentId?: unknown;
  model?: unknown;
  connector?: unknown;
  path?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  submittedTokens?: unknown;
  thinkingTokens?: unknown;
  toolTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  durationMs?: unknown;
  iterations?: unknown;
  status?: string | null;
  errorKind?: unknown;
  ts?: number | null;
  runId?: unknown;
}

function texte(v: unknown): string {
  return veritePy(v) ? strPy(v) : "";
}

/** `record_usage` : un tour sans jeton ni erreur n'est pas enregistré ; best-effort, faux au lieu de lever. */
export async function recordUsage(x: Executeur, l: LigneUsage): Promise<boolean> {
  const inT = entierPositif(l.inputTokens ?? 0);
  const outT = entierPositif(l.outputTokens ?? 0);
  const thinkT = outT
    ? minPy(entierPositif(l.thinkingTokens ?? 0), outT)
    : entierPositif(l.thinkingTokens ?? 0);
  const st = stripPy(l.status || "ok") || "ok";
  if (inT === 0 && outT === 0 && st === "ok") return false;
  let uid: number | null;
  try {
    uid = l.userId === null || l.userId === undefined ? null : intPy(l.userId);
  } catch (e) {
    if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    uid = null;
  }
  try {
    await x.run(
      "INSERT INTO usage_events(ts, user_id, source, origin_id, parent_id, model, connector, path, " +
        "input_tokens, output_tokens, submitted_tokens, thinking_tokens, cache_read_tokens, " +
        "cache_creation_tokens, duration_ms, iterations, status, error_kind, run_id, tool_tokens) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        floatPy(l.ts ?? Date.now() / 1000),
        uid,
        stripPy(l.source || "unknown") || "unknown",
        texte(l.originId),
        texte(l.parentId),
        texte(l.model),
        texte(l.connector),
        texte(l.path),
        inT,
        outT,
        entierPositif(l.submittedTokens ?? 0),
        thinkT,
        entierPositif(l.cacheReadTokens ?? 0),
        entierPositif(l.cacheCreationTokens ?? 0),
        entierPositif(l.durationMs ?? 0),
        entierPositif(l.iterations ?? 0),
        st,
        prefixePy(texte(l.errorKind), 120),
        prefixePy(texte(l.runId), 191),
        minPy(entierPositif(l.toolTokens ?? 0), inT),
      ],
    );
    return true;
  } catch (e) {
    log.debug({ err: e }, "[usage] record_usage failed (non-fatal)");
    return false;
  }
}

export type FiltresUsage = Readonly<Record<string, Valeur | readonly Valeur[] | undefined>>;

/** `_where` : fenêtre `ts > since` (`<= until`), filtres limités aux dimensions connues. */
function clauseWhere(
  since: number,
  until: number | null | undefined,
  filtres: FiltresUsage,
): [string, Valeur[]] {
  const sql = ["ts > ?"];
  const params: Valeur[] = [floatPy(since)];
  if (until !== null && until !== undefined) {
    sql.push("ts <= ?");
    params.push(floatPy(until));
  }
  for (const [cle, val] of Object.entries(filtres)) {
    if (val === null || val === undefined || !Object.hasOwn(GROUP_COLUMNS, cle)) continue;
    if (Array.isArray(val)) {
      if (!val.length) continue;
      sql.push(`${GROUP_COLUMNS[cle]} IN (${val.map(() => "?").join(",")})`);
      params.push(...(val as Valeur[]));
    } else {
      sql.push(`${GROUP_COLUMNS[cle]} = ?`);
      params.push(val as Valeur);
    }
  }
  return [sql.join(" AND "), params];
}

function entier(v: unknown): number {
  return intPy(veritePy(v) ? v : 0);
}

/** `usage_totals` : tokens, tours, échecs, cache et durée sur la fenêtre, plus total, réponse et entrée utile dérivés. */
export async function usageTotals(
  x: Executeur,
  since: number,
  until: number | null = null,
  filtres: FiltresUsage = {},
): Promise<Ligne> {
  const [where, params] = clauseWhere(since, until, filtres);
  const row = await x.get(
    `SELECT COUNT(*) AS turns,
                   COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
                   COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
                   COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                   COALESCE(SUM(tool_tokens), 0)   AS tool_tokens,
                   COALESCE(SUM(duration_ms), 0)   AS duration_ms,
                   COALESCE(SUM(iterations), 0)    AS iterations,
                   COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS failures,
                   COUNT(DISTINCT user_id)         AS users
            FROM usage_events WHERE ${where}`,
    params,
  );
  const out: Ligne = { ...(row ?? {}) };
  const lu = (cle: string): number => entier(Object.hasOwn(out, cle) ? out[cle] : 0);
  out["total_tokens"] = lu("input_tokens") + lu("output_tokens");
  out["response_tokens"] = maxPy(0, lu("output_tokens") - lu("thinking_tokens"));
  out["input_new_tokens"] = maxPy(0, lu("input_tokens") - lu("cache_read_tokens"));
  return out;
}

/** `usage_cache_totals` : cache lu, cache créé et entrée totale (le cache lu est compris dans l'entrée). */
export async function usageCacheTotals(
  x: Executeur,
  since: number,
  until: number | null = null,
  filtres: FiltresUsage = {},
): Promise<{ cache_read_tokens: number; cache_creation_tokens: number; input_total: number }> {
  const t = await usageTotals(x, since, until, filtres);
  return {
    cache_read_tokens: entier(t["cache_read_tokens"]),
    cache_creation_tokens: entier(t["cache_creation_tokens"]),
    input_total: entier(t["input_tokens"]),
  };
}

/** `usage_group` : top `limit` d'une dimension trié par `metric` décroissant, avec tours et tokens de chaque groupe. */
export async function usageGroup(
  x: Executeur,
  dimension: string,
  since: number,
  until: number | null = null,
  o: { metric?: string; limit?: number; filtres?: FiltresUsage } = {},
): Promise<Ligne[]> {
  const col = Object.hasOwn(GROUP_COLUMNS, dimension) ? GROUP_COLUMNS[dimension] : undefined;
  const expr = metricExpr(o.metric ?? "tokens", x.dialecte);
  if (!col || !expr) return [];
  const [where, params] = clauseWhere(since, until, o.filtres ?? {});
  return x.all(
    `SELECT ${col} AS "key",
                   ${expr} AS value,
                   COUNT(*) AS turns,
                   COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                   COALESCE(SUM(input_tokens), 0) AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                   COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
                   COALESCE(SUM(duration_ms), 0) AS duration_ms,
                   COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS failures
            FROM usage_events WHERE ${where}
            GROUP BY ${col} ORDER BY value DESC LIMIT ?`,
    [...params, maxPy(1, intPy(o.limit ?? 10))],
  );
}

/** `delete_usage_events` : supprime la fenêtre demandée, toute la table sans bornes ; rend le nombre de lignes. */
export async function deleteUsageEvents(
  x: Executeur,
  fromTs: number | null = null,
  toTs: number | null = null,
): Promise<number> {
  const sql = ["1=1"];
  const params: Valeur[] = [];
  if (fromTs !== null) {
    sql.push("ts >= ?");
    params.push(floatPy(fromTs));
  }
  if (toTs !== null) {
    sql.push("ts <= ?");
    params.push(floatPy(toTs));
  }
  const r = await x.run(`DELETE FROM usage_events WHERE ${sql.join(" AND ")}`, params);
  return r.changes || 0;
}

/** `purge_usage_events` : rétention de la maintenance, `<= 0` désactive ; ne lève jamais. */
export async function purgeUsageEvents(x: Executeur, retentionDays = 90): Promise<number> {
  if (retentionDays <= 0) return 0;
  try {
    const n = await deleteUsageEvents(x, null, Date.now() / 1000 - retentionDays * 86400);
    if (n) log.info(`[maintenance] ${n} usage_events purgé(s) (>${retentionDays}j).`);
    return n;
  } catch (e) {
    log.debug({ err: e }, "[maintenance] purge_usage_events failed (non-fatal)");
    return 0;
  }
}
