// SPDX-License-Identifier: MIT
/** apps/toolhost/src/config.ts — configuration de l'hôte d'outils (`toolhost.json`, env, config de l'app) : port de toolhost/config.py, schéma validé par Ajv, amont MCP (elpis-tools). */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  decoderJsonPy,
  ErreurPython,
  estDict,
  estErreurPython,
  estFichierPy,
  floatPy,
  intPy,
  lireTextePy,
  reprPy,
  rstripPy,
  splitlinesPy,
  stripPy,
  strPy,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, pyJoin, pyPath, realpathPy } from "@elpis/config";
import {
  compilerSchema,
  erreursSchema,
  FAMILY_NAMES,
  load as chargerManifeste,
  parseFamilies,
  SANDBOX_FAMILIES,
} from "@elpis/mcp";

export const NOM_FICHIER = "toolhost.json";
export const CHEMIN_SCHEMA = path.join("docs", "schemas", "toolhost.schema.json");
const TRANSPORTS_RESEAU = ["http", "sse"] as const;

export interface ToolhostConfig {
  host: string;
  port: number;
  transport: string;
  transports: string[];
  token: string;
  token_file: string;
  families: string[];
  /** Familles servies par l'hôte lui-même (sous-ensemble de `families`) ; les autres sont relayées vers elpis-tools. */
  familles_natives: string[];
  /** `familles_natives` absente de toolhost.json : toutes les portées, recalculées si `families` change (`--families`). */
  natives_par_defaut?: boolean;
  sandbox_dir: string;
  db_path: string;
  app_url: string;
  playwright_api_url: string;
  pw_dir: string;
  desktop_dir: string;
  identity_max_skew_s: number;
  /** Amont MCP HTTP streamable (elpis-tools) relayé sous `/mcp` ; vide : façade fermée. */
  mcp_upstream: string;
  /** Amont MCP SSE relayé sous `/sse` et `/messages/` ; vide : SSE non servi. */
  mcp_upstream_sse: string;
  source: "file" | "defaults";
  path: string | null;
  warnings: string[];
  raw: Dict;
}

/** `ToolhostConfig()` du Python : défauts du dataclass. */
export function configParDefaut(): ToolhostConfig {
  return {
    host: "127.0.0.1",
    port: 8765,
    transport: "streamable-http",
    transports: ["http", "sse"],
    token: "",
    token_file: "",
    families: [...FAMILY_NAMES],
    familles_natives: [],
    sandbox_dir: "",
    db_path: "",
    app_url: "",
    playwright_api_url: "",
    pw_dir: "",
    desktop_dir: "",
    identity_max_skew_s: 60,
    mcp_upstream: "",
    mcp_upstream_sse: "",
    source: "defaults",
    path: null,
    warnings: [],
    raw: {},
  };
}

export function estReseau(tc: ToolhostConfig): boolean {
  return ["streamable-http", "http", "sse"].includes(tc.transport);
}

/** `public_dict` : jamais le jeton, seulement sa présence. */
export function publicDict(tc: ToolhostConfig): Dict {
  return {
    host: tc.host,
    port: tc.port,
    transport: tc.transport,
    transports: [...tc.transports],
    has_token: Boolean(tc.token),
    families: [...tc.families],
    ...(tc.familles_natives.length > 0 ? { familles_natives: [...tc.familles_natives] } : {}),
    sandbox_dir: tc.sandbox_dir,
    db_path: tc.db_path,
    app_url: tc.app_url,
    playwright_api_url: tc.playwright_api_url,
    source: tc.source,
    path: tc.path ?? "",
    warnings: [...tc.warnings],
  };
}

function racine(): string {
  return config.PROJECT_ROOT;
}

/** `Path.expanduser()` pour `~` et `~/…` (le Python lève sur un `~utilisateur` inconnu ; ici gardé tel quel). */
function expanduser(p: string): string {
  if (p !== "~" && !p.startsWith("~/")) return p;
  return (process.env["HOME"] || homedir()) + p.slice(1);
}

/** `config_path()` : `TOOLHOST_CONFIG` (relatif à la racine du dépôt), sinon `<racine>/toolhost.json`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const brut = stripPy(env["TOOLHOST_CONFIG"] ?? "");
  if (brut) {
    const p = pyPath(expanduser(brut));
    return p.startsWith("/") ? p : pyJoin(racine(), p);
  }
  return pyJoin(racine(), NOM_FICHIER);
}

/** `_rel` : vide → vide ; absolu gardé (normalisé) ; relatif résolu sous la racine (liens suivis). */
function relatif(valeur: unknown, defaut: string): string {
  const s = stripPy(strPy(veritePy(valeur) ? valeur : defaut || ""));
  if (!s) return "";
  const q = pyPath(expanduser(s));
  return q.startsWith("/") ? q : realpathPy(pyJoin(racine(), q));
}

