// SPDX-License-Identifier: MIT
/** packages/auth/src/oauth.ts — autorisation OAuth 2.1 des clients MCP (mcp/oauth.py) : politique, ressource, clients, codes, jetons, autorisations. */
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";

import {
  adresseIpOuNul,
  encoderUtf8Py,
  entierOuNulPy,
  ErreurLecturePy,
  ErreurPython,
  estDict,
  estGlobaleIp,
  getOu,
  hostname,
  ipv4Mappee,
  iterExige,
  longueurPy,
  lowerPy,
  nomTypePy,
  port,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  pyJsonLoadsOctets,
  rstripPy,
  splitPy,
  strPy,
  stripPy,
  texteIp,
  urlsplit,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict, UrlDecoupee } from "@elpis/commun";
import type { Base, Executeur } from "@elpis/db";
import { blockRemoteUrlReason, egauxEnTempsConstant } from "@elpis/securite";
import type { Resolveur } from "@elpis/securite";

import { valeur } from "./dict";
import { politique } from "./jetons";

export const ACCESS_PREFIX = "eoa_";
export const REFRESH_PREFIX = "eor_";
export const RESOURCE_PATH = "/api/mcp-bridge";
export const SCOPE_ALL = "tools";
export const SCOPE_PREFIX = "tools:";
export const CODE_TTL_S = 120;
export const MAX_CLIENTS = 1000;
const TOUCHE_TOUTES_S = 300;
const DCR_PERIME_S = 3600;
const CIMD_RAFRAICHI_S = 86400;
const CIMD_OCTETS_MAX = 64 * 1024;
const NOM_MAX = 100;
const REDIRECTIONS_MAX = 10;
const HOTES_BOUCLE: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const COLONNES_CLIENT =
  "client_id, kind, name, secret_hash, auth_method, redirect_uris, metadata, created_at, fetched_at, last_used_at";
const INJOIGNABLE = "Document de client injoignable depuis ce serveur.";

/** Erreur OAuth normalisée (`error` RFC 6749 et description courte). */
export class ErreurOAuth extends Error {
  readonly error: string;
  readonly description: string;
  readonly status: number;

  constructor(error: string, description = "", status = 400) {
    super(description || error);
    this.name = "OAuthError";
    this.error = error;
    this.description = description;
    this.status = status;
  }

  body(): Record<string, string> {
    return this.description
      ? { error: this.error, error_description: this.description }
      : { error: this.error };
  }
}

export interface DependancesOAuth {
  readonly base: Base;
  config(): unknown;
  maintenant?(): number;
  /** `secrets.token_urlsafe(n)`. */
  jetonUrl?(octets: number): string;
  /** `secrets.token_hex(n)`. */
  jetonHex?(octets: number): string;
  resoudre?: Resolveur;
  /** GET https épinglé sur `ip` (nom d'origine pour SNI et Host) : corps borné, ou ErreurOAuth. */
  telecharger?(url: string, ip: string): Promise<Uint8Array>;
  avertir?(message: string, erreur: unknown): void;
}

export interface PolitiqueOAuth {
  enabled: boolean;
  dcr_enabled: boolean;
  access_ttl_s: number;
  refresh_days: number;
  families: string[];
}

export interface ClientOAuth {
  client_id: string;
  kind: string;
  name: string;
  has_secret: boolean;
  secret_hash: string;
  auth_method: string;
  redirect_uris: string[];
  metadata: Dict;
  created_at: number;
  fetched_at: unknown;
  last_used_at: unknown;
}

export interface ClientDuRelais {
  user_id: number;
  username: string;
  kind: "oauth";
  families: string[];
  client_id: string;
  grant_id: string;
  resource: string;
}

function maintenant(dep: DependancesOAuth): number {
  return dep.maintenant ? dep.maintenant() : Date.now() / 1000;
}

function jetonUrl(dep: DependancesOAuth, octets: number): string {
  return dep.jetonUrl ? dep.jetonUrl(octets) : randomBytes(octets).toString("base64url");
}

function jetonHex(dep: DependancesOAuth, octets: number): string {
  return dep.jetonHex ? dep.jetonHex(octets) : randomBytes(octets).toString("hex");
}

/** `_truthy` : `v is not False and str(v).strip().lower()` hors de false, 0, off, no et vide. */
function vrai(v: unknown): boolean {
  return v !== false && !["false", "0", "off", "no", ""].includes(lowerPy(stripPy(strPy(v))));
}

/** `_as_int(v, défaut, bas, haut)` : TypeError ou ValueError → défaut, puis borné. */
function entierBorne(v: unknown, defaut: number, bas: number, haut: number): number {
  const n = entierOuNulPy(v);
  return n === null ? defaut : Math.max(bas, Math.min(haut, n));
}

/** `policy()` : politique OAuth relue à chaud, bornée par celle des jetons d'outils. */
export function politiqueOauth(config: unknown): PolitiqueOAuth {
  const tp = politique(config);
  let refreshDays = entierBorne(valeur(config, "mcp.oauth.refresh_days", 30), 30, 1, 3650);
  if (tp.max_days) refreshDays = Math.min(refreshDays, tp.max_days);
  return {
    enabled: vrai(valeur(config, "mcp.oauth.enabled", true)) && tp.tools_enabled,
    dcr_enabled: vrai(valeur(config, "mcp.oauth.dcr_enabled", true)),
    access_ttl_s: entierBorne(valeur(config, "mcp.oauth.access_ttl_s", 3600), 3600, 300, 86400),
    refresh_days: refreshDays,
    families: [...tp.tools_families],
  };
}

