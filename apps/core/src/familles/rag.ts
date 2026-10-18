// SPDX-License-Identifier: MIT
/** apps/core/src/familles/rag.ts — `GET /api/rag/collections` : collections vues par le service `rag_app` (shared_infra/routes/tools.py), `[]` sur toute panne. */
import { veritePy } from "@elpis/commun";
import type { FastifyRequest } from "fastify";

import { listCollections } from "../rag/client";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";

/** Délai court : la page interroge la liste à chaque ouverture. */
const DELAI_COLLECTIONS_S = 3.0;

async function collections(req: FastifyRequest): Promise<unknown> {
  utilisateur(req);
  try {
    const cols = await listCollections(null, null, DELAI_COLLECTIONS_S);
    return { collections: veritePy(cols) ? cols : [] };
  } catch {
    return { collections: [] };
  }
}

export function creerFamilleRag(): Famille {
  return {
    nom: "rag",
    routes: [
      {
        methode: "GET",
        chemin: "/api/rag/collections",
        processus: ["main"],
        acces: "session",
        traiter: collections,
      },
    ],
  };
}
