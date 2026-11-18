// SPDX-License-Identifier: MIT
/** apps/core/src/identite/etat.ts — invariant « au moins un administrateur actif à mot de passe local », vérifié dans la transaction de l'action qu'il garde. */
import { HttpError } from "@elpis/commun";
import type { Executeur } from "@elpis/db";

const ADMIN_LOCAL_ACTIF = "is_admin=1 AND (suspended_at IS NULL OR suspended_at=0) AND pass_hash<>'!'";

/** Nombre d'administrateurs actifs à mot de passe local, hors `sauf`. */
export async function compterAdminsLocaux(x: Executeur, sauf?: number): Promise<number> {
  const r =
    sauf === undefined
      ? await x.valeurs<[number]>(`SELECT COUNT(*) FROM users WHERE ${ADMIN_LOCAL_ACTIF}`)
      : await x.valeurs<[number]>(`SELECT COUNT(*) FROM users WHERE ${ADMIN_LOCAL_ACTIF} AND id<>?`, [sauf]);
  return Number(r[0]?.[0] ?? 0);
}

/** 409 s'il ne resterait aucun administrateur local actif ; avec `sauf`, seulement si ce compte en est un aujourd'hui (l'action en retire un). */
export async function exigerAdminLocal(x: Executeur, options: { sauf?: number } = {}): Promise<void> {
  const { sauf } = options;
  if (sauf !== undefined) {
    const present = await x.valeurs<[number]>(
      `SELECT COUNT(*) FROM users WHERE ${ADMIN_LOCAL_ACTIF} AND id=?`,
      [sauf],
    );
    if (Number(present[0]?.[0] ?? 0) === 0) return;
  }
  if ((await compterAdminsLocaux(x, sauf)) === 0)
    throw new HttpError(409, "Il doit rester au moins un administrateur actif avec un mot de passe local.");
}
