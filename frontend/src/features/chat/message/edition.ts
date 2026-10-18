// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/edition.ts — édition d'un message envoyé : troncature de l'historique, pièces jointes gardées, régénération (porté de `chat/_message_edit.js`). */
import type * as Vue from "vue";
import type { Ref } from "vue";

import { revoquerCaptures } from "./captures-web.ts";

export type VueEdition = Pick<typeof Vue, "ref" | "nextTick">;

export interface MessageEditable {
  role?: string;
  content?: unknown;
  images?: unknown;
  files?: unknown;
  image_request?: unknown;
  [cle: string]: unknown;
}

export interface RefsEdition {
  messages: Ref<MessageEditable[]>;
  isStreaming: Ref<boolean>;
  isUserScrolling: Ref<boolean>;
}

export interface CtxEdition {
  scrollToBottom(force?: boolean): void;
  generateResponse(): Promise<void>;
  openConfirm?: (
    titre: string,
    texte: string,
    danger?: boolean,
    ok?: string,
    annuler?: string,
  ) => Promise<boolean>;
  resetDiffCardState?: () => void;
  sweepOrphanCharts?: () => void;
}

export function setupChatMessageEdit(vue: VueEdition, refs: RefsEdition, ctx: CtxEdition) {
  const { ref, nextTick } = vue;
  const { messages, isStreaming, isUserScrolling } = refs;
  const editingMessageIndex = ref<number | null>(null);
  const editMessageText = ref("");

  function startEditMessage(index: number): void {
    if (isStreaming.value) return;
    editingMessageIndex.value = index;
    const c = messages.value[index]?.content;
    editMessageText.value = typeof c === "string" ? c : "";
    void nextTick(() => {
      const el = document.querySelector<HTMLTextAreaElement>("[data-edit-message-input]");
      if (!el) return;
      el.focus();
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        /* champ non textuel */
      }
    });
  }

  function cancelEditMessage(): void {
    editingMessageIndex.value = null;
    editMessageText.value = "";
  }

  // Le premier message demande confirmation : tout ce qui suit est régénéré.
  async function submitEditMessage(index: number): Promise<void> {
    if (isStreaming.value) return;
    const text = editMessageText.value.trim();
    if (!text) {
      cancelEditMessage();
      return;
    }
    const perdus = messages.value.length - index - 1;
    if (index === 0 && perdus > 0 && typeof ctx.openConfirm === "function") {
      const mot = perdus > 1 ? "messages" : "message";
      const ok = await ctx.openConfirm(
        "Modifier le premier message ?",
        `La conversation sera régénérée depuis ce point. Les ${perdus} ${mot} qui suivent seront perdus.`,
        false,
        "Modifier et régénérer",
        "Annuler",
      );
      if (!ok) return;
    }
    const orig = messages.value[index] || {};
    const images = Array.isArray(orig.images) ? (orig.images as unknown[]).slice() : null;
    const files = Array.isArray(orig.files) ? (orig.files as unknown[]).slice() : null;
    revoquerCaptures(messages.value.slice(index));
    messages.value.splice(index);
    ctx.resetDiffCardState?.();
    if (typeof ctx.sweepOrphanCharts === "function") {
      const balayer = ctx.sweepOrphanCharts;
      void nextTick(() => balayer());
    }
    const edite: MessageEditable = { role: "user", content: text };
    if (images && images.length) edite.images = images;
    if (files && files.length) edite.files = files;
    if (orig.image_request && typeof orig.image_request === "object")
      edite.image_request = { ...(orig.image_request as Record<string, unknown>) };
    messages.value.push(edite);
    cancelEditMessage();
    isUserScrolling.value = false;
    void nextTick(() => ctx.scrollToBottom(true));
    await ctx.generateResponse();
  }

  return {
    editingMessageIndex,
    editMessageText,
    startEditMessage,
    cancelEditMessage,
    submitEditMessage,
  };
}
