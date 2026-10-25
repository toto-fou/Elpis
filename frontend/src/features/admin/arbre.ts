// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/arbre.ts — arbre déplié de la console (groupes et pages toujours visibles) et filtre de recherche des pages. */
import { CHAMPS_ADMIN } from "./champs.gen";
import type { PageAdmin } from "./registre";

export interface GroupeArbre {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly pages: readonly string[];
}

/** Groupes de la navigation dépliée : mêmes pages que le registre, sauf Sous-agents et Accès HTTPS rangés avec leur sujet. */
export const ARBRE_DEPLIE: readonly GroupeArbre[] = Object.freeze([
  { id: "overview", label: "Vue d’ensemble", icon: "ph-squares-four", pages: ["overview"] },
  {
    id: "supervision",
    label: "Supervision",
    icon: "ph-chart-line-up",
    pages: ["dashboard", "report", "runs", "tool-calls", "audit", "logs"],
  },
  {
    id: "models",
    label: "Modèles & services",
    icon: "ph-cpu",
    pages: [
      "inference",
      "compression",
      "prompts",
      "rag",
      "vision",
      "voice",
      "images",
      "mcp",
      "sandbox-agents",
    ],
  },
  {
    id: "access",
    label: "Utilisateurs & accès",
    icon: "ph-users",
    pages: ["accounts", "groups", "rights", "sessions", "https"],
  },
  {
    id: "sandbox",
    label: "Sandbox",
    icon: "ph-cube",
    pages: ["sandbox-limits", "sandbox-network", "sandbox-toolhosts", "sandbox-containers"],
  },
  {
    id: "system",
    label: "Système",
    icon: "ph-hard-drives",
    pages: ["instance", "appearance", "data", "upkeep"],
  },
]);

const normaliser = (t: string): string => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Libellé du groupe qui range une page dans l'arbre déplié, ou « » si elle n'y figure pas. */
export function groupeDeplie(idPage: string): string {
  return ARBRE_DEPLIE.find((g) => g.pages.includes(idPage))?.label ?? "";
}

export interface GroupeAffiche extends GroupeArbre {
  readonly pagesVisibles: readonly PageAdmin[];
}

/** Groupes à afficher : pages permises au rôle, filtrées par le libellé de la page ou d'un de ses réglages ; un groupe sans page disparaît. */
export function filtrerArbre(
  pages: Readonly<Record<string, PageAdmin>>,
  admin: boolean,
  requete: string,
): GroupeAffiche[] {
  const q = normaliser(requete.trim());
  const reglagesParPage = new Map<string, string>();
  if (q) {
    for (const c of CHAMPS_ADMIN) {
      reglagesParPage.set(c.page, `${reglagesParPage.get(c.page) ?? ""} ${normaliser(c.label)}`);
    }
  }
  const sortie: GroupeAffiche[] = [];
  for (const g of ARBRE_DEPLIE) {
    const visibles: PageAdmin[] = [];
    for (const id of g.pages) {
      const page = pages[id];
      if (!page || (page.role === "admin" && !admin)) continue;
      if (q && !normaliser(page.label).includes(q) && !(reglagesParPage.get(id) ?? "").includes(q)) continue;
      visibles.push(page);
    }
    if (visibles.length) sortie.push({ ...g, pagesVisibles: visibles });
  }
  return sortie;
}
