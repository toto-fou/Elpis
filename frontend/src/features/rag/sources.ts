// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/sources.ts — sources RAG d'un message (`rag_sources`) validées à la frontière : passages numérotés `[n]`, cités ou lus. */
import { schemaSourceCiteeRag, SOURCES_MESSAGE_RAG_MAX } from "@elpis/contracts";
import type { SourceCiteeRag } from "@elpis/contracts";

/** Sources valides d'une valeur reçue (flux, chat relu), un numéro gardé une fois, 200 au plus. */
export function sourcesRagValides(v: unknown): SourceCiteeRag[] {
  if (!Array.isArray(v)) return [];
  const vus = new Set<number>();
  const sortie: SourceCiteeRag[] = [];
  for (const brut of v) {
    const r = schemaSourceCiteeRag.safeParse(brut);
    if (!r.success || vus.has(r.data.n)) continue;
    vus.add(r.data.n);
    sortie.push(r.data);
    if (sortie.length >= SOURCES_MESSAGE_RAG_MAX) break;
  }
  return sortie;
}

/** Source d'un renvoi `[n]` : celle du message, sinon celle d'un message précédent (passage relu d'un tour antérieur), sinon `null` (renvoi inconnu). */
export function sourceDuRenvoi(
  n: number,
  message: { rag_sources?: readonly SourceCiteeRag[] | null },
  precedents: readonly { rag_sources?: readonly SourceCiteeRag[] | null }[] = [],
): SourceCiteeRag | null {
  const ici = message.rag_sources?.find((s) => s.n === n);
  if (ici) return ici;
  for (let i = precedents.length - 1; i >= 0; i--) {
    const s = precedents[i]?.rag_sources?.find((x) => x.n === n);
    if (s) return s;
  }
  return null;
}
