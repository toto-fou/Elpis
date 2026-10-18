// SPDX-License-Identifier: MIT
/** packages/http/src/journal.ts — journal du process : lignes texte sur stderr préfixées `[domaine]`, interface de Fastify, copie vers l'historique du bus. */

export type Niveau = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";

const RANGS: Readonly<Record<Niveau, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

const LIBELLES: Readonly<Record<Exclude<Niveau, "silent">, string>> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

export type Sortie = (ligne: string) => void;

/** Ligne écrite : niveau au nom Python, message sans horodatage (domaine, champs et pile compris), date. */
export type CrochetJournal = (niveau: string, message: string, date: Date) => void;

let crochetJournal: CrochetJournal | null = null;

/** Un seul crochet par process, le dernier posé (`SSELogHandler` sur le logger racine) ; `null` le retire. */
export function installerCrochetJournal(crochet: CrochetJournal | null): void {
  crochetJournal = crochet;
}

/** Copie au mieux, comme un handler de logging Python : un crochet en échec n'empêche jamais la ligne d'être écrite. */
function copier(niveau: string, message: string, date: Date): void {
  try {
    crochetJournal?.(niveau, message, date);
  } catch {
    return;
  }
}

const sortieStderr: Sortie = (ligne) => {
  process.stderr.write(ligne + "\n");
};

const NIVEAUX_PYTHON: Readonly<Record<string, Niveau>> = {
  debug: "debug",
  info: "info",
  warning: "warn",
  warn: "warn",
  error: "error",
  critical: "fatal",
};

/** `APP_LOG_LEVEL` avec les noms de Python (DEBUG à CRITICAL), INFO par défaut. */
function niveauInitial(): Niveau {
  const brut = (process.env["APP_LOG_LEVEL"] ?? "").trim().toLowerCase();
  return Object.hasOwn(NIVEAUX_PYTHON, brut) ? (NIVEAUX_PYTHON[brut] ?? "info") : "info";
}

function texte(valeur: unknown): string {
  if (valeur instanceof Error) return valeur.stack ?? `${valeur.name}: ${valeur.message}`;
  if (typeof valeur === "string") return valeur;
  try {
    return JSON.stringify(valeur);
  } catch {
    return String(valeur);
  }
}

export class Journal {
  level: Niveau;
  private readonly liaisons: Readonly<Record<string, unknown>>;
  private readonly sortie: Sortie;

  constructor(options: { niveau?: Niveau; liaisons?: Record<string, unknown>; sortie?: Sortie } = {}) {
    this.level = options.niveau ?? niveauInitial();
    this.liaisons = options.liaisons ?? {};
    this.sortie = options.sortie ?? sortieStderr;
  }

  child(liaisons: Record<string, unknown>): Journal {
    return new Journal({
      niveau: this.level,
      liaisons: { ...this.liaisons, ...liaisons },
      sortie: this.sortie,
    });
  }

  /** Convention pino : un objet en premier argument porte des champs (`err` pour une erreur), le message suit. */
  private ecrire(niveau: Exclude<Niveau, "silent">, args: unknown[]): void {
    if (RANGS[niveau] < RANGS[this.level]) return;
    const premier = args[0];
    const avecChamps = premier !== null && typeof premier === "object" && !(premier instanceof Error);
    const champs = avecChamps ? (premier as Record<string, unknown>) : {};
    const message = (avecChamps ? args.slice(1) : args).map(texte).join(" ");
    const domaine = this.liaisons["domaine"];
    const prefixe = typeof domaine === "string" && domaine ? `[${domaine}] ` : "";
    const erreur = champs["err"];
    const extras = Object.entries({ ...this.liaisons, ...champs }).filter(
      ([c]) => c !== "domaine" && !(c === "err" && erreur instanceof Error),
    );
    let corps = `${prefixe}${message}`;
    if (extras.length > 0) corps += " " + texte(Object.fromEntries(extras));
    if (erreur instanceof Error) corps += "\n" + texte(erreur);
    const date = new Date();
    this.sortie(`${date.toISOString()} ${LIBELLES[niveau]} ${corps}`);
    copier(LIBELLES[niveau], corps, date);
  }

  trace(...args: unknown[]): void {
    this.ecrire("trace", args);
  }
  debug(...args: unknown[]): void {
    this.ecrire("debug", args);
  }
  info(...args: unknown[]): void {
    this.ecrire("info", args);
  }
  warn(...args: unknown[]): void {
    this.ecrire("warn", args);
  }
  error(...args: unknown[]): void {
    this.ecrire("error", args);
  }
  fatal(...args: unknown[]): void {
    this.ecrire("fatal", args);
  }
  silent(): void {}
}

export const journalRacine = new Journal();

export function journal(domaine: string): Journal {
  return journalRacine.child({ domaine });
}
