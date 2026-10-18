// SPDX-License-Identifier: MIT
/** apps/core/src/tour/ouverture.ts — ouverture d'un tour, par la route de chat ou par le réveilleur des jobs : admission (409 compression ou génération en cours, 429 plafond du compte), préparation, verrou de présence et passation (chatbot_app/routes/chats.py). */
import { HttpError, intPy, stripPy, strPy, veritePy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";
import type { Base } from "@elpis/db";

import { getChat } from "../chats/stockage";
import { journal } from "../journal";
import {
  acquireGenPresence,
  handoverRebaselineOk,
  manualCompressionActive,
  reserverVerrou,
  sweepPendingGenLocks,
} from "./admission";
import { isChatCancelled, isGenerationActive, verrousChat } from "./etat";
import { jobsTour } from "./ports-jobs";
import type { OrigineReveil } from "./ports-jobs";
import { prepareTurn } from "./preparation";
import type { PersistBaseline, TurnPlan, TurnResources } from "./preparation";

const log = journal("uvicorn.error");

export interface DependancesOuverture {
  readonly base: Base;
  /** Attente entre deux sondes d'une génération en cours (tests). */
  readonly dormir?: (s: number) => Promise<void>;
}

/** Tour ouvert : préparé, verrou de présence pris et réservé jusqu'à sa réclamation par le tour. */
export interface TourOuvert {
  readonly plan: TurnPlan;
  readonly res: TurnResources;
  readonly base: PersistBaseline;
}

/** Gardes communes aux tours (texte et « Images ») : compression ou génération en cours (409), plafond du compte (429) ; rend le chat demandé. */
export async function admettreTour(dep: DependancesOuverture, uid: number, data: Dict): Promise<string> {
  const dormir = dep.dormir ?? ((s: number) => new Promise<void>((ok) => setTimeout(ok, s * 1000)));
  const chatId = stripPy(strPy(veritePy(data["chat_id"]) ? data["chat_id"] : ""));
  if (chatId && manualCompressionActive(uid, chatId)) throw new HttpError(409, "compression_running");
  sweepPendingGenLocks();
  if (chatId && !isChatCancelled(uid, chatId) && isGenerationActive(uid, chatId)) {
    let libre = false;
    for (let i = 0; i < 6 && !libre; i++) {
      await dormir(0.1);
      libre = isChatCancelled(uid, chatId) || !isGenerationActive(uid, chatId);
    }
    if (!libre) throw new HttpError(409, "generation_running");
  }
  let maxRuns: number;
  try {
    maxRuns = intPy(veritePy(config.MAX_RUNS_PER_USER) ? config.MAX_RUNS_PER_USER : 0);
  } catch {
    maxRuns = 0;
  }
  if (maxRuns > 0) {
    const n = verrousChat.countHeld("gen", uid);
    if (n >= maxRuns) {
      log.info(`[chat_stream] user=${uid} a déjà ${n} génération(s) en cours (plafond ${maxRuns}) — refus`);
      throw new HttpError(429, "too_many_runs");
    }
  }
  return chatId;
}

/** Gardes et préparation avant le flux ; lève HttpError tant que rien n'est rendu au client (événements de jobs pris alors rendus). */
export async function ouvrirTour(
  dep: DependancesOuverture,
  uid: number,
  data: Dict,
  reveil: OrigineReveil | null = null,
): Promise<TourOuvert> {
  const chatId = await admettreTour(dep, uid, data);
  const [plan, res, base] = await prepareTurn({ base: dep.base }, data, uid, chatId, reveil);
  try {
    const passation: boolean[] = [];
    const jeton = await acquireGenPresence(uid, plan.chatId, passation);
    if (passation.length && !plan.ephemeral && !plan.chatReadFailed) {
      try {
        const frais = await getChat(dep.base, uid, plan.chatId);
        if (frais && handoverRebaselineOk(base.messages, frais["messages"])) {
          base.updatedAt = frais["updated_at"];
          base.messages = frais["messages"];
          base.title = strPy(veritePy(frais["title"]) ? frais["title"] : "");
        }
      } catch (e) {
        log.debug(`[chat.handover_rebaseline] ${String(e)}`);
      }
    }
    reserverVerrou(uid, plan.chatId, jeton);
  } catch (e) {
    jobsTour()?.finTour(uid, plan.chatId, plan.runId, { message: false, reponse: false, suffixe: false });
    throw e;
  }
  return { plan, res, base };
}
