// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/historique/historique.ts — conversations enregistrées : liste, nouveau chat, chargement (jetons de chargement et de session), archivage, renommage, suppression annulable, actions groupées. */
import { schemaResumeReveil } from "@elpis/contracts";
import type { Ref } from "vue";

import { copyImageFields } from "../../images/formats.ts";
import { lireBilanTache } from "../outils/bilan-tache.ts";
import { parseToolHistorySegments } from "../outils/segments.ts";
import { sourcesRagValides } from "../../rag/sources.ts";
import type { FetchAuth, VueFabrique } from "./recherche";

export interface ResumeChat {
  id: string;
  title: string;
  [cle: string]: unknown;
}

export type Message = Record<string, unknown>;

export interface RefsHistorique {
  messages: Ref<readonly Message[]>;
  currentChatId: Ref<string | null>;
  currentChatTitle: Ref<string>;
  currentView: Ref<string>;
  isStreaming: Ref<boolean>;
  isUserScrolling: Ref<boolean>;
  chats: Ref<ResumeChat[]>;
  inputRef: Ref<HTMLTextAreaElement | null>;
  attachedFiles?: Ref<unknown[]>;
  user?: Ref<unknown>;
}

interface OptionsToast {
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
  onExpire?: () => void | Promise<void>;
}

export interface CtxHistorique {
  fetchAuth: FetchAuth;
  showToast(message: string, type?: string, options?: OptionsToast): void;
  openConfirm(titre: string, texte?: string, danger?: boolean, libelle?: string): Promise<boolean>;
  openPrompt(titre: string, valeur?: string): Promise<string | null>;
  showSidebar: Ref<boolean>;
  clearSavedSession?: () => void;
  announce?: (message: string) => void;
}

interface StatutGeneration {
  generation_running?: boolean;
  resumable?: boolean;
  run_id?: string;
}

type Rappel = (...args: never[]) => unknown;

export interface DepsHistorique {
  detachFromStream(): void;
  stopRunForChat?: ((id: string) => unknown) | null;
  attachRun?: (id: string, statut: StatutGeneration) => unknown;
  followRun?: (id: string, opts: { silent: boolean }) => unknown;
  _parseFileBlocks(contenu: unknown): { files?: unknown; displayContent?: unknown };
  scrollToBottom(force?: boolean): void;
  settleScrollBottom?: () => void;
  _revokeAllWebShotBlobs(): void;
  _vsReset(): void;
  _vsInitTail(n: number): void;
  clearMarkdownCache(): void;
  clearChartInstances?: Rappel;
  resetDiffCardState?: Rappel;
  loadAvailableModels(): unknown;
  resetMessageSearch?: Rappel;
  cancelEditMessage?: Rappel;
  setTodoList?: (taches: readonly unknown[]) => void;
  applyChatTools?: (outils: unknown) => void;
  defaultToolKeys?: () => unknown;
  resetSlash?: Rappel;
  applyChatPlanMode?: (actif: unknown) => void;
  applyChatRag?: (rag: unknown) => void;
  applyChatCtxUsage?: (usage: unknown, id: string) => void;
  clearPinnedSkills?: Rappel;
  resetAskUser?: Rappel;
  closeTaskModal?: Rappel;
  resetImageCompose?: Rappel;
  compterJobsActifs?: (chatIds: readonly string[]) => Promise<number>;
  [cle: string]: unknown;
}

/** Ce que l'historique lit de la session (L04) : un chargement parti avant une déconnexion n'écrit rien. */
export interface SessionGenerations {
  readonly generation: number;
}

interface GlobalsHistorique {
  __ADMIN_ONLY_MODE__?: boolean;
}

export interface HistoriqueChat {
  loadChatsList(): Promise<void>;
  startNewChat(): Promise<void>;
  loadChat(id: string, opts?: { force?: boolean; noAttach?: boolean }): Promise<void>;
  archiveChat(id: string): Promise<void>;
  renameChat(id: string, ancien: string): Promise<void>;
  _doRenameChat(id: string, titre: string): Promise<boolean>;
  deleteChat(id: string): Promise<void>;
  chatSelectMode: Ref<boolean>;
  chatSelected: Ref<string[]>;
  toggleChatSelectMode(): void;
  toggleChatSelect(id: string): void;
  bulkArchiveChats(): Promise<void>;
  bulkDeleteChats(): Promise<void>;
}

