// SPDX-License-Identifier: MIT
/** apps/core/src/memoire/index.ts — API de la mémoire unifiée (magasins Markdown, portées, journal, gestionnaire) pour l'outil `memory` et les routes. */
export { MarkdownMemoryProvider, MemoryProvider } from "./fournisseur";
export type { ReglagesFournisseur } from "./fournisseur";
export { buildDefaultManager, MemoryManager } from "./gestionnaire";
export type { OptionsFabrique, OptionsGestionnaire } from "./gestionnaire";
export * as memoryJournal from "./journal";
export type { Ecriture } from "./journal";
export {
  computeEntryId,
  DEFAULT_LOCK_TIMEOUT_S,
  DELIM,
  entryIds,
  MarkdownStore,
  normalizeForMatch,
  parseEntries,
  resolveTarget,
  sanitizeEntryText,
  serialize,
  storeTransaction,
  StoreBusyError,
  StoreReadError,
} from "./magasin";
export type { OptionsMagasin, ResolutionCible, StoreOpResult } from "./magasin";
export { migrateLegacyMemory } from "./migration";
export {
  cheminPy,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_USER_LIMIT,
  LEGACY_MEMORY_SUBDIR,
  MEMORY_SUBDIR,
  resolvePaths,
  safeUsername,
  scopeHash,
  storeFor,
} from "./portee";
export type { Limites } from "./portee";
export {
  asEnum,
  errEnvelope,
  fmtEntry,
  identiteMemoire,
  isoDay,
  limitesMemoire,
  memory,
  safeChatIdOutil,
  safeUsernameOutil,
  sessionSearch,
  unquote,
} from "./outil";
export type {
  ArgsMemoire,
  ArgsSessionSearch,
  DependancesMemoire,
  DependancesSessionSearch,
  IdentiteAppel,
} from "./outil";
export { comptesMemoire, indexSessions, installerComptesMemoire, installerIndexSessions } from "./ports";
export type { MessageIndexe, PortComptesMemoire, PortIndexSessions } from "./ports";
export {
  ftsSearchSql,
  ftsSnippetSql,
  ftsTerms,
  manualExcerpt,
  MESSAGE_MAX_CHARS,
  SEARCH_ROLES,
  sessionIndexMessage,
  sessionIndexMessages,
  sessionMessageByRef,
  sessionSearchFts,
  sessionSearchSnippets,
} from "./sessions";
export type { ExtraitSession, LigneSession, MessageAIndexer, MessageSession } from "./sessions";
