// SPDX-License-Identifier: MIT
/** packages/mcp/src/serveurs.ts — serveurs MCP des comptes : bibliothèque partagée (admin, en base) et serveurs perso, secrets chiffrés (Fernet) jamais renvoyés au navigateur. */
import { ErreurPython, intPy, pyJsonDumps, strPy, stripPy, veritePy } from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";
import type { Base, Ligne } from "@elpis/db";
import { decrypt, encrypt } from "@elpis/securite";

import { BUILTIN_SENTINEL } from "./manifeste";
import { ErreurCle, estDict, lire, nomType, poser, repr, texte, texteNet } from "./outils";
import type { Dict } from "./outils";
import { gardeUrlBranchee, journalDe, marquerConfiance } from "./ports";

export const SERVER_TYPES = ["sse", "stdio", "http"] as const;
export const AUTH_MODES = ["", "basic", "raw", "bearer", "header"] as const;
export const HTTP_TYPES = ["sse", "http"] as const;
export const DEFAULT_HEADER_NAME = "X-API-Key";

export const MAX_PAIRS = 20;
export const MAX_PAIR_NAME = 128;
export const MAX_PAIR_VALUE = 8192;

const NOM_ENTETE_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const NOM_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const ENTETES_RESERVES = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "upgrade",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "expect",
]);

/** Variables que l'ancien lanceur stdio calculait lui-même. */
const ENV_RESERVES = new Set(["PYTHONPATH", "NODE_PATH", "APP_SANDBOX_DIR"]);

export interface Paire {
  name: string;
  value: string;
}

/** Nom d'en-tête ou de variable refusé (chemins qui peuvent répondre 400 : bibliothèque partagée). */
export class InvalidPair extends Error {
  override name = "InvalidPair";
}

/** Un compte non administrateur a tenté d'ajouter un serveur perso `stdio` (commande exécutée sur l'hôte). */
export class StdioNotAllowed extends Error {
  override name = "StdioNotAllowed";
}

/** URL d'un serveur perso vers une adresse interne ; sous-classe de `StdioNotAllowed` (403 côté routes). */
export class UrlNotAllowed extends StdioNotAllowed {
  override name = "UrlNotAllowed";
}

function estHttp(type: unknown): boolean {
  return type === "sse" || type === "http";
}

/** `s[:n]` en points de code. */
function prefixe(s: string, n: number): string {
  let fin = 0;
  let compte = 0;
  for (const c of s) {
    if (compte === n) break;
    fin += c.length;
    compte++;
  }
  return s.slice(0, fin);
}

function nomPaireOk(name: string, kind: string): boolean {
  if (kind === "env") return NOM_ENV_RE.test(name) && !ENV_RESERVES.has(name);
  return NOM_ENTETE_RE.test(name) && !ENTETES_RESERVES.has(name.toLowerCase());
}

/** Un nom d'en-tête est-il utilisable comme créneau d'auth `header` ? */
export function headerNameOk(name: unknown): boolean {
  return nomPaireOk(texteNet(name), "headers");
}

/** `(raw or [])[:80]` : une liste est tranchée, un texte ne donne aucun dict, un dict lève KeyError (Python ≥ 3.12), le reste TypeError. */
function quatreVingtsPremiers(raw: unknown): unknown[] {
  if (!veritePy(raw)) return [];
  if (Array.isArray(raw)) return raw.slice(0, MAX_PAIRS * 4);
  if (typeof raw === "string") return [];
  if (estDict(raw)) throw new ErreurCle(`slice(None, ${MAX_PAIRS * 4}, None)`);
  throw new ErreurPython("TypeError", `'${nomType(raw)}' object is not subscriptable`);
}

