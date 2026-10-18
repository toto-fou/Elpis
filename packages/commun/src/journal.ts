// SPDX-License-Identifier: MIT
/** packages/commun/src/journal.ts — journal que les paquets attendent de leur hôte : un seul branchement au démarrage, stderr sinon. */

/** Sous-ensemble du `Journal` du core (`warn` = WARNING, `fatal` = CRITICAL de Python). */
export interface Journal {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal?(...args: unknown[]): void;
}

export type FabriqueJournal = (domaine: string) => Journal;

const LIBELLES = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
} as const;

export function journalStderr(domaine: string): Required<Journal> {
  const ecrire =
    (niveau: keyof typeof LIBELLES) =>
    (...args: unknown[]): void => {
      if (niveau === "debug") return;
      const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      process.stderr.write(`${new Date().toISOString()} ${LIBELLES[niveau]} [${domaine}] ${message}\n`);
    };
  return {
    debug: ecrire("debug"),
    info: ecrire("info"),
    warn: ecrire("warn"),
    error: ecrire("error"),
    fatal: ecrire("fatal"),
  };
}

let fabrique: FabriqueJournal = journalStderr;

/** Le core y passe son `journal(domaine)` au démarrage ; `null` revient à stderr. */
export function brancherJournal(f: FabriqueJournal | null): void {
  fabrique = f ?? journalStderr;
}

export function journalDe(domaine: string): Journal {
  return fabrique(domaine);
}
