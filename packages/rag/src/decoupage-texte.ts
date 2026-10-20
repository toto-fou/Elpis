// SPDX-License-Identifier: MIT
/** packages/rag/src/decoupage-texte.ts — coupes de texte brut avec positions : taille, phrases, lignes, tableau, sections Markdown, séparateur, regex bornée. */
import { createContext, runInContext } from "node:vm";

import { ErreurRag } from "./erreurs";

/** Tranche `[debut, fin)` d'un texte. */
export interface Morceau {
  debut: number;
  fin: number;
}

const BLANC = /\s/;
const FIN_DE_PHRASE = /(?<=[.!?…])\s+/g;
const ENTETE_MARKDOWN = /^[ \t]*#{1,6}\s/;
const FENCE = /^[ \t]*(```|~~~)/;
const SEPARATEUR_MARKDOWN = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const MOTIF_LONGUEUR_MAX = 500;
const CORRESPONDANCES_MAX = 200_000;
const DELAI_REGEX_MS = 2_000;

function estBlanc(c: string | undefined): boolean {
  return c !== undefined && BLANC.test(c);
}

function estSubstitutHaut(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Refuse un découpage dont le nombre minimal de morceaux dépasse la borne (taille minuscule sur un texte énorme). */
export function verifierBorne(longueur: number, pas: number, maxPassages: number): void {
  if (longueur / Math.max(1, pas) > maxPassages) {
    throw new ErreurRag(
      "trop_de_passages",
      `découpage refusé : plus de ${maxPassages} passages pour ${longueur} caractères (taille trop petite)`,
    );
  }
}

/** Coupe par taille en caractères : fin sur un blanc si possible, chevauchement sur un début de mot, progression stricte. */
export function decouperParTaille(
  texte: string,
  taille: number,
  chevauchement: number,
  maxPassages: number,
): Morceau[] {
  const t = Math.max(1, Math.floor(taille));
  const chev = Math.max(0, Math.min(Math.floor(chevauchement), Math.floor(t / 2)));
  const n = texte.length;
  verifierBorne(n, t - chev, maxPassages);
  const sortie: Morceau[] = [];
  let debut = 0;
  while (debut < n) {
    let fin = Math.min(n, debut + t);
    if (fin < n) {
      if (estSubstitutHaut(texte.charCodeAt(fin - 1)) && fin - 1 > debut) fin--;
      if (!estBlanc(texte[fin])) {
        let b = fin - 1;
        while (b > debut && !estBlanc(texte[b])) b--;
        if (b > debut) fin = b;
      }
    }
    sortie.push({ debut, fin });
    if (fin >= n) break;
    debut = debutDeMot(texte, Math.max(debut + 1, fin - chev), fin);
  }
  return sortie;
}

/** Premier début de mot dans `[depuis, fin)` ; `fin` s'il n'y en a pas (pas de chevauchement au milieu d'un mot géant). */
function debutDeMot(texte: string, depuis: number, fin: number): number {
  if (depuis >= fin) return fin;
  if (estBlanc(texte[depuis - 1]) || estBlanc(texte[depuis])) {
    let i = depuis;
    while (i < fin && estBlanc(texte[i])) i++;
    return i;
  }
  for (let i = depuis; i < fin; i++) {
    if (estBlanc(texte[i])) {
      let j = i;
      while (j < fin && estBlanc(texte[j])) j++;
      return j;
    }
  }
  return fin;
}

/** Phrases (fin après `. ! ? …` et blancs), chaque phrase gardant ses blancs finaux. */
function phrases(texte: string): Morceau[] {
  const sortie: Morceau[] = [];
  let precedent = 0;
  for (const m of texte.matchAll(FIN_DE_PHRASE)) {
    const fin = m.index + m[0].length;
    sortie.push({ debut: precedent, fin });
    precedent = fin;
  }
  if (precedent < texte.length) sortie.push({ debut: precedent, fin: texte.length });
  return sortie;
}

/** Coupe par phrases regroupées jusqu'à la cible, chevauchement en phrases entières ; repli sur la taille sans ponctuation. */
export function decouperParPhrases(
  texte: string,
  cible: number,
  chevauchement: number,
  maxPassages: number,
): Morceau[] {
  const ph = phrases(texte);
  if (ph.length <= 1) return decouperParTaille(texte, cible, chevauchement, maxPassages);
  verifierBorne(texte.length, Math.max(1, cible - chevauchement), maxPassages);
  const sortie: Morceau[] = [];
  let i = 0;
  while (i < ph.length) {
    const debut = ph[i]?.debut ?? 0;
    let fin = ph[i]?.fin ?? 0;
    let j = i + 1;
    while (j < ph.length && (ph[j]?.fin ?? 0) - debut < cible) {
      fin = ph[j]?.fin ?? fin;
      j++;
    }
    sortie.push({ debut, fin });
    if (j >= ph.length) break;
    const departChevauchement = Math.max(0, fin - chevauchement);
    let k = i;
    while (k < j && (ph[k]?.fin ?? 0) <= departChevauchement) k++;
    i = Math.max(k, i + 1);
  }
  return sortie;
}

interface Ligne {
  debut: number;
  fin: number;
}

function lignes(texte: string): Ligne[] {
  const sortie: Ligne[] = [];
  let debut = 0;
  while (debut <= texte.length) {
    const nl = texte.indexOf("\n", debut);
    const fin = nl === -1 ? texte.length : nl;
    sortie.push({ debut, fin });
    if (nl === -1) break;
    debut = nl + 1;
  }
  return sortie;
}

/** Coupe par lignes entières regroupées jusqu'à la cible (listes, code) ; une ligne plus longue que la cible est coupée par taille. */
export function decouperParLignes(texte: string, cible: number, maxPassages: number): Morceau[] {
  const sortie: Morceau[] = [];
  let courant: Morceau | null = null;
  for (const l of lignes(texte)) {
    if (l.fin - l.debut > cible) {
      if (courant) sortie.push(courant);
      courant = null;
      for (const m of decouperParTaille(texte.slice(l.debut, l.fin), cible, 0, maxPassages)) {
        sortie.push({ debut: l.debut + m.debut, fin: l.debut + m.fin });
      }
      continue;
    }
    if (courant && l.fin - courant.debut > cible) {
      sortie.push(courant);
      courant = null;
    }
    courant = courant ? { debut: courant.debut, fin: l.fin } : { debut: l.debut, fin: l.fin };
  }
  if (courant) sortie.push(courant);
  return sortie;
}

export interface MorceauTableau {
  debut: number;
  fin: number;
  texte: string;
}

/** Coupe un tableau par lignes en répétant l'en-tête (première ligne, et la ligne de tirets Markdown si elle suit) dans chaque morceau. */
export function decouperTableau(texte: string, cible: number): MorceauTableau[] {
  const ls = lignes(texte);
  const brut = (l: Ligne): string => texte.slice(l.debut, l.fin);
  const deuxieme = ls[1];
  const aSeparateur = deuxieme !== undefined && SEPARATEUR_MARKDOWN.test(brut(deuxieme));
  const nbEntete = Math.min(ls.length, aSeparateur ? 2 : 1);
  const entete = ls.slice(0, nbEntete).map(brut).join("\n");
  const corps = ls.slice(nbEntete).filter((l) => l.fin > l.debut);
  if (corps.length === 0) return [{ debut: 0, fin: texte.length, texte }];
  const sortie: MorceauTableau[] = [];
  let groupe: Ligne[] = [];
  let taille = entete.length;
  const vider = (): void => {
    const premier = groupe[0];
    const dernier = groupe[groupe.length - 1];
    if (!premier || !dernier) return;
    const tete = sortie.length === 0 ? 0 : premier.debut;
    sortie.push({ debut: tete, fin: dernier.fin, texte: `${entete}\n${groupe.map(brut).join("\n")}` });
    groupe = [];
    taille = entete.length;
  };
  for (const l of corps) {
    if (groupe.length > 0 && taille + 1 + (l.fin - l.debut) > cible) vider();
    groupe.push(l);
    taille += 1 + (l.fin - l.debut);
  }
  vider();
  return sortie;
}

/** Débuts de sections Markdown (lignes `#`, hors blocs de code balisés) ; `extra` : débuts supplémentaires (titres de l'extracteur). */
export function debutsMarkdown(texte: string, extra: readonly number[]): number[] {
  const debuts = new Set<number>(extra);
  let dansCode = false;
  for (const l of lignes(texte)) {
    const ligne = texte.slice(l.debut, l.fin);
    if (FENCE.test(ligne)) {
      dansCode = !dansCode;
      continue;
    }
    if (!dansCode && ENTETE_MARKDOWN.test(`${ligne}\n`)) debuts.add(l.debut);
  }
  return [...debuts].sort((a, b) => a - b);
}

/** Morceaux délimités par des débuts (le premier morceau commence à 0, le dernier finit au bout du texte). */
export function parDebuts(longueur: number, debuts: readonly number[]): Morceau[] {
  const bornes = [0, ...debuts.filter((d) => d > 0 && d < longueur), longueur];
  const sortie: Morceau[] = [];
  for (let i = 0; i + 1 < bornes.length; i++) {
    sortie.push({ debut: bornes[i] ?? 0, fin: bornes[i + 1] ?? longueur });
  }
  return sortie;
}

/** Séquences d'échappement usuelles saisies dans un champ texte (`\n`, `\t`, `\r`, `\\`). */
export function desechapper(valeur: string): string {
  return valeur.replace(/\\([ntr\\])/g, (_m, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : "\\",
  );
}

/** Morceaux du séparateur : chaque morceau après le premier garde le séparateur en tête, les morceaux vides sont ignorés. */
export function parSeparateur(texte: string, separateur: string): Morceau[] {
  const sortie: Morceau[] = [];
  let position = 0;
  for (const partie of texte.split(separateur)) {
    const debutPartie = position;
    position += partie.length + separateur.length;
    if (partie.trim() === "") continue;
    const avecSeparateur = sortie.length > 0 && debutPartie >= separateur.length;
    sortie.push({
      debut: avecSeparateur ? debutPartie - separateur.length : debutPartie,
      fin: debutPartie + partie.length,
    });
  }
  return sortie;
}

/** Erreur de syntaxe levée dans le contexte `vm`, d'un autre royaume : `instanceof Error` y est faux, seul le nom compte. */
function estErreurSyntaxe(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "SyntaxError";
}

/** Débuts des correspondances d'un motif (indicateurs `gmu` puis `gm`), dans un contexte à délai : `null` si motif invalide, trop long ou trop lent. */
export function debutsRegex(motif: string, texte: string): number[] | null {
  if (motif === "" || motif.length > MOTIF_LONGUEUR_MAX) return null;
  for (const indicateurs of ["gmu", "gm"]) {
    try {
      const contexte = createContext({
        motif,
        texte,
        indicateurs,
        max: CORRESPONDANCES_MAX,
        sortie: [] as number[],
      });
      runInContext(
        "const re = new RegExp(motif, indicateurs); let m; " +
          "while ((m = re.exec(texte)) !== null && sortie.length < max) { sortie.push(m.index); if (m[0].length === 0) re.lastIndex++; }",
        contexte,
        { timeout: DELAI_REGEX_MS },
      );
      return Array.from(contexte.sortie);
    } catch (e) {
      if (estErreurSyntaxe(e)) continue;
      return null;
    }
  }
  return null;
}
