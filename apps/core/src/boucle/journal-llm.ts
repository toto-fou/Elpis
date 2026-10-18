// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/journal-llm.ts — journal des échanges avec le moteur (table `llm_calls`, anneau borné) lu par la console « Trafic LLM » ; capture best-effort, jamais le raisonnement. */
import { ErreurPython, FlottantPy, intPy, pyJsonDumps, stripPy, strPy, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";
import type { Valeur } from "@elpis/db";

import { base } from "../base";
import { journal } from "../journal";
import { getPy } from "../llm/dict-py";
import { entierPy, estDict, flottantPy, longueurPy, ou, prefixePy } from "../python";
import { contexteUsage } from "./ports";

const log = journal("llm_debug");
const logAppels = journal("llm_calls");

const MAX_UID_EN_CACHE = 512;
const uidParNom = new Map<string, number | null>();

function typeTolere(e: unknown): boolean {
  return e instanceof ErreurPython && (e.type === "TypeError" || e.type === "ValueError");
}

/** Durée de l'appel d'après le serveur (`prompt_ms + predicted_ms`, tronquée en ms) ; `null` si absente, nulle ou illisible. */
export function durationMsFromTimings(timings: unknown): number | null {
  if (!estDict(timings)) return null;
  let total: number;
  try {
    total =
      flottantPy(ou(getPy(timings, "prompt_ms"), 0)) + flottantPy(ou(getPy(timings, "predicted_ms"), 0));
  } catch (e) {
    if (typeTolere(e)) return null;
    throw e;
  }
  return total > 0 ? intPy(total) : null;
}

/** `_uid_for_username` : nom de compte → id, cache borné du process ; une base indisponible n'est pas mise en cache. */
export async function uidPourNom(nom: unknown): Promise<number | null> {
  if (!nom || typeof nom !== "string") return null;
  if (uidParNom.has(nom)) return uidParNom.get(nom) ?? null;
  let uid: number | null;
  try {
    const ligne = await base().get<{ id: unknown }>("SELECT id FROM users WHERE username=?", [nom]);
    uid = ligne ? entierPy(ligne.id) : null;
  } catch {
    return null;
  }
  if (uidParNom.size > MAX_UID_EN_CACHE) uidParNom.clear();
  uidParNom.set(nom, uid);
  return uid;
}

/** Tests : oublie les noms déjà résolus (une autre base). */
export function viderCacheUids(): void {
  uidParNom.clear();
}

/** Valeur telle que `pyJsonDumps` l'écrit : `toJSON()` appliqué, sauf à un `FlottantPy`. */
function serialisable(v: unknown): unknown {
  if (v instanceof FlottantPy || v === null || typeof v !== "object") return v;
  const versJson = (v as { toJSON?: unknown }).toJSON;
  return typeof versJson === "function" ? (versJson as () => unknown).call(v) : v;
}

function saute(v: unknown): boolean {
  return v === undefined || typeof v === "function" || typeof v === "symbol";
}

/** `prefixePy(pyJsonDumps(valeur, { ensureAscii: false }), limite)` sans rien écrire au-delà de la limite (un texte n'est échappé que sur le préfixe utile). */
export function jsonBorne(valeur: unknown, limite: number): string {
  const parties: string[] = [];
  let compte = 0;
  const enCours = new Set<object>();
  const pousser = (morceau: string): boolean => {
    parties.push(morceau);
    compte += longueurPy(morceau);
    return compte >= limite;
  };
  const texte = (t: string): boolean => {
    const debut = prefixePy(t, Math.max(0, limite - compte));
    const echappe = pyJsonDumps(debut, { ensureAscii: false });
    return pousser(debut.length === t.length ? echappe : echappe.slice(0, -1));
  };
  const ecrire = (v: unknown): boolean => {
    if (typeof v === "string") return texte(v);
    if (v === null || typeof v !== "object" || v instanceof FlottantPy)
      return pousser(pyJsonDumps(v, { ensureAscii: false }));
    if (enCours.has(v)) throw new TypeError("référence circulaire détectée");
    enCours.add(v);
    try {
      if (Array.isArray(v)) {
        if (pousser("[")) return true;
        for (let i = 0; i < v.length; i++) {
          const w = serialisable(v[i]);
          if ((i > 0 && pousser(", ")) || (saute(w) ? pousser("null") : ecrire(w))) return true;
        }
        return pousser("]");
      }
      if (pousser("{")) return true;
      let premier = true;
      for (const cle of Object.keys(v)) {
        const w = serialisable((v as Record<string, unknown>)[cle]);
        if (saute(w)) continue;
        if ((!premier && pousser(", ")) || texte(cle) || pousser(": ") || ecrire(w)) return true;
        premier = false;
      }
      return pousser("}");
    } finally {
      enCours.delete(v);
    }
  };
  const racine = serialisable(valeur);
  if (saute(racine)) throw new TypeError("valeur racine non sérialisable en JSON");
  ecrire(racine);
  return prefixePy(parties.join(""), limite);
}

/** Valeur liée comme Python la lie : un entier (ou booléen) en INTEGER, pas en REAL (« 12 » et non « 12.0 » dans une colonne texte). */
function valeurSql(v: unknown): Valeur {
  if (typeof v === "boolean") return BigInt(v ? 1 : 0);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (v instanceof FlottantPy) return v.valeur;
  return (v ?? null) as Valeur;
}

export interface AppelLlm {
  reqId?: string | null;
  userId?: number | null;
  chatId?: unknown;
  model?: unknown;
  path?: unknown;
  status?: string;
  finishReason?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  durationMs?: number | null;
  nMessages?: number | null;
  nToolCalls?: number | null;
  requestJson?: string | null;
  responseJson?: string | null;
  error?: string | null;
  maxEntries?: number;
}

/** `record_llm_call` : une ligne, puis l'anneau ne garde que les `maxEntries` plus récentes (borne par clé primaire), dans une transaction ; un échec est avalé. */
export async function recordLlmCall(a: AppelLlm): Promise<void> {
  const maxEntries = a.maxEntries ?? 500;
  try {
    await base().transaction(async (tx) => {
      await tx.run(
        "INSERT INTO llm_calls(" +
          "ts, req_id, user_id, chat_id, model, path, status, finish_reason, " +
          "prompt_tokens, completion_tokens, duration_ms, n_messages, " +
          "n_tool_calls, request_json, response_json, error) " +
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          Date.now() / 1000,
          a.reqId ?? null,
          a.userId !== null && a.userId !== undefined ? intPy(a.userId) : null,
          valeurSql(a.chatId),
          valeurSql(a.model),
          valeurSql(a.path),
          a.status ?? "ok",
          valeurSql(a.finishReason),
          valeurSql(a.promptTokens),
          valeurSql(a.completionTokens),
          a.durationMs ?? null,
          a.nMessages ?? null,
          a.nToolCalls ?? null,
          a.requestJson ?? null,
          a.responseJson ?? null,
          a.error ? prefixePy(a.error, 1000) : null,
        ],
      );
      if (maxEntries && maxEntries > 0)
        await tx.run(
          "DELETE FROM llm_calls WHERE id < (SELECT id FROM " +
            "(SELECT id FROM llm_calls ORDER BY id DESC LIMIT 1 OFFSET ?) AS seuil)",
          [intPy(maxEntries) - 1],
        );
    });
  } catch (e) {
    logAppels.debug({ err: e }, "write failed (non-fatal)");
  }
}