/** Liste client → paires propres ; `strict` lève `InvalidPair` sur un nom refusé ; doublons : la dernière valeur gagne, la première place reste. */
export function sanitizePairs(raw: unknown, kind: string, strict = false): Paire[] {
  const out: Paire[] = [];
  const vus = new Map<string, number>();
  for (const item of quatreVingtsPremiers(raw)) {
    if (!estDict(item)) continue;
    const name = prefixe(texteNet(lire(item, "name")), MAX_PAIR_NAME);
    if (!name) continue;
    if (!nomPaireOk(name, kind)) {
      if (strict) throw new InvalidPair(name);
      continue;
    }
    const value = stripPy(prefixe(texte(lire(item, "value")), MAX_PAIR_VALUE));
    const deja = vus.get(name);
    if (deja !== undefined) {
      const p = out[deja];
      if (p !== undefined) p.value = value;
      continue;
    }
    vus.set(name, out.length);
    out.push({ name, value });
    if (out.length >= MAX_PAIRS) break;
  }
  return out;
}

/** Fusion « vide = inchangé » par nom : une valeur vide reprend celle déjà stockée sous le même nom. */
export function mergePairs(oldPairs: unknown, newPairs: unknown, kind: string, strict = false): Paire[] {
  const stockees = new Map<string, unknown>();
  for (const p of Array.isArray(oldPairs) ? oldPairs : [])
    if (estDict(p) && veritePy(lire(p, "name"))) stockees.set(strPy(p["name"]), p["value"]);
  const out = sanitizePairs(newPairs, kind, strict);
  for (const p of out) if (!p.value) p.value = strPy(stockees.get(p.name) ?? "");
  return out;
}

/** Vue navigateur : le nom, jamais la valeur (`value` vide, `has_value`). */
export function pairsPublic(pairs: unknown): Dict[] {
  if (!Array.isArray(pairs)) return [];
  return pairs
    .filter((p) => estDict(p) && veritePy(lire(p, "name")))
    .map((p) => ({ name: (p as Dict)["name"], value: "", has_value: veritePy(lire(p, "value")) }));
}

/** `(blob, schéma)` ; liste vide → `("", "plain")` ; propage `EncryptionUnavailable`. */
function encoderPaires(pairs: unknown): [string, string] {
  const propres = (Array.isArray(pairs) ? pairs : []).filter((p) => estDict(p) && veritePy(lire(p, "name")));
  if (propres.length === 0) return ["", "plain"];
  return [encrypt(pyJsonDumps(propres, { ensureAscii: false })), "fernet"];
}

/** Blob → paires ; tolérant : un blob illisible (clé remplacée) rend une liste vide. */
function decoderPaires(enc: unknown, scheme: unknown): Paire[] {
  if (!veritePy(enc)) return [];
  let data: unknown;
  try {
    data = parseJsonPy(scheme === "fernet" ? decrypt(strPy(enc)) : strPy(enc));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter((p) => estDict(p) && veritePy(lire(p, "name")))
    .map((p) => ({ name: texte(lire(p, "name")), value: texte(lire(p, "value")) }));
}

/** Les deux créneaux chiffrés, ou rien si le chiffrement est indisponible (jamais de jeton lisible). */
function encoderPairesOuRien(h: Paire[], e: Paire[]): [string, string, string, string] {
  try {
    return [...encoderPaires(h), ...encoderPaires(e)];
  } catch {
    return ["", "plain", "", "plain"];
  }
}

const signales = new Set<string>();

/** Tests : oublie les noms de paires déjà signalés (`_SIGNALES.clear()`). */
export function oublierAvertissementsPaires(): void {
  signales.clear();
}

/** Paires → dict pour le transport : valeur vide = créneau en attente ; nom refusé par la validation ignoré, signalé une fois par processus. */
function pairesEnDict(pairs: unknown, kind: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (!(estDict(p) && veritePy(lire(p, "name")) && veritePy(lire(p, "value")))) continue;
    const nom = strPy(p["name"]);
    if (!nomPaireOk(nom, kind)) {
      if (!signales.has(`${kind}\u0000${nom}`)) {
        signales.add(`${kind}\u0000${nom}`);
        journalDe("mcp").warn(
          `${kind} : nom enregistré refusé par la validation, paire ignorée : ${repr(nom)}`,
        );
      }
      continue;
    }
    poser(out, nom, p["value"]);
  }
  return out;
}

export const ID_PREFIX = "shared:";

export function publicId(rowId: unknown): string {
  return `${ID_PREFIX}${intPy(rowId)}`;
}

