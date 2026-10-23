// SPDX-License-Identifier: MIT
/** packages/mcp/src/manifeste.ts — manifeste `mcp.json` des serveurs d'outils : substitution, normalisation, validation, synthèse héritée, surcharges d'environnement et cache. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  comparePointsDeCode,
  ErreurPython,
  intPy,
  rstripPy,
  strPy,
  stripPy,
  urlsplit,
  urlunsplit,
  veritePy,
} from "@elpis/commun";
import { config, parseJsonPy } from "@elpis/config";
import type { ValidateFunction } from "ajv/dist/2020.js";

import {
  APP_FAMILIES,
  brancherManifesteFamilles,
  DEFAULT_OPENCODE_EXCLUDE,
  FAMILY_CATEGORY,
  FAMILY_NAMES,
  opencodeFamilies,
  parseFamilies,
  parseFamilySet,
} from "./familles";
import { estDict, iterer, lire, poser, repr, texte, texteNet } from "./outils";
import type { Dict } from "./outils";
import { journalDe, marquerConfiance } from "./ports";
import { compilerSchema, erreursSchema } from "./schema-json";

export const BUILTIN_SENTINEL = "DEFAULT_LOCAL_PYTHON";

export const ROLE_TOOLHOST = "toolhost";
export const ROLE_APP = "app";
export const ROLE_EXTERNAL = "external";
const ROLES = [ROLE_TOOLHOST, ROLE_APP, ROLE_EXTERNAL];

export const TYPE_HTTP = "http";
export const TYPE_SSE = "sse";
export const TYPE_STDIO = "stdio";
export const TYPE_INPROCESS = "inprocess";
const NETWORK_TYPES = [TYPE_HTTP, TYPE_SSE];

export const IDENTITY_META = "meta";
export const IDENTITY_TOKEN = "token";

export const DEFAULT_TOOLHOST_NAME = "elpis-tools";
export const OPENCODE_PREFIX_DEFAULT = "elpis-";
export const MANIFEST_VERSION = 1;

const SUBST_RE = /\$\{(env|file|python|root)(?::([^}]*))?\}/g;

/** Config de pool d'un serveur MCP (forme Python : clés libres, valeurs JSON). */
export type ConfigMcp = Dict;

// ── Environnement (racine du dépôt, interpréteurs Python et Node) ────────────

const surcharges: { racine: string | null; python: string | null; node: string | null } = {
  racine: null,
  python: null,
  node: null,
};

/** Tests : racine et interpréteurs figés ; rend la fonction qui remet les précédents. */
export function reglerEnvironnementManifeste(r: {
  racine?: string | null;
  python?: string | null;
  node?: string | null;
}): () => void {
  const avant = { ...surcharges };
  if (r.racine !== undefined) surcharges.racine = r.racine;
  if (r.python !== undefined) surcharges.python = r.python;
  if (r.node !== undefined) surcharges.node = r.node;
  return () => Object.assign(surcharges, avant);
}

function racineProjet(): string {
  return surcharges.racine ?? config.PROJECT_ROOT;
}

/** `sys.executable` du core Python : `ELPIS_PYTHON`, sinon le venv du dépôt, sinon `python3` (le core TS n'a pas d'interpréteur). */
export function interpreteurPython(): string {
  if (surcharges.python !== null) return surcharges.python;
  const env = stripPy(process.env["ELPIS_PYTHON"] ?? "");
  if (env) return env;
  const venv = path.join(racineProjet(), "venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

/** Repli stdio de familles de l'hôte : `main.mjs --stdio` de l'hôte TS (écart : `python -m toolhost --stdio` en Python). */
export function commandeStdioHote(familles: readonly string[]): RepliStdio {
  return {
    type: TYPE_STDIO,
    command: surcharges.node ?? process.execPath,
    args: [
      joindre(racineProjet(), "apps/toolhost/dist/main.mjs"),
      "--stdio",
      "--families",
      familles.join(","),
    ],
    env: { LOCAL_MCP_TRANSPORT: "stdio" },
  };
}

function expanduser(p: string): string {
  if (p !== "~" && !p.startsWith("~/")) return p;
  return (process.env["HOME"] || homedir()) + p.slice(1);
}

/** `Path(x)` posix : barres doublées et `.` retirés, `..` gardés (pas de résolution). */
function cheminPy(p: string): string {
  if (!p) return ".";
  const absolu = p.startsWith("/");
  const parties = p.split("/").filter((x) => x !== "" && x !== ".");
  const corps = parties.join("/");
  if (absolu) return "/" + corps;
  return corps || ".";
}

function joindre(racine: string, p: string): string {
  const q = cheminPy(p);
  if (q.startsWith("/")) return q;
  const r = cheminPy(racine);
  return q === "." ? r : r === "." ? q : r.endsWith("/") ? r + q : `${r}/${q}`;
}

/** `APP_MCP_MANIFEST` (relu à chaque appel) sinon `<racine>/mcp.json`. */
export function manifestPath(): string {
  const brut = stripPy(process.env["APP_MCP_MANIFEST"] ?? "");
  if (brut) {
    const p = cheminPy(expanduser(brut));
    return p.startsWith("/") ? p : joindre(racineProjet(), p);
  }
  return joindre(racineProjet(), "mcp.json");
}

const FINS_DE_LIGNE = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

function premiereLigne(s: string): string {
  for (let i = 0; i < s.length; i++) if (FINS_DE_LIGNE.has(s.charCodeAt(i))) return s.slice(0, i);
  return s;
}

/** `p.read_text(encoding="utf-8")` : décodage strict, BOM conservé. */
function lireTexteUtf8(p: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(p));
}

/** `${env:NOM}`, `${file:chemin}` (première ligne), `${python}`, `${root}` ; récursif ; une substitution impossible donne "" et un avertissement. */
export function substitute(
  value: unknown,
  options: { root?: string; warnings?: string[] | null } = {},
): unknown {
  const root = options.root ?? racineProjet();
  const warnings = options.warnings ?? null;
  if (estDict(value)) {
    const out: Dict = {};
    for (const [k, v] of Object.entries(value)) poser(out, k, substitute(v, { root, warnings }));
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, { root, warnings }));
  if (typeof value !== "string" || !value.includes("${")) return value;
  return value.replace(SUBST_RE, (tout: string, kind: string, brut: string | undefined) => {
    const arg = stripPy(brut ?? "");
    if (kind === "env") {
      const v = process.env[arg];
      if (v === undefined) warnings?.push(`variable d'environnement absente : ${arg}`);
      return v || "";
    }
    if (kind === "file") {
      let p = cheminPy(expanduser(arg));
      if (!p.startsWith("/")) p = joindre(root, p);
      try {
        const contenu = lireTexteUtf8(p);
        return contenu ? stripPy(premiereLigne(contenu)) : "";
      } catch {
        warnings?.push(`fichier illisible : ${arg}`);
        return "";
      }
    }
    if (kind === "python") return interpreteurPython();
    if (kind === "root") return root;
    return tout;
  });
}

