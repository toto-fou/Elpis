// SPDX-License-Identifier: MIT
/** apps/core/src/identite/reglages.ts — réglages `config.json › auth` : types, lecteur tolérant lu à chaud et validateur strict des écritures. */
import { createHash, X509Certificate } from "node:crypto";

import { adresseIpOuNul, estDict, FlottantPy, HttpError } from "@elpis/commun";
import { liveConfigValue } from "@elpis/config";

export const FOURNISSEURS_MAX = 5;
export const CA_PEM_MAX = 64 * 1024;
const REGEX_ID = /^[a-z0-9][a-z0-9-]{0,30}$/u;
const CONTROLE = /\p{Cc}/u;
const REGEX_ATTRIBUT = /^[A-Za-z][A-Za-z0-9.;-]{0,63}$/u;
const REGEX_REVENDICATION = /^[A-Za-z0-9_.:-]{1,64}$/u;
const REGEX_JETON_SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
const REGEX_URL_LDAPS = /^ldaps:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9._-]*)(?::(\d{1,5}))?$/u;
const REGEX_PEM = /^\s*(?:-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/u;
const BLOC_PEM = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/gu;

export type ModeLocal = "all" | "admins";
export type ModeGroupes = "memberof" | "chain" | "member";

export interface CorrespondanceGroupe {
  external: string;
  group_id: number;
}

export interface FournisseurCommun {
  id: string;
  type: "ldap" | "oidc";
  label: string;
  enabled: boolean;
  preset: string;
  ca_pem: string;
  required_groups: string[];
  roles: { enabled: boolean; admin_groups: string[]; moderator_groups: string[] };
  group_map: { enabled: boolean; map: CorrespondanceGroupe[] };
  freshness_days: number;
}

export interface FournisseurLdap extends FournisseurCommun {
  type: "ldap";
  urls: string[];
  bind_dn: string;
  user_base_dn: string;
  user_filter: string;
  attrs: { id: string; username: string; email: string; name: string };
  groups: { mode: ModeGroupes };
  max_failures: number;
  failure_window_sec: number;
  timeout_sec: number;
}

export interface FournisseurOidc extends FournisseurCommun {
  type: "oidc";
  issuer: string;
  client_id: string;
  client_auth: "basic" | "post";
  scopes: string[];
  subject_claim: string;
  username_claim: string;
  email_claim: string;
  name_claim: string;
  groups_claim: string;
  required_acr: string[];
  required_amr: string[];
  max_age_sec: number;
  clock_skew_sec: number;
  session_max_age_sec: number;
  logout: { rp_initiated: boolean; backchannel: boolean };
}

export type Fournisseur = FournisseurLdap | FournisseurOidc;

export interface ReglagesAuth {
  public_url: string;
  local: { mode: ModeLocal };
  providers: Fournisseur[];
}

/** Réglages lus : fournisseurs valides, et ceux du fichier qui ne le sont pas (id et libellé quand ils se lisent). */
export interface ReglagesAuthLus extends ReglagesAuth {
  invalides: { id: string | null; label: string | null; enabled: boolean }[];
}

export const BORNES_AUTH = {
  providers_max: FOURNISSEURS_MAX,
  label: { min: 1, max: 40 },
  ca_pem_max: CA_PEM_MAX,
  required_groups_max: 20,
  freshness_days: { min: 1, max: 90, default: 14 },
  ldap_urls_max: 3,
  max_failures: { min: 1, max: 20, default: 4 },
  failure_window_sec: { min: 60, max: 86_400, default: 900 },
  timeout_sec: { min: 2, max: 30, default: 10 },
  clock_skew_sec: { min: 0, max: 300, default: 60 },
  secret_max: 16_384,
} as const;

function refus(nom: string, attendu: string): never {
  throw new HttpError(400, `Champ « ${nom} » : ${attendu}.`);
}

function entierLu(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v === "bigint") return v >= -(2n ** 53n) && v <= 2n ** 53n ? Number(v) : null;
  if (v instanceof FlottantPy) return Number.isSafeInteger(v.valeur) ? v.valeur : null;
  return null;
}