/** `"shared:3"` → 3 ; toute autre forme → `null`. */
export function sharedId(publicValue: unknown): number | null {
  const s = texte(publicValue);
  if (!s.startsWith(ID_PREFIX)) return null;
  try {
    return intPy(s.slice(ID_PREFIX.length));
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "ValueError") return null;
    throw e;
  }
}

function encoderSecret(secret: string): [string, string] {
  return secret ? [encrypt(secret), "fernet"] : ["", "plain"];
}

/** Secret nettoyé avant stockage ; en mode `bearer`, le jeton nu (« Bearer eyJ… » collé tel quel est retaillé). */
export function normalizeSecret(mode: unknown, secret: unknown): string {
  let s = stripPy(texte(secret));
  if (mode === "bearer" && s.slice(0, 7).toLowerCase() === "bearer ") s = stripPy(s.slice(7));
  return s;
}

function decoderSecret(enc: unknown, scheme: unknown): string {
  if (!veritePy(enc)) return "";
  return scheme === "fernet" ? decrypt(strPy(enc)) : strPy(enc);
}

const COLONNES_COMPTE = ["id", "name", "type", "enabled"] as const;
const COLONNES_ADMIN = [
  ...COLONNES_COMPTE,
  "url",
  "command",
  "auth_mode",
  "auth_user",
  "created_at",
  "updated_at",
] as const;

/** Lecture tolérante d'une colonne (base pas encore migrée). */
function colonne(r: Ligne, cle: string, defaut: unknown = ""): unknown {
  const v = Object.hasOwn(r, cle) ? r[cle] : undefined;
  return v === null || v === undefined ? defaut : v;
}

/** Vue sans secret ; un compte ordinaire n'a que de quoi reconnaître et afficher le serveur. */
function vuePublique(r: Ligne, admin = false): Dict {
  const d: Dict = {};
  for (const k of admin ? COLONNES_ADMIN : COLONNES_COMPTE) poser(d, k, r[k]);
  d["id"] = publicId(d["id"]);
  d["enabled"] = veritePy(d["enabled"]);
  d["has_auth"] = veritePy(r["auth_enc"]);
  d["shared"] = true;
  if (admin) {
    const scheme = colonne(r, "extra_scheme", "plain");
    d["headers"] = pairsPublic(decoderPaires(colonne(r, "headers_enc", ""), scheme));
    d["env"] = pairsPublic(decoderPaires(colonne(r, "env_enc", ""), scheme));
  }
  return d;
}

// ── Bibliothèque partagée : lectures ─────────────────────────────────────────

/** Bibliothèque publiée, vue sans secret ; un compte ordinaire ne voit que les entrées actives. */
export async function listShared(
  base: Base,
  options: { admin?: boolean; includeDisabled?: boolean | null } = {},
): Promise<Dict[]> {
  const admin = options.admin ?? false;
  const inclure = options.includeDisabled ?? admin;
  let sql = "SELECT * FROM mcp_shared_servers";
  if (!inclure) sql += " WHERE enabled=1";
  sql += " ORDER BY name ASC, id ASC";
  return (await base.all(sql)).map((r) => vuePublique(r, admin));
}

export async function getShared(
  base: Base,
  serverId: unknown,
  options: { admin?: boolean } = {},
): Promise<Dict | null> {
  const r = await base.get("SELECT * FROM mcp_shared_servers WHERE id=?", [intPy(serverId)]);
  return r ? vuePublique(r, options.admin ?? false) : null;
}

// ── Bibliothèque partagée : écritures (admin) ────────────────────────────────

export interface ChampsPartage {
  name?: string | null;
  type?: string | null;
  url?: string | null;
  command?: string | null;
  auth_mode?: string | null;
  auth_user?: string | null;
  auth_secret?: string | null;
  enabled?: boolean | null;
  headers?: unknown;
  env?: unknown;
}

