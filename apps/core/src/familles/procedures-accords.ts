// SPDX-License-Identifier: MIT
/** apps/core/src/familles/procedures-accords.ts — accords humains des gestes sensibles d'une procédure : demandes en attente d'une conversation et décision du compte connecté (jamais un outil). */
import { HttpError } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { corpsJson, entrees, py } from "@elpis/http";

import { decider, demandesEnAttente } from "../procedures/demandes";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";

export interface DependancesAccords {
  readonly base: Base;
}

/** Routes de session du process main : chaque requête est bornée au compte connecté. */
export function creerFamilleAccordsProcedures(dep: DependancesAccords): Famille {
  return {
    nom: "procedures-accords",
    routes: [
      {
        methode: "GET",
        chemin: "/api/procedures/approbations",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const { chat_id } = entrees(req, { query: { chat_id: py.str({ max_length: 200 }) } }).query;
          return { items: chat_id ? await demandesEnAttente(dep.base, uid, chat_id) : [] };
        },
      },
      {
        methode: "POST",
        chemin: "/api/procedures/approbations/:id/decision",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const uid = utilisateur(req);
          const { id } = entrees(req, { path: { id: py.str({ max_length: 100 }) } }).path;
          let corps: unknown;
          try {
            corps = corpsJson(req);
          } catch {
            corps = null;
          }
          const decision = (corps as { decision?: unknown } | null)?.decision;
          if (decision !== "approve" && decision !== "refuse") throw new HttpError(422, "Décision attendue.");
          const item = await decider(dep.base, uid, id, decision);
          if (item === null) throw new HttpError(404, "Demande introuvable, déjà traitée ou expirée.");
          return { ok: true, item };
        },
      },
    ],
  };
}
