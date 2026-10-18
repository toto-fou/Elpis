// SPDX-License-Identifier: MIT
/** packages/db/src/demarrage.ts — démarrage de la base d'un process (`init_db`) : réglages de la config, droits, verrou de schéma, schéma et migrations, nettoyage sous verrou ; partagé par le core et l'hôte d'outils. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { intPy, journalDe, reprPy, veritePy } from "@elpis/commun";
import type { FabriqueJournal } from "@elpis/commun";
import { config, configView, DB_BACKENDS_RETIRED, dbPassword, retiredBackendMessage } from "@elpis/config";
import { VerrouFichier, VerrouOccupe } from "@elpis/verrous";

import type { Base } from "./base";
import { ErreurOperation } from "./erreurs";
import { durcirDroits, initialiserBase } from "./init";
import type { RapportInit } from "./init";
import { ouvrirBase } from "./ouvrir";
import type { ReglagesBase } from "./ouvrir";

/** Migrations comprises, la pose du schéma peut durer : le battement garde la péremption courte (`_SCHEMA_PEREMPTION_S`). */
const PEREMPTION_SCHEMA_MS = 120_000;

/** Réglages de connexion ; un moteur retiré (MariaDB/MySQL) arrête le démarrage avec le message de `db()` en Python. */
export function reglagesBase(): ReglagesBase {
  if (DB_BACKENDS_RETIRED.includes(config.DB_BACKEND))
    throw new Error(retiredBackendMessage(config.DB_BACKEND));
  if (config.DB_BACKEND === "sqlite") return { backend: "sqlite", path: config.DB_PATH };
  if (config.DB_BACKEND !== "postgres")
    throw new Error(`moteur serveur inconnu : ${reprPy(config.DB_BACKEND)}`);
  return {
    backend: "postgres",
    host: config.DB_HOST,
    port: config.DB_PORT,
    name: config.DB_NAME,
    user: config.DB_USER,
    password: dbPassword(),
    tls: config.DB_TLS,
    timeout: config.DB_TIMEOUT,
    poolMax: config.DB_POOL_MAX,
  };
}

function entier(valeur: unknown): number {
  try {
    return intPy(veritePy(valeur) ? valeur : 0);
  } catch {
    return 0;
  }
}

/** Génération publiée : `database.generation` de config.json, ou celle du drapeau de bascule s'il est marqué publié. */
export function generationPubliee(): number {
  const section = configView()["database"];
  const depuisConfig =
    section !== null && typeof section === "object" && !Array.isArray(section)
      ? entier((section as Record<string, unknown>)["generation"])
      : 0;
  let depuisDrapeau = 0;
  try {
    const drapeau = JSON.parse(
      readFileSync(join(dirname(config.DB_PATH), ".db_maintenance"), "utf-8"),
    ) as unknown;
    if (drapeau !== null && typeof drapeau === "object" && !Array.isArray(drapeau)) {
      const d = drapeau as Record<string, unknown>;
      if (veritePy(d["published"])) depuisDrapeau = entier(d["generation"]);
    }
  } catch {
    depuisDrapeau = 0;
  }
  return Math.max(depuisConfig, depuisDrapeau);
}

/** `_generation_guard` (chaque process, hôte d'outils compris) : relue au plus une fois par seconde ; base basculée → tout emprunt refusé jusqu'au redémarrage. */
export function creerGardeGeneration(
  o: { maintenant?: () => number; journal?: FabriqueJournal } = {},
): () => void {
  const maintenant = o.maintenant ?? (() => performance.now());
  let verifieA = Number.NEGATIVE_INFINITY;
  let perimee = false;
  const refus = () => new ErreurOperation("base de données basculée : ce processus doit être rechargé");
  return () => {
    if (perimee) throw refus();
    const t = maintenant();
    if (t - verifieA < 1_000) return;
    verifieA = t;
    const publiee = generationPubliee();
    if (publiee > config.DB_GENERATION) {
      perimee = true;
      (o.journal ?? journalDe)("db").error(
        `base basculée (génération ${publiee} > ${config.DB_GENERATION}) : emprunts refusés jusqu'au rechargement de ce processus.`,
      );
      throw refus();
    }
  };
}

function verrouDeLaBase(nom: string, delaiMs: number | null): VerrouFichier {
  return new VerrouFichier(join(dirname(config.DB_PATH), nom), {
    delaiMs,
    peremptionMs: PEREMPTION_SCHEMA_MS,
    battement: true,
  });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `_schema_lock` : un seul process pose le schéma (`.init_db.lock`, sans délai) ; verrou indisponible → sans verrou. */
export async function prendreVerrouSchema(
  journal: FabriqueJournal = journalDe,
): Promise<VerrouFichier | null> {
  const verrou = verrouDeLaBase(".init_db.lock", null);
  try {
    await verrou.acquerir();
    return verrou;
  } catch (e) {
    if (typeof (e as { code?: unknown }).code !== "string") throw e;
    journal("init_db").warn(`verrou de schéma indisponible : ${message(e)}`);
    return null;
  }
}

/** `_run_startup_cleanup` : `nettoyer` par un seul process (`.startup_cleanup.lock`, délai nul) ; déjà pris → on passe (faux). */
export async function nettoyerSousVerrou(
  b: Base,
  nettoyer: (b: Base) => Promise<void>,
  journal: FabriqueJournal = journalDe,
): Promise<boolean> {
  const verrou = verrouDeLaBase(".startup_cleanup.lock", 0);
  try {
    try {
      await verrou.acquerir();
    } catch (e) {
      if (e instanceof VerrouOccupe) return false;
      throw e;
    }
    try {
      await nettoyer(b);
    } finally {
      await verrou.rendre();
    }
  } catch (e) {
    journal("startup").warn(
      `_run_startup_cleanup: verrou inaccessible (${message(e)}), nettoyage exécuté quand même en fallback.`,
    );
    await nettoyer(b);
  }
  return true;
}

export interface OptionsDemarrage {
  /** Garde de chaque emprunt (`_generation_guard` du core). */
  readonly garde?: () => void;
  /** Après le schéma, avant de rendre la base (nettoyage au démarrage) ; une erreur ferme la base. */
  readonly apres?: (b: Base) => Promise<unknown>;
  readonly journal?: FabriqueJournal;
}

/** `init_db` : droits des fichiers SQLite, schéma et migrations sous verrou (rapport journalisé), puis `apres`. */
export async function demarrerBase(o: OptionsDemarrage = {}): Promise<{ base: Base; rapport: RapportInit }> {
  const journal = o.journal ?? journalDe;
  const log = journal("db");
  const reglages = reglagesBase();
  if (reglages.backend === "sqlite") {
    for (const corrige of durcirDroits(reglages.path, config.PROJECT_ROOT))
      log.info(`droits resserrés : ${corrige}`);
  }
  const nouvelle = ouvrirBase(reglages, o.garde ? { garde: o.garde } : {});
  try {
    const verrou = await prendreVerrouSchema(journal);
    let rapport: RapportInit;
    try {
      rapport = await initialiserBase(nouvelle);
    } finally {
      await verrou?.rendre();
    }
    for (const avertissement of rapport.avertissements) log.warn(avertissement);
    if (rapport.echec) log.error(`migration ${rapport.echec.name} en échec : ${rapport.echec.message}`);
    await o.apres?.(nouvelle);
    return { base: nouvelle, rapport };
  } catch (e) {
    await nouvelle.fermer();
    throw e;
  }
}
