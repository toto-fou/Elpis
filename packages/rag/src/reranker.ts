// SPDX-License-Identifier: MIT
/** packages/rag/src/reranker.ts — client `/v1/rerank` (llama.cpp, Jina, Cohere : `results[].relevance_score` ; TEI : `[{index, score}]`). */
import { ErreurRag } from "./erreurs";
import { appeler, estObjet, extrait, jsonOuNul, sansBarresFinales } from "./reseau";
import type { FetchRag } from "./reseau";

export interface OptionsReranker {
  url: string;
  modele?: string;
  cleApi?: string | undefined;
  delaiMs?: number;
  caracteresMax?: number;
  fetch?: FetchRag;
}

export interface ScoreReclassement {
  index: number;
  score: number;
}

const DELAI_DEFAUT_MS = 10_000;
const MODELE_DEFAUT = "bge-reranker-v2-m3";
const CARACTERES_DEFAUT = 2_000;

/** Scores d'une réponse de reclassement, triés du meilleur au moins bon ; erreur si aucun n'est exploitable. */
export function lireReclassement(json: unknown, nbDocuments: number): ScoreReclassement[] {
  const liste: unknown = Array.isArray(json)
    ? json
    : estObjet(json)
      ? (json["results"] ?? json["data"])
      : undefined;
  if (!Array.isArray(liste))
    throw new ErreurRag("reranker_reponse", "réponse du reranker sans liste de résultats");
  const sortie: ScoreReclassement[] = [];
  for (const e of liste as unknown[]) {
    if (!estObjet(e)) continue;
    const index = e["index"];
    const score = e["relevance_score"] ?? e["score"];
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= nbDocuments) continue;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    sortie.push({ index, score });
  }
  if (sortie.length === 0)
    throw new ErreurRag("reranker_reponse", "réponse du reranker sans résultat exploitable");
  return sortie.sort((a, b) => b.score - a.score || a.index - b.index);
}

export class ClientReranker {
  private readonly adresse: string;
  private readonly modele: string;
  private readonly cleApi: string | undefined;
  private readonly delaiMs: number;
  private readonly caracteresMax: number;
  private readonly fetchImpl: FetchRag;

  constructor(options: OptionsReranker) {
    this.adresse = `${sansBarresFinales(options.url).replace(/\/v1$/, "")}/v1/rerank`;
    this.modele = options.modele && options.modele !== "" ? options.modele : MODELE_DEFAUT;
    this.cleApi = options.cleApi && options.cleApi !== "" ? options.cleApi : undefined;
    this.delaiMs = options.delaiMs ?? DELAI_DEFAUT_MS;
    this.caracteresMax = Math.max(1, options.caracteresMax ?? CARACTERES_DEFAUT);
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Classe `documents` selon `requete` : indices et scores, du plus pertinent au moins pertinent (au plus `topN`). */
  async classer(
    requete: string,
    documents: readonly string[],
    options: { topN?: number; signal?: AbortSignal | undefined } = {},
  ): Promise<ScoreReclassement[]> {
    if (documents.length === 0) return [];
    const rep = await appeler({
      fetch: this.fetchImpl,
      origine: "reranker",
      methode: "POST",
      url: this.adresse,
      corps: {
        model: this.modele,
        query: requete,
        documents: documents.map((d) => d.slice(0, this.caracteresMax)),
        top_n: Math.min(options.topN ?? documents.length, documents.length),
        return_documents: false,
      },
      entetes: this.cleApi ? { authorization: `Bearer ${this.cleApi}` } : {},
      signal: options.signal,
      delaiMs: this.delaiMs,
    });
    if (rep.statut < 200 || rep.statut >= 300) {
      throw new ErreurRag(
        "reranker_http",
        `reranker : HTTP ${rep.statut} : ${extrait(rep.texte)}`,
        rep.statut,
      );
    }
    return lireReclassement(jsonOuNul(rep.texte), documents.length);
  }
}
