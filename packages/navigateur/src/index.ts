// SPDX-License-Identifier: MIT
/** packages/navigateur/src/index.ts — navigateur partagé du core et de l'hôte d'outils : propriété des sessions Playwright, garde des destinations, mémoire AX des sites, client du service navigateur. */
export {
  extractPwScreenshotUrl,
  getPwSessionOwner,
  proprietaire,
  PW_VERB_ALIASES,
  pwOwner,
  pwOwnerEnfant,
  pwOwnerPath,
  pwOwnersDir,
  pwVerbOf,
  recordPwSessionOwner,
  registerPwSessionOwner,
  trackPwSessionOwnership,
  unregisterPwSessionOwner,
} from "./session";
export { hostAddresses, jugeRelaisBac, reglagesJugeBac } from "./url";
export type { HoteNavigateur, OptionsGardeNavigateur, ProfilRelais } from "./url";
export { cheminsNavigateurBac, jetonDuBac, requeteService, serviceNavigateur, servicesDesBacs } from "./mode";
export type { ServiceNavigateur } from "./mode";
export {
  autoriteARenouveler,
  chargerAutorite,
  dossierAutorite,
  Feuilles,
  reglagesAutorite,
} from "./autorite";
export type { Autorite } from "./autorite";
export {
  defisAuth,
  formesValeur,
  origineDe as origineDuRelais,
  Purgeur,
  reglagesRelaisNavigateur,
  RelaisNavigateur,
  remplacerOctets,
  reponseDigest,
  valeurPourCorps,
} from "./relais";
export type { IdentifiantsRelais, JugeRelais, LiaisonRelais, VerdictRelais } from "./relais";
export {
  AX_INJECT_MIN_SIGNAL,
  cheminInerte,
  cibleInerte,
  deleteCredentials,
  deleteOwnerCredentials,
  deleteSite,
  deleteSitesBulk,
  detectSessionUrl,
  detectSitesFromText,
  getSiteStats,
  getTreeJson,
  listSitesWithStats,
  loadDomTree,
  markSiteStale,
  nomInerte,
  normalizeUrl,
  origineExacte,
  renderFocusedDomForPrompt,
  renderFullDomForPrompt,
  renderSelector,
  renderSiteContextual,
  roleInerte,
  selecteurInerte,
  siteSignal,
  verrouAx,
  wipeAll,
} from "./ax";
export type { IdentifiantSite, IdentifiantsDesSites, NoeudDom, PageDom, Selecteur, Suppressions } from "./ax";
export {
  extractSelectorsFromKwargs,
  findPath,
  inferRegion,
  isActionSuccess,
  nodeKey,
  recordAction,
  recordInspection,
  searchNodes,
} from "./ax-actions";
export type { Action } from "./ax-actions";
export {
  avecProprietaire,
  axExtractNodesFromInspect,
  budgetResultat,
  buildLocatorPayload,
  clampItems,
  classerErreur,
  ClientNavigateur,
  clipResult,
  codeNavigateur,
  corpsJson,
  DSL_KEYS,
  dslToByKw,
  dslToSelector,
  echapperDsl,
  encoderParams,
  errPw,
  first,
  mergeTarget,
  mergeValue,
  parseTargetDsl,
  POINTS_D_ENTREE,
  pwVerb,
  rappelOnglet,
  refusSessionDAutrui,
  sansAnsi,
  SCREENSHOT_URL_PREFIX,
  screenshotResult,
  waitPayload,
} from "./client";
export type { Echec, Locateur, OptionsClientNavigateur, OptionsRequete } from "./client";
