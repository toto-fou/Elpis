// SPDX-License-Identifier: MIT
/** packages/commun/src/json-lecture.ts — `json.loads` de Python : un point d'entrée, trois modes (valeurs, corps, natif). */
import { objetNu, poserCle } from "./dict";
import { FlottantPy, versFlottantPy } from "./json";
import { estCleEntiere, noterOrdreDesCles } from "./ordre";
import { texteUtf8 } from "./python";

const LIGNE_OU_PAIRE = /\n|[\ud800-\udbff][\udc00-\udfff]/g;

/** `json.JSONDecodeError` : message, position et ligne/colonne en points de code (une seule passe sur le préfixe). */
export class ErreurJsonPy extends SyntaxError {
  readonly msgPy: string;
  readonly pos: number;
  readonly lineno: number;
  readonly colno: number;

  constructor(msg: string, doc: string, unite: number) {
    let paires = 0;
    let lignes = 0;
    let derniere = -1;
    let pairesAvantDerniere = 0;
    const avant = doc.slice(0, unite);
    LIGNE_OU_PAIRE.lastIndex = 0;
    for (let m = LIGNE_OU_PAIRE.exec(avant); m !== null; m = LIGNE_OU_PAIRE.exec(avant)) {
      if (m[0] === "\n") {
        lignes++;
        derniere = m.index;
        pairesAvantDerniere = paires;
      } else paires++;
    }
    const pos = unite - paires;
    const colno = derniere < 0 ? pos + 1 : pos - (derniere - pairesAvantDerniere);
    super(`${msg}: line ${lignes + 1} column ${colno} (char ${pos})`);
    this.name = "ErreurJsonPy";
    this.msgPy = msg;
    this.pos = pos;
    this.lineno = lignes + 1;
    this.colno = colno;
  }
}

/** Échec hors syntaxe JSON, nommé comme l'exception Python (`ValueError` : entier de plus de 4300 chiffres). */
export class ErreurLecturePy extends Error {
  readonly nature: "UnicodeDecodeError" | "RecursionError" | "ValueError";

  constructor(nature: ErreurLecturePy["nature"], message: string) {
    super(message);
    this.name = "ErreurLecturePy";
    this.nature = nature;
  }
}

/** Imbrication à laquelle le scanner C lève `RecursionError` sous FastAPI (mesurée sous TestClient ; un peu moins sous uvicorn). */
const PROFONDEUR_JSON_MAX = 9994;
const CHIFFRES_INT_MAX = 4300;

const ESPACE = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const CHIFFRE = (c: number): boolean => c >= 0x30 && c <= 0x39;
const ECHAPPEMENTS: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function chiffreHex(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

function hex4(s: string, debut: number): number {
  let v = 0;
  for (let i = debut; i < debut + 4; i++) {
    const d = chiffreHex(s.charCodeAt(i));
    if (d < 0) return -1;
    v = (v << 4) | d;
  }
  return v;
}

/** `scanstring_unicode` (strict) : renvoie la chaîne et l'index après le guillemet fermant. */
function lireChaine(s: string, fin: number): [string, number] {
  const debut = fin - 1;
  let morceaux = "";
  let i = fin;
  for (;;) {
    let j = i;
    let c = 0;
    for (; j < s.length; j++) {
      c = s.charCodeAt(j);
      if (c === 0x22 || c === 0x5c) break;
      if (c <= 0x1f) throw new ErreurJsonPy("Invalid control character at", s, j);
    }
    if (j >= s.length) throw new ErreurJsonPy("Unterminated string starting at", s, debut);
    morceaux += s.slice(i, j);
    j++;
    if (c === 0x22) return [morceaux, j];
    if (j === s.length) throw new ErreurJsonPy("Unterminated string starting at", s, debut);
    const echappe = s.charAt(j);
    if (echappe !== "u") {
      const remplacement = ECHAPPEMENTS[echappe];
      if (remplacement === undefined) throw new ErreurJsonPy("Invalid \\escape", s, j - 1);
      morceaux += remplacement;
      i = j + 1;
      continue;
    }
    const hex = j + 1;
    let suite = hex + 4;
    if (suite >= s.length) throw new ErreurJsonPy("Invalid \\uXXXX escape", s, j);
    let code = hex4(s, hex);
    if (code < 0) throw new ErreurJsonPy("Invalid \\uXXXX escape", s, j);
    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      suite + 6 < s.length &&
      s.charCodeAt(suite) === 0x5c &&
      s.charCodeAt(suite + 1) === 0x75
    ) {
      const bas = hex4(s, suite + 2);
      if (bas < 0) throw new ErreurJsonPy("Invalid \\uXXXX escape", s, suite + 1);
      if (bas >= 0xdc00 && bas <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (bas - 0xdc00);
        suite += 6;
      }
    }
    morceaux += String.fromCodePoint(code);
    i = suite;
  }
}