/** `_read_token_file` : première ligne nettoyée, `""` si illisible. */
export function lireFichierJeton(p: string): string {
  try {
    const lignes = splitlinesPy(lireTextePy(p));
    return stripPy(lignes[0] ?? "");
  } catch {
    return "";
  }
}

/** `(x or y or …).strip()` : premier opérande vrai, qui doit être un texte (le Python lève sinon). */
function premierTexte(cle: string, ...valeurs: unknown[]): string {
  const v = valeurs.find((x) => veritePy(x)) ?? valeurs[valeurs.length - 1];
  if (typeof v !== "string")
    throw new ErreurPython("AttributeError", `${cle} : texte attendu, reçu ${JSON.stringify(v)}`);
  return stripPy(v);
}

function lire(d: Dict, cle: string): unknown {
  return Object.hasOwn(d, cle) ? d[cle] : undefined;
}

/** `int(x)` ; ValueError → 8765 comme le Python, TypeError lève. */
function port(env: NodeJS.ProcessEnv, bind: Dict): number {
  const v = [env["LOCAL_MCP_PORT"], lire(bind, "port"), config.LOCAL_MCP_PORT].find((x) => veritePy(x));
  try {
    return intPy(v ?? 8765);
  } catch (e) {
    if (estErreurPython(e, "ValueError")) return 8765;
    throw e;
  }
}

/** Transports réseau : env, puis `bind.transports`, puis `serve.transports` du manifeste, sinon http + sse. */
function transportsReseau(env: NodeJS.ProcessEnv, bind: Dict): unknown[] | null {
  const brut = env["TOOLHOST_TRANSPORTS"];
  if (brut !== undefined) return brut.replaceAll(";", ",").split(",");
  const liste = lire(bind, "transports");
  if (Array.isArray(liste)) return liste;
  try {
    const serve = lire(chargerManifeste().host(), "serve");
    const t = estDict(serve) ? lire(serve, "transports") : undefined;
    return Array.isArray(t) ? t : null;
  } catch {
    return null;
  }
}

