// SPDX-License-Identifier: MIT
/** packages/http/src/pydantic.ts — schémas au comportement de Pydantic 2.13 (mode lax, `validate_python(from_attributes=True)`) : sorties et erreurs. */
import { clesOrdonnees, estCleEntiere, noterOrdreDesCles, objetNu, texteUtf8 } from "@elpis/commun";

import { ErreurValidation, HttpError } from "./erreurs";
import type { Emplacement } from "./erreurs";

export { clesOrdonnees, estCleEntiere, noterOrdreDesCles, objetNu, texteUtf8 };

type Loc = (string | number)[];

export interface ErreurPy {
  type: string;
  loc: Loc;
  msg: string;
  input: unknown;
  ctx?: Record<string, unknown>;
}

const ECHEC: unique symbol = Symbol("échec");
type Echec = typeof ECHEC;

/** Erreurs de la validation en cours ; `horsBornes` : un entier valide pour Pydantic mais hors de la plage sûre de JS. */
interface Etat {
  erreurs: ErreurPy[];
  horsBornes: boolean;
}

type Verifier<T> = (entree: unknown, loc: Loc, etat: Etat) => T | Echec;

interface OptionsSchema {
  readonly alias?: string;
  readonly defaut?: () => unknown;
  readonly sequence?: boolean;
}

export class SchemaPy<T> {
  readonly verifier: Verifier<T>;
  readonly options: OptionsSchema;

  constructor(verifier: Verifier<T>, options: OptionsSchema = {}) {
    this.verifier = verifier;
    this.options = options;
  }

  /** Défaut d'un champ absent, jamais validé (comme Pydantic) : `structuredClone` ici lève tout de suite s'il n'est pas clonable. */
  defaut<D>(valeur: D): SchemaPy<T | D> {
    const modele = structuredClone(valeur);
    return new SchemaPy<T | D>(this.verifier, { ...this.options, defaut: () => copier(modele) });
  }

  fabrique<D>(fabrique: () => D): SchemaPy<T | D> {
    return new SchemaPy<T | D>(this.verifier, { ...this.options, defaut: fabrique });
  }

  alias(nom: string): SchemaPy<T> {
    return new SchemaPy<T>(this.verifier, { ...this.options, alias: nom });
  }
}

export type Sortie<S> = S extends SchemaPy<infer T> ? T : never;
export type Champs = Readonly<Record<string, SchemaPy<unknown>>>;
export type SortieChamps<C extends Champs> = { -readonly [K in keyof C]: Sortie<C[K]> };

export interface ContraintesNombre {
  gt?: number;
  ge?: number;
  lt?: number;
  le?: number;
  multiple_of?: number;
}

export interface ContraintesFlottant extends ContraintesNombre {
  allow_inf_nan?: boolean;
}

export interface ContraintesTaille {
  min_length?: number;
  max_length?: number;
}

type Litteral = string | number | boolean | null;

const MESSAGES: Readonly<Record<string, string>> = {
  missing: "Field required",
  int_type: "Input should be a valid integer",
  int_parsing: "Input should be a valid integer, unable to parse string as an integer",
  int_parsing_size: "Unable to parse input string as an integer, exceeded maximum size",
  int_from_float: "Input should be a valid integer, got a number with a fractional part",
  finite_number: "Input should be a finite number",
  float_type: "Input should be a valid number",
  float_parsing: "Input should be a valid number, unable to parse string as a number",
  bool_type: "Input should be a valid boolean",
  bool_parsing: "Input should be a valid boolean, unable to interpret input",
  string_type: "Input should be a valid string",
  string_unicode: "Input should be a valid string, unable to parse raw data as a unicode string",
  list_type: "Input should be a valid list",
  dict_type: "Input should be a valid dictionary",
  model_attributes_type: "Input should be a valid dictionary or object to extract fields from",
  extra_forbidden: "Extra inputs are not permitted",
};

function echec(
  etat: Etat,
  type: string,
  loc: Loc,
  input: unknown,
  ctx?: Record<string, unknown>,
  msg = MESSAGES[type] ?? type,
): Echec {
  etat.erreurs.push(
    ctx === undefined ? { type, loc: [...loc], msg, input } : { type, loc: [...loc], msg, input, ctx },
  );
  return ECHEC;
}

