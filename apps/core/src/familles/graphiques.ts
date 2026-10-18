// SPDX-License-Identifier: MIT
/** apps/core/src/familles/graphiques.ts — config d'un graphique : cache du compte d'abord, puis copie durable incrustée dans la conversation (shared_infra/charts/routes.py). */
import { getUsernameById } from "@elpis/auth";
import { estDict, getOu, HttpError, iterExige, pyJsonLoads, strPy, texteUtf8 } from "@elpis/commun";
import type { Base } from "@elpis/db";

import { getChat } from "../chats/stockage";
import { idGraphiqueSur, lireCacheGraphique } from "../graphiques/incrustation";
import { journal } from "../journal";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { entrees, py, reponseJsonPy } from "@elpis/http";

const log = journal("charts");

export interface DependancesGraphiques {
  readonly base: Base;
}

export function creerFamilleGraphiques(dep: DependancesGraphiques): Famille {
  const base = dep.base;
  return {
    nom: "graphiques",
    routes: [
      {
        methode: "GET",
        chemin: "/api/charts/:chart_id",
        processus: ["main"],
        acces: "session",
        traiter: async (req, rep) => {
          const { path, query } = entrees(req, {
            path: { chart_id: py.str() },
            query: { chat_id: py.str().defaut("") },
          });
          const uid = utilisateur(req);
          const nom = await getUsernameById(base, uid);
          if (!nom) throw new HttpError(500, "user record missing for authenticated session");
          const id = idGraphiqueSur(path.chart_id);
          if (!id) throw new HttpError(400, "invalid chart_id");
          let enCache: { config: unknown } | null = null;
          try {
            const octets = lireCacheGraphique(nom, id);
            if (octets !== null) {
              const texte = texteUtf8(octets);
              if (texte === undefined) throw new Error("'utf-8' codec can't decode bytes");
              enCache = { config: pyJsonLoads(texte) };
            }
          } catch (e) {
            log.warn(
              `[charts] cache illisible ${id}.json : ${e instanceof Error ? e.message : strPy(e)} — repli copie durable`,
            );
          }
          if (enCache !== null)
            return reponseJsonPy(rep, { ok: true, chart_id: id, config: enCache.config, source: "cache" });
          if (query.chat_id) {
            let chat: Awaited<ReturnType<typeof getChat>>;
            try {
              chat = await getChat(base, uid, query.chat_id);
            } catch {
              chat = null;
            }
            if (chat)
              for (const m of iterExige(getOu(chat, "messages", []))) {
                const graphiques = estDict(m) ? getOu(m, "charts", null) : null;
                if (estDict(graphiques) && Object.hasOwn(graphiques, id))
                  return reponseJsonPy(rep, {
                    ok: true,
                    chart_id: id,
                    config: graphiques[id],
                    source: "chat",
                  });
              }
          }
          throw new HttpError(404, `chart '${id}' not found`);
        },
      },
    ],
  };
}
