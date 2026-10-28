// SPDX-License-Identifier: MIT
/** apps/core/src/familles/coffre.ts — Paramètres › Coffre et fenêtre `/creds` : entrées du compte et jetons de conversation, mot de passe en écriture seule (aucun écho en cas d'erreur). */
import { HttpError } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { corpsJson, entrees, py } from "@elpis/http";
import type { FastifyRequest } from "fastify";

import { creerJetonCreds, listerJetons, renouvelerJeton, revoquerJeton } from "../coffre/jetons";
import {
  confirmerOrigine,
  creerEntree,
  ErreurCoffre,
  listerEntrees,
  modifierEntree,
  supprimerEntree,
} from "../coffre/stockage";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";

export interface DependancesCoffre {
  readonly base: Base;
}

function route(methode: DefinitionRoute["methode"], chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["main"], acces: "session", traiter };
}

/** Corps JSON lu à la main : le 422 de validation générique recopierait le mot de passe. */
function corps(req: FastifyRequest): Record<string, unknown> {
  let v: unknown;
  try {
    v = corpsJson(req);
  } catch {
    throw new HttpError(422, "Corps JSON invalide.");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new HttpError(422, "Objet JSON attendu.");
  return v as Record<string, unknown>;
}

async function garde<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ErreurCoffre) throw new HttpError(e.statut, e.message);
    throw e;
  }
}

const idChemin = (req: FastifyRequest): number => entrees(req, { path: { id: py.int() } }).path.id;

/** Chaque requête est bornée au compte connecté ; aucune réponse ne porte de mot de passe. */
export function creerFamilleCoffre(dep: DependancesCoffre): Famille {
  const base = dep.base;
  return {
    nom: "coffre",
    routes: [
      route("GET", "/api/coffre", async (req) => ({ items: await listerEntrees(base, utilisateur(req)) })),
      route("POST", "/api/coffre", (req) =>
        garde(async () => {
          const uid = utilisateur(req);
          const c = corps(req);
          const item = await creerEntree(base, uid, {
            nom: c["nom"],
            origin: c["origin"],
            username: c["username"],
            password: c["password"],
          });
          return { ok: true, item };
        }),
      ),
      route("PUT", "/api/coffre/:id", (req) =>
        garde(async () => {
          const uid = utilisateur(req);
          const id = idChemin(req);
          const c = corps(req);
          const item = await modifierEntree(base, uid, id, {
            ...(c["nom"] !== undefined ? { nom: c["nom"] } : {}),
            ...(c["origin"] !== undefined ? { origin: c["origin"] } : {}),
            ...(c["username"] !== undefined ? { username: c["username"] } : {}),
            ...(c["password"] !== undefined ? { password: c["password"] } : {}),
          });
          if (!item) throw new HttpError(404, "Entrée introuvable.");
          return { ok: true, item };
        }),
      ),
      route("POST", "/api/coffre/:id/confirmer", (req) =>
        garde(async () => {
          const uid = utilisateur(req);
          const id = idChemin(req);
          const item = await confirmerOrigine(base, uid, id, corps(req)["origin"]);
          if (!item) throw new HttpError(404, "Entrée introuvable.");
          return { ok: true, item };
        }),
      ),
      route("DELETE", "/api/coffre/:id", async (req) => {
        if (!(await supprimerEntree(base, utilisateur(req), idChemin(req))))
          throw new HttpError(404, "Entrée introuvable.");
        return { ok: true };
      }),
      route("GET", "/api/coffre/jetons", async (req) => {
        const uid = utilisateur(req);
        const { chat_id } = entrees(req, { query: { chat_id: py.str({ max_length: 200 }) } }).query;
        return { items: await listerJetons(base, uid, chat_id) };
      }),
      route("POST", "/api/coffre/jetons", (req) =>
        garde(async () => {
          const uid = utilisateur(req);
          const c = corps(req);
          const chatId = typeof c["chat_id"] === "string" ? c["chat_id"] : "";
          if (!chatId || chatId.length > 200) throw new HttpError(422, "Conversation requise.");
          const idEntree = c["entry_id"];
          if (idEntree !== undefined && (typeof idEntree !== "number" || !Number.isInteger(idEntree)))
            throw new HttpError(422, "Entrée invalide.");
          const r = await creerJetonCreds(base, uid, {
            chatId,
            ...(idEntree !== undefined ? { entryId: idEntree as number } : {}),
            origin: c["origin"],
            username: c["username"],
            password: c["password"],
            enregistrer: c["save"] === true,
          });
          return { ok: true, token: r.token, item: r.item };
        }),
      ),
      route("POST", "/api/coffre/jetons/:id/renouveler", async (req) => {
        const item = await renouvelerJeton(base, utilisateur(req), idChemin(req));
        if (!item) throw new HttpError(404, "Jeton introuvable.");
        return { ok: true, item };
      }),
      route("DELETE", "/api/coffre/jetons/:id", async (req) => {
        if (!(await revoquerJeton(base, utilisateur(req), idChemin(req))))
          throw new HttpError(404, "Jeton introuvable.");
        return { ok: true };
      }),
    ],
  };
}