function copier<V>(valeur: V): V {
  return valeur !== null && typeof valeur === "object" ? structuredClone(valeur) : valeur;
}

const pluriel = (n: number): string => (n === 1 ? "" : "s");

/** `Display` de Rust pour une borne : chiffres les plus courts, jamais d'exposant (`1.0` → `1`, `1e-7` → `0.0000001`). */
function nombreRust(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  const signe = n < 0 || Object.is(n, -0) ? "-" : "";
  if (!Number.isFinite(n)) return `${signe}inf`;
  const [mantisse = "0", exposant = "0"] = Math.abs(n).toExponential().split("e");
  const chiffres = mantisse.replace(".", "");
  const virgule = Number(exposant) + 1;
  if (virgule <= 0) return `${signe}0.${"0".repeat(-virgule)}${chiffres}`;
  if (virgule >= chiffres.length) return signe + chiffres + "0".repeat(virgule - chiffres.length);
  return `${signe}${chiffres.slice(0, virgule)}.${chiffres.slice(virgule)}`;
}

const estOctets = (v: unknown): v is Uint8Array => v instanceof Uint8Array;

/** Un `dict` Python : objet ordinaire ou sans prototype, ni tableau, ni octets. */
function estDict(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Uint8Array) return false;
  const prototype: unknown = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
}

/** Clé d'un `loc` : une demi-paire passe par `to_string_lossy` de PyO3 (UTF-8 `surrogatepass` puis 3 × U+FFFD). */
function cleLoc(cle: string): string {
  if (cle.isWellFormed()) return cle;
  let sortie = "";
  for (const c of cle)
    sortie +=
      c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff ? "\ufffd\ufffd\ufffd" : c;
  return sortie;
}

/** Propriété `White_Space` (celle de `str::trim` en Rust) : tous ces caractères sont dans le plan de base. */
const espaceRust = (c: number): boolean =>
  (c >= 0x09 && c <= 0x0d) ||
  c === 0x20 ||
  c === 0x85 ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000;

function rognerRust(s: string): string {
  let debut = 0;
  let fin = s.length;
  while (debut < fin && espaceRust(s.charCodeAt(debut))) debut++;
  while (fin > debut && espaceRust(s.charCodeAt(fin - 1))) fin--;
  return s.slice(debut, fin);
}

const PAIRE = /[\ud800-\udbff][\udc00-\udfff]/g;

/** `len()` de Python : une paire UTF-16 compte pour un point de code (une passe ; sans paire, rien d'autre à faire). */
function pointsDeCode(s: string): number {
  let n = s.length;
  PAIRE.lastIndex = 0;
  while (PAIRE.exec(s) !== null) n--;
  return n;
}

/** Texte d'une entrée chaîne ou octets (`maybe_as_string`) ; `null` si l'entrée n'est ni l'un ni l'autre. */
function texteLax(entree: unknown, loc: Loc, etat: Etat, typeParsing: string): string | null | Echec {
  if (typeof entree === "string")
    return entree.isWellFormed() ? entree : echec(etat, "string_unicode", loc, entree);
  if (estOctets(entree)) return texteUtf8(entree) ?? echec(etat, typeParsing, loc, entree);
  return null;
}

/** `NumberInt::try_from` de jiter : entier JSON entier (pas de `+`, pas de zéro de tête), « plage » au-delà de 4300 caractères. */
function entierJiter(s: string): number | "plage" | undefined {
  const debut = s.startsWith("-") ? 1 : 0;
  const premier = s.charCodeAt(debut);
  if (premier === 0x30) return debut + 1 === s.length ? 0 : undefined;
  if (!(premier >= 0x31 && premier <= 0x39)) return undefined;
  let fin = debut;
  while (fin < s.length && s.charCodeAt(fin) >= 0x30 && s.charCodeAt(fin) <= 0x39) fin++;
  if (fin > 4300) return "plage";
  return fin === s.length ? Number(s) : undefined;
}

/** `strip_leading_zeros` de pydantic-core : zéros et soulignés de tête retirés jusqu'au premier chiffre, `-` ou `.`. */
function sansZerosDeTete(d: string): string | undefined {
  const premier = d.charAt(0);
  if (premier >= "1" && premier <= "9") return d;
  if (premier !== "0") return undefined;
  for (let i = 1; i < d.length; i++) {
    const c = d.charAt(i);
    if (c === "0" || c === "_") continue;
    if ((c >= "1" && c <= "9") || c === "-") return d.slice(i);
    if (c === ".") return d.slice(i - 1);
    return undefined;
  }
  return d.slice(-1);
}

