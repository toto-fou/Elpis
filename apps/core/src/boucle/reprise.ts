// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/reprise.ts — reprises automatiques d'une génération coupée (raisonnement, rédaction) : demande en attente, restitution, décision. */
import { config } from "@elpis/config";
import { intPy, longueurPy, rstripPy, stripPy, veritePy } from "@elpis/commun";

import { currentTarget } from "../llm/cible";
import { continueFinalSupport } from "../llm/parametres";
import { journal } from "../journal";
import type { Dict } from "../python";
import { stripToolCallMarkup } from "./analyse-appels";
import { emit } from "./evenements";
import { shouldAutoResume, shouldAutoResumeContent } from "./reprise-raisonnement";
import type { RunContext } from "./run";
import type { LiveText } from "./texte-direct";

const log = journal("boucle.reprise");

/** Prose renvoyée pour une reprise token-exacte : la version affichable prolongée de la queue blanche du dernier segment. */
export function resumePrefixJoin(clean: string, exact: string): string {
  const queue = exact ? exact.slice(rstripPy(exact).length) : "";
  return (clean || "") + queue;
}

/** Demande de reprise consommée par UN appel LLM (rien = appel normal). */
export interface ResumeRequest {
  readonly think: string | null;
  readonly nativeOk: boolean;
  readonly content: string | null;
}

export const AUCUNE_REPRISE: ResumeRequest = Object.freeze({ think: null, nativeOk: true, content: null });

export interface PlanReprise {
  live: LiveText;
  finish: unknown;
  toolCalls: readonly unknown[];
  legacyCalls: readonly unknown[] | null;
  iterThinking: string;
  iterClean: string;
  rawContentExact: string;
  rawResponse: Dict;
  gaugeCtxTotal: number;
  iteration: number;
}

function entier(v: unknown): number {
  return intPy(veritePy(v) ? v : 0);
}

/** Demande de reprise en attente et compteurs de la série en cours. */
export class ResumeState {
  thinkCount = 0;
  thinkTokens = 0;
  pendingThink: string | null = null;
  pendingNativeOk = true;
  contentCount = 0;
  pendingContent: string | null = null;

  /** Consomme la demande en attente pour l'appel qui part. */
  take(): ResumeRequest {
    const req = { think: this.pendingThink, nativeOk: this.pendingNativeOk, content: this.pendingContent };
    this.pendingThink = null;
    this.pendingNativeOk = true;
    this.pendingContent = null;
    return req;
  }

  /** Restitue une demande consommée par un appel qui sera relancé. */
  restore(req: ResumeRequest): void {
    this.pendingThink = req.think;
    this.pendingNativeOk = req.nativeOk;
    this.pendingContent = req.content;
  }

  resetChain(): void {
    this.thinkCount = 0;
    this.contentCount = 0;
    this.thinkTokens = 0;
  }

  /** Tour sans appel d'outil : `true` si une reprise est programmée pour le PROCHAIN appel. */
  async plan(ctx: RunContext, p: PlanReprise): Promise<boolean> {
    const parts = p.live.parts;
    const coupe = String(p.finish ?? "") === "length";
    const sansAppel = !p.toolCalls.length && !(p.legacyCalls && p.legacyCalls.length);
    if (
      coupe &&
      sansAppel &&
      !stripPy(stripToolCallMarkup(parts.join(""))) &&
      stripPy(p.iterThinking || "") &&
      !ctx.cancelled()
    ) {
      const usage = (p.rawResponse["usage"] || {}) as Dict;
      const [ok, pourquoi] = shouldAutoResume({
        finish: "length",
        content: "",
        thinking: p.iterThinking,
        hadToolCalls: false,
        partial: veritePy(p.rawResponse["partial"]),
        resumesDone: this.thinkCount,
        thinkTokensDone: this.thinkTokens + entier(usage["completion_tokens"]),
        ctxSize: entier(p.gaugeCtxTotal) || null,
        windowTokens: entier(usage["prompt_tokens"]) + entier(usage["completion_tokens"]),
      });
      if (ok) {
        this.thinkCount += 1;
        this.thinkTokens += entier(usage["completion_tokens"]);
        this.pendingThink = p.iterThinking;
        this.pendingNativeOk = veritePy(p.rawResponse["reasoning_channel_native"]);
        log.info(
          `[run_chat_multi_mcp] raisonnement coupé par le plafond → auto-reprise in-run (${pourquoi}, iter ${p.iteration}, ≈${this.thinkTokens} tk de thinking cumulés)`,
        );
        return true;
      }
      log.warn(
        `[run_chat_multi_mcp] coupure en plein raisonnement sans auto-reprise : ${pourquoi} (iter ${p.iteration})`,
      );
    }
    if (coupe && sansAppel && !ctx.cancelled()) {
      let crRaw = p.iterClean || parts.join("");
      const exactStrip = stripPy(p.rawContentExact || "");
      if (p.iterClean && p.rawContentExact && exactStrip && rstripPy(p.iterClean).endsWith(exactStrip))
        crRaw = resumePrefixJoin(p.iterClean, p.rawContentExact);
      const crText = stripPy(stripToolCallMarkup(crRaw));
      if (crText) {
        const usage = (p.rawResponse["usage"] || {}) as Dict;
        let natifOk = false;
        try {
          natifOk = Boolean(
            currentTarget().isLlamacpp &&
            continueFinalSupport(ctx.c.model || config.LLAMA_MODEL || null) !== false,
          );
        } catch (e) {
          log.debug(`content_resume_native_probe : ${String(e)}`);
        }
        const [ok, pourquoi] = shouldAutoResumeContent({
          finish: "length",
          content: crText,
          hadToolCalls: false,
          nativeOk: natifOk,
          resumesDone: this.contentCount,
          ctxSize: entier(p.gaugeCtxTotal) || null,
          windowTokens: entier(usage["prompt_tokens"]) + entier(usage["completion_tokens"]),
        });
        if (ok) {
          this.contentCount += 1;
          this.pendingContent = crRaw;
          log.info(
            `[run_chat_multi_mcp] réponse coupée par le plafond → auto-reprise de la rédaction (${pourquoi}, iter ${p.iteration}, ${longueurPy(crText)} chars déjà écrits)`,
          );
          await p.live.emitRest(crText, { replaceOnDivergence: true });
          await emit(ctx.c.onEvent, {
            type: "info",
            text: "Réponse tronquée — reprise automatique de la rédaction…",
          });
          return true;
        }
        log.warn(`[run_chat_multi_mcp] réponse coupée sans reprise : ${pourquoi} (iter ${p.iteration})`);
      }
    }
    return false;
  }
}
