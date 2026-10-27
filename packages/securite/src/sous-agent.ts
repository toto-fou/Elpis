// SPDX-License-Identifier: MIT
/** packages/securite/src/sous-agent.ts — périmètre d'un sous-agent (`task`) : profils d'outils par type, lecture seule, chemins écrivables, shell ; même règle pour le manifeste du core et les refus de l'hôte d'outils. */
import { stripWorkPrefix } from "./confinement";

/** Session du navigateur d'un sous-agent : la sienne (contexte neuf, aucun cookie du compte) ou la session connectée du compte. */
export type SessionNavigateur = "isolated" | "user";
export const SESSIONS_NAVIGATEUR: readonly SessionNavigateur[] = ["isolated", "user"];

/** Champ `subagent` du `_meta` d'appel et de l'enveloppe d'identité : il ne fait que restreindre. */
export interface SousAgent {
  readonly type: string;
  readonly read_only: boolean;
  /** Préfixes relatifs au bac où les outils de fichiers peuvent écrire ; `null` : aucune borne. */
  readonly writable_paths: readonly string[] | null;
  /** Identifiant de l'enfant (`task_id`) : sa session de navigateur ne sert qu'à lui ; absent, session isolée commune aux enfants du compte. */
  readonly id?: string;
  /** Absent ou illisible : `isolated` (le défaut ne donne jamais la session du compte). */
  readonly browser_session?: SessionNavigateur;
  /** Échéance souple (epoch ms, horloge du core) : une commande du shell ne court pas au-delà ; absente, aucune borne. */
  readonly deadline_ms?: number;
}

export const TYPES_AGENTS_LIVRES = ["explore", "implement", "verify", "web", "pr"] as const;
/** Clé des réglages qui vaut pour tous les agents personnels. */
export const TYPE_AGENT_PERSONNALISE = "custom";
export const TYPES_AGENTS_REGLABLES: readonly string[] = [...TYPES_AGENTS_LIVRES, TYPE_AGENT_PERSONNALISE];

