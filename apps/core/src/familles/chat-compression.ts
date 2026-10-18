// SPDX-License-Identifier: MIT
/** apps/core/src/familles/chat-compression.ts — compression manuelle d'une conversation hors flux : état pour le bouton, compaction `/compact` persistée en tête du chat (chatbot_app/routes/chat_compression.py). */
import { getUserSettings } from "@elpis/auth";
import {
  estDict,
  floatPy,
  HttpError,
  intPy,
  prefixePy,
  stripPy,
  strPy,
  texteOu,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config, reloadCompressionConfigFromDisk } from "@elpis/config";
import type { Base } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";

import { horsTour, llamaChatCompaction } from "../boucle/appels-uniques";
import { clearChatCtxUsage, getChat, upsertChat } from "../chats/stockage";
import type { LlamaChatFn } from "../contexte/compresseur";
import { maybeCompressConversation } from "../contexte/compresseur";
import {
  applyPersistedState,
  buildStateSystemMessage,
  countTurns,
  extractCompressionState,
  stripSummaryMessages,
} from "../contexte/etat-compression";
import { resolveMaxRounds } from "../contexte/porte-compaction";
import { measuredPromptTokens } from "../contexte/tokens";
import { runScope } from "../executions/registre";
import { journal } from "../journal";
import { canUseEngine } from "../llm/acces-moteurs";
import { EngineUnavailable, resolveLlmTarget, useLlmTarget } from "../llm/cible";
import type { LlmTarget } from "../llm/cible";
import { resolveContextWindow } from "../llm/fenetre-contexte";
import { BUILTIN_KEY, connectorKey, engineForTarget } from "../llm/moteurs";
import { getCurrentlyLoadedModel } from "../llm/sante";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { manualCompressionActive, manualCompressionBegin, manualCompressionEnd } from "../tour/admission";
import { isGenerationActive } from "../tour/etat";
import { expandHistoryForLlm } from "../tour/historique";
import { utilisateur } from "./comptes";
import { corpsJson, entrees, py, reponseJsonPy } from "@elpis/http";

const log = journal("uvicorn.error");

export interface DependancesChatCompression {
  readonly base: Base;
}

let resumeurDeTest: LlamaChatFn | null = null;

/** Résumeur des tests à la place de l'appel au modèle ; `null` rétablit l'appel réel. */
export function reglerCompressionPourTests(f: LlamaChatFn | null): void {
  resumeurDeTest = f;
}

function route(methode: "GET" | "POST", chemin: string, traiter: Traitement): DefinitionRoute {
  return { methode, chemin, processus: ["main"], acces: "session", traiter };
}

function rechargerConfig(): void {
  try {
    reloadCompressionConfigFromDisk();
  } catch (e) {
    log.debug(`[chat.api_chat_compression] ${String(e)}`);
  }
}

/** Bulles persistées (sans les system) développées pour le modèle, état de compression ré-appliqué. */
function vueModele(chat: Dict): { vue: Dict[]; etat: Dict | null; persistes: unknown[] } {
  const persistes = Array.isArray(chat["messages"]) ? (chat["messages"] as unknown[]) : [];
  const bulles = persistes.filter((m): m is Dict => estDict(m) && m["role"] !== "system");
  const cles = Array.isArray(chat["ctx_pruned_keys"]) ? (chat["ctx_pruned_keys"] as unknown[]) : [];
  return {
    vue: expandHistoryForLlm(bulles, { prunedKeys: cles }),
    etat: extractCompressionState(persistes) as Dict | null,
    persistes,
  };
}

const maxParChat = (userMax: number | null): number =>
  userMax !== null
    ? userMax
    : intPy(veritePy(config.COMPRESSION_MAX_PER_CHAT) ? config.COMPRESSION_MAX_PER_CHAT : 0);

