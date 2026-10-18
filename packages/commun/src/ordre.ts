// SPDX-License-Identifier: MIT
/** packages/commun/src/ordre.ts — ordre d'insertion Python des clés qu'un objet JS range autrement (clés entières en tête). */

const ordresDesCles = new WeakMap<object, { liste: string[]; vues: Set<string> }>();
const INDEX_TABLEAU = /^(?:0|[1-9][0-9]{0,9})$/;

/** Clé que JS range avant les autres (index de tableau) : seule cause d'un écart d'ordre avec un `dict` Python. */
export function estCleEntiere(cle: string): boolean {
  const c = cle.charCodeAt(0);
  return c >= 0x30 && c <= 0x39 && INDEX_TABLEAU.test(cle) && Number(cle) < 4294967295;
}

/** Retient l'ordre d'insertion Python de `cles` si JS le perdrait. */
export function noterOrdreDesCles(objet: object, cles: readonly string[]): void {
  if (cles.some(estCleEntiere)) ordresDesCles.set(objet, { liste: [...cles], vues: new Set(cles) });
}

/** Avant l'ajout de `cle` : la place Python d'une nouvelle clé est la dernière, même entière. */
export function noterCleAjoutee(objet: object, cle: string): void {
  if (Object.hasOwn(objet, cle)) return;
  const ordre = ordresDesCles.get(objet);
  if (ordre !== undefined) {
    if (ordre.vues.has(cle)) ordre.liste.splice(ordre.liste.indexOf(cle), 1);
    ordre.liste.push(cle);
    ordre.vues.add(cle);
  } else if (estCleEntiere(cle)) {
    const cles = Object.keys(objet);
    if (cles.length > 0) noterOrdreDesCles(objet, [...cles, cle]);
  }
}

/** Clés dans l'ordre Python : l'ordre retenu (clés encore présentes), puis celles ajoutées sans `poserCle`. */
export function clesOrdonnees(objet: object): readonly string[] {
  const cles = Object.keys(objet);
  const ordre = ordresDesCles.get(objet);
  if (ordre === undefined) return cles;
  const presentes = new Set(cles);
  const sortie = ordre.liste.filter((cle) => presentes.has(cle));
  for (const cle of cles) if (!ordre.vues.has(cle)) sortie.push(cle);
  return sortie;
}
