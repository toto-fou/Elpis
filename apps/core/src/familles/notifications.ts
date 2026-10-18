// SPDX-License-Identifier: MIT
/** apps/core/src/familles/notifications.ts — centre de notifications du compte : liste, compteur, lu/non lu, suppression (shared_infra/notifications/routes.py). */
import { maxPy, minPy } from "@elpis/commun";
import type { Base } from "@elpis/db";
import type { FastifyRequest } from "fastify";

import {
  clearAll,
  countUnread,
  deleteNotification,
  listNotifications,
  markAllRead,
  markRead,
  markUnread,
} from "../notifications/stockage";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { utilisateur } from "./comptes";
import { entrees, py } from "@elpis/http";

export interface DependancesNotifications {
  readonly base: Base;
}

function route(methode: DefinitionRoute["methode"], chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["main"], acces: "session", traiter };
}

const idNotification = (req: FastifyRequest): number =>
  entrees(req, { path: { notif_id: py.int() } }).path.notif_id;

/** Chaque requête est filtrée par le compte : l'id d'une notification d'autrui ne change rien. */
export function creerFamilleNotifications(dep: DependancesNotifications): Famille {
  const base = dep.base;
  return {
    nom: "notifications",
    routes: [
      route("GET", "/api/notifications", async (req) => {
        const uid = utilisateur(req);
        const { query } = entrees(req, {
          query: { before: py.optional(py.int()).defaut(null), limit: py.int().defaut(50) },
        });
        const limite = maxPy(1, minPy(query.limit, 100));
        const items = await listNotifications(base, uid, limite, query.before);
        return { items, unread: await countUnread(base, uid) };
      }),
      route("GET", "/api/notifications/unread-count", async (req) => ({
        count: await countUnread(base, utilisateur(req)),
      })),
      route("PATCH", "/api/notifications/:notif_id/read", async (req) => {
        const uid = utilisateur(req);
        await markRead(base, uid, idNotification(req));
        return { ok: true, unread: await countUnread(base, uid) };
      }),
      route("PATCH", "/api/notifications/:notif_id/unread", async (req) => {
        const uid = utilisateur(req);
        await markUnread(base, uid, idNotification(req));
        return { ok: true, unread: await countUnread(base, uid) };
      }),
      route("POST", "/api/notifications/read-all", async (req) => ({
        ok: true,
        marked: await markAllRead(base, utilisateur(req)),
        unread: 0,
      })),
      route("DELETE", "/api/notifications/:notif_id", async (req) => {
        const uid = utilisateur(req);
        await deleteNotification(base, uid, idNotification(req));
        return { ok: true, unread: await countUnread(base, uid) };
      }),
      route("POST", "/api/notifications/clear", async (req) => ({
        ok: true,
        cleared: await clearAll(base, utilisateur(req)),
        unread: 0,
      })),
    ],
  };
}
