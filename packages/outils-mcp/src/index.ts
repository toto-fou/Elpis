// SPDX-License-Identifier: MIT
/** packages/outils-mcp/src/index.ts — point d'entrée de @elpis/outils-mcp : boîte à outils et serveur MCP des familles d'outils. */
export {
  asBool,
  asEnum,
  asInt,
  asList,
  asStr,
  brancherSurchargesErreurs,
  clipText,
  err,
  foldConfusable,
  getChatId,
  getUsername,
  globMatch,
  headTail,
  Heartbeat,
  HEARTBEAT_S,
  LIST_BUDGET,
  LIVE_KIND_HEARTBEAT,
  LIVE_KIND_SHELL,
  LIVE_LOGGER_HEARTBEAT,
  LIVE_LOGGER_SHELL,
  liveNotify,
  ok,
  page,
  POLICY_KEYS,
  readMetaField,
  safeChatId,
  safeUsername,
  tagKw,
  TEXT_BUDGET,
  tokenIdentity,
  toolKw,
  toolKwDestructive,
  toolKwIdempotent,
  toolKwMutating,
  toolKwOpenworld,
  toolKwReadonly,
  twinMessage,
  unicodeTwinWarning,
  unquote,
  withPolicy,
} from "./boite";
export type { Categorie, KwOutil, OptionsErr, Politique } from "./boite";
export { contenuElide, contientContenuElide, estContenuElide } from "./contenu-elide";
export { avecJeton, getAccessToken, NIVEAUX_JOURNAL } from "./contexte";
export type { ContexteAppel, JetonAcces, NiveauJournal, OptionsJournal } from "./contexte";
export { estEnveloppeErreur } from "./modeles";
export type * from "./modeles";
export { jsonPydantic, titlePy } from "./texte";
export { avant, texteValidationError, tronquerEntree, validerArguments, VERSION_PYDANTIC } from "./arguments";
export type { ResultatArguments, Signature } from "./arguments";
export {
  CONC_MAX,
  CONC_PER_USER,
  CONC_WAIT_S,
  ErreurOutil,
  LimiteConcurrence,
  LimiteDebit,
  RATE_BURST,
  RATE_RPS,
  SeauJetons,
} from "./limites";
export { familleDuChemin, famillesCachees } from "./portee";
export {
  CAPACITES,
  decoderCurseur,
  encoderCurseur,
  ErreurProtocole,
  ResultatBrut,
  SERVER_INSTRUCTIONS,
  ServeurOutils,
  VERSION_PROTOCOLE_DEFAUT,
  VERSIONS_PROTOCOLE,
  versionElpis,
} from "./serveur";
export type {
  ContexteRequete,
  DefinitionOutil,
  DefinitionRessource,
  FamilleAEnregistrer,
  IdentiteDistante,
  OptionsServeur,
  PortRappelIdentite,
  SessionOutils,
} from "./serveur";
export {
  chargerJetons,
  construireTable,
  creerVerificateur,
  erreurConfigJetons,
  jetonDelegue,
  liaisonPermise,
  OPENCODE_CLIENT_PREFIX,
  OPENCODE_TOKEN_PREFIX,
  SCOPE_LOCAL_TOOLS,
  TOOLS_CLIENT_PREFIX,
  TOOLS_TOKEN_PREFIX,
  VerificateurJetons,
} from "./jetons";
export type { IdentiteJeton, PortIntrospection, ResolveurJetonPersonnel } from "./jetons";
export { HTTP_MOUNT_PATH, MESSAGES_PATH, serialiserMessage, ServiceMcpHttp, SSE_MOUNT_PATH } from "./http";
export type { OptionsRequete, OptionsServiceHttp, TransformationEntetes } from "./http";
export { ouvrirEnMemoire } from "./memoire";
export type { ConnexionEnMemoire } from "./memoire";
export { ecartsSignature, outilDuGolden, schemaDAnnotation, signatureDuGolden } from "./goldens";
export type { Golden, ParametrePython } from "./goldens";
