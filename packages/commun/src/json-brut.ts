// SPDX-License-Identifier: MIT
/** packages/commun/src/json-brut.ts — `JSONDecoder.raw_decode` et `json.loads` à `JSONDecodeError` (lecture des appels d'outils écrits en texte). */
import { poserCle } from "./dict";
import { FlottantPy } from "./json";
import { ErreurPython } from "./python";

/** `json.JSONDecodeError` : seul échec de lecture que les stratégies rattrapent (un entier de plus de 4 300 chiffres lève `ValueError`). */
export class JSONDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JSONDecodeError";
  }
}

const BLANC_JSON = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

const NOMBRE_JSON = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;

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

/** `JSONDecoder.raw_decode(texte, idx)` : une valeur JSON qui commence exactement à `debut` (indices en unités UTF-16). */
export function rawDecodePy(t: string, debut: number): [unknown, number] {
  let i = debut;
  const echec = (message: string): never => {
    throw new JSONDecodeError(message);
  };
  const blancs = (): void => {
    while (i < t.length && BLANC_JSON(t.charCodeAt(i))) i++;
  };
  const chaine = (): string => {
    let sortie = "";
    for (i++; ;) {
      if (i >= t.length) echec("Unterminated string");
      const code = t.charCodeAt(i);
      if (code === 0x22) {
        i++;
        return sortie;
      }
      if (code < 0x20) echec("Invalid control character");
      if (code !== 0x5c) {
        sortie += t[i++];
        continue;
      }
      const e = t[i + 1] ?? "";
      if (e === "u") {
        const hex = t.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/u.test(hex)) echec("Invalid \\uXXXX escape");
        sortie += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        const c = ECHAPPEMENTS[e];
        if (c === undefined) echec("Invalid \\escape");
        sortie += c;
        i += 2;
      }
    }
  };
  const valeur = (): unknown => {
    const c = t[i];
    if (c === '"') return chaine();
    if (c === "{" || c === "[") {
      const objet = c === "{";
      const v: unknown[] | Record<string, unknown> = objet ? {} : [];
      i++;
      blancs();
      if (t[i] === (objet ? "}" : "]")) {
        i++;
        return v;
      }
      for (;;) {
        if (objet) {
          if (t[i] !== '"') echec("Expecting property name enclosed in double quotes");
          const cle = chaine();
          blancs();
          if (t[i] !== ":") echec("Expecting ':' delimiter");
          i++;
          blancs();
          poserCle(v, cle, valeur());
        } else {
          (v as unknown[]).push(valeur());
        }
        blancs();
        if (t[i] === ",") {
          i++;
          blancs();
          continue;
        }
        if (t[i] === (objet ? "}" : "]")) {
          i++;
          return v;
        }
        echec("Expecting ',' delimiter");
      }
    }
    for (const [mot, v] of [
      ["null", null],
      ["true", true],
      ["false", false],
      ["NaN", new FlottantPy(NaN)],
      ["Infinity", new FlottantPy(Infinity)],
      ["-Infinity", new FlottantPy(-Infinity)],
    ] as const) {
      if (t.startsWith(mot, i)) {
        i += mot.length;
        return v;
      }
    }
    NOMBRE_JSON.lastIndex = i;
    const m = NOMBRE_JSON.exec(t);
    if (!m) return echec("Expecting value");
    i = NOMBRE_JSON.lastIndex;
    if (m[1] === undefined && m[2] === undefined) {
      if (m[0].replace("-", "").length > 4300)
        throw new ErreurPython("ValueError", "Exceeds the limit (4300 digits) for integer string conversion");
      const n = Number(m[0]);
      return Number.isSafeInteger(n) ? n + 0 : BigInt(m[0]);
    }
    const f = Number(m[0]);
    return Number.isInteger(f) || !Number.isFinite(f) ? new FlottantPy(f) : f;
  };
  const v = valeur();
  return [v, i];
}

/** `json.loads(texte)` : blancs JSON autour, rien après (un BOM en tête n'est pas une valeur). */
export function jsonLoads(texte: string): unknown {
  let i = 0;
  while (i < texte.length && BLANC_JSON(texte.charCodeAt(i))) i++;
  const [v, fin] = rawDecodePy(texte, i);
  let j = fin;
  while (j < texte.length && BLANC_JSON(texte.charCodeAt(j))) j++;
  if (j !== texte.length) throw new JSONDecodeError("Extra data");
  return v;
}