export function scopesSupported(pol: PolitiqueOAuth): string[] {
  return [SCOPE_ALL, ...pol.families.map((f) => SCOPE_PREFIX + f)];
}

/** `families_from_scope` : portée absente ou `tools` = toutes les familles permises ; une portée inconnue est ignorée. */
export function famillesDePortee(scope: unknown, pol: PolitiqueOAuth): string[] {
  const items = splitPy(strPy(veritePy(scope) ? scope : "")).filter(Boolean);
  if (items.length === 0 || items.includes(SCOPE_ALL)) return [...pol.families];
  const voulues = new Set(
    items.filter((s) => s.startsWith(SCOPE_PREFIX)).map((s) => s.slice(SCOPE_PREFIX.length)),
  );
  return pol.families.filter((f) => voulues.has(f));
}

export function portee(familles: readonly string[]): string {
  return familles.map((f) => SCOPE_PREFIX + f).join(" ");
}

/** `digest` : SHA-256 hexadécimal du texte en UTF-8 strict. */
export function empreinte(texte: string): string {
  return createHash("sha256").update(encoderUtf8Py(texte)).digest("hex");
}

function famillesCsv(familles: Iterable<string>): string {
  return [...familles].filter(Boolean).join(",");
}

function famillesListe(csv: unknown): string[] {
  return strPy(veritePy(csv) ? csv : "")
    .split(",")
    .filter(Boolean);
}

function decouper(texte: string): UrlDecoupee | null {
  try {
    return urlsplit(texte);
  } catch {
    return null;
  }
}

/** `resource_base` : URL canonique de la ressource protégée d'une origine d'app. */
export function resourceBase(appUrl: string): string {
  const p = urlsplit(rstripPy(appUrl, "/"));
  return `${lowerPy(p.scheme)}://${lowerPy(p.netloc)}${RESOURCE_PATH}`;
}

/** `resource_family` : famille d'une ressource `…/api/mcp-bridge/<famille>`, sinon null. */
export function resourceFamily(resource: unknown): string | null {
  const p = decouper(strPy(veritePy(resource) ? resource : ""));
  if (p === null) return null;
  const chemin = rstripPy(p.path, "/");
  return chemin.startsWith(`${RESOURCE_PATH}/`) ? chemin.slice(RESOURCE_PATH.length + 1) || null : null;
}

/** `check_resource` : ressource de base ou enfant d'une famille permise → [canonique, famille] ; sinon invalid_target. */
export function checkResource(
  resource: unknown,
  appUrl: string,
  pol: PolitiqueOAuth,
): [string, string | null] {
  const base = resourceBase(appUrl);
  const r = stripPy(strPy(veritePy(resource) ? resource : ""));
  if (!r) throw new ErreurOAuth("invalid_target", "Paramètre resource requis.");
  const p = decouper(r);
  if (p === null || p.fragment) throw new ErreurOAuth("invalid_target", "Ressource mal formée.");
  const canon = `${lowerPy(p.scheme)}://${lowerPy(p.netloc)}${rstripPy(p.path, "/")}`;
  if (canon === base) return [base, null];
  if (canon.startsWith(`${base}/`)) {
    const fam = canon.slice(base.length + 1);
    if (pol.families.includes(fam)) return [canon, fam];
  }
  throw new ErreurOAuth("invalid_target", "Ressource inconnue de ce serveur.");
}

/** `(username, password)` de `urlsplit` : avant le dernier `@`, mot de passe après le premier `:`. */
function identifiants(netloc: string): [string | null, string | null] {
  const a = netloc.lastIndexOf("@");
  if (a < 0) return [null, null];
  const info = netloc.slice(0, a);
  const d = info.indexOf(":");
  return d < 0 ? [info, null] : [info.slice(0, d), info.slice(d + 1)];
}

function hote(p: UrlDecoupee): string {
  return lowerPy(hostname(p) ?? "");
}

/** `_redirect_ok` : boucle locale en http (tout port) ou https, sans fragment ni identifiants. */
export function redirectionPermise(uri: unknown): boolean {
  const p = decouper(strPy(veritePy(uri) ? uri : ""));
  if (p === null) return false;
  const [utilisateur, mot] = identifiants(p.netloc);
  if (p.fragment || !p.netloc || veritePy(utilisateur) || veritePy(mot)) return false;
  const h = hote(p);
  if (p.scheme === "https") return h !== "";
  if (p.scheme === "http") return HOTES_BOUCLE.has(h);
  return false;
}

export function estBoucleLocale(uri: string): boolean {
  const p = decouper(uri);
  return p !== null && p.scheme === "http" && HOTES_BOUCLE.has(hote(p));
}

/** `redirect_matches` : égalité exacte, sauf le port d'une redirection en boucle locale (RFC 8252 § 7.3). */
export function redirectionCorrespond(demandee: string, enregistrees: Iterable<string>): boolean {
  for (const r of enregistrees) {
    if (demandee === r) return true;
    if (estBoucleLocale(demandee) && estBoucleLocale(r)) {
      const a = urlsplit(demandee);
      const b = urlsplit(r);
      if (hote(a) === hote(b) && a.path === b.path && a.query === b.query) return true;
    }
  }
  return false;
}

/** `json.loads(texte or défaut)`, défaut sur ValueError. */
function jsonOu(brut: unknown, defaut: unknown): unknown {
  try {
    return pyJsonLoads(veritePy(brut) ? strPy(brut) : JSON.stringify(defaut));
  } catch (e) {
    if (e instanceof SyntaxError || (e instanceof ErreurLecturePy && e.nature === "ValueError"))
      return defaut;
    throw e;
  }
}

type LigneClient = Record<string, unknown>;