// `globalThis` plutôt que `window` : le module se charge aussi dans Node (harnais des scripts historiques).
const globaux = (): GlobalsHistorique & Partial<Pick<Window, "innerWidth" | "addEventListener">> =>
  globalThis as unknown as GlobalsHistorique;
// Une seule écoute du déchargement par page, quel que soit le nombre d'historiques créés.
let dechargementEcoute = false;
const etroit = (): boolean => (globaux().innerWidth ?? 1024) < 1024;

function appeler(f: Rappel | null | undefined): void {
  if (typeof f !== "function") return;
  try {
    (f as () => unknown)();
  } catch {
    /* une remise à zéro d'un sous-module ne bloque pas le changement de chat */
  }
}

function enregistrement(x: unknown): x is Message {
  return !!x && typeof x === "object";
}

/** Contenu multimodal persisté → texte et images, comme à l'envoi. */
function contenuEtImages(m: Message): { contenu: unknown; images: unknown[] | null } {
  let images = Array.isArray(m.images) && m.images.length ? (m.images as unknown[]) : null;
  const brut = m.content;
  if (!Array.isArray(brut)) return { contenu: brut, images };
  if (!images) {
    const extraites = brut
      .filter(
        (p): p is { image_url: { url: string } } =>
          enregistrement(p) && p.type === "image_url" && enregistrement(p.image_url) && !!p.image_url.url,
      )
      .map((p) => ({ dataUrl: p.image_url.url }));
    if (extraites.length) images = extraites;
  }
  const texte: unknown = brut.find((p) => enregistrement(p) && p.type === "text");
  const contenu = enregistrement(texte) && typeof texte.text === "string" ? texte.text : "";
  return { contenu, images };
}

/** Pseudo-étapes « compression du contexte » d'un tour, replacées après les appels du round où elles ont eu lieu. */
function placerCompactions(msg: Message, compactions: readonly unknown[]): void {
  const etapes = [...((msg.toolSteps as Message[] | undefined) ?? [])];
  const segs = Array.isArray(msg.segTexts) && msg.segTexts.length ? msg.segTexts : [""];
  for (const c of compactions) {
    if (!enregistrement(c)) continue;
    const r = Number(c.round) || 0;
    const pos = etapes.findIndex(
      (s) => s._kind !== "compression" && typeof s.round === "number" && s.round >= r,
    );
    const ou = pos < 0 ? etapes.length : pos;
    const prec = etapes[ou - 1];
    const avant = Number(c.tokens_before) || 0;
    etapes.splice(ou, 0, {
      _kind: "compression",
      name: "context_compress",
      status: "done",
      seg: prec ? (prec.seg as number) || 0 : 0,
      path: c.path || "",
      reason: c.reason || "",
      threshold: c.threshold || 0,
      ctx_size: c.ctx_size || 0,
      args: null,
      result: null,
      stats: { ...c, ratio: avant ? (Number(c.tokens_after) || 0) / avant : 0 },
    });
  }
  msg.toolSteps = etapes;
  if (!(Array.isArray(msg.segTexts) && msg.segTexts.length)) msg.segTexts = segs;
}

