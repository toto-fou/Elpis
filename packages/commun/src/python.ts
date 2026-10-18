// SPDX-License-Identifier: MIT
/** packages/commun/src/python.ts — int(), float(), bool(), str(), repr(), strip(), max() et min() de Python sur des valeurs JSON. */
import { FlottantPy, pyJsonDumps, reprFlottant } from "./json";
import { clesOrdonnees } from "./ordre";

export type TypeErreurPython = "TypeError" | "ValueError" | "OverflowError" | "AttributeError" | "IndexError";

/** Exception levée là où Python lève : `type` porte le nom de la classe Python. */
export class ErreurPython extends Error {
  readonly type: TypeErreurPython;

  constructor(type: TypeErreurPython, message: string) {
    super(message);
    this.name = type;
    this.type = type;
  }
}

/** `str.isspace()` (Unicode 15) : U+001C à U+001F et U+0085 compris, U+FEFF exclu. */
export function estBlancPy(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

export function stripPy(s: string): string {
  let debut = 0;
  let fin = s.length;
  while (debut < fin && estBlancPy(s.charCodeAt(debut))) debut++;
  while (fin > debut && estBlancPy(s.charCodeAt(fin - 1))) fin--;
  return s.slice(debut, fin);
}

/** `str.isspace()` en classe de regex (le `\s` de `re`, qui n'est pas celui de JS). */
export const BLANC_PY =
  "[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const UN_BLANC = new RegExp(`^${BLANC_PY}$`);
const BLANCS = new RegExp(`${BLANC_PY}+`);

function estBlanc(c: string): boolean {
  return UN_BLANC.test(c);
}

export function lstripPy(s: string): string {
  let debut = 0;
  while (debut < s.length && estBlanc(s.charAt(debut))) debut++;
  return s.slice(debut);
}

/** `s.rstrip()` ou `s.rstrip(caracteres)`. */
export function rstripPy(s: string, caracteres?: string): string {
  let fin = s.length;
  const retirer = (c: string): boolean => (caracteres === undefined ? estBlanc(c) : caracteres.includes(c));
  while (fin > 0 && retirer(s.charAt(fin - 1))) fin--;
  return s.slice(0, fin);
}

/** `s.split(sep, maxsplit)` : sans séparateur, morceaux non vides entre blancs Unicode ; séparateur vide → ValueError. */
export function splitPy(s: string, sep: string | null = null, maxsplit = -1): string[] {
  if (sep === "") throw new ErreurPython("ValueError", "empty separator");
  if (sep !== null) {
    const morceaux: string[] = [];
    let reste = s;
    for (
      let i = reste.indexOf(sep);
      i >= 0 && (maxsplit < 0 || morceaux.length < maxsplit);
      i = reste.indexOf(sep)
    ) {
      morceaux.push(reste.slice(0, i));
      reste = reste.slice(i + sep.length);
    }
    return [...morceaux, reste];
  }
  if (maxsplit < 0) return s.split(BLANCS).filter((m) => m !== "");
  const morceaux: string[] = [];
  let reste = lstripPy(s);
  while (reste !== "" && morceaux.length < maxsplit) {
    const m = BLANCS.exec(reste);
    if (m === null) break;
    morceaux.push(reste.slice(0, m.index));
    reste = lstripPy(reste.slice(m.index));
  }
  return reste === "" ? morceaux : [...morceaux, reste];
}

const DEMI_PAIRES = /[\ud800-\udfff]/;

/** `len(s)` : points de code, pas unités UTF-16. */
export function longueurPy(s: string): number {
  if (!DEMI_PAIRES.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** `s[:n]` en points de code. */
export function prefixePy(s: string, n: number): string {
  if (n < 0) return Array.from(s).slice(0, n).join("");
  if (!DEMI_PAIRES.test(s.slice(0, n))) return s.slice(0, n);
  let fin = 0;
  let compte = 0;
  for (const c of s) {
    if (compte === n) break;
    fin += c.length;
    compte++;
  }
  return s.slice(0, fin);
}

const FINS_DE_LIGNE: ReadonlySet<number> = new Set([
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

/** `s.splitlines()` : toutes les fins de ligne de Python (`\r\n` compte pour une), sans ligne vide finale. */
export function splitlinesPy(s: string): string[] {
  const lignes: string[] = [];
  let debut = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (!FINS_DE_LIGNE.has(code)) continue;
    lignes.push(s.slice(debut, i));
    if (code === 0x0d && s.charCodeAt(i + 1) === 0x0a) i++;
    debut = i + 1;
  }
  if (debut < s.length) lignes.push(s.slice(debut));
  return lignes;
}

type Plages = readonly (readonly [number, number])[];

function plages(table: string): Plages {
  return table.split(" ").map((p) => {
    const [debut = "", fin = debut] = p.split("-");
    return [Number.parseInt(debut, 16), Number.parseInt(fin, 16)] as const;
  });
}

/** Début de la plage de `table` qui contient `code`, ou `null`. */
function debutDePlage(table: Plages, code: number): number | null {
  let bas = 0;
  let haut = table.length - 1;
  while (bas <= haut) {
    const milieu = (bas + haut) >> 1;
    const [debut, fin] = table[milieu] ?? [0, -1];
    if (code < debut) haut = milieu - 1;
    else if (code > fin) bas = milieu + 1;
    else return debut;
  }
  return null;
}

function dans(table: Plages, code: number): boolean {
  return debutDePlage(table, code) !== null;
}

/** `str.isdecimal()` d'Unicode 15.1 (Python 3.13), généré par unicodedata : seuls chiffres de `int()` et `float()`. */
const DECIMAUX_15 = plages(
  "30-39 660-669 6f0-6f9 7c0-7c9 966-96f 9e6-9ef a66-a6f ae6-aef b66-b6f be6-bef c66-c6f ce6-cef d66-d6f " +
    "de6-def e50-e59 ed0-ed9 f20-f29 1040-1049 1090-1099 17e0-17e9 1810-1819 1946-194f 19d0-19d9 1a80-1a89 " +
    "1a90-1a99 1b50-1b59 1bb0-1bb9 1c40-1c49 1c50-1c59 a620-a629 a8d0-a8d9 a900-a909 a9d0-a9d9 a9f0-a9f9 " +
    "aa50-aa59 abf0-abf9 ff10-ff19 104a0-104a9 10d30-10d39 11066-1106f 110f0-110f9 11136-1113f 111d0-111d9 " +
    "112f0-112f9 11450-11459 114d0-114d9 11650-11659 116c0-116c9 11730-11739 118e0-118e9 11950-11959 " +
    "11c50-11c59 11d50-11d59 11da0-11da9 11f50-11f59 16a60-16a69 16ac0-16ac9 16b50-16b59 1d7ce-1d7ff " +
    "1e140-1e149 1e2f0-1e2f9 1e4f0-1e4f9 1e950-1e959 1fbf0-1fbf9",
);

/** Chiffres non décimaux de `str.isdigit()` d'Unicode 15.1 (exposants, cerclés…). */
const AUTRES_CHIFFRES_15 = plages(
  "b2-b3 b9 1369-1371 19da 2070 2074-2079 2080-2089 2460-2468 2474-247c 2488-2490 24ea 24f5-24fd 24ff " +
    "2776-277e 2780-2788 278a-2792 10a40-10a43 10e60-10e68 11052-1105a 1f100-1f10a",
);

/** Majuscules dont la minuscule est postérieure à Unicode 15.1 : `str.lower()` de Python 3.13 les laisse telles quelles. */
const CASSES_POSTERIEURES_15 = plages("1c89 a7cb-a7cc a7ce a7d2 a7d4 a7da a7dc 10d50-10d65 16ea0-16eb8");
/** Lettres et chiffres de `\\p{L}\\p{N}` (Node 24, Unicode 17) absents d'Unicode 15.1 (Python 3.13), calculés point par point. */
const ALNUM_POSTERIEURS_15 = plages(
  "88f c5c cdc 1c89-1c8a a7cb-a7cf a7d2 a7d4 a7da-a7dc a7f1 105c0-105f3 10940-10959 10d40-10d65 " +
    "10d6f-10d85 10ec2-10ec7 11380-11389 1138b 1138e 11390-113b5 113b7 113d1 113d3 116d0-116e3 " +
    "11bc0-11be0 11bf0-11bf9 11db0-11ddb 11de0-11de9 13460-143fa 16100-1611d 16130-16139 16d40-16d6c " +
    "16d70-16d79 16ea0-16eb8 16ebb-16ed3 16ff2-16ff6 187f8-187ff 18cff 18d09-18d1e 18d80-18df2 " +
    "1ccf0-1ccf9 1e5d0-1e5ed 1e5f0-1e5fa 1e6c0-1e6de 1e6e0-1e6e2 1e6e4-1e6e5 1e6e7-1e6ed 1e6f0-1e6f4 " +
    "1e6fe-1e6ff 2b73a-2b73f 2cea2-2cead 323b0-33479",
);
const ALNUM_JS = /^[\p{L}\p{N}]$/u;

/** `c.isalnum()` d'un point de code en Unicode 15.1 : celui de Python 3.13 et du `\\w` de `re` (avec `_`). */
export function estAlnumPy(c: string): boolean {
  return ALNUM_JS.test(c) && !dans(ALNUM_POSTERIEURS_15, c.codePointAt(0) ?? 0);
}

/** `str.isdigit()` de Python 3.13, indépendant de la version d'Unicode de Node. */
export function estChiffresPy(s: string): boolean {
  if (s === "") return false;
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    if (!dans(DECIMAUX_15, code) && !dans(AUTRES_CHIFFRES_15, code)) return false;
  }
  return true;
}

/** `str.lower()` de Python 3.13 : `toLowerCase()` sauf les casses ajoutées à Unicode depuis la 15.1. */
export function lowerPy(s: string): string {
  let sortie = "";
  let debut = 0;
  let i = 0;
  for (const c of s) {
    if (dans(CASSES_POSTERIEURES_15, c.codePointAt(0) ?? 0)) {
      sortie += s.slice(debut, i).toLowerCase() + c;
      debut = i + c.length;
    }
    i += c.length;
  }
  return sortie + s.slice(debut).toLowerCase();
}

/** `s[-n:]` en points de code (`n` nul : tout le texte, comme `s[-0:]`). */
export function suffixePy(s: string, n: number): string {
  if (n <= 0) return n === 0 ? s : Array.from(s).slice(-n).join("");
  let debut = s.length;
  for (let compte = 0; compte < n && debut > 0; compte++) {
    const c = s.charCodeAt(debut - 1);
    debut -=
      c >= 0xdc00 && c <= 0xdfff && debut >= 2 && (s.charCodeAt(debut - 2) & 0xfc00) === 0xd800 ? 2 : 1;
  }
  return s.slice(debut);
}

function indexEnPoints(s: string, unites: number): number {
  return unites < 0 ? -1 : longueurPy(s.slice(0, unites));
}

/** `s.find(sous)` : index en points de code, -1 si absente. */
export function findPy(s: string, sous: string): number {
  return indexEnPoints(s, s.indexOf(sous));
}

/** `s.rfind(sous)` : dernier index en points de code, -1 si absente. */
export function rfindPy(s: string, sous: string): number {
  return indexEnPoints(s, s.lastIndexOf(sous));
}

/** `isinstance(v, int)` : booléen, entier JS ou bigint ; un `FlottantPy` est un float. */
export function estEntierPy(v: unknown): boolean {
  return typeof v === "boolean" || typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v));
}

/** `v not in (None, "", [], {})` en égalité de valeur Python : 0 et False restent non vides. */
export function nonVidePy(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object" && !(v instanceof FlottantPy)) {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) return Object.keys(v).length > 0;
  }
  return true;
}

