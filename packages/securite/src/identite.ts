// SPDX-License-Identifier: MIT
/** packages/securite/src/identite.ts — enveloppes d'identité signées, registre, identité courante. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";

import {
  comparePointsDeCode,
  ErreurPython,
  floatPy,
  intPy,
  pyJsonDumps,
  reprFlottant,
  strPy,
  stripPy,
} from "@elpis/commun";

import { urlsafeB64Decode, urlsafeB64EncodeSansRembourrage } from "./base64";
import { compareDigest } from "./mots-de-passe";
import { decoderUtf8Py, encoderUtf8Py, estDict, estErreurPython, getPy, ouPy } from "./outils";
import { comptesBranches } from "./ports";
import { lireSousAgent, sousAgentEnDict } from "./sous-agent";
import type { SousAgent } from "./sous-agent";

export const IDENTITY_HEADER = "x-elpis-identity";
export const MAX_SKEW_S = 60;
export const DELEGATION_HEADER = "x-elpis-mcp-client";
export const DELEGATION_AUDIENCE = "elpis-mcp";
export const REGISTRY_MAX = 2048;

/** Champs du dataclass Python (forme signée) ; `is_admin` : admin plein (== 1), jamais le modérateur ; `forced_network_profile_id` : imposition vue par main, `null` = non transmise ; `subagent` : périmètre d'un sous-agent (propre au TS). */
export interface Identity {
  user_id: number;
  username: string;
  roles: string[];
  network_profile_id: string;
  chat_id: string;
  is_admin: boolean;
  forced_network_profile_id: string | null;
  subagent?: SousAgent | null;
}

export type ChampsIdentite = Pick<Identity, "user_id" | "username"> & Partial<Identity>;

/** `Identity(...)` avec les défauts du dataclass. */
export function creerIdentite(champs: ChampsIdentite): Identity {
  return {
    user_id: champs.user_id,
    username: champs.username,
    roles: [...(champs.roles ?? [])],
    network_profile_id: champs.network_profile_id ?? "",
    chat_id: champs.chat_id ?? "",
    is_admin: champs.is_admin ?? false,
    forced_network_profile_id: champs.forced_network_profile_id ?? null,
    ...(champs.subagent ? { subagent: champs.subagent } : {}),
  };
}

/** `to_dict` : ordre des champs du dataclass ; sans imposition ni sous-agent, la forme signée reste celle d'avant ces champs. */
export function identityToDict(identite: Identity): Record<string, unknown> {
  return {
    user_id: identite.user_id,
    username: identite.username,
    roles: [...identite.roles],
    network_profile_id: identite.network_profile_id,
    chat_id: identite.chat_id,
    is_admin: identite.is_admin,
    ...(identite.forced_network_profile_id === null
      ? {}
      : { forced_network_profile_id: identite.forced_network_profile_id }),
    ...(identite.subagent ? { subagent: sousAgentEnDict(identite.subagent) } : {}),
  };
}

/** `Identity.from_dict` : `int()`, `str()`, `strip()` de Python ; `null` si id ≤ 0 ou nom vide. */
export function identityFromDict(d: Record<string, unknown>): Identity | null {
  let userId: number;
  let username: string;
  try {
    userId = intPy(getPy(d, "user_id"));
    username = stripPy(strPy(ouPy(getPy(d, "username"), "")));
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return null;
    throw e;
  }
  if (userId <= 0 || !username) return null;
  const roles = getPy(d, "roles");
  const admin = getPy(d, "is_admin");
  const impose = getPy(d, "forced_network_profile_id");
  return {
    user_id: userId,
    username,
    roles: Array.isArray(roles) ? roles.map(strPy) : [],
    network_profile_id: strPy(ouPy(getPy(d, "network_profile_id"), "")),
    chat_id: strPy(ouPy(getPy(d, "chat_id"), "")),
    is_admin: admin === 1 || admin === true,
    forced_network_profile_id: impose === null ? null : strPy(ouPy(impose, "")),
    ...avecSousAgent(getPy(d, "subagent")),
  };
}

/** Champ `subagent` lu s'il est porté (absent : la forme d'avant le champ). */
function avecSousAgent(brut: unknown): { subagent?: SousAgent } {
  const sa = lireSousAgent(brut);
  return sa === null ? {} : { subagent: sa };
}

/** Vue « ligne users » minimale. */
export function identityAsRow(identite: Identity): { id: number; username: string; is_admin: 0 | 1 } {
  return { id: identite.user_id, username: identite.username, is_admin: identite.is_admin ? 1 : 0 };
}

const contexte = new AsyncLocalStorage<Identity | null>();
const parId = new Map<number, Identity>();
const parNom = new Map<string, Identity>();