/** `_match_number_unicode` ; un entier de plus de 4300 chiffres lève comme `int()`. */
function lireNombre(s: string, debut: number, valeursPy: boolean): [unknown, number] | undefined {
  let i = debut;
  const fin = s.length - 1;
  if (s.charCodeAt(i) === 0x2d) {
    i++;
    if (i > fin) return undefined;
  }
  const premier = s.charCodeAt(i);
  if (premier >= 0x31 && premier <= 0x39) {
    i++;
    while (i <= fin && CHIFFRE(s.charCodeAt(i))) i++;
  } else if (premier === 0x30) i++;
  else return undefined;
  let flottant = false;
  if (i < fin && s.charCodeAt(i) === 0x2e && CHIFFRE(s.charCodeAt(i + 1))) {
    flottant = true;
    i += 2;
    while (i <= fin && CHIFFRE(s.charCodeAt(i))) i++;
  }
  if (i < fin && (s.charCodeAt(i) === 0x65 || s.charCodeAt(i) === 0x45)) {
    const e = i;
    i++;
    if (i < fin && (s.charCodeAt(i) === 0x2d || s.charCodeAt(i) === 0x2b)) i++;
    while (i <= fin && CHIFFRE(s.charCodeAt(i))) i++;
    if (CHIFFRE(s.charCodeAt(i - 1))) flottant = true;
    else i = e;
  }
  const texte = s.slice(debut, i);
  if (!flottant && texte.replace("-", "").length > CHIFFRES_INT_MAX) {
    throw new ErreurLecturePy("ValueError", "Exceeds the limit (4300 digits) for integer string conversion");
  }
  const n = Number(texte);
  if (valeursPy) return [flottant ? versFlottantPy(n) : Number.isSafeInteger(n) ? n + 0 : BigInt(texte), i];
  return [flottant || n !== 0 ? n : 0, i];
}

interface CadreObjet {
  objet: Record<string, unknown>;
  cle: string;
  cles: string[];
  entieres: boolean;
}

type Cadre = { tableau: unknown[] } | CadreObjet;

function sauter(s: string, i: number): number {
  while (i < s.length && ESPACE(s.charCodeAt(i))) i++;
  return i;
}

/** Après `{` ou `,` : lit `"clé"` puis `:` et renvoie l'index de la valeur. */
function lireCle(s: string, i: number, cadre: CadreObjet): number {
  if (i >= s.length || s.charCodeAt(i) !== 0x22) {
    throw new ErreurJsonPy("Expecting property name enclosed in double quotes", s, i);
  }
  const [cle, apres] = lireChaine(s, i + 1);
  cadre.cle = cle;
  const j = sauter(s, apres);
  if (j >= s.length || s.charCodeAt(j) !== 0x3a) throw new ErreurJsonPy("Expecting ':' delimiter", s, j);
  return sauter(s, j + 1);
}

function entrer(pile: Cadre[]): void {
  if (pile.length + 1 > PROFONDEUR_JSON_MAX) {
    throw new ErreurLecturePy(
      "RecursionError",
      "maximum recursion depth exceeded while decoding a JSON document",
    );
  }
}

