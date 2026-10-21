// SPDX-License-Identifier: MIT
/** packages/config/src/reglages.ts — tous les réglages de config.py (env > config.json > défaut), calculés comme à l'import Python. */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";

import { comparePointsDeCode, intPy, maxPy, minPy, reprPy, strPy, stripPy, veritePy } from "@elpis/commun";
import { avecVerrouSync } from "@elpis/verrous";

import {
  asBool,
  asFloat,
  asInt,
  asStr,
  deepGet,
  ecrireTout,
  envVrai,
  estDict,
  estErreurSysteme,
  getPy,
  lireTextePy,
  ouPy,
  poserCle,
  premiereLignePy,
  pyJoin,
  pyParent,
  pyPath,
  realpathPy,
  resolveConfigJsonPath,
  resolvePath,
  resolveRel,
  rstripPy,
} from "./brut";
import type { Dict, Env } from "./brut";

export interface CibleDesktop {
  name: string;
  os: string;
  agent_url: string;
  /** Jeton partagé avec l'agent de bureau (`agent_token.txt` de la machine) ; vide : `DESKTOP_AGENT_TOKEN` du processus. */
  agent_token: string;
  default: boolean;
  access: string;
  allowed_users: string[];
}

export const HOT_RELOAD_PREFIXES: readonly string[] = Object.freeze([
  "vision.",
  "desktop.",
  "llm.compression.",
  "llm.compaction.",
  "llm.prune.",
  "memory.",
  "mcp.tokens.",
  "mcp.oauth.",
]);

export const HOT_RELOAD_PATHS: ReadonlySet<string> = new Set([
  "llm.scheduling_mode",
  "app.max_recent_chats",
  "maintenance.daily_digest_enabled",
  "browser.url_allowlist",
  "mcp.allowed_origins",
]);

export const WEAK_SESSION_SECRETS: ReadonlySet<string> = new Set([
  "mysecretsessiontomodify",
  "changeme",
  "secret",
  "session_secret",
]);

const ALIAS_MOTEUR_LLAMA: ReadonlyMap<string, string> = new Map([
  ["", "llamacpp"],
  ["llamacpp", "llamacpp"],
  ["llama.cpp", "llamacpp"],
  ["llama-cpp", "llamacpp"],
  ["llama_cpp", "llamacpp"],
  ["llama", "llamacpp"],
  ["vllm", "vllm"],
  ["sglang", "sglang"],
  ["generic", "generic"],
  ["openai", "generic"],
  ["openai_compat", "generic"],
  ["openai-compatible", "generic"],
  ["tgi", "generic"],
  ["ollama", "generic"],
  ["lmstudio", "generic"],
]);

/** Type de moteur d'un `llama.engine` (alias compris) : `llamacpp`, `vllm`, `sglang`, sinon `generic`. */
export function typeMoteurLlama(brut: string): string {
  return ALIAS_MOTEUR_LLAMA.get(stripPy(brut).toLowerCase()) ?? "generic";
}

/** URL `…/v1/chat/completions` d'un `llama.url` donné en base (`http://h:p`), en `…/v1` ou déjà complet ; vide si vide. */
export function urlChatLlama(brut: string): string {
  const u = rstripPy(stripPy(brut), "/");
  if (!u || u.endsWith("/chat/completions")) return u;
  return u.endsWith("/v1") ? `${u}/chat/completions` : `${u}/v1/chat/completions`;
}

const ALIAS_BASE: ReadonlyMap<string, string> = new Map([
  ["postgresql", "postgres"],
  ["pg", "postgres"],
]);

const PORT_BASE: ReadonlyMap<string, number> = new Map([["postgres", 5432]]);

const BUILD_ID_SUR = /^[A-Za-z0-9._-]{1,64}$/;

/** Identifiant de version injectable tel quel dans une page : 1 à 64 caractères parmi lettres et chiffres ASCII, `.`, `_`, `-`. */
export function buildIdValide(v: unknown): v is string {
  return typeof v === "string" && BUILD_ID_SUR.test(v);
}

/** `APP_BUILD_ID` s'il est valide, sinon un identifiant neuf « secondes-6 hex ». */
export function buildIdDepuis(v: unknown): string {
  return buildIdValide(v) ? v : `${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString("hex")}`;
}

/** Gardés tels quels (jamais de repli SQLite) : l'ouverture de la base les refuse avec `retiredBackendMessage`. */
export const DB_BACKENDS_RETIRED: readonly string[] = Object.freeze(["mysql", "mariadb"]);

/** `retired_backend_message` : pourquoi une instance sur un moteur retiré ne démarre pas, et comment en sortir. */
export function retiredBackendMessage(backend: string): string {
  return (
    `moteur de base ${reprPy(backend)} (config.json › database.backend ou APP_DB_BACKEND) : ` +
    "MariaDB/MySQL n'est plus pris en charge. Revenir à la version précédente " +
    "d'Elpis, y quitter ce moteur (console › Base de données › « Revenir à SQLite », " +
    "ou « ./elpis db transfer » puis « ./elpis db use » vers PostgreSQL), puis " +
    "refaire la mise à jour (docs/exploitation.md, « Mettre à jour »)."
  );
}

function borner(bas: number, haut: number, x: number): number {
  return maxPy(bas, minPy(haut, x));
}

/** Nombre de points de code, le `len()` de Python. */
function longueurPy(s: string): number {
  return [...s].length;
}

/** `_coerce_desktop_targets` : un dict seul devient une liste, une entrée sans nom ou sans URL est ignorée. */
export function coerceDesktopTargets(brut: unknown): CibleDesktop[] {
  const liste = estDict(brut) ? [brut] : brut;
  if (!Array.isArray(liste)) return [];
  const cibles: CibleDesktop[] = [];
  for (const t of liste) {
    if (!estDict(t)) continue;
    const name = stripPy(asStr(getPy(t, "name"), ""));
    const url = stripPy(asStr(getPy(t, "agent_url"), ""));
    if (!name || !url) continue;
    const access = stripPy(asStr(getPy(t, "access"), "all")).toLowerCase();
    const autorises = getPy(t, "allowed_users");
    cibles.push({
      name,
      os: stripPy(asStr(getPy(t, "os"), "linux")).toLowerCase() || "linux",
      agent_url: rstripPy(url, "/"),
      agent_token: stripPy(asStr(getPy(t, "agent_token"), "")),
      default: veritePy(getPy(t, "default")),
      access: access === "all" || access === "list" ? access : "all",
      allowed_users: Array.isArray(autorises)
        ? [...new Set(autorises.map((u) => stripPy(strPy(u))).filter((u) => u !== ""))].sort(
            comparePointsDeCode,
          )
        : [],
    });
  }
  return cibles;
}

