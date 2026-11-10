// SPDX-License-Identifier: MIT
/** apps/core/src/secrets/portee.ts — règles d'un secret : nom (slug), portée selon le genre (origines exactes, hôte, connecteur, serveur), politique, identifiant, valeur, métadonnées, AAD. */
import {
  GENRES_SECRET,
  ORIGINES_SECRET_MAX,
  POLITIQUE_SECRET_DEFAUT,
  RE_NOM_SECRET,
  VALEUR_SECRET_MAX,
} from "@elpis/contracts";
import type { GenreSecret, PolitiqueSecret, PorteeSecret } from "@elpis/contracts";

import { ErreurSecret } from "./erreurs";

const IDENTIFIANT_MAX = 256;
const META_MAX = 4096;
const SERVEUR = /^[\x21-\x7e]{1,128}$/u;
const HOTE_PORT = /^(\[[0-9A-Fa-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/u;
const CONTROLE = /\p{Cc}/u;

export function estGenre(v: unknown): v is GenreSecret {
  return typeof v === "string" && (GENRES_SECRET as readonly string[]).includes(v);
}

/** Genres dont la portée est une liste d'origines exactes. */
export function parOrigines(genre: GenreSecret): boolean {
  return genre === "web-login" || genre === "http-auth";
}

export function validerNom(brut: unknown): string {
  if (typeof brut !== "string" || !RE_NOM_SECRET.test(brut))
    throw new ErreurSecret(
      422,
      "secret_name_invalid",
      "Invalid name: 1 to 48 characters among a-z, 0-9, '.', '_' and '-', starting with a letter or a digit.",
    );
  return brut;
}

/** Origine exacte `scheme://host[:port]` d'une adresse http(s) (WHATWG : hôte en minuscules et punycode, port par défaut omis), comme `origineExacte` du navigateur ; `null` sinon. */
export function origineExacte(adresse: string): string | null {
  const brut = adresse.trim();
  if (!brut || brut.length > 2048 || !URL.canParse(brut)) return null;
  const u = new URL(brut);
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
  return u.origin;
}

/** Origine saisie dans une portée : une origine seule (ni compte, ni chemin, ni requête, ni fragment), normalisée. */
function origineDePortee(brut: string): string | null {
  const t = brut.trim();
  if (!t || t.length > 2048 || !URL.canParse(t)) return null;
  const u = new URL(t);
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  return t.endsWith("?") || t.endsWith("#") ? null : u.origin;
}

/** `hôte[:port]` d'un dépôt git : hôte normalisé par WHATWG (minuscules, punycode), port gardé tel quel (1 à 65535). */
export function hoteExact(brut: string): string | null {
  const t = brut.trim();
  const m = t.length <= 300 && !/[\s/?#@\\]/u.test(t) ? HOTE_PORT.exec(t) : null;
  if (m === null || !URL.canParse(`http://${m[1] ?? ""}/`)) return null;
  const u = new URL(`http://${m[1] ?? ""}/`);
  if (!u.hostname) return null;
  const port = m[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535 || port.startsWith("0"))) return null;
  return port === undefined ? u.hostname : `${u.hostname}:${port}`;
}

function refusPortee(message: string): ErreurSecret {
  return new ErreurSecret(422, "secret_scope_invalid", message);
}

/** Portée validée et normalisée selon le genre. */
export function normaliserPortee(genre: GenreSecret, brut: unknown): PorteeSecret {
  const objet: unknown = brut === undefined && genre === "token" ? {} : brut;
  if (typeof objet !== "object" || objet === null || Array.isArray(objet))
    throw refusPortee("Invalid scope: an object is expected.");
  const p = objet as Record<string, unknown>;
  const cles = Object.keys(p);
  if (parOrigines(genre)) {
    const brutes = p["origins"];
    if (cles.length !== 1 || !Array.isArray(brutes) || brutes.length === 0)
      throw refusPortee(
        "Invalid scope: 'origins' must list one or more exact origins (scheme://host[:port]).",
      );
    const origines: string[] = [];
    for (const o of brutes) {
      const n = typeof o === "string" ? origineDePortee(o) : null;
      if (n === null)
        throw refusPortee(
          "Invalid scope: each origin is http(s)://host[:port], without user, path, query or fragment.",
        );
      if (!origines.includes(n)) origines.push(n);
    }
    if (origines.length > ORIGINES_SECRET_MAX)
      throw refusPortee(`Invalid scope: ${ORIGINES_SECRET_MAX} origins at most.`);
    return { origins: origines };
  }
  if (genre === "git") {
    const hote = cles.length === 1 && typeof p["host"] === "string" ? hoteExact(p["host"]) : null;
    if (hote === null) throw refusPortee("Invalid scope: 'host' is a git host name, with an optional port.");
    return { host: hote };
  }
  if (genre === "llm") {
    const id = p["connector_id"];
    if (cles.length !== 1 || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      throw refusPortee("Invalid scope: 'connector_id' is the id of an LLM connector.");
    return { connector_id: id };
  }
  if (genre === "mcp") {
    const serveur = typeof p["server"] === "string" ? p["server"].trim() : "";
    if (cles.length !== 1 || !SERVEUR.test(serveur))
      throw refusPortee("Invalid scope: 'server' is the id of an MCP server.");
    return { server: serveur };
  }
  if (cles.length !== 0) throw refusPortee("Invalid scope: a token has no scope ({}).");
  return {};
}

/** La nouvelle portée donne accès à une cible que l'ancienne ne couvrait pas (origine ajoutée, autre hôte, connecteur ou serveur). */
export function elargit(genre: GenreSecret, avant: PorteeSecret, apres: PorteeSecret): boolean {
  if (parOrigines(genre)) {
    const anciennes = new Set(origines(avant));
    return origines(apres).some((o) => !anciennes.has(o));
  }
  return JSON.stringify(avant) !== JSON.stringify(apres);
}

export function origines(p: PorteeSecret): string[] {
  const o = (p as { origins?: unknown }).origins;
  return Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : [];
}

/** Politique complète : défauts, puis la politique enregistrée, puis les champs fournis (validés par le contrat). */
export function fusionnerPolitique(
  base: PolitiqueSecret,
  partielle: Partial<PolitiqueSecret> | undefined,
): PolitiqueSecret {
  return { ...POLITIQUE_SECRET_DEFAUT, ...base, ...(partielle ?? {}) };
}

/** Identifiant (non secret) : blancs retirés, vide = aucun ; 256 caractères au plus, sans caractère de contrôle. */
export function validerIdentifiant(brut: unknown): string | null {
  if (brut === null || brut === undefined) return null;
  const v = typeof brut === "string" ? brut.trim() : null;
  if (v === null || v.length > IDENTIFIANT_MAX || CONTROLE.test(v))
    throw new ErreurSecret(422, "secret_request_invalid", "Invalid username.");
  return v || null;
}

/** Valeur en écriture seule : texte non vide, bien formé, borné. */
export function validerValeur(brut: unknown): string {
  if (typeof brut !== "string" || brut === "")
    throw new ErreurSecret(422, "secret_value_required", "A secret value is required.");
  if (brut.length > VALEUR_SECRET_MAX || !brut.isWellFormed())
    throw new ErreurSecret(
      422,
      "secret_value_invalid",
      `Invalid secret value: ${VALEUR_SECRET_MAX} characters at most.`,
    );
  return brut;
}

/** Métadonnées non secrètes : un objet JSON de 4 Kio au plus. */
export function validerMeta(brut: unknown): Record<string, unknown> {
  if (brut === undefined || brut === null) return {};
  const ok = typeof brut === "object" && !Array.isArray(brut);
  if (!ok || JSON.stringify(brut).length > META_MAX)
    throw new ErreurSecret(422, "secret_meta_invalid", "Invalid meta: a JSON object of 4 KiB at most.");
  return brut as Record<string, unknown>;
}

/** Objet JSON enregistré, `{}` s'il est illisible. */
export function objetJson(texte: unknown): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(typeof texte === "string" ? texte : "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Politique enregistrée, champs illisibles remplacés par les défauts. */
export function lirePolitique(texte: unknown): PolitiqueSecret {
  const p = objetJson(texte);
  const d = POLITIQUE_SECRET_DEFAUT;
  const bool = (k: keyof PolitiqueSecret, defaut: boolean): boolean =>
    typeof p[k] === "boolean" ? (p[k] as boolean) : defaut;
  return {
    subagents: bool("subagents", d.subagents),
    routines: bool("routines", d.routines),
    confirm_first_use: bool("confirm_first_use", d.confirm_first_use),
    tls: p["tls"] === "insecure" ? "insecure" : "strict",
  };
}

/** AAD d'un secret : propriétaire (0 = instance), genre et nom ; un renommage rechiffre. */
export function aadSecret(proprietaire: number | null, genre: GenreSecret, nom: string): string {
  return `vault|v1|${proprietaire ?? 0}|${genre}|${nom}`;
}
