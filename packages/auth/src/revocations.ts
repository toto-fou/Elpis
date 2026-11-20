// SPDX-License-Identifier: MIT
/** packages/auth/src/revocations.ts — révocation des sessions : par `_sid` (déconnexion) et par compte (`session_min_ts`). */
import { intPy } from "@elpis/commun";
import type { Executeur } from "@elpis/db";

import { lire, sousObjet } from "./dict";

function sid128(sid: string): string {
  return Array.from(sid).slice(0, 128).join("");
}

/** Range le `_sid` révoqué avec l'échéance figée de sa session (`expiresAt`, 0 si inconnue). */
export async function revoquerSid(
  x: Executeur,
  sid: string,
  userId: number | null,
  ts: number,
  expiresAt = 0,
): Promise<boolean> {
  if (!sid) return false;
  await x.run(
    "INSERT INTO revoked_sessions (sid, user_id, revoked_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(sid) DO NOTHING",
    [sid128(sid), userId, ts, Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0],
  );
  return true;
}

export async function estRevoquee(x: Executeur, sid: string): Promise<boolean> {
  if (!sid) return false;
  return (await x.get("SELECT 1 AS un FROM revoked_sessions WHERE sid=?", [sid128(sid)])) !== undefined;
}

/** Supprime les révocations dont la session a expiré (échéance + marge) ; une ligne sans échéance connue part quand sa révocation date de plus que `dureeMaxS` (aucune session n'a pu lui survivre), jamais si `dureeMaxS` est absent. */
export async function purgerRevocations(
  x: Executeur,
  maintenant: number,
  margeS = 0,
  dureeMaxS?: number,
): Promise<number> {
  const marge = Math.max(0, margeS);
  const connues = await x.run("DELETE FROM revoked_sessions WHERE expires_at > 0 AND expires_at < ?", [
    maintenant - marge,
  ]);
  if (dureeMaxS === undefined) return connues.changes;
  const inconnues = await x.run("DELETE FROM revoked_sessions WHERE expires_at = 0 AND revoked_at < ?", [
    maintenant - marge - dureeMaxS,
  ]);
  return connues.changes + inconnues.changes;
}

/** `bump_session_min_ts` : toute session ouverte avant `ts` est refusée et leurs lignes de session du fournisseur d'identité sont supprimées ; la coupure ne baisse jamais (condition dans la requête). */
export async function leverMinSession(x: Executeur, userId: number, ts: number): Promise<boolean> {
  const r = await x.run(
    "UPDATE users SET session_min_ts=? WHERE id=? AND (session_min_ts IS NULL OR session_min_ts < ?)",
    [ts, userId, ts],
  );
  await x.run("DELETE FROM auth_ext_sessions WHERE user_id=?", [userId]);
  return r.changes > 0;
}

/** Durée de vie maximale d'une session en secondes (`security.session.max_age_sec`), comme la lit `validerSession`. */
export function dureeMaxSession(config: unknown): number {
  try {
    return intPy(lire(sousObjet(sousObjet(config, "security"), "session"), "max_age_sec", 86400));
  } catch {
    return 86400;
  }
}
