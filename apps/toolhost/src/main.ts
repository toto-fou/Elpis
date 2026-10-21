// SPDX-License-Identifier: MIT
/** apps/toolhost/src/main.ts — point d'entrée de l'hôte d'outils (`node apps/toolhost/dist/main.mjs`) : configuration, porte, routes, façade MCP, arrêt gracieux ; `--stdio` pour un applicatif tiers ; `--natif`, `--empreinte` et `--familles-natives` pour le lanceur ; `--familles-relayees` (aucune) et `--elpis-tools` (sans effet) pour les anciens `./elpis` et unités systemd d'une mise à jour. */
import path from "node:path";

import { brancherJournal as brancherJournalCommun } from "@elpis/commun";
import { verifierEmpreinteBundle } from "@elpis/commun/empreinte";
import { journalRacine } from "@elpis/http";
import { parseFamilies } from "@elpis/mcp";
import { brancherJournal as brancherJournalSecurite } from "@elpis/securite";
import { brancherJournal as brancherJournalVerrous, definirProcessus } from "@elpis/verrous";
import { rechargerConfig } from "@elpis/config";

import { creerAppToolhost } from "./app";
import { fermerBaseHote, ouvrirBaseHote } from "./base-hote";
import { appliquerEnvironnement, bindAutorise, chargerConfig, nativesPortees } from "./config";
import { composer } from "./composition";
import { CycleDeVie, DELAI_ARRET_MS } from "./cycle";
import { journal } from "./journal";
import { niveauDuJournal, parseFamiliesArgv } from "./lanceur";
import { avertirFamillesIgnorees, famillesNativesActives } from "./mcp/natives";
import { FABRIQUES_NATIVES } from "./mcp/registre";
import { verifierNatifs } from "./natif";
import { servirStdio } from "./stdio";

const GRACE_APRES_FORCAGE_MS = 2_000;
/** Sortie après un SIGHUP : relance demandée au lanceur (relance.sh, SuccessExitStatus=75), comme le core. */
const CODE_RELANCE = 75;

/** Code de sortie d'une commande, d'un refus ou de la session stdio ; `null` : service démarré, arrêté par signal. */
async function principal(argv: readonly string[]): Promise<number | null> {
  const ecrire = (l: string): boolean => process.stdout.write(`${l}\n`);
  if (argv.includes("--natif")) return verifierNatifs(ecrire);
  if (argv.includes("--familles-relayees")) {
    ecrire("");
    return 0;
  }
  if (argv.includes("--elpis-tools")) {
    process.stderr.write(
      "elpis-tools est retiré : rien à servir (sudo ./elpis service install retire son unité).\n",
    );
    return 0;
  }
  if (argv.includes("--empreinte"))
    return verifierEmpreinteBundle(
      import.meta.dirname,
      path.resolve(import.meta.dirname, "..", "..", ".."),
      ecrire,
    );
  const niveau = niveauDuJournal(process.env["TOOLHOST_LOG_LEVEL"]);
  if (niveau !== null) journalRacine.level = niveau;
  definirProcessus("toolhost");
  brancherJournalCommun(journal);
  brancherJournalSecurite(journal);
  brancherJournalVerrous(journal);
  const log = journal("toolhost");
  const tc = chargerConfig();
  const fams = parseFamiliesArgv(argv);
  if (fams !== null) {
    tc.families = parseFamilies(fams, (w) => log.warn(w));
    tc.familles_natives = nativesPortees(tc.families);
  }
  if (argv.includes("--familles-natives")) {
    const natives = famillesNativesActives(tc, FABRIQUES_NATIVES, log);
    avertirFamillesIgnorees(tc, natives, log);
    ecrire(natives.join(","));
    return 0;
  }
  if (argv.includes("--stdio") || tc.transport === "stdio") return servirStdio(tc, { journal: log });
  appliquerEnvironnement(tc);
  rechargerConfig();
  for (const w of tc.warnings) log.warn(w);
  if (!bindAutorise(tc.host, Boolean(tc.token))) {
    log.error(`REFUS : bind ${tc.host}:${tc.port} hors loopback sans jeton de service.`);
    return 2;
  }
  await ouvrirBaseHote(journal);
  const cycle = new CycleDeVie(journal("cycle"));
  const composition = composer(tc, { journal: log, cycle });
  cycle.alArret("service MCP", () => composition.fermer());
  cycle.alArret("base de l'hôte", fermerBaseHote);
  const app = await creerAppToolhost({
    tc,
    familles: composition.familles,
    journal: log,
    arretEnCours: () => cycle.arretEnCours,
  });
  await cycle.demarrer();
  await app.listen({ host: tc.host, port: tc.port });
  const servis = composition.natif?.transports() ?? [];
  const mcp =
    servis.map((t) => (t === "http" ? "/mcp[/<famille>]" : "/sse[/<famille>]")).join(" + ") ||
    "aucune famille";
  log.info(
    `hôte d'outils : http://${tc.host}:${tc.port}  (MCP ${mcp}, familles ${tc.families.join(", ")}` +
      `${composition.natif ? ` dont natives ${composition.natif.familles.map((f) => f.famille).join(", ")}` : ""}, ` +
      `auth=${tc.token ? "bearer" : "aucune (loopback)"})`,
  );
  let premier: NodeJS.Signals | null = null;
  const sortie = (reussi: boolean): number => (premier === "SIGHUP" ? CODE_RELANCE : reussi ? 0 : 1);
  const arreter = (signal: NodeJS.Signals): void => {
    if (premier !== null) {
      log.warn(`${signal} reçu pendant l'arrêt : sortie immédiate`);
      process.exit(sortie(false));
    }
    premier = signal;
    log.info(`${signal} reçu : arrêt gracieux (jusqu'à ${DELAI_ARRET_MS / 1000} s)`);
    cycle.annoncerArret();
    const balayage = setInterval(() => app.server.closeIdleConnections(), 500);
    const force = setTimeout(() => {
      log.warn("délai d'arrêt dépassé : connexions fermées de force");
      app.server.closeAllConnections();
      setTimeout(() => process.exit(sortie(false)), GRACE_APRES_FORCAGE_MS).unref();
    }, DELAI_ARRET_MS);
    void app
      .close()
      .then(() => cycle.executerArrets())
      .then(() => {
        clearInterval(balayage);
        clearTimeout(force);
        log.info("arrêt terminé");
        process.exit(sortie(true));
      })
      .catch((e: unknown) => {
        log.error({ err: e }, "arrêt en échec");
        process.exit(sortie(false));
      });
  };
  process.on("SIGTERM", arreter);
  process.on("SIGINT", arreter);
  process.on("SIGHUP", arreter);
  return null;
}

principal(process.argv.slice(2))
  .then((code) => {
    if (code !== null) process.exit(code);
  })
  .catch((e: unknown) => {
    journal("startup").fatal({ err: e }, "démarrage impossible");
    process.exit(1);
  });
