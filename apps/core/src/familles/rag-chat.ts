// SPDX-License-Identifier: MIT
/** apps/core/src/familles/rag-chat.ts — collections actives d'une conversation (`PUT /api/saved/chats/:chat_id/rag`) : le serveur fait autorité, chaque collection doit être lisible par le compte. */
import { schemaCorpsRagChat } from "@elpis/contracts";

import { accesCollection } from "../rag/acces";
import { ecrireReglageRagChat, lireReglageRagChat } from "../rag/chat";
import { corpsValide, ErreurRouteRag, exigerDroit, parametre } from "../rag/http";
import type { DefinitionRoute } from "../routes";
import { utilisateur } from "./comptes";
import { routeRag } from "./rag-aides";
import type { RoutesRagResolues } from "./rag-aides";

const introuvable = (): ErreurRouteRag =>
  new ErreurRouteRag(404, "chat_introuvable", "Conversation introuvable.");

export function routesChatRag(dep: RoutesRagResolues): DefinitionRoute[] {
  const base = dep.base;
  return [
    routeRag("PUT", "/api/saved/chats/:chat_id/rag", async (req) => {
      const uid = utilisateur(req);
      const corps = corpsValide(req, schemaCorpsRagChat);
      const chatId = parametre(req, "chat_id");
      if (!chatId) throw introuvable();
      if (corps.collections.length) await exigerDroit(base, uid);
      for (const id of corps.collections)
        if ((await accesCollection(base, uid, id)) === null)
          throw new ErreurRouteRag(404, "collection_introuvable", "Collection introuvable.");
      const actuel = await lireReglageRagChat(base, uid, chatId);
      if (actuel === null) throw introuvable();
      const reglage = {
        collections: corps.collections,
        mode: corps.mode ?? actuel.mode,
        top_k: corps.top_k ?? actuel.top_k,
      };
      if (!(await ecrireReglageRagChat(base, uid, chatId, reglage))) throw introuvable();
      return { ok: true, rag: reglage };
    }),
  ];
}
