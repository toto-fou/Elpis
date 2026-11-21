// SPDX-License-Identifier: MIT
/** apps/core/src/identite/reglages.ts — réglages `config.json › auth` : types, lecteur tolérant lu à chaud et validateur strict des écritures. */
import { createHash, X509Certificate } from "node:crypto";

import { DUREE_MAX_SESSION_S } from "@elpis/auth";
import { estDict, FlottantPy, HttpError } from "@elpis/commun";
import { configView, gelerProfond } from "@elpis/config";
import { REGEX_ID_FOURNISSEUR } from "@elpis/contracts";

export const FOURNISSEURS_MAX = 5;
export const CA_PEM_MAX = 64 * 1024;
const CONTROLE = /\p{Cc}/u;
const REGEX_REVENDICATION = /^[A-Za-z0-9_.:-]{1,64}$/u;
const REGEX_JETON_SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
const REGEX_PEM = /^\s*(?:-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/u;
export const BLOC_PEM = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/gu;

export const ALGORITHMES_JETON = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;
export type AlgorithmeJeton = (typeof ALGORITHMES_JETON)[number];

export type ModeLocal = "all" | "admins";

export interface CorrespondanceGroupe {
  external: string;
  group_id: number;
}

export interface Fournisseur {
  id: string;
  type: "oidc";
  label: string;
  enabled: boolean;
  ca_pem: string;
  required_groups: string[];
  roles: { enabled: boolean; admin_groups: string[]; moderator_groups: string[] };
  group_map: { enabled: boolean; map: CorrespondanceGroupe[] };
  freshness_days: number;
  issuer: string;
  client_id: string;
  client_auth: "basic" | "post";
  id_token_alg: AlgorithmeJeton;
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
  label: { min: 1, max: 40 },
  required_groups_max: 20,
  freshness_days: { min: 1, max: 90, default: 14 },
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

function listeSansDoublon(v: unknown, nom: string, max: number, longueur: number): string[] {
  const sortie = listeTextes(v, nom, max, longueur);
  if (Array.isArray(v) && sortie.length !== v.length) return refus(nom, "valeurs en double");
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

function nomRevendication(v: unknown, nom: string): string {
  if (typeof v !== "string" || !REGEX_REVENDICATION.test(v) || nomDePrototype(v))
    return refus(nom, "nom de revendication attendu (lettres, chiffres, _, -, . ou :)");
  return v;
}

function correspondances(v: unknown): CorrespondanceGroupe[] {
  if (!Array.isArray(v) || v.length > 50) return refus("group_map.map", "50 correspondances au plus");
  const vues = new Set<string>();
  return v.map((x) => {
    const o = objet(x, "group_map.map", ["external", "group_id"]);
    const c = {
      external: texte(o["external"], "group_map.map.external", 1, 512),
      group_id: entier(o["group_id"], "group_map.map.group_id", 1, 2 ** 31),
    };
    const cle = JSON.stringify([c.external, c.group_id]);
    if (vues.has(cle)) return refus("group_map.map", "correspondance en double");
    vues.add(cle);
    return c;
  });
}

function portees(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20)
    return refus("scopes", "1 à 20 portées dont openid");
  const scopes = v.map((p) => {
    if (typeof p !== "string" || p.length > 128 || !REGEX_JETON_SCOPE.test(p))
      return refus("scopes", "portée invalide");
    return p;
  });
  if (!scopes.includes("openid")) refus("scopes", "la portée openid est obligatoire");
  return [...new Set(scopes)];
}

function deconnexion(v: unknown): Fournisseur["logout"] {
  const o = objet(v, "logout", ["rp_initiated", "backchannel"]);
  return {
    rp_initiated: booleen(o["rp_initiated"], "logout.rp_initiated"),
    backchannel: booleen(o["backchannel"], "logout.backchannel"),
  };
}

const CLES_FOURNISSEUR = [
  "id",
  "type",
  "label",
  "enabled",
  "ca_pem",
  "required_groups",
  "roles",
  "group_map",
  "freshness_days",
  "issuer",
  "client_id",
  "client_auth",
  "id_token_alg",
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

function fournisseurDe(o: Record<string, unknown>): Fournisseur {
  const roles = objet(o["roles"], "roles", ["enabled", "admin_groups", "moderator_groups"]);
  const carte = objet(o["group_map"], "group_map", ["enabled", "map"]);
  const id = o["id"];
  if (typeof id !== "string" || !REGEX_ID_FOURNISSEUR.test(id))
    return refus("id", "minuscules, chiffres et tirets, 31 caractères au plus");
  return {
    id,
    type: choix(o["type"], "type", ["oidc"] as const),
    label: texte(typeof o["label"] === "string" ? o["label"].trim() : o["label"], "label", 1, 40),
    enabled: booleen(o["enabled"], "enabled"),
    ca_pem: certificats(o["ca_pem"]),
    required_groups: listeTextes(o["required_groups"], "required_groups", 20, 512),
    roles: {
      enabled: booleen(roles["enabled"], "roles.enabled"),
      admin_groups: listeSansDoublon(roles["admin_groups"], "roles.admin_groups", 20, 512),
      moderator_groups: listeSansDoublon(roles["moderator_groups"], "roles.moderator_groups", 20, 512),
    },
    group_map: {
      enabled: booleen(carte["enabled"], "group_map.enabled"),
      map: correspondances(carte["map"]),
    },
    freshness_days: entier(o["freshness_days"], "freshness_days", 1, 90),
    issuer: adresseIssuer(o["issuer"]),
    client_id: texte(o["client_id"], "client_id", 1, 256),
    client_auth: choix(o["client_auth"], "client_auth", ["basic", "post"] as const),
    id_token_alg: choix(o["id_token_alg"], "id_token_alg", ALGORITHMES_JETON),
    scopes: portees(o["scopes"]),
    subject_claim: nomRevendication(o["subject_claim"], "subject_claim"),
    username_claim: nomRevendication(o["username_claim"], "username_claim"),
    email_claim: nomRevendication(o["email_claim"], "email_claim"),
    name_claim: nomRevendication(o["name_claim"], "name_claim"),
    groups_claim: nomRevendication(o["groups_claim"], "groups_claim"),
    required_acr: listeTextes(o["required_acr"], "required_acr", 10, 128),
    required_amr: listeTextes(o["required_amr"], "required_amr", 10, 128),
    max_age_sec: entier(o["max_age_sec"], "max_age_sec", 0, 604_800),
    clock_skew_sec: entier(o["clock_skew_sec"], "clock_skew_sec", 0, 300),
    session_max_age_sec: entier(o["session_max_age_sec"], "session_max_age_sec", 0, DUREE_MAX_SESSION_S),
    logout: deconnexion(o["logout"]),
  };
}

/** Fournisseur complet validé strictement (toute clé inconnue, valeur fausse ou hors borne : 400) ; un champ absent n'a pas de défaut ici. */
export function validerFournisseur(brut: unknown): Fournisseur {
  return fournisseurDe(objet(brut, "fournisseur", CLES_FOURNISSEUR));
}

/** Valeurs de départ d'un fournisseur créé : un champ qu'elles fixent peut être omis de la requête. */
export function defautsFournisseur(): Record<string, unknown> {
  return {
    type: "oidc",
    enabled: false,
    ca_pem: "",
    required_groups: [],
    roles: { enabled: false, admin_groups: [], moderator_groups: [] },
    group_map: { enabled: false, map: [] },
    freshness_days: BORNES_AUTH.freshness_days.default,
    client_auth: "basic",
    id_token_alg: "RS256",
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
  if (corps["type"] !== "oidc") return refus("type", "oidc");
  if (Object.hasOwn(corps, "enabled") && corps["enabled"] !== false)
    throw new HttpError(400, "Un fournisseur est créé éteint.");
  return validerFournisseur(fusionner(defautsFournisseur(), corps));
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

const lus = new WeakMap<object, ReglagesAuthLus>();

/** Réglages `auth` relus à chaud de config.json, validés une fois par instantané de la configuration (gelés). */
export function lireReglagesAuth(): ReglagesAuthLus {
  const vue = configView();
  let r = lus.get(vue);
  if (r === undefined) {
    r = gelerProfond(reglagesAuthDepuis(vue["auth"] ?? {}));
    lus.set(vue, r);
  }
  return r;
}
