// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/cle.ts — clé du coffre vue des commandes d'exploitation : secrets comptés par clé (`kid`), rechiffrement des secrets d'une ancienne clé vers la clé courante ; les secrets de webhook des routines, chiffrés sur place par la même clé, suivent. */
import { aadWebhookRoutine } from "@elpis/db";
import type { Base, Executeur } from "@elpis/db";
import { chiffrerSecret, dechiffrerSecret, kidDe } from "@elpis/securite";
import type { CleCoffre } from "@elpis/securite";

import { estGenre } from "./portee";
import { aadLigne, COLONNES_SECRET, colonneWebhooks } from "./stockage";
import type { LigneSecret } from "./stockage";

/** Secrets de webhook des routines (chiffrés sur place, hors `vault_secrets`) ; colonne pas encore posée (services pas redémarrés) : aucun. */
async function webhooks(x: Executeur): Promise<{ id: number; enc: string }[]> {
  if (!(await colonneWebhooks(x))) return [];
  const lignes = await x.all<{ id: number; webhook_secret_enc: string }>(
    "SELECT id, webhook_secret_enc FROM editor_routines WHERE webhook_secret_enc IS NOT NULL AND webhook_secret_enc <> '' ORDER BY id",
  );
  return lignes.map((l) => ({ id: Number(l.id), enc: l.webhook_secret_enc }));
}

/** Nombre de secrets par `kid` (secrets de webhook des routines compris), combien sont des secrets d'instance et combien des secrets de webhook. */
export async function secretsParCle(
  x: Executeur,
): Promise<{ total: number; instance: number; webhooks: number; parKid: Map<string, number> }> {
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
  const routines = await webhooks(x);
  for (const w of routines) {
    const kid = kidDe(w.enc) ?? "?";
    parKid.set(kid, (parKid.get(kid) ?? 0) + 1);
  }
  return { total, instance, webhooks: routines.length, parKid };
}

export interface RapportRechiffrement {
  rechiffres: number;
  echecs: number;
  /** Secrets restés sur une autre clé que la courante (ni l'ancienne ni la courante). */
  restants: number;
}

/** Secrets de webhook de `ancienne` rechiffrés avec `courante` (même garde qu'aux secrets du coffre). */
async function rechiffrerWebhooks(
  base: Base,
  ancienne: CleCoffre,
  courante: CleCoffre,
  r: RapportRechiffrement,
): Promise<void> {
  for (const w of await webhooks(base)) {
    if (kidDe(w.enc) !== ancienne.kid) continue;
    const aad = aadWebhookRoutine(w.id);
    let enc: string;
    try {
      enc = chiffrerSecret(dechiffrerSecret(w.enc, aad, [ancienne]), aad, courante);
    } catch {
      r.echecs += 1;
      continue;
    }
    const fait = await base.ecriture((x) =>
      x.run("UPDATE editor_routines SET webhook_secret_enc = ? WHERE id = ? AND webhook_secret_enc = ?", [
        enc,
        w.id,
        w.enc,
      ]),
    );
    if (fait.changes > 0) r.rechiffres += 1;
  }
}

/** Rechiffre un à un les secrets de `ancienne` avec `courante` (secrets de webhook compris) ; une ligne changée entre-temps (rotation concurrente) est laissée telle quelle. */
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
    const aad = aadLigne(l);
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
  await rechiffrerWebhooks(base, ancienne, courante, r);
  const reste = await base.get<{ n: number }>("SELECT COUNT(*) AS n FROM vault_secrets WHERE kid <> ?", [
    courante.kid,
  ]);
  r.restants =
    Number(reste?.n ?? 0) + (await webhooks(base)).filter((w) => kidDe(w.enc) !== courante.kid).length;
  return r;
}
