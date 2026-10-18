// SPDX-License-Identifier: MIT
/** apps/core/src/outils/mcp/en-processus.ts — familles du compte servies en processus (remplace appmcp :8766) : serveur MCP unique de main, client `inprocess` du pool, service HTTP du pont. */
import { strPy } from "@elpis/commun";
import type { ConfigMcp } from "@elpis/mcp";
import {
  brancherSurchargesErreurs,
  ServeurOutils,
  ServiceMcpHttp,
  SCOPE_LOCAL_TOOLS,
} from "@elpis/outils-mcp";
import type {
  DefinitionOutil,
  DefinitionRessource,
  FamilleAEnregistrer,
  JetonAcces,
  OptionsServeur,
} from "@elpis/outils-mcp";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { CTX } from "../../contexte/config-contexte";
import { journal } from "../../journal";

let serveur: ServeurOutils | null = null;
let service: ServiceMcpHttp | null = null;

/** Serveur `elpis-app` du process (créé à la composition de main), avec ses extinctions et surcharges d'erreurs. */
export function creerServeurEnProcessus(o: OptionsServeur = {}): {
  serveur: ServeurOutils;
  service: ServiceMcpHttp;
} {
  brancherSurchargesErreurs((code) => CTX.get(`errors.${code}`));
  const s = new ServeurOutils({ nom: "elpis-app", outilsEteints: () => CTX.disabledTools(), ...o });
  serveur = s;
  service = new ServiceMcpHttp({ serveur: s, verificateur: null });
  return { serveur: s, service };
}

/** Tests et arrêt : plus de serveur en processus. */
export function oublierServeurEnProcessus(): void {
  serveur = null;
  service = null;
}

export function serveurEnProcessus(): ServeurOutils | null {
  return serveur;
}

export function serviceEnProcessus(): ServiceMcpHttp | null {
  return service;
}

/** Famille du compte portée en TS (B3-05 et suivants) : enregistrée sur le serveur du process. */
export function enregistrerFamilleEnProcessus(
  famille: string,
  outils: readonly DefinitionOutil[],
  ressources: readonly DefinitionRessource[] = [],
): boolean {
  if (serveur === null) throw new Error("serveur MCP en processus absent (composition de main)");
  return serveur.enregistrerFamille(famille, outils, ressources);
}

/** Vague de familles du compte portées en TS : enregistrées ensemble, extinctions de la configuration appliquées une fois ensuite. */
export function enregistrerFamillesEnProcessus(vague: readonly FamilleAEnregistrer[]): string[] {
  if (serveur === null) throw new Error("serveur MCP en processus absent (composition de main)");
  return serveur.enregistrerFamilles(vague);
}

/** Client de confiance du core : identité par `_meta` (comme le jeton de service), familles de l'entrée du manifeste en liste blanche stricte (vide = aucune). */
export function jetonInterne(familles: readonly string[]): JetonAcces {
  return {
    token: "",
    client_id: "elpis-app",
    scopes: [SCOPE_LOCAL_TOOLS],
    expires_at: null,
    claims: {
      client_id: "elpis-app",
      scopes: [SCOPE_LOCAL_TOOLS],
      trusted_meta: true,
      delegated: true,
      families: [...familles],
    },
  };
}

/** Paire en mémoire pour une entrée `inprocess` : le côté serveur est branché, le côté client rendu ; `null` sans serveur. */
export function transportEnProcessus(cfg: ConfigMcp): InMemoryTransport | null {
  if (serveur === null) return null;
  const familles = Array.isArray(cfg["families"]) ? cfg["families"].map((f) => strPy(f)) : [];
  const [client, cote] = InMemoryTransport.createLinkedPair();
  serveur
    .connecter(cote, { famille: null, niveau: null, jetonDefaut: jetonInterne(familles) })
    .catch((e: unknown) => {
      journal("mcp").error("[mcp] serveur en processus : connexion impossible", e);
    });
  return client;
}
