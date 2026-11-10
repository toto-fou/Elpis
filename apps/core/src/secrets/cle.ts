// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/cle.ts — clé du coffre vue des commandes d'exploitation : secrets comptés par clé (`kid`), rechiffrement des secrets d'une ancienne clé vers la clé courante. */
import type { Base, Executeur } from "@elpis/db";
import { chiffrerSecret, dechiffrerSecret, kidDe } from "@elpis/securite";
import type { CleCoffre } from "@elpis/securite";

import { aadSecret, estGenre } from "./portee";
import { COLONNES_SECRET } from "./stockage";
import type { LigneSecret } from "./stockage";

/** Nombre de secrets par `kid`, et combien sont des secrets d'instance. */
export async function secretsParCle(
  x: Executeur,
): Promise<{ total: number; instance: number; parKid: Map<string, number> }> {
  const lignes = await x.all<{ kid: string; instance: number; n: number }>(
    "SELECT kid, CASE WHEN user_id IS NULL THEN 1 ELSE 0 END AS instance, COUNT(*) AS n " +
      "FROM vault_secrets GROUP BY kid, CASE WHEN user_id IS NULL THEN 1 ELSE 0 END",
  );
  const parKid = new Map<string, number>();
  let total = 0;
  let instance = 0;
  for (const l of lignes) {
    const n = Number(l.n);
    total += n;
    if (Number(l.instance) === 1) instance += n;
    parKid.set(l.kid, (parKid.get(l.kid) ?? 0) + n);
  }
  return { total, instance, parKid };
}

export interface RapportRechiffrement {
  rechiffres: number;
  echecs: number;
  /** Secrets restés sur une autre clé que la courante (ni l'ancienne ni la courante). */
  restants: number;
}

/** Rechiffre un à un les secrets de `ancienne` avec `courante` ; une ligne changée entre-temps (rotation concurrente) est laissée telle quelle. */
export async function rechiffrerCoffre(
  base: Base,
  ancienne: CleCoffre,
  courante: CleCoffre,
): Promise<RapportRechiffrement> {
  const r: RapportRechiffrement = { rechiffres: 0, echecs: 0, restants: 0 };
  const lignes = await base.all<LigneSecret & Record<string, unknown>>(
    `SELECT ${COLONNES_SECRET} FROM vault_secrets WHERE kid = ? ORDER BY id`,
    [ancienne.kid],
  );
  for (const l of lignes) {
    if (!estGenre(l.kind)) {
      r.echecs += 1;
      continue;
    }
    const aad = aadSecret(l.user_id, l.kind, l.name);
    let enc: string;
    try {
      enc = chiffrerSecret(dechiffrerSecret(l.secret_enc, aad, [ancienne]), aad, courante);
    } catch {
      r.echecs += 1;
      continue;
    }
    const fait = await base.ecriture((x) =>
      x.run("UPDATE vault_secrets SET secret_enc = ?, kid = ? WHERE id = ? AND secret_enc = ?", [
        enc,
        kidDe(enc) ?? "",
        l.id,
        l.secret_enc,
      ]),
    );
    if (fait.changes > 0) r.rechiffres += 1;
  }
  const reste = await base.get<{ n: number }>("SELECT COUNT(*) AS n FROM vault_secrets WHERE kid <> ?", [
    courante.kid,
  ]);
  r.restants = Number(reste?.n ?? 0);
  return r;
}
