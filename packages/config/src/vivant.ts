// SPDX-License-Identifier: MIT
/** packages/config/src/vivant.ts — config.json relu à chaud (cache), écriture atomique, rechargements et fonctions publiques de config.py. */
import { randomInt } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";

import {
  copieProfondePy,
  ErreurPython,
  intPy,
  maxPy,
  minPy,
  pyJsonDumps,
  strPy,
  stripPy,
  veritePy,
} from "@elpis/commun";

import {
  asFloat,
  asInt,
  asStr,
  deepGet,
  ecrireTout,
  estDict,
  estErreurSysteme,
  gelerProfond,
  getPy,
  lireTextePy,
  ouPy,
  pyJoin,
  pyParent,
  pyPath,
  readJsonFile,
} from "./brut";
import type { Dict } from "./brut";
import { config } from "./instance";
import {
  builtinLocalMcpDepuis,
  builtinLocalMcpUrlDepuis,
  coerceDesktopTargets,
  lireJetonLocal,
  normaliserUrlCompression,
} from "./reglages";
import type { CibleDesktop } from "./reglages";

export interface AttributsCookie {
  cookie_name: string;
  same_site: string;
  https_only: boolean;
  max_age: number;
}

export interface PortsHttps {
  main: number;
  admin: number;
  rag: number;
}

const PEREMPTION_MS = 1000;
const VIDE: Readonly<Dict> = Object.freeze({});

let cacheCle: string | null = null;
let cacheValeur: Readonly<Dict> = VIDE;
let cacheA = 0;
const derniersRechargements = { desktop: 0, compression: 0, memoire: 0 };

function borner(bas: number, haut: number, x: number): number {
  return maxPy(bas, minPy(haut, x));
}

/** Vue partagée et gelée de config.json : relue si mtime, taille ou inode changent, et au plus tard après 1 s. */
export function configView(): Readonly<Dict> {
  let cle: string;
  try {
    const st = statSync(config.CONFIG_JSON_PATH, { bigint: true });
    cle = `${st.mtimeNs}:${st.size}:${st.ino}`;
  } catch {
    invalidateConfigCache();
    return VIDE;
  }
  const maintenant = performance.now();
  if (cle === cacheCle && maintenant - cacheA < PEREMPTION_MS) return cacheValeur;
  const valeur = gelerProfond(readJsonFile(config.CONFIG_JSON_PATH));
  cacheCle = cle;
  cacheValeur = valeur;
  cacheA = maintenant;
  return valeur;
}

export function invalidateConfigCache(): void {
  cacheCle = null;
  cacheValeur = VIDE;
  cacheA = 0;
}

/** Cache vidé et repères de rechargement à zéro, comme après un import neuf du module Python. */
export function reinitialiserCaches(): void {
  invalidateConfigCache();
  derniersRechargements.desktop = 0;
  derniersRechargements.compression = 0;
  derniersRechargements.memoire = 0;
}

/** Copie modifiable de config.json, pour un lire-modifier-écrire. */
export function readConfigJson(): Dict {
  return copieProfondePy(configView()) as Dict;
}

/** Valeur lue sur disque à l'appel (`"a.b.c"`) ; un objet ou une liste est rendu en copie. */
export function liveConfigValue(chemin: string, defaut: unknown = null): unknown {
  try {
    let noeud: unknown = configView();
    for (const partie of chemin.split(".")) {
      if (!estDict(noeud) || !Object.hasOwn(noeud, partie)) return defaut;
      noeud = noeud[partie];
    }
    return estDict(noeud) || Array.isArray(noeud) ? copieProfondePy(noeud) : noeud;
  } catch {
    return defaut;
  }
}

