// SPDX-License-Identifier: MIT
/** packages/securite/src/index.ts — point d'entrée de la sécurité partagée du core et du toolhost. */
export {
  coerceToFernetKey,
  configurerChiffrement,
  decrypt,
  deriveFernetKey,
  encrypt,
  EncryptionUnavailable,
  encryptionKeyPath,
  Fernet,
  InvalidToken,
  loadOrCreateKey,
} from "./chiffrement";
export type { SourceCle } from "./chiffrement";
export {
  avecIdentite,
  creerIdentite,
  current,
  DELEGATION_AUDIENCE,
  DELEGATION_HEADER,
  forgetAll,
  fromMeta,
  IDENTITY_HEADER,
  identityAsRow,
  identityFromDict,
  identityToDict,
  MAX_SKEW_S,
  REGISTRY_MAX,
  remember,
  resolveForcedNetworkProfileId,
  resolveNetworkProfileId,
  resolveUser,
  resolveUsername,
  sign,
  signClaims,
  userIdFor,
  usernameFor,
  userNetworkProfileId,
  verify,
  verifyClaims,
} from "./identite";
export type { ChampsIdentite, Identity, OptionsSignature, OptionsVerification } from "./identite";
export {
  bytesFromHex,
  compareDigest,
  egauxEnTempsConstant,
  hachageAJour,
  hashPassword,
  maxWorkers,
  PASSWORD_ITERATIONS,
  runPasswordOp,
  shutdownPasswordPool,
  tokenDigest,
  tokenHex,
  tokenUrlsafe,
  verifyPassword,
} from "./mots-de-passe";
export { brancherComptes, brancherJournal } from "./ports";
export type { ComptesEnBase, FabriqueJournal, Journal } from "./ports";
export { urlsafeB64Decode } from "./base64";
export {
  auditCodeExec,
  auditEvent,
  auditLogin,
  configureAudit,
  defaultAuditDir,
  defaultAuditKeyPath,
  oublierConfigurationAudit,
  readRecentAuditLines,
} from "./audit";
export type { EvenementAudit, FiltresAudit, ReglagesAudit } from "./audit";
export { CONTEXTE_JETON_INTERNE, jetonInterne } from "./interne";
export { adresseCritique, blockRemoteUrlReason, GIT_REMOTE_SCHEMES } from "./ssrf";
export { cibleNonAmbigue, urlNonAmbigue } from "./url-whatwg";
export type { OptionsGardeUrl, Resolveur } from "./ssrf";
export {
  CONTAINER_ROOT,
  ecrireSous,
  ErreurCheminBac,
  feuilleCourte,
  lexicalRel,
  lireDossierBrut,
  modeEntree,
  O_PATH,
  ouvrirDossierSous,
  ouvrirFeuille,
  parcourirSous,
  relParts,
  relUnder,
  rouvrir,
  saisirEntree,
  stripWorkPrefix,
  supprimerArbreSous,
  supprimerEntreeSous,
  toContainer,
} from "./confinement";
export type { DossierParcouru, EntreeBrute, OptionsEcritureSous, OptionsLexical } from "./confinement";
export { cheminDiff, masquer, masquerSecretsTexte, secretsDuDiff } from "./secrets";
export type { Trouvaille } from "./secrets";
export {
  cheminsEcrits,
  envShellSousAgent,
  FIX_SOUS_AGENT,
  lireSousAgent,
  outilPermisSousAgent,
  OUTILS_JAMAIS_SOUS_AGENT,
  OUTILS_RETIRES_PAR_TYPE,
  refusSousAgent,
  REFUS_FOND_SOUS_AGENT,
  REFUS_TACHE_SOUS_AGENT,
  refusHorsChemins,
  relatifBac,
  SHELL_SOUS_AGENT_DELAI_DEFAUT_S,
  SHELL_SOUS_AGENT_DELAI_MAX_S,
  SESSIONS_NAVIGATEUR,
  sousAgentEnDict,
  sousPrefixes,
  TYPE_AGENT_PERSONNALISE,
  TYPES_AGENTS_LIVRES,
  TYPES_AGENTS_REGLABLES,
} from "./sous-agent";
export type { RefusSousAgent, SessionNavigateur, SousAgent } from "./sous-agent";
