// SPDX-License-Identifier: MIT
/** packages/rag/src/erreurs.ts — erreur typée du moteur RAG : code stable, statut HTTP et corps tronqué. */

export type CodeErreurRag =
  | "qdrant_injoignable"
  | "qdrant_http"
  | "collection_absente"
  | "collection_existe"
  | "dimension_differente"
  | "embeddings_injoignable"
  | "embeddings_http"
  | "embeddings_reponse"
  | "reranker_injoignable"
  | "reranker_http"
  | "reranker_reponse"
  | "delai"
  | "parametres"
  | "trop_de_passages"
  | "regex_invalide";

export class ErreurRag extends Error {
  override name = "ErreurRag";
  readonly code: CodeErreurRag;
  readonly statut: number | undefined;

  constructor(code: CodeErreurRag, message: string, statut?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.statut = statut;
  }
}

/** Vrai si `e` est l'abandon demandé par l'appelant (signal), pas une panne. */
export function estAbandon(e: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true && (e === signal.reason || (e instanceof Error && e.name === "AbortError"));
}
