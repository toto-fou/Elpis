// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/texte.ts — `str.title()` de Python et texte JSON de `pydantic_core.to_json` (résultats des outils). */
import { clesOrdonnees, ErreurPython, estDict, FlottantPy, lowerPy, reprFlottant } from "@elpis/commun";

const CASSE = /\p{Cased}/u;

/** Titres qui ne sont pas la majuscule (Unicode 15, `c.title() != c.upper()`). */
const TITRES = new Map<number, string>([
  [0xdf, "Ss"],
  [0x587, "Եւ"],
  [0xfb00, "Ff"],
  [0xfb01, "Fi"],
  [0xfb02, "Fl"],
  [0xfb03, "Ffi"],
  [0xfb04, "Ffl"],
  [0xfb05, "St"],
  [0xfb06, "St"],
  [0xfb13, "Մն"],
  [0xfb14, "Մե"],
  [0xfb15, "Մի"],
  [0xfb16, "Վն"],
  [0xfb17, "Մխ"],
  [0x1fb2, "Ὰͅ"],
  [0x1fb3, "ᾼ"],
  [0x1fb4, "Άͅ"],
  [0x1fb7, "ᾼ͂"],
  [0x1fbc, "ᾼ"],
  [0x1fc2, "Ὴͅ"],
  [0x1fc3, "ῌ"],
  [0x1fc4, "Ήͅ"],
  [0x1fc7, "ῌ͂"],
  [0x1fcc, "ῌ"],
  [0x1ff2, "Ὼͅ"],
  [0x1ff3, "ῼ"],
  [0x1ff4, "Ώͅ"],
  [0x1ff7, "ῼ͂"],
  [0x1ffc, "ῼ"],
]);

function titreCaractere(c: string): string {
  const p = c.codePointAt(0) ?? 0;
  const special = TITRES.get(p);
  if (special !== undefined) return special;
  if (p >= 0x1c4 && p <= 0x1cc) return String.fromCodePoint(p - ((p - 0x1c4) % 3) + 1);
  if (p >= 0x1f1 && p <= 0x1f3) return "ǲ";
  if ((p >= 0x10d0 && p <= 0x10fa) || (p >= 0x10fd && p <= 0x10ff)) return c;
  if (p >= 0x1f80 && p <= 0x1faf) return String.fromCodePoint(p | 0x8);
  return c.toUpperCase();
}

/** `str.title()` : titre après un caractère sans casse, minuscule sinon. */
export function titlePy(s: string): string {
  let sortie = "";
  let precedentCasse = false;
  for (const c of s) {
    sortie += precedentCasse ? lowerPy(c) : titreCaractere(c);
    precedentCasse = CASSE.test(c);
  }
  return sortie;
}

/** `repr(float)` avec l'exposant négatif sans zéro de tête (`1e-7`), comme serde_json dans pydantic-core. */
function flottantPydantic(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  return reprFlottant(x).replace(/e-0+(\d)/u, "e-$1");
}

function chainePydantic(s: string): string {
  if (!s.isWellFormed())
    throw new ErreurPython("ValueError", "'utf-8' codec can't encode character: surrogates not allowed");
  let sortie = '"';
  for (const c of s) {
    const p = c.codePointAt(0) ?? 0;
    if (c === '"') sortie += '\\"';
    else if (c === "\\") sortie += "\\\\";
    else if (c === "\n") sortie += "\\n";
    else if (c === "\r") sortie += "\\r";
    else if (c === "\t") sortie += "\\t";
    else if (c === "\b") sortie += "\\b";
    else if (c === "\f") sortie += "\\f";
    else if (p < 0x20) sortie += "\\u" + p.toString(16).padStart(4, "0");
    else sortie += c;
  }
  return sortie + '"';
}

/** `pydantic_core.to_json(v, fallback=str)` : compact, non-ASCII brut, flottants marqués par `FlottantPy` ou non entiers. */
export function jsonPydantic(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (v instanceof FlottantPy) return flottantPydantic(v.valeur);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : flottantPydantic(v);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return chainePydantic(v);
  if (Array.isArray(v)) return `[${v.map((x) => jsonPydantic(x)).join(",")}]`;
  if (estDict(v))
    return `{${clesOrdonnees(v)
      .map((k) => `${chainePydantic(k)}:${jsonPydantic(v[k])}`)
      .join(",")}}`;
  return chainePydantic(String(v));
}
