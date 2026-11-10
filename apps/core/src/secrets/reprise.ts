// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/reprise.ts — reprise des anciennes clés dans le coffre : insertion des secrets repris par la migration 0028 (sans journal de sécurité, pas encore ouvert au démarrage), puis suite au démarrage de main (clés illisibles réessayées, clé du moteur d'images semée et retirée de config.json). */
import { POLITIQUE_SECRET_DEFAUT } from "@elpis/contracts";
import {
  cleImagesHeritee,
  genreCleImages,
  installerRangementCoffre,
  POLITIQUE_CLE_MOTEUR,
  reprendreClesLlm,
  semerCleImages,
} from "@elpis/db";
import type { Base, Executeur, RapportInit, SecretARanger } from "@elpis/db";
import { chargerCleCoffre, chiffrerSecret, cleCoffre, CleCoffreIndisponible, kidDe } from "@elpis/securite";
import type { CleCoffre } from "@elpis/securite";

import { retirerCleHeritee } from "../images/config";
import type { Journal } from "../journal";
import { aadSecret, fusionnerPolitique, normaliserPortee, validerNom } from "./portee";
import type { ColonnesLiees } from "./portee";
import { maintenant } from "./stockage";

const MIGRATION = "0028_vault_llm_images";

/** Clé pour chiffrer hors de `creerSecret` (reprise, assistant), même règle : la courante ; à défaut, la clé de repli posée seulement sur un coffre vide, sinon `CleCoffreIndisponible` avec sa cause. */
export async function clePourChiffrer(x: Executeur): Promise<CleCoffre> {
  const cle = cleCoffre();
  if (cle !== null) return cle;
  const n = await x.get<{ n: number }>("SELECT COUNT(*) AS n FROM vault_secrets");
  if (Number(n?.n ?? 0) > 0)
    throw new CleCoffreIndisponible(
      "clé du coffre absente alors que des secrets existent : restaurer /etc/elpis/vault.key",
    );
  return chargerCleCoffre();
}

/** Secret repris inséré comme `creerSecret` le crée (actif, version 1, AAD liée aux colonnes enregistrées : à garder identique), politique des clés du moteur ; rend son id. */
export async function insererSecretRepris(x: Executeur, s: SecretARanger): Promise<number> {
  const nom = validerNom(s.nom);
  const portee = normaliserPortee(s.genre, s.portee);
  const politique = fusionnerPolitique(POLITIQUE_SECRET_DEFAUT, POLITIQUE_CLE_MOTEUR);
  const liees: ColonnesLiees = {
    scope_json: JSON.stringify(portee),
    policy_json: JSON.stringify(politique),
    state: "active",
    version: 1,
    username: null,
  };
  const enc = chiffrerSecret(
    s.valeur,
    aadSecret(s.proprietaire, s.genre, nom, liees),
    await clePourChiffrer(x),
  );
  const t = maintenant();
  return x.insertId(
    "INSERT INTO vault_secrets (user_id, kind, name, scope_json, username, secret_enc, kid, version, state, " +
      "policy_json, meta_json, created_at, updated_at, use_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 0)",
    [
      s.proprietaire,
      s.genre,
      nom,
      liees.scope_json,
      liees.username,
      enc,
      kidDe(enc) ?? "",
      liees.version,
      liees.state,
      liees.policy_json,
      t,
      t,
    ],
  );
}

/** Rangement de la migration 0028 dans ce process (main, admin), avant l'ouverture de la base. */
export function installerRepriseCoffre(): void {
  installerRangementCoffre(insererSecretRepris);
}

/** Suite au démarrage de main, migration déjà faite : clés illisibles réessayées (clé de chiffrement rétablie), clé du moteur d'images semée, puis retirée de config.json une fois dans le coffre ; jamais d'échec du démarrage. */
export async function reprendreAuDemarrage(base: Base, rapport: RapportInit, log: Journal): Promise<void> {
  try {
    if (!(await base.get("SELECT 1 AS un FROM schema_migrations WHERE name = ?", [MIGRATION]))) return;
    if (!rapport.appliquees.includes(MIGRATION)) {
      const bilans = await base.ecriture(async (x) => [await reprendreClesLlm(x), await semerCleImages(x)]);
      for (const b of bilans) {
        for (const i of b.infos) log.info(`coffre : ${i}`);
        for (const a of b.avertissements) log.warn(`coffre : ${a}`);
      }
    }
    if (cleImagesHeritee() !== "" && (await genreCleImages(base)) === "token") {
      await retirerCleHeritee();
      log.info("coffre : ancienne clé du moteur d'images retirée de config.json (image.api_key_enc)");
    }
  } catch (e) {
    log.warn(
      `coffre : reprise des anciennes clés reportée au prochain démarrage (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}
