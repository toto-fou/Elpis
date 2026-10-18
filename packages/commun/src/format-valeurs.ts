// SPDX-License-Identifier: MIT
/** packages/commun/src/format-valeurs.ts — `str.format(**champs)` de Python sur des valeurs typées (texte, entier, flottant, booléen) : champs nommés, conversions, mini-langage de format, arrondis décimaux exacts. */
import { FlottantPy, reprFlottant } from "./json";
import { fixePy } from "./nombres";
import { reprPy } from "./python";

/** Valeur d'un champ : un `float` de Python passe en `FlottantPy` (un nombre JS entier serait formaté comme un `int`). */
export type ValeurFormat = string | number | bigint | boolean | FlottantPy;

export type TypeErreurFormat =
  "ValueError" | "KeyError" | "IndexError" | "TypeError" | "OverflowError" | "AttributeError";

export class ErreurFormat extends Error {
  readonly type: TypeErreurFormat;

  constructor(type: TypeErreurFormat, message: string) {
    super(message);
    this.name = type;
    this.type = type;
  }
}

const valeurErreur = (message: string): ErreurFormat => new ErreurFormat("ValueError", message);

type Valeur =
  | { genre: "texte"; v: string }
  | { genre: "entier"; v: bigint }
  | { genre: "flottant"; v: number }
  | { genre: "booleen"; v: boolean };

function classer(v: ValeurFormat): Valeur {
  if (typeof v === "string") return { genre: "texte", v };
  if (typeof v === "boolean") return { genre: "booleen", v };
  if (v instanceof FlottantPy) return { genre: "flottant", v: v.valeur };
  if (typeof v === "bigint") return { genre: "entier", v };
  return Number.isInteger(v) ? { genre: "entier", v: BigInt(v) } : { genre: "flottant", v };
}

function texteFlottant(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  return reprFlottant(x);
}

/** `str(v)`. */
function strValeur(v: Valeur): string {
  if (v.genre === "texte") return v.v;
  if (v.genre === "booleen") return v.v ? "True" : "False";
  return v.genre === "entier" ? v.v.toString() : texteFlottant(v.v);
}

/** `ascii(v)` : `repr` dont le non-ASCII est échappé (`\xNN`, `\uNNNN`, `\UNNNNNNNN`). */
function asciiValeur(v: Valeur): string {
  const repr = v.genre === "texte" ? reprPy(v.v) : strValeur(v);
  let sortie = "";
  for (const c of repr) {
    const code = c.codePointAt(0) ?? 0;
    if (code < 0x80) sortie += c;
    else if (code < 0x100) sortie += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code < 0x10000) sortie += `\\u${code.toString(16).padStart(4, "0")}`;
    else sortie += `\\U${code.toString(16).padStart(8, "0")}`;
  }
  return sortie;
}

