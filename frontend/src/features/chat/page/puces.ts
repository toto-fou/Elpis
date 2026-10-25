// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/puces.ts — libellés des puces d'état du composeur (contexte, tâches de la session, réflexion) et nom de modèle abrégé. */
import type { TacheSession } from "../outils/types";
import type { OccupationContexte, StatsDirect } from "./types";

export interface PuceContexte {
  pct: number;
  titre: string;
}

const fr = (n: number): string => n.toLocaleString("fr-FR");

/** « Contexte 38 % » : pendant le tour (jetons/s et durée en infobulle), sinon l'occupation du dernier tour. */
export function puceContexte(
  direct: StatsDirect | null,
  repos: OccupationContexte | null,
): PuceContexte | null {
  const vivant = direct
    ? [direct.tokPerSec !== null ? `${direct.tokPerSec} jetons/s` : "", direct.secLabel].filter(Boolean)
    : [];
  if (direct && direct.ctxLabel)
    return { pct: Math.round(direct.pct), titre: [`${direct.ctxLabel} jetons`, ...vivant].join(" · ") };
  if (repos && repos.total > 0) {
    const fin =
      `${fr(repos.used)} / ${fr(repos.total)} jetons à la fin du dernier tour` +
      (repos.persisted ? " (valeur enregistrée, restaurée au chargement)" : "");
    return { pct: Math.round(repos.pct), titre: [fin, ...vivant].join(" · ") };
  }
  return null;
}

/** Seuil à partir duquel la puce de contexte porte le signe d'alerte. */
export const SEUIL_CONTEXTE = 80;

export interface CompteTaches {
  faites: number;
  total: number;
  enCours: string;
}

export function compteTaches(taches: readonly TacheSession[]): CompteTaches {
  return {
    faites: taches.filter((t) => t.status === "completed").length,
    total: taches.length,
    enCours: taches.find((t) => t.status === "in_progress")?.content ?? "",
  };
}

const EFFORTS: Readonly<Record<string, string>> = {
  none: "Aucun",
  minimal: "Minimal",
  low: "Faible",
  medium: "Moyen",
  high: "Élevé",
};

export const libelleEffort = (v: string): string => EFFORTS[v] ?? v;

/** « qwen3-coder-30b » devient « qwen3-coder » : chemin et extension retirés, deux premiers segments, 14 caractères au plus. */
export function abregerModele(nom: string): string {
  const base = (nom.split("/").pop() ?? nom).replace(/\.gguf$/i, "");
  const court = base.split("-").slice(0, 2).join("-") || base;
  return court.length > 14 ? court.slice(0, 13) + "…" : court;
}
