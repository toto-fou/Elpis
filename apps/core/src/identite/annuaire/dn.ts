// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/dn.ts — forme normalisée d'un DN (blancs autour des séparateurs retirés, casse ignorée) pour comparer deux DN. */

/** DN en minuscules, sans blanc autour des virgules ni des signes égal ; les virgules échappées restent dans leur valeur. */
export function dnNormalise(dn: string): string {
  const rdns: string[] = [];
  let courant = "";
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i] as string;
    if (c === "\\") {
      courant += c + (dn[i + 1] ?? "");
      i++;
    } else if (c === ",") {
      rdns.push(courant);
      courant = "";
    } else courant += c;
  }
  rdns.push(courant);
  return rdns
    .map((r) => {
      const i = r.indexOf("=");
      if (i < 0) return r.trim().toLowerCase();
      return `${r.slice(0, i).trim()}=${r.slice(i + 1).trim()}`.toLowerCase();
    })
    .join(",");
}

/** Vrai si les deux DN sont les mêmes une fois normalisés. */
export function memeDn(a: string, b: string): boolean {
  return dnNormalise(a) === dnNormalise(b);
}
