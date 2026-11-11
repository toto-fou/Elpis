// SPDX-License-Identifier: MIT
/** packages/mcp/src/serveurs.ts — serveurs MCP des comptes : bibliothèque partagée (admin, en base) et serveurs perso ; leurs secrets (jeton, en-têtes, variables) forment un secret du coffre par serveur, relu à chaque connexion, jamais renvoyé au navigateur ; reprise des anciens champs (Fernet, clair). */
import { ErreurPython, intPy, strPy, stripPy, veritePy } from "@elpis/commun";
import { parseJsonPy } from "@elpis/config";
import type { Base, Ligne } from "@elpis/db";
import { decryptStrict, EncryptionUnavailable, InvalidToken } from "@elpis/securite";

import { coffreMcp, estVide, SecretMcpIndisponible, secretsVides, serveurDePortee } from "./coffre";
import type { ActeurMcp, ContexteSecretMcp, MotifSecretMcp, SecretsServeur } from "./coffre";
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

/** Une paire reçue porte une valeur neuve (une valeur vide laisse l'ancienne). */
function pairesSaisies(raw: unknown): boolean {
  return Array.isArray(raw) && raw.some((p) => estDict(p) && stripPy(texte(lire(p, "value"))) !== "");
}

const signales = new Set<string>();
const ignores = new Map<string, number>();
const RAPPEL_IGNORE_MS = 3_600_000;

/** Tests : oublie les noms de paires et les serveurs ignorés déjà signalés (`_SIGNALES.clear()`). */
export function oublierAvertissementsPaires(): void {
  signales.clear();
  ignores.clear();
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

/** Secret nettoyé avant stockage ; en mode `bearer`, le jeton nu (« Bearer eyJ… » collé tel quel est retaillé). */
export function normalizeSecret(mode: unknown, secret: unknown): string {
  let s = stripPy(texte(secret));
  if (mode === "bearer" && s.slice(0, 7).toLowerCase() === "bearer ") s = stripPy(s.slice(7));
  return s;
}

// ── Secrets au coffre : valeur, lecture ──────────────────────────────────────

/** Valeur JSON d'un secret MCP, parties non vides seulement : `{"auth": …, "headers": [{name, value}], "env": […]}`. */
export function secretsEnJson(v: SecretsServeur): string {
  const o: Dict = {};
  if (v.auth) o["auth"] = v.auth;
  if (v.headers.length > 0) o["headers"] = v.headers.map((p) => ({ name: p.name, value: p.value }));
  if (v.env.length > 0) o["env"] = v.env.map((p) => ({ name: p.name, value: p.value }));
  return JSON.stringify(o);
}

/** Paires telles qu'enregistrées (liste `{name, value}` ou objet `{nom: valeur}`) : noms vérifiés à la connexion seulement (`pairesEnDict`), comme avant le coffre. */
function pairesBrutes(brut: unknown): Paire[] {
  const liste = estDict(brut) ? Object.entries(brut).map(([name, value]) => ({ name, value })) : brut;
  if (!Array.isArray(liste)) return [];
  return liste
    .filter((p) => estDict(p) && veritePy(lire(p, "name")))
    .map((p) => ({ name: texte(lire(p, "name")), value: texte(lire(p, "value")) }));
}

/** Valeur lue au coffre : un objet JSON (`auth`, `headers`, `env`) ; tout autre texte est le jeton d'authentification. */
export function secretsDeJson(t: string): SecretsServeur {
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    o = null;
  }
  if (!estDict(o)) return { auth: stripPy(t), headers: [], env: [] };
  return {
    auth: typeof o["auth"] === "string" ? o["auth"] : "",
    headers: pairesBrutes(o["headers"]),
    env: pairesBrutes(o["env"]),
  };
}

/** Secrets tels que lus : valeur (vide sans secret) et motif d'une lecture impossible (rien n'est alors écrasé sans nouvelle saisie). */
export interface EtatSecrets {
  valeur: SecretsServeur;
  erreur: MotifSecretMcp | null;
}

export function etatSansSecret(): EtatSecrets {
  return { valeur: secretsVides(), erreur: null };
}

/** `secret_id` d'une entrée ou d'une ligne : entier positif (texte en PostgreSQL), `null` sinon. */
export function idSecretServeur(v: unknown): number | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "bigint"
        ? Number(v)
        : typeof v === "string" && /^[1-9]\d{0,15}$/u.test(v)
          ? Number(v)
          : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function lireEtat(
  base: Base,
  proprietaire: number | null,
  secretId: unknown,
  serveur: string,
  contexte?: ContexteSecretMcp,
): Promise<EtatSecrets> {
  const id = idSecretServeur(secretId);
  if (id === null) return etatSansSecret();
  try {
    return { valeur: await coffreMcp().lire(base, proprietaire, id, serveur, contexte), erreur: null };
  } catch (e) {
    if (!(e instanceof SecretMcpIndisponible)) throw e;
    return { valeur: secretsVides(), erreur: e.motif };
  }
}