/** Vérité de Python : `None`, `False`, 0, `""`, `[]` et `{}` sont faux ; NaN est vrai. */
export function veritePy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v instanceof FlottantPy) return v.valeur !== 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** `max(a, b, …)` : garde le premier sauf si un suivant est strictement plus grand (NaN ne gagne jamais après coup). */
export function maxPy(premier: number, ...autres: number[]): number {
  let resultat = premier;
  for (const x of autres) if (x > resultat) resultat = x;
  return resultat;
}

export function minPy(premier: number, ...autres: number[]): number {
  let resultat = premier;
  for (const x of autres) if (x < resultat) resultat = x;
  return resultat;
}

function nomTypePy(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") return "dict";
  return typeof v;
}

/** `_PyUnicode_TransformDecimalAndSpaceToASCII` : blancs et chiffres d'Unicode 15.1 en ASCII, `null` si un autre non-ASCII. */
function versAscii(s: string): string | null {
  let sortie = "";
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    const zero = code < 127 || estBlancPy(code) ? null : debutDePlage(DECIMAUX_15, code);
    if (code < 127) sortie += c;
    else if (estBlancPy(code)) sortie += " ";
    else if (zero !== null) sortie += String((code - zero) % 10);
    else return null;
  }
  return sortie;
}

const ENTIER_TEXTE = /^[ \t\n\v\f\r]*([+-]?)(\d(?:_?\d)*)[ \t\n\v\f\r]*$/;
const MAX_CHIFFRES_INT = 4300;

