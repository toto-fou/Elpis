// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/vue-flux.ts — vue du flux de génération (portée de `handleStreamEvent` d'`app-chat.js`) : chaque événement appliqué au message assistant en cours (texte, réflexion, outils, sous-agents, compression, images, fin de tour). */
import { journal } from "../../../platform/journal";
import { nextTick } from "vue";

import { decoderTexte } from "../../editor/lecture";
import { fusionnerSourcesRag, sourcesRag } from "../affichage";
import { sourcesRagValides } from "../../rag/sources";
import { lireBilanTache } from "../outils/bilan-tache";
import { ragCallLabel, ragResultLabel, resultIsError, shellFieldsFromResult } from "../outils/segments";
import { comprSkipLabel } from "./formats";
import type { CoeurChat } from "./liens";
import { PRE_RENDER_CLEAR, STREAM_RENDER_CLEAR } from "./rendu-flux";
import type {
  CaptureChat,
  DonneesFlux,
  EntreeDeroule,
  EtapeChat,
  ExecutionTache,
  MessageChat,
  Objet,
  OptionsToast,
} from "./types";
import type { TacheSession } from "../outils/types";

type Toast = (message: string, type?: string, options?: OptionsToast) => void;

interface Tour {
  data: DonneesFlux;
  msgs: MessageChat[];
  idx: number;
  toast: Toast;
}

const estObjet = (v: unknown): v is Objet => !!v && typeof v === "object" && !Array.isArray(v);
const chaine = (v: unknown): string => (typeof v === "string" ? v : "");
const nombreOu = (v: unknown, defaut: number): number => (typeof v === "number" ? v : defaut);
const MUTANTS_MEMOIRE = ["add", "replace", "remove", "rewrite"];
const RAISONS_SILENCIEUSES = ["threshold_not_reached", "nothing_to_compress", "disabled", "not_run"];

/** Chemin ramené à la racine affichée du bac. */
function sousRacine(chemin: string, racine: string | null | undefined): string {
  return racine && chemin.startsWith(racine) ? chemin.substring(racine.length).replace(/^\/+/, "") : chemin;
}