/** `_parse_client_tokens` : `tok:user,…` (env, prioritaire) ou `{"tok": "user"}` (config) ; table sans prototype (`constructor` n'est pas un jeton). */
export function parseClientTokens(envVal: unknown, cfgVal: unknown): Record<string, string> {
  const jetons = Object.create(null) as Record<string, string>;
  if (typeof envVal === "string" && stripPy(envVal)) {
    for (const partie of envVal.split(",")) {
      const deuxPoints = partie.indexOf(":");
      if (deuxPoints < 0) continue;
      const jeton = stripPy(partie.slice(0, deuxPoints));
      const compte = stripPy(partie.slice(deuxPoints + 1).split(":", 1)[0] ?? "");
      if (jeton && compte) poserCle(jetons, jeton, compte);
    }
    return jetons;
  }
  if (estDict(cfgVal)) {
    for (const [jeton, compte] of Object.entries(cfgVal)) {
      if (typeof compte === "string" && stripPy(jeton) && stripPy(compte)) {
        poserCle(jetons, stripPy(jeton), stripPy(compte.split(":", 1)[0] ?? ""));
      }
    }
  }
  return jetons;
}

function familles(spec: string): string[] {
  return spec
    .replaceAll(",", "+")
    .split("+")
    .filter((f) => stripPy(f) !== "")
    .map((f) => stripPy(f).toLowerCase());
}

/** `_parse_client_token_families` : troisième segment `tok:user:fam1+fam2` (env) ou `"user:fam1+fam2"` (config). */
export function parseClientTokenFamilies(envVal: unknown, cfgVal: unknown): Record<string, string[]> {
  const parJeton = Object.create(null) as Record<string, string[]>;
  if (typeof envVal === "string" && stripPy(envVal)) {
    for (const partie of envVal.split(",")) {
      const bouts = partie.split(":").map(stripPy);
      const [jeton = "", , spec = ""] = bouts;
      if (bouts.length >= 3 && jeton && spec) poserCle(parJeton, jeton, familles(spec));
    }
    return parJeton;
  }
  if (estDict(cfgVal)) {
    for (const [jeton, compte] of Object.entries(cfgVal)) {
      if (typeof compte !== "string" || !compte.includes(":")) continue;
      const liste = familles(compte.slice(compte.indexOf(":") + 1));
      if (liste.length > 0) poserCle(parJeton, stripPy(jeton), liste);
    }
  }
  return parJeton;
}

/** `_builtin_local_mcp` : descripteur du service d'outils intégré, surchargé par `mcp.local_servers["local-tools"]`. */
export function builtinLocalMcpDepuis(hote: string, port: number, serveursBruts: unknown): Dict {
  const d: Dict = {
    builtin: true,
    transport: "streamable-http",
    host: hote || "127.0.0.1",
    port: port || 8765,
    mount: "",
    expose_opencode: true,
  };
  const surcharge = estDict(serveursBruts) ? getPy(serveursBruts, "local-tools") : null;
  if (estDict(surcharge)) {
    for (const [cle, valeur] of Object.entries(surcharge)) if (valeur !== null) poserCle(d, cle, valeur);
  }
  const t = stripPy(strPy(ouPy(d["transport"], "streamable-http"))).toLowerCase();
  d["transport"] = ["http", "streamable-http", "streamable_http"].includes(t)
    ? "streamable-http"
    : t === "sse"
      ? "sse"
      : "stdio";
  if (!stripPy(strPy(ouPy(d["mount"], "")))) d["mount"] = d["transport"] === "sse" ? "/sse" : "/mcp";
  return d;
}

/** `_builtin_local_mcp_url` : URL réseau en boucle locale, quel que soit le transport (l'hôte d'outils est un service) ; un port illisible lève. */
export function builtinLocalMcpUrlDepuis(d: Dict): string {
  const hote = strPy(ouPy(d["host"], "127.0.0.1"));
  return `http://${hote}:${strPy(intPy(ouPy(d["port"], 8765)))}${strPy(d["mount"])}`;
}

/** Complète une URL nue (`http://hôte:port`) en `/v1/chat/completions`. */
export function normaliserUrlCompression(url: string): string {
  if (!url) return url;
  const bas = url.toLowerCase();
  if (bas.includes("/v1/chat/completions") || bas.includes("/chat/completions")) return url;
  return `${rstripPy(url, "/")}/v1/chat/completions`;
}

/** `_read_local_mcp_token_file` : première ligne du fichier de jeton, `""` s'il manque ou se lit mal. */
export function lireJetonLocal(fichier: string): string {
  try {
    if (statSync(fichier).isFile()) return stripPy(premiereLignePy(lireTextePy(fichier)));
  } catch {
    return "";
  }
  return "";
}

/** Dossier non vide ? (un dossier vide ou absent n'a rien à préserver) */
function dossierNonVide(chemin: string): boolean {
  try {
    return readdirSync(chemin).length > 0;
  } catch {
    return false;
  }
}

/** Défaut d'un dossier de données : celui du Python, sauf instance déplacée (base, lien non suivi, hors `<racine>/user_db`) où il suit le dossier de la base ; un ancien dossier garni sans voisin est gardé. */
function defautDonnees(dbBrut: string, racine: string, nom: string, defautPython: string): string {
  const base = pyPath(dbBrut);
  const dossierBase = realpathPy(pyParent(base.startsWith("/") ? base : pyJoin(racine, base)));
  if (dossierBase === realpathPy(pyJoin(racine, "user_db"))) return defautPython;
  const voisin = pyJoin(dossierBase, nom);
  const ancien = resolvePath(defautPython, defautPython, racine);
  return !existsSync(voisin) && dossierNonVide(ancien) ? defautPython : voisin;
}

/** Comme Python : un dossier impossible à créer n'empêche pas le démarrage. */
function creerDossierTolerant(chemin: string): void {
  try {
    mkdirSync(chemin, { recursive: true });
  } catch {
    return;
  }
}

function chargerPrompt(chemin: string): string {
  try {
    return lireTextePy(chemin);
  } catch {
    return "";
  }
}

function avertirSecretFaible(secret: string, source: string): void {
  const s = stripPy(secret);
  if (!WEAK_SESSION_SECRETS.has(s.toLowerCase()) && longueurPy(s) >= 32) return;
  process.stderr.write(
    `\n[CRITICAL] Elpis SESSION_SECRET FAIBLE/PAR DÉFAUT (source=${source}, len=${longueurPy(s)}) — cookies de ` +
      "session FORGEABLES. Définissez un APP_SESSION_SECRET fort en environnement et faites-le tourner (retirez " +
      "toute valeur committée de config.json / config.json.bak).\n\n",
  );
}

/** Secret lu (blancs retirés), `null` si le fichier manque ; un fichier qui n'est pas de l'UTF-8 lève comme Python. */
function lireSecret(fichier: string): string | null {
  try {
    return stripPy(lireTextePy(fichier));
  } catch (e) {
    if (estErreurSysteme(e)) return null;
    throw e;
  }
}

/** Remet en 0600 un fichier de secret élargi (restauration, copie, chmod à la main). */
function durcirModeSecret(fichier: string): void {
  try {
    const mode = statSync(fichier).mode & 0o777;
    if ((mode & 0o077) === 0) return;
    chmodSync(fichier, 0o600);
    process.stderr.write(
      `[startup] ${fichier} était en ${mode.toString(8)} (lisible hors propriétaire) — remis en 0600.\n`,
    );
  } catch (e) {
    if (!estErreurSysteme(e)) throw e;
  }
}