function client(r: LigneClient): ClientOAuth {
  const redirections = jsonOu(r["redirect_uris"], []);
  const meta = jsonOu(r["metadata"], {});
  return {
    client_id: strPy(r["client_id"]),
    kind: strPy(r["kind"]),
    name: strPy(veritePy(r["name"]) ? r["name"] : ""),
    has_secret: veritePy(r["secret_hash"]),
    secret_hash: strPy(veritePy(r["secret_hash"]) ? r["secret_hash"] : ""),
    auth_method: strPy(veritePy(r["auth_method"]) ? r["auth_method"] : "none"),
    redirect_uris: iterExige(redirections).filter((u): u is string => typeof u === "string"),
    metadata: estDict(meta) ? meta : {},
    created_at: Number(veritePy(r["created_at"]) ? r["created_at"] : 0),
    fetched_at: r["fetched_at"],
    last_used_at: r["last_used_at"],
  };
}

export async function getClient(x: Executeur, clientId: unknown): Promise<ClientOAuth | null> {
  const r = await x.get(`SELECT ${COLONNES_CLIENT} FROM oauth_clients WHERE client_id=?`, [
    strPy(veritePy(clientId) ? clientId : ""),
  ]);
  return r ? client(r) : null;
}

export interface MetadonneesClient {
  redirect_uris: string[];
  grant_types: unknown[];
  auth_method: string;
  client_name: string;
}

/** `_validate_metadata` : métadonnées RFC 7591 → champs retenus, ou ErreurOAuth. */
export function validerMetadonnees(meta: unknown): MetadonneesClient {
  if (!estDict(meta)) throw new ErreurOAuth("invalid_client_metadata", "Objet JSON attendu.");
  const brutes = getOu(meta, "redirect_uris", null);
  if (!Array.isArray(brutes) || brutes.length === 0 || brutes.length > REDIRECTIONS_MAX)
    throw new ErreurOAuth("invalid_redirect_uri", "redirect_uris : 1 à 10 adresses.");
  const redirections = brutes.map((u) => strPy(u));
  if (!redirections.every(redirectionPermise))
    throw new ErreurOAuth(
      "invalid_redirect_uri",
      "Redirections permises : http://127.0.0.1, http://localhost ou https://.",
    );
  const g = getOu(meta, "grant_types", null);
  const grants = veritePy(g) ? g : ["authorization_code", "refresh_token"];
  if (Array.isArray(grants))
    for (const x of grants)
      if (estDict(x) || Array.isArray(x))
        throw new ErreurPython("TypeError", `unhashable type: '${nomTypePy(x)}'`);
  if (
    !Array.isArray(grants) ||
    !grants.every((x) => x === "authorization_code" || x === "refresh_token") ||
    !grants.includes("authorization_code")
  )
    throw new ErreurOAuth("invalid_client_metadata", "grant_types : authorization_code (+ refresh_token).");
  const rt = getOu(meta, "response_types", null);
  const reponses = veritePy(rt) ? rt : ["code"];
  if (!Array.isArray(reponses) || reponses.length !== 1 || reponses[0] !== "code")
    throw new ErreurOAuth("invalid_client_metadata", "response_types : code seul.");
  const m = getOu(meta, "token_endpoint_auth_method", null);
  const methode = strPy(veritePy(m) ? m : "client_secret_basic");
  if (!["none", "client_secret_basic", "client_secret_post"].includes(methode))
    throw new ErreurOAuth("invalid_client_metadata", "token_endpoint_auth_method non pris en charge.");
  const n = getOu(meta, "client_name", null);
  const nom = prefixePy(stripPy(strPy(veritePy(n) ? n : "")), NOM_MAX);
  return { redirect_uris: redirections, grant_types: grants, auth_method: methode, client_name: nom };
}

/** `register_client` : réponse d'enregistrement, `client_secret` en clair une seule fois si la méthode l'exige. */
export async function registerClient(
  dep: DependancesOAuth,
  meta: unknown,
  kind = "dcr",
  plafond = MAX_CLIENTS,
): Promise<Dict> {
  const v = validerMetadonnees(meta);
  const t = maintenant(dep);
  const clientId = "elpis-" + jetonUrl(dep, 18);
  const secret = v.auth_method !== "none" ? "ecs_" + jetonUrl(dep, 32) : "";
  const uri = getOu(meta, "client_uri", null);
  const stocke = { grant_types: v.grant_types, client_uri: prefixePy(strPy(veritePy(uri) ? uri : ""), 300) };
  await dep.base.transaction(async (tx) => {
    if (kind === "dcr") {
      await tx.run("DELETE FROM oauth_clients WHERE kind='dcr' AND last_used_at IS NULL AND created_at<?", [
        t - DCR_PERIME_S,
      ]);
      const [[n] = [0]] = await tx.valeurs<[number]>("SELECT COUNT(*) FROM oauth_clients WHERE kind='dcr'");
      if (Number(n) >= plafond) {
        const ancien = await tx.get<{ client_id: string }>(
          "SELECT client_id FROM oauth_clients WHERE kind='dcr' AND last_used_at IS NULL ORDER BY created_at LIMIT 1",
        );
        if (!ancien)
          throw new ErreurOAuth(
            "invalid_client_metadata",
            "Trop de clients enregistrés ; demandez à l'administrateur.",
          );
        await tx.run("DELETE FROM oauth_clients WHERE client_id=?", [ancien.client_id]);
      }
    }
    await tx.run(
      "INSERT INTO oauth_clients(client_id, kind, name, secret_hash, auth_method, redirect_uris, metadata, created_at) " +
        "VALUES(?,?,?,?,?,?,?,?)",
      [
        clientId,
        kind,
        v.client_name || "Client MCP",
        secret ? empreinte(secret) : "",
        v.auth_method,
        pyJsonDumps(v.redirect_uris),
        pyJsonDumps(stocke),
        t,
      ],
    );
  });
  const out: Dict = {
    client_id: clientId,
    client_id_issued_at: Math.trunc(t),
    client_name: v.client_name || "Client MCP",
    redirect_uris: v.redirect_uris,
    grant_types: v.grant_types,
    response_types: ["code"],
    token_endpoint_auth_method: v.auth_method,
  };
  if (secret) Object.assign(out, { client_secret: secret, client_secret_expires_at: 0 });
  return out;
}

