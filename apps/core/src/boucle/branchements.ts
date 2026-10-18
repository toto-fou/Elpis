// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/branchements.ts — ports de la boucle posés au démarrage : file LLM unique (tours, sous-agents, images), prompt d'image, prompts de capacité, captures et trames, todos du chat. */
import { getUser } from "@elpis/auth";
import type { Executeur } from "@elpis/db";
import { extractPwScreenshotUrl, pwVerbOf, trackPwSessionOwnership } from "@elpis/navigateur";

import { desktopFramePath, extractDesktopFrame, registerDesktopFrameOwner } from "../bureau";
import { getChatTodos } from "../chats/stockage";
import { installerPromptsCapacites } from "../contexte/ports";
import { QUEUE_MAX_S } from "../images/base";
import { getImageConfig } from "../images/config";
import { installerAppelEnrichissement, installerFileImages } from "../images/ports";
import { avecLLM, ordonnanceur } from "../llm/ordonnanceur/process";
import { currentEngine } from "../llm/moteurs";
import {
  clearLastScreenshotFor,
  getLastScreenshotB64,
  modelSupportsVision,
  trackLastScreenshotForVision,
} from "../llm/vision";
import { buildCapabilityBlock, capabilityWantsRuntimeContext } from "../prompts/systeme";
import { appelPromptImage } from "./appels-uniques";
import { installerFileLlm, installerTodos, installerVisionBureau } from "./ports";
import type { PortFileLlm, PortTodos, PortVisionBureau } from "./ports";

/** `withLLM` de la boucle = `llm_scheduling_guard` du moteur courant : disjoncteur, réglages relus, puis la file unique du process. */
export const fileDuProcess: PortFileLlm = {
  withLLM: (model, priority, signal, fn, options = {}) =>
    avecLLM(currentEngine(), model, priority, signal, fn, options),
};

export const visionDuProcess: PortVisionBureau = {
  extractDesktopFrame: (toolName, toolArgs, resultStr) => extractDesktopFrame(toolName, toolArgs, resultStr),
  desktopFramePath,
  registerDesktopFrameOwner,
  extractPwScreenshotUrl: (toolName, toolArgs, resultStr) => {
    const ss = extractPwScreenshotUrl(toolName, toolArgs, resultStr);
    return ss === null ? null : { url: String(ss["url"]), step: ss["step"], session_id: ss["session_id"] };
  },
  pwVerbOf,
  trackPwSessionOwnership,
  getLastScreenshotB64,
  trackLastScreenshotForVision,
  clearLastScreenshotFor,
  modelSupportsVision,
  imageToolTimeoutS: () => QUEUE_MAX_S + Number(getImageConfig().timeout_sec) + 60.0,
};

/** `get_chat_todos` du compte, son id gardé en mémoire comme `_TCM_UID_CACHE` (pas de lecture de `users` à chaque tour). */
export function todosDuProcess(base: Executeur): PortTodos {
  const uids = new Map<string, number>();
  return {
    async todosDuChat(username, chatId) {
      let uid = uids.get(username);
      if (uid === undefined) {
        const ligne = await getUser(base, username);
        if (ligne === undefined) return null;
        uid = Number(ligne.id);
        uids.set(username, uid);
      }
      return getChatTodos(base, uid, chatId);
    },
  };
}

/** Une seule file dans le process : tours et sous-agents (serveurs LLM) comme créneaux d'images (`image:<url>`). */
export function brancherBoucle(base: Executeur): void {
  installerFileLlm(fileDuProcess);
  installerFileImages(ordonnanceur);
  installerAppelEnrichissement((messages, o) => appelPromptImage(o.model, o.chatId, o.signal)(messages));
  installerPromptsCapacites({ capabilityWantsRuntimeContext, buildCapabilityBlock });
  installerVisionBureau(visionDuProcess);
  installerTodos(todosDuProcess(base));
}
