// SPDX-License-Identifier: MIT
/** apps/core/src/rag/sources-message.ts — sources structurées d'un message de l'assistant (`rag_sources`) : validées, bornées, fusionnées ; jamais renvoyées au modèle. */
import { schemaSourceCiteeRag, SOURCES_MESSAGE_RAG_MAX } from "@elpis/contracts";
import type { SourceCiteeRag } from "@elpis/contracts";
import { FlottantPy } from "@elpis/commun";

/** Valeur lue par `pyJsonLoads` ramenée aux types natifs (flottants Python, entiers géants) avant validation. */
function versNatif(v: unknown, profondeur = 0): unknown {
  if (profondeur > 8) return v;
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map((x) => versNatif(x, profondeur + 1));
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, versNatif(x, profondeur + 1)]));
  return v;
}

/** Sources valides d'une liste reçue (client ou base), un numéro gardé une fois, 200 au plus. */
export function sourcesRagPropres(v: unknown): SourceCiteeRag[] {
  if (!Array.isArray(v)) return [];
  const sortie: SourceCiteeRag[] = [];
  const vus = new Set<number>();
  for (const brut of v.slice(0, SOURCES_MESSAGE_RAG_MAX * 2)) {
    const r = schemaSourceCiteeRag.safeParse(versNatif(brut));
    if (!r.success || vus.has(r.data.n)) continue;
    vus.add(r.data.n);
    sortie.push(r.data);
    if (sortie.length >= SOURCES_MESSAGE_RAG_MAX) break;
  }
  return sortie;
}

/** Sources de tous les messages de l'assistant d'une conversation : leurs numéros restent pris. */
export function sourcesRagDesMessages(messages: readonly unknown[]): SourceCiteeRag[] {
  const sortie: SourceCiteeRag[] = [];
  for (const m of messages) {
    if (m === null || typeof m !== "object" || (m as Record<string, unknown>)["role"] !== "assistant")
      continue;
    sortie.push(...sourcesRagPropres((m as Record<string, unknown>)["rag_sources"]));
  }
  return sortie;
}

/** Sources d'un « Continuer » : celles du segment interrompu d'abord, un numéro gardé une fois. */
export function fusionnerSourcesRag(avant: unknown, apres: unknown): SourceCiteeRag[] {
  return sourcesRagPropres([...sourcesRagPropres(avant), ...sourcesRagPropres(apres)]);
}

const RENVOI = /\[(\d{1,4}(?:\s*[,;\u2013-]\s*\d{1,4})*)\]/gu;

/** Numéros cités par un texte : `[3]`, `[2, 5]`, `[4-6]` (plages bornées à 50). */
export function numerosCitesRag(texte: unknown): Set<number> {
  const vus = new Set<number>();
  if (typeof texte !== "string") return vus;
  for (const m of texte.matchAll(RENVOI)) {
    for (const morceau of (m[1] ?? "").split(/\s*[,;]\s*/u)) {
      const [a, b] = morceau.split(/\s*[\u2013-]\s*/u).map(Number);
      if (a === undefined || !Number.isInteger(a)) continue;
      if (b !== undefined && Number.isInteger(b) && b >= a && b - a <= 50)
        for (let i = a; i <= b; i++) vus.add(i);
      else vus.add(a);
    }
  }
  return vus;
}

/** Sources du message marquées `cited` d'après le texte de la réponse (une source déjà citée le reste). */
export function marquerCiteesRag(sources: readonly SourceCiteeRag[], texte: unknown): SourceCiteeRag[] {
  const cites = numerosCitesRag(texte);
  return sources.map((s) => ({ ...s, cited: s.cited || cites.has(s.n) }));
}