/** `delete_client` : client supprimé avec tout ce qu'il a obtenu (console). */
export async function deleteClient(base: Base, clientId: string): Promise<boolean> {
  return base.transaction(async (tx) => {
    await tx.run("DELETE FROM oauth_tokens WHERE client_id=?", [clientId]);
    await tx.run("DELETE FROM oauth_codes WHERE client_id=?", [clientId]);
    return (await tx.run("DELETE FROM oauth_clients WHERE client_id=?", [clientId])).changes > 0;
  });
}

/** Valeur REAL relue telle que Python la rend : flottant, ou None. */
function flottantOuNul(v: unknown): unknown {
  return v === null || v === undefined ? null : versFlottantPy(Number(v));
}

/** `list_clients` : clients connus sans empreinte de secret, avec le nombre d'autorisations actives. */
export async function listClients(x: Executeur, t: number): Promise<Dict[]> {
  const lignes = await x.all(`SELECT ${COLONNES_CLIENT} FROM oauth_clients ORDER BY created_at DESC`);
  const actives = new Map(
    (
      await x.valeurs<[string, number]>(
        "SELECT client_id, COUNT(DISTINCT grant_id) FROM oauth_tokens WHERE kind='refresh' " +
          "AND revoked_at IS NULL AND expires_at>? GROUP BY client_id",
        [t],
      )
    ).map(([c, n]) => [c, Number(n)]),
  );
  return lignes.map((r) => {
    const { secret_hash: _secret, ...d } = client(r);
    return {
      ...d,
      created_at: versFlottantPy(d.created_at),
      fetched_at: flottantOuNul(d.fetched_at),
      last_used_at: flottantOuNul(d.last_used_at),
      grants: actives.get(d.client_id) ?? 0,
    };
  });
}

/** `is_cimd_client_id` : URL https à chemin non vide (document de métadonnées de client). */
export function estClientCimd(clientId: unknown): boolean {
  const p = decouper(strPy(veritePy(clientId) ? clientId : ""));
  return p !== null && p.scheme === "https" && p.netloc !== "" && p.path !== "" && p.path !== "/";
}

/** `_resolve_public` : première adresse globale de l'hôte (IPv4 encapsulée comprise), résolue une seule fois. */
async function adressePublique(dep: DependancesOAuth, h: string, p: number): Promise<string> {
  let adresses: string[];
  try {
    adresses = dep.resoudre
      ? await dep.resoudre(h, p)
      : (await lookup(h, { all: true, order: "verbatim" })).map((r) => r.address);
  } catch {
    throw new ErreurOAuth("invalid_client", INJOIGNABLE);
  }
  for (const brute of adresses) {
    const ip = adresseIpOuNul(brute.split("%", 1)[0] ?? "");
    if (ip === null) continue;
    const cible = ipv4Mappee(ip) ?? ip;
    if (estGlobaleIp(cible)) return texteIp(cible);
  }
  throw new ErreurOAuth("invalid_client", INJOIGNABLE);
}

/** `_fetch_pinned` : GET https vers l'adresse validée, SNI et certificat sur le nom d'origine, sans redirection ni mandataire ; chemin encodé comme httpx. */
export function telechargerEpingle(url: string, ip: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const echec = (description: string): void => reject(new ErreurOAuth("invalid_client", description));
    let req: ReturnType<typeof request>;
    try {
      const p = urlsplit(url);
      const w = new URL(url);
      req = request(
        {
          host: ip,
          port: port(p) || 443,
          path: (w.pathname || "/") + w.search,
          method: "GET",
          servername: hostname(p) ?? "",
          headers: { accept: "application/json", host: p.netloc.slice(p.netloc.lastIndexOf("@") + 1) },
          timeout: 5000,
          agent: false,
        },
        (rep) => {
          if (rep.statusCode !== 200) {
            rep.destroy();
            echec("Document de client introuvable.");
            return;
          }
          const morceaux: Buffer[] = [];
          let total = 0;
          rep.on("data", (m: Buffer) => {
            total += m.length;
            if (total > CIMD_OCTETS_MAX) {
              rep.destroy();
              echec("Document de client trop volumineux.");
              return;
            }
            morceaux.push(m);
          });
          rep.on("end", () => resolve(Buffer.concat(morceaux)));
          rep.on("error", () => echec(INJOIGNABLE));
        },
      );
    } catch {
      echec(INJOIGNABLE);
      return;
    }
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", () => echec(INJOIGNABLE));
    req.end();
  });
}