/** Attributs du cookie de session, source unique du middleware et de la déconnexion ; une section non-dict lève. */
export function sessionCookieAttrs(): AttributsCookie {
  let session: unknown;
  try {
    const securite = ouPy(getPy(configView(), "security"), {});
    session = ouPy(getPy(securite, "session"), {});
  } catch {
    session = {};
  }
  const nom = strPy(ouPy(getPy(session, "cookie_name"), "mcpwebui_session"));
  let sameSite = strPy(ouPy(getPy(session, "same_site"), "lax")).toLowerCase();
  if (!["lax", "strict", "none"].includes(sameSite)) sameSite = "lax";
  let httpsOnly = veritePy(getPy(session, "https_only", false));
  if (sameSite === "none" && !httpsOnly) httpsOnly = true;
  let maxAge: number;
  try {
    maxAge = intPy(getPy(session, "max_age_sec", 86400));
  } catch (e) {
    if (!(e instanceof ErreurPython) || e.type === "OverflowError") throw e;
    maxAge = 86400;
  }
  if (maxAge <= 0) maxAge = 86400;
  return { cookie_name: nom, same_site: sameSite, https_only: httpsOnly, max_age: maxAge };
}

/** Plafond de conversations actives relu à chaque appel ; `APP_MAX_RECENT_CHATS` prime ; plancher 1. */
export function maxRecentChats(): number {
  if (process.env["APP_MAX_RECENT_CHATS"] !== undefined) return maxPy(1, config.MAX_RECENT_CHATS);
  return maxPy(
    1,
    asInt(liveConfigValue("app.max_recent_chats", config.MAX_RECENT_CHATS), config.MAX_RECENT_CHATS),
  );
}

/** `features.<nom>` de config.json, relu à chaque appel ; seul `false` éteint. */
export function featureEnabled(nom: string, defaut = true): boolean {
  try {
    const fonctions = ouPy(getPy(configView(), "features"), {});
    return getPy(fonctions, nom, defaut) !== false;
  } catch {
    return defaut;
  }
}

export function httpsEnabled(): boolean {
  try {
    const securite = ouPy(getPy(configView(), "security"), {});
    return veritePy(getPy(ouPy(getPy(securite, "https"), {}), "enabled", false));
  } catch {
    return false;
  }
}

/** Ports du frontal Caddy ; une seule valeur illisible ramène les trois défauts. */
export function httpsPorts(): PortsHttps {
  try {
    const securite = ouPy(getPy(configView(), "security"), {});
    const https = ouPy(getPy(securite, "https"), {});
    return {
      main: intPy(getPy(https, "main_port", 443)),
      admin: intPy(getPy(https, "admin_port", 8443)),
      rag: intPy(getPy(https, "rag_port", 8444)),
    };
  } catch {
    return { main: 443, admin: 8443, rag: 8444 };
  }
}

/** `app.sandbox_import_max_pct`, relu à chaud, borné à [1, 100] ; un infini lève comme `int()` (OverflowError). */
export function sandboxImportMaxPct(): number {
  let pct: number;
  try {
    const app = getPy(configView(), "app", {});
    pct = intPy(getPy(app, "sandbox_import_max_pct", config.SANDBOX_IMPORT_MAX_PCT_DEFAULT));
  } catch (e) {
    if (!(e instanceof ErreurPython) || e.type === "OverflowError") throw e;
    pct = config.SANDBOX_IMPORT_MAX_PCT_DEFAULT;
  }
  return maxPy(1, minPy(100, pct));
}

/** `APP_DB_PASSWORD`, sinon `.db_password` du dossier de la base (relu à chaque connexion), sinon `""`. */
export function dbPassword(): string {
  const explicite = process.env["APP_DB_PASSWORD"];
  if (explicite) return explicite;
  try {
    return stripPy(lireTextePy(pyJoin(pyParent(config.DB_PATH), ".db_password")));
  } catch (e) {
    if (estErreurSysteme(e)) return "";
    throw e;
  }
}

/** Nom canonique du dossier et du conteneur sandbox : garde `[A-Za-z0-9_-]`, supprime le reste, `guest` si vide. */
export function safeSandboxName(username: string | null | undefined): string {
  if (!username) return "guest";
  return String(username).replace(/[^A-Za-z0-9_-]/g, "") || "guest";
}

export function builtinLocalMcp(): Dict {
  return builtinLocalMcpDepuis(config.LOCAL_MCP_HOST, config.LOCAL_MCP_PORT, config.LOCAL_MCP_SERVERS_RAW);
}

