// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/file.ts — file bornée d'un abonné, comme `asyncio.Queue` : dépôt immédiat, retrait avec délai ou abandon. */

export const DELAI: unique symbol = Symbol("délai");
export const ABANDON: unique symbol = Symbol("abandon");

export class FileAttente<T> {
  readonly capacite: number;
  private elements: T[] = [];
  private tete = 0;
  private reveil: (() => void) | undefined;

  /** Capacité infinie par défaut (`maxsize=0` de Python). */
  constructor(capacite = Number.POSITIVE_INFINITY) {
    this.capacite = capacite > 0 ? capacite : Number.POSITIVE_INFINITY;
  }

  get taille(): number {
    return this.elements.length - this.tete;
  }

  /** `put_nowait` : faux quand la file est pleine (`QueueFull`). */
  deposer(element: T): boolean {
    if (this.taille >= this.capacite) return false;
    this.elements.push(element);
    const reveil = this.reveil;
    this.reveil = undefined;
    reveil?.();
    return true;
  }

  /** `get_nowait` : `undefined` quand la file est vide (`QueueEmpty`). */
  retirer(): T | undefined {
    if (this.taille === 0) return undefined;
    const element = this.elements[this.tete] as T;
    this.tete += 1;
    if (this.tete > 64 && this.tete * 2 > this.elements.length) {
      this.elements = this.elements.slice(this.tete);
      this.tete = 0;
    }
    return element;
  }

  vider(): void {
    this.elements = [];
    this.tete = 0;
  }

  contenu(): T[] {
    return this.elements.slice(this.tete);
  }

  /** `wait_for(get(), délai)` : l'élément reste compté dans la file jusqu'à la reprise du consommateur, comme en asyncio. */
  async prendre(delaiMs: number, signal?: AbortSignal): Promise<T | typeof DELAI | typeof ABANDON> {
    const echeance = Date.now() + delaiMs;
    for (;;) {
      if (signal?.aborted) return ABANDON;
      if (this.taille > 0) return this.retirer() as T;
      const reste = echeance - Date.now();
      if (reste <= 0) return DELAI;
      const issue = await this.attendre(reste, signal);
      if (issue !== undefined) return issue;
    }
  }

  private attendre(
    delaiMs: number,
    signal?: AbortSignal,
  ): Promise<typeof DELAI | typeof ABANDON | undefined> {
    return new Promise((resoudre) => {
      const finir = (issue: typeof DELAI | typeof ABANDON | undefined): void => {
        clearTimeout(minuterie);
        signal?.removeEventListener("abort", surAbandon);
        if (this.reveil === surReveil) this.reveil = undefined;
        resoudre(issue);
      };
      const surAbandon = (): void => finir(ABANDON);
      const surReveil = (): void => finir(undefined);
      const minuterie = setTimeout(() => finir(DELAI), delaiMs);
      this.reveil = surReveil;
      signal?.addEventListener("abort", surAbandon, { once: true });
    });
  }
}
