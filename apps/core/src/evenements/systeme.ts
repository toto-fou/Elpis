// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/systeme.ts — bus système en mémoire (`SystemEvents`) : diffusion, logs staff, notifications par compte. */
import { intPy, pyJsonDumps, strPy, veritePy } from "@elpis/commun";

import type { Journal } from "../journal";
import { ABANDON, DELAI, FileAttente } from "./file";

export type Message = Record<string, unknown>;

/** Sentinelle de fermeture d'un flux, comparée par identité (`_CLIENT_CLOSED`). */
export const CLIENT_CLOSED: unique symbol = Symbol("CLIENT_CLOSED");

export type ElementSysteme = string | Message | typeof CLIENT_CLOSED;

export interface AbonneSysteme {
  readonly staff: boolean;
  readonly uid: number | null;
}

export interface EntreeHistorique {
  readonly id: number;
  readonly message: unknown;
  readonly level: unknown;
}

export type VerifierSession = () => boolean | Promise<boolean>;

export interface OptionsListen {
  isStaff?: boolean;
  userId?: number | null;
  validityCheck?: VerifierSession;
  signal?: AbortSignal;
}

export interface OptionsDiffusion {
  relais?: boolean;
  donnees?: string;
}

/** Ligne du journal JSONL commun (`access_logging.write_event`) ; `live: false` la garde hors de la console staff. */
export interface LigneJournal {
  level: string;
  category: unknown;
  message: string;
  logger: string;
  extras?: Readonly<Record<string, unknown>> | null;
  live?: boolean;
}

export type EcrireJournal = (ligne: LigneJournal) => void;

export type Relais = (message: Message, donnees: string) => void;

export interface OptionsSystemEvents {
  journal?: Journal;
  peutVoirModeles?: (uid: number) => boolean;
  ecrireJournal?: EcrireJournal;
  surAbonneStaff?: () => void;
  attenteMs?: number;
  revalidationMs?: number;
}

const AVERTISSEMENT_SATURATION = "[system_events] client saturé — événements les plus anciens abandonnés";

function dict(v: unknown): Message | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Message) : undefined;
}

function cle(message: Message, nom: string, defaut: unknown): unknown {
  return Object.hasOwn(message, nom) ? message[nom] : defaut;
}

/** `int(data.get("user_id"))` d'une notification ; `null` si absent ou illisible. */
function destinataire(message: Message): number | null {
  const data = dict(message["data"]);
  if (data === undefined) return null;
  try {
    return intPy(data["user_id"] ?? null);
  } catch {
    return null;
  }
}

/** Événements remis au seul compte de `data.user_id` : notifications, jobs et réveils des tâches de fond. */
const TYPES_DU_COMPTE: ReadonlySet<unknown> = new Set(["notification", "chat_job", "chat_wake"]);

function deux(n: number): string {
  return String(n).padStart(2, "0");
}

export class SystemEvents {
  static readonly LOG_HISTORY_MAXLEN = 300;
  static readonly QUEUE_MAX_SIZE = 500;
  static readonly SESSION_RECHECK_SEC = 60;
  static readonly ATTENTE_SEC = 30;

  readonly clients = new Map<FileAttente<ElementSysteme>, AbonneSysteme>();
  private readonly historique: EntreeHistorique[] = [];
  private readonly relais = new Set<Relais>();
  private readonly options: OptionsSystemEvents;
  private fermeture: Message | undefined;

  constructor(options: OptionsSystemEvents = {}) {
    this.options = options;
  }

  get nombreClients(): number {
    return this.clients.size;
  }

  get aUnStaff(): boolean {
    for (const meta of this.clients.values()) if (meta.staff) return true;
    return false;
  }

  /** Inscription immédiate : itérer jusqu'au bout ou passer `signal`, sinon l'abonné reste ; rend le texte de chaque trame `data`. */
  listen(options: OptionsListen = {}): AsyncGenerator<string, void, undefined> {
    const file = new FileAttente<ElementSysteme>(SystemEvents.QUEUE_MAX_SIZE);
    if (this.fermeture !== undefined) {
      this.fermerFile(file, this.fermeture);
    } else if (!options.signal?.aborted) {
      this.clients.set(file, { staff: Boolean(options.isStaff), uid: options.userId ?? null });
      if (options.isStaff) this.options.surAbonneStaff?.();
    }
    const desinscrire = (): void => void this.clients.delete(file);
    options.signal?.addEventListener("abort", desinscrire, { once: true });
    return this.boucle(file, options, desinscrire);
  }

  private async *boucle(
    file: FileAttente<ElementSysteme>,
    options: OptionsListen,
    desinscrire: () => void,
  ): AsyncGenerator<string, void, undefined> {
    const attente = this.options.attenteMs ?? SystemEvents.ATTENTE_SEC * 1000;
    const revalidation = this.options.revalidationMs ?? SystemEvents.SESSION_RECHECK_SEC * 1000;
    let dernierControle = Date.now();
    try {
      for (;;) {
        const element = await file.prendre(attente, options.signal);
        if (element === ABANDON) return;
        if (options.validityCheck !== undefined && Date.now() - dernierControle >= revalidation) {
          dernierControle = Date.now();
          let valide: boolean;
          try {
            valide = Boolean(await options.validityCheck());
          } catch {
            valide = true;
          }
          if (!valide) {
            yield pyJsonDumps({ type: "session_expired" });
            return;
          }
        }
        if (element === DELAI) continue;
        if (element === CLIENT_CLOSED) return;
        if (typeof element === "string") {
          yield element;
          continue;
        }
        let donnees: string;
        try {
          donnees = pyJsonDumps(element);
        } catch {
          this.options.journal?.debug("[system_events] payload non sérialisable droppé");
          continue;
        }
        yield donnees;
      }
    } finally {
      options.signal?.removeEventListener("abort", desinscrire);
      desinscrire();
    }
  }

