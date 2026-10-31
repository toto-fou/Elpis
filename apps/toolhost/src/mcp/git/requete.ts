// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/git/requete.ts — `git_query` (git_tools.py) : requêtes en lecture seule (status, log, diff, show, blame, branches, tags, remotes, conflicts, grep, files, find_text, read, repos). */

import type { Dict } from "@elpis/commun";
import { intPy, longueurPy, lowerPy, prefixePy, splitlinesPy, stripPy } from "@elpis/commun";
import { AgentError } from "@elpis/fichiers";
import { globMatch, ok, unquote } from "@elpis/outils-mcp";

import type { Espace } from "../espace";
import { PROFONDEUR } from "../fs/acces";
import { MAX_WALK } from "../fs/liste";
import { cleParcours, comparerCles } from "../fs/texte";
import {
  baseParDefaut,
  BILAN_STAT,
  brancheCourante,
  cheminSur,
  cwdConteneur,
  depotSur,
  echecGit,
  entierPy,
  erreurValeur,
  errGit,
  estErreurValeur,
  fichierDuDepot,
  lectureGit,
  MAX_FILE_READ,
  MAX_FILES,
  refSure,
  reussi,
  sortie,
  strExc,
  USER_GIT_SUBDIR,
} from "./commun";
import type { CompteGit } from "./commun";

export interface ArgsRequete {
  repo: string;
  action: string;
  target: string;
  target2: string;
  pattern: string;
  max_count: number;
  ignore_case: boolean;
  start_line: number;
  max_lines: number;
}

/** Diff (`diff`, `show`) au-delà duquel seuls le `--stat` et son début sont rendus, en caractères (harnais N-14, GI-12). */
export const DIFF_APERCU = 6000;
/** Diff lu jusqu'à cette taille pour en donner la taille exacte, en caractères. */
const DIFF_LU = 1_000_000;
/** `--stat` rendu en entier jusqu'à cette taille ; au-delà, ses premières lignes et son bilan. */
const STAT_MAX = 6000;

/** `--stat` borné : premières lignes tenant dans `STAT_MAX`, fichiers omis comptés, ligne de bilan gardée. */
function statBorne(texte: string): [string, boolean] {
  const lignes = splitlinesPy(texte).filter((l) => stripPy(l));
  if (longueurPy(texte) <= STAT_MAX) return [lignes.join("\n"), false];
  const bilan = BILAN_STAT.test(lignes[lignes.length - 1] ?? "") ? (lignes.pop() as string) : "";
  const gardees: string[] = [];
  let taille = longueurPy(bilan);
  for (const l of lignes) {
    taille += longueurPy(l) + 1;
    if (taille > STAT_MAX) break;
    gardees.push(l);
  }
  gardees.push(`... ${lignes.length - gardees.length} more file(s)`);
  if (bilan) gardees.push(bilan);
  return [gardees.join("\n"), true];
}