/** `_publish_secret` : lien dur exclusif d'un temporaire complet en 0600 ; sur échec, un secret valide posé entre-temps l'emporte, sinon remplacement. */
function creerSecretExclusif(fichier: string): string {
  const secret = `ELPIS_${randomBytes(32).toString("hex")}`;
  const temporaire = `${fichier}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporaire, "wx", 0o600);
  try {
    try {
      ecrireTout(fd, Buffer.from(secret, "utf-8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporaire, 0o600);
    try {
      linkSync(temporaire, fichier);
      return secret;
    } catch (e) {
      if (!estErreurSysteme(e)) throw e;
    }
    const autre = lireSecret(fichier);
    if (autre !== null && longueurPy(autre) >= 40) return autre;
    renameSync(temporaire, fichier);
    return secret;
  } finally {
    rmSync(temporaire, { force: true });
  }
}

function secretEphemere(): string {
  return `EPHEMERAL_${randomBytes(16).toString("hex")}`;
}

/** Fichier `<dossier>/.session_secret` : relu s'il est valide (≥ 40 caractères), sinon créé sous `.session_secret.lock` (v1.1, comme Python) ; éphémère en dernier recours. */
function chargerOuCreerSecret(dossier: string): string {
  const fichier = pyJoin(dossier, ".session_secret");
  const existant = lireSecret(fichier);
  if (existant !== null && longueurPy(existant) >= 40) {
    durcirModeSecret(fichier);
    return existant;
  }
  try {
    mkdirSync(dossier, { recursive: true });
  } catch (e) {
    process.stderr.write(
      `[startup] Impossible de créer ${dossier} pour persister SESSION_SECRET (${String(e)}) — sessions NON ` +
        "persistées entre process et redémarrages.\n",
    );
    return secretEphemere();
  }
  try {
    return avecVerrouSync(`${fichier}.lock`, {}, () => {
      const relu = lireSecret(fichier);
      return relu !== null && longueurPy(relu) >= 40 ? relu : creerSecretExclusif(fichier);
    });
  } catch (e) {
    process.stderr.write(
      `[startup] Échec d'écriture du SESSION_SECRET dans ${fichier} : ${String(e)}. Fallback EPHEMERAL — les ` +
        "sessions ne survivront PAS au prochain redémarrage. Vérifier les permissions du dossier de la base, OU " +
        "définir APP_SESSION_SECRET dans l'environnement.\n",
    );
  }
  return secretEphemere();
}

/** Précédence : `APP_SESSION_SECRET` > `app.session_secret` (hors valeurs d'exemple publiées) > fichier près de la base. */
function resoudreSecretSession(env: Env, sessionJson: string, dbPath: string): string {
  const sessionEnv = asStr(env["APP_SESSION_SECRET"], "");
  if (sessionEnv) {
    avertirSecretFaible(sessionEnv, "env");
    return sessionEnv;
  }
  if (sessionJson && !WEAK_SESSION_SECRETS.has(stripPy(sessionJson).toLowerCase())) {
    avertirSecretFaible(sessionJson, "config.json");
    return sessionJson;
  }
  const secret = chargerOuCreerSecret(pyParent(dbPath));
  if (secret.startsWith("EPHEMERAL_")) {
    process.stderr.write(
      "\n[CRITICAL] Elpis SESSION_SECRET est ÉPHÉMÈRE — sessions cassées entre process et redémarrages. " +
        "Configurez APP_SESSION_SECRET en environnement.\n\n",
    );
  }
  return secret;
}