/** Jamais offerts à un sous-agent (ni réveil, ni sous-agent, ni question à l'humain, ni création de routine), registre ou non. */
export const OUTILS_JAMAIS_SOUS_AGENT: ReadonlySet<string> = new Set([
  "shell_job",
  "task",
  "ask_user",
  "routine_save",
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
export const OUTILS_RETIRES_PAR_TYPE: Readonly<Record<string, ReadonlySet<string>>> = {
  verify: new Set([...ECRITURE_FICHIERS, ...ECRITURE_GIT]),
  implement: new Set(["git_commit", "git_submit", "git_start_work", "git_abandon"]),
};

export const SHELL_SOUS_AGENT_DELAI_DEFAUT_S = 120;
export const SHELL_SOUS_AGENT_DELAI_MAX_S = 300;

/** Délai d'une commande du shell d'un sous-agent borné au temps restant avant son échéance souple (1 s au moins) ; sans échéance, tel quel. */
export function bornerDelaiShell(
  sa: SousAgent | null | undefined,
  delaiS: number,
  maintenantMs: number = Date.now(),
): number {
  if (!sa || sa.deadline_ms === undefined) return delaiS;
  return Math.max(1, Math.min(delaiS, Math.floor((sa.deadline_ms - maintenantMs) / 1000)));
}

/** Conseil commun quand un sous-agent ne peut pas faire ce qu'il demande. */
export const FIX_SOUS_AGENT =
  "A sub-agent cannot run background jobs or be woken: split the command into shorter steps " +
  `(timeout_sec up to ${SHELL_SOUS_AGENT_DELAI_MAX_S}), or stop and return status blocked to the parent with what is missing.`;

export interface RefusSousAgent {
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

/** `background` d'`execute_shell` demandé (forme stricte ou souple de Pydantic). */
function fondDemande(v: unknown): boolean {
  return v === true || v === 1 || (typeof v === "string" && /^\s*(?:1|t|true|y|yes|on)\s*$/iu.test(v));
}

const NOM_TYPE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ID_ENFANT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

/** Champ reçu (meta ou enveloppe) lu en fermant : présent mais mal formé, il vaut lecture seule. */
export function lireSousAgent(brut: unknown): SousAgent | null {
  if (brut === null || brut === undefined) return null;
  if (typeof brut !== "object" || Array.isArray(brut))
    return {
      type: TYPE_AGENT_PERSONNALISE,
      read_only: true,
      writable_paths: null,
      browser_session: "isolated",
    };
  const d = brut as Record<string, unknown>;
  const type =
    typeof d["type"] === "string" && NOM_TYPE.test(d["type"]) ? d["type"] : TYPE_AGENT_PERSONNALISE;
  const wp = d["writable_paths"];
  let chemins: string[] | null = null;
  if (wp !== null && wp !== undefined) {
    chemins = [];
    if (Array.isArray(wp))
      for (const c of wp) {
        const rel = typeof c === "string" ? relatifBac(c) : null;
        if (rel !== null && !chemins.includes(rel)) chemins.push(rel);
      }
  }
  const id = typeof d["id"] === "string" && ID_ENFANT.test(d["id"]) ? { id: d["id"] } : {};
  const session: SessionNavigateur = d["browser_session"] === "user" ? "user" : "isolated";
  const fin = d["deadline_ms"];
  const echeance =
    typeof fin === "number" && Number.isFinite(fin) && fin > 0 ? { deadline_ms: Math.trunc(fin) } : {};
  return {
    type,
    read_only: d["read_only"] !== false,
    writable_paths: chemins,
    ...id,
    browser_session: session,
    ...echeance,
  };
}

/** Forme transmise (clés stables, chemins normalisés). */
export function sousAgentEnDict(sa: SousAgent): Record<string, unknown> {
  return {
    type: sa.type,
    read_only: sa.read_only,
    ...(sa.writable_paths === null ? {} : { writable_paths: [...sa.writable_paths] }),
    ...(sa.id === undefined ? {} : { id: sa.id }),
    ...(sa.browser_session === undefined ? {} : { browser_session: sa.browser_session }),
    ...(sa.deadline_ms === undefined ? {} : { deadline_ms: sa.deadline_ms }),
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

/** Vrai si `rel` est sous l'un des préfixes (le préfixe vide couvre tout le bac). */
export function sousPrefixes(rel: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => p === "" || rel === p || rel.startsWith(`${p}/`));
}

function texte(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Chemins qu'un outil de fichiers modifierait ; `null` pour un outil hors de la borne `writable_paths`. */
export function cheminsEcrits(nom: string, args: Readonly<Record<string, unknown>>): string[] | null {
  if (nom === "write_file" || nom === "edit_file") return [texte(args["path"])];
  if (nom === "git_write") {
    const repo = stripWorkPrefix(texte(args["repo"])).replace(/\/+$/u, "");
    const p = texte(args["path"]).replace(/^\/+/u, "");
    return [repo ? `${repo}/${p}` : p];
  }
  if (nom !== "manage_files") return null;
  const action = texte(args["action"]);
  if (action === "copy") return [texte(args["dest"])];
  if (action === "move") return [texte(args["path"]), texte(args["dest"])];
  if (action === "batch_delete") return (Array.isArray(args["paths"]) ? args["paths"] : []).map(texte);
  return [texte(args["path"])];
}

/** Refus d'un appel par le périmètre du sous-agent, `null` s'il passe ; `lectureSeule` : annotation `readOnlyHint` de l'outil. */
export function refusSousAgent(
  sa: SousAgent | null | undefined,
  nom: string,
  args: Readonly<Record<string, unknown>>,
  lectureSeule: boolean,
  serveurIntegre = false,
): RefusSousAgent | null {
  if (!sa) return null;
  if (nom === "task") return REFUS_TACHE_SOUS_AGENT;
  if (!outilPermisSousAgent(sa, nom, lectureSeule, serveurIntegre)) {
    if (OUTILS_JAMAIS_SOUS_AGENT.has(nom))
      return {
        code: "not_available_here",
        message: `${nom} is not available to a sub-agent (it cannot be woken)`,
        fix: FIX_SOUS_AGENT,
      };
    if (sa.read_only)
      return {
        code: "read_only_subagent",
        message: `${nom} is not available: this sub-agent is read-only (no write, commit, job or shell tool)`,
        fix: "Report what should change and return status blocked if the mission needs it; the parent decides.",
      };
    return {
      code: "not_available_for_subagent",
      message: `${nom} is not part of the '${sa.type}' sub-agent profile`,
      fix: "Leave this step to the parent: list it under 'Left open' in your report.",
    };
  }
  if (nom === "execute_shell" && fondDemande(args["background"])) return REFUS_FOND_SOUS_AGENT;
  if (sa.writable_paths === null) return null;
  for (const c of cheminsEcrits(nom, args) ?? []) {
    const refus = refusHorsChemins(sa.writable_paths, c, relatifBac(c));
    if (refus !== null) return refus;
  }
  return null;
}

/** Refus `path_not_writable` du chemin `affiche` dont `rel` est la forme relative au bac (`null` : hors du bac) ; `null` s'il est sous un préfixe permis. */
export function refusHorsChemins(
  prefixes: readonly string[],
  affiche: string,
  rel: string | null,
): RefusSousAgent | null {
  if (rel !== null && sousPrefixes(rel, prefixes)) return null;
  const permis = prefixes.map((p) => (p === "" ? "/work" : `/work/${p}`)).join(", ") || "(none)";
  return {
    code: "path_not_writable",
    message: `${affiche || "(empty path)"} is outside the writable paths of this sub-agent: ${permis}`,
    fix: `Write only under ${permis}; list any other change under 'Left open' for the parent.`,
  };
}

/** Outil offert au sous-agent (manifeste du core et garde de l'hôte d'outils, même règle) ; en lecture seule, les `pw_*` du seul serveur d'outils intégré restent (navigateur : consultation, aucun effet sur le bac). */
export function outilPermisSousAgent(
  sa: SousAgent | null | undefined,
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
export function envShellSousAgent(sa: SousAgent | null | undefined): Record<string, string> {
  if (sa?.type === "verify") return { PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "-p no:cacheprovider" };
  if (sa?.type === "implement") return { PYTHONDONTWRITEBYTECODE: "1" };
  return {};
}
