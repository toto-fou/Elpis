// SPDX-License-Identifier: MIT
/** apps/core/src/familles/procedures-accords.ts — accords humains des gestes sensibles d'une procédure : demandes en attente d'une conversation et décision du compte connecté (jamais un outil). */
import { HttpError } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { corpsJson, entrees, py } from "@elpis/http";
import type { FastifyRequest } from "fastify";

import { decider, demandesEnAttente } from "../procedures/demandes";
import {
  approuverVersion,
  listerProcedures,
  resumerVersion,
  supprimerProcedure,
} from "../procedures/gestion";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";

export interface DependancesAccords {
  readonly base: Base;
}

/** Compte de la session de l'utilisateur : l'identité de l'hôte d'outils n'est jamais admise ici (le modèle ne décide pas). */
function compteHumain(req: FastifyRequest): { uid: number; owner: string } {
  if (req.identiteToolhost) throw new HttpError(403, "Réservé à la session de l'utilisateur.");
  const uid = utilisateur(req);
  const owner = req.utilisateur?.username;
  if (!owner) throw new HttpError(401, "not logged in");
  return { uid, owner };
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
          const { uid } = compteHumain(req);
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
          const { uid } = compteHumain(req);
          const { id } = entrees(req, { path: { id: py.str({ max_length: 100 }) } }).path;
          // Un formulaire inter-site ne peut pas poster de JSON : le type est exigé en plus de la garde CSRF.
          if (!/^application\/json\b/iu.test(String(req.headers["content-type"] ?? "")))
            throw new HttpError(415, "JSON attendu.");
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
      {
        methode: "GET",
        chemin: "/api/procedures",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => ({ items: await listerProcedures(dep.base, compteHumain(req).owner) }),
      },
      {
        methode: "GET",
        chemin: "/api/procedures/:id/versions/:version",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const { owner } = compteHumain(req);
          const { id, version } = chemin(req);
          const r = await resumerVersion(dep.base, owner, id, version);
          if (r === null) throw new HttpError(404, "Version introuvable.");
          return r;
        },
      },
      {
        methode: "POST",
        chemin: "/api/procedures/:id/versions/:version/approve",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const { owner } = compteHumain(req);
          const { id, version } = chemin(req);
          const t = await approuverVersion(dep.base, owner, id, version);
          if (t === null) throw new HttpError(404, "Version introuvable.");
          return { ok: true, approved_at: t };
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/procedures/:id",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const { owner } = compteHumain(req);
          const { id } = entrees(req, { path: { id: py.str({ max_length: 100 }) } }).path;
          const n = await supprimerProcedure(dep.base, owner, id, 0);
          if (n === 0) throw new HttpError(404, "Procédure introuvable.");
          return { ok: true, deleted: n };
        },
      },
      {
        methode: "DELETE",
        chemin: "/api/procedures/:id/versions/:version",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const { owner } = compteHumain(req);
          const { id, version } = chemin(req);
          const n = await supprimerProcedure(dep.base, owner, id, version);
          if (n === 0) throw new HttpError(404, "Version introuvable.");
          return { ok: true, deleted: n };
        },
      },
    ],
  };
}

function chemin(req: FastifyRequest): { id: string; version: number } {
  const p = entrees(req, { path: { id: py.str({ max_length: 100 }), version: py.int() } }).path;
  if (p.version < 1) throw new HttpError(422, "Version invalide.");
  return p;
}
