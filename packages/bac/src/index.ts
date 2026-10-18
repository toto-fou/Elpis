// SPDX-License-Identifier: MIT
/** packages/bac/src/index.ts — point d'entrée de @elpis/bac : bac à sable partagé par le core, l'hôte d'outils et les familles d'outils. */
export { definirFabriqueAgent, erreurAgent, estErreurAgent, fabriqueAgent, PANNES_AGENT } from "./agent";
export type {
  AgentBac,
  ArchiveAgent,
  BacPourAgent,
  DonneesEnvoi,
  ErreurAgent,
  EtatBac,
  FabriqueAgent,
  OptionsArchive,
  OptionsExtraction,
} from "./agent";
export * as bwrap from "./bwrap";
export { CaptureBornee, execCaptureMaxBytes } from "./capture";
export {
  ensureImageLoaded,
  getImageLoadState,
  imageStateDict,
  reglagesChargement,
  resetImageLoadState,
} from "./chargeur-image";
export type { ImageLoadState, ImageLoadStatus } from "./chargeur-image";
export { codeRetour, DockerCli, ErreurLancement } from "./cli";
export type { CliDocker, OptionsAppel, ProcessusDocker, ReponseDocker } from "./cli";
export {
  CAPABILITIES,
  ExecError,
  loadAdminConfig,
  racinePrivee,
  reglagesBac,
  resolveNetworkProfileIdReglages,
  resolveProfileDomains,
  RUN_SPEC,
  sandboxAdminConfigDepuis,
  UserSandbox,
} from "./conteneur";
export type {
  ChargeurImage,
  ConfigSandbox,
  ExecResult,
  OptionsExec,
  OptionsUserSandbox,
  ResolveurDomaines,
} from "./conteneur";
export { reglagesCycle, sousVerrouDeCycle, verrouDeCycle } from "./cycle";
export { arreterReadinessCache, getReadinessCache, ReadinessCache } from "./disponibilite";
export {
  appelDocker,
  binaireDocker,
  CONTAINER_PREFIX,
  containerName,
  decoderRemplace,
  label,
  labelFilter,
  LABEL_NS,
  labelTpl,
  which,
} from "./docker";
export type { OptionsAppelDocker, ResultatDocker } from "./docker";
export { candidateTarPaths, configuredImage, DEFAULT_IMAGE, findImageArchive } from "./image";
export {
  AGENT_MOUNT,
  AGENT_RUN_DIR,
  AGENT_SOCKET,
  agentDir,
  agentEmpreinte,
  reglagesMontages,
  RELAY_DIR,
  RELAY_MOUNT,
} from "./montages";
export * as privdrop from "./privdrop";
export { messageSuppression, supprimerDossierBac } from "./suppression";
export {
  chargerConfigBac,
  configBacDepuis,
  DOMAIN_RE,
  netcfgHash,
  oublierSignalements,
  PROFILE_ID_RE,
  profilParId,
  profilReseauDepuis,
  signalerUneFois,
} from "./profils";
export type { Avertir, ConfigBac, ProfilReseau } from "./profils";
export {
  agentFor,
  bacDeLOutil,
  bacDuCompte,
  ensureContainerRunning,
  forgetPreviewIp,
  getUserSandbox,
  ipConteneurApercu,
  mib,
  previewContainerIp,
  profilDuBac,
  profilReseauEffectif,
  profilRetenu,
  racineTravail,
  resetUserSandboxCache,
  retenirChoixProfil,
  runningContainerStats,
} from "./registre";
export type { IpConteneurApercu, PortProfilRappel } from "./registre";
export {
  assainirSeuilsDisque,
  BORNES_DISQUE,
  DEFAUTS_DISQUE,
  seuilsDisque,
  seuilsDisqueDepuis,
} from "./seuils-disque";
export type { SeuilsDisque } from "./seuils-disque";
export {
  balayerPartsOrphelines,
  bumpSandboxUsage,
  invalidateSandboxUsage,
  oublierOccupations,
  sandboxUsageBytes,
  tailleBac,
  UPLOAD_TMP_SUFFIX,
} from "./usage";
export {
  ensureWorkSubdir,
  MODES_MARKER,
  PERMS_MARKER_LEGACY,
  WORK_LOCK,
  WORK_MARKER,
  WORK_RESERVED,
  WORK_SUBDIR,
} from "./travail";
