// SPDX-License-Identifier: MIT
/** packages/db/src/ouvrir.ts — ouverture d'une base SQLite ou PostgreSQL selon ses réglages. */
import type { Base } from "./base";
import { BasePostgres } from "./postgres";
import type { ReglagesPostgres } from "./postgres";
import { BaseSqlite } from "./sqlite";
import type { ReglagesSqlite } from "./sqlite";

export type ReglagesBase = ReglagesSqlite | ReglagesPostgres;

export interface OptionsBase {
  /** Appelée avant chaque emprunt ; lève pour refuser (base basculée depuis le démarrage, comme `_generation_guard`). */
  garde?: () => void;
}

export function ouvrirBase(reglages: ReglagesBase, options: OptionsBase = {}): Base {
  return reglages.backend === "sqlite"
    ? new BaseSqlite(reglages, options.garde)
    : new BasePostgres(reglages, options.garde);
}