/** `fetch_cimd` : document de client récupéré sous la garde SSRF, borné, mis en cache 24 h dans oauth_clients. */
export async function fetchCimd(dep: DependancesOAuth, clientId: string): Promise<ClientOAuth> {
  const existant = await getClient(dep.base, clientId);
  if (
    existant &&
    existant.kind === "cimd" &&
    veritePy(existant.fetched_at) &&
    maintenant(dep) - Number(existant.fetched_at) < CIMD_RAFRAICHI_S
  )
    return existant;
  const motif = await blockRemoteUrlReason(clientId, {
    allowSchemes: ["https"],
    ...(dep.resoudre ? { resoudre: dep.resoudre } : {}),
  });
  if (motif) throw new ErreurOAuth("invalid_client", INJOIGNABLE);
  const p = urlsplit(clientId);
  const ip = await adressePublique(dep, hostname(p) ?? "", port(p) || 443);
  const brut = await (dep.telecharger ?? telechargerEpingle)(clientId, ip);
  let doc: unknown;
  try {
    doc = pyJsonLoadsOctets(brut);
  } catch (e) {
    if (e instanceof SyntaxError || (e instanceof ErreurLecturePy && e.nature !== "RecursionError"))
      throw new ErreurOAuth("invalid_client", "Document de client illisible.");
    throw e;
  }
  const declare = estDict(doc) ? getOu(doc, "client_id", null) : null;
  if (!estDict(doc) || strPy(veritePy(declare) ? declare : "") !== clientId)
    throw new ErreurOAuth("invalid_client", "Document de client incohérent.");
  const methode = getOu(doc, "token_endpoint_auth_method", null);
  const v = validerMetadonnees({ ...doc, token_endpoint_auth_method: veritePy(methode) ? methode : "none" });
  if (v.auth_method !== "none")
    throw new ErreurOAuth("invalid_client", "Un client CIMD est public (méthode none).");
  const t = maintenant(dep);
  await dep.base.transaction(async (tx) => {
    if (existant)
      await tx.run("UPDATE oauth_clients SET name=?, redirect_uris=?, fetched_at=? WHERE client_id=?", [
        v.client_name || clientId,
        pyJsonDumps(v.redirect_uris),
        t,
        clientId,
      ]);
    else
      await tx.run(
        "INSERT INTO oauth_clients(client_id, kind, name, secret_hash, auth_method, redirect_uris, metadata, " +
          "created_at, fetched_at) VALUES(?,?,?,?,?,?,?,?,?)",
        [clientId, "cimd", v.client_name || clientId, "", "none", pyJsonDumps(v.redirect_uris), "{}", t, t],
      );
  });
  return (await getClient(dep.base, clientId)) as ClientOAuth;
}

/** `resolve_client` : client d'une demande d'autorisation (enregistré, ou document CIMD récupéré). */
export async function resolveClient(dep: DependancesOAuth, clientId: unknown): Promise<ClientOAuth> {
  const cid = stripPy(strPy(veritePy(clientId) ? clientId : ""));
  if (!cid || longueurPy(cid) > 255) throw new ErreurOAuth("invalid_client", "Client inconnu.");
  const c = await getClient(dep.base, cid);
  if (c && c.kind !== "cimd") return c;
  if (estClientCimd(cid)) return fetchCimd(dep, cid);
  throw new ErreurOAuth("invalid_client", "Client inconnu.");
}

/** `secrets.compare_digest` de deux textes ASCII. */
function egauxTextes(a: string, b: string): boolean {
  return egauxEnTempsConstant(Buffer.from(a, "latin1"), Buffer.from(b, "latin1"));
}

/** `authenticate_client` : secret vérifié s'il en a un ; un client public n'en présente pas. */
export async function authenticateClient(
  x: Executeur,
  clientId: unknown,
  secret: unknown,
): Promise<ClientOAuth> {
  const c = await getClient(x, clientId);
  if (!c) throw new ErreurOAuth("invalid_client", "Client inconnu.", 401);
  if (c.has_secret && (!veritePy(secret) || !egauxTextes(empreinte(strPy(secret)), c.secret_hash)))
    throw new ErreurOAuth("invalid_client", "Authentification du client refusée.", 401);
  return c;
}

/** `pkce_ok` : vérificateur de 43 à 128 caractères, SHA-256 de ses octets ASCII, base64url sans remplissage. */
export function pkceOk(verifier: unknown, challenge: unknown): boolean {
  const v = strPy(veritePy(verifier) ? verifier : "");
  const n = longueurPy(v);
  if (n < 43 || n > 128) return false;
  const ascii = Buffer.from(
    Array.from(v)
      .filter((c) => c.charCodeAt(0) < 0x80)
      .join(""),
    "latin1",
  );
  const calcule = createHash("sha256").update(ascii).digest("base64url");
  if (!veritePy(challenge)) return false;
  const attendu = strPy(challenge);
  if (Array.from(attendu).some((c) => c.charCodeAt(0) > 0x7f))
    throw new ErreurPython("TypeError", "comparing strings with non-ASCII characters is not supported");
  return egauxTextes(calcule, attendu);
}

export interface DemandeCode {
  client_id: string;
  user_id: number;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  families: readonly string[];
}

/** `issue_code` : code d'autorisation à usage unique, 2 minutes ; les codes expirés depuis une heure sont oubliés. */
export async function issueCode(dep: DependancesOAuth, d: DemandeCode): Promise<string> {
  const code = "eoc_" + jetonUrl(dep, 32);
  const t = maintenant(dep);
  await dep.base.transaction(async (tx) => {
    await tx.run("DELETE FROM oauth_codes WHERE expires_at<?", [t - 3600]);
    await tx.run(
      "INSERT INTO oauth_codes(code_hash, client_id, user_id, grant_id, redirect_uri, code_challenge, resource, " +
        "families, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        empreinte(code),
        d.client_id,
        Math.trunc(d.user_id),
        jetonHex(dep, 16),
        d.redirect_uri,
        d.code_challenge,
        d.resource,
        famillesCsv(d.families),
        t,
        t + CODE_TTL_S,
      ],
    );
  });
  return code;
}

