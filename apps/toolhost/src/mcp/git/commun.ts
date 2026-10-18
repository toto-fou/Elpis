// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/git/commun.ts — socle de la famille git (llm_core/tools/git_tools.py) : enveloppes, gardes des arguments, dépôt du compte, git par l'agent du bac et par le relais, branches et politique du dépôt. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Dict } from "@elpis/commun";
import {
  ErreurPython,
  estBlancPy,
  fnmatchPy,
  journalDe,
  longueurPy,
  lowerPy,
  prefixePy,
  reprPy,
  splitlinesPy,
  stripPy,
  strPy,
} from "@elpis/commun";
import { config, parseJsonPy } from "@elpis/config";
import { AgentError, RelayRefused } from "@elpis/fichiers";
import type { GitResult, SourceGit } from "@elpis/fichiers";
import { err, ok } from "@elpis/outils-mcp";
import { userIdFor } from "@elpis/securite";

import { agentEnAnglais, enAnglais, strErreurAnglais } from "../anglais";
import type { Espace } from "../espace";

/** `TIMEOUT` : commandes git LOCALES (le réseau a le sien, 120 s), lu une fois comme le Python. */
export const TIMEOUT = Math.max(5, Math.trunc(Number(config.GIT_TOOL_TIMEOUT_S) || 60));
export const MAX_OUT = 20_000;
export const MAX_FILE_READ = 1_500_000;
export const MAX_FILE_WRITE = 400_000;
export const MAX_FILES = 2000;
const BAD_CHARS = ";|&><`$\n\r";
export const READONLY_SUBS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "rev-list",
  "describe",
  "ls-files",
  "grep",
  "blame",
  "tag",
  "remote",
  "stash",
  "config",
  "diff-tree",
  "shortlog",
]);
export const USER_GIT_SUBDIR = "git_repos";
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = [
  "main",
  "master",
  "develop",
  "dev",
  "trunk",
  "staging",
  "prod",
  "production",
  "release/*",
  "hotfix/*",
];
export const DEFAULT_AGENT_BRANCH_PREFIXES: readonly string[] = [
  "agent/",
  "ai/",
  "claude/",
  "fix/agent-",
  "feature/agent-",
];
export const INIT_SCAFFOLD_MSG = "chore: initialize repository";

/** `ValueError` d'une garde : rendue par l'outil en `_err(str(e))`. */
export function erreurValeur(message: string): ErreurPython {
  return new ErreurPython("ValueError", message);
}

export function estErreurValeur(e: unknown): e is ErreurPython {
  return e instanceof ErreurPython && e.type === "ValueError";
}

/** `str(e)` d'une exception Python portée (AgentError : `code: message`). */
export function strExc(e: unknown): string {
  return e instanceof Error ? strErreurAnglais(e) : strPy(e);
}

