// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/rendu-chat.ts — rendu côté conversation (porté de `chat/_rendering.js`) : moteur Markdown de la page, clic, export, enrichissement des blocs hors composants, hauteur du composeur. */
import type * as Vue from "vue";
import type { Ref } from "vue";

import { parsePath } from "../../../utils/utils-purs.ts";
import { exporterConversation } from "../export.ts";
import type { FormatExport, MessageExporte } from "../export.ts";
import {
  balayerGraphiques,
  clicMarkdown,
  configurerEnrichissement,
  enrichirBlocs,
  viderGraphiques,
} from "./enrichissement.ts";
import type { MoteurMarkdown } from "./markdown.ts";

export interface RefsRenduChat {
  messages: Ref<readonly MessageExporte[]>;
  currentChatId: Ref<string | null>;
  user: Ref<{ username?: string } | null>;
  settings: Ref<{ assistant_name?: string }>;
  inputRef: Ref<HTMLTextAreaElement | null>;
  chatContainer: Ref<HTMLElement | null>;
  currentChatTitle: Ref<string>;
}

export interface CtxRenduChat {
  fetchAuth?: (url: string, init?: RequestInit) => Promise<Response | null>;
  openInEditor?: (chemin: string, ligne?: number | null, colonne?: number | null) => void;
}

export function creerRenduChat(
  moteur: MoteurMarkdown,
  vue: Pick<typeof Vue, "ref" | "nextTick">,
  refs: RefsRenduChat,
  ctx: CtxRenduChat | null,
) {
  const { ref, nextTick } = vue;
  const { messages, currentChatId, user, settings, inputRef, chatContainer, currentChatTitle } = refs;
  const lire = ctx?.fetchAuth;
  configurerEnrichissement({
    fetch: async (url) => {
      const r = lire ? await lire(url) : await fetch(url, { credentials: "same-origin" });
      if (!r) throw new Error("session expirée");
      return r;
    },
    chatCourant: () => currentChatId.value || "",
  });

  function handleMarkdownClick(event: Event): void {
    clicMarkdown(event, {
      ...(ctx && typeof ctx.openInEditor === "function" ? { ouvrirDansEditeur: ctx.openInEditor } : {}),
      analyserChemin: parsePath,
    });
  }

  // Plancher d'une ligne (deux sur la page de nouveau chat, par la min-height de ZoneSaisie) : la barre grandit jusqu'à 150 px avant de défiler.
  function autoResize(): void {
    const el = inputRef.value;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.max(40, Math.min(el.scrollHeight, 150)) + "px";
  }

  const showExportFormatMenu = ref(false);

  function exportChatAs(format: FormatExport): void {
    showExportFormatMenu.value = false;
    exporterConversation(format, {
      messages: messages.value,
      titre: currentChatTitle.value || "Chat Export",
      chatId: currentChatId.value || "export",
      utilisateur: user.value?.username || "Utilisateur",
      assistant: settings.value.assistant_name || "Assistant",
    });
  }

  // Portée explicite (aide des réglages) ou conteneur du chat ; les corps possédés par un composant sont sautés.
  function addCodeCopyButtons(processAll?: boolean, explicitScope?: Element | null): void {
    void nextTick(() => {
      let scope: Element | Document;
      const c = chatContainer.value;
      if (explicitScope) scope = explicitScope;
      else if (processAll) scope = c || document;
      else if (c) {
        const nodes = c.querySelectorAll("[data-vs-idx]");
        scope = nodes[nodes.length - 1] ?? c;
      } else scope = document;
      enrichirBlocs(scope, true);
    });
  }

  return {
    renderMarkdown: moteur.renderMarkdown,
    renderMarkdownHighlight: moteur.renderMarkdownHighlight,
    scanStreamBlocks: moteur.scanStreamBlocks,
    renderStreamingActive: moteur.renderStreamingActive,
    renderStreamBlock: moteur.renderStreamBlock,
    renderMarkdownLive: moteur.renderMarkdownLive,
    handleMarkdownClick,
    clearMarkdownCache: moteur.clearMarkdownCache,
    clearChartInstances: viderGraphiques,
    sweepOrphanCharts: balayerGraphiques,
    autoResize,
    showExportFormatMenu,
    exportChatAs,
    addCodeCopyButtons,
  };
}