function sansZerosDecimaux(s: string): string | undefined {
  const point = s.indexOf(".");
  return point >= 0 && /^0+$/.test(s.slice(point + 1)) ? s.slice(0, point) : undefined;
}

function sansSoulignes(s: string): string | undefined {
  return s.startsWith("_") || s.endsWith("_") || s.includes("__") ? undefined : s.replace(/_/g, "");
}

/** `str_as_int` : jiter sur le texte brut (seul cas `int_parsing_size`), puis texte rogné, signe, zéros de tête, `.0`, soulignés. */
function entierDuTexte(texte: string): number | "taille" | undefined {
  const brut = entierJiter(texte);
  if (brut === "plage") return "taille";
  if (brut !== undefined) return brut;
  const t = rognerRust(texte);
  const signe = t.startsWith("-") ? "-" : "";
  const chiffres = sansZerosDeTete(t.startsWith("-") || t.startsWith("+") ? t.slice(1) : t);
  if (chiffres === undefined) return undefined;
  const u = signe + chiffres;
  const decimal = sansZerosDecimaux(u);
  for (const essai of [u, decimal, sansSoulignes(decimal ?? u)]) {
    const v = essai === undefined ? undefined : entierJiter(essai);
    if (typeof v === "number") return v === 0 ? 0 : v;
  }
  return undefined;
}

const FLOTTANT_RUST = /^[+-]?(?:inf|infinity|nan|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?)$/i;

function flottantRust(s: string): number | undefined {
  if (!FLOTTANT_RUST.test(s)) return undefined;
  const absolu = s.replace(/^[+-]/, "").toLowerCase();
  if (absolu === "nan") return NaN;
  if (absolu === "inf" || absolu === "infinity") return s.startsWith("-") ? -Infinity : Infinity;
  return Number(s);
}

/** `str_as_float` : texte rogné, sinon soulignés retirés du texte brut (ni en tête, ni en fin, ni doublés). */
function flottantDuTexte(texte: string): number | undefined {
  const direct = flottantRust(rognerRust(texte));
  if (direct !== undefined) return direct;
  if (texte.startsWith("_") || texte.endsWith("_") || texte.includes("__")) return undefined;
  return flottantRust(texte.replace(/_/g, ""));
}

const arrondiRust = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));
const multipleFlottant = (x: number, m: number): boolean => !(Math.abs(x - arrondiRust(x / m) * m) > 1e-9);

/** Contraintes numériques dans l'ordre de pydantic-core : multiple_of, le, lt, ge, gt (une seule erreur ; NaN échoue). */
function bornes(
  n: number,
  c: ContraintesNombre | undefined,
  flottant: boolean,
  entree: unknown,
  loc: Loc,
  etat: Etat,
): number | Echec {
  if (c === undefined) return n;
  const { multiple_of: m, le, lt, ge, gt } = c;
  if (m !== undefined && !(flottant ? multipleFlottant(n, m) : n % m === 0))
    return echec(
      etat,
      "multiple_of",
      loc,
      entree,
      { multiple_of: m },
      `Input should be a multiple of ${nombreRust(m)}`,
    );
  if (le !== undefined && !(n <= le))
    return echec(
      etat,
      "less_than_equal",
      loc,
      entree,
      { le },
      `Input should be less than or equal to ${nombreRust(le)}`,
    );
  if (lt !== undefined && !(n < lt))
    return echec(etat, "less_than", loc, entree, { lt }, `Input should be less than ${nombreRust(lt)}`);
  if (ge !== undefined && !(n >= ge))
    return echec(
      etat,
      "greater_than_equal",
      loc,
      entree,
      { ge },
      `Input should be greater than or equal to ${nombreRust(ge)}`,
    );
  if (gt !== undefined && !(n > gt))
    return echec(etat, "greater_than", loc, entree, { gt }, `Input should be greater than ${nombreRust(gt)}`);
  return n;
}