export async function createShared(base: Base, f: ChampsPartage): Promise<number> {
  const type = f.type ?? "sse";
  const [enc, scheme] = encoderSecret(normalizeSecret(f.auth_mode || "", f.auth_secret ?? ""));
  const [hEnc, hScheme] = encoderPaires(estHttp(type) ? f.headers : []);
  const [eEnc, eScheme] = encoderPaires(type === "stdio" ? f.env : []);
  const extra = hScheme === "fernet" || eScheme === "fernet" ? "fernet" : "plain";
  const maintenant = Date.now() / 1000;
  return base.insertId(
    "INSERT INTO mcp_shared_servers(name, type, url, command, auth_mode, " +
      "auth_user, auth_enc, key_scheme, headers_enc, env_enc, extra_scheme, " +
      "enabled, created_at, updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [
      f.name ?? "",
      type,
      f.url || "",
      f.command || "",
      f.auth_mode || "",
      f.auth_user || "",
      enc,
      scheme,
      hEnc,
      eEnc,
      extra,
      (f.enabled ?? true) ? 1 : 0,
      maintenant,
      maintenant,
    ],
  );
}

/** Ligne brute, `auth_enc` compris : côté serveur seulement (bouton « Tester », fusion « vide = inchangé »). */
export async function rawShared(base: Base, serverId: unknown): Promise<Dict | null> {
  const r = await base.get("SELECT * FROM mcp_shared_servers WHERE id=?", [intPy(serverId)]);
  return r ? { ...r } : null;
}

/** Paires (en-têtes, variables) en clair d'une ligne partagée, côté serveur. */
export async function sharedPairs(base: Base, serverId: unknown): Promise<[Paire[], Paire[]]> {
  const r = await rawShared(base, serverId);
  if (r === null) return [[], []];
  const scheme = veritePy(r["extra_scheme"]) ? r["extra_scheme"] : "plain";
  return [decoderPaires(r["headers_enc"] ?? "", scheme), decoderPaires(r["env_enc"] ?? "", scheme)];
}

/** Mise à jour partielle : secret vide = conservé ; `auth_mode=""` efface le secret et prime sur un secret joint. */
export async function updateShared(base: Base, serverId: unknown, f: ChampsPartage): Promise<boolean> {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const k of ["name", "type", "url", "command", "auth_user"] as const) {
    const v = f[k];
    if (v !== null && v !== undefined) {
      sets.push(`${k}=?`);
      vals.push(v);
    }
  }
  if (f.enabled !== null && f.enabled !== undefined) {
    sets.push("enabled=?");
    vals.push(f.enabled ? 1 : 0);
  }
  const mode = f.auth_mode;
  const secret = f.auth_secret;
  if (mode !== null && mode !== undefined) {
    sets.push("auth_mode=?");
    vals.push(mode);
  }
  if (mode !== null && mode !== undefined && !mode) {
    sets.push("auth_enc=?", "key_scheme=?");
    vals.push("", "plain");
  } else if (secret) {
    let modeEffectif = mode;
    if (modeEffectif === null || modeEffectif === undefined) {
      const r = await base.get("SELECT auth_mode FROM mcp_shared_servers WHERE id=?", [intPy(serverId)]);
      modeEffectif = texte(r ? r["auth_mode"] : "");
    }
    const [enc, scheme] = encoderSecret(normalizeSecret(modeEffectif, secret));
    sets.push("auth_enc=?", "key_scheme=?");
    vals.push(enc, scheme);
  }
  const hFourni = f.headers !== null && f.headers !== undefined;
  const eFourni = f.env !== null && f.env !== undefined;
  if (hFourni || eFourni) {
    const [ancH, ancE] = await sharedPairs(base, serverId);
    let typeEffectif: unknown = f.type;
    if (typeEffectif === null || typeEffectif === undefined) {
      const r = (await rawShared(base, serverId)) ?? {};
      typeEffectif = veritePy(r["type"]) ? r["type"] : "sse";
    }
    let nvH = hFourni ? mergePairs(ancH, f.headers, "headers") : ancH;
    let nvE = eFourni ? mergePairs(ancE, f.env, "env") : ancE;
    if (!estHttp(typeEffectif)) nvH = [];
    if (typeEffectif !== "stdio") nvE = [];
    const [hEnc, hScheme] = encoderPaires(nvH);
    const [eEnc, eScheme] = encoderPaires(nvE);
    sets.push("headers_enc=?", "env_enc=?", "extra_scheme=?");
    vals.push(hEnc, eEnc, hScheme === "fernet" || eScheme === "fernet" ? "fernet" : "plain");
  }
  if (sets.length === 0) return false;
  sets.push("updated_at=?");
  vals.push(Date.now() / 1000, intPy(serverId));
  const res = await base.run(`UPDATE mcp_shared_servers SET ${sets.join(", ")} WHERE id=?`, vals);
  return res.changes > 0;
}

