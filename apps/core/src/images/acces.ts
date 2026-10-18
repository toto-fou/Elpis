// SPDX-License-Identifier: MIT
/** apps/core/src/images/acces.ts — qui peut générer (instance, groupes autorisés, cases du compte) et préférences ramenées aux limites du moteur (shared_infra/image/access.py). */
import { getUserGroups, getUserSettings, ligneUtilisateur } from "@elpis/auth";
import { ErreurPython, estDict, getOu, intPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Executeur } from "@elpis/db";

import { journal } from "../journal";
import { effectiveMaxN, getImageConfig, imageReady, RATIOS, sidesFor } from "./config";
import type { ConfigImage } from "./config";

const log = journal("image");

export const PREFS_DEFAULTS = { ratio: "1:1", side: 1024, n: 1, enhance: false } as const;

export type PrefsImage = { ratio: string; side: number; n: number; enhance: boolean };

/** Le compte est-il dans un groupe autorisé (ou l'accès ouvert) ? Groupes illisibles : refus journalisé. */
export async function userAllowed(
  base: Executeur,
  userId: number,
  cfg?: ConfigImage | null,
): Promise<boolean> {
  const c = cfg ?? getImageConfig();
  const groupes = new Set(c.groups);
  if (groupes.size === 0) return true;
  let miens: Set<number>;
  try {
    const row = await ligneUtilisateur(base, Math.trunc(userId));
    if (row !== undefined && Number(row["is_admin"]) === 1) return true;
    miens = new Set((await getUserGroups(base, Math.trunc(userId))).map((g) => intPy(g.id)));
  } catch (e) {
    log.warn({ err: e }, `groupes du compte ${userId} illisibles : accès refusé`);
    return false;
  }
  return [...miens].some((g) => groupes.has(g));
}

/** Moteur prêt ET compte autorisé : ce que le compte peut se voir proposer. */
export async function readyFor(base: Executeur, userId: number, cfg?: ConfigImage | null): Promise<boolean> {
  const c = cfg ?? getImageConfig();
  return imageReady(c) && (await userAllowed(base, userId, c));
}

/** Réglages du compte, ou `null` s'ils sont illisibles. */
export async function readSettings(base: Executeur, userId: number): Promise<Dict | null> {
  try {
    return await getUserSettings(base, Math.trunc(userId), (m) => log.error(m));
  } catch (e) {
    log.warn({ err: e }, `réglages du compte ${userId} illisibles`);
    return null;
  }
}

/** Case « Images » du compte (cochée par défaut) ; réglages illisibles : non. */
export function enabledIn(settings: Dict | null): boolean {
  return settings !== null && getOu(settings, "image_enabled", null) !== false;
}

/** Case « Par le modèle », sous la case « Images ». */
export function toolEnabledIn(settings: Dict | null): boolean {
  return settings !== null && enabledIn(settings) && getOu(settings, "image_tool_enabled", null) !== false;
}

/** `int(v)` ; TypeError, ValueError et OverflowError donnent `null`. */
function entierOuNul(v: unknown): number | null {
  try {
    return intPy(v);
  } catch (e) {
    if (e instanceof ErreurPython && ["TypeError", "ValueError", "OverflowError"].includes(e.type))
      return null;
    throw e;
  }
}

/** Préférences du compte ramenées aux limites du moteur : format connu, taille proposée la plus proche, nombre borné. */
export function cleanPrefs(raw: unknown, cfg?: ConfigImage | null): PrefsImage {
  const c = cfg ?? getImageConfig();
  const brut: Dict = estDict(raw) ? raw : {};
  const choix = getOu(brut, "ratio", null);
  let ratio = stripPy(strPy(veritePy(choix) ? choix : ""));
  if (!(RATIOS as readonly string[]).includes(ratio)) ratio = PREFS_DEFAULTS.ratio;
  const cotes = sidesFor(c);
  const brutCote = getOu(brut, "side", null);
  const entier = entierOuNul(brutCote) ?? (c.default_side || PREFS_DEFAULTS.side);
  const voulu =
    typeof brutCote === "bigint"
      ? brutCote
      : Number.isFinite(entier)
        ? BigInt(entier)
        : (entier > 0 ? 1n : -1n) << 1100n;
  const ecart = (s: number): bigint => (BigInt(s) > voulu ? BigInt(s) - voulu : voulu - BigInt(s));
  let side = cotes[0] ?? c.max_side;
  for (const s of cotes) if (ecart(s) < ecart(side) || (ecart(s) === ecart(side) && s < side)) side = s;
  const n = Math.max(1, Math.min(entierOuNul(getOu(brut, "n", null)) ?? 1, effectiveMaxN(c)));
  return { ratio, side, n, enhance: getOu(brut, "enhance", null) === true };
}
