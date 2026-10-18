// SPDX-License-Identifier: MIT
/** apps/core/src/routines/cron.ts — `validate_cron` (scheduling/routes_cron.py) : expression à 5 champs validée en miroir exact de `cronMatches`, 400 sinon. */
import { HttpError, splitPy, stripPy } from "@elpis/commun";

/** Bornes par champ, dans l'ordre de `cronMatches` (jour de semaine : lundi = 1 … dimanche = 7). */
const BORNES: readonly (readonly [string, number, number])[] = [
  ["minute", 0, 59],
  ["heure", 0, 23],
  ["jour du mois", 1, 31],
  ["mois", 1, 12],
  ["jour de semaine", 1, 7],
];

/** `str.partition(sep)` : avant et après la PREMIÈRE occurrence. */
function partition(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

/** Un champ, même précédence que le matcher (`/`, puis `-`, puis `,`, puis entier nu) ; entiers exacts (BigInt) pour les messages. */
function validerChamp(jeton: string, bas: number, haut: number, champ: string): void {
  if (jeton === "*") return;
  const entier = (brut: string): bigint => {
    const s = stripPy(brut);
    if (!/^-?[0-9]+$/u.test(s)) throw new HttpError(400, `Champ cron « ${champ} » invalide : « ${jeton} »`);
    return BigInt(s);
  };
  const dansPlage = (v: bigint): void => {
    if (v < BigInt(bas) || v > BigInt(haut))
      throw new HttpError(400, `Champ cron « ${champ} » hors plage [${bas}-${haut}] : ${v}`);
  };
  if (jeton.includes("/")) {
    const [base, pas] = partition(jeton, "/");
    if (entier(pas) < 1n) throw new HttpError(400, `Champ cron « ${champ} » : pas (step) doit être ≥ 1`);
    if (base !== "*") dansPlage(entier(base));
  } else if (jeton.includes("-")) {
    const [aS, bS] = partition(jeton, "-");
    const a = entier(aS);
    const b = entier(bS);
    dansPlage(a);
    dansPlage(b);
    if (a > b) throw new HttpError(400, `Champ cron « ${champ} » : plage inversée ${a}-${b}`);
  } else if (jeton.includes(",")) {
    const elements = jeton.split(",");
    if (elements.some((p) => p === "")) throw new HttpError(400, `Champ cron « ${champ} » : liste malformée`);
    for (const p of elements) dansPlage(entier(p));
  } else dansPlage(entier(jeton));
}

/** Expression rognée si valide ; un motif que le matcher rejetterait en silence donne un 400. */
export function validateCron(expr: string | null | undefined): string {
  const e = stripPy(expr || "");
  const parties = splitPy(e);
  if (parties.length !== 5)
    throw new HttpError(400, "Expression cron invalide (5 champs requis : min heure jour mois jour-semaine)");
  parties.forEach((jeton, i) => {
    const [champ, bas, haut] = BORNES[i] as readonly [string, number, number];
    validerChamp(jeton, bas, haut, champ);
  });
  return e;
}
