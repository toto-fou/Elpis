// SPDX-License-Identifier: MIT
/** apps/core/src/familles/jobs.ts — tâches de fond vues par l'utilisateur : liste (`/jobs`, `/jobs all`), arrêt, « Ne pas me réveiller » d'une conversation, signal de saisie en cours. */
import { estDict, HttpError } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { corpsJsonValeurs, entrees, py } from "@elpis/http";
import type { FastifyRequest } from "fastify";

import type { ServiceJobs } from "../jobs/service";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";

export interface DependancesFamilleJobs {
  readonly service: ServiceJobs;
}

function chatDuChemin(req: FastifyRequest): string {
  return entrees(req, { path: { chat_id: py.str({ max_length: 200 }) } }).path.chat_id;
}

function corpsObjet(req: FastifyRequest): Dict {
  const c = corpsJsonValeurs(req);
  if (!estDict(c)) throw new HttpError(422, "corps JSON objet attendu");
  return c;
}

function listeDeTextes(v: unknown, nom: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    throw new HttpError(422, `${nom} doit être une liste d'identifiants`);
  return v.slice(0, 200);
}

export function creerFamilleJobs(dep: DependancesFamilleJobs): Famille {
  const s = dep.service;
  return {
    nom: "jobs",
    routes: [
      {
        methode: "GET",
        chemin: "/api/jobs",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const q = entrees(req, {
            query: {
              chat_id: py.str({ max_length: 200 }).defaut(""),
              scope: py.str({ max_length: 16 }).defaut(""),
            },
          }).query;
          if (!q.chat_id && q.scope !== "all") throw new HttpError(400, "chat_id ou scope=all requis");
          return s.liste(utilisateur(req), q.scope === "all" ? null : q.chat_id);
        },
      },
      {
        methode: "POST",
        chemin: "/api/jobs/stop",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const c = corpsObjet(req);
          const ids = listeDeTextes(c["ids"], "ids");
          const chatId = c["chat_id"] ?? null;
          const tous = c["all"] === true;
          if (chatId !== null && typeof chatId !== "string")
            throw new HttpError(422, "chat_id doit être un texte");
          if (ids === undefined && !chatId && !tous) throw new HttpError(400, "ids, chat_id ou all requis");
          return s.arreterJobs(utilisateur(req), {
            ...(ids === undefined ? {} : { ids }),
            ...(typeof chatId === "string" && chatId && !tous ? { chatId } : {}),
            tous,
          });
        },
      },
      {
        methode: "PUT",
        chemin: "/api/saved/chats/:chat_id/wake",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          const chatId = chatDuChemin(req);
          const valeur = corpsObjet(req)["wake_disabled"];
          if (typeof valeur !== "boolean") throw new HttpError(422, "wake_disabled doit être un booléen");
          if (!(await s.poserReveil(utilisateur(req), chatId, valeur)))
            throw new HttpError(404, "chat not found");
          return { ok: true, wake_disabled: valeur };
        },
      },
      {
        methode: "POST",
        chemin: "/api/chat/:chat_id/composing",
        processus: ["main"],
        acces: "session",
        traiter: async (req) => {
          await s.saisie(utilisateur(req), chatDuChemin(req));
          return { ok: true };
        },
      },
    ],
  };
}
