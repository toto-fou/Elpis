// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/disque.ts — garde de remplissage des outils qui écrivent (harnais N-08, propre au TS) : `disk_warning` au-delà du seuil d'alerte, refus `disk_full_risk` au-delà du seuil de refus, mesure bornée dans le temps et jamais bloquante. */
import { racineTravail } from "@elpis/bac";
import type { Dict } from "@elpis/commun";
import { err, getUsername } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { userIdFor } from "@elpis/securite";

import type { RappelFichiers } from "../fichiers/commun";
import { alerteRemplissage, bornee, refusRemplissage } from "../fichiers/quota";

/** Attente bornée d'une mesure : au-delà, ni alerte ni refus cette fois (la mesure finit et remplit le cache). */
export const ATTENTE_DISQUE_MS = 1000;

export const FIX_DISQUE =
  "Free space first: delete old logs in /work/.tool-output/, large build artifacts or downloads " +
  '(manage_files(action="delete") or rm), then retry.';

/** Mesures de remplissage d'un bac (phrase anglaise au-delà du seuil, `null` sinon) et lieu mesuré d'un compte. */
export interface GardeDisque {
  lieu(username: string): Promise<readonly [number, string]>;
  alerte(uid: number, racine: string): Promise<string | null>;
  refus(uid: number, racine: string): Promise<string | null>;
}

/** `p` s'il aboutit dans `ms`, sinon `null` ; une panne donne `null`. */
export function auPlus<T>(p: Promise<T | null>, ms = ATTENTE_DISQUE_MS): Promise<T | null> {
  return bornee(p, ms);
}

/** Rappel au core qui donne le quota du compte, sinon `null`. */
export function rappelQuota(rappel: unknown): Pick<RappelFichiers, "quotaCompte"> | null {
  const r = rappel as Partial<RappelFichiers> | null | undefined;
  return r && typeof r.quotaCompte === "function" ? (r as Pick<RappelFichiers, "quotaCompte">) : null;
}

/** Garde réelle : `/work` du compte sur l'hôte, quota par le rappel au core s'il le donne, seuils de `executors.disk`. */
export function gardeDisque(rappel: unknown): GardeDisque {
  const q = rappelQuota(rappel);
  return {
    lieu: async (username) => [await userIdFor(username), await racineTravail(username)],
    alerte: (uid, racine) => alerteRemplissage(q, uid, racine),
    refus: (uid, racine) => refusRemplissage(q, uid, racine),
  };
}

/** Refus `disk_full_risk` : code stable et correctif pour libérer de la place. */
export function refusDisque(message: string): Dict {
  return err("disk_full_risk", message, { fix: FIX_DISQUE });
}

/** `f` sous la garde : refus mesuré avant si `refusable`, puis `disk_warning` ajouté ; `null` (suppression), sans garde ou lieu inconnu : `f` seul. */
export async function sousGardeDisque(
  g: GardeDisque | null,
  ctx: ContexteAppel,
  refusable: boolean | null,
  f: () => Promise<Dict>,
): Promise<Dict> {
  if (g === null || refusable === null) return f();
  let lieu: readonly [number, string] | null;
  try {
    lieu = await auPlus(g.lieu(getUsername(ctx)));
  } catch {
    lieu = null;
  }
  if (lieu === null) return f();
  const [uid, racine] = lieu;
  if (refusable) {
    const refus = await auPlus(g.refus(uid, racine));
    if (refus) return refusDisque(refus);
  }
  const alerte = g.alerte(uid, racine).catch(() => null);
  const r = await f();
  const a = await auPlus(alerte);
  if (a) r["disk_warning"] = a;
  return r;
}

/** Garde des outils fichiers : suppressions sans garde, refus pour `write_file` et `manage_files(copy)` hors `dry_run`, alerte seule sinon. */
export function politiqueFs(outil: string, v: Dict): boolean | null {
  const action = v["action"];
  if (outil === "manage_files" && (action === "delete" || action === "batch_delete")) return null;
  return v["dry_run"] !== true && (outil === "write_file" || (outil === "manage_files" && action === "copy"));
}
