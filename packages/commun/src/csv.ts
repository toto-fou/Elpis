// SPDX-License-Identifier: MIT
/** packages/commun/src/csv.ts — cellules d'export CSV sûres pour un tableur. */

const DEBUT_FORMULE = /^[=+\-@\t\r]/u;
/** Déclencheur de formule après un séparateur qu'un tableur peut prendre pour le sien (`;` d'un Excel français, `,` pour un fichier en `;`), une tabulation ou un retour, guillemets compris. */
const FORMULE_INTERNE: Readonly<Record<"," | ";", RegExp>> = {
  ",": /([;\t\r\n]"*)(?=[=+\-@\t\r])/gu,
  ";": /([,;\t\r\n]"*)(?=[=+\-@\t\r])/gu,
};

/** Un texte (ou un objet écrit en JSON) qui commence par = + - @ (ou tabulation, retour), ou en contient un après un séparateur ou un retour, reçoit une apostrophe devant : un tableur ne l'exécute jamais comme formule ; les nombres restent des nombres. */
export function sansFormule(valeur: unknown, texte: string, separateur: "," | ";" = ","): string {
  if (typeof valeur === "number" || typeof valeur === "bigint" || typeof valeur === "boolean") return texte;
  const t = texte.replace(FORMULE_INTERNE[separateur], "$1'");
  return DEBUT_FORMULE.test(t) ? `'${t}` : t;
}
