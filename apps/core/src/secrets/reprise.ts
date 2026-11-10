// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/reprise.ts — reprise des anciennes clés dans le coffre : insertion des secrets repris par la migration 0028 (sans journal de sécurité, pas encore ouvert au démarrage), puis suite au démarrage de main (clés illisibles réessayées). */
import { POLITIQUE_SECRET_DEFAUT } from "@elpis/contracts";
import { installerRangementCoffre, POLITIQUE_CLE_MOTEUR, reprendreClesLlm } from "@elpis/db";
import type { Base, Executeur, RapportInit, SecretARanger } from "@elpis/db";
import { chiffrerSecret, kidDe } from "@elpis/securite";

import type { Journal } from "../journal";
import { aadSecret, fusionnerPolitique, normaliserPortee, validerNom } from "./portee";
import { maintenant } from "./stockage";

const MIGRATION = "0028_vault_llm_images";

/** Secret repris inséré comme `creerSecret` le crée (actif, version 1, même AAD : à garder identique), politique des clés du moteur ; rend son id. */
export async function insererSecretRepris(x: Executeur, s: SecretARanger): Promise<number> {
  const nom = validerNom(s.nom);
  const portee = normaliserPortee(s.genre, s.portee);
  const politique = fusionnerPolitique(POLITIQUE_SECRET_DEFAUT, POLITIQUE_CLE_MOTEUR);
  const enc = chiffrerSecret(s.valeur, aadSecret(s.proprietaire, s.genre, nom));
  const t = maintenant();
  return x.insertId(
    "INSERT INTO vault_secrets (user_id, kind, name, scope_json, username, secret_enc, kid, version, state, " +
      "policy_json, meta_json, created_at, updated_at, use_count) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 'active', ?, '{}', ?, ?, 0)",
    [
      s.proprietaire,
      s.genre,
      nom,
      JSON.stringify(portee),
      enc,
      kidDe(enc) ?? "",
      JSON.stringify(politique),
      t,
      t,
    ],
  );
}

/** Rangement de la migration 0028 dans ce process (main, admin), avant l'ouverture de la base. */
export function installerRepriseCoffre(): void {
  installerRangementCoffre(insererSecretRepris);
}

/** Suite au démarrage de main, migration déjà faite : clés illisibles réessayées (clé de chiffrement rétablie) ; jamais d'échec du démarrage. */
export async function reprendreAuDemarrage(base: Base, rapport: RapportInit, log: Journal): Promise<void> {
  try {
    if (!(await base.get("SELECT 1 AS un FROM schema_migrations WHERE name = ?", [MIGRATION]))) return;
    if (rapport.appliquees.includes(MIGRATION)) return;
    const b = await base.ecriture((x) => reprendreClesLlm(x));
    for (const i of b.infos) log.info(`coffre : ${i}`);
    for (const a of b.avertissements) log.warn(`coffre : ${a}`);
  } catch (e) {
    log.warn(
      `coffre : reprise des anciennes clés reportée au prochain démarrage (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}
