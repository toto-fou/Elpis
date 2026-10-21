// SPDX-License-Identifier: MIT
/** apps/toolhost/src/composition.ts — composition de l'hôte : configuration, familles natives, client de rappel, familles de routes et tâches du cycle de vie. */
import { setTimeout as attendre } from "node:timers/promises";

import {
  arreterReadinessCache,
  definirFabriqueAgent,
  invalidateSandboxUsage,
  ipConteneurApercu,
  sandboxUsageBytes,
} from "@elpis/bac";
import type { IpConteneurApercu } from "@elpis/bac";
import type { Base } from "@elpis/db";
import { AgentClient, installerImportAncien } from "@elpis/fichiers";
import { commandeStdioHote } from "@elpis/mcp";
import { Agent } from "undici";

import type { Famille } from "./app";
import { BAC_DU_COMPTE, creerFamilleApercuFichiers } from "./apercu-fichiers";
import type { BacDuCompte } from "./apercu-fichiers";
import { creerFamilleBac } from "./bac/famille";
import { installerInvalidationUsage } from "./bac/instantanes";
import { creerFamilleCaptures } from "./captures";
import { creerFamilleTrames } from "./trames";
import type { ToolhostConfig } from "./config";
import type { CycleDeVie } from "./cycle";
import { arreterFilsCalcul } from "./fichiers/calcul-execution";
import { BAC_REGISTRE } from "./fichiers/commun";
import type { BacFichiers } from "./fichiers/commun";
import { boucleBalayage } from "./fichiers/entretien";
import { installerMetrique } from "./fichiers/ecriture";
import { creerFamilleFichiers } from "./fichiers/famille";
import { metriqueHote } from "./fichiers/metrique";
import type { Journal } from "./journal";
import { creerFamilleMandataireApercu } from "./mandataire-apercu";
import type { CommandeStdio } from "./manifeste";
import { CHEMINS_FACADE, contexteFacade, METHODES, traiterFacade } from "./mcp/facade";
import type { ContexteFacade } from "./mcp/facade";
import { avertirFamillesIgnorees, creerServiceNatif } from "./mcp/natives";
import { creerFamilleJobs } from "./mcp/shell/jobs/routes";
import { agentVeilleDuCompte, installerVeilleurJobs, VeilleurJobs } from "./mcp/shell/jobs/veilleur";
import type { FabriqueNative, ServiceNatif } from "./mcp/natives";
import { FABRIQUES_NATIVES } from "./mcp/registre";
import { arreterWorkerOffice } from "./mcp/office/famille";
import { arreterOffice } from "./office/apercu";
import { ClientRappel } from "./rappel";
import { creerFamilleSocle } from "./socle";
import { Terminaux } from "./terminal/pty";
import { baseDuTerminal, installerUsageTerminal, usageBranchee } from "./terminal/quota";
import type { LanceurPty } from "./terminal/pty";
import { creerFamilleTerminal } from "./terminal/routes";
import { SessionsTerminal } from "./terminal/sessions";

/** `_local_cleanup_loop` : PTY inactifs et sessions abandonnées balayés toutes les 5 min. */
export const NETTOYAGE_TERMINAUX_MS = 5 * 60_000;

export interface OptionsComposition {
  readonly journal: Journal;
  readonly cycle?: CycleDeVie;
  /** Point d'entrée stdio d'une famille ; défaut : `main.mjs --stdio --families <f>` de l'hôte (`commandeStdioHote`). */
  readonly stdio?: (famille: string) => CommandeStdio;
  readonly delaiConnexionMs?: number;
  readonly demarreA?: number;
  /** IP du conteneur pour l'aperçu ; défaut : `ipConteneurApercu` de @elpis/bac (tests : doublure). */
  readonly ipConteneurApercu?: IpConteneurApercu;
  /** Dossier de travail et agent du conteneur du compte ; défaut : `BAC_DU_COMPTE` (@elpis/bac). */
  readonly bacDuCompte?: BacDuCompte;
  /** Base des sessions du terminal (tests) ; sinon `baseHote()`, ouverte au démarrage. */
  readonly base?: Base;
  readonly lanceurPty?: LanceurPty;
  readonly maxPtyParCompte?: number;
  /** Familles natives connues ; défaut : celles portées en TS (registre). */
  readonly natives?: Readonly<Record<string, FabriqueNative>>;
  /** Bac et agent du compte des routes de fichiers ; défaut : registre de @elpis/bac (tests : bac sans conteneur). */
  readonly bacFichiers?: BacFichiers;
}

export interface Composition {
  readonly tc: ToolhostConfig;
  readonly familles: Famille[];
  readonly natif: ServiceNatif | null;
  readonly rappel: ClientRappel;
  readonly terminaux: Terminaux;
  readonly sessions: SessionsTerminal;
  /** Un passage du balayage des terminaux (PTY inactifs, lignes abandonnées). */
  nettoyerTerminaux(): Promise<void>;
  fermer(): Promise<void>;
}

export function stdioParDefaut(famille: string): CommandeStdio {
  const { command, args } = commandeStdioHote([famille]);
  return { command, args };
}

function familleFacade(ctx: ContexteFacade): Famille {
  const traiter = traiterFacade();
  return {
    nom: "mcp",
    contexte: contexteFacade(ctx),
    routes: CHEMINS_FACADE.map((chemin) => ({
      methode: METHODES,
      chemin,
      processus: ["toolhost"],
      acces: "mcp",
      traiter,
    })),
  };
}