export async function deleteShared(base: Base, serverId: unknown): Promise<boolean> {
  const res = await base.run("DELETE FROM mcp_shared_servers WHERE id=?", [intPy(serverId)]);
  return res.changes > 0;
}

// ── Résolution côté serveur (secret inclus : jamais sérialisée vers HTTP) ────

/** Pose le créneau d'auth principal ; le mode prime sur un en-tête homonyme de la liste. */
function appliquerModeAuth(cfg: Dict, mode: unknown, user: unknown, secret: string): void {
  const m = texte(mode);
  const u = texte(user);
  if (!secret) return;
  if (m === "basic" && u) cfg["basic_auth"] = { username: u, token: secret };
  else if (m === "bearer") cfg["authorization"] = `Bearer ${secret}`;
  else if (m === "raw") cfg["authorization"] = secret;
  else if (m === "header") {
    const nom = stripPy(u) || DEFAULT_HEADER_NAME;
    if (headerNameOk(nom)) {
      const h: Dict = estDict(cfg["headers"]) ? { ...cfg["headers"] } : {};
      poser(h, nom, secret);
      cfg["headers"] = h;
    }
  }
}

/** Ligne → config MCP, auth déchiffrée (côté serveur), paires revérifiées. */
export function ligneEnConfig(r: Ligne): Dict {
  const cfg: Dict = marquerConfiance({
    id: publicId(r["id"]),
    name: r["name"],
    type: r["type"],
    url: r["url"],
    command: r["command"],
  });
  const scheme = colonne(r, "extra_scheme", "plain");
  if (!estHttp(r["type"])) {
    const env = pairesEnDict(decoderPaires(colonne(r, "env_enc", ""), scheme), "env");
    if (Object.keys(env).length > 0) cfg["env"] = env;
    return cfg;
  }
  const headers = pairesEnDict(decoderPaires(colonne(r, "headers_enc", ""), scheme), "headers");
  if (Object.keys(headers).length > 0) cfg["headers"] = headers;
  appliquerModeAuth(cfg, r["auth_mode"], r["auth_user"], decoderSecret(r["auth_enc"], r["key_scheme"]));
  return cfg;
}

/** Config prête pour le client MCP, en-tête d'auth compris ; `null` si l'entrée est inconnue ou désactivée. */
export async function resolveConfig(base: Base, serverId: unknown): Promise<Dict | null> {
  const r = await base.get("SELECT * FROM mcp_shared_servers WHERE id=? AND enabled=1", [intPy(serverId)]);
  return r ? ligneEnConfig(r) : null;
}

/** `resolveConfig` sur des ids publics, ordre préservé, inconnus et désactivés jetés, une seule requête. */
export async function resolveMany(base: Base, publicIds: unknown): Promise<Dict[]> {
  const rids: number[] = [];
  for (const pid of Array.isArray(publicIds) ? publicIds : []) {
    const rid = sharedId(pid);
    if (rid !== null && !rids.includes(rid)) rids.push(rid);
  }
  if (rids.length === 0) return [];
  const marques = rids.map(() => "?").join(",");
  const lignes = await base.all(
    `SELECT * FROM mcp_shared_servers WHERE enabled=1 AND id IN (${marques})`,
    rids,
  );
  const parId = new Map(lignes.map((r) => [intPy(r["id"]), r]));
  return rids.flatMap((rid) => {
    const r = parId.get(rid);
    return r ? [ligneEnConfig(r)] : [];
  });
}

// ── Serveurs perso (settings.mcp_servers) ────────────────────────────────────

