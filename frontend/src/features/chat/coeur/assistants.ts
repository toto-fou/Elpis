// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/assistants.ts — descripteurs des assistants de création (skill, routine) : cadrage, outils à cocher, skill épinglé et message d'amorce ; un nouvel assistant = un descripteur ici. */

export interface ChampAssistant {
  cle: string;
  libelle: string;
  type: "input" | "textarea" | "choix";
  requis?: boolean;
  placeholder?: string;
  options?: string[];
  /** Deux champs « demi » consécutifs partagent une rangée. */
  demi?: boolean;
}

/** Préfixe d'une clé `manquantes` qui désigne un réglage du compte coupé plutôt qu'une catégorie d'outils. */
export const PREFIXE_REGLAGE = "reglage:";

export interface DescripteurAssistant {
  id: string;
  titre: string;
  intro: string;
  champs: ChampAssistant[];
  bouton: string;
  /** Catégories d'outils cochées dans le chat neuf. */
  categories: string[];
  /** Toasts d'un prérequis absent : clé = catégorie d'outils manquante, ou `reglage:<clé>` d'un réglage du compte coupé. */
  manquantes?: Record<string, string>;
  skill: { name: string; description: string };
  amorce: string;
  consigne: string;
}

export interface EtatAssistant {
  open: boolean;
  id: string;
  valeurs: Record<string, string>;
}

export const ASSISTANTS: Readonly<Record<string, DescripteurAssistant>> = {
  skill: {
    id: "skill",
    titre: "Créer un skill avec l'assistant",
    intro:
      "Pose les bases ici — l'assistant complétera par des questionnaires interactifs dans le chat, puis rédigera et enregistrera le skill.",
    champs: [
      {
        cle: "sujet",
        libelle: "Sujet",
        type: "input",
        requis: true,
        placeholder: "Déployer l'app sur le serveur de staging",
      },
      {
        cle: "objectif",
        libelle: "Objectif / résultat attendu",
        type: "textarea",
        placeholder: "À la fin, l'app tourne sur staging et le smoke-test passe.",
      },
      { cle: "domaine", libelle: "Domaine", type: "input", placeholder: "jenkins, qdrant…", demi: true },
      {
        cle: "scripts",
        libelle: "Scripts à embarquer ?",
        type: "choix",
        options: ["oui", "non", "à voir"],
        demi: true,
      },
    ],
    bouton: "Commencer l'entretien",
    categories: ["skill", "fs"],
    manquantes: {
      skill:
        "Outils « Skills » indisponibles : l’assistant rédigera le skill sans pouvoir l’enregistrer lui-même",
    },
    skill: { name: "creer-un-skill", description: "Entretien guidé de création de skill" },
    amorce: "Je veux créer un nouveau skill. Voici le cadrage initial :",
    consigne:
      "Mène l'entretien pour le reste en posant tes questions groupées et numérotées en texte (plusieurs à la fois), puis rédige, enregistre et vérifie le skill.",
  },
  routine: {
    id: "routine",
    titre: "Créer une routine avec l'assistant",
    intro:
      "Décris l'objectif ici — l'assistant précisera la fréquence et les outils par un questionnaire dans le chat, puis créera la routine en pause.",
    champs: [
      {
        cle: "objectif",
        libelle: "Objectif",
        type: "textarea",
        requis: true,
        placeholder: "Résumer chaque matin les nouveautés d'un dépôt.",
      },
      { cle: "quand", libelle: "Quand", type: "input", placeholder: "Chaque lundi à 8 h" },
      {
        cle: "resultat",
        libelle: "Résultat attendu",
        type: "textarea",
        placeholder: "Un résumé de dix lignes, notifié à chaque exécution.",
      },
    ],
    bouton: "Commencer l'entretien",
    categories: ["skill"],
    manquantes: {
      skill: "Outils « Skills » indisponibles : l’assistant ne pourra pas proposer les skills à attacher",
      [`${PREFIXE_REGLAGE}routine_tool_enabled`]:
        "Création de routines coupée (Paramètres › Fonctionnalités) : l’assistant rédigera la routine sans pouvoir l’enregistrer",
    },
    skill: { name: "creer-une-routine", description: "Entretien guidé de création de routine" },
    amorce: "Je veux créer une nouvelle routine planifiée. Voici le cadrage initial :",
    consigne:
      "Mène l'entretien pour le reste avec ask_user (deux tours au plus), montre le brouillon complet, puis crée la routine (en pause) après mon accord.",
  },
};

/** Lignes du message de cadrage : une ligne `**Libellé :** valeur` par champ renseigné (le « ? » final du libellé est retiré). */
export function lignesCadrage(d: DescripteurAssistant, valeurs: Record<string, string>): string[] {
  const lignes = [d.amorce];
  for (const c of d.champs) {
    const v = (valeurs[c.cle] || "").trim();
    if (v) lignes.push(`**${c.libelle.replace(/\s*\?$/, "")} :** ${v}`);
  }
  lignes.push("", d.consigne);
  return lignes;
}

/** Valeurs initiales vides d'un descripteur, éventuellement préremplies. */
export function valeursInitiales(
  d: DescripteurAssistant,
  pre: Record<string, string> = {},
): Record<string, string> {
  return Object.fromEntries(d.champs.map((c) => [c.cle, pre[c.cle] ?? ""]));
}