export function builtinLocalMcpUrl(): string {
  return builtinLocalMcpUrlDepuis(builtinLocalMcp());
}

export function readLocalMcpTokenFile(): string {
  return lireJetonLocal(config.LOCAL_MCP_TOKEN_FILE);
}

const CARACTERES_TEMPORAIRES = "abcdefghijklmnopqrstuvwxyz0123456789_";

/** `tempfile.mkstemp` : `<préfixe>XXXXXXXX<suffixe>` créé en exclusif et en 0600. */
function creerTemporaire(dossier: string, prefixe: string, suffixe: string): { fd: number; chemin: string } {
  const drapeaux = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  for (let essai = 0; essai < 10_000; essai++) {
    let nom = "";
    for (let i = 0; i < 8; i++)
      nom += CARACTERES_TEMPORAIRES.charAt(randomInt(CARACTERES_TEMPORAIRES.length));
    const chemin = pyJoin(dossier, `${prefixe}${nom}${suffixe}`);
    try {
      return { fd: openSync(chemin, drapeaux, 0o600), chemin };
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`aucun nom de fichier temporaire libre dans ${dossier}`);
}

function supprimerSiPossible(chemin: string): void {
  try {
    unlinkSync(chemin);
  } catch {
    return;
  }
}

/** Écriture atomique : temporaire unique du même dossier, vidé sur disque, mode du fichier repris (0644 s'il est neuf), renommé. */
export function writeTextAtomic(chemin: string, contenu: string): void {
  const dossier = pyParent(chemin);
  mkdirSync(dossier, { recursive: true });
  if (!contenu.isWellFormed())
    throw new ErreurPython("ValueError", "'utf-8' codec can't encode a lone surrogate");
  const nom = pyPath(chemin).split("/").pop() ?? "";
  const { fd, chemin: temporaire } = creerTemporaire(dossier, `${nom}.`, ".tmp");
  let aNettoyer: string | null = temporaire;
  try {
    try {
      ecrireTout(fd, Buffer.from(contenu, "utf-8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(temporaire, statSync(chemin).mode & 0o777);
    } catch (e) {
      if (!estErreurSysteme(e)) throw e;
      chmodSync(temporaire, 0o644);
    }
    renameSync(temporaire, chemin);
    aNettoyer = null;
  } finally {
    if (aNettoyer !== null) supprimerSiPossible(aNettoyer);
  }
}

/** Écrit config.json comme `json.dumps(…, ensure_ascii=False, indent=2)` puis force la relecture. */
export function writeConfigJson(nouvelle: Readonly<Dict>): void {
  writeTextAtomic(config.CONFIG_JSON_PATH, pyJsonDumps(nouvelle, { ensureAscii: false, indent: 2 }));
  invalidateConfigCache();
}

function mtimeConfig(): number | null {
  try {
    return statSync(config.CONFIG_JSON_PATH).mtimeMs;
  } catch (e) {
    if (estErreurSysteme(e)) return null;
    throw e;
  }
}

/** Lecteurs d'un config.json relu : la valeur courante sert de défaut (l'env n'est pas réappliqué). */
function lecteurs(brut: Dict) {
  return {
    texte: (chemin: string, actuel: string): string => asStr(deepGet(brut, chemin, actuel), actuel),
    entier: (chemin: string, actuel: number): number => asInt(deepGet(brut, chemin, actuel), actuel),
    flottant: (chemin: string, actuel: number): number => asFloat(deepGet(brut, chemin, actuel), actuel),
    vrai: (chemin: string, actuel: boolean): boolean => veritePy(deepGet(brut, chemin, actuel)),
  };
}

/** Resynchronise VISION_* et DESKTOP_* (même sous-ensemble que Python) avec config.json ; vrai si relu. */
export function reloadDesktopConfigFromDisk(force = false): boolean {
  const mtime = mtimeConfig();
  if (mtime === null || (!force && mtime <= derniersRechargements.desktop)) return false;
  const brut = readJsonFile(config.CONFIG_JSON_PATH);
  const { texte, entier } = lecteurs(brut);
  const c = config;
  c.VISION_ENDPOINT_URL = stripPy(texte("vision.endpoint_url", c.VISION_ENDPOINT_URL));
  c.VISION_FORMAT = stripPy(texte("vision.format", c.VISION_FORMAT)).toLowerCase() || "omniparser";
  c.VISION_PROMPT = texte("vision.prompt", c.VISION_PROMPT);
  c.VISION_MODEL = stripPy(texte("vision.model", c.VISION_MODEL));
  c.VISION_PASSES = borner(1, 3, entier("vision.passes", c.VISION_PASSES));
  c.VISION_TIMEOUT_SEC = borner(5, 300, entier("vision.timeout_sec", c.VISION_TIMEOUT_SEC));
  c.VISION_A11Y_SKIP_MIN = maxPy(0, entier("vision.a11y_skip_min", c.VISION_A11Y_SKIP_MIN));
  const carte = deepGet(brut, "vision.response_map", c.VISION_RESPONSE_MAP);
  c.VISION_RESPONSE_MAP = estDict(carte) ? carte : {};
  c.DESKTOP_AGENT_TIMEOUT_SEC = borner(
    5,
    300,
    entier("desktop.agent_timeout_sec", c.DESKTOP_AGENT_TIMEOUT_SEC),
  );
  c.DESKTOP_REPLAY_SELF_HEAL_MAX = maxPy(
    0,
    entier("desktop.replay_self_heal_max", c.DESKTOP_REPLAY_SELF_HEAL_MAX),
  );
  c.DESKTOP_STALE_FRAME_HAM = borner(0, 64, entier("desktop.stale_frame_ham", c.DESKTOP_STALE_FRAME_HAM));
  c.DESKTOP_SCREENSHOT_FORMAT =
    stripPy(texte("desktop.screenshot_format", c.DESKTOP_SCREENSHOT_FORMAT)).toLowerCase() || "png";
  c.DESKTOP_SCREENSHOT_QUALITY = borner(
    40,
    95,
    entier("desktop.screenshot_quality", c.DESKTOP_SCREENSHOT_QUALITY),
  );
  c.DESKTOP_TOOL_RESULT_MAX_CHARS = maxPy(
    8000,
    entier("desktop.tool_result_max_chars", c.DESKTOP_TOOL_RESULT_MAX_CHARS),
  );
  c.DESKTOP_MAX_ELEMENTS_CHAT = borner(
    0,
    400,
    entier("desktop.max_elements_chat", c.DESKTOP_MAX_ELEMENTS_CHAT),
  );
  c.DESKTOP_TARGETS = coerceDesktopTargets(deepGet(brut, "desktop.targets", c.DESKTOP_TARGETS));
  derniersRechargements.desktop = mtime;
  return true;
}

/** Copie des cibles desktop, fraîches du disque par défaut. */
export function getDesktopTargets(recharger = true): CibleDesktop[] {
  if (recharger) {
    try {
      reloadDesktopConfigFromDisk();
    } catch {
      return [...config.DESKTOP_TARGETS];
    }
  }
  return [...config.DESKTOP_TARGETS];
}

/** Cible nommée, sinon celle marquée `default`, sinon la première ; `null` sans cible. */
export function getDesktopTarget(nom = "", recharger = true): CibleDesktop | null {
  const cibles = getDesktopTargets(recharger);
  if (nom) {
    for (const cible of cibles) if (cible.name === nom) return cible;
  }
  for (const cible of cibles) if (cible.default) return cible;
  return cibles[0] ?? null;
}

/** Resynchronise COMPRESSION_*, COMPACTION_* (hors per_run_max) et PRUNE_* (hors every_iters) ; vrai si relu. */
export function reloadCompressionConfigFromDisk(force = false): boolean {
  const mtime = mtimeConfig();
  if (mtime === null || (!force && mtime <= derniersRechargements.compression)) return false;
  const brut = readJsonFile(config.CONFIG_JSON_PATH);
  const { texte, entier, flottant, vrai } = lecteurs(brut);
  const c = config;
  c.COMPRESSION_ENABLED = vrai("llm.compression.enabled", c.COMPRESSION_ENABLED);
  c.COMPRESSION_KEEP_RECENT = borner(
    2,
    50,
    entier("llm.compression.keep_recent_turns", c.COMPRESSION_KEEP_RECENT),
  );
  c.COMPRESSION_KEEP_BRIDGE = borner(
    0,
    20,
    entier("llm.compression.keep_bridge_turns", c.COMPRESSION_KEEP_BRIDGE),
  );
  c.COMPRESSION_EXTERNAL_MODEL = stripPy(
    texte("llm.compression.external_model", c.COMPRESSION_EXTERNAL_MODEL),
  );
  c.COMPRESSION_ENDPOINT_URL = normaliserUrlCompression(
    stripPy(texte("llm.compression.endpoint_url", c.COMPRESSION_ENDPOINT_URL)),
  );
  c.COMPRESSION_ENDPOINT_MODEL = stripPy(
    texte("llm.compression.endpoint_model", c.COMPRESSION_ENDPOINT_MODEL),
  );
  c.COMPRESSION_ENDPOINT_TIMEOUT_SEC = borner(
    10,
    600,
    entier("llm.compression.endpoint_timeout_sec", c.COMPRESSION_ENDPOINT_TIMEOUT_SEC),
  );
  c.COMPRESSION_MAX_PER_CHAT = borner(
    0,
    64,
    entier("llm.compression.max_per_chat", c.COMPRESSION_MAX_PER_CHAT),
  );
  c.COMPACTION_BUFFER_TOKENS = maxPy(0, entier("llm.compaction.buffer_tokens", c.COMPACTION_BUFFER_TOKENS));
  c.COMPACTION_PARTIAL_TARGET_RATIO = borner(
    0.2,
    0.9,
    flottant("llm.compaction.partial_target_ratio", c.COMPACTION_PARTIAL_TARGET_RATIO),
  );
  const seuilPct = entier("llm.compaction.threshold_pct", c.COMPACTION_THRESHOLD_PCT);
  c.COMPACTION_THRESHOLD_PCT = seuilPct <= 0 ? 0 : borner(30, 100, seuilPct);
  const seuilJetons = entier("llm.compaction.threshold_tokens", c.COMPACTION_THRESHOLD_TOKENS);
  c.COMPACTION_THRESHOLD_TOKENS = seuilJetons <= 0 ? 0 : borner(2_048, 4_000_000, seuilJetons);
  c.PRUNE_ENABLED = vrai("llm.prune.enabled", c.PRUNE_ENABLED);
  c.PRUNE_PROTECT_TOKENS = maxPy(0, entier("llm.prune.protect_tokens", c.PRUNE_PROTECT_TOKENS));
  c.PRUNE_MIN_TOKENS = maxPy(0, entier("llm.prune.min_tokens", c.PRUNE_MIN_TOKENS));
  derniersRechargements.compression = mtime;
  return true;
}

/** Après une écriture de `llm.compression` par ce process : son repère suit le fichier (pas de relecture inutile). */
export function marquerCompressionAJour(): void {
  let mtime: number | null;
  try {
    mtime = mtimeConfig();
  } catch {
    return;
  }
  if (mtime !== null) derniersRechargements.compression = mtime;
}

/** Resynchronise MEMORY_ENABLED, MEMORY_MD_CHAR_LIMIT et USER_MD_CHAR_LIMIT ; vrai si relu. */
export function reloadMemoryConfigFromDisk(force = false): boolean {
  const mtime = mtimeConfig();
  if (mtime === null || (!force && mtime <= derniersRechargements.memoire)) return false;
  const { entier, vrai } = lecteurs(readJsonFile(config.CONFIG_JSON_PATH));
  const c = config;
  c.MEMORY_ENABLED = vrai("memory.enabled", c.MEMORY_ENABLED);
  c.MEMORY_MD_CHAR_LIMIT = borner(200, 20000, entier("memory.memory_char_limit", c.MEMORY_MD_CHAR_LIMIT));
  c.USER_MD_CHAR_LIMIT = borner(200, 20000, entier("memory.user_char_limit", c.USER_MD_CHAR_LIMIT));
  derniersRechargements.memoire = mtime;
  return true;
}