interface Paire {
  grantId: string;
  userId: number;
  clientId: string;
  families: string[];
  resource: string;
  echeance?: number;
}

/** `_issue_pair` : jeton d'accès (eoa_) et de rafraîchissement (eor_) du même lot. */
async function emettrePaire(
  dep: DependancesOAuth,
  tx: Executeur,
  p: Paire,
  pol: PolitiqueOAuth,
): Promise<Dict> {
  const t = maintenant(dep);
  const acces = ACCESS_PREFIX + jetonUrl(dep, 32);
  const rafraichissement = REFRESH_PREFIX + jetonUrl(dep, 32);
  const ttl = Math.trunc(pol.access_ttl_s);
  const echeance = p.echeance || t + pol.refresh_days * 86400;
  for (const [kind, jeton, expire] of [
    ["access", acces, t + ttl],
    ["refresh", rafraichissement, echeance],
  ] as const) {
    await tx.run(
      "INSERT INTO oauth_tokens(grant_id, user_id, client_id, kind, token_hash, families, resource, created_at, " +
        "expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [
        p.grantId,
        p.userId,
        p.clientId,
        kind,
        empreinte(jeton),
        famillesCsv(p.families),
        p.resource,
        t,
        expire,
      ],
    );
  }
  await tx.run("UPDATE oauth_clients SET last_used_at=? WHERE client_id=?", [t, p.clientId]);
  return {
    access_token: acces,
    token_type: "Bearer",
    expires_in: ttl,
    refresh_token: rafraichissement,
    scope: portee(p.families),
  };
}

async function revoquerLot(dep: DependancesOAuth, tx: Executeur, grantId: unknown): Promise<void> {
  await tx.run("UPDATE oauth_tokens SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL", [
    maintenant(dep),
    strPy(grantId),
  ]);
}

/** Cible demandée au point de jeton, comparée à celle de l'autorisation ; erreur rendue, jamais levée. */
function cibleRefusee(
  resource: unknown,
  attendue: unknown,
  appUrl: string,
  pol: PolitiqueOAuth,
  quoi: string,
) {
  if (!veritePy(resource)) return null;
  try {
    const [canon] = checkResource(resource, appUrl, pol);
    return canon !== attendue
      ? new ErreurOAuth("invalid_target", `Ressource différente de celle de ${quoi}.`)
      : null;
  } catch (e) {
    if (e instanceof ErreurOAuth) return e;
    throw e;
  }
}

export interface Echange {
  code: unknown;
  client: ClientOAuth;
  redirectUri: unknown;
  codeVerifier: unknown;
  resource: unknown;
  appUrl: string;
}

/** `exchange_code` : code à usage unique, PKCE vérifié ; consommé et révoqué sur rejeu même quand l'échange échoue. */
export async function exchangeCode(dep: DependancesOAuth, e: Echange): Promise<Dict> {
  const pol = politiqueOauth(dep.config());
  if (!pol.enabled) throw new ErreurOAuth("invalid_grant", "Autorisation désactivée par l'administrateur.");
  const t = maintenant(dep);
  const h = empreinte(strPy(veritePy(e.code) ? e.code : ""));
  const [erreur, out] = await dep.base.transaction(async (tx): Promise<[ErreurOAuth | null, Dict]> => {
    const r = await tx.get(
      "SELECT client_id, user_id, grant_id, redirect_uri, code_challenge, resource, families, expires_at, used_at " +
        "FROM oauth_codes WHERE code_hash=?",
      [h],
    );
    if (!r) return [new ErreurOAuth("invalid_grant", "Code inconnu."), {}];
    if (r["used_at"] !== null && r["used_at"] !== undefined) {
      await revoquerLot(dep, tx, r["grant_id"]);
      return [new ErreurOAuth("invalid_grant", "Code déjà utilisé."), {}];
    }
    if (
      (await tx.run("UPDATE oauth_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL", [t, h]))
        .changes === 0
    ) {
      await revoquerLot(dep, tx, r["grant_id"]);
      return [new ErreurOAuth("invalid_grant", "Code déjà utilisé."), {}];
    }
    const familles = famillesListe(r["families"]).filter((f) => pol.families.includes(f));
    const cible = cibleRefusee(e.resource, r["resource"], e.appUrl, pol, "la demande");
    const ruri = r["redirect_uri"];
    if (r["client_id"] !== e.client.client_id)
      return [new ErreurOAuth("invalid_grant", "Code émis pour un autre client."), {}];
    if (Number(r["expires_at"]) < t) return [new ErreurOAuth("invalid_grant", "Code expiré."), {}];
    if (veritePy(ruri) && strPy(veritePy(e.redirectUri) ? e.redirectUri : "") !== ruri)
      return [new ErreurOAuth("invalid_grant", "redirect_uri différente de celle de la demande."), {}];
    if (!pkceOk(e.codeVerifier, r["code_challenge"]))
      return [new ErreurOAuth("invalid_grant", "Vérification PKCE refusée."), {}];
    if (cible !== null) return [cible, {}];
    if (!(await tx.get("SELECT 1 FROM users WHERE id=?", [Number(r["user_id"])])))
      return [new ErreurOAuth("invalid_grant", "Compte supprimé."), {}];
    if (familles.length === 0)
      return [new ErreurOAuth("invalid_scope", "Aucune famille encore autorisée."), {}];
    const paire = await emettrePaire(
      dep,
      tx,
      {
        grantId: strPy(r["grant_id"]),
        userId: Number(r["user_id"]),
        clientId: strPy(r["client_id"]),
        families: familles,
        resource: strPy(r["resource"]),
      },
      pol,
    );
    return [null, paire];
  });
  if (erreur !== null) throw erreur;
  return out;
}

