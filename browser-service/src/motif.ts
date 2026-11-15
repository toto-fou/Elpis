// SPDX-License-Identifier: MIT
/** browser-service/src/motif.ts — expression régulière fournie par l'appelant (url-matches, pw_mock is_regex) : compilée et essayée à part, sous un délai, pour qu'un motif coûteux n'arrête jamais le service. */
import vm from "node:vm";

/** Longueur d'un motif, et durée accordée à sa compilation comme à chacun de ses essais (ms). */
const LONGUEUR_MAX = 2000;
const DELAI_MS = 100;

/** Motif compilé : `test` rend faux si l'essai dépasse son délai (retour arrière sans fin). */
export interface Motif {
  test(texte: string): boolean;
}

const COMPILER = new vm.Script("re = new RegExp(source, drapeaux)");
const ESSAYER = new vm.Script("re.test(texte)");

/** Motif de l'appelant ; lève l'erreur de syntaxe d'un motif invalide ou trop long. */
export function compilerMotif(source: string, drapeaux = ""): Motif {
  if (source.length > LONGUEUR_MAX)
    throw new SyntaxError(`the pattern is longer than ${LONGUEUR_MAX} characters`);
  const bac = vm.createContext({ source, drapeaux, re: null, texte: "" });
  COMPILER.runInContext(bac, { timeout: DELAI_MS });
  return {
    test(texte: string): boolean {
      bac["texte"] = texte;
      try {
        return ESSAYER.runInContext(bac, { timeout: DELAI_MS }) === true;
      } catch {
        return false;
      }
    },
  };
}
