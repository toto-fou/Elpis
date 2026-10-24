// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/generation.ts — tour de génération (porté d'`app-chat.js`) : envoi, flux NDJSON lu et suivi, reprises (409, coupure après outils), arrêt, continuation, « répondre maintenant », régénération, jauge de contexte en direct. */
import { journal } from "../../../platform/journal";
import { nextTick } from "vue";

import { fmtElapsed } from "../../../utils/utils-purs.ts";
import { lireNdjson } from "../../../platform/streams/ndjson";
import type { GestionnaireSession } from "../../auth/session";
import { SuiviFlux } from "../suivi";
import type { RunLu } from "./etat.ts";
import { fmtTokens } from "./formats.ts";
import type { CoeurChat } from "./liens.ts";
import { garderPourPersistance, projeterPourPersistance } from "./persistance.ts";
import { PRE_RENDER_CLEAR, STREAM_RENDER_CLEAR } from "./rendu-flux.ts";
import type { DonneesFlux, MessageChat, Objet } from "./types.ts";

const RETENTATIVES_MAX = 2;
const REPRISE_CLEAR: Readonly<Objet> = Object.freeze({
  isTruncated: false,
  toolLoopTruncated: false,
  toolLoopStats: null,
});

const estObjet = (v: unknown): v is Objet => !!v && typeof v === "object" && !Array.isArray(v);
const attendre = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Bulle assistant vide d'un nouveau tour. */
export function bulleAssistant(): MessageChat {
  return {
    role: "assistant",
    content: "",
    thinking: "",
    thinkingOpen: false,
    _statusLine: "",
    isStreaming: true,
    isError: false,
    errorMessage: "",
    isTruncated: false,
  };
}

/** Les marqueurs de reprise ne valent que pour la dernière bulle : les autres sont purgés. */
export function retirerReprisesPerimees(msgs: MessageChat[], sauf: number): void {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (i !== sauf && m && m.role === "assistant" && (m.isTruncated || m.toolLoopTruncated))
      msgs[i] = Object.assign({}, m, REPRISE_CLEAR);
  }
}

class Erreur401 extends Error {}

