// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-delai-outil.ts — écart voulu au Python : le résultat d'un outil resté sans réponse dans son délai (`toolTimeoutJson`) est rendu au modèle en anglais. */

const MESSAGE_PY =
  /L'outil '([^']*)' n'a pas répondu en (\d+)s — attente abandonnée ; il peut encore s'exécuter côté serveur\./gu;
const FIX_PY =
  "Vérifie l'état (fichier, dépôt, processus) avant de relancer ; puis relance une action plus ciblée/rapide, " +
  "ou découpe le travail en étapes plus petites.";

/** Texte attendu (Python) dont le message et le correctif du délai dépassé sont mis en anglais. */
export function delaiEnAnglais(texte: string): string {
  return texte
    .replace(
      MESSAGE_PY,
      "Tool '$1' did not answer within $2 s: the wait was abandoned and it may still be running on the server.",
    )
    .replaceAll(
      FIX_PY,
      "Check the state (files, repository, processes) before retrying, then retry a narrower or faster action, " +
        "or split the work into smaller steps.",
    );
}
