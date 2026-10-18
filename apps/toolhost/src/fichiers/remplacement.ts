// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/remplacement.ts — remplacement multi-fichiers de l'éditeur (routes_files.py `_replace_*`, `_remplacement*`) : `re.subn` de Python (expression traduite, gabarit `_parser.parse_template`, correspondances vides de `_sre`), lignes, échantillons. */
import {
  compilerReGroupes,
  ErreurPyRe,
  ErreurRe,
  echapperPy,
  fnmatchPy,
  gabaritPy,
  RE_IGNORECASE,
  RegexNonGeree,
  splitlinesPy,
  veritePy,
} from "@elpis/commun";
import type { ReCompile } from "@elpis/commun";

export const REPLACE_MAX_SAMPLES = 5;
export const GREP_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const GREP_IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".charts",
  ".memory",
  "__pycache__",
  "node_modules",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".cache",
  "dist",
  "build",
]);
const JS_REF_RE = /\$(\$|&|\p{Nd}+)/gu;
const FIN_DE_LIGNE = /(\r\n|\n|\r)$/u;
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Erreur du gabarit ou de l'expression : message de `str(e)` (re.error ou IndexError). */
export class ErreurGabarit extends Error {
  override name = "ErreurGabarit";
}

/** `_replace_template` (expression) : `$1`, `$&`, `$$` du JavaScript traduits en gabarit `re`. */
export function gabaritJs(remplacement: string): string {
  return remplacement.replace(JS_REF_RE, (_m, g: string) =>
    g === "$" ? "$" : g === "&" ? "\\g<0>" : `\\g<${g}>`,
  );
}

/** Morceau d'un gabarit : texte littéral, ou numéro de groupe de Python. */
export type Morceau = string | number;

/** `_parser.parse_template` de Python 3.13 (moteur `re` commun) : ses refus (`re.error`, `IndexError`) deviennent des erreurs du gabarit. */
export function analyserGabarit(source: string, c: Pick<ReCompile, "groupes" | "noms">): Morceau[] {
  try {
    return gabaritPy(source, c);
  } catch (e) {
    if (e instanceof ErreurRe || (e instanceof ErreurPyRe && e.name === "IndexError"))
      throw new ErreurGabarit(e.message);
    throw e;
  }
}

/** Indice au milieu d'une paire de substitution (entre ses deux unités UTF-16). */
function dansPaire(t: string, i: number): boolean {
  if (i <= 0 || i >= t.length) return false;
  const bas = t.charCodeAt(i);
  const haut = t.charCodeAt(i - 1);
  return bas >= 0xdc00 && bas <= 0xdfff && haut >= 0xd800 && haut <= 0xdbff;
}

/** Spécification d'un remplacement (corps de `/api/sandbox/replace`). */
export interface SpecRemplacement {
  readonly query: string;
  readonly replacement: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
}

/** `pat.subn(repl, texte)` de Python sur l'expression traduite ; construit en refusant comme `re.compile` puis `subn(repl, "")`. */
export class Remplaceur {
  private readonly c: ReCompile;
  private readonly global: RegExp;
  private nonVide: RegExp | null = null;
  private readonly morceaux: Morceau[] | null;
  private readonly litteral: string;

  constructor(spec: SpecRemplacement) {
    const motif = spec.regex ? spec.query : echapperPy(spec.query);
    this.c = compilerReGroupes(motif, spec.caseSensitive ? 0 : RE_IGNORECASE);
    this.global = new RegExp(this.c.re.source, "gv");
    this.litteral = spec.replacement;
    this.morceaux = spec.regex ? analyserGabarit(gabaritJs(spec.replacement), this.c) : null;
  }

  /** Correspondance non vide à `pos` exactement (`must_advance` de `_sre`), sinon `null`. */
  private nonVideA(texte: string, pos: number): RegExpExecArray | null {
    this.nonVide ??= new RegExp(
      `(?=(?<elpisFin>[\\s\\S]*))(?:${this.c.sourceApres(1)})(?!\\k<elpisFin>(?![\\s\\S]))`,
      "vy",
    );
    this.nonVide.lastIndex = pos;
    return this.nonVide.exec(texte);
  }

  private developper(m: RegExpExecArray, decalage: number): string {
    if (this.morceaux === null) return this.litteral;
    let r = "";
    for (const x of this.morceaux) {
      if (typeof x === "string") r += x;
      else r += (x === 0 ? m[0] : m[(this.c.versJs.get(x) ?? x) + decalage]) ?? "";
    }
    return r;
  }

  /** Prochaine correspondance à partir de `pos`, jamais au milieu d'une paire de substitution (Python compte en points de code). */
  private chercher(texte: string, pos: number): RegExpExecArray | null {
    this.global.lastIndex = pos;
    for (;;) {
      const m = this.global.exec(texte);
      if (m === null || !dansPaire(texte, m.index)) return m;
      this.global.lastIndex = m.index + 1;
    }
  }