/** `int(texte)` en base 10 ; au-delà de 2^53 la valeur est approchée (pas d'entier exact en JS). */
function entierDepuisTexte(s: string): number {
  const ascii = versAscii(s);
  const m = ascii === null ? null : ENTIER_TEXTE.exec(ascii);
  if (m === null)
    throw new ErreurPython("ValueError", `invalid literal for int() with base 10: ${reprPy(s)}`);
  const chiffres = (m[2] ?? "").replaceAll("_", "");
  if (chiffres.length > MAX_CHIFFRES_INT) {
    throw new ErreurPython("ValueError", "Exceeds the limit (4300 digits) for integer string conversion");
  }
  return Number(`${m[1] ?? ""}${chiffres}`) + 0;
}

export function intPy(v: unknown): number {
  if (v instanceof FlottantPy) return intPy(v.valeur);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (Number.isNaN(v)) throw new ErreurPython("ValueError", "cannot convert float NaN to integer");
    if (!Number.isFinite(v))
      throw new ErreurPython("OverflowError", "cannot convert float infinity to integer");
    return Math.trunc(v) + 0;
  }
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return entierDepuisTexte(v);
  throw new ErreurPython(
    "TypeError",
    `int() argument must be a string, a bytes-like object or a real number, not '${nomTypePy(v)}'`,
  );
}