export interface Rafraichissement {
  refreshToken: unknown;
  client: ClientOAuth;
  scope: unknown;
  resource: unknown;
  appUrl: string;
}

/** `refresh` : rotation du jeton de rafraîchissement ; un jeton rejoué révoque toute l'autorisation. */
export async function refresh(dep: DependancesOAuth, f: Rafraichissement): Promise<Dict> {
  const pol = politiqueOauth(dep.config());
  if (!pol.enabled) throw new ErreurOAuth("invalid_grant", "Autorisation désactivée par l'administrateur.");
  const jeton = strPy(veritePy(f.refreshToken) ? f.refreshToken : "");
  if (!jeton.startsWith(REFRESH_PREFIX))
    throw new ErreurOAuth("invalid_grant", "Jeton de rafraîchissement inconnu.");
  const t = maintenant(dep);
  const [erreur, out] = await dep.base.transaction(async (tx): Promise<[ErreurOAuth | null, Dict]> => {
    const r = await tx.get(
      "SELECT id, grant_id, user_id, client_id, families, resource, expires_at, used_at, revoked_at " +
        "FROM oauth_tokens WHERE token_hash=? AND kind='refresh'",
      [empreinte(jeton)],
    );
    if (!r) return [new ErreurOAuth("invalid_grant", "Jeton de rafraîchissement inconnu."), {}];
    let accordees = famillesListe(r["families"]).filter((f2) => pol.families.includes(f2));
    let err: ErreurOAuth | null = null;
    if (veritePy(f.scope)) {
      const reduites = famillesDePortee(f.scope, pol);
      if (reduites.every((x) => accordees.includes(x))) accordees = reduites;
      else {
        accordees = [];
        err = new ErreurOAuth("invalid_scope", "Portée plus large que l'autorisation.");
      }
    }
    const cible = cibleRefusee(f.resource, r["resource"], f.appUrl, pol, "l'autorisation");
    const utilise = r["used_at"] !== null && r["used_at"] !== undefined;
    const revoque = r["revoked_at"] !== null && r["revoked_at"] !== undefined;
    if (r["client_id"] !== f.client.client_id)
      return [new ErreurOAuth("invalid_grant", "Jeton émis pour un autre client."), {}];
    if (utilise || revoque) {
      await revoquerLot(dep, tx, r["grant_id"]);
      return [new ErreurOAuth("invalid_grant", "Jeton de rafraîchissement déjà utilisé ou révoqué."), {}];
    }
    if (Number(r["expires_at"]) < t)
      return [new ErreurOAuth("invalid_grant", "Jeton de rafraîchissement expiré."), {}];
    if (cible !== null) return [cible, {}];
    if (!(await tx.get("SELECT 1 FROM users WHERE id=?", [Number(r["user_id"])])))
      return [new ErreurOAuth("invalid_grant", "Compte supprimé."), {}];
    if (err !== null) return [err, {}];
    if (accordees.length === 0)
      return [new ErreurOAuth("invalid_scope", "Aucune famille encore autorisée."), {}];
    const consomme = await tx.run(
      "UPDATE oauth_tokens SET used_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL",
      [t, Number(r["id"])],
    );
    if (consomme.changes === 0) {
      await revoquerLot(dep, tx, r["grant_id"]);
      return [new ErreurOAuth("invalid_grant", "Jeton de rafraîchissement déjà utilisé ou révoqué."), {}];
    }
    await tx.run(
      "UPDATE oauth_tokens SET revoked_at=? WHERE grant_id=? AND kind='access' AND revoked_at IS NULL",
      [t, strPy(r["grant_id"])],
    );
    const paire = await emettrePaire(
      dep,
      tx,
      {
        grantId: strPy(r["grant_id"]),
        userId: Number(r["user_id"]),
        clientId: strPy(r["client_id"]),
        families: accordees,
        resource: strPy(r["resource"]),
        echeance: Number(r["expires_at"]),
      },
      pol,
    );
    return [null, paire];
  });
  if (erreur !== null) throw erreur;
  return out;
}

/** `revoke_token` (RFC 7009) : rafraîchissement → toute l'autorisation ; accès → lui seul ; inconnu → rien. */
export async function revokeToken(dep: DependancesOAuth, token: unknown, clientId: unknown): Promise<void> {
  const jeton = strPy(veritePy(token) ? token : "");
  if (!jeton.startsWith(ACCESS_PREFIX) && !jeton.startsWith(REFRESH_PREFIX)) return;
  await dep.base.transaction(async (tx) => {
    const r = await tx.get("SELECT id, grant_id, kind, client_id FROM oauth_tokens WHERE token_hash=?", [
      empreinte(jeton),
    ]);
    if (!r || (veritePy(clientId) && strPy(r["client_id"]) !== strPy(clientId))) return;
    if (r["kind"] === "refresh") await revoquerLot(dep, tx, r["grant_id"]);
    else
      await tx.run("UPDATE oauth_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL", [
        maintenant(dep),
        Number(r["id"]),
      ]);
  });
}

const touchesParBase = new WeakMap<Base, Map<number, number>>();

/** `_touch` : `last_used_at` écrit au plus toutes les 5 minutes par jeton (mémoire propre à chaque base) ; une panne ici ne refuse rien. */
async function toucher(dep: DependancesOAuth, id: number, connu: unknown): Promise<void> {
  const t = maintenant(dep);
  let touches = touchesParBase.get(dep.base);
  if (touches === undefined) touchesParBase.set(dep.base, (touches = new Map()));
  const dernier = Math.max(Number(veritePy(connu) ? connu : 0), touches.get(id) ?? 0);
  if (t - dernier < TOUCHE_TOUTES_S) return;
  touches.set(id, t);
  if (touches.size > 4096) for (const [k, v] of touches) if (t - v >= TOUCHE_TOUTES_S) touches.delete(k);
  try {
    await dep.base.transaction((tx) => tx.run("UPDATE oauth_tokens SET last_used_at=? WHERE id=?", [t, id]));
  } catch {
    return;
  }
}