function longueur(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

interface Spec {
  fill: string;
  align: string;
  signe: string;
  z: boolean;
  alt: boolean;
  largeur: number;
  separateur: "" | "," | "_";
  precision: number;
  type: string;
}

const ALIGNEMENTS = "<>=^";

/** `parse_internal_render_format_spec` de CPython. */
function lireSpec(spec: string, alignDefaut: "<" | ">"): Spec {
  const c = Array.from(spec);
  const s: Spec = {
    fill: " ",
    align: alignDefaut,
    signe: "",
    z: false,
    alt: false,
    largeur: -1,
    separateur: "",
    precision: -1,
    type: "",
  };
  let i = 0;
  let fillExplicite = false;
  let alignExplicite = false;
  if (c.length >= 2 && ALIGNEMENTS.includes(c[1] ?? "")) {
    s.fill = c[0] ?? " ";
    s.align = c[1] ?? alignDefaut;
    fillExplicite = alignExplicite = true;
    i = 2;
  } else if (c.length >= 1 && ALIGNEMENTS.includes(c[0] ?? "")) {
    s.align = c[0] ?? alignDefaut;
    alignExplicite = true;
    i = 1;
  }
  if ("+- ".includes(c[i] ?? "x")) s.signe = c[i++] ?? "";
  if (c[i] === "z") {
    s.z = true;
    i++;
  }
  if (c[i] === "#") {
    s.alt = true;
    i++;
  }
  if (!fillExplicite && c[i] === "0") {
    s.fill = "0";
    if (!alignExplicite && alignDefaut === ">") s.align = "=";
    i++;
  }
  const entier = (): number => {
    let texte = "";
    while (/^[0-9]$/.test(c[i] ?? "")) texte += c[i++];
    if (texte.length > 18) throw valeurErreur("Too many decimal digits in format string");
    return texte === "" ? -1 : Number(texte);
  };
  s.largeur = entier();
  if (c[i] === ",") {
    s.separateur = ",";
    i++;
  }
  if (c[i] === "_") {
    if (s.separateur !== "") throw valeurErreur("Cannot specify both ',' and '_'.");
    s.separateur = "_";
    i++;
  }
  if (c[i] === "," && s.separateur === "_") throw valeurErreur("Cannot specify both ',' and '_'.");
  if (c[i] === ".") {
    i++;
    s.precision = entier();
    if (s.precision === -1) throw valeurErreur("Format specifier missing precision");
  }
  if (c.length - i > 1) throw valeurErreur(`Invalid format specifier '${spec}'`);
  if (c.length - i === 1) s.type = c[i] ?? "";
  if (s.separateur !== "" && !"defgEFG%".includes(s.type || "d")) {
    if (s.separateur === "_" && "boxX".includes(s.type) && s.type !== "") return s;
    throw valeurErreur(`Cannot specify '${s.separateur}' with '${s.type}'.`);
  }
  return s;
}

/** Chiffres exacts d'un double fini positif : `chiffres × 10^-echelle` (tout double a un développement décimal fini). */
function decimalExact(x: number): { chiffres: string; echelle: number } {
  const vue = new DataView(new ArrayBuffer(8));
  vue.setFloat64(0, x);
  const haut = vue.getUint32(0);
  const brut = (haut >>> 20) & 0x7ff;
  const fraction = (BigInt(haut & 0xfffff) << 32n) | BigInt(vue.getUint32(4));
  const mantisse = brut === 0 ? fraction : fraction | (1n << 52n);
  const exposant = brut === 0 ? -1074 : brut - 1075;
  if (mantisse === 0n) return { chiffres: "0", echelle: 0 };
  if (exposant >= 0) return { chiffres: (mantisse << BigInt(exposant)).toString(), echelle: 0 };
  return { chiffres: (mantisse * 5n ** BigInt(-exposant)).toString(), echelle: -exposant };
}

/** `p` chiffres significatifs arrondis au plus proche, moitié au pair ; `decpt` = position du point décimal. */
function significatifs(x: number, p: number): { chiffres: string; decpt: number } {
  if (x === 0) return { chiffres: "0".repeat(p), decpt: 1 };
  const { chiffres, echelle } = decimalExact(x);
  let decpt = chiffres.length - echelle;
  if (chiffres.length <= p) return { chiffres: chiffres.padEnd(p, "0"), decpt };
  let tete = chiffres.slice(0, p);
  const reste = chiffres.slice(p);
  const premier = reste.charAt(0);
  const pair = Number(tete.charAt(tete.length - 1)) % 2 === 0;
  if (premier > "5" || (premier === "5" && (/[1-9]/.test(reste.slice(1)) || !pair))) {
    tete = (BigInt(tete) + 1n).toString();
    if (tete.length > p) {
      tete = tete.slice(0, p);
      decpt++;
    }
  }
  return { chiffres: tete, decpt };
}

function exposantTexte(e: number, majuscule: boolean): string {
  return `${majuscule ? "E" : "e"}${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
}

/** `PyOS_double_to_string` (types e, f, g, r ; ALT, ADD_DOT_0, NO_NEG_0), signe compris. */
function doubleEnTexte(
  x: number,
  type: string,
  precision: number,
  alt: boolean,
  ajoutPoint0: boolean,
  z: boolean,
): string {
  const majuscule = type === "E" || type === "F" || type === "G";
  if (Number.isNaN(x)) return majuscule ? "NAN" : "nan";
  if (!Number.isFinite(x)) return (x < 0 ? "-" : "") + (majuscule ? "INF" : "inf");
  const a = Math.abs(x);
  let corps: string;
  switch (type.toLowerCase()) {
    case "f":
      corps = fixePy(a, precision) + (alt && precision === 0 ? "." : "");
      break;
    case "e": {
      const { chiffres, decpt } = significatifs(a, precision + 1);
      const reste = chiffres.slice(1);
      corps =
        chiffres.charAt(0) +
        (reste || alt ? "." : "") +
        reste +
        exposantTexte(a === 0 ? 0 : decpt - 1, majuscule);
      break;
    }
    case "g": {
      const p = precision === 0 ? 1 : precision;
      const brut = significatifs(a, p);
      const chiffres = alt ? brut.chiffres : brut.chiffres.replace(/0+$/, "") || "0";
      const decpt = brut.decpt;
      if (decpt <= -4 || decpt > (ajoutPoint0 ? p - 1 : p)) {
        const reste = chiffres.slice(1);
        corps =
          chiffres.charAt(0) +
          (reste || alt ? "." : "") +
          reste +
          exposantTexte(a === 0 ? 0 : decpt - 1, majuscule);
      } else if (decpt <= 0) {
        corps = `0.${"0".repeat(-decpt)}${chiffres}`;
      } else if (decpt >= chiffres.length) {
        corps = chiffres + "0".repeat(decpt - chiffres.length) + (alt ? "." : "");
      } else {
        corps = `${chiffres.slice(0, decpt)}.${chiffres.slice(decpt)}`;
      }
      if (ajoutPoint0 && !/[.eE]/.test(corps)) corps += ".0";
      break;
    }
    default:
      corps = reprFlottant(a);
      if (alt && !corps.includes(".")) corps = corps.replace(/e/, ".e");
  }
  const negatif = (x < 0 || Object.is(x, -0)) && !(z && /^[0.]*$/.test(corps.replace(/[eE].*$/, "")));
  return (negatif ? "-" : "") + corps;
}

/** Séparateurs de milliers et zéros de tête jusqu'à `minimum` caractères (`_PyUnicode_InsertThousandsGrouping`) : le moins de chiffres possible, groupés une fois. */
function grouper(chiffres: string, taille: number, sep: string, minimum: number): string {
  const longueurGroupee = (n: number): number =>
    sep === "" ? n : n + Math.floor((n - 1) / taille) * sep.length;
  let n = chiffres.length;
  if (longueurGroupee(n) < minimum) {
    const borne =
      sep === "" ? minimum : Math.floor((minimum * taille + sep.length) / (taille + sep.length)) - 1;
    n = Math.max(n, borne);
    while (longueurGroupee(n) < minimum) n++;
  }
  const d = "0".repeat(n - chiffres.length) + chiffres;
  if (sep === "") return d;
  const tete = d.length % taille || taille;
  const groupes = [d.slice(0, tete)];
  for (let i = tete; i < d.length; i += taille) groupes.push(d.slice(i, i + taille));
  return groupes.join(sep);
}

/** `calc_number_widths` puis `fill_number` : remplissage, signe, préfixe, zéros groupés, reste. */
function disposer(
  signe: string,
  prefixe: string,
  chiffres: string,
  reste: string,
  s: Spec,
  taille: number,
): string {
  const sep = s.type === "n" ? "" : s.separateur;
  const fixes = longueur(signe) + prefixe.length + longueur(reste);
  const groupes =
    chiffres === ""
      ? ""
      : grouper(chiffres, taille, sep, s.fill === "0" && s.align === "=" ? s.largeur - fixes : 0);
  const total = fixes + groupes.length;
  let [gauche, milieu, droite] = [0, 0, 0];
  if (s.largeur > total) {
    const n = s.largeur - total;
    if (s.align === "<") droite = n;
    else if (s.align === "^") [gauche, droite] = [Math.floor(n / 2), n - Math.floor(n / 2)];
    else if (s.align === "=") milieu = n;
    else gauche = n;
  }
  return (
    s.fill.repeat(gauche) + signe + prefixe + s.fill.repeat(milieu) + groupes + reste + s.fill.repeat(droite)
  );
}

function signeDe(negatif: boolean, s: Spec): string {
  if (negatif) return "-";
  return s.signe === "+" || s.signe === " " ? s.signe : "";
}

function formaterTexte(v: string, spec: string): string {
  const s = lireSpec(spec, "<");
  if (s.type !== "" && s.type !== "s")
    throw valeurErreur(`Unknown format code '${s.type}' for object of type 'str'`);
  if (s.signe !== "") throw valeurErreur("Sign not allowed in string format specifier");
  if (s.z) throw valeurErreur("Negative zero coercion (z) not allowed in format specifier");
  if (s.alt) throw valeurErreur("Alternate form (#) not allowed in string format specifier");
  if (s.align === "=") throw valeurErreur("'=' alignment not allowed in string format specifier");
  if (s.separateur !== "") throw valeurErreur(`Cannot specify '${s.separateur}' with 's'.`);
  return disposer("", "", "", s.precision >= 0 ? Array.from(v).slice(0, s.precision).join("") : v, s, 3);
}

function formaterFlottant(x: number, s: Spec): string {
  let type = s.type;
  let precision = s.precision;
  let ajoutPoint0 = false;
  if (type === "") {
    ajoutPoint0 = true;
    type = precision < 0 ? "r" : "g";
  } else if (type === "n") {
    type = "g";
  }
  let valeur = x;
  let pourcent = false;
  if (type === "%") {
    type = "f";
    valeur = x * 100;
    pourcent = true;
  }
  if (precision < 0) precision = 6;
  const corps = doubleEnTexte(valeur, type, precision, s.alt, ajoutPoint0, s.z) + (pourcent ? "%" : "");
  const negatif = corps.startsWith("-");
  const nombre = negatif ? corps.slice(1) : corps;
  const chiffres = /^[0-9]*/.exec(nombre)?.[0] ?? "";
  return disposer(signeDe(negatif, s), "", chiffres, nombre.slice(chiffres.length), s, 3);
}

function formaterEntier(v: bigint, s: Spec): string {
  if ("eEfFgG%".includes(s.type) && s.type !== "") {
    const x = Number(v);
    if (!Number.isFinite(x)) throw new ErreurFormat("OverflowError", "int too large to convert to float");
    return formaterFlottant(x, s);
  }
  const type = s.type || "d";
  if (!"bcdoxXn".includes(type)) throw valeurErreur(`Unknown format code '${type}' for object of type 'int'`);
  if (s.precision !== -1) throw valeurErreur("Precision not allowed in integer format specifier");
  if (s.z) throw valeurErreur("Negative zero coercion (z) not allowed in format specifier");
  if (type === "c") {
    if (s.signe !== "") throw valeurErreur("Sign not allowed with integer format specifier 'c'");
    if (s.alt) throw valeurErreur("Alternate form (#) not allowed with integer format specifier 'c'");
    if (v < 0n || v > 0x10ffffn) throw new ErreurFormat("OverflowError", "%c arg not in range(0x110000)");
    return disposer("", "", "", String.fromCodePoint(Number(v)), s, 3);
  }
  const base = { b: 2, o: 8, x: 16, X: 16 }[type as "b"] ?? 10;
  const absolu = v < 0n ? -v : v;
  let chiffres = absolu.toString(base);
  let prefixe = s.alt && base !== 10 ? `0${type === "X" ? "X" : type}` : "";
  if (type === "X") {
    chiffres = chiffres.toUpperCase();
    prefixe = prefixe.toUpperCase();
  }
  return disposer(signeDe(v < 0n, s), prefixe, chiffres, "", s, base === 10 ? 3 : 4);
}

/** `format(valeur, spec)` : `__format__` de `str`, `int`, `float` et `bool`. */
export function formatValeur(valeur: ValeurFormat, spec: string): string {
  const v = classer(valeur);
  if (v.genre === "texte") return formaterTexte(v.v, spec);
  if (v.genre === "booleen")
    return spec === "" ? strValeur(v) : formaterEntier(v.v ? 1n : 0n, lireSpec(spec, ">"));
  const s = lireSpec(spec, ">");
  if (v.genre === "entier") return formaterEntier(v.v, s);
  if (!"eEfFgGn%".includes(s.type))
    throw valeurErreur(`Unknown format code '${s.type}' for object of type 'float'`);
  return formaterFlottant(v.v, s);
}

/** Valeur d'un nom de champ : mot-clé, puis index `[n]` d'un texte ; attributs et positions non pris en charge. */
function valeurDuChamp(nom: string, champs: Readonly<Record<string, ValeurFormat>>): ValeurFormat {
  const fin = nom.search(/[.[]/);
  const tete = fin < 0 ? nom : nom.slice(0, fin);
  if (tete === "" || /^[0-9]+$/.test(tete))
    throw new ErreurFormat("IndexError", "Replacement index out of range for positional args tuple");
  if (!Object.hasOwn(champs, tete)) throw new ErreurFormat("KeyError", `'${tete}'`);
  let v = champs[tete] as ValeurFormat;
  let reste = fin < 0 ? "" : nom.slice(fin);
  while (reste !== "") {
    if (reste.startsWith(".")) {
      if (/^\.(?:[.[]|$)/.test(reste)) throw valeurErreur("Empty attribute in format string");
      throw new ErreurFormat("AttributeError", "attribut d'un champ de format non pris en charge");
    }
    const ferme = reste.indexOf("]");
    if (ferme < 0) throw valeurErreur("Missing ']' in format string");
    const cle = reste.slice(1, ferme);
    if (cle === "") throw valeurErreur("Empty attribute in format string");
    reste = reste.slice(ferme + 1);
    if (reste !== "" && !/^[.[]/.test(reste))
      throw valeurErreur("Only '.' or '[' may follow ']' in format field specifier");
    if (typeof v !== "string") throw new ErreurFormat("TypeError", "object is not subscriptable");
    if (!/^[0-9]+$/.test(cle))
      throw new ErreurFormat("TypeError", "string indices must be integers, not 'str'");
    const car = Array.from(v)[Number(cle)];
    if (car === undefined) throw new ErreurFormat("IndexError", "string index out of range");
    v = car;
  }
  return v;
}

/** Un champ `nom[!conversion][:spec]` (spec aux champs imbriqués déjà développés). */
function formaterChamp(
  contenu: string,
  champs: Readonly<Record<string, ValeurFormat>>,
  profondeur: number,
): string {
  let i = 0;
  let arret = "";
  for (; i < contenu.length; i++) {
    const c = contenu.charAt(i);
    if (c === "{") throw valeurErreur("unexpected '{' in field name");
    if (c === "[") {
      const ferme = contenu.indexOf("]", i);
      i = ferme < 0 ? contenu.length - 1 : ferme;
      continue;
    }
    if (c === ":" || c === "!") {
      arret = c;
      break;
    }
  }
  const nom = contenu.slice(0, i);
  let conversion = "";
  let spec = "";
  if (arret === "!") {
    if (i + 1 >= contenu.length) throw valeurErreur("end of string while looking for conversion specifier");
    conversion = Array.from(contenu.slice(i + 1))[0] ?? "";
    const apres = i + 1 + conversion.length;
    if (apres < contenu.length && contenu.charAt(apres) !== ":")
      throw valeurErreur("expected ':' after conversion specifier");
    spec = contenu.slice(apres + 1);
  } else if (arret === ":") {
    spec = contenu.slice(i + 1);
  }
  let valeur = valeurDuChamp(nom, champs);
  if (conversion !== "") {
    const v = classer(valeur);
    if (conversion === "s") valeur = strValeur(v);
    else if (conversion === "r") valeur = v.genre === "texte" ? reprPy(v.v) : strValeur(v);
    else if (conversion === "a") valeur = asciiValeur(v);
    else throw valeurErreur(`Unknown conversion specifier ${conversion}`);
  }
  if (spec.includes("{")) spec = formaterGabarit(spec, champs, profondeur - 1);
  return formatValeur(valeur, spec);
}

function formaterGabarit(
  gabarit: string,
  champs: Readonly<Record<string, ValeurFormat>>,
  profondeur: number,
): string {
  if (profondeur <= 0) throw valeurErreur("Max string recursion exceeded");
  let sortie = "";
  for (let i = 0; i < gabarit.length;) {
    const c = gabarit.charAt(i);
    if (c === "}") {
      if (gabarit.charAt(i + 1) !== "}") throw valeurErreur("Single '}' encountered in format string");
      sortie += "}";
      i += 2;
      continue;
    }
    if (c !== "{") {
      sortie += c;
      i++;
      continue;
    }
    if (gabarit.charAt(i + 1) === "{") {
      sortie += "{";
      i += 2;
      continue;
    }
    let niveau = 1;
    let j = i + 1;
    for (; j < gabarit.length && niveau > 0; j++) {
      if (gabarit.charAt(j) === "{") niveau++;
      else if (gabarit.charAt(j) === "}") niveau--;
    }
    if (niveau > 0)
      throw valeurErreur(
        j >= gabarit.length && i + 1 === gabarit.length
          ? "Single '{' encountered in format string"
          : "expected '}' before end of string",
      );
    sortie += formaterChamp(gabarit.slice(i + 1, j - 1), champs, profondeur);
    i = j;
  }
  return sortie;
}

/** `gabarit.format(**champs)` ; lève `ErreurFormat` là où Python lève. */
export function formatValeursPy(gabarit: string, champs: Readonly<Record<string, ValeurFormat>>): string {
  return formaterGabarit(gabarit, champs, 2);
}
