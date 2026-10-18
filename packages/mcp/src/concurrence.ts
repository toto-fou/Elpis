// SPDX-License-Identifier: MIT
/** packages/mcp/src/concurrence.ts — verrou et sémaphore asynchrones (attente bornée, annulable, FIFO) et bornes de délai par signal. */
import { delaiMinuterie, dormirMs, raisonAnnulation } from "@elpis/commun";

export { delaiMinuterie, dormirMs as dormir, raisonAnnulation };

/** `asyncio.TimeoutError` : délai écoulé (message vide comme `str(TimeoutError())`). */
export class DelaiDepasse extends Error {
  override name = "TimeoutError";
  constructor(message = "") {
    super(message);
  }
}

export interface OptionsAttente {
  signal?: AbortSignal | undefined;
  delaiMs?: number | null | undefined;
}

interface Attente {
  servi: boolean;
  resoudre: () => void;
}

/** File d'attente FIFO avec remise directe au suivant ; l'abandon d'un attendeur le retire de la file. */
abstract class FileAttente {
  protected file: Attente[] = [];

  get enAttente(): number {
    return this.file.length;
  }

  protected attendre(options: OptionsAttente): Promise<void> {
    const { signal, delaiMs } = options;
    return new Promise<void>((resolve, reject) => {
      const attente: Attente = { servi: false, resoudre: () => undefined };
      let minuterie: ReturnType<typeof setTimeout> | null = null;
      const nettoyer = (): void => {
        if (minuterie !== null) clearTimeout(minuterie);
        signal?.removeEventListener("abort", surAbandon);
      };
      const retirer = (raison: unknown): void => {
        if (attente.servi) return;
        const i = this.file.indexOf(attente);
        if (i >= 0) this.file.splice(i, 1);
        nettoyer();
        reject(raison);
      };
      const surAbandon = (): void => retirer(raisonAnnulation(signal as AbortSignal));
      attente.resoudre = () => {
        attente.servi = true;
        nettoyer();
        resolve();
      };
      if (signal?.aborted) {
        reject(raisonAnnulation(signal));
        return;
      }
      this.file.push(attente);
      signal?.addEventListener("abort", surAbandon, { once: true });
      const borne = delaiMinuterie(delaiMs);
      if (borne !== null) minuterie = setTimeout(() => retirer(new DelaiDepasse()), borne);
    });
  }

  /** Remet la ressource au premier attendeur ; `false` si personne n'attendait. */
  protected remettre(): boolean {
    const suivant = this.file.shift();
    if (suivant === undefined) return false;
    suivant.resoudre();
    return true;
  }
}

/** `asyncio.Lock` : non réentrant, FIFO, sans passe-droit entre libération et reprise. */
export class VerrouAsyncio extends FileAttente {
  private pris = false;

  get locked(): boolean {
    return this.pris;
  }

  essayer(): boolean {
    if (this.pris) return false;
    this.pris = true;
    return true;
  }

  async acquerir(options: OptionsAttente = {}): Promise<void> {
    if (options.signal?.aborted) throw raisonAnnulation(options.signal);
    if (this.essayer()) return;
    await this.attendre(options);
  }

  liberer(): void {
    if (!this.pris) throw new Error("Lock is not acquired.");
    if (!this.remettre()) this.pris = false;
  }

  /** `async with lock:` */
  async avec<T>(fn: () => Promise<T>, options: OptionsAttente = {}): Promise<T> {
    await this.acquerir(options);
    try {
      return await fn();
    } finally {
      this.liberer();
    }
  }
}

/** `asyncio.Semaphore` : permis comptés, attente FIFO. */
export class Semaphore extends FileAttente {
  private valeur: number;

  constructor(valeur: number) {
    super();
    this.valeur = valeur;
  }

  /** `_value` : permis libres. */
  get value(): number {
    return this.valeur;
  }

  async acquerir(options: OptionsAttente = {}): Promise<void> {
    if (options.signal?.aborted) throw raisonAnnulation(options.signal);
    if (this.valeur > 0 && this.file.length === 0) {
      this.valeur--;
      return;
    }
    await this.attendre(options);
  }

  liberer(): void {
    if (!this.remettre()) this.valeur++;
  }
}

/** Signal annulé par le parent ou après `delaiMs` (raison : `DelaiDepasse`, identifiable par `estCeDelai`). */
export function signalBorne(
  parent: AbortSignal | undefined,
  delaiMs: number | null | undefined,
): { signal: AbortSignal; delai: DelaiDepasse; liberer: () => void } {
  const ctl = new AbortController();
  const delai = new DelaiDepasse();
  const surParent = (): void => ctl.abort(raisonAnnulation(parent as AbortSignal));
  if (parent?.aborted) ctl.abort(raisonAnnulation(parent));
  else parent?.addEventListener("abort", surParent, { once: true });
  const borne = delaiMinuterie(delaiMs);
  const minuterie = borne === null ? null : setTimeout(() => ctl.abort(delai), borne);
  return {
    signal: ctl.signal,
    delai,
    liberer: () => {
      if (minuterie !== null) clearTimeout(minuterie);
      parent?.removeEventListener("abort", surParent);
    },
  };
}

/** Course entre une promesse et l'annulation d'un signal ; la promesse abandonnée ne lève plus rien. */
export function course<T>(promesse: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promesse;
  if (signal.aborted) {
    promesse.catch(() => undefined);
    return Promise.reject(raisonAnnulation(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const surAbandon = (): void => {
      promesse.catch(() => undefined);
      reject(raisonAnnulation(signal));
    };
    signal.addEventListener("abort", surAbandon, { once: true });
    promesse.then(
      (v) => {
        signal.removeEventListener("abort", surAbandon);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", surAbandon);
        reject(e);
      },
    );
  });
}

export { VerrouAsyncio as Verrou };
