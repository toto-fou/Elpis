// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/git/ecriture.ts — `git_write` (git_tools.py) : écrire ou remplacer dans un fichier de dépôt par l'agent du bac, sous le verrou partagé avec l'éditeur et fs, historique de session et `files_changed`. */
import type { Dict, MotifPy } from "@elpis/commun";
import { compilerPy, ErreurRe, intPy, lowerPy, stripPy, subn } from "@elpis/commun";
import { AgentError, MAX_FILE, TOO_BIG } from "@elpis/fichiers";
import type { ContenuHistorique } from "@elpis/fichiers";
import { ok } from "@elpis/outils-mcp";

import { Espace } from "../espace";
import { avecVerrou, dansDossierGit, entreeChangee, modeEcrit, noterEcriture } from "../fs/acces";
import { verifierRegexSure } from "../fs/edition";
import { statsDiff } from "../fs/texte";
import {
  depotSur,
  erreurValeur,
  errGit,
  estErreurValeur,
  fichierDuDepot,
  MAX_FILE_READ,
  MAX_FILE_WRITE,
  strExc,
} from "./commun";
import type { CompteGit } from "./commun";
import { ErreurFichierGit, octetsSous } from "./requete";

export interface ArgsEcritureGit {
  repo: string;
  action: string;
  path: string;
  content: string;
  find: string;
  replace: string;
  regex: boolean;
  mode: string;
  dry_run: boolean;
}

const DEMI_PAIRE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;

/** `s.encode("utf-8", errors="replace")` : une demi-paire isolée devient `?`. */
export function octetsRemplaces(s: string): Buffer {
  return Buffer.from(s.replace(DEMI_PAIRE, "?"), "utf-8");
}

/** `len(s.encode())` : UTF-8 strict, `UnicodeEncodeError` (ValueError) du Python sur une demi-paire isolée. */
function longueurStricte(s: string): number {
  const pos: number[] = [];
  let i = 0;
  for (const c of s) {
    if (c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff) pos.push(i);
    i++;
  }
  if (pos.length) {
    const premier = pos[0] as number;
    let fin = premier;
    while (pos.includes(fin + 1)) fin++;
    const code = [...s][premier]?.charCodeAt(0) ?? 0;
    throw erreurValeur(
      fin === premier
        ? `'utf-8' codec can't encode character '\\u${code.toString(16)}' in position ${premier}: surrogates not allowed`
        : `'utf-8' codec can't encode characters in position ${premier}-${fin}: surrogates not allowed`,
    );
  }
  return Buffer.byteLength(s, "utf-8");
}

/** `_read_text_exact` : UTF-8 STRICT, fins de ligne conservées ; un fichier non UTF-8 n'est jamais réécrit. */
async function texteExact(esp: Espace, rel: string): Promise<string> {
  const brut = await octetsSous(esp, rel, MAX_FILE_READ);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(brut);
  } catch {
    throw erreurValeur(
      "not_utf8: this file is not UTF-8 text — rewriting it would corrupt it; use execute_shell (iconv, sed) instead",
    );
  }
}

/** `_history_before` : contenu avant (ou après) écriture pour l'historique : octets, `null`, `TOO_BIG`. */
async function contenuHistorique(esp: Espace, rel: string): Promise<ContenuHistorique> {
  try {
    const e = await esp.stat(rel);
    if (e["kind"] !== "file") return null;
    if (intPy(e["size"] || 0) > MAX_FILE) return TOO_BIG;
    return (await esp.lire(rel, { maxBytes: MAX_FILE })).data;
  } catch {
    return null;
  }
}

/** `_write_atomic` : verrou de fichier partagé, mode du fichier remplacé conservé ; refus de l'agent → `ValueError(code)`. */
async function ecrireAtomique(esp: Espace, rel: string, contenu: string): Promise<void> {
  const b = octetsRemplaces(contenu);
  if (b.length > MAX_FILE_WRITE) throw erreurValeur(`too_large: ${b.length}B`);
  try {
    await avecVerrou(esp, rel, async () => {
      const mode = modeEcrit(await esp.stat(rel));
      await esp.ecrire(rel, b, { parents: true, ...(mode === undefined ? {} : { mode }) });
    });
  } catch (e) {
    if (e instanceof AgentError) throw erreurValeur(e.code);
    throw e;
  }
}

