// SPDX-License-Identifier: MIT
/** packages/db/src/verrou.ts — verrou asynchrone FIFO avec délai d'attente (jamais d'attente bloquante). */
import { ErreurOperation } from "./erreurs";

interface Attente {
  servir(): void;
}

export class Verrou {
  private occupe = false;
  private readonly file: Attente[] = [];

  /** Rend la fonction de libération ; lève ErreurOperation(message) au-delà de `delaiMs`. */
  prendre(delaiMs: number, message: string): Promise<() => void> {
    if (!this.occupe) {
      this.occupe = true;
      return Promise.resolve(this.liberateur());
    }
    return new Promise((resolve, reject) => {
      const attente: Attente = {
        servir: () => {
          clearTimeout(minuteur);
          resolve(this.liberateur());
        },
      };
      const minuteur = setTimeout(() => {
        const i = this.file.indexOf(attente);
        if (i >= 0) this.file.splice(i, 1);
        reject(new ErreurOperation(message));
      }, delaiMs);
      this.file.push(attente);
    });
  }

  private liberateur(): () => void {
    let fait = false;
    return () => {
      if (fait) return;
      fait = true;
      const suivante = this.file.shift();
      if (suivante) suivante.servir();
      else this.occupe = false;
    };
  }
}