export function creerVueFlux(c: CoeurChat) {
  const { r, ctx, e, f, l } = c;
  const rien: Toast = () => undefined;

  function etapes(m: MessageChat | undefined): EtapeChat[] {
    return [...(m?.toolSteps || [])];
  }

  function effacerAttente(idx: number): void {
    const cur = l.getStreamMsgs()[idx];
    if (cur && cur._statusLine) l.patch(idx, { _statusLine: "" });
    if (cur && cur._lastToolResultAt) l.patch(idx, { _lastToolResultAt: null });
    if (cur && typeof cur._prefillPct === "number") l.patch(idx, { _prefillPct: undefined });
  }

  function surReflexion(t: Tour): void {
    l.stopPreContentFlush();
    f.thinkBuf += t.data.text || "";
    // Débit seulement : la réflexion ne compte pas dans le contexte du tour suivant.
    if (f.ctxLive) f.ctxLive.gen += t.data.n || 1;
    f.inThinkPhase = true;
    if (!f.thinkFlushTimer) f.thinkFlushTimer = setInterval(() => l.flushThinkBuf(), 100);
    if (t.idx >= 0) effacerAttente(t.idx);
  }

  // Resynchronisation de fin de tour : le texte nettoyé par le serveur remplace la bulle.
  function surRemplacement(t: Tour): void {
    l.stopStreamFlush();
    f.streamBuf = "";
    if (f.preContentFlushTimer) {
      clearInterval(f.preContentFlushTimer);
      f.preContentFlushTimer = null;
    }
    f.preContentBuf = "";
    if (t.idx >= 0 && l.getStreamMsgs()[t.idx])
      l.patch(
        t.idx,
        Object.assign(
          { content: t.data.text || "", _pendingPreContent: "" },
          STREAM_RENDER_CLEAR,
          PRE_RENDER_CLEAR,
        ),
      );
  }

  // Phase outils : le contenu va dans la ligne vivante du conteneur, jamais dans le corps.
  function surContenu(t: Tour): void {
    l.stopThinkFlush();
    f.inThinkPhase = false;
    if (e.queueStatus.value) e.queueStatus.value = null;
    if (t.idx >= 0) {
      effacerAttente(t.idx);
      const cur = l.getStreamMsgs()[t.idx];
      if (cur && cur._thinkingStartedAt && !cur._thinkingEndedAt)
        l.patch(t.idx, { _thinkingEndedAt: Date.now() });
    }
    if (f.ctxLive) f.ctxLive.gen += t.data.n || 1;
    if (f.streamToolPhase) {
      f.preContentBuf += t.data.text || "";
      if (!f.preContentFlushTimer) f.preContentFlushTimer = setInterval(() => l.flushPreContentBuf(), 40);
      e.isThinking.value = true;
    } else {
      l.stopPreContentFlush();
      e.isThinking.value = false;
      e.statusText.value = "";
      f.streamBuf += t.data.text || "";
      l.armStreamFlush();
    }
  }

  // Préremplissage : pourcentage de l'entrée utile (hors part relue du cache), porté par le message.
  function surPreremplissage(t: Tour): void {
    const total = Number(t.data["total"]) || 0;
    if (!(total > 0) || t.idx < 0) return;
    const cache = Math.min(Math.max(0, Number(t.data["cache"]) || 0), total);
    const utile = total - cache;
    const fait = Math.max(0, (Number(t.data["processed"]) || 0) - cache);
    l.patch(t.idx, {
      _prefillPct: utile > 0 ? Math.min(100, Math.round((fait / utile) * 100)) : 100,
      _prefillCachePct: Math.round((cache / total) * 100),
    });
  }

  function surFileAttente(t: Tour): void {
    const d = t.data;
    const pct = typeof d["progress_pct"] === "number" ? Math.max(0, Math.min(100, d["progress_pct"])) : null;
    const avant = e.queueStatus.value;
    const genre = chaine(d["kind"]) || "waiting";
    const etat = {
      kind: genre,
      model: chaine(d["model"]),
      loaded: d["loaded"] || null,
      position: Number(d["position"]) || 1,
      active: Number(d["active"]) || 1,
      est_ms: Number(d["est_ms"]) || 15000,
      pct,
      stage: chaine(d["stage"]),
      stages: Array.isArray(d["stages"]) ? (d["stages"] as unknown[]) : [],
      started_at: avant && avant.kind === genre ? avant.started_at : Date.now(),
    };
    e.queueStatus.value = etat;
    if (t.idx >= 0) {
      const chargement =
        d["kind"] === "loading"
          ? { model: chaine(d["model"]), pct: etat.pct, stage: chaine(d["stage"]), stages: etat.stages }
          : null;
      if (chargement || t.msgs[t.idx]?._modelLoad) l.patch(t.idx, { _modelLoad: chargement });
    }
  }

  function surOccupation(t: Tour): void {
    const total = t.data["total"];
    if (typeof total !== "number" || !(total > 0)) return;
    const utilise = Number(t.data["used"]) || 0;
    const pct = typeof t.data["pct"] === "number" ? t.data["pct"] : Math.round((utilise / total) * 100);
    // La santé décrit le serveur intégré : un tour sur un connecteur n'y écrit pas.
    if (!e.selectedConnector.value)
      e.llmHealth.value = {
        ...(e.llmHealth.value || { props: {} }),
        kv_cache: { used: utilise, total, pct },
      } as typeof e.llmHealth.value;
    if (f.ctxLive) {
      f.ctxLive.total = total;
      if (utilise > 0) f.ctxLive.base = utilise;
    }
    if (utilise > 0) {
      e.ctxRealPct.value = pct;
      e.ctxUsage.value = { used: utilise, total, pct };
    }
  }

  // Compression : rendue comme une étape d'outil grise dans le segment courant.
  function surDebutCompression(t: Tour): void {
    const d = t.data;
    if (t.idx >= 0) {
      const cur = l.getStreamMsgs()[t.idx];
      if (cur && cur._statusLine) l.patch(t.idx, { _statusLine: "" });
    }
    e.isThinking.value = false;
    e.statusText.value = "";
    const tokens = Number(d["tokens"]) || 0;
    const taille = Number(d["ctx_size"]) || 0;
    const pct = taille && tokens ? Math.round((tokens / taille) * 100) : 0;
    const path = chaine(d["path"]) || "self";
    const est_ms = l.estimateCompressionMs(path);
    const started_at = Date.now();
    if (t.idx >= 0) {
      const cur = l.getStreamMsgs()[t.idx];
      const steps = etapes(cur);
      const segs = cur?.segTexts && cur.segTexts.length ? cur.segTexts : [""];
      steps.push({
        _kind: "compression",
        name: "context_compress",
        status: "running",
        seg: segs.length - 1,
        path,
        external: !!d["external"],
        model: chaine(d["model"]),
        turns: Number(d["turns"]) || 0,
        tokens,
        ctx_size: taille,
        pct,
        reason: chaine(d["reason"]),
        threshold: Number(d["threshold"]) || 0,
        est_ms,
        started_at,
        progress: 0,
        args: null,
        result: null,
        stats: null,
      });
      l.patch(t.idx, {
        toolSteps: steps,
        ...(cur?.segTexts && cur.segTexts.length ? {} : { segTexts: segs }),
      });
    }
    e.compressionStatus.value = {
      path,
      external: !!d["external"],
      model: chaine(d["model"]),
      turns: Number(d["turns"]) || 0,
      tokens,
      ctx_size: taille,
      pct,
      est_ms,
      started_at,
      msg_idx: t.idx,
    };
    l.startCompressionTick(t.idx);
  }

  function surFinCompression(t: Tour): void {
    const stats = estObjet(t.data["stats"]) ? t.data["stats"] : {};
    if (stats["compressed"] && stats["duration_ms"])
      l.recordCompressionDuration(chaine(stats["path"]) || "self", Number(stats["duration_ms"]));
    const cs = e.compressionStatus.value;
    const cible = cs && typeof cs.msg_idx === "number" ? cs.msg_idx : t.idx;
    if (cible >= 0) {
      try {
        const cur = l.getStreamMsgs()[cible];
        if (cur && Array.isArray(cur.toolSteps)) {
          const suite = cur.toolSteps.slice();
          for (let i = suite.length - 1; i >= 0; i--) {
            const st = suite[i];
            if (st && st._kind === "compression" && st.status === "running") {
              suite[i] = stats["compressed"]
                ? { ...st, status: "done", progress: 100, stats }
                : {
                    ...st,
                    status: "skipped",
                    progress: 0,
                    stats,
                    reasonLabel: comprSkipLabel(stats["reason"]),
                  };
              l.patch(cible, { toolSteps: suite });
              break;
            }
          }
        }
      } catch {
        /* non bloquant */
      }
    }
    l.stopCompressionTick();
    e.compressionProgress.value = 0;
    e.compressionStatus.value = null;
    const raison = stats["reason"];
    if (!stats["compressed"] && raison && !RAISONS_SILENCIEUSES.includes(String(raison)))
      journal.avertir("[compression] not applied:", raison);
  }

  function surProgressionImage(t: Tour): void {
    const d = t.data;
    const outil = d["source"] === "tool";
    const cur = t.msgs[t.idx] || ({} as MessageChat);
    const avant = (
      estObjet(cur[outil ? "_toolImageProgress" : "_imageProgress"])
        ? cur[outil ? "_toolImageProgress" : "_imageProgress"]
        : {}
    ) as Objet;
    const apercu = d["preview"];
    const prog = {
      state: chaine(d["state"]) || "generating",
      queue_position: d["queue_position"] || null,
      elapsed_s: Number(d["elapsed_s"]) || 0,
      eta_s: d["eta_s"] || null,
      pct: typeof d["pct"] === "number" ? d["pct"] : null,
      pct_real: !!d["pct_real"],
      width: d["width"] || avant["width"],
      height: d["height"] || avant["height"],
      n: d["n"] || avant["n"] || 1,
      preview:
        typeof apercu === "string" && apercu.indexOf("data:image/") === 0 ? apercu : avant["preview"] || null,
    };
    if (outil) l.patch(t.idx, { _toolImageProgress: d["state"] === "done" ? null : prog });
    else l.patch(t.idx, { _imageTurn: true, _imageProgress: prog });
  }

  function surImage(t: Tour): void {
    const items = Array.isArray(t.data["items"]) ? (t.data["items"] as unknown[]) : [];
    if (t.data["source"] === "tool") {
      const cur = t.msgs[t.idx];
      const avant = Array.isArray(cur?.["tool_images"]) ? (cur["tool_images"] as unknown[]) : [];
      l.patch(t.idx, { _toolImageProgress: null, tool_images: avant.concat(items) });
    } else l.patch(t.idx, { _imageTurn: true, _imageProgress: null, generated_images: items });
  }

  function surErreurImage(t: Tour): void {
    if (t.data["source"] === "tool") {
      l.patch(t.idx, { _toolImageProgress: null });
      return;
    }
    l.patch(t.idx, {
      _imageTurn: true,
      _imageProgress: null,
      _imageErrorLive: true,
      image_error: {
        code: chaine(t.data["code"]) || "engine",
        message: chaine(t.data["message"]),
        retryable: t.data["retryable"] !== false,
      },
    });
  }

  function surStatut(t: Tour): void {
    e.isThinking.value = true;
    e.statusText.value = t.data.text || "";
    if (t.data.type === "mode" && t.data["kind"] === "image" && t.idx >= 0 && !t.msgs[t.idx]?._imageTurn)
      l.patch(t.idx, { _imageTurn: true });
    if (t.idx < 0) return;
    const st = t.data.text || "";
    if (!st || st === "Réflexion...") return;
    const cur = l.getStreamMsgs()[t.idx];
    if (cur && cur._statusLine !== st) l.patch(t.idx, { _statusLine: st });
  }

  function surContenuReflexion(t: Tour): void {
    l.stopThinkFlush();
    const cur = l.getStreamMsgs()[t.idx];
    const p: Objet = { thinking: t.data.text || "" };
    if (cur && !cur._thinkingStartedAt) p["_thinkingStartedAt"] = Date.now();
    l.patch(t.idx, p);
  }

  // Instantané du contexte figé dans le message : dernier réel serveur du tour, sinon le dernier prompt.
  function instantaneContexte(metriques: Objet): { used: number; total: number; pct: number } | null {
    const sante = e.llmHealth.value;
    const nCtx = !l.ctxGaugeApplicable()
      ? 0
      : l.getCtxSize() || sante?.kv_cache?.total || Number(sante?.props?.n_ctx) || 0;
    let utilise = f.lastCtxUsed > 0 ? f.lastCtxUsed : 0;
    if (!utilise) {
      if (typeof metriques["last_prompt_tokens"] === "number") utilise = metriques["last_prompt_tokens"];
      else if (typeof metriques["input_tokens"] === "number") utilise = metriques["input_tokens"];
    }
    if (!(utilise > 0) || !(nCtx > 0)) return null;
    return {
      used: Math.min(utilise, nCtx),
      total: nCtx,
      pct: Math.min(100, Math.round((utilise / nCtx) * 100)),
    };
  }

  function statsBoucle(d: DonneesFlux): Objet | null {
    if (!d["tool_limit_reached"]) return null;
    const m = estObjet(d["metrics"]) ? d["metrics"] : {};
    return {
      iterations:
        d["tool_limit_effective_iters"] ||
        m["tool_limit_effective_iters"] ||
        d["tool_limit_iters"] ||
        m["tool_limit_iters"] ||
        0,
      hard_iterations: d["tool_limit_iters"] || m["tool_limit_iters"] || 0,
      max_iterations: d["tool_limit_max"] || m["tool_limit_max"] || 0,
      tool_calls_done: d["tool_limit_calls"] || m["tool_limit_calls"] || 0,
      stop_reason: m["tool_limit_stop_reason"] || "",
    };
  }

  function finImage(t: Tour, cur: MessageChat): boolean {
    const d = t.data;
    const image = !!(d["image"] || cur._imageTurn);
    if (!image) return false;
    const p: Objet = {
      isTruncated: false,
      toolLoopTruncated: false,
      toolLoopStats: null,
      _imageProgress: null,
      _imageTurn: true,
    };
    const generees = d["generated_images"];
    if (Array.isArray(generees) && JSON.stringify(generees) !== JSON.stringify(cur["generated_images"] || []))
      p["generated_images"] = generees;
    if (d["revised_prompt"]) p["revised_prompt"] = d["revised_prompt"];
    const m = estObjet(d["metrics"]) ? d["metrics"] : null;
    const meta =
      d["image_meta"] ||
      (m && (m["model"] || m["duration_s"])
        ? { model: m["model"] || "", duration_s: m["duration_s"] || 0 }
        : null);
    if (meta) p["image_meta"] = meta;
    if (d["image_error"]) {
      p["image_error"] =
        typeof d["image_error"] === "object"
          ? d["image_error"]
          : { code: "engine", message: "", retryable: true };
      p["_imageErrorLive"] = true;
    } else if (d["cancelled"] && !(Array.isArray(generees) && generees.length)) {
      p["image_error"] = { code: "cancelled", message: "", retryable: true };
      p["_imageErrorLive"] = true;
    }
    l.patch(t.idx, p);
    return true;
  }

  // Todo de fin de tour : soldée → disparaît ; touchée (ou tour annulé) → repliée ; ignorée → abandonnée.
  function finTodo(annule: boolean): void {
    const liste = e.todoList.value;
    if (!liste.length) return;
    if (liste.every((x) => x.status === "completed" || x.status === "cancelled")) e.todoList.value = [];
    else if (f.todoTouchedThisTurn || annule) e.todoPanelOpen.value = false;
    else e.todoList.value = [];
  }

  function surFinal(t: Tour): void {
    const d = t.data;
    l.stopThinkFlush();
    l.stopPreContentFlush();
    if (f.ctxLive && f.ctxLive.base > 0) f.lastCtxUsed = f.ctxLive.base;
    l.clearLiveCtx();
    void l.refreshCompressionState();
    l.stopStreamFlush();
    const cur = t.msgs[t.idx];
    if (!cur) return;
    l.purgeToolStreams(d.chat_id || r.currentChatId.value || "local");
    if (cur.webScreenshots && cur.webScreenshots.length)
      for (const s of cur.webScreenshots) s.pending = false;
    let diffuse = (cur.content || "") + f.streamBuf;
    f.streamBuf = "";
    if (f.streamToolPhase && !diffuse.trim() && (cur._pendingPreContent || "").trim())
      diffuse = cur._pendingPreContent || "";
    const assistant = chaine(d["assistant"]);
    let contenu = assistant && assistant.length >= diffuse.length ? assistant : diffuse || assistant || "";
    const avecOutils = !!(cur.toolSteps && cur.toolSteps.length > 0);
    const metriquesFlux = estObjet(d["metrics"]) ? d["metrics"] : null;
    let reflexion = avecOutils
      ? cur.thinking || ""
      : cur.thinking || chaine(d["thinking"]) || chaine(metriquesFlux?.["thinking"]) || "";
    // Réponse piégée dans la réflexion : promue, sauf coupure en plein raisonnement (alors finalisée telle quelle).
    const coupeEnReflexion = !!d["truncated_in_think"];
    if (!avecOutils && !coupeEnReflexion && !contenu.trim() && reflexion.trim()) {
      contenu = reflexion;
      reflexion = "";
    }
    const deplier = !contenu && !!reflexion;
    const base = metriquesFlux || cur.metrics || {};
    const instant = instantaneContexte(metriquesFlux || {});
    const metriques = instant ? { ...base, kv_cache: instant } : base;
    if (f.pendingAskUser) {
      e.askUserPanel.value = { items: f.pendingAskUser, idx: 0 };
      f.pendingAskUser = null;
    }
    const runIds = d["run_ids"];
    const compactions = d["compactions"];
    l.patch(t.idx, {
      content: contenu,
      thinking: reflexion,
      thinkingOpen: deplier,
      thinkingTruncated: coupeEnReflexion,
      _pendingPreContent: "",
      ...PRE_RENDER_CLEAR,
      _pendingToolThinking: "",
      _liveThinkingOpen: undefined,
      _statusLine: "",
      metrics: metriques,
      _prefillPct: undefined,
      isStreaming: false,
      ...STREAM_RENDER_CLEAR,
      isTruncated: !!d["tool_limit_reached"] || !!d["cancelled"] || !!d["truncated"],
      run_ids: Array.isArray(runIds) && runIds.length ? runIds : cur.run_ids || null,
      compactions: Array.isArray(compactions) && compactions.length ? compactions : cur.compactions || null,
      pruned: d["pruned"] || cur.pruned || 0,
      ...(cur._thinkingStartedAt && !cur._thinkingEndedAt ? { _thinkingEndedAt: Date.now() } : {}),
      tool_history: (metriquesFlux && metriquesFlux["tool_history"]) || cur.tool_history || null,
      tool_history_delta:
        metriquesFlux && metriquesFlux["tool_history"]
          ? !!metriquesFlux["tool_history_delta"]
          : !!cur.tool_history_delta,
      toolLoopTruncated: !!d["tool_limit_reached"],
      toolLoopStats: statsBoucle(d),
    });
    const image = finImage(t, cur);
    const sourcesFinales = sourcesRagValides(d["rag_sources"]);
    if (sourcesFinales.length) l.patch(t.idx, { rag_sources: sourcesFinales });
    const imagesOutil = d["tool_images"];
    if (Array.isArray(imagesOutil) && imagesOutil.length)
      l.patch(t.idx, { tool_images: imagesOutil, _toolImageProgress: null });
    else if (cur["_toolImageProgress"]) l.patch(t.idx, { _toolImageProgress: null });
    l.mergeFilesChanged(t.idx, d["files_changed"]);
    l.markRunDone(d.chat_id || f.streamingForChatId || r.currentChatId.value);
    if (d.chat_id) r.currentChatId.value = d.chat_id;
    try {
      finTodo(!!d["cancelled"]);
    } catch {
      /* liste malformée */
    }
    const titre = d["title"];
    if (typeof titre === "string" && titre) {
      const renomme = titre !== e.currentChatTitle.value;
      e.currentChatTitle.value = titre;
      const entree = e.chats.value.find((x) => String(x.id) === String(r.currentChatId.value));
      if (entree) entree.title = titre;
      if (renomme) l.flashRenamedTitle(entree);
    }
    e.isThinking.value = false;
    e.statusText.value = "";
    r.isStreaming.value = false;
    void nextTick(() => {
      l.scrollToBottom();
      void l.loadAvailableModels();
    });
    ctx.announce?.(
      d["cancelled"]
        ? "Génération interrompue"
        : image
          ? d["image_error"]
            ? "Échec de la génération d’image"
            : "Image générée"
          : "Réponse terminée",
    );
    try {
      l.voix().onAssistantFinal(image ? "" : contenu, image || !!d["cancelled"]);
    } catch (err) {
      journal.erreur("[voix]", err);
    }
    if (d["plan_mode_done"]) {
      e.planMode.value = false;
      t.toast("Plan rendu — mode plan terminé, outils rétablis.", "info");
    }
    if (d["persisted"] === false)
      t.toast(
        d["persist_error"] === "collision"
          ? "Réponse non sauvegardée (conflit de chat). Copiez-la avant de recharger."
          : "Réponse non sauvegardée (erreur base). Copiez-la avant de recharger.",
        "error",
      );
  }

  // Itération rejouée ou abandonnée par le serveur : fragments, narration et noms d'outil de l'itération purgés.
  async function surReinitDelta(t: Tour): Promise<void> {
    try {
      await l.resetToolStreamsForIter(t.data.chat_id || r.currentChatId.value || "local", t.data.iter);
    } catch (err) {
      journal.avertir("[tool_call_delta] reset error — silent fallback", err);
    }
    if (f.preContentFlushTimer) {
      clearInterval(f.preContentFlushTimer);
      f.preContentFlushTimer = null;
    }
    f.preContentBuf = "";
    l.forgetDeltaNames(t.data.iter);
    const cur = t.msgs[t.idx];
    if (t.idx >= 0 && cur) {
      if (cur._pendingPreContent) l.patch(t.idx, Object.assign({ _pendingPreContent: "" }, PRE_RENDER_CLEAR));
      if (!(cur.toolSteps && cur.toolSteps.length)) f.streamToolPhase = false;
    }
  }

  // Premier signal fiable d'un appel d'outil : le texte déjà streamé passe dans la ligne vivante.
  async function surDelta(t: Tour): Promise<void> {
    if (!f.streamToolPhase) {
      f.streamToolPhase = true;
      l.stopStreamFlush();
      const msgs = l.getStreamMsgs();
      const i = l.streamIdx(msgs);
      const cur = i >= 0 ? msgs[i] : undefined;
      const corps = (cur?.content || "") + f.streamBuf;
      f.streamBuf = "";
      if (cur && corps) {
        const pre = corps.trim() ? (cur._pendingPreContent || "") + corps : null;
        msgs[i] = Object.assign(
          {},
          cur,
          pre !== null ? l.applyPreRender(cur, pre) : {},
          { content: "" },
          STREAM_RENDER_CLEAR,
        );
        if (pre !== null) e.isThinking.value = true;
      }
    }
    l.noteDeltaStatus(t.data, t.idx);
    try {
      await l.handleToolCallDelta(t.data, t.data.chat_id || r.currentChatId.value || "local", f.replaying);
    } catch (err) {
      journal.avertir("[tool_call_delta] parse/stream error — silent fallback", err);
    }
  }

  function surAppelOutil(t: Tour): void {
    const d = t.data;
    f.toolsExecutedThisTurn = true;
    f.streamToolPhase = true;
    l.oublierLibelleDelta();
    f.inThinkPhase = false;
    const nom = d.name || "";
    const rag = nom.startsWith("rag_");
    const args = estObjet(d.args) ? d.args : null;
    if (nom === "ask_user") {
      const qs = l.normalizeAskUser(args?.["questions"]);
      if (qs) f.pendingAskUser = qs;
    }
    const cur = t.msgs[t.idx];
    if (!cur) return;
    const steps = etapes(cur);
    const tache = nom === "task";
    const libelleRag = rag ? ragCallLabel(nom, args) : "";
    l.stopPreContentFlush();
    l.stopThinkFlush();
    l.stopStreamFlush();
    const texteAvant = (t.msgs[t.idx]?.content || "") + f.streamBuf;
    f.streamBuf = "";
    const actuel = t.msgs[t.idx] ?? cur;
    if (texteAvant.trim()) t.msgs[t.idx] = Object.assign({}, actuel, { content: "" }, STREAM_RENDER_CLEAR);
    const src = t.msgs[t.idx] ?? cur;
    // La narration du round ouvre un nouveau segment ; les appels suivants du round le rejoignent.
    const narration = [texteAvant.trim(), (src._pendingPreContent || "").trim()].filter(Boolean).join("\n\n");
    const segTexts = [...(cur.segTexts || [])];
    if (narration) segTexts.push(narration);
    if (!segTexts.length) segTexts.push("");
    const reflexion = src.thinking || "";
    const memoire =
      nom === "memory" && !!args && MUTANTS_MEMOIRE.includes(String(args["action"] || "").toLowerCase());
    const todo = nom === "todowrite";
    // Étapes rendues hors liste (carte agent, lignes d'effets) : leur réflexion reste sur le message.
    const reflexionSurMessage = tache || memoire || todo;
    steps.push({
      name: nom,
      args,
      result: null,
      status: "running",
      callId: d.call_id || null,
      seg: segTexts.length - 1,
      thinking: reflexionSurMessage ? "" : reflexion,
      thinkingOpen: false,
      isRag: false,
      ragLabel: libelleRag,
      ...(memoire ? { _kind: "memory" } : {}),
      ...(todo ? { _kind: "todo" } : {}),
      ...(tache ? { _kind: "task" } : {}),
    });
    const runs: ExecutionTache[] | undefined = tache
      ? [
          ...(cur.taskRuns || []),
          {
            id: null,
            callId: d.call_id || null,
            agent: chaine(args?.["subagent_type"]) || "agent",
            label: chaine(args?.["description"]),
            prompt: chaine(args?.["prompt"]),
            state: "running",
            tokens: 0,
            steps_total: 0,
            tools: [],
            progress: null,
          },
        ]
      : undefined;
    l.patch(t.idx, {
      _pendingPreContent: "",
      ...PRE_RENDER_CLEAR,
      _pendingToolThinking: "",
      thinking: reflexionSurMessage ? reflexion : "",
      thinkingOpen: false,
      _liveThinkingOpen: undefined,
      _statusLine: rag ? libelleRag : memoire || todo || tache ? "" : nom,
      toolSteps: steps,
      segTexts,
      ...(runs ? { taskRuns: runs } : {}),
    });
    const captures = t.msgs[t.idx]?.webScreenshots || [];
    if (nom.startsWith("pw_") && captures.length > 0) {
      const shots = [...captures];
      const dernier = shots.length - 1;
      const s = shots[dernier];
      if (s) shots[dernier] = { ...s, pending: true };
      l.patch(t.idx, { webScreenshots: shots });
    }
    e.isThinking.value = true;
    if (rag) e.statusText.value = libelleRag;
    else {
      e.statusText.value = nom;
      const tn = nom.toLowerCase();
      const brut = args ? args["path"] || args["filename"] : null;
      if (
        (tn.includes("write") || tn.includes("save") || tn.includes("edit")) &&
        typeof brut === "string" &&
        brut
      ) {
        const chemin = sousRacine(brut, r.settings.value.sandbox_path_display);
        e.pendingWrite.value = { path: chemin };
        if (!ctx.isStreamActive?.(chemin)) t.toast("Édition : " + chemin + "...");
      }
    }
    void nextTick(() => l.scrollToBottom());
  }

  function terminerEtape(st: EtapeChat, d: DonneesFlux, erreur: boolean, libelleRag: string): EtapeChat {
    const maj: EtapeChat = {
      ...st,
      result: d.result,
      status: "done",
      ragResultLabel: libelleRag,
      _is_error: erreur,
    };
    if (typeof d["duration_ms"] === "number") maj.durationMs = d["duration_ms"];
    // Console du terminal remplie depuis le résultat quand rien n'a été streamé.
    if (maj.name === "execute_shell" && !maj.shellDone) {
      const shf = shellFieldsFromResult(d.result);
      if (shf) {
        maj.shellDone = true;
        maj.shellRc = shf.shellRc;
        maj.shellMs = shf.shellMs;
        if (shf.shellOut != null && maj.shellOut == null) maj.shellOut = shf.shellOut;
      }
    }
    return maj;
  }

  // Appariement : par call_id (appels parallèles), puis nom en cours, puis dernier en cours.
  function apparier(steps: EtapeChat[], d: DonneesFlux, maj: (s: EtapeChat) => EtapeChat): void {
    const nom = d.name || "";
    const essais: ((s: EtapeChat) => boolean)[] = [];
    if (d.call_id) essais.push((s) => s.callId === d.call_id && s.status === "running");
    essais.push(
      (s) => s.name === nom && s.status === "running",
      (s) => s.status === "running",
    );
    for (const essai of essais)
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (s && essai(s)) {
          steps[i] = maj(s);
          return;
        }
      }
  }

  // Capture d'écran d'un outil Playwright : téléchargée en blob, révoquée si le chat ou le message a changé.
  function capturerEcran(t: Tour, nom: string, steps: EtapeChat[]): void {
    const d = t.data;
    const url = chaine(d["screenshot_url"]);
    const cur = t.msgs[t.idx];
    if (!url || !cur) return;
    const avant = (cur.webScreenshots || []).map((s) => (s.pending ? { ...s, pending: false } : s));
    const etape = Number(d["screenshot_step"]) || avant.length + 1;
    const nouvelle: CaptureChat = {
      blobUrl: null,
      serverUrl: url,
      tool: nom,
      stepIdx: steps.length - 1,
      step: etape,
      sid: chaine(d["screenshot_session"]) || null,
      ts: Date.now(),
      args: steps[steps.length - 1]?.args || null,
      pending: true,
    };
    l.patch(t.idx, {
      webScreenshots: [...avant, nouvelle],
      webScreenshotIdx: avant.length,
      webScreenshotExpanded: cur.webScreenshotExpanded == null ? false : cur.webScreenshotExpanded,
    });
    const idx = t.idx;
    const chat = r.currentChatId.value;
    void (async () => {
      let blob: string | null = null;
      try {
        const rep = await ctx.fetchAuth(url);
        if (!rep || !rep.ok) return;
        blob = URL.createObjectURL(await rep.blob());
        const m = l.getStreamMsgs();
        const c2 = m[idx];
        const ti =
          chat === r.currentChatId.value && c2?.webScreenshots
            ? c2.webScreenshots.findIndex((s) => s.step === etape)
            : -1;
        const cible = c2?.webScreenshots?.[ti];
        if (!c2 || !c2.webScreenshots || !cible) {
          URL.revokeObjectURL(blob);
          blob = null;
          return;
        }
        if (cible.blobUrl)
          try {
            URL.revokeObjectURL(cible.blobUrl);
          } catch {
            /* déjà libérée */
          }
        const shots = c2.webScreenshots.slice();
        shots[ti] = { ...cible, blobUrl: blob, pending: false };
        m[idx] = Object.assign({}, c2, { webScreenshots: shots });
      } catch {
        if (blob)
          try {
            URL.revokeObjectURL(blob);
          } catch {
            /* déjà libérée */
          }
      }
    })();
  }

  /** Contenu final et description disque d'un fichier écrit, lus dans la même réponse (3 essais). */
  async function lireFichierFinal(path: string): Promise<{ texte: string | null; disque: Objet | null }> {
    for (let essai = 0; essai < 3; essai++) {
      if (essai > 0) await new Promise((res) => setTimeout(res, 300));
      try {
        const rep = await ctx.fetchAuth("/api/sandbox/download?path=" + encodeURIComponent(path), {}, true);
        if (rep && rep.ok) {
          const dec = decoderTexte(new Uint8Array(await rep.arrayBuffer()));
          const mt = parseFloat(rep.headers.get("X-Mtime") || "");
          const sh = rep.headers.get("X-Sha256");
          return {
            texte: dec.text,
            disque: {
              ...dec,
              mtime: Number.isFinite(mt) ? mt : null,
              sha: sh && /^[0-9a-f]{64}$/.test(sh) ? sh : null,
            },
          };
        }
      } catch {
        /* nouvel essai */
      }
    }
    return { texte: null, disque: null };
  }

  function carteSansDiff(idx: number, path: string, result: unknown): void {
    l.recordDiffForMessage(idx, path, null);
    l.extractAndStoreDiffStats(idx, path, result);
  }

  // Écriture réussie, éditeur actif : réconcilie le flux ouvert ou met l'onglet à jour, puis la carte de diff.
  async function reconcilierEcriture(t: Tour, path: string): Promise<void> {
    const d = t.data;
    const chatFlux = d.chat_id || r.currentChatId.value || "local";
    const fluxActif = !!ctx.isStreamActive?.(path);
    const visionneuse = !fluxActif && !!ctx.editorIsViewerPath?.(path);
    const lu = visionneuse ? { texte: null, disque: null } : await lireFichierFinal(path);
    if (fluxActif) {
      const preSnapshot = ctx.getStreamPreSnapshot ? ctx.getStreamPreSnapshot(path) : null;
      const fin = await l.finalizeToolStream(d, chatFlux, {
        resultStr: d.result,
        finalContent: lu.texte,
        disk: lu.disque,
      });
      const pre = fin.preSnapshot || preSnapshot;
      if (pre !== null && lu.texte !== null && pre !== lu.texte) l.recordDiffForMessage(t.idx, path, pre);
      else carteSansDiff(t.idx, path, d.result);
    } else {
      const preSnapshot = ctx.capturePreWrite ? ctx.capturePreWrite(path) : null;
      if (visionneuse) {
        await ctx.editorRefreshViewer?.(path);
        carteSansDiff(t.idx, path, d.result);
      } else if (lu.texte !== null) {
        await ctx.updateEditor?.(path, lu.texte, lu.disque);
        if (preSnapshot !== null && preSnapshot !== lu.texte)
          l.recordDiffForMessage(t.idx, path, preSnapshot);
        else carteSansDiff(t.idx, path, d.result);
      }
    }
    void ctx.loadSandboxFiles?.();
  }

  async function traiterEcriture(t: Tour, path: string, erreur: boolean): Promise<void> {
    e.pendingWrite.value = null;
    try {
      let ok = true;
      try {
        const p: unknown = JSON.parse(chaine(t.data.result));
        if (estObjet(p) && p["ok"] === false) ok = false;
      } catch {
        /* résultat non JSON */
      }
      // Écriture refusée : le flux est clos tout de suite (modèle rétabli, onglet fantôme retiré).
      if ((!ok || erreur) && ctx.isStreamActive?.(path))
        try {
          await ctx.streamFinalize?.(path, { success: false });
        } catch {
          /* éditeur absent */
        }
      if (ok && r.settings.value.enable_editor) await reconcilierEcriture(t, path);
      else if (ok) {
        carteSansDiff(t.idx, path, t.data.result);
        void ctx.loadSandboxFiles?.();
      }
    } catch {
      /* non bloquant */
    }
  }

  async function surResultatOutil(t: Tour): Promise<void> {
    const d = t.data;
    const nom = d.name || "";
    const rag = nom.startsWith("rag_");
    const erreur = resultIsError(d.result);
    const cur = t.msgs[t.idx];
    if (!cur) return;
    const steps = etapes(cur);
    const libelleRag = rag ? ragResultLabel(nom, d.result) : "";
    apparier(steps, d, (s) => terminerEtape(s, d, erreur, libelleRag));
    l.patch(t.idx, { toolSteps: steps, _statusLine: "" });
    if (d["screenshot_url"] && nom.startsWith("pw_")) capturerEcran(t, nom, steps);
    if (rag) e.statusText.value = libelleRag;
    let chemin = rag ? null : chaine(d["path"]) || e.pendingWrite.value?.path || null;
    if (chemin) chemin = sousRacine(chemin, r.settings.value.sandbox_path_display);
    // Rejeu d'un journal : écriture déjà faite, seule la clôture d'un flux encore ouvert est traitée.
    const fluxRejoue = f.replaying && !!chemin && !!ctx.isStreamActive?.(chemin);
    if ((!f.replaying || fluxRejoue) && !rag) {
      const tn = nom.toLowerCase();
      if (d["dry_run"] && chemin) {
        if (ctx.isStreamActive?.(chemin))
          try {
            await ctx.streamFinalize?.(chemin, { success: false });
          } catch {
            /* éditeur absent */
          }
      } else if ((tn.includes("write") || tn.includes("save") || tn.includes("edit")) && chemin)
        await traiterEcriture(t, chemin, erreur);
      else if (/delete|move|mkdir|manage|copy|rename|shell|exec|run|git|command|terminal/.test(tn)) {
        void ctx.loadSandboxFiles?.();
        ctx.checkExternalModsSoon?.();
      }
    }
    l.mergeFilesChanged(t.idx, d["files"]);
    l.patch(t.idx, { _lastToolResultAt: Date.now() });
    void nextTick(() => l.scrollToBottom());
  }

  // Étape en cours visée par une progression ou un journal : par son call_id s'il est donné, sinon la dernière de ce nom.
  function etapeEnCours(steps: readonly EtapeChat[], d: DonneesFlux): number {
    const nom = d.name || "";
    const vise = d.call_id ? (s: EtapeChat) => s.callId === d.call_id : (s: EtapeChat) => s.name === nom;
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s && s.status === "running" && vise(s)) return i;
    }
    return -1;
  }

  function surProgressionOutil(t: Tour): void {
    const d = t.data;
    const cur = t.msgs[t.idx];
    if (!cur) return;
    const steps = etapes(cur);
    const i = etapeEnCours(steps, d);
    const s = steps[i];
    if (!s) return;
    const total = typeof d["total"] === "number" && d["total"] > 0 ? d["total"] : null;
    const progression = Number(d["progress"]);
    steps[i] = {
      ...s,
      progressInfo: {
        value: progression || 0,
        total,
        pct: total ? Math.max(0, Math.min(100, Math.round((progression / total) * 100))) : null,
        message: chaine(d["message"]),
        at: Date.now(),
      },
    };
    l.patch(t.idx, { toolSteps: steps });
  }

  function surJournalOutil(t: Tour): void {
    const d = t.data;
    const cur = t.msgs[t.idx];
    if (!cur) return;
    const steps = etapes(cur);
    const i = etapeEnCours(steps, d);
    const s = steps[i];
    if (!s) return;
    const avant = s.logs || [];
    const ligne = {
      level: chaine(d["level"]) || "info",
      message: chaine(d["message"]),
      logger: chaine(d["logger"]),
      at: Date.now(),
    };
    steps[i] = { ...s, logs: avant.length >= 50 ? [...avant.slice(-49), ligne] : [...avant, ligne] };
    l.patch(t.idx, { toolSteps: steps });
  }

  function indexEtapeShell(steps: EtapeChat[], d: DonneesFlux): number {
    const nom = d.name || "";
    const essais: ((s: EtapeChat) => boolean)[] = [];
    if (d.call_id) essais.push((s) => s.callId === d.call_id);
    essais.push(
      (s) => s.name === nom && s.status === "running",
      (s) => s.name === nom,
    );
    for (const essai of essais)
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (s && essai(s)) return i;
      }
    return -1;
  }

  // Terminal en direct : morceaux coalescés par étape (aucun patch ici), fin appliquée tout de suite.
  function surSortieShell(t: Tour): void {
    const d = t.data;
    if (r.settings.value.live_shell_enabled === false) return;
    const cur = t.msgs[t.idx];
    if (!cur) return;
    const steps = etapes(cur);
    const si = indexEtapeShell(steps, d);
    const st = steps[si];
    if (si < 0 || !st) return;
    const cle = t.idx + ":" + si;
    const attente = f.shellPend.get(cle);
    const base = Math.max(st.shellSeq || 0, attente?.seq || 0);
    const seq = d["seq"];
    if (typeof seq === "number" && seq <= base) return;
    const morceau = d["chunk"];
    if (!d["done"] && typeof morceau === "string" && morceau) {
      const p = attente || { chunk: "", seq: 0 };
      p.chunk += morceau;
      p.seq = Math.max(p.seq, nombreOu(seq, 0) || base + 1);
      f.shellPend.set(cle, p);
      l.armerShell();
      return;
    }
    const maj: EtapeChat = { ...st, shellSeq: nombreOu(seq, 0) || base + 1 };
    if (d["done"]) {
      if (attente) {
        maj.shellOut = l.shellFoldPend(st, attente);
        f.shellPend.delete(cle);
      }
      maj.shellDone = true;
      maj.shellRc = typeof d["returncode"] === "number" ? d["returncode"] : null;
      maj.shellMs = Number(d["duration_ms"]) || 0;
      maj.shellLiveTruncated = !!d["live_truncated"];
    }
    steps[si] = maj;
    l.patch(t.idx, { toolSteps: steps });
  }

  function annulationDifferee(run: ExecutionTache, cid: string): void {
    if (!run.cancelRequested || run.cancelSent) return;
    run.cancelSent = true;
    void ctx
      .fetchAuth("/api/chat/task-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ child_id: cid }),
      })
      .catch(() => null);
  }

  function finSousAgent(run: ExecutionTache, d: DonneesFlux): void {
    run.state = chaine(d["state"]) || "completed";
    run.steps_total = Number(d["steps_total"]) || 0;
    run.input_tokens = Number(d["input_tokens"]) || 0;
    run.output_tokens = Number(d["output_tokens"]) || 0;
    run.duration_ms = Number(d["duration_ms"]) || 0;
    run.tokens =
      Number(d["context_tokens"]) > 0
        ? Number(d["context_tokens"])
        : run.tokens || run.input_tokens + run.output_tokens;
    run.progress = null;
    if (Array.isArray(d["transcript"]) && d["transcript"].length)
      run.transcript = d["transcript"] as EntreeDeroule[];
    if (typeof d["result"] === "string" && d["result"]) run.result = d["result"];
    const bilan = lireBilanTache(d["harness"]);
    if (bilan) run.harness = bilan;
  }

  function etapeSousAgent(run: ExecutionTache, d: DonneesFlux): void {
    const outils = [...(run.tools || [])];
    const deroule: EntreeDeroule[] = [...(run.transcript || [])];
    const outil = chaine(d["tool"]);
    if (d["status"] === "running") {
      const entree = { tool: outil, args_preview: chaine(d["args_preview"]), status: "running" };
      run.tools = outils.length >= 50 ? [...outils.slice(-49), entree] : [...outils, entree];
      if (deroule.length < 120) deroule.push({ ...entree, result_preview: "" });
      run.transcript = deroule;
      // « étape N/M » : tours comptés par le serveur ; sans valeur, la progression connue est gardée.
      run.progress = {
        step: Number(d["step"]) || run.progress?.step || 1,
        max_steps: Number(d["max_steps"]) || run.progress?.max_steps || 0,
      };
      return;
    }
    for (let j = outils.length - 1; j >= 0; j--) {
      const o = outils[j];
      if (o && o.status === "running" && o.tool === outil) {
        outils[j] = { ...o, status: chaine(d["status"]) };
        break;
      }
    }
    for (let j = deroule.length - 1; j >= 0; j--) {
      const o = deroule[j];
      if (o && o.status === "running" && o.tool === outil) {
        deroule[j] = { ...o, status: chaine(d["status"]), result_preview: chaine(d["result_preview"]) };
        break;
      }
    }
    run.tools = outils;
    run.transcript = deroule;
  }

  // Sous-agent : la ligne de son appel `task` (call_id) ; sans call_id, le run en cours de même id.
  function surEtapeSousAgent(t: Tour): void {
    const d = t.data;
    const cid = chaine(d["child_id"]);
    const appel = chaine(d["call_id"]);
    l.mergeFilesChanged(t.idx, d["files"]);
    const cur = t.msgs[t.idx];
    if (!cur) return;
    const runs = [...(cur.taskRuns || [])];
    const ri = appel
      ? runs.findIndex((x) => x.callId === appel)
      : cid
        ? runs.findIndex((x) => x.id === cid && x.state === "running")
        : -1;
    const source = runs[ri];
    if (ri < 0 || !source) return;
    const run: ExecutionTache = { ...source };
    if (!run.id && cid) {
      run.id = cid;
      annulationDifferee(run, cid);
    }
    if (typeof d["tokens"] === "number") run.tokens = d["tokens"];
    const statut = d["status"];
    if (statut === "spawned") {
      if (typeof d["depth"] === "number") run.depth = d["depth"];
    } else if (statut === "text") {
      const tr = [...(run.transcript || [])];
      if (tr.length < 120 && d.text) tr.push({ text: String(d.text) });
      run.transcript = tr;
    } else if (statut === "final") finSousAgent(run, d);
    else if (statut !== "tick") etapeSousAgent(run, d);
    runs[ri] = run;
    l.patch(t.idx, { taskRuns: runs });
  }

  async function surErreur(t: Tour): Promise<void> {
    const d = t.data;
    f.pendingAskUser = null;
    e.isThinking.value = false;
    t.toast(d.text || "Erreur", "error");
    const chat = d.chat_id || r.currentChatId.value || "local";
    await l.finalizeAllToolStreams(chat);
    const cur = t.msgs[t.idx];
    if (cur && cur.webScreenshots && cur.webScreenshots.length)
      for (const s of cur.webScreenshots) s.pending = false;
    // Une erreur n'est pas suivie d'un `final` : la bulle sort du flux ici.
    l.patch(t.idx, {
      isError: true,
      errorMessage: d.text || "Erreur",
      errorDetail: d["detail"] || "",
      errorKind: d["kind"] || "",
      isStreaming: false,
      ...STREAM_RENDER_CLEAR,
    });
  }

  function surAvis(t: Tour): void {
    const d = t.data;
    if (!d.text) return;
    const alerte = d.type === "warning";
    const opts: OptionsToast = { duration: alerte ? 12000 : 7000 };
    if (alerte && r.currentChatId.value && /contexte/i.test(d.text)) {
      opts.actionLabel = "Compacter";
      opts.onAction = () => void l.manualCompress();
    }
    t.toast(d.text, alerte ? "warning" : "info", opts);
  }

  function surNotice(t: Tour): void {
    const message = chaine(t.data["message"]);
    if (!message) return;
    const alerte = t.data["level"] === "warn";
    t.toast(message, alerte ? "warning" : "info", { duration: alerte ? 12000 : 7000 });
  }

  /** Applique un événement du flux au message assistant en cours (vue historique du tour). */
  async function handleStreamEvent(data: DonneesFlux): Promise<void> {
    const toast: Toast = f.replaying ? rien : ctx.showToast;
    const msgs = l.getStreamMsgs();
    const idx = l.streamIdx(msgs);
    if (idx < 0) return;
    // Un événement d'un flux précédent ne pose pas l'identifiant du chat courant.
    if (data.chat_id && !r.currentChatId.value && f.streamingForChatId === data.chat_id)
      r.currentChatId.value = data.chat_id;
    const t: Tour = { data, msgs, idx, toast };
    switch (data.type) {
      case "thinking_token":
        return surReflexion(t);
      case "content_replace":
        return surRemplacement(t);
      case "content_token":
        return surContenu(t);
      case "prompt_progress":
        return surPreremplissage(t);
      case "queue_status":
        return surFileAttente(t);
      case "queue_cleared":
        e.queueStatus.value = null;
        if (msgs[idx]?._modelLoad) l.patch(idx, { _modelLoad: null });
        return;
      case "todo_updated":
        e.todoList.value = Array.isArray(data["todos"]) ? (data["todos"] as TacheSession[]) : [];
        f.todoTouchedThisTurn = true;
        return;
      case "iteration": {
        const cur = msgs[idx];
        const n = data["n"];
        const max = data["max"];
        if (cur && typeof n === "number" && typeof max === "number" && max > 0)
          msgs[idx] = { ...cur, iterBudget: { n, max } };
        return;
      }
      case "kv_cache":
        return surOccupation(t);
      case "compression_start":
        return surDebutCompression(t);
      case "compression_done":
        return surFinCompression(t);
      case "compression_capped":
        e.compressionCapped.value = { round: Number(data["round"]) || 0, max: Number(data["max"]) || 0 };
        return;
      case "image_progress":
        return surProgressionImage(t);
      case "image":
        return surImage(t);
      case "image_prompt":
        l.patch(idx, { revised_prompt: data.text || "" });
        return;
      case "image_error":
        return surErreurImage(t);
      case "thinking":
      case "mode":
        return surStatut(t);
      case "thinking_content":
        return surContenuReflexion(t);
      case "final":
        return surFinal(t);
      case "tool_call_delta":
        return data.reset ? surReinitDelta(t) : surDelta(t);
      case "tool_call":
        return surAppelOutil(t);
      case "tool_result":
        return surResultatOutil(t);
      case "tool_progress":
        return surProgressionOutil(t);
      case "tool_log":
        return surJournalOutil(t);
      case "shell_output":
        return surSortieShell(t);
      case "task_step":
        return surEtapeSousAgent(t);
      case "annotation_frame":
        try {
          ctx.onAnnotationFrame?.(data);
        } catch {
          /* Studio absent */
        }
        return;
      case "error":
        return surErreur(t);
      case "warning":
      case "info":
        return surAvis(t);
      case "rag_sources": {
        const recues = sourcesRagValides(data["sources"]);
        if (!recues.length) return;
        const cur = l.getStreamMsgs()[idx];
        const sources = fusionnerSourcesRag(cur?.rag_sources, recues);
        l.patch(idx, { rag_sources: sources, _ragSources: sourcesRag(sources) });
        return;
      }
      case "journal_truncated":
        l.patch(idx, { _journalTruncated: true });
        return;
      case "notice":
        return surNotice(t);
      default:
        return;
    }
  }

  return { handleStreamEvent };
}