/** `diff` et `show` bornés : un petit diff rendu tel quel ; au-delà de `DIFF_APERCU`, `--stat` complet, début coupé sur une fin de ligne, taille totale et `hint`. */
async function diffBorne(c: CompteGit, rp: string, args: string[], argsStat: string[]): Promise<Dict> {
  const r = await lectureGit(c, rp, args, { maxOut: DIFF_LU });
  if (!reussi(r)) return r;
  const texte = sortie(r);
  const entier = r["truncated"] !== true;
  if (entier && longueurPy(texte) <= DIFF_APERCU) return r;
  const st = await lectureGit(c, rp, argsStat, { maxOut: DIFF_LU });
  const [stat, statCoupe] = statBorne(reussi(st) ? sortie(st) : "");
  const bilan = BILAN_STAT.exec(stat.slice(stat.lastIndexOf("\n") + 1));
  const tete = prefixePy(texte, DIFF_APERCU);
  const montre = tete.includes("\n") ? tete.slice(0, tete.lastIndexOf("\n") + 1) : tete;
  const total = entier ? longueurPy(texte) : null;
  const n = longueurPy(montre);
  const taille = total === null ? `more than ${DIFF_LU} characters` : `${total} characters`;
  return ok({
    cmd: r["cmd"],
    cwd: r["cwd"],
    returncode: 0,
    truncated: true,
    total_chars: total,
    total_lines: entier ? splitlinesPy(texte).length : null,
    shown_chars: n,
    files_changed: bilan ? Number(bilan[1]) : null,
    insertions: bilan ? Number(bilan[2] ?? 0) : null,
    deletions: bilan ? Number(bilan[3] ?? 0) : null,
    stat,
    stat_truncated: statCoupe,
    stdout:
      montre +
      (total === null
        ? `...[truncated: diff larger than ${DIFF_LU} characters]`
        : `...[truncated: ${total - n} of ${total} characters omitted]`),
    stderr: r["stderr"],
    hint: `Large diff (${taille}): 'stat' lists the changed files and 'stdout' holds only the first ${n} characters, cut at a line end. To see more, narrow the range with target/target2 (one commit: target='<sha>~1', target2='<sha>'), or read a changed file with git_query(action='read', target='<path>', start_line=..., max_lines=...).`,
    duration_ms: r["duration_ms"],
  });
}

/** Requête sortie en erreur : référence inconnue reconnue, sinon `<action>_failed` ; `grep` sans résultat (code 1, rien sur stderr) reste un succès. */
function echecRequete(act: string, r: Dict): Dict {
  if (act === "grep" && r["returncode"] === 1 && !stripPy(String(r["stderr"] ?? ""))) return r;
  if (
    /unknown revision|bad revision|bad object|invalid object name|not a valid object name|needed a single revision/iu.test(
      String(r["stderr"] ?? ""),
    )
  )
    return echecGit(
      r,
      "unknown_ref",
      "List the refs with git_query(action='branches'), git_query(action='tags') or git_query(action='log').",
    );
  return echecGit(r, `${act}_failed`);
}

/** `FileNotFoundError` / `IsADirectoryError` de `_read_bytes_under` : `str(e)` = le code. */
export class ErreurFichierGit extends Error {
  constructor(nature: "FileNotFoundError" | "IsADirectoryError", message: string) {
    super(message);
    this.name = nature;
  }
}

/** `_read_bytes_under` : octets d'un fichier du bac lus par l'agent, bornés ; refus de l'agent → `ValueError(code)`. */
export async function octetsSous(esp: Espace, rel: string, maxOctets: number): Promise<Buffer> {
  try {
    const e = await esp.stat(rel);
    if (e["kind"] === "missing") throw new ErreurFichierGit("FileNotFoundError", "not_found");
    if (e["kind"] === "dir") throw new ErreurFichierGit("IsADirectoryError", "is_dir");
    const taille = intPy(e["size"] || 0);
    if (taille > maxOctets) throw erreurValeur(`too_large: ${taille}B`);
    return (await esp.lire(rel, { maxBytes: maxOctets })).data;
  } catch (x) {
    if (x instanceof AgentError) throw erreurValeur(x.code);
    throw x;
  }
}

/** `_read_text` : lecture tolérante (octets invalides remplacés, fins de ligne ramenées à `\n`). */
export async function texteTolerant(esp: Espace, rel: string, maxOctets: number): Promise<string> {
  const t = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await octetsSous(esp, rel, maxOctets));
  return t.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/** `git_query(action='repos')` : dépôts du bac (profondeur ≤ 3), branche, base et propreté de chacun (entrée partielle si git échoue), racine vue du conteneur. */