/** Messages dont la tête ne fait pas un code court → code stable. */
const CODES_GIT: readonly (readonly [RegExp, string])[] = [
  [/^target\b.*\brequired\b/u, "target_required"],
  [/^repo must be a RELATIVE path/u, "repo_not_relative"],
  [/^repo path may not contain '\.\.'/u, "repo_traversal"],
  [/codec can't encode/u, "invalid_text"],
];

/** Tête d'un message (avant `:`, ` —`, ` (`, un guillemet ou une fin de phrase) : là où commencent ses données. */
export const FIN_DE_TETE = /:|\s[—–]|\s\(|['"`«]|\.(?:\s|$)/u;

/** Code stable sans donnée (écart voulu au Python, qui prenait le slug du message entier) : table, sinon tête du message en `[a-z0-9_]`, 40 au plus. */
export function codeGit(texte: string): string {
  for (const [re, code] of CODES_GIT) if (re.test(texte)) return code;
  const tete = texte.split(FIN_DE_TETE, 1)[0] ?? "";
  const code = lowerPy(tete)
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40)
    .replace(/_+$/u, "");
  return code || "git_error";
}

/** `_err` : code stable (`codeGit`), message tel quel, conseil en `fix`. */
export function errGit(m: unknown, hint = "", kw: Dict = {}): Dict {
  const texte = strPy(m);
  return err(codeGit(texte), texte, { fix: hint || null, ...kw });
}

/** `_trunc` : coupe à `n` caractères avec un marqueur honnête. */
export function tronquer(s: string | null | undefined, n: number): [string, boolean] {
  const t = s ?? "";
  const l = longueurPy(t);
  if (l <= n) return [t, false];
  return [prefixePy(t, n) + `\n...[truncated: ${l - n} of ${l} characters omitted]`, true];
}

/** `_reject` : caractères de shell refusés dans l'argv, sauf aux positions des valeurs libres. */
export function rejeter(jetons: readonly string[], libres: ReadonlySet<number> = new Set()): void {
  jetons.forEach((t, i) => {
    if (!libres.has(i) && [...t].some((c) => BAD_CHARS.includes(c)))
      throw erreurValeur("Shell chars forbidden in git args");
  });
}

/** `_safe_rel` : chemin relatif au dépôt, sans `/`, `~`, `:`, `..` ni tiret de tête ; forme normalisée. */
export function cheminSur(rel: string): string {
  if (!rel)
    throw erreurValeur(
      "path required — pass a path RELATIVE to the repo root, e.g. path='src/main.py' or path='README.md'",
    );
  const s = stripPy(rel).replaceAll("\\", "/");
  if (s.startsWith("/"))
    throw erreurValeur(
      `Invalid path: ${reprPy(s)}. Use a path RELATIVE to the repo root, not absolute. Try path='${s.replace(/^\/+/u, "")}' instead.`,
    );
  if (s.startsWith("~"))
    throw erreurValeur(
      `Invalid path: ${reprPy(s)}. Tilde expansion is not performed; pass a path relative to the repo root.`,
    );
  if (s.includes(":"))
    throw erreurValeur(
      `Invalid path: ${reprPy(s)}. Colons are not permitted in paths (possible scheme prefix or Windows drive).`,
    );
  if (s.split("/").includes(".."))
    throw erreurValeur(
      `Invalid path: ${reprPy(s)}. '..' (path traversal) is blocked. Use only paths inside the repo root.`,
    );
  if (s.startsWith("-"))
    throw erreurValeur(
      `Invalid path: ${reprPy(s)}. Paths starting with '-' are blocked (could be misinterpreted as a CLI flag). Try './${s}' if the file genuinely starts with a dash.`,
    );
  return s;
}

/** `_safe_ref` : alphanumériques, `/._-@~^`, jamais de tiret de tête. */
export function refSure(ref: string): string {
  if (!ref) throw erreurValeur("ref required");
  if (!/^[A-Za-z0-9._/\-@~^]+$/u.test(ref)) throw erreurValeur(`Invalid ref: ${reprPy(ref)}`);
  if (ref.startsWith("-")) throw erreurValeur("ref cannot start with '-'");
  return ref;
}

/** `_validate_branch`. */
export function brancheValide(b: string): string {
  if (
    !b ||
    [...b].some((c) => estBlancPy(c.codePointAt(0) ?? 0)) ||
    b.startsWith("-") ||
    b.includes("..") ||
    b.includes("~") ||
    b.includes(":")
  )
    throw erreurValeur(`Invalid branch name: ${reprPy(b)}`);
  return b;
}

/** `/work[/rel]` : vue conteneur d'un chemin du bac, jamais un chemin de l'hôte. */
export function cwdConteneur(rel: string): string {
  return "/work" + (rel ? "/" + rel : "");
}

/** `pathlib.PurePosixPath(p).parts` (sans la racine) et `is_absolute()`. */
function partiesPosix(p: string): { absolu: boolean; parties: string[] } {
  return { absolu: p.startsWith("/"), parties: p.split("/").filter((x) => x !== "" && x !== ".") };
}

/** Comptes de /etc/passwd : `Path("~nom").expanduser()` n'aboutit que pour un compte connu. */
function compteSysteme(nom: string): boolean {
  try {
    return readFileSync("/etc/passwd", "utf-8")
      .split("\n")
      .some((l) => l.split(":")[0] === nom);
  } catch {
    return false;
  }
}

/** `Path(repo).expanduser()` réduit à ce que la garde observe : chemin absolu, ou `RuntimeError` du Python si le compte de `~nom` est inconnu. */
export function etendreTilde(repo: string): string {
  if (!repo.startsWith("~")) return repo;
  const i = repo.indexOf("/");
  const nom = i < 0 ? repo.slice(1) : repo.slice(1, i);
  if (nom && !compteSysteme(nom)) throw new Error("Could not determine home directory.");
  return "/" + (i < 0 ? "" : repo.slice(i + 1));
}

/** Compte d'un appel : espace de son bac, source des identifiants git (rappel au core), id du compte. */
export class CompteGit {
  readonly username: string;
  readonly source: SourceGit & {
    identityForUsername?: (u: string) => Promise<{ readonly user_id: number } | null>;
  };
  private readonly espace: Espace | null;
  private idConnu: number | null = null;

  constructor(username: string, esp: Espace | null, source: CompteGit["source"]) {
    this.username = username;
    this.espace = esp;
    this.source = source;
  }

  /** Compte sans bac (`git_set_credential` ne touche jamais la sandbox, comme le Python). */
  static sansEspace(username: string, source: CompteGit["source"]): CompteGit {
    return new CompteGit(username, null, source);
  }

  get esp(): Espace {
    if (this.espace === null) throw new Error("espace du compte non ouvert");
    return this.espace;
  }

  /** Id du compte : identité de l'enveloppe, sinon rappel au core ; jamais 0 pour un compte connu sur un hôte distant (défaut Python corrigé). */
  async uid(): Promise<number> {
    if (this.idConnu !== null) return this.idConnu;
    let id =
      this.espace !== null ? Math.max(0, this.espace.uid) : await userIdFor(this.username).catch(() => 0);
    if (!id && this.source.identityForUsername)
      id = (await this.source.identityForUsername(this.username).catch(() => null))?.user_id ?? 0;
    this.idConnu = id;
    return id;
  }
}

/** `_safe_repo_path` : dépôt `repo` (relatif à /work, ou ancienne disposition `git_repos/`) contenant `.git`, vu par l'agent ; rend son chemin relatif à /work. */
export async function depotSur(esp: Espace, repo: string): Promise<string> {
  if (!repo)
    throw erreurValeur(
      "repo required — pass repo='<path>' (relative to sandbox root, e.g. 'myproject' or 'code/web-app'). Use git_query(action='repos') to discover existing repos.",
    );
  const { absolu, parties } = partiesPosix(etendreTilde(repo));
  if (absolu)
    throw erreurValeur(
      `repo must be a RELATIVE path, not absolute. Got: ${reprPy(repo)}. Pass just the path within your sandbox, e.g. 'myproject' or 'code/web-app'.`,
    );
  if (parties.includes(".."))
    throw erreurValeur(`repo path may not contain '..' (path traversal). Got: ${reprPy(repo)}.`);
  const posix = parties.join("/") || ".";
  const rel = parties.join("/");
  const ancien = `${USER_GIT_SUBDIR}/${posix}`;
  let e: Dict[];
  try {
    e = await esp.stats([rel, rel ? `${rel}/.git` : ".git", ancien, `${ancien}/.git`]);
  } catch (x) {
    if (!(x instanceof AgentError)) throw x;
    throw erreurValeur(`repo_unavailable: ${x.code} — the sandbox could not be reached; retry in a moment`);
  }
  const genre = (i: number): unknown => e[i]?.["kind"];
  if (genre(0) === "dir" && (genre(1) === "dir" || genre(1) === "file")) return rel;
  if (genre(2) === "dir" && (genre(3) === "dir" || genre(3) === "file")) {
    journalDe("git").warn(
      `[git_tools] DEPRECATION: legacy ${USER_GIT_SUBDIR}/${repo} layout used — move repos to sandbox root for full alignment with fs/shell tools.`,
    );
    return parties.length ? `${USER_GIT_SUBDIR}/${rel}` : USER_GIT_SUBDIR;
  }
  throw erreurValeur(
    `Repo not found: ${repo}. Use git_query(action='repos') to list discoverable repos in your sandbox. To create one: git_clone(url='https://...', into_path=${reprPy(repo)}) or via git_action(action='init', repo=${reprPy(repo)}).`,
  );
}

/** `_repo_file` : chemin relatif à /work du fichier `rel` du dépôt `rp`, sans lire le disque (liens résolus par l'agent). */
export function fichierDuDepot(rp: string, rel: string): string {
  const s = cheminSur(rel);
  const r = normpathPosix(rp ? `${rp}/${s}` : s);
  if (r === "." || r === ".." || r.startsWith("../") || (rp && r !== rp && !r.startsWith(rp + "/")))
    throw erreurValeur("path outside repo");
  return r;
}

/** `posixpath.normpath` d'un chemin relatif. */
export function normpathPosix(p: string): string {
  const pile: string[] = [];
  for (const c of p.split("/")) {
    if (c === "" || c === ".") continue;
    if (c === ".." && pile.length && pile[pile.length - 1] !== "..") pile.pop();
    else pile.push(c);
  }
  return pile.join("/") || ".";
}

export interface OptionsGit {
  readonly timeout?: number;
  readonly maxOut?: number;
  readonly libres?: ReadonlySet<number>;
}

/** `_envelope` : délai → `timeout` (124) ; sinon sorties tronquées, `cwd` en vue conteneur. */
export function enveloppe(
  cmd: readonly string[],
  rel: string,
  r: GitResult,
  timeout: number,
  maxOut: number,
): Dict {
  if (r.timed_out)
    return errGit("timeout", `Exceeded ${timeout}s.`, {
      cmd: [...cmd],
      returncode: 124,
      duration_ms: r.duration_ms,
    });
  const [sortie, t1] = tronquer(r.stdout, maxOut);
  const [erreur, t2] = tronquer(r.stderr, maxOut);
  return ok({
    cmd: [...cmd],
    cwd: cwdConteneur(rel),
    returncode: r.returncode,
    stdout: sortie,
    stderr: erreur,
    truncated: t1 || t2 || r.truncated,
    duration_ms: r.duration_ms,
  });
}

/** `_run_cmd` : `["git", …]` dans `rel` (relatif à /work), exécuté par l'agent du bac ; panne de l'agent → enveloppe d'erreur. */
export async function executer(
  c: CompteGit,
  rel: string,
  cmd: readonly string[],
  o: OptionsGit = {},
): Promise<Dict> {
  const timeout = o.timeout ?? TIMEOUT;
  const maxOut = o.maxOut ?? MAX_OUT;
  rejeter(cmd, o.libres);
  if (!cmd.length || cmd[0] !== "git") throw erreurValeur("git command expected");
  let r: GitResult;
  try {
    r = await c.esp.git(rel, cmd.slice(1), { timeoutS: timeout, maxOut: maxOut * 4 });
  } catch (e) {
    if (!(e instanceof AgentError)) throw e;
    return errGit(e.code, agentEnAnglais(e.code, e.message), { cmd: [...cmd], returncode: 1 });
  }
  return enveloppe(cmd, rel, r, timeout, maxOut);
}

/** `_run_git_ro` : sous-commande en lecture seule (liste `READONLY_SUBS`). */
export async function lectureGit(
  c: CompteGit,
  rel: string,
  args: readonly string[],
  o: OptionsGit = {},
): Promise<Dict> {
  if (!args.length) return errGit("args empty");
  if (!READONLY_SUBS.has(lowerPy(args[0] ?? "")))
    return errGit("subcommand_not_allowed", `Read-only allows: ${reprPy([...READONLY_SUBS].sort())}`);
  const libres = new Set([...(o.libres ?? [])].map((i) => i + 1));
  return executer(c, rel, ["git", ...args], { ...o, libres });
}

/** `_run_network` : commande réseau vers `url` par le relais (identifiant ajouté par l'hôte, jamais dans le bac). */
export async function executerReseau(
  c: CompteGit,
  rel: string,
  args: readonly string[],
  o: {
    url: string;
    pushRefs?: Iterable<string>;
    auth?: readonly [string, string] | null;
    timeout?: number;
  },
): Promise<Dict> {
  const cmd = ["git", ...args];
  const timeout = o.timeout ?? 120;
  let r: GitResult;
  try {
    r = await c.esp.gitReseau(rel, args, {
      uid: await c.uid(),
      username: c.username,
      url: o.url,
      source: c.source,
      ...(o.pushRefs === undefined ? {} : { pushRefs: o.pushRefs }),
      ...(o.auth ? { auth: o.auth } : {}),
      timeoutS: timeout,
      maxOut: MAX_OUT * 4,
    });
  } catch (e) {
    if (e instanceof RelayRefused) return errGit(e.code, enAnglais(e.message), { cmd, returncode: 1 });
    if (e instanceof AgentError)
      return errGit(e.code, agentEnAnglais(e.code, e.message), { cmd, returncode: 1 });
    throw e;
  }
  r.stderr = enAnglais(r.stderr);
  return enveloppe(cmd, rel, r, timeout, MAX_OUT);
}

/** `_run_pull` : `git pull <mode> <remote> [<branche>]`, fetch par le relais puis fusion locale. */
export async function tirer(
  c: CompteGit,
  rel: string,
  remote: string,
  branche: string,
  mode: string,
  timeout = 120,
): Promise<Dict> {
  const cmd = ["git", "pull", mode, remote, ...(branche ? [branche] : [])];
  let r: GitResult;
  try {
    r = await c.esp.gitPull(rel, remote, branche, mode, {
      uid: await c.uid(),
      username: c.username,
      source: c.source,
      timeoutS: timeout,
      maxOut: MAX_OUT * 4,
    });
  } catch (e) {
    if (e instanceof RelayRefused) return errGit(e.code, enAnglais(e.message), { cmd, returncode: 1 });
    if (e instanceof AgentError)
      return errGit(e.code, agentEnAnglais(e.code, e.message), { cmd, returncode: 1 });
    throw e;
  }
  r.stderr = enAnglais(r.stderr);
  return enveloppe(cmd, rel, r, timeout, MAX_OUT);
}

/** Ligne qui dit l'échec d'une commande git : `fatal:`, `error:` ou `CONFLICT` d'abord, sinon la première ligne qui n'est pas un `hint:`. */
export function ligneEchec(r: Dict): string {
  const lignes = [r["stderr"], r["stdout"]]
    .flatMap((s) => splitlinesPy(typeof s === "string" ? s : "").map(stripPy))
    .filter((l) => l && !l.startsWith("hint:"));
  const ligne = lignes.find((l) => /^(?:fatal:|error:|CONFLICT\b)/u.test(l)) ?? lignes[0];
  return prefixePy(ligne ?? `exit code ${strPy(r["returncode"])}`, 300);
}

/** Commande git sortie avec un code non nul : erreur au code stable, commande et sorties gardées (écart voulu au Python, qui rendait `ok: true`) ; toute autre enveloppe rendue telle quelle. */
export function echecGit(r: Dict, code: string, hint = "", kw: Dict = {}): Dict {
  const rc = r["returncode"];
  if (r["ok"] !== true || typeof rc !== "number" || rc === 0) return r;
  const contexte: Dict = { ...r, ...kw };
  delete contexte["ok"];
  return errGit(`${code}: ${ligneEchec(r)}`, hint, contexte);
}

/** Ligne de bilan d'un `--stat` / `--shortstat` : fichiers, ajouts, retraits. */
export const BILAN_STAT =
  /^\s*(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/u;

/** `r.get("ok") and r.get("returncode") == 0`. */
export function reussi(r: Dict): boolean {
  return r["ok"] === true && r["returncode"] === 0;
}

/** `(r.get("stdout") or "")`. */
export function sortie(r: Dict): string {
  const s = r["stdout"];
  return typeof s === "string" ? s : "";
}

/** `_current_branch` : `branch --show-current` (branche non née comprise), sinon `rev-parse --abbrev-ref HEAD` ; `null` en tête détachée. */
export async function brancheCourante(c: CompteGit, rp: string): Promise<string | null> {
  const r = await lectureGit(c, rp, ["branch", "--show-current"], { maxOut: 2000 });
  if (reussi(r)) {
    const b = stripPy(sortie(r));
    if (b) return b;
  }
  const r2 = await lectureGit(c, rp, ["rev-parse", "--abbrev-ref", "HEAD"], { maxOut: 2000 });
  if (r2["ok"] !== true) return null;
  const b = stripPy(sortie(r2));
  return b && b !== "HEAD" ? b : null;
}

/** `_head_is_unborn` : aucun commit encore. */
export async function teteNonNee(c: CompteGit, rp: string): Promise<boolean> {
  return !reussi(
    await lectureGit(c, rp, ["rev-parse", "--verify", "-q", "HEAD"], { timeout: 4, maxOut: 200 }),
  );
}

/** `_head_is_pristine` : tête non née, ou un seul commit = l'amorce posée par `git_action(init)`. */
export async function tetePristine(c: CompteGit, rp: string): Promise<boolean> {
  if (await teteNonNee(c, rp)) return true;
  const n = await lectureGit(c, rp, ["rev-list", "--count", "HEAD"], { timeout: 4, maxOut: 200 });
  if (!reussi(n)) return false;
  if (entierPy(stripPy(sortie(n)) || "0") !== 1) return false;
  const s = await lectureGit(c, rp, ["log", "-1", "--pretty=format:%s"], { timeout: 4, maxOut: 500 });
  return s["ok"] === true && stripPy(sortie(s)) === INIT_SCAFFOLD_MSG;
}

/** `int(texte)` de Python (blancs et `_` entre chiffres admis), `null` sinon. */
export function entierPy(texte: string): number | null {
  const t = stripPy(texte);
  if (!/^[+-]?\d+(?:_\d+)*$/u.test(t)) return null;
  return Number(t.replaceAll("_", ""));
}

export interface Politique {
  protected_branches: string[];
  allowed_agent_prefixes: string[];
}

/** `_load_repo_policy` : défauts que `.git-tool-policy.json` (64 Kio, lu par l'agent) peut RENFORCER, jamais assouplir ; agent injoignable → `ValueError`. */
export async function politique(c: CompteGit, rp: string): Promise<Politique> {
  const pol: Politique = {
    protected_branches: [...DEFAULT_PROTECTED_BRANCHES],
    allowed_agent_prefixes: [...DEFAULT_AGENT_BRANCH_PREFIXES],
  };
  let lu: unknown;
  try {
    const rel = `${rp || "."}/.git-tool-policy.json`;
    const brut = (await c.esp.lire(rel, { maxBytes: 64 * 1024 })).data;
    lu = parseJsonPy(new TextDecoder("utf-8", { ignoreBOM: true }).decode(brut));
  } catch (e) {
    if (e instanceof AgentError) {
      if (["not_found", "is_dir", "not_file", "too_large", "denied", "outside_root"].includes(e.code))
        return pol;
      throw erreurValeur(
        `policy_unreadable: ${e.code} — the branch policy of this repo could not be read; retry in a moment`,
      );
    }
    return pol;
  }
  if (lu === null || typeof lu !== "object" || Array.isArray(lu)) return pol;
  const d = lu as Dict;
  const textes = (cle: string): string[] | null => {
    const v = d[cle];
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  };
  const defauts = [...pol.protected_branches];
  pol.protected_branches.push(...(textes("protected_branches") ?? []).filter((b) => !defauts.includes(b)));
  const etroit = textes("allowed_agent_prefixes");
  if (etroit !== null)
    pol.allowed_agent_prefixes = pol.allowed_agent_prefixes.filter((x) => etroit.includes(x));
  return pol;
}

/** `_is_protected` : nom exact, ou motif glob s'il contient `*`. */
export function estProtegee(branche: string, pol: Politique): boolean {
  if (!branche) return false;
  return pol.protected_branches.some((m) => m === branche || (m.includes("*") && fnmatchPy(branche, m)));
}

/** `_is_agent_branch` : préfixe d'agent permis. */
export function estBrancheAgent(branche: string, pol: Politique): boolean {
  if (!branche) return false;
  return pol.allowed_agent_prefixes.some((p) => branche.startsWith(p));
}

/** Intention mise en slug avant validation (écart voulu au Python, qui refusait) : minuscules, accents ôtés, blancs et `_` en `-`, le reste retiré. */
export function slugIntention(brut: string): string {
  return stripPy(brut)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** `_validate_intent_slug` : kebab-case, 3 à 41 caractères, après `slugIntention` ; un refus propose un slug valide s'il en existe un. */
export function intentionValide(brut: string): string {
  if (!stripPy(brut))
    throw erreurValeur(
      "branch_intent required — short kebab-case description of what you're about to do, e.g. 'fix-login-validation' or 'add-csv-export'. Must match: ^[a-z0-9][a-z0-9-]{2,40}$",
    );
  const slug = slugIntention(brut);
  if (/^[a-z0-9][a-z0-9-]{2,40}$/u.test(slug)) return slug;
  const court = slug.slice(0, 41).replace(/-+$/u, "");
  const idee = /^[a-z0-9][a-z0-9-]{2,40}$/u.test(court) ? ` Try branch_intent=${reprPy(court)}.` : "";
  throw erreurValeur(
    `Invalid branch_intent ${reprPy(brut)} — normalized to ${reprPy(slug)}, which must start with a letter or digit, contain only [a-z0-9-] and be 3-41 characters long.${idee} Examples: 'fix-login-validation', 'add-csv-export'.`,
  );
}

/** `_generate_agent_branch` : `agent/<intention>-<8 hex>`. */
export function brancheAgent(intention: string, prefixe = "agent/"): string {
  return `${prefixe}${intention}-${randomBytes(4).toString("hex")}`;
}

/** `_default_base_branch` : HEAD distant mémorisé au clone, puis main/master/develop/trunk locales, puis la branche courante, sinon « main ». */
export async function baseParDefaut(c: CompteGit, rp: string): Promise<string> {
  const r = await executer(c, rp, ["git", "symbolic-ref", "refs/remotes/origin/HEAD"], {
    timeout: 4,
    maxOut: 200,
  });
  if (reussi(r)) {
    const ref = stripPy(sortie(r));
    if (ref.startsWith("refs/remotes/origin/") && longueurPy(ref) > 20) return ref.slice(20);
  }
  for (const cand of ["main", "master", "develop", "trunk"]) {
    const v = await lectureGit(c, rp, ["rev-parse", "--verify", `refs/heads/${cand}`], {
      timeout: 4,
      maxOut: 200,
    });
    if (reussi(v)) return cand;
  }
  return (await brancheCourante(c, rp)) || "main";
}

/** `_ensure_git_config` : user.email et user.name locaux posés s'ils manquent. */
export async function assurerConfig(c: CompteGit, rp: string): Promise<void> {
  const present = async (cle: string): Promise<boolean> => {
    const r = await executer(c, rp, ["git", "config", "--local", "--get", cle], { timeout: 3, maxOut: 200 });
    return reussi(r) && stripPy(sortie(r)) !== "";
  };
  if (!(await present("user.email")))
    await executer(c, rp, ["git", "config", "--local", "user.email", `${c.username}@elpis.local`], {
      timeout: 3,
    });
  if (!(await present("user.name")))
    await executer(c, rp, ["git", "config", "--local", "user.name", `${c.username} (Elpis agent)`], {
      timeout: 3,
    });
}