  /** Cause (`message`) puis sentinelle ; une file pleine est vidée pour leur faire place. */
  private fermerFile(file: FileAttente<ElementSysteme>, message: Message | undefined): void {
    const depose = (message === undefined || file.deposer(message)) && file.deposer(CLIENT_CLOSED);
    if (depose) return;
    file.vider();
    if (message !== undefined) file.deposer(message);
    file.deposer(CLIENT_CLOSED);
  }

  /** Ferme les flux d'un compte (`null` : tous) ; rend le nombre de flux fermés. */
  disconnectUser(uid: number | null = null, message?: Message): number {
    let fermes = 0;
    for (const [file, meta] of [...this.clients]) {
      if (uid !== null && meta.uid !== uid) continue;
      this.clients.delete(file);
      this.fermerFile(file, message);
      fermes += 1;
    }
    return fermes;
  }

  /** Arrêt du process : tous les flux reçoivent `message` puis se ferment, les suivants aussi dès l'ouverture. */
  fermer(message: Message): number {
    this.fermeture = message;
    return this.disconnectUser(null, message);
  }

  /** Un `log` va à l'historique et au journal commun (relu par chaque process pour son staff) ; le reste est diffusé. */
  broadcast(message: Message, options: OptionsDiffusion = {}): void {
    if (message["type"] === "log") {
      this.noter({
        id: Date.now() / 1000,
        message: cle(message, "message", ""),
        level: cle(message, "level", ""),
      });
      try {
        this.options.ecrireJournal?.({
          level: strPy(veritePy(message["level"]) ? message["level"] : "INFO").toUpperCase(),
          category: veritePy(message["category"]) ? message["category"] : "app",
          message: strPy(cle(message, "message", "")),
          logger: "system_events",
        });
      } catch (e) {
        this.options.journal?.debug({ err: e }, "[system_events] log non journalisé");
      }
      return;
    }
    const donnees = this.fanout(message, options.donnees);
    if (options.relais === false || this.relais.size === 0 || donnees === null) return;
    let texte = donnees;
    if (texte === undefined) {
      try {
        texte = pyJsonDumps(message);
      } catch {
        return;
      }
    }
    for (const relais of this.relais) {
      try {
        relais(message, texte);
      } catch (e) {
        this.options.journal?.warn({ err: e }, "[system_events] relais en échec");
      }
    }
  }

  /** Diffusion locale filtrée (staff, destinataire, accès au moteur) ; rend le texte sérialisé, `null` si le message est jeté. */
  fanout(message: Message, donnees?: string): string | null | undefined {
    const estLog = message["type"] === "log";
    let notifUid: number | null = null;
    if (TYPES_DU_COMPTE.has(message["type"])) {
      notifUid = destinataire(message);
      if (notifUid === null) {
        this.options.journal?.debug(
          `[system_events] ${String(message["type"])} sans user_id valide — droppée`,
        );
        return null;
      }
    }
    const estEtatModeles = message["type"] === "model_status";
    let texte = donnees;
    const acces = new Map<number, boolean>();
    const saturees: FileAttente<ElementSysteme>[] = [];
    for (const [file, meta] of [...this.clients]) {
      if (estLog && !meta.staff) continue;
      if (notifUid !== null && meta.uid !== notifUid) continue;
      const uid = meta.uid;
      if (estEtatModeles && uid !== null) {
        if (!acces.has(uid)) {
          let permis: boolean;
          try {
            permis = Boolean(this.options.peutVoirModeles?.(uid) ?? true);
          } catch {
            permis = true;
          }
          acces.set(uid, permis);
        }
        if (acces.get(uid) !== true) continue;
      }
      if (texte === undefined) {
        try {
          texte = pyJsonDumps(message);
        } catch {
          this.options.journal?.debug("[system_events] payload non sérialisable droppé");
          return null;
        }
      }
      if (!file.deposer(texte)) saturees.push(file);
    }
    for (const file of saturees) {
      for (let i = 0; i < Math.max(1, Math.floor(SystemEvents.QUEUE_MAX_SIZE / 2)); i++) {
        if (file.retirer() === undefined) break;
      }
      const repart =
        file.deposer({ type: "log", level: "warning", message: AVERTISSEMENT_SATURATION }) &&
        file.deposer(texte as string);
      if (!repart) {
        this.clients.delete(file);
        file.deposer(CLIENT_CLOSED);
      }
    }
    return texte;
  }

  /** Abonne le canal interne (process main) aux diffusions locales qui ne sont pas des logs. */
  surDiffusion(relais: Relais): () => void {
    this.relais.add(relais);
    return () => void this.relais.delete(relais);
  }

  private noter(entree: EntreeHistorique): void {
    this.historique.push(entree);
    if (this.historique.length > SystemEvents.LOG_HISTORY_MAXLEN) this.historique.shift();
  }

  /** `SSELogHandler.emit` : ligne du journal du process au format `%H:%M:%S - NIVEAU - message`. */
  noterLigneJournal(level: string, message: string, date = new Date()): void {
    const heure = `${deux(date.getHours())}:${deux(date.getMinutes())}:${deux(date.getSeconds())}`;
    this.noter({ id: date.getTime() / 1000, message: `${heure} - ${level} - ${message}`, level });
  }

  getRecentLogs(): EntreeHistorique[] {
    return [...this.historique];
  }
}
