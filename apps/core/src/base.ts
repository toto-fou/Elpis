// SPDX-License-Identifier: MIT
/** apps/core/src/base.ts — base de l'application : ouverture depuis la config, garde de génération, initialisation au démarrage, reprise des anciens identifiants AX dans le coffre. */
import { config } from "@elpis/config";
import {
  creerGardeGeneration,
  demarrerBase as demarrerBaseCommune,
  nettoyerSousVerrou,
  prendreVerrouSchema,
  walCheckpoint,
} from "@elpis/db";
import type { Base, RapportInit } from "@elpis/db";

import { journal } from "./journal";
import type { ModeApp } from "./mode";
import { purgeOldMetrics } from "./observabilite/metriques-evenements";
import { repriseAxDuCore } from "./secrets/import-ax";

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

/** Anciens identifiants AX de la base du core repris dans le coffre sous le verrou de schéma (un seul process à la fois) ; une panne n'empêche pas le démarrage, les lignes restantes attendent le suivant. */
export async function reprendreAxAuDemarrage(b: Base): Promise<void> {
  const log = journal("secrets");
  const verrou = await prendreVerrouSchema(journal);
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
  } finally {
    await verrou?.rendre();
  }
}

/** `init_db` : droits des fichiers SQLite, schéma et migrations sous verrou (rapport journalisé), puis nettoyage et reprise des anciens identifiants AX par main seulement. */
export async function demarrerBase(mode: ModeApp): Promise<RapportInit> {
  const { base: nouvelle, rapport } = await demarrerBaseCommune({
    garde: creerGardeGeneration({ journal }),
    ...(mode === "main" ? { apres: nettoyerAuDemarrage } : {}),
    journal,
  });
  courante = nouvelle;
  if (mode === "main") await reprendreAxAuDemarrage(nouvelle);
  return rapport;
}
