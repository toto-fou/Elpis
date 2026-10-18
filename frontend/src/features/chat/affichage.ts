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

/** Sources RAG du tour (`rag_sources.text`, une par ligne), sans doublon ni ligne vide. */
export function sourcesRag(texte: unknown): string[] {
  if (typeof texte !== "string") return [];
  return [
    ...new Set(
      texte
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ];
}
