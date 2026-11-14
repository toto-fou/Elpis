// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/rendu-chat.ts — rendu côté conversation (porté de `chat/_rendering.js`) : moteur Markdown de la page, clic, export, enrichissement des blocs hors composants, hauteur du composeur. */
import type * as Vue from "vue";
import type { Ref } from "vue";

import { parsePath } from "../../../utils/utils-purs.ts";
import { exporterConversation } from "../export.ts";
import type { FormatExport, MessageExporte } from "../export.ts";
import { planifierBalayage } from "./coloration.ts";
import {
  balayerGraphiques,
  clicMarkdown,
  configurerEnrichissement,
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
  const { ref } = vue;
  const { messages, currentChatId, user, settings, inputRef, currentChatTitle } = refs;
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

  // Les vues qui posent ce HTML elles-mêmes (modales, routines, skills, éditeur) n'ont pas de composant pour planifier la coloration.
  function renderMarkdown(texte: string | null | undefined): string {
    const html = moteur.renderMarkdown(texte);
    planifierBalayage();
    return html;
  }

  let imageTaille = 0;
  // Plancher d'une ligne (deux sur la page de nouveau chat, par la min-height de ZoneSaisie) : la barre grandit jusqu'à 150 px ; une mesure par image, pas une mise en page forcée par touche.
  function autoResize(): void {
    if (imageTaille) return;
    imageTaille = requestAnimationFrame(() => {
      imageTaille = 0;
      const el = inputRef.value;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = Math.max(40, Math.min(el.scrollHeight, 150)) + "px";
    });
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

  return {
    renderMarkdown,
    renderMarkdownHighlight: moteur.renderMarkdownHighlight,
    renderStreamingActive: moteur.renderStreamingActive,
    renderMarkdownLive: moteur.renderMarkdownLive,
    handleMarkdownClick,
    clearMarkdownCache: moteur.clearMarkdownCache,
    clearChartInstances: viderGraphiques,
    sweepOrphanCharts: balayerGraphiques,
    autoResize,
    showExportFormatMenu,
    exportChatAs,
  };
}