/** `http://h:8765/mcp/git` → `http://h:8765` : retire un segment de famille connue puis le montage (`/mcp` ou `/sse`). */
export function stripMcpPath(url: string | null | undefined): string {
  const u = stripPy(url || "").replace(/\/+$/, "");
  if (!u) return "";
  const parts = urlsplit(u);
  if (!parts.netloc) return u;
  const segs = parts.path.split("/").filter((x) => x !== "");
  for (let i = 0; i < 2; i++) {
    const dernier = segs[segs.length - 1];
    if (dernier !== undefined && (FAMILY_NAMES.includes(dernier) || dernier === "mcp" || dernier === "sse")) {
      segs.pop();
      continue;
    }
    break;
  }
  return urlunsplit({
    scheme: parts.scheme,
    netloc: parts.netloc,
    path: segs.length > 0 ? ["", ...segs].join("/") : "",
    query: "",
    fragment: "",
  }).replace(/\/+$/, "");
}

// ── Modèle ─────────────────────────────────────────────────────────────────

export interface RepliStdio {
  type: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export class ServerEntry {
  name: string;
  type = TYPE_HTTP;
  url = "";
  headers: Record<string, string> = {};
  command = "";
  args: string[] = [];
  env: Record<string, string> = {};
  description = "";
  enabled = true;
  role = ROLE_EXTERNAL;
  identity = IDENTITY_TOKEN;
  families: string[] = [];
  default_on: string[] = [];
  default_on_self = false;
  opencode_families: string[] = [];
  opencode_prefix = OPENCODE_PREFIX_DEFAULT;
  opencode_publish = false;
  sandbox = "";
  host = "";
  fallback: RepliStdio | null = null;
  serve: Dict = {};
  prompt_fragments: Record<string, string> = {};
  raw: Dict = {};

  constructor(champs: Partial<ServerEntry> & { name: string }) {
    this.name = champs.name;
    Object.assign(this, champs);
  }

  get isBuiltin(): boolean {
    return this.role === ROLE_TOOLHOST || this.role === ROLE_APP;
  }

  get isNetwork(): boolean {
    return NETWORK_TYPES.includes(this.type) && Boolean(this.url);
  }

  /** Jeton porté par `Authorization: Bearer …` (vide sinon). */
  get token(): string {
    for (const [k, v] of Object.entries(this.headers)) {
      if (k.toLowerCase() !== "authorization") continue;
      const val = texteNet(v);
      return val.toLowerCase().startsWith("bearer") ? stripPy(val.slice(6)) : val;
    }
    return "";
  }

  /** Config telle que le pool la consomme : une entrée intégrée garde la forme sentinelle, une entrée app sans URL la forme en processus. */
  clientCfg(filterCategories: unknown[] | null = null): ConfigMcp {
    let cfg: ConfigMcp;
    if (this.role === ROLE_APP && !this.isNetwork) {
      cfg = {
        type: TYPE_INPROCESS,
        name: this.name,
        manifest: this.name,
        identity: IDENTITY_META,
        role: this.role,
        families: [...this.families],
      };
    } else if (this.isBuiltin) {
      cfg = {
        type: TYPE_STDIO,
        name: this.name,
        command: BUILTIN_SENTINEL,
        manifest: this.name,
        identity: IDENTITY_META,
        role: this.role,
        families: [...this.families],
      };
    } else {
      cfg = {
        type: this.type,
        name: this.name,
        manifest: this.name,
        identity: this.identity,
        role: this.role,
      };
      if (NETWORK_TYPES.includes(this.type)) {
        cfg["url"] = this.url;
        if (Object.keys(this.headers).length > 0) cfg["headers"] = { ...this.headers };
      } else if (this.type === TYPE_STDIO) {
        cfg["command"] = stripPy([this.command, ...this.args].join(" "));
        if (Object.keys(this.env).length > 0) cfg["env"] = { ...this.env };
      }
    }
    if (filterCategories !== null) cfg["filter_categories"] = [...filterCategories];
    return marquerConfiance(cfg);
  }

  /** Les façons de joindre cette entrée depuis un applicatif tiers (HTTP streamable, SSE, stdio du repli). */
  endpoints(baseUrl = ""): Dict {
    const fam = this.families.length === 1 ? (this.families[0] ?? "") : "";
    let base = rstripPy(baseUrl || "", "/");
    if (!base && this.url) base = stripMcpPath(this.url);
    const seg = fam ? `/${fam}` : "";
    const out: Dict = {};
    if (base) {
      out["http"] = `${base}/mcp${seg}`;
      if (!(this.role === ROLE_APP && this.isNetwork)) out["sse"] = `${base}/sse${seg}`;
    }
    const fb = this.fallback;
    if (fb !== null && veritePy(fb.command))
      out["stdio"] = { command: fb.command, args: [...(fb.args ?? [])], env: { ...(fb.env ?? {}) } };
    return out;
  }

  /** Entrée `opencode.json` (`type: remote`) d'un serveur externe publié tel quel. */
  opencodeEntry(): Dict {
    const entry: Dict = { type: "remote", url: this.url, enabled: Boolean(this.enabled) };
    if (Object.keys(this.headers).length > 0) entry["headers"] = { ...this.headers };
    return entry;
  }
}

export class Manifest {
  servers = new Map<string, ServerEntry>();
  sandbox_hosts = new Map<string, Dict>();
  placement: Dict = {};
  source = "synthesized";
  path: string | null = null;
  warnings: string[] = [];
  errors: string[] = [];
  loaded_at = 0;
  mtime = 0;
  version = MANIFEST_VERSION;

