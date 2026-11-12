// SPDX-License-Identifier: MIT
/** apps/core/src/base.ts — base de l'application : ouverture depuis la config, garde de génération, initialisation au démarrage (migrations du coffre appliquées par main seulement), puis suites du coffre et un compactage sous le verrou de schéma. */
import { config } from "@elpis/config";
import {
  compacterApresMigrations,
  creerGardeGeneration,
  demarrerBase as demarrerBaseCommune,
  MIGRATION_COFFRE_GIT,
  MIGRATION_COFFRE_LLM_IMAGES,
  nettoyerSousVerrou,
  prendreVerrouSchema,
  walCheckpoint,
} from "@elpis/db";
import type { Base, Migration, RapportInit } from "@elpis/db";

import { journal } from "./journal";
import type { ModeApp } from "./mode";
import { purgeOldMetrics } from "./observabilite/metriques-evenements";
import { repriseAxDuCore } from "./secrets/import-ax";
import { MIGRATION_MCP, reprendreMcpAuDemarrage } from "./secrets/migration-mcp";
import { portsMigrationsDuCore, reprendreAuDemarrage } from "./secrets/reprise";

/** Implémentations des migrations du registre (`MIGRATIONS_TS` de @elpis/db) que main applique avec les ports du core ; admin, l'hôte d'outils et les commandes les lui laissent. */
export const MIGRATIONS_DU_CORE: readonly Migration[] = [
  MIGRATION_COFFRE_GIT,
  MIGRATION_COFFRE_LLM_IMAGES,
  MIGRATION_MCP,
];

export { creerGardeGeneration, generationPubliee, reglagesBase } from "@elpis/db";

let courante: Base | undefined;

export function base(): Base {
  if (!courante) throw new Error("base de l'application non ouverte");
  return courante;
}

/** Pour les tests : pose (ou retire) la base du process. */
export function remplacerBase(nouvelle: Base | undefined): void {
  courante = nouvelle;
}

/** Purge des `metric_events` hors rétention (0 = illimitée), puis WAL compacté. */
async function nettoyer(b: Base): Promise<void> {
  if (config.METRICS_RETENTION_DAYS > 0) await purgeOldMetrics(b, config.METRICS_RETENTION_DAYS);
  await walCheckpoint(b);
}

/** `_run_startup_cleanup` : purge et WAL par un seul process (`.startup_cleanup.lock`, délai nul) ; déjà pris → on passe (faux). */
export function nettoyerAuDemarrage(b: Base): Promise<boolean> {
  return nettoyerSousVerrou(b, nettoyer, journal);
}

/** Anciens identifiants AX de la base du core repris dans le coffre ; une panne n'empêche pas le démarrage, les lignes restantes attendent le suivant. */
async function reprendreAx(b: Base): Promise<void> {
  const log = journal("secrets");
  try {
    const bilan = await repriseAxDuCore(b);
    if (bilan.retirees || bilan.gardees)
      log.info(
        `anciens identifiants AX : ${bilan.retirees} ligne(s) reprise(s) ou écartée(s), ${bilan.gardees} gardée(s) pour le prochain démarrage`,
      );
    if (!bilan.propre)
      log.warn("anciens identifiants AX : WAL occupé, fichier nettoyé au prochain démarrage");
  } catch (e) {
    log.warn(`anciens identifiants AX non repris : ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Compactage unique des `tables` (anciennes valeurs hors du fichier) ; une erreur est journalisée, jamais bloquante. */
async function compacter(b: Base, tables: readonly string[]): Promise<void> {
  const log = journal("coffre");
  try {
    const propre = await compacterApresMigrations(b, tables);
    log.info(
      `base compactée après les migrations du coffre (${b.dialecte === "sqlite" ? "VACUUM" : `VACUUM FULL ${tables.join(", ")}`})`,
    );
    if (!propre)
      log.warn("compactage : WAL occupé par un autre process, tronqué au prochain point de contrôle");
  } catch (e) {
    log.warn(
      `compactage après les migrations du coffre impossible (${e instanceof Error ? e.message : String(e)}) : ` +
        "d'anciennes valeurs peuvent rester dans des pages libres jusqu'au prochain VACUUM",
    );
  }
}

/** Suites du coffre au démarrage de main, après les migrations et sous le verrou de schéma (un seul process) : anciennes clés LLM et du moteur d'images, secrets MCP et anciens identifiants AX restés hors du coffre ; chacune ne fait rien sans reste, efface sous `secure_delete` et journalise après validation ; puis un seul compactage des tables des migrations appliquées et de celles dont une suite a retiré d'anciennes valeurs. */
export async function reprendreCoffreAuDemarrage(b: Base, rapport: RapportInit): Promise<void> {
  const verrou = await prendreVerrouSchema(journal);
  try {
    const tables = new Set(rapport.aCompacter);
    for (const t of await reprendreAuDemarrage(b, rapport, journal("coffre"))) tables.add(t);
    for (const t of await reprendreMcpAuDemarrage(b, rapport, journal("coffre"))) tables.add(t);
    await reprendreAx(b);
    if (tables.size) await compacter(b, [...tables]);
  } finally {
    await verrou?.rendre();
  }
}

/** `init_db` : droits des fichiers SQLite, schéma et migrations sous verrou (rapport journalisé) ; main seul applique les migrations du coffre (journal de sécurité écrit après validation), puis nettoyage et suites du coffre. */
export async function demarrerBase(mode: ModeApp): Promise<RapportInit> {
  const { base: nouvelle, rapport } = await demarrerBaseCommune({
    garde: creerGardeGeneration({ journal }),
    ...(mode === "main"
      ? { apres: nettoyerAuDemarrage, migrations: MIGRATIONS_DU_CORE, ports: portsMigrationsDuCore() }
      : {}),
    journal,
  });
  courante = nouvelle;
  if (mode === "main") await reprendreCoffreAuDemarrage(nouvelle, rapport);
  return rapport;
}