async function depots(c: CompteGit): Promise<Dict> {
  const trouves: Dict[] = [];
  for (const rel of await c.esp.gitDepots({ depth: 3, limit: 50 })) {
    const entree: Dict = { path: rel };
    await (async () => {
      const br = await brancheCourante(c, rel);
      entree["current_branch"] = br || "?";
      entree["default_branch"] = await baseParDefaut(c, rel);
      const st = await lectureGit(c, rel, ["status", "--porcelain=v1"], { timeout: 4, maxOut: 2000 });
      entree["is_clean"] = st["ok"] === true && !stripPy(sortie(st));
    })().catch(() => undefined);
    if (rel.split("/").includes(USER_GIT_SUBDIR)) entree["legacy_layout"] = true;
    trouves.push(entree);
  }
  return ok({ repos: trouves, count: trouves.length, sandbox_root: cwdConteneur("") });
}

async function fichiers(c: CompteGit, rp: string, motif: string, maxCount: number): Promise<Dict> {
  const cap = Math.max(1, Math.min(maxCount, MAX_FILES));
  const pat = motif || "**/*";
  const liste = await c.esp.lister(rp, {
    depth: PROFONDEUR,
    maxEntries: MAX_WALK,
    hidden: true,
    exclude: [".git"],
  });
  const rels = liste.entries
    .filter((x) => x["kind"] === "file" || x["kind"] === "link")
    .map((x) => (rp ? String(x["path"]).slice(rp.length + 1) : String(x["path"])));
  const cles = new Map(rels.map((r) => [r, cleParcours(r, false)]));
  rels.sort((a, b) => comparerCles(cles.get(a) ?? [], cles.get(b) ?? []));
  const out: string[] = [];
  for (const rel of rels) {
    if (!globMatch(rel, pat)) continue;
    out.push(rel);
    if (out.length >= cap) break;
  }
  return ok({ items: out, count: out.length, glob: pat, truncated: out.length >= cap || liste.truncated });
}

async function trouverTexte(
  c: CompteGit,
  rp: string,
  a: ArgsRequete,
  motif: string,
  cible: string,
): Promise<Dict> {
  if (!motif) return errGit("pattern required", "pattern=<text to search>");
  const cap = Math.max(1, Math.min(a.max_count, 5000));
  const args = ["grep", "-n", "-I", `--max-count=${cap}`];
  if (a.ignore_case) args.push("-i");
  if (motif.startsWith("re:")) args.push("-E", "--", motif.slice(3));
  else args.push("-F", "--", motif);
  const libres = new Set([args.length - 1]);
  if (cible) args.push(":(glob)" + cible);
  const r = await lectureGit(c, rp, args, { timeout: 15, libres });
  if (r["ok"] !== true) return r;
  if (r["returncode"] !== 0 && (r["returncode"] !== 1 || stripPy(String(r["stderr"] ?? ""))))
    return echecGit(
      r,
      "find_text_failed",
      "Check the pattern: plain text by default, an extended regex (ERE) after 're:'.",
    );
  const hits: Dict[] = [];
  for (const ligne of splitlinesPy(sortie(r))) {
    const i = ligne.indexOf(":");
    const j = i < 0 ? -1 : ligne.indexOf(":", i + 1);
    if (j < 0) continue;
    const n = entierPy(ligne.slice(i + 1, j));
    if (n === null) continue;
    hits.push({ file: ligne.slice(0, i), line: n, text: prefixePy(ligne.slice(j + 1), 260) });
    if (hits.length >= cap) break;
  }
  return ok({ hits, count: hits.length, truncated: hits.length >= cap, via: "git_grep" });
}