/** Entier lax ; au-delà de 2^53 il est valide pour Pydantic mais signalé hors bornes (400), après ses bornes s'il vient d'un texte. */
function entier(c?: ContraintesNombre): SchemaPy<number> {
  return new SchemaPy<number>((entree, loc, etat) => {
    let n: number;
    if (typeof entree === "boolean") n = entree ? 1 : 0;
    else if (typeof entree === "number") {
      if (Number.isNaN(entree)) return echec(etat, "finite_number", loc, entree);
      if (Number.isFinite(entree) && !Number.isInteger(entree))
        return echec(etat, "int_from_float", loc, entree);
      n = entree === 0 ? 0 : entree;
    } else {
      const texte = texteLax(entree, loc, etat, "int_parsing");
      if (texte === ECHEC) return ECHEC;
      if (texte === null) return echec(etat, "int_type", loc, entree);
      const lu = entierDuTexte(texte);
      if (lu === "taille") return echec(etat, "int_parsing_size", loc, entree);
      if (lu === undefined) return echec(etat, "int_parsing", loc, entree);
      n = lu;
    }
    if (!Number.isFinite(n) && typeof entree === "number") {
      etat.horsBornes = true;
      return n;
    }
    const exact = Number.isFinite(n) || c === undefined ? c : { ...c, multiple_of: undefined };
    const v = bornes(n, exact, false, entree, loc, etat);
    if (v !== ECHEC && !Number.isSafeInteger(v)) etat.horsBornes = true;
    return v;
  });
}

function flottant(c?: ContraintesFlottant): SchemaPy<number> {
  return new SchemaPy<number>((entree, loc, etat) => {
    let x: number;
    if (typeof entree === "boolean") x = entree ? 1 : 0;
    else if (typeof entree === "number") x = entree;
    else {
      const texte = texteLax(entree, loc, etat, "float_parsing");
      if (texte === ECHEC) return ECHEC;
      if (texte === null) return echec(etat, "float_type", loc, entree);
      const lu = flottantDuTexte(texte);
      if (lu === undefined) return echec(etat, "float_parsing", loc, entree);
      x = lu;
    }
    if (c?.allow_inf_nan === false && !Number.isFinite(x)) return echec(etat, "finite_number", loc, entree);
    return bornes(x, c, true, entree, loc, etat);
  });
}

const VRAI = new Set(["1", "t", "y", "on", "yes", "true"]);
const FAUX = new Set(["0", "f", "n", "no", "off", "false"]);
const asciiMinuscules = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const DEUX_63 = 2 ** 63;

function booleen(): SchemaPy<boolean> {
  return new SchemaPy<boolean>((entree, loc, etat) => {
    if (typeof entree === "boolean") return entree;
    if (typeof entree === "number") {
      if (entree === 1) return true;
      if (entree === 0) return false;
      return Number.isInteger(entree) && entree > -DEUX_63 && entree < DEUX_63
        ? echec(etat, "bool_parsing", loc, entree)
        : echec(etat, "bool_type", loc, entree);
    }
    const texte = texteLax(entree, loc, etat, "bool_parsing");
    if (texte === ECHEC) return ECHEC;
    if (texte === null) return echec(etat, "bool_type", loc, entree);
    const mot = asciiMinuscules(texte);
    if (VRAI.has(mot)) return true;
    if (FAUX.has(mot)) return false;
    return echec(etat, "bool_parsing", loc, entree);
  });
}

/** `str` lax ; sans `pattern` (aucun modèle Python ne s'en sert, et un moteur linéaire serait à écrire). */
function texte(c: ContraintesTaille = {}): SchemaPy<string> {
  const { min_length: min, max_length: max } = c;
  const contraint = min !== undefined || max !== undefined;
  return new SchemaPy<string>((entree, loc, etat) => {
    let s: string;
    if (typeof entree === "string") {
      if (contraint && !entree.isWellFormed()) return echec(etat, "string_unicode", loc, entree);
      s = entree;
    } else if (estOctets(entree)) {
      const lu = texteUtf8(entree);
      if (lu === undefined) return echec(etat, "string_unicode", loc, entree);
      s = lu;
    } else return echec(etat, "string_type", loc, entree);
    if (!contraint) return s;
    const n = pointsDeCode(s);
    if (min !== undefined && n < min)
      return echec(
        etat,
        "string_too_short",
        loc,
        entree,
        { min_length: min },
        `String should have at least ${min} character${pluriel(min)}`,
      );
    if (max !== undefined && n > max)
      return echec(
        etat,
        "string_too_long",
        loc,
        entree,
        { max_length: max },
        `String should have at most ${max} character${pluriel(max)}`,
      );
    return s;
  });
}

