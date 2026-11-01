// SPDX-License-Identifier: MIT
/** frontend/src/features/agents/page.ts — page Agents : bande de cinq capacités, groupes de la grille, libellés des cartes et onglets de la fiche (logique pure). */
import { capacitesAgent } from "@elpis/contracts";
import type { CleCapaciteAgent } from "@elpis/contracts";

import { categoriesEffectives, typeReglable } from "../reglages/agents";
import type { FormulaireAgent, RangeeAgent } from "../reglages/agents";

/** Case de la bande : `oui` accordée, `non` absente, `verrou` retirée par la lecture seule (remplace Modifier). */
export type EtatCase = "oui" | "non" | "verrou";

export interface CaseCapacite {
  cle: CleCapaciteAgent;
  libelle: string;
  icone: string;
  etat: EtatCase;
  titre: string;
}

export interface BandeAgent {
  cases: CaseCapacite[];
  /** Texte pour les lecteurs d'écran. */
  lecteur: string;
  /** Catégories d'un modèle livré inconnues : les cases ne disent rien. */
  inconnu: boolean;
}

/** Ce que la bande lit d'un agent : son type, ses catégories effectives, la lecture seule effective. */
export interface EntreeBande {
  nom: string;
  livre: boolean;
  categories: readonly string[];
  lectureSeule: boolean;
  /** Catégories d'un modèle livré inconnues : les cinq cases restent absentes. */
  inconnu?: boolean;
}

// Tables littérales : une classe d'icône composée à la volée serait absente de la feuille générée.
const CASES: Readonly<Record<CleCapaciteAgent, { libelle: string; icone: string }>> = {
  lire: { libelle: "Lire", icone: "ph-book-open" },
  modifier: { libelle: "Modifier", icone: "ph-pencil-simple" },
  terminal: { libelle: "Terminal", icone: "ph-terminal-window" },
  git: { libelle: "Git", icone: "ph-git-branch" },
  web: { libelle: "Web", icone: "ph-globe" },
};

/** Les cinq cases dans l'ordre fixe Lire, Modifier, Terminal, Git, Web ; calculées par `capacitesAgent` comme les puces. */
export function bandeCapacites(e: EntreeBande): BandeAgent {
  const type = typeReglable(e.nom, e.livre);
  const calcul = capacitesAgent({
    type,
    categories: e.inconnu ? [] : e.categories,
    lectureSeule: e.lectureSeule,
  });
  const cases = calcul.map((c): CaseCapacite => {
    const { libelle, icone } = CASES[c.cle];
    if (c.cle === "modifier" && c.etat === "lecture_seule")
      return {
        cle: c.cle,
        libelle,
        icone: "ph-lock-simple",
        etat: "verrou",
        titre: "Lecture seule : Modifier retiré",
      };
    if (c.etat === "lecture_seule")
      return { cle: c.cle, libelle, icone, etat: "non", titre: `${libelle} : retiré par la lecture seule` };
    if (c.cle === "git" && c.etat === "oui" && e.lectureSeule && type !== "verify")
      return {
        cle: c.cle,
        libelle,
        icone,
        etat: "oui",
        titre: "Git : consultation seule, écritures retirées par la lecture seule",
      };
    return {
      cle: c.cle,
      libelle,
      icone,
      etat: c.etat,
      titre: `${libelle} : ${c.etat === "oui" ? "oui" : "non"}`,
    };
  });
  const peut = cases.filter((c) => c.etat === "oui").map((c) => c.libelle);
  const gitConsulte =
    e.lectureSeule && type !== "verify" && cases.some((c) => c.cle === "git" && c.etat === "oui");
  const ro = gitConsulte || cases.some((c) => c.etat === "verrou") ? " ; lecture seule" : "";
  const lecteur = e.inconnu ? "Capacités inconnues" : `Peut : ${peut.length ? peut.join(", ") : "rien"}${ro}`;
  return { cases, lecteur, inconnu: e.inconnu === true };
}

/** Bande d'une rangée de la banque. */
export function bandeDeRangee(row: RangeeAgent, socle: readonly string[]): BandeAgent {
  return bandeCapacites({
    nom: row.name,
    livre: row.template,
    categories: categoriesEffectives(row, socle),
    lectureSeule: row.read_only,
    inconnu: row.template && !row.tool_categories.length,
  });
}

/** Bande du formulaire ouvert, relue à chaque saisie : catégories du modèle si aucune n'est cochée, socle pour un agent personnel. */
export function bandeDeFormulaire(
  f: FormulaireAgent,
  lectureSeule: boolean,
  socle: readonly string[],
): BandeAgent {
  const cochees = f.tool_categories.length > 0;
  const categories = cochees
    ? f.tool_categories
    : f._template
      ? (f._tplCats ?? [])
      : f.mcp_server_ids.length
        ? []
        : socle;
  return bandeCapacites({
    nom: f.name.trim().toLowerCase(),
    livre: f._template,
    categories,
    lectureSeule,
    inconnu: f._template && !categories.length,
  });
}

/** « Livré », « Livré · personnalisé » ou « Personnel ». */
export function etiquetteAgent(row: Pick<RangeeAgent, "template" | "modified">): string {
  if (!row.template) return "Personnel";
  return row.modified ? "Livré · personnalisé" : "Livré";
}

/** « 60 appels » puis « · réflexion » si elle est activée ; « Budget par défaut » sans budget. */
export function metaAgent(row: Pick<RangeeAgent, "max_iters" | "thinking">): string {
  const budget = row.max_iters > 0 ? `${row.max_iters} appels` : "Budget par défaut";
  return row.thinking === "on" ? `${budget} · réflexion` : budget;
}

export interface GroupeAgents {
  id: "livres" | "perso";
  titre: string;
  agents: RangeeAgent[];
}

/** Groupes de la grille : « Livrés », puis « Personnels · n sur MAX ». */
export function groupesAgents(banque: readonly RangeeAgent[], nbPerso: number, max: number): GroupeAgents[] {
  return [
    { id: "livres", titre: "Livrés", agents: banque.filter((a) => a.template) },
    { id: "perso", titre: `Personnels · ${nbPerso} sur ${max}`, agents: banque.filter((a) => !a.template) },
  ];
}

/** Rangée que le formulaire ouvert édite : un modèle par son nom, un agent personnel par sa place ; `null` pour un nouvel agent. */
export function rangeeDuFormulaire(
  banque: readonly RangeeAgent[],
  f: FormulaireAgent | null,
): RangeeAgent | null {
  if (!f) return null;
  const trouvee = f._template
    ? banque.find((a) => a.template && a.name === f.name)
    : f._idx >= 0
      ? banque.find((a) => !a.template && a._idx === f._idx)
      : undefined;
  return trouvee ?? null;
}

export type OngletFiche = "general" | "droits" | "outils" | "instructions";

/** Onglets de la fiche : un mot chacun, le détail en infobulle. */
export const ONGLETS_FICHE: readonly { id: OngletFiche; libelle: string; info: string }[] = [
  { id: "general", libelle: "Général", info: "Nom, description et budget d'appels d'outils" },
  { id: "outils", libelle: "Outils", info: "Catégories d'outils et serveurs MCP de l'agent" },
  {
    id: "droits",
    libelle: "Droits",
    info: "Fichiers, réflexion et, avec des outils web, session du navigateur",
  },
  { id: "instructions", libelle: "Instructions", info: "Texte lu par l'agent, en anglais" },
];