/** Messages persistés → messages affichés, gelés (Vue ne les rend pas réactifs ; `_patch` remplace l'objet à son index). */
export function construireMessages(
  bruts: readonly Message[],
  parseFileBlocks: DepsHistorique["_parseFileBlocks"],
): Message[] {
  let dernierAssistant = -1;
  for (let i = bruts.length - 1; i >= 0; i--) {
    if (bruts[i]?.role === "assistant") {
      dernierAssistant = i;
      break;
    }
  }
  let historiquePrecedent: unknown = null;
  return bruts.map((m, mi) => {
    const { contenu, images } = contenuEtImages(m);
    const fichiers = m.role === "user" ? parseFileBlocks(contenu) : {};
    const msg: Message = {
      role: m.role,
      content: contenu,
      metrics: m.metrics,
      isError: m.isError,
      thinking: mi === dernierAssistant ? m.thinking || "" : "",
      thinkingOpen: false,
      files: fichiers.files,
      displayContent: fichiers.displayContent,
    };
    if (images && images.length) msg.images = images;
    if (m.role === "user" && m.origin === "job_wake") {
      msg.origin = "job_wake";
      const wake = schemaResumeReveil.safeParse(m.wake);
      if (wake.success) msg.wake = wake.data;
    }
    if (m.role === "notice") {
      msg.kind = m.kind || "compaction";
      msg.ts = m.ts || null;
      msg.tokens_after = m.tokens_after || null;
      msg.summary = m.summary || "";
    }
    if (m.tool_history) msg.tool_history = m.tool_history;
    if (m.tool_history_delta) msg.tool_history_delta = true;
    if (m.role === "assistant" && Array.isArray(m.tool_history) && m.tool_history.length) {
      const segs = parseToolHistorySegments(m.tool_history, {
        prevHistory: historiquePrecedent,
        delta: !!m.tool_history_delta,
        finalContent: (typeof contenu === "string" ? contenu : "") || "",
      });
      if (segs && segs.toolSteps.length) {
        msg.toolSteps = segs.toolSteps;
        msg.segTexts = segs.segTexts;
      }
      historiquePrecedent = m.tool_history;
    }
    if (m.isTruncated) msg.isTruncated = m.isTruncated;
    if (m.toolLoopTruncated) msg.toolLoopTruncated = m.toolLoopTruncated;
    if (m.toolLoopStats) msg.toolLoopStats = m.toolLoopStats;
    if (m.thinkingTruncated && m.resume_thinking) {
      msg.thinking = msg.thinking || m.resume_thinking;
      msg.resume_thinking = m.resume_thinking;
      msg.thinkingTruncated = true;
    }
    if (Array.isArray(m.task_runs) && m.task_runs.length) {
      msg.taskRuns = m.task_runs.filter(enregistrement).map((r) => {
        const { harness, ...reste } = r;
        const bilan = lireBilanTache(harness);
        return {
          ...reste,
          ...(bilan ? { harness: bilan } : {}),
          tokens:
            Number(r.context_tokens) > 0
              ? Number(r.context_tokens)
              : (Number(r.input_tokens) || 0) + (Number(r.output_tokens) || 0),
        };
      });
    }
    if (m.errorMessage) msg.errorMessage = m.errorMessage;
    if (Array.isArray(m.files_changed) && m.files_changed.length) msg.files_changed = m.files_changed;
    if (Array.isArray(m.run_ids) && m.run_ids.length) msg.run_ids = m.run_ids;
    if (m.role === "assistant") {
      const sources = sourcesRagValides(m.rag_sources);
      if (sources.length) msg.rag_sources = sources;
    }
    if (m.role === "assistant" && Array.isArray(m.compactions) && m.compactions.length) {
      msg.compactions = m.compactions;
      placerCompactions(msg, m.compactions);
    }
    if (m.pruned) msg.pruned = m.pruned;
    copyImageFields(m, msg);
    return Object.freeze(msg);
  });
}

async function lireJson(res: Response): Promise<Record<string, unknown>> {
  const corps: unknown = await res.json().catch(() => ({}));
  return enregistrement(corps) ? corps : {};
}