const NON_IMPRIMABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** `repr()` d'une chaîne Python : guillemets choisis, échappements des non-imprimables. */
function reprTexte(s: string): string {
  const guillemet = s.includes("'") && !s.includes('"') ? '"' : "'";
  let sortie = guillemet;
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    if (c === "\\" || c === guillemet) sortie += "\\" + c;
    else if (c === "\t") sortie += "\\t";
    else if (c === "\n") sortie += "\\n";
    else if (c === "\r") sortie += "\\r";
    else if (c !== " " && NON_IMPRIMABLE.test(c)) {
      if (code < 0x100) sortie += "\\x" + code.toString(16).padStart(2, "0");
      else if (code < 0x10000) sortie += "\\u" + code.toString(16).padStart(4, "0");
      else sortie += "\\U" + code.toString(16).padStart(8, "0");
    } else sortie += c;
  }
  return sortie + guillemet;
}

function reprLitteral(v: Litteral): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  return reprTexte(v);
}

/** `Literal[...]` : recherche booléen strict, entier exact, chaîne exacte, None, puis égalité Python (`True == 1`). */
function litteral<const V extends readonly Litteral[]>(...valeurs: V): SchemaPy<V[number]> {
  if (valeurs.length === 0) throw new Error("littéral vide");
  const avecBooleens = valeurs.some((v) => typeof v === "boolean");
  if (avecBooleens && valeurs.some((v) => typeof v === "number"))
    throw new Error("littéral mêlant booléens et nombres : 1 et 1.0 sont indiscernables en JS");
  for (const v of valeurs) {
    if (typeof v === "number" && !Number.isSafeInteger(v))
      throw new Error(`littéral numérique non entier : ${v}`);
  }
  const avecTextes = valeurs.some((v) => typeof v === "string");
  const reprs = valeurs.map(reprLitteral);
  const dernier = reprs[reprs.length - 1] ?? "";
  const attendu = reprs.length === 1 ? dernier : `${reprs.slice(0, -1).join(", ")} or ${dernier}`;
  return new SchemaPy<V[number]>((entree, loc, etat) => {
    if (typeof entree === "boolean") {
      const egal = valeurs.find((v) => v === entree || v === (entree ? 1 : 0));
      if (egal !== undefined) return egal;
    } else if (typeof entree === "number") {
      const egal = valeurs.find((v) => v === entree || (typeof v === "boolean" && (v ? 1 : 0) === entree));
      if (egal !== undefined) return egal;
    } else if (typeof entree === "string" && avecTextes) {
      if (!entree.isWellFormed()) return echec(etat, "string_unicode", loc, entree);
      if (valeurs.includes(entree)) return entree as V[number];
    } else if (entree === null && valeurs.includes(null)) return null as V[number];
    return echec(etat, "literal_error", loc, entree, { expected: attendu }, `Input should be ${attendu}`);
  });
}

/** Validation d'un sous-élément dont les erreurs peuvent être écartées (`too_long` d'une liste). */
function sousEtat(): Etat {
  return { erreurs: [], horsBornes: false };
}

function liste<T>(element: SchemaPy<T>, c?: ContraintesTaille): SchemaPy<T[]> {
  return new SchemaPy<T[]>(
    (entree, loc, etat) => {
      if (!Array.isArray(entree)) return echec(etat, "list_type", loc, entree);
      const sortie: T[] = [];
      const local = sousEtat();
      for (let i = 0; i < entree.length; i++) {
        const v = element.verifier(entree[i], [...loc, i], local);
        if (v !== ECHEC) sortie.push(v);
        if (c?.max_length !== undefined && i + 1 > c.max_length) {
          const ctx = { field_type: "List", max_length: c.max_length, actual_length: entree.length };
          const msg = `List should have at most ${c.max_length} item${pluriel(c.max_length)} after validation, not ${entree.length}`;
          return echec(etat, "too_long", loc, entree, ctx, msg);
        }
      }
      etat.horsBornes ||= local.horsBornes;
      if (local.erreurs.length > 0) {
        etat.erreurs.push(...local.erreurs);
        return ECHEC;
      }
      return taille(sortie, sortie.length, "List", c, entree, loc, etat, false);
    },
    { sequence: true },
  );
}

