// SPDX-License-Identifier: MIT
/** apps/core/src/llm/fournisseurs/llama-flux.ts — flux reprenable de llama-server : session nommée (HMAC), reprise, arrêt explicite, fin du raisonnement, signe de vie observé. */
import { createHmac } from "node:crypto";

import { strPy, utf8Remplace, veritePy } from "@elpis/commun";
import { config } from "@elpis/config";

import { journal } from "../../journal";
import { estDict } from "../../python";
import type { Dict } from "../../python";
import { sansBarresFinales } from "../client-http";
import type { ClientHttp, Delais, ReponseFlux } from "../client-http";
import { getPy, iterExige } from "../dict-py";
import { currentEngine } from "../moteurs";

const log = journal("llama_stream");

export const CONV_HEADER = "X-Conversation-Id";

/** Identifiant de session stable et non devinable : HMAC du secret d'instance sur `purpose:chat` (l'utilisateur n'y entre pas). */
export function conversationId(_userId: unknown, chatId: unknown, purpose = "chat"): string {
  if (!veritePy(chatId)) return "";
  let secret: unknown;
  try {
    secret = config.SESSION_SECRET;
  } catch {
    secret = "";
  }
  return createHmac("sha256", utf8Remplace(strPy(secret)))
    .update(utf8Remplace(`${purpose}:${strPy(chatId)}`))
    .digest("hex")
    .slice(0, 32);
}

/** Copie de `headers` portant l'en-tête de session (no-op sans identifiant). */
export function headersWithConv(
  headers: Readonly<Record<string, string>> | null | undefined,
  convId: string,
): Record<string, string> {
  const sortie = { ...(headers ?? {}) };
  if (convId) sortie[CONV_HEADER] = convId;
  return sortie;
}

/** Sessions vivantes parmi `convIds` (réponse du moteur) ; toute panne rend une table vide. */
export async function lookupStreams(
  client: ClientHttp,
  baseUrl: string,
  convIds: readonly string[],
  model = "",
  options: { headers?: Readonly<Record<string, string>> | null } = {},
): Promise<Map<unknown, Dict>> {
  if (convIds.length === 0) return new Map();
  try {
    const payload: Dict = { conversation_ids: [...convIds] };
    if (model) payload["model"] = model;
    const r = await client.post(`${sansBarresFinales(baseUrl)}/v1/streams/lookup`, {
      json: payload,
      timeout: 10.0,
      headers: options.headers ?? null,
    });
    if (r.statusCode !== 200) return new Map();
    const corps = r.json();
    const sortie = new Map<unknown, Dict>();
    for (const ligne of iterExige(veritePy(corps) ? corps : [])) {
      if (estDict(ligne) && veritePy(getPy(ligne, "conversation_id")))
        sortie.set(ligne["conversation_id"], ligne);
    }
    return sortie;
  } catch (e) {
    log.debug(`lookup indisponible : ${String(e).slice(0, 120)}`);
    return new Map();
  }
}

/** Flux de REPRISE (`GET /v1/stream`) : rejoue depuis `fromBytes` puis suit le direct ; l'appelant le ferme. */
export function resumeRequest(
  client: ClientHttp,
  baseUrl: string,
  convId: string,
  model = "",
  fromBytes = 0,
  timeout?: number | Delais | null,
  options: { headers?: Readonly<Record<string, string>> | null; signal?: AbortSignal } = {},
): Promise<ReponseFlux> {
  const params: Record<string, string | number> = { conv_id: convId, from: Math.trunc(fromBytes) };
  if (model) params["model"] = model;
  return client.stream("GET", `${sansBarresFinales(baseUrl)}/v1/stream`, {
    params,
    ...(timeout !== undefined && timeout !== null ? { timeout } : {}),
    headers: options.headers ?? null,
    signal: options.signal,
  });
}

/** Arrêt EXPLICITE d'une session (`DELETE /v1/stream`) : 200, 204 et 404 valent succès. */
export async function cancelStream(
  client: ClientHttp,
  baseUrl: string,
  convId: string,
  model = "",
  options: { headers?: Readonly<Record<string, string>> | null } = {},
): Promise<boolean> {
  if (!convId) return false;
  try {
    const params: Record<string, string> = { conv_id: convId };
    if (model) params["model"] = model;
    const r = await client.delete(`${sansBarresFinales(baseUrl)}/v1/stream`, {
      params,
      timeout: 10.0,
      headers: options.headers ?? null,
    });
    const ok = [200, 204, 404].includes(r.statusCode);
    if (!ok) log.warn(`DELETE conv=${convId.slice(0, 8)} → HTTP ${r.statusCode}`);
    return ok;
  } catch (e) {
    log.debug(`DELETE indisponible : ${String(e).slice(0, 120)}`);
    return false;
  }
}

/** Moteurs qui ont donné signe de vie pendant le silence (par serveur et modèle, en mémoire). */
export const ALIVE_SIGNAL = new Map<string, boolean>();

function aliveKey(model: unknown): string {
  try {
    return currentEngine().cacheKey(strPy(veritePy(model) ? model : ""));
  } catch {
    return strPy(veritePy(model) ? model : "");
  }
}

export function noteAliveSignal(model: string): void {
  if (model) ALIVE_SIGNAL.set(aliveKey(model), true);
}

export function hasAliveSignal(model: string): boolean {
  return ALIVE_SIGNAL.get(aliveKey(model)) === true;
}

/** Ferme le bloc de raisonnement d'une complétion en cours (`reasoning_end`) ; succès explicite exigé. */
export async function endReasoning(
  client: ClientHttp,
  baseUrl: string,
  completionId: string,
  model = "",
  options: { headers?: Readonly<Record<string, string>> | null } = {},
): Promise<boolean> {
  if (!completionId) return false;
  try {
    const corps: Dict = { id: completionId, action: "reasoning_end" };
    if (model) corps["model"] = model;
    const r = await client.post(`${sansBarresFinales(baseUrl)}/v1/chat/completions/control`, {
      json: corps,
      timeout: 10.0,
      headers: options.headers ?? null,
    });
    let ok = false;
    if (r.statusCode === 200) {
      const lu = r.json();
      ok = veritePy(getPy(veritePy(lu) ? lu : {}, "success"));
    }
    if (!ok) log.info(`reasoning_end refusé (HTTP ${r.statusCode}) : ${r.text.slice(0, 160)}`);
    return ok;
  } catch (e) {
    log.debug(`reasoning_end indisponible : ${String(e).slice(0, 120)}`);
    return false;
  }
}
