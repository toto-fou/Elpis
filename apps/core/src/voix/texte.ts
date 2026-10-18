// SPDX-License-Identifier: MIT
/** apps/core/src/voix/texte.ts — réponse markdown ramenée à un texte prononçable (code et tableaux annoncés, liens, émojis, symboles), coupée à une fin de phrase. */
import { compilerRe, echapperPy, estAlnumPy, longueurPy, prefixePy, rfindPy, stripPy } from "@elpis/commun";

export const ANNONCE_CODE = "Bloc de code.";
export const ANNONCE_TABLEAU = "Tableau.";

type Remplacement = string | ((m: string, g1: string | undefined) => string);

/** Motif de `re` de Python (sémantique exacte), parcouru en entier comme `re.sub`. */
function motif(source: string): RegExp {
  const r = compilerRe(source);
  return new RegExp(r.source, r.flags + "g");
}

const groupe1 = (suffixe: string) => (_m: string, g1: string | undefined) => (g1 ?? "") + suffixe;

const REMPLACEMENTS: readonly (readonly [RegExp, Remplacement])[] = [
  [motif("(?i)<think>[\\s\\S]*?</think>"), " "],
  [motif("```[\\s\\S]*?```"), ` ${ANNONCE_CODE} `],
  [motif("```[\\s\\S]*$"), ` ${ANNONCE_CODE} `],
  [motif("~~~[\\s\\S]*?~~~"), ` ${ANNONCE_CODE} `],
  [motif("`([^`]*)`"), groupe1("")],
  [motif("!\\[[^\\]]*\\]\\([^)]*\\)"), " "],
  [motif("\\[([^\\]]*)\\]\\([^)]*\\)"), groupe1("")],
  [motif("</?[A-Za-z][\\w:-]*(?:\\s[^<>\\n]{0,200})?/?>"), " "],
  [motif("(?m)^\\s{0,3}#{1,6}\\s*"), ""],
  [motif("(?m)^\\s{0,3}>\\s?"), ""],
  [motif("(?m)^\\s{0,3}[-*+]\\s+"), ""],
  [motif("(?m)^\\s{0,3}\\d{1,3}[.)]\\s+"), ""],
  [motif("(?m)^\\s*\\|[-:\\s|]+\\|\\s*$"), " "],
  [motif("(?m)^\\s*\\|.*\\|\\s*$"), ` ${ANNONCE_TABLEAU} `],
  [motif("~~([^~]+)~~"), groupe1("")],
  [motif("\\*\\*([^*]+)\\*\\*"), groupe1("")],
  [motif("(?<!\\w)[*_]([^*_\\n]+)[*_](?!\\w)"), groupe1("")],
  [motif("(?m)^\\s*[-*_]{3,}\\s*$"), " "],
  [motif("\\[\\^[^\\]]*\\]"), " "],
  [motif("[\u{1F000}-\u{1FAFF}☀-➿⌀-⏿⬀-⯿️‍⃣]"), " "],
];

const PRONONCIATION: readonly (readonly [RegExp, Remplacement])[] = [
  [motif("(\\d)\\s*°C"), groupe1(" degrés")],
  [motif("(\\d)\\s*%"), groupe1(" pour cent")],
  [motif("(?<=\\d)\\s*€"), " euros"],
  [motif("(?<=\\d)\\s*\\$"), " dollars"],
  [motif("(?<=\\s)&(?=\\s)"), " et "],
  [motif("\\s*(?:-->|->|=>)\\s*"), " vers "],
  [motif("[•▪●▸→←]"), " "],
  [motif("(?<![\\w@])(?:https?://|www\\.)\\S+"), " lien "],
];

const ANNONCES_REPETEES: readonly (readonly [string, RegExp])[] = [ANNONCE_CODE, ANNONCE_TABLEAU].map(
  (a) => [a, motif(`${echapperPy(a)}(?:\\s+${echapperPy(a)})+`)] as const,
);

const ESPACES = motif("\\s+");
const PONCTUATION_ORPHELINE = motif("\\s+([,.])");

function appliquer(texte: string, re: RegExp, r: Remplacement): string {
  re.lastIndex = 0;
  return typeof r === "string" ? texte.replace(re, () => r) : texte.replace(re, r);
}

/** `pour_la_voix` : nettoyage puis, si `maxChars` > 0, coupe à la dernière fin de phrase au-delà du tiers du plafond. */
export function pourLaVoix(texte: string | null | undefined, maxChars = 0): string {
  if (!texte) return "";
  let sortie = texte;
  for (const [re, r] of REMPLACEMENTS) sortie = appliquer(sortie, re, r);
  for (const [re, r] of PRONONCIATION) sortie = appliquer(sortie, re, r);
  for (const [annonce, re] of ANNONCES_REPETEES) sortie = appliquer(sortie, re, annonce);
  sortie = appliquer(sortie, ESPACES, " ");
  sortie = stripPy(appliquer(sortie, PONCTUATION_ORPHELINE, groupe1("")));
  if (maxChars && longueurPy(sortie) > maxChars) {
    const tronque = prefixePy(sortie, maxChars);
    const coupe = Math.max(rfindPy(tronque, ". "), rfindPy(tronque, "! "), rfindPy(tronque, "? "));
    sortie = stripPy(coupe > Math.floor(maxChars / 3) ? prefixePy(tronque, coupe + 1) : tronque);
  }
  return sortie;
}

/** Reste-t-il à dire : au moins deux caractères dont un alphanumérique. */
export function estPrononcable(texte: string | null | undefined): boolean {
  const nu = stripPy(texte ?? "");
  if (longueurPy(nu) < 2) return false;
  for (const c of nu) if (estAlnumPy(c)) return true;
  return false;
}