function normaliserTransports(liste: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const brut of liste) {
    let t = stripPy(strPy(brut)).toLowerCase();
    if (t === "streamable-http" || t === "streamable_http") t = "http";
    if ((TRANSPORTS_RESEAU as readonly string[]).includes(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Familles servies : env, sinon toolhost.json, sinon les entrées `role: toolhost` du manifeste (celles du compte vivent dans le core), sans elles celles du bac ; manifeste illisible : toutes, comme le Python. */
function familles(env: NodeJS.ProcessEnv, raw: Dict, warnings: string[]): string[] {
  const avertir = (m: string): void => {
    warnings.push(m);
  };
  const envFam = env["LOCAL_MCP_TOOL_FAMILIES"];
  if (envFam !== undefined) return parseFamilies(envFam, avertir);
  const fr = lire(raw, "families");
  if (fr !== undefined && fr !== null) {
    if (!Array.isArray(fr)) return parseFamilies(strPy(fr), avertir);
    const voulues = new Set(fr.map((x) => stripPy(strPy(x)).toLowerCase()));
    for (const u of [...voulues].filter((x) => !FAMILY_NAMES.includes(x)).sort())
      warnings.push(`famille inconnue ignorée : ${reprPy(u)}`);
    return FAMILY_NAMES.filter((f) => voulues.has(f));
  }
  try {
    const servies = chargerManifeste().toolhostFamilies();
    if (servies.length > 0) return servies;
  } catch {
    return [...FAMILY_NAMES];
  }
  return FAMILY_NAMES.filter((f) => (SANDBOX_FAMILIES as readonly string[]).includes(f));
}

/** Familles portées en TS que l'hôte sait servir (registre `mcp/registre.ts`, énumération du schéma). */
export const FAMILLES_NATIVES_PORTEES: readonly string[] = [
  "browser",
  "desktop",
  "fs",
  "git",
  "shell",
  "skill_run",
];

/** Familles portées et servies (`families`), ordre canonique : `familles_natives` par défaut. */
export function nativesPortees(servies: readonly string[]): string[] {
  return FAMILY_NAMES.filter((f) => servies.includes(f) && FAMILLES_NATIVES_PORTEES.includes(f));
}

/** `familles_natives` : clé absente (ou pas de toolhost.json) → toutes les familles portées et servies ; liste explicite (même vide) respectée, ordre canonique ; le reste est signalé et ignoré. */
function famillesNatives(raw: Dict, servies: readonly string[], warnings: string[]): string[] {
  const brut = lire(raw, "familles_natives");
  if (brut === undefined || brut === null) return nativesPortees(servies);
  if (!Array.isArray(brut)) {
    warnings.push("familles_natives ignoré : liste de familles attendue");
    return [];
  }
  const voulues = new Set(brut.map((x) => stripPy(strPy(x)).toLowerCase()));
  for (const f of [...voulues].sort()) {
    if (!FAMILY_NAMES.includes(f)) warnings.push(`famille native inconnue ignorée : ${reprPy(f)}`);
    else if (!FAMILLES_NATIVES_PORTEES.includes(f))
      warnings.push(`famille native sans implémentation TypeScript ignorée (relayée) : ${reprPy(f)}`);
    else if (!servies.includes(f)) warnings.push(`famille native hors de families ignorée : ${reprPy(f)}`);
  }
  return FAMILY_NAMES.filter(
    (f) => voulues.has(f) && servies.includes(f) && FAMILLES_NATIVES_PORTEES.includes(f),
  );
}

/** `float(x or 60.0)` ; TypeError/ValueError → 60. */
function decalage(raw: Dict, warnings: string[]): number {
  const v = lire(raw, "identity_max_skew_s");
  let x: number;
  try {
    x = floatPy(veritePy(v) ? v : 60);
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return 60;
    throw e;
  }
  if (Number.isFinite(x) && x >= 1) return x;
  warnings.push(`identity_max_skew_s=${String(x)} refusé (fini, au moins 1) : 60 s`);
  return 60;
}

/** Erreurs du schéma `docs/schemas/toolhost.schema.json` (Ajv) ; le Python ne valide pas : de simples avertissements. */
export function erreursDuSchema(raw: Dict): string[] {
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(path.join(racine(), CHEMIN_SCHEMA), "utf-8"));
  } catch {
    return [`schéma : ${CHEMIN_SCHEMA} illisible sous ${racine()} : configuration non vérifiée`];
  }
  const valider = compilerSchema(schema);
  if (valider === null) return [];
  return erreursSchema(valider, schema, raw).map(
    (e) => `schéma : ${e.chemin.join(".") || "(racine)"} : ${e.message}`,
  );
}

/** URL d'amont MCP : env, sinon clé du fichier, barre finale et point de montage final (`montage`, comme `…:8767/mcp` du lanceur) retirés : l'origine ; http(s) sans requête ni identifiants, sinon ignorée. */
function amont(
  env: NodeJS.ProcessEnv,
  variable: string,
  raw: Dict,
  cle: string,
  montage: string,
  warnings: string[],
): string {
  const v = env[variable] || lire(raw, cle);
  let brut = rstripPy(stripPy(veritePy(v) ? strPy(v) : ""), "/");
  if (brut.endsWith(montage) && /^[a-z]+:\/\/[^/]+\//iu.test(brut))
    brut = rstripPy(brut.slice(0, -montage.length), "/");
  if (!brut) return "";
  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    warnings.push(`${cle} ignoré : URL illisible`);
    return "";
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    warnings.push(`${cle} ignoré : URL http(s) sans requête, fragment ni identifiants attendue`);
    return "";
  }
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    warnings.push(`${cle} en http hors de la boucle locale : le jeton de service y circule en clair`);
  return brut;
}

/** `json.loads` sur un texte : messages de CPython, BOM refusé comme lui. */
function lireJsonPy(texte: string): unknown {
  if (texte.startsWith("\ufeff"))
    throw new Error("Unexpected UTF-8 BOM (decode using utf-8-sig): line 1 column 1 (char 0)");
  return decoderJsonPy(texte);
}

/** `load()` : `toolhost.json` (ou défauts) ; `LOCAL_MCP_*` et `TOOLHOST_*` de l'environnement priment. */
export function chargerConfig(chemin?: string, env: NodeJS.ProcessEnv = process.env): ToolhostConfig {
  const p = chemin ?? configPath(env);
  const warnings: string[] = [];
  let raw: Dict = {};
  let source: ToolhostConfig["source"] = "defaults";
  const nom = path.basename(p);
  if (estFichierPy(p)) {
    try {
      const lu = lireJsonPy(lireTextePy(p));
      if (estDict(lu)) {
        raw = lu;
        source = "file";
      } else warnings.push(`${nom} : objet JSON attendu`);
    } catch (e) {
      warnings.push(`${nom} illisible : ${e instanceof Error ? e.message : strPy(e)}`);
    }
  }
  if (source === "file") warnings.push(...erreursDuSchema(raw));
  const bindBrut = lire(raw, "bind");
  const bind: Dict = estDict(bindBrut) ? bindBrut : {};
  const host = premierTexte(
    "bind.host",
    env["LOCAL_MCP_HOST"],
    lire(bind, "host"),
    config.LOCAL_MCP_HOST,
    "127.0.0.1",
  );
  let transport = premierTexte(
    "bind.transport",
    env["LOCAL_MCP_TRANSPORT"],
    lire(bind, "transport"),
    "streamable-http",
  ).toLowerCase();
  if (transport === "http" || transport === "streamable_http") transport = "streamable-http";
  let transports = normaliserTransports(transportsReseau(env, bind) ?? ["http", "sse"]);
  if (transport === "stdio") transports = [];
  else if (transports.length === 0) {
    transports = ["http"];
    warnings.push("aucun transport réseau reconnu — repli sur http");
  }
  const tokenFile = relatif(lire(raw, "token_file"), strPy(config.LOCAL_MCP_TOKEN_FILE || ""));
  const tokenEnv = stripPy(env["LOCAL_MCP_TOKEN"] ?? "");
  let token = tokenFile ? tokenEnv || lireFichierJeton(tokenFile) : tokenEnv;
  if (!token) token = stripPy(strPy(config.LOCAL_MCP_TOKEN || ""));
  if (token && ![...token].every((c) => c.charCodeAt(0) < 0x80))
    warnings.push("jeton de service non ASCII : aucune requête ne peut le présenter, API fermée");
  const fams = familles(env, raw, warnings);
  const sandboxDir = relatif(
    lire(raw, "sandbox_dir"),
    env["APP_SANDBOX_DIR"] || strPy(config.SANDBOX_DIR || ""),
  );
  let dbPath = relatif(lire(raw, "db_path"), "");
  if (source === "file" && !dbPath) dbPath = realpathPy(pyJoin(racine(), "user_db/toolhost.db"));
  const assetsBrut = lire(raw, "assets");
  const assets: Dict = estDict(assetsBrut) ? assetsBrut : {};
  const texte = (variable: string, valeur: unknown): string =>
    stripPy(env[variable] || (veritePy(valeur) ? strPy(valeur) : ""));
  return {
    host,
    port: port(env, bind),
    transport,
    transports,
    token,
    token_file: tokenFile,
    families: fams,
    familles_natives: famillesNatives(raw, fams, warnings),
    natives_par_defaut: lire(raw, "familles_natives") === undefined || lire(raw, "familles_natives") === null,
    sandbox_dir: sandboxDir,
    db_path: dbPath,
    app_url: rstripPy(texte("TOOLHOST_APP_URL", lire(raw, "app_url")), "/"),
    playwright_api_url: texte("PLAYWRIGHT_API_URL", lire(raw, "playwright_api_url")),
    pw_dir: texte("PW_SCREENS_DIR", lire(assets, "pw_dir")),
    desktop_dir: texte("DESKTOP_SCREENS_DIR", lire(assets, "desktop_dir")),
    identity_max_skew_s: decalage(raw, warnings),
    mcp_upstream: amont(env, "TOOLHOST_MCP_UPSTREAM", raw, "mcp_upstream", "/mcp", warnings),
    mcp_upstream_sse: amont(env, "TOOLHOST_MCP_UPSTREAM_SSE", raw, "mcp_upstream_sse", "/sse", warnings),
    source,
    path: source === "file" ? p : null,
    warnings,
    raw,
  };
}

/** `bind_allowed` : sans jeton, la boucle locale est la seule frontière acceptable. */
export function bindAutorise(hote: string, avecJeton: boolean): boolean {
  return avecJeton || ["127.0.0.1", "localhost", "::1"].includes(stripPy(hote ?? "").toLowerCase());
}

/** `apply_environment` : la configuration de l'hôte propagée à l'environnement que lisent les modules partagés (avant leur usage). */
export function appliquerEnvironnement(tc: ToolhostConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (tc.sandbox_dir) {
    env["APP_SANDBOX_DIR"] = tc.sandbox_dir;
    env["MCP_SANDBOX_ROOT"] = tc.sandbox_dir;
  }
  if (tc.db_path) {
    env["APP_DB_PATH"] = tc.db_path;
    env["APP_DB_BACKEND"] = "sqlite";
  }
  if (tc.playwright_api_url) env["PLAYWRIGHT_API_URL"] = tc.playwright_api_url;
  if (tc.pw_dir) env["PW_SCREENS_DIR"] = tc.pw_dir;
  if (tc.desktop_dir) env["DESKTOP_SCREENS_DIR"] = tc.desktop_dir;
  if (tc.token) env["LOCAL_MCP_TOKEN"] = tc.token;
  if (tc.app_url) env["TOOLHOST_APP_URL"] = tc.app_url;
  env["LOCAL_MCP_TRANSPORT"] = tc.transport;
  env["LOCAL_MCP_HOST"] = tc.host;
  env["LOCAL_MCP_PORT"] = String(tc.port);
  const relayees = tc.families.filter((f) => !tc.familles_natives.includes(f));
  env["LOCAL_MCP_TOOL_FAMILIES"] = relayees.length
    ? relayees.join(",")
    : tc.familles_natives.length
      ? FAMILY_NAMES.map((f) => `-${f}`).join(",")
      : "all";
  env["ELPIS_TOOLHOST"] = "1";
}
