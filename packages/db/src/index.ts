// SPDX-License-Identifier: MIT
/** packages/db/src/index.ts — point d'entrée : ouverture d'une base SQLite ou PostgreSQL, dialectes, erreurs. */
export { ouvrirBase } from "./ouvrir";
export type { OptionsBase, ReglagesBase } from "./ouvrir";
export {
  creerGardeGeneration,
  demarrerBase,
  generationPubliee,
  nettoyerSousVerrou,
  prendreVerrouSchema,
  reglagesBase,
} from "./demarrage";
export type { OptionsDemarrage } from "./demarrage";

export type { Base, Executeur, Ligne, Parametres, Resultat, StatsPool, Valeur } from "./base";
export type { ReglagesPostgres } from "./postgres";
export type { ReglagesSqlite } from "./sqlite";
export * from "./dialecte";
export * from "./erreurs";
export { firstWord, qmarkVersDollar, splitStatements } from "./sql";
export {
  addMissingColumns,
  createAll,
  createIndexSql,
  createTableSql,
  ensureFts,
  ensureTables,
  ErreurSchema,
  pgFtsDocument,
  hasTable,
  isFresh,
  q,
  tableColumns,
  tableNames,
  tableParNom,
} from "./schema";
export type { Col, Fk, Index, RapportFts, RapportSchema, Table, TypeCol } from "./schema";
export {
  importerIdentifiantsAx,
  nomDepuisSite,
  retirerIdentifiantsAxDuCompte,
  retirerIdentifiantsAxOrphelins,
  TABLE_IDENTIFIANTS_AX,
} from "./coffre-heritage";
export { BASELINE_COVERS, MIGRATIONS_PYTHON, TABLES } from "./schema.gen";
export {
  decrireEmplacement,
  durcirDroits,
  ErreurBaseNonAJour,
  infoBase,
  initialiserBase,
  MIGRATIONS_TS,
  registreMigrations,
  walCheckpoint,
} from "./init";
export type { InfoBase, Migration, OptionsInfo, RapportInit } from "./init";
