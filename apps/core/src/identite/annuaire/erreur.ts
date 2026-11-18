// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/erreur.ts — erreur d'annuaire : une nature fermée et un code numérique, jamais le message du serveur, un DN ni un mot de passe. */
import type { CodeSortant } from "../sortant";

export type NatureAnnuaire = "identifiants" | "injoignable" | "protocole" | "configuration";

export class ErreurAnnuaire extends Error {
  readonly nature: NatureAnnuaire;
  /** Code de résultat LDAP, `null` hors réponse du serveur. */
  readonly code: number | null;
  /** Code fermé du client sortant (réseau, TLS, délai), `null` sinon. */
  readonly sortant: CodeSortant | null;

  constructor(nature: NatureAnnuaire, o: { code?: number; sortant?: CodeSortant } = {}) {
    super(nature);
    this.name = "ErreurAnnuaire";
    this.nature = nature;
    this.code = o.code ?? null;
    this.sortant = o.sortant ?? null;
  }
}
