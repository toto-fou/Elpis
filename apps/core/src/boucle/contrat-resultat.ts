// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/contrat-resultat.ts — un résultat d'outil dénote-t-il un échec, et de l'outil lui-même ? Source unique (boucle, compression, sous-agents). */
import { estDict } from "../python";
import type { Dict } from "../python";

const CONSTANTES_PY = ["-Infinity", "Infinity", "NaN"] as const;
const NOMBRE = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y;
const MAX_CHIFFRES_INT = 4300;

/** `json.loads` réduit à la structure : NaN et ±Infinity hors chaîne valent `null`, un entier de plus de 4 300 chiffres lève (comme `int()`). */
function chargerJsonPy(texte: string): unknown {
  if (!/NaN|Infinity|\d{4301}/.test(texte)) return JSON.parse(texte);
  let sortie = "";
  let debut = 0;
  let i = 0;
  while (i < texte.length) {
    const c = texte.charAt(i);
    if (c === '"') {
      i++;
      while (i < texte.length && texte.charAt(i) !== '"') i += texte.charAt(i) === "\\" ? 2 : 1;
      i++;
      continue;
    }
    const constante = CONSTANTES_PY.find((m) => texte.startsWith(m, i));
    if (constante !== undefined) {
      sortie += texte.slice(debut, i) + "null";
      i += constante.length;
      debut = i;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      NOMBRE.lastIndex = i;
      const m = NOMBRE.exec(texte);
      if (m !== null) {
        const entier = m[1] === undefined && m[2] === undefined;
        if (entier && m[0].replace("-", "").length > MAX_CHIFFRES_INT)
          throw new RangeError("Exceeds the limit (4300 digits)");
        i = NOMBRE.lastIndex;
        continue;
      }
    }
    i++;
  }
  return JSON.parse(sortie + texte.slice(debut));
}

function analyser(contenu: unknown): Dict | null {
  if (typeof contenu !== "string") return null;
  let valeur: unknown;
  try {
    valeur = chargerJsonPy(contenu);
  } catch {
    return null;
  }
  return estDict(valeur) ? valeur : null;
}

/** Échec si `{"ok": false, …}` ou `{"error": …}` seul ; tout autre contenu (texte libre, liste, données) est un succès. */
export function resultIsError(resultContent: unknown): boolean {
  const d = analyser(resultContent);
  if (d === null) return false;
  if (Object.hasOwn(d, "ok") && d["ok"] === false) return true;
  return Object.hasOwn(d, "error") && Object.keys(d).length === 1;
}

/** Échec de l'outil lui-même : une commande exécutée au code de sortie non nul (`returncode` sans `error`) n'en est pas un. */
export function resultIsToolFailure(resultContent: unknown): boolean {
  if (!resultIsError(resultContent)) return false;
  const d = analyser(resultContent);
  if (d === null) return true;
  return !(d["ok"] === false && Object.hasOwn(d, "returncode") && !Object.hasOwn(d, "error"));
}
