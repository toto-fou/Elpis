// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/bilan.ts — bloc du harnais d'un run de `task` : statut, fichiers, git et erreurs relevés sur les outils de l'enfant, rapport masqué et plafonné, rendu `<task>`. */
import { estDict, jsonLoads, longueurPy, prefixePy, pyJsonDumps, stripPy, strPy } from "@elpis/commun";
import { masquerSecretsTexte, relatifBac } from "@elpis/securite";

import { neutraliserBalisesHarnais } from "../../../contexte/elagage";
import type { Dict } from "../../../python";
import type { Verdict } from "./statut";

/** Rapport rendu au parent au plus (caractères) ; le reste part dans un fichier du bac. */
export const RAPPORT_MAX = 8000;

export type Statut =
  | "done"
  | "partial"
  | "blocked"
  | "unknown"
  | "budget_exhausted"
  | "timeout"
  | "unavailable"
  | "error"
  | "cancelled";

export interface FichierBilan {
  path: string;
  change: string;
  added?: number;
  removed?: number;
}

export interface AvertissementBudget {
  at: number;
  text: string;
}

/** Points d'étape gardés au plus dans le bloc. */
export const BUDGET_WARNINGS_MAX = 20;

/** Texte d'un `<harness_status>` sans ses balises, borné. */
export function texteAvertissement(ligne: string): string {
  const t = stripPy(ligne.replace(/^\s*<harness_status>/u, "").replace(/<\/harness_status>\s*$/u, ""));
  return longueurPy(t) > 600 ? prefixePy(t, 599) + "…" : t;
}

/** Bloc du harnais (forme de `schemaBilanTache` des contrats). */
export interface Bilan {
  status: Statut;
  stop_reason?: string;
  tool_calls: number;
  tool_calls_total: number;
  budget_warnings?: AvertissementBudget[];
  iterations: number;
  resumed: boolean;
  duration_s: number;
  /** Attente avant la place au moteur (s), depuis l'entrée dans `task` : l'échéance compte `queued_s + duration_s`. */
  queued_s?: number;
  files_changed: FichierBilan[];
  /** Un autre run du compte qui peut écrire a tourné pendant celui-ci : `files_changed` peut contenir ses fichiers. */
  concurrent?: true;
  git: { branch?: string; commits: string[]; index_changed?: true; staged?: string[] };
  errors: number;
  read_only: boolean;
  remaining_work?: string;
  /** Issue de la vérification déclarée par un agent `verify` (ligne `Verdict:` de tête) ; absente sinon. */
  verdict?: Verdict;
  report_chars: number;
  report_saved_to?: string;
  secrets_masked?: number;
}

type FichierSuivi = FichierBilan;

/** Entrée fusionnée par chemin (`/work/x` et `x` confondus) : `created` gardé, lignes cumulées. */
function fusionner(m: Map<string, FichierSuivi>, f: Dict): void {
  const chemin = f["path"] as string;
  const cle = relatifBac(chemin) ?? chemin;
  const avant = m.get(cle);
  const change = strPy(f["change"] || "modified");
  const e: FichierSuivi = {
    path: avant?.path ?? chemin,
    change: avant?.change === "created" && change !== "deleted" ? "created" : change,
  };
  for (const k of ["added", "removed"] as const) {
    const v = (avant?.[k] ?? 0) + (typeof f[k] === "number" ? (f[k] as number) : 0);
    if (typeof f[k] === "number" || avant?.[k] !== undefined) e[k] = v;
  }
  m.delete(cle);
  m.set(cle, e);
}

/** Actions de `git_action` qui changent l'index git. */
const ACTIONS_INDEX: ReadonlySet<string> = new Set(["stage", "unstage", "stash", "stash_pop", "merge"]);

/** Ce que les outils de l'enfant ont fait, relevé sur ses `tool_result` (jamais sur sa parole). */
export class SuiviOutils {
  appels = 0;
  erreurs = 0;
  readonly fichiers = new Map<string, FichierSuivi>();
  branche: string | null = null;
  readonly commits: string[] = [];
  depot: string | null = null;
  private cwdShell: string | null = null;
  gitOuShell = false;
  /** Index git touché par `git_action` (le relevé avant/après des fichiers ne voit pas `.git`) ; chemins indexés (`.` : tout). */
  indexModifie = false;
  readonly indexes: string[] = [];
  private readonly actionsIndex = new Map<string, string[] | null>();

