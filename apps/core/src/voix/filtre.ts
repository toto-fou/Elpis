// SPDX-License-Identifier: MIT
/** apps/core/src/voix/filtre.ts — transcriptions inventées par whisper sur du silence : génériques de vidéo, formules courtes douteuses, descriptions sonores, boucles. */
import { casefoldPy, compilerRe, estAlnumPy, longueurPy, sansAccentsPy, stripPy } from "@elpis/commun";

const HALLUCINATIONS: ReadonlySet<string> = new Set(
  [
    "merci d'avoir regarde cette video.",
    "merci d'avoir regarde cette video !",
    "merci d'avoir regarde cette video",
    "sous-titres realises par la communaute d'amara.org",
    "sous-titres realises para la communaute d'amara.org",
    "sous-titrage societe radio-canada",
    "sous-titrage mfp.",
    "* * *",
    "...",
    ". . .",
    "[musique]",
    "[applaudissements]",
    "(musique)",
    "you",
    "thank you.",
    "thanks for watching!",
    "amara.org",
    "abonnez-vous !",
  ].map(casefoldPy),
);

const FORMULES_COURTES: ReadonlySet<string> = new Set([
  "merci",
  "merci beaucoup",
  "merci a tous",
  "au revoir",
  "a bientot",
  "a tres vite",
  "c est parti",
  "bonne journee",
  "bonne soiree",
]);

const SILENCE_DOUTEUX = 0.5;
const LOGPROB_DOUTEUX = -0.5;
const ENVELOPPES: readonly (readonly [string, string])[] = [
  ["*", "*"],
  ["[", "]"],
  ["(", ")"],
  ["<", ">"],
];
const MOTS_MINIMUM_POUR_JUGER = 6;
const DIVERSITE_MINIMALE = 0.34;

function mots(texte: string): string[] {
  const re = compilerRe("\\w+");
  return texte.match(new RegExp(re.source, re.flags + "g")) ?? [];
}

function estEnveloppe(texte: string): boolean {
  return ENVELOPPES.some(([o, f]) => texte.startsWith(o) && texte.endsWith(f) && longueurPy(texte) > 1);
}

/** Une transcription d'au moins six mots dont le vocabulaire se répète (diversité ≤ 0,34) est une boucle de décodage. */
function boucle(texte: string): boolean {
  const m = mots(casefoldPy(texte));
  if (m.length < MOTS_MINIMUM_POUR_JUGER) return false;
  return new Set(m).size / m.length <= DIVERSITE_MINIMALE;
}

function forme(texte: string): string {
  return mots(casefoldPy(sansAccentsPy(texte)).replaceAll("_", " ")).join(" ");
}

function signalDouteux(avgLogprob: number | null, noSpeechProb: number | null): boolean {
  if (avgLogprob === null && noSpeechProb === null) return true;
  if (noSpeechProb !== null && noSpeechProb >= SILENCE_DOUTEUX) return true;
  return avgLogprob !== null && avgLogprob < LOGPROB_DOUTEUX;
}

/** `est_bruit` : vide, ponctuation seule, son décrit, hallucination connue, formule courte sur un signal douteux, ou boucle. */
export function estBruit(
  texte: string | null | undefined,
  avgLogprob: number | null = null,
  noSpeechProb: number | null = null,
): boolean {
  const nu = stripPy(texte ?? "");
  if (longueurPy(nu) < 2) return true;
  if (![...nu].some(estAlnumPy)) return true;
  if (estEnveloppe(nu)) return true;
  if (HALLUCINATIONS.has(casefoldPy(sansAccentsPy(nu)))) return true;
  if (FORMULES_COURTES.has(forme(nu))) return signalDouteux(avgLogprob, noSpeechProb);
  return boucle(nu);
}