  private entrees(): ServerEntry[] {
    return [...this.servers.values()];
  }

  /** La première entrée `role: toolhost` (activée ou non) : transport, jeton et préfixe opencode de référence. */
  toolhost(): ServerEntry | null {
    return this.entrees().find((e) => e.role === ROLE_TOOLHOST) ?? null;
  }

  toolhosts(enabledOnly = true): ServerEntry[] {
    return this.entrees().filter((e) => e.role === ROLE_TOOLHOST && (e.enabled || !enabledOnly));
  }

  /** Entrées `role: app` (familles liées au compte, servies en processus par main, ou par le serveur de leur URL si elles en ont une). */
  apps(enabledOnly = true): ServerEntry[] {
    return this.entrees().filter((e) => e.role === ROLE_APP && (e.enabled || !enabledOnly));
  }

  /** Descripteur d'hôte : clé donnée, sinon celle du placement, `main`, puis le premier déclaré. */
  host(key: unknown = ""): Dict {
    const k = texteNet(key);
    const hote = (cle: string): Dict | null => {
      const h = this.sandbox_hosts.get(cle);
      return h === undefined ? null : { ...h };
    };
    if (k && this.sandbox_hosts.has(k)) return hote(k) ?? {};
    for (const c of [texte(lire(this.placement, "host")), "main"])
      if (c && this.sandbox_hosts.has(c)) return hote(c) ?? {};
    for (const v of this.sandbox_hosts.values()) return { ...v };
    return {};
  }

  /** Origine de l'hôte d'outils : descripteur d'hôte, sinon dérivée d'une entrée toolhost réseau. */
  hostBaseUrl(key: unknown = ""): string {
    const url = texteNet(lire(this.host(key), "url")).replace(/\/+$/, "");
    if (url) return stripMcpPath(url);
    for (const e of this.toolhosts()) if (e.isNetwork) return stripMcpPath(e.url);
    return "";
  }

  /** Base du service MCP (`…/mcp`), à laquelle opencode ajoute `/<famille>`. */
  mcpBaseUrl(key: unknown = ""): string {
    const base = this.hostBaseUrl(key);
    return base ? base + "/mcp" : "";
  }

  /** Jeton de service de l'hôte : descripteur, sinon `Authorization` d'une entrée toolhost. */
  hostToken(key: unknown = ""): string {
    const tok = texteNet(lire(this.host(key), "token"));
    if (tok) return tok.toLowerCase().startsWith("bearer") ? stripPy(tok.slice(7)) : tok;
    for (const e of this.toolhosts()) if (e.token) return e.token;
    return "";
  }

  builtins(enabledOnly = true): ServerEntry[] {
    return this.entrees().filter((e) => e.isBuiltin && (e.enabled || !enabledOnly));
  }

  externals(enabledOnly = true): ServerEntry[] {
    return this.entrees().filter((e) => !e.isBuiltin && (e.enabled || !enabledOnly));
  }

  get(name: unknown): ServerEntry | null {
    return this.servers.get(texteNet(name)) ?? null;
  }

  /** Familles à enregistrer sur l'hôte d'outils (une entrée app réseau est servie par son propre service). */
  families(): string[] {
    const want = new Set<string>();
    for (const e of this.builtins()) {
      if (e.role === ROLE_APP && e.isNetwork) continue;
      for (const f of e.families) want.add(f);
    }
    const out = FAMILY_NAMES.filter((f) => want.has(f));
    return out.length > 0 ? out : this.builtins().length === 0 ? [...FAMILY_NAMES] : [];
  }

  toolhostFamilies(): string[] {
    const want = new Set(this.toolhosts().flatMap((e) => e.families));
    return FAMILY_NAMES.filter((f) => want.has(f));
  }

  entryForFamily(family: unknown): ServerEntry | null {
    const fam = texteNet(family).toLowerCase();
    return this.builtins().find((e) => e.families.includes(fam)) ?? null;
  }

  /** Catégories pré-cochées dans un nouveau chat, dérivées des `default_on` des entrées intégrées. */
  defaultOnCategories(): Set<string> {
    const out = new Set<string>();
    for (const e of this.builtins()) for (const fam of e.default_on) out.add(FAMILY_CATEGORY[fam] ?? fam);
    return out;
  }

  defaultOnExternals(): string[] {
    return this.externals()
      .filter((e) => e.default_on_self)
      .map((e) => e.name);
  }

