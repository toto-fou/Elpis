// SPDX-License-Identifier: MIT
/** apps/core/src/rag/nettoyage.ts — rappels de nettoyage après la suppression des lignes RAG d'un compte (fichiers du magasin, collections Qdrant, avis aux lecteurs). */
import { journal } from "../journal";

const log = journal("rag");

/** Collection disparue avec son compte, relevée avant la suppression des lignes. */
export interface CollectionPartieRag {
  readonly id: string;
  readonly owner_user_id: number;
  readonly name: string;
  readonly visibility: string;
  readonly group_ids: readonly number[];
}

export type NettoyageRag = (uid: number, collections: readonly CollectionPartieRag[]) => void | Promise<void>;

const rappels = new Set<NettoyageRag>();

/** Inscrit un rappel du process ; rend sa désinscription. */
export function inscrireNettoyageRag(rappel: NettoyageRag): () => void {
  rappels.add(rappel);
  return () => {
    rappels.delete(rappel);
  };
}

/** Appelle chaque rappel après la suppression du compte ; un échec est journalisé, jamais propagé. */
export async function nettoyerRagCompte(
  uid: number,
  collections: readonly CollectionPartieRag[],
): Promise<void> {
  for (const rappel of [...rappels]) {
    try {
      await rappel(uid, collections);
    } catch (e) {
      log.error({ err: e }, `[rag] nettoyage du compte ${uid} en échec`);
    }
  }
}
