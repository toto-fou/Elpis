// SPDX-License-Identifier: MIT
/** packages/securite/src/index.ts — point d'entrée de la sécurité partagée du core et du toolhost. */
export {
  coerceToFernetKey,
  cleFernetPresente,
  configurerChiffrement,
  decrypt,
  decryptStrict,
  deriveFernetKey,
  encrypt,
  EncryptionUnavailable,
  encryptionKeyPath,
  estJetonFernet,
  Fernet,
  InvalidToken,
  loadOrCreateKey,
} from "./chiffrement";
export type { SourceCle } from "./chiffrement";
export {
  aadCoffre,
  aadWebhookRoutine,
  chargerCleCoffre,
  chiffrerSecret,
  cleCoffre,
  CleCoffreIndisponible,
  coffreConfigure,
  configurerCoffre,
  dechiffrerSecret,
  etatCleCoffre,
  FICHIER_CLE_COFFRE,
  kidCoffre,
  kidDe,
  lireCleCoffre,
  nomDeriveCoffre,
  octetsCleCoffre,
  reglagesCoffreDeLEnvironnement,
  REPLI_CLE_COFFRE,
  SecretIndechiffrable,
  validerCleCoffre,
} from "./coffre";
export type { CleCoffre, ColonnesLieesCoffre, ReglagesCoffre, SourceCleCoffre } from "./coffre";
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
  arreterAudit,
  auditCodeExec,
  auditEvent,
  auditLogin,
  cleAuditCourante,
  configureAudit,
  defaultAuditDir,
  defaultAuditKeyPath,
  demarrerAudit,
  empreinteIdentifiant,
  etatEcritureAudit,
  FICHIER_AUDIT,
  issueParDefaut,
  JOUR_AUDIT,
  lireCleAudit,
  oublierConfigurationAudit,
  texteBorne,
} from "./audit";
export type { EvenementAudit, IssueAudit, ReglagesAudit } from "./audit";
export { auditLecture, auditRafale, viderRafalesAudit } from "./audit-agregat";
export { verifierJournalAudit } from "./audit-verification";
export type { ResultatVerificationAudit } from "./audit-verification";
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
export {
  GLUON,
  neutraliserJetonsRole,
  neutraliserMarqueursTour,
  OUTILS_SANS_RESTAURATION,
  restaurerArgsOutil,
  restaurerMarqueursArgs,
  restaurerMarqueursTour,
} from "@elpis/commun/marqueurs-tour";
export {
  cheminDiff,
  masquer,
  masquerArgv,
  masquerCommandeShell,
  masquerSecretsTexte,
  secretsDuDiff,
} from "./secrets";
export type { Trouvaille } from "./secrets";
export {
  envShellSousAgent,
  FIX_SOUS_AGENT,
  lireSousAgent,
  outilPermisSousAgent,
  OUTILS_JAMAIS_SOUS_AGENT,
  REFUS_FOND_SOUS_AGENT,
  REFUS_TACHE_SOUS_AGENT,
  relatifBac,
  SHELL_SOUS_AGENT_DELAI_DEFAUT_S,
  SHELL_SOUS_AGENT_DELAI_MAX_S,
  sousAgentEnDict,
  TYPE_AGENT_PERSONNALISE,
  TYPES_AGENTS_LIVRES,
  TYPES_AGENTS_REGLABLES,
} from "./sous-agent";
export type { SessionNavigateur, SousAgent, SousAgentHote } from "./sous-agent";