  /** Familles publiées à opencode (`publish: true` et forme héritée `families`), exclusion invariante appliquée. */
  opencodeFamilies(): string[] {
    const want = new Set<string>();
    for (const e of this.toolhosts()) {
      if (e.opencode_publish) for (const f of e.families) want.add(f);
      for (const f of e.opencode_families) if (e.families.includes(f)) want.add(f);
    }
    const exc = parseFamilySet(DEFAULT_OPENCODE_EXCLUDE);
    return FAMILY_NAMES.filter((f) => want.has(f) && !exc.has(f));
  }

  opencodePrefix(): string {
    return this.toolhost()?.opencode_prefix ?? OPENCODE_PREFIX_DEFAULT;
  }

  /** Vue d'administration, jetons masqués. */
  toPublicDict(): Dict {
    const masquer = (h: Record<string, string>): Dict => {
      const out: Dict = {};
      for (const [k, v] of Object.entries(h))
        poser(out, k, k.toLowerCase() === "authorization" && v ? "***" : strPy(v));
      return out;
    };
    const base = this.hostBaseUrl();
    const servers = this.entrees().map((e) => ({
      endpoints: e.endpoints(e.role === ROLE_TOOLHOST ? base : ""),
      name: e.name,
      type: e.type,
      url: e.url,
      headers: masquer(e.headers),
      command: e.command,
      args: [...e.args],
      description: e.description,
      enabled: e.enabled,
      role: e.role,
      identity: e.identity,
      families: [...e.families],
      default_on: [...e.default_on],
      default_on_self: e.default_on_self,
      opencode_families: [...e.opencode_families],
      opencode_publish: e.opencode_publish,
      has_token: Boolean(e.token),
      fallback: Boolean(e.fallback),
      sandbox: e.sandbox,
      host: e.host,
    }));
    const hotes: Dict = {};
    for (const [k, v] of this.sandbox_hosts) {
      const h: Dict = {};
      for (const [kk, vv] of Object.entries(v)) poser(h, kk, kk === "token" && veritePy(vv) ? "***" : vv);
      poser(hotes, k, h);
    }
    return {
      version: this.version,
      source: this.source,
      host_base_url: base,
      mcp_base_url: this.mcpBaseUrl(),
      path: this.path ?? "",
      loaded_at: this.loaded_at,
      servers,
      sandbox_hosts: hotes,
      placement: { ...this.placement },
      warnings: [...this.warnings],
      errors: [...this.errors],
    };
  }
}

/** Bloc `{"mcpServers": {…}}` prêt à coller dans un autre applicatif ; le jeton n'y est que s'il est fourni. */
export function exportServers(
  entries: ServerEntry[],
  options: { baseUrl?: string; transport?: string; token?: string; prefix?: string } = {},
): Dict {
  let transport = stripPy(options.transport || "http").toLowerCase();
  if (["streamable-http", "streamable_http", "remote"].includes(transport)) transport = "http";
  const out: Dict = {};
  for (const e of entries) {
    const eps = e.endpoints(e.role === ROLE_TOOLHOST ? (options.baseUrl ?? "") : "");
    const name = options.prefix ? `${options.prefix}${e.name}` : e.name;
    let spec: Dict;
    if (transport === "stdio") {
      const st = lire(eps, "stdio") as RepliStdio | undefined;
      if (!veritePy(st) || st === undefined) continue;
      spec = { type: TYPE_STDIO, command: st.command, args: [...st.args] };
      if (veritePy(st.env)) spec["env"] = { ...st.env };
    } else {
      const url = lire(eps, transport);
      if (!veritePy(url)) continue;
      spec = { type: transport === "sse" ? TYPE_SSE : TYPE_HTTP, url };
      if (options.token) spec["headers"] = { Authorization: `Bearer ${options.token}` };
    }
    if (e.description) spec["description"] = e.description;
    poser(out, name, spec);
  }
  return { mcpServers: out };
}

// ── Normalisation ──────────────────────────────────────────────────────────

const TYPE_ALIASES: Readonly<Record<string, string>> = {
  http: TYPE_HTTP,
  "streamable-http": TYPE_HTTP,
  streamable_http: TYPE_HTTP,
  streamablehttp: TYPE_HTTP,
  remote: TYPE_HTTP,
  sse: TYPE_SSE,
  stdio: TYPE_STDIO,
  local: TYPE_STDIO,
  inprocess: TYPE_INPROCESS,
  "in-process": TYPE_INPROCESS,
};

function normaliserType(raw: unknown, aUrl: boolean, aCommande: boolean): string {
  const t = texteNet(raw).toLowerCase();
  if (Object.hasOwn(TYPE_ALIASES, t)) return TYPE_ALIASES[t] ?? TYPE_HTTP;
  if (aUrl) return TYPE_HTTP;
  if (aCommande) return TYPE_STDIO;
  return TYPE_HTTP;
}

/** Forme au repos `[{name, value}]` ou dict → dict de textes (clés textuelles non vides, valeurs non nulles). */
function dictDeTextes(raw: unknown): Record<string, string> {
  const d: unknown = raw;
  if (Array.isArray(raw)) {
    const paires: [unknown, unknown][] = [];
    for (const p of raw)
      if (estDict(p) && veritePy(lire(p, "name"))) paires.push([lire(p, "name"), lire(p, "value")]);
    const vues = new Map<unknown, unknown>();
    for (const [k, v] of paires) vues.set(k, v);
    const out: Record<string, string> = {};
    for (const [k, v] of vues)
      if (typeof k === "string" && k && v !== null && v !== undefined) poser(out, k, strPy(v));
    return out;
  }
  if (!estDict(d)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) if (k && v !== null && v !== undefined) poser(out, k, strPy(v));
  return out;
}

function nomTypePy(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (estDict(v)) return "dict";
  return typeof v;
}

/** Familles connues dans l'ordre canonique ; liste ou grammaire `all,-x` ; un nom inconnu est ignoré avec avertissement. */
function listeFamilles(
  raw: unknown,
  warnings: string[],
  where: string,
  defaut: string[] | null = null,
): string[] {
  if (raw === null || raw === undefined) return defaut !== null ? [...defaut] : [];
  if (typeof raw === "string") return parseFamilies(raw, (m) => warnings.push(`${where} : ${m}`));
  if (typeof raw === "boolean") {
    if (raw && defaut !== null) return [...defaut];
    return raw ? [...FAMILY_NAMES] : [];
  }
  if (Array.isArray(raw)) {
    const voulues = new Set(raw.filter((x) => typeof x === "string").map((x) => stripPy(x).toLowerCase()));
    for (const u of [...voulues].filter((x) => !FAMILY_NAMES.includes(x)).sort(comparePointsDeCode))
      warnings.push(`${where} : famille d'outils inconnue ignorée : ${repr(u)}`);
    return FAMILY_NAMES.filter((f) => voulues.has(f));
  }
  warnings.push(`${where} : liste de familles invalide (${nomTypePy(raw)})`);
  return defaut !== null ? [...defaut] : [];
}

/** Entrée brute (déjà substituée) → `ServerEntry`, ou `null` si inexploitable (jamais d'exception pour une entrée incohérente). */
export function normalizeEntry(name: string, raw: unknown, warnings: string[]): ServerEntry | null {
  if (!estDict(raw)) {
    warnings.push(`${name} : entrée ignorée (pas un objet)`);
    return null;
  }
  const url = texteNet(lire(raw, "url"));
  const command = texteNet(lire(raw, "command"));
  const args = iterer(veritePy(lire(raw, "args")) ? lire(raw, "args") : [])
    .filter((a) => typeof a === "string" || typeof a === "number" || typeof a === "boolean")
    .map((a) => strPy(a));
  const xeBrut = lire(raw, "x-elpis");
  const xe: Dict = estDict(xeBrut) ? xeBrut : {};
  let role = stripPy(strPy(veritePy(lire(xe, "role")) ? lire(xe, "role") : ROLE_EXTERNAL)).toLowerCase();
  if (!ROLES.includes(role)) {
    warnings.push(`${name} : rôle inconnu ${repr(role)} → external`);
    role = ROLE_EXTERNAL;
  }
  let typ = normaliserType(lire(raw, "type"), Boolean(url), Boolean(command));
  const isBuiltin = role === ROLE_TOOLHOST || role === ROLE_APP;
  if (role === ROLE_APP && !url && !command) typ = TYPE_INPROCESS;
  if (NETWORK_TYPES.includes(typ) && !url && !isBuiltin) {
    warnings.push(`${name} : serveur réseau sans url — ignoré`);
    return null;
  }
  if (typ === TYPE_STDIO && !command && !isBuiltin) {
    warnings.push(`${name} : serveur stdio sans command — ignoré`);
    return null;
  }
  if (typ === TYPE_INPROCESS && !isBuiltin) {
    warnings.push(`${name} : type inprocess réservé aux entrées intégrées — ignoré`);
    return null;
  }

  const identiteDefaut = isBuiltin ? IDENTITY_META : IDENTITY_TOKEN;
  let identity = stripPy(
    strPy(veritePy(lire(xe, "identity")) ? lire(xe, "identity") : identiteDefaut),
  ).toLowerCase();
  if (identity !== IDENTITY_META && identity !== IDENTITY_TOKEN) {
    warnings.push(`${name} : identity inconnue ${repr(identity)}`);
    identity = identiteDefaut;
  }
  if (identity === IDENTITY_META && !isBuiltin) {
    warnings.push(`${name} : identity=meta refusée pour un serveur externe → token`);
    identity = IDENTITY_TOKEN;
  }

  const families = listeFamilles(lire(xe, "families"), warnings, name, []);
  const dOnBrut = lire(xe, "default_on");
  let defaultOn: string[];
  let defaultOnSelf = false;
  if (isBuiltin) {
    defaultOn = dOnBrut === true ? [...families] : listeFamilles(dOnBrut, warnings, `${name}.default_on`, []);
    defaultOn = defaultOn.filter((f) => families.includes(f));
  } else {
    defaultOn = [];
    defaultOnSelf = veritePy(dOnBrut);
  }

  const ocBrut = lire(xe, "opencode");
  const oc: Dict = estDict(ocBrut) ? ocBrut : {};
  const ocPublish = veritePy(Object.hasOwn(oc, "publish") ? oc["publish"] : false);
  const ocPrefix = strPy(veritePy(lire(oc, "prefix")) ? lire(oc, "prefix") : OPENCODE_PREFIX_DEFAULT);
  const ocFamilies = isBuiltin
    ? listeFamilles(lire(oc, "families"), warnings, `${name}.opencode.families`, [])
    : [];

  let fb: unknown = Object.hasOwn(xe, "fallback") ? xe["fallback"] : null;
  let fallback: RepliStdio | null = null;
  if (fb === false) fb = null;
  if (estDict(fb) && texteNet(lire(fb, "command"))) {
    fallback = {
      type: TYPE_STDIO,
      command: stripPy(strPy(lire(fb, "command"))),
      args: iterer(veritePy(lire(fb, "args")) ? lire(fb, "args") : []).map((a) => strPy(a)),
      env: dictDeTextes(lire(fb, "env")),
    };
  } else if (fb !== null && fb !== undefined) {
    warnings.push(`${name} : fallback invalide (command manquante) — ignoré`);
  }

  const serveBrut = lire(xe, "serve");
  const pfBrut = lire(xe, "prompt_fragments");
  const pf: Record<string, string> = {};
  if (estDict(pfBrut)) for (const [k, v] of Object.entries(pfBrut)) poser(pf, k, strPy(v));

  return new ServerEntry({
    name,
    type: typ,
    url,
    headers: dictDeTextes(lire(raw, "headers")),
    command,
    args,
    env: dictDeTextes(lire(raw, "env")),
    description: texteNet(lire(raw, "description")),
    enabled: lire(raw, "enabled") !== false,
    role,
    identity,
    families,
    default_on: defaultOn,
    default_on_self: defaultOnSelf,
    opencode_families: ocFamilies,
    opencode_prefix: ocPrefix,
    opencode_publish: ocPublish,
    sandbox: texteNet(lire(xe, "sandbox")),
    host: texteNet(veritePy(lire(xe, "host")) ? lire(xe, "host") : lire(xe, "sandbox")),
    fallback,
    serve: estDict(serveBrut) ? { ...serveBrut } : {},
    prompt_fragments: pf,
    raw,
  });
}

// ── Validation (JSON Schema, tolérante) ──────────────────────────────────────

const schemas = new Map<string, { schema: unknown; valider: ValidateFunction | null }>();

export function schemaPath(): string {
  return joindre(racineProjet(), "docs/schemas/mcp.schema.json");
}

/** Erreurs de schéma (liste vide = valide) ; sans fichier de schéma : validation structurelle minimale. */
export function validateRaw(raw: unknown): string[] {
  const errors: string[] = [];
  if (!estDict(raw)) return ["le manifeste doit être un objet JSON"];
  const cleRacine = Object.hasOwn(raw, "mcpServers")
    ? "mcpServers"
    : Object.hasOwn(raw, "servers")
      ? "servers"
      : null;
  if (cleRacine === null) errors.push("clé racine absente : mcpServers (ou servers)");
  else if (!estDict(raw[cleRacine])) errors.push(`${cleRacine} doit être un objet nom → serveur`);
  const sp = schemaPath();
  let entree = schemas.get(sp);
  if (entree === undefined) {
    try {
      const schema = parseJsonPy(lireTexteUtf8(sp));
      entree = { schema, valider: compilerSchema(schema, "2020-12") };
      schemas.set(sp, entree);
    } catch {
      return errors;
    }
  }
  try {
    for (const e of erreursSchema(entree.valider, entree.schema, raw)) {
      const ou = e.chemin.map((p) => String(p)).join("/") || "(racine)";
      errors.push(`${ou} : ${e.message}`);
    }
  } catch (e) {
    errors.push(`validation impossible : ${e instanceof Error ? `${e.name}(${repr(e.message)})` : strPy(e)}`);
  }
  return errors;
}

// ── Synthèse depuis la config héritée (aucun fichier) ───────────────────────

function toolhostHerite(warnings: string[]): Dict {
  const url = texteNet(config.LOCAL_MCP_URL);
  const token = texteNet(config.LOCAL_MCP_TOKEN);
  const famsBrut = texte(config.LOCAL_MCP_TOOL_FAMILIES) || "all";
  const familles = parseFamilies(famsBrut, (m) => warnings.push(m));
  const compte = familles.filter((f) => (APP_FAMILIES as readonly string[]).includes(f));
  if (compte.length > 0)
    warnings.push(
      `sans mcp.json, l'hôte d'outils ne sert plus les familles du compte (${compte.join(", ")}) : ./elpis configure écrit mcp.json, qui les fait servir par main`,
    );
  const entry: Dict = {
    type: url ? (url.replace(/\/+$/, "").endsWith("/sse") ? TYPE_SSE : TYPE_HTTP) : TYPE_STDIO,
    description: "Outils intégrés (service local d'outils)",
    "x-elpis": {
      role: ROLE_TOOLHOST,
      identity: IDENTITY_META,
      families: familles,
      default_on: [],
      opencode: {
        families: opencodeFamilies({ warn: (m) => warnings.push(m), useManifest: false }),
        prefix: OPENCODE_PREFIX_DEFAULT,
      },
      fallback: commandeStdioHote(familles),
    },
  };
  if (url) entry["url"] = url;
  if (token) entry["headers"] = { Authorization: `Bearer ${token}` };
  return entry;
}

/** `mcp.local_servers` (registre déprécié) → entrées externes du manifeste synthétisé. */
function serveursHerites(warnings: string[]): Dict {
  const raw: unknown = config.LOCAL_MCP_SERVERS_RAW;
  const out: Dict = {};
  if (!estDict(raw)) return out;
  const extras = Object.entries(raw).filter(([k]) => stripPy(k) !== "" && k !== "local-tools");
  if (extras.length > 0)
    warnings.push(
      "config.json › mcp.local_servers est déprécié : déclarez ces serveurs dans mcp.json (mcpServers)",
    );
  for (const [name, spec] of extras) {
    if (!estDict(spec)) continue;
    const d: Dict = { ...spec };
    const type = Object.hasOwn(d, "transport") ? d["transport"] : (d["type"] ?? null);
    delete d["transport"];
    poser(d, "type", type);
    const expose = Object.hasOwn(d, "expose_opencode") ? d["expose_opencode"] : false;
    delete d["expose_opencode"];
    poser(d, "x-elpis", { role: ROLE_EXTERNAL, opencode: { publish: veritePy(expose) } });
    poser(out, stripPy(name), d);
  }
  return out;
}

function synthetiser(warnings: string[]): Dict {
  const servers: Dict = { [DEFAULT_TOOLHOST_NAME]: toolhostHerite(warnings) };
  for (const [k, v] of Object.entries(serveursHerites(warnings))) poser(servers, k, v);
  return { version: MANIFEST_VERSION, mcpServers: servers };
}

// ── Surcharges d'environnement ───────────────────────────────────────────────

/** `LOCAL_MCP_URL` / `_TOKEN` / `_TOOL_FAMILIES` / `_OPENCODE_FAMILIES` en environnement priment sur le fichier, pour toutes les entrées intégrées. */
function appliquerSurchargesEnv(
  servers: Map<string, ServerEntry>,
  warnings: string[],
  hosts: Map<string, Dict>,
  placement: Dict,
): void {
  const ths = [...servers.values()].filter((e) => e.role === ROLE_TOOLHOST);
  let hk = "";
  for (const k of [texte(lire(placement, "host")), "main"]) {
    if (k && hosts.has(k)) {
      hk = k;
      break;
    }
  }
  if (!hk && hosts.size > 0) hk = hosts.keys().next().value ?? "";
  const url = stripPy(process.env["LOCAL_MCP_URL"] || "");
  if (url && ths.length > 0) {
    const base = stripMcpPath(url);
    const segs = urlsplit(url.replace(/\/+$/, ""))
      .path.split("/")
      .filter((x) => x !== "");
    const montage = segs.includes("sse") ? "/sse" : "/mcp";
    for (const e of ths) {
      const fam = e.families.length === 1 ? (e.families[0] ?? "") : "";
      e.url = `${base}${montage}` + (fam ? `/${fam}` : "");
      e.type = montage === "/sse" ? TYPE_SSE : TYPE_HTTP;
    }
    if (hk) poser(hosts.get(hk) ?? {}, "url", base);
  }
  const tok = stripPy(process.env["LOCAL_MCP_TOKEN"] || "");
  if (tok) {
    if (hk) poser(hosts.get(hk) ?? {}, "token", tok);
    const cibles = [...ths, ...[...servers.values()].filter((x) => x.role === ROLE_APP && x.isNetwork)];
    for (const e of cibles) {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.headers)) if (k.toLowerCase() !== "authorization") poser(h, k, v);
      poser(h, "Authorization", `Bearer ${tok}`);
      e.headers = h;
    }
  }
  const fams = process.env["LOCAL_MCP_TOOL_FAMILIES"];
  if (fams !== undefined && stripPy(fams)) {
    const voulues = new Set(parseFamilies(fams, (m) => warnings.push(m)));
    for (const [name, e] of [...servers]) {
      if (!e.isBuiltin) continue;
      const gardees = e.families.filter((f) => voulues.has(f));
      if (gardees.length === 0) servers.delete(name);
      else {
        e.families = gardees;
        e.default_on = e.default_on.filter((f) => gardees.includes(f));
      }
    }
  }
  const ocf = process.env["LOCAL_MCP_OPENCODE_FAMILIES"];
  if (ocf !== undefined) {
    const permises = stripPy(ocf) ? new Set(parseFamilies(ocf, (m) => warnings.push(m))) : new Set<string>();
    for (const e of [...servers.values()].filter((x) => x.role === ROLE_TOOLHOST)) {
      e.opencode_families = e.families.filter((f) => permises.has(f));
      e.opencode_publish = e.opencode_families.length > 0;
    }
  }
}

