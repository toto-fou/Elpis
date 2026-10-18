// SPDX-License-Identifier: MIT
/** packages/commun/src/format.ts — `str.format(**champs)` de Python sur des valeurs texte : champs nommés, conversions, mini-langage des chaînes. */
import { ErreurCle } from "./dict";
import { ErreurPython, reprPy } from "./python";

const CHIFFRES = /^[0-9]+$/;

function valeurErreur(message: string): ErreurPython {
  return new ErreurPython("ValueError", message);
}

/** `ascii(s)` : le repr, chaque caractère non ASCII échappé en \xNN, \uNNNN ou \UNNNNNNNN. */
export function asciiPy(s: string): string {
  let sortie = "";
  for (const c of reprPy(s)) {
    const p = c.codePointAt(0) ?? 0;
    if (p < 0x7f) sortie += c;
    else if (p < 0x100) sortie += `\\x${p.toString(16).padStart(2, "0")}`;
    else if (p < 0x10000) sortie += `\\u${p.toString(16).padStart(4, "0")}`;
    else sortie += `\\U${p.toString(16).padStart(8, "0")}`;
  }
  return sortie;
}

/** `format(texte, spec)` d'une chaîne : remplissage, alignement, largeur et précision en points de code. */
function appliquerSpec(texte: string, spec: string): string {
  const s = Array.from(spec);
  let pos = 0;
  let remplissage = " ";
  let alignement = "<";
  const remplissageDonne = s.length >= 2 && "<>=^".includes(s[1] ?? "");
  if (remplissageDonne) {
    remplissage = s[pos] ?? " ";
    alignement = s[pos + 1] ?? "<";
    pos += 2;
  } else if (s.length - pos >= 1 && "<>=^".includes(s[pos] ?? "")) {
    alignement = s[pos] ?? "<";
    pos += 1;
  }
  const signe = pos < s.length && "+- ".includes(s[pos] ?? "") ? s[pos++] : null;
  const zeroNegatif = s[pos] === "z" ? (pos++, true) : false;
  const alterne = s[pos] === "#" ? (pos++, true) : false;
  if (s[pos] === "0") {
    if (!remplissageDonne) remplissage = "0";
    pos++;
  }
  let largeur = "";
  while (pos < s.length && /[0-9]/.test(s[pos] ?? "")) largeur += s[pos++];
  const groupement = s[pos] === "," || s[pos] === "_" ? s[pos++] : null;
  let precision: string | null = null;
  if (s[pos] === ".") {
    pos++;
    precision = "";
    while (pos < s.length && /[0-9]/.test(s[pos] ?? "")) precision += s[pos++];
    if (precision === "") throw valeurErreur("Format specifier missing precision");
  }
  if (s.length - pos > 1) throw valeurErreur(`Invalid format specifier '${spec}' for object of type 'str'`);
  const type = s[pos] ?? "s";
  if (groupement !== null) throw valeurErreur(`Cannot specify '${groupement}' with '${type}'.`);
  if (type !== "s") throw valeurErreur(`Unknown format code '${type}' for object of type 'str'`);
  if (signe !== null) throw valeurErreur("Sign not allowed in string format specifier");
  if (zeroNegatif) throw valeurErreur("Negative zero coercion (z) not allowed in string format specifier");
  if (alterne) throw valeurErreur("Alternate form (#) not allowed in string format specifier");
  if (alignement === "=") throw valeurErreur("'=' alignment not allowed in string format specifier");
  let points = Array.from(texte);
  if (precision !== null) points = points.slice(0, Number(precision));
  const manque = Math.max(0, Number(largeur || 0) - points.length);
  const gauche = alignement === ">" ? manque : alignement === "^" ? Math.floor(manque / 2) : 0;
  return remplissage.repeat(gauche) + points.join("") + remplissage.repeat(manque - gauche);
}

