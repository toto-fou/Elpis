// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/runs.ts — runs en arrière-plan (portés d'`app-chat.js`) : pastilles des runs vivants, suivi par sondage d'un run non rejouable, détachement en quittant une conversation, rattachement au journal d'un run en cours. */
import { schemaResumeReveil } from "@elpis/contracts";
import type { ResumeReveil } from "@elpis/contracts";
import { journal } from "../../../platform/journal";
import { nextTick, watch } from "vue";

import { lireNdjson } from "../../../platform/streams/ndjson";
import type { GestionnaireSession } from "../../auth/session";
import { SuiviFlux } from "../suivi";
import type { RunLu } from "./etat.ts";
import type { CoeurChat, StatutGeneration } from "./liens.ts";
import type { DonneesFlux, MessageChat } from "./types.ts";

const SONDAGE_SUIVI_MS = 4000;
const SUIVI_MAX_TOURS = 5400;
const SUIVI_MAX_ECHECS = 15;

function lireJson(r: Response): Promise<unknown> {
  return r.json().catch(() => null);
}

export function creerRuns(c: CoeurChat, session: GestionnaireSession) {
  const { r, ctx, e, f, l } = c;
  let minuterieRuns: ReturnType<typeof setTimeout> | null = null;
  let minuterieSuivi: ReturnType<typeof setTimeout> | null = null;
  let toursSuivi = 0;
  let echecsSuivi = 0;
  const consoleSeule = (): boolean => !!(window as { __ADMIN_ONLY_MODE__?: boolean }).__ADMIN_ONLY_MODE__;

  function markRunActive(chatId: unknown): void {
    const id = String(chatId || "");
    if (!id || id.startsWith("__")) return;
    if (!e.activeRunIds.value.includes(id)) e.activeRunIds.value = e.activeRunIds.value.concat([id]);
    planifierSondage();
  }

  function markRunDone(chatId: unknown): void {
    const id = String(chatId || "");
    if (e.activeRunIds.value.includes(id))
      e.activeRunIds.value = e.activeRunIds.value.filter((x) => x !== id);
  }

  function planifierSondage(): void {
    if (minuterieRuns || !e.activeRunIds.value.length) return;
    minuterieRuns = setTimeout(() => {
      minuterieRuns = null;
      void refreshActiveRuns();
    }, 5000);
  }

  // Un run qui sort de la liste alors que sa conversation n'est pas affichée : réponse prête (notification).
  async function refreshActiveRuns(): Promise<void> {
    if (!r.user.value) return;
    let ids: string[] | null = null;
    try {
      const rep = await ctx.fetchAuth("/api/chats/active-runs", {}, true);
      if (rep && rep.ok) {
        const d = await lireJson(rep);
        const brut = d && typeof d === "object" ? (d as { chat_ids?: unknown }).chat_ids : null;
        if (Array.isArray(brut)) ids = brut.map(String);
      }
    } catch {
      /* réessayé au sondage suivant */
    }
    if (ids === null) {
      planifierSondage();
      return;
    }
    const vivants = ids;
    const affiche = String(r.currentChatId.value || "");
    const finis = e.activeRunIds.value.filter(
      (id) => !vivants.includes(id) && !(id === affiche && r.isStreaming.value),
    );
    const garder = affiche && r.isStreaming.value && e.activeRunIds.value.includes(affiche) ? [affiche] : [];
    e.activeRunIds.value = Array.from(new Set(vivants.concat(garder)));
    if (finis.length) {
      try {
        void l.loadChatsList();
      } catch {
        /* liste relue plus tard */
      }
      for (const id of finis) {
        if (id === affiche) continue;
        const titre = e.chats.value.find((x) => String(x.id) === id)?.title || "Conversation";
        try {
          ctx.notifyChatDone?.(id, titre);
        } catch {
          /* notification indisponible */
        }
      }
    }
    planifierSondage();
  }

  watch(
    r.user,
    (u) => {
      if (u && !consoleSeule()) void refreshActiveRuns();
    },
    { immediate: true },
  );
  if (!consoleSeule())
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && r.user.value) void refreshActiveRuns();
    });

  // Bulle de suivi : retirée par recherche (elle n'est plus la dernière dès qu'un message la suit).
  function setFollowBubble(on: boolean): void {
    const msgs = r.messages.value;
    const dernier = msgs.length ? msgs[msgs.length - 1] : null;
    if (on) {
      if (dernier && dernier.role === "assistant" && dernier._followBubble) return;
      msgs.push({
        role: "assistant",
        content: "",
        thinking: "",
        thinkingOpen: false,
        _statusLine: "Génération en cours…",
        isStreaming: true,
        isError: false,
        errorMessage: "",
        isTruncated: false,
        _followBubble: true,
      });
    } else
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?._followBubble) msgs.splice(i, 1);
      }
  }

  function stopFollowRun(): void {
    if (minuterieSuivi) {
      clearTimeout(minuterieSuivi);
      minuterieSuivi = null;
    }
    toursSuivi = 0;
    echecsSuivi = 0;
    const id = e.followedRunChatId.value;
    if (!id) return;
    e.followedRunChatId.value = null;
    markRunDone(id);
    if (String(r.currentChatId.value) === String(id)) setFollowBubble(false);
    // Sans flux local ni contrôleur, le drapeau « en cours » appartient au suivi : on peut le baisser.
    if (r.isStreaming.value && !e.abortController.value) {
      r.isStreaming.value = false;
      e.isThinking.value = false;
      e.statusText.value = "";
    }
  }

  function afficherSuivi(id: string): void {
    if (String(r.currentChatId.value) === id && !e.abortController.value) {
      setFollowBubble(true);
      r.isStreaming.value = true;
      f.streamingForChatId = id;
    }
  }

  // Sonde l'état de génération et recharge la conversation à la fin ; aucun tour n'est jamais rejoué.
  function followRun(chatId: unknown, opts?: { silent?: boolean }): void {
    const id = String(chatId || "");
    if (!id) return;
    if (e.followedRunChatId.value === id) {
      afficherSuivi(id);
      return;
    }
    stopFollowRun();
    e.followedRunChatId.value = id;
    markRunActive(id);
    afficherSuivi(id);
    if (!opts?.silent)
      ctx.showToast("La génération continue côté serveur — la conversation se rechargera à la fin.", "info", {
        duration: 8000,
      });
    const tour = async (): Promise<void> => {
      minuterieSuivi = null;
      if (e.followedRunChatId.value !== id) return;
      if (++toursSuivi > SUIVI_MAX_TOURS) {
        stopFollowRun();
        return;
      }
      let enCours: boolean | null = null;
      let disparu = false;
      try {
        const rep = await ctx.fetchAuth(
          "/api/chat/" + encodeURIComponent(id) + "/generation-status",
          {},
          true,
        );
        if (rep && rep.ok) {
          const d = await lireJson(rep);
          if (d && typeof d === "object") enCours = !!(d as StatutGeneration).generation_running;
        } else if (rep && rep.status === 404) disparu = true;
      } catch {
        /* réseau : nouvelle tentative */
      }
      if (e.followedRunChatId.value !== id) return;
      if (disparu) {
        stopFollowRun();
        return;
      }
      if (enCours === null) {
        if (++echecsSuivi >= SUIVI_MAX_ECHECS) {
          stopFollowRun();
          ctx.showToast(
            "Suivi de la génération interrompu : le serveur ne répond plus. Rechargez la conversation pour vérifier son état.",
            "warning",
            { duration: 8000 },
          );
          return;
        }
      } else echecsSuivi = 0;
      if (enCours === false) {
        stopFollowRun();
        if (String(r.currentChatId.value) === id && !r.isStreaming.value) {
          try {
            await l.loadChat(id, { force: true });
          } catch {
            /* rechargement manuel possible */
          }
          ctx.showToast("Génération terminée — conversation à jour.", "success", { duration: 5000 });
        } else {
          ctx.showToast("Une génération en arrière-plan est terminée.", "info", { duration: 5000 });
          try {
            void ctx.loadChatsList?.();
          } catch {
            /* liste relue plus tard */
          }
        }
        return;
      }
      minuterieSuivi = setTimeout(() => void tour(), SONDAGE_SUIVI_MS);
    };
    minuterieSuivi = setTimeout(() => void tour(), SONDAGE_SUIVI_MS);
  }

  function resetStreamState(): void {
    l.stopStreamFlush();
    if (f.thinkFlushTimer) {
      clearInterval(f.thinkFlushTimer);
      f.thinkFlushTimer = null;
    }
    if (f.preContentFlushTimer) {
      clearInterval(f.preContentFlushTimer);
      f.preContentFlushTimer = null;
    }
    f.streamBuf = "";
    f.thinkBuf = "";
    f.preContentBuf = "";
    f.streamToolPhase = false;
    f.toolsExecutedThisTurn = false;
    f.pendingAskUser = null;
    l.resetDeltaStatus();
    if (f.ctxLive) l.clearLiveCtx();
    l.stopCompressionTick();
    e.compressionProgress.value = 0;
    e.compressionStatus.value = null;
    e.queueStatus.value = null;
  }

  /** On quitte la conversation qui génère : la lecture s'arrête, le run continue côté serveur. */
  function detachFromStream(): boolean {
    const run = f.currentRun;
    const id = f.streamingForChatId;
    if (e.followedRunChatId.value) setFollowBubble(false);
    if (!run || run.detached || !r.isStreaming.value) {
      if (r.isStreaming.value && !e.abortController.value) {
        r.isStreaming.value = false;
        e.isThinking.value = false;
        e.statusText.value = "";
      }
      return false;
    }
    run.detached = true;
    f.pendingReattach = null;
    if (id && !String(id).startsWith("__")) markRunActive(id);
    f.activeGen++;
    if (run.posted && e.abortController.value) {
      try {
        e.abortController.value.abort();
      } catch {
        /* déjà interrompu */
      }
    }
    e.abortController.value = null;
    l.closeToolStreamsFor(id || null);
    f.shellPend.clear();
    if (f.shellFlushTimer) {
      clearTimeout(f.shellFlushTimer);
      f.shellFlushTimer = null;
    }
    resetStreamState();
    r.isStreaming.value = false;
    e.isThinking.value = false;
    e.statusText.value = "";
    e.pendingWrite.value = null;
    f.streamingForChatId = null;
    f.currentRun = null;
    return true;
  }

  async function reattachOrFollow(chatId: string, reveil?: ResumeReveil): Promise<void> {
    const id = String(chatId || "");
    if (!id) return;
    let st: StatutGeneration | null = null;
    try {
      const rep = await ctx.fetchAuth("/api/chat/" + encodeURIComponent(id) + "/generation-status", {}, true);
      if (rep && rep.ok) {
        const d = await lireJson(rep);
        st = d && typeof d === "object" ? (d as StatutGeneration) : null;
      }
    } catch {
      /* état inconnu */
    }
    if (String(r.currentChatId.value) !== id) {
      if (st?.generation_running) markRunActive(id);
      return;
    }
    if (!st || !st.generation_running) {
      try {
        await l.loadChat(id, { force: true, noAttach: true });
      } catch {
        /* rechargement manuel possible */
      }
      return;
    }
    if (st.resumable && st.run_id) await attachRun(id, st, reveil);
    else followRun(id, { silent: true });
  }

  // Réconcilie le fil (la base est dans l'état d'avant le tour), puis pose la question (déjà en réveil si connu) et la bulle du tour.
  function reconcilierFil(st: StatutGeneration, reveil?: ResumeReveil): void {
    const msgs = r.messages.value;
    const base = Math.max(0, Number(st.base_count) || 0);
    const bulle = (): MessageChat => ({
      role: "assistant",
      content: "",
      thinking: "",
      thinkingOpen: false,
      _statusLine: "",
      isStreaming: true,
      isError: false,
      errorMessage: "",
      isTruncated: false,
    });
    if (st.is_continue) {
      let li = -1;
      for (let i = msgs.length - 1; i >= 0; i--)
        if (msgs[i]?.role === "assistant") {
          li = i;
          break;
        }
      const cur = msgs[li];
      if (li >= 0 && cur)
        msgs[li] = Object.assign({}, cur, {
          isStreaming: true,
          isTruncated: false,
          isError: false,
          errorMessage: "",
          iterBudget: null,
        });
      else msgs.push(bulle());
      return;
    }
    const ireq = st.image_request && typeof st.image_request === "object" ? st.image_request : null;
    const q = ireq && base > 0 ? msgs[base - 1] : null;
    if (q && q.role === "user") {
      if (msgs.length > base) msgs.splice(base);
      if (!q.image_request) msgs[base - 1] = Object.assign({}, q, { image_request: ireq });
    } else {
      const garder = base > 0 ? base - 1 : msgs.length;
      if (msgs.length > garder) msgs.splice(garder);
      if (st.user_message)
        msgs.push(
          Object.assign(
            { role: "user", content: st.user_message },
            ireq ? { image_request: ireq } : {},
            reveil ? { origin: "job_wake", wake: reveil } : {},
          ),
        );
    }
    msgs.push(
      Object.assign(bulle(), ireq ? { _imageTurn: true, _imageProgress: l.imageInitialProgress(ireq) } : {}),
    );
  }

  /** Tour de réveil : la question posée à la place de l'utilisateur devient une ligne de réveil. */
  function marquerReveil(evt: unknown): void {
    const ev = (evt ?? {}) as { origin?: unknown; wake?: unknown; user_message?: unknown };
    if (ev.origin !== "job_wake") return;
    const wake = schemaResumeReveil.safeParse(ev.wake);
    const msgs = r.messages.value;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== "user") continue;
      if (typeof ev.user_message === "string" && m.content !== ev.user_message) return;
      msgs[i] = Object.assign({}, m, { origin: "job_wake" }, wake.success ? { wake: wake.data } : {});
      return;
    }
  }

  /** Se rattache au run en cours de la conversation affichée : rejoue son journal puis suit le direct. */
  async function attachRun(
    chatId: unknown,
    st: StatutGeneration | null | undefined,
    reveil?: ResumeReveil,
  ): Promise<boolean> {
    const id = String(chatId || "");
    if (!id || !st || !st.run_id) return false;
    if (String(r.currentChatId.value) !== id) return false;
    if (r.isStreaming.value && e.abortController.value) return false;
    if (String(e.followedRunChatId.value || "") === id) stopFollowRun();
    const mien = ++f.activeGen;
    const run: RunLu = {
      gen: mien,
      chatId: id,
      posted: true,
      detached: false,
      attached: true,
      stopped: false,
    };
    f.currentRun = run;
    resetStreamState();
    l.clearToolStreams();
    reconcilierFil(st, reveil);
    r.isStreaming.value = true;
    e.isThinking.value = true;
    e.statusText.value = "";
    r.isUserScrolling.value = false;
    f.streamingForChatId = id;
    const ctl = new AbortController();
    e.abortController.value = ctl;
    markRunActive(id);
    l.seedLiveCtx();
    void nextTick(() => l.scrollToBottom(true));

    let finalVu = false;
    let perdu = false;
    f.replaying = true;
    try {
      const rep = await fetch(
        "/api/chat/" + encodeURIComponent(id) + "/run/events?run_id=" + encodeURIComponent(st.run_id),
        { signal: ctl.signal, credentials: "same-origin" },
      );
      if (rep.status === 401) {
        perdu = true;
        try {
          await ctx.checkAuth?.();
        } catch {
          /* session réglée par l'authentification */
        }
      } else if (!rep.ok || !rep.body) perdu = true;
      else {
        // Un événement inconnu, illisible, d'une session révolue ou d'un autre chat n'est jamais appliqué.
        const suivi = new SuiviFlux({
          chatId: id,
          generation: session.generation,
          generationCourante: () => session.generation,
          actif: () => mien === f.activeGen,
          rejeu: true,
        });
        for await (const evt of lireNdjson(rep.body)) {
          const res = suivi.recevoir(evt);
          if (mien !== f.activeGen) break;
          const ev = res.ev;
          if (!res.appliquer || !ev) continue;
          const t = res.type;
          if (t === "replay_done") {
            f.replaying = false;
            void nextTick(() => l.scrollToBottom(true));
            continue;
          }
          if (t === "run_started") {
            marquerReveil(ev);
            continue;
          }
          if (t === "ping") continue;
          if (t === "run_end") break;
          if (t === "run_lost" || t === "session_expired") {
            perdu = true;
            break;
          }
          if (t === "final") finalVu = true;
          try {
            await l.handleStreamEvent(ev as unknown as DonneesFlux);
          } catch (err) {
            journal.erreur("[chat] rattachement : événement en échec", err, t);
          }
        }
      }
    } catch (err) {
      if (!(err instanceof Error) || err.name !== "AbortError") perdu = true;
    } finally {
      f.replaying = false;
      l.stopStreamFlush();
    }
    if (mien !== f.activeGen) return true;
    if (f.ctxLive) l.clearLiveCtx();
    if (f.thinkFlushTimer) {
      clearInterval(f.thinkFlushTimer);
      f.thinkFlushTimer = null;
    }
    if (f.preContentFlushTimer) {
      clearInterval(f.preContentFlushTimer);
      f.preContentFlushTimer = null;
    }
    e.abortController.value = null;
    e.pendingWrite.value = null;
    f.streamingForChatId = null;
    if (f.currentRun === run) f.currentRun = null;
    r.isStreaming.value = false;
    e.isThinking.value = false;
    e.statusText.value = "";
    markRunDone(id);
    // Fin sans `final` : la vérité est en base (un Stop utilisateur a déjà finalisé la bulle).
    if ((perdu || !finalVu) && !run.stopped && String(r.currentChatId.value) === id) {
      try {
        await l.loadChat(id, { force: true, noAttach: true });
      } catch {
        /* rechargement manuel possible */
      }
    } else if (finalVu)
      void nextTick(() => {
        if (r.user.value) void l.loadChatsList();
      });
    return true;
  }

  // Supprimer une conversation qui génère : le run s'arrête d'abord (premier plan, suivi ou détaché).
  function stopRunForChat(chatId: unknown): boolean {
    const id = String(chatId || "");
    if (!id || id.startsWith("__")) return false;
    if (r.isStreaming.value && String(f.streamingForChatId || "") === id) {
      l.stopGeneration();
      return true;
    }
    const suivi = String(e.followedRunChatId.value || "") === id;
    if (suivi || e.activeRunIds.value.includes(id)) {
      void ctx
        .fetchAuth("/api/chat/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: id }),
        })
        .catch(() => null);
      if (suivi) stopFollowRun();
      markRunDone(id);
      return true;
    }
    return false;
  }

  function oublierRuns(): void {
    f.currentRun = null;
    f.streamingForChatId = null;
    e.activeRunIds.value = [];
    if (minuterieRuns) {
      clearTimeout(minuterieRuns);
      minuterieRuns = null;
    }
  }

  return {
    markRunActive,
    markRunDone,
    refreshActiveRuns,
    setFollowBubble,
    stopFollowRun,
    followRun,
    resetStreamState,
    detachFromStream,
    reattachOrFollow,
    attachRun,
    stopRunForChat,
    oublierRuns,
  };
}
