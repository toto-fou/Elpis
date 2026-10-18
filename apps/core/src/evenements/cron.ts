// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/cron.ts — `_cron_matches` : expression à 5 champs comparée à l'heure locale (lundi = 1 … dimanche = 7). */
import { estBlancPy, intPy } from "@elpis/commun";

/** `str.split()` sans séparateur : découpe sur les blancs de Python, sans morceau vide. */
function decouperPy(texte: string): string[] {
  const parties: string[] = [];
  let courant = "";
  for (const c of texte) {
    if (!estBlancPy(c.codePointAt(0) ?? 0)) {
      courant += c;
      continue;
    }
    if (courant !== "") parties.push(courant);
    courant = "";
  }
  if (courant !== "") parties.push(courant);
  return parties;
}

function champCorrespond(motif: string, valeur: number): boolean {
  if (motif === "*") return true;
  if (motif.includes("/")) {
    const pas = intPy(motif.split("/")[1] ?? "");
    if (pas === 0) return false;
    return valeur % pas === 0;
  }
  if (motif.includes("-")) {
    const bornes = motif.split("-");
    if (bornes.length !== 2) return false;
    return intPy(bornes[0]) <= valeur && valeur <= intPy(bornes[1]);
  }
  if (motif.includes(","))
    return motif
      .split(",")
      .map((x) => intPy(x))
      .includes(valeur);
  return intPy(motif) === valeur;
}

/** Jamais d'erreur : un motif illisible (non numérique, pas nul, plage malformée) ne correspond pas. */
export function cronMatches(expr: string, maintenant: Date): boolean {
  const parties = decouperPy(expr);
  if (parties.length !== 5) return false;
  const valeurs = [
    maintenant.getMinutes(),
    maintenant.getHours(),
    maintenant.getDate(),
    maintenant.getMonth() + 1,
    ((maintenant.getDay() + 6) % 7) + 1,
  ];
  for (let i = 0; i < 5; i++) {
    try {
      if (!champCorrespond(parties[i] as string, valeurs[i] as number)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