/** État pour le bouton manuel : tour, plafond, possibilité et raison, tours et estimation de l'historique seul. */
async function etatCompression(dep: DependancesChatCompression, req: FastifyRequest, rep: FastifyReply) {
  const uid = utilisateur(req);
  const chatId = entrees(req, { path: { chat_id: py.str() } }).path.chat_id;
  const chat = await getChat(dep.base, uid, chatId);
  if (!chat) throw new HttpError(404, "chat not found");
  rechargerConfig();
  const lue = vueModele(chat);
  const etat = lue.etat;
  let vue = lue.vue;
  if (etat) {
    try {
      vue = applyPersistedState(vue, etat)[0] as Dict[];
    } catch (e) {
      log.warn(`[compression-state] apply état échoué (vue brute) : ${String(e)}`);
    }
  }
  const tour = intPy(veritePy((etat ?? {})["round"]) ? (etat ?? {})["round"] : 0);
  const max = maxParChat(resolveMaxRounds(await getUserSettings(dep.base, uid)));
  const tours = countTurns(vue);
  const minimum = intPy(config.COMPRESSION_KEEP_RECENT) + intPy(config.COMPRESSION_KEEP_BRIDGE);
  let reason: string;
  if (max > 0 && tour >= max) reason = "max_reached";
  else if (isGenerationActive(uid, chatId)) reason = "generation_running";
  else if (manualCompressionActive(uid, chatId)) reason = "compression_running";
  else if (tours <= minimum) reason = "too_short";
  else reason = "ok";
  rep.header("cache-control", "no-cache");
  return reponseJsonPy(rep, {
    round: tour,
    max,
    can_compress: reason === "ok",
    reason,
    turns: tours,
    tokens_estimate: measuredPromptTokens(vue),
    estimated: true,
    scope: "history_only",
  });
}

const milliers = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");

