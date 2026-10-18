// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/pipeline.ts — bus par compte (`PipelineEvents`, page Code), en mémoire : un seul process main. */
import { pyJsonDumps } from "@elpis/commun";

import { ABANDON, DELAI, FileAttente } from "./file";
import { CLIENT_CLOSED } from "./systeme";
import type { Message, VerifierSession } from "./systeme";

export type ElementPipeline = Message | typeof CLIENT_CLOSED;

/** Texte du champ `data` d'un message, `null` pour ne rien envoyer (`render` de Python). */
export type Rendu = (message: Message) => string | null;

export interface OptionsListenPipeline {
  validityCheck?: VerifierSession;
  render?: Rendu;
  signal?: AbortSignal;
}

export interface StatsPipeline {
  backend: "memory";
  users_connected: number;
  total_clients: number;
  events_dropped: number;
  errors: number;
}

export class PipelineEvents {
  static readonly QUEUE_MAX_SIZE = 500;
  static readonly MAX_CLIENTS_PER_USER = 50;
  static readonly PING_INTERVAL_SEC = 15;
  static readonly SESSION_RECHECK_SEC = 60;

  readonly clients = new Map<number, Set<FileAttente<ElementPipeline>>>();
  private totalDropped = 0;
  private totalErrors = 0;
  private fermeture: Message | undefined;
  private readonly attenteMs: number;
  private readonly revalidationMs: number;

  constructor(options: { attenteMs?: number; revalidationMs?: number } = {}) {
    this.attenteMs = options.attenteMs ?? PipelineEvents.PING_INTERVAL_SEC * 1000;
    this.revalidationMs = options.revalidationMs ?? PipelineEvents.SESSION_RECHECK_SEC * 1000;
  }

  get nombreClients(): number {
    let n = 0;
    for (const files of this.clients.values()) n += files.size;
    return n;
  }

  register(userId: number, file: FileAttente<ElementPipeline>): boolean {
    let files = this.clients.get(userId);
    if (files === undefined) {
      files = new Set();
      this.clients.set(userId, files);
    }
    if (files.size >= PipelineEvents.MAX_CLIENTS_PER_USER) return false;
    files.add(file);
    return true;
  }

  unregister(userId: number, file: FileAttente<ElementPipeline>): void {
    const files = this.clients.get(userId);
    if (files === undefined) return;
    files.delete(file);
    if (files.size === 0) this.clients.delete(userId);
  }

  snapshotQueues(userId: number): FileAttente<ElementPipeline>[] {
    return [...(this.clients.get(userId) ?? [])];
  }

  hasClients(): boolean {
    for (const files of this.clients.values()) if (files.size > 0) return true;
    return false;
  }

  /** Une file pleine perd sa moitié la plus ancienne, jamais son client. */
  distributeLocal(userId: number, message: Message): void {
    for (const file of this.snapshotQueues(userId)) {
      if (file.deposer(message)) continue;
      for (let i = 0; i < Math.max(1, Math.floor(PipelineEvents.QUEUE_MAX_SIZE / 2)); i++) {
        if (file.retirer() === undefined) break;
      }
      if (file.deposer(message)) {
        this.totalDropped += 1;
        continue;
      }
      this.unregister(userId, file);
      this.totalDropped += 1;
      file.retirer();
      file.deposer(CLIENT_CLOSED);
    }
  }

  /** Itérateur des textes `data` d'un client : erreur « trop de flux », revalidation, sentinelle. */
  listen(userId: number, options: OptionsListenPipeline = {}): AsyncGenerator<string, void, undefined> {
    const file = new FileAttente<ElementPipeline>(PipelineEvents.QUEUE_MAX_SIZE);
    if (this.fermeture !== undefined || options.signal?.aborted) {
      if (this.fermeture !== undefined) this.fermerFile(file, this.fermeture);
      return this.boucle(file, true, options, () => undefined);
    }
    const inscrit = this.register(userId, file);
    const desinscrire = (): void => this.unregister(userId, file);
    if (inscrit) options.signal?.addEventListener("abort", desinscrire, { once: true });
    return this.boucle(file, inscrit, options, desinscrire);
  }

  /** Comme `except (TypeError, ValueError)` : un message illisible est sauté, toute autre erreur termine le flux. */
  private trame(message: Message, rendu: Rendu): string | null {
    try {
      return rendu(message);
    } catch (e) {
      if (!(e instanceof TypeError || e instanceof RangeError)) throw e;
      this.totalErrors += 1;
      return null;
    }
  }

  private async *boucle(
    file: FileAttente<ElementPipeline>,
    inscrit: boolean,
    options: OptionsListenPipeline,
    desinscrire: () => void,
  ): AsyncGenerator<string, void, undefined> {
    const rendu: Rendu = options.render ?? ((m) => pyJsonDumps(m));
    if (!inscrit) {
      const refus = this.trame(
        { type: "error", code: "too_many_streams", message: "Too many concurrent SSE connections" },
        rendu,
      );
      if (refus !== null) yield refus;
      return;
    }
    let dernierControle = Date.now();
    try {
      for (;;) {
        const element = await file.prendre(this.attenteMs, options.signal);
        if (element === ABANDON) return;
        if (options.validityCheck !== undefined && Date.now() - dernierControle >= this.revalidationMs) {
          dernierControle = Date.now();
          let valide: boolean;
          try {
            valide = Boolean(await options.validityCheck());
          } catch {
            valide = true;
          }
          if (!valide) {
            const expire = this.trame({ type: "session_expired" }, rendu);
            if (expire !== null) yield expire;
            return;
          }
        }
        if (element === DELAI) continue;
        if (element === CLIENT_CLOSED) return;
        const texte = this.trame(element, rendu);
        if (texte !== null) yield texte;
      }
    } catch {
      this.totalErrors += 1;
    } finally {
      options.signal?.removeEventListener("abort", desinscrire);
      desinscrire();
    }
  }

  private fermerFile(file: FileAttente<ElementPipeline>, message: Message | undefined): void {
    const depose = (message === undefined || file.deposer(message)) && file.deposer(CLIENT_CLOSED);
    if (depose) return;
    file.vider();
    if (message !== undefined) file.deposer(message);
    file.deposer(CLIENT_CLOSED);
  }

  /** Cause puis sentinelle à chaque flux du compte (le `finally` du flux le désinscrit) ; rend le nombre de flux. */
  disconnectUser(userId: number, message?: Message): number {
    const files = this.snapshotQueues(userId);
    for (const file of files) this.fermerFile(file, message);
    return files.length;
  }

  disconnectAll(message?: Message): number {
    let n = 0;
    for (const uid of [...this.clients.keys()]) n += this.disconnectUser(uid, message);
    return n;
  }

  /** Arrêt du process : comme `disconnectAll`, et tout flux ouvert ensuite se ferme aussitôt. */
  fermer(message: Message): number {
    this.fermeture = message;
    return this.disconnectAll(message);
  }

  broadcastToUser(userId: number, message: Message): void {
    this.distributeLocal(userId, message);
  }

  stats(): StatsPipeline {
    return {
      backend: "memory",
      users_connected: this.clients.size,
      total_clients: this.nombreClients,
      events_dropped: this.totalDropped,
      errors: this.totalErrors,
    };
  }
}
