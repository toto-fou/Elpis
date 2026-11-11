// SPDX-License-Identifier: MIT
/** apps/core/src/tour/fichiers-joints.ts — blocs `--- FILE: nom --- … --- END FILE ---` retirés d'un message en temps linéaire (titre du chat). */
import { estBlancPy } from "@elpis/commun";

function apresBlancs(s: string, i: number): number {
  while (i < s.length && estBlancPy(s.charCodeAt(i))) i++;
  return i;
}

/** Fin (blancs suivants compris) du pied `--- END FILE ---` commencé en `i`, -1 sinon. */
function finPied(s: string, i: number): number {
  const apres = apresBlancs(s, i + 3);
  if (!s.startsWith("END FILE", apres)) return -1;
  const tirets = apresBlancs(s, apres + 8);
  return s.startsWith("---", tirets) ? apresBlancs(s, tirets + 3) : -1;
}

/** Fins possibles de l'en-tête commencé en `a` : `nom` vide fait de blancs (`courte`) ou nom jusqu'aux tirets suivants de sa ligne (`longue`) ; -1 si impossible. */
function finsEnTete(s: string, a: number): { courte: number; longue: number } {
  const fichier = apresBlancs(s, a + 3);
  if (!s.startsWith("FILE:", fichier)) return { courte: -1, longue: -1 };
  const blancs = fichier + 5;
  const nom = apresBlancs(s, blancs);
  let courte = -1;
  if (s.startsWith("---", nom))
    for (let i = blancs; i < nom && courte < 0; i++) if (s[i] !== "\n") courte = nom + 3;
  let longue = -1;
  const tirets = s.indexOf("---", nom + 1);
  if (tirets >= 0) {
    let ligne = nom;
    while (ligne < tirets && s[ligne] !== "\n") ligne++;
    if (apresBlancs(s, ligne) >= tirets) longue = tirets + 3;
  }
  return { courte, longue };
}

/** Texte sans ses blocs de fichiers joints (un en-tête sans pied reste) ; pieds cherchés à positions croissantes, une seule fois chacun. */
export function retirerFichiersJoints(s: string): string {
  let sortie = "";
  let copie = 0;
  let pied = -1;
  let finDuPied = -1;
  let epuise = false;
  const finPiedDepuis = (x: number): number => {
    if (pied >= x) return finDuPied;
    if (epuise) return -1;
    for (let f = s.indexOf("---", x); f >= 0; f = s.indexOf("---", f + 1)) {
      const fin = finPied(s, f);
      if (fin >= 0) {
        pied = f;
        finDuPied = fin;
        return fin;
      }
    }
    epuise = true;
    return -1;
  };
  for (let a = s.indexOf("---"); a >= 0;) {
    const { courte, longue } = finsEnTete(s, a);
    const parCourte = courte >= 0 ? finPiedDepuis(courte) : -1;
    const parLongue = longue >= 0 ? finPiedDepuis(longue) : -1;
    const fin = parLongue >= 0 ? parLongue : parCourte;
    if (fin < 0) {
      a = s.indexOf("---", a + 1);
      continue;
    }
    sortie += s.slice(copie, a);
    copie = fin;
    a = s.indexOf("---", fin);
  }
  return sortie + s.slice(copie);
}
