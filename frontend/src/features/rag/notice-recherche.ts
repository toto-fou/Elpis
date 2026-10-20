// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/notice-recherche.ts — notice du fil de `/rag search` : passages trouvés dans les collections actives, rangés et fusionnés, écrits dans la notice (champ `summary`, JSON) et relus au rechargement. */
import { EXTRAIT_SOURCE_RAG_MAX, schemaPassageTrouveRag } from "@elpis/contracts";
import type { PassageTrouveRag, SourceCiteeRag } from "@elpis/contracts";
import { z } from "zod";

export const KIND_NOTICE_RECHERCHE = "rag_search";

const schemaNotice = z.object({
  v: z.literal(1),
  requete: z.string(),
  mode: z.string(),
  duree_ms: z.number(),
  collections: z.array(z.object({ id: z.string(), name: z.string() })),
  passages: z.array(schemaPassageTrouveRag),
  /** Messages des collections dont la recherche a échoué. */
  erreurs: z.array(z.string()),
});
export type NoticeRechercheRag = z.infer<typeof schemaNotice>;

function coupe(texte: string): string {
  return texte.length > EXTRAIT_SOURCE_RAG_MAX ? `${texte.slice(0, EXTRAIT_SOURCE_RAG_MAX - 1)}…` : texte;
}

/** Passages de plusieurs collections en une liste : la pertinence (rapport au meilleur de sa collection) départage, puis le rang ; `limite` au plus, rangs refaits de 1 à N. */
export function fusionnerPassages(
  parCollection: readonly (readonly PassageTrouveRag[])[],
  limite: number,
): PassageTrouveRag[] {
  const tous = parCollection.flatMap((liste, ordre) => liste.map((p) => ({ p, ordre })));
  tous.sort((a, b) => b.p.relevance - a.p.relevance || a.p.rank - b.p.rank || a.ordre - b.ordre);
  return tous.slice(0, limite).map(({ p }, i) => ({ ...p, rank: i + 1, text: coupe(p.text) }));
}

export function creerNotice(n: Omit<NoticeRechercheRag, "v">): NoticeRechercheRag {
  return { v: 1, ...n };
}

/** Contenu du champ `summary` d'une notice. */
export function serialiserNotice(n: NoticeRechercheRag): string {
  return JSON.stringify(n);
}

/** Notice relue d'un `summary` ; `null` si le contenu n'est pas une notice de recherche valide. */
export function lireNotice(summary: string | null | undefined): NoticeRechercheRag | null {
  if (summary === null || summary === undefined || summary === "") return null;
  try {
    const r = schemaNotice.safeParse(JSON.parse(summary));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Passages de la notice comme sources navigables de la visionneuse : le rang tient lieu de numéro. */
export function sourcesDeNotice(n: NoticeRechercheRag): SourceCiteeRag[] {
  return n.passages.map((p) => ({
    n: p.rank,
    cited: true,
    query: n.requete,
    rank: p.rank,
    relevance: p.relevance,
    passage: {
      collection_id: p.collection_id,
      collection_name: p.collection_name,
      owner: p.owner,
      document_id: p.document_id,
      document_name: p.document_name,
      rel_path: p.rel_path,
      chunk_index: p.chunk_index,
      page: p.page,
      heading_path: p.heading_path,
      text: p.text,
      score: p.score,
      boxes: p.boxes,
    },
  }));
}
