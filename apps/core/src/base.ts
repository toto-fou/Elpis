// SPDX-License-Identifier: MIT
/** apps/core/src/base.ts — base de l'application : ouverture depuis la config, garde de génération, initialisation au démarrage (migrations du core comprises). */
import { config } from "@elpis/config";
import {
  creerGardeGeneration,
  demarrerBase as demarrerBaseCommune,
  nettoyerSousVerrou,
  walCheckpoint,
} from "@elpis/db";
import type { Base, RapportInit } from "@elpis/db";

import { journal } from "./journal";
import type { ModeApp } from "./mode";
import { purgeOldMetrics } from "./observabilite/metriques-evenements";
import { compacterApresReprise, MIGRATION_AX, migrationAxCredentials } from "./secrets/import-ax";

/** Migrations numérotées propres au core (jamais jouées par l'hôte d'outils sur sa base). */
export const MIGRATIONS_CORE = [migrationAxCredentials] as const;

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

/** `init_db` : droits des fichiers SQLite, schéma et migrations sous verrou (rapport journalisé), puis nettoyage par main seulement ; après la reprise des anciens identifiants AX, le fichier est compacté. */
export async function demarrerBase(mode: ModeApp): Promise<RapportInit> {
  const { base: nouvelle, rapport } = await demarrerBaseCommune({
    garde: creerGardeGeneration({ journal }),
    ...(mode === "main" ? { apres: nettoyerAuDemarrage } : {}),
    journal,
    migrations: MIGRATIONS_CORE,
  });
  courante = nouvelle;
  if (rapport.appliquees.includes(MIGRATION_AX))
    await compacterApresReprise(nouvelle).catch((e: unknown) =>
      journal("db").warn(`VACUUM après la reprise des identifiants AX impossible : ${String(e)}`),
    );
  return rapport;
}
