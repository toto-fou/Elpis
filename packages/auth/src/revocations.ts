// SPDX-License-Identifier: MIT
/** packages/auth/src/revocations.ts — révocation des sessions : par `_sid` (déconnexion) et par compte (`session_min_ts`). */
import type { Executeur } from "@elpis/db";

function sid128(sid: string): string {
  return Array.from(sid).slice(0, 128).join("");
}

export async function revoquerSid(
  x: Executeur,
  sid: string,
  userId: number | null,
  ts: number,
): Promise<boolean> {
  if (!sid) return false;
  await x.run(
    "INSERT INTO revoked_sessions (sid, user_id, revoked_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO NOTHING",
    [sid128(sid), userId, ts],
  );
  return true;
}

export async function estRevoquee(x: Executeur, sid: string): Promise<boolean> {
  if (!sid) return false;
  return (await x.get("SELECT 1 AS un FROM revoked_sessions WHERE sid=?", [sid128(sid)])) !== undefined;
}

export async function purgerRevocations(x: Executeur, maxAgeS: number, maintenant: number): Promise<number> {
  return (
    await x.run("DELETE FROM revoked_sessions WHERE revoked_at < ?", [maintenant - Math.max(0, maxAgeS)])
  ).changes;
}

/** `bump_session_min_ts` : toute session ouverte avant `ts` est refusée. */
export async function leverMinSession(x: Executeur, userId: number, ts: number): Promise<boolean> {
  return (await x.run("UPDATE users SET session_min_ts=? WHERE id=?", [ts, userId])).changes > 0;
}

export async function effacerMinSession(x: Executeur, userId: number): Promise<boolean> {
  return (await x.run("UPDATE users SET session_min_ts=0 WHERE id=?", [userId])).changes > 0;
}
