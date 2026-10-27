// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/bilan-taches.ts — bloc de métadonnées du harnais pour `task` : arguments du parent, suivi des outils de l'enfant (fichiers sûrs ou candidats, git, erreurs), statut, travail restant, champs exigés, rapport masqué et plafonné, runs du compte qui se chevauchent. */
import { estDict, jsonLoads, longueurPy, prefixePy, pyJsonDumps, stripPy, strPy } from "@elpis/commun";
import { masquerSecretsTexte, relatifBac, SESSIONS_NAVIGATEUR } from "@elpis/securite";
import type { SessionNavigateur, SousAgent } from "@elpis/securite";

import type { Dict } from "../../python";

/** Rapport rendu au parent au plus (caractères) ; le reste part dans un fichier du bac. */
export const RAPPORT_MAX = 8000;
export const WRITABLE_PATHS_MAX = 16;
export const OUTPUT_SCHEMA_MAX = 20;
const CHAMP_RE = /^[A-Za-z][A-Za-z0-9 _-]{0,47}$/u;

export type Statut =
  "done" | "partial" | "blocked" | "budget_exhausted" | "timeout" | "unavailable" | "error" | "cancelled";

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
  tool_budget: number;
  budget_warnings?: AvertissementBudget[];
  iterations: number;
  resumed: boolean;
  budget_reset: boolean;
  duration_s: number;
  files_changed: FichierBilan[];
  files_changed_candidates?: FichierBilan[];
  files_changed_attribution?: "uncertain";
  overlapped_with?: string[];
  git: { branch?: string; commits: string[]; pr_url?: string };
  errors: number;
  read_only: boolean;
  read_only_source: "admin_forced" | "task" | "user" | "admin_default" | null;
  /** Réflexion demandée à l'agent : réglage voulu ET moteur qui l'honore, fixé au lancement ; pas la preuve qu'il a réfléchi (jetons mesurés : `think_tokens` de l'étape finale). */
  thinking: boolean;
  /** Contexte de départ : la conversation du parent (`fork`) ou une page blanche (`fresh`). */
  context?: "fork" | "fresh";
  /** Session du navigateur de l'agent ; posée seulement pour un agent qui a des outils `pw_*`. */
  browser_session?: SessionNavigateur;
  /** Posé quand l'appel a autorisé `git_submit` (publication hors de la machine). */
  allow_submit?: true;
  writable_paths?: string[];
  writable_paths_scope?: "file_tools_only";
  remaining_work?: string;
  missing_fields?: string[];
  report_chars: number;
  report_saved_to?: string;
  secrets_masked?: number;
  reason?: string;
}

/** Paramètres facultatifs de `task` validés ; `erreur` : refus à rendre tel quel. */
export interface ArgsTache {
  contexte: "fresh" | "fork";
  readOnly: boolean;
  /** `null` : non demandée (isolée, ou celle de l'enregistrement repris). */
  browserSession: SessionNavigateur | null;
  /** `git_submit` autorisé pour ce lancement seulement (jamais repris d'un enregistrement). */
  allowSubmit: boolean;
  maxIterations: number | null;
  maxSeconds: number | null;
  writablePaths: string[] | null;
  outputSchema: string[];
}