/** Secrets d'un serveur perso de `proprietaire`, lus au coffre ; sans compte connu, un secret enregistré est réputé absent. */
export async function secretsPerso(
  base: Base,
  proprietaire: number | null,
  srv: unknown,
  contexte?: ContexteSecretMcp,
): Promise<EtatSecrets> {
  if (!estDict(srv)) return etatSansSecret();
  if (proprietaire === null)
    return idSecretServeur(srv["secret_id"]) === null
      ? etatSansSecret()
      : { valeur: secretsVides(), erreur: "missing" };
  return lireEtat(base, proprietaire, srv["secret_id"], serveurDePortee(srv["id"]), contexte);
}

/** Lecture tolérante d'une colonne (base pas encore migrée). */
function colonne(r: Ligne, cle: string, defaut: unknown = ""): unknown {
  const v = Object.hasOwn(r, cle) ? r[cle] : undefined;
  return v === null || v === undefined ? defaut : v;
}

/** Secrets d'un serveur de la bibliothèque partagée : secret d'instance, lu au coffre. */
export function secretsPartage(base: Base, r: Ligne, contexte?: ContexteSecretMcp): Promise<EtatSecrets> {
  return lireEtat(base, null, colonne(r, "secret_id", null), publicId(r["id"]), contexte);
}

const MOTIFS: Readonly<Record<MotifSecretMcp, string>> = {
  undecryptable: "illisible avec la clé actuelle du coffre",
  key_unavailable: "inaccessible (clé du coffre indisponible)",
  missing: "absent du coffre",
  refused: "refusé par sa politique (routines, sous-agents)",
  not_migrated: "resté hors du coffre à la migration",
};

/** Une partie des secrets n'est pas au coffre : drapeau de la migration (`secret_error`), ou ancien champ secret encore rempli (migration pas encore passée). */
export function drapeauSecret(src: unknown): MotifSecretMcp | null {
  if (!estDict(src)) return null;
  const d = texte(src["secret_error"]);
  if (d) return d === "not_migrated" ? "not_migrated" : "undecryptable";
  const reste = CLES_HERITEES.some((k) => k !== "key_scheme" && k !== "extra_scheme" && veritePy(src[k]));
  return reste ? "not_migrated" : null;
}

/** Serveur laissé de côté à la connexion faute de pouvoir lire son secret (jamais connecté avec une partie de ses secrets) : signalé une fois par heure et par motif, pas à chaque tour. */
export function signalerServeurIgnore(nom: unknown, motif: MotifSecretMcp): void {
  const libelle = repr(prefixe(strPy(nom ?? "?"), 80));
  const cle = `${motif}\u0000${libelle}`;
  const t = Date.now();
  const vu = ignores.get(cle);
  if (vu !== undefined && t - vu < RAPPEL_IGNORE_MS) return;
  if (ignores.size >= 1000) ignores.clear();
  ignores.set(cle, t);
  journalDe("mcp").warn(`serveur MCP ${libelle} ignoré : secret ${MOTIFS[motif]}`);
}

// ── Reprise des champs d'avant le coffre (Fernet, clair) ─────────────────────

export type PartieSecrete = "auth" | "headers" | "env";

/** Champs d'avant le coffre : chiffrés (Fernet, ou clair selon leur schéma), clair hérité (`authorization`, `basic_auth`, `headers`/`env` en objet), jeton saisi resté stocké. */
export const CLES_HERITEES: readonly string[] = [
  "auth_enc",
  "key_scheme",
  "headers_enc",
  "env_enc",
  "extra_scheme",
  "authorization",
  "basic_auth",
  "auth_secret",
  "headers",
  "env",
];

/** Champs laissés en place quand le chiffré d'une partie est illisible. */
const CLES_DES_PARTIES: Readonly<Record<PartieSecrete, readonly string[]>> = {
  auth: ["auth_enc", "key_scheme"],
  headers: ["headers_enc", "extra_scheme"],
  env: ["env_enc", "extra_scheme"],
};

export interface Heritage {
  /** Parties lisibles : Fernet déchiffré avec la clé actuelle, ou clair hérité. */
  valeur: SecretsServeur;
  /** Parties dont le chiffré est illisible (clé changée, donnée altérée). */
  illisibles: PartieSecrete[];
  /** Mode d'un ancien clair : `basic_auth` → basic, `authorization` → raw (bearer s'il l'était déjà). */
  mode: { auth_mode: string; auth_user: string } | null;
}

/** Chiffré d'avant le coffre : texte, `null` s'il est illisible (jeton invalide, clé Fernet changée ou absente : jamais créée ici). */
function lireChiffre(enc: unknown, scheme: unknown): string | null {
  if (!veritePy(enc)) return "";
  if (scheme !== "fernet") return strPy(enc);
  try {
    return decryptStrict(strPy(enc));
  } catch (e) {
    if (e instanceof InvalidToken || e instanceof EncryptionUnavailable) return null;
    throw e;
  }
}

