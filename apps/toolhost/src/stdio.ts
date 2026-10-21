// SPDX-License-Identifier: MIT
/** apps/toolhost/src/stdio.ts — `main.mjs --stdio --families <f>` : familles natives servies sur stdio comme `python -m toolhost --stdio` (identité du `_meta`, aucun jeton, aucun port). */
import type { Readable, Writable } from "node:stream";

import { arreterReadinessCache, definirFabriqueAgent } from "@elpis/bac";
import { rechargerConfig } from "@elpis/config";
import { AgentClient } from "@elpis/fichiers";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Agent } from "undici";

import { fermerBaseHote, ouvrirBaseHote } from "./base-hote";
import { appliquerEnvironnement } from "./config";
import type { ToolhostConfig } from "./config";
import { journal as fabriqueJournal } from "./journal";
import type { Journal } from "./journal";
import { avertirFamillesIgnorees, creerServeurNatif, famillesNativesActives } from "./mcp/natives";
import type { FabriqueNative } from "./mcp/natives";
import { arreterWorkerOffice } from "./mcp/office/famille";
import { FABRIQUES_NATIVES } from "./mcp/registre";
import { arreterOffice } from "./office/apercu";
import { ClientRappel } from "./rappel";

const SIGNAUX: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

export interface OptionsStdio {
  readonly journal: Journal;
  readonly fabriques?: Readonly<Record<string, FabriqueNative>>;
  /** Canal JSON-RPC (tests) ; défaut : stdin et stdout du process. */
  readonly entree?: Readable;
  readonly sortie?: Writable;
}

/** Sert les familles natives de `tc.families` sur stdio jusqu'à la fermeture de l'entrée ; aucune servie : refus (code 2). */
export async function servirStdio(tc: ToolhostConfig, o: OptionsStdio): Promise<number> {
  const fabriques = o.fabriques ?? FABRIQUES_NATIVES;
  const natives = famillesNativesActives(tc, fabriques, o.journal);
  avertirFamillesIgnorees(tc, natives, o.journal);
  if (natives.length === 0) {
    o.journal.error("stdio : aucune des familles demandées n'est servie (--families <famille>)");
    return 2;
  }
  tc.transport = "stdio";
  tc.transports = [];
  appliquerEnvironnement(tc);
  rechargerConfig();
  for (const w of tc.warnings) o.journal.warn(w);
  return servirNatives(tc, natives, fabriques, o);
}

/** Familles natives sur stdio : session sans jeton (identité du `_meta`, rappel au core pour l'id), toutes les familles enregistrées visibles. */
async function servirNatives(
  tc: ToolhostConfig,
  natives: readonly string[],
  fabriques: Readonly<Record<string, FabriqueNative>>,
  o: OptionsStdio,
): Promise<number> {
  const agent = new Agent({ connect: { timeout: 5_000 }, keepAliveTimeout: 4_000 });
  const rappel = new ClientRappel({ appUrl: tc.app_url, jeton: tc.token, journal: o.journal, agent });
  definirFabriqueAgent((bac) => new AgentClient(bac));
  await ouvrirBaseHote(fabriqueJournal);
  const { serveur } = creerServeurNatif({ tc, fabriques, rappel, journal: o.journal }, natives);
  const entree = o.entree ?? process.stdin;
  const transport = new StdioServerTransport(entree, o.sortie ?? process.stdout);
  const fermer = (): void => void transport.close();
  const ferme = new Promise<void>((fin) => {
    transport.onclose = fin;
  });
  entree.once("end", fermer);
  for (const s of SIGNAUX) process.on(s, fermer);
  await serveur.connecter(transport, { famille: null, niveau: null, jetonDefaut: null });
  await ferme;
  for (const s of SIGNAUX) process.off(s, fermer);
  arreterReadinessCache();
  await arreterOffice();
  await arreterWorkerOffice();
  definirFabriqueAgent(null);
  await fermerBaseHote();
  await agent.destroy();
  return 0;
}
