// SPDX-License-Identifier: MIT
/** apps/core/src/outils/todo/index.ts — logique pure de l'outil `todowrite` (normalisation, résultat, corps) à brancher sur le socle MCP. */
export { dependancesTodo, chargerPrecedente, persister, todoItemDump, todowrite } from "./ecriture";
export type { DependancesTodo } from "./ecriture";
export {
  coerce,
  MAX_CONTENT_CHARS,
  MAX_TODOS,
  normalize,
  normStatus,
  normText,
  signature,
  similar,
  strictItemSchema,
  VALID_PRIORITY,
  VALID_STATUS,
} from "./normalisation";
export type { TodoNormalise } from "./normalisation";
export { buildResult } from "./resultat";
export type { FonctionPersistance, ResultatTodoWrite } from "./resultat";
