// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/reprise.ts — ports des migrations du coffre passés par main (secret inséré comme `creerSecret`, Fernet relu sans jamais créer de clé, journal de sécurité après validation), puis suite au démarrage de main (clés illisibles réessayées, clés réécrites par une version antérieure confrontées au coffre, clé du moteur d'images semée et retirée de config.json et config.json.bak). */
import { basename } from "node:path";

import type { Dict } from "@elpis/commun";
import { POLITIQUE_SECRET_DEFAUT, schemaPolitiqueSecret } from "@elpis/contracts";
import {
  avecEffacementSur,
  cleHeritee,
  cleImagesHeritee,
  NOM_CLE_IMAGES,
  ouvrirSceauImages,
  reprendreClesLlm,
  SCHEMA_COFFRE,
  semerCleImages,
} from "@elpis/db";
import type {
  Base,
  BilanReprise,
  EvenementMigration,
  Executeur,
  PortFernet,
  PortsMigration,
  PortsReprise,
  RapportInit,
  SecretARanger,
} from "@elpis/db";
import {
  chargerCleCoffre,
  chiffrerSecret,
  cleCoffre,
  CleCoffreIndisponible,
  decryptStrict,
  EncryptionUnavailable,
  InvalidToken,
  kidDe,
} from "@elpis/securite";
import type { CleCoffre } from "@elpis/securite";

import { retirerCleHeritee } from "../images/config";
import type { Journal } from "../journal";
import { lireCle, SELECT_CONNECTEUR } from "../llm/cle-coffre";
import { ErreurSecret } from "./erreurs";
import {
  aadSecret,
  estGenre,
  fusionnerPolitique,
  normaliserPortee,
  origines,
  validerIdentifiant,
  validerMeta,
  validerNom,
} from "./portee";
import type { ColonnesLiees } from "./portee";
import { dechiffrerLigne, journaliser, lireLigneParNom, maintenant, porteeDe } from "./stockage";

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

/** Secret repris inséré comme `creerSecret` le crée (actif, version 1, AAD de `aadSecret` liée aux colonnes enregistrées), politique donnée complétée par les défauts ; rend son id et son événement `vault.secret.created` ; clé du coffre indisponible : erreur explicite, rien d'écrit. */
export async function insererSecretRepris(
  x: Executeur,
  s: SecretARanger,
): Promise<{ id: number; evenement: EvenementMigration }> {
  if (!estGenre(s.genre)) throw new Error(`genre de secret inconnu : ${s.genre}`);
  const genre = s.genre;
  const nom = validerNom(s.nom);
  const portee = normaliserPortee(genre, s.portee, { proprietaire: s.proprietaire, nom });
  const politique = fusionnerPolitique(
    POLITIQUE_SECRET_DEFAUT,
    schemaPolitiqueSecret.partial().parse(s.politique ?? {}),
  );
  const meta = validerMeta(s.meta ?? {});
  const liees: ColonnesLiees = {
    scope_json: JSON.stringify(portee),
    policy_json: JSON.stringify(politique),
    state: "active",
    version: 1,
    username: validerIdentifiant(s.username ?? null),
  };
  let cle: CleCoffre;
  try {
    cle = await clePourChiffrer(x);
  } catch (e) {
    if (!(e instanceof CleCoffreIndisponible)) throw e;
    throw new Error(`clé du coffre indisponible (./elpis doctor) : ${e.message}`, { cause: e });
  }
  const enc = chiffrerSecret(s.valeur, aadSecret(s.proprietaire, genre, nom, liees), cle);
  const t = maintenant();
  const id = await x.insertId(
    "INSERT INTO vault_secrets (user_id, kind, name, scope_json, username, secret_enc, kid, version, state, " +
      "policy_json, meta_json, created_at, updated_at, use_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
    [
      s.proprietaire,
      genre,
      nom,
      liees.scope_json,
      liees.username,
      enc,
      kidDe(enc) ?? "",
      liees.version,
      liees.state,
      liees.policy_json,
      JSON.stringify(meta),
      t,
      t,
    ],
  );
  const owner = s.proprietaire === null ? "instance" : "user";
  return {
    id,
    evenement: {
      userId: s.proprietaire,
      action: "vault.secret.created",
      details: { secret_id: id, name: nom, kind: genre, owner, scope: portee, state: "active" },
    },
  };
}

/** Ancien chiffrement Fernet relu sans jamais créer de clé : une clé absente laisse les valeurs en attente du démarrage suivant. */
export const FERNET_SANS_CREATION: PortFernet = {
  ouvrir(jeton) {
    try {
      return { clair: decryptStrict(jeton) };
    } catch (e) {
      if (e instanceof InvalidToken) return { erreur: "illisible" };
      if (e instanceof EncryptionUnavailable) return { erreur: "cle_absente" };
      throw e;
    }
  },
};

/** Ports des migrations du coffre passés par main à `demarrerBase` (aucun effet de bord à l'import). */
export function portsMigrationsDuCore(): PortsMigration {
  return { coffre: { ranger: insererSecretRepris }, fernet: FERNET_SANS_CREATION };
}

/** Événements des migrations écrits au journal de sécurité, une fois leur transaction validée. */
export function journaliserMigrations(evenements: readonly EvenementMigration[]): void {
  for (const e of evenements)
    journaliser({ userId: e.userId, username: null, ip: null }, e.action, e.details);
}

/** Ports de la reprise hors migration (démarrage de main, essais) : les événements des secrets rangés attendent la validation de la transaction. */
export function portsDeReprise(evenements: EvenementMigration[]): PortsReprise {
  return {
    coffre: {
      async ranger(x, s) {
        const { id, evenement } = await insererSecretRepris(x, s);
        evenements.push(evenement);
        return id;
      },
    },
    fernet: FERNET_SANS_CREATION,
  };
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
    const ancienne = cleHeritee(String(row["api_key_enc"]), row["key_scheme"], FERNET_SANS_CREATION);
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
    const ancienne = ouvrirSceauImages(enc, FERNET_SANS_CREATION);
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

/** Suite au démarrage de main, migration déjà faite : clés gardées réessayées (clé de chiffrement rétablie), clés réécrites confrontées au coffre, clé du moteur d'images semée puis retirée de config.json ; anciennes valeurs effacées des pages SQLite ; secrets créés journalisés après validation ; jamais d'échec du démarrage. */
export async function reprendreAuDemarrage(base: Base, rapport: RapportInit, log: Journal): Promise<void> {
  try {
    if (!(await base.get("SELECT 1 AS un FROM schema_migrations WHERE name = ?", [MIGRATION]))) return;
    if (!rapport.appliquees.includes(MIGRATION)) {
      const evenements: EvenementMigration[] = [];
      const ports = portsDeReprise(evenements);
      const bilans = await base.ecriture((x) =>
        avecEffacementSur(x, async () => [
          await reprendreReecritures(x),
          await reprendreClesLlm(x, ports),
          await semerCleImages(x, ports),
        ]),
      );
      journaliserMigrations(evenements);
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
