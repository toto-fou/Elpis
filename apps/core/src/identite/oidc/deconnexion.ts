// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/deconnexion.ts — déconnexion côté fournisseur OIDC : adresse de fin de session construite sans appel sortant, et jeton de déconnexion par canal arrière vérifié (signature, émetteur, public, événement) puis appliqué aux seules sessions de ce fournisseur. */

/** Ligne de journal d'un refus agrégée : une ligne par raison et par minute au plus, avec le nombre, écrite à la fin de la minute. */
export class RefusAgreges {
  private readonly raisons = new Map<string, number>();

  private readonly ecrire: (raison: string, n: number) => void;

  constructor(ecrire: (raison: string, n: number) => void) {
    this.ecrire = ecrire;
  }

  /** Compte un refus ; la ligne de sa raison part une minute plus tard. */
  noter(raison: string): void {
    const n = this.raisons.get(raison);
    if (n !== undefined) {
      this.raisons.set(raison, n + 1);
      return;
    }
    this.raisons.set(raison, 1);
    setTimeout(() => {
      const total = this.raisons.get(raison) ?? 0;
      this.raisons.delete(raison);
      this.ecrire(raison, total);
    }, 60_000).unref();
  }
}