  /** `(nouveau texte, nombre de remplacements)`. */
  subn(texte: string): [string, number] {
    let sortie = "";
    let n = 0;
    let dernier = 0;
    let pos = 0;
    let avancer = false;
    for (;;) {
      let m: RegExpExecArray | null;
      let decalage = 0;
      if (avancer) {
        m = this.nonVideA(texte, pos);
        decalage = 1;
        if (m === null) {
          if (pos >= texte.length) break;
          decalage = 0;
          m = this.chercher(texte, pos + ((texte.codePointAt(pos) ?? 0) > 0xffff ? 2 : 1));
        }
      } else m = this.chercher(texte, pos);
      if (m === null) break;
      const debut = m.index;
      const fin = debut + m[0].length;
      sortie += texte.slice(dernier, debut) + this.developper(m, decalage);
      n += 1;
      dernier = fin;
      avancer = debut === fin;
      pos = fin;
    }
    return [sortie + texte.slice(dernier), n];
  }
}

/** Compilation du motif et du gabarit comme la route : message de `str(e)`, `Regex invalide` ou `Remplacement invalide`. */
export function preparerRemplaceur(spec: SpecRemplacement): Remplaceur | { erreur: string } {
  try {
    return new Remplaceur(spec);
  } catch (e) {
    if (e instanceof ErreurGabarit) return { erreur: `Remplacement invalide : ${e.message}` };
    if (e instanceof RegexNonGeree)
      return { erreur: "Regex invalide : motif sans équivalent JavaScript (conditionnelle, \\N{…})" };
    if (e instanceof ErreurRe) return { erreur: `Regex invalide : ${e.message}` };
    throw e;
  }
}

/** Échantillon d'une ligne remplacée : numéro, avant, après. */
export type Echantillon = [number, string, string];

/** `_replace_in_text` : remplacement ligne par ligne (fin de ligne gardée), nombre et premiers échantillons. */
export function remplacerDansTexte(
  texte: string,
  r: Remplaceur,
  maxEchantillons = REPLACE_MAX_SAMPLES,
): [string, number, Echantillon[]] {
  const sortie: string[] = [];
  const echantillons: Echantillon[] = [];
  let total = 0;
  let numero = 0;
  for (const brut of lignesAvecFins(texte)) {
    numero += 1;
    const fin = FIN_DE_LIGNE.exec(brut)?.[1] ?? "";
    const corps = brut.slice(0, brut.length - fin.length);
    const [nouveau, n] = r.subn(corps);
    if (n) {
      total += n;
      if (echantillons.length < maxEchantillons) echantillons.push([numero, corps, nouveau]);
    }
    sortie.push(nouveau + fin);
  }
  return [sortie.join(""), total, echantillons];
}

/** `str.splitlines(keepends=True)`. */
export function lignesAvecFins(texte: string): string[] {
  const sansFin = splitlinesPy(texte);
  const lignes: string[] = [];
  let pos = 0;
  for (const l of sansFin) {
    let fin = pos + l.length;
    if (texte.charAt(fin) === "\r" && texte.charAt(fin + 1) === "\n") fin += 2;
    else if (fin < texte.length) fin += 1;
    lignes.push(texte.slice(pos, fin));
    pos = fin;
  }
  return lignes;
}

/** Longueur en points de code (`len(str)`). */
export function longueurPy(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** Résultat de `_remplacement` : à remplacer, raison d'ignorer, ou rien. */
export type ResultatRemplacement =
  { texte: string; nouveau: string; n: number; echantillons: Echantillon[] } | string | null;

/** `_remplacement` : un fichier lu par l'agent (`kind`, `link` de son entrée) ; liens et fichiers spéciaux ignorés, binaire ou non UTF-8 strict hors champ. */
export function remplacement(
  entree: { kind: unknown; link?: unknown },
  brut: Uint8Array | null,
  r: Remplaceur,
): ResultatRemplacement {
  if (entree.kind === "link" || veritePy(entree.link)) return "lien symbolique";
  if (entree.kind !== "file") return "fichier spécial";
  if (brut === null || brut.length > GREP_MAX_FILE_BYTES || brut.subarray(0, 512).includes(0)) return null;
  let texte: string;
  try {
    texte = UTF8_STRICT.decode(brut);
  } catch {
    return null;
  }
  const [nouveau, n, echantillons] = remplacerDansTexte(texte, r);
  if (!n) return null;
  if (longueurPy(nouveau) > GREP_MAX_FILE_BYTES) return "résultat trop gros";
  return { texte, nouveau, n, echantillons };
}

/** `_replace_path_in_scope` : mêmes exclusions que le parcours de l'aperçu, pour un chemin fourni à l'application. */
export function dansLeChamp(rel: string, cachesAussi: boolean, motifNom: string): boolean {
  const parties = partiesPosix(rel);
  if (!parties.length || parties.some((p) => p === "" || p === "." || p === "..")) return false;
  if (parties.slice(0, -1).some((d) => GREP_IGNORED_DIRS.has(d))) return false;
  if (!cachesAussi && parties.some((p) => p.startsWith("."))) return false;
  return !motifNom || fnmatchPy(parties[parties.length - 1] as string, motifNom);
}

/** `PurePosixPath(p).parts` : `/` de tête comme partie, `//` gardé, `.` et vides retirés. */
export function partiesPosix(p: string): string[] {
  const tete = p.startsWith("//") && !p.startsWith("///") ? ["//"] : p.startsWith("/") ? ["/"] : [];
  return [...tete, ...p.split("/").filter((x) => x !== "" && x !== ".")];
}

/** `PurePosixPath(p).as_posix()`. */
export function posix(p: string): string {
  const parties = partiesPosix(p);
  if (!parties.length) return ".";
  const [t, ...reste] = parties;
  if (t === "/" || t === "//") return t + reste.join("/");
  return parties.join("/");
}