const SOULIGNE_MAL_PLACE = /(?:^|[^0-9])_|_(?:[^0-9]|$)/;
const FLOTTANT_SPECIAL = /^[+-]?(?:inf|infinity|nan)$/i;
const FLOTTANT_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const BLANCS_ASCII = " \t\n\v\f\r";

function sansBlancsAscii(s: string): string {
  let debut = 0;
  let fin = s.length;
  while (debut < fin && BLANCS_ASCII.includes(s.charAt(debut))) debut++;
  while (fin > debut && BLANCS_ASCII.includes(s.charAt(fin - 1))) fin--;
  return s.slice(debut, fin);
}

function flottantDepuisTexte(s: string): number {
  const ascii = versAscii(s);
  const echec = (): never => {
    throw new ErreurPython("ValueError", `could not convert string to float: ${reprPy(s)}`);
  };
  if (ascii === null || SOULIGNE_MAL_PLACE.test(ascii)) return echec();
  const texte = sansBlancsAscii(ascii.replaceAll("_", ""));
  if (FLOTTANT_SPECIAL.test(texte)) {
    if (/nan$/i.test(texte)) return Number.NaN;
    return texte.startsWith("-") ? -Infinity : Infinity;
  }
  return FLOTTANT_DECIMAL.test(texte) ? Number(texte) : echec();
}