function entierPositif(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/u.test(v.trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/** Lecture des paramètres du parent ; message anglais de refus pour une valeur mal formée. */
export function lireArgsTache(
  args: Dict,
  o: { maxIters: number; maxSecondsCap: number },
): ArgsTache | { erreur: string; fix: string } {
  const ro = args["read_only"];
  if (ro !== undefined && ro !== null && typeof ro !== "boolean")
    return { erreur: "read_only must be a boolean", fix: "pass read_only=true or omit it" };
  const contexte = args["context"];
  if (contexte !== undefined && contexte !== null && contexte !== "fresh" && contexte !== "fork")
    return {
      erreur: 'context must be "fresh" or "fork"',
      fix: 'pass context="fork", context="fresh" or omit it',
    };
  const bs = args["browser_session"];
  if (bs !== undefined && bs !== null && !SESSIONS_NAVIGATEUR.includes(bs as SessionNavigateur))
    return {
      erreur: 'browser_session must be "isolated" or "user"',
      fix: 'pass browser_session="isolated" (the default), "user" or omit it',
    };
  const as = args["allow_submit"];
  if (as !== undefined && as !== null && typeof as !== "boolean")
    return { erreur: "allow_submit must be a boolean", fix: "pass allow_submit=true or omit it" };
  const it = entierPositif(args["max_iterations"]);
  if (Number.isNaN(it))
    return { erreur: "max_iterations must be a positive integer", fix: `pass 1..${o.maxIters} or omit it` };
  const sec = entierPositif(args["max_seconds"]);
  if (Number.isNaN(sec) || (sec !== null && sec < 30))
    return {
      erreur: "max_seconds must be an integer of at least 30",
      fix: `pass 30..${o.maxSecondsCap} or omit it`,
    };
  let chemins: string[] | null = null;
  const wp = args["writable_paths"];
  if (wp !== undefined && wp !== null) {
    if (!Array.isArray(wp) || wp.length > WRITABLE_PATHS_MAX || !wp.every((c) => typeof c === "string"))
      return {
        erreur: `writable_paths must be a list of at most ${WRITABLE_PATHS_MAX} paths relative to /work`,
        fix: 'pass e.g. ["src/feature", "tests"]',
      };
    chemins = [];
    for (const c of wp as string[]) {
      const rel = relatifBac(c);
      if (rel === null)
        return { erreur: `writable_paths: ${c} is outside the sandbox`, fix: "use paths under /work" };
      if (!chemins.includes(rel)) chemins.push(rel);
    }
  }
  const os = args["output_schema"];
  let champs: string[] = [];
  if (os !== undefined && os !== null) {
    if (
      !Array.isArray(os) ||
      os.length > OUTPUT_SCHEMA_MAX ||
      !os.every((c) => typeof c === "string" && CHAMP_RE.test(c.trim()))
    )
      return {
        erreur: `output_schema must be a list of at most ${OUTPUT_SCHEMA_MAX} field names (letters, digits, space, _ or -)`,
        fix: 'pass e.g. ["verdict", "failing_tests"]',
      };
    champs = [...new Set((os as string[]).map((c) => c.trim()))];
  }
  return {
    contexte: contexte === "fork" ? "fork" : "fresh",
    readOnly: ro === true,
    browserSession: bs === undefined || bs === null ? null : (bs as SessionNavigateur),
    allowSubmit: as === true,
    maxIterations: it === null ? null : Math.min(it, o.maxIters),
    maxSeconds: sec === null ? null : Math.min(sec, o.maxSecondsCap),
    writablePaths: chemins,
    outputSchema: champs,
  };
}

type FichierSuivi = FichierBilan;

/** Outils qui décrivent leurs propres écritures ; le shell, lui, relève tout le bac du compte. */
const ECRITURE_PROPRE = /^(?:write_file|edit_file|manage_files|git_[a-z_]+)$/u;

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

/** Ce que les outils de l'enfant ont fait, relevé sur ses `tool_result` (jamais sur sa parole). */
export class SuiviOutils {
  appels = 0;
  erreurs = 0;
  readonly fichiers = new Map<string, FichierSuivi>();
  readonly candidats = new Map<string, FichierSuivi>();
  branche: string | null = null;
  readonly commits: string[] = [];
  prUrl: string | null = null;
  depot: string | null = null;
  private cwdShell: string | null = null;
  gitOuShell = false;

  /** Un appel compté ; un outil git ou le shell rend la branche à relire, et nomme le dépôt s'il le peut. */
  appel(nom = "", args: unknown = null): void {
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

  /** Un résultat : échec compté ; fichiers sûrs, ou candidats si relevés par le shell pendant un autre run du compte ; git. */
  resultat(nom: string, brut: unknown, echec: boolean, fichiers: unknown, chevauche = false): void {
    if (echec) this.erreurs++;
    const incertain = chevauche && !ECRITURE_PROPRE.test(nom);
    for (const f of Array.isArray(fichiers) ? fichiers : []) {
      if (!estDict(f) || typeof f["path"] !== "string") continue;
      const cle = relatifBac(f["path"]) ?? f["path"];
      if (incertain) {
        if (!this.fichiers.has(cle)) fusionner(this.candidats, f);
        continue;
      }
      this.candidats.delete(cle);
      fusionner(this.fichiers, f);
    }
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
    if (nom === "git_submit" && typeof d["pr_url"] === "string" && d["pr_url"]) this.prUrl = d["pr_url"];
  }

  fichiersModifies(): FichierSuivi[] {
    return [...this.fichiers.values()].slice(0, 200);
  }

  fichiersCandidats(): FichierSuivi[] {
    return [...this.candidats.values()].slice(0, 200);
  }

  git(): Bilan["git"] {
    return {
      ...(this.branche ? { branch: this.branche } : {}),
      commits: [...this.commits],
      ...(this.prUrl ? { pr_url: this.prUrl } : {}),
    };
  }
}

const TITRE = (nom: string): RegExp =>
  new RegExp(
    `^\\s{0,3}(?:#{1,6}\\s*|\\*\\*)?${nom.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:\\*\\*)?\\s*(?::|$)`,
    "imu",
  );

/** Statut déclaré par la ligne `Status:` du rapport (`blocked`, `partial`), sinon `null`. */
export function statutDeclare(rapport: string): "blocked" | "partial" | null {
  const m = /^\s{0,3}(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*+\s*)?([a-z_]+)/imu.exec(rapport);
  const v = m?.[1]?.toLowerCase();
  return v === "blocked" || v === "partial" ? v : null;
}

/** Section `## Left open` du rapport (travail restant), bornée ; `null` si absente ou vide. */
export function travailRestant(rapport: string): string | null {
  const m = TITRE("left open").exec(rapport);
  if (!m) return null;
  const reste = rapport.slice(m.index + m[0].length);
  const fin = /^\s{0,3}#{1,6}\s/mu.exec(reste);
  const t = stripPy(fin ? reste.slice(0, fin.index) : reste);
  if (!t || /^(?:nothing|none|rien|aucun)\.?$/iu.test(t)) return null;
  return longueurPy(t) > 2000 ? prefixePy(t, 1999) + "…" : t;
}

/** Champs exigés absents du rapport (ligne `champ:` ou titre `## champ`, casse ignorée). */
export function champsManquants(rapport: string, champs: readonly string[]): string[] {
  return champs.filter((c) => !TITRE(c).test(rapport));
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

/** Balises du bloc rendu au parent neutralisées dans le texte du sous-agent : il ne peut pas en imiter une. */
export function neutraliserBalises(texte: string): string {
  return texte.replace(/<(\/?\s*task(?:_meta|_result)?)(?=[\s>/]|$)/giu, "&lt;$1");
}

/** `<task …>` d'une mission aboutie : bloc du harnais (JSON sans `<` ni `>`) puis rapport aux balises neutralisées. */
export function rendreTache(childId: string, etat: string, bilan: Bilan, rapport: string): string {
  const meta = pyJsonDumps(bilan, { ensureAscii: false }).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
  return (
    `<task id="${childId}" state="${etat}">\n` +
    `<task_meta>${meta}</task_meta>\n` +
    `<task_result>\n${neutraliserBalises(rapport || "")}\n</task_result>\n</task>`
  );
}

interface Trace {
  nom: string;
  parent: string;
  sousAgent: boolean;
  t0: number;
  t1: number | null;
  ecrit: boolean;
}

/** Runs suivis par compte (le shell relève tout le bac du compte) : sous-agents et boucles de premier niveau. */
const TRACES = new Map<string, Map<string, Trace>>();
const TRACE_TTL_MS = 30 * 60 * 1000;
let numeroBoucle = 0;

function tracesDu(compte: string): Map<string, Trace> {
  const m = TRACES.get(compte) ?? new Map<string, Trace>();
  const maintenant = Date.now();
  for (const [k, t] of m) if (t.t1 !== null && maintenant - t.t1 > TRACE_TTL_MS) m.delete(k);
  TRACES.set(compte, m);
  return m;
}

/** Début d'un sous-agent du compte sous son chat parent (`compte:chat`). */
export function debutTrace(compte: string, parent: string, id: string, sa: SousAgent): void {
  tracesDu(compte).set(id, {
    nom: id,
    parent,
    sousAgent: true,
    t0: Date.now(),
    t1: null,
    ecrit: !sa.read_only,
  });
}

/** Boucle de premier niveau du compte (chat, routine) ; rend sa fin. */
export function debutBoucle(compte: string, chatId: string | null, ecrit: boolean): () => void {
  const cle = `#${++numeroBoucle}`;
  const t: Trace = {
    nom: `chat:${chatId || "default"}`,
    parent: `${compte}:${chatId || ""}`,
    sousAgent: false,
    t0: Date.now(),
    t1: null,
    ecrit,
  };
  tracesDu(compte).set(cle, t);
  return () => void (t.t1 = Date.now());
}

/** Autres runs du compte actifs pendant [t0, t1] (t0 absent : début du run), hors boucle parente ; `ecrivains` : ceux qui pouvaient écrire. */
export function chevauchements(
  compte: string,
  id: string,
  t0: number | null,
  t1: number,
  ecrivains = false,
): string[] {
  const m = TRACES.get(compte);
  const moi = m?.get(id);
  if (!m || !moi) return [];
  const debut = t0 ?? moi.t0;
  const noms = new Set<string>();
  for (const [k, t] of m) {
    if (k === id || (!t.sousAgent && t.parent === moi.parent) || (ecrivains && !t.ecrit)) continue;
    if (t.t0 > t1 || (t.t1 !== null && t.t1 < debut)) continue;
    noms.add(t.nom);
  }
  return [...noms];
}

/** Fin d'un sous-agent : autres runs du compte qui ont tourné en même temps que lui. */
export function finTrace(compte: string, id: string): string[] {
  const moi = TRACES.get(compte)?.get(id);
  if (!moi) return [];
  moi.t1 = Date.now();
  return chevauchements(compte, id, moi.t0, moi.t1);
}

/** Tests : plus aucune trace. */
export function oublierTraces(): void {
  TRACES.clear();
}