/** Paires d'un chiffré d'avant le coffre ; illisible ou mal formé : `null`. */
function pairesChiffrees(enc: unknown, scheme: unknown): Paire[] | null {
  const t = lireChiffre(enc, scheme);
  if (t === null) return null;
  if (!t) return [];
  let data: unknown;
  try {
    data = parseJsonPy(t);
  } catch {
    return null;
  }
  return Array.isArray(data) ? pairesBrutes(data) : null;
}

function pairesEnClair(brut: unknown, kind: string): Paire[] {
  if (!estDict(brut)) return [];
  return sanitizePairs(
    Object.entries(brut).map(([name, value]) => ({ name, value })),
    kind,
  );
}

/** Secrets d'avant le coffre d'une entrée perso ou d'une ligne partagée, lus comme à la connexion : chiffré d'abord, sinon clair hérité ; chiffré illisible (ou sans clé Fernet) : partie signalée. */
export function secretsHerites(src: Dict): Heritage {
  const h: Heritage = { valeur: secretsVides(), illisibles: [], mode: null };
  if (veritePy(src["auth_enc"])) {
    const t = lireChiffre(src["auth_enc"], veritePy(src["key_scheme"]) ? src["key_scheme"] : "plain");
    if (t === null) h.illisibles.push("auth");
    else h.valeur.auth = t;
  } else {
    const b = src["basic_auth"];
    const u = estDict(b) ? texteNet(b["username"]) : "";
    const p = estDict(b) ? texteNet(veritePy(b["password"]) ? b["password"] : b["token"]) : "";
    const a = typeof src["authorization"] === "string" ? stripPy(src["authorization"]) : "";
    if (u && p) {
      h.valeur.auth = p;
      h.mode = { auth_mode: "basic", auth_user: prefixe(u, 200) };
    } else if (a) {
      const bearer = src["auth_mode"] === "bearer" && a.slice(0, 7).toLowerCase() === "bearer ";
      h.valeur.auth = bearer ? stripPy(a.slice(7)) : a;
      h.mode = { auth_mode: bearer ? "bearer" : "raw", auth_user: "" };
    }
  }
  const scheme = veritePy(src["extra_scheme"]) ? src["extra_scheme"] : "plain";
  for (const kind of ["headers", "env"] as const) {
    const lues = pairesChiffrees(src[`${kind}_enc`], scheme);
    if (lues === null) h.illisibles.push(kind);
    h.valeur[kind] = lues !== null && lues.length > 0 ? lues : pairesEnClair(src[kind], kind);
  }
  return h;
}

export interface RepriseHeritee extends Heritage {
  /** Type tel que la fusion l'enregistre (`sse` s'il manque ou est inconnu), comme la connexion le lisait. */
  type: string;
  /** Valeur utile non vide, à garder au coffre. */
  aReprendre: boolean;
  /** Un champ hérité porte une valeur (chiffrée ou claire) : la ligne ou l'entrée est à réécrire. */
  aVider: boolean;
  /** Champs hérités présents ; `gardees` : ceux des chiffrés illisibles utiles, laissés en place. */
  cles: string[];
  gardees: string[];
}

/** Reprise au coffre d'une entrée perso ou d'une ligne partagée : parties utiles à son type et à son mode (les autres n'étaient jamais envoyées) ; `null` sans champ hérité. */
export function repriseHeritee(src: Dict): RepriseHeritee | null {
  const cles = CLES_HERITEES.filter((k) => Object.hasOwn(src, k));
  if (cles.length === 0) return null;
  const h = secretsHerites(src);
  const brut = stripPy(texte(veritePy(src["type"]) ? src["type"] : "sse")).toLowerCase();
  const type = (SERVER_TYPES as readonly string[]).includes(brut) ? brut : "sse";
  const http = estHttp(type);
  const mode = http ? h.mode : null;
  const avecAuth = http && (mode?.auth_mode ?? stripPy(texte(src["auth_mode"]))) !== "";
  const utile = (p: PartieSecrete): boolean =>
    p === "auth" ? avecAuth : p === "headers" ? http : type === "stdio";
  const valeur: SecretsServeur = {
    auth: avecAuth ? h.valeur.auth : "",
    headers: http ? h.valeur.headers : [],
    env: type === "stdio" ? h.valeur.env : [],
  };
  const illisibles = h.illisibles.filter(utile);
  return {
    type,
    valeur,
    illisibles,
    mode,
    aReprendre: !estVide(valeur),
    aVider: cles.some((k) => k !== "key_scheme" && k !== "extra_scheme" && veritePy(src[k])),
    cles,
    gardees: illisibles.flatMap((p) => CLES_DES_PARTIES[p]),
  };
}

