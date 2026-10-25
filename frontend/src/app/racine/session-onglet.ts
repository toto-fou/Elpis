// SPDX-License-Identifier: MIT
/** frontend/src/app/racine/session-onglet.ts — reprise après rechargement de l'onglet (instantané de la conversation par compte) et retour vers une autorisation OAuth. */
import { schemaMetaOutils } from "@elpis/contracts";
import type { Ref } from "vue";

import { copyImageFields } from "../../features/images/formats";
import { segmentsOutils } from "../../features/chat/outils/segments";
import type { MessageChat } from "../../features/chat/coeur/types";
import type { FetchAuth } from "../../features/editor/etat";

export const CLE_SESSION = "elpis_chat_session";
const DUREE_MAX_MS = 3600000;

interface CompteSession {
  id?: unknown;
  user_id?: unknown;
  username?: unknown;
}

/** Ce que la reprise lit et réécrit dans le chat. */
export interface ChatSession {
  readonly currentChatTitle?: Ref<string>;
  readonly todoList?: Ref<unknown[]>;
  activeToolCats?(): unknown;
  applyChatTools?(cats: unknown[]): unknown;
  scrollToBottom?(force?: boolean): unknown;
  loadChat?(id: string, opts?: { force?: boolean }): unknown;
  readonly ragChat?: { recharger(chatId: string): unknown };
}

export interface DependancesSessionOnglet {
  readonly user: Ref<CompteSession | null>;
  readonly messages: Ref<MessageChat[]>;
  readonly currentChatId: Ref<string | null>;
  readonly fetchAuth: FetchAuth;
  chat(): ChatSession | null;
}

/** Clé de l'instantané d'un compte (un autre compte dans le même onglet ne le reprend pas). */
export function cleSession(u: CompteSession | null | undefined): string {
  const uid = (u && (u.id ?? u.user_id ?? u.username)) || "anon";
  return CLE_SESSION + ":" + String(uid as string);
}

// Même règle de conservation que la persistance : ce que l'instantané perd serait effacé en base au tour suivant.
function aGarder(m: MessageChat): boolean {
  return !!(
    m.role &&
    (m.role === "notice" ||
      m.content ||
      (Array.isArray(m.images) && m.images.length) ||
      (Array.isArray(m.tool_history) && m.tool_history.length) ||
      (m.image_error && typeof m.image_error === "object"))
  );
}

