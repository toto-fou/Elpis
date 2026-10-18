// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/usage-compte.ts — métriques d'usage du compte courant, jamais d'un autre : chats, tokens, messages, routines (shared_infra/observability/routes_usage.py). */
import { arrondiEntierPy, estErreurPython, FlottantPy, floatPy, intPy, veritePy } from "@elpis/commun";
import { getUsernameById } from "@elpis/auth";
import { jsonGet } from "@elpis/db";
import type { Executeur } from "@elpis/db";

import { journal } from "../journal";
import { tokenBreakdown } from "./usage-registre";

const log = journal("usage");

export const ALLOWED_DAYS = [1, 7, 30, 90] as const;

/** `days` lu en texte puis ramené à la fenêtre autorisée la plus proche (égalité : la plus courte), 30 si illisible. */
export function fenetreJours(brut: string): number {
  let jours: number;
  try {
    jours = intPy(brut);
  } catch (e) {
    if (!estErreurPython(e, "TypeError", "ValueError")) throw e;
    jours = 30;
  }
  if ((ALLOWED_DAYS as readonly number[]).includes(jours)) return jours;
  if (jours >= 90) return 90;
  if (jours <= 1) return 1;
  let meilleur: number = ALLOWED_DAYS[0];
  for (const d of ALLOWED_DAYS) if (Math.abs(d - jours) < Math.abs(meilleur - jours)) meilleur = d;
  return meilleur;
}

function entier(v: unknown): number {
  return intPy(veritePy(v) ? v : 0);
}

/** Corps de `GET /api/usage/me` pour le compte `uid` sur `days` jours ; messages comptés par `user_id` (le nom seulement pour les lignes sans identifiant, écart au Python) ; chaque agrégat en échec garde ses zéros. */
export async function usageDuCompte(
  x: Executeur,
  uid: number,
  days: number,
): Promise<Record<string, unknown>> {
  const username = (await getUsernameById(x, uid)) || `user_${uid}`;
  const since = Date.now() / 1000 - days * 86400;
  let nActive = 0;
  let nArchived = 0;
  let parts = tokenBreakdown();
  let [inTok, outTok, totalTok, thinkTok, respTok] = [0, 0, 0, 0, 0];
  let [msgUser, msgAssistant] = [0, 0];
  let [rN, rOk, rErr, rIn, rOut, rAvg] = [0, 0, 0, 0, 0, 0.0];
  try {
    const [row] = await x.valeurs(
      "SELECT COALESCE(SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END),0), " +
        "       COALESCE(SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END),0) " +
        "FROM chats WHERE user_id=?",
      [uid],
    );
    [nActive, nArchived] = [entier(row?.[0]), entier(row?.[1])];
  } catch (e) {
    log.debug(`[usage] chats agg failed: ${String(e)}`);
  }
  try {
    const [row = []] = await x.valeurs(
      `
                SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                       COALESCE(SUM(thinking_tokens),0), COALESCE(SUM(cache_read_tokens),0),
                       COALESCE(SUM(cache_creation_tokens),0), COALESCE(SUM(tool_tokens),0)
                FROM usage_events WHERE user_id=? AND ts >= ?
            `,
      [uid, since],
    );
    parts = tokenBreakdown(row[0], row[1], {
      thinkingTokens: row[2],
      cacheReadTokens: row[3],
      cacheCreationTokens: row[4],
      toolTokens: row[5],
    });
    [inTok, outTok] = [parts.input, parts.output];
    [thinkTok, respTok] = [parts.thinking, parts.response];
    totalTok = inTok + outTok;
  } catch (e) {
    log.debug(`[usage] tokens agg failed: ${String(e)}`);
  }
  const bySource: Record<string, unknown>[] = [];
  try {
    for (const r of await x.valeurs(
      `
                SELECT source, COALESCE(SUM(input_tokens + output_tokens),0) AS t,
                       COUNT(*) AS n, COALESCE(SUM(input_tokens),0),
                       COALESCE(SUM(output_tokens),0), COALESCE(SUM(cache_read_tokens),0),
                       COALESCE(SUM(thinking_tokens),0), COALESCE(SUM(tool_tokens),0)
                FROM usage_events WHERE user_id=? AND ts >= ?
                GROUP BY source ORDER BY t DESC
            `,
      [uid, since],
    )) {
      const b = tokenBreakdown(r[3], r[4], { cacheReadTokens: r[5], thinkingTokens: r[6], toolTokens: r[7] });
      bySource.push({
        source: r[0],
        tokens: entier(r[1]),
        turns: entier(r[2]),
        input: b.input,
        output: b.output,
        cache: b.cache,
        input_new: b.input_new,
        tools: b.tools,
        thinking: b.thinking,
        response: b.response,
      });
    }
  } catch (e) {
    log.debug(`[usage] by_source agg failed: ${String(e)}`);
  }
  try {
    const role = jsonGet("tags_json", "role", x.dialecte);
    const [row] = await x.valeurs(
      `
                SELECT
                  COALESCE(SUM(CASE WHEN ${role}='user'      THEN 1 ELSE 0 END),0),
                  COALESCE(SUM(CASE WHEN ${role}='assistant' THEN 1 ELSE 0 END),0)
                FROM metric_events
                WHERE event_type='message_sent' AND created_at >= ?
                  AND (user_id = ? OR (user_id IS NULL AND ${jsonGet("tags_json", "user", x.dialecte)} = ?))
            `,
      [since, uid, username],
    );
    [msgUser, msgAssistant] = [entier(row?.[0]), entier(row?.[1])];
  } catch (e) {
    log.debug(`[usage] messages agg failed: ${String(e)}`);
  }
  try {
    const [row = []] = await x.valeurs(
      `
                SELECT COUNT(*),
                       COALESCE(SUM(CASE WHEN status='ok'    THEN 1 ELSE 0 END),0),
                       COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0),
                       COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                       COALESCE(AVG(duration_ms),0)
                FROM editor_routine_runs
                WHERE owner_user_id=? AND started_at >= ?
            `,
      [uid, since],
    );
    [rN, rOk, rErr] = [entier(row[0]), entier(row[1]), entier(row[2])];
    [rIn, rOut, rAvg] = [entier(row[3]), entier(row[4]), floatPy(veritePy(row[5]) ? row[5] : 0)];
  } catch (e) {
    log.debug(`[usage] routines agg failed: ${String(e)}`);
  }
  return {
    days,
    since: new FlottantPy(since),
    chats: { active: nActive, archived: nArchived, total: nActive + nArchived },
    messages: { sent: msgUser, received: msgAssistant },
    tokens: {
      input: inTok,
      output: outTok,
      total: totalTok,
      cache: parts.cache,
      input_new: parts.input_new,
      cache_creation: parts.cache_creation,
      cache_pct: parts.cache_pct,
      tools: parts.tools,
      thinking: thinkTok,
      response: respTok,
      estimated: false,
      split_available: true,
      by_source: bySource,
    },
    routines: {
      runs: rN,
      ok: rOk,
      error: rErr,
      input_tokens: rIn,
      output_tokens: rOut,
      avg_duration_ms: arrondiEntierPy(rAvg),
    },
  };
}
