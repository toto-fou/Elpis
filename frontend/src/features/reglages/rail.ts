// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/rail.ts — rail des Paramètres : groupes par intention, recherche par libellé ou mot-clé. */

export interface EntreeRail {
  readonly id: string;
  readonly libelle: string;
  readonly icone: string;
  readonly mots: string;
  readonly ancien?: string;
}

export interface GroupeRail {
  readonly titre: string;
  readonly entrees: readonly EntreeRail[];
  readonly replie?: boolean;
}

export const GROUPES_RAIL: readonly GroupeRail[] = [
  {
    titre: "Général",
    entrees: [
      { id: "profile", libelle: "Profil", icone: "ph-user", mots: "nom mot de passe avatar photo email" },
      {
        id: "appearance",
        libelle: "Apparence",
        icone: "ph-palette",
        mots: "theme sombre clair couleur habillage skin mode",
      },
      {
        id: "chat",
        libelle: "Chat",
        icone: "ph-chat-circle",
        mots: "envoi entree reflexion saisie captures navigateur affichage deroule classique bloc chronologie journal terminal contexte anneau pourcentage reflexions metriques densite compacte",
      },
    ],
  },
  {
    titre: "Assistant",
    entrees: [
      {
        id: "ai_models",
        libelle: "Modèles IA",
        icone: "ph-sparkle",
        mots: "cle api fournisseur openai modele",
      },
      { id: "agents", libelle: "Agents", icone: "ph-users-three", mots: "sous-agent categories outils" },
      { id: "prompts", libelle: "Prompts", icone: "ph-bookmarks-simple", mots: "gabarit template systeme" },
      { id: "skills", libelle: "Skills", icone: "ph-graduation-cap", mots: "competence" },
      { id: "memory", libelle: "Mémoire", icone: "ph-brain", mots: "souvenir note" },
    ],
  },
  {
    titre: "Accès",
    entrees: [
      {
        id: "connexions",
        libelle: "Jetons d'accès",
        icone: "ph-key",
        mots: "token jeton mcp openapi opencode connexions",
        ancien: "Connexions",
      },
      {
        id: "connectors",
        libelle: "Comptes Git",
        icone: "ph-git-fork",
        mots: "token jeton git github gitea connecteurs depot",
        ancien: "Connecteurs",
      },
    ],
  },
  {
    titre: "Avancé",
    replie: true,
    entrees: [
      {
        id: "compaction",
        libelle: "Compaction",
        icone: "ph-arrows-in-line-horizontal",
        mots: "contexte compression seuil resume",
      },
      { id: "sandbox", libelle: "Sandbox", icone: "ph-cube", mots: "conteneur image quota bac" },
      { id: "features", libelle: "Fonctionnalités", icone: "ph-toggle-right", mots: "modules activer" },
      { id: "archives", libelle: "Archives", icone: "ph-archive", mots: "conversations archivees" },
      {
        id: "usage",
        libelle: "Utilisation",
        icone: "ph-chart-line",
        mots: "consommation jetons tokens cout",
      },
    ],
  },
];

export function sansAccent(texte: string): string {
  return texte.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Groupes réduits aux entrées dont le libellé, l'ancien nom ou les mots-clés contiennent la requête. */
export function filtrerRail(requete: string): GroupeRail[] {
  const q = sansAccent(requete.trim());
  if (!q) return GROUPES_RAIL.map((g) => g);
  const res: GroupeRail[] = [];
  for (const g of GROUPES_RAIL) {
    const entrees = g.entrees.filter((e) =>
      sansAccent(`${e.libelle} ${e.ancien ?? ""} ${e.mots}`).includes(q),
    );
    if (entrees.length) res.push({ ...g, entrees });
  }
  return res;
}