export function composer(tc: ToolhostConfig, o: OptionsComposition): Composition {
  const agent = new Agent({
    connect: { timeout: o.delaiConnexionMs ?? 5_000 },
    headersTimeout: 0,
    bodyTimeout: 0,
    keepAliveTimeout: 4_000,
  });
  const rappel = new ClientRappel({ appUrl: tc.app_url, jeton: tc.token, journal: o.journal, agent });
  const veilleur = new VeilleurJobs({
    agent: agentVeilleDuCompte,
    relais: rappel,
    journal: o.journal,
    ...(o.cycle ? { arret: o.cycle.signalArret } : {}),
  });
  installerVeilleurJobs(veilleur);
  const natif = creerServiceNatif({
    tc,
    fabriques: o.natives ?? FABRIQUES_NATIVES,
    rappel,
    journal: o.journal,
  });
  avertirFamillesIgnorees(tc, natif?.familles.map((f) => f.famille) ?? [], o.journal);
  const facade: ContexteFacade = { natif, journal: o.journal };
  definirFabriqueAgent((bac) => new AgentClient(bac));
  const fixe = o.base;
  const base = (): Promise<Base> => (fixe === undefined ? baseDuTerminal() : Promise.resolve(fixe));
  const terminaux = new Terminaux({
    journal: o.journal,
    ...(o.lanceurPty ? { lanceur: o.lanceurPty } : {}),
    ...(o.maxPtyParCompte !== undefined ? { maxParCompte: o.maxPtyParCompte } : {}),
  });
  const sessions = new SessionsTerminal(base);
  const nettoyerTerminaux = async (): Promise<void> => {
    terminaux.nettoyerInactifs();
    const purgees = await sessions.purger();
    if (purgees) o.journal.info(`[PTY] purged ${purgees} abandoned session row(s) (>7d).`);
  };
  installerImportAncien((compte, d) => rappel.importAncien(compte, d));
  installerInvalidationUsage(invalidateSandboxUsage);
  installerMetrique((nom, valeur, etiquettes) => metriqueHote(o.journal, nom, valeur, etiquettes));
  installerUsageTerminal((uid, racine, quota) => sandboxUsageBytes(uid, racine, { quotaBytes: quota }));
  const cycle = o.cycle;
  if (cycle !== undefined) {
    cycle.auDemarrage("balayage des envois abandonnés", () => boucleBalayage(o.journal, cycle.signalArret), {
      arrierePlan: true,
    });
    cycle.alArret("threads de calcul (remplacements, .docx)", arreterFilsCalcul);
    cycle.alArret("conversions Office", arreterOffice);
    cycle.alArret("worker Office", arreterWorkerOffice);
    cycle.alArret("abonnement docker events", arreterReadinessCache);
    cycle.auDemarrage(
      "nettoyage des terminaux",
      () => balayer(nettoyerTerminaux, cycle.signalArret, o.journal),
      { arrierePlan: true },
    );
    cycle.alArret("terminaux", () => terminaux.tuerTout());
    cycle.auDemarrage("port de la jauge du terminal", () => {
      if (!usageBranchee())
        o.journal.warn(
          "[PTY] mesure d'occupation du bac non branchée : quota disque du terminal non appliqué",
        );
    });
  }
  return {
    tc,
    natif,
    rappel,
    familles: [
      creerFamilleSocle({
        tc,
        natif,
        stdio: o.stdio ?? stdioParDefaut,
        ...(o.demarreA !== undefined ? { demarreA: o.demarreA } : {}),
      }),
      creerFamilleBac({ journal: o.journal, ...(cycle ? { arret: cycle.signalArret } : {}) }),
      creerFamilleCaptures({
        journal: o.journal,
        playwrightApi: process.env["PLAYWRIGHT_API_URL"] ?? "http://localhost:3000",
      }),
      creerFamilleTrames({ journal: o.journal }),
      creerFamilleApercuFichiers(o.bacDuCompte ?? o.bacFichiers ?? BAC_DU_COMPTE),
      creerFamilleMandataireApercu({
        journal: o.journal,
        ipConteneur: o.ipConteneurApercu ?? ipConteneurApercu,
      }),
      creerFamilleTerminal({ terminaux, sessions, base, journal: o.journal, arret: cycle?.signalArret }),
      creerFamilleFichiers({
        bac: o.bacFichiers ?? BAC_REGISTRE,
        rappel,
        journal: o.journal,
        ...(cycle ? { arret: cycle.signalArret } : {}),
      }),
      creerFamilleJobs({ veilleur: () => veilleur }),
      familleFacade(facade),
    ],
    terminaux,
    sessions,
    nettoyerTerminaux,
    async fermer() {
      veilleur.arreter();
      installerVeilleurJobs(null);
      await natif?.fermer();
      await arreterWorkerOffice();
      arreterReadinessCache();
      definirFabriqueAgent(null);
      terminaux.tuerTout();
      installerImportAncien(null);
      installerInvalidationUsage(null);
      installerMetrique(null);
      installerUsageTerminal(null);
      await arreterFilsCalcul();
      await agent.destroy();
    },
  };
}

/** Boucle de fond : un balayage toutes les 5 min jusqu'à l'arrêt ; une erreur est journalisée sans arrêter la boucle. */
async function balayer(passage: () => Promise<void>, arret: AbortSignal, journal: Journal): Promise<void> {
  while (!arret.aborted) {
    try {
      await attendre(NETTOYAGE_TERMINAUX_MS, undefined, { signal: arret, ref: false });
    } catch {
      return;
    }
    try {
      await passage();
    } catch (e) {
      journal.warn(`[CLEANUP] _cleanup_idle_terminals: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