export function creerSessionOnglet(dep: DependancesSessionOnglet) {
  function sauverSession(): void {
    if (!dep.user.value) return;
    const cle = cleSession(dep.user.value);
    try {
      const msgs = dep.messages.value.filter(aGarder);
      if (!msgs.length) {
        sessionStorage.removeItem(cle);
        return;
      }
      const chat = dep.chat();
      const todos = chat?.todoList?.value;
      sessionStorage.setItem(
        cle,
        JSON.stringify({
          chatId: dep.currentChatId.value,
          title: chat?.currentChatTitle ? chat.currentChatTitle.value : "",
          // Bascules d'outils et tâches : la reprise court-circuite loadChat, qui ne les rejoue donc pas.
          tools: chat?.activeToolCats ? chat.activeToolCats() : null,
          todos: Array.isArray(todos) ? todos : [],
          messages: msgs.map((m) => ({
            role: m.role,
            content: m.content,
            images: m.images,
            files: m.files,
            displayContent: m.displayContent,
            thinking: m.thinking,
            isError: m.isError,
            errorMessage: m.errorMessage,
            errorDetail: m.errorDetail,
            errorKind: m.errorKind,
            tool_meta: m.tool_meta,
            _thinkingMs: m._thinkingMs,
            metrics: m.metrics,
            tool_history: m.tool_history,
            tool_history_delta: m.tool_history_delta,
            taskRuns: m.taskRuns,
            isTruncated: m.isTruncated,
            kind: m.kind,
            ts: m.ts,
            round: m.round,
            tokens_after: m.tokens_after,
            summary: m.summary,
            files_changed: m.files_changed,
            rag_sources: m.rag_sources,
            origin: m.origin,
            wake: m.wake,
            ...copyImageFields(m),
          })),
          savedAt: Date.now(),
        }),
      );
    } catch {
      /* stockage plein ou refusé */
    }
  }

  /** Reprise d'un instantané récent (moins d'une heure) quand le fil est vide ; un run encore en cours est rattaché. */
  function restaurerSession(): void {
    const cle = cleSession(dep.user.value);
    try {
      const brut = sessionStorage.getItem(cle);
      if (!brut) return;
      const data = JSON.parse(brut) as {
        chatId?: string | null;
        title?: string;
        tools?: unknown;
        todos?: unknown;
        messages?: MessageChat[];
        savedAt?: number;
      } | null;
      if (!data?.messages?.length) return;
      if (Date.now() - (data.savedAt ?? 0) > DUREE_MAX_MS) {
        sessionStorage.removeItem(cle);
        return;
      }
      if (dep.messages.value.length > 0) return;
      const chat = dep.chat();
      dep.currentChatId.value = data.chatId || null;
      if (chat?.currentChatTitle) chat.currentChatTitle.value = data.title || "";
      // Bascules d'outils avant tout : le panneau ne prend pas l'état vide du démarrage pour un choix à enregistrer.
      try {
        if (Array.isArray(data.tools) && chat?.applyChatTools) chat.applyChatTools(data.tools);
      } catch {
        /* instantané d'une version antérieure */
      }
      // Tâches : une liste entièrement soldée ne réapparaît pas.
      try {
        const td: unknown[] = Array.isArray(data.todos) ? data.todos : [];
        const ouvertes = td.some((t) => {
          const s = t && typeof t === "object" ? (t as { status?: unknown }).status : undefined;
          return !!t && s !== "completed" && s !== "cancelled";
        });
        if (chat?.todoList) chat.todoList.value = ouvertes ? td : [];
      } catch {
        /* tâches illisibles */
      }
      // Vue entrelacée texte/outils reconstruite depuis tool_history, comme au chargement d'un chat.
      let historiquePrecedent: unknown[] | null = null;
      dep.messages.value = data.messages.map((m) => {
        const msg: MessageChat = {
          ...m,
          events: [],
          thinkingOpen: false,
          isStreaming: false,
          isTruncated: !!m.isTruncated,
        };
        // Instantané relu du navigateur : le méta des étapes est revalidé comme au chargement d'un chat.
        const lue = m.role === "assistant" && m.tool_meta ? schemaMetaOutils.safeParse(m.tool_meta) : null;
        const meta = lue?.success ? lue.data : null;
        if (meta) msg.tool_meta = meta;
        else delete msg.tool_meta;
        try {
          if (m.role === "assistant" && Array.isArray(m.tool_history) && m.tool_history.length) {
            const segs = segmentsOutils.parseToolHistorySegments(m.tool_history, {
              prevHistory: historiquePrecedent,
              delta: !!m.tool_history_delta,
              finalContent: (typeof m.content === "string" ? m.content : "") || "",
              meta,
            });
            if (segs?.toolSteps.length) {
              // Étapes reconstruites : même forme que celles du flux (EtapeChat), typées à part par l'analyseur.
              msg.toolSteps = segs.toolSteps as unknown as MessageChat["toolSteps"];
              msg.segTexts = segs.segTexts;
            }
            historiquePrecedent = m.tool_history;
          }
        } catch {
          /* reprise sans segments */
        }
        return msg;
      });
      sessionStorage.removeItem(cle);
      setTimeout(() => {
        void dep.chat()?.scrollToBottom?.(true);
      }, 200);
      // Rechargement pendant un tour : si le run tourne encore, le chat est relu depuis la base pour s'y rattacher.
      const id = data.chatId;
      if (id) void chat?.ragChat?.recharger(id);
      if (id && chat?.loadChat) {
        void dep
          .fetchAuth("/api/chat/" + encodeURIComponent(id) + "/generation-status", {}, true)
          .then((r) => (r?.ok ? (r.json() as Promise<unknown>) : null))
          .then((d) => {
            const enCours =
              !!d && typeof d === "object" && !!(d as { generation_running?: unknown }).generation_running;
            if (enCours && String(dep.currentChatId.value) === String(id))
              void chat.loadChat?.(id, { force: true });
          })
          .catch(() => undefined);
      }
    } catch {
      /* instantané illisible */
    }
  }

  /** Purge l'instantané du compte sortant et la clé historique sans compte. */
  function purgerSession(compte: CompteSession | null | undefined): void {
    try {
      sessionStorage.removeItem(cleSession(compte));
    } catch {
      /* stockage refusé */
    }
    try {
      sessionStorage.removeItem(CLE_SESSION);
    } catch {
      /* stockage refusé */
    }
  }

  /** Retour vers `/oauth/authorize?…` de cette origine une fois connecté (jamais une redirection ouverte). */
  function reprendreOAuth(): boolean {
    if (!dep.user.value) return false;
    let suite: string;
    try {
      suite = new URLSearchParams(window.location.search).get("oauth_next") || "";
    } catch {
      return false;
    }
    if (!suite.startsWith("/oauth/authorize?") || suite.startsWith("//")) return false;
    window.location.replace(suite);
    return true;
  }

  return { sauverSession, restaurerSession, purgerSession, reprendreOAuth };
}