/** Compaction manuelle du chat persisté (seuils ignorés) ; état et jalon persistés sous la garde optimiste ; un échec métier reste un 200. */
async function compresser(dep: DependancesChatCompression, req: FastifyRequest, rep: FastifyReply) {
  const uid = utilisateur(req);
  const chatId = entrees(req, { path: { chat_id: py.str() } }).path.chat_id;
  const chat = await getChat(dep.base, uid, chatId);
  if (!chat) throw new HttpError(404, "chat not found");
  if (isGenerationActive(uid, chatId)) throw new HttpError(409, "generation_running");
  if (manualCompressionActive(uid, chatId)) throw new HttpError(409, "compression_running");
  let model: string | null = null;
  let connecteur: unknown = null;
  try {
    const corps = corpsJson(req);
    if (estDict(corps)) {
      model = stripPy(texteOu(corps["model"], "")) || null;
      connecteur = corps["connector_id"] ?? null;
    }
  } catch {
    model = null;
  }
  let cid: number | null;
  try {
    cid = [null, "", 0, "0", false].includes(connecteur as never) ? null : intPy(connecteur);
  } catch {
    cid = null;
  }
  let cible: LlmTarget;
  try {
    cible = await resolveLlmTarget(uid, cid, model, { strict: true });
  } catch (e) {
    if (e instanceof EngineUnavailable)
      throw new HttpError(409, { code: "engine_unavailable", reason: e.reason, message: e.message });
    throw e;
  }
  let autorise = true;
  try {
    autorise = await canUseEngine(dep.base, uid, cid ? connectorKey(cid) : BUILTIN_KEY);
  } catch (e) {
    log.debug(`[chat.manual_compress.access] ${String(e)}`);
  }
  if (!autorise)
    throw new HttpError(409, {
      code: "engine_unavailable",
      reason: "forbidden",
      message: "Ce serveur ne vous est pas ouvert.",
    });
  if (!model && cible.isDefault) {
    try {
      model = await getCurrentlyLoadedModel();
    } catch {
      model = null;
    }
  }
  manualCompressionBegin(uid, chatId);
  try {
    rechargerConfig();
    const userMax = resolveMaxRounds(await getUserSettings(dep.base, uid));
    const lue = vueModele(chat);
    const persistes = lue.persistes;
    let { vue, etat } = lue;
    if (etat) {
      const [v, e] = applyPersistedState(vue, etat);
      [vue, etat] = [v as Dict[], e ?? null];
    }
    let ctxTok = 0;
    try {
      ctxTok = Math.trunc((await resolveContextWindow(model || "", cible)) || 0);
    } catch {
      ctxTok = 0;
    }
    const recu: Dict = {};
    const surEvenement = (ev: Dict): void => {
      if (estDict(ev) && ev["type"] === "compression_state")
        for (const k of ["round", "covered_turns", "summary_xml", "turns_compressed", "ledger_block"])
          if (k in ev) recu[k] = ev[k];
    };
    const resume: LlamaChatFn =
      resumeurDeTest ??
      ((messages, o) => horsTour(model, "high", o.signal, () => llamaChatCompaction(messages, o)));
    const t0 = Date.now() / 1000;
    const [, stats] = await useLlmTarget(cible, () =>
      runScope(
        "compaction",
        { userId: uid, chatId, model: model || "", engine: engineForTarget(cible).key },
        () =>
          maybeCompressConversation(vue, {
            llamaChatFn: resume,
            onEvent: surEvenement,
            model,
            userId: String(uid),
            logPrefix: "chat_manual",
            ctxSizeTokens: ctxTok || null,
            prevState: etat,
            manual: true,
            maxRounds: userMax,
            ftsSessionId: String(chatId),
          }),
      ),
    );
    const compresse = veritePy(stats["compressed"]);
    if (compresse && veritePy(recu["summary_xml"])) {
      const apres = intPy(veritePy(stats["tokens_after"]) ? stats["tokens_after"] : 0);
      const etatMsg = buildStateSystemMessage(
        strPy(recu["summary_xml"]),
        intPy(veritePy(recu["round"]) ? recu["round"] : 1),
        intPy(veritePy(recu["covered_turns"]) ? recu["covered_turns"] : 0),
        (recu["turns_compressed"] ?? null) as number | null,
        veritePy(recu["ledger_block"]) ? strPy(recu["ledger_block"]) : "",
      );
      const jalon: Dict = {
        role: "notice",
        kind: "compaction",
        ts: versFlottantPy(Date.now() / 1000),
        round: intPy(veritePy(recu["round"]) ? recu["round"] : 1),
        tokens_after: apres,
        content: `Conversation compactée — contexte ≈ ${milliers(apres)} tokens`,
        summary: prefixePy(texteOu(recu["summary_xml"], ""), 12000),
      };
      const nouveaux = [etatMsg, ...stripSummaryMessages(persistes), jalon];
      try {
        const ok = await upsertChat(
          dep.base,
          uid,
          chatId,
          veritePy(chat["title"]) ? strPy(chat["title"]) : "Nouveau chat",
          nouveaux,
          Date.now() / 1000,
          chat["updated_at"] === null || chat["updated_at"] === undefined
            ? null
            : floatPy(chat["updated_at"]),
        );
        if (!ok) {
          rep.code(409);
          return reponseJsonPy(rep, { ok: false, compressed: false, reason: "chat_modified" });
        }
        try {
          await clearChatCtxUsage(dep.base, uid, chatId);
        } catch (e) {
          log.debug(`[chat_manual.ctx_usage] ${String(e)}`);
        }
      } catch (e) {
        log.warn(`[chat_manual] persist post-compression échoué : ${String(e)}`);
        rep.code(500);
        return reponseJsonPy(rep, { ok: false, compressed: false, reason: "persist_failed" });
      }
    }
    const get = (k: string): unknown => (k in stats ? stats[k] : null);
    return reponseJsonPy(rep, {
      ok: true,
      compressed: compresse,
      reason: get("reason"),
      stats: {
        tokens_before: get("tokens_before"),
        tokens_after: get("tokens_after"),
        tokens_saved: get("tokens_saved"),
        tokens_estimated: get("tokens_estimated"),
        turns_compressed: get("turns_compressed"),
        round: veritePy(stats["round"])
          ? stats["round"]
          : intPy(veritePy((etat ?? {})["round"]) ? (etat ?? {})["round"] : 0),
        max: maxParChat(userMax),
        duration_ms: veritePy(stats["duration_ms"])
          ? stats["duration_ms"]
          : Math.trunc((Date.now() / 1000 - t0) * 1000),
        path: get("path"),
        summary_xml: prefixePy(texteOu(recu["summary_xml"], ""), 12000),
      },
    });
  } finally {
    manualCompressionEnd(uid, chatId);
  }
}

export function creerFamilleChatCompression(dep: DependancesChatCompression): Famille {
  return {
    nom: "chat-compression",
    routes: [
      route("GET", "/api/chat/:chat_id/compression-state", (req, rep) => etatCompression(dep, req, rep)),
      route("POST", "/api/chat/:chat_id/compress", (req, rep) => compresser(dep, req, rep)),
    ],
  };
}