/** Entrée perso telle que la migration la laisse : type et mode repris, champs hérités retirés sauf les chiffrés illisibles (signalés, sinon le drapeau d'avant est levé), `secret_id` posé. */
export function entreeReprise(srv: Dict, r: RepriseHeritee, secretId: number | null): void {
  if (srv["type"] !== r.type) poser(srv, "type", r.type);
  if (r.mode !== null) for (const [k, v] of Object.entries(r.mode)) poser(srv, k, v);
  for (const k of r.cles) if (!r.gardees.includes(k)) delete srv[k];
  if (secretId !== null) poser(srv, "secret_id", secretId);
  if (r.illisibles.length > 0) poser(srv, "secret_error", "undecryptable");
  else delete srv["secret_error"];
}

// ── Fusion « vide = inchangé » ───────────────────────────────────────────────

interface Saisie {
  /** Type et mode effectifs après l'enregistrement. */
  type: string;
  mode: string;
  /** Jeton saisi ; vide : inchangé. */
  secret: string;
  /** Paires reçues ; `undefined` : inchangées. */
  headers: unknown;
  env: unknown;
}

interface Fusion {
  valeur: SecretsServeur | null;
  changee: boolean;
  illisibles: PartieSecrete[];
  /** Utilisateur d'un ancien `basic_auth` dont le mot de passe est repris. */
  utilisateur: string | null;
}

/** `a` complété partie par partie de `b` (jeton, en-têtes, variables). */
export function completer(a: SecretsServeur, b: SecretsServeur | undefined): SecretsServeur {
  if (b === undefined) return a;
  return {
    auth: a.auth || b.auth,
    headers: a.headers.length > 0 ? a.headers : b.headers,
    env: a.env.length > 0 ? a.env : b.env,
  };
}

/** Nouvelle valeur : jeton et paires saisis sur l'ancienne (coffre, sinon champs hérités lisibles, gardés tels quels sans nouvelle valeur), parties inutiles au type ou au mode retirées ; secret du coffre illisible ou retiré et rien de saisi : gardé tel quel (`null`). */
function fusionnerSecrets(s: Saisie, etat: EtatSecrets, herite: Heritage | null): Fusion {
  const http = estHttp(s.type);
  const stdio = s.type === "stdio";
  const secret = s.mode ? normalizeSecret(s.mode, s.secret) : "";
  const saisies: Readonly<Record<PartieSecrete, boolean>> = {
    auth: secret !== "",
    headers: pairesSaisies(s.headers),
    env: pairesSaisies(s.env),
  };
  const illisibles = (herite?.illisibles ?? []).filter(
    (p) => !saisies[p] && (p === "auth" ? s.mode !== "" : p === "headers" ? http : stdio),
  );
  if (!saisies.auth && !saisies.headers && !saisies.env && etat.erreur !== null)
    return { valeur: null, changee: false, illisibles, utilisateur: null };
  const avant = completer(etat.valeur, herite?.valeur);
  const paires = (kind: "headers" | "env", recues: unknown): Paire[] => {
    if (recues === undefined) return avant[kind];
    const fusion = mergePairs(avant[kind], recues, kind);
    const heritees = etat.valeur[kind].length === 0 ? (herite?.valeur[kind] ?? []) : [];
    if (heritees.length === 0 || saisies[kind]) return fusion;
    const noms = new Set(fusion.map((p) => p.name));
    return [...fusion, ...heritees.filter((p) => !noms.has(p.name))].slice(0, MAX_PAIRS);
  };
  const valeur: SecretsServeur = {
    auth: !s.mode ? "" : secret || avant.auth,
    headers: http ? paires("headers", s.headers) : [],
    env: stdio ? paires("env", s.env) : [],
  };
  const heriteLisible = herite !== null && !estVide(herite.valeur);
  const authHeritee = valeur.auth !== "" && !secret && !etat.valeur.auth;
  return {
    valeur,
    changee: etat.erreur !== null || heriteLisible || secretsEnJson(valeur) !== secretsEnJson(etat.valeur),
    illisibles,
    utilisateur: authHeritee && herite?.mode?.auth_mode === "basic" ? herite.mode.auth_user : null,
  };
}

/** Chiffrés illisibles encore utiles : laissés en place dans `cible`, signalés (`secret_error`). */
function garderIllisibles(cible: Dict, ancien: Dict, illisibles: readonly PartieSecrete[]): void {
  if (illisibles.length === 0) return;
  for (const k of illisibles.flatMap((p) => CLES_DES_PARTIES[p]))
    if (Object.hasOwn(ancien, k)) poser(cible, k, ancien[k]);
  poser(cible, "secret_error", "undecryptable");
}

// ── Bibliothèque partagée : lectures ─────────────────────────────────────────

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

/** Secrets montrés (noms seulement) : ceux du coffre, complétés des anciens champs lisibles encore en place, que le prochain enregistrement reprend. */
function secretsMontres(r: RepriseHeritee | null, etat: EtatSecrets): SecretsServeur {
  return r === null ? etat.valeur : completer(etat.valeur, r.valeur);
}