function taille<V>(
  sortie: V,
  n: number,
  genre: string,
  c: ContraintesTaille | undefined,
  entree: unknown,
  loc: Loc,
  etat: Etat,
  verifierMax: boolean,
): V | Echec {
  const min = c?.min_length;
  const max = c?.max_length;
  if (min !== undefined && n < min) {
    const msg = `${genre} should have at least ${min} item${pluriel(min)} after validation, not ${n}`;
    return echec(
      etat,
      "too_short",
      loc,
      entree,
      { field_type: genre, min_length: min, actual_length: n },
      msg,
    );
  }
  if (verifierMax && max !== undefined && n > max) {
    const msg = `${genre} should have at most ${max} item${pluriel(max)} after validation, not ${n}`;
    return echec(
      etat,
      "too_long",
      loc,
      entree,
      { field_type: genre, max_length: max, actual_length: n },
      msg,
    );
  }
  return sortie;
}

function dictionnaire<K, V>(
  cle: SchemaPy<K>,
  valeur: SchemaPy<V>,
  c?: ContraintesTaille,
): SchemaPy<Record<string, V>> {
  return new SchemaPy<Record<string, V>>((entree, loc, etat) => {
    if (!estDict(entree)) return echec(etat, "dict_type", loc, entree);
    const sortie = objetNu() as Record<string, V>;
    const ordre: string[] = [];
    const debut = etat.erreurs.length;
    for (const k of clesOrdonnees(entree)) {
      const kv = cle.verifier(k, [...loc, cleLoc(k), "[key]"], etat);
      const vv = valeur.verifier(entree[k], [...loc, cleLoc(k)], etat);
      if (kv === ECHEC || vv === ECHEC) continue;
      const k2 = String(kv);
      if (!Object.hasOwn(sortie, k2)) ordre.push(k2);
      sortie[k2] = vv;
    }
    if (etat.erreurs.length > debut) return ECHEC;
    noterOrdreDesCles(sortie, ordre);
    return taille(sortie, ordre.length, "Dictionary", c, entree, loc, etat, true);
  });
}

/** `Optional[T]` : `None` accepté ; alias et défaut se posent avant ou après, au choix. */
function optionnel<T>(schema: SchemaPy<T>): SchemaPy<T | null> {
  return new SchemaPy<T | null>(
    (entree, loc, etat) => (entree === null ? null : schema.verifier(entree, loc, etat)),
    { ...schema.options },
  );
}

function quelconque(): SchemaPy<unknown> {
  return new SchemaPy<unknown>((entree) => entree);
}

export interface OptionsModele {
  extra?: "ignore" | "forbid" | "allow";
  /** Nom de la classe : entrée non dict → `model_type` (validation hors `from_attributes`, celle des arguments d'outils). */
  classe?: string;
}

/** `BaseModel` : champs dans l'ordre déclaré (clé = alias), `missing` porte l'objet parent, puis les extras. */
function modele<const C extends Champs>(champs: C, options: OptionsModele = {}): SchemaPy<SortieChamps<C>> {
  const extra = options.extra ?? "ignore";
  const declares = Object.entries(champs).map(([nom, schema]) => ({
    nom,
    schema,
    cle: schema.options.alias ?? nom,
  }));
  const acceptees = new Set(declares.map((c) => c.cle));
  const noms = new Set(declares.map((c) => c.nom));
  return new SchemaPy<SortieChamps<C>>((entree, loc, etat) => {
    if (!estDict(entree))
      return options.classe === undefined
        ? echec(etat, "model_attributes_type", loc, entree)
        : echec(
            etat,
            "model_type",
            loc,
            entree,
            { class_name: options.classe },
            `Input should be a valid dictionary or instance of ${options.classe}`,
          );
    const sortie = objetNu();
    const ordre: string[] = [];
    const debut = etat.erreurs.length;
    for (const { nom, schema, cle } of declares) {
      if (Object.hasOwn(entree, cle)) {
        const v = schema.verifier(entree[cle], [...loc, cle], etat);
        if (v === ECHEC) continue;
        sortie[nom] = v;
      } else if (schema.options.defaut) {
        sortie[nom] = schema.options.defaut();
      } else {
        echec(etat, "missing", [...loc, cle], entree);
        continue;
      }
      ordre.push(nom);
    }
    if (extra !== "ignore") {
      for (const k of clesOrdonnees(entree)) {
        if (!k.isWellFormed()) {
          etat.erreurs.splice(debut);
          return echec(etat, "string_unicode", loc, k);
        }
        if (acceptees.has(k)) continue;
        if (extra === "forbid") echec(etat, "extra_forbidden", [...loc, cleLoc(k)], entree[k]);
        else if (!noms.has(k)) {
          sortie[k] = entree[k];
          ordre.push(k);
        }
      }
    }
    if (etat.erreurs.length > debut) return ECHEC;
    noterOrdreDesCles(sortie, ordre);
    return sortie as SortieChamps<C>;
  });
}

