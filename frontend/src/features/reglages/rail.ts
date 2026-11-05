// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/rail.ts — rail des Paramètres : groupes par intention, sections de chaque entrée, recherche par libellé ou mot-clé. */

/** Partie d'un onglet : un élément du sous-menu, avec le titre et l'aide de sa page. */
export interface SectionRail {
  readonly id: string;
  readonly libelle: string;
  readonly icone: string;
  readonly mots: string;
  readonly aide: string;
}

export interface EntreeRail {
  readonly id: string;
  readonly libelle: string;
  readonly icone: string;
  readonly mots: string;
  readonly ancien?: string;
  readonly sections?: readonly SectionRail[];
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
        sections: [
          {
            id: "theme",
            libelle: "Thème",
            icone: "ph-palette",
            mots: "theme sombre clair systeme mode habillage skin palette couleurs",
            aide: "Mode et habillage de l'application.",
          },
          {
            id: "editeur",
            libelle: "Éditeur",
            icone: "ph-code-block",
            mots: "editeur sombre theme clair interface classique selon le skin",
            aide: "Allure et thème de l'éditeur de code.",
          },
          {
            id: "mascotte",
            libelle: "Mascotte",
            icone: "ph-smiley",
            mots: "mascotte logo accueil animation",
            aide: "Ce qui accueille un nouveau chat.",
          },
        ],
      },
      {
        id: "chat",
        libelle: "Chat",
        icone: "ph-chat-circle",
        mots: "envoi entree reflexion saisie captures navigateur affichage deroule classique bloc chronologie journal terminal contexte anneau pourcentage reflexions metriques densite compacte",
        sections: [
          {
            id: "conversation",
            libelle: "Conversation",
            icone: "ph-chat-circle",
            mots: "prompt systeme largeur terminal reveil tache notifications effacer conversations",
            aide: "Comportement des conversations.",
          },
          {
            id: "affichage",
            libelle: "Affichage",
            icone: "ph-rows",
            mots: "affichage deroule classique bloc chronologie journal contexte anneau pourcentage reflexions metriques densite compacte captures navigateur",
            aide: "Présentation du fil de discussion.",
          },
          {
            id: "voix",
            libelle: "Voix",
            icone: "ph-microphone",
            mots: "voix dictee micro reponse vocale lecture",
            aide: "Dictée et lecture des réponses.",
          },
        ],
      },
      {
        id: "features",
        libelle: "Fonctionnalités",
        icone: "ph-toggle-right",
        mots: "modules activer",
        sections: [
          {
            id: "modules",
            libelle: "Modules",
            icone: "ph-plug",
            mots: "modules activer mcp images sandbox routines",
            aide: "Ce que l'assistant peut faire. Chaque module s'active séparément.",
          },
          {
            id: "images",
            libelle: "Images",
            icone: "ph-image",
            mots: "images format taille nombre enrichir bibliotheque",
            aide: "Génération d'images : format, taille, bibliothèque.",
          },
          {
            id: "editeur",
            libelle: "Éditeur",
            icone: "ph-code-block",
            mots: "editeur police taille indentation minimap numeros ligne sauvegarde onglets apercu surbrillance",
            aide: "Affichage et comportement de l'éditeur de code.",
          },
        ],
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

/** Entrée du rail par son identifiant. */
export function entreeRail(id: string): EntreeRail | undefined {
  return GROUPES_RAIL.flatMap((g) => g.entrees).find((e) => e.id === id);
}

/** Groupes réduits aux entrées dont le libellé, l'ancien nom, les mots-clés ou une section contiennent la requête. */
export function filtrerRail(requete: string): GroupeRail[] {
  const q = sansAccent(requete.trim());
  if (!q) return GROUPES_RAIL.map((g) => g);
  const res: GroupeRail[] = [];
  for (const g of GROUPES_RAIL) {
    const entrees = g.entrees.filter((e) =>
      sansAccent(
        `${e.libelle} ${e.ancien ?? ""} ${e.mots} ${(e.sections ?? []).map((s) => `${s.libelle} ${s.mots}`).join(" ")}`,
      ).includes(q),
    );
    if (entrees.length) res.push({ ...g, entrees });
  }
  return res;
}