/** `_git_write_fc` : `files_changed` (chemin /work, empreintes des versions, lignes ±) ; toute panne → rien. */
function fichiersChanges(rel: string, avant: ContenuHistorique, apres: ContenuHistorique): Dict {
  try {
    const ent = entreeChangee(rel, avant === null ? "created" : "modified", avant, apres);
    if (ent["new_sha256"] && (avant === null || ent["old_sha256"]) && apres instanceof Uint8Array) {
      const lire = (b: Uint8Array): string => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);
      const anc = avant instanceof Uint8Array ? avant : new Uint8Array();
      [ent["lines_added"], ent["lines_removed"]] = statsDiff(lire(anc), lire(apres));
    }
    return { files_changed: [ent] };
  } catch {
    return {};
  }
}

/** Écrit puis note l'écriture dans l'historique de session du compte (id du compte résolu, jamais 0 sur l'hôte). */
async function ecrireEtNoter(c: CompteGit, rel: string, contenu: string): Promise<Dict> {
  const esp = new Espace(c.esp.racine, await c.uid(), c.esp.agent);
  const avant = await contenuHistorique(esp, rel);
  await ecrireAtomique(esp, rel, contenu);
  const apres = await contenuHistorique(esp, rel);
  await noterEcriture(esp, rel, avant, apres);
  return fichiersChanges(rel, avant, apres);
}

async function ecrireDepot(c: CompteGit, a: ArgsEcritureGit): Promise<Dict> {
  const rp = await depotSur(c.esp, a.repo);
  const act = lowerPy(stripPy(a.action || ""));
  const rel = fichierDuDepot(rp, a.path);
  if (await dansDossierGit(c.esp, rel))
    return errGit(
      "path_in_git_dir: git_write does not write inside a git directory",
      "Edit work-tree files only; repository state (config, hooks, refs) is managed by git_action, git_start_work and git_commit.",
      { path: a.path },
    );
  if (act === "write") {
    const mode = lowerPy(stripPy(a.mode || "overwrite"));
    if (mode !== "overwrite" && mode !== "append") return errGit("invalid_mode", "Use: overwrite|append");
    let nouveau = a.content || "";
    const existe = (await c.esp.stat(rel))["kind"] !== "missing";
    if (mode === "append" && existe) nouveau = (await texteExact(c.esp, rel)) + nouveau;
    const n = octetsRemplaces(nouveau).length;
    if (n > MAX_FILE_WRITE) return errGit("too_large", `Max ${MAX_FILE_WRITE} bytes.`);
    if (a.dry_run)
      return ok({ path: a.path, action: mode, dry_run: true, bytes_after: n, exists_before: existe });
    const fc = await ecrireEtNoter(c, rel, nouveau);
    return ok({ path: a.path, bytes: n, action: mode, ...fc });
  }
  if (act === "replace") {
    if (!a.find) return errGit("find required");
    const texte = await texteExact(c.esp, rel);
    let nouveau: string;
    let n: number;
    if (!a.regex) {
      n = texte.split(a.find).length - 1;
      if (n === 0)
        return ok({ path: a.path, replacements: 0, changed: false, hint: "find string not found in file." });
      nouveau = texte.replaceAll(a.find, () => a.replace);
    } else {
      let m: MotifPy;
      try {
        verifierRegexSure(a.find);
        m = compilerPy(a.find, 0);
      } catch (e) {
        if (e instanceof ErreurRe) return errGit(`bad_regex: ${e.message}`, "Escape special chars with \\ .");
        throw e;
      }
      [nouveau, n] = subn(m, a.replace, texte);
      if (n === 0) return ok({ path: a.path, replacements: 0, changed: false });
    }
    if (a.dry_run)
      return ok({
        path: a.path,
        action: "replace",
        dry_run: true,
        replacements: n,
        bytes_before: longueurStricte(texte),
        bytes_after: longueurStricte(nouveau),
      });
    const fc = await ecrireEtNoter(c, rel, nouveau);
    return ok({ path: a.path, replacements: n, changed: true, ...fc });
  }
  return errGit("unknown action", "Use: write|replace");
}

/** `git_write` : `ValueError`, fichier absent ou dossier → enveloppe de leur message ; toute autre panne → `unexpected: …`. */
export async function gitWrite(c: CompteGit, a: ArgsEcritureGit): Promise<Dict> {
  try {
    return await ecrireDepot(c, a);
  } catch (e) {
    if (estErreurValeur(e) || e instanceof ErreurFichierGit) return errGit(e.message);
    return errGit(`unexpected: ${strExc(e)}`);
  }
}
