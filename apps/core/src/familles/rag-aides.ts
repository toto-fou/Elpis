// SPDX-License-Identifier: MIT
/** apps/core/src/familles/rag-aides.ts — dépendances et aides communes aux familles de routes RAG : définition d'une route de session, collection de la requête avec le rôle du compte, service d'indexation. */
import { configRag } from "@elpis/config";
import type { Base } from "@elpis/db";
import { ClientQdrant } from "@elpis/rag";
import type { ClientEmbeddings, ClientReranker } from "@elpis/rag";
import type { FastifyRequest } from "fastify";

import { accesCollection } from "../rag/acces";
import type { RoleRag } from "../rag/acces";
import type { DependancesEtatRag } from "../rag/etat";
import {
  avecErreursRag,
  ErreurRouteRag,
  exigerDroit,
  idCollection,
  MESSAGE_LECTURE_SEULE,
} from "../rag/http";
import { serviceIndexationRag } from "../rag/service";
import type { ServiceIndexationRag } from "../rag/service";
import { lireCollection } from "../rag/travaux";
import type { LigneCollectionRag } from "../rag/travaux";
import type { DefinitionRoute, Traitement } from "../routes";
import { utilisateur } from "./comptes";

/** Ce que les routes RAG empruntent au reste du core ; tout est remplaçable par les tests. */
export interface DependancesFamilleRag {
  readonly base: Base;
  /** Service d'indexation du process (par défaut celui de la composition). */
  readonly service?: (() => ServiceIndexationRag | null) | undefined;
  /** Client Qdrant de la configuration courante (par défaut `rag.qdrant_url`). */
  readonly qdrant?: (() => ClientQdrant) | undefined;
  readonly embeddings?: ((modele: string) => ClientEmbeddings) | undefined;
  readonly reranker?: (() => ClientReranker | null) | undefined;
  readonly sondeExtracteur?: DependancesEtatRag["sondeExtracteur"];
  /** Notification d'un partage (par défaut `pousserNotification`). */
  readonly notifier?:
    ((n: { uid: number; title: string; body: string; collectionId: string }) => Promise<unknown>) | undefined;
}

export interface RoutesRagResolues {
  readonly base: Base;
  readonly service: () => ServiceIndexationRag | null;
  readonly qdrant: () => ClientQdrant;
  readonly embeddings: DependancesFamilleRag["embeddings"];
  readonly reranker: DependancesFamilleRag["reranker"];
  readonly sondeExtracteur: DependancesFamilleRag["sondeExtracteur"];
  readonly notifier: DependancesFamilleRag["notifier"];
}

export function resoudreDependancesRag(dep: DependancesFamilleRag): RoutesRagResolues {
  return {
    base: dep.base,
    service: dep.service ?? serviceIndexationRag,
    qdrant: dep.qdrant ?? (() => new ClientQdrant({ url: configRag().qdrant_url })),
    embeddings: dep.embeddings,
    reranker: dep.reranker,
    sondeExtracteur: dep.sondeExtracteur,
    notifier: dep.notifier,
  };
}

/** Route du compte (processus main, session), dont les refus du domaine deviennent `{detail, code}`. */
export function routeRag(
  methode: DefinitionRoute["methode"],
  chemin: string,
  traiter: Traitement,
): DefinitionRoute {
  return { methode, chemin, processus: ["main"], acces: "session", traiter: avecErreursRag(traiter) };
}

/** Service d'indexation du process, sinon 503 (jamais avant la composition). */
export function serviceExige(dep: RoutesRagResolues): ServiceIndexationRag {
  const s = dep.service();
  if (s === null)
    throw new ErreurRouteRag(
      503,
      "rag_desactive",
      "Le RAG n'est pas encore démarré : réessayez dans un instant.",
    );
  return s;
}

export interface ContexteCollection {
  readonly uid: number;
  readonly id: string;
  readonly role: RoleRag;
  readonly ligne: LigneCollectionRag;
}

/** Collection de la requête vue par le compte : droit RAG (403), puis rôle (404 si invisible) ; l'écriture exige d'en être propriétaire (403 `lecture_seule`). */
export async function collectionDeLaRequete(
  dep: RoutesRagResolues,
  req: FastifyRequest,
  o: { ecriture?: boolean } = {},
): Promise<ContexteCollection> {
  const uid = utilisateur(req);
  await exigerDroit(dep.base, uid);
  const id = idCollection(req);
  const role = await accesCollection(dep.base, uid, id);
  if (role === null) throw new ErreurRouteRag(404, "collection_introuvable", "Collection introuvable.");
  if (o.ecriture && role !== "proprietaire")
    throw new ErreurRouteRag(403, "lecture_seule", MESSAGE_LECTURE_SEULE);
  const ligne = await lireCollection(dep.base, id);
  if (ligne === null) throw new ErreurRouteRag(404, "collection_introuvable", "Collection introuvable.");
  return { uid, id, role, ligne };
}
