// SPDX-License-Identifier: MIT
/** packages/securite/src/sous-agent.ts — périmètre d'un sous-agent (`task`) appliqué à son manifeste par le core ; l'hôte d'outils ne reçoit que son type, son id et sa session de navigateur. */
import { stripWorkPrefix } from "./confinement";

/** Session du navigateur d'un sous-agent : la sienne (contexte neuf, aucun cookie du compte) ou la session connectée du compte. */
export type SessionNavigateur = "isolated" | "user";

/** Champ `subagent` du `_meta` d'appel et de l'enveloppe d'identité, tel que l'hôte d'outils le lit. */
export interface SousAgentHote {
  readonly type: string;
  /** Identifiant de l'enfant (`task_id`) : sa session de navigateur ne sert qu'à lui ; absent, session isolée commune aux enfants du compte. */
  readonly id?: string;
  /** Absent ou illisible : `isolated` (le défaut ne donne jamais la session du compte). */
  readonly browser_session?: SessionNavigateur;
}

/** Périmètre d'un sous-agent côté core : manifeste (type, lecture seule) et échéance de ses appels ; seul `SousAgentHote` part vers l'hôte. */
export interface SousAgent extends SousAgentHote {
  readonly read_only: boolean;
  /** Échéance souple en temps monotone (`performance.now()`, ms) : le core coupe un appel d'outil de l'enfant qui la dépasse. */
  readonly deadline_ms?: number;
}

export const TYPES_AGENTS_LIVRES = ["explore", "implement", "verify", "web", "pr"] as const;
/** Clé des réglages qui vaut pour tous les agents personnels. */
export const TYPE_AGENT_PERSONNALISE = "custom";
export const TYPES_AGENTS_REGLABLES: readonly string[] = [...TYPES_AGENTS_LIVRES, TYPE_AGENT_PERSONNALISE];

/** Jamais offerts à un sous-agent (ni réveil, ni sous-agent, ni question à l'humain, ni création de routine ou d'agent, ni publication ni identifiant git du compte : hors du bac), registre ou non. */
export const OUTILS_JAMAIS_SOUS_AGENT: ReadonlySet<string> = new Set([
  "shell_job",
  "task",
  "ask_user",
  "routine_save",
  "agent_save",
  "git_submit",
  "git_set_credential",
]);

const ECRITURE_FICHIERS = ["write_file", "edit_file", "manage_files"];
const ECRITURE_GIT = [
  "git_write",
  "git_action",
  "git_start_work",
  "git_commit",
  "git_submit",
  "git_abandon",
  "git_clone",
  "git_set_credential",
];

/** Outils retirés par type livré, lecture seule mise à part. */
const OUTILS_RETIRES_PAR_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
  verify: new Set([...ECRITURE_FICHIERS, ...ECRITURE_GIT]),
  implement: new Set(["git_commit", "git_start_work", "git_abandon"]),
};

export const SHELL_SOUS_AGENT_DELAI_DEFAUT_S = 120;
export const SHELL_SOUS_AGENT_DELAI_MAX_S = 300;

/** Conseil commun quand un sous-agent ne peut pas faire ce qu'il demande. */
export const FIX_SOUS_AGENT =
  "A sub-agent cannot run background jobs or be woken: split the command into shorter steps " +
  `(timeout_sec up to ${SHELL_SOUS_AGENT_DELAI_MAX_S}), or stop and return status blocked to the parent with what is missing.`;

interface RefusSousAgent {
  readonly code: string;
  readonly message: string;
  readonly fix: string;
}

/** Un sous-agent qui appelle `task` (aucune imbrication, quel que soit le réglage). */
export const REFUS_TACHE_SOUS_AGENT: RefusSousAgent = {
  code: "not_available_here",
  message: "task is not available to a sub-agent: a sub-agent cannot launch sub-agents",
  fix: "Do this part yourself, or list it under 'Left open' in your report for the parent.",
};

/** `execute_shell(background=true)` d'un sous-agent : aucun processus ne doit lui survivre. */
export const REFUS_FOND_SOUS_AGENT: RefusSousAgent = {
  code: "not_available_here",
  message: "execute_shell(background=true) is not available to a sub-agent: nothing may outlive it",
  fix: FIX_SOUS_AGENT,
};

const NOM_TYPE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ID_ENFANT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

/** Champ reçu (meta ou enveloppe) lu en fermant : type illisible → `custom`, id illisible → absent, session autre que `user` → `isolated`. */
export function lireSousAgent(brut: unknown): SousAgentHote | null {
  if (brut === null || brut === undefined) return null;
  const d = typeof brut === "object" && !Array.isArray(brut) ? (brut as Record<string, unknown>) : {};
  const type =
    typeof d["type"] === "string" && NOM_TYPE.test(d["type"]) ? d["type"] : TYPE_AGENT_PERSONNALISE;
  const id = typeof d["id"] === "string" && ID_ENFANT.test(d["id"]) ? { id: d["id"] } : {};
  return { type, ...id, browser_session: d["browser_session"] === "user" ? "user" : "isolated" };
}

/** Forme transmise à l'hôte d'outils : le type, l'id et la session de navigateur, rien d'autre. */
export function sousAgentEnDict(sa: SousAgentHote): Record<string, unknown> {
  return {
    type: sa.type,
    ...(sa.id === undefined ? {} : { id: sa.id }),
    ...(sa.browser_session === undefined ? {} : { browser_session: sa.browser_session }),
  };
}

/** Chemin vu du bac (`/work/a`, `a`, `./a`, `~/a`) ramené à `a/b` normalisé ; `""` : la racine ; `null` : hors du bac. */
export function relatifBac(chemin: string): string | null {
  if (chemin.includes("\0")) return null;
  let s = stripWorkPrefix(chemin);
  if (s === "~" || s.startsWith("~/")) s = s.slice(1);
  else if (s.startsWith("/")) return null;
  const parties: string[] = [];
  for (const c of s.split("/")) {
    if (c === "" || c === ".") continue;
    if (c !== "..") parties.push(c);
    else if (parties.length) parties.pop();
    else return null;
  }
  return parties.join("/");
}

/** Outil offert au sous-agent par son manifeste ; en lecture seule, les `pw_*` du seul serveur d'outils intégré restent (navigateur : consultation, aucun effet sur le bac). */
export function outilPermisSousAgent(
  sa: Pick<SousAgent, "type" | "read_only"> | null | undefined,
  nom: string,
  lectureSeule: boolean,
  serveurIntegre = false,
): boolean {
  if (!sa) return true;
  if (OUTILS_JAMAIS_SOUS_AGENT.has(nom)) return false;
  if (OUTILS_RETIRES_PAR_TYPE[sa.type]?.has(nom)) return false;
  return !sa.read_only || lectureSeule || (serveurIntegre && nom.startsWith("pw_"));
}

/** Environnement ajouté au shell d'un sous-agent : ni `__pycache__` (`verify`, `implement`) ni `.pytest_cache` (`verify`). */
export function envShellSousAgent(sa: SousAgentHote | null | undefined): Record<string, string> {
  if (sa?.type === "verify") return { PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "-p no:cacheprovider" };
  if (sa?.type === "implement") return { PYTHONDONTWRITEBYTECODE: "1" };
  return {};
}