// ── Construction et chargement (cache par mtime ; synthèse recalculée à chaque appel) ──

/** Repli stdio dérivé d'une entrée toolhost réseau qui n'en déclare pas (`"fallback": false` le refuse). */
function deriverReplis(entries: ServerEntry[]): void {
  for (const e of entries) {
    const xe = lire(e.raw, "x-elpis");
    if (e.fallback !== null || !e.isNetwork) continue;
    if (estDict(xe) && xe["fallback"] === false) continue;
    if (e.families.length === 0) continue;
    e.fallback = commandeStdioHote(e.families);
  }
}

function construire(
  raw: Dict,
  source: string,
  chemin: string | null,
  mtime: number,
  warnings: string[],
  errors: string[],
): Manifest {
  const root = racineProjet();
  const sousAvert: string[] = [];
  const rawSub = substitute(raw, { root, warnings: sousAvert }) as Dict;
  warnings.push(...sousAvert);
  const cleRacine = Object.hasOwn(rawSub, "mcpServers") ? "mcpServers" : "servers";
  const serversRaw = estDict(lire(rawSub, cleRacine)) ? (rawSub[cleRacine] as Dict) : {};
  const m = new Manifest();
  for (const [name, spec] of Object.entries(serversRaw)) {
    if (!stripPy(name)) continue;
    const e = normalizeEntry(stripPy(name), spec, warnings);
    if (e !== null) m.servers.set(e.name, e);
  }
  for (const cle of ["sandboxHosts", "toolHosts"]) {
    const brut = lire(rawSub, cle);
    if (!estDict(brut)) continue;
    for (const [k, v] of Object.entries(brut)) {
      if (!estDict(v)) continue;
      const cible = m.sandbox_hosts.get(k) ?? {};
      for (const [kk, vv] of Object.entries(v)) poser(cible, kk, vv);
      m.sandbox_hosts.set(k, cible);
    }
  }
  const pl = lire(rawSub, "placement");
  m.placement = estDict(pl) ? { ...pl } : {};
  let ths = [...m.servers.values()].filter((e) => e.role === ROLE_TOOLHOST);
  if (ths.length === 1 && ths[0] !== undefined && ths[0].families.length === 0)
    ths[0].families = [...FAMILY_NAMES];
  for (const e of ths)
    if (e.families.length === 0)
      warnings.push(`${e.name} : entrée toolhost sans x-elpis.families — aucun outil ne lui est rattaché`);
  if (source === "file") {
    appliquerSurchargesEnv(m.servers, warnings, m.sandbox_hosts, m.placement);
    ths = [...m.servers.values()].filter((e) => e.role === ROLE_TOOLHOST);
  }
  deriverReplis(ths);
  let version = MANIFEST_VERSION;
  try {
    version = intPy(veritePy(lire(rawSub, "version")) ? lire(rawSub, "version") : MANIFEST_VERSION);
  } catch (e) {
    if (!(e instanceof ErreurPython) || e.type === "OverflowError") throw e;
  }
  Object.assign(m, { source, path: chemin, warnings, errors, loaded_at: Date.now() / 1000, mtime, version });
  return m;
}