function entier(v: unknown, nom: string, min: number, max: number): number {
  const n = entierLu(v);
  if (n === null || n < min || n > max) return refus(nom, `un entier entre ${min} et ${max}`);
  return n;
}

function booleen(v: unknown, nom: string): boolean {
  if (typeof v !== "boolean") return refus(nom, "vrai ou faux attendu");
  return v;
}

function texte(v: unknown, nom: string, min: number, max: number): string {
  if (typeof v !== "string" || !v.isWellFormed() || v.length < min || v.length > max || CONTROLE.test(v))
    return refus(
      nom,
      min === 0 && max > 0 ? `texte de ${max} caractères au plus` : `texte de ${min} à ${max} caractères`,
    );
  return v;
}

function listeTextes(v: unknown, nom: string, max: number, longueur: number): string[] {
  if (!Array.isArray(v) || v.length > max) return refus(nom, `liste de ${max} textes au plus`);
  const sortie: string[] = [];
  for (const x of v) {
    const t = texte(x, nom, 1, longueur);
    if (!sortie.includes(t)) sortie.push(t);
  }
  return sortie;
}

function objet(v: unknown, nom: string, permises: readonly string[]): Record<string, unknown> {
  if (!estDict(v)) return refus(nom, "objet attendu");
  for (const cle of Object.keys(v)) if (!permises.includes(cle)) refus(`${nom}.${cle}`, "champ inconnu");
  return v;
}

function choix<T extends string>(v: unknown, nom: string, permis: readonly T[]): T {
  if (typeof v !== "string" || !(permis as readonly string[]).includes(v))
    return refus(nom, `une valeur parmi ${permis.join(", ")}`);
  return v as T;
}