/** Calcule les réglages comme l'import de config.py ; `lectures` = chemins de config.json lus (BOOT_READ_PATHS). */
export function calculerReglages(env: Env, brut: Dict, racine: string, cheminConfig?: string) {
  const lectures = new Set<string>();
  const lire = (chemin: string, defaut: unknown): unknown => {
    lectures.add(chemin);
    return deepGet(brut, chemin, defaut);
  };
  const envStr = (nom: string, chemin: string, defaut: string): string =>
    asStr(env[nom], asStr(lire(chemin, defaut), defaut));
  const envInt = (nom: string, chemin: string, defaut: number): number =>
    asInt(env[nom], asInt(lire(chemin, defaut), defaut));
  const envFloat = (nom: string, chemin: string, defaut: number): number =>
    asFloat(env[nom], asFloat(lire(chemin, defaut), defaut));
  const envBool = (nom: string, chemin: string, defaut: boolean): boolean =>
    asBool(env[nom], veritePy(lire(chemin, defaut)));

  const PROJECT_ROOT = racine;
  const BACKEND_DIR = pyJoin(racine, "shared_infra");
  const CONFIG_JSON_PATH = cheminConfig ?? resolveConfigJsonPath(env, racine, false);
  const BUILD_ID = buildIdDepuis(env["APP_BUILD_ID"]);

  const LLAMA_IP = envStr("LLAMA_IP", "llama.ip", "127.0.0.1");
  const LLAMA_PORT = envStr("LLAMA_PORT", "llama.port", "8080");
  const urlLlamaJson = asStr(lire("llama.url", ""), "");
  const urlLlamaEnv = asStr(env["LLAMA_URL"], "");
  const LLAMA_URL =
    urlChatLlama(urlLlamaEnv || urlLlamaJson) || `http://${LLAMA_IP}:${LLAMA_PORT}/v1/chat/completions`;
  const LLAMA_API_KEY = stripPy(asStr(env["LLAMA_API_KEY"], "") || asStr(lire("llama.api_key", ""), ""));
  const LLAMA_MODEL = envStr("LLAMA_MODEL", "llama.model", "local-model");
  const LLAMA_PROVIDER_TYPE = typeMoteurLlama(envStr("LLAMA_ENGINE", "llama.engine", "llamacpp"));
  const LLAMA_ENGINE = LLAMA_PROVIDER_TYPE;
  const LLAMA_TIMEOUT_SEC = envInt("LLAMA_TIMEOUT_SEC", "llama.timeout_sec", 600);
  const LLAMA_RETRIES = envInt("LLAMA_RETRIES", "llama.retries", 3);
  const LLAMA_RETRY_BACKOFF_SEC = envFloat("LLAMA_RETRY_BACKOFF_SEC", "llama.retry_backoff_sec", 0.6);
  const LLAMA_RETRY_BACKOFF_CAP_S = envFloat("LLAMA_RETRY_BACKOFF_CAP_S", "llama.retry_backoff_cap_s", 15.0);
  const LLAMA_LOADING_WAIT_S = envFloat("LLAMA_LOADING_WAIT_S", "llama.loading_wait_s", 90.0);
  const LLAMA_SSE_PING_INTERVAL_S = envInt("LLAMA_SSE_PING_INTERVAL_S", "llama.sse_ping_interval_s", 15);
  const LLAMA_RETURN_PROGRESS = envBool("LLAMA_RETURN_PROGRESS", "llama.return_progress", true);
  const LLAMA_RESUMABLE_STREAM = envBool("LLAMA_RESUMABLE_STREAM", "llama.resumable_stream", true);
  const LLAMA_REASONING_CONTROL = envBool("LLAMA_REASONING_CONTROL", "llama.reasoning_control", true);
  const LLAMA_REASONING_SOFT_BUDGET_TOKENS = envInt(
    "LLAMA_REASONING_SOFT_BUDGET_TOKENS",
    "llama.reasoning_soft_budget_tokens",
    0,
  );
  const LLAMA_MAX_CONCURRENCY = envInt("LLAMA_MAX_CONCURRENCY", "llama.max_concurrency", 4);
  const LLAMA_MAX_MODELS = envInt("LLAMA_MAX_MODELS", "llama.max_models", 1);
  const LLAMA_MAX_TOOL_ITERATIONS = envInt("LLAMA_MAX_TOOL_ITERATIONS", "llama.max_tool_iterations", 200);
  const LLAMA_TOOL_TIMEOUT_S = envInt("LLAMA_TOOL_TIMEOUT_S", "llama.tool_timeout_s", 300);
  const LLAMA_TOOL_LOOP_MAX_S = maxPy(0, envInt("LLAMA_TOOL_LOOP_MAX_S", "llama.tool_loop_max_s", 0));
  const LLAMA_THINKING_BUDGET_TOKENS = envInt(
    "LLAMA_THINKING_BUDGET_TOKENS",
    "llama.thinking_budget_tokens",
    8192,
  );
  const LLAMA_MAX_TOKENS_CHAT = envInt("LLAMA_MAX_TOKENS_CHAT", "llama.max_tokens_chat", 16384);
  const LLAMA_MAX_TOKENS_THINKING = envInt("LLAMA_MAX_TOKENS_THINKING", "llama.max_tokens_thinking", 24576);
  const LLAMA_THINKING_OUTPUT_UNCAPPED = envBool(
    "LLAMA_THINKING_OUTPUT_UNCAPPED",
    "llama.thinking_output_uncapped",
    true,
  );
  const DETACH_RUN_ON_DISCONNECT =
    veritePy(lire("llm.detach_run_on_disconnect", false)) ||
    ["1", "true", "yes"].includes(stripPy(env["APP_DETACH_RUN_ON_DISCONNECT"] ?? "").toLowerCase());
  const runsParCompte = lire("llm.max_runs_per_user", 3);
  const MAX_RUNS_PER_USER = maxPy(0, intPy(ouPy(runsParCompte, 0)));
  const LLAMA_CONTENT_RESUME_MAX = maxPy(
    0,
    envInt("LLAMA_CONTENT_RESUME_MAX", "llama.content_resume_max", 4),
  );
  const LLAMA_THINK_RESUME_MAX = maxPy(0, envInt("LLAMA_THINK_RESUME_MAX", "llama.think_resume_max", 6));
  const LLAMA_THINK_RESUME_TOTAL_TOKENS = maxPy(
    0,
    envInt("LLAMA_THINK_RESUME_TOTAL_TOKENS", "llama.think_resume_total_tokens", 131072),
  );

  const VISION_ENDPOINT_URL = stripPy(envStr("APP_VISION_ENDPOINT_URL", "vision.endpoint_url", ""));
  const VISION_FORMAT =
    stripPy(envStr("APP_VISION_FORMAT", "vision.format", "omniparser")).toLowerCase() || "omniparser";
  const VISION_PROMPT = envStr("APP_VISION_PROMPT", "vision.prompt", "");
  const VISION_MODEL = stripPy(envStr("APP_VISION_MODEL", "vision.model", ""));
  const VISION_PASSES = borner(1, 3, envInt("APP_VISION_PASSES", "vision.passes", 2));
  const VISION_TIMEOUT_SEC = borner(5, 300, envInt("APP_VISION_TIMEOUT_SEC", "vision.timeout_sec", 30));
  const VISION_A11Y_SKIP_MIN = maxPy(0, envInt("APP_VISION_A11Y_SKIP_MIN", "vision.a11y_skip_min", 12));
  const carteVision = lire("vision.response_map", {});
  const VISION_RESPONSE_MAP: Dict = estDict(carteVision) ? carteVision : {};
  const DESKTOP_AGENT_TIMEOUT_SEC = borner(
    5,
    300,
    envInt("APP_DESKTOP_AGENT_TIMEOUT_SEC", "desktop.agent_timeout_sec", 30),
  );
  const DESKTOP_TRANSPORT_RETRIES = borner(
    0,
    2,
    envInt("APP_DESKTOP_TRANSPORT_RETRIES", "desktop.transport_retries", 1),
  );
  const DESKTOP_REPLAY_SELF_HEAL_MAX = maxPy(
    0,
    envInt("APP_REPLAY_SELF_HEAL_MAX", "desktop.replay_self_heal_max", 10),
  );
  const DESKTOP_STALE_FRAME_HAM = borner(
    0,
    64,
    envInt("APP_DESKTOP_STALE_FRAME_HAM", "desktop.stale_frame_ham", 10),
  );
  const DESKTOP_FRAME_STRICT_OWNER = asBool(
    env["APP_DESKTOP_FRAME_STRICT_OWNER"],
    lire("desktop.frame_strict_owner", true),
  );
  const DESKTOP_ACT_SETTLE_QUIET_MS = maxPy(
    50,
    envInt("APP_DESKTOP_ACT_SETTLE_QUIET_MS", "desktop.act_settle_quiet_ms", 350),
  );
  const DESKTOP_ACT_SETTLE_POLL_MS = maxPy(
    30,
    envInt("APP_DESKTOP_ACT_SETTLE_POLL_MS", "desktop.act_settle_poll_ms", 200),
  );
  const DESKTOP_SCREENSHOT_FORMAT =
    stripPy(envStr("APP_DESKTOP_SCREENSHOT_FORMAT", "desktop.screenshot_format", "png")).toLowerCase() ||
    "png";
  const DESKTOP_SCREENSHOT_QUALITY = borner(
    40,
    95,
    envInt("APP_DESKTOP_SCREENSHOT_QUALITY", "desktop.screenshot_quality", 85),
  );
  const CTX_IMAGE_TOKEN_COST = maxPy(
    256,
    envInt("APP_CTX_IMAGE_TOKEN_COST", "llm.ctx_image_token_cost", 1500),
  );
  const DESKTOP_MAX_ELEMENTS = borner(0, 400, envInt("APP_DESKTOP_MAX_ELEMENTS", "desktop.max_elements", 0));
  const DESKTOP_MAX_ELEMENTS_CHAT = borner(
    0,
    400,
    envInt("APP_DESKTOP_MAX_ELEMENTS_CHAT", "desktop.max_elements_chat", 0),
  );
  const DESKTOP_STUDIO_MAX_NODES = borner(
    100,
    5000,
    envInt("APP_DESKTOP_STUDIO_MAX_NODES", "desktop.studio_max_nodes", 2000),
  );
  const DESKTOP_STUDIO_ACT_SETTLE_MS = borner(
    0,
    10000,
    envInt("APP_DESKTOP_STUDIO_ACT_SETTLE_MS", "desktop.studio_act_settle_ms", 1500),
  );
  let DESKTOP_OBSERVE_SCOPE = stripPy(
    envStr("APP_DESKTOP_OBSERVE_SCOPE", "desktop.observe_scope", "focus"),
  ).toLowerCase();
  if (!["focus", "monitor", "desktop"].includes(DESKTOP_OBSERVE_SCOPE)) DESKTOP_OBSERVE_SCOPE = "focus";
  const DESKTOP_TOOL_RESULT_MAX_CHARS = maxPy(
    8000,
    envInt("APP_DESKTOP_TOOL_RESULT_MAX_CHARS", "desktop.tool_result_max_chars", 60000),
  );
  const DESKTOP_TOOL_RESULT_MAX_TOKENS = maxPy(
    0,
    envInt("APP_DESKTOP_TOOL_RESULT_MAX_TOKENS", "desktop.tool_result_max_tokens", 0),
  );
  const DESKTOP_EXPOSE_RAW_TOOLS =
    envVrai(env["APP_DESKTOP_EXPOSE_RAW_TOOLS"]) || veritePy(lire("desktop.expose_raw_tools", false));
  const DESKTOP_DISABLE_SHELL =
    envVrai(env["APP_DESKTOP_DISABLE_SHELL"]) || veritePy(lire("desktop.disable_shell", false));
  const DESKTOP_TARGETS = coerceDesktopTargets(lire("desktop.targets", []));

  const TOOLS_CACHE_TTL_SEC = envFloat("MCP_TOOLS_CACHE_TTL_SEC", "mcp.tools_cache_ttl_sec", 360.0);
  const LOCAL_MCP_HOST = envStr("LOCAL_MCP_HOST", "mcp.local_host", "127.0.0.1");
  const LOCAL_MCP_PORT = envInt("LOCAL_MCP_PORT", "mcp.local_port", 8765);
  const LOCAL_MCP_SERVERS_RAW = lire("mcp.local_servers", null);
  let baseDuJeton = pyPath(envStr("APP_DB_PATH", "app.db_path", "user_db/app.db"));
  if (!baseDuJeton.startsWith("/")) baseDuJeton = pyJoin(racine, baseDuJeton);
  const LOCAL_MCP_TOKEN_FILE = realpathPy(pyJoin(pyParent(baseDuJeton), ".local_mcp_token"));
  const LOCAL_MCP_TOKEN =
    stripPy(envStr("LOCAL_MCP_TOKEN", "mcp.local_token", "")) || lireJetonLocal(LOCAL_MCP_TOKEN_FILE);
  const descripteurIntegre = builtinLocalMcpDepuis(LOCAL_MCP_HOST, LOCAL_MCP_PORT, LOCAL_MCP_SERVERS_RAW);
  const LOCAL_MCP_TRANSPORT =
    stripPy(asStr(env["LOCAL_MCP_TRANSPORT"], "")) ||
    strPy(descripteurIntegre["transport"]) ||
    asStr(lire("mcp.local_transport", "sse"), "sse");
  const LOCAL_MCP_URL_EXPLICIT = stripPy(envStr("LOCAL_MCP_URL", "mcp.local_url", ""));
  const LOCAL_MCP_URL = LOCAL_MCP_URL_EXPLICIT || builtinLocalMcpUrlDepuis(descripteurIntegre);
  const LOCAL_MCP_TOOL_FAMILIES =
    stripPy(envStr("LOCAL_MCP_TOOL_FAMILIES", "mcp.local_tool_families", "all")) || "all";
  const LOCAL_MCP_OPENCODE_FAMILIES = stripPy(
    envStr("LOCAL_MCP_OPENCODE_FAMILIES", "mcp.opencode_families", "git,browser,desktop"),
  );
  const LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES = stripPy(
    envStr(
      "LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES",
      "mcp.opencode_exclude_families",
      "fs,shell,office,skill_run",
    ),
  );
  const LOCAL_MCP_PUBLIC_URL = stripPy(envStr("LOCAL_MCP_PUBLIC_URL", "mcp.public_url", ""));
  const LOCAL_MCP_CLIENT_TOKENS = parseClientTokens(
    env["LOCAL_MCP_CLIENT_TOKENS"],
    lire("mcp.local_client_tokens", null),
  );
  const LOCAL_MCP_CLIENT_TOKEN_FAMILIES = parseClientTokenFamilies(
    env["LOCAL_MCP_CLIENT_TOKENS"],
    lire("mcp.local_client_tokens", null),
  );
  const DB_BRUT = envStr("APP_DB_PATH", "app.db_path", "user_db/app.db");
  const DB_PATH = resolveRel(DB_BRUT, racine);
  const MCP_SERVERS_DIR = resolvePath(
    envStr(
      "MCP_SERVERS_DIR",
      "mcp.servers_dir",
      defautDonnees(DB_BRUT, racine, "mcp_custom_servers", "../mcp_custom_servers"),
    ),
    "../mcp_custom_servers",
    racine,
  );
  creerDossierTolerant(MCP_SERVERS_DIR);

  let DB_BACKEND = stripPy(envStr("APP_DB_BACKEND", "database.backend", "sqlite")).toLowerCase() || "sqlite";
  DB_BACKEND = ALIAS_BASE.get(DB_BACKEND) ?? DB_BACKEND;
  if (!["sqlite", "postgres"].includes(DB_BACKEND) && !DB_BACKENDS_RETIRED.includes(DB_BACKEND)) {
    process.stderr.write(`[config] database.backend=${reprPy(DB_BACKEND)} inconnu — SQLite utilisé.\n`);
    DB_BACKEND = "sqlite";
  }
  const DB_HOST = envStr("APP_DB_HOST", "database.host", "127.0.0.1");
  const DB_PORT = envInt("APP_DB_PORT", "database.port", 0) || (PORT_BASE.get(DB_BACKEND) ?? 0);
  const DB_NAME = envStr("APP_DB_NAME", "database.name", "elpis");
  const DB_USER = envStr("APP_DB_USER", "database.user", "elpis");
  const DB_TLS = envStr("APP_DB_TLS", "database.tls", "off").toLowerCase();
  const DB_POOL_MAX = maxPy(1, envInt("APP_DB_POOL_MAX", "database.pool_max", 8));
  const DB_TIMEOUT = maxPy(5.0, envFloat("APP_DB_TIMEOUT", "database.timeout", 60.0));
  const DB_GENERATION = asInt(lire("database.generation", 0), 0);
  if (DB_BACKENDS_RETIRED.includes(DB_BACKEND))
    process.stderr.write(`[config] ${retiredBackendMessage(DB_BACKEND)}\n`);

  const MAX_RECENT_CHATS = envInt("APP_MAX_RECENT_CHATS", "app.max_recent_chats", 100);
  const METRICS_RETENTION_DAYS = maxPy(
    0,
    envInt("APP_METRICS_RETENTION_DAYS", "maintenance.metrics_retention_days", 90),
  );
  const USAGE_EVENTS_RETENTION_DAYS = maxPy(
    0,
    envInt("APP_USAGE_EVENTS_RETENTION_DAYS", "maintenance.usage_events_retention_days", 180),
  );
  const SESSION_MESSAGES_RETENTION_DAYS = maxPy(
    0,
    envInt("APP_SESSION_MESSAGES_RETENTION_DAYS", "maintenance.session_messages_retention_days", 180),
  );
  const METRICS_TIMEZONE = envStr("APP_METRICS_TIMEZONE", "metrics.timezone", "");
  const METRICS_BUSINESS_START = borner(
    0,
    23,
    envInt("APP_METRICS_BUSINESS_START", "metrics.business_hours.start", 8),
  );
  const METRICS_BUSINESS_END = borner(
    1,
    24,
    envInt("APP_METRICS_BUSINESS_END", "metrics.business_hours.end", 19),
  );
  const METRICS_BUSINESS_DAYS = envStr(
    "APP_METRICS_BUSINESS_DAYS",
    "metrics.business_hours.days",
    "1,2,3,4,5",
  );
  const TOOL_METRICS_RETENTION_DAYS = maxPy(
    0,
    envInt("APP_TOOL_METRICS_RETENTION_DAYS", "maintenance.tool_metrics_retention_days", 90),
  );
  const ROUTINE_RUNS_RETENTION_DAYS = maxPy(
    0,
    envInt("APP_ROUTINE_RUNS_RETENTION_DAYS", "maintenance.routine_runs_retention_days", 180),
  );
  const DAILY_REPORT_RETENTION_DAYS = maxPy(
    0,
    envInt("APP_DAILY_REPORT_RETENTION_DAYS", "maintenance.daily_report_retention_days", 400),
  );
  const MAINTENANCE_HOUR = borner(0, 23, envInt("APP_MAINTENANCE_HOUR", "maintenance.hour", 6));

  const SYSTEM_PROMPT_DEFAULT_PATH = resolveRel(
    envStr("APP_SYSTEM_PROMPT_DEFAULT", "app.system_prompts.default", "system_prompts/CHATBOT_SYSTEM.md"),
    racine,
  );
  const SYSTEM_PROMPT_AX_MEMORY_HEADER_PATH = resolveRel(
    envStr(
      "APP_SYSTEM_PROMPT_AX_MEMORY_HEADER",
      "app.system_prompts.ax_memory_header",
      "system_prompts/AX_MEMORY_HEADER.md",
    ),
    racine,
  );
  const SYSTEM_PROMPT_COMPRESSOR_PATH = resolveRel(
    envStr(
      "APP_SYSTEM_PROMPT_COMPRESSOR",
      "app.system_prompts.compressor",
      "system_prompts/COMPRESSOR_SYSTEM.md",
    ),
    racine,
  );

  const MAX_UPLOAD_MB = envInt("APP_MAX_UPLOAD_MB", "app.max_upload_mb", 50);
  const MAX_UPLOAD_BYTES = maxPy(1, MAX_UPLOAD_MB) * 1024 * 1024;
  const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
  const SANDBOX_IMPORT_MAX_PCT_DEFAULT = 60;

  let LLM_SCHEDULING_MODE = envStr("APP_LLM_SCHEDULING", "llm.scheduling_mode", "auto").toLowerCase();
  if (!["auto", "classic", "optimized"].includes(LLM_SCHEDULING_MODE)) LLM_SCHEDULING_MODE = "auto";

  const COMPRESSION_ENABLED = veritePy(lire("llm.compression.enabled", true));
  let COMPRESSION_KEEP_RECENT = asInt(lire("llm.compression.keep_recent_turns", 6), 6);
  let COMPRESSION_KEEP_BRIDGE = asInt(lire("llm.compression.keep_bridge_turns", 3), 3);
  const COMPRESSION_EXTERNAL_MODEL = stripPy(
    envStr("APP_COMPRESSION_MODEL", "llm.compression.external_model", ""),
  );
  const COMPRESSION_ENDPOINT_URL = normaliserUrlCompression(
    stripPy(envStr("APP_COMPRESSION_ENDPOINT_URL", "llm.compression.endpoint_url", "")),
  );
  const COMPRESSION_ENDPOINT_MODEL = stripPy(
    envStr("APP_COMPRESSION_ENDPOINT_MODEL", "llm.compression.endpoint_model", ""),
  );
  let COMPRESSION_ENDPOINT_TIMEOUT_SEC = envInt(
    "APP_COMPRESSION_ENDPOINT_TIMEOUT_SEC",
    "llm.compression.endpoint_timeout_sec",
    120,
  );
  let COMPRESSION_MAX_PER_CHAT = envInt("APP_COMPRESSION_MAX_PER_CHAT", "llm.compression.max_per_chat", 12);
  COMPRESSION_KEEP_RECENT = borner(2, 50, COMPRESSION_KEEP_RECENT);
  COMPRESSION_KEEP_BRIDGE = borner(0, 20, COMPRESSION_KEEP_BRIDGE);
  COMPRESSION_ENDPOINT_TIMEOUT_SEC = borner(10, 600, COMPRESSION_ENDPOINT_TIMEOUT_SEC);

  const COMPACTION_BUFFER_TOKENS = maxPy(
    0,
    envInt("APP_COMPACTION_BUFFER_TOKENS", "llm.compaction.buffer_tokens", 0),
  );
  const COMPACTION_PARTIAL_TARGET_RATIO = borner(
    0.2,
    0.9,
    envFloat("APP_COMPACTION_PARTIAL_TARGET_RATIO", "llm.compaction.partial_target_ratio", 0.6),
  );
  const seuilPct = envInt("APP_COMPACTION_THRESHOLD_PCT", "llm.compaction.threshold_pct", 0);
  const COMPACTION_THRESHOLD_PCT = seuilPct <= 0 ? 0 : borner(30, 100, seuilPct);
  const seuilJetons = envInt("APP_COMPACTION_THRESHOLD_TOKENS", "llm.compaction.threshold_tokens", 0);
  const COMPACTION_THRESHOLD_TOKENS = seuilJetons <= 0 ? 0 : borner(2_048, 4_000_000, seuilJetons);

  const PRUNE_ENABLED = veritePy(lire("llm.prune.enabled", true));
  const PRUNE_PROTECT_TOKENS = maxPy(0, envInt("APP_PRUNE_PROTECT_TOKENS", "llm.prune.protect_tokens", 0));
  const PRUNE_MIN_TOKENS = maxPy(0, envInt("APP_PRUNE_MIN_TOKENS", "llm.prune.min_tokens", 0));
  COMPRESSION_MAX_PER_CHAT = borner(0, 64, COMPRESSION_MAX_PER_CHAT);
  const PRUNE_EVERY_ITERS = borner(0, 1000, envInt("APP_PRUNE_EVERY_ITERS", "llm.prune.every_iters", 10));
  const COMPACTIONS_PER_RUN_MAX = borner(
    1,
    64,
    envInt("APP_COMPACTIONS_PER_RUN_MAX", "llm.compaction.per_run_max", 8),
  );
  const THINKING_HISTORY_MAX_CHARS = maxPy(
    0,
    envInt("APP_THINKING_HISTORY_MAX_CHARS", "llm.thinking.history_max_chars", 400_000),
  );

  let TASK_CHILD_TIMEOUT_S = envInt("APP_TASK_CHILD_TIMEOUT_S", "llm.task.child_timeout_s", 3600);
  let TASK_SUBAGENT_DEPTH = envInt("APP_TASK_SUBAGENT_DEPTH", "llm.task.subagent_depth", 1);
  let TASK_RESUME_TTL_S = envInt("APP_TASK_RESUME_TTL_S", "llm.task.resume_ttl_s", 21600);
  let TASK_RESUME_MAX = envInt("APP_TASK_RESUME_MAX", "llm.task.resume_max", 200);
  let TASK_MAX_ITERS_EXPLORE = envInt("APP_TASK_MAX_ITERS_EXPLORE", "llm.task.max_iters.explore", 60);
  let TASK_MAX_ITERS_GENERAL = envInt("APP_TASK_MAX_ITERS_GENERAL", "llm.task.max_iters.general", 80);
  let TASK_MAX_ITERS_CUSTOM = envInt(
    "APP_TASK_MAX_ITERS_CUSTOM",
    "llm.task.max_iters.custom",
    TASK_MAX_ITERS_GENERAL,
  );
  let TASK_MAX_ITERS_IMPLEMENT = envInt("APP_TASK_MAX_ITERS_IMPLEMENT", "llm.task.max_iters.implement", 100);
  let TASK_MAX_ITERS_VERIFY = envInt("APP_TASK_MAX_ITERS_VERIFY", "llm.task.max_iters.verify", 60);
  let TASK_MAX_ITERS_WEB = envInt("APP_TASK_MAX_ITERS_WEB", "llm.task.max_iters.web", 60);
  let TASK_MAX_ITERS_PR = envInt("APP_TASK_MAX_ITERS_PR", "llm.task.max_iters.pr", 40);
  TASK_CHILD_TIMEOUT_S = borner(60, 21600, TASK_CHILD_TIMEOUT_S);
  TASK_SUBAGENT_DEPTH = borner(1, 3, TASK_SUBAGENT_DEPTH);
  TASK_RESUME_TTL_S = borner(60, 86400, TASK_RESUME_TTL_S);
  TASK_RESUME_MAX = borner(1, 500, TASK_RESUME_MAX);
  TASK_MAX_ITERS_EXPLORE = borner(1, 500, TASK_MAX_ITERS_EXPLORE);
  TASK_MAX_ITERS_GENERAL = borner(1, 500, TASK_MAX_ITERS_GENERAL);
  TASK_MAX_ITERS_CUSTOM = borner(1, 500, TASK_MAX_ITERS_CUSTOM);
  TASK_MAX_ITERS_IMPLEMENT = borner(1, 500, TASK_MAX_ITERS_IMPLEMENT);
  TASK_MAX_ITERS_VERIFY = borner(1, 500, TASK_MAX_ITERS_VERIFY);
  TASK_MAX_ITERS_WEB = borner(1, 500, TASK_MAX_ITERS_WEB);
  TASK_MAX_ITERS_PR = borner(1, 500, TASK_MAX_ITERS_PR);
  const AGENTS_ENABLED = veritePy(lire("llm.task.enabled", true));
  const GIT_TOOL_TIMEOUT_S = borner(5, 600, envInt("APP_GIT_TOOL_TIMEOUT_S", "tools.git.timeout_s", 60));

  const SANDBOX_DIR = resolvePath(
    envStr("APP_SANDBOX_DIR", "app.sandbox_dir", "user_sandboxes"),
    "user_sandboxes",
    racine,
  );
  const dossierMemoire = stripPy(envStr("APP_MEMORY_DIR", "app.memory_dir", ""));
  const MEMORY_DIR = dossierMemoire ? resolvePath(dossierMemoire, "", racine) : SANDBOX_DIR;
  const SKILLS_DIR = resolvePath(envStr("APP_SKILLS_DIR", "skills.dir", "skills"), "skills", racine);
  const USER_SKILLS_DIR = resolvePath(
    envStr(
      "APP_USER_SKILLS_DIR",
      "skills.user_dir",
      defautDonnees(DB_BRUT, racine, "user_skills", "user_skills"),
    ),
    "user_skills",
    racine,
  );
  const SKINS_DIR = resolvePath(
    envStr("APP_SKINS_DIR", "skins.dir", defautDonnees(DB_BRUT, racine, "user_skins", "user_skins")),
    "user_skins",
    racine,
  );
  const SKILLS_MIN_SCORE = maxPy(0.0, envFloat("APP_SKILLS_MIN_SCORE", "skills.min_score", 1.0));
  const SKILLS_CHAR_BUDGET = maxPy(0, envInt("APP_SKILLS_CHAR_BUDGET", "skills.char_budget", 12000));
  const SKILLS_INDEX_MAX = maxPy(0, envInt("APP_SKILLS_INDEX_MAX", "skills.index_max", 100));

  let LLM_DEBUG_ENABLED = veritePy(lire("llm.debug.enabled", true));
  if (env["APP_LLM_DEBUG_ENABLED"] !== undefined) LLM_DEBUG_ENABLED = envVrai(env["APP_LLM_DEBUG_ENABLED"]);
  const LLM_DEBUG_MAX_ENTRIES = maxPy(10, envInt("APP_LLM_DEBUG_MAX_ENTRIES", "llm.debug.max_entries", 500));
  const LLM_DEBUG_MAX_BODY_CHARS = maxPy(
    1000,
    envInt("APP_LLM_DEBUG_MAX_BODY_CHARS", "llm.debug.max_body_chars", 100000),
  );

  const MEMORY_ENABLED = veritePy(lire("memory.enabled", true));
  const MEMORY_MD_CHAR_LIMIT = borner(
    200,
    20000,
    envInt("APP_MEMORY_MD_CHAR_LIMIT", "memory.memory_char_limit", 2200),
  );
  const USER_MD_CHAR_LIMIT = borner(
    200,
    20000,
    envInt("APP_USER_MD_CHAR_LIMIT", "memory.user_char_limit", 1375),
  );

  const SESSION_SECRET = resoudreSecretSession(env, asStr(lire("app.session_secret", ""), ""), DB_PATH);

  const SYSTEM_PROMPT_DEFAULT = chargerPrompt(SYSTEM_PROMPT_DEFAULT_PATH);
  const SYSTEM_PROMPT_AX_MEMORY_HEADER = chargerPrompt(SYSTEM_PROMPT_AX_MEMORY_HEADER_PATH);
  const SYSTEM_PROMPT_COMPRESSOR = chargerPrompt(SYSTEM_PROMPT_COMPRESSOR_PATH);
  const BOOT_READ_PATHS: ReadonlySet<string> = lectures;

  const reglages = {
    PROJECT_ROOT,
    BACKEND_DIR,
    CONFIG_JSON_PATH,
    BUILD_ID,
    LLAMA_IP,
    LLAMA_PORT,
    LLAMA_URL,
    LLAMA_API_KEY,
    LLAMA_MODEL,
    LLAMA_PROVIDER_TYPE,
    LLAMA_ENGINE,
    LLAMA_TIMEOUT_SEC,
    LLAMA_RETRIES,
    LLAMA_RETRY_BACKOFF_SEC,
    LLAMA_RETRY_BACKOFF_CAP_S,
    LLAMA_LOADING_WAIT_S,
    LLAMA_SSE_PING_INTERVAL_S,
    LLAMA_RETURN_PROGRESS,
    LLAMA_RESUMABLE_STREAM,
    LLAMA_REASONING_CONTROL,
    LLAMA_REASONING_SOFT_BUDGET_TOKENS,
    LLAMA_MAX_CONCURRENCY,
    LLAMA_MAX_MODELS,
    LLAMA_MAX_TOOL_ITERATIONS,
    LLAMA_TOOL_TIMEOUT_S,
    LLAMA_TOOL_LOOP_MAX_S,
    LLAMA_THINKING_BUDGET_TOKENS,
    LLAMA_MAX_TOKENS_CHAT,
    LLAMA_MAX_TOKENS_THINKING,
    LLAMA_THINKING_OUTPUT_UNCAPPED,
    DETACH_RUN_ON_DISCONNECT,
    MAX_RUNS_PER_USER,
    LLAMA_CONTENT_RESUME_MAX,
    LLAMA_THINK_RESUME_MAX,
    LLAMA_THINK_RESUME_TOTAL_TOKENS,
    VISION_ENDPOINT_URL,
    VISION_FORMAT,
    VISION_PROMPT,
    VISION_MODEL,
    VISION_PASSES,
    VISION_TIMEOUT_SEC,
    VISION_A11Y_SKIP_MIN,
    VISION_RESPONSE_MAP,
    DESKTOP_AGENT_TIMEOUT_SEC,
    DESKTOP_TRANSPORT_RETRIES,
    DESKTOP_REPLAY_SELF_HEAL_MAX,
    DESKTOP_STALE_FRAME_HAM,
    DESKTOP_FRAME_STRICT_OWNER,
    DESKTOP_ACT_SETTLE_QUIET_MS,
    DESKTOP_ACT_SETTLE_POLL_MS,
    DESKTOP_SCREENSHOT_FORMAT,
    DESKTOP_SCREENSHOT_QUALITY,
    CTX_IMAGE_TOKEN_COST,
    DESKTOP_MAX_ELEMENTS,
    DESKTOP_MAX_ELEMENTS_CHAT,
    DESKTOP_STUDIO_MAX_NODES,
    DESKTOP_STUDIO_ACT_SETTLE_MS,
    DESKTOP_OBSERVE_SCOPE,
    DESKTOP_TOOL_RESULT_MAX_CHARS,
    DESKTOP_TOOL_RESULT_MAX_TOKENS,
    DESKTOP_EXPOSE_RAW_TOOLS,
    DESKTOP_DISABLE_SHELL,
    DESKTOP_TARGETS,
    TOOLS_CACHE_TTL_SEC,
    LOCAL_MCP_HOST,
    LOCAL_MCP_PORT,
    LOCAL_MCP_SERVERS_RAW,
    LOCAL_MCP_TOKEN_FILE,
    LOCAL_MCP_TOKEN,
    LOCAL_MCP_TRANSPORT,
    LOCAL_MCP_URL_EXPLICIT,
    LOCAL_MCP_URL,
    LOCAL_MCP_TOOL_FAMILIES,
    LOCAL_MCP_OPENCODE_FAMILIES,
    LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES,
    LOCAL_MCP_PUBLIC_URL,
    LOCAL_MCP_CLIENT_TOKENS,
    LOCAL_MCP_CLIENT_TOKEN_FAMILIES,
    MCP_SERVERS_DIR,
    DB_PATH,
    DB_BACKEND,
    DB_BACKENDS_RETIRED,
    DB_HOST,
    DB_PORT,
    DB_NAME,
    DB_USER,
    DB_TLS,
    DB_POOL_MAX,
    DB_TIMEOUT,
    DB_GENERATION,
    MAX_RECENT_CHATS,
    METRICS_RETENTION_DAYS,
    USAGE_EVENTS_RETENTION_DAYS,
    SESSION_MESSAGES_RETENTION_DAYS,
    METRICS_TIMEZONE,
    METRICS_BUSINESS_START,
    METRICS_BUSINESS_END,
    METRICS_BUSINESS_DAYS,
    TOOL_METRICS_RETENTION_DAYS,
    ROUTINE_RUNS_RETENTION_DAYS,
    DAILY_REPORT_RETENTION_DAYS,
    MAINTENANCE_HOUR,
    SYSTEM_PROMPT_DEFAULT_PATH,
    SYSTEM_PROMPT_AX_MEMORY_HEADER_PATH,
    SYSTEM_PROMPT_COMPRESSOR_PATH,
    MAX_UPLOAD_MB,
    MAX_UPLOAD_BYTES,
    MAX_AVATAR_BYTES,
    SANDBOX_IMPORT_MAX_PCT_DEFAULT,
    LLM_SCHEDULING_MODE,
    COMPRESSION_ENABLED,
    COMPRESSION_KEEP_RECENT,
    COMPRESSION_KEEP_BRIDGE,
    COMPRESSION_EXTERNAL_MODEL,
    COMPRESSION_ENDPOINT_URL,
    COMPRESSION_ENDPOINT_MODEL,
    COMPRESSION_ENDPOINT_TIMEOUT_SEC,
    COMPRESSION_MAX_PER_CHAT,
    COMPACTION_BUFFER_TOKENS,
    COMPACTION_PARTIAL_TARGET_RATIO,
    COMPACTION_THRESHOLD_PCT,
    COMPACTION_THRESHOLD_TOKENS,
    PRUNE_ENABLED,
    PRUNE_PROTECT_TOKENS,
    PRUNE_MIN_TOKENS,
    PRUNE_EVERY_ITERS,
    COMPACTIONS_PER_RUN_MAX,
    THINKING_HISTORY_MAX_CHARS,
    TASK_CHILD_TIMEOUT_S,
    TASK_SUBAGENT_DEPTH,
    TASK_RESUME_TTL_S,
    TASK_RESUME_MAX,
    TASK_MAX_ITERS_EXPLORE,
    TASK_MAX_ITERS_GENERAL,
    TASK_MAX_ITERS_CUSTOM,
    TASK_MAX_ITERS_IMPLEMENT,
    TASK_MAX_ITERS_VERIFY,
    TASK_MAX_ITERS_WEB,
    TASK_MAX_ITERS_PR,
    AGENTS_ENABLED,
    GIT_TOOL_TIMEOUT_S,
    SANDBOX_DIR,
    MEMORY_DIR,
    SKILLS_DIR,
    USER_SKILLS_DIR,
    SKINS_DIR,
    SKILLS_MIN_SCORE,
    SKILLS_CHAR_BUDGET,
    SKILLS_INDEX_MAX,
    LLM_DEBUG_ENABLED,
    LLM_DEBUG_MAX_ENTRIES,
    LLM_DEBUG_MAX_BODY_CHARS,
    MEMORY_ENABLED,
    MEMORY_MD_CHAR_LIMIT,
    USER_MD_CHAR_LIMIT,
    SESSION_SECRET,
    SYSTEM_PROMPT_DEFAULT,
    SYSTEM_PROMPT_AX_MEMORY_HEADER,
    SYSTEM_PROMPT_COMPRESSOR,
    HOT_RELOAD_PREFIXES,
    HOT_RELOAD_PATHS,
    BOOT_READ_PATHS,
  };
  return { reglages, lectures: BOOT_READ_PATHS };
}

export type Reglages = ReturnType<typeof calculerReglages>["reglages"];

/** `os.environ.setdefault` de config.py : les sous-process (service MCP…) héritent des chemins absolus résolus. */
export function propagerEnv(env: Record<string, string | undefined>, reglages: Reglages): void {
  const chemins: readonly [string, string][] = [
    ["APP_SANDBOX_DIR", reglages.SANDBOX_DIR],
    ["APP_SKILLS_DIR", reglages.SKILLS_DIR],
    ["APP_USER_SKILLS_DIR", reglages.USER_SKILLS_DIR],
  ];
  for (const [nom, valeur] of chemins) if (env[nom] === undefined) env[nom] = valeur;
}