/** `JSONDecoder.decode` (scanner C, `strict=True`), itératif : objets sans prototype (ou ordinaires et nombres Python si `valeursPy`). */
export function decoderJsonPy(s: string, valeursPy = false): unknown {
  const nouvelObjet = (): Record<string, unknown> => (valeursPy ? {} : objetNu());
  const special = (x: number): unknown => (valeursPy ? new FlottantPy(x) : x);
  const pile: Cadre[] = [];
  let i = sauter(s, 0);
  for (;;) {
    let valeur: unknown;
    if (i >= s.length) throw new ErreurJsonPy("Expecting value", s, i);
    const c = s.charCodeAt(i);
    if (c === 0x22) {
      [valeur, i] = lireChaine(s, i + 1);
    } else if (c === 0x7b) {
      entrer(pile);
      const j = sauter(s, i + 1);
      if (j < s.length && s.charCodeAt(j) === 0x7d) {
        valeur = nouvelObjet();
        i = j + 1;
      } else {
        const cadre: CadreObjet = { objet: nouvelObjet(), cle: "", cles: [], entieres: false };
        i = lireCle(s, j, cadre);
        pile.push(cadre);
        continue;
      }
    } else if (c === 0x5b) {
      entrer(pile);
      const j = sauter(s, i + 1);
      if (j < s.length && s.charCodeAt(j) === 0x5d) {
        valeur = [];
        i = j + 1;
      } else {
        pile.push({ tableau: [] });
        i = j;
        continue;
      }
    } else if (s.startsWith("null", i)) [valeur, i] = [null, i + 4];
    else if (s.startsWith("true", i)) [valeur, i] = [true, i + 4];
    else if (s.startsWith("false", i)) [valeur, i] = [false, i + 5];
    else if (s.startsWith("NaN", i)) [valeur, i] = [special(NaN), i + 3];
    else if (s.startsWith("Infinity", i)) [valeur, i] = [special(Infinity), i + 8];
    else if (s.startsWith("-Infinity", i)) [valeur, i] = [special(-Infinity), i + 9];
    else {
      const nombre = lireNombre(s, i, valeursPy);
      if (nombre === undefined) throw new ErreurJsonPy("Expecting value", s, i);
      [valeur, i] = nombre;
    }
    for (;;) {
      const cadre = pile[pile.length - 1];
      if (cadre === undefined) {
        const fin = sauter(s, i);
        if (fin !== s.length) throw new ErreurJsonPy("Extra data", s, fin);
        return valeur;
      }
      const tableau = "tableau" in cadre;
      if (tableau) cadre.tableau.push(valeur);
      else {
        if (!Object.hasOwn(cadre.objet, cadre.cle)) {
          cadre.cles.push(cadre.cle);
          if (!cadre.entieres && estCleEntiere(cadre.cle)) cadre.entieres = true;
        }
        poserCle(cadre.objet, cadre.cle, valeur);
      }
      i = sauter(s, i);
      const fermant = tableau ? 0x5d : 0x7d;
      if (i < s.length && s.charCodeAt(i) === fermant) {
        pile.pop();
        i++;
        if (tableau) valeur = cadre.tableau;
        else {
          if (cadre.entieres) noterOrdreDesCles(cadre.objet, cadre.cles);
          valeur = cadre.objet;
        }
        continue;
      }
      if (i >= s.length || s.charCodeAt(i) !== 0x2c) throw new ErreurJsonPy("Expecting ',' delimiter", s, i);
      const virgule = i;
      i = sauter(s, i + 1);
      if (i < s.length && s.charCodeAt(i) === fermant) {
        throw new ErreurJsonPy(
          `Illegal trailing comma before end of ${tableau ? "array" : "object"}`,
          s,
          virgule,
        );
      }
      if (!tableau) i = lireCle(s, i, cadre);
      break;
    }
  }
}

