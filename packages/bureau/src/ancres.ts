// SPDX-License-Identifier: MIT
/** packages/bureau/src/ancres.ts — mémoire inter-session des ancres résolues (requête → auto_id stable), best-effort de bout en bout (shared_infra/desktop/anchors.py). */
import { floatPy, intPy, lowerPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Base, Executeur } from "@elpis/db";
import { noLimit } from "@elpis/db";

import type { AncreEpinglee, PortAncres } from "./ports";

const ttlEnv = process.env["APP_ACTION_CACHE_TTL_S"] ?? "";

/** TTL généreux (30 j) : n'évince que les ancres vraiment anciennes ; `APP_ACTION_CACHE_TTL_S`. */
export const REGLAGES_ANCRES = { ttlS: ttlEnv ? floatPy(ttlEnv) : 30 * 86400 };

const maintenant = (): number => Date.now() / 1000;

/** `record_action_anchor` : UPSERT de l'ancre pour (scope, requête) ; rien sans auto_id ni requête, aucune erreur ne remonte. */
export async function recordActionAnchor(
  x: Executeur,
  scope: string,
  queryNorm: string,
  autoId: unknown,
  role: unknown = "",
  center: unknown = null,
): Promise<void> {
  const aid = stripPy(veritePy(autoId) ? strPy(autoId) : "");
  if (!aid || !stripPy(veritePy(queryNorm) ? strPy(queryNorm) : "")) return;
  let cx: number | null = null;
  let cy: number | null = null;
  if (Array.isArray(center) && center.length >= 2) {
    try {
      [cx, cy] = [intPy(center[0]), intPy(center[1])];
    } catch {
      [cx, cy] = [null, null];
    }
  }
  try {
    await x.run(
      "INSERT INTO editor_action_cache(scope, query_norm, auto_id, role, " +
        "center_x, center_y, hits, updated_at) VALUES(?,?,?,?,?,?,1,?) " +
        "ON CONFLICT(scope, query_norm) DO UPDATE SET " +
        "auto_id=excluded.auto_id, role=excluded.role, " +
        "center_x=excluded.center_x, center_y=excluded.center_y, " +
        "hits=editor_action_cache.hits+1, updated_at=excluded.updated_at",
      [
        strPy(scope),
        lowerPy(stripPy(strPy(queryNorm))),
        aid,
        veritePy(role) ? strPy(role) : "",
        cx,
        cy,
        maintenant(),
      ],
    );
  } catch {
    return;
  }
}

/** `lookup_action_anchor` : ancre épinglée `{auto_id, role, center}` ou `null` (absente, vide, plus vieille que le TTL, base en panne). */
export async function lookupActionAnchor(
  x: Executeur,
  scope: string,
  queryNorm: string,
): Promise<AncreEpinglee | null> {
  if (!stripPy(veritePy(queryNorm) ? strPy(queryNorm) : "")) return null;
  let l: Record<string, unknown> | undefined;
  try {
    l = await x.get(
      "SELECT auto_id, role, center_x, center_y, updated_at FROM editor_action_cache WHERE scope=? AND query_norm=?",
      [strPy(scope), lowerPy(stripPy(strPy(queryNorm)))],
    );
  } catch {
    return null;
  }
  if (!l || !veritePy(l["auto_id"])) return null;
  const date = l["updated_at"];
  const perimee = (): boolean => {
    try {
      return (
        REGLAGES_ANCRES.ttlS > 0 && maintenant() - floatPy(veritePy(date) ? date : 0) > REGLAGES_ANCRES.ttlS
      );
    } catch {
      return false;
    }
  };
  if (perimee()) return null;
  const centre =
    l["center_x"] !== null && l["center_y"] !== null ? [intPy(l["center_x"]), intPy(l["center_y"])] : null;
  return { auto_id: strPy(l["auto_id"]), role: veritePy(l["role"]) ? strPy(l["role"]) : "", center: centre };
}

/** `prune_action_cache` : purge par âge (TTL) puis par taille (au-delà de `maxRows`, garde les `keep` plus récentes) ; rend le nombre purgé, 0 sur panne. */
export async function pruneActionCache(base: Base, maxRows = 10000, keep = 8000): Promise<number> {
  try {
    return await base.transaction(async (tx) => {
      let purgees = 0;
      if (REGLAGES_ANCRES.ttlS > 0)
        purgees += (
          await tx.run("DELETE FROM editor_action_cache WHERE updated_at < ?", [
            maintenant() - REGLAGES_ANCRES.ttlS,
          ])
        ).changes;
      const n = intPy((await tx.get("SELECT COUNT(*) AS n FROM editor_action_cache"))?.["n"] ?? 0);
      if (n > maxRows)
        purgees += (
          await tx.run(
            "DELETE FROM editor_action_cache WHERE (scope, query_norm) IN (" +
              "SELECT scope, query_norm FROM (SELECT scope, query_norm " +
              "FROM editor_action_cache ORDER BY updated_at DESC " +
              `LIMIT ${noLimit(tx.dialecte)} OFFSET ?) AS perimees)`,
            [keep],
          )
        ).changes;
      return purgees;
    });
  } catch {
    return 0;
  }
}

/** Port des ancres branché sur la base du process (installé par `composer`). */
export function ancresDeLaBase(base: Executeur): PortAncres {
  return {
    lookupActionAnchor: (scope, query) => lookupActionAnchor(base, scope, query),
    recordActionAnchor: (scope, query, autoId, o) =>
      recordActionAnchor(base, scope, query, autoId, o.role, o.center),
  };
}