/** Valeur d'un nom de champ : argument nommé, puis `.attribut` (absent d'une chaîne) ou `[index]` en points de code. */
function valeurDuChamp(nom: string, champs: Readonly<Record<string, string>>): string {
  const coupe = nom.search(/[.[]/);
  const base = coupe < 0 ? nom : nom.slice(0, coupe);
  if (base === "" || CHIFFRES.test(base))
    throw new ErreurPython("IndexError", "Replacement index 0 out of range for positional args tuple");
  if (!Object.hasOwn(champs, base)) throw new ErreurCle(reprPy(base));
  let valeur = champs[base] ?? "";
  for (let reste = coupe < 0 ? "" : nom.slice(coupe); reste !== "";) {
    if (reste.startsWith(".")) {
      const attribut = reste.slice(1).split(/[.[]/, 1)[0] ?? "";
      throw new ErreurPython("AttributeError", `'str' object has no attribute '${attribut}'`);
    }
    const fin = reste.indexOf("]");
    const cle = reste.slice(1, fin < 0 ? undefined : fin);
    if (!CHIFFRES.test(cle))
      throw new ErreurPython("TypeError", "string indices must be integers, not 'str'");
    const point = Array.from(valeur)[Number(cle)];
    if (point === undefined) throw new ErreurPython("IndexError", "string index out of range");
    valeur = point;
    reste = fin < 0 ? "" : reste.slice(fin + 1);
  }
  return valeur;
}

/** Champ complet `nom!conversion:spec` déjà isolé entre ses accolades. */
function rendreChamp(champ: string, champs: Readonly<Record<string, string>>, profondeur: number): string {
  let i = 0;
  let crochets = 0;
  while (i < champ.length && (crochets > 0 || (champ[i] !== "!" && champ[i] !== ":"))) {
    if (champ[i] === "[") crochets++;
    else if (champ[i] === "]") crochets = Math.max(0, crochets - 1);
    i++;
  }
  const nom = champ.slice(0, i);
  let conversion: string | null = null;
  if (champ[i] === "!") {
    conversion = champ[i + 1] ?? "";
    i += 2;
    if (i < champ.length && champ[i] !== ":") throw valeurErreur("expected ':' after conversion specifier");
  }
  const spec = i < champ.length ? champ.slice(i + 1) : "";
  let texte = valeurDuChamp(nom, champs);
  if (conversion === "r") texte = reprPy(texte);
  else if (conversion === "a") texte = asciiPy(texte);
  else if (conversion !== null && conversion !== "s")
    throw valeurErreur(`Unknown conversion specifier ${conversion}`);
  const specEtendue = spec.includes("{") ? formater(spec, champs, profondeur + 1) : spec;
  return appliquerSpec(texte, specEtendue);
}

function formater(gabarit: string, champs: Readonly<Record<string, string>>, profondeur: number): string {
  if (profondeur > 2) throw valeurErreur("Max string recursion exceeded");
  let sortie = "";
  for (let i = 0; i < gabarit.length; i++) {
    const c = gabarit[i];
    if (c === "}") {
      if (gabarit[i + 1] !== "}") throw valeurErreur("Single '}' encountered in format string");
      sortie += "}";
      i++;
    } else if (c === "{") {
      if (gabarit[i + 1] === "{") {
        sortie += "{";
        i++;
        continue;
      }
      if (i + 1 >= gabarit.length) throw valeurErreur("Single '{' encountered in format string");
      let niveau = 1;
      let j = i + 1;
      let specOuConversion = false;
      for (; j < gabarit.length; j++) {
        const d = gabarit[j];
        if (d === "!" && !specOuConversion) {
          specOuConversion = true;
          j++;
        } else if (d === ":") specOuConversion = true;
        else if (d === "{") niveau++;
        else if (d === "}" && --niveau === 0) break;
      }
      if (j >= gabarit.length)
        throw valeurErreur(
          specOuConversion ? "unmatched '{' in format spec" : "expected '}' before end of string",
        );
      sortie += rendreChamp(gabarit.slice(i + 1, j), champs, profondeur);
      i = j;
    } else sortie += c;
  }
  return sortie;
}

/** `gabarit.format(**champs)` : erreurs de Python (ValueError, KeyError, IndexError, AttributeError, TypeError) ; pas d'arguments positionnels. */
export function formatPy(gabarit: string, champs: Readonly<Record<string, string>>): string {
  return formater(gabarit, champs, 0);
}

/** Gabarit `str.format` limité à `{tool}`, `{result}` et aux accolades doublées ; tout autre champ lève. */
export function formatGabarit(gabarit: string, champs: Readonly<Record<string, string>>): string {
  return gabarit.replace(/\{\{|\}\}|\{([^{}]*)\}|[{}]/gu, (m, nom: string | undefined) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    if (nom !== undefined && Object.hasOwn(champs, nom)) return champs[nom]!;
    throw new Error(`champ de gabarit non pris en charge : ${m}`);
  });
}