const CLES_CLIENT_PERSO = [
  "id",
  "name",
  "type",
  "url",
  "command",
  "visible",
  "auth_mode",
  "auth_user",
] as const;
const CLES_SECRETES_PERSO = new Set([
  "auth_enc",
  "key_scheme",
  "auth_secret",
  "authorization",
  "basic_auth",
  "headers_enc",
  "env_enc",
  "extra_scheme",
]);
const CLES_HORS_CONFIG = new Set([
  "auth_enc",
  "key_scheme",
  "auth_secret",
  "has_auth",
  "visible",
  "headers",
  "headers_enc",
  "env",
  "env_enc",
  "extra_scheme",
]);

/** Paires (en-têtes, variables) en clair d'une entrée perso ; reprend au vol les formes héritées `headers`/`env: {…}` en clair, revalidées. */
export function personalPairs(srv: unknown): [Paire[], Paire[]] {
  if (!estDict(srv)) return [[], []];
  const scheme = veritePy(srv["extra_scheme"]) ? srv["extra_scheme"] : "plain";
  let headers = decoderPaires(veritePy(srv["headers_enc"]) ? srv["headers_enc"] : "", scheme);
  if (headers.length === 0) {
    const herite = srv["headers"];
    if (estDict(herite))
      headers = sanitizePairs(
        Object.entries(herite).map(([k, v]) => ({ name: k, value: v })),
        "headers",
      );
  }
  let env = decoderPaires(veritePy(srv["env_enc"]) ? srv["env_enc"] : "", scheme);
  if (env.length === 0 && estDict(srv["env"]))
    env = sanitizePairs(
      Object.entries(srv["env"]).map(([k, v]) => ({ name: k, value: v })),
      "env",
    );
  return [headers, env];
}

/** Vue navigateur d'un serveur perso : sans secret, avec `has_auth`. */
export function personalPublic(srv: unknown): Dict {
  if (!estDict(srv)) return {};
  const out: Dict = {};
  for (const [k, v] of Object.entries(srv))
    if (!CLES_SECRETES_PERSO.has(k) && k !== "headers") poser(out, k, v);
  out["has_auth"] =
    veritePy(srv["auth_enc"]) || veritePy(srv["authorization"]) || veritePy(srv["basic_auth"]);
  const [headers, env] = personalPairs(srv);
  poser(out, "headers", pairsPublic(headers));
  poser(out, "env", pairsPublic(env));
  return out;
}

const verdicts = new Map<string, [number, string | null]>();

/** Motif de refus de l'URL d'un serveur perso d'un non-admin (garde SSRF stricte), mémorisé 60 s ; garde absente = refus. */
export async function personalUrlBlockReason(url: unknown): Promise<string | null> {
  const u = texte(url);
  const maintenant = performance.now() / 1000;
  const vu = verdicts.get(u);
  if (vu !== undefined && maintenant - vu[0] < 60) return vu[1];
  const garde = gardeUrlBranchee();
  if (garde === null) return "garde SSRF non branchée";
  const why = await garde(u, ["http", "https"]);
  if (verdicts.size > 512) verdicts.clear();
  verdicts.set(u, [maintenant, why]);
  return why;
}

/** Tests : oublie les verdicts mémorisés de la garde d'URL. */
export function oublierVerdictsUrl(): void {
  verdicts.clear();
}

/** Entrée perso → config MCP ; `stdio` (et URL interne) refusés à un propriétaire non admin : `{}` ; celle d'un admin est de confiance. */
export async function personalToConfig(srv: unknown, options: { allowStdio?: boolean } = {}): Promise<Dict> {
  const allowStdio = options.allowStdio ?? false;
  if (!estDict(srv)) return {};
  if (texte(srv["type"]).toLowerCase() === "stdio" && !allowStdio) return {};
  if (estHttp(srv["type"]) && !allowStdio && veritePy(await personalUrlBlockReason(srv["url"]))) return {};
  const cfg: Dict = allowStdio ? marquerConfiance({}) : {};
  for (const [k, v] of Object.entries(srv)) if (!CLES_HORS_CONFIG.has(k)) poser(cfg, k, v);
  const stype = srv["type"];
  const [headers, env] = personalPairs(srv);
  if (stype === "stdio") {
    const envMap = pairesEnDict(env, "env");
    if (Object.keys(envMap).length > 0) poser(cfg, "env", envMap);
  } else if (estHttp(stype)) {
    const enTetes = pairesEnDict(headers, "headers");
    if (Object.keys(enTetes).length > 0) poser(cfg, "headers", enTetes);
  }
  const enc = veritePy(srv["auth_enc"]) ? srv["auth_enc"] : "";
  if (!enc) return cfg;
  delete cfg["authorization"];
  delete cfg["basic_auth"];
  if (!estHttp(stype)) return cfg;
  appliquerModeAuth(
    cfg,
    srv["auth_mode"],
    srv["auth_user"],
    decoderSecret(enc, veritePy(srv["key_scheme"]) ? srv["key_scheme"] : "plain"),
  );
  return cfg;
}