/** `verify_access_token` : jeton d'accès valable → client du relais, familles bornées par la politique et la ressource. */
export async function verifyAccessToken(
  dep: DependancesOAuth,
  token: unknown,
): Promise<ClientDuRelais | null> {
  const jeton = stripPy(strPy(veritePy(token) ? token : ""));
  if (!jeton.startsWith(ACCESS_PREFIX) || longueurPy(jeton) < 20) return null;
  const pol = politiqueOauth(dep.config());
  if (!pol.enabled) return null;
  let r: Record<string, unknown> | undefined;
  try {
    r = await dep.base.get(
      "SELECT t.id, t.grant_id, t.user_id, t.client_id, t.families, t.resource, t.expires_at, t.revoked_at, " +
        "t.last_used_at, u.username FROM oauth_tokens t JOIN users u ON u.id = t.user_id " +
        "WHERE t.token_hash=? AND t.kind='access'",
      [empreinte(jeton)],
    );
  } catch (e) {
    dep.avertir?.("[oauth] vérification impossible", e);
    return null;
  }
  if (!r || (r["revoked_at"] !== null && r["revoked_at"] !== undefined)) return null;
  if (Number(r["expires_at"]) <= maintenant(dep) || !veritePy(r["username"])) return null;
  let familles = famillesListe(r["families"]).filter((f) => pol.families.includes(f));
  const res = strPy(veritePy(r["resource"]) ? r["resource"] : "");
  const fam = resourceFamily(res);
  if (fam !== null) familles = familles.filter((f) => f === fam);
  if (familles.length === 0) return null;
  await toucher(dep, Number(r["id"]), r["last_used_at"]);
  return {
    user_id: Number(r["user_id"]),
    username: strPy(r["username"]),
    kind: "oauth",
    families: familles,
    client_id: strPy(r["client_id"]),
    grant_id: strPy(r["grant_id"]),
    resource: res,
  };
}

/** `list_grants` : une ligne par autorisation encore valable du compte (rafraîchissement ni révoqué ni expiré). */
export async function listGrants(x: Executeur, uid: number, t: number): Promise<Dict[]> {
  const lignes = await x.valeurs<[string, string, string, number, number, number, string | null]>(
    "SELECT t.grant_id, t.client_id, t.families, MIN(t.created_at), MAX(t.expires_at), " +
      "MAX(COALESCE(t.last_used_at, 0)), cl.name FROM oauth_tokens t " +
      "LEFT JOIN oauth_clients cl ON cl.client_id = t.client_id " +
      "WHERE t.user_id=? AND t.kind='refresh' AND t.revoked_at IS NULL AND t.used_at IS NULL " +
      "AND t.expires_at>? GROUP BY t.grant_id, t.client_id, t.families, cl.name ORDER BY MIN(t.created_at) DESC",
    [uid, t],
  );
  const premiers = new Map(
    await x.valeurs<[string, number]>(
      "SELECT grant_id, MIN(created_at) FROM oauth_tokens WHERE user_id=? GROUP BY grant_id",
      [uid],
    ),
  );
  const utilises = new Map(
    await x.valeurs<[string, number | null]>(
      "SELECT grant_id, MAX(last_used_at) FROM oauth_tokens WHERE user_id=? AND kind='access' GROUP BY grant_id",
      [uid],
    ),
  );
  return lignes.map(([grant, cid, fams, cree, expire, , nom]) => ({
    grant_id: strPy(grant),
    client_id: strPy(cid),
    client_name: strPy(veritePy(nom) ? nom : cid),
    families: famillesListe(fams),
    created_at: versFlottantPy(Number(premiers.get(grant) || cree || 0)),
    expires_at: versFlottantPy(Number(expire || 0)),
    last_used_at: flottantOuNul(utilises.get(grant)),
  }));
}

export async function revokeGrant(base: Base, uid: number, grantId: string, t: number): Promise<boolean> {
  return base.transaction(
    async (tx) =>
      (
        await tx.run(
          "UPDATE oauth_tokens SET revoked_at=? WHERE grant_id=? AND user_id=? AND revoked_at IS NULL",
          [t, grantId, uid],
        )
      ).changes > 0,
  );
}

/** Autorisations encore valables comptées comme `len(list_grants(uid))`, puis jetons et codes du compte supprimés. */
export async function revoquerOauthDuCompte(base: Base, uid: number, t: number): Promise<number> {
  const r = await base.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM (SELECT 1 AS un FROM oauth_tokens t LEFT JOIN oauth_clients cl ON cl.client_id = t.client_id " +
      "WHERE t.user_id=? AND t.kind='refresh' AND t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at>? " +
      "GROUP BY t.grant_id, t.client_id, t.families, cl.name) g",
    [uid, t],
  );
  await base.ecriture((x) => supprimerOauthCompte(x, uid));
  return Number(r?.n ?? 0);
}

/** `delete_for_user` : jetons et codes du compte, dans la transaction de l'appelant. */
export async function supprimerOauthCompte(x: Executeur, uid: number): Promise<void> {
  await x.run("DELETE FROM oauth_tokens WHERE user_id=?", [uid]);
  await x.run("DELETE FROM oauth_codes WHERE user_id=?", [uid]);
}
