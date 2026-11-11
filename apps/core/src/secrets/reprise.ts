// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/reprise.ts — reprise des anciennes clés dans le coffre : insertion des secrets repris par la migration 0028 (sans journal de sécurité, pas encore ouvert au démarrage), puis suite au démarrage de main (clés illisibles réessayées, clés réécrites par une version antérieure confrontées au coffre, clé du moteur d'images semée et retirée de config.json et config.json.bak). */
import { basename } from "node:path";

import type { Dict } from "@elpis/commun";
import { POLITIQUE_SECRET_DEFAUT } from "@elpis/contracts";
import {
  avecEffacementSur,
  cleHeritee,
  cleImagesHeritee,
  installerRangementCoffre,
  NOM_CLE_IMAGES,
  ouvrirSceauImages,
  POLITIQUE_CLE_MOTEUR,
  reprendreClesLlm,
  SCHEMA_COFFRE,
  semerCleImages,
} from "@elpis/db";
import type { Base, BilanReprise, Executeur, RapportInit, SecretARanger } from "@elpis/db";
import { chargerCleCoffre, chiffrerSecret, cleCoffre, CleCoffreIndisponible, kidDe } from "@elpis/securite";
import type { CleCoffre } from "@elpis/securite";

import { retirerCleHeritee } from "../images/config";
import type { Journal } from "../journal";
import { lireCle, SELECT_CONNECTEUR } from "../llm/cle-coffre";
import { ErreurSecret } from "./erreurs";
import { aadSecret, fusionnerPolitique, normaliserPortee, origines, validerNom } from "./portee";
import type { ColonnesLiees } from "./portee";
import { dechiffrerLigne, lireLigneParNom, maintenant, porteeDe } from "./stockage";

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
  const portee = normaliserPortee(s.genre, s.portee, { proprietaire: s.proprietaire, nom });
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

/** Clés réécrites par une version antérieure (retour en arrière, non pris en charge) sur des connecteurs déjà liés au coffre : celle du coffre est gardée et l'autre effacée, avec un avertissement si elles diffèrent ; celle du coffre illisible : l'autre reste ; secret disparu : l'autre est reprise comme à la migration. */
async function reprendreReecritures(x: Executeur): Promise<BilanReprise> {
  const b: BilanReprise = { infos: [], avertissements: [], restantes: 0 };
  const lignes = await x.all<Dict>(
    `${SELECT_CONNECTEUR} WHERE c.secret_id IS NOT NULL AND c.api_key_enc <> '' ORDER BY c.id`,
  );
  for (const row of lignes) {
    const id = Number(row["id"]);
    const coffre = lireCle(row);
    if (coffre.erreur === "missing") {
      await x.run("UPDATE llm_connectors SET secret_id = NULL WHERE id = ?", [id]);
      continue;
    }
    if (coffre.erreur !== null) {
      b.restantes += 1;
      b.avertissements.push(
        `connecteur LLM #${id} : clé réécrite par une version antérieure, gardée tant que celle du coffre est illisible (${coffre.erreur})`,
      );
      continue;
    }
    const ancienne = cleHeritee(String(row["api_key_enc"]), row["key_scheme"]);
    if (!("clair" in ancienne) || ancienne.clair !== coffre.cle)
      b.avertissements.push(
        `connecteur LLM #${id} : clé réécrite par une version antérieure (retour en arrière non pris en charge), ` +
          "différente de celle du coffre ou illisible : celle du coffre est gardée, l'autre effacée",
      );
    await x.run("UPDATE llm_connectors SET api_key_enc = '', key_scheme = ? WHERE id = ?", [
      SCHEMA_COFFRE,
      id,
    ]);
  }
  return b;
}

/** Ancienne clé du moteur d'images retirée de config.json et de config.json.bak une fois le coffre pourvu ; réapparue (retour en arrière, restauration) et différente : avertissement, celle du coffre gardée ; celle du coffre illisible : l'ancienne reste. */
async function retirerCleImagesHeritee(base: Base, log: Journal): Promise<void> {
  const l = await lireLigneParNom(base, null, NOM_CLE_IMAGES);
  if (l === null || l.kind !== "token") return;
  const enc = cleImagesHeritee();
  if (enc !== "") {
    let coffre: string;
    try {
      coffre = dechiffrerLigne(l);
    } catch (e) {
      if (!(e instanceof ErreurSecret)) throw e;
      log.warn(
        `coffre : clé du moteur d'images illisible dans le coffre (${e.code}), celle de config.json est gardée`,
      );
      return;
    }
    const ancienne = ouvrirSceauImages(enc);
    if (!("cle" in ancienne) || ancienne.cle !== coffre || !origines(porteeDe(l)).includes(ancienne.origine))
      log.warn(
        "coffre : clé du moteur d'images de config.json (version antérieure ? retour en arrière non pris en charge) " +
          "différente de celle du coffre ou illisible : celle du coffre est gardée, l'autre retirée",
      );
  }
  const fichiers = await retirerCleHeritee();
  if (fichiers.length)
    log.info(
      `coffre : ancienne clé du moteur d'images (image.api_key_enc) retirée de ${fichiers.map((f) => basename(f)).join(", ")}`,
    );
}

/** Suite au démarrage de main, migration déjà faite : clés illisibles réessayées (clé de chiffrement rétablie), clés réécrites confrontées au coffre, clé du moteur d'images semée puis retirée de config.json ; anciennes valeurs effacées des pages SQLite ; jamais d'échec du démarrage. */
export async function reprendreAuDemarrage(base: Base, rapport: RapportInit, log: Journal): Promise<void> {
  try {
    if (!(await base.get("SELECT 1 AS un FROM schema_migrations WHERE name = ?", [MIGRATION]))) return;
    if (!rapport.appliquees.includes(MIGRATION)) {
      const bilans = await base.ecriture((x) =>
        avecEffacementSur(x, async () => [
          await reprendreReecritures(x),
          await reprendreClesLlm(x),
          await semerCleImages(x),
        ]),
      );
      for (const b of bilans) {
        for (const i of b.infos) log.info(`coffre : ${i}`);
        for (const a of b.avertissements) log.warn(`coffre : ${a}`);
      }
    }
    await retirerCleImagesHeritee(base, log);
  } catch (e) {
    log.warn(
      `coffre : reprise des anciennes clés reportée au prochain démarrage (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}