type Encodage =
  "utf-8" | "utf-8-sig" | "utf-16" | "utf-16-le" | "utf-16-be" | "utf-32" | "utf-32-le" | "utf-32-be";

function detecterEncodage(b: Uint8Array): Encodage {
  const [b0, b1, b2, b3] = [b[0], b[1], b[2], b[3]];
  if (
    (b0 === 0xff && b1 === 0xfe && b2 === 0 && b3 === 0) ||
    (b0 === 0 && b1 === 0 && b2 === 0xfe && b3 === 0xff)
  ) {
    return "utf-32";
  }
  if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return "utf-16";
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return "utf-8-sig";
  if (b.length >= 4) {
    if (!b0) return b1 ? "utf-16-be" : "utf-32-be";
    if (!b1) return b2 || b3 ? "utf-16-le" : "utf-32-le";
  } else if (b.length === 2) {
    if (!b0) return "utf-16-be";
    if (!b1) return "utf-16-le";
  }
  return "utf-8";
}

const echecDecodage = (detail: string): ErreurLecturePy =>
  new ErreurLecturePy("UnicodeDecodeError", `codec can't decode bytes: ${detail}`);

/** Unités UTF-16 en chaîne, demi-paires isolées comprises (`surrogatepass`). */
const unitesEnTexte = (unites: Uint16Array, n: number): string =>
  Buffer.from(unites.buffer, unites.byteOffset, n * 2).toString("utf16le");

function ajouterPoint(unites: Uint16Array, n: number, code: number): number {
  if (code <= 0xffff) {
    unites[n] = code;
    return n + 1;
  }
  unites[n] = 0xd800 + ((code - 0x10000) >> 10);
  unites[n + 1] = 0xdc00 + ((code - 0x10000) & 0x3ff);
  return n + 2;
}

/** UTF-8 avec `surrogatepass` : demi-paires encodées acceptées, le reste strict. */
function utf8DemiPaires(b: Uint8Array, debut: number): string {
  const unites = new Uint16Array(b.length);
  let n = 0;
  for (let i = debut; i < b.length;) {
    const c = b[i] ?? 0;
    let suite: number;
    let code: number;
    let min: number;
    if (c < 0x80) [suite, code, min] = [0, c, 0];
    else if (c >= 0xc2 && c <= 0xdf) [suite, code, min] = [1, c & 0x1f, 0x80];
    else if (c >= 0xe0 && c <= 0xef) [suite, code, min] = [2, c & 0x0f, 0x800];
    else if (c >= 0xf0 && c <= 0xf4) [suite, code, min] = [3, c & 0x07, 0x10000];
    else throw echecDecodage("invalid start byte");
    if (i + suite >= b.length && suite > 0) throw echecDecodage("unexpected end of data");
    for (let k = 1; k <= suite; k++) {
      const octet = b[i + k] ?? 0;
      if ((octet & 0xc0) !== 0x80) throw echecDecodage("invalid continuation byte");
      code = (code << 6) | (octet & 0x3f);
    }
    if (code < min || code > 0x10ffff) throw echecDecodage("invalid sequence");
    n = ajouterPoint(unites, n, code);
    i += suite + 1;
  }
  return unitesEnTexte(unites, n);
}

function utf16(b: Uint8Array, debut: number, petit: boolean): string {
  if ((b.length - debut) % 2 !== 0) throw echecDecodage("truncated data");
  const copie = Buffer.from(b.subarray(debut));
  if (!petit) copie.swap16();
  return copie.toString("utf16le");
}

function utf32(b: Uint8Array, debut: number, petit: boolean): string {
  if ((b.length - debut) % 4 !== 0) throw echecDecodage("truncated data");
  const vue = new DataView(b.buffer, b.byteOffset + debut, b.length - debut);
  const unites = new Uint16Array(((b.length - debut) / 4) * 2);
  let n = 0;
  for (let i = 0; i < vue.byteLength; i += 4) {
    const code = vue.getUint32(i, petit);
    if (code > 0x10ffff) throw echecDecodage("code point not in range(0x110000)");
    n = ajouterPoint(unites, n, code);
  }
  return unitesEnTexte(unites, n);
}

