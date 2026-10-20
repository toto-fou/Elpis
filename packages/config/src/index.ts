// SPDX-License-Identifier: MIT
/** packages/config/src/index.ts — point d'entrée de @elpis/config : objet `config`, rechargement, surcharge de test et fonctions de config.py. */
import { config, remplacerConfig } from "./instance";
import type { Reglages } from "./reglages";
import { invalidateConfigCache, reinitialiserCaches } from "./vivant";

export { bootRaw, config, racineDepot } from "./instance";
export { CHARS_PER_TOKEN, cheminContextConfig, outilsEteints } from "./contexte";
export {
  buildIdDepuis,
  buildIdValide,
  builtinLocalMcpDepuis,
  builtinLocalMcpUrlDepuis,
  calculerReglages,
  coerceDesktopTargets,
  DB_BACKENDS_RETIRED,
  HOT_RELOAD_PATHS,
  HOT_RELOAD_PREFIXES,
  parseClientTokenFamilies,
  parseClientTokens,
  propagerEnv,
  retiredBackendMessage,
  typeMoteurLlama,
  urlChatLlama,
  WEAK_SESSION_SECRETS,
} from "./reglages";
export type { CibleDesktop, Reglages } from "./reglages";
export {
  asBool,
  asFloat,
  asInt,
  asStr,
  deepGet,
  parseJsonPy,
  pyJoin,
  pyParent,
  pyPath,
  readJsonFile,
  realpathPy,
  resolveConfigJsonPath,
  resolvePath,
  resolveRel,
} from "./brut";
export type { Dict, Env } from "./brut";
export {
  builtinLocalMcp,
  builtinLocalMcpUrl,
  configView,
  dbPassword,
  featureEnabled,
  getDesktopTarget,
  getDesktopTargets,
  httpsEnabled,
  httpsPorts,
  invalidateConfigCache,
  liveConfigValue,
  marquerCompressionAJour,
  maxRecentChats,
  readConfigJson,
  readLocalMcpTokenFile,
  reinitialiserCaches,
  reloadCompressionConfigFromDisk,
  reloadDesktopConfigFromDisk,
  reloadMemoryConfigFromDisk,
  safeSandboxName,
  sandboxImportMaxPct,
  sessionCookieAttrs,
  writeConfigJson,
  writeTextAtomic,
} from "./vivant";
export type { AttributsCookie, PortsHttps } from "./vivant";

/** Recalcule `config` depuis l'env et le disque, caches remis à neuf, comme `importlib.reload` (l'env déjà propagée prime). */
export function rechargerConfig(): void {
  remplacerConfig();
  reinitialiserCaches();
}

/** Aide de test : remplace des réglages et rend la fonction qui remet les précédents. */
export function surchargerConfig(partiel: Partial<Reglages>): () => void {
  const avant: Partial<Reglages> = {};
  for (const cle of Object.keys(partiel) as (keyof Reglages)[]) Object.assign(avant, { [cle]: config[cle] });
  Object.assign(config, partiel);
  invalidateConfigCache();
  return () => {
    Object.assign(config, avant);
    invalidateConfigCache();
  };
}
export {
  CONFIG_ILLISIBLE,
  lireConfigDisque,
  mettreAJourConfigJson,
  sousVerrouConfigJson,
} from "./config-json";
