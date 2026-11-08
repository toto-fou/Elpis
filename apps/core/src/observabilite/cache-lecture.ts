// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/cache-lecture.ts — cache court d'une lecture lourde de la console : durée de vie, calcul partagé en vol, erreurs jamais gardées, contournement « frais ». */

interface Entree<T> {
  jusqua: number;
  valeur: T | undefined;
  enVol: Promise<T> | null;
}

const ENTREES_MAX = 64;

export class CacheLecture<T> {
  private readonly entrees = new Map<string, Entree<T>>();

  private readonly ttlMs: number;
  private readonly horloge: () => number;

  constructor(ttlMs: number, horloge: () => number = () => performance.now()) {
    this.ttlMs = ttlMs;
    this.horloge = horloge;
  }

  /** Valeur fraîche gardée, sinon calcul partagé en cours, sinon nouveau calcul ; `frais` ignore le gardé mais remplace l'entrée. */
  lire(cle: string, calcul: () => Promise<T>, frais = false): Promise<T> {
    const vu = this.entrees.get(cle);
    if (!frais && vu !== undefined) {
      if (vu.valeur !== undefined && vu.jusqua > this.horloge()) return Promise.resolve(vu.valeur);
      if (vu.enVol !== null) return vu.enVol;
    }
    const enVol: Promise<T> = calcul().then(
      (valeur) => {
        if (this.entrees.get(cle)?.enVol === enVol)
          this.entrees.set(cle, { jusqua: this.horloge() + this.ttlMs, valeur, enVol: null });
        return valeur;
      },
      (e: unknown) => {
        if (this.entrees.get(cle)?.enVol === enVol) this.entrees.delete(cle);
        throw e;
      },
    );
    if (this.entrees.size >= ENTREES_MAX && !this.entrees.has(cle)) this.entrees.clear();
    this.entrees.set(cle, { jusqua: 0, valeur: undefined, enVol });
    return enVol;
  }

  /** Oublie tout (un calcul en vol ne sera pas gardé) : après une purge, la prochaine lecture repart de la base. */
  invalider(): void {
    this.entrees.clear();
  }
}