function secretHerite(srv: Dict): string {
  const b = srv["basic_auth"];
  if (estDict(b)) return texte(veritePy(b["password"]) ? b["password"] : b["token"]);
  return texte(srv["authorization"]);
}

/** Fusionne la liste perso reçue avec celle en base : le secret n'est jamais pris des octets du client (« vide = inchangé »). */
export async function mergePersonalMcp(
  oldList: unknown,
  newList: unknown,
  options: { allowStdio?: boolean } = {},
): Promise<Dict[]> {
  const allowStdio = options.allowStdio ?? false;
  const anciens = new Map<string, Dict>();
  for (const s of Array.isArray(oldList) ? oldList : [])
    if (estDict(s) && veritePy(s["id"])) anciens.set(strPy(s["id"]), s);
  const out: Dict[] = [];
  for (const srv of Array.isArray(newList) ? newList : []) {
    if (!estDict(srv)) continue;
    const entry: Dict = {};
    for (const k of CLES_CLIENT_PERSO) if (Object.hasOwn(srv, k)) poser(entry, k, srv[k]);
    const stype = stripPy(texte(veritePy(entry["type"]) ? entry["type"] : "sse")).toLowerCase();
    poser(entry, "type", (SERVER_TYPES as readonly string[]).includes(stype) ? stype : "sse");
    const idClient = strPy(srv["id"] ?? null);
    if (entry["type"] === "stdio" && !allowStdio) {
      const prec = anciens.get(idClient);
      if (
        prec === undefined ||
        stripPy(texte(prec["type"])).toLowerCase() !== "stdio" ||
        texte(prec["command"]) !== texte(entry["command"])
      )
        throw new StdioNotAllowed(
          "Serveur MCP « Local » (commande exécutée sur le serveur) réservé aux administrateurs.",
        );
    }
    if (estHttp(entry["type"]) && !allowStdio) {
      const prec = anciens.get(idClient);
      const url = prefixe(texte(entry["url"]), 2000);
      if (prec === undefined || texte(prec["url"]) !== url) {
        const why = await personalUrlBlockReason(url);
        if (why)
          throw new UrlNotAllowed(
            `Adresse de serveur MCP refusée (${why}) : les adresses ` +
              "internes (machine locale, réseau privé) sont réservées " +
              "aux serveurs publiés par un administrateur.",
          );
      }
    }
    const mode = stripPy(texte(entry["auth_mode"])).toLowerCase();
    poser(entry, "auth_mode", (AUTH_MODES as readonly string[]).includes(mode) ? mode : "");
    poser(entry, "name", prefixe(texte(entry["name"]), 120));
    for (const k of ["url", "command"])
      if (Object.hasOwn(entry, k)) poser(entry, k, prefixe(texte(entry[k]), 2000));
    poser(entry, "auth_user", prefixe(texte(entry["auth_user"]), 200));

    const ancien = anciens.get(idClient);
    const [ancH, ancE] = personalPairs(ancien ?? {});
    let nvH = Object.hasOwn(srv, "headers") ? mergePairs(ancH, srv["headers"], "headers") : ancH;
    let nvE = Object.hasOwn(srv, "env") ? mergePairs(ancE, srv["env"], "env") : ancE;
    if (!estHttp(entry["type"])) nvH = [];
    if (entry["type"] !== "stdio") nvE = [];
    const [hEnc, hScheme, eEnc, eScheme] = encoderPairesOuRien(nvH, nvE);
    poser(entry, "headers_enc", hEnc);
    poser(entry, "env_enc", eEnc);
    poser(entry, "extra_scheme", hScheme === "fernet" || eScheme === "fernet" ? "fernet" : "plain");

    if (entry["auth_mode"] === "header") {
      const nom = stripPy(entry["auth_user"] as string) || DEFAULT_HEADER_NAME;
      if (headerNameOk(nom)) poser(entry, "auth_user", nom);
      else poser(entry, "auth_mode", "");
    }

    const secret = texte(srv["auth_secret"]);
    if (!entry["auth_mode"]) {
      poser(entry, "auth_enc", "");
      poser(entry, "key_scheme", "plain");
      poser(entry, "auth_user", "");
    } else if (secret) {
      const [enc, scheme] = encoderSecret(normalizeSecret(entry["auth_mode"], secret));
      poser(entry, "auth_enc", enc);
      poser(entry, "key_scheme", scheme);
    } else if (ancien !== undefined && veritePy(ancien["auth_enc"])) {
      poser(entry, "auth_enc", ancien["auth_enc"]);
      poser(entry, "key_scheme", veritePy(ancien["key_scheme"]) ? ancien["key_scheme"] : "plain");
    } else if (
      ancien !== undefined &&
      (veritePy(ancien["authorization"]) || veritePy(ancien["basic_auth"]))
    ) {
      const herite = secretHerite(ancien);
      if (herite) {
        const [enc, scheme] = encoderSecret(herite);
        poser(entry, "auth_enc", enc);
        poser(entry, "key_scheme", scheme);
        if (veritePy(ancien["basic_auth"])) {
          const b = ancien["basic_auth"];
          if (!estDict(b)) throw new ErreurPython("AttributeError", "object has no attribute 'get'");
          poser(entry, "auth_user", prefixe(texte(b["username"]), 200));
        }
      } else {
        poser(entry, "auth_enc", "");
        poser(entry, "key_scheme", "plain");
      }
    } else {
      poser(entry, "auth_enc", "");
      poser(entry, "key_scheme", "plain");
    }
    out.push(entry);
  }
  return out;
}

