// SPDX-License-Identifier: MIT
/** apps/core/src/main.ts — point d'entrée d'un process du core (`APP_MODE`, écoute sur `BIND`, arrêt gracieux 300 s). */
import { config, configView, racineDepot } from "@elpis/config";

import { creerApp } from "./app";
import { base, demarrerBase } from "./base";
import { composer, serviceDuProcess } from "./composition";
import { codeDeSortie, CycleDeVie, DELAI_ARRET_MS } from "./cycle";
import { adresseEcoute, hoteParDefaut } from "./ecoute";
import { cheminJournalCommun } from "./evenements";
import { journal } from "./journal";
import { resoudreModeApp } from "./mode";
import { configurerJournalProcess, ecrivainDuProcess } from "./observabilite/journal-acces";
import { brancherTravailDesComptes } from "./ops/travail-agent";
import { configurerSecuriteDuCore } from "./securite";

const GRACE_APRES_FORCAGE_MS = 5_000;

/** `app.cors_origins` de config.json, lu au démarrage ; une liste de textes, sinon aucune origine. */
function originesCors(): string[] {
  const app = (configView() as Record<string, unknown>)["app"];
  const brut =
    app !== null && typeof app === "object" ? (app as Record<string, unknown>)["cors_origins"] : undefined;
  return Array.isArray(brut) ? brut.filter((o): o is string => typeof o === "string") : [];
}

async function principal(): Promise<void> {
  const log = journal("startup");
  const mode = resoudreModeApp(process.env["APP_MODE"], log);
  configurerJournalProcess(serviceDuProcess(mode), cheminJournalCommun(racineDepot()));
  const cycle = new CycleDeVie(journal("cycle"));
  configurerSecuriteDuCore();
  await demarrerBase(mode);
  const composition = await composer(mode, base(), log, undefined, undefined, { cycle });
  brancherTravailDesComptes(cycle, base(), journal("backup"));
  cycle.alArret("base", () => base().fermer());
  cycle.alArret("journal commun", () => ecrivainDuProcess()?.fermer());
  const app = await creerApp({
    mode,
    arretEnCours: () => cycle.arretEnCours,
    corsOrigines: originesCors(),
    ...composition,
  });
  await cycle.demarrer(mode);
  const { hote, port } = adresseEcoute(
    process.env["BIND"],
    mode,
    hoteParDefaut(config.CONFIG_JSON_PATH, log),
  );
  await app.listen({ host: hote, port });
  log.info(`process ${mode} à l'écoute sur ${hote}:${port} (${app.elpis.routes.length} routes)`);

  let arretDemande = false;
  let redemarrage = false;
  /** SIGHUP aussi : le Python y rechargeait ses workers ; ici le process s'arrête proprement (sortie 75) et systemd ou relance.sh le relance. */
  const arreter = (signal: NodeJS.Signals): void => {
    if (arretDemande) {
      log.warn(`${signal} reçu pendant l'arrêt : sortie immédiate`);
      process.exit(codeDeSortie(redemarrage && signal === "SIGHUP", false));
    }
    arretDemande = true;
    redemarrage = signal === "SIGHUP";
    log.info(`${signal} reçu : arrêt gracieux (jusqu'à ${DELAI_ARRET_MS / 1000} s)`);
    cycle.annoncerArret();
    const balayage = setInterval(() => app.server.closeIdleConnections(), 1_000);
    const force = setTimeout(() => {
      log.warn("délai d'arrêt dépassé : connexions fermées de force");
      app.server.closeAllConnections();
      setTimeout(() => process.exit(codeDeSortie(redemarrage, false)), GRACE_APRES_FORCAGE_MS).unref();
    }, DELAI_ARRET_MS);
    void app
      .close()
      .then(() => cycle.executerArrets())
      .then(() => {
        clearInterval(balayage);
        clearTimeout(force);
        log.info("arrêt terminé");
        process.exit(codeDeSortie(redemarrage, true));
      })
      .catch((e: unknown) => {
        log.error({ err: e }, "arrêt en échec");
        process.exit(codeDeSortie(redemarrage, false));
      });
  };
  process.on("SIGTERM", arreter);
  process.on("SIGINT", arreter);
  process.on("SIGHUP", arreter);
  cycle.brancherRedemarrage(() => process.kill(process.pid, "SIGHUP"));
}

principal().catch((e: unknown) => {
  journal("startup").fatal({ err: e }, "démarrage impossible");
  process.exit(1);
});
