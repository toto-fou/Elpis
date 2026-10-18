// SPDX-License-Identifier: MIT
/** apps/core/src/evenements/index.ts — bus d'événements en mémoire, canal interne main → admin, redémarrage nécessaire. */
export { brancherEvenements, RECYCLAGE, urlMainInterne } from "./branchement";
export type { Evenements, OptionsAdmin, OptionsMain } from "./branchement";
export {
  AbonnementCanal,
  CanalInterne,
  delaiReconnexion,
  lireStatutMain,
  publierVersMain,
  servirCanal,
  TYPES_CONSOLE,
} from "./canal";
export type { AppelInterne, OptionsAbonnement } from "./canal";
export { cronMatches } from "./cron";
export { ABANDON, DELAI, FileAttente } from "./file";
export {
  cheminJournalCommun,
  ecrivainJournalCommun,
  KEPT_ROTATIONS,
  ligneJournal,
  LOG_MAX_BYTES,
  tournerSiPlein,
} from "./journal-commun";
export type { EcrivainJournal } from "./journal-commun";
export { FileTail, logRecordToEvent, SuiviJournalStaff } from "./journal-staff";
export { PipelineEvents } from "./pipeline";
export type { OptionsListenPipeline, Rendu, StatsPipeline } from "./pipeline";
export {
  digest,
  digests,
  EmpreinteDemarrage,
  EXTRA_BOOT_PATHS,
  getChemin,
  MISSING,
  pending,
  restartPaths,
} from "./redemarrage";
export type { Empreinte, SourceRedemarrage, StatutMain } from "./redemarrage";
export { applySessionRevocation } from "./revocation";
export type { BilanRevocation, CiblesRevocation } from "./revocation";
export { familleEvenements, identiteDeSession, TYPES_ADMIN, TYPES_CONTROLE } from "./routes";
export type { IdentiteFlux, ResoudreIdentite } from "./routes";
export {
  AnalyseurSse,
  encoderDonneeSse,
  encoderEvenementSse,
  ENTETES_SSE,
  horodatagePing,
  servirFluxSse,
  tramePing,
} from "./sse";
export type { EvenementSse } from "./sse";
export { CLIENT_CLOSED, SystemEvents } from "./systeme";
export type { EcrireJournal, LigneJournal, Message, OptionsListen, VerifierSession } from "./systeme";
