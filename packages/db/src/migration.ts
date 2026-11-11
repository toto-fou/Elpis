// SPDX-License-Identifier: MIT
/** packages/db/src/migration.ts — contrat d'une migration propre au TS : son travail, ses notes au journal du démarrage et son report à un process qui en a les moyens. */
import type { Base, Executeur } from "./base";

/** Notes d'une migration pour le journal du démarrage (jamais de secret). */
export interface NotesMigration {
  infos?: readonly string[];
  avertissements?: readonly string[];
}

export interface Migration {
  name: string;
  /** `x` : la transaction de la migration ; `base` : la même base, dont les transactions imbriquées deviennent des points de sauvegarde. */
  migrer(x: Executeur, base: Base): Promise<void | NotesMigration>;
}

/** Migration laissée à un autre process (le core, qui a la clé du coffre) : ni appliquée ni tamponnée ici, sans erreur. */
export class MigrationDifferee extends Error {
  override name = "MigrationDifferee";
}
