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

/** Texte d'une valeur du journal ; une erreur dont `stack` n'est pas un texte donne `nom: message`. */
function texte(valeur: unknown): string {
  if (valeur instanceof Error) {
    const pile: unknown = valeur.stack;
    return typeof pile === "string" ? pile : `${String(valeur.name)}: ${String(valeur.message)}`;
  }
  if (typeof valeur === "string") return valeur;
  try {
    return JSON.stringify(valeur);
  } catch {
    return String(valeur);
  }
}

// eslint-disable-next-line no-control-regex -- les caractères de contrôle sont précisément ce qu'on cherche
const CONTROLE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/u;
// eslint-disable-next-line no-control-regex -- idem, version globale pour le remplacement
const CONTROLES = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/gu;

/** Une ligne reste une ligne : retours et caractères de contrôle d'un message rendus visibles (`\n`, `\u001b`…), sans coût pour un texte propre. */
export function uneLigne(t: string): string {
  if (!CONTROLE.test(t)) return t;
  return t.replace(CONTROLES, (c) =>
    c === "\n" ? "\\n" : c === "\r" ? "\\r" : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Lignes de pile d'erreur écrites au plus : une erreur à mille retours ne remplit pas journald (limite de débit du service). */
const PILE_MAX = 100;

/** Plafond d'une ligne physique en octets UTF-8, bien sous `LineMax` de journald (48 Kio) : une ligne trop longue n'y est jamais coupée en un second enregistrement au texte choisi. */
const LIGNE_MAX = 8000;

/** Ligne bornée à `max` octets UTF-8 (sans couper un caractère), la fin remplacée par `…[tronqué N]` (N caractères retirés). */
function bornerLigne(t: string, max = LIGNE_MAX): string {
  if (t.length * 3 <= max || Buffer.byteLength(t, "utf8") <= max) return t;
  const octets = Buffer.from(t, "utf8");
  let fin = Math.max(0, max - 32);
  while (fin > 0 && ((octets[fin] ?? 0) & 0xc0) === 0x80) fin--;
  const tete = octets.subarray(0, fin).toString("utf8");
  return `${tete}…[tronqué ${t.length - tete.length}]`;
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

  /** Convention pino : un objet en premier argument porte des champs (`err` pour une erreur), le message suit ; une erreur passée en argument vaut `err`. */
  private ecrire(niveau: Exclude<Niveau, "silent">, args: unknown[]): void {
    if (RANGS[niveau] < RANGS[this.level]) return;
    const premier = args[0];
    const avecChamps = premier !== null && typeof premier === "object" && !(premier instanceof Error);
    const champs = avecChamps ? (premier as Record<string, unknown>) : {};
    const positionnels = avecChamps ? args.slice(1) : args;
    const errChamp = champs["err"];
    const erreur = errChamp instanceof Error ? errChamp : positionnels.find((a) => a instanceof Error);
    const message = positionnels
      .filter((a) => a !== erreur)
      .map(texte)
      .join(" ");
    const domaine = this.liaisons["domaine"];
    const prefixe = typeof domaine === "string" && domaine ? `[${domaine}] ` : "";
    const extras = Object.entries({ ...this.liaisons, ...champs }).filter(
      ([c]) => c !== "domaine" && !(c === "err" && errChamp instanceof Error),
    );
    const suite =
      extras.length > 0 ? bornerLigne(uneLigne(texte(Object.fromEntries(extras))), LIGNE_MAX / 2) : "";
    let corps = bornerLigne(
      `${prefixe}${uneLigne(message)}`,
      LIGNE_MAX - (suite ? Buffer.byteLength(suite) + 1 : 0),
    );
    if (suite) corps += " " + suite;
    // Pile d'erreur sur les lignes suivantes, chacune échappée, bornée et indentée : aucune ne peut passer pour un nouvel enregistrement.
    if (erreur instanceof Error) {
      const pile = texte(erreur).split(/\r\n|\r|\n/u);
      for (const l of pile.slice(0, PILE_MAX)) corps += "\n    " + bornerLigne(uneLigne(l), LIGNE_MAX - 4);
      if (pile.length > PILE_MAX) corps += `\n    …[${pile.length - PILE_MAX} lignes]`;
    }
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
