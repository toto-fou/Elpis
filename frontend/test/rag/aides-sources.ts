// SPDX-License-Identifier: MIT
/** frontend/test/rag/aides-sources.ts — fixtures des sources d'une réponse du RAG : sources numérotées, messages de l'assistant, passages trouvés. */
import type { PassageTrouveRag, SourceCiteeRag } from "@elpis/contracts";

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export interface OptionsSource {
  document?: string;
  doc?: string;
  collection?: string;
  collectionId?: string;
  auteur?: string;
  page?: number | null;
  section?: string;
  chunk?: number;
  texte?: string;
  query?: string | null;
  cited?: boolean;
  relevance?: number | null;
  boxes?: [number, number, number, number, number][];
}

/** Source `[n]` : par défaut le passage 2 de « procedure-vpn-ipsec-sites.docx », page 7, cité. */
export function source(n: number, o: OptionsSource = {}): SourceCiteeRag {
  const auteur = o.auteur ?? "alice";
  return {
    n,
    cited: o.cited ?? true,
    query: o.query === undefined ? "renouvellement certificats" : o.query,
    rank: n,
    relevance: o.relevance === undefined ? 0.79 : o.relevance,
    passage: {
      collection_id: o.collectionId ?? UUID(1),
      collection_name: o.collection ?? "Procédures réseau",
      owner: { id: 1, username: auteur, display_name: auteur },
      document_id: UUID(100 + Number((o.doc ?? "d1").replace(/\D/g, "") || 1)),
      document_name: o.document ?? "procedure-vpn-ipsec-sites.docx",
      rel_path: o.document ?? "procedure-vpn-ipsec-sites.docx",
      chunk_index: o.chunk ?? n + 24,
      page: o.page === undefined ? 7 : o.page,
      heading_path: o.section ?? "3.2 Renouvellement",
      text:
        o.texte ??
        "Avant tout renouvellement, vérifiez que le profil de chiffrement du correspondant accepte la nouvelle autorité. Le tunnel reste monté si les deux certificats sont présents.",
      score: 0.5,
      boxes: o.boxes ?? [],
    },
  };
}

export function passageTrouve(
  rang: number,
  o: OptionsSource & { relevance?: number } = {},
): PassageTrouveRag {
  const s = source(rang, o);
  return { ...s.passage, rank: rang, relevance: o.relevance ?? 1 - (rang - 1) / 10 };
}

/** Message de l'assistant portant des sources. */
export function reponse(
  texte: string,
  sources: SourceCiteeRag[] = [],
): {
  role: string;
  content: string;
  rag_sources: SourceCiteeRag[];
} {
  return { role: "assistant", content: texte, rag_sources: sources };
}