/** Vue sans secret ; un compte ordinaire n'a que de quoi reconnaître le serveur (`has_auth` : un secret est enregistré, sans le déchiffrer ; drapeau de la migration) ; l'admin : `has_auth`, `has_value` lisibles avec la clé actuelle (`etat`). */
function vuePublique(r: Ligne, admin: boolean, etat: EtatSecrets | null): Dict {
  const d: Dict = {};
  for (const k of admin ? COLONNES_ADMIN : COLONNES_COMPTE) poser(d, k, r[k]);
  d["id"] = publicId(d["id"]);
  d["enabled"] = veritePy(d["enabled"]);
  d["shared"] = true;
  if (!admin || etat === null) {
    d["has_auth"] =
      idSecretServeur(colonne(r, "secret_id", null)) !== null || veritePy(colonne(r, "auth_enc"));
    const drapeau = drapeauSecret(r);
    if (drapeau !== null) d["secret_error"] = drapeau;
    return d;
  }
  const vus = secretsMontres(repriseHeritee(r), etat);
  d["has_auth"] = veritePy(vus.auth);
  d["headers"] = pairsPublic(vus.headers);
  d["env"] = pairsPublic(vus.env);
  const erreur = etat.erreur ?? drapeauSecret(r);
  if (erreur !== null) d["secret_error"] = erreur;
  return d;
}

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
  const out: Dict[] = [];
  for (const r of await base.all(sql))
    out.push(vuePublique(r, admin, admin ? await secretsPartage(base, r) : null));
  return out;
}

export async function getShared(
  base: Base,
  serverId: unknown,
  options: { admin?: boolean } = {},
): Promise<Dict | null> {
  const r = await base.get("SELECT * FROM mcp_shared_servers WHERE id=?", [intPy(serverId)]);
  if (!r) return null;
  const admin = options.admin ?? false;
  return vuePublique(r, admin, admin ? await secretsPartage(base, r) : null);
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

/** Publication : la ligne, puis son secret d'instance au coffre (`mcp-shared-<n>`), dans une même transaction. */
export async function createShared(base: Base, f: ChampsPartage, acteur: ActeurMcp): Promise<number> {
  const type = f.type ?? "sse";
  const mode = f.auth_mode || "";
  const valeur: SecretsServeur = {
    auth: mode ? normalizeSecret(mode, f.auth_secret ?? "") : "",
    headers: estHttp(type) ? sanitizePairs(f.headers, "headers") : [],
    env: type === "stdio" ? sanitizePairs(f.env, "env") : [],
  };
  const maintenant = Date.now() / 1000;
  return base.ecriture(async (x) => {
    const id = await x.insertId(
      "INSERT INTO mcp_shared_servers(name, type, url, command, auth_mode, " +
        "auth_user, auth_enc, key_scheme, headers_enc, env_enc, extra_scheme, " +
        "enabled, created_at, updated_at) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        f.name ?? "",
        type,
        f.url || "",
        f.command || "",
        mode,
        f.auth_user || "",
        "",
        "plain",
        "",
        "",
        "plain",
        (f.enabled ?? true) ? 1 : 0,
        maintenant,
        maintenant,
      ],
    );
    if (!estVide(valeur)) {
      const sid = await coffreMcp().ecrire(base, null, publicId(id), valeur, null, acteur);
      await x.run("UPDATE mcp_shared_servers SET secret_id=? WHERE id=?", [sid, id]);
    }
    return id;
  });
}

/** Ligne brute (`secret_id`, champs hérités) : côté serveur seulement (bouton « Tester », fusion « vide = inchangé »). */
export async function rawShared(base: Base, serverId: unknown): Promise<Dict | null> {
  const r = await base.get("SELECT * FROM mcp_shared_servers WHERE id=?", [intPy(serverId)]);
  return r ? { ...r } : null;
}

/** Mise à jour partielle : champ absent inchangé, secret vide inchangé, `auth_mode=""` retire le jeton ; secret illisible gardé tel quel sans nouvelle saisie. */
export async function updateShared(
  base: Base,
  serverId: unknown,
  f: ChampsPartage,
  acteur: ActeurMcp,
): Promise<boolean> {
  const rid = intPy(serverId);
  return base.ecriture(async (x) => {
    const r = await x.get("SELECT * FROM mcp_shared_servers WHERE id=?", [rid]);
    if (!r) return false;
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const poserCol = (col: string, v: string | number | null): void => {
      sets.push(`${col}=?`);
      vals.push(v);
    };
    for (const k of ["name", "type", "url", "command", "auth_user"] as const) {
      const v = f[k];
      if (v !== null && v !== undefined) poserCol(k, v);
    }
    if (f.enabled !== null && f.enabled !== undefined) poserCol("enabled", f.enabled ? 1 : 0);
    if (f.auth_mode !== null && f.auth_mode !== undefined) poserCol("auth_mode", f.auth_mode);
    const type = f.type ?? (texte(r["type"]) || "sse");
    const fusion = fusionnerSecrets(
      {
        type,
        mode: f.auth_mode ?? texte(r["auth_mode"]),
        secret: texte(f.auth_secret),
        headers: f.headers ?? undefined,
        env: f.env ?? undefined,
      },
      await secretsPartage(base, r),
      secretsHerites(r),
    );
    if (fusion.valeur !== null) {
      const serveur = publicId(rid);
      let sid = idSecretServeur(r["secret_id"]);
      if (estVide(fusion.valeur)) {
        if (sid !== null) await coffreMcp().supprimer(base, null, sid, serveur, acteur);
        sid = null;
      } else if (fusion.changee || sid === null)
        sid = await coffreMcp().ecrire(base, null, serveur, fusion.valeur, sid, acteur);
      const gardees = new Set(fusion.illisibles.flatMap((p) => CLES_DES_PARTIES[p]));
      for (const [col, vide] of [
        ["auth_enc", ""],
        ["key_scheme", "plain"],
        ["headers_enc", ""],
        ["env_enc", ""],
        ["extra_scheme", "plain"],
      ] as const)
        if (!gardees.has(col)) poserCol(col, vide);
      poserCol("secret_id", sid);
      poserCol("secret_error", fusion.illisibles.length > 0 ? "undecryptable" : "");
    }
    if (sets.length === 0) return false;
    poserCol("updated_at", Date.now() / 1000);
    const res = await x.run(`UPDATE mcp_shared_servers SET ${sets.join(", ")} WHERE id=?`, [...vals, rid]);
    return res.changes > 0;
  });
}