/** `bytes.decode(detect_encoding(b), "surrogatepass")` de `json.loads`. */
export function texteJsonPy(b: Uint8Array): string {
  const encodage = detecterEncodage(b);
  switch (encodage) {
    case "utf-8":
    case "utf-8-sig": {
      const debut = encodage === "utf-8" ? 0 : 3;
      return texteUtf8(b.subarray(debut)) ?? utf8DemiPaires(b, debut);
    }
    case "utf-16":
      return utf16(b, 2, b[0] === 0xff);
    case "utf-16-le":
    case "utf-16-be":
      return utf16(b, 0, encodage === "utf-16-le");
    case "utf-32":
      return utf32(b, 4, b[0] === 0xff);
    case "utf-32-le":
    case "utf-32-be":
      return utf32(b, 0, encodage === "utf-32-le");
  }
}

const SUITE_DE_CHIFFRES = new RegExp(`(?<![0-9])[0-9]{${CHIFFRES_INT_MAX + 1}}`);

/** Plus de `max` crochets ou accolades ouvrants, chaînes comprises : condition nécessaire d'une imbrication trop profonde. */
function ouvrantsAuDela(s: string, max: number): boolean {
  let n = 0;
  for (const ouvrant of ["[", "{"]) {
    for (let i = s.indexOf(ouvrant); i >= 0; i = s.indexOf(ouvrant, i + 1)) if (++n > max) return true;
  }
  return false;
}

/** Index du guillemet fermant : un guillemet précédé d'un nombre impair de `\` est échappé. */
function finDeChaine(s: string, ouvrant: number): number {
  for (let i = s.indexOf('"', ouvrant + 1); i >= 0; i = s.indexOf('"', i + 1)) {
    let barres = 0;
    for (let j = i - 1; s.charCodeAt(j) === 0x5c; j--) barres++;
    if (barres % 2 === 0) return i;
  }
  return s.length;
}

function profondeurAuDela(s: string, max: number): boolean {
  let profondeur = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) i = finDeChaine(s, i);
    else if (c === 0x5b || c === 0x7b) {
      if (++profondeur > max) return true;
    } else if (c === 0x5d || c === 0x7d) profondeur--;
  }
  return false;
}

/** Prépasse linéaire : une suite de plus de 4300 chiffres ou une imbrication trop profonde exigent le scanner exact. */
function exigeLeScanner(s: string): boolean {
  if (s.length <= CHIFFRES_INT_MAX) return false;
  if (SUITE_DE_CHIFFRES.test(s)) return true;
  return ouvrantsAuDela(s, PROFONDEUR_JSON_MAX) && profondeurAuDela(s, PROFONDEUR_JSON_MAX);
}

const CLE_CHIFFRE = /"(?:[0-9]|\\u003[0-9])/;

/** Retire les prototypes de `JSON.parse` ; faux si le résultat diffère de `json.loads` (clé entière : ordre ; -0 entier). */
function commeLePython(racine: unknown, texte: string): boolean {
  const zero = texte.includes("-0");
  if (racine === null || typeof racine !== "object") return !(zero && Object.is(racine, -0));
  const cles = CLE_CHIFFRE.test(texte);
  const pile: object[] = [racine];
  for (let v = pile.pop(); v !== undefined; v = pile.pop()) {
    let enfants: readonly unknown[] = v as unknown[];
    if (!Array.isArray(v)) {
      const noms = Object.keys(v);
      Object.setPrototypeOf(v, null);
      if (cles && noms.some(estCleEntiere)) return false;
      enfants = noms.map((cle) => (v as Record<string, unknown>)[cle]);
    }
    for (const x of enfants) {
      if (x !== null && typeof x === "object") pile.push(x);
      else if (zero && Object.is(x, -0)) return false;
    }
  }
  return true;
}