/** Origine https seule (ni chemin, ni requête, ni fragment, ni identifiants), sous sa forme normalisée ; `null` sinon. */
export function origineHttps(brut: unknown): string | null {
  if (typeof brut !== "string") return null;
  const t = brut.trim();
  if (!t || t.length > 2048 || CONTROLE.test(t) || /[?#]/u.test(t) || !URL.canParse(t)) return null;
  const u = new URL(t);
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.pathname !== "/") return null;
  return u.origin;
}

/** Adresse du fournisseur OIDC : https avec hôte, sans identifiants, requête ni fragment ; gardée telle que saisie. */
function adresseIssuer(v: unknown): string {
  const t = texte(v, "issuer", 1, 512);
  if (t !== t.trim() || /[?#\s]/u.test(t) || !URL.canParse(t))
    return refus("issuer", "adresse https attendue");
  const u = new URL(t);
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password)
    return refus("issuer", "adresse https sans identifiants, requête ni fragment");
  if (u.port === "0") return refus("issuer", "port invalide");
  return t;
}

function adresseLdaps(v: unknown): string {
  const t = texte(v, "urls", 1, 300);
  const m = REGEX_URL_LDAPS.exec(t);
  if (m === null) return refus("urls", "adresses ldaps://hôte[:port] seulement");
  const crochets = /^\[(.*)\]$/u.exec(m[1] ?? "")?.[1];
  if (crochets !== undefined && (!crochets.includes(":") || adresseIpOuNul(crochets) === null))
    return refus("urls", "adresse IPv6 invalide");
  const port = m[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535 || port.startsWith("0")))
    return refus("urls", "port invalide");
  return t;
}

/** Hôte et port (636 par défaut) d'une adresse `ldaps://` validée, en minuscules. */
export function hotePortLdaps(url: string): string {
  const m = REGEX_URL_LDAPS.exec(url);
  return `${(m?.[1] ?? "").toLowerCase()}:${m?.[2] ?? "636"}`;
}

/** Hôte et port (443 par défaut) de l'adresse https d'un fournisseur OIDC. */
export function hotePortHttps(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "443"}`;
}

const PEM_VERDICTS_MAX = 64;
const verdictsPem = new Map<string, boolean>();

/** Verdict (lisible ou non) d'un PEM déjà analysé, gardé par empreinte du contenu : les lectures à chaud ne refont pas l'analyse. */
function pemLisible(v: string): boolean {
  const cle = createHash("sha256").update(v, "utf8").digest("hex");
  const connu = verdictsPem.get(cle);
  if (connu !== undefined) return connu;
  let ok = true;
  try {
    for (const bloc of v.match(BLOC_PEM) ?? []) new X509Certificate(bloc);
  } catch {
    ok = false;
  }
  if (verdictsPem.size >= PEM_VERDICTS_MAX) verdictsPem.clear();
  verdictsPem.set(cle, ok);
  return ok;
}

function certificats(v: unknown): string {
  if (typeof v !== "string" || !v.isWellFormed() || Buffer.byteLength(v) > CA_PEM_MAX)
    return refus("ca_pem", "certificats PEM de 64 Kio au plus");
  if (v === "") return v;
  if (!REGEX_PEM.test(v)) return refus("ca_pem", "certificats PEM attendus");
  if (!pemLisible(v)) return refus("ca_pem", "certificat illisible");
  return v;
}

/** Vrai si le nom, ou l'un des segments d'un chemin pointé, existe sur `Object.prototype`. */
function nomDePrototype(v: string): boolean {
  return [v, ...v.split(".")].some((segment) => segment in Object.prototype);
}

function nomAttribut(v: unknown, nom: string): string {
  if (typeof v !== "string" || !REGEX_ATTRIBUT.test(v) || nomDePrototype(v))
    return refus(nom, "nom d'attribut attendu");
  return v;
}

function nomRevendication(v: unknown, nom: string): string {
  if (typeof v !== "string" || !REGEX_REVENDICATION.test(v) || nomDePrototype(v))
    return refus(nom, "nom de revendication attendu (lettres, chiffres, _, -, . ou :)");
  return v;
}

function correspondances(v: unknown): CorrespondanceGroupe[] {
  if (!Array.isArray(v) || v.length > 50) return refus("group_map.map", "50 correspondances au plus");
  return v.map((x) => {
    const o = objet(x, "group_map.map", ["external", "group_id"]);
    return {
      external: texte(o["external"], "group_map.map.external", 1, 512),
      group_id: entier(o["group_id"], "group_map.map.group_id", 1, 2 ** 31),
    };
  });
}

const CLES_COMMUNES = [
  "id",
  "type",
  "label",
  "enabled",
  "preset",
  "ca_pem",
  "required_groups",
  "roles",
  "group_map",
  "freshness_days",
] as const;
const CLES_LDAP = [
  "urls",
  "bind_dn",
  "user_base_dn",
  "user_filter",
  "attrs",
  "groups",
  "max_failures",
  "failure_window_sec",
  "timeout_sec",
] as const;
const CLES_OIDC = [
  "issuer",
  "client_id",
  "client_auth",
  "scopes",
  "subject_claim",
  "username_claim",
  "email_claim",
  "name_claim",
  "groups_claim",
  "required_acr",
  "required_amr",
  "max_age_sec",
  "clock_skew_sec",
  "session_max_age_sec",
  "logout",
] as const;

function communs(o: Record<string, unknown>): FournisseurCommun {
  const roles = objet(o["roles"], "roles", ["enabled", "admin_groups", "moderator_groups"]);
  const carte = objet(o["group_map"], "group_map", ["enabled", "map"]);
  const id = o["id"];
  if (typeof id !== "string" || !REGEX_ID.test(id))
    return refus("id", "minuscules, chiffres et tirets, 31 caractères au plus");
  const preset = texte(o["preset"], "preset", 0, 40);
  if (!/^[A-Za-z0-9_.-]*$/u.test(preset)) refus("preset", "lettres, chiffres, point, tiret ou soulignement");
  return {
    id,
    type: choix(o["type"], "type", ["ldap", "oidc"] as const),
    label: texte(typeof o["label"] === "string" ? o["label"].trim() : o["label"], "label", 1, 40),
    enabled: booleen(o["enabled"], "enabled"),
    preset,
    ca_pem: certificats(o["ca_pem"]),
    required_groups: listeTextes(o["required_groups"], "required_groups", 20, 512),
    roles: {
      enabled: booleen(roles["enabled"], "roles.enabled"),
      admin_groups: listeTextes(roles["admin_groups"], "roles.admin_groups", 20, 512),
      moderator_groups: listeTextes(roles["moderator_groups"], "roles.moderator_groups", 20, 512),
    },
    group_map: {
      enabled: booleen(carte["enabled"], "group_map.enabled"),
      map: correspondances(carte["map"]),
    },
    freshness_days: entier(o["freshness_days"], "freshness_days", 1, 90),
  };
}

function ldap(o: Record<string, unknown>, c: FournisseurCommun): FournisseurLdap {
  const urls = o["urls"];
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 3)
    return refus("urls", "1 à 3 adresses ldaps://");
  const adresses = urls.map(adresseLdaps);
  if (new Set(adresses.map(hotePortLdaps)).size !== adresses.length) refus("urls", "adresses en double");
  const filtre = texte(o["user_filter"], "user_filter", 1, 512);
  if (filtre.split("{username}").length !== 2 || !filtre.startsWith("(") || !filtre.endsWith(")"))
    refus("user_filter", "filtre entre parenthèses contenant une fois {username}");
  const attrs = objet(o["attrs"], "attrs", ["id", "username", "email", "name"]);
  const groupes = objet(o["groups"], "groups", ["mode"]);
  return {
    ...c,
    type: "ldap",
    urls: adresses,
    bind_dn: texte(o["bind_dn"], "bind_dn", 1, 512),
    user_base_dn: texte(o["user_base_dn"], "user_base_dn", 1, 512),
    user_filter: filtre,
    attrs: {
      id: nomAttribut(attrs["id"], "attrs.id"),
      username: nomAttribut(attrs["username"], "attrs.username"),
      email: nomAttribut(attrs["email"], "attrs.email"),
      name: nomAttribut(attrs["name"], "attrs.name"),
    },
    groups: { mode: choix(groupes["mode"], "groups.mode", ["memberof", "chain", "member"] as const) },
    max_failures: entier(o["max_failures"], "max_failures", 1, 20),
    failure_window_sec: entier(o["failure_window_sec"], "failure_window_sec", 60, 86_400),
    timeout_sec: entier(o["timeout_sec"], "timeout_sec", 2, 30),
  };
}

function oidc(o: Record<string, unknown>, c: FournisseurCommun): FournisseurOidc {
  const portees = o["scopes"];
  if (!Array.isArray(portees) || portees.length < 1 || portees.length > 20)
    return refus("scopes", "1 à 20 portées dont openid");
  const scopes = portees.map((p) => {
    if (typeof p !== "string" || p.length > 128 || !REGEX_JETON_SCOPE.test(p))
      return refus("scopes", "portée invalide");
    return p;
  });
  if (!scopes.includes("openid")) refus("scopes", "la portée openid est obligatoire");
  const deconnexion = objet(o["logout"], "logout", ["rp_initiated", "backchannel"]);
  return {
    ...c,
    type: "oidc",
    issuer: adresseIssuer(o["issuer"]),
    client_id: texte(o["client_id"], "client_id", 1, 256),
    client_auth: choix(o["client_auth"], "client_auth", ["basic", "post"] as const),
    scopes: [...new Set(scopes)],
    subject_claim: nomRevendication(o["subject_claim"], "subject_claim"),
    username_claim: nomRevendication(o["username_claim"], "username_claim"),
    email_claim: nomRevendication(o["email_claim"], "email_claim"),
    name_claim: nomRevendication(o["name_claim"], "name_claim"),
    groups_claim: nomRevendication(o["groups_claim"], "groups_claim"),
    required_acr: listeTextes(o["required_acr"], "required_acr", 10, 128),
    required_amr: listeTextes(o["required_amr"], "required_amr", 10, 128),
    max_age_sec: entier(o["max_age_sec"], "max_age_sec", 0, 604_800),
    clock_skew_sec: entier(o["clock_skew_sec"], "clock_skew_sec", 0, 300),
    session_max_age_sec: entier(o["session_max_age_sec"], "session_max_age_sec", 0, 2_592_000),
    logout: {
      rp_initiated: booleen(deconnexion["rp_initiated"], "logout.rp_initiated"),
      backchannel: booleen(deconnexion["backchannel"], "logout.backchannel"),
    },
  };
}

/** Fournisseur complet validé strictement (toute clé inconnue, valeur fausse ou hors borne : 400) ; un champ absent n'a pas de défaut ici. */
export function validerFournisseur(brut: unknown): Fournisseur {
  const type = estDict(brut) ? brut["type"] : undefined;
  if (type !== "ldap" && type !== "oidc") return refus("type", "ldap ou oidc");
  const o = objet(brut, "fournisseur", [...CLES_COMMUNES, ...(type === "ldap" ? CLES_LDAP : CLES_OIDC)]);
  const c = communs(o);
  return type === "ldap" ? ldap(o, c) : oidc(o, c);
}

/** Valeurs de départ d'un fournisseur créé : un champ qu'elles fixent peut être omis de la requête. */
export function defautsFournisseur(type: "ldap" | "oidc"): Record<string, unknown> {
  const commun = {
    type,
    enabled: false,
    preset: "",
    ca_pem: "",
    required_groups: [],
    roles: { enabled: false, admin_groups: [], moderator_groups: [] },
    group_map: { enabled: false, map: [] },
    freshness_days: BORNES_AUTH.freshness_days.default,
  };
  if (type === "ldap")
    return {
      ...commun,
      attrs: { id: "entryUUID", username: "uid", email: "mail", name: "cn" },
      groups: { mode: "memberof" },
      max_failures: BORNES_AUTH.max_failures.default,
      failure_window_sec: BORNES_AUTH.failure_window_sec.default,
      timeout_sec: BORNES_AUTH.timeout_sec.default,
    };
  return {
    ...commun,
    client_auth: "basic",
    scopes: ["openid", "profile", "email"],
    subject_claim: "sub",
    username_claim: "preferred_username",
    email_claim: "email",
    name_claim: "name",
    groups_claim: "groups",
    required_acr: [],
    required_amr: [],
    max_age_sec: 0,
    clock_skew_sec: BORNES_AUTH.clock_skew_sec.default,
    session_max_age_sec: 0,
    logout: { rp_initiated: false, backchannel: false },
  };
}

/** Fusion d'une requête sur des valeurs de départ : les objets imbriqués sont fusionnés clé à clé, le reste est remplacé. */
export function fusionner(
  base: Record<string, unknown>,
  ajout: Record<string, unknown>,
): Record<string, unknown> {
  const sortie: Record<string, unknown> = { ...base };
  for (const [cle, v] of Object.entries(ajout)) {
    const avant = sortie[cle];
    sortie[cle] = estDict(v) && estDict(avant) ? { ...avant, ...v } : v;
  }
  return sortie;
}

/** Corps de création validé : le fournisseur est toujours éteint ; 400 sur tout autre état demandé. */
export function validerCreation(corps: unknown): Fournisseur {
  if (!estDict(corps)) return refus("corps", "objet attendu");
  const type = corps["type"];
  if (type !== "ldap" && type !== "oidc") return refus("type", "ldap ou oidc");
  if (Object.hasOwn(corps, "enabled") && corps["enabled"] !== false)
    throw new HttpError(400, "Un fournisseur est créé éteint.");
  return validerFournisseur(fusionner(defautsFournisseur(type), corps));
}

/** Modification validée : champs de la requête fusionnés sur le fournisseur actuel, `id` et `type` jamais changés ; `enabled` ne passe que par les routes d'activation. */
export function validerModification(corps: unknown, actuel: Fournisseur): Fournisseur {
  if (!estDict(corps)) return refus("corps", "objet attendu");
  if (Object.hasOwn(corps, "id") && corps["id"] !== actuel.id)
    throw new HttpError(400, "L'identifiant ne se modifie pas.");
  if (Object.hasOwn(corps, "type") && corps["type"] !== actuel.type)
    throw new HttpError(400, "Le type ne se modifie pas.");
  if (Object.hasOwn(corps, "enabled") && corps["enabled"] !== actuel.enabled)
    throw new HttpError(400, "L'activation passe par les actions Activer et Désactiver.");
  return validerFournisseur(fusionner(actuel as unknown as Record<string, unknown>, corps));
}

/** Réglages généraux d'une requête appliqués aux actuels (champs absents gardés) ; 400 sur une clé inconnue ou une valeur fausse. */
export function validerReglagesGeneraux(
  corps: unknown,
  actuels: Pick<ReglagesAuth, "public_url" | "local">,
): { public_url: string; local: { mode: ModeLocal } } {
  const o = objet(corps, "corps", ["public_url", "local"]);
  let publicUrl = actuels.public_url;
  let mode = actuels.local.mode;
  if (Object.hasOwn(o, "public_url")) {
    const brut = o["public_url"];
    const n = brut === "" ? "" : origineHttps(brut);
    if (n === null) return refus("public_url", "vide, ou une origine https sans chemin ni identifiants");
    publicUrl = n;
  }
  if (Object.hasOwn(o, "local"))
    mode = choix(objet(o["local"], "local", ["mode"])["mode"], "local.mode", ["all", "admins"] as const);
  return { public_url: publicUrl, local: { mode } };
}

/** Réglages lus d'une section : tolérant (section absente ou corrompue : réglages d'aujourd'hui), fournisseurs invalides mis à part. */
export function reglagesAuthDepuis(section: unknown): ReglagesAuthLus {
  const d = estDict(section) ? section : {};
  const local = estDict(d["local"]) ? d["local"] : {};
  const liste = Array.isArray(d["providers"]) ? d["providers"] : [];
  const lus: ReglagesAuthLus = {
    public_url: origineHttps(d["public_url"]) ?? "",
    local: { mode: local["mode"] === "admins" ? "admins" : "all" },
    providers: [],
    invalides: [],
  };
  for (const brut of liste.slice(0, FOURNISSEURS_MAX + 20)) {
    try {
      const f = validerFournisseur(brut);
      if (lus.providers.some((p) => p.id === f.id)) throw new HttpError(400, "doublon");
      lus.providers.push(f);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      const o = estDict(brut) ? brut : {};
      lus.invalides.push({
        id: typeof o["id"] === "string" ? o["id"].slice(0, 64) : null,
        label: typeof o["label"] === "string" ? o["label"].slice(0, 40) : null,
        enabled: o["enabled"] === true,
      });
    }
  }
  if (lus.providers.length > FOURNISSEURS_MAX) lus.providers.length = FOURNISSEURS_MAX;
  return lus;
}

/** Réglages `auth` relus à chaud de config.json. */
export function lireReglagesAuth(): ReglagesAuthLus {
  return reglagesAuthDepuis(liveConfigValue("auth", {}));
}