/** Retrait : la ligne et son secret d'instance, dans une même transaction. */
export async function deleteShared(base: Base, serverId: unknown, acteur: ActeurMcp): Promise<boolean> {
  const rid = intPy(serverId);
  return base.ecriture(async (x) => {
    const r = await x.get("SELECT secret_id FROM mcp_shared_servers WHERE id=?", [rid]);
    if (!r) return false;
    await x.run("DELETE FROM mcp_shared_servers WHERE id=?", [rid]);
    const sid = idSecretServeur(r["secret_id"]);
    if (sid !== null) await coffreMcp().supprimer(base, null, sid, publicId(rid), acteur);
    return true;
  });
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

/** Ligne → config MCP de confiance, secrets lus au coffre, paires revérifiées. */
export function ligneEnConfig(r: Ligne, secrets: SecretsServeur = secretsVides()): Dict {
  const cfg: Dict = marquerConfiance({
    id: publicId(r["id"]),
    name: r["name"],
    type: r["type"],
    url: r["url"],
    command: r["command"],
  });
  if (!estHttp(r["type"])) {
    const env = pairesEnDict(secrets.env, "env");
    if (Object.keys(env).length > 0) cfg["env"] = env;
    return cfg;
  }
  const headers = pairesEnDict(secrets.headers, "headers");
  if (Object.keys(headers).length > 0) cfg["headers"] = headers;
  appliquerModeAuth(cfg, r["auth_mode"], r["auth_user"], normalizeSecret(r["auth_mode"], secrets.auth));
  return cfg;
}

/** Ligne → config, secret lu au coffre ; illisible, retiré ou refusé : `null` (serveur ignoré, signalé). */
async function ligneResolue(base: Base, r: Ligne, contexte?: ContexteSecretMcp): Promise<Dict | null> {
  const etat = await secretsPartage(base, r, contexte);
  const motif = etat.erreur ?? drapeauSecret(r);
  if (motif === null) return ligneEnConfig(r, etat.valeur);
  signalerServeurIgnore(r["name"], motif);
  return null;
}

/** Config prête pour le client MCP, en-tête d'auth compris ; `null` si l'entrée est inconnue, désactivée, ou son secret illisible. */
export async function resolveConfig(
  base: Base,
  serverId: unknown,
  contexte?: ContexteSecretMcp,
): Promise<Dict | null> {
  const r = await base.get("SELECT * FROM mcp_shared_servers WHERE id=? AND enabled=1", [intPy(serverId)]);
  return r ? ligneResolue(base, r, contexte) : null;
}

/** `resolveConfig` sur des ids publics, ordre préservé, inconnus, désactivés et illisibles jetés, une seule requête. */
export async function resolveMany(
  base: Base,
  publicIds: unknown,
  contexte?: ContexteSecretMcp,
): Promise<Dict[]> {
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
  const out: Dict[] = [];
  for (const rid of rids) {
    const r = parId.get(rid);
    const cfg = r ? await ligneResolue(base, r, contexte) : null;
    if (cfg !== null) out.push(cfg);
  }
  return out;
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
/** Jamais dans la vue navigateur : champs hérités, référence au coffre, paires (rendues à part, sans valeur). */
const CLES_PRIVEES_PERSO = new Set([...CLES_HERITEES, "has_auth", "secret_id", "secret_error"]);
/** Jamais dans une config : champs hérités et propres à l'enregistrement. */
const CLES_HORS_CONFIG = new Set([...CLES_HERITEES, "has_auth", "visible", "secret_id", "secret_error"]);

/** Vue navigateur d'un serveur perso : sans secret ni champ hérité ; `has_auth`, `has_value` lisibles avec la clé actuelle (coffre, et anciens champs encore en place, mode implicite compris) ; `secret_error` quand un secret ne peut pas être lu. */
export function personalPublic(srv: unknown, etat: EtatSecrets = etatSansSecret()): Dict {
  if (!estDict(srv)) return {};
  const out: Dict = {};
  for (const [k, v] of Object.entries(srv)) if (!CLES_PRIVEES_PERSO.has(k)) poser(out, k, v);
  const r = repriseHeritee(srv);
  if (r?.mode) for (const [k, v] of Object.entries(r.mode)) poser(out, k, v);
  const vus = secretsMontres(r, etat);
  out["has_auth"] = veritePy(vus.auth);
  poser(out, "headers", pairsPublic(vus.headers));
  poser(out, "env", pairsPublic(vus.env));
  const erreur = etat.erreur ?? drapeauSecret(srv);
  if (erreur !== null) poser(out, "secret_error", erreur);
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

/** Verdicts de la garde demandés d'avance (mémorisés 60 s) pour les adresses HTTP reçues neuves ou changées : la fusion, faite ensuite dans la transaction d'écriture, ne résout plus de nom. */
export async function prechaufferGardeUrl(recus: unknown, anciens: unknown): Promise<void> {
  const connues = new Map<string, string>();
  for (const s of Array.isArray(anciens) ? anciens : [])
    if (estDict(s) && veritePy(s["id"])) connues.set(strPy(s["id"]), texte(s["url"]));
  for (const srv of Array.isArray(recus) ? recus : []) {
    if (!estDict(srv)) continue;
    const type = stripPy(texte(veritePy(srv["type"]) ? srv["type"] : "sse")).toLowerCase();
    const url = prefixe(texte(srv["url"]), 2000);
    if (estHttp(type) && connues.get(strPy(srv["id"] ?? null)) !== url) await personalUrlBlockReason(url);
  }
}

/** Entrée perso → config MCP, secrets lus au coffre par l'appelant ; `stdio` (et URL interne) refusés à un propriétaire non admin : `{}` ; celle d'un admin est de confiance. */
export async function personalToConfig(
  srv: unknown,
  options: { allowStdio?: boolean; secrets?: SecretsServeur | null } = {},
): Promise<Dict> {
  const allowStdio = options.allowStdio ?? false;
  if (!estDict(srv)) return {};
  if (texte(srv["type"]).toLowerCase() === "stdio" && !allowStdio) return {};
  if (estHttp(srv["type"]) && !allowStdio && veritePy(await personalUrlBlockReason(srv["url"]))) return {};
  const cfg: Dict = allowStdio ? marquerConfiance({}) : {};
  for (const [k, v] of Object.entries(srv)) if (!CLES_HORS_CONFIG.has(k)) poser(cfg, k, v);
  const secrets = options.secrets ?? secretsVides();
  const stype = srv["type"];
  if (stype === "stdio") {
    const envMap = pairesEnDict(secrets.env, "env");
    if (Object.keys(envMap).length > 0) poser(cfg, "env", envMap);
  } else if (estHttp(stype)) {
    const enTetes = pairesEnDict(secrets.headers, "headers");
    if (Object.keys(enTetes).length > 0) poser(cfg, "headers", enTetes);
    appliquerModeAuth(
      cfg,
      srv["auth_mode"],
      srv["auth_user"],
      normalizeSecret(srv["auth_mode"], secrets.auth),
    );
  }
  return cfg;
}

/** Une entrée fusionnée : à enregistrer sans valeur secrète, et sa nouvelle valeur pour le coffre. */
export interface FusionPerso {
  /** `secret_id` de l'ancienne entrée repris tel quel ; `appliquerSecretsPerso` le confirme, le remplace ou le retire. */
  entree: Dict;
  /** `null` : secret illisible gardé tel quel (rien de saisi). */
  valeur: SecretsServeur | null;
  /** Valeur à écrire au coffre (ou à retirer si elle est vide). */
  changee: boolean;
}

/** Fusionne la liste perso reçue avec celle en base : un secret n'est jamais pris des octets du client sans saisie (« vide = inchangé ») ; `secrets` : anciennes valeurs lues au coffre, par id. */
export async function mergePersonalMcp(
  oldList: unknown,
  newList: unknown,
  options: { allowStdio?: boolean; secrets?: ReadonlyMap<string, EtatSecrets> } = {},
): Promise<FusionPerso[]> {
  const allowStdio = options.allowStdio ?? false;
  const anciens = new Map<string, Dict>();
  for (const s of Array.isArray(oldList) ? oldList : [])
    if (estDict(s) && veritePy(s["id"])) anciens.set(strPy(s["id"]), s);
  const out: FusionPerso[] = [];
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
    if (entry["auth_mode"] === "header") {
      const nom = stripPy(entry["auth_user"] as string) || DEFAULT_HEADER_NAME;
      if (headerNameOk(nom)) poser(entry, "auth_user", nom);
      else poser(entry, "auth_mode", "");
    }
    if (!entry["auth_mode"]) poser(entry, "auth_user", "");

    const ancien = anciens.get(idClient);
    const fusion = fusionnerSecrets(
      {
        type: texte(entry["type"]),
        mode: texte(entry["auth_mode"]),
        secret: texte(srv["auth_secret"]),
        headers: Object.hasOwn(srv, "headers") ? srv["headers"] : undefined,
        env: Object.hasOwn(srv, "env") ? srv["env"] : undefined,
      },
      ancien === undefined ? etatSansSecret() : (options.secrets?.get(idClient) ?? etatSansSecret()),
      ancien === undefined ? null : secretsHerites(ancien),
    );
    if (ancien !== undefined) {
      const sid = idSecretServeur(ancien["secret_id"]);
      if (sid !== null) poser(entry, "secret_id", sid);
      garderIllisibles(entry, ancien, fusion.illisibles);
    }
    if (fusion.utilisateur !== null && entry["auth_mode"] === "basic" && !stripPy(texte(entry["auth_user"])))
      poser(entry, "auth_user", fusion.utilisateur);
    out.push({ entree: entry, valeur: fusion.valeur, changee: fusion.changee });
  }
  return out;
}

/** Écrit au coffre les secrets fusionnés de `proprietaire` (création, nouvelle valeur, retrait) et rend les entrées à enregistrer, `secret_id` à jour ; les secrets des serveurs retirés de la liste sont supprimés. */
export async function appliquerSecretsPerso(
  base: Base,
  proprietaire: number,
  anciens: readonly unknown[],
  fusion: readonly FusionPerso[],
  acteur: ActeurMcp,
): Promise<Dict[]> {
  const coffre = coffreMcp();
  const pris = new Set<number>();
  const out: Dict[] = [];
  for (const f of fusion) {
    const e = f.entree;
    const serveur = serveurDePortee(e["id"]);
    const repris = idSecretServeur(e["secret_id"]);
    let sid = repris !== null && !pris.has(repris) ? repris : null;
    delete e["secret_id"];
    if (f.valeur !== null) {
      if (estVide(f.valeur)) {
        if (sid !== null) await coffre.supprimer(base, proprietaire, sid, serveur, acteur);
        sid = null;
      } else if (f.changee || sid === null)
        sid = await coffre.ecrire(base, proprietaire, serveur, f.valeur, sid, acteur);
    }
    if (sid !== null) {
      pris.add(sid);
      poser(e, "secret_id", sid);
    }
    out.push(e);
  }
  for (const s of anciens) {
    const sid = estDict(s) ? idSecretServeur(s["secret_id"]) : null;
    if (sid !== null && !pris.has(sid))
      await coffre.supprimer(base, proprietaire, sid, serveurDePortee((s as Dict)["id"]), acteur);
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

/** Entrée perso → config, secret lu au coffre ; illisible, retiré ou refusé : `null` (serveur ignoré, signalé). */
async function persoResolue(
  base: Base,
  proprietaire: number | null,
  srv: Dict,
  options: { allowStdio?: boolean; contexte?: ContexteSecretMcp },
): Promise<Dict | null> {
  const etat = await secretsPerso(base, proprietaire, srv, options.contexte);
  const motif = etat.erreur ?? drapeauSecret(srv);
  if (motif !== null) {
    signalerServeurIgnore(srv["name"] ?? srv["id"], motif);
    return null;
  }
  const cfg = await personalToConfig(srv, { allowStdio: options.allowStdio ?? false, secrets: etat.valeur });
  return Object.keys(cfg).length > 0 ? cfg : null;
}

/** Config perso par id, secret lu au coffre ; `null` si l'id est inconnu, refusé ou son secret illisible. */
export async function resolvePersonal(
  base: Base,
  proprietaire: number | null,
  userSettings: unknown,
  serverId: unknown,
  options: { allowStdio?: boolean; contexte?: ContexteSecretMcp } = {},
): Promise<Dict | null> {
  for (const srv of serveursPerso(userSettings)) {
    if (estDict(srv) && strPy(srv["id"] ?? null) === strPy(serverId ?? null))
      return persoResolue(base, proprietaire, srv, options);
  }
  return null;
}

/** Serveurs qu'un agent custom peut référencer : perso (même masqués) + partagés que le compte affiche, résolus avec leur auth (secret illisible : serveur ignoré). */
export async function resolveForAgents(
  base: Base,
  userSettings: unknown,
  options: { allowStdio?: boolean; proprietaire?: number | null; contexte?: ContexteSecretMcp } = {},
): Promise<Dict[]> {
  const propres: Dict[] = [];
  for (const s of serveursPerso(userSettings)) {
    if (!estDict(s)) continue;
    const cfg = await persoResolue(base, options.proprietaire ?? null, s, options);
    if (cfg !== null) propres.push(cfg);
  }
  const visibles = lire(userSettings, "shared_mcp_visible");
  return [...propres, ...(await resolveMany(base, veritePy(visibles) ? visibles : [], options.contexte))];
}