export function creerGeneration(c: CoeurChat, session: GestionnaireSession) {
  const { r, ctx, e, f, l } = c;

  // La jauge n'a de sens que pour l'intégré, ou un connecteur dont le moteur annonce sa fenêtre (llama.cpp, vLLM, SGLang).
  function ctxGaugeApplicable(): boolean {
    if (!e.selectedConnector.value) return true;
    const meta = e.selectedEngineMeta.value as { llamacpp?: unknown; contexte?: unknown } | null;
    return !!meta?.llamacpp || !!meta?.contexte;
  }

  function getCtxSize(): number {
    if (!ctxGaugeApplicable()) return 0;
    if (e.selectedConnector.value)
      return Number((e.selectedEngineMeta.value as { n_ctx?: unknown } | null)?.n_ctx) || 0;
    return Number(e.llmHealth.value?.props?.n_ctx) || 0;
  }

  function stopGenTicker(): void {
    if (f.genTicker) {
      clearInterval(f.genTicker);
      f.genTicker = null;
    }
  }

  function clearLiveCtx(): void {
    f.ctxLive = null;
    f.inThinkPhase = false;
    stopGenTicker();
    e.liveGen.value = null;
  }

  // Ligne de statistiques en direct : réassignée seulement quand l'affichage change.
  function startGenTicker(): void {
    stopGenTicker();
    const tic = (): void => {
      const vivant = f.ctxLive;
      if (!vivant) {
        stopGenTicker();
        e.liveGen.value = null;
        return;
      }
      const sec = Math.max(0, (Date.now() - f.genStartMs) / 1000);
      const brut = vivant.base;
      if (brut > 0) f.lastCtxUsed = brut;
      // Occupation réelle, jamais bornée à la fenêtre ; seul le pourcentage l'est.
      const utilise = vivant.total && brut > 0 ? brut : 0;
      const suite = {
        model: e.selectedModel.value || "",
        sec,
        secLabel: fmtElapsed(sec, { live: true }),
        tokPerSec: f.inThinkPhase || !vivant.gen ? null : sec > 0.3 ? Math.round(vivant.gen / sec) : 0,
        ctxLabel: vivant.total > 0 ? fmtTokens(utilise) + " / " + fmtTokens(vivant.total) : "",
        pct: utilise > 0 ? Math.min(100, Math.round((utilise / vivant.total) * 100)) : 0,
      };
      const cur = e.liveGen.value;
      if (
        !cur ||
        cur.model !== suite.model ||
        cur.secLabel !== suite.secLabel ||
        cur.tokPerSec !== suite.tokPerSec ||
        cur.ctxLabel !== suite.ctxLabel ||
        cur.pct !== suite.pct
      )
        e.liveGen.value = suite;
    };
    tic();
    f.genTicker = setInterval(tic, 200);
  }

  // Base = dernière occupation réelle connue ; aucune estimation n'est jamais affichée.
  function seedLiveCtx(): void {
    const applicable = ctxGaugeApplicable();
    const kv = applicable && !e.selectedConnector.value ? e.llmHealth.value?.kv_cache || null : null;
    const total = applicable ? getCtxSize() || kv?.total || 0 : 0;
    f.ctxLive = { base: f.lastCtxUsed > 0 ? f.lastCtxUsed : 0, gen: 0, total };
    f.inThinkPhase = false;
    f.genStartMs = Date.now();
    startGenTicker();
  }

  /** Crée le chat côté serveur s'il n'existe pas (le mode plan armé et les collections RAG choisies sont scellés dans le même appel). */
  async function ensureServerChat(source: string, run?: RunLu): Promise<string | false> {
    if (r.currentChatId.value) return r.currentChatId.value;
    const rag = l.ragEnAttente();
    try {
      const res = await ctx.fetchAuth("/api/saved/chats/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_mode: !!e.planMode.value,
          ...(rag.length ? { rag_collections: rag } : {}),
        }),
      });
      if (!res || !res.ok) return false;
      const d: unknown = await res.json();
      const id = estObjet(d) && d["id"] ? String(d["id"]) : "";
      if (!id) return false;
      const titre =
        String(source || "")
          .substring(0, 60)
          .trim()
          .replace(/\n.*/s, "") || "Nouveau chat";
      if (!run || !run.detached) {
        r.currentChatId.value = id;
        e.currentChatTitle.value = titre;
        if (rag.length) l.ragCreation(estObjet(d) ? d["rag_collections"] : null);
      }
      e.chats.value.unshift({ id, title: titre, updated_at: Date.now() / 1000 });
      return id;
    } catch {
      return false;
    }
  }

  function serveursActifs(mcp: boolean): Objet[] {
    const actifs: Objet[] = [];
    if (!mcp) return actifs;
    const cats = Object.keys(e.localTools.value).filter((k) => e.localTools.value[k]);
    if (cats.length > 0)
      actifs.push({
        type: "stdio",
        name: "Outils Locaux",
        command: "DEFAULT_LOCAL_PYTHON",
        filter_categories: cats,
      });
    for (const s of e.manifestServers.value || [])
      if (s && e.manifestTools.value[s.name])
        actifs.push({ manifest: s.name, name: s.name, type: "manifest" });
    // Référence seule : le serveur résout URL et authentification depuis son magasin.
    for (const id of r.config.value.active_mcp_ids || []) {
      const srv = l.pinnedServers().find((s) => s.id === id);
      if (srv)
        actifs.push({ id: srv.id, name: srv.name, type: srv.type, ...(srv.shared ? { shared: true } : {}) });
    }
    return actifs;
  }

  function marquerErreur(p: Objet): void {
    const msgs = l.getStreamMsgs();
    const li = l.streamIdx(msgs);
    if (li >= 0 && msgs[li]?.role === "assistant")
      l.patch(li, { ...p, isStreaming: false, ...STREAM_RENDER_CLEAR });
  }

  /** Réponse refusée avant le flux (états métier, sans nouvelle tentative) ; vrai si le tour est clos. */
  async function refusMetier(rep: Response, imageGen: Objet | null): Promise<boolean> {
    if (rep.status === 429) {
      const msg = "Trop de générations en cours sur votre compte — attendez qu'une d'elles se termine.";
      const msgs = l.getStreamMsgs();
      const li = msgs.length - 1;
      if (li >= 0 && msgs[li]?.role === "assistant")
        l.patch(li, { isError: true, errorMessage: msg, isStreaming: false, ...STREAM_RENDER_CLEAR });
      ctx.showToast(msg, "info");
      return true;
    }
    if (rep.status === 409) {
      await refus409(rep, imageGen);
      return true;
    }
    if (imageGen && [400, 403, 404, 413, 503].includes(rep.status)) {
      let detail: unknown = null;
      try {
        const corps: unknown = await rep.json();
        detail = estObjet(corps) ? corps["detail"] : null;
      } catch {
        /* corps illisible */
      }
      const codes: Readonly<Record<number, string>> = {
        403: "forbidden",
        413: "too_large",
        503: "unavailable",
      };
      const code = (estObjet(detail) && detail["code"]) || codes[rep.status] || "invalid";
      const msg = typeof detail === "string" ? detail : String((estObjet(detail) && detail["message"]) || "");
      marquerErreur({
        _imageErrorLive: true,
        image_error: { code, message: msg, retryable: rep.status === 503 },
        _imageProgress: null,
      });
      return true;
    }
    return false;
  }

  // 409 : serveur indisponible (paire abandonnée), génération déjà en cours (suivie), autre opération.
  async function refus409(rep: Response, imageGen: Objet | null): Promise<void> {
    let raison = "";
    let detail: unknown = null;
    try {
      const corps: unknown = await rep.json();
      detail = estObjet(corps) ? corps["detail"] : null;
      raison = typeof detail === "string" ? detail : String((estObjet(detail) && detail["code"]) || "");
    } catch {
      /* corps illisible */
    }
    if (raison === "engine_unavailable" && imageGen) {
      marquerErreur({
        _imageErrorLive: true,
        image_error: {
          code: "enhance",
          retryable: true,
          message: "Enrichir indisponible : le modèle du chat ne répond pas. Décochez Enrichir ou réessayez.",
        },
        _imageProgress: null,
      });
      return;
    }
    if (raison === "engine_unavailable") {
      const em = String((estObjet(detail) && detail["message"]) || "Serveur indisponible.");
      marquerErreur({
        isError: true,
        errorMessage: em + " Choisissez un autre serveur dans le sélecteur de modèle.",
      });
      ctx.showToast(em, "error");
      if (e.selectedConnector.value) {
        e.selectedConnector.value = "";
        try {
          localStorage.setItem("selected_connector", "");
        } catch {
          /* stockage indisponible */
        }
      }
      void l.loadLlmConnectors();
      void l.loadAvailableModels();
      return;
    }
    const enCours = raison === "generation_running";
    const msg =
      raison === "compression_running"
        ? "Compression du contexte en cours — réessaie dans un instant."
        : enCours
          ? "Une génération est déjà en cours sur cette conversation — elle se rechargera à la fin."
          : "Une autre opération est en cours sur ce chat — réessaie dans un instant.";
    marquerErreur({ isError: !enCours, errorMessage: msg });
    ctx.showToast(msg, "info");
    if (enCours) {
      const sfc = String(f.streamingForChatId || "");
      l.followRun(r.currentChatId.value || (sfc.indexOf("__pending_") === 0 ? "" : sfc), { silent: true });
    }
  }

  function idFinal(): string {
    const sfc = String(f.streamingForChatId || "");
    return r.currentChatId.value || (sfc.indexOf("__pending_") === 0 ? "" : sfc);
  }

  // Ne jamais rejouer un tour dont des outils ont tourné, ni un tour image accepté par le serveur.
  function echecReseau(err: unknown, serveurMaitre: boolean, imageGen: Objet | null): void {
    const msgs = l.getStreamMsgs();
    const li = l.streamIdx(msgs);
    const assistant = li >= 0 && msgs[li]?.role === "assistant";
    if (imageGen && !serveurMaitre && assistant) {
      l.patch(li, {
        _imageErrorLive: true,
        image_error: { code: "engine", retryable: true, message: "Demande non transmise au serveur." },
        _imageProgress: null,
        isStreaming: false,
        ...STREAM_RENDER_CLEAR,
      });
      ctx.showToast("Erreur de connexion", "error");
      return;
    }
    if (assistant)
      l.patch(li, {
        isError: !serveurMaitre,
        errorMessage: serveurMaitre
          ? "Connexion interrompue — la génération se poursuit côté serveur. Cette conversation se rechargera automatiquement à la fin."
          : (err instanceof Error && err.message) || "Erreur réseau",
        isStreaming: false,
        ...STREAM_RENDER_CLEAR,
      });
    if (serveurMaitre) {
      const coupe = idFinal();
      if (coupe) f.pendingReattach = String(coupe);
      ctx.showToast(
        "Connexion interrompue — la génération se poursuit côté serveur, reprise de l’affichage…",
        "info",
      );
    } else ctx.showToast("Erreur de connexion", "error");
  }

  /** Remise à zéro des tampons et minuteries d'un nouveau tour affiché. */
  function preparerTour(continuation: boolean): void {
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
    seedLiveCtx();
    if (!continuation) l.closeToolStreamsFor(r.currentChatId.value || f.streamingForChatId || null);
    e.isThinking.value = true;
    e.statusText.value = "";
    r.isUserScrolling.value = false;
    ctx._lockAutoScroll?.();
  }

  // Captures web des messages précédents libérées (non persistées).
  function libererCaptures(): void {
    try {
      const msgs = r.messages.value;
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m?.webScreenshots || !m.webScreenshots.length) continue;
        for (const s of m.webScreenshots)
          if (s.blobUrl)
            try {
              URL.revokeObjectURL(s.blobUrl);
            } catch {
              /* déjà libérée */
            }
        msgs[i] = Object.assign({}, m, {
          webScreenshots: [],
          webScreenshotIdx: null,
          webScreenshotExpanded: false,
        });
      }
    } catch {
      /* liste en cours de remplacement */
    }
  }

  function charge(sMsgs: MessageChat[], continuation: boolean): { payload: Objet[]; prefill: string | null } {
    const brut = continuation ? sMsgs : sMsgs.slice(0, -1);
    // « Répondre maintenant » : préremplissage capturé puis effacé de la source (une seule fois).
    let prefill: string | null = null;
    const dernier = brut[brut.length - 1];
    if (continuation && dernier && dernier.role === "assistant" && dernier._respondNowPrefill) {
      prefill = dernier._respondNowPrefill;
      const nettoye = Object.assign({}, dernier);
      delete nettoye._respondNowPrefill;
      sMsgs[sMsgs.length - 1] = nettoye;
    }
    const payload = brut.filter(garderPourPersistance).map(projeterPourPersistance);
    if (prefill) payload.push({ role: "assistant", content: prefill });
    return { payload, prefill };
  }

  function corpsEnvoi(
    run: RunLu,
    payload: Objet[],
    prefill: string | null,
    continuation: boolean,
    skills: string[],
    imageGen: Objet | null,
    mcp: boolean,
  ): string {
    const budget = l.thinkingBudget();
    return JSON.stringify({
      messages: payload,
      chat_id: run.chatId && !run.chatId.startsWith("__") ? run.chatId : "",
      resumable: true,
      ctx_size: getCtxSize(),
      active_mcp_servers: serveursActifs(mcp),
      excluded_tools: mcp ? l.excludedNames() : [],
      model: e.selectedModel.value || null,
      connector_id: e.selectedConnector.value || null,
      // Un préremplissage d'assistant est incompatible avec la réflexion côté llama.cpp.
      thinking_mode: prefill ? false : typeof budget === "number" && budget > 0,
      is_continue: continuation,
      pinned_skills: skills,
      sampling_override: l.cleanSamplingOverride(),
      ...(imageGen ? { image_gen: imageGen } : {}),
    });
  }

  /** Lit le flux d'une réponse acceptée ; une fin propre sans conclusion appliquée (absente ou hors contrat) arme le rattachement. */
  async function lireFlux(rep: Response, run: RunLu, mien: number): Promise<void> {
    if (!rep.body) throw new Error("HTTP " + rep.status);
    const suivi = new SuiviFlux({
      chatId: run.chatId && !run.chatId.startsWith("__") ? run.chatId : null,
      generation: session.generation,
      generationCourante: () => session.generation,
      actif: () => mien === f.activeGen,
      rejeu: false,
    });
    let finPropre = true;
    let conclu = false;
    for await (const evt of lireNdjson(rep.body)) {
      const res = suivi.recevoir(evt);
      if (mien !== f.activeGen) {
        finPropre = false;
        break;
      }
      const ev = res.ev;
      if (!res.appliquer || !ev) continue;
      if (ev.type === "final" || ev.type === "error") conclu = true;
      try {
        await l.handleStreamEvent(ev as unknown as DonneesFlux);
      } catch (err) {
        journal.erreur("[chat] handleStreamEvent a échoué :", err, res.type);
      }
      if (mien !== f.activeGen) {
        finPropre = false;
        break;
      }
    }
    if (finPropre && (suivi.etat.terminal === null || !conclu) && mien === f.activeGen) {
      const fin = idFinal();
      if (fin) f.pendingReattach = String(fin);
    }
  }

  function reinitRetentative(): void {
    const msgs = l.getStreamMsgs();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "assistant" && m.isStreaming) {
        msgs[i] = Object.assign(
          {},
          m,
          {
            content: "",
            thinking: "",
            _pendingPreContent: "",
            isError: false,
            errorMessage: "",
            isTruncated: false,
          },
          STREAM_RENDER_CLEAR,
          PRE_RENDER_CLEAR,
        );
        break;
      }
    }
    f.streamBuf = "";
    if (f.preContentFlushTimer) {
      clearInterval(f.preContentFlushTimer);
      f.preContentFlushTimer = null;
    }
    f.preContentBuf = "";
    f.streamToolPhase = false;
  }

  // Épilogue gardé par le jeton : une génération supplantée ne touche pas à l'état de sa remplaçante.
  function epilogue(run: RunLu, mien: number): void {
    if (mien !== f.activeGen) return;
    if (f.ctxLive) clearLiveCtx();
    if (f.thinkFlushTimer) {
      clearInterval(f.thinkFlushTimer);
      f.thinkFlushTimer = null;
    }
    if (f.preContentFlushTimer) {
      clearInterval(f.preContentFlushTimer);
      f.preContentFlushTimer = null;
    }
    f.pendingAskUser = null;
    // Run détaché suivi sur la conversation affichée : l'état « en cours » reste (bouton Arrêter offert).
    const suivi =
      !!e.followedRunChatId.value && String(e.followedRunChatId.value) === String(r.currentChatId.value);
    r.isStreaming.value = suivi;
    e.isThinking.value = false;
    if (suivi) e.statusText.value = "Génération en arrière-plan…";
    e.abortController.value = null;
    e.pendingWrite.value = null;
    if (!f.pendingReattach) l.markRunDone(run.chatId);
    f.streamingForChatId = null;
    if (f.currentRun === run) f.currentRun = null;
  }

  async function bouclePost(
    run: RunLu,
    mien: number,
    continuation: boolean,
    runMsgs: MessageChat[],
    skills: string[],
  ): Promise<void> {
    let essais = 0;
    let imageGen: Objet | null = null;
    let imageAcceptee = false;
    for (;;) {
      if (essais > 0) {
        reinitRetentative();
        await attendre(essais * 1500);
      }
      try {
        const sMsgs = run.detached ? runMsgs : l.getStreamMsgs();
        const { payload, prefill } = charge(sMsgs, continuation);
        // Interrupteur « Outils externes » coupé : rien ne part (le serveur applique la même règle).
        const mcp = r.settings.value.enable_mcp !== false;
        const ctl = (!run.detached && e.abortController.value) || new AbortController();
        imageGen = continuation ? null : l.imageGenFor(payload);
        imageAcceptee = false;
        run.posted = true;
        const rep = await fetch("/api/chat-saved-stream3", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: corpsEnvoi(run, payload, prefill, continuation, skills, imageGen, mcp),
          signal: ctl.signal,
          credentials: "same-origin",
        });
        if (run.detached) {
          if (rep.ok) l.markRunActive(run.chatId);
          try {
            ctl.abort();
          } catch {
            /* déjà interrompu */
          }
          return;
        }
        if (rep.ok) l.markRunActive(run.chatId);
        if (rep.ok && imageGen) imageAcceptee = true;
        if (rep.status === 401) throw new Erreur401("401");
        if (await refusMetier(rep, imageGen)) return;
        if (!rep.ok) throw new Error("HTTP " + rep.status);
        await lireFlux(rep, run, mien);
        return;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        if (err instanceof Erreur401) {
          ctx.showToast("Session expirée, reconnexion...", "error");
          await ctx.checkAuth?.();
          return;
        }
        const serveurMaitre = f.toolsExecutedThisTurn || (!!imageGen && imageAcceptee);
        if (essais < RETENTATIVES_MAX && !serveurMaitre && !imageGen) {
          essais++;
          e.statusText.value = "Reconnexion (" + essais + "/" + RETENTATIVES_MAX + ")...";
          continue;
        }
        echecReseau(err, serveurMaitre, imageGen);
        return;
      } finally {
        l.stopStreamFlush();
      }
    }
  }

  async function doGenerate(continuation: boolean): Promise<void> {
    // Garde anti double envoi posée avant toute attente.
    r.isStreaming.value = true;
    try {
      l.voix().onAssistantStart(continuation);
    } catch (err) {
      journal.erreur("[voix]", err);
    }
    f.todoTouchedThisTurn = false;
    const mien = ++f.activeGen;
    const runMsgs = r.messages.value;
    const run: RunLu = { gen: mien, chatId: null, posted: false, detached: false };
    f.currentRun = run;
    f.pendingReattach = null;
    try {
      const skills = l.pinnedSkillNames();
      l.clearPinnedSkills();
      e.askUserPanel.value = null;
      libererCaptures();
      if (e.abortController.value) {
        try {
          e.abortController.value.abort();
        } catch {
          /* déjà interrompu */
        }
        e.abortController.value = null;
        await attendre(0);
      }
      e.abortController.value = new AbortController();
      if (!r.currentChatId.value && !continuation) {
        const premier = r.messages.value.find((m) => m.role === "user");
        const cree = await ensureServerChat(
          premier ? premier.displayContent || premier.content || "" : "",
          run,
        );
        if (cree) run.chatId = String(cree);
        else
          ctx.showToast(
            "Conversation non enregistrée côté serveur : cette réponse sera perdue si vous rechargez la page. Copiez ce qui vous importe.",
            "warning",
            { duration: 15000 },
          );
      }
      run.chatId ||= String(r.currentChatId.value || "__pending_" + Date.now());
      if (!run.detached) f.streamingForChatId = run.chatId;
      if (e.followedRunChatId.value && String(e.followedRunChatId.value) === String(f.streamingForChatId))
        l.stopFollowRun();
      // Conversation quittée avant l'envoi : le tour part quand même, l'écran appartient à la suivante.
      const tot = run.detached;
      if (!tot) preparerTour(continuation);
      if (!continuation) {
        retirerReprisesPerimees(runMsgs, -1);
        for (let i = 0; i < runMsgs.length; i++) {
          const m = runMsgs[i];
          if (m && m.role === "assistant" && m.thinking)
            runMsgs[i] = Object.assign({}, m, { thinking: "", thinkingOpen: false });
        }
        const req = l.imageGenFor(runMsgs);
        runMsgs.push({
          ...bulleAssistant(),
          ...(req ? { _imageTurn: true, _imageProgress: l.imageInitialProgress(req) } : {}),
        });
      }
      if (!tot) {
        void nextTick(() => l.scrollToBottom(true));
        f.toolsExecutedThisTurn = false;
        f.streamToolPhase = false;
        l.resetDeltaStatus();
      }
      await bouclePost(run, mien, continuation, runMsgs, skills);
      epilogue(run, mien);
      if (f.pendingReattach && mien === f.activeGen) {
        const rid = f.pendingReattach;
        f.pendingReattach = null;
        void l.reattachOrFollow(rid);
      }
      void nextTick(() => {
        if (r.user.value) void l.loadChatsList();
      });
    } catch (err) {
      // Erreur précoce : le garde anti double envoi est relâché (sauf génération supplantée).
      if (mien === f.activeGen) {
        r.isStreaming.value = false;
        e.isThinking.value = false;
        if (f.ctxLive) clearLiveCtx();
      }
      throw err;
    }
  }

  async function generateResponse(): Promise<void> {
    await doGenerate(false);
  }

  function marquerSousAgentsAnnules(): void {
    const msgs = l.getStreamMsgs();
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const runs = m?.taskRuns;
      if (!m || !runs || !runs.length || !runs.some((x) => x.state === "running")) continue;
      msgs[i] = Object.assign({}, m, {
        taskRuns: runs.map((x) => (x.state === "running" ? { ...x, state: "cancelled", progress: null } : x)),
      });
    }
  }

  // Compression interrompue : l'étape en cours est retirée et la minuterie arrêtée.
  function annulerCompression(): void {
    l.stopCompressionTick();
    const cs = e.compressionStatus.value;
    const ci = cs && typeof cs.msg_idx === "number" ? cs.msg_idx : -1;
    if (ci >= 0)
      try {
        const cur = l.getStreamMsgs()[ci];
        if (cur && Array.isArray(cur.toolSteps)) {
          const steps = cur.toolSteps.slice();
          for (let i = steps.length - 1; i >= 0; i--) {
            const st = steps[i];
            if (st && st._kind === "compression" && st.status === "running") {
              steps.splice(i, 1);
              l.patch(ci, { toolSteps: steps });
              break;
            }
          }
        }
      } catch {
        /* non bloquant */
      }
    e.compressionProgress.value = 0;
    e.compressionStatus.value = null;
  }

  function finaliserBulleArretee(reste: string): void {
    const msgs = l.getStreamMsgs();
    const li = l.streamIdx(msgs);
    const cur = msgs[li];
    if (li < 0 || !cur || cur.role !== "assistant") return;
    if (cur.webScreenshots && cur.webScreenshots.length)
      for (const s of cur.webScreenshots) s.pending = false;
    const reflexion = !!(cur.thinking && cur.thinking.trim());
    const corps = (cur.content || "") + reste;
    const vivant = (cur._pendingPreContent || "").trim();
    const avecOutils = !!((cur.toolSteps && cur.toolSteps.length) || (cur.taskRuns && cur.taskRuns.length));
    const texte = corps || (vivant ? cur._pendingPreContent || "" : "");
    if (cur._imageTurn) {
      const images =
        Array.isArray(cur["generated_images"]) && (cur["generated_images"] as unknown[]).length > 0;
      msgs[li] = Object.assign(
        {},
        cur,
        {
          content: images ? cur.content || "" : "[Génération d'image arrêtée]",
          isStreaming: false,
          isTruncated: false,
          _imageProgress: null,
          _toolImageProgress: null,
          ...(images
            ? {}
            : { image_error: { code: "cancelled", message: "", retryable: true }, _imageErrorLive: true }),
        },
        STREAM_RENDER_CLEAR,
        PRE_RENDER_CLEAR,
      );
      return;
    }
    // Stop pendant les outils sans texte : même marqueur que le serveur (la bulle reste alignée sur la base).
    msgs[li] = Object.assign(
      {},
      cur,
      {
        content: texte || (avecOutils && !reflexion ? "_(génération interrompue)_" : ""),
        _pendingPreContent: "",
        _pendingToolThinking: "",
        isStreaming: false,
        isTruncated: !reflexion,
        _toolImageProgress: null,
      },
      STREAM_RENDER_CLEAR,
      PRE_RENDER_CLEAR,
    );
  }

  function annulerCote(chatId: string): void {
    const cid = chatId.startsWith("__") ? r.currentChatId.value || "" : chatId;
    void ctx
      .fetchAuth("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cid ? { chat_id: cid } : {}),
      })
      .catch(() => null);
  }

  function stopGeneration(): void {
    if (f.currentRun && f.currentRun.attached) f.currentRun.stopped = true;
    clearLiveCtx();
    l.resetAskUser();
    // Chat du run (suivi ou rattachement), pas forcément la conversation affichée.
    const chatStop = String(f.streamingForChatId || e.followedRunChatId.value || r.currentChatId.value || "");
    annulerCote(chatStop);
    if (e.abortController.value) {
      try {
        e.abortController.value.abort();
      } catch {
        /* déjà interrompu */
      }
      e.abortController.value = null;
    }
    l.stopFollowRun();
    r.isStreaming.value = false;
    e.isThinking.value = false;
    e.statusText.value = "";
    // Témoins que seuls des événements de fin (jamais lus après l'abandon) retiraient.
    e.queueStatus.value = null;
    const sm = l.getStreamMsgs();
    const si = l.streamIdx(sm);
    const sc = sm[si];
    if (si >= 0 && sc && sc._statusLine) sm[si] = Object.assign({}, sc, { _statusLine: "" });
    if (chatStop && !chatStop.startsWith("__")) l.markRunDone(chatStop);
    l.setFollowBubble(false);
    marquerSousAgentsAnnules();
    l.stopThinkFlush();
    l.stopPreContentFlush();
    l.stopStreamFlush();
    l.cancelPendingChatSearch();
    annulerCompression();
    l.cancelAllToolStreams();
    const reste = f.streamBuf;
    f.streamBuf = "";
    finaliserBulleArretee(reste);
    l.markRunDone(chatStop);
    f.currentRun = null;
    f.streamingForChatId = null;
    void nextTick(() => {
      l.scrollToBottom();
      void l.loadAvailableModels();
    });
  }

  async function continueGeneration(): Promise<void> {
    if (r.isStreaming.value) return;
    const msgs = r.messages.value;
    let li = msgs.length - 1;
    while (li >= 0 && msgs[li]?.role !== "assistant") li--;
    const dernier = msgs[li];
    if (!dernier || dernier.role !== "assistant" || !dernier.isTruncated) return;
    retirerReprisesPerimees(msgs, li);
    // `thinkingTruncated` gardé : la projection en tire `resume_thinking` pour la reprise du raisonnement.
    msgs[li] = Object.assign({}, dernier, REPRISE_CLEAR, { isStreaming: true, _prefillPct: undefined });
    await doGenerate(true);
  }

  /** Interrompt la réflexion : fermeture native par le moteur, sinon relance avec le raisonnement en préremplissage. */
  async function respondNow(assistantIdx: number): Promise<void> {
    const msgs = l.getStreamMsgs();
    if (typeof assistantIdx !== "number" || assistantIdx < 0 || assistantIdx >= msgs.length) return;
    const cur = msgs[assistantIdx];
    if (!cur || cur.role !== "assistant") return;
    const partiel = (cur.thinking || "").trim();
    if (!partiel || !r.isStreaming.value) return;
    try {
      const cid0 = r.currentChatId.value || "";
      if (cid0) {
        const rep = await ctx.fetchAuth("/api/chat/reasoning-end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: cid0 }),
        });
        const d: unknown = rep ? await rep.json().catch(() => null) : null;
        if (estObjet(d) && d["ok"]) {
          l.patch(assistantIdx, { thinkingOpen: false });
          return;
        }
      }
    } catch {
      /* moteur ancien : repli */
    }
    const cid = r.currentChatId.value || "";
    void ctx
      .fetchAuth("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cid ? { chat_id: cid } : {}),
      })
      .catch(() => null);
    if (e.abortController.value) {
      try {
        e.abortController.value.abort();
      } catch {
        /* déjà interrompu */
      }
      e.abortController.value = null;
    }
    l.stopThinkFlush();
    l.stopPreContentFlush();
    l.stopStreamFlush();
    f.streamBuf = "";
    msgs[assistantIdx] = Object.assign(
      {},
      cur,
      {
        _respondNowPrefill: "<think>\n" + partiel + "\n</think>\n\n",
        content: "",
        thinking: partiel,
        thinkingOpen: false,
        isStreaming: true,
        isTruncated: false,
        isError: false,
        errorMessage: "",
        _statusLine: "",
        _pendingPreContent: "",
        _pendingToolThinking: "",
      },
      STREAM_RENDER_CLEAR,
      PRE_RENDER_CLEAR,
    );
    await attendre(50);
    await doGenerate(true);
  }

  // Reprendre après erreur : la tool_history est gardée et le tour continue (sinon régénération).
  async function resumeAfterError(index: number): Promise<void> {
    if (r.isStreaming.value) return;
    const msgs = r.messages.value;
    const cible = msgs[index];
    if (!cible || cible.role !== "assistant") return;
    if (index !== msgs.length - 1 || !(cible.tool_history && cible.tool_history.length)) {
      await retryGeneration(index);
      return;
    }
    msgs[index] = Object.assign({}, cible, {
      isError: false,
      errorMessage: "",
      isTruncated: false,
      toolLoopTruncated: false,
      toolLoopStats: null,
      isStreaming: true,
    });
    await doGenerate(true);
  }

  // Régénérer : troncature depuis la réponse (confirmation si des messages suivent).
  async function retryGeneration(index: number): Promise<void> {
    if (r.isStreaming.value) return;
    const msgs = r.messages.value;
    const cible = msgs[index];
    if (!cible || cible.role !== "assistant") return;
    const perdus = msgs.length - index - 1;
    if (perdus > 0) {
      const mot = perdus > 1 ? "messages" : "message";
      const ok = await ctx.openConfirm(
        "Régénérer cette réponse ?",
        `La conversation sera régénérée depuis ce point. Les ${perdus} ${mot} qui suivent seront perdus.`,
        false,
        "Régénérer",
        "Annuler",
      );
      if (!ok) return;
    }
    msgs.splice(index);
    l.resetDiffCardState();
    await generateResponse();
  }

  return {
    ctxGaugeApplicable,
    getCtxSize,
    seedLiveCtx,
    clearLiveCtx,
    ensureServerChat,
    doGenerate,
    generateResponse,
    stopGeneration,
    continueGeneration,
    respondNow,
    resumeAfterError,
    retryGeneration,
  };
}