/** Entrée « outils locaux » reçue d'un client → sentinelle reconstruite (nom et catégories seulement). */
export function clientBuiltinRef(raw: unknown): Dict | null {
  if (!estDict(raw) || raw["command"] !== BUILTIN_SENTINEL) return null;
  const cfg: Dict = {
    type: "stdio",
    name: prefixe(texte(veritePy(raw["name"]) ? raw["name"] : "Outils Locaux"), 120),
    command: BUILTIN_SENTINEL,
  };
  const cats = raw["filter_categories"];
  if (Array.isArray(cats)) cfg["filter_categories"] = cats.filter((c) => typeof c === "string").slice(0, 64);
  return cfg;
}

function serveursPerso(userSettings: unknown): unknown[] {
  const brut = lire(userSettings, "mcp_servers");
  return Array.isArray(brut) ? brut : [];
}

/** Config perso par id, déchiffrée ; `null` si l'id est inconnu ou refusé. */
export async function resolvePersonal(
  userSettings: unknown,
  serverId: unknown,
  options: { allowStdio?: boolean } = {},
): Promise<Dict | null> {
  for (const srv of serveursPerso(userSettings)) {
    if (estDict(srv) && strPy(srv["id"] ?? null) === strPy(serverId ?? null)) {
      const cfg = await personalToConfig(srv, options);
      return Object.keys(cfg).length > 0 ? cfg : null;
    }
  }
  return null;
}

/** Serveurs qu'un agent custom peut référencer : perso (même masqués) + partagés que le compte affiche, résolus avec leur auth. */
export async function resolveForAgents(
  base: Base,
  userSettings: unknown,
  options: { allowStdio?: boolean } = {},
): Promise<Dict[]> {
  const propres: Dict[] = [];
  for (const s of serveursPerso(userSettings)) {
    if (!estDict(s)) continue;
    const cfg = await personalToConfig(s, options);
    if (Object.keys(cfg).length > 0) propres.push(cfg);
  }
  const visibles = lire(userSettings, "shared_mcp_visible");
  return [...propres, ...(await resolveMany(base, veritePy(visibles) ? visibles : []))];
}