/** `set_current` … `reset_current` autour de `fn` (et tout ce qu'il lance) ; l'identité entre au registre. */
export function avecIdentite<T>(identite: Identity | null, fn: () => T): T {
  if (identite !== null) remember(identite);
  return contexte.run(identite, fn);
}

export function current(): Identity | null {
  return contexte.getStore() ?? null;
}

/** Au-delà de REGISTRY_MAX, le plus ancien quart (ordre d'insertion) est oublié. */
export function remember(identite: Identity): void {
  parId.set(identite.user_id, identite);
  parNom.set(identite.username, identite);
  if (parId.size > REGISTRY_MAX) {
    for (const id of Array.from(parId.keys()).slice(0, Math.floor(REGISTRY_MAX / 4))) {
      const ancienne = parId.get(id);
      parId.delete(id);
      if (ancienne !== undefined) parNom.delete(ancienne.username);
    }
  }
}

export function forgetAll(): void {
  parId.clear();
  parNom.clear();
}

/** `int(user_id)` : `null` sur TypeError ou ValueError, l'OverflowError traverse comme en Python. */
function idOuNull(userId: unknown): number | null {
  try {
    return intPy(userId);
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return null;
    throw e;
  }
}

/** Username d'un id : contexte courant, puis registre ; `null` = inconnu (l'appelant retombe sur la base). */
export function resolveUsername(userId: unknown): string | null {
  const uid = idOuNull(userId);
  if (uid === null) return null;
  const courant = current();
  if (courant !== null && courant.user_id === uid) return courant.username;
  return parId.get(uid)?.username ?? null;
}

export function resolveUser(username: unknown): Identity | null {
  const nom = stripPy(strPy(ouPy(username, "")));
  if (!nom) return null;
  const courant = current();
  if (courant !== null && courant.username === nom) return courant;
  return parNom.get(nom) ?? null;
}

/** Identité d'un id : contexte courant, puis registre. */
function identiteDuCompte(userId: unknown): Identity | null {
  const uid = idOuNull(userId);
  if (uid === null) return null;
  const courant = current();
  return courant !== null && courant.user_id === uid ? courant : (parId.get(uid) ?? null);
}

export function resolveNetworkProfileId(userId: unknown): string | null {
  return identiteDuCompte(userId)?.network_profile_id || null;
}

/** Imposition portée par l'enveloppe de main (`""` : aucune) ; `null` = non transmise, l'hôte lit sa base. */
export function resolveForcedNetworkProfileId(userId: unknown): string | null {
  return identiteDuCompte(userId)?.forced_network_profile_id ?? null;
}

/** `_username_for` des routes : identité, base, puis `user_<id>` (journaux, comparaisons de propriété). */
export async function usernameFor(userId: number): Promise<string> {
  try {
    return resolveUsername(userId) || (await comptesBranches()?.getUsernameById(userId)) || `user_${userId}`;
  } catch {
    return `user_${userId}`;
  }
}

/** `user_id_for` : id de l'identité (non nul), sinon de la base ; 0 si inconnu ou si la base échoue. */
export async function userIdFor(username: string): Promise<number> {
  const identite = resolveUser(username);
  if (identite !== null && identite.user_id) return identite.user_id;
  try {
    return (await comptesBranches()?.getUserIdByUsername(username)) || 0;
  } catch {
    return 0;
  }
}

/** `user_network_profile_id` : profil de l'identité, sinon de la base ; « isolated » en cas d'échec. */
export async function userNetworkProfileId(userId: number): Promise<string> {
  try {
    return (
      resolveNetworkProfileId(userId) || (await comptesBranches()?.getNetworkProfileId(userId)) || "isolated"
    );
  } catch {
    return "isolated";
  }
}

function maintenant(): number {
  return Date.now() / 1000;
}

const COMPACT = { separators: [",", ":"], sortKeys: true } as const;

/** `float` dans `json.dumps` : `repr` (`2.0`, `1e+16`, `-0.0`), et NaN/Infinity comme Python. */
function flottantJson(x: number): string {
  return Number.isFinite(x) ? reprFlottant(x) : pyJsonDumps(x);
}

/** `json.dumps(corps | {"ts": float(now)}, separators=(",", ":"), sort_keys=True)`, ASCII seulement. */
function corpsSigne(corps: Record<string, unknown>, ts: number): string {
  const cles = Object.keys(corps).filter((c) => c !== "ts" && corps[c] !== undefined);
  cles.push("ts");
  cles.sort(comparePointsDeCode);
  const parties = cles.map(
    (c) => `${pyJsonDumps(c)}:${c === "ts" ? flottantJson(ts) : pyJsonDumps(corps[c], COMPACT)}`,
  );
  return `{${parties.join(",")}}`;
}

