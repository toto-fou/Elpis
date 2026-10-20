// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/affichage.ts — libellés des mentions du tour : sources RAG, journal tronqué, chargement du modèle. */

export interface ChargementAffiche {
  readonly model?: string;
  readonly pct?: number | null;
  readonly stage?: string;
  readonly stages?: readonly string[];
}

const ETAPES: Readonly<Record<string, string>> = {
  download: "Téléchargement du modèle",
  text_model: "Chargement du modèle",
  mmproj_model: "Chargement du module vision",
};

/** « Chargement du modèle (1/2) · 42 % » ; sans pourcentage connu, « Chargement du modèle… ». */
export function libelleChargementModele(c: ChargementAffiche | null | undefined): string {
  if (!c) return "";
  const stage = c.stage ?? "";
  const base = ETAPES[stage] ?? "Chargement du modèle";
  const etapes = c.stages ?? [];
  const rang = etapes.indexOf(stage);
  const pas = etapes.length > 1 && rang >= 0 ? ` (${rang + 1}/${etapes.length})` : "";
  const pct =
    typeof c.pct === "number" && Number.isFinite(c.pct)
      ? Math.round(Math.max(0, Math.min(100, c.pct)))
      : null;
  return pct === null ? `${base}${pas}…` : `${base}${pas} · ${pct} %`;
}

/** Documents des sources RAG (`rag_sources.sources`), dans l'ordre, sans doublon ni nom vide. */
export function sourcesRag(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  const noms = sources.map((s: unknown) => {
    const p = s !== null && typeof s === "object" ? (s as { passage?: unknown }).passage : null;
    const nom = p !== null && typeof p === "object" ? (p as { document_name?: unknown }).document_name : null;
    return typeof nom === "string" ? nom.trim() : "";
  });
  return [...new Set(noms.filter((n) => n !== ""))];
}

/** Sources d'un message complétées par celles d'un événement, un numéro gardé une fois (la plus récente l'emporte). */
export function fusionnerSourcesRag<T extends { n: number }>(
  avant: readonly T[] | null | undefined,
  nouvelles: readonly T[],
): T[] {
  const parN = new Map<number, T>();
  for (const s of avant ?? []) parN.set(s.n, s);
  for (const s of nouvelles) parN.set(s.n, s);
  return [...parN.values()];
}