/** Mode « corps » : `JSON.parse` sauf quand une prépasse ou un parcours montre un résultat différent de `json.loads`. */
function lireCorps(texte: string): unknown {
  if (exigeLeScanner(texte)) return decoderJsonPy(texte);
  let valeur: unknown;
  try {
    valeur = JSON.parse(texte);
  } catch {
    return decoderJsonPy(texte);
  }
  return commeLePython(valeur, texte) ? valeur : decoderJsonPy(texte);
}

/** `json.loads(octets)` de Python 3.13 en mode « corps », décodage de `detect_encoding` compris. */
export function pyJsonLoadsOctets(octets: Uint8Array): unknown {
  return lireCorps(texteJsonPy(octets));
}

const NOMBRE_JSON = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y;

/** Reviver de `JSON.parse` : la source d'un nombre dit s'il est flottant (`1.0`) ou entier exact (`9007199254740993`). */
function versValeurPy(_cle: string, valeur: unknown, contexte?: { source?: string }): unknown {
  if (typeof valeur !== "number") return valeur;
  const source = contexte?.source ?? String(valeur);
  if (/[.eE]/.test(source)) return versFlottantPy(valeur);
  if (Number.isSafeInteger(valeur)) return valeur + 0;
  if (source.replace("-", "").length > CHIFFRES_INT_MAX)
    throw new ErreurLecturePy("ValueError", "Exceeds the limit (4300 digits) for integer string conversion");
  return BigInt(source);
}

/** Mode « valeurs » : entier exact (bigint au-delà de 2^53), flottant entier ou non fini en `FlottantPy` ; `JSON.parse` sauf NaN, clé entière ou imbrication profonde. */
function lireValeurs(texte: string): unknown {
  let valeur: unknown;
  try {
    valeur = JSON.parse(texte, versValeurPy);
  } catch (e) {
    if (e instanceof ErreurLecturePy) throw e;
    return decoderJsonPy(texte, true);
  }
  return CLE_CHIFFRE.test(texte) && aUneCleEntiere(valeur) ? decoderJsonPy(texte, true) : valeur;
}

/** Grammaire de `json.loads` (JSON plus NaN, Infinity et -Infinity), pour ce que JSON.parse refuse. */
function analyserNatif(t: string): unknown {
  let i = 0;
  const echec = (): never => {
    throw new SyntaxError(`JSON invalide à la position ${i}`);
  };
  const blancs = (): void => {
    while (t[i] === " " || t[i] === "\t" || t[i] === "\n" || t[i] === "\r") i++;
  };
  const attendre = (c: string): void => {
    if (t[i] !== c) echec();
    i++;
  };
  const chaine = (): string => {
    attendre('"');
    let s = "";
    for (;;) {
      const c = t[i];
      if (c === undefined || c.charCodeAt(0) < 0x20) return echec();
      i++;
      if (c === '"') return s;
      if (c !== "\\") {
        s += c;
        continue;
      }
      const e = t[i] ?? "";
      const simple = Object.hasOwn(ECHAPPEMENTS, e) ? ECHAPPEMENTS[e] : undefined;
      if (simple !== undefined) {
        s += simple;
        i++;
      } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(t.slice(i + 1, i + 5))) {
        s += String.fromCharCode(Number.parseInt(t.slice(i + 1, i + 5), 16));
        i += 5;
      } else {
        return echec();
      }
    }
  };
  const valeur = (): unknown => {
    const c = t[i];
    if (c === '"') return chaine();
    if (c === "{") {
      i++;
      const objet: Record<string, unknown> = {};
      blancs();
      if (t[i] === "}") {
        i++;
        return objet;
      }
      for (;;) {
        blancs();
        const cle = chaine();
        blancs();
        attendre(":");
        blancs();
        poserCle(objet, cle, valeur());
        blancs();
        if (t[i] === "}") {
          i++;
          return objet;
        }
        attendre(",");
      }
    }
    if (c === "[") {
      i++;
      const liste: unknown[] = [];
      blancs();
      if (t[i] === "]") {
        i++;
        return liste;
      }
      for (;;) {
        blancs();
        liste.push(valeur());
        blancs();
        if (t[i] === "]") {
          i++;
          return liste;
        }
        attendre(",");
      }
    }
    for (const [mot, v] of [
      ["null", null],
      ["true", true],
      ["false", false],
      ["NaN", Number.NaN],
      ["Infinity", Infinity],
      ["-Infinity", -Infinity],
    ] as const) {
      if (t.startsWith(mot, i)) {
        i += mot.length;
        return v;
      }
    }
    NOMBRE_JSON.lastIndex = i;
    const m = NOMBRE_JSON.exec(t);
    if (m === null) return echec();
    i = NOMBRE_JSON.lastIndex;
    return Number(m[0]);
  };
  blancs();
  const resultat = valeur();
  blancs();
  if (i !== t.length) echec();
  return resultat;
}

