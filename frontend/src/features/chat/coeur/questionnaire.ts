// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/questionnaire.ts — questionnaire de l'outil `ask_user` (porté d'`app-chat.js`) : questions normalisées au `tool_call`, panneau ouvert à la fin du tour, réponses envoyées en un message. */
import { computed } from "vue";

import type { QuestionAsk } from "./etat.ts";
import type { CoeurChat } from "./liens.ts";

/** Questions de l'outil (8 au plus, 12 options chacune), ou null. */
export function normaliserQuestions(raw: unknown): QuestionAsk[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const items = (raw as unknown[]).slice(0, 8).map((x): QuestionAsk => {
    const o = (x && typeof x === "object" ? x : {}) as {
      q?: unknown;
      question?: unknown;
      options?: unknown;
      multi?: unknown;
    };
    return {
      q: String(o.q || o.question || "")
        .trim()
        .slice(0, 300),
      options: Array.isArray(o.options)
        ? (o.options as unknown[]).slice(0, 12).map((v) => String(v).slice(0, 120))
        : [],
      multi: !!o.multi,
      _sel: [],
      _free: "",
    };
  });
  const retenues = items.filter((x) => x.q);
  return retenues.length ? retenues : null;
}

export function creerQuestionnaire(c: CoeurChat) {
  const { r, ctx, e, f, l } = c;
  const askUserCurrent = computed(() => {
    const p = e.askUserPanel.value;
    return p ? (p.items[p.idx] ?? null) : null;
  });

  // Un questionnaire en attente meurt avec le tour (Stop, erreur, changement de conversation).
  function resetAskUser(): void {
    f.pendingAskUser = null;
    e.askUserPanel.value = null;
  }

  function isAskOptionOn(opt: string): boolean {
    const qq = askUserCurrent.value;
    return !!qq && qq._sel.includes(opt);
  }

  function toggleAskOption(opt: string): void {
    const qq = askUserCurrent.value;
    if (!qq) return;
    const i = qq._sel.indexOf(opt);
    if (i >= 0) qq._sel.splice(i, 1);
    else {
      if (!qq.multi) qq._sel.length = 0;
      qq._sel.push(opt);
    }
  }

  function askUserPrev(): void {
    const p = e.askUserPanel.value;
    if (p && p.idx > 0) p.idx--;
  }

  // Suivant, ou envoi groupé sur la dernière question.
  function askUserNext(): void {
    const p = e.askUserPanel.value;
    if (!p) return;
    if (p.idx < p.items.length - 1) {
      p.idx++;
      return;
    }
    submitAskUser();
  }

  function dismissAskUser(): void {
    e.askUserPanel.value = null;
  }

  // Le brouillon du composeur revient après l'envoi des réponses.
  function submitAskUser(): void {
    const p = e.askUserPanel.value;
    if (!p || r.isStreaming.value) return;
    const lignes: string[] = [];
    for (const qq of p.items) {
      const parts = [...(qq._sel || [])];
      if ((qq._free || "").trim()) parts.push(qq._free.trim());
      if (parts.length) lignes.push(`**${qq.q}**  \n${parts.join(" ; ")}`);
    }
    if (!lignes.length) {
      ctx.showToast("Réponds à au moins une question", "info");
      return;
    }
    const brouillon = r.inputMessage.value;
    f.composeRestoreDraft = brouillon && brouillon.trim() ? brouillon : null;
    r.inputMessage.value = lignes.join("\n\n");
    void l.sendMessage();
  }

  return {
    askUserCurrent,
    resetAskUser,
    isAskOptionOn,
    toggleAskOption,
    askUserPrev,
    askUserNext,
    dismissAskUser,
    submitAskUser,
  };
}
