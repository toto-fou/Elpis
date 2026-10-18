// SPDX-License-Identifier: MIT
/** apps/toolhost/src/app.ts — serveur Fastify de l'hôte d'outils : socle de @elpis/http, porte d'entrée avant le routage, gardes de l'hôte. */
import { HttpError } from "@elpis/commun";
import { cheminDecode, creerAppHttp, premierEntete } from "@elpis/http";
import type { DefinitionRoute as DefinitionRouteHttp, Famille as FamilleHttp } from "@elpis/http";
import { originAllowed } from "@elpis/mcp";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ToolhostConfig } from "./config";
import type { Journal } from "./journal";
import { familleDuChemin, installerPorte, sansRoute } from "./porte";

export type ModeToolhost = "toolhost";
/** `enveloppe` : jeton de service et enveloppe d'identité (porte de l'API) ; `mcp` : portes du service MCP, jeton vérifié par elpis-tools. */
export type AccesToolhost = "public" | "enveloppe" | "mcp";
export type DefinitionRoute = DefinitionRouteHttp<ModeToolhost, AccesToolhost>;
export type Famille = FamilleHttp<ModeToolhost, AccesToolhost>;

export interface OptionsAppToolhost {
  readonly tc: ToolhostConfig;
  readonly familles: readonly Famille[];
  readonly journal?: Journal;
  readonly arretEnCours?: () => boolean;
}

/** Défense en profondeur : la porte a déjà posé l'identité de l'enveloppe. */
function gardeEnveloppe(requete: FastifyRequest): void {
  if (requete.identite === null)
    throw new HttpError(401, "enveloppe d'identité absente ou invalide", { "WWW-Authenticate": "Bearer" });
}

/** Défense en profondeur : Origin et famille déjà contrôlés par la porte. */
function gardeMcp(requete: FastifyRequest): void {
  if (!originAllowed(premierEntete(requete, "origin"))) throw new HttpError(403, "origine non autorisée");
  if (familleDuChemin(cheminDecode(requete)) === null) throw new HttpError(404);
}

export async function creerAppToolhost(o: OptionsAppToolhost): Promise<FastifyInstance> {
  return creerAppHttp<ModeToolhost, AccesToolhost>({
    mode: "toolhost",
    familles: o.familles,
    gardes: { enveloppe: gardeEnveloppe, mcp: gardeMcp },
    extensions: [(app) => installerPorte(app, { jeton: o.tc.token, decalageMaxS: o.tc.identity_max_skew_s })],
    introuvable: sansRoute,
    ...(o.journal ? { journal: o.journal } : {}),
    ...(o.arretEnCours ? { arretEnCours: o.arretEnCours } : {}),
    corsOrigines: [],
  });
}