  /** Un appel compté ; un outil git ou le shell rend la branche à relire, et nomme le dépôt s'il le peut ; une action de `git_action` sur l'index attend son résultat (`cle` : id de l'appel). */
  appel(nom = "", args: unknown = null, cle = ""): void {
    this.appels++;
    if (!nom.startsWith("git_") && nom !== "execute_shell") return;
    this.gitOuShell = true;
    let a: unknown = args;
    try {
      if (typeof a === "string") a = jsonLoads(a);
    } catch {
      return;
    }
    if (!estDict(a)) return;
    const action = a["action"];
    if (
      nom === "git_action" &&
      typeof action === "string" &&
      ACTIONS_INDEX.has(action) &&
      a["dry_run"] !== true
    ) {
      const chemins = Array.isArray(a["paths"])
        ? a["paths"].filter((c): c is string => typeof c === "string")
        : [];
      this.actionsIndex.set(cle || nom, action === "stage" ? (chemins.length ? chemins : ["."]) : null);
    }
    const brut = nom === "execute_shell" ? a["cwd"] : a["repo"];
    const rel = typeof brut === "string" && brut.trim() ? relatifBac(brut.trim()) : null;
    if (!rel) return;
    if (nom === "execute_shell") this.cwdShell = rel;
    else this.depot = rel;
  }

  /** Dépôt à relire : celui des outils git, sinon le dossier du shell. */
  depotARelire(): string | null {
    return this.depot ?? this.cwdShell;
  }

  /** Un résultat : échec compté, fichiers changés, git. */
  resultat(nom: string, brut: unknown, echec: boolean, fichiers: unknown, cle = ""): void {
    if (echec) this.erreurs++;
    const index = this.actionsIndex.get(cle || nom);
    if (index !== undefined) {
      this.actionsIndex.delete(cle || nom);
      if (!echec) {
        this.indexModifie = true;
        for (const c of index ?? [])
          if (this.indexes.length < 50 && !this.indexes.includes(c)) this.indexes.push(c);
      }
    }
    for (const f of Array.isArray(fichiers) ? fichiers : [])
      if (estDict(f) && typeof f["path"] === "string") fusionner(this.fichiers, f);
    if (echec || !nom.startsWith("git_")) return;
    let d: unknown;
    try {
      d = typeof brut === "string" ? jsonLoads(brut) : brut;
    } catch {
      return;
    }
    if (!estDict(d)) return;
    if (typeof d["branch"] === "string" && d["branch"]) this.branche = d["branch"];
    if (nom === "git_commit" && typeof d["sha"] === "string" && d["sha"] && !this.commits.includes(d["sha"]))
      this.commits.push(d["sha"]);
  }

  fichiersModifies(): FichierSuivi[] {
    return [...this.fichiers.values()].slice(0, 200);
  }

  git(): Bilan["git"] {
    return {
      ...(this.branche ? { branch: this.branche } : {}),
      commits: [...this.commits],
      ...(this.indexModifie ? { index_changed: true as const } : {}),
      ...(this.indexes.length ? { staged: [...this.indexes] } : {}),
    };
  }
}

/** Rapport masqué puis plafonné : texte rendu, texte complet (masqué) à sauver s'il déborde, nombre de secrets masqués. */
export function preparerRapport(rapport: string): {
  rendu: string;
  complet: string;
  deborde: boolean;
  masques: number;
} {
  const { texte, n } = masquerSecretsTexte(rapport);
  const deborde = longueurPy(texte) > RAPPORT_MAX;
  return { rendu: deborde ? prefixePy(texte, RAPPORT_MAX) : texte, complet: texte, deborde, masques: n };
}

/** Note de fin d'un rapport coupé, avec le fichier qui garde le texte complet (ou l'échec de la sauvegarde). */
export function noteDebord(total: number, chemin: string | null): string {
  return chemin
    ? `\n\n[report truncated by the harness at ${RAPPORT_MAX} of ${total} characters: the full report is in ${chemin} (read it with read_file)]`
    : `\n\n[report truncated by the harness at ${RAPPORT_MAX} of ${total} characters: the full report could not be saved]`;
}

/** `<task …>` d'une mission aboutie : bloc du harnais (JSON sans `<` ni `>`) puis rapport aux balises du harnais neutralisées (il ne peut pas en imiter une). */
export function rendreTache(childId: string, etat: string, bilan: Bilan, rapport: string): string {
  const meta = pyJsonDumps(bilan, { ensureAscii: false }).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
  return (
    `<task id="${childId}" state="${etat}">\n` +
    `<task_meta>${meta}</task_meta>\n` +
    `<task_result>\n${neutraliserBalisesHarnais(rapport || "")}\n</task_result>\n</task>`
  );
}

/** Bloc d'un refus avant lancement (aucune boucle, aucun appel) ; l'enveloppe d'erreur dit pourquoi. */
export function bilanRefus(status: Statut): Bilan {
  return {
    status,
    tool_calls: 0,
    tool_calls_total: 0,
    iterations: 0,
    resumed: false,
    duration_s: 0,
    files_changed: [],
    git: { commits: [] },
    errors: 0,
    read_only: false,
    report_chars: 0,
  };
}