const log = (): ReturnType<typeof journalDe> => journalDe("mcp.json");

let cache: Manifest | null = null;
let cleCache = "";

/** Entrées `role: app` sans URL : familles du compte servies par le serveur MCP en processus de main (journalisé au chargement). */
function signalerEntreesEnProcessus(m: Manifest): void {
  for (const e of m.builtins(false))
    if (e.type === TYPE_INPROCESS)
      log().info(
        `${e.name} : entrée role=app sans url — familles ${e.families.join(",") || "(aucune)"} servies en processus par le core`,
      );
}

/** Le manifeste courant : fichier présent → cache invalidé par son mtime ; absent → synthèse depuis la config héritée. */
export function load(force = false): Manifest {
  const p = manifestPath();
  let mtime = 0;
  let mtimeNs = "";
  try {
    const st = statSync(p, { bigint: true });
    if (st.isFile()) {
      mtime = Number(st.mtimeNs) / 1e9;
      mtimeNs = st.mtimeNs.toString();
    }
  } catch {
    mtime = 0;
  }
  if (mtime > 0) {
    const cle = `${p}\u0000${mtimeNs}`;
    if (!force && cache !== null && cleCache === cle) return cache;
    const warnings: string[] = [];
    const errors: string[] = [];
    let raw: unknown;
    try {
      raw = parseJsonPy(lireTexteUtf8(p));
    } catch (e) {
      errors.push(`${path.basename(p)} illisible : ${e instanceof Error ? e.message : strPy(e)}`);
      raw = null;
    }
    if (estDict(raw)) errors.push(...validateRaw(raw));
    let m: Manifest;
    if (errors.length > 0 && !estDict(raw)) {
      log().error(`${errors.join("; ")} — repli sur la configuration héritée`);
      m = construire(synthetiser(warnings), "synthesized", p, mtime, warnings, errors);
    } else {
      for (const w of errors) log().warn(`schéma : ${w}`);
      if (!estDict(raw))
        throw new ErreurPython(
          "AttributeError",
          `'${Array.isArray(raw) ? "list" : nomTypePy(raw)}' object has no attribute 'get'`,
        );
      m = construire(raw, "file", p, mtime, warnings, errors);
      if (m.toolhost() === null)
        m.warnings.push("aucune entrée role=toolhost : le service d'outils intégré n'est pas déclaré");
    }
    for (const w of m.warnings) log().warn(w);
    signalerEntreesEnProcessus(m);
    cache = m;
    cleCache = cle;
    return m;
  }
  const warnings: string[] = [];
  return construire(synthetiser(warnings), "synthesized", null, 0, warnings, []);
}

