// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/edition.ts — moteur d'édition de edit_file (fs_tools.py) : str_replace (repli tolérant), contexte, regex, lignes, ancres, indentation, lots `multi` ordonnés. */
import {
  BLANC_PY,
  compilerPy,
  ErreurLecturePy,
  ErreurPyRe,
  ErreurPython,
  ErreurRe,
  estDict,
  getCloseMatches,
  intPy,
  longueurPy,
  lowerPy,
  prefixePy,
  RE_DOTALL,
  RE_IGNORECASE,
  RE_MULTILINE,
  rstripPy,
  splitlinesPy,
  stripPy,
  subn,
  trouverTout,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { err } from "@elpis/outils-mcp";

import { ErreurCodec } from "./codecs";

/** `ValueError` levée par le moteur (message lu par `_edit_err`). */
export class ErreurEdition extends Error {
  override readonly name = "ValueError";

  readonly extra: Dict;

  constructor(message: string, extra: Dict = {}) {
    super(message);
    this.extra = extra;
  }
}

/** Occurrences (5 au plus) de positions `offs` : {line, text coupé à 80} et total. */
function occurrencesDe(texte: string, offs: readonly number[]): Dict {
  const lignes = texte.split("\n");
  const occurrences = offs.slice(0, 5).map((o) => {
    const ligne = compterNl(texte, o);
    const t = lignes[ligne] ?? "";
    return { line: ligne + 1, text: longueurPy(t) > 80 ? prefixePy(t, 80) : t };
  });
  return { occurrences, total: offs.length };
}

/** Positions des occurrences de `sous` (les 5 premières suffisent pour le détail). */
function positions(texte: string, sous: string, max = 5): number[] {
  const r: number[] = [];
  for (let i = texte.indexOf(sous); i >= 0 && r.length < max; i = texte.indexOf(sous, i + sous.length))
    r.push(i);
  return r;
}

/** « lines 3, 9, 14 » des occurrences, avec « … » si le total en dépasse l'affichage. */
function lignesMessage(d: Dict): string {
  const occ = d["occurrences"] as { line: number }[];
  return `lines ${occ.map((o) => o.line).join(", ")}${(d["total"] as number) > occ.length ? ", …" : ""}`;
}

/** `ValueError` de Python : du moteur, ou d'un `int()` sur une valeur reçue. */
export function estValueError(e: unknown): e is Error {
  return (
    e instanceof ErreurEdition ||
    (e instanceof ErreurPython && e.type === "ValueError") ||
    (e instanceof ErreurLecturePy && e.nature !== "RecursionError") ||
    (e instanceof ErreurCodec && e.name !== "LookupError") ||
    (e instanceof ErreurPyRe && e.name === "ValueError") ||
    (e instanceof Error && e.name === "SandboxPathError")
  );
}

/** Messages connus du moteur et des chemins → code stable (sans donnée) ; écart voulu au Python : le code n'est plus le slug du message. */
export const CODES_MESSAGE: readonly (readonly [RegExp, string])[] = [
  [/path outside the sandbox root|'\.\.' component refused|absolute path refused/u, "path_outside_sandbox"],
  [/null byte in path|control character in path|^path required/u, "invalid_path"],
  [/symlink or (?:non-directory|special file)/u, "symlink_refused"],
  [/a file path is required|operation requires a path inside/u, "path_not_allowed"],
  [/old_str required/u, "old_str_required"],
  [/pattern required/u, "pattern_required"],
  [/content required/u, "content_required"],
  [/provide at least one of before_context/u, "context_required"],
  [/str_replace_ctx: no match/u, "context_no_match"],
  [/bad regex|bad pattern/u, "bad_regex"],
  [/provide anchor_str or anchor_re/u, "anchor_required"],
  [/anchor: position must be/u, "invalid_position"],
  [/anchor: occurrence=/u, "occurrence_out_of_range"],
  [/start_line (?:required|must be)/u, "invalid_line"],
  [/start_line \S+ > total/u, "line_out_of_range"],
  [/edits \S+ and \S+ overlap/u, "edits_overlap"],
  [/leading spaces, can't dedent/u, "indent_underflow"],
  [/unknown action/u, "unknown_action"],
  [/invalid literal for int\(\)/u, "invalid_integer"],
  [/codec can't encode/u, "invalid_text"],
];

/** Code machine stable : code déjà propre gardé, sinon table, sinon préfixe `mot:` / `mot '…'`, sinon `fs_error`. */
export function codeStable(texte: string): string {
  if (/^[a-z][a-z0-9_]*$/u.test(texte)) return texte;
  for (const [re, code] of CODES_MESSAGE) if (re.test(texte)) return code;
  const pre = /^([a-z][a-z0-9_]*)(?::| ')/u.exec(texte);
  return pre?.[1] ?? "fs_error";
}

/** Correctif d'un `hash_mismatch` : le hash attendu ne correspond pas au fichier courant. */
export const HASH_PERIME =
  "expected_sha256 does not match the current file (it changed since you read it, or the hash is wrong). Re-read it with read_file to get the current sha256, then retry.";

const cite = (v: unknown): string => (typeof v === "string" ? ` '${v}'` : "");
const chemin = (kw: Dict): string => cite(kw["path"]);

/** Phrases anglaises des codes nus (écart voulu au Python : `message` n'est plus le code seul) ; le chemin y figure quand il est connu. */
export const PHRASES: Readonly<Record<string, (kw: Dict) => string>> = {
  not_found: (kw) => `No such file or directory${chemin(kw)}.`,
  is_directory: (kw) => `The path${chemin(kw)} is a directory, not a file.`,
  not_a_regular_file: (kw) => `The path${chemin(kw)} is not a regular file or directory.`,
  bad_sha256: () => "expected_sha256 is not a 64-character hexadecimal sha256.",
  hash_mismatch: (kw) => `The current sha256${chemin(kw)} differs from expected_sha256; nothing was written.`,
  not_utf8: (kw) => `The file${chemin(kw)} is not valid UTF-8 text.`,
  dest_exists: (kw) => `The destination${cite(kw["dest"])} already exists.`,
  is_dir: (kw) => `The target${chemin(kw)} is a directory and recursive=True was not given.`,
  root_refused: () => "The sandbox root itself cannot be deleted or moved.",
  path_outside_sandbox: (kw) => `The path${chemin(kw)} resolves outside the sandbox (/work).`,
  permission_denied: (kw) => `Permission denied${chemin(kw)}.`,
  bad_path: (kw) => `Invalid path${chemin(kw)}.`,
  no_space: () => "No space left on the sandbox disk.",
  too_large: (kw) => `Size limit exceeded${chemin(kw)}.`,
  timeout: () => "The sandbox did not answer in time.",
  dest_inside_source: () => "The destination is inside the source directory.",
  sandbox_unavailable: () => "The sandbox container could not be reached.",
  not_greppable: (kw) => `The file${chemin(kw)} cannot be searched as text.`,
  too_large_for_mode: (kw) => `The file${chemin(kw)} is too large for this read mode.`,
  path_required: () => "A path is required.",
  paths_required: () => "A non-empty paths list is required.",
  too_many_paths: () => "Too many paths in one call.",
  edits_required: () => "A non-empty edits list is required.",
  too_many_edits: () => "Too many edits in one call.",
  symbol_required: () => "A symbol is required for this action.",
  dest_required: () => "A destination (dest) is required for this action.",
  invalid_action: () => "Unknown action.",
  invalid_mode: () => "Unknown write mode.",
  conflict: () => "path and paths cannot be used together.",
  scope_not_a_dir: (kw) => `The scope${cite(kw["scope"])} is not a directory.`,
  not_a_file: (kw) => `The path${chemin(kw)} is not a readable file.`,
  concurrent_modification: (kw) =>
    `The file${chemin(kw)} changed during this operation; nothing was written.`,
  encoding_mismatch: (kw) =>
    `The file${chemin(kw)} does not match the requested encoding; nothing was written.`,
  exists_not_dir: (kw) => `The path${chemin(kw)} already exists and is not a directory.`,
  dest_is_directory: (kw) => `The destination${cite(kw["dest"])} is an existing directory.`,
  dest_is_file: (kw) => `The destination${cite(kw["dest"])} is an existing file.`,
  mkdir_moved: () => "write_file does not create directories.",
  backup_is_directory: () => "The backup path is a directory; nothing was written.",
  too_large_after_edit: () => "The edit would make the file too large; nothing was written.",
  path_in_git_dir: (kw) => `The path${chemin(kw)} is inside a .git directory.`,
};

/** Phrase anglaise d'un code nu : celle de `PHRASES`, sinon le code mis en phrase (jamais le code seul). */
export function phraseErreur(code: string, kw: Dict = {}): string {
  if (Object.hasOwn(PHRASES, code)) return (PHRASES[code] as (k: Dict) => string)(kw);
  const mots = code.replaceAll("_", " ");
  return `${mots.charAt(0).toUpperCase()}${mots.slice(1)}${chemin(kw)}.`;
}

/** Correctifs propres à chaque code, pour les erreurs levées sans correctif explicite. */
const CORRECTIFS: Readonly<Record<string, string>> = {
  path_outside_sandbox: "Use a path inside /work (relative, no '..').",
  invalid_path: "Pass a non-empty path without control characters or NUL.",
  symlink_refused: "Pass a regular file or directory, not a symlink or special file.",
  path_not_allowed: "Pass a path to a file or folder inside /work.",
  bad_regex: "Escape special characters with a backslash, or simplify the pattern.",
  invalid_line: "Use 1-based line numbers within the file.",
  line_out_of_range: "Re-read the file to get its current line count.",
};

/** Correctif par défaut d'un code, `null` s'il n'en a pas. */
export function correctifDe(code: string): string | null {
  return Object.hasOwn(CORRECTIFS, code) ? (CORRECTIFS[code] as string) : null;
}

/** `_err` de fs_tools : code stable tiré du message, correctif, contexte. */
export function errFs(msg: unknown, hint = "", kw: Dict = {}): Dict {
  const texte = String(msg);
  return err(codeStable(texte), texte, { fix: hint || null, ...kw });
}

/** Sortie d'outil : erreur dont le message n'est que le code (ou vide) → phrase anglaise, sans correctif → correctif du code (écart voulu au Python) ; lots de `read_file` compris. */
export function enrichirErreur(r: Dict): Dict {
  const f = r["files"];
  if (r["ok"] === true && f !== null && typeof f === "object" && !Array.isArray(f))
    for (const v of Object.values(f as Dict))
      if (v !== null && typeof v === "object") enrichirErreur(v as Dict);
  if (r["ok"] !== false || typeof r["error"] !== "string") return r;
  const code = r["error"];
  if (r["message"] === code || !r["message"]) r["message"] = phraseErreur(code, r);
  if (!r["fix"]) {
    const c = correctifDe(code);
    if (c !== null) r["fix"] = c;
  }
  return r;
}
/** `_edit_err` : codes stables `old_str_not_found` / `old_str_ambiguous`, sinon `_err`. */
export function errEdition(e: Error, o: { prefixe?: string; hint?: string; kw?: Dict } = {}): Dict {
  const ml = lowerPy(e.message);
  const msg = `${o.prefixe ?? ""}${e.message}`;
  const extra = e instanceof ErreurEdition ? e.extra : {};
  if (ml.includes("not found") || ml.includes("matched 0 times"))
    return err("old_str_not_found", msg, {
      fix: o.hint || "Re-read the file — your context is stale (old_str/pattern not found).",
      ...extra,
      ...(o.kw ?? {}),
    });
  if (ml.includes("ambiguous") || ml.includes("occurrences, found"))
    return err("old_str_ambiguous", msg, {
      fix: o.hint || "Widen old_str, or use str_replace_ctx with before_context=/after_context=.",
      ...extra,
      ...(o.kw ?? {}),
    });
  return errFs(msg, o.hint ?? "", { ...extra, ...(o.kw ?? {}) });
}

const REDOS_NESTED = /\([^()]*[+*][^()]*\)[+*]/u;

/** `_check_regex_safe` : motif trop long ou à quantificateur imbriqué refusé avant compilation (`re.error`). */
export function verifierRegexSure(motif: string): void {
  if (!motif) return;
  if (longueurPy(motif) > 2000) throw new ErreurRe("pattern too long (>2000 chars) — denial-of-service risk");
  if (REDOS_NESTED.test(motif))
    throw new ErreurRe("pattern at risk of catastrophic backtracking (nested quantifier)");
}

/** `str.splitlines(keepends=True)` (fins de ligne de Python). */
export function splitlinesGarde(s: string): string[] {
  const nues = splitlinesPy(s);
  const sortie: string[] = [];
  let pos = 0;
  for (const l of nues) {
    let fin = pos + l.length;
    if (s.charCodeAt(fin) === 0x0d && s.charCodeAt(fin + 1) === 0x0a) fin += 2;
    else if (fin < s.length) fin += 1;
    sortie.push(s.slice(pos, fin));
    pos = fin;
  }
  return sortie;
}

/** `str.count(sous)` sans chevauchement. */
export function compter(texte: string, sous: string): number {
  if (!sous) return longueurPy(texte) + 1;
  let n = 0;
  for (let i = texte.indexOf(sous); i >= 0; i = texte.indexOf(sous, i + sous.length)) n++;
  return n;
}

function remplacerN(texte: string, ancien: string, nouveau: string, n: number): string {
  let sortie = "";
  let pos = 0;
  for (let k = 0; k < n; k++) {
    const i = texte.indexOf(ancien, pos);
    if (i < 0) break;
    sortie += texte.slice(pos, i) + nouveau;
    pos = i + ancien.length;
  }
  return sortie + texte.slice(pos);
}

function compterNl(texte: string, fin: number): number {
  let n = 0;
  for (let i = texte.indexOf("\n"); i >= 0 && i < fin; i = texte.indexOf("\n", i + 1)) n++;
  return n;
}

const BLANCS_PY = new RegExp(`${BLANC_PY}+`, "gu");

function normCtx(s: string): string {
  return stripPy(s.replace(BLANCS_PY, " "));
}

/** `_find_str_with_context` : positions (unités UTF-16) de `cible` dont les lignes voisines correspondent au contexte. */
export function trouverAvecContexte(
  texte: string,
  cible: string,
  avant: readonly string[],
  apres: readonly string[],
): number[] {
  if (!cible) return [];
  const nAvant = avant.map(normCtx);
  const nApres = apres.map(normCtx);
  if (!nAvant.length && !nApres.length) {
    const offs: number[] = [];
    for (let j = texte.indexOf(cible); j >= 0; j = texte.indexOf(cible, j + Math.max(1, cible.length)))
      offs.push(j);
    return offs;
  }
  const lignes = splitlinesPy(texte);
  const debuts = [0];
  for (const l of splitlinesGarde(texte)) debuts.push((debuts[debuts.length - 1] as number) + l.length);
  const ligneDe = (off: number): number => {
    let [lo, hi] = [0, debuts.length - 1];
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if ((debuts[mid] as number) <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const sortie: number[] = [];
  for (let j = texte.indexOf(cible); j >= 0; j = texte.indexOf(cible, j + Math.max(1, cible.length))) {
    const l0 = ligneDe(j);
    const l1 = cible.length > 0 ? ligneDe(j + cible.length - 1) : l0;
    const okAvant = [...nAvant]
      .reverse()
      .every((v, k) => l0 - 1 - k >= 0 && normCtx(lignes[l0 - 1 - k] as string) === v);
    if (!okAvant) continue;
    const okApres = nApres.every(
      (v, k) => l1 + 1 + k < lignes.length && normCtx(lignes[l1 + 1 + k] as string) === v,
    );
    if (okApres) sortie.push(j);
  }
  return sortie;
}

function indentDe(s: string): string {
  return s.slice(0, s.length - s.replace(/^[ \t]+/u, "").length);
}

/** `_flexible_block_matches` : blocs alignés sur les lignes, tolérant blancs de fin et décalage d'indentation uniforme. */
export function blocsSouples(texte: string, cible: string): [number, number, string, string][] {
  let tl = cible.split("\n");
  if (!tl.some((l) => stripPy(l))) return [];
  const finNl = cible.endsWith("\n");
  if (finNl) tl = tl.slice(0, -1);
  const debuts: number[] = [];
  const corps: string[] = [];
  let pos = 0;
  for (const l of texte.split("\n")) {
    debuts.push(pos);
    corps.push(l);
    pos += l.length + 1;
  }
  const [n, nt] = [corps.length, tl.length];
  if (nt === 0 || nt > n) return [];
  const sortie: [number, number, string, string][] = [];
  let i = 0;
  while (i + nt <= n) {
    let op: string | null = null;
    let prefixe = "";
    let ok = true;
    for (let k = 0; k < nt; k++) {
      const w = rstripPy(corps[i + k] as string);
      const t = rstripPy(tl[k] as string);
      if (w === "" && t === "") continue;
      if (w.replace(/^[ \t]+/u, "") !== t.replace(/^[ \t]+/u, "")) {
        ok = false;
        break;
      }
      const [wi, ti] = [indentDe(w), indentDe(t)];
      let kop: string;
      let kpre: string;
      if (wi === ti) [kop, kpre] = ["", ""];
      else if (wi.endsWith(ti) && wi.length > ti.length)
        [kop, kpre] = ["+", wi.slice(0, wi.length - ti.length)];
      else if (ti.endsWith(wi) && ti.length > wi.length)
        [kop, kpre] = ["-", ti.slice(0, ti.length - wi.length)];
      else {
        ok = false;
        break;
      }
      if (op === null) [op, prefixe] = [kop, kpre];
      else if (op !== kop || prefixe !== kpre) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const derniere = i + nt - 1;
      const fin = finNl
        ? Math.min((debuts[derniere] as number) + (corps[derniere] as string).length + 1, texte.length)
        : (debuts[derniere] as number) + (corps[derniere] as string).length;
      sortie.push([debuts[i] as number, fin, op ?? "", prefixe]);
      i += nt;
    } else i += 1;
  }
  return sortie;
}

/** `_shift_indent` : le décalage détecté appliqué aux lignes non vides de `new_str`. */
export function decalerIndent(s: string, op: string, prefixe: string): string {
  if (!op || !prefixe) return s;
  return s
    .split("\n")
    .map((l) =>
      !stripPy(l) ? l : op === "+" ? prefixe + l : l.startsWith(prefixe) ? l.slice(prefixe.length) : l,
    )
    .join("\n");
}

/** `_nearest_candidate` : fenêtre du fichier la plus proche d'un `old_str` introuvable (vide si aucune). */
export function candidatProche(texte: string, ancien: string): string {
  try {
    const aiguilles = splitlinesPy(ancien)
      .map(stripPy)
      .filter((l) => l)
      .sort((a, b) => longueurPy(b) - longueurPy(a));
    if (!aiguilles.length) return "";
    const lignes = splitlinesPy(texte);
    const meilleur = getCloseMatches(aiguilles[0] as string, lignes.map(stripPy), 1, 0.6);
    if (!meilleur.length) return "";
    const idx = lignes.findIndex((l) => stripPy(l) === meilleur[0]);
    const [lo, hi] = [Math.max(0, idx - 2), Math.min(lignes.length, idx + 3)];
    const fenetre = prefixePy(
      Array.from({ length: hi - lo }, (_, k) => `${lo + k + 1}: ${lignes[lo + k] as string}`).join("\n"),
      400,
    );
    return `\nClosest match in the file (around line ${idx + 1}):\n${fenetre}\nRe-read that region and provide the exact current text.`;
  } catch {
    return "";
  }
}

/** `_resolve_anchor` : (ligne, position) d'insertion ; `occurrence` -1 = la dernière. */
export function resoudreAncre(
  texte: string,
  o: { str?: string; re?: string; pos?: string; occurrence?: number },
): [number, number] {
  let corr: [number, number][];
  if (o.re) {
    let m;
    try {
      verifierRegexSure(o.re);
      m = compilerPy(o.re, RE_MULTILINE);
    } catch (e) {
      if (e instanceof ErreurRe) throw new ErreurEdition(`anchor: bad regex (${e.message})`);
      throw e;
    }
    corr = [...trouverTout(m, texte)].map((x) => [x.debut, x.fin]);
  } else if (o.str) {
    corr = [];
    for (let i = texte.indexOf(o.str); i >= 0; i = texte.indexOf(o.str, i + 1))
      corr.push([i, i + o.str.length]);
  } else throw new ErreurEdition("anchor: provide anchor_str or anchor_re");
  if (!corr.length) throw new ErreurEdition("anchor: not found in file");
  let occ = o.occurrence ?? 1;
  if (occ === -1) occ = corr.length;
  if (occ < 1 || occ > corr.length)
    throw new ErreurEdition(`anchor: occurrence=${occ} out of range (1..${corr.length})`);
  const [debut, fin] = corr[occ - 1] as [number, number];
  const pos = o.pos === "before" ? debut : fin;
  return [compterNl(texte, pos) + 1, pos];
}

const ADRESSEES = ["insert", "delete", "replace", "indent"];

function action(ed: unknown): string {
  if (!estDict(ed)) return "";
  return lowerPy(stripPy(texteOuVide(ed["action"], "strip")));
}

/** `(x or "")` d'une chaîne attendue ; un autre type lève l'AttributeError de la méthode appelée ensuite. */
function texteOuVide(v: unknown, methode = "lower"): string {
  if (v === null || v === undefined || v === "" || v === false || v === 0) return "";
  if (typeof v !== "string")
    throw new ErreurPython("AttributeError", `'${nomType(v)}' object has no attribute '${methode}'`);
  return v;
}

function nomType(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "str";
  return Array.isArray(v) ? "list" : "dict";
}

function entierOu(ed: Dict, cle: string, defaut: number): number {
  return intPy(Object.hasOwn(ed, cle) ? ed[cle] : defaut);
}

/** `_norm_edit_crlf` : champs texte d'une édition de `multi` ramenés en LF. */
export function normEditionCrlf(ed: unknown): unknown {
  if (!estDict(ed)) return ed;
  const sortie: Dict = { ...ed };
  for (const k of ["old_str", "new_str", "content", "replacement", "anchor_str"])
    if (typeof sortie[k] === "string") sortie[k] = (sortie[k] as string).replaceAll("\r\n", "\n");
  for (const k of ["before_context", "after_context"])
    if (Array.isArray(sortie[k]))
      sortie[k] = (sortie[k] as unknown[]).map((x) => strEdit(x).replaceAll("\r\n", "\n"));
  return sortie;
}

function strEdit(x: unknown): string {
  return typeof x === "string" ? x : JSON.stringify(x);
}

/** `_order_multi_edits` : éditions par ligne de bas en haut (sur le fichier lu), puis éditions par contenu dans l'ordre. */
export function ordonnerMulti(edits: readonly unknown[]): [number, unknown][] {
  const parLigne: [number, number, Dict, number, number][] = [];
  const autres: [number, unknown][] = [];
  edits.forEach((ed, i) => {
    const act = estDict(ed) ? action(ed) : "";
    if (!ADRESSEES.includes(act)) {
      autres.push([i, ed]);
      return;
    }
    const d = ed as Dict;
    let s: number;
    try {
      s = entierOu(d, "start_line", act === "insert" ? -1 : 0);
    } catch (e) {
      if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) {
        autres.push([i, ed]);
        return;
      }
      throw e;
    }
    if (act === "insert") {
      const cle = s === -1 ? Infinity : Math.max(s, 0);
      parLigne.push([cle, i, d, cle, cle]);
    } else {
      let e: number;
      try {
        const v = d["end_line"];
        e = intPy(v === undefined || v === null || v === 0 || v === "" || v === false ? s : v);
      } catch (x) {
        if (x instanceof ErreurPython && (x.type === "TypeError" || x.type === "ValueError")) e = s;
        else throw x;
      }
      parLigne.push([s, i, d, s, Math.max(e, s)]);
    }
  });
  const plages = parLigne
    .map(([, i, ed, lo, hi]) => [lo, hi, i, lowerPy(texteOuVide(ed["action"]))] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));
  for (let k = 0; k + 1 < plages.length; k++) {
    const [lo1, hi1, i1, a1] = plages[k] as (typeof plages)[number];
    const [lo2, hi2, i2, a2] = plages[k + 1] as (typeof plages)[number];
    if (a1 === "insert" && a2 === "insert") continue;
    if (a1 === "insert") {
      if (lo2 < lo1 && lo1 <= hi2 && a2 !== "insert")
        throw new ErreurEdition(`edits ${i1} and ${i2} overlap (insert inside a range)`);
      continue;
    }
    if (a2 === "insert") {
      if (lo1 < lo2 && lo2 <= hi1)
        throw new ErreurEdition(`edits ${i1} and ${i2} overlap (insert inside a range)`);
      continue;
    }
    if (lo2 <= hi1)
      throw new ErreurEdition(
        `edits ${i1} and ${i2} overlap (lines ${Math.trunc(lo1)}-${Math.trunc(hi1)} and ${Math.trunc(lo2)}-${Math.trunc(hi2)})`,
      );
  }
  const ins = (ed: Dict): number => (action(ed) === "insert" ? 0 : 1);
  parLigne.sort((a, b) => b[0] - a[0] || ins(b[2]) - ins(a[2]) || b[1] - a[1]);
  return [...parLigne.map(([, i, ed]) => [i, ed] as [number, unknown]), ...autres];
}

function lire(ed: Dict, cle: string, defaut: unknown): unknown {
  return Object.hasOwn(ed, cle) ? ed[cle] : defaut;
}

function texteExige(v: unknown, quoi: string): string {
  if (typeof v === "string") return v;
  throw new ErreurPython("TypeError", `${quoi} must be str, not ${nomType(v)}`);
}

/** `_apply_one_edit` : (nouveau texte, info) ou `ErreurEdition` avec l'indice de correction. */
export function appliquerEdition(ancien: string, edit: Dict): [string, Dict] {
  const act = action(edit);
  if (act === "str_replace") {
    const old = texteExige(lire(edit, "old_str", ""), "old_str");
    const neu = texteExige(lire(edit, "new_str", ""), "new_str");
    const count = intPy(lire(edit, "count", 1));
    if (!old) throw new ErreurEdition("str_replace: old_str required");
    const occ = compter(ancien, old);
    if (occ === 0) {
      const blocs = blocsSouples(ancien, old);
      if (!blocs.length)
        throw new ErreurEdition(
          "str_replace: old_str not found — check whitespace, indentation, line endings" +
            candidatProche(ancien, old),
        );
      if (count !== -1 && count !== blocs.length)
        throw new ErreurEdition(
          `str_replace: expected ${count} occurrences, found ${blocs.length} (via whitespace-tolerant match) — expand old_str or use count=-1`,
        );
      let sortie = "";
      let cur = 0;
      for (const [s, e, op, pre] of blocs) {
        sortie += ancien.slice(cur, s) + decalerIndent(neu, op, pre);
        cur = e;
      }
      sortie += ancien.slice(cur);
      const mode = blocs.some(([, , op]) => op) ? "indent_shift" : "trailing_ws";
      return [
        sortie,
        {
          action: "str_replace",
          replacements: blocs.length,
          matched: mode,
          note:
            "Non-literal match: old_str differed by " +
            (mode === "indent_shift"
              ? "a uniform indentation shift (new_str was re-indented to follow the file)"
              : "trailing whitespace") +
            ". Check the diff.",
        },
      ];
    }
    if (count === -1) return [ancien.split(old).join(neu), { action: "str_replace", replacements: occ }];
    if (occ !== count) {
      const detail = occurrencesDe(ancien, positions(ancien, old));
      throw new ErreurEdition(
        `str_replace: expected ${count} occurrences, found ${occ} (${lignesMessage({ ...detail, total: occ })}) — expand old_str for uniqueness or use count=-1`,
        { ...detail, total: occ },
      );
    }
    return [remplacerN(ancien, old, neu, count), { action: "str_replace", replacements: count }];
  }
  if (act === "str_replace_ctx") {
    const old = texteExige(lire(edit, "old_str", ""), "old_str");
    const neu = texteExige(lire(edit, "new_str", ""), "new_str");
    const avant = (lire(edit, "before_context", []) || []) as string[];
    const apres = (lire(edit, "after_context", []) || []) as string[];
    if (!old) throw new ErreurEdition("str_replace_ctx: old_str required");
    if (!avant.length && !apres.length)
      throw new ErreurEdition(
        "str_replace_ctx: provide at least one of before_context or after_context (otherwise just use str_replace)",
      );
    const offs = trouverAvecContexte(ancien, old, avant, apres);
    if (offs.length === 0)
      throw new ErreurEdition(
        `str_replace_ctx: no match with provided context (target alone has ${compter(ancien, old)} occurrence(s) — verify before_context/after_context lines exactly)`,
      );
    if (offs.length > 1)
      throw new ErreurEdition(
        `str_replace_ctx: still ambiguous — ${offs.length} matches at lines [${offs.map((o) => compterNl(ancien, o) + 1).join(", ")}]. Add more context lines to disambiguate.`,
        occurrencesDe(ancien, offs),
      );
    const off = offs[0] as number;
    return [
      ancien.slice(0, off) + neu + ancien.slice(off + old.length),
      {
        action: "str_replace_ctx",
        replacements: 1,
        match_offset: longueurPy(ancien.slice(0, off)),
        match_line: compterNl(ancien, off) + 1,
      },
    ];
  }
  if (act === "regex") {
    const motif = texteExige(lire(edit, "pattern", ""), "pattern");
    const repl = texteExige(lire(edit, "replacement", ""), "replacement");
    let count = intPy(lire(edit, "count", 0));
    if (count < 0) count = 0;
    const drapeaux = lowerPy(texteOuVide(edit["flags"]));
    if (!motif) throw new ErreurEdition("regex: pattern required");
    let fl = 0;
    if (drapeaux.includes("i")) fl |= RE_IGNORECASE;
    if (drapeaux.includes("m")) fl |= RE_MULTILINE;
    if (drapeaux.includes("s")) fl |= RE_DOTALL;
    let m;
    try {
      verifierRegexSure(motif);
      m = compilerPy(motif, fl);
    } catch (e) {
      if (e instanceof ErreurRe) throw new ErreurEdition(`regex: bad pattern (${e.message})`);
      throw e;
    }
    const [sortie, n] = subn(m, repl, ancien, count);
    if (n === 0) throw new ErreurEdition("regex: pattern matched 0 times — check pattern or flags");
    return [sortie, { action: "regex", replacements: n }];
  }
  if (act === "insert") {
    let contenu = texteExige(lire(edit, "content", lire(edit, "new_str", "")), "content");
    if (contenu === "") throw new ErreurEdition("insert: content required");
    if (!contenu.endsWith("\n")) contenu += "\n";
    const debut = intPy(lire(edit, "start_line", -1));
    const lignes = splitlinesGarde(ancien);
    if (debut === -1) {
      if (lignes.length && !(lignes[lignes.length - 1] as string).endsWith("\n"))
        lignes[lignes.length - 1] += "\n";
      lignes.push(contenu);
    } else if (debut === 0) lignes.unshift(contenu);
    else {
      if (debut < 1)
        throw new ErreurEdition("insert: start_line must be 0 (prepend), -1 (append), or 1-based");
      const idx = Math.min(debut - 1, lignes.length);
      if (idx === lignes.length && lignes.length && !(lignes[lignes.length - 1] as string).endsWith("\n"))
        lignes[lignes.length - 1] += "\n";
      lignes.splice(idx, 0, contenu);
    }
    return [lignes.join(""), { action: "insert", at: debut }];
  }
  if (act === "delete" || act === "replace" || act === "indent") {
    const debut = intPy(lire(edit, "start_line", 0));
    const v = lire(edit, "end_line", 0);
    const fin = intPy(v === null || v === 0 || v === "" || v === false ? debut : v);
    if (act === "indent") {
      const delta = intPy(lire(edit, "indent_delta", 0));
      if (debut < 1) throw new ErreurEdition("indent: start_line required (1-based)");
      if (delta === 0) return [ancien, { action: "indent", lines_changed: 0, delta: 0 }];
      return indenter(ancien, debut, fin, delta);
    }
    if (debut < 1)
      throw new ErreurEdition(
        act === "delete" ? "delete: start_line required (1-based)" : "replace: start_line required",
      );
    const lignes = splitlinesGarde(ancien);
    const total = lignes.length;
    const s = debut - 1;
    if (s >= total) throw new ErreurEdition(`${act}: start_line ${debut} > total ${total}`);
    const e = Math.min(fin, total);
    if (act === "delete") {
      const retirees = e - s;
      lignes.splice(s, Math.max(0, e - s));
      return [lignes.join(""), { action: "delete", lines_removed: retirees }];
    }
    const contenu = texteExige(lire(edit, "content", lire(edit, "new_str", "")), "content");
    const morceau = contenu.endsWith("\n") ? contenu : contenu + "\n";
    lignes.splice(s, Math.max(0, e - s), ...(contenu ? [morceau] : []));
    return [lignes.join(""), { action: "replace", lines_replaced: e - s }];
  }
  if (act === "anchor") {
    const ancreStr = texteExige(lire(edit, "anchor_str", ""), "anchor_str");
    const ancreRe = texteExige(lire(edit, "anchor_re", ""), "anchor_re");
    const position = lowerPy(texteOuVide(edit["position"]) || "after");
    const occurrence = intPy(lire(edit, "occurrence", 1));
    let contenu = texteExige(lire(edit, "content", lire(edit, "new_str", "")), "content");
    if (position !== "before" && position !== "after")
      throw new ErreurEdition("anchor: position must be 'before' or 'after'");
    if (!contenu) throw new ErreurEdition("anchor: content required");
    const [ligne, pos0] = resoudreAncre(ancien, { str: ancreStr, re: ancreRe, pos: position, occurrence });
    let pos = pos0;
    if (position === "after" && !(pos > 0 && ancien[pos - 1] === "\n")) {
      const nl = ancien.indexOf("\n", pos);
      pos = nl >= 0 ? nl + 1 : ancien.length;
    } else {
      const prec = pos > 0 ? ancien.lastIndexOf("\n", pos - 1) : -1;
      pos = prec >= 0 ? prec + 1 : 0;
    }
    if (!contenu.endsWith("\n")) contenu += "\n";
    return [
      ancien.slice(0, pos) + contenu + ancien.slice(pos),
      { action: "anchor", position, anchor_line: ligne, occurrence },
    ];
  }
  throw new ErreurEdition(
    `unknown action '${act}' — use str_replace|regex|insert|delete|replace|anchor|indent`,
  );
}

function indenter(ancien: string, debut: number, fin: number, delta: number): [string, Dict] {
  const lignes = splitlinesGarde(ancien);
  const total = lignes.length;
  const s = debut - 1;
  if (s >= total) throw new ErreurEdition(`indent: start_line ${debut} > total ${total}`);
  const e = Math.min(fin, total);
  if (delta > 0) {
    const pad = " ".repeat(delta);
    for (let i = s; i < e; i++) if (stripPy(lignes[i] as string)) lignes[i] = pad + (lignes[i] as string);
  } else {
    const besoin = -delta;
    for (let i = s; i < e; i++) {
      const l = lignes[i] as string;
      if (!stripPy(l)) continue;
      const tete = l.length - l.replace(/^ +/u, "").length;
      if (tete < besoin)
        throw new ErreurEdition(
          `indent: line ${i + 1} has ${tete} leading spaces, can't dedent by ${besoin} (would corrupt structure)`,
        );
    }
    for (let i = s; i < e; i++) {
      const l = lignes[i] as string;
      if (stripPy(l)) lignes[i] = l.slice(besoin);
    }
  }
  return [lignes.join(""), { action: "indent", lines_changed: e - s, delta }];
}