function signer(corps: Record<string, unknown>, key: string, now: number | undefined): string {
  const brut = Buffer.from(corpsSigne(corps, now ?? maintenant()), "utf8");
  const mac = createHmac("sha256", encoderUtf8Py(key)).update(brut).digest();
  return `${urlsafeB64EncodeSansRembourrage(brut)}.${urlsafeB64EncodeSansRembourrage(mac)}`;
}

function b64d(s: string): Buffer {
  return urlsafeB64Decode(s + "=".repeat((4 - (s.length % 4)) % 4));
}

/** Corps signé, daté à `maxSkewS` près, d'audience `aud` si donnée ; `null` (jamais d'exception) sinon. */
function corpsVerifie(
  header: string | null | undefined,
  key: string | null | undefined,
  now: number | undefined,
  maxSkewS: number,
  aud: string | null,
): Record<string, unknown> | null {
  if (!header || !key || !header.includes(".")) return null;
  let brut: Buffer;
  let mac: Buffer;
  try {
    const point = header.indexOf(".");
    brut = b64d(header.slice(0, point));
    mac = b64d(header.slice(point + 1));
  } catch {
    return null;
  }
  const attendu = createHmac("sha256", encoderUtf8Py(key)).update(brut).digest();
  if (!compareDigest(mac, attendu)) return null;
  let corps: unknown;
  try {
    corps = JSON.parse(decoderUtf8Py(brut));
  } catch {
    return null;
  }
  if (!estDict(corps) || (aud !== null && getPy(corps, "aud") !== aud)) return null;
  let ts: number;
  try {
    ts = floatPy(getPy(corps, "ts"));
  } catch (e) {
    if (estErreurPython(e, "TypeError", "ValueError")) return null;
    throw e;
  }
  if (Math.abs((now ?? maintenant()) - ts) > maxSkewS) return null;
  return corps;
}

export interface OptionsSignature {
  now?: number;
}

export interface OptionsVerification {
  now?: number;
  maxSkewS?: number;
}

/** `<charge b64>.<hmac-sha256 b64>` : identité + `ts`, signée avec le jeton de service. */
export function sign(identity: Identity, key: string, options: OptionsSignature = {}): string {
  if (!key) throw new ErreurPython("ValueError", "jeton de service absent : impossible de signer l'identité");
  return signer(identityToDict(identity), key, options.now);
}

export function verify(
  header: string | null | undefined,
  key: string | null | undefined,
  options: OptionsVerification = {},
): Identity | null {
  const corps = corpsVerifie(header, key, options.now, options.maxSkewS ?? MAX_SKEW_S, null);
  return corps === null ? null : identityFromDict(corps);
}

/** `claims` + `aud` + `ts`, signés comme `sign` : l'audience lie l'enveloppe à son usage. */
export function signClaims(
  claims: Record<string, unknown>,
  key: string,
  options: OptionsSignature & { aud: string },
): string {
  if (!key) throw new ErreurPython("ValueError", "jeton de service absent : impossible de signer");
  return signer({ ...claims, aud: options.aud }, key, options.now);
}

export function verifyClaims(
  header: string | null | undefined,
  key: string | null | undefined,
  options: OptionsVerification & { aud: string },
): Record<string, unknown> | null {
  return corpsVerifie(header, key, options.now, options.maxSkewS ?? MAX_SKEW_S, options.aud);
}

function lireMeta(meta: unknown, cle: string): unknown {
  return typeof meta === "object" && meta !== null && Object.hasOwn(meta, cle)
    ? (meta as Record<string, unknown>)[cle]
    : null;
}

/** Identité du `_meta` d'un appel MCP : `username` requis, `user_id` à 0 s'il manque ou ne se lit pas, périmètre de sous-agent s'il est porté. */
export function fromMeta(meta: unknown): Identity | null {
  if (meta === null || meta === undefined) return null;
  const username = stripPy(strPy(ouPy(lireMeta(meta, "username"), "")));
  if (!username) return null;
  let userId: number;
  try {
    userId = intPy(ouPy(lireMeta(meta, "user_id"), 0));
  } catch (e) {
    if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    userId = 0;
  }
  return creerIdentite({
    user_id: userId,
    username,
    network_profile_id: strPy(ouPy(lireMeta(meta, "network_profile_id"), "")),
    chat_id: strPy(ouPy(lireMeta(meta, "chat_id"), "")),
    ...avecSousAgent(lireMeta(meta, "subagent")),
  });
}
