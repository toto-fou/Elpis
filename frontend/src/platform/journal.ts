// SPDX-License-Identifier: MIT
/** frontend/src/platform/journal.ts — seul point d'écriture vers la console du navigateur (règle `no-console` ailleurs). */
/* eslint-disable no-console */

export const journal = {
  info: (...args: unknown[]): void => console.info(...args),
  avertir: (...args: unknown[]): void => console.warn(...args),
  erreur: (...args: unknown[]): void => console.error(...args),
};
