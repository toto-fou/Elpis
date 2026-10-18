// SPDX-License-Identifier: MIT
/** apps/core/src/admin/aides.ts — aides des routes de la console : paramètre de requête, entiers et textes à la Python, config.json relue sur disque, audit. */
import { ErreurPython, estDict, FlottantPy, HttpError, intPy, nomTypePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { CONFIG_ILLISIBLE, lireConfigDisque } from "@elpis/config";
import { auditEvent } from "@elpis/securite";
import type { FastifyRequest } from "fastify";

const SUR_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const HORS_BORNES = "Paramètre hors bornes.";

/** `int(v)` exact (bigint au-delà de 2^53) ; l'OverflowError devient le 400 du gestionnaire de server/app.py. */
export function entierPy(v: unknown): number | bigint {
  if (typeof v === "bigint") return v;
  const x = v instanceof FlottantPy ? v.valeur : v;
  let n: number;
  try {
    n = intPy(x);
  } catch (e) {
    if (e instanceof ErreurPython && e.type === "OverflowError") throw new HttpError(400, HORS_BORNES);
    throw e;
  }
  if (Number.isSafeInteger(n)) return n;
  if (typeof x === "number") return BigInt(Math.trunc(x));
  if (typeof x === "string") {
    const ascii = x.trim().replaceAll("_", "");
    if (/^[+-]?\d+$/u.test(ascii)) return BigInt(ascii);
  }
  return n;
}

/** Identifiant passé à la base : au-delà de 2^53 (OverflowError du pilote au-delà de 64 bits en Python), 400 « Paramètre hors bornes. ». */
export function entierBase(v: number | bigint): number {
  const b = BigInt(v);
  if (b > SUR_MAX || b < -SUR_MAX) throw new HttpError(400, HORS_BORNES);
  return Number(b);
}

/** `v.strip()` sur une valeur reçue : AttributeError (500) si ce n'est pas un texte. */
export function exigerTexte(v: unknown): string {
  if (typeof v !== "string")
    throw new ErreurPython("AttributeError", `'${nomTypePy(v)}' object has no attribute 'strip'`);
  return v;
}

/** `d.get(cle)` avec une clé non hachable (liste, dict) : TypeError (500) comme en Python. */
export function exigerHachable(v: unknown): void {
  if (Array.isArray(v) || estDict(v))
    throw new ErreurPython("TypeError", `unhashable type: '${nomTypePy(v)}'`);
}

/** `{"admin": 1, "moderator": 2, "user": 0}.get(role, 0)`. */
export function niveauDuRole(role: unknown): number {
  exigerHachable(role);
  return role === "admin" ? 1 : role === "moderator" ? 2 : 0;
}

/** config.json à réécrire : illisible = 500, jamais écrasé par une config vide (le Python le remplaçait). */
export function lireConfigPourEcrire(): Dict {
  const cfg = lireConfigDisque();
  if (cfg === null) throw new HttpError(500, CONFIG_ILLISIBLE);
  return cfg;
}

/** `audit_event(user_id=request.state.user_id, username=request.state.username, …)`. */
export function auditer(requete: FastifyRequest, action: string, details: Dict): void {
  auditEvent({
    userId: requete.utilisateur?.id ?? null,
    username: requete.utilisateur?.username ?? null,
    action,
    details,
  });
}
