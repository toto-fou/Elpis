// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/historique/recherche.ts — recherche dans la conversation (surlignage différé) et dans l'historique des chats (titres du volet filtrés aussitôt, requête différée qui les complète, seule la dernière s'applique). */
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

type LigneTrouvee = { readonly id?: unknown; readonly title?: unknown };

/** Titre qui contient la saisie, casse ignorée (la recherche du serveur porte sur les titres). */
export function titreCorrespond(titre: unknown, saisie: string): boolean {
  const q = saisie.trim().toLocaleLowerCase();
  const t = String(titre ?? "").toLocaleLowerCase();
  return !!q && t.includes(q);
}

/** Résultats affichés : titres du volet d'abord, dans leur ordre, puis ceux que le serveur ajoute à la suite. */
export function fusionnerResultats<C extends LigneTrouvee, S extends LigneTrouvee>(
  saisie: string,
  connus: readonly C[],
  serveur: readonly S[],
): (C | S)[] {
  const out: (C | S)[] = connus.filter((c) => titreCorrespond(c.title, saisie));
  const vus = new Set(out.map((c) => String(c.id)));
  for (const r of serveur) {
    if (vus.has(String(r.id))) continue;
    vus.add(String(r.id));
    out.push(r);
  }
  return out;
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
      /* recherche non fatale : les résultats affichés restent */
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
    // Réponse précédente gardée pour ce qui correspond encore : rien ne clignote entre deux frappes.
    const gardes = chatSearchResults.value.filter((r) => titreCorrespond(r.title, String(val)));
    if (gardes.length !== chatSearchResults.value.length) chatSearchResults.value = gardes;
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