/** Relecture forcée (route d'administration) et purge du cache. */
export function reload(): Manifest {
  cache = null;
  cleCache = "";
  return load(true);
}

/** Purge du cache sans relecture (tests, invalidation). */
export function oublierManifeste(): void {
  cache = null;
  cleCache = "";
  schemas.clear();
}

brancherManifesteFamilles(() => {
  const m = load();
  return { source: m.source, toolhost: () => m.toolhost(), opencodeFamilies: () => m.opencodeFamilies() };
});

// ── Raccourcis ─────────────────────────────────────────────────────────────

export function toolhostEntry(): ServerEntry | null {
  return load().toolhost();
}

/** Config sentinelle du service intégré, telle que la route de chat, les sous-agents et le pré-chauffage l'envoient au pool. */
export function builtinClientCfg(
  filterCategories: unknown[] | null = null,
  name: string | null = null,
): ConfigMcp {
  const th = toolhostEntry();
  if (th === null) {
    const cfg: ConfigMcp = {
      type: TYPE_STDIO,
      name: name || DEFAULT_TOOLHOST_NAME,
      command: BUILTIN_SENTINEL,
      identity: IDENTITY_META,
    };
    if (filterCategories !== null) cfg["filter_categories"] = [...filterCategories];
    return cfg;
  }
  const cfg = th.clientCfg(filterCategories);
  if (name) cfg["name"] = name;
  return cfg;
}

/** Configs de pool de toutes les entrées intégrées activées, une par entrée ; sentinelle nue si le manifeste n'en a aucune. */
export function builtinClientCfgs(filterCategories: unknown[] | null = null): ConfigMcp[] {
  const out = load()
    .builtins()
    .map((e) => e.clientCfg(filterCategories));
  if (out.length === 0) out.push(builtinClientCfg(filterCategories));
  return out;
}

/** Config de pool d'une entrée externe activée (par nom) : le serveur fait autorité, le navigateur n'envoie que le nom. */
export function resolveExternalCfg(name: unknown): ConfigMcp | null {
  const e = load().get(name);
  if (e === null || !e.enabled || e.isBuiltin) return null;
  return e.clientCfg(null);
}

/** `(url, jeton)` du service intégré partagé ; sans jeton de service, rien à relayer ni à publier. */
export function serviceUpstream(): [string | null, string] {
  const m = load();
  if (!m.toolhosts().some((e) => e.isNetwork)) return [null, ""];
  const base = m.mcpBaseUrl();
  const tok = m.hostToken();
  if (!base || !tok) return [null, ""];
  return [base, tok];
}