/** Un objet de `racine` a-t-il une clé entière (que `JSON.parse` a rangée en tête) ? */
function aUneCleEntiere(racine: unknown): boolean {
  const pile: unknown[] = [racine];
  for (let v = pile.pop(); v !== undefined; v = pile.pop()) {
    if (v === null || typeof v !== "object") continue;
    if (Array.isArray(v)) for (const x of v as unknown[]) pile.push(x);
    else {
      const noms = Object.keys(v);
      if (noms.some(estCleEntiere)) return true;
      for (const nom of noms) pile.push((v as Record<string, unknown>)[nom]);
    }
  }
  return false;
}

/** Mode « natif » : objets de `JSON.parse` ; l'analyseur maison pour ce qu'il refuse (NaN, Infinity) ou pour l'ordre des clés entières. */
function lireNatif(texte: string): unknown {
  let valeur: unknown;
  try {
    valeur = JSON.parse(texte);
  } catch {
    return analyserNatif(texte);
  }
  if (!CLE_CHIFFRE.test(texte) || !aUneCleEntiere(valeur)) return valeur;
  try {
    return analyserNatif(texte);
  } catch {
    return valeur;
  }
}

export type ModeJsonLoads = "valeurs" | "corps" | "natif";

const LECTEURS: Readonly<Record<ModeJsonLoads, (texte: string) => unknown>> = {
  valeurs: lireValeurs,
  corps: lireCorps,
  natif: lireNatif,
};

/** `json.loads(texte)`, NaN et ±Infinity admis ; le mode choisit la forme des nombres, des objets et des erreurs. */
export function pyJsonLoads(texte: string, options: { mode?: ModeJsonLoads } = {}): unknown {
  return LECTEURS[options.mode ?? "valeurs"](texte);
}

/** Nombre lu par `JSON.parse`, rendu comme `pyJsonLoads` d'après son texte source (bigint, `FlottantPy`). */
function nombrePy(valeur: number, source: string): unknown {
  if (/[.eE]/.test(source))
    return Number.isInteger(valeur) || !Number.isFinite(valeur) ? new FlottantPy(valeur) : valeur;
  if (source.replace("-", "").length > 4300) throw new RangeError("entier de plus de 4300 chiffres");
  return Number.isSafeInteger(valeur) ? valeur + 0 : BigInt(source);
}

/** `pyJsonLoads` analysé en natif (lots d'images de 160 Mo) ; NaN, ±Infinity, erreurs et entiers géants repassent par `pyJsonLoads`. */
export function chargerJsonPy(texte: string): unknown {
  try {
    return JSON.parse(texte, (_cle: string, valeur: unknown, contexte?: { source?: string }) => {
      if (typeof valeur !== "number") return valeur;
      if (contexte?.source === undefined) throw new RangeError("texte source indisponible");
      return nombrePy(valeur, contexte.source);
    }) as unknown;
  } catch {
    return pyJsonLoads(texte);
  }
}
