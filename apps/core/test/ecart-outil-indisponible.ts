// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-outil-indisponible.ts — écart voulu au Python : l'appel d'un outil absent du manifeste du run (inconnu, désactivé, jamais offert à un sous-agent) est refusé en anglais, avec la marche à suivre. */

const MESSAGE_PY = /\{"error": "Outil '([^']*)' inconnu ou désactivé\."\}/gu;

/** Texte attendu (Python) dont le refus d'un outil absent devient l'erreur anglaise `tool_not_available`. */
export function outilIndisponibleEnAnglais(texte: string): string {
  return texte.replace(
    MESSAGE_PY,
    '{"ok": false, "error": "tool_not_available", "message": "$1 is not available in this run ' +
      '(unknown, disabled or not offered here)", "fix": "Use only the tools listed for you. A sub-agent leaves ' +
      "this step to its parent and lists it under 'Left open' in its report; otherwise tell the user which tool " +
      'is missing."}',
  );
}