/** Fabriques des types Pydantic : `py.int({ ge: 0 })`, `py.model({ a: py.str().defaut("") })`… */
export const py = {
  int: entier,
  float: flottant,
  bool: booleen,
  str: texte,
  literal: litteral,
  list: liste,
  dict: dictionnaire,
  optional: optionnel,
  any: quelconque,
  model: modele,
};

type ResultatPy<T> =
  { ok: true; valeur: T; horsBornes: boolean } | { ok: false; erreurs: ErreurPy[]; horsBornes: boolean };

export function validerPy<T>(schema: SchemaPy<T>, entree: unknown, loc: Loc = []): ResultatPy<T> {
  const etat: Etat = { erreurs: [], horsBornes: false };
  const valeur = schema.verifier(entree, loc, etat);
  return valeur === ECHEC || etat.erreurs.length > 0
    ? { ok: false, erreurs: etat.erreurs, horsBornes: etat.horsBornes }
    : { ok: true, valeur, horsBornes: etat.horsBornes };
}

/** Imbrication d'une entrée en erreur au-delà de laquelle `jsonable_encoder` lève `RecursionError` (500), mesurée sous FastAPI. */
const PROFONDEUR_RENDU_MAX = 972;

/** `jsonable_encoder` puis `JSONResponse` : octets décodés en UTF-8 ; flottant non fini, demi-paire ou imbrication excessive ⇒ 500. */
function jsonable(v: unknown, profondeur: number): unknown {
  if (typeof v === "string") {
    if (!v.isWellFormed()) throw new Error("'utf-8' codec can't encode character: surrogates not allowed");
    return v;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Out of range float values are not JSON compliant");
    return v;
  }
  if (estOctets(v)) {
    const lu = texteUtf8(v);
    if (lu === undefined) throw new Error("'utf-8' codec can't decode bytes");
    return lu;
  }
  if (v === null || typeof v !== "object") return v;
  if (profondeur >= PROFONDEUR_RENDU_MAX) throw new RangeError("maximum recursion depth exceeded");
  if (Array.isArray(v)) return v.map((x) => jsonable(x, profondeur + 1));
  const copie = objetNu();
  const cles = clesOrdonnees(v);
  for (const k of cles)
    copie[jsonable(k, profondeur) as string] = jsonable((v as Record<string, unknown>)[k], profondeur + 1);
  noterOrdreDesCles(copie, cles);
  return copie;
}

/** Le 422 de FastAPI ; une entrée non rendable en JSON donne la panne 500 de Starlette. */
export function erreurValidation(erreurs: readonly ErreurPy[]): ErreurValidation {
  return new ErreurValidation(
    erreurs.map((e) => {
      const rendue = { type: e.type, loc: e.loc, msg: e.msg, input: jsonable(e.input, 0) };
      return e.ctx === undefined ? rendue : { ...rendue, ctx: jsonable(e.ctx, 0) as Record<string, unknown> };
    }),
  );
}

/** Donnée déjà lue (corps `corpsJson`, configuration…) validée comme un paramètre `emplacement` : 422, ou 400 hors bornes. */
export function valider<T>(schema: SchemaPy<T>, donnees: unknown, emplacement: Emplacement = "body"): T {
  const resultat = validerPy(schema, donnees, [emplacement]);
  if (!resultat.ok) throw erreurValidation(resultat.erreurs);
  if (resultat.horsBornes) throw horsBornes();
  return resultat.valeur;
}

/** Le 400 que le filet `OverflowError` de server/app.py rend pour un entier que SQLite refuse. */
export function horsBornes(): HttpError {
  return new HttpError(400, "Paramètre hors bornes.");
}