export function floatPy(v: unknown): number {
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return flottantDepuisTexte(v);
  throw new ErreurPython(
    "TypeError",
    `float() argument must be a string or a real number, not '${nomTypePy(v)}'`,
  );
}

const NON_IMPRIMABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hexPy(code: number, largeur: number): string {
  return code.toString(16).padStart(largeur, "0");
}

/** `repr(str)` : guillemet simple sauf s'il n'y a que des simples, non-imprimables en `\xNN`/`\uNNNN`/`\UNNNNNNNN`. */
function reprChaine(s: string): string {
  const guillemet = s.includes("'") && !s.includes('"') ? '"' : "'";
  let sortie = guillemet;
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    if (c === guillemet || c === "\\") sortie += `\\${c}`;
    else if (c === "\t") sortie += "\\t";
    else if (c === "\n") sortie += "\\n";
    else if (c === "\r") sortie += "\\r";
    else if (code < 0x20 || code === 0x7f) sortie += `\\x${hexPy(code, 2)}`;
    else if (code < 0x7f || !NON_IMPRIMABLE.test(c)) sortie += c;
    else if (code <= 0xff) sortie += `\\x${hexPy(code, 2)}`;
    else if (code <= 0xffff) sortie += `\\u${hexPy(code, 4)}`;
    else sortie += `\\U${hexPy(code, 8)}`;
  }
  return sortie + guillemet;
}

/** Un flottant entier (`8080.0`) s'écrit comme un entier : JSON.parse ne distingue pas `1.0` de `1`. */
function reprNombre(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  return pyJsonDumps(x);
}

export function reprPy(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v instanceof FlottantPy)
    return Number.isFinite(v.valeur) ? reprFlottant(v.valeur) : reprNombre(v.valeur);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return reprNombre(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return reprChaine(v);
  if (Array.isArray(v)) return `[${v.map(reprPy).join(", ")}]`;
  if (typeof v === "object") {
    const d = v as Record<string, unknown>;
    const paires = clesOrdonnees(d).map((cle) => `${reprChaine(cle)}: ${reprPy(d[cle])}`);
    return `{${paires.join(", ")}}`;
  }
  return String(v);
}

export function strPy(v: unknown): string {
  return typeof v === "string" ? v : reprPy(v);
}

const decodeurStrict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `octets.decode()` strict ; `undefined` si l'UTF-8 est invalide. */
export function texteUtf8(octets: Uint8Array): string | undefined {
  try {
    return decodeurStrict.decode(octets);
  } catch {
    return undefined;
  }
}

export function estErreurPython(e: unknown, ...types: TypeErreurPython[]): e is ErreurPython {
  return e instanceof ErreurPython && types.includes(e.type);
}

/** `str.encode("utf-8")` : une demi-paire isolée lève (UnicodeEncodeError) au lieu de devenir U+FFFD. */
export function encoderUtf8Py(s: string): Buffer {
  if (!s.isWellFormed()) {
    throw new ErreurPython("ValueError", "'utf-8' codec can't encode character: surrogates not allowed");
  }
  return Buffer.from(s, "utf8");
}

/** `str.encode("utf-8", "replace")` : une demi-paire isolée devient `?`. */
export function utf8Remplace(s: string): Buffer {
  return Buffer.from(s.replace(/\p{Cs}/gu, "?"), "utf-8");
}

/** `int(v)`, `null` sur TypeError ou ValueError (OverflowError lève). */
export function entierOuNulPy(v: unknown): number | null {
  try {
    return intPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError")) return null;
    throw e;
  }
}
