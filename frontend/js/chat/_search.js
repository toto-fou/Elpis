// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_search.js -- Recherche dans les messages du chat courant
//  + recherche globale dans la liste des chats sauvegardés.
//
//  Extrait de app-chat.js. Comportement identique :
//
//    * messageSearch / messageSearchActive  -- pur state UI lu par le
//      template Vue (la search box dans le header du chat). Aucune
//      logique JS dédiée ici, juste les refs.
//
//    * chatSearch / chatSearchResults / isSearchingChats  -- recherche
//      sur ``/api/saved/chats/search`` avec debounce de 300 ms via
//      ``watch(chatSearch, …)`` interne.
//
//  Le timer de debounce est encapsulé. Le sous-module expose
//  ``cancelPendingSearch()`` que ``_resetStreamingState()`` (côté
//  app-chat.js) appelle quand l'utilisateur stoppe une génération en
//  cours, pour ne pas laisser un fetch search orphelin.
//
//  Dépendances injectées :
//    * ctx.fetchAuth -- helper HTTP authentifié
//
//  Exporte :
//    * messageSearch, messageSearchActive  (refs UI)
//    * chatSearch, chatSearchResults, isSearchingChats  (refs)
//    * searchOpen, chatSearchRef, openChatSearch(), closeChatSearch()
//      -- repli/déploiement du champ de recherche dans la sidebar
//    * cancelPendingSearch()
// ============================================================

function setupChatSearch(vue, sharedRefs, ctx) {
    const { ref, watch, nextTick } = vue;
    const { fetchAuth }  = ctx;

    // ── State UI ──────────────────────────────────────────────────
    // Lus par le template Vue (header du chat — search box).
    const messageSearch       = ref('');
    const messageSearchActive = ref(false);

    // Miroir DEBOUNCÉ de messageSearch pour tout ce qui RE-REND les messages
    // (AUDIT 2026-08-31). La valeur brute figurait dans le v-memo des lignes :
    // chaque FRAPPE réécrivait l'innerHTML de toutes les lignes visibles
    // (renderMarkdownHighlight non mémoïsé × ~30) et détruisait le DOM enrichi
    // après coup (Chart.js, Mermaid, boutons Copier) — re-posé par le watch
    // d'app-chat.js sur ce miroir. Le champ, lui, reste lié à messageSearch :
    // la saisie ne perd rien ; le surlignage suit après une courte pause.
    // L'EFFACEMENT est immédiat (fermer/vider ne doit pas laisser 250 ms de
    // surlignage périmé).
    const messageSearchQ = ref('');
    let _msgSearchTimer = null;
    watch(messageSearch, val => {
        clearTimeout(_msgSearchTimer);
        const v = (val == null) ? '' : String(val);
        if (!v.trim()) { messageSearchQ.value = ''; return; }
        _msgSearchTimer = setTimeout(() => { messageSearchQ.value = v; }, 250);
    });
    watch(messageSearchActive, act => {
        if (!act) { clearTimeout(_msgSearchTimer); messageSearchQ.value = ''; }
    });

    // Réinitialise la recherche IN-MESSAGE (barre de surlignage). Appelée au
    // changement de conversation (startNewChat / loadChat) : sans ça, la barre
    // restait ouverte avec l'ANCIENNE requête → les messages du NOUVEAU chat ne
    // contenant pas la requête étaient grisés (opacity-25) et faussement
    // surlignés. (Avant, _history.js dépendait d'un ``resetMessageSearch``
    // jamais fourni → no-op permanent.)
    function resetMessageSearch() {
        messageSearch.value = '';
        messageSearchActive.value = false;
    }

    // ── State pour la recherche globale dans la liste des chats ──
    const chatSearch          = ref('');
    const chatSearchResults   = ref([]);
    const isSearchingChats    = ref(false);

    // ── Révélation du champ de recherche (à la ChatGPT) ─────────────
    // Dans la sidebar, « Rechercher » est une ligne de menu repliée par
    // défaut (cohérente avec « Nouveau Chat » / « Skills »). Un clic
    // déplie + focus un champ inline ; Échap ou ✕ le replie. Replier vide
    // ``chatSearch`` → le watch ci-dessous efface les résultats et éteint
    // le spinner. État UI pur, aucune incidence sur le debounce.
    const searchOpen    = ref(false);
    const chatSearchRef = ref(null);   // <input> el, pour l'autofocus

    function openChatSearch() {
        searchOpen.value = true;
        nextTick(() => { if (chatSearchRef.value) chatSearchRef.value.focus(); });
    }

    function closeChatSearch() {
        chatSearch.value = '';   // → le watch vide les résultats
        searchOpen.value = false;
    }

    // Timer de debounce (300 ms) — encapsulé.
    let _chatSearchTimer = null;
    // compteur de séquence : une requête de recherche lente pour
    // une vieille requête peut résoudre APRÈS une requête rapide pour la
    // requête plus récente → résultats périmés affichés. On n'applique le
    // résultat (et on n'éteint le spinner) que pour la dernière requête
    // émise. ``cancelPendingSearch`` et le branchement « requête vide »
    // incrémentent aussi le compteur pour invalider tout fetch en vol.
    let _chatSearchSeq = 0;

    watch(chatSearch, val => {
        clearTimeout(_chatSearchTimer);
        // val peut être null/undefined si une autre route remet la
        // ref à null (vu en pratique au logout). .trim() sur null crashe.
        if (!val || !String(val).trim()) {
            _chatSearchSeq++;  // invalide tout fetch en vol
            chatSearchResults.value = [];
            isSearchingChats.value  = false;
            return;
        }
        isSearchingChats.value = true;
        _chatSearchTimer = setTimeout(async () => {
            const _seq = ++_chatSearchSeq;
            try {
                const res = await fetchAuth(
                    '/api/saved/chats/search?q=' + encodeURIComponent(val),
                    {}, true
                );
                if (res && res.ok) {
                    const data = await res.json();
                    // Une recherche plus récente a-t-elle été lancée pendant
                    // que celle-ci était en vol ? Si oui, on jette ce résultat.
                    if (_seq !== _chatSearchSeq) return;
                    chatSearchResults.value = data.items || [];
                }
            } catch (e) {
                /* non-fatal — search reste vide */
            } finally {
                // Seule la dernière requête éteint le spinner.
                if (_seq === _chatSearchSeq) isSearchingChats.value = false;
            }
        }, 300);
    });

    function cancelPendingSearch() {
        if (_chatSearchTimer) {
            clearTimeout(_chatSearchTimer);
            _chatSearchTimer = null;
        }
        // Invalide aussi toute requête déjà en vol : son résultat ne doit
        // plus être appliqué (sinon il écraserait l'état courant).
        _chatSearchSeq++;
        // (passe 6, F11) — la requête invalidée ne passera plus par son
        // finally (``_seq !== _chatSearchSeq``) : le spinner restait allumé.
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

window.setupChatSearch = setupChatSearch;
