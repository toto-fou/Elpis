// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/natives.ts — familles servies par l'hôte lui-même (@elpis/outils-mcp) derrière la façade : serveur, jetons et portée, routage des requêtes MCP, agrégats de /health et /manifest. */
import type { IncomingMessage, ServerResponse } from "node:http";

import { cheminContextConfig, deepGet, outilsEteints, readJsonFile } from "@elpis/config";
import { FAMILY_NAMES } from "@elpis/mcp";
import {
  brancherSurchargesErreurs,
  chargerJetons,
  creerVerificateur,
  ServeurOutils,
  ServiceMcpHttp,
} from "@elpis/outils-mcp";
import type { DefinitionOutil } from "@elpis/outils-mcp";

import type { ToolhostConfig } from "../config";
import type { Journal } from "../journal";
import { familleDuChemin, HTTP_MOUNT_PATH, SSE_MOUNT_PATH } from "../porte";
import type { ClientRappel } from "../rappel";

/** Famille portée en TS servie par l'hôte : ses outils (définitions du golden, traitements). */
export interface FamilleNative {
  readonly famille: string;
  readonly outils: readonly DefinitionOutil[];
}

/** Fabrique d'une famille native, appelée seulement si la configuration la demande. */
export type FabriqueNative = (o: {
  tc: ToolhostConfig;
  rappel: ClientRappel;
  journal: Journal;
}) => FamilleNative;

export interface OptionsNatives {
  readonly tc: ToolhostConfig;
  readonly fabriques: Readonly<Record<string, FabriqueNative>>;
  readonly rappel: ClientRappel;
  readonly journal: Journal;
}

export class ServiceNatif {
  readonly familles: readonly FamilleNative[];
  readonly serveur: ServeurOutils;
  readonly service: ServiceMcpHttp;
  private readonly configures: readonly string[];

  constructor(
    familles: readonly FamilleNative[],
    serveur: ServeurOutils,
    service: ServiceMcpHttp,
    tc: ToolhostConfig,
  ) {
    this.familles = familles;
    this.serveur = serveur;
    this.service = service;
    this.configures = tc.transports;
  }

  /** Requête MCP d'une famille native (`/mcp/<f>`, `/sse/<f>`), d'une session SSE ouverte ici (`/messages/`), ou racine `/mcp` (`/sse`) : toutes les familles natives, comme le point d'entrée agrégé du Python. */
  prend(chemin: string, requete: string): boolean {
    if (chemin === "/messages" || chemin.startsWith("/messages/")) return this.service.aSessionSse(requete);
    if (chemin === HTTP_MOUNT_PATH) return true;
    if (chemin === SSE_MOUNT_PATH) return this.configures.includes("sse");
    const fam = familleDuChemin(chemin);
    return typeof fam === "string" && this.sert(fam);
  }

  traiter(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    return this.service.traiter(req, res);
  }

  /** Transports servis par les familles natives, dans l'ordre de la configuration. */
  transports(): string[] {
    return this.configures.filter((t) => t === "http" || t === "sse");
  }

  sert(famille: string): boolean {
    return this.familles.some((f) => f.famille === famille);
  }

  /** Outils visibles (non éteints) par nom, avec leur famille. */
  outils(): Map<string, string> {
    const carte = new Map<string, string>();
    for (const f of this.familles)
      for (const o of f.outils)
        if (this.serveur.appelable(o.nom, { jeton: null, famille: null })) carte.set(o.nom, f.famille);
    return carte;
  }

  fermer(): Promise<void> {
    return this.service.fermer();
  }
}

/** Familles natives demandées et servies (`families`) qui ont une implémentation ; les autres sont signalées et ignorées. */
export function famillesNativesActives(
  tc: ToolhostConfig,
  fabriques: Readonly<Record<string, FabriqueNative>>,
  journal: Journal,
): string[] {
  const actives: string[] = [];
  for (const f of tc.familles_natives) {
    if (!tc.families.includes(f)) journal.warn(`famille native ${f} hors de families : ignorée`);
    else if (fabriques[f] === undefined) journal.warn(`famille native ${f} sans implémentation TS : ignorée`);
    else actives.push(f);
  }
  return FAMILY_NAMES.filter((f) => actives.includes(f));
}

/** Familles de `families` que l'hôte ne sert pas : signalées (celles du compte sont servies par main d'après mcp.json). */
export function avertirFamillesIgnorees(
  tc: ToolhostConfig,
  natives: readonly string[],
  journal: Journal,
): string[] {
  const ignorees = tc.families.filter((f) => !natives.includes(f));
  for (const f of ignorees)
    journal.warn(
      `famille ${f} non servie par l'hôte d'outils : ignorée (chart, memory, skill et todo sont servies par main, d'après mcp.json)`,
    );
  return ignorees;
}

/** Outils des familles natives `noms` : identité par rappel au core, outils éteints et libellés d'erreur de context_config. */
export function creerServeurNatif(
  o: OptionsNatives,
  noms: readonly string[],
): { familles: FamilleNative[]; serveur: ServeurOutils } {
  const contexte = readJsonFile(cheminContextConfig());
  brancherSurchargesErreurs((code) => deepGet(contexte, `errors.${code}`, null));
  const serveur = new ServeurOutils({ rappel: o.rappel, outilsEteints: () => outilsEteints(contexte) });
  const familles = noms.map((f) =>
    (o.fabriques[f] as FabriqueNative)({ tc: o.tc, rappel: o.rappel, journal: o.journal }),
  );
  for (const f of familles) serveur.enregistrerFamille(f.famille, f.outils);
  return { familles, serveur };
}

/** Service HTTP des familles natives (`null` sans famille native) : jetons et délégation de la configuration, introspection par rappel au core. */
export function creerServiceNatif(o: OptionsNatives): ServiceNatif | null {
  const noms = famillesNativesActives(o.tc, o.fabriques, o.journal);
  if (noms.length === 0) return null;
  const { familles, serveur } = creerServeurNatif(o, noms);
  const verificateur = creerVerificateur({
    jetons: { ...chargerJetons(), service: o.tc.token },
    introspection: o.rappel,
  });
  const service = new ServiceMcpHttp({
    serveur,
    verificateur,
    http: HTTP_MOUNT_PATH,
    sse: o.tc.transports.includes("sse") ? SSE_MOUNT_PATH : null,
    porteSurTout: false,
  });
  return new ServiceNatif(familles, serveur, service, o.tc);
}
