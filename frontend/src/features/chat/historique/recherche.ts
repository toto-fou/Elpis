// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/historique/recherche.ts — recherche dans la conversation (surlignage différé) et dans l'historique des chats (requête différée, seule la dernière s'applique). */
import type * as Vue from "vue";
import type { Ref } from "vue";

export type FetchAuth = (
  url: string,
  options?: Record<string, unknown>,
  soft?: boolean,
) => Promise<Response | null>;

export interface ResultatRecherche {
  id?: string;
  title?: string;
  [cle: string]: unknown;
}

export interface RechercheChat {
  messageSearch: Ref<string>;
  messageSearchActive: Ref<boolean>;
  messageSearchQ: Ref<string>;
  resetMessageSearch(): void;
  chatSearch: Ref<string | null>;
  chatSearchResults: Ref<ResultatRecherche[]>;
  isSearchingChats: Ref<boolean>;
  searchOpen: Ref<boolean>;
  chatSearchRef: Ref<HTMLInputElement | null>;
  openChatSearch(): void;
  closeChatSearch(): void;
  cancelPendingSearch(): void;
}

/** Ce que les fabriques portées reçoivent de Vue (l'instance unique du pont, aussi la doublure du harnais Node). */
export type VueFabrique = Pick<typeof Vue, "ref" | "watch" | "nextTick">;

export const DELAI_SURLIGNAGE_MS = 250;
export const DELAI_RECHERCHE_MS = 300;

function lireResultats(corps: unknown): ResultatRecherche[] {
  const items = corps && typeof corps === "object" ? (corps as { items?: unknown }).items : null;
  return Array.isArray(items)
    ? items.filter((x): x is ResultatRecherche => !!x && typeof x === "object")
    : [];
}

/** Même contrat que l'ancien `setupChatSearch(vue, refs, { fetchAuth })` de chat/_search.js. */
export function creerRechercheChat(
  vue: VueFabrique,
  _refs: unknown,
  ctx: { fetchAuth: FetchAuth },
): RechercheChat {
  const { ref, watch, nextTick } = vue;
  const { fetchAuth } = ctx;
  const messageSearch = ref("");
  const messageSearchActive = ref(false);
  // Miroir différé de la saisie : seul lui re-rend les lignes ; l'effacement est immédiat.
  const messageSearchQ = ref("");
  let minuteurSurlignage: ReturnType<typeof setTimeout> | undefined;
  watch(messageSearch, (val) => {
    clearTimeout(minuteurSurlignage);
    const v = val == null ? "" : String(val);
    if (!v.trim()) {
      messageSearchQ.value = "";
      return;
    }
    minuteurSurlignage = setTimeout(() => {
      messageSearchQ.value = v;
    }, DELAI_SURLIGNAGE_MS);
  });
  watch(messageSearchActive, (actif) => {
    if (actif) return;
    clearTimeout(minuteurSurlignage);
    messageSearchQ.value = "";
  });

  function resetMessageSearch(): void {
    messageSearch.value = "";
    messageSearchActive.value = false;
  }

  const chatSearch = ref<string | null>("");
  const chatSearchResults = ref<ResultatRecherche[]>([]);
  const isSearchingChats = ref(false);
  const searchOpen = ref(false);
  const chatSearchRef = ref<HTMLInputElement | null>(null);

  function openChatSearch(): void {
    searchOpen.value = true;
    void nextTick(() => chatSearchRef.value?.focus());
  }

  function closeChatSearch(): void {
    chatSearch.value = "";
    searchOpen.value = false;
  }

  let minuteurRecherche: ReturnType<typeof setTimeout> | null = null;
  // Jeton : une réponse lente d'une requête dépassée n'écrit rien et n'éteint pas l'indicateur.
  let sequence = 0;

  async function chercher(q: string, seq: number): Promise<void> {
    try {
      const res = await fetchAuth("/api/saved/chats/search?q=" + encodeURIComponent(q), {}, true);
      if (res && res.ok) {
        const corps: unknown = await res.json();
        if (seq === sequence) chatSearchResults.value = lireResultats(corps);
      }
    } catch {
      /* recherche non fatale : la liste reste vide */
    } finally {
      if (seq === sequence) isSearchingChats.value = false;
    }
  }

  watch(chatSearch, (val) => {
    if (minuteurRecherche) clearTimeout(minuteurRecherche);
    minuteurRecherche = null;
    if (!val || !String(val).trim()) {
      sequence++;
      chatSearchResults.value = [];
      isSearchingChats.value = false;
      return;
    }
    isSearchingChats.value = true;
    minuteurRecherche = setTimeout(() => {
      minuteurRecherche = null;
      void chercher(String(val), ++sequence);
    }, DELAI_RECHERCHE_MS);
  });

  function cancelPendingSearch(): void {
    if (minuteurRecherche) clearTimeout(minuteurRecherche);
    minuteurRecherche = null;
    sequence++;
    isSearchingChats.value = false;
  }

  return {
    messageSearch,
    messageSearchActive,
    messageSearchQ,
    resetMessageSearch,
    chatSearch,
    chatSearchResults,
    isSearchingChats,
    searchOpen,
    chatSearchRef,
    openChatSearch,
    closeChatSearch,
    cancelPendingSearch,
  };
}
