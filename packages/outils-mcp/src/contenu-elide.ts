// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/contenu-elide.ts — marqueur d'un contenu d'écriture condensé dans la vue du modèle : émis par le core (élagage H-04), refusé à l'écriture par l'hôte d'outils. */
import { createHash } from "node:crypto";

import { longueurPy, utf8Remplace } from "@elpis/commun";

const RE_CONTENU_ELIDE = /\[content elided: \d+ chars, sha256 [0-9a-f]{12}/u;
const RE_CONTENU_ELIDE_ENTIER =
  /^\[content elided: \d+ chars, sha256 [0-9a-f]{12} — re-read the file if needed\]$/u;

/** Remplaçant d'un long champ : taille en points de code et sha256 court (12 hex) de son texte. */
export function contenuElide(v: string): string {
  const sha = createHash("sha256").update(utf8Remplace(v)).digest("hex").slice(0, 12);
  return `[content elided: ${longueurPy(v)} chars, sha256 ${sha} — re-read the file if needed]`;
}

/** Vrai si `v` est, aux blancs près, le marqueur entier que l'élagage pose à la place d'un champ (refusé à l'écriture). */
export function estContenuElide(v: unknown): boolean {
  return typeof v === "string" && v.includes("[content elided: ") && RE_CONTENU_ELIDE_ENTIER.test(v.trim());
}

/** Vrai si `v` est un texte qui contient le marqueur exact `[content elided: <N> chars, sha256 <hex>`. */
export function contientContenuElide(v: unknown): boolean {
  return typeof v === "string" && v.includes("[content elided: ") && RE_CONTENU_ELIDE.test(v);
}