export interface EchangeLlm {
  reqId?: string | null;
  userId?: unknown;
  chatId?: string | null;
  model?: string | null;
  path?: string;
  requestPayload?: unknown;
  content?: string | null;
  toolCalls?: readonly unknown[] | null;
  usage?: unknown;
  timings?: unknown;
  finishReason?: string | null;
  status?: string;
  error?: string | null;
}

/** Compte de l'appel : id donné, sinon le nom résolu en base, sinon le compte du contexte d'usage. */
async function resoudreUid(userId: unknown): Promise<number | null> {
  let uid: number | null;
  try {
    uid = userId !== null && userId !== undefined && stripPy(strPy(userId)) !== "" ? entierPy(userId) : null;
  } catch (e) {
    if (!typeTolere(e)) throw e;
    uid = await uidPourNom(strPy(userId)).catch(() => null);
  }
  if (uid !== null) return uid;
  try {
    return contexteUsage().utilisateurCourant();
  } catch {
    return null;
  }
}

/** `capture_llm_exchange` (et sa variante async, la base n'arrêtant jamais la boucle) : requête et réponse visibles bornées, métriques ; rien si `LLM_DEBUG_ENABLED` est faux, aucune erreur vers l'appelant. */
export async function captureLlmExchange(e: EchangeLlm): Promise<void> {
  try {
    if (!config.LLM_DEBUG_ENABLED) return;
    const maxBody = config.LLM_DEBUG_MAX_BODY_CHARS;
    let requestJson: string | null = null;
    let nMessages: number | null = null;
    if (estDict(e.requestPayload)) {
      const messages = getPy(e.requestPayload, "messages");
      if (Array.isArray(messages)) nMessages = messages.length;
      requestJson = jsonBorne(e.requestPayload, maxBody);
    }
    const reponse = {
      content: ou(e.content, ""),
      tool_calls: ou(e.toolCalls, []),
      usage: ou(e.usage, {}),
      timings: ou(e.timings, {}),
      finish_reason: e.finishReason ?? null,
    };
    const responseJson = jsonBorne(reponse, maxBody);
    const usage = estDict(e.usage) ? e.usage : {};
    const userId = await resoudreUid(e.userId);
    await recordLlmCall({
      reqId: e.reqId ?? null,
      userId,
      chatId: e.chatId ?? null,
      model: e.model ?? null,
      path: e.path ?? "classic",
      status: e.status ?? "ok",
      finishReason: e.finishReason ?? null,
      promptTokens: getPy(usage, "prompt_tokens"),
      completionTokens: getPy(usage, "completion_tokens"),
      durationMs: durationMsFromTimings(e.timings),
      nMessages,
      nToolCalls: veritePy(e.toolCalls) ? (e.toolCalls ?? []).length : 0,
      requestJson,
      responseJson,
      error: e.error ?? null,
      maxEntries: config.LLM_DEBUG_MAX_ENTRIES,
    });
  } catch (err) {
    log.debug({ err }, "capture failed (non-fatal)");
  }
}
