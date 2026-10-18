// SPDX-License-Identifier: MIT
/** packages/verrous/src/ports.ts — ce que le paquet attend de son hôte : le journal (stderr tant que le core n'a pas branché le sien). */

/** Sous-ensemble du `Journal` du core (`warn` = WARNING de Python). */
export interface Journal {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export type FabriqueJournal = (domaine: string) => Journal;

const LIBELLES = { debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR" } as const;

function journalStderr(domaine: string): Journal {
  const ecrire =
    (niveau: keyof typeof LIBELLES) =>
    (...args: unknown[]): void => {
      if (niveau === "debug") return;
      const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      process.stderr.write(`${new Date().toISOString()} ${LIBELLES[niveau]} [${domaine}] ${message}\n`);
    };
  return { debug: ecrire("debug"), info: ecrire("info"), warn: ecrire("warn"), error: ecrire("error") };
}

let fabrique: FabriqueJournal = journalStderr;

/** Le core y passe son `journal(domaine)` au démarrage ; `null` revient à stderr. */
export function brancherJournal(f: FabriqueJournal | null): void {
  fabrique = f ?? journalStderr;
}

export function journalDe(domaine: string): Journal {
  return fabrique(domaine);
}