/** Même contrat que l'ancien `setupChatHistory(vue, refs, ctx, deps)` de chat/_history.js. */
export function creerHistoriqueChat(
  vue: VueFabrique,
  refs: RefsHistorique,
  ctx: CtxHistorique,
  deps: DepsHistorique,
  session: SessionGenerations | null = null,
): HistoriqueChat {
  const { ref, nextTick } = vue;
  const {
    messages,
    currentChatId,
    currentChatTitle,
    currentView,
    isStreaming,
    isUserScrolling,
    chats,
    inputRef,
  } = refs;
  const user = refs.user ?? { value: null };
  const { fetchAuth, showToast, openConfirm, openPrompt, showSidebar } = ctx;

  // Pièces jointes, édition, menus et questionnaire ne suivent pas vers une autre conversation.
  function remettreComposeur(memeChat: boolean): void {
    if (!memeChat && refs.attachedFiles) refs.attachedFiles.value = [];
    appeler(deps.cancelEditMessage);
    appeler(deps.resetSlash);
    appeler(deps.clearPinnedSkills);
    appeler(deps.resetAskUser);
    appeler(deps.closeTaskModal);
    if (!memeChat) appeler(deps.resetImageCompose);
  }

  function viderRendu(): void {
    deps._revokeAllWebShotBlobs();
    deps._vsReset();
    deps.clearMarkdownCache();
    appeler(deps.clearChartInstances);
    appeler(deps.resetDiffCardState);
    appeler(deps.resetMessageSearch);
  }

  async function loadChatsList(): Promise<void> {
    if (globaux().__ADMIN_ONLY_MODE__) return;
    try {
      const res = await fetchAuth("/api/saved/chats?archived=0", {}, true);
      if (!res || !res.ok) return;
      const items = (await lireJson(res)).items;
      chats.value = Array.isArray(items) ? (items as ResumeChat[]) : [];
      if (currentChatId.value) {
        const cur = chats.value.find((c) => c.id === currentChatId.value);
        if (cur) currentChatTitle.value = cur.title;
      }
    } catch {
      /* liste non fatale */
    }
  }

  // Jeton de chargement : seul le dernier chargement demandé (ou un « Nouveau chat ») écrit.
  let sequence = 0;

  async function startNewChat(): Promise<void> {
    currentView.value = "chat";
    sequence++;
    deps.detachFromStream();
    viderRendu();
    remettreComposeur(false);
    messages.value = [];
    currentChatId.value = null;
    currentChatTitle.value = "";
    deps.setTodoList?.([]);
    deps.applyChatTools?.(typeof deps.defaultToolKeys === "function" ? deps.defaultToolKeys() : []);
    deps.applyChatPlanMode?.(false);
    deps.applyChatRag?.(null);
    isUserScrolling.value = false;
    try {
      ctx.clearSavedSession?.();
    } catch {
      /* stockage indisponible */
    }
    if (etroit()) showSidebar.value = false;
    void deps.loadAvailableModels();
    void nextTick(() => inputRef.value?.focus());
  }

  function sonderRun(id: string, seq: number, opts: { noAttach?: boolean } | undefined): void {
    fetchAuth("/api/chat/" + encodeURIComponent(id) + "/generation-status", {}, true)
      .then((r) => (r && r.ok ? (r.json() as Promise<unknown>) : null))
      .then((d) => {
        if (seq !== sequence || !enregistrement(d)) return;
        const statut = d as StatutGeneration;
        if (!statut.generation_running || currentChatId.value !== id || isStreaming.value) return;
        try {
          if (statut.resumable && statut.run_id && !opts?.noAttach && typeof deps.attachRun === "function")
            deps.attachRun(id, statut);
          else if (deps.followRun) deps.followRun(id, { silent: true });
        } catch {
          /* suivi best-effort */
        }
      })
      .catch(() => {});
  }

  async function loadChat(id: string, opts?: { force?: boolean; noAttach?: boolean }): Promise<void> {
    currentView.value = "chat";
    if (currentChatId.value === id && !opts?.force) return;
    const seq = ++sequence;
    const generation = session ? session.generation : 0;
    const perime = (): boolean => seq !== sequence || (session !== null && session.generation !== generation);
    const memeChat = currentChatId.value === id;
    deps.detachFromStream();
    viderRendu();
    remettreComposeur(memeChat);
    try {
      const res = await fetchAuth("/api/saved/chats/" + id, {}, true);
      if (perime()) return;
      if (res && res.ok) {
        const d = await lireJson(res);
        if (perime()) return;
        currentChatId.value = d.id as string;
        currentChatTitle.value = d.title as string;
        if (deps.setTodoList) {
          const taches = Array.isArray(d.todos) ? d.todos : [];
          const ouvertes = taches.some(
            (t) => enregistrement(t) && t.status !== "completed" && t.status !== "cancelled",
          );
          deps.setTodoList(ouvertes ? taches : []);
        }
        deps.applyChatTools?.(d.tools);
        deps.applyChatPlanMode?.(d.plan_mode);
        deps.applyChatRag?.(d.rag);
        const bruts = (Array.isArray(d.messages) ? d.messages : []).filter(
          (m): m is Message => enregistrement(m) && m.role !== "system",
        );
        const construits = construireMessages(bruts, deps._parseFileBlocks);
        // Fenêtre posée avant l'affectation : le premier calcul des lignes visibles est déjà le bon.
        deps._vsInitTail(construits.length);
        messages.value = construits;
        deps.applyChatCtxUsage?.(d.ctx_usage, d.id as string);
        if (etroit()) showSidebar.value = false;
        isUserScrolling.value = false;
        void deps.loadAvailableModels();
        void nextTick(() => {
          deps.scrollToBottom(true);
          deps.settleScrollBottom?.();
        });
        sonderRun(id, seq, opts);
      } else if (!res && !user.value) {
        /* 401 déjà traité par fetchAuth (écran de connexion) */
      } else if (res && res.status === 404) {
        showToast("Cette conversation n’existe plus.", "error");
        void loadChatsList();
      } else {
        showToast(
          "Conversation impossible à charger" +
            (res ? " (erreur " + res.status + ")" : " : serveur injoignable") +
            " — réessayez.",
          "error",
        );
      }
    } catch {
      if (perime()) return;
      showToast(
        "Conversation illisible — son contenu est corrompu ou " + "la réponse du serveur est incomplète.",
        "error",
      );
    }
  }

  /** Désarchive après « Annuler » : la conversation reprend sa place, ou la liste est relue si le serveur refuse. */
  async function desarchiver(ids: readonly string[], remettre: () => void): Promise<void> {
    const reponses = await Promise.all(
      ids.map((i) => fetchAuth("/api/saved/chats/" + i + "/unarchive", { method: "POST" }).catch(() => null)),
    );
    if (reponses.every((r) => r && r.ok)) {
      remettre();
      showToast(ids.length > 1 ? "Conversations restaurées" : "Conversation restaurée");
    } else {
      void loadChatsList();
      showToast("Restauration impossible", "error");
    }
  }

  // Réversible : l'archivage part sans question, « Annuler » le défait.
  async function archiveChat(id: string): Promise<void> {
    if (!id) return;
    const idStr = String(id);
    try {
      const res = await fetchAuth("/api/saved/chats/" + id + "/archive", { method: "POST" });
      if (!res || !res.ok) {
        showToast("Archivage impossible", "error");
        return;
      }
      const idx = chats.value.findIndex((c) => String(c.id) === idStr);
      const retire = idx >= 0 ? (chats.value[idx] as ResumeChat) : null;
      chats.value = chats.value.filter((c) => String(c.id) !== idStr);
      if (String(currentChatId.value) === idStr) void startNewChat();
      const titre = retire?.title ? `« ${retire.title} » archivée` : "Conversation archivée";
      showToast(titre, "success", {
        duration: 6000,
        actionLabel: "Annuler",
        onAction: () =>
          void desarchiver([idStr], () => {
            if (retire && !chats.value.some((c) => String(c.id) === idStr))
              chats.value.splice(Math.min(idx, chats.value.length), 0, retire);
          }),
      });
    } catch {
      showToast("Archivage impossible", "error");
    }
  }

  async function _doRenameChat(id: string, nouveau: string): Promise<boolean> {
    const title = (nouveau || "").trim();
    if (!title) return false;
    try {
      const res = await fetchAuth("/api/saved/chats/" + id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (res && res.ok) {
        const chat = chats.value.find((c) => String(c.id) === String(id));
        if (chat) chat.title = title;
        if (String(currentChatId.value) === String(id)) currentChatTitle.value = title;
        return true;
      }
    } catch {
      /* non fatal */
    }
    return false;
  }

  async function renameChat(id: string, ancien: string): Promise<void> {
    const title = await openPrompt("Renommer la conversation", ancien);
    if (!title || !title.trim()) return;
    await _doRenameChat(id, title);
  }

  // Suppressions en attente du toast d'annulation : envoyées au déchargement de la page (keepalive).
  const suppressionsEnAttente = new Set<string>();
  const g = globaux();
  if (!dechargementEcoute && typeof g.addEventListener === "function") {
    dechargementEcoute = true;
    g.addEventListener("beforeunload", () => {
      for (const pid of suppressionsEnAttente) {
        fetchAuth("/api/saved/chats/" + pid, { method: "DELETE", keepalive: true }).catch(() => {});
      }
      suppressionsEnAttente.clear();
    });
  }

  // « N tâches de fond seront arrêtées » : lecture best-effort, la suppression ne dépend pas d'elle.
  async function avertissementJobs(ids: readonly string[]): Promise<string> {
    const n = await Promise.resolve(deps.compterJobsActifs?.(ids) ?? 0).catch(() => 0);
    return n > 0 ? `${n} ${n > 1 ? "tâches de fond seront arrêtées" : "tâche de fond sera arrêtée"}.` : "";
  }

  async function deleteChat(id: string): Promise<void> {
    if (!id) return;
    // Irréversible une fois le toast passé : la confirmation reste.
    if (
      !(await openConfirm(
        "Supprimer la conversation ?",
        await avertissementJobs([String(id)]),
        true,
        "Supprimer",
      ))
    )
      return;
    const idStr = String(id);
    if (typeof deps.stopRunForChat === "function") {
      try {
        deps.stopRunForChat(idStr);
      } catch {
        /* arrêt best-effort */
      }
    }
    const idx = chats.value.findIndex((c) => String(c.id) === idStr);
    if (idx < 0) return;
    const retire = chats.value[idx] as ResumeChat;
    chats.value.splice(idx, 1);
    if (String(currentChatId.value) === idStr) void startNewChat();
    let annule = false;
    // Restauration par identité : la liste a pu changer pendant les 5 s du toast.
    const restaurer = (): void => {
      if (chats.value.some((c) => String(c.id) === idStr)) return;
      chats.value.splice(Math.min(idx, chats.value.length), 0, retire);
    };
    suppressionsEnAttente.add(idStr);
    showToast("Conversation supprimée", "success", {
      duration: 5000,
      actionLabel: "Annuler",
      onAction: () => {
        annule = true;
        suppressionsEnAttente.delete(idStr);
        restaurer();
        showToast("Suppression annulée");
      },
      onExpire: async () => {
        if (annule) return;
        try {
          const res = await fetchAuth("/api/saved/chats/" + id, { method: "DELETE" });
          if (!res || !res.ok) {
            restaurer();
            showToast("Échec de la suppression", "error");
          }
        } catch {
          restaurer();
          showToast("Erreur réseau", "error");
        } finally {
          suppressionsEnAttente.delete(idStr);
        }
      },
    });
  }

  const chatSelectMode = ref(false);
  const chatSelected = ref<string[]>([]);

  function toggleChatSelectMode(): void {
    chatSelectMode.value = !chatSelectMode.value;
    chatSelected.value = [];
  }

  function toggleChatSelect(id: string): void {
    const i = chatSelected.value.indexOf(id);
    if (i >= 0) chatSelected.value.splice(i, 1);
    else chatSelected.value.push(id);
  }

  function finirGroupe(message: string, type = "success", annuler?: () => void): void {
    if (message)
      showToast(message, type, annuler ? { duration: 6000, actionLabel: "Annuler", onAction: annuler } : {});
    ctx.announce?.(message || "");
    chatSelected.value = [];
    chatSelectMode.value = false;
  }

  // Action groupée : retrait optimiste, requête batch, liste relue du serveur en cas d'échec.
  async function groupe(
    ids: string[],
    route: string,
    cle: string,
    reussite: (n: number) => string,
    echec: string,
    annuler?: () => void,
  ): Promise<void> {
    const ensemble = new Set(ids.map(String));
    chats.value = chats.value.filter((c) => !ensemble.has(String(c.id)));
    if (ensemble.has(String(currentChatId.value))) void startNewChat();
    try {
      const res = await fetchAuth(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (res && res.ok) {
        const n = (await lireJson(res))[cle];
        finirGroupe(reussite(n != null ? Number(n) : ids.length), "success", annuler);
      } else {
        void loadChatsList();
        finirGroupe(echec, "error");
      }
    } catch {
      void loadChatsList();
      finirGroupe("Erreur réseau", "error");
    }
  }

  async function bulkArchiveChats(): Promise<void> {
    const ids = chatSelected.value.slice();
    if (!ids.length) return;
    const avant = chats.value.slice();
    await groupe(
      ids,
      "/api/saved/chats/archive-batch",
      "archived",
      (n) => `${n} conversation(s) archivée(s)`,
      "Échec de l'archivage",
      () =>
        void desarchiver(ids, () => {
          const presents = new Set(chats.value.map((c) => String(c.id)));
          chats.value = [
            ...chats.value,
            ...avant.filter((c) => ids.includes(String(c.id)) && !presents.has(String(c.id))),
          ];
        }),
    );
  }

  async function bulkDeleteChats(): Promise<void> {
    const ids = chatSelected.value.slice();
    if (!ids.length) return;
    if (
      !(await openConfirm(
        `Supprimer ${ids.length} conversation(s) ?`,
        ["Cette action est irréversible.", await avertissementJobs(ids)].filter(Boolean).join(" "),
        true,
        "Supprimer",
      ))
    )
      return;
    await groupe(
      ids,
      "/api/saved/chats/delete-batch",
      "deleted",
      (n) => `${n} conversation(s) supprimée(s)`,
      "Échec de la suppression",
    );
  }

  return {
    loadChatsList,
    startNewChat,
    loadChat,
    archiveChat,
    renameChat,
    _doRenameChat,
    deleteChat,
    chatSelectMode,
    chatSelected,
    toggleChatSelectMode,
    toggleChatSelect,
    bulkArchiveChats,
    bulkDeleteChats,
  };
}