async function requeteDepot(c: CompteGit, act: string, a: ArgsRequete): Promise<Dict> {
  const rp = await depotSur(c.esp, a.repo);
  const [cible, cible2, motif] = [unquote(a.target), unquote(a.target2), unquote(a.pattern)];
  switch (act) {
    case "status":
      return lectureGit(c, rp, ["status", "--porcelain=v1", "-b"]);
    case "log": {
      const args = [
        "log",
        `--max-count=${Math.max(1, Math.min(a.max_count, 200))}`,
        "--oneline",
        "--decorate",
      ];
      if (cible) args.push(refSure(cible));
      return lectureGit(c, rp, args);
    }
    case "diff": {
      const rev: string[] = [];
      if (cible && cible2) rev.push(`${refSure(cible)}..${refSure(cible2)}`);
      else if (cible) {
        const tl = lowerPy(cible);
        rev.push(tl.includes("staged") || tl.includes("cached") ? "--staged" : refSure(cible));
      }
      return diffBorne(
        c,
        rp,
        ["diff", "-U1", ...rev],
        ["diff", "--stat=200", "--stat-graph-width=20", ...rev],
      );
    }
    case "show": {
      if (!cible) return errGit("target required", "target=<ref> (commit SHA, tag, HEAD~1, ...)");
      const ref = refSure(cible);
      return diffBorne(
        c,
        rp,
        ["show", ref],
        ["show", "--stat=200", "--stat-graph-width=20", "--format=", ref],
      );
    }
    case "blame": {
      if (!cible) return errGit("target required (filepath)", "target=path/to/file");
      cheminSur(cible);
      const sl = Math.max(1, Math.trunc(a.start_line));
      const el = sl + Math.max(1, Math.min(Math.trunc(a.max_lines), 1000)) - 1;
      return lectureGit(c, rp, ["blame", "-L", `${sl},${el}`, "--", cible]);
    }
    case "branches":
      return lectureGit(c, rp, ["branch", "-vv", ...(cible === "all" ? ["-a"] : [])]);
    case "tags":
      return lectureGit(c, rp, ["tag", "--list", "--sort=-creatordate"]);
    case "remotes":
      return lectureGit(c, rp, ["remote", "-v"]);
    case "conflicts": {
      const r = await lectureGit(c, rp, ["diff", "--name-only", "--diff-filter=U"]);
      if (!reussi(r)) return echecGit(r, "conflicts_failed");
      const liste = splitlinesPy(sortie(r)).filter((l) => stripPy(l));
      return ok({
        count: liste.length,
        files: liste,
        hint: liste.length ? "Resolve via git_write or manual edit, then re-stage." : "",
      });
    }
    case "grep": {
      if (!motif) return errGit("pattern required");
      const args = ["grep", "-n", `--max-count=${Math.max(1, Math.min(a.max_count, 2000))}`];
      if (a.ignore_case) args.push("-i");
      args.push("--", motif);
      const libres = new Set([args.length - 1]);
      if (cible) args.push(cheminSur(cible));
      return lectureGit(c, rp, args, { libres });
    }
    case "files":
      return fichiers(c, rp, motif, a.max_count);
    case "find_text":
      return trouverTexte(c, rp, a, motif, cible);
    case "read": {
      if (!cible) return errGit("target=filepath required");
      const lignes = splitlinesPy(await texteTolerant(c.esp, fichierDuDepot(rp, cible), MAX_FILE_READ));
      const s = Math.max(a.start_line - 1, 0);
      const morceau = lignes.slice(s, s + Math.max(1, Math.min(a.max_lines, 2000)));
      return ok({ path: cible, start_line: s + 1, total_lines: lignes.length, content: morceau.join("\n") });
    }
    default:
      return errGit(
        `unknown action: ${act}`,
        "Use: status|log|diff|show|blame|branches|tags|remotes|conflicts|grep|files|find_text|read",
      );
  }
}

/** `git_query` : `ValueError` → enveloppe de son message, toute autre panne → `unexpected: …` ; une commande sortie en erreur n'est jamais un succès. */
export async function gitQuery(c: CompteGit, a: ArgsRequete): Promise<Dict> {
  try {
    const act = lowerPy(stripPy(a.action || ""));
    if (act === "repos") return await depots(c);
    return echecRequete(act, await requeteDepot(c, act, a));
  } catch (e) {
    if (estErreurValeur(e)) return errGit(e.message);
    return errGit(`unexpected: ${strExc(e)}`);
  }
}
