// SPDX-License-Identifier: MIT
/** packages/mcp/src/invalidation.ts — registre de rappels d'invalidation des caches MCP du process (réglages d'un compte, rechargement du manifeste). */
import { pyJsonDumps, strPy, veritePy } from "@elpis/commun";

import { oublierManifeste } from "./manifeste";
import { estDict } from "./outils";
import type { Dict } from "./outils";
import type { PoolMcp } from "./pool";
import { deConfiance, journalDe, marquerConfiance } from "./ports";
import { personalToConfig } from "./serveurs";

/** `reglages` : liste `mcp_servers` d'un compte avant et après sauvegarde ; `partage` : serveur de la bibliothèque écrit (config résolue d'avant, `null` à la création) ; `manifeste` : `mcp.json` relu par l'administration. */
export type EvenementMcp =
  | { type: "reglages"; avant: unknown[]; apres: unknown[] }
  | { type: "partage"; avant: Dict | null }
  | { type: "manifeste" };

export type RappelInvalidation = (e: EvenementMcp) => void | Promise<void>;

const rappels = new Set<RappelInvalidation>();
const log = (): ReturnType<typeof journalDe> => journalDe("MCP_POOL");

/** Abonne un cache à l'invalidation ; rend la fonction de désabonnement. */
export function surInvalidationMcp(rappel: RappelInvalidation): () => void {
  rappels.add(rappel);
  return () => {
    rappels.delete(rappel);
  };
}

/** Diffuse l'événement à tous les caches abonnés ; une panne d'un rappel est journalisée, jamais levée. */
export async function invaliderMcp(e: EvenementMcp): Promise<void> {
  for (const rappel of [...rappels]) {
    try {
      await rappel(e);
    } catch (err) {
      log().warn(`Erreur invalidation pool: ${err instanceof Error ? err.message : strPy(err)}`);
    }
  }
}

function parId(liste: unknown[]): Map<string, Dict> {
  const out = new Map<string, Dict>();
  for (const s of liste) if (estDict(s) && veritePy(s["id"])) out.set(strPy(s["id"]), s);
  return out;
}

function canonique(v: unknown): string {
  return pyJsonDumps(v ?? null, { sortKeys: true });
}

/** Ferme la connexion de la config sous ses deux clés de pool : de confiance et gardée. */
async function invaliderVariantes(pool: PoolMcp, cfg: Dict): Promise<void> {
  await pool.invalidate(cfg);
  await pool.invalidate(deConfiance(cfg) ? { ...cfg } : marquerConfiance({ ...cfg }));
}

/** Invalidation ciblée des serveurs perso modifiés (ancienne et nouvelle clé), recyclage large si une entrée n'a pas d'id. */
export async function invaliderServeursPerso(
  pool: PoolMcp,
  avant: unknown[],
  apres: unknown[],
): Promise<void> {
  if (canonique(avant) === canonique(apres)) return;
  const anciens = parId(avant);
  const nouveaux = parId(apres);
  if (anciens.size !== avant.length || nouveaux.size !== apres.length) {
    await pool.reset();
    log().info("Pool reset (entrée MCP sans id).");
    return;
  }
  const touches = [...new Set([...anciens.keys(), ...nouveaux.keys()])].filter(
    (sid) => canonique(anciens.get(sid)) !== canonique(nouveaux.get(sid)),
  );
  let fermees = 0;
  for (const sid of touches) {
    for (const src of [anciens.get(sid), nouveaux.get(sid)]) {
      if (src === undefined) continue;
      const cfg = await personalToConfig(src, { allowStdio: true });
      if (Object.keys(cfg).length === 0) continue;
      await invaliderVariantes(pool, cfg);
      fermees++;
    }
  }
  log().info(
    `${touches.length} serveur(s) MCP modifié(s) → ${fermees} clé(s) invalidée(s) ; les autres connexions du process sont conservées.`,
  );
}

/** Abonne le pool : réglages → invalidation ciblée ; serveur partagé → sa connexion d'avant fermée ; manifeste → cache purgé et connexions recyclées (pool toujours utilisable). */
export function brancherInvalidationPool(pool: PoolMcp): () => void {
  return surInvalidationMcp(async (e) => {
    if (e.type === "reglages") await invaliderServeursPerso(pool, e.avant, e.apres);
    else if (e.type === "partage") {
      if (e.avant !== null) await invaliderVariantes(pool, e.avant);
    } else {
      oublierManifeste();
      await pool.reset({ keepPersistent: false });
    }
  });
}
