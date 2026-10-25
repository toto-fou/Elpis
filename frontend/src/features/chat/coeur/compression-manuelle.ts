// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/compression-manuelle.ts — compression manuelle (commande /compact, bouton près de la jauge) et état de compression du chat affiché (portés d'`app-chat.js`). */
import { nextTick, watch } from "vue";

import { comprSkipLabel } from "./formats.ts";
import type { CoeurChat } from "./liens.ts";
import type { Objet } from "./types.ts";

interface IssueCompactage {
  ok?: boolean;
  after?: number;
  summary?: string;
  reason?: string;
}

const estObjet = (v: unknown): v is Objet => !!v && typeof v === "object" && !Array.isArray(v);

export function creerCompressionManuelle(c: CoeurChat) {
  const { r, ctx, e, f, l } = c;
  let minuterieNotice: ReturnType<typeof setTimeout> | null = null;

  async function refreshCompressionState(): Promise<void> {
    const id = r.currentChatId.value;
    if (!id) {
      e.compressionState.value = null;
      e.compressionCapped.value = null;
      return;
    }
    try {
      const res = await ctx.fetchAuth("/api/chat/" + encodeURIComponent(id) + "/compression-state", {}, true);
      if (String(r.currentChatId.value) !== String(id)) return;
      if (res && res.ok) {
        const d: unknown = await res.json();
        e.compressionState.value = estObjet(d) ? d : null;
        e.compressionCapped.value =
          estObjet(d) && d["reason"] === "max_reached"
            ? { round: Number(d["round"]) || 0, max: Number(d["max"]) || 0 }
            : null;
      } else {
        e.compressionState.value = null;
        e.compressionCapped.value = null;
      }
    } catch {
      /* le bouton garde son dernier état */
    }
  }

  // Ligne de compaction scopée au chat qui la lance ; le succès devient une notice persistée dans le fil.
  async function manualCompress(): Promise<void> {
    const id = r.currentChatId.value;
    if (!id) {
      ctx.showToast("Rien à compacter pour l’instant", "info");
      return;
    }
    if (e.manualCompressBusy.value) return;
    e.manualCompressBusy.value = true;
    e.manualCompressChatId.value = id;
    const t0 = Date.now();
    if (minuterieNotice) {
      clearTimeout(minuterieNotice);
      minuterieNotice = null;
    }
    let estMs = 10000;
    try {
      estMs = l.estimateCompressionMs("self") || 10000;
    } catch {
      /* estimation par défaut */
    }
    e.compactionNotice.value = { state: "running", chatId: id, pct: 0 };
    const debutPct = Date.now();
    // Progression pilotée par JS (sous mouvement réduit, les animations CSS sont coupées).
    const minuteriePct = setInterval(() => {
      const cn = e.compactionNotice.value;
      if (!cn || cn.state !== "running" || cn.chatId !== id) {
        clearInterval(minuteriePct);
        return;
      }
      const ecoule = Date.now() - debutPct;
      const pct =
        ecoule <= estMs
          ? Math.round((ecoule / estMs) * 70)
          : Math.min(88, 70 + Math.round(((ecoule - estMs) / estMs) * 18));
      e.compactionNotice.value = { ...cn, pct };
    }, 350);
    void nextTick(() => l.scrollToBottom());
    const conclure = (v: IssueCompactage): void => {
      clearInterval(minuteriePct);
      if (v.ok) {
        e.compactionNotice.value = null;
        if (r.currentChatId.value === id) {
          r.messages.value.push(
            Object.freeze({
              role: "notice",
              kind: "compaction",
              ts: Date.now() / 1000,
              tokens_after: v.after || 0,
              summary: v.summary || "",
              content: "",
            }),
          );
          void nextTick(() => l.scrollToBottom());
        }
      } else
        e.compactionNotice.value = {
          state: "skip",
          chatId: id,
          reason: v.reason || "Échec de la compression",
        };
    };
    try {
      const res = await ctx.fetchAuth(
        "/api/chat/" + encodeURIComponent(id) + "/compress",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: e.selectedModel.value || null,
            connector_id: e.selectedConnector.value || null,
          }),
        },
        true,
      );
      const brut: unknown = res ? await res.json().catch(() => null) : null;
      const d = estObjet(brut) ? brut : null;
      if (res && res.ok && d && d["compressed"]) {
        const st = estObjet(d["stats"]) ? d["stats"] : {};
        try {
          l.recordCompressionDuration(String(st["path"] || "self"), Date.now() - t0);
        } catch {
          /* historique indisponible */
        }
        if (r.currentChatId.value === id) {
          // La dernière mesure décrit l'historique d'avant compression : la jauge repart masquée.
          f.lastCtxUsed = 0;
          e.ctxRealPct.value = 0;
          e.ctxUsage.value = null;
        }
        conclure({
          ok: true,
          after: Number(st["tokens_after"]) || 0,
          summary: String(st["summary_xml"] || ""),
        });
      } else if (res && res.status === 409) {
        const raison = String((d && (d["detail"] || d["reason"] || d["error"])) || "");
        conclure({
          reason: raison.includes("generation")
            ? "Génération en cours — réessayez après"
            : raison.includes("chat_modified")
              ? "Le chat a changé — réessayez"
              : "Compression déjà en cours",
        });
      } else if (d && d["reason"]) conclure({ reason: comprSkipLabel(d["reason"]) });
      else conclure({ reason: "Échec de la compression" });
    } catch {
      conclure({ reason: "Échec de la compression" });
    } finally {
      e.manualCompressBusy.value = false;
      e.manualCompressChatId.value = null;
      if (e.compactionNotice.value && e.compactionNotice.value.state === "skip")
        minuterieNotice = setTimeout(() => {
          e.compactionNotice.value = null;
        }, 6000);
      if (r.currentChatId.value === id) void refreshCompressionState();
    }
  }

  // Changement de conversation : la voix suit le fil affiché (pas à la naissance de l'id du chat neuf).
  watch(r.currentChatId, (_nouveau, ancien) => {
    if (ancien)
      try {
        l.voix().cancelVoice();
      } catch {
        /* voix absente */
      }
    e.compressionCapped.value = null;
    e.compressionState.value = null;
    f.lastCtxUsed = 0;
    e.ctxRealPct.value = 0;
    e.ctxUsage.value = null;
    void refreshCompressionState();
  });

  return { refreshCompressionState, manualCompress };
}
