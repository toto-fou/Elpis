// SPDX-License-Identifier: MIT
/** packages/auth/src/index.ts — sessions, CSRF, gardes d'accès, révocations et jetons personnels du core. */
export { enteteCookie, enteteEffacement, lireSession, signerSession, valeurCookie } from "./cookie";
export { estInterSite, METHODES_MUTANTES, netlocUrl, PREFIXES_EXEMPTES_CSRF } from "./csrf";
export type { Entetes } from "./csrf";
export {
  CHEMINS_SI_MOT_DE_PASSE_A_CHANGER,
  creerGardes,
  exigerJetonInterne,
  exigerJetonService,
  exigerRole,
  dependancesSession,
  exigerUtilisateur,
  ligneUtilisateur,
  revaliderFlux,
} from "./garde";
export type { DependancesAuth, GardeAuth } from "./garde";
export { installerAuth } from "./installer";
export {
  adressePair,
  analyserMandataires,
  estMandataireDeConfiance,
  ipClient,
  MANDATAIRES_DU_JOURNAL_PAR_DEFAUT,
  mandatairesDuJournal,
} from "./ip-client";
export type { Reseau } from "./ip-client";
export { estLocalDirect, MANDATAIRES_DE_CONFIANCE } from "./local";
export {
  effacerMinSession,
  estRevoquee,
  leverMinSession,
  purgerRevocations,
  revoquerSid,
} from "./revocations";
export { fluxEncoreValide, Session, validerSession } from "./session";
export type { DependancesSession, LigneUtilisateur } from "./session";
export {
  convertirAnciensJetons,
  creerJeton,
  ErreurJeton,
  FAMILLES_EXTERNES,
  familles,
  lireJeton,
  listerJetons,
  nomPropre,
  opencodeActif,
  politique,
  PREFIXES,
  regenererJeton,
  resoudreJeton,
  revoquerJeton,
  revoquerTousAcces,
  revoquerType,
  supprimerJetonsCompte,
  toucherJeton,
  typeDe,
  TYPES,
  validerDemandeOutils,
  verifierQuota,
  VISION_TTL_S,
} from "./jetons";
export type { DependancesJetons, Jeton, JetonResolu, Politique, TypeJeton } from "./jetons";
export { dependancesParDefaut } from "./defaut";
export {
  createUser,
  ErreurNomUtilisateur,
  getAllUsers,
  getUser,
  getUserGroups,
  getUsernameById,
  getUserSettings,
  getUsersLite,
  mergeUserSettings,
  nomCanonique,
  rehacherSiAncien,
  reglagesDepuis,
  reglagesEnJson,
  resetUserPassword,
  updateUserAvatar,
  validerNomUtilisateur,
  verifyUser,
} from "./comptes";
export type { CompteLite, CompteResume, Groupe } from "./comptes";
export {
  createGroup,
  deleteGroup,
  ErreurGroupe,
  getAllUsersWithGroups,
  getGroup,
  listGroups,
  setUserGroups,
  updateGroup,
} from "./groupes";
export {
  ACCESS_PREFIX,
  authenticateClient,
  checkResource,
  CODE_TTL_S,
  deleteClient,
  empreinte,
  ErreurOAuth,
  estBoucleLocale,
  estClientCimd,
  exchangeCode,
  famillesDePortee,
  fetchCimd,
  getClient,
  issueCode,
  listClients,
  listGrants,
  MAX_CLIENTS,
  pkceOk,
  politiqueOauth,
  portee,
  redirectionCorrespond,
  redirectionPermise,
  refresh,
  REFRESH_PREFIX,
  registerClient,
  resolveClient,
  RESOURCE_PATH,
  resourceBase,
  resourceFamily,
  revokeGrant,
  revokeToken,
  revoquerOauthDuCompte,
  supprimerOauthCompte,
  SCOPE_ALL,
  SCOPE_PREFIX,
  scopesSupported,
  validerMetadonnees,
  verifyAccessToken,
} from "./oauth";
export type {
  ClientDuRelais,
  ClientOAuth,
  DemandeCode,
  DependancesOAuth,
  Echange,
  MetadonneesClient,
  PolitiqueOAuth,
  Rafraichissement,
} from "./oauth";
