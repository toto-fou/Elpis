// SPDX-License-Identifier: MIT
// ============================================================
//  app-chat.js  -- Chat module  (production-ready)
//
//  New features vs original:
//   1. @fichier mention
//      • Type @ in the textarea → dropdown of sandbox files
//      • Arrow keys + Enter to select, Escape to dismiss
//      • File content injected as attachedFile chip (reuses
//        the existing --- FILE: --- injection pipeline)
//      • Works even when the editor panel is closed
//
//   2. Streaming robustness
//      • Auto-reconnect on network drop (up to 2 silent retries
//        with 1.5s / 3s back-off, not on AbortError or 401)
//      • stopGeneration() now marks the message isTruncated
//        and flushes the remaining buffer properly
//      • continueGeneration(): sends the partial assistant
//        message as context so the LLM continues seamlessly
//      • statusText shows retry progress to the user
// ============================================================

function setupChat(vue, sharedRefs, ctx) {
    const { ref, computed, watch, nextTick } = vue;
    const {
        user, settings, config, messages, currentChatId,
        inputMessage, inputRef, isStreaming,
        currentView, isAdminView, isUserScrolling,
    } = sharedRefs;
    const { showToast, fetchAuth, openConfirm, openPrompt } = ctx;

    // -- Contexte proche du maximum -------------------------------
    // Le clamp en nombre de messages (LLAMA_MAX_MSGS) est RETIRÉ : tout
    // l'historique part au modèle, la seule borne est la fenêtre de
    // contexte. La bannière se base donc sur l'occupation RÉELLE mesurée
    // par le serveur (event kv_cache de fin de requête), par chat : à
    // partir de 90 %, on invite à compacter ou repartir à neuf. Remise à
    // zéro au switch de chat et après une compaction (comme la jauge).
    const CTX_NEAR_MAX_PCT = 90;
    // Fin de tour de l'assistant : les onglets ouverts sont revérifiés
    // (commandes shell, git, écritures hors flux — E8).
    watch(isStreaming, (v, old) => {
        if (old && !v && ctx.checkExternalModsSoon) ctx.checkExternalModsSoon(500);
    });
    const ctxRealPct = ref(0);
    // Occupation RÉELLE du contexte du chat courant ({used, total, pct}) :
    // dernier event kv_cache du tour, OU la valeur PERSISTÉE en base
    // (meta_json["ctx_usage"], re-semée par loadChat). C'est la source de la
    // puce « ctx » au repos sous le composeur : après un rechargement ou un
    // redémarrage, l'utilisateur voit l'occupation réelle avant de reprendre.
    // Remise à null au changement de chat et après une compaction (la mesure
    // décrit alors un historique qui n'existe plus).
    const ctxUsage = ref(null);

    // Libellé du bandeau « boucle d'outils stoppée » selon la cause réelle de
    // l'arrêt (metrics.tool_limit_stop_reason). Avant, tout arrêt affichait
    // « Limite d'itérations atteinte · 200/200 tours » — y compris un run
    // coupé par le mur d'horloge ou par des appels tronqués, dont le compteur
    // était forcé au budget pour sortir de la boucle.
    const _TOOL_LIMIT_LABELS = {
        steps:         'Budget de tours atteint',
        hard:          'Trop d\'appels d\'outils en échec',
        wallclock:     'Budget de temps atteint',
        ctx_saturated: 'Contexte saturé',
        gen_cap:       'Appels d\'outils trop longs',
        cycle:         'Boucle d\'action détectée',
        empty_choices: 'Réponses vides du moteur',
    };
    function toolLimitLabel(stats) {
        const k = stats && stats.stop_reason;
        return (k && _TOOL_LIMIT_LABELS[k]) || 'Limite d\'itérations atteinte';
    }
    const conversationTooLong = computed(
        () => ctxRealPct.value >= CTX_NEAR_MAX_PCT
    );

    // -- Core chat state ------------------------------------------
    const chats               = ref([]);
    const currentChatTitle    = ref('');
    // Flash visuel de renommage (titre auto-généré par le modèle au 1er
    // tour) : classe .elpis-title-flash posée ~1,6 s sur le titre du header
    // (ref) et l'entrée sidebar (flag _renamed sur l'objet chat).
    const titleFlash          = ref(false);
    let   _titleFlashTimer    = null;
    function _flashRenamedTitle(entry) {
        titleFlash.value = true;
        if (_titleFlashTimer) clearTimeout(_titleFlashTimer);
        _titleFlashTimer = setTimeout(() => { titleFlash.value = false; }, 1600);
        if (entry) {
            entry._renamed = true;
            setTimeout(() => { try { entry._renamed = false; } catch (_) {} }, 1600);
        }
    }
    const chatContainer       = ref(null);
    const isThinking          = ref(false);
    const statusText          = ref('');
    // UX file d'attente — alimenté par les events SSE "queue_status" /
    // "queue_cleared" émis par le backend au début du chat si un switch
    // de modèle est nécessaire ou si les slots sont saturés. null = pas
    // de widget affiché (cas nominal). Dict = widget visible avec les
    // infos (kind, model, position, est_ms, ...).
    const queueStatus         = ref(null);
    // Todo-list de session (outil ``todowrite``, sémantique replace-all) :
    // event NDJSON ``todo_updated`` en live + seed depuis le chat chargé
    // (meta_json["todos"]). [] = pas de panneau. todoPanelOpen = pli/dépli.
    const todoList            = ref([]);
    // Panneau PLIÉ par défaut, et AUCUN dépliage automatique : seul
    // l'utilisateur déplie. Le REPLI, lui, peut être automatique : switch
    // de chat / nouvelle liste (seed), et fin de tour avec des tâches
    // encore ouvertes (le panneau déplié ne doit pas rester à masquer le
    // chat entre deux tours — l'en-tête N/M reste visible, replié).
    const todoPanelOpen       = ref(false);
    // Vrai si AU MOINS un todo_updated est arrivé pendant le tour courant
    // (remis à false au départ de chaque génération). Discrimine, en fin
    // de tour avec des tâches ouvertes, une liste EN COURS (touchée →
    // repli, elle resservira au tour suivant) d'une liste ABANDONNÉE
    // (ignorée tout le tour → le panneau disparaît ; la liste reste dans
    // meta_json côté serveur, un rechargement du chat la ré-affiche).
    let _todoTouchedThisTurn  = false;
    function _seedTodoList(t) {
        todoList.value = Array.isArray(t) ? t : [];
        todoPanelOpen.value = false;
    }
    // Hauteur RÉELLE de la colonne du composeur (barre de prompt + widgets
    // empilés au-dessus : panneau todo, file d'attente, bannières…). La
    // colonne est absolue ancrée en bas et RECOUVRE le chat : un spacer
    // statique (h-32) et un bouton « descendre » à offset fixe (bottom-36)
    // passaient DESSOUS dès qu'un widget s'empilait. Le spacer de fin de
    // chat et le bouton se calent désormais sur cette mesure (computeds
    // ci-dessous), pour tous les widgets présents et futurs.
    const composeColRef  = ref(null);
    const composerHeight = ref(0);
    let _composeRO = null;
    watch(composeColRef, (el) => {
        if (_composeRO) { _composeRO.disconnect(); _composeRO = null; }
        if (!el) { composerHeight.value = 0; return; }
        if (typeof ResizeObserver !== 'undefined') {
            _composeRO = new ResizeObserver(() => {
                composerHeight.value = el.offsetHeight || 0;
            });
            _composeRO.observe(el);
        }
        composerHeight.value = el.offsetHeight || 0;
    });
    // Colonne ancrée à bottom-6 (24px). Spacer = hauteur + ancre + marge de
    // lecture ; bouton « descendre » = 12px au-dessus du bord haut de la
    // colonne. Les planchers reproduisent les anciennes valeurs statiques
    // (h-32 = 128px, bottom-36 = 144px) tant que rien n'est mesuré.
    const chatBottomPad   = computed(() => Math.max(128, (composerHeight.value || 0) + 40));
    const scrollBtnBottom = computed(() => Math.max(144, (composerHeight.value || 0) + 36));
    // État séparé pour la compression conversationnelle. Historiquement
    // partagé avec queueStatus (kind='compressing'), ce qui créait de la
    // confusion visuelle : "j'attends un slot" et "le backend résume" se
    // ressemblaient. Séparation claire :
    //   - queueStatus       : file d'attente de slot LLM (widget teal
    //     au-dessus du composer, passe 9).
    //   - compressionStatus : condensation backend en cours. Depuis la
    //     passe 11, la compression est RENDUE INLINE dans le message
    //     assistant courant comme un pseudo tool-step (_kind='compression'
    //     dans toolSteps), pas comme un widget séparé. La ref garde deux
    //     rôles techniques : flag "compression in flight" pour le tick
    //     timer, et mémorisation de msg_idx pour retrouver le step à
    //     clôturer quand compression_done arrive.
    const compressionStatus   = ref(null);
    // Barre de progression reactive (0-100). Alimentée par un tick timer
    // qui asymptote à 95 % avec une courbe exponentielle pendant la
    // compression, puis saute à 100 % quand compression_done fire.
    // Évite deux bugs visuels :
    //   - linéaire plein avant la fin (l'utilisateur pense "c'est fini" et ça ne l'est pas)
    //   - plus aucune indication de progression après plafond atteint
    const compressionProgress = ref(0);
    // Cap de compressions atteint pour la conversation COURANTE (event
    // ``compression_capped`` {round, max}) : badge discret près de la jauge
    // + bouton de compression manuelle désactivé. Null = pas au cap.
    // Reset au switch de conversation (loadChat / nouveau chat).
    const compressionCapped   = ref(null);

    // Libellé FR d'une compression tentée mais non appliquée (step 'skipped').
    function _comprSkipLabel(reason) {
        const r = String(reason || '');
        const map = {
            no_token_gain:          'Sans gain — annulée',
            summary_invalid_format: 'Résumé invalide — annulée',
            summary_too_short:      'Résumé trop court — annulée',
            nothing_to_compress:    'Rien à compresser',
            // Gardes qui court-circuitent AVANT l'appel LLM — libellés explicites
            // pour que « rien ne s'est passé » ait une raison claire.
            disabled:               'Compression désactivée (réglage admin)',
            max_rounds_reached:     'Maximum de compressions atteint',
            threshold_not_reached:  'Contexte encore trop court',
            gain_too_small:         'Trop peu à compacter — reportée',
            persist_failed:         'Échec d\'enregistrement — réessaie',
        };
        if (map[r]) return map[r];
        if (r.startsWith('llm_error'))  return 'Erreur du modèle de compression';
        if (r.startsWith('exception'))  return 'Erreur interne — annulée';
        return 'Non appliquée';
    }

    // ── Compression MANUELLE (bouton près de la jauge, hors génération) ──
    // GET /api/chat/{id}/compression-state au switch de chat + après chaque
    // 'final' + après le POST manuel. Payload : {round, max, can_compress,
    // reason, turns, tokens_estimate, estimated}.
    const compressionState   = ref(null);
    const manualCompressBusy  = ref(false);
    // Ligne DANS LE CHAT (commande /compact) : remplace l'ancienne barre de
    // progression « estimée » (fausse). {state:'running'|'ok'|'skip', chatId,
    // saved?, reason?} — rendue en fin de flux de messages, scopée au chat
    // qui a lancé la compaction (F18), auto-effacée après le résultat.
    const compactionNotice = ref(null);
    let _compactionTimer = null;
    // Horodatage court d'une notice persistée (« 12/07 22:41 ») — répond au
    // besoin « savoir QUAND la conversation a été compactée ».
    function fmtNoticeTs(ts) {
        if (!ts) return '';
        try {
            return new Date(ts * 1000).toLocaleString('fr-FR', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
            });
        } catch (_) { return ''; }
    }
    // F18 — id du chat dont la compression manuelle est EN COURS (null sinon).
    const manualCompressChatId = ref(null);

    async function refreshCompressionState() {
        const id = currentChatId.value;
        if (!id) { compressionState.value = null; compressionCapped.value = null; return; }
        try {
            const res = await fetchAuth('/api/chat/' + encodeURIComponent(id) + '/compression-state', {}, true);
            // Réponse d'un chat quitté entre-temps : on l'ignore.
            if (String(currentChatId.value) !== String(id)) return;
            if (res && res.ok) {
                const d = await res.json();
                compressionState.value = d;
                compressionCapped.value = (d && d.reason === 'max_reached')
                    ? { round: d.round, max: d.max } : null;
            } else {
                // 404 = chat pas encore persisté (nouveau chat) → pas de bouton.
                compressionState.value = null;
                compressionCapped.value = null;
            }
        } catch (_) { /* non-fatal : le bouton reste dans son dernier état */ }
    }

    async function manualCompress() {
        const id = currentChatId.value;
        if (!id) { showToast('Rien à compacter pour l’instant', 'info'); return; }
        if (manualCompressBusy.value) return;
        manualCompressBusy.value = true;
        // F18 — SCOPE la compression au chat qui la lance : si l'utilisateur
        // change de chat pendant le POST (bloquant), le nouveau chat ne doit
        // pas afficher la ligne de compaction du chat précédent (la ligne
        // porte le chatId et n'est rendue que dessus).
        manualCompressChatId.value = id;
        const _t0 = Date.now();
        if (_compactionTimer) { clearTimeout(_compactionTimer); _compactionTimer = null; }
        // Progression PILOTÉE PAR JS (pct + barre en largeur inline) : sous
        // prefers-reduced-motion — le cas de l'OS du user — les spinners CSS
        // sont neutralisés (animation:none), la ligne semblait figée. Courbe
        // 2 phases (idiome _startCompressionTick) : 0→70 % sur la durée
        // médiane estimée, puis rampe lente vers 88 % (jamais 100 % avant la
        // réponse — pas de fausse promesse).
        let _estMs = 10000;
        try { _estMs = _estimateCompressionMs('self') || 10000; } catch (_) {}
        compactionNotice.value = { state: 'running', chatId: id, pct: 0 };
        const _pctT0 = Date.now();
        const _pctTimer = setInterval(() => {
            const cn = compactionNotice.value;
            if (!cn || cn.state !== 'running' || cn.chatId !== id) { clearInterval(_pctTimer); return; }
            const el = Date.now() - _pctT0;
            const pct = el <= _estMs
                ? Math.round((el / _estMs) * 70)
                : Math.min(88, 70 + Math.round(((el - _estMs) / _estMs) * 18));
            compactionNotice.value = { ...cn, pct };
        }, 350);
        nextTick(() => { try { scrollToBottom(); } catch (_) {} });
        // Succès → la ligne éphémère disparaît, remplacée par un MESSAGE
        // ``notice`` PERSISTANT poussé dans le fil (le backend a ajouté le
        // même marqueur à messages_json : reload-proof). Échec → la ligne
        // éphémère affiche la raison puis s'efface.
        const _flash = (v) => {
            clearInterval(_pctTimer);
            if (v.ok) {
                compactionNotice.value = null;
                if (currentChatId.value === id) {
                    messages.value.push(Object.freeze({
                        role: 'notice', kind: 'compaction',
                        ts: Date.now() / 1000,
                        tokens_after: v.after || 0,
                        // Copie du résumé produit → accordéon « Vérifier le
                        // compact » (le backend a persisté la même copie dans
                        // le notice de messages_json : reload-proof).
                        summary: v.summary || '',
                        content: '',
                    }));
                    nextTick(() => { try { scrollToBottom(); } catch (_) {} });
                }
            } else {
                compactionNotice.value = { state: 'skip', chatId: id,
                                           reason: v.reason || 'Échec de la compression' };
            }
        };
        try {
            // Envoie le MODÈLE COURANT du chat : sans lui, la route retombe sur
            // le défaut LLAMA_MODEL (placeholder routeur type « RAG ») → 400
            // llama-server → « Erreur du modèle de compression ».
            const res = await fetchAuth('/api/chat/' + encodeURIComponent(id) + '/compress',
                                        { method: 'POST',
                                          headers: { 'Content-Type': 'application/json' },
                                          // + le SERVEUR choisi (M5, 2026-09-16) : sans
                                          // lui, l'intégré résumait un chat mené ailleurs.
                                          body: JSON.stringify({ model: selectedModel.value || null,
                                                                 connector_id: selectedConnector.value || null }) },
                                        true);
            const d = res ? await res.json().catch(() => null) : null;
            if (res && res.ok && d && d.compressed) {
                // Alimente l'estimateur pour la prochaine fois (durée réelle, par path).
                try { _recordCompressionDuration((d.stats && d.stats.path) || 'self', Date.now() - _t0); } catch (_) {}
                const _st = d.stats || {};
                if (currentChatId.value === id) {
                    // Jauge ctx : on INVALIDE la dernière valeur réelle (elle
                    // décrit l'historique d'avant compression). Pas de re-seed
                    // estimé : la jauge repart masquée et se recale sur le réel
                    // au premier event kv_cache de la prochaine génération.
                    _lastCtxUsed = 0;
                    ctxRealPct.value = 0;
                    ctxUsage.value = null;
                }
                // ok:true → le flash de SUCCÈS s'affiche même si tokens_saved=0
                // (compression appliquée mais gain nul), avant→après pour preuve.
                // ``total`` = n_ctx du modèle → mini-jauge visible qui montre le
                // contexte BAISSER tout de suite (réponse directe à « voir la
                // jauge ctx baisser » sans avoir à regénérer). ``after`` est
                // l'historique compressé (≈, hors system/tools) → flag est:true.
                let _tot = 0; try { _tot = _getCtxSize() || 0; } catch (_) {}
                const _pct = (_tot > 0 && _st.tokens_after > 0)
                    ? Math.min(100, Math.round(_st.tokens_after / _tot * 100)) : 0;
                _flash({ ok: true, saved: _st.tokens_saved || 0,
                         before: _st.tokens_before, after: _st.tokens_after,
                         total: _tot, pct: _pct, summary: _st.summary_xml || '' });
            } else if (res && res.status === 409) {
                const _r = String(d && (d.detail || d.reason || d.error) || '');
                _flash({
                    reason: _r.includes('generation') ? 'Génération en cours — réessaie après'
                          : _r.includes('chat_modified') ? 'Le chat a changé — réessaie'
                          : 'Compression déjà en cours',
                });
            } else if (d && d.reason) {
                _flash({ reason: _comprSkipLabel(d.reason) });
            } else {
                _flash({ reason: 'Échec de la compression' });
            }
        } catch (_) {
            _flash({ reason: 'Échec de la compression' });
        } finally {
            manualCompressBusy.value = false;
            manualCompressChatId.value = null;
            // Seul l'ÉCHEC reste éphémère (le succès est un message notice
            // persistant dans le fil) : raison lisible 6 s puis effacement.
            if (compactionNotice.value && compactionNotice.value.state === 'skip') {
                _compactionTimer = setTimeout(() => { compactionNotice.value = null; }, 6000);
            }
            // Ne rafraîchit l'état de compression que si on est resté sur ce chat
            // (sinon on écraserait l'état du chat courant avec celui de l'ancien).
            if (currentChatId.value === id) refreshCompressionState();
        }
    }

    // Switch de conversation (loadChat, nouveau chat, deep-link) : reset
    // immédiat du badge cap + re-fetch de l'état pour le nouveau chat.
    watch(currentChatId, (nouveau, ancien) => {
        // La voix suit la conversation affichée : une réponse qui continue de
        // se lire après un changement de chat parle d'un contexte qui n'est
        // plus à l'écran, et la dictée viserait un brouillon qui n'existe plus.
        //
        // ⚠ MAIS passer de « pas encore d'id » à l'id que le serveur vient
        // d'attribuer n'est PAS un changement de conversation : c'est le même
        // fil, qui vient de naître à l'envoi du premier message. Couper la voix
        // là-dessus arrêtait le micro juste après cet envoi — exactement au
        // moment où l'on enchaîne sur le message suivant, et cela mettait
        // ``segmenteur`` à null AU MILIEU du premier tour : toute la première
        // réponse d'une conversation neuve restait muette.
        if (ancien) { try { cancelVoice(); } catch (_) {} }
        compressionCapped.value = null;
        compressionState.value = null;
        // La ligne de compaction du chat quitté est scopée par chatId (elle ne
        // se rend pas ailleurs) ; la compression continue côté serveur et son
        // résultat reste gardé par l'id (cf. manualCompress).
        // F19 — remet à 0 le contexte live HÉRITÉ : sans ça, _seedLiveCtx du
        // 1er message d'un (petit) chat repartait de _lastCtxUsed du chat
        // PRÉCÉDENT (p.ex. « 45k / 128k ») jusqu'au premier event kv_cache réel.
        _lastCtxUsed = 0;
        ctxRealPct.value = 0;
        ctxUsage.value = null;   // re-semé par applyChatCtxUsage (loadChat)
        refreshCompressionState();
    });

    // ── Historique des durées de compression + tickers de progression ──
    // Implémentation extraite dans static/js/chat/_compression_ui.js.
    // Les noms exposés ci-dessous sont identiques à ceux qu'utilisaient
    // les définitions inline. ``_getStreamMsgs`` et ``_patch`` sont des
    // function declarations donc hoistées au top du scope ; les passer
    // ici est sûr même si elles sont définies plus bas dans la source.
    const _compressionMod = window.setupChatCompressionUI(
        vue,
        { compressionStatus, compressionProgress },
        { _getStreamMsgs, _patch }
    );
    const {
        _readCompressionHistory,
        _recordCompressionDuration,
        _estimateCompressionMs,
        _startCompressionTick,
        _stopCompressionTick,
    } = _compressionMod;

    const abortController     = ref(null);
    const pendingWrite        = ref(null);

    // -- Search (extracted to chat/_search.js) -----------------------
    // Refs exposées + recherche globale debouncée (300 ms) + helper de
    // cleanup ``cancelPendingSearch`` appelé par ``_resetStreamingState``
    // pour ne pas laisser un fetch search en attente après un stop.
    const _searchMod = window.setupChatSearch(vue, {}, { fetchAuth });
    const {
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
        cancelPendingSearch: _cancelPendingChatSearch,
    } = _searchMod;

    const showChatMenu        = ref(false);
    // editingMessageIndex / editMessageText sont créés par
    // chat/_message_edit.js (appelé plus bas).
    const attachedFiles       = ref([]);
    // ── MCP local categories (DYNAMIC) ─────────────────────────────────
    // Used to be a hardcoded ref({fs:false,git:false,shell:false,
    // browser:false,chart:false}). Now sourced from the backend registry
    // via GET /api/mcp/categories. The keys of localTools.value are the
    // category names returned by that endpoint, so adding a new tool
    // module in tools/*.py makes a new toggle appear here automatically
    // after the next app reload (the backend AST-discovers it on boot).
    //
    // mcpUserCategories: full descriptors {name,label,icon,color,visible}
    //                    used by panel_mcp.html for the v-for loop.
    // localTools.value:  {[catName]: bool} — the active state per category.
    //                    consumed by activeCategories computation in
    //                    sendMessage() (search 'activeCategories' in this
    //                    file). Keys MUST match cat.name.
    const localTools          = ref({});
    const mcpUserCategories   = ref([]);
    const showMcpPanel        = ref(false);
    // (2026-09-11) Serveurs DÉCLARÉS dans ``mcp.json`` (rôle externe) :
    // proposés dans le panneau Outils, état per-chat ``mf:<nom>`` (même canal
    // que les externes ``ext:<id>``). Le navigateur n'envoie que le NOM.
    const manifestServers     = ref([]);
    const manifestTools       = ref({});
    // (2026-09-12) Sélection des outils UN PAR UN, sous chaque catégorie.
    // On mémorise les EXCLUSIONS, pas les inclusions : « tout coché » est un
    // objet VIDE, donc un chat d'avant la feature garde exactement ses outils
    // et aucune migration n'est nécessaire. Les catégories restent le maître :
    // sous une catégorie éteinte, les exclusions sont IGNORÉES — ni envoyées,
    // ni persistées ; elles ne survivent pas au rechargement.
    const excludedTools       = ref({});   // {[nomOutil]: true} = retiré du tour
    const openToolCats        = ref({});   // {[nomCategorie]: true} = déplié

    // Mode lecture seule de la conversation (commande « /plan »). Persisté
    // par chat dans meta_json, comme les catégories d'outils — le serveur
    // est AUTORITÉ : la route de streaming relit meta_json, elle ne se fie
    // pas à un champ du corps de requête. Ce ref n'est donc qu'un miroir
    // d'affichage (pastille) et l'état de départ de la bascule.
    const planMode            = ref(false);

    // Serveurs MCP externes affichables par ce compte = ses serveurs perso
    // visibles + la bibliothèque PARTAGÉE (admin) qu'il a cochée. La liste est
    // construite par le module Paramètres ; on la lit via ctx pour n'avoir
    // qu'UNE définition de « ce qui est affichable » (panneau, envoi au
    // backend, restauration per-chat). Repli sur la liste perso si le module
    // Paramètres n'est pas monté (mode admin réduit).
    function _pinnedServers() {
        try {
            const p = ctx.pinnedServers;
            if (p && Array.isArray(p.value)) return p.value;
        } catch (e) { /* module absent */ }
        return ((settings.value && settings.value.mcp_servers) || []).filter(s => s && s.visible);
    }
    const showRagPanel        = ref(false);
    // -- Composer "+" mini-menu (UX option 4 cleanup) ------------------
    // Petite popover qui regroupe les actions secondaires du composer
    // (aujourd'hui : Partages reçus -- bell remplacée par "+"). Ouvre
    // au-dessus du composer, ferme sur Escape ou click-outside via
    // onGlobalClick (app.js). Le badge inboxCount s'affiche sur le "+"
    // pour préserver le signal de notification quand le menu est fermé.
    const showComposerPlus    = ref(false);
    const composerPlusRef     = ref(null);                 // pour click-outside
    const ragDropdownRef      = ref(null);
    const ragCollections      = ref([]);
    const availableModels     = ref([]);
    const activeModelIds      = ref([]); // Stocke TOUS les modèles actuellement chargés en RAM
    const selectedModel       = ref('');
    // Connecteur LLM choisi (''/null = llama.cpp local par défaut ; sinon id du
    // connecteur cloud/partagé). Envoyé au backend pour router la requête.
    const selectedConnector   = ref('');
    // Serveur sélectionné (tenu par chat/_models.js) : clé, dialecte llama.cpp
    // ou non, modèles chargés, n_ctx connu. Lu par le panneau de sampling et la
    // jauge de contexte — un connecteur llama.cpp a les mêmes mécanismes que
    // l'intégré depuis le 2026-09-16.
    const selectedEngineMeta  = ref({ key: 'builtin', llamacpp: true, label: '', loaded: [], n_ctx: 0 });
    const llmHealth           = ref(null);
    const liveGen             = ref(null);   // ligne de stats LIVE sous le composeur (gen en cours)
    // Placeholder du composeur : la version longue wrappe sur 2 lignes et se
    // fait couper verticalement sur petits écrans (textarea min-height 40px)
    // → version courte < 640px. Constante de boot, pas réactive au resize
    // (le cas rotation est marginal et sans casse).
    const composerPlaceholder = (window.innerWidth < 640)
        ? 'Envoyer un message...'
        : 'Envoyer un message... (@ pour insérer un fichier)';
    const isLoadingModel      = ref(false);
    const showModelManager    = ref(false);
    const showModelProps      = ref(false);
    const modelPropsData      = ref(null);
    const modelPropsLoading   = ref(false);
    // Modale « œil » d'un sous-agent (UX 2026-07-24) : { idx, ri, cid, snap }
    // — la résolution LIVE se fait par taskModalRun() (les runs sont
    // remplacés à chaque patch), `snap` = repli figé si le chat change.
    // taskModalStep = index de l'entrée outil dont la carte détail est
    // ouverte (une seule à la fois — même contrat que _activeToolStep).
    const taskModal           = ref(null);
    const taskModalStep       = ref(null);

    // -- Sampling override (UI "Paramètres avancés" par chat) ---------
    // Implémentation extraite dans static/js/chat/_sampling.js.
    // Les noms exposés ci-dessous sont identiques à ceux qu'utilisaient
    // les anciennes définitions inline — code consommateur (streaming
    // chat, return final, template Vue) inchangé.
    const _samplingMod = window.setupChatSampling(vue, { selectedModel, activeModelIds, selectedConnector, selectedEngineMeta }, { fetchAuth });
    const {
        showSamplingPanel,
        samplingOverride,
        thinkingEnabled,
        effectiveParamsData,
        effectiveParamsLoading,
        ignoredByEngine,
        isIgnoredByEngine,
        _cleanSamplingOverride,
        clampThinkingBudget,
        loadEffectiveParams,
        resetSamplingOverride,
        openSamplingPanel,
        closeSamplingPanel,
        preserveReasoningSupported,
        preserveReasoningEnabled,
        reasoningEffortValues,
        showReasoningEffortMenu,
        toggleReasoningEffortMenu,
        pickReasoningEffort,
    } = _samplingMod;

    // ── Panneaux / dropdowns exclusifs du chat ─────────────────────────
    // Un seul ouvert à la fois. Remplace les enchaînements inline
    // `showX = !showX; showY = false; showZ = false` du template, qui
    // demandaient une combinaison de plus à maintenir à chaque panneau
    // ajouté. L'ouverture déclenche le chargement associé.
    const _chatPanels = {
        mcp:      showMcpPanel,
        rag:      showRagPanel,
        sampling: showSamplingPanel,
    };
    function togglePanel(name) {
        const target  = _chatPanels[name];
        if (!target) return;
        const opening = !target.value;
        for (const key in _chatPanels) _chatPanels[key].value = false;
        target.value = opening;
        if (!opening) return;
        if (name === 'sampling') loadEffectiveParams(selectedModel.value);
    }

    // -- @mention state + composer (extracted to chat/_compose.js) --
    // Le sous-module gère le state @mention, les helpers, et les handlers
    // d'input (keydown/input). ``sendMessage`` est passé en référence : la
    // function declaration est hoistée donc la référence est valide même si
    // sa source est plus bas. ``ctx.autoResize`` est wrappé pour être
    // ré-évalué au moment de l'appel (lazy : pas dispo à l'init).
    const _composeMod = window.setupChatCompose(
        vue,
        { inputRef, inputMessage, attachedFiles, isStreaming },
        {
            fetchAuth, showToast, sendMessage,
            // Commande /compact du menu "/" (function declaration hoistée).
            manualCompress,
            // Commande /plan (idem : function declaration).
            setPlanMode,
            // ``ctx.autoResize`` peut ne pas être disponible à l'init — on
            // ré-évalue à chaque appel.
            get autoResize() { return ctx.autoResize; },
            // Commandes de navigation. Elles vivent dans le module
            // Paramètres, monté APRÈS celui-ci : on passe par les proxies
            // paresseux du ctx d'app.js, jamais par une capture directe.
            openSettingsTab(tab) { return ctx.openSettingsTab ? ctx.openSettingsTab(tab) : undefined; },
            openHelp(doc)        { return ctx.openHelp ? ctx.openHelp(doc) : undefined; },
            // Contexte d'exécution des commandes, reconstruit à CHAQUE accès
            // (le figer au montage gèlerait les disponibilités).
            get env() {
                return {
                    chatId:      currentChatId.value,
                    isStreaming: isStreaming.value,
                    planMode:    planMode.value,
                };
            },
            // {{utilisateur}} des templates de prompt : lu à l'insertion.
            get userName() {
                const u = user && user.value;
                return (u && (u.display_name || u.username)) || '';
            },
        }
    );
    const {
        showMentionDropdown,
        mentionQuery,
        mentionFiles,
        mentionIndex,
        mentionRecentCount,
        isMentionLoading,
        mentionHasMore,
        loadMoreMentionFiles,
        onMentionScroll,
        closeMentionDropdown,
        selectMention,
        handleInputKeydown,
        handleInputInput,
        mentionIconClass,
        mentionFilenameOf,
        mentionDirOf,
        // Menu « / » (chat/_slash.js, monté par _compose.js)
        showSlash,
        slashLevel,
        slashList,
        slashIdx,
        slashRaw,
        pinnedSkills,
        selectSlash,
        removePinnedSkill,
        slashDismiss,
        slashSetIdx,
        resetSlash,
        slashResolve,
        slashRun,
        slashCmdOk,
        slashRowKey,
        slashRowTitle,
        promptPreview,
        slashHeaderIcon,
        slashHeaderLabel,
        // Templates de prompt (chat/_templates.js, monté par _compose.js)
        templatesAll,
        loadTemplates,
        openTemplate,
        templateFill,
        submitTemplateFill,
        cancelTemplateFill,
        templateFillKeydown,
        templateVarsLabel,
    } = _composeMod;

    // -- Webshot carousel (extracted to chat/_webshot.js) ----------
    // 4 fonctions de navigation dans le carousel des screenshots
    // Playwright + helper de cleanup des blob URLs (anti-leak mémoire).
    const _webshotMod = window.setupChatWebshot(vue, { messages }, {});
    const {
        _revokeAllWebShotBlobs,
        webShotPrev,
        webShotNext,
        webShotToggleExpand,
        webShotGoto,
    } = _webshotMod;

    // -- Voix : dictée + lecture (extrait dans chat/_voice.js) ------
    // Le découpage en phrases y vit aussi : il travaille sur un flux en
    // cours de génération, donc sur un état qui n'existe que dans l'onglet.
    const _voiceMod = window.setupChatVoice(
        vue,
        { settings, features: sharedRefs.features, inputMessage, inputRef, messages },
        {
            fetchAuth, showToast,
            get announce() { return ctx.announce; },
            // Comme pour le composeur : ``ctx.autoResize`` peut ne pas être
            // disponible à l'init, on ré-évalue à chaque accès.
            get autoResize() { return ctx.autoResize; },
            get nextTick() { return nextTick; },
        });
    const {
        voiceState, voiceLevel, voiceBusy, voiceReading, voiceReadingIdx,
        voiceCanDictate, voiceCanRead,
        toggleDictation, cancelVoice, voiceEscape, speakMessage, stopSpeaking,
    } = _voiceMod;

    // -- Message edit : initialisé PLUS BAS, après _diffCardMod --
    // (voir le bloc « Message edit » sous _diffCardMod : son ctx a besoin
    // de resetDiffCardState, une const destructurée depuis _diffCardMod —
    // l'initialiser ici la capturerait en zone morte temporelle.)

    // -- Streaming internals --------------------------------------
    let _streamBuf        = '';
    // AUDIT 2026-08-02 (W3) — true dès qu'un outil a été EXÉCUTÉ pendant le
    // tour en cours. Le retry automatique re-POSTe le tour complet sans clé
    // d'idempotence côté serveur : rejouer un tour dont les outils mutants
    // ont déjà tourné (write/commit/push) les ré-exécute — double commit,
    // fichiers réécrits. Quand ce flag est posé, on n'auto-retry PAS : on
    // affiche une erreur honnête à la place.
    let _toolsExecutedThisTurn = false;
    // (correctif 2026-09-02) Phase « outils » du tour courant : posée au 1er
    // tool_call_delta / tool_call, remise à zéro à chaque nouveau tour. Tant
    // qu'elle est vraie, le contenu streamé va dans la LIGNE LIVE du conteneur
    // « Travail de l'assistant » (_pendingPreContent, texte brut) et jamais
    // dans le corps markdown : narration inter-outils et réponse finale sont
    // indiscernables avant la fin d'itération, et l'ancien rejeu tool_thinking
    // (d'avant l'émission directe) les plaçait déjà là. Cf. handler
    // content_token.
    let _streamToolPhase = false;
    let _streamFlushTimer = null;
    const MAX_RETRIES     = 2;

    // ── Coalescing de la console shell (AUDIT 2026-08-31) ───────────────
    // Chaque chunk shell_output (~2 Ko) re-rendait TOUTE la console : _patch
    // → nouveau msg → caches WeakMap (grp, step) invalidés → ansiToHtml sur
    // la sortie CUMULÉE (jusqu'à 96 Ko) + réécriture innerHTML du <pre> +
    // lecture de layout forcée — O(n²) précisément quand l'utilisateur
    // regarde le terminal déplié. On coalesce les chunks par step et on ne
    // patche qu'à cadence bornée ; le ``done`` flush immédiatement.
    const _SHELL_FLUSH_MS = 120;
    const _shellPend = new Map();          // "idx:si" → { chunk, seq }
    let _shellFlushTimer = null;

    function _shellFoldPend(st, pend) {
        // Fusionne la sortie en attente dans le step (cap 96 Ko, QUEUE gardée).
        let acc = (st.shellOut || '') + pend.chunk;
        if (acc.length > 98304) acc = acc.slice(-98304);
        return acc;
    }

    function _flushShellPend() {
        _shellFlushTimer = null;
        const m = _getStreamMsgs();
        for (const [k, pend] of _shellPend) {
            const sep = k.lastIndexOf(':');
            const idx = Number(k.slice(0, sep)), si = Number(k.slice(sep + 1));
            const cur = m[idx];
            if (!cur || !cur.toolSteps || !cur.toolSteps[si]) continue;
            const steps = [...cur.toolSteps];
            const st = steps[si];
            steps[si] = { ...st, shellOut: _shellFoldPend(st, pend),
                          shellSeq: Math.max(st.shellSeq || 0, pend.seq || 0) };
            _patch(idx, { toolSteps: steps });
            // Autoscroll INTERNE de la console (une lecture de layout par
            // FLUSH, plus par chunk) : on suit si déjà en bas du bloc.
            const _gi = Math.max(st.seg || 0, 0);
            nextTick(() => {
                try {
                    const el = document.querySelector('[data-shell-live="' + idx + '-' + _gi + '"]');
                    if (el && (el.scrollHeight - el.scrollTop - el.clientHeight) < 48) {
                        el.scrollTop = el.scrollHeight;
                    }
                } catch (_) {}
            });
        }
        _shellPend.clear();
    }

    // Thinking-token buffer: accumulate tokens in a plain string
    // and flush to Vue reactivity every 100ms instead of on every
    // single token (which causes 99% wasted Object.assign calls
    // on reasoning models that emit hundreds of thinking tokens/s).
    let _thinkBuf        = '';
    let _thinkFlushTimer = null;

    // -- Contexte LIVE : RÉEL SEUL. La jauge n'estime plus rien : elle affiche
    //    la dernière occupation RÉELLE poussée par le backend (event 'kv_cache',
    //    émis en fin de chaque requête LLM depuis l'usage serveur). Pendant un
    //    stream, la valeur reste figée sur le dernier réel connu ; en boucle
    //    outils, chaque itération terminée pousse un nouveau réel. Aucune valeur
    //    tant qu'aucune requête n'a abouti (1er tour d'un chat neuf) → partie
    //    ctx masquée. null = pas de stream.
    //      base = dernière occupation réelle (event kv_cache)
    //      gen  = TOUT le généré (content + thinking) → débit tok/s uniquement
    let _ctxLive = null;
    // Phase de RÉFLEXION en cours (entre le 1er thinking_token et le 1er
    // content_token / tool_call du round). Pendant cette phase la ligne live
    // n'affiche AUCUN compteur de tokens : le débit y serait un cumul incluant
    // le prefill (mesuré jusqu'à ~8 s sur un prompt froid), donc un chiffre qui
    // ne correspond à rien de réel — alors que la métrique de fin de tour, elle,
    // vient des timings llama.cpp. Mieux vaut ne rien montrer qu'un faux.
    let _inThinkPhase = false;
    // Dernière occupation de contexte RÉELLE affichée. Sert à semer la jauge au
    // tour suivant ET à figer le snapshot du message (capturée avant
    // _clearLiveCtx, donc survit à la fin du stream).
    let _lastCtxUsed = 0;
    let _genStartMs = 0;
    let _genTicker = null;

    // ── Auto-scroll de stream unifié (perf vague 1) ──────────────────
    // Avant : chaque flush (content 40 ms, think 100 ms, preContent 40 ms)
    // écrivait scrollTop=scrollHeight EN SYNCHRONE dans son timer, AVANT
    // le patch DOM de Vue (microtask) → layout forcé à chaque tick ET
    // scroll en retard d'un tick. nextTick garantit le post-render, rAF
    // coalesce à une écriture par frame. Le lock est posé dans le même
    // stack que l'écriture (contrat du scroll handler, cf. app.js).
    let _scrollPending = false;
    function _scheduleStreamScroll() {
        if (_scrollPending) return;
        _scrollPending = true;
        nextTick(() => requestAnimationFrame(() => {
            _scrollPending = false;
            if (isUserScrolling.value || !chatContainer.value) return;
            if (ctx._lockAutoScroll) ctx._lockAutoScroll();
            chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
        }));
    }

    function _flushThinkBuf() {
        if (!_thinkBuf) return;
        const msgs = _getStreamMsgs();
        const idx = _streamIdx(msgs);
        if (idx < 0) { _thinkBuf = ''; return; }
        const cur = msgs[idx];
        // Cohérence visuelle (refonte cartes agents) : le bloc thinking reste
        // PLIÉ par défaut, y compris à l'apparition du live — l'utilisateur
        // clique s'il veut suivre le raisonnement (son choix est ensuite
        // respecté : les flushs ne touchent jamais thinkingOpen).
        const merged = (cur.thinking || '') + _thinkBuf;
        _thinkBuf = '';
        msgs[idx] = Object.assign({}, cur, { thinking: merged });
        {
            statusText.value = _thinkingTitle(merged);
            // Auto-scroll le <pre> du bloc thinking ouvert vers le bas.
            // requestAnimationFrame s'exécute APRÈS le rendu Vue (microtasks)
            // et AVANT le prochain paint -- timing parfait pour querySelector.
            // Pas de Promise → pas de DOMException sur abort.
            requestAnimationFrame(() => {
                try {
                    if (!chatContainer.value || !isStreaming.value) return;
                    const msgEl = chatContainer.value.querySelector('[data-vs-idx="' + idx + '"]');
                    if (!msgEl) return;
                    const pre = msgEl.querySelector('[data-think][open] pre');
                    if (pre) pre.scrollTop = pre.scrollHeight;
                } catch(_) {}
            });
            // Auto-scroll du conteneur principal (comme pour content_token) :
            // pendant une longue phase de thinking, le bloc grossit et peut
            // sortir du viewport. On garde le bas visible, sauf si l'user
            // a scrollé vers le haut (respecte isUserScrolling).
            _scheduleStreamScroll();
        }
    }

    function _stopThinkFlush() {
        if (_thinkFlushTimer) { clearInterval(_thinkFlushTimer); _thinkFlushTimer = null; }
        _flushThinkBuf();
    }

    // Buffer pour le contenu pré-outil (texte visible que le modèle écrit avant/entre les appels d'outils)
    // Ce n'est PAS du reasoning -- c'est du texte normal comme "Je vais chercher X..."
    // Il doit s'afficher visiblement dans le chat, pas dans un bloc caché "Réflexion".
    let _preContentBuf = '', _preContentFlushTimer = null;

    function _flushPreContentBuf(force) {
        const msgs = _getStreamMsgs(), idx = _streamIdx(msgs);
        if (idx < 0) { _preContentBuf = ''; return; }
        const cur = msgs[idx];
        if (!_preContentBuf) {
            // Buffer vide : rattrapage du bloc actif s'il est resté en retard
            // (throttle 110 ms) — même règle que le corps.
            if (_liveRenderDirty._pp && cur && cur._pendingPreContent) {
                msgs[idx] = Object.assign({}, cur, _catchUpRender(cur, cur._pendingPreContent, '_pp', false));
            } else {
                _liveRenderDirty._pp = false;
            }
            return;
        }
        // Lissage (cf. _smoothTake) : la narration pré-outil arrive par les
        // mêmes rafales que le contenu — même versement borné. ``force``
        // (fin de phase / Stop) draine tout d'un coup.
        const take = force ? _preContentBuf.length : _smoothTake(_preContentBuf, 40);
        const chunk = _preContentBuf.slice(0, take);
        _preContentBuf = _preContentBuf.slice(take);
        const _preComplet = (cur._pendingPreContent || '') + chunk;
        msgs[idx] = Object.assign({}, cur,
            _applyPreRender(cur, _preComplet),
            { _statusLine: cur._statusLine || '' });
        // Lecture vocale de la narration d'étapes (réglage « Lire entre les
        // outils »). Ce texte ne passe PAS par _streamBuf : sans ce crochet,
        // tout ce que l'assistant annonce avant un appel d'outil resterait
        // muet. Le tampon repart de zéro à chaque tool_call — le module s'en
        // sert pour vider la phrase en cours avant d'enchaîner.
        try { _voiceMod.onAssistantToolStream(_preComplet); } catch (e) { console.error('[voix]', e); }
        // Auto-scroll pendant le pré-contenu, comme content_token
        if (!isUserScrolling.value && chatContainer.value) {
            _vsEnsureTail();
            _scheduleStreamScroll();
        }
    }

    function _stopPreContentFlush() {
        if (_preContentFlushTimer) { clearInterval(_preContentFlushTimer); _preContentFlushTimer = null; }
        _flushPreContentBuf(true);
        _liveRenderTs._pp = 0;      // prochaine narration : bloc actif rendu d'emblée
        _liveRenderDirty._pp = false;
    }

    // Alias de compatibilité (ancien nom utilisé dans stopGeneration)
    function _stopToolThinkFlush() { _stopPreContentFlush(); }

    // ===========================================================
    //  RUNS EN ARRIÈRE-PLAN  (chantier C, 2026-09-16)
    //
    //  Un tour n'est plus « parqué » en mémoire quand on quitte sa
    //  conversation : la LECTURE du flux s'arrête, le serveur poursuit le run
    //  jusqu'au bout (``resumable`` : déconnexion = détachement) et journalise
    //  ses événements. Revenir sur la conversation — autre chat puis retour,
    //  rechargement, autre appareil — REJOUE le journal puis suit le direct
    //  (``attachRun``) : bulle, étapes d'outils, texte et bouton Stop
    //  reviennent. Plusieurs runs peuvent tourner en fond.
    //
    //  L'ancien mécanisme (copie des messages, un seul flux parqué, sauvegarde
    //  partielle ``save-messages``) perdait les événements arrivés pendant le
    //  chargement du chat de destination, faisait fuir l'indicateur dans un
    //  autre chat, pouvait écrire les messages d'un chat dans un autre (course
    //  A→B→C→A) et faisait perdre le résultat d'un run détaché (conflit de
    //  persistance) — cf. docs/evolutions-upload-moteurs-reprise-design-2026-09-16.md § 3.
    // ===========================================================
    let _streamingForChatId = null;       // chatId the current stream targets
    // Run lu en ce moment (POST ou rattachement) : ``detached`` est posé quand
    // on quitte la conversation AVANT que la requête ne soit partie — le POST
    // part quand même (le tour de l'utilisateur n'est pas perdu), sa lecture
    // est abandonnée dès la réponse.
    let _currentRun = null;               // { gen, chatId, posted, detached }
    // Conversations dont un run tourne (tous workers, tous onglets) : pastille
    // de la barre latérale. Source : les runs lancés ici + /api/chats/active-runs.
    const activeRunIds = ref([]);
    let _activeRunsTimer = null;
    // Rejeu d'un journal en cours : pas de toasts ni d'ouverture d'éditeur pour
    // des événements déjà passés.
    let _replaying = false;

    function _markRunActive(chatId) {
        const id = String(chatId || '');
        if (!id || id.startsWith('__')) return;
        if (!activeRunIds.value.includes(id)) activeRunIds.value = activeRunIds.value.concat([id]);
        _scheduleActiveRunsPoll();
    }

    function _markRunDone(chatId) {
        const id = String(chatId || '');
        if (activeRunIds.value.includes(id)) activeRunIds.value = activeRunIds.value.filter(x => x !== id);
    }

    function _scheduleActiveRunsPoll() {
        if (_activeRunsTimer || !activeRunIds.value.length) return;
        _activeRunsTimer = setTimeout(() => { _activeRunsTimer = null; refreshActiveRuns(); }, 5000);
    }

    // Relit la liste des runs vivants. Un run qui en SORT alors que sa
    // conversation n'est pas affichée : réponse prête (toast + notif OS), liste
    // des chats rafraîchie (titre généré).
    // Pastilles dès la connexion (runs lancés ailleurs, ou avant un
    // rechargement) et à chaque retour sur l'onglet.
    // Console admin seule (admin.html, processus admin) : ni chats ni runs,
    // et la route n'existe pas sur ce port (404 à chaque retour d'onglet).
    const _adminOnly = typeof window !== 'undefined' && !!window.__ADMIN_ONLY_MODE__;
    watch(user, (u) => { if (u && !_adminOnly) refreshActiveRuns(); }, { immediate: true });
    try {
        if (!_adminOnly) document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && user.value) refreshActiveRuns();
        });
    } catch (_) {}

    async function refreshActiveRuns() {
        if (!user.value) return;
        let ids = null;
        try {
            const r = await fetchAuth('/api/chats/active-runs', {}, true);
            if (r && r.ok) {
                const d = await r.json().catch(() => null);
                if (d && Array.isArray(d.chat_ids)) ids = d.chat_ids.map(String);
            }
        } catch (_) {}
        if (ids === null) { _scheduleActiveRunsPoll(); return; }
        const shown = String(currentChatId.value || '');
        const finis = activeRunIds.value.filter(id => !ids.includes(id)
            && !(id === shown && isStreaming.value));
        // Le run affiché et lu en direct reste marqué tant que sa lecture dure.
        const garder = (shown && isStreaming.value && activeRunIds.value.includes(shown)) ? [shown] : [];
        activeRunIds.value = Array.from(new Set(ids.concat(garder)));
        if (finis.length) {
            try { loadChatsList(); } catch (_) {}
            for (const id of finis) {
                if (id === shown) continue;
                const t = (chats.value.find(c => String(c.id) === id) || {}).title || 'Conversation';
                if (ctx.notifyChatDone) { try { ctx.notifyChatDone(id, t); } catch (_) {} }
            }
        }
        _scheduleActiveRunsPoll();
    }

    // ===========================================================
    //  SUIVI D'UN RUN DÉTACHÉ  (audit 2026-08-22, B3/B4)
    //
    //  Repli quand un run ne peut PAS être rejoué (journal indisponible, run
    //  lancé par un client sans reprise) : on sonde l'état de génération du chat
    //  et on le recharge dès qu'elle se termine. Aucun re-POST : le tour n'est
    //  JAMAIS rejoué (des outils ont muté des fichiers). Depuis le 2026-09-16 le
    //  suivi est VISIBLE sur la conversation affichée : bulle « Génération en
    //  cours… » et bouton Arrêter, plus un simple toast.
    // ===========================================================
    const followedRunChatId = ref(null);
    let _followTimer  = null;
    let _followTicks  = 0;
    let _followErrs   = 0;           // échecs CONSÉCUTIFS de la sonde
    const FOLLOW_POLL_MS  = 4000;
    const FOLLOW_MAX_TICKS = 5400;   // ~6 h de veille, largement au-delà d'un run
    // AUDIT 2026-08-31 (passe 4, F2) — si ``/generation-status`` échoue en
    // continu (serveur redémarré, chat supprimé), ``running`` restait null →
    // aucune branche de sortie → 6 h de polls onglet caché compris, avec le
    // composeur verrouillé (l'épilogue garde isStreaming armé pendant le
    // suivi). On borne : ~1 min d'échecs consécutifs → on lâche le suivi.
    const FOLLOW_MAX_ERRS = 15;

    // Bulle de suivi (repli sans journal) : pastille « en cours » sur la
    // conversation affichée, retirée quand le suivi s'arrête.
    function _setFollowBubble(on) {
        const msgs = messages.value;
        const last = msgs.length ? msgs[msgs.length - 1] : null;
        if (on) {
            if (last && last.role === 'assistant' && last._followBubble) return;
            msgs.push({ role: 'assistant', content: '', thinking: '', thinkingOpen: false,
                        _statusLine: 'Génération en cours…', isStreaming: true,
                        isError: false, errorMessage: '', isTruncated: false,
                        _followBubble: true });
        } else {
            // Retrait par RECHERCHE, pas par ``pop()`` : dès qu'un message a été
            // poussé après elle (début d'un vrai tour, notice, question
            // ask_user), la bulle n'est plus la dernière — elle restait alors
            // au milieu du fil, ``isStreaming: true``, à afficher une
            // génération qui n'existait plus.
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i] && msgs[i]._followBubble) msgs.splice(i, 1);
            }
        }
    }

    function stopFollowRun() {
        if (_followTimer) { clearTimeout(_followTimer); _followTimer = null; }
        _followTicks = 0;
        _followErrs  = 0;
        if (followedRunChatId.value) {
            const _id = followedRunChatId.value;
            followedRunChatId.value = null;
            _markRunDone(_id);
            // Pendant le suivi, ``isStreaming`` reste armé pour que le bouton
            // Arrêter demeure offert (le Stop traverse les workers par le bus
            // d'annulation). Il n'y a alors NI flux local NI contrôleur
            // d'abandon : c'est à quoi on reconnaît que ce drapeau nous
            // appartient, et qu'on peut le baisser sans casser un vrai stream.
            if (String(currentChatId.value) === String(_id)) _setFollowBubble(false);
            if (isStreaming.value && !abortController.value) {
                isStreaming.value = false;
                isThinking.value  = false;
                statusText.value  = '';
            }
        }
    }

    // Le suivi est PROPRE au chat : revenir sur un chat déjà suivi remet sa
    // bulle et le bouton Arrêter (avant, la sortie anticipée laissait un chat
    // qui génère avec un composeur ouvert → 409 au premier envoi).
    function _showFollowState(id) {
        if (String(currentChatId.value) === id && !abortController.value) {
            _setFollowBubble(true);
            isStreaming.value = true;
            _streamingForChatId = id;
        }
    }

    function followRun(chatId, opts) {
        const id = String(chatId || '');
        if (!id) return;
        if (followedRunChatId.value === id) { _showFollowState(id); return; }
        stopFollowRun();
        followedRunChatId.value = id;
        _markRunActive(id);
        _showFollowState(id);
        if (!opts || !opts.silent) {
            showToast('La génération continue côté serveur — la conversation '
                    + 'se rechargera à la fin.', 'info', { duration: 8000 });
        }
        const _tick = async () => {
            _followTimer = null;
            if (followedRunChatId.value !== id) return;
            if (++_followTicks > FOLLOW_MAX_TICKS) { stopFollowRun(); return; }
            let running = null;
            let gone = false;
            try {
                const r = await fetchAuth(
                    '/api/chat/' + encodeURIComponent(id) + '/generation-status',
                    {}, true);
                if (r && r.ok) {
                    const d = await r.json().catch(() => null);
                    if (d) running = !!d.generation_running;
                } else if (r && r.status === 404) {
                    // Chat supprimé (ou purgé côté serveur) : plus rien à suivre.
                    gone = true;
                }
            } catch (_) { /* réseau : on retentera */ }
            if (followedRunChatId.value !== id) return;
            // AUDIT 2026-08-31 (passe 4, F2) — sortie d'erreur : sans elle,
            // ``running`` null re-planifiait indéfiniment (jusqu'à 6 h) avec
            // le composeur verrouillé. 404 → stop immédiat ; échecs
            // consécutifs (réseau / 5xx) bornés à FOLLOW_MAX_ERRS.
            if (gone) { stopFollowRun(); return; }
            if (running === null) {
                if (++_followErrs >= FOLLOW_MAX_ERRS) {
                    stopFollowRun();
                    showToast('Suivi de la génération interrompu : le serveur '
                            + 'ne répond plus. Rechargez la conversation pour '
                            + 'vérifier son état.', 'warning', { duration: 8000 });
                    return;
                }
            } else {
                _followErrs = 0;
            }
            if (running === false) {
                stopFollowRun();   // baisse aussi isStreaming (cf. ci-dessus)
                // Terminé : on recharge pour afficher la réponse persistée
                // (la tool_history enregistrée reconstruit les cartes d'outils).
                if (String(currentChatId.value) === id && !isStreaming.value) {
                    // ``force`` : c'est la conversation AFFICHÉE qu'il faut
                    // relire — sans lui, loadChat court-circuite (« déjà
                    // ouverte ») et l'écran resterait sur le tour interrompu.
                    try { await loadChat(id, { force: true }); } catch (_) {}
                    showToast('Génération terminée — conversation à jour.',
                              'success', { duration: 5000 });
                } else {
                    showToast('Une génération en arrière-plan est terminée.',
                              'info', { duration: 5000 });
                    if (ctx.loadChatsList) { try { ctx.loadChatsList(); } catch (_) {} }
                }
                return;
            }
            _followTimer = setTimeout(_tick, FOLLOW_POLL_MS);
        };
        _followTimer = setTimeout(_tick, FOLLOW_POLL_MS);
    }

    // Token de génération monotone. Chaque _doGenerate capture sa valeur
    // (myGen). Quand une nouvelle génération démarre (et abort l'ancienne),
    // _activeGen est incrémenté ; la boucle de lecture de l'ancien stream
    // détecte alors myGen !== _activeGen et cesse de dispatcher ses events
    // bufferisés. Ferme la race où un dernier event décodé d'un stream abandonné
    // s'écrivait dans messages.value du NOUVEAU chat.
    let _activeGen = 0;

    /** Messages que le flux alimente : toujours la conversation AFFICHÉE —
     *  quitter une conversation arrête la lecture de son flux (chantier C). */
    function _getStreamMsgs() {
        return messages.value;
    }

    // (passe 8, F6) — cible des flushs et des patchs de stream : le DERNIER
    // assistant EN COURS de stream, pas msgs.length-1 aveuglément. Un
    // ``notice`` de compaction (gelé) poussé APRÈS l'assistant pendant le
    // tour recevait sinon les patchs (objet hybride) et la bulle n'était
    // plus alimentée. Repli : dernier message (comportement historique).
    function _streamIdx(msgs) {
        for (let i = msgs.length - 1, n = 0; i >= 0 && n < 4; i--, n++) {
            const m = msgs[i];
            if (m && m.role === 'assistant' && m.isStreaming) return i;
        }
        return msgs.length - 1;
    }

    // ── Projection PARTAGÉE des messages pour la persistance ──────────────
    // AUDIT 2026-08-01 (C2/E1/E2) : trois chemins écrivaient l'historique
    // complet avec des filtres DIVERGENTS — `payloadMsgs` (_doGenerate, le
    // seul correct), l'ancienne sauvegarde partielle d'arrière-plan et
    // `_saveSession`. Comme
    // `/save-messages` ÉCRASE le blob entier, toute divergence devenait une
    // perte définitive en base : un message image-seule (`content: ''`)
    // disparaissait, et `images` / `task_runs` n'étaient jamais réémis.
    // Les deux helpers ci-dessous sont désormais l'unique source de vérité.

    /** Vrai si le message doit survivre à un round-trip de persistance. */
    function _keepForPersist(m) {
        return !!(m && m.role && (
            m.role === 'notice'
            || m.content
            || (m.images && m.images.length > 0)
            || (m.tool_history && m.tool_history.length > 0)
            // Tour coupé en PLEIN raisonnement (content vide, thinking seul) :
            // AVANT, ce message était jeté du payload de reprise → le backend
            // recevait is_continue sur un fil finissant par le message user,
            // n'injectait aucune consigne, et le modèle re-raisonnait de zéro
            // jusqu'au même mur — boucle infinie du « Continuer ».
            || (m.thinking && m.thinkingTruncated)
        ));
    }

    /** Projette un message vers sa forme persistée (format round-trip du
     *  backend : images en `parts`, notice avec ses champs structurés). */
    function _projectForPersist(m) {
        if (m.role === 'notice') {
            return { role: 'notice', kind: m.kind || 'compaction',
                     ts: m.ts || null, round: m.round || null,
                     tokens_after: m.tokens_after || null,
                     summary: m.summary || null,
                     content: m.content || '' };
        }
        let o;
        if (m.images && m.images.length > 0) {
            const parts = m.images.map(img => ({
                type:      'image_url',
                image_url: { url: img.dataUrl },
            }));
            if (m.content) parts.push({ type: 'text', text: m.content });
            o = { role: m.role, content: parts };
        } else {
            o = { role: m.role, content: m.content };
        }
        if (m.tool_history && m.tool_history.length > 0) {
            o.tool_history = m.tool_history;
            if (m.tool_history_delta) o.tool_history_delta = true;
        }
        if (m.taskRuns && m.taskRuns.length) o.task_runs = m.taskRuns;
        // Exécutions du message (table ``runs``) : relues par « Détails », et
        // conservées par le serveur à la fusion d'un « Continuer ».
        if (m.run_ids && m.run_ids.length) o.run_ids = m.run_ids;
        // Fichiers modifiés par les outils (lignes « fichiers modifiés »).
        if (m.files_changed && m.files_changed.length) o.files_changed = m.files_changed;
        // Pied du message (modèle, durée, débits) : sans aller-retour, il
        // disparaissait au tour suivant. Sans le raisonnement ni les outils
        // qu'un événement live peut y porter (le serveur les écarte aussi).
        if (m.metrics && typeof m.metrics === 'object') {
            const { thinking, tool_history, ...pied } = m.metrics;
            o.metrics = pied;
        }
        // isTruncated pilote SEUL le bouton « Continuer » (chat.html) : sans
        // round-trip, un tour coupé par le plafond d'itérations devient
        // irrécupérable après un simple rechargement de page.
        if (m.isTruncated) o.isTruncated = true;
        // Raisonnement d'un tour coupé en plein think : projeté sous
        // ``resume_thinking`` (seul thinking persisté, cf. save_chat) — c'est
        // lui que le backend rejoue à la reprise (_expand_history_for_llm).
        if (m.thinkingTruncated && (m.resume_thinking || m.thinking)) {
            o.resume_thinking = m.resume_thinking || m.thinking;
            o.thinkingTruncated = true;
        }
        return o;
    }

    // Remise à zéro de l'état de flux propre au tour LU (tampons, timers, jauge
    // live, compaction) — au détachement comme au rattachement.
    function _resetStreamState() {
        _stopStreamFlush();
        if (_thinkFlushTimer)      { clearInterval(_thinkFlushTimer);      _thinkFlushTimer      = null; }
        if (_preContentFlushTimer) { clearInterval(_preContentFlushTimer); _preContentFlushTimer = null; }
        _streamBuf = ''; _thinkBuf = ''; _preContentBuf = '';
        _streamToolPhase = false;
        _toolsExecutedThisTurn = false;
        _pendingAskUser = null;
        _resetDeltaStatus();
        if (_ctxLive) _clearLiveCtx();
        _stopCompressionTick();
        compressionProgress.value = 0;
        compressionStatus.value   = null;
        queueStatus.value = null;
    }

    /**
     * On quitte la conversation qui génère : la LECTURE s'arrête, le run
     * continue côté serveur (``resumable``) et se rejouera au retour.
     * @returns {boolean} true si un tour était en cours.
     */
    function _detachFromStream() {
        const run = _currentRun;
        const id = _streamingForChatId;
        if (followedRunChatId.value) {
            // Suivi par sondage : il continue (pastille), mais la bulle de la
            // conversation quittée n'a plus lieu d'être.
            _setFollowBubble(false);
        }
        if (!run || run.detached || !isStreaming.value) {
            if (isStreaming.value && !abortController.value) {
                isStreaming.value = false; isThinking.value = false; statusText.value = '';
            }
            return false;
        }
        run.detached = true;
        _pendingReattach = null;
        if (id && !String(id).startsWith('__')) _markRunActive(id);
        // Jeton : la boucle de lecture abandonnée cesse de dispatcher, et son
        // épilogue ne touche plus à l'état de la conversation suivante.
        _activeGen++;
        // Requête déjà partie : on coupe la lecture (le serveur détache). Pas
        // encore partie : ``_doGenerate`` l'enverra quand même puis coupera.
        if (run.posted && abortController.value) {
            try { abortController.value.abort(); } catch (_) {}
        }
        abortController.value = null;
        // Les flux d'écriture Monaco de CE chat ne recevront plus de deltas
        // (la lecture s'arrête) : on les ferme ici, en revenant au contenu
        // d'avant — le disque recevra la version finale quand le run se
        // terminera côté serveur, et l'onglet (propre) la rechargera.
        _closeToolStreamsFor(id || null);
        // Sorties shell en attente de flush (clés « idx:si », sans chat) :
        // purgées avec leur minuteur, sinon elles se recollaient sur le
        // message de même index de la conversation suivante (2026-09-20).
        _shellPend.clear();
        if (_shellFlushTimer) { clearTimeout(_shellFlushTimer); _shellFlushTimer = null; }
        _resetStreamState();
        isStreaming.value = false;
        isThinking.value  = false;
        statusText.value  = '';
        pendingWrite.value = null;
        _streamingForChatId = null;
        _currentRun = null;
        return true;
    }

    // Coupure réseau d'un tour qui avait exécuté des outils : rattachement au
    // journal une fois l'épilogue de la génération passé (cf. _doGenerate).
    let _pendingReattach = null;

    async function _reattachOrFollow(chatId) {
        const id = String(chatId || '');
        if (!id) return;
        let st = null;
        try {
            const r = await fetchAuth('/api/chat/' + encodeURIComponent(id) + '/generation-status', {}, true);
            if (r && r.ok) st = await r.json().catch(() => null);
        } catch (_) {}
        if (String(currentChatId.value) !== id) {
            if (st && st.generation_running) _markRunActive(id);
            return;
        }
        if (!st || !st.generation_running) {
            // Terminé pendant la coupure : la conversation est à jour en base.
            try { await loadChat(id, { force: true, noAttach: true }); } catch (_) {}
            return;
        }
        if (st.resumable && st.run_id) await attachRun(id, st);
        else followRun(id, { silent: true });
    }

    /**
     * Se RATTACHE au run en cours de la conversation affichée (chantier C) :
     * réconcilie le fil (le tour n'est pas encore en base), rejoue le journal
     * du run puis le suit en direct avec le MÊME gestionnaire d'événements que
     * le flux d'envoi. Bulle, étapes d'outils, sous-agents et bouton Stop
     * reviennent tels qu'ils étaient.
     * @param {string} chatId
     * @param {object} st  réponse de /generation-status (run_id, base_count,
     *                     user_message, is_continue)
     */
    async function attachRun(chatId, st) {
        const id = String(chatId || '');
        if (!id || !st || !st.run_id) return false;
        if (String(currentChatId.value) !== id) return false;
        if (isStreaming.value && abortController.value) return false;   // déjà lu ici
        if (String(followedRunChatId.value || '') === id) stopFollowRun();
        const myGen = ++_activeGen;
        const run = { gen: myGen, chatId: id, posted: true, detached: false,
                      attached: true, stopped: false };
        _currentRun = run;
        _resetStreamState();
        _toolStreamStates.clear();
        _toolStreamQueues.clear();

        // ── Réconciliation du fil ──────────────────────────────────────────
        // La base est dans l'état d'AVANT le tour. ``base_count`` = messages du
        // payload du run (dont le message utilisateur du tour) : on retire ce
        // qui a été remplacé (régénération, édition), puis on ajoute la
        // question et la bulle du tour.
        const msgs = messages.value;
        const base = Math.max(0, Number(st.base_count) || 0);
        if (st.is_continue) {
            let li = -1;
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i] && msgs[i].role === 'assistant') { li = i; break; }
            }
            if (li >= 0) {
                msgs[li] = Object.assign({}, msgs[li], { isStreaming: true, isTruncated: false,
                                                         isError: false, errorMessage: '' });
            } else {
                msgs.push({ role: 'assistant', content: '', thinking: '', thinkingOpen: false,
                            _statusLine: '', isStreaming: true, isError: false,
                            errorMessage: '', isTruncated: false });
            }
        } else {
            const keep = base > 0 ? base - 1 : msgs.length;
            if (msgs.length > keep) msgs.splice(keep);
            if (st.user_message) msgs.push({ role: 'user', content: st.user_message });
            msgs.push({ role: 'assistant', content: '', thinking: '', thinkingOpen: false,
                        _statusLine: '', isStreaming: true, isError: false,
                        errorMessage: '', isTruncated: false });
        }

        isStreaming.value = true;
        isThinking.value  = true;
        statusText.value  = '';
        isUserScrolling.value = false;
        _streamingForChatId = id;
        const ctl = new AbortController();
        abortController.value = ctl;
        _markRunActive(id);
        _seedLiveCtx();
        nextTick(() => scrollToBottom(true));

        let sawFinal = false, lost = false;
        _replaying = true;
        try {
            const res = await fetch('/api/chat/' + encodeURIComponent(id) + '/run/events?run_id='
                                    + encodeURIComponent(st.run_id),
                                    { signal: ctl.signal, credentials: 'same-origin' });
            if (res.status === 401) {
                lost = true;
                try { await ctx.checkAuth(); } catch (_) {}
            } else if (!res.ok) {
                lost = true;
            } else {
                const reader = res.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buf = '';
                let stop = false;
                try {
                    while (!stop) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buf += decoder.decode(value, { stream: true });
                        const lines = buf.split('\n');
                        buf = lines.pop();
                        for (const line of lines) {
                            if (!line.trim()) continue;
                            if (myGen !== _activeGen) { stop = true; break; }
                            let evt = null;
                            try { evt = JSON.parse(line); } catch (_) { continue; }
                            const t = evt && evt.type;
                            if (t === 'replay_done') {
                                _replaying = false;
                                nextTick(() => { scrollToBottom(true); addCodeCopyButtons(); });
                                continue;
                            }
                            if (t === 'run_started' || t === 'ping') continue;
                            if (t === 'run_end') { stop = true; break; }
                            if (t === 'run_lost' || t === 'session_expired') { lost = true; stop = true; break; }
                            if (t === 'final') sawFinal = true;
                            try { await handleStreamEvent(evt); }
                            catch (e) { console.error('[chat] rattachement : événement en échec', e, t); }
                        }
                    }
                } finally {
                    try { const _p = reader.cancel(); if (_p && _p.catch) _p.catch(() => {}); } catch (_) {}
                }
            }
        } catch (e) {
            if (!e || e.name !== 'AbortError') lost = true;
        } finally {
            _replaying = false;
            _stopStreamFlush();
        }

        // Quitté / supplanté pendant la lecture : l'état appartient à la suite.
        if (myGen !== _activeGen) return true;
        if (_ctxLive) _clearLiveCtx();
        if (_thinkFlushTimer)      { clearInterval(_thinkFlushTimer);      _thinkFlushTimer      = null; }
        if (_preContentFlushTimer) { clearInterval(_preContentFlushTimer); _preContentFlushTimer = null; }
        abortController.value = null;
        pendingWrite.value = null;
        _streamingForChatId = null;
        if (_currentRun === run) _currentRun = null;
        isStreaming.value = false;
        isThinking.value  = false;
        statusText.value  = '';
        _markRunDone(id);
        // Fin sans ``final`` (run perdu, journal illisible) : la vérité est en
        // base — on relit la conversation (sans rattachement automatique : un
        // run encore vivant mais illisible passe en suivi par sondage). Un Stop
        // utilisateur a déjà finalisé la bulle localement.
        if ((lost || !sawFinal) && !run.stopped && String(currentChatId.value) === id) {
            try { await loadChat(id, { force: true, noAttach: true }); } catch (_) {}
        } else if (sawFinal) {
            nextTick(() => { addCodeCopyButtons(); if (user.value) loadChatsList(); });
        }
        return true;
    }

    // ===========================================================
    //  VIRTUAL SCROLL -- windowed rendering  (extracted)
    //  See static/js/chat/_virtual_scroll.js for the full implementation.
    // ===========================================================
    const _vs = window.setupChatVirtualScroll(vue, {
        messages, chatContainer, isUserScrolling,
    }, ctx);
    const {
        visibleMessages, vsTopPad, vsBotPad, lastAssistantIdx,
        onChatScroll, scrollToMessage, _vsReset, _vsEnsureTail, _vsInitTail,
    } = _vs;

    // -- Helpers --------------------------------------------------

    function scrollToBottom(force) {
        if (chatContainer.value && (force || !isUserScrolling.value)) {
            if (force) isUserScrolling.value = false;
            _vsEnsureTail();
            nextTick(function() {
                const el = chatContainer.value;
                if (!el) return;
                if (ctx._lockAutoScroll) ctx._lockAutoScroll();
                if (force) {
                    // Saut INSTANTANÉ : le conteneur a `scroll-smooth` (CSS) ;
                    // un grand saut animé (ex. ouverture d'un chat long depuis
                    // l'accueil) se fait interrompre par les rendus différés
                    // (highlight.js, fonts) et laisse le viewport en haut.
                    const prev = el.style.scrollBehavior;
                    el.style.scrollBehavior = 'auto';
                    el.scrollTop = el.scrollHeight;
                    el.style.scrollBehavior = prev || '';
                } else {
                    el.scrollTop = el.scrollHeight;
                }
            });
        }
    }

    // Ré-ancrage du bas après un chargement de chat : highlight.js / fonts
    // font grossir le contenu APRÈS le premier scrollToBottom(true). On
    // re-colle le bas en plusieurs passes, tant que l'utilisateur n'a pas
    // repris la main (isUserScrolling). Branché UNIQUEMENT dans loadChat —
    // pas dans scrollToMessage/sauts outline (il se ferait battre par
    // _vsCorrectTo).
    function settleScrollBottom() {
        // Capture le chat au moment de l'appel : les passes 600/1200 ms
        // peuvent firer APRÈS un switch de conversation (clic rapide dans la
        // sidebar) et re-scrollaient alors le NOUVEAU chat vers le bas alors
        // que l'utilisateur venait d'y positionner son viewport.
        const chatAtCall = currentChatId.value;
        [80, 250, 600, 1200].forEach(function(delay) {
            setTimeout(function() {
                if (currentChatId.value !== chatAtCall) return;
                const el = chatContainer.value;
                if (!el || isUserScrolling.value) return;
                if (el.scrollHeight - el.scrollTop - el.clientHeight > 4) {
                    if (ctx._lockAutoScroll) ctx._lockAutoScroll();
                    const prev = el.style.scrollBehavior;
                    el.style.scrollBehavior = 'auto';
                    el.scrollTop = el.scrollHeight;
                    el.style.scrollBehavior = prev || '';
                }
            }, delay);
        });
    }

    function _patch(idx, patch) {
        const msgs = _getStreamMsgs();
        if (idx >= 0 && idx < msgs.length)
            msgs[idx] = Object.assign({}, msgs[idx], patch);
    }

    // Mutation d'état d'UI sur un message AFFICHÉ (entry de visibleMessages).
    // Les messages chargés sont Object.freeze() (perf — cf. _history.js) : muter
    // directement ``entry.msg.<prop>`` dans un handler de template est un no-op
    // SILENCIEUX (les handlers Vue compilés tournent en non-strict via ``with``).
    // Sans ça : sur un chat rechargé, déplier un step d'outil (_activeToolStep,
    // v-if sans repli natif) ne faisait RIEN, et les <details> thinking/events se
    // refermaient au prochain re-render (v-memo dépend de isStreaming). On REMPLACE
    // donc l'objet à son index dans messages.value (l'array reste réactif → re-render).
    // Cible messages.value (le chat AFFICHÉ), PAS _getStreamMsgs() qui peut pointer
    // un autre tableau si la conversation vient de changer.
    function setMsgUi(entry, patch) {
        const arr = messages.value;
        if (!entry || !Array.isArray(arr)) return;
        let i = (typeof entry.idx === 'number') ? entry.idx : -1;
        if (!(i >= 0 && i < arr.length && arr[i] === entry.msg)) {
            i = arr.indexOf(entry.msg);   // index a dérivé → relocalise par identité
        }
        if (i >= 0) arr[i] = Object.assign({}, arr[i], patch);
    }

    // ── Flush adaptatif du contenu streamé (perf vague 1) ─────────────
    // setTimeout auto-replanifié plutôt que setInterval : la cadence
    // s'espace avec la taille du message, car le coût d'un patch croît
    // avec la longueur du text node remplacé (re-layout O(n) du nœud).
    // 40 ms reste la cadence nominale (imperceptible) ; on espace au-delà
    // de 16K chars pour borner le travail de layout par seconde.
    function _streamFlushDelay(len) {
        if (len < 16384) return 40;
        if (len < 65536) return 80;
        return 120;
    }

    // ── Lissage de la révélation (2026-09-01 — « saccades ») ──────────
    // Les tokens ARRIVENT en rafales : fenêtre de retenue serveur (48 c),
    // drain de fin d'itération d'outils, coalescence réseau. Flusher TOUT
    // le backlog à chaque tick faisait sauter le texte par blocs entiers.
    // On révèle désormais à débit borné : chaque tick n'affiche qu'une
    // tranche proportionnelle au retard, calibrée pour résorber le backlog
    // en ~_SMOOTH_WINDOW_MS. Flux régulier → la tranche plancher couvre
    // tout (aucune latence ajoutée) ; rafale → versement continu sur
    // ~350 ms au lieu d'un saut. Le retard visuel est borné et le 'final'
    // recale toujours le texte complet (il reprend _streamBuf).
    const _SMOOTH_WINDOW_MS = 350;
    const _SMOOTH_MIN_CHARS = 24;
    function _smoothTake(buf, dtMs) {
        if (!buf) return 0;
        let take = Math.max(_SMOOTH_MIN_CHARS,
                            Math.ceil(buf.length * dtMs / _SMOOTH_WINDOW_MS));
        if (take >= buf.length) return buf.length;
        // Jamais couper une paire de substitution UTF-16 (sinon U+FFFD
        // clignote en fin de ligne le temps d'un tick).
        const cc = buf.charCodeAt(take - 1);
        if (cc >= 0xD800 && cc <= 0xDBFF) take++;
        return Math.min(take, buf.length);
    }
    let _lastContentFlushTs = 0;

    // ── Rendu markdown LIVE incrémental (claude.ai-like) ──────────────
    // Calcule le patch d'affichage pour un contenu streamé. Les blocs
    // markdown TERMINÉS sont parsés une seule fois (renderMarkdown) et figés
    // (keyés dans le template → Vue ne les retouche pas) ; seul le bloc EN
    // COURS est re-rendu à chaque flush. scanStreamBlocks ne parcourt que le
    // contenu APRÈS _mdCursor → O(nouveau chunk). msg.content reste l'unique
    // source de vérité ; les _md* sont d'affichage, purgés en fin de stream
    // (_STREAM_RENDER_CLEAR) où le 'final' refait le rendu complet
    // (charts/mermaid/copier). Partagé entre le flush et le typewriter.
    // Le bloc ACTIF est re-parsé au plus toutes _ACTIVE_RENDER_MS (découplé de
    // la cadence de flush). À 40 ms de flush, re-parser le bloc en cours à
    // chaque tick = des centaines de marked.parse/s. ~110 ms = ~9 maj/s du
    // texte en cours : visuellement fluide, coût divisé par ~3. Les blocs se
    // figent et le scroll suivent toujours CHAQUE flush. On force aussi un
    // rendu du bloc actif dès qu'un bloc se fige (le contenu actif a changé
    // structurellement → éviter un doublon transitoire).
    const _ACTIVE_RENDER_MS = 110;
    // (2026-09-02) Un état de rendu incrémental par FLUX : le corps (préfixe
    // de champs ``_md``) et la LIGNE LIVE du conteneur (``_pp``, narration /
    // réponse d'un tour à outils) partagent le moteur mais ont chacun leur
    // horodatage de throttle et leur drapeau de rattrapage.
    const _liveRenderTs    = { _md: 0, _pp: 0 };
    const _liveRenderDirty = { _md: false, _pp: false };

    // Caret de streaming INJECTÉ dans le flux du dernier bloc (AUDIT
    // 2026-08-31). Le <span> frère du gabarit tombait dans une boîte de bloc
    // anonyme SOUS le paragraphe (les wrappers display:contents remontent le
    // <p> au niveau du .markdown-body, et `.markdown-body p` porte 1em de
    // marge basse) : le rectangle clignotait une ligne sous le texte au lieu
    // de suivre le dernier caractère. On l'insère avant la fermeture la plus
    // profonde de niveau texte ; le span du gabarit ne sert plus que de repli
    // quand il n'y a pas de bloc actif (entre deux blocs).
    const _CARET_HTML = '<span class="elpis-stream-caret" aria-hidden="true"></span>';
    function _injectCaret(html) {
        if (!html) return html;
        const s = html.replace(/\s+$/, '');
        let m = /<\/code><\/pre>$/i.exec(s);                    // bloc de code actif
        if (!m) m = /<\/(?:p|li|h[1-6]|td|th|blockquote|pre)>(?:\s*<\/(?:ul|ol|li|table|thead|tbody|tr|td|th|blockquote|div)>)*$/i.exec(s);
        if (m) return s.slice(0, m.index) + _CARET_HTML + s.slice(m.index);
        return s + _CARET_HTML;                                 // texte nu (repli échappé)
    }

    // Moteur commun : ``P`` = préfixe des champs d'état sur le message
    // (``_md`` → _mdBlocks/_mdScanPos/_mdFence/_mdBlockStart/_mdActiveHtml,
    // ``_pp`` → _ppBlocks/…). Retourne le patch d'affichage pour ``text``.
    // ``caret`` : le corps porte le curseur de streaming ; la ligne live du
    // conteneur N'EN A PAS (demande utilisateur 2026-09-02).
    function _applyIncrementalRender(cur, text, P, caret = true) {
        let blocks = cur[P + 'Blocks'] || null;
        const scan = scanStreamBlocks(text, cur[P + 'ScanPos'] || 0, !!cur[P + 'Fence'], cur[P + 'BlockStart'] || 0);
        const finalized = scan.blocks.length > 0;
        if (finalized) {
            blocks = (blocks || []).slice();
            for (const bmd of scan.blocks) blocks.push({ i: blocks.length, html: renderStreamBlock(bmd) });
        }
        const patch = {};
        patch[P + 'Blocks']     = blocks;
        patch[P + 'ScanPos']    = scan.scanPos;
        patch[P + 'Fence']      = scan.fence;
        patch[P + 'BlockStart'] = scan.blockStart;
        const now = Date.now();
        if (finalized || (now - _liveRenderTs[P]) >= _ACTIVE_RENDER_MS) {
            const _html = renderStreamingActive(text.slice(scan.blockStart));
            patch[P + 'ActiveHtml'] = caret ? _injectCaret(_html) : _html;
            _liveRenderTs[P] = now;
            _liveRenderDirty[P] = false;
        } else {
            // Object.assign préserve l'ActiveHtml courant (texte en cours en
            // retard ≤110 ms) — rattrapé par le tick suivant dès que le
            // buffer est vide (cf. _catchUpRender).
            _liveRenderDirty[P] = true;
        }
        return patch;
    }
    // (correctif 2026-09-02) Le throttle laissait le bloc actif en RETARD si
    // le buffer se vidait dans la fenêtre des 110 ms sans nouvel event : la
    // fin de la phrase restait invisible jusqu'au prochain token — plusieurs
    // secondes quand le modèle enchaîne sur la génération des arguments d'un
    // appel d'outil. Rattrapage : re-rendu du bloc actif depuis le texte
    // complet, appelé par le tick de flush du flux quand son buffer est vide.
    function _catchUpRender(cur, text, P, caret = true) {
        _liveRenderDirty[P] = false;
        _liveRenderTs[P] = Date.now();
        const patch = {};
        const _html = renderStreamingActive(text.slice(cur[P + 'BlockStart'] || 0));
        patch[P + 'ActiveHtml'] = caret ? _injectCaret(_html) : _html;
        return patch;
    }
    function _applyStreamRender(cur, content) {
        return Object.assign({ content, isStreaming: true },
                             _applyIncrementalRender(cur, content, '_md'));
    }
    // Ligne live du conteneur « Travail de l'assistant » : MÊME rendu
    // markdown incrémental que le corps (avant : texte brut interpolé, qui ne
    // devenait du markdown qu'au gel dans le segment — « brut puis interprété »).
    function _applyPreRender(cur, text) {
        return Object.assign({ _pendingPreContent: text },
                             _applyIncrementalRender(cur, text, '_pp', false));
    }
    const _PRE_RENDER_CLEAR = { _ppBlocks: null, _ppActiveHtml: '', _ppScanPos: 0, _ppFence: false, _ppBlockStart: 0 };

    function _streamFlushTick() {
        _streamFlushTimer = null;
        let len = 0;
        if (!_streamBuf.length && _liveRenderDirty._md) {
            const m = _getStreamMsgs();
            const i = _streamIdx(m);
            if (i >= 0 && m[i] && m[i].isStreaming) {
                const cur = m[i];
                const content = cur.content || '';
                len = content.length;
                m[i] = Object.assign({}, cur, _catchUpRender(cur, content, '_md'));
            } else {
                _liveRenderDirty._md = false;
            }
        }
        if (_streamBuf.length) {
            // Tranche lissée (cf. _smoothTake) : dt réel écoulé, borné pour
            // qu'une reprise après pause (tool call) ne vide pas tout d'un
            // coup — le versement reste continu.
            const now = Date.now();
            const dt = _lastContentFlushTs ? Math.min(150, now - _lastContentFlushTs) : 40;
            _lastContentFlushTs = now;
            const take = _smoothTake(_streamBuf, dt);
            const chunk = _streamBuf.slice(0, take);
            _streamBuf = _streamBuf.slice(take);
            const m = _getStreamMsgs();
            const i = _streamIdx(m);
            if (i >= 0) {
                const cur = m[i];
                const content = (cur.content || '') + chunk;
                len = content.length;
                // Lecture automatique : la voix suit le texte AFFICHÉ, pas les
                // octets bruts du réseau. Le son démarre donc à la première
                // phrase complète, pas à la fin de la réponse.
                try { _voiceMod.onAssistantStream(content); } catch (e) { console.error('[voix]', e); }
                m[i] = Object.assign({}, cur, _applyStreamRender(cur, content));
                if (!isUserScrolling.value && chatContainer.value) {
                    _vsEnsureTail();
                    _scheduleStreamScroll();
                }
            }
        }
        _streamFlushTimer = setTimeout(_streamFlushTick, _streamFlushDelay(len));
    }

    function _armStreamFlush() {
        if (!_streamFlushTimer) _streamFlushTimer = setTimeout(_streamFlushTick, 40);
    }

    function _stopStreamFlush() {
        if (_streamFlushTimer) { clearTimeout(_streamFlushTimer); _streamFlushTimer = null; }
        _liveRenderTs._md    = 0;   // prochain stream : 1er bloc actif rendu d'emblée
        _lastContentFlushTs  = 0;   // prochain stream : dt lissé repart du nominal
        _liveRenderDirty._md = false;
    }

    // Nettoyage des champs d'affichage du rendu live incrémental — à étaler
    // dans CHAQUE patch qui termine ou réinitialise un stream (le rendu
    // v-else markdown reprend la main sur ``content``, source de vérité ;
    // libère aussi les HTML des blocs figés). _mdBlocks=null → le v-for
    // streaming ne rend rien.
    const _STREAM_RENDER_CLEAR = { _mdBlocks: null, _mdActiveHtml: '', _mdScanPos: 0, _mdFence: false, _mdBlockStart: 0 };

    // ===========================================================
    //  @MENTION FEATURE
    // ===========================================================

    // The composer + @mention helpers (formerly here, lines 387-597) are
    // now in static/js/chat/_compose.js. Setup is done at the top of
    // ``setupChat`` via ``window.setupChatCompose(...)``.

    // ===========================================================
    //  MARKDOWN / EXPORT / CHART / MERMAID / SVG  (extracted)
    //
    //  Pure transforms (text → HTML, DOM → enhanced DOM). No shared
    //  state mutation, no network calls. Moved to static/js/chat/_rendering.js
    //  to shrink this file. Self-contained -- replaceable without touching
    //  chat logic. See that module's header for the full contract.
    // ===========================================================
    const _rendering = window.setupChatRendering(vue, {
        messages, currentChatId, user, settings,
        inputRef, chatContainer, currentChatTitle,
    }, ctx);
    const {
        renderMarkdown, renderMarkdownHighlight, handleMarkdownClick, clearMarkdownCache,
        scanStreamBlocks, renderStreamingActive, renderStreamBlock, renderMarkdownLive,
        clearChartInstances, sweepOrphanCharts,
        autoResize,
        showExportFormatMenu, exportChatAs,
        addCodeCopyButtons,
    } = _rendering;

    // re-post-traiter les <pre> recréés par le
    // virtual scroll. Quand une conv dépasse VS_THRESHOLD, le windowing
    // démonte/remonte des messages au scroll ; Vue recrée alors leur DOM
    // depuis le markdown brut, SANS repasser par addCodeCopyButtons. Sans
    // ce watch, les graphiques (Chart.js / Mermaid / SVG / chart-ref) qui
    // reviennent dans la fenêtre réapparaissaient en TEXTE BRUT et les
    // blocs de code perdaient leur bouton Copier. On observe la fenêtre
    // (premier/dernier index visible) et on relance le post-traitement :
    // il est idempotent grâce au garde data-cb-done, donc seuls les <pre>
    // fraîchement recréés sont retraités. ``processAll=true`` car le scope
    // par défaut ne cible que le dernier message rendu.
    watch(
        () => visibleMessages.value.length
              ? (visibleMessages.value[0].idx + ':' + visibleMessages.value[visibleMessages.value.length - 1].idx)
              : '',
        () => { nextTick(() => addCodeCopyButtons(true)); }
    );

    // Recherche in-chat (AUDIT 2026-08-31) : chaque bascule du surlignage
    // réécrit l'innerHTML des lignes visibles (v-memo →
    // renderMarkdownHighlight / renderMarkdown) → le DOM enrichi après coup
    // (Chart.js, Mermaid, SVG, header de langue, bouton Copier) était DÉTRUIT
    // sans AUCUN chemin de restauration : un graphique restait du JSON brut,
    // définitivement sous le seuil de virtualisation (la fenêtre ne bouge pas
    // en tapant). On re-post-traite à chaque bascule du miroir debouncé —
    // idempotent grâce au garde data-cb-done.
    watch([messageSearchActive, messageSearchQ],
          () => { nextTick(() => addCodeCopyButtons(true)); });

    // Compteur de résultats : c'était une expression INLINE du template
    // (filter + toLowerCase sur TOUTE la conversation), réévaluée à chaque
    // re-render racine tant que la barre était ouverte. Computed sur le
    // miroir debouncé : recalcul uniquement quand la requête change.
    const messageSearchCount = computed(() => {
        const q = (messageSearchQ.value || '').toLowerCase();
        if (!q) return 0;
        return messages.value.filter(
            m => m.content && m.content.toLowerCase().includes(q)).length;
    });


    // ===========================================================
    //  STREAM EVENT HANDLER
    // ===========================================================

    // -- Thinking title (extracted to chat/_thinking_title.js) ----
    // Pures fonctions de transformation texte (zéro state). Utilisées
    // par ``_flushThinkBuf`` pour générer un titre humain depuis le
    // raisonnement LLM (affiché dans la status bar pendant le thinking).
    const _thinkingTitleMod = window.setupChatThinkingTitle();
    const { _thinkingTitle, _cap } = _thinkingTitleMod;

    // ===========================================================
    //  TOOL-CALL DELTA STREAMING
    //
    //  Décode les fragments d'arguments JSON des tool_calls au fur et
    //  à mesure qu'ils arrivent (events `tool_call_delta`) et pilote
    //  streamOpenForWrite / streamLocateEdit / streamWriteChunk du
    //  module editor pour afficher le contenu en temps réel.
    //
    //  Outils supportés (reste fallback silencieux → pas de stream) :
    //    - write_file (mode=write|append) : fichier complet, typewriter
    //    - edit_file  action=str_replace  : scroll + remplace old_str par new_str
    //    - edit_file  action=replace      : scroll ligne start→end, typewriter content
    //    - edit_file  action=insert       : scroll ligne start_line, insertion typewriter
    //
    //  L'état vit dans une Map globale au module (pas réactif, transient).
    //  Clé = `${chatIdOrMsgIdx}:${iter}:${index}` pour supporter streams
    //  concurrents (background + foreground).
    // ===========================================================

    const _toolStreamStates = new Map();
    // Verrouillage par clé pour garantir l'ordre FIFO du traitement des
    // deltas : `_handleToolCallDelta` est async (await sur streamOpenForWrite)
    // et plusieurs deltas peuvent arriver rapidement. Sans queue on risque
    // d'avoir un delta[N+1] qui s'exécute avant que delta[N] ait fini
    // d'ouvrir le stream → chunk inséré à (1,1) au lieu de (curLine,curCol).
    const _toolStreamQueues = new Map();    // key → Promise dernière en cours

    // Ferme (revert) les flux d'écriture Monaco encore ouverts d'UNE
    // conversation et purge leurs états (2026-09-20). Avant, le prologue
    // d'envoi balayait TOUTES les conversations : envoyer un message dans un
    // autre chat faisait revenir en arrière le fichier que le premier chat
    // écrivait encore. Un état porte le chat de son flux (``st.chatId`` =
    // ``data.chat_id`` du serveur, ou ``currentChatId``, ou ``'local'``) ;
    // ``'local'`` et les ids provisoires ``__…`` sont traités comme « sans
    // conversation » et fermés avec n'importe quel appelant.
    function _closeToolStreamsFor(chatId) {
        const cid = chatId == null ? '' : String(chatId);
        const _loose = (v) => !v || v === 'local' || String(v).startsWith('__');
        for (const [k, v] of Array.from(_toolStreamStates.entries())) {
            const own = v && v.chatId;
            if (cid && !_loose(cid) && !_loose(own) && String(own) !== cid) continue;
            if (v && v.opened && !v.failed) {
                try { ctx.streamFinalize(v.path, { success: false }); } catch (_) {}
            }
            _toolStreamStates.delete(k);
            _toolStreamQueues.delete(k);
        }
    }
    // -- JSON streaming helpers (extracted to chat/_helpers_json.js) --
    // 4 fonctions pures (_makeToolStreamKey, _reEsc, _extractJsonScalar,
    // _pullJsonStringField). Pas de state, pas de side effects — utilisées
    // uniquement par _handleToolCallDeltaImpl plus bas.
    const _helpersJson = window.setupChatHelpersJson();
    const {
        _makeToolStreamKey,
        _reEsc,
        _extractJsonScalar,
        _pullJsonStringField,
    } = _helpersJson;


    // -- Misc helpers (extracted to chat/_helpers_misc.js) --------
    // 3 utilitaires bas niveau utilisés par le streaming de tool_calls :
    // _relPath, _prefetchSandboxFile, _recordDiffForMessage. Le
    // sous-module reçoit settings, fetchAuth, et les helpers hoistés
    // (_getStreamMsgs, _patch).
    const _helpersMisc = window.setupChatHelpersMisc(vue,
        { settings },
        { fetchAuth, _getStreamMsgs, _patch }
    );
    const {
        _relPath,
        _prefetchSandboxFile,
        _recordDiffForMessage,
    } = _helpersMisc;

    // Helper : extrait lines_added / lines_removed depuis le payload
    // ``data.result`` d'un tool write_file / edit_file et les stocke
    // dans ``_diffStats[path]`` sur le message de l'assistant. La
    // diff card lit ce champ pour afficher "+12 / -3" à côté du nom
    // du fichier.
    //
    // Best-effort : si le payload n'est pas JSON ou n'a pas ces champs,
    // on no-op silencieusement — la card s'affichera juste avec le nom
    // + le bouton télécharger.
    //
    // Auparavant inline dans la branche "editor master toggle OFF"
    // uniquement. Maintenant aussi appelée par les fallbacks
    // streaming / non-streaming quand le snapshot n'a pas pu être
    // capturé (cf. auto_open_editor_on_write=false).
    // Fichiers modifiés décrits par le serveur (``files`` d'un tool_result ou
    // d'un task_step de sous-agent, 2026-09-26) → ``files_changed`` du
    // message : source des lignes « fichiers modifiés » et de leurs diffs
    // (versions relues dans l'historique de session). Fusion idempotente
    // par chemin (rejeu d'un journal sans effet).
    function _mergeFilesChanged(idx, files) {
        if (!Array.isArray(files) || !files.length || !window.elpisFilesChanged) return;
        const _cur = _getStreamMsgs()[idx];
        if (!_cur) return;
        _patch(idx, { files_changed: window.elpisFilesChanged.mergeFiles(_cur.files_changed, files) });
    }

    function _extractAndStoreDiffStats(idx, path, resultStr) {
        try {
            const parsed = JSON.parse(resultStr || '{}');
            if (parsed && typeof parsed.lines_added === 'number') {
                const _msgs = _getStreamMsgs();
                const _cur  = _msgs[idx];
                if (_cur) {
                    const _prev = _cur._diffStats || {};
                    const _next = Object.assign({}, _prev, {
                        [path]: {
                            additions: parsed.lines_added,
                            deletions: parsed.lines_removed || 0,
                        },
                    });
                    _patch(idx, { _diffStats: _next });
                }
            }
        } catch (_) { /* result non-JSON, on skip */ }
    }

    // -- Diff rows (extracted to chat/_diff_card.js) -------------
    // Lignes "fichiers modifiés" intégrées à la bulle assistant.
    // Stats +/- côté client. Clic ouvre Monaco diff (si éditeur
    // activé) ou bouton download par fichier + zip (si désactivé).
    //
    // ATTENTION : on passe ``ctx`` directement (PAS ``...ctx``) parce
    // que ses propriétés sont des getters lazy-résolus à l'accès. Un
    // spread les évaluerait MAINTENANT, capturant ``editorMod=undefined``
    // (les modules sont initialisés en cascade et editorMod n'existe
    // pas encore quand setupChat tourne).
    const _diffCardMod = (typeof window.setupChatDiffCard === 'function')
        ? window.setupChatDiffCard(vue, { settings }, ctx)
        : {};
    const {
        diffCardState,
        resetDiffCardState,
        diffCardRev,
        diffFilesFor,
        hasDiffFiles,
        isDiffEditorEnabled,
        onDiffRowClick,
        downloadOneFile,
        downloadAllFilesAsZip,
    } = _diffCardMod;

    // -- Ligne "sauvegardé en mémoire" (extracted to chat/_memory_card.js) --
    // Rendue à la place de l'appel d'outil `memory` brut. Live only (dérive de
    // toolSteps). Fallback inerte si le module n'est pas chargé (ex. admin).
    const _memCardMod = (typeof window.setupChatMemoryCard === 'function')
        ? window.setupChatMemoryCard(vue, { settings, currentChatId }, ctx)
        : { memorySavesFor: () => [], effectLinesFor: () => [],
            toolStepsForDisplay: (s) => (Array.isArray(s) ? s : []),
            effectIsOpen: () => false, effectDetail: () => null, toggleEffect: () => {},
            undoMemoryEffect: () => {}, manageMemory: () => {}, effectUiRev: vue.ref(0) };
    const { memorySavesFor, effectLinesFor, toolStepsForDisplay, effectIsOpen, effectDetail,
            toggleEffect, undoMemoryEffect, manageMemory, effectUiRev } = _memCardMod;

    // -- « Détails » d'une réponse : chronologie de son exécution (L5.3) --
    // chat/_run_details.js ; fallback inerte si le module n'est pas chargé.
    const _runDetailsMod = (typeof window.setupRunDetails === 'function')
        ? window.setupRunDetails(vue, ctx)
        : { runDetails: vue.ref(null), openRunDetails: () => {}, closeRunDetails: () => {},
            showRunDetails: () => {}, toggleRunEvent: () => {}, runDuration: () => '',
            runEventLabel: () => '', runEventMeta: () => '', runEventState: () => 'ok',
            runClock: () => '', runExportHref: () => '#' };

    // -- Segments texte/outils (helpers partagés live + reload) ------------
    // chat/_tool_segments.js : labels RAG + détection d'erreur = source
    // UNIQUE pour les handlers live ci-dessous ET la reconstruction au
    // loadChat (_history.js). Fallback inerte si le module n'est pas chargé.
    const _toolSegs = window.elpisToolSegments || {
        ragCallLabel: () => '', ragResultLabel: () => '',
        resultIsError: () => false, parseToolHistorySegments: () => null,
    };

    // -- Message edit (extracted to chat/_message_edit.js) --------
    // Refs editingMessageIndex / editMessageText + 3 fonctions
    // (start/cancel/submit). ``scrollToBottom`` et ``generateResponse``
    // sont des function declarations hoistées — les passer ici est sûr,
    // la résolution se fait au moment de l'appel effectif. Ce bloc vit
    // APRÈS _diffCardMod : submitEditMessage purge les diff cards via
    // resetDiffCardState (les index de messages sont réutilisés après
    // troncature) — avant ce déplacement, la clé n'était jamais passée
    // et la purge était un no-op silencieux (stats +/- périmées).
    const _msgEditMod = window.setupChatMessageEdit(
        vue,
        { messages, isStreaming, isUserScrolling },
        { scrollToBottom, generateResponse, openConfirm, resetDiffCardState, sweepOrphanCharts }
    );
    const {
        editingMessageIndex,
        editMessageText,
        startEditMessage,
        cancelEditMessage,
        submitEditMessage,
    } = _msgEditMod;

    // Entry point appelé depuis handleStreamEvent quand data.type === 'tool_call_delta'.
    // Sérialise le traitement par clé pour garantir l'ordre de curseur Monaco.
    function _handleToolCallDelta(data, chatId, noOpen) {
        const key = _makeToolStreamKey(chatId, data.iter, data.index);
        const prev = _toolStreamQueues.get(key) || Promise.resolve();
        const next = prev.then(
            () => _handleToolCallDeltaImpl(data, chatId, noOpen),
            () => _handleToolCallDeltaImpl(data, chatId, noOpen),  // swallow previous rejection
        );
        _toolStreamQueues.set(key, next);
        // Nettoyage : quand la dernière promise de cette clé est fulfilled,
        // on retire l'entrée pour éviter de retenir des closures inutilement.
        next.finally(() => {
            if (_toolStreamQueues.get(key) === next) {
                _toolStreamQueues.delete(key);
            }
        });
        return next;
    }

    async function _handleToolCallDeltaImpl(data, chatId, noOpen) {
        if (!settings.value.enable_editor) return;
        const key = _makeToolStreamKey(chatId, data.iter, data.index);
        let st = _toolStreamStates.get(key);
        // ``noOpen`` = REJEU d'un journal (chantier C, 2026-09-16) : ces
        // écritures sont déjà faites sur le disque — on n'ouvre pas l'éditeur
        // en streaming pour les rejouer (un stream déjà OUVERT, lui, continue
        // jusqu'à son tool_result). (passe 9, F4) — « ouvert », pas « connu » :
        // l'état existe dès le premier fragment de nom, bien avant l'ouverture
        // de Monaco.
        if (noOpen && !(st && st.opened)) return;
        if (!st) {
            st = {
                key, chatId, iter: data.iter, index: data.index,
                nameBuf: '', argsBuf: '',
                toolName: '', toolKind: null,   // 'write' | 'edit' | null (non-write tool)
                path: null, relPath: null,
                mode: null, action: null,
                oldStrState: null, oldStr: null,
                startLine: null, endLine: null,
                opened: false, failed: false,
                streamFieldState: null,         // état du pull progressif content/new_str
                streamField: null,              // 'content' | 'new_str'
            };
            _toolStreamStates.set(key, st);
        }
        if (st.failed) return;

        // ── 1. Accumulation ─────────────────────────────────────────
        if (data.name_delta) st.nameBuf += data.name_delta;
        if (data.args_delta) st.argsBuf += data.args_delta;

        // ── 2. Détection du type d'outil (dès que le nom est stable) ─
        if (!st.toolKind && st.nameBuf) {
            const n = st.nameBuf;
            // On attend un nom qui correspond à un outil connu. Les noms des
            // tools MCP peuvent être préfixés (ex: "fs__write_file") : on
            // match sur le suffixe.
            if (/(^|_)write_file$/.test(n))      { st.toolKind = 'write'; st.toolName = 'write_file'; }
            else if (/(^|_)edit_file$/.test(n))  { st.toolKind = 'edit';  st.toolName = 'edit_file';  }
            else if (st.argsBuf.length > 0 || n.length > 40) {
                // Le nom est figé (args commencent → nameBuf n'évoluera plus)
                // ET ne matche aucun outil d'écriture → abandon définitif.
                // On garde l'entrée dans la Map mais `failed=true` → deltas
                // suivants ignorés. La purge à final/error nettoiera.
                st.failed = true; return;
            }
        }
        if (!st.toolKind) return;   // pas encore identifié, on attend

        // ── 3. Extraction des champs scalaires ──────────────────────
        // Passe d'optimisation 2026-09-26 — UNIQUEMENT avant l'ouverture.
        // L'ouverture attend le marqueur du champ streamé (content / new_str),
        // donc tous les scalaires qui le précèdent sont déjà connus ; après,
        // ces extractions (``mode`` d'un write_file qui n'en a pas,
        // ``start_line`` d'un str_replace…) re-parcouraient TOUT argsBuf à
        // chaque delta : O(n²) sur un gros fichier streamé.
        if (!st.opened) {
        if (!st.path) {
            const p = _extractJsonScalar(st.argsBuf, 'path');
            if (p && p.type === 'string') {
                st.path    = p.value;
                st.relPath = _relPath(p.value);
            }
        }
        if (st.toolKind === 'write' && !st.mode) {
            const mo = _extractJsonScalar(st.argsBuf, 'mode');
            if (mo && mo.type === 'string') st.mode = mo.value.toLowerCase();
        }
        if (st.toolKind === 'edit' && !st.action) {
            const ac = _extractJsonScalar(st.argsBuf, 'action');
            if (ac && ac.type === 'string') st.action = ac.value.toLowerCase();
        }
        if (st.toolKind === 'edit') {
            if (st.startLine === null) {
                const sl = _extractJsonScalar(st.argsBuf, 'start_line');
                if (sl && sl.type === 'number') st.startLine = sl.value;
            }
            if (st.endLine === null) {
                const el = _extractJsonScalar(st.argsBuf, 'end_line');
                if (el && el.type === 'number') st.endLine = el.value;
            }
            if (st.oldStr === null && st.action === 'str_replace') {
                // Décodage progressif pour ne pas bloquer le parse si old_str
                // est très long — on pull-drain jusqu'à completion.
                if (!st.oldStrState) st.oldStrState = {};
                const r = _pullJsonStringField(st.argsBuf, 'old_str', st.oldStrState);
                if (r.found && r.complete) {
                    // Reconstruit la valeur complète via cursor (le state
                    // interne ne stocke pas tout, on re-decode en une passe).
                    // Approche plus simple : refaire un _extractJsonScalar
                    // maintenant que l'on sait qu'il est complet.
                    const os = _extractJsonScalar(st.argsBuf, 'old_str');
                    if (os && os.type === 'string') st.oldStr = os.value;
                }
            }
        }
        }   // fin « avant l'ouverture »

        // ── 4. Décision d'ouverture du stream ───────────────────────
        //
        // Astuce : on attend que le marker du champ à streamer (content /
        // new_str) apparaisse dans argsBuf AVANT d'ouvrir. Ça garantit que
        // tous les scalaires qui précèdent ont été émis par le LLM, et donc
        // que st.mode / st.action / st.startLine sont déjà extraits (ou
        // confirmés absents). Sans ça, pour write_file({path, mode:"append",
        // content}), on ouvrirait AVANT d'avoir vu mode → on partirait en
        // mode=write par défaut et l'append serait perdu.
        if (!st.opened && !st.failed && st.path) {
            // Pour edit_file : on doit connaître l'action AVANT de décider
            // quel champ sera streamé (str_replace → new_str ; autres →
            // content). Sans ce check, on cherchait le marker "content":
            // pour str_replace et on ne l'ouvrait jamais.
            if (st.toolKind === 'edit' && !st.action) return;
            const streamFieldName = (st.toolKind === 'edit' && st.action === 'str_replace')
                ? 'new_str' : 'content';
            // Regex compilée une fois, testée sur la QUEUE du tampon seulement
            // (la partie déjà examinée ne contenait pas le marqueur ; on
            // recouvre 64 caractères pour un marqueur coupé entre deux deltas).
            if (st._markerFor !== streamFieldName) {
                st._markerFor = streamFieldName;
                st._markerRe = new RegExp('"' + _reEsc(streamFieldName) + '"\\s*:\\s*"');
                st._markerScan = 0;
            }
            const hasStreamMarker = st._markerRe.test(
                st.argsBuf.slice(Math.max(0, st._markerScan - 64)));
            st._markerScan = st.argsBuf.length;
            if (!hasStreamMarker) return;   // pas encore prêt, attendre plus de deltas
            let opened = false;
            if (st.toolKind === 'write') {
                // Mode = 'write' par défaut si non encore parsé (le champ
                // peut arriver plus tard — on ne bloque pas l'ouverture
                // puisque le mode par défaut côté backend EST 'write').
                const mode = st.mode || 'write';
                if (mode === 'b64' || mode === 'mkdir') {
                    st.failed = true; return;    // pas de stream pour binaire/mkdir
                }
                let preload = null;
                if (mode === 'append') {
                    // Si le modèle existe déjà (user a ouvert le fichier),
                    // son contenu est utilisé tel quel par streamOpenForWrite.
                    // Sinon on prefetch pour que l'append parte du bon offset.
                    const models = ctx.models;
                    const existing = models && models[st.path] && !models[st.path].isDisposed();
                    if (!existing) {
                        preload = await _prefetchSandboxFile(st.path);
                    }
                }
                st.streamField = 'content';
                opened = await ctx.streamOpenForWrite(st.path, {
                    append: (mode === 'append'),
                    preloadContent: preload,
                });
            } else if (st.toolKind === 'edit') {
                if (!st.action) return;   // attendre l'action
                if (st.action === 'delete') {
                    st.failed = true; return;   // delete = instantané, pas de stream
                }
                // Prefetch si le fichier n'est pas ouvert : indispensable
                // pour str_replace (findMatches sur old_str) et utile pour
                // replace/insert (positionnement sur le BON numéro de ligne).
                let preload = null;
                {
                    const models = ctx.models;
                    const existing = models && models[st.path] && !models[st.path].isDisposed();
                    if (!existing) {
                        preload = await _prefetchSandboxFile(st.path);
                        if (preload === null) {
                            // Fichier non fetché (n'existe pas, 404, etc.) :
                            // on laisse le flux tool_result gérer.
                            st.failed = true; return;
                        }
                    }
                }
                if (st.action === 'str_replace') {
                    // Il faut old_str COMPLET avant de pouvoir localiser.
                    if (st.oldStr === null) return;
                    st.streamField = 'new_str';
                    opened = await ctx.streamLocateEdit(st.path, {
                        action:         'str_replace',
                        old_str:        st.oldStr,
                        preloadContent: preload,
                    });
                } else if (st.action === 'replace') {
                    if (st.startLine === null || st.endLine === null) return;
                    st.streamField = 'content';
                    opened = await ctx.streamLocateEdit(st.path, {
                        action:         'replace',
                        start_line:     st.startLine,
                        end_line:       st.endLine,
                        preloadContent: preload,
                    });
                } else if (st.action === 'insert') {
                    if (st.startLine === null) return;
                    st.streamField = 'content';
                    opened = await ctx.streamLocateEdit(st.path, {
                        action:         'insert',
                        start_line:     st.startLine,
                        preloadContent: preload,
                    });
                } else {
                    // action inconnue → fallback
                    st.failed = true; return;
                }
            }
            // (passe 9, F3) — l'état a pu être PURGÉ pendant les await
            // (final/erreur/nouveau tour) : un stream ouvert sur un état
            // détaché serait invisible de toutes les purges → Monaco
            // verrouillé (« ÉCRITURE… ») jusqu'au rechargement. On referme.
            if (_toolStreamStates.get(key) !== st) {
                if (opened) { try { ctx.streamFinalize(st.path, { success: false }); } catch (_) {} }
                return;
            }
            if (opened) {
                st.opened = true;
                st.streamFieldState = {};
                // Toast subtil pour l'user
                showToast('Édition : ' + (st.relPath || st.path) + '…');
            } else {
                // streamOpen/Locate a retourné false → fallback silencieux
                // sur le flux tool_result classique. Marque failed pour ne
                // plus essayer sur les deltas suivants.
                st.failed = true;
                return;
            }
        }

        // ── 5. Pull progressif du champ streamé ─────────────────────
        if (st.opened && st.streamField && st.streamFieldState) {
            const r = _pullJsonStringField(st.argsBuf, st.streamField, st.streamFieldState);
            if (r.chunk) {
                ctx.streamWriteChunk(st.path, r.chunk);
            }
            // Pour edit_file insert avec start_line=0 : prepend. Une fois
            // le stream complet, ajouter un '\n' final si besoin pour
            // pousser le contenu existant sur une nouvelle ligne.
            if (r.complete && st.toolKind === 'edit' && st.action === 'insert'
                && Number(st.startLine) === 0) {
                // Heuristique : si le chunk ne se termine pas par \n, ajoute-en un
                if (r.chunk && !r.chunk.endsWith('\n')) {
                    ctx.streamWriteChunk(st.path, '\n');
                }
            }
        }
    }

    // Clôture le stream associé à un tool_result. Appelé depuis
    // handleStreamEvent quand tool_result arrive. Récupère la state à
    // partir de la Map (dernier tool_call_delta émis) et invoque
    // streamFinalize avec le succès + le contenu final côté serveur.
    async function _finalizeToolStream(data, chatId, noOpen, opts) {
        // (passe 8, F2) — plus de garde ici : l'appelant décide (un stream
        // ouvert est clos même pendant un rejeu).
        // Attendre que les queues de deltas pour ce chat soient drainées :
        // un tool_result peut arriver alors que _handleToolCallDeltaImpl
        // est encore en cours (await sur streamOpenForWrite). On drain
        // uniquement les queues liées à ce chat (plusieurs streams
        // parallèles possibles en théorie).
        const chatQueues = [];
        for (const [k, p] of _toolStreamQueues.entries()) {
            if (k.startsWith((chatId || 'local') + ':')) chatQueues.push(p);
        }
        if (chatQueues.length) {
            try { await Promise.all(chatQueues.map(p => p.catch(() => {}))); } catch(_) {}
        }

        // Back-end flow : pour une itération donnée, TOUS les deltas arrivent
        // AVANT le premier tool_result. Puis chaque tool s'exécute en série,
        // émettant tool_call → tool_result. Donc quand ce tool_result arrive
        // il concerne le stream le plus ANCIEN non-finalisé qui matche le
        // nom de l'outil. On itère dans l'ordre FIFO (iter ASC, index ASC).
        const resultToolName = (data.name || '').toLowerCase();
        const entries = [...(_toolStreamStates.entries())]
            .filter(([, v]) => v.chatId === chatId && v.opened && !v.failed)
            .sort(([, a], [, b]) =>
                (a.iter - b.iter) || (a.index - b.index)
            );

        let bestKey = null, best = null;
        for (const [k, v] of entries) {
            // Match lâche sur le nom (les outils MCP peuvent être préfixés).
            const n = (v.toolName || '').toLowerCase();
            if (!n || resultToolName.endsWith(n) || n.endsWith(resultToolName)) {
                best = v; bestKey = k; break;
            }
        }
        // Fallback : si aucun match par nom, on prend juste le plus ancien
        // (défense en profondeur — certains serveurs MCP renomment les tools).
        if (!best && entries.length > 0) {
            bestKey = entries[0][0]; best = entries[0][1];
        }
        if (!best) return { handled: false };

        // Succès / échec : parse le tool result comme ok=true/false si possible
        let ok = true;
        try {
            const p = JSON.parse(opts.resultStr || '{}');
            if (p && p.ok === false) ok = false;
        } catch(_) {}

        const preSnapshot = best.preSnapshot || null;
        const streamPath  = best.path;
        // On supprime l'entrée AVANT d'appeler streamFinalize pour qu'un
        // éventuel tool_call_delta tardif de la même itération (rare) ne
        // retombe pas sur un état zombi.
        _toolStreamStates.delete(bestKey);

        await ctx.streamFinalize(streamPath, {
            success:      ok,
            finalContent: opts.finalContent,
            disk:         opts.disk || null,
        });
        return { handled: true, ok, path: streamPath, preSnapshot };
    }

    // Cleanup : purge les states liés à ce chat (appel à la fin d'un stream
    // de chat, pour éviter la fuite de Map entries si des tool_calls ont failed).
    function _purgeToolStreams(chatId) {
        for (const k of Array.from(_toolStreamStates.keys())) {
            const v = _toolStreamStates.get(k);
            if (!v || v.chatId !== chatId) continue;
            // (passe 8, F1) — un stream encore OUVERT ici n'a jamais reçu son
            // tool_result (tour mort avant l'exécution, plafond d'outils,
            // erreur LLM) : sans streamFinalize, Monaco restait verrouillé
            // (« ÉCRITURE… » permanent, sauvegarde et onglets bloqués,
            // fichier à moitié écrit). Même geste que les trois autres
            // purges : l'éditeur retrouve son état d'avant l'édition.
            if (v.opened && !v.failed) {
                try { ctx.streamFinalize(v.path, { success: false }); } catch (_) {}
            }
            _toolStreamStates.delete(k);
        }
    }

    // (passe 8, F7) — génération des ARGUMENTS d'un appel sans prose visible :
    // aucune pill, engrenage immobile pendant des dizaines de secondes (gros
    // write_file). On pose un libellé de statut (nom d'outil dès qu'il est
    // connu) ; patch SEULEMENT quand le libellé change — les deltas d'args
    // sont fréquents, le nom arrive en un ou deux fragments.
    const _DELTA_STATUS_PREFIX = "Appel d'outil";
    const _deltaNames = new Map();          // 'iter:index' → nom accumulé
    let _deltaStatusLabel = '';
    function _noteDeltaStatus(data, idx) {
        const k = data.iter + ':' + data.index;
        const name = (_deltaNames.get(k) || '') + (data.name_delta || '');
        if (data.name_delta) _deltaNames.set(k, name);
        const label = _DELTA_STATUS_PREFIX + (name ? ' · ' + name : '') + '…';
        if (label === _deltaStatusLabel) return;
        const cur = _getStreamMsgs()[idx];
        if (!cur) return;
        // Un statut backend en place (« Connecté : … ») n'est pas écrasé.
        if (cur._statusLine && !cur._statusLine.startsWith(_DELTA_STATUS_PREFIX)) return;
        _deltaStatusLabel = label;
        _patch(idx, { _statusLine: label });
    }
    function _resetDeltaStatus() { _deltaNames.clear(); _deltaStatusLabel = ''; }

    // (passe 7, H2) — le backend rejoue ou abandonne une itération dont des
    // fragments d'args ont déjà été streamés (event ``tool_call_delta`` avec
    // ``reset:true``) : on jette les accumulateurs de CETTE itération et on
    // rend à l'éditeur son état d'avant l'édition optimiste — sinon le JSON
    // d'args était concaténé deux fois, ou le fichier restait à moitié écrit
    // jusqu'à la fin du tour.
    async function _resetToolStreamsForIter(chatId, iter) {
        // (passe 8, F5) — attendre les deltas encore EN VOL sur ces clés :
        // l'impl async ouvre le stream Monaco APRÈS plusieurs await ;
        // supprimer l'état avant laissait un stream orphelin, invisible de
        // toutes les purges (même course que _finalizeToolStream évite).
        const _pref = chatId + ':' + iter + ':';
        const _inflight = [];
        for (const [k, p] of _toolStreamQueues.entries()) {
            if (String(k).startsWith(_pref)) _inflight.push(p.catch(() => {}));
        }
        if (_inflight.length) { try { await Promise.all(_inflight); } catch (_) {} }
        for (const k of Array.from(_toolStreamStates.keys())) {
            const v = _toolStreamStates.get(k);
            if (!v || v.chatId !== chatId || v.iter !== iter) continue;
            if (v.opened && !v.failed) {
                try { ctx.streamFinalize(v.path, { success: false }); } catch (_) {}
            }
            _toolStreamStates.delete(k);
        }
    }

    async function handleStreamEvent(data) {
        // Rejeu d'un journal (rattachement, chantier C) : les toasts
        // d'événements déjà passés sont tus — ils ont été vus, ou ne
        // concernent plus l'instant présent.
        const showToast = _replaying ? function() {} : ctx.showToast;
        const msgs = _getStreamMsgs();
        const idx  = _streamIdx(msgs);
        if (idx < 0) return;

        // Chat ID assignment
        if (data.chat_id) {
            if (!currentChatId.value
                       && _streamingForChatId === data.chat_id) {
                // n'assigne le chat_id au chat courant que si le
                // stream actif EST ce chat. Sans ce check, un event bufferisé
                // d'un stream précédent (utilisateur qui démarre un nouveau
                // chat avant que l'ancien soit complètement drainé) écrasait
                // currentChatId avec un ID périmé.
                currentChatId.value = data.chat_id;
            }
        }

        if (data.type === 'thinking_token') {
            _stopToolThinkFlush();
            _thinkBuf += data.text || '';
            // DÉBIT seulement : le thinking ne compte PAS dans le contexte (il est
            // strippé de l'historique au tour suivant → l'inclure gonflait la jauge
            // d'un coût éphémère). ``data.n`` (≥2) = tokens agrégés (coalescing NDJSON ;
            // fallback 1 si backend sans coalescing).
            if (_ctxLive) _ctxLive.gen += (data.n || 1);
            _inThinkPhase = true;
            if (!_thinkFlushTimer) {
                _thinkFlushTimer = setInterval(_flushThinkBuf, 100);
            }
            if (idx >= 0) {
                const _c = _getStreamMsgs()[idx];
                if (_c && _c._statusLine) _patch(idx, { _statusLine: '' });
                if (_c && _c._lastToolResultAt) _patch(idx, { _lastToolResultAt: null });
            }

        } else if (data.type === 'content_replace') {
            // Resynchronisation de fin de tour (chemin outils, streaming
            // direct 2026-08-31) : le texte nettoyé côté serveur DIFFÈRE de
            // ce qui a été streamé (markup d'appel d'outil retiré, dialecte
            // de thinking extrait, reprise de prose). On remplace la bulle —
            // le 'final' qui suit ne préfère data.assistant au streamé que
            // s'il est au moins aussi long, il ne peut donc pas corriger un
            // texte RACCOURCI par le nettoyage. Le rendu live est purgé
            // (_STREAM_RENDER_CLEAR) : le scan incrémental suppose un contenu
            // qui ne fait que croître ; le 'final' immédiat re-rend en
            // markdown complet.
            _stopStreamFlush();
            _streamBuf = '';
            // Phase outils (correctif 2026-09-02) : la réponse finale a
            // streamé dans la ligne live du conteneur — on la vide ici, sinon
            // le texte serait affiché en double (ligne + bulle) jusqu'au
            // 'final' qui suit.
            if (_preContentFlushTimer) { clearInterval(_preContentFlushTimer); _preContentFlushTimer = null; }
            _preContentBuf = '';
            if (idx >= 0 && _getStreamMsgs()[idx]) {
                _patch(idx, Object.assign(
                    { content: data.text || '', _pendingPreContent: '' },
                    _STREAM_RENDER_CLEAR, _PRE_RENDER_CLEAR));
            }

        } else if (data.type === 'content_token') {
            _stopThinkFlush();
            _inThinkPhase = false;   // le modèle écrit : le débit redevient lisible
            // Safety : le premier token de contenu signifie que le LLM a pris
            // la main, retire le widget file d'attente s'il était encore là
            // (cas où queue_cleared aurait été perdu). Le widget compression
            // vit sur son propre état (compressionStatus), pas concerné ici.
            if (queueStatus.value) {
                queueStatus.value = null;
            }
            if (idx >= 0) {
                const _c = _getStreamMsgs()[idx];
                if (_c && _c._statusLine) _patch(idx, { _statusLine: '' });
                // Le modèle a repris la main → plus besoin de l'indicateur "en attente"
                if (_c && _c._lastToolResultAt) _patch(idx, { _lastToolResultAt: null });
                // ── Tracking durée du thinking (UX option 3 round 4) ──
                // Premier content_token = fin de la phase thinking. On
                // capture seulement si on avait du thinking ET pas encore
                // de timestamp de fin (idempotent sur le 2e+ token).
                if (_c && _c._thinkingStartedAt && !_c._thinkingEndedAt) {
                    _patch(idx, { _thinkingEndedAt: Date.now() });
                }
            }
            // DÉBIT seulement : la jauge ctx n'additionne plus les tokens
            // streamés — elle n'affiche que le réel serveur (event kv_cache).
            // Le contenu de ce tour apparaîtra dans le prompt réel du suivant.
            if (_ctxLive) _ctxLive.gen += (data.n || 1);
            if (_streamToolPhase) {
                // (correctif 2026-09-02) Tour à outils : le back émet TOUT le
                // contenu d'itération en direct (plus de rejeu tool_thinking),
                // sans savoir s'il s'agit de la narration du prochain appel ou
                // de la réponse finale. Le rendre dans le corps markdown
                // affichait un faux message pleine taille qui disparaissait
                // dans l'accordéon au tool_call suivant (« message interprété
                // bizarre »). Destination : la ligne live du conteneur (texte
                // brut + résumé dans le summary replié) — même canal que
                // l'ancien tool_thinking. Au tool_call, elle rejoint la
                // narration du segment ; au 'final', le corps est posé depuis
                // data.assistant (texte complet, nettoyé côté serveur).
                _preContentBuf += data.text || '';
                if (!_preContentFlushTimer)
                    _preContentFlushTimer = setInterval(_flushPreContentBuf, 40);
                isThinking.value = true;
            } else {
                _stopToolThinkFlush();
                { isThinking.value = false; statusText.value = ''; }
                _streamBuf += data.text || '';
                _armStreamFlush();
            }

        } else if (data.type === 'prompt_progress') {
            // Pré-remplissage : la phase MUETTE d'un tour. Sur un historique
            // long elle dure des minutes, pendant lesquelles rien ne
            // distinguait « ça calcule » de « c'est planté ». Le moteur sait
            // désormais le dire — on l'affiche dans la ligne d'état, sans
            // widget supplémentaire (elle est libérée par le premier token).
            // ⚠ Ni ``statusText`` (bandeau réservé à l'arrière-plan et à la
            // reconnexion) ni un widget à part : la progression s'affiche DANS
            // la pill de statut vivante du message, à côté de « Réflexion… »
            // — c'est le seul endroit que l'utilisateur regarde déjà pendant
            // qu'il attend. Cf. ``statusPhase``.
            // ⚠ Le pourcentage doit vivre SUR LE MESSAGE, pas dans un ref
            // global : le sous-arbre d'un message est mémoïsé (``v-memo`` sur
            // l'identité de ``entry.msg``), donc un état externe ne le re-rend
            // pas — la pill ne serait jamais apparue. ``_patch`` remplace
            // l'objet, ce qui est exactement le signal attendu par le memo.
            if (data.total > 0 && idx >= 0) {
                _patch(idx, {
                    _prefillPct: Math.min(
                        100, Math.round((data.processed / data.total) * 100)),
                });
            }

        } else if (data.type === 'queue_status') {
            // Widget file d'attente de la conversation affichée. Capture le
            // timestamp pour animer une barre de progression côté UI.
            {
                // progress_pct : progression RÉELLE du chargement, poussée par
                // le moteur (llama.cpp ≥ b10545, /models/sse). Absente sur un
                // moteur plus ancien — la barre retombe alors sur l'animation
                // pilotée par l'estimation, comme avant.
                const _pct = (typeof data.progress_pct === 'number')
                    ? Math.max(0, Math.min(100, data.progress_pct))
                    : null;
                const _prev = queueStatus.value;
                queueStatus.value = {
                    kind:       data.kind || 'waiting',
                    model:      data.model || '',
                    loaded:     data.loaded || null,
                    position:   data.position || 1,
                    active:     data.active || 1,
                    est_ms:     data.est_ms || 15000,
                    pct:        _pct,
                    stage:      data.stage || '',
                    stages:     Array.isArray(data.stages) ? data.stages : [],
                    // Conservé d'un événement à l'autre : la progression en
                    // émet un toutes les 200 ms, et repartir de « maintenant »
                    // à chaque fois remettrait l'animation de repli à zéro.
                    started_at: (_prev && _prev.kind === (data.kind || 'waiting'))
                        ? _prev.started_at : Date.now(),
                };
            }

        } else if (data.type === 'queue_cleared') {
            // Slot obtenu côté backend → retire le widget. Le content_token
            // suivant (ou thinking_token) prendra le relais visuellement.
            queueStatus.value = null;

        } else if (data.type === 'todo_updated') {
            // Checklist de session (todowrite) : replace-all, panneau dédié.
            // AUCUN dépliage automatique : l'état plié/déplié appartient à
            // l'utilisateur (l'en-tête du panneau montre déjà la progression
            // N/M et la tâche en cours, même replié).
            todoList.value = Array.isArray(data.todos) ? data.todos : [];
            _todoTouchedThisTurn = true;

        } else if (data.type === 'kv_cache') {
            // Contexte RÉEL : occupation poussée par le backend en FIN de chaque
            // requête LLM, lue dans l'usage du serveur (plus aucun event pré-vol
            // estimé). On met à jour llmHealth.kv_cache (détail KV de la dropdown
            // modèle) ET la base de la jauge live : CHAQUE event kv_cache recale
            // la jauge sur le réel — c'est désormais sa seule source.
            if (typeof data.total === 'number' && data.total > 0) {
                const _kvUsed = Number(data.used) || 0;
                const _kvPct  = (typeof data.pct === 'number')
                    ? data.pct : Math.round((_kvUsed / data.total) * 100);
                // llmHealth décrit le serveur INTÉGRÉ (bloc KV du sélecteur) :
                // un tour sur un connecteur n'y écrit pas ses propres totaux.
                if (!(selectedConnector && selectedConnector.value)) {
                    llmHealth.value = {
                        ...(llmHealth.value || {}),
                        kv_cache: { used: _kvUsed, total: data.total, pct: _kvPct },
                    };
                }
                if (_ctxLive) {
                    _ctxLive.total = data.total;
                    if (_kvUsed > 0) _ctxLive.base = _kvUsed;
                }
                // Bannière « contexte proche du maximum » : occupation réelle
                // du chat courant (réactif, remis à 0 au switch/compaction).
                if (_kvUsed > 0) ctxRealPct.value = _kvPct;
                // Puce « ctx » au repos : la mesure la plus fraîche du tour
                // (le serveur persiste la même en fin de tour).
                if (_kvUsed > 0) ctxUsage.value = { used: _kvUsed, total: data.total, pct: _kvPct };
            }

        } else if (data.type === 'compression_start') {
            // Compression conversationnelle en cours côté backend. Le
            // tool-loop LLM est en PAUSE : plus de "Réflexion..." à
            // afficher. Depuis la refonte, la compression est rendue
            // COMME un tool call, inline dans le flux du message
            // assistant courant — pseudo-step marqué _kind='compression'
            // dans toolSteps, branché en gris par le template.
            //
            // Trois actions :
            //   1. Effacer _statusLine sur le message assistant courant
            //      (sinon "Réflexion en cours..." reste stale).
            //   2. Pousser un pseudo-toolStep _kind='compression' dans
            //      toolSteps du message assistant (rendu en gris sobre).
            //   3. Setter compressionStatus (compat interne) et démarrer
            //      le tick timer qui fait avancer la barre grise du step.
            {
                if (idx >= 0) {
                    const cur = _getStreamMsgs()[idx];
                    if (cur && cur._statusLine) _patch(idx, { _statusLine: '' });
                }
                // Plus d'indicateur "thinking" pendant la compression :
                // le step compression prend le relais visuellement.
                isThinking.value = false;
                statusText.value = '';

                const pct = (data.ctx_size && data.tokens)
                    ? Math.round(data.tokens / data.ctx_size * 100)
                    : 0;
                const path = data.path || 'self';
                const est_ms = _estimateCompressionMs(path);
                const started_at = Date.now();

                // ── (2) Pseudo-toolStep injection ─────────────────────────
                //
                // Format aligné sur les vrais tool steps (name, status,
                // args, result) avec un marqueur _kind='compression' qui
                // déclenche les branches de rendu gris dans chat.html.
                // Le marqueur est plus robuste que le nom seul (évite
                // une collision si un MCP externe expose un outil
                // "context_compress").
                if (idx >= 0) {
                    const cur = _getStreamMsgs()[idx];
                    const steps = [...(cur.toolSteps || [])];
                    // Segment d'appartenance (UX entrelacée) : la compression
                    // rejoint le segment courant ; si aucun n'existe encore
                    // (compression avant tout tool_call), on en ouvre un vide.
                    const _segs = (cur.segTexts && cur.segTexts.length) ? cur.segTexts : [''];
                    steps.push({
                        _kind:      'compression',
                        name:       'context_compress',
                        status:     'running',
                        seg:        _segs.length - 1,
                        // Métadonnées du chemin d'appel (affichées dans le
                        // panneau de détail quand le step est cliqué)
                        path:       path,
                        external:   !!data.external,
                        model:      data.model || '',
                        // État de la conversation au moment du déclenchement
                        turns:      data.turns || 0,
                        tokens:     data.tokens || 0,
                        ctx_size:   data.ctx_size || 0,
                        pct:        pct,
                        // Timing pour la barre de progression
                        est_ms:     est_ms,
                        started_at: started_at,
                        progress:   0,
                        // Alignement de shape avec les autres steps
                        args:       null,
                        result:     null,
                        // stats sera renseigné au compression_done
                        stats:      null,
                    });
                    _patch(idx, {
                        toolSteps: steps,
                        ...((cur.segTexts && cur.segTexts.length) ? {} : { segTexts: _segs }),
                    });
                }

                // ── (3) Ref globale (compat interne) + tick timer ─────────
                //
                // compressionStatus/compressionProgress ne sont plus
                // rendues comme widget séparé (l'ancien bloc amber a été
                // retiré du template), mais restent reactive :
                //   - Sert de flag "compression in flight" pour le tick
                //     timer (early exit si null).
                //   - msg_idx permet au done handler de retrouver le
                //     step à clôturer même si idx a changé entre-temps.
                compressionStatus.value = {
                    path:       path,
                    external:   !!data.external,
                    model:      data.model || '',
                    turns:      data.turns || 0,
                    tokens:     data.tokens || 0,
                    ctx_size:   data.ctx_size || 0,
                    pct:        pct,
                    est_ms:     est_ms,
                    started_at: started_at,
                    msg_idx:    idx,
                };
                _startCompressionTick(idx);
            }

        } else if (data.type === 'compression_done') {
            // Le backend a fini. Workflow UX :
            //   1. On enregistre la durée réelle dans l'historique (pour
            //      l'estimation des prochaines compressions, moving-median
            //      par path).
            //   2. On finalise le pseudo-toolStep inline dans le message
            //      assistant : status='done', progress=100, stats embed.
            //      C'est ce qui remplace la pill grise "context_compress"
            //      par une version "done" avec icône check et résumé
            //      compact des économies de tokens.
            //   3. Si la compression a été tentée mais pas appliquée
            //      (no_token_gain, summary_invalid_format, llm_error…), le
            //      step passe en 'skipped' avec une raison FR lisible.
            //      AVANT : le step était retiré en silence — l'utilisateur
            //      voyait « Compression… » disparaître sans explication et
            //      croyait la compression appliquée.
            //   4. On clôture le tick timer et on reset les refs globales.
            const stats = data.stats || {};
            if (stats.compressed && stats.duration_ms) {
                _recordCompressionDuration(stats.path || 'self', stats.duration_ms);
            }

            // ── (2)/(3) Finalisation du step inline ──────────────────────
            // On privilégie msg_idx mémorisé dans compressionStatus plutôt
            // que `idx` courant : entre start et done, idx peut avoir
            // bougé (rare mais possible sur des streams entrelacés).
            const targetIdx = (compressionStatus.value && typeof compressionStatus.value.msg_idx === 'number')
                ? compressionStatus.value.msg_idx
                : idx;
            if (typeof targetIdx === 'number' && targetIdx >= 0) {
                try {
                    const _msgs = _getStreamMsgs();
                    const cur = _msgs && _msgs[targetIdx];
                    if (cur && Array.isArray(cur.toolSteps)) {
                        const newSteps = cur.toolSteps.slice();
                        for (let i = newSteps.length - 1; i >= 0; i--) {
                            const st = newSteps[i];
                            if (st && st._kind === 'compression' && st.status === 'running') {
                                if (stats.compressed) {
                                    // Step finalisé : statut done, progress
                                    // à 100 % pour la transition visuelle
                                    // avant que la barre disparaisse (elle
                                    // n'est rendue qu'en statut 'running'),
                                    // stats embed pour le détail panel.
                                    newSteps[i] = Object.assign({}, st, {
                                        status:   'done',
                                        progress: 100,
                                        stats:    stats,
                                    });
                                } else {
                                    // Compression tentée mais NON appliquée :
                                    // statut 'skipped' + raison lisible (pill
                                    // grise/ambre, pas de barre). La conversation
                                    // continue avec les messages originaux.
                                    newSteps[i] = Object.assign({}, st, {
                                        status:      'skipped',
                                        progress:    0,
                                        stats:       stats,
                                        reasonLabel: _comprSkipLabel(stats.reason),
                                    });
                                }
                                _patch(targetIdx, { toolSteps: newSteps });
                                break;
                            }
                        }
                    }
                } catch (_) { /* non-fatal */ }
            }

            // ── (4) Clôture état global ──────────────────────────────────
            _stopCompressionTick();
            compressionProgress.value = 0;
            compressionStatus.value = null;

            // Log console discret pour les cas "pas appliqué" inattendus
            // (utile au debug ; pas de toast UX — l'info vit dans le step).
            if (!stats.compressed && stats.reason) {
                if (!['threshold_not_reached', 'nothing_to_compress', 'disabled', 'not_run'].includes(stats.reason)) {
                    console.warn('[compression] not applied:', stats.reason);
                }
            }

        } else if (data.type === 'compression_capped') {
            // Cap de compressions atteint pour CE chat : badge près de la
            // jauge + bouton manuel désactivé. Émis par le backend seulement
            // quand une compression AURAIT eu lieu (pas de spam).
            compressionCapped.value = {
                round: Number(data.round) || 0,
                max:   Number(data.max)   || 0,
            };

        } else if (data.type === 'thinking' || data.type === 'mode') {
            isThinking.value = true; statusText.value = data.text || '';
            if (idx >= 0) {
                const _st = data.text || '';
                // 'Réflexion...' est filtré (thinking inline), on ne touche pas _statusLine
                // pour ne pas effacer le message de connexion précédent
                const _skip = !_st || _st === 'Réflexion...';
                if (!_skip) {
                    const _cur = _getStreamMsgs()[idx];
                    if (_cur && _cur._statusLine !== _st)
                        _patch(idx, { _statusLine: _st });
                }
            }

        } else if (data.type === 'thinking_content') {
            _stopThinkFlush();
            const _tcCur = _getStreamMsgs()[idx];
            // Cohérence visuelle (refonte cartes agents) : plié par défaut,
            // même à la première arrivée — on ne touche jamais thinkingOpen
            // (le choix d'ouverture appartient à l'utilisateur, même logique
            // que _flushThinkBuf).
            const _tcPatch = { thinking: data.text || '' };
            // ── Tracking durée du thinking (UX option 3 round 4) ──────
            // Capture le timestamp du PREMIER thinking_content : on sert
            // de point de départ pour calculer combien de temps le modèle
            // a passé à réfléchir avant de produire du content. Le ts de
            // fin sera capturé dans le handler content_token (premier
            // delta) ou dans 'final' en fallback.
            if (_tcCur && !_tcCur._thinkingStartedAt) {
                _tcPatch._thinkingStartedAt = Date.now();
            }
            _patch(idx, _tcPatch);

        } else if (data.type === 'final') {
            _stopThinkFlush();
            _stopToolThinkFlush();
            // Fige l'occupation ctx finale (dernier RÉEL serveur du tour) AVANT
            // de détruire _ctxLive : alimente le snapshot du message + le seed
            // du tour suivant.
            if (_ctxLive && _ctxLive.base > 0) {
                _lastCtxUsed = _ctxLive.base;
            }
            _clearLiveCtx();   // fin du stream : on retire la ligne de stats live
            // Le tour vient d'être persisté (avec un éventuel nouveau round de
            // compression) : rafraîchit l'état du bouton « Compresser ».
            refreshCompressionState();
            _stopStreamFlush();
            const cur      = msgs[idx];
            // Purge des streams d'outils éventuellement restés actifs. Le cas
            // normal a déjà été traité dans chaque tool_result (finalize) ;
            // ici on catch les cas tordus : erreur LLM au milieu d'un
            // tool_call, tool_limit atteint avant tool_result, etc.
            const _streamChatIdFinal = data.chat_id || currentChatId.value || 'local';
            _purgeToolStreams(_streamChatIdFinal);
            // (Le titre (re)généré par le modèle — payload additif `title` —
            // est appliqué plus bas, avec le flash de renommage.)
            // Clear pending sur TOUS les screenshots (le spinner "capture..." doit disparaître
            // dès que la génération est terminée, même si un blob n'a jamais résolu).
            if (cur.webScreenshots && cur.webScreenshots.length) {
                for (const s of cur.webScreenshots) s.pending = false;
            }
            let streamed = (cur.content || '') + _streamBuf; _streamBuf = '';
            // (correctif 2026-09-02) phase outils : la réponse finale a streamé
            // dans la LIGNE LIVE du conteneur (_pendingPreContent, drainée par
            // _stopToolThinkFlush ci-dessus), pas dans le corps — c'est elle le
            // « streamé » de ce tour (repli si ``assistant`` manque ou est plus
            // court, comme pour le corps).
            if (_streamToolPhase && !streamed.trim() && (cur._pendingPreContent || '').trim()) {
                streamed = cur._pendingPreContent;
            }
            // data.assistant = source de vérité du backend
            let finalContent = (data.assistant && data.assistant.length >= streamed.length)
                ? data.assistant : (streamed || data.assistant || '');

            const hasMCPSteps   = !!(cur.toolSteps && cur.toolSteps.length > 0);
            let finalThinking = hasMCPSteps
                ? (cur.thinking || '')           // avec steps : seulement les vrais tokens de reasoning
                : (cur.thinking || data.thinking || (data.metrics && data.metrics.thinking) || '');

            // ── Filet « réponse piégée dans le thinking » (défense en profondeur) ──
            // Le backend dé-route désormais la réponse hors du thinking (cf.
            // _thinking_reconcile : recovery classic + run_chat_multi_mcp). Ce filet
            // côté client couvre les cas résiduels / anciens flux : si le tour s'est
            // terminé SANS prose visible mais AVEC du raisonnement et SANS steps
            // d'outil, la réponse est en fait coincée dans le bloc thinking (que le
            // template re-titrerait « Réponse »). On la promeut en réponse visible et
            // on vide le bloc thinking pour ne pas l'afficher en double.
            //
            // GATE truncated_in_think (bug « le thinking déborde dans le chat ») :
            // quand le backend signale une coupure par plafond EN PLEIN
            // raisonnement, ce texte n'est PAS une réponse — le promouvoir
            // l'affichait en markdown dans la bulle (bloc Réflexion vidé).
            // Règle : un think non fermé en fin de stream est finalisé tel quel,
            // jamais promu ni jeté ; la bannière « Continuer » (isTruncated,
            // armé par data.truncated) reprend la main avec resume_thinking.
            const truncInThink = !!data.truncated_in_think;
            if (!hasMCPSteps && !truncInThink
                    && !String(finalContent || '').trim() && String(finalThinking || '').trim()) {
                finalContent  = finalThinking;
                finalThinking = '';
            }
            const autoExpand    = !finalContent && !!finalThinking;

            // ── Snapshot KV cache figé dans le message ─────────────
            // = dernière occupation RÉELLE mesurée par le serveur pendant ce tour
            // (event kv_cache de fin de requête, prompt réel sans le thinking).
            // On NE prend PAS llmHealth.kv_cache (KV physique du slot, qui inclut
            // le thinking transitoire) ni last_completion_tokens : c'est ce qui
            // donnait "4,7k en fin de tour" alors que le prompt du tour suivant
            // (thinking strippé) ne faisait que ~800. Sans source → pas de pill.
            let _kvSnapshot = null;
            // n_ctx pour la pill figée du message : local uniquement (cf.
            // _ctxGaugeApplicable). Via un connecteur, on n'a pas le bon n_ctx →
            // pas de pill (0) plutôt qu'un pourcentage faux.
            const _nCtxSnap = !_ctxGaugeApplicable() ? 0 : (_getCtxSize()
                || (llmHealth.value && llmHealth.value.kv_cache && llmHealth.value.kv_cache.total)
                || (llmHealth.value && llmHealth.value.props && llmHealth.value.props.n_ctx) || 0);
            // Source PRIMAIRE : dernier réel serveur du tour (_lastCtxUsed).
            // Fallback (chat rechargé / erreur précoce) : last_prompt_tokens
            // = prompt réel, DÉJÀ sans le thinking des tours passés — on N'AJOUTE PAS
            // last_completion_tokens (qui contient le thinking du tour courant).
            let _used = _lastCtxUsed > 0 ? _lastCtxUsed : 0;
            if (!_used) {
                const _m = data.metrics || {};
                if (typeof _m.last_prompt_tokens === 'number')      _used = _m.last_prompt_tokens;
                else if (typeof _m.input_tokens === 'number')       _used = _m.input_tokens;
            }
            if (_used > 0 && _nCtxSnap > 0) {
                _kvSnapshot = {
                    used:  Math.min(_used, _nCtxSnap),
                    total: _nCtxSnap,
                    pct:   Math.min(100, Math.round((_used / _nCtxSnap) * 100)),
                };
            }
            const _baseMetrics = data.metrics || cur.metrics || {};
            const _mergedMetrics = _kvSnapshot
                ? { ..._baseMetrics, kv_cache: _kvSnapshot }
                : _baseMetrics;

            // Questionnaire interactif (outil ask_user) : intercepté sur
            // l'événement tool_call, le panneau ne s'OUVRE qu'à la fin du
            // tour (sinon l'utilisateur répondrait pendant le stream).
            if (_pendingAskUser) {
                // La conversation AFFICHÉE est forcément celle du tour : quitter
                // une conversation arrête la lecture de son flux (chantier C).
                askUserPanel.value = { items: _pendingAskUser, idx: 0 };
                _pendingAskUser = null;
            }

            _patch(idx, {
                content:              finalContent,
                thinking:             finalThinking,
                thinkingOpen:         autoExpand,
                // Coupure en plein raisonnement : titre « Réflexion
                // interrompue » (chat.html) + resume_thinking projeté au
                // persist/continue (cf. _projectForPersist).
                thinkingTruncated:    truncInThink,
                _pendingPreContent:   '',  // nettoyage
                ..._PRE_RENDER_CLEAR,
                _pendingToolThinking: '',  // compat
                _liveThinkingOpen:    undefined,
                _statusLine:          '',
                metrics:              _mergedMetrics,
                isStreaming:          false,
                ..._STREAM_RENDER_CLEAR,
                // FIX : avant, isTruncated ne dépendait QUE de
                // tool_limit_reached. Un tour ANNULÉ par l'utilisateur
                // (le backend émet alors un final avec ``cancelled:true``)
                // n'était donc pas marqué tronqué → le bouton
                // « Continuer » n'apparaissait pas en session, alors que
                // le backend a bien persisté un partiel continuable.
                // On honore désormais aussi ``data.cancelled`` ET
                // ``data.truncated`` (coupure par plafond de tokens,
                // finish=length) — le cas le plus courant de réponse
                // continuable, jusqu'ici jamais signalé.
                isTruncated:          !!data.tool_limit_reached || !!data.cancelled || !!data.truncated,
                // Exécutions du message (``runs``) : liste FUSIONNÉE par le
                // serveur (un « Continuer » y ajoute la sienne).
                run_ids:              (Array.isArray(data.run_ids) && data.run_ids.length)
                                          ? data.run_ids : (cur.run_ids || null),
                // Fallback durée thinking : si on a démarré sans qu'un
                // content_token soit jamais arrivé (ex: réponse 100 %
                // thinking, pas de body), on clôture ici. Idempotent si
                // déjà set par content_token.
                ...(cur._thinkingStartedAt && !cur._thinkingEndedAt
                    ? { _thinkingEndedAt: Date.now() }
                    : {}),
                // tool_history : séquence OpenAI structurée des tool_calls/
                // tool_results du tour qui vient de s'arrêter avant sa
                // réponse finale (limit/erreur/cancel). Persistée sur le
                // message assistant pour que le bouton "Continuer"
                // retrouve son contexte agentic complet et le ré-envoie
                // au backend, qui l'expand dans le payload LLM. Sans ça,
                // un Continue voit le LLM générer une "réponse pré-tools"
                // car il n'a aucune trace des outils déjà appelés.
                tool_history:         (data.metrics && data.metrics.tool_history)
                                          || cur.tool_history
                                          || null,
                // Marqueur de format DELTA : suit la même source que
                // tool_history (metrics du tour, sinon valeur déjà portée).
                // Sans lui, un Continue live re-posterait un delta non
                // marqué → dédup legacy côté serveur + heuristiques de
                // frontière côté parseur de segments.
                tool_history_delta:   (data.metrics && data.metrics.tool_history)
                                          ? !!data.metrics.tool_history_delta
                                          : !!cur.tool_history_delta,
                // Distinction UX : si la coupure vient d'un tool-loop qui a
                // atteint le plafond d'itérations, on a plus d'infos
                // (nb de tools exécutés, plafond) pour afficher un message
                // clair. Sans ça, l'utilisateur voit juste "réponse
                // interrompue" sans comprendre que c'était une boucle
                // d'outils qui a coupé, pas le LLM qui a fini sa phrase.
                toolLoopTruncated:    !!data.tool_limit_reached,
                // `iterations` = itérations PRODUCTIVES, seule grandeur homogène à
                // `max_iterations` (le compteur dur monte jusqu'à 2× le budget et
                // donnait des couples du type « 100/50 »).
                toolLoopStats: data.tool_limit_reached ? {
                    iterations:      data.tool_limit_effective_iters
                                     || data.metrics?.tool_limit_effective_iters
                                     || data.tool_limit_iters || data.metrics?.tool_limit_iters || 0,
                    hard_iterations: data.tool_limit_iters   || data.metrics?.tool_limit_iters || 0,
                    max_iterations:  data.tool_limit_max     || data.metrics?.tool_limit_max   || 0,
                    tool_calls_done: data.tool_limit_calls   || data.metrics?.tool_limit_calls || 0,
                    // Cause fine (steps | hard | wallclock | ctx_saturated |
                    // gen_cap | cycle | empty_choices) → libellé du bandeau.
                    stop_reason:     data.metrics?.tool_limit_stop_reason || '',
                } : null,
            });
            // Liste consolidée du serveur (fusion du tour) : fusionnée à ce
            // que le direct a accumulé — un « Continuer » garde ainsi les
            // fichiers du segment précédent de la même bulle.
            _mergeFilesChanged(idx, data.files_changed);

            {
                _markRunDone(data.chat_id || _streamingForChatId || currentChatId.value);
                if (data.chat_id) currentChatId.value = data.chat_id;
                // Todo-list, fin de tour :
                //   * toutes les tâches soldées (completed/cancelled) → le
                //     panneau disparaît (travail fini) ;
                //   * tâches ouvertes mais liste TOUCHÉE ce tour (ou tour
                //     annulé par l'utilisateur : le modèle n'a pas eu sa
                //     chance) → on garde la liste, panneau REPLIÉ — hors
                //     génération l'en-tête N/M suffit, le chat reste lisible,
                //     et l'utilisateur peut redéplier d'un clic ;
                //   * tâches ouvertes et liste IGNORÉE tout le tour → liste
                //     abandonnée par le modèle, le panneau disparaît (elle
                //     reste dans meta_json ; recharger le chat la ré-affiche).
                try {
                    if (todoList.value.length) {
                        if (todoList.value.every(
                                t => t.status === 'completed' || t.status === 'cancelled')) {
                            todoList.value = [];
                        } else if (_todoTouchedThisTurn || data.cancelled) {
                            todoPanelOpen.value = false;
                        } else {
                            todoList.value = [];
                        }
                    }
                } catch (_) {}
                // Update sidebar and header title from server — avec flash de
                // renommage (header + entrée sidebar) : le titre vient d'être
                // généré par le modèle, on rend le changement perceptible.
                if (data.title) {
                    const _renamed = data.title !== currentChatTitle.value;
                    currentChatTitle.value = data.title;
                    const entry = chats.value.find(c => String(c.id) === String(currentChatId.value));
                    if (entry) entry.title = data.title;
                    if (_renamed) _flashRenamedTitle(entry);
                }
                isThinking.value = false; statusText.value = ''; isStreaming.value = false;
                nextTick(() => { scrollToBottom(); addCodeCopyButtons(); loadAvailableModels(); });
                // a11y — la fin de génération n'avait AUCUN
                // signal pour les lecteurs d'écran (le texte arrive token par
                // token, illisible en live). Annonce unique au final.
                if (ctx.announce) ctx.announce(data.cancelled ? 'Génération interrompue' : 'Réponse terminée');
                // Reste de la réponse à lire. ``data.cancelled`` distingue un
                // Stop d'une fin normale : on ne lit pas une génération que
                // l'utilisateur vient d'interrompre.
                try { _voiceMod.onAssistantFinal(finalContent, !!data.cancelled); } catch (e) { console.error('[voix]', e); }
            }

            // Mode plan ONE-SHOT : le serveur a coupé le mode en fin de tour
            // (le plan est rendu). Miroir local + toast.
            if (data.plan_mode_done) {
                planMode.value = false;
                showToast('Plan rendu — mode plan terminé, outils rétablis.', 'info');
            }

            // persistance : le backend signale via ``persisted === false``
            // que la réponse N'A PAS été sauvegardée (collision cross-user / panne
            // DB). Sans ce toast, l'UI affichait un faux succès et la réponse était
            // perdue au rechargement. Toast non bloquant invitant à la recopier.
            if (data.persisted === false) {
                showToast(
                    data.persist_error === 'collision'
                        ? 'Réponse non sauvegardée (conflit de chat). Copiez-la avant de recharger.'
                        : 'Réponse non sauvegardée (erreur base). Copiez-la avant de recharger.',
                    'error'
                );
            }

        } else if (data.type === 'tool_call_delta' && data.reset) {
            // (passe 7, H2) — itération rejouée/abandonnée côté backend : purge
            // des accumulateurs de cette itération (cf. _resetToolStreamsForIter).
            try {
                await _resetToolStreamsForIter(data.chat_id || currentChatId.value || 'local', data.iter);
            } catch (_e) {
                console.warn('[tool_call_delta] reset error — silent fallback', _e);
            }
            // (passe 8, F3) — l'itération est REJOUÉE côté backend : sa
            // narration, déjà streamée (queue relâchée au 1er delta) et
            // basculée dans la ligne live, va être ré-émise → on la purge,
            // sinon elle se concatène (doublon figé dans le segment, ou
            // réponse finale dupliquée qui l'emporte sur data.assistant).
            // Sans step encore posé, on revient au routage « corps » du
            // round 1. (_pendingPreContent est vidé à chaque tool_call : tout
            // ce qu'il contient ici appartient bien à l'itération avortée.)
            if (_preContentFlushTimer) { clearInterval(_preContentFlushTimer); _preContentFlushTimer = null; }
            _preContentBuf = '';
            // (passe 9, F10) — noms d'outil accumulés pour la pill (F7) :
            // le rejeu de l'itération les re-concaténait (« write_filewrite_file… »).
            for (const _k of Array.from(_deltaNames.keys())) {
                if (_k.startsWith(data.iter + ':')) _deltaNames.delete(_k);
            }
            _deltaStatusLabel = '';
            if (idx >= 0 && msgs[idx]) {
                if (msgs[idx]._pendingPreContent) {
                    _patch(idx, Object.assign({ _pendingPreContent: '' }, _PRE_RENDER_CLEAR));
                }
                if (!(msgs[idx].toolSteps && msgs[idx].toolSteps.length)) _streamToolPhase = false;
            }

        } else if (data.type === 'tool_call_delta') {
            // (correctif 2026-09-02) Premier signal FIABLE que l'itération se
            // conclut en tool_calls — le modèle a fini sa prose et commence à
            // générer l'appel. Au round 1 (avant tout step) la destination du
            // contenu était inconnue : il a streamé dans le corps markdown. On
            // le bascule TOUT DE SUITE dans la ligne live du conteneur (le
            // tool_call, lui, n'arrive qu'après la génération complète des
            // args — plusieurs secondes pour un write_file volumineux, pendant
            // lesquelles le faux « message » restait affiché). Le tool_call
            // trouve ensuite le texte dans _pendingPreContent et l'intègre à
            // la narration du segment (chemin déjà existant).
            if (!_streamToolPhase) {
                _streamToolPhase = true;
                _stopStreamFlush();
                const _fMsgs = _getStreamMsgs(), _fIdx = _streamIdx(_fMsgs);
                const _fCur  = _fIdx >= 0 ? _fMsgs[_fIdx] : null;
                const _body  = ((_fCur && _fCur.content) || '') + _streamBuf;
                _streamBuf = '';
                if (_fCur && _body) {
                    // (passe 8, F15) — corps composé de blancs seulement : on
                    // le purge quand même (sinon un bloc vide gardait le caret
                    // sous le conteneur), sans rien ajouter à la ligne live.
                    const _pre = _body.trim() ? (_fCur._pendingPreContent || '') + _body : null;
                    _fMsgs[_fIdx] = Object.assign({}, _fCur,
                        _pre !== null ? _applyPreRender(_fCur, _pre) : {},
                        { content: '' }, _STREAM_RENDER_CLEAR);
                    if (_pre !== null) isThinking.value = true;
                }
            }
            _noteDeltaStatus(data, idx);      // (passe 8, F7)
            // Fragments d'args d'un tool_call en cours de génération par le LLM.
            // On pilote le streaming live dans Monaco (write_file / edit_file).
            // Best-effort : toute erreur ici ne doit PAS casser le stream du chat.
            // Les erreurs sont confinées à `_handleToolCallDelta` ; on garde
            // un try/catch au cas où (défense en profondeur).
            try {
                const _streamChatId = data.chat_id || currentChatId.value || 'local';
                await _handleToolCallDelta(data, _streamChatId, _replaying);
            } catch (_e) {
                console.warn('[tool_call_delta] parse/stream error — silent fallback', _e);
            }

        } else if (data.type === 'tool_call') {
            _toolsExecutedThisTurn = true;   // audit 2026-08-02 (W3)
            _streamToolPhase = true;         // (2026-09-02) provider sans tool_call_delta
            _deltaStatusLabel = '';          // (passe 8, F7) prochaine itération : nouveau libellé
            _inThinkPhase = false;           // exécution d'outil ≠ réflexion
            const toolName = data.name || '';
            const isRagTool = toolName.startsWith('rag_');

            // Outil ask_user : stashe le questionnaire — le panneau au-dessus
            // de la barre de prompt s'ouvrira au 'final' (fin du tour).
            if (toolName === 'ask_user') {
                const _qs = _normalizeAskUser(data.args && data.args.questions);
                if (_qs) _pendingAskUser = _qs;
            }

            const cur = msgs[idx];
            const steps = [...(cur.toolSteps || [])];
            // stepThinking lu après flush dans le patch tool_call

            // Sous-agent (outil `task`) : rendu à PART du panneau outils (carte
            // agent persistante, cf. msg.taskRuns) — le step reste dans toolSteps
            // marqué `_kind:'task'` (apparié par tool_result, exclu de
            // l'affichage générique comme les steps mémoire). Les events
            // `task_step` de l'enfant mettent à jour le run (corrélation par
            // `id`, assigné au 1er event).
            const isTaskTool = (toolName === 'task');
            let taskAgent = '', taskLabel = '', taskPrompt = '';
            if (isTaskTool && data.args) {
                taskAgent  = data.args.subagent_type || 'agent';
                taskLabel  = data.args.description || '';
                taskPrompt = data.args.prompt || '';
            }

            // Friendly label for RAG tools (helper partagé avec le reload)
            const ragLabel = isRagTool ? _toolSegs.ragCallLabel(toolName, data.args) : '';

            _stopToolThinkFlush();
            // Flush du buffer de THINKING (throttle 100 ms) AVANT de lire
            // _srcMsg.thinking plus bas : sans ça, le raisonnement émis juste
            // avant le tool_call pouvait rester dans _thinkBuf → step.thinking
            // vide selon le timing du tick (course visible au harnais toolseg,
            // check « thinking retenu sur le step »).
            _stopThinkFlush();
            // -- Flush du stream buffer avant tool_call ----------------------
            // Le modèle peut avoir écrit du texte AVANT d'appeler l'outil
            // Ex: "Je vais chercher X..." → ce texte doit apparaître AU-DESSUS des tools
            _stopStreamFlush();
            const _preToolText = (msgs[idx].content || '') + _streamBuf;
            _streamBuf = '';
            if (_preToolText.trim()) {
                // Le texte bascule dans segTexts (nouveau segment, ci-dessous).
                // _STREAM_RENDER_CLEAR : on remet content='' → il FAUT purger les
                // blocs de rendu live, sinon la narration pré-outil resterait
                // affichée en double (blocs figés) après le passage en tool_call.
                msgs[idx] = Object.assign({}, msgs[idx], {
                    content: '',
                }, _STREAM_RENDER_CLEAR);
            }

            const _srcMsg          = msgs[idx];
            // -- Segments entrelacés (UX 2026-07-20) -------------------------
            // La narration du round (content streamé + _pendingPreContent,
            // la ligne live de la phase outils) OUVRE un nouveau segment ; les tool
            // calls suivants du même round trouvent des buffers vides et
            // rejoignent donc le segment courant (segTexts.length - 1).
            const _narrParts = [];
            if (_preToolText.trim()) _narrParts.push(_preToolText.trim());
            if ((_srcMsg._pendingPreContent || '').trim()) _narrParts.push(_srcMsg._pendingPreContent.trim());
            const _narr = _narrParts.join('\n\n');
            const segTexts = [...(cur.segTexts || [])];
            if (_narr) segTexts.push(_narr);
            if (!segTexts.length) segTexts.push('');
            // _srcMsg.thinking : tokens de raisonnement réels (DeepSeek-R1, Qwen3, etc.) → bloc caché
            const stepThinkingFlushed = _srcMsg.thinking || '';
            const stepThinkingOpen    = false; // toujours fermé : seul le thinking en cours (msg.thinking) est ouvert
            // Sauvegarde mémoire (outil `memory` mutant) → marquée `_kind:'memory'`
            // pour être SORTIE du panneau « outils » générique (comme les steps de
            // compression) et rendue en ligne titrée (cf. chat/_memory_card.js).
            const _isMemSave = (toolName === 'memory' && data.args
                && ['add', 'replace', 'remove', 'rewrite'].includes(String(data.args.action || '').toLowerCase()));
            // Liste de tâches (todowrite) : rendue en ligne « Tâches N/M » sous
            // le travail de l'assistant, pas comme un outil (2026-09-19).
            const _isTodoWrite = (toolName === 'todowrite');
            // Steps EXCLUS de la liste d'outils (carte agent / lignes d'effets) :
            // leur ``step.thinking`` ne serait rendu nulle part — le
            // raisonnement pré-appel reste donc sur le message (sans cela la
            // réflexion d'un modèle qui planifie puis appelle todowrite en
            // premier disparaissait de tout le direct).
            const _keepThinkingOnMsg = isTaskTool || _isMemSave || _isTodoWrite;
            steps.push({
                name: toolName, args: data.args, result: null,
                status: 'running',
                // call_id backend : corrélation fiable des events par appel
                // (shell_output — deux execute_shell parallèles partagent le
                // même name). Absent sur les vieux backends → repli par nom.
                callId: data.call_id || null,
                seg: segTexts.length - 1,          // segment d'appartenance
                // Task : le step est EXCLU de l'affichage (carte agent à part)
                // → son thinking serait invisible ; on le laisse sur le message.
                thinking:     _keepThinkingOnMsg ? '' : stepThinkingFlushed,
                thinkingOpen: stepThinkingOpen,
                isRag: false, ragLabel: ragLabel,
                ...(_isMemSave ? { _kind: 'memory' } : {}),
                ...(_isTodoWrite ? { _kind: 'todo' } : {}),
                ...(isTaskTool ? { _kind: 'task' } : {}),
            });
            // Carte agent persistante : un run par appel `task`, alimenté ensuite
            // par les events `task_step` (id assigné au 1er event de l'enfant).
            const _newTaskRuns = isTaskTool
                ? [...(cur.taskRuns || []), {
                      id: null, agent: taskAgent, label: taskLabel,
                      prompt: taskPrompt,
                      state: 'running', tokens: 0, steps_total: 0,
                      tools: [], progress: null,
                  }]
                : undefined;
            // Mémoire et task : pas de libellé de statut live (chacun a son
            // propre affichage dédié — ligne mémoire / carte agent), sinon
            // doublon avec la pill de tool en cours.
            const _runLabel = isRagTool ? ragLabel : ((_isMemSave || _isTodoWrite || isTaskTool) ? '' : toolName);
            _patch(idx, {
                _pendingPreContent:   '',
                ..._PRE_RENDER_CLEAR,
                _pendingToolThinking: '',  // compat ancienne version
                // Transféré dans step.thinking — SAUF pour `task` (step exclu de
                // l'affichage) : le raisonnement pré-appel reste sur le message.
                thinking:          _keepThinkingOnMsg ? stepThinkingFlushed : '',
                thinkingOpen:      false,
                _liveThinkingOpen: undefined,
                _statusLine: _runLabel,
                toolSteps: steps,
                segTexts,
                ...(_newTaskRuns ? { taskRuns: _newTaskRuns } : {}),
                // (passe 6, F1) — plus de ``events`` : état réactif MORT
                // (aucun lecteur, jamais persisté) qui retenait les args puis
                // le RESULT COMPLET de chaque outil pour toute la session.
            });

            // -- Pending flag sur le dernier screenshot si nouveau pw_ appel --
            if (toolName.startsWith('pw_') && (msgs[idx].webScreenshots || []).length > 0) {
                const cur2 = msgs[idx];
                const shots = [...(cur2.webScreenshots || [])];
                const last = shots.length - 1;
                if (shots[last]) shots[last] = { ...shots[last], pending: true };
                _patch(idx, { webScreenshots: shots });
            }

            {
                isThinking.value = true;
                if (isRagTool) {
                    statusText.value = ragLabel;
                } else {
                    statusText.value = toolName;
                    const tn = toolName.toLowerCase();
                    if ((tn.includes('write') || tn.includes('save') || tn.includes('edit'))
                        && data.args && (data.args.path || data.args.filename)) {
                        let rawPath = data.args.path || data.args.filename;
                        const sbRoot = settings.value.sandbox_path_display;
                        if (sbRoot && rawPath.startsWith(sbRoot)) {
                            rawPath = rawPath.substring(sbRoot.length).replace(/^\/+/, '');
                        }
                        pendingWrite.value = { path: rawPath };
                        // Pas de toast ici si un stream est déjà actif sur ce
                        // path — le toast "Édition : …" a déjà été montré au
                        // premier tool_call_delta (évite le doublon).
                        const alreadyStreaming = ctx.isStreamActive && ctx.isStreamActive(rawPath);
                        if (!alreadyStreaming) {
                            showToast('Édition : ' + rawPath + '...');
                        }
                    }
                }
            }
            // Auto-scroll après l'ajout du step : garde le dernier tool_call
            // visible quand le modèle en enchaîne plusieurs. Respecte
            // isUserScrolling : si l'user a remonté pour lire un step plus
            // haut, on ne lui arrache pas le viewport.
            nextTick(() => scrollToBottom());

        } else if (data.type === 'tool_result') {
            const toolName = data.name || '';
            const isRagTool = toolName.startsWith('rag_');

            // ── Tool error detection (UX) ─────────────────────────────────
            // Two error shapes flow through the wire:
            //
            //  (A) Legacy chaos error from _execute_single_tool_call when a
            //      tool raises an exception : ``{"error": "<msg>"}`` — one
            //      key, no ``ok`` field.
            //
            //  (B) Structured envelope from ``tools/_toolkit.err()`` (v17+)
            //      and from the typed Union returns (v19+) :
            //      ``{"ok": false, "error": "<code>", "message": "<txt>",
            //         "fix": "...", "next_action": "...", "retryable": true}``
            //
            // Until v19 the FE only recognized (A) — the red pill never lit
            // up for the structured envelope, which is the COMMON case.
            // Now we recognize both (helper partagé avec le reload).
            const _isErrorResult = _toolSegs.resultIsError(data.result);

            const cur = msgs[idx];
            const steps = [...(cur.toolSteps || [])];

            // Friendly result summary for RAG tools (helper partagé)
            const ragResultLabel = isRagTool ? _toolSegs.ragResultLabel(toolName, data.result) : '';

            // Mark step as done. Appariement par call_id d'abord (fiable pour
            // les appels PARALLÈLES du même outil — le matching par nom
            // attribuait le 1er résultat au DERNIER step running) ; replis :
            // nom+running, puis dernier running (anciens backends sans call_id).
            const _finishStep = (st) => {
                const upd = { ...st, result: data.result, status: 'done', ragResultLabel: ragResultLabel, _is_error: _isErrorResult };
                // Terminal en direct : si rien n'a été streamé (réglage OFF
                // au backend, vieux serveur…), remplit la console depuis le
                // résultat (même helper que le reload). Best-effort : le
                // résultat de l'event est coupé à 2000 chars → un gros JSON
                // ne parse pas, le reload complet prendra le relais.
                if (upd.name === 'execute_shell' && !upd.shellDone) {
                    const shf = _toolSegs.shellFieldsFromResult
                        ? _toolSegs.shellFieldsFromResult(data.result) : null;
                    if (shf) {
                        upd.shellDone = true;
                        upd.shellRc = shf.shellRc;
                        upd.shellMs = shf.shellMs;
                        if (shf.shellOut != null && upd.shellOut == null) upd.shellOut = shf.shellOut;
                    }
                }
                return upd;
            };
            let patched = false;
            if (data.call_id) {
                for (let i = steps.length - 1; i >= 0; i--) {
                    if (steps[i].callId === data.call_id && steps[i].status === 'running') {
                        steps[i] = _finishStep(steps[i]);
                        patched = true; break;
                    }
                }
            }
            if (!patched) {
                for (let i = steps.length - 1; i >= 0; i--) {
                    if (steps[i].name === toolName && steps[i].status === 'running') {
                        steps[i] = _finishStep(steps[i]);
                        patched = true; break;
                    }
                }
            }
            if (!patched) {
                for (let i = steps.length - 1; i >= 0; i--) {
                    if (steps[i].status === 'running') {
                        steps[i] = _finishStep(steps[i]);
                        break;
                    }
                }
            }
            // (passe 6, F1) — un SEUL _patch (le second, qui accumulait
            // ``events`` avec le result COMPLET de l'outil, doublait le
            // re-render de la ligne à chaque résultat — pour un état mort).
            _patch(idx, { toolSteps: steps, _statusLine: '' }); // clear : outil terminé

            // -- Live web screenshot (Playwright tools) -- carousel ------
            // STRATÉGIE: on télécharge la PNG immédiatement en blob → stocké
            // côté client via URL.createObjectURL. Le serveur peut supprimer
            // la PNG dès qu'elle est servie (1-shot). Les blobs sont gardés
            // tant que le message est affiché, puis revoke() au démarrage
            // d'un nouveau message OU au démontage du composant.
            if (data.screenshot_url && toolName.startsWith('pw_')) {
                const curMsg = msgs[idx];
                // -- Remplacement d'objet via _patch (perf vague 2) ----------
                // Ex-mutation in-place : incompatible avec le v-memo du v-for
                // messages, qui se fie à l'identité de l'objet message pour
                // décider de re-rendre. Un screenshot est un événement rare
                // (1 par tool pw_*) : le re-render de la ligne est acceptable.
                // Clear pending sur les anciens (copie), puis append du nouveau.
                const prevShots = (curMsg.webScreenshots || []).map(
                    s => s.pending ? { ...s, pending: false } : s
                );
                const newShot = {
                    blobUrl: null,
                    serverUrl: data.screenshot_url,
                    tool:    toolName,
                    stepIdx: steps.length - 1,
                    step:    data.screenshot_step || (prevShots.length + 1),
                    sid:     data.screenshot_session || null,
                    ts:      Date.now(),
                    args:    (steps[steps.length - 1] || {}).args || null,
                    pending: true,
                };
                _patch(idx, {
                    webScreenshots: [...prevShots, newShot],
                    webScreenshotIdx: prevShots.length,
                    webScreenshotExpanded: curMsg.webScreenshotExpanded == null
                        ? false : curMsg.webScreenshotExpanded,
                });
                // Fire-and-forget : télécharge la PNG en blob, met à jour le shot.
                // on capture l'identité du chat au moment du fetch.
                // Si l'utilisateur change de chat pendant le download, _getStreamMsgs()
                // pointe sur un autre tableau (ou messages.value a été remplacé) et
                // on créait un blob orphelin sans jamais le révoquer. On vérifie que
                // (a) on est toujours sur le même chat et (b) le message cible existe
                // toujours avec ses webScreenshots — sinon revoke immédiatement.
                const _idx = idx;
                const _step = newShot.step;
                const _capturedChatId = currentChatId.value;
                (async () => {
                    let url = null;
                    try {
                        const r = await fetchAuth(data.screenshot_url);
                        if (!r || !r.ok) return;
                        const blob = await r.blob();
                        url = URL.createObjectURL(blob);
                        // Garde-fou anti-leak : si on a changé de chat, on jette le blob
                        if (_capturedChatId !== currentChatId.value) {
                            URL.revokeObjectURL(url); url = null; return;
                        }
                        // Retrouver le shot dans le message actuel (peut avoir changé d'index)
                        const m = _getStreamMsgs();
                        const cur = m[_idx];
                        if (!cur || !cur.webScreenshots) {
                            URL.revokeObjectURL(url); url = null; return;
                        }
                        const _ti = cur.webScreenshots.findIndex(s => s.step === _step);
                        if (_ti < 0) {
                            URL.revokeObjectURL(url); url = null; return;
                        }
                        const target = cur.webScreenshots[_ti];
                        // Si target avait déjà un blob (race avec un autre tour), revoke l'ancien
                        if (target.blobUrl) {
                            try { URL.revokeObjectURL(target.blobUrl); } catch(_) {}
                        }
                        // Remplacement d'objet (résolution ASYNC du blob :
                        // sans nouvelle identité de message, le v-memo ne
                        // re-rendrait pas la ligne → spinner bloqué).
                        const _shots = cur.webScreenshots.slice();
                        _shots[_ti] = { ...target, blobUrl: url, pending: false };
                        m[_idx] = Object.assign({}, cur, { webScreenshots: _shots });
                    } catch (e) {
                        // Cleanup en cas d'exception après createObjectURL
                        if (url) { try { URL.revokeObjectURL(url); } catch(_) {} }
                    }
                })();
            }

            if (isRagTool) {
                statusText.value = ragResultLabel;
            }

            // Path du fichier muté : priorité à data.path (désormais porté par
            // le tool_result backend → fiable même quand le modèle émet
            // PLUSIEURS writes dans le même tour). Fallback legacy pendingWrite
            // (ref unique, écrasée en multi-write → ne gardait que le dernier).
            let _evtPath = isRagTool ? null
                : (data.path || (pendingWrite.value && pendingWrite.value.path) || null);
            if (_evtPath) {
                const _sbRoot = settings.value.sandbox_path_display;
                if (_sbRoot && _evtPath.startsWith(_sbRoot)) {
                    _evtPath = _evtPath.substring(_sbRoot.length).replace(/^\/+/, '');
                }
            }
            // Rejeu d'un journal (chantier C) : l'écriture est déjà faite — on
            // ne traite QUE la clôture d'un stream Monaco encore ouvert pour ce
            // fichier (pas de relecture de fichier ni de carte de diff pour un
            // tour passé).
            const _replayStreamOpen = _replaying && !!_evtPath
                && !!(ctx.isStreamActive && ctx.isStreamActive(_evtPath));
            if ((!_replaying || _replayStreamOpen) && !isRagTool) {
                const tn = toolName.toLowerCase();
                // Essai à blanc (``dry_run``) : rien n'a été écrit. Un flux
                // éventuellement ouvert est annulé, aucune carte de diff (E19)
                // — avant, le tampon de l'utilisateur était mis de côté puis
                // « réaligné » sur un disque inchangé.
                if (data.dry_run && _evtPath) {
                    if (ctx.isStreamActive && ctx.isStreamActive(_evtPath)) {
                        try { await ctx.streamFinalize(_evtPath, { success: false }); } catch (_) {}
                    }
                } else
                if ((tn.includes('write') || tn.includes('save') || tn.includes('edit'))
                    && _evtPath) {
                    const path = _evtPath; pendingWrite.value = null;
                    try {
                        let ok = true;
                        try { const p = JSON.parse(data.result); if (p && p.ok === false) ok = false; } catch(_) {}
                        if ((!ok || _isErrorResult) && ctx.isStreamActive && ctx.isStreamActive(path)) {
                            // Écriture refusée côté serveur (permissions, hash
                            // mismatch…) : clore le stream TOUT DE SUITE —
                            // streamFinalize revert le modèle ET retire
                            // l'onglet fantôme qu'il avait créé — au lieu
                            // d'attendre le cleanup de fin de tour.
                            try { await ctx.streamFinalize(path, { success: false }); } catch(_) {}
                        }
                        if (ok && settings.value.enable_editor) {
                            // ── Branche streaming : un tool_call_delta a déjà
                            //    préparé l'éditeur et écrit en direct. On télécharge
                            //    tout de même le contenu final pour réconcilier
                            //    (échappements exotiques, transformations backend)
                            //    et on passe la main à streamFinalize.
                            const _streamChatId = data.chat_id || currentChatId.value || 'local';
                            const streamActive = ctx.isStreamActive && ctx.isStreamActive(path);
                            // Fichier binaire/Office (xlsx généré, pdf…) : aucun
                            // contenu texte à réconcilier — on ne le télécharge pas.
                            const _viewerFile = !streamActive
                                && !!(ctx.editorIsViewerPath && ctx.editorIsViewerPath(path));
                            // Contenu final ET sa description disque (mtime,
                            // sha256, BOM, fins de ligne) lus dans la MÊME
                            // réponse : c'est la base de précondition du
                            // prochain enregistrement (lot B). Décodage fidèle :
                            // ``res.text()`` retirait le BOM (E15).
                            let newContent = null, newDisk = null;
                            for (let attempt = 0; !_viewerFile && attempt < 3; attempt++) {
                                if (attempt > 0) await new Promise(r => setTimeout(r, 300));
                                try {
                                    const res = await fetchAuth('/api/sandbox/download?path=' + encodeURIComponent(path), {}, true);
                                    if (res && res.ok) {
                                        const bytes = new Uint8Array(await res.arrayBuffer());
                                        const dec = window.elpisDecodeText
                                            ? window.elpisDecodeText(bytes)
                                            : { text: new TextDecoder('utf-8').decode(bytes) };
                                        const mt = parseFloat(res.headers.get('X-Mtime'));
                                        const sh = res.headers.get('X-Sha256');
                                        newContent = dec.text;
                                        newDisk = Object.assign({}, dec, {
                                            mtime: Number.isFinite(mt) ? mt : null,
                                            sha: sh && /^[0-9a-f]{64}$/.test(sh) ? sh : null,
                                        });
                                        break;
                                    }
                                } catch(_) {}
                            }
                            if (streamActive) {
                                // Snapshot PRE-stream conservé par streamFinalize
                                const preSnapshot = ctx.getStreamPreSnapshot
                                    ? ctx.getStreamPreSnapshot(path) : null;
                                const fin = await _finalizeToolStream(data, _streamChatId, _replaying, {
                                    resultStr:    data.result,
                                    finalContent: newContent,
                                    disk:         newDisk,
                                });
                                const preSnap = (fin && fin.preSnapshot) || preSnapshot;
                                if (preSnap !== null && newContent !== null && preSnap !== newContent) {
                                    _recordDiffForMessage(idx, path, preSnap);
                                } else {
                                    // Stream actif mais pas de snapshot
                                    // exploitable (ex : capturePreWrite a échoué,
                                    // ou newContent égale preSnap). On enregistre
                                    // quand même la carte SANS diff pour que
                                    // l'utilisateur voie qu'un fichier a été
                                    // modifié + bouton télécharger.
                                    _recordDiffForMessage(idx, path, null);
                                    _extractAndStoreDiffStats(idx, path, data.result);
                                }
                            } else {
                                // Pas de stream actif (fallback classique : backend legacy,
                                // tool non-reconnu par le décodeur, OU auto-ouverture
                                // de l'éditeur désactivée par l'utilisateur — cf.
                                // settings.auto_open_editor_on_write).
                                const preSnapshot = ctx.capturePreWrite ? ctx.capturePreWrite(path) : null;
                                if (_viewerFile) {
                                    await ctx.editorRefreshViewer(path);
                                    _recordDiffForMessage(idx, path, null);
                                    _extractAndStoreDiffStats(idx, path, data.result);
                                } else if (newContent !== null) {
                                    await ctx.updateEditor(path, newContent, newDisk);
                                    if (preSnapshot !== null && preSnapshot !== newContent) {
                                        _recordDiffForMessage(idx, path, preSnapshot);
                                    } else {
                                        // Pas de snapshot exploitable :
                                        // soit le fichier n'était pas encore ouvert
                                        // dans Monaco (pas de modèle), soit l'user
                                        // a désactivé auto-open (updateEditor a
                                        // bail-out). Dans tous les cas, on doit
                                        // afficher la carte du fichier modifié +
                                        // bouton télécharger. Symétrique de la
                                        // branche "editor master toggle OFF"
                                        // ci-dessous (ligne 1729 dans l'original).
                                        _recordDiffForMessage(idx, path, null);
                                        _extractAndStoreDiffStats(idx, path, data.result);
                                    }
                                }
                            }
                            ctx.loadSandboxFiles();
                        } else if (ok) {
                            // ── Mode editor DÉSACTIVÉ : on n'a ni stream ni Monaco
                            //    pour capturer un "avant", mais on doit quand même
                            //    informer l'utilisateur qu'un fichier a été modifié.
                            //    On enregistre le path avec snapshot=null + on lit
                            //    les stats lines_added/lines_removed renvoyées par
                            //    le tool (write_file et edit_file les exposent
                            //    explicitement -- cf tools/fs_tools.py). La diff
                            //    card côté UI affichera +X/-Y et un bouton download.
                            //
                            //    NB : ce branchement est INDÉPENDANT du bloc
                            //    enable_editor ci-dessus -- erreur précédente :
                            //    le fallback null était imbriqué dedans, donc
                            //    jamais atteint en mode désactivé.
                            _recordDiffForMessage(idx, path, null);

                            // Extraction des stats backend (best-effort)
                            // factorisée en _extractAndStoreDiffStats.
                            _extractAndStoreDiffStats(idx, path, data.result);

                            ctx.loadSandboxFiles();
                        }
                    } catch(err) {}
                } else if (/delete|move|mkdir|manage|copy|rename|shell|exec|run|git|command|terminal/.test(tn)) {
                    // Outils qui touchent au disque sans passer par le flux
                    // d'écriture (commande shell, git de l'assistant,
                    // ``manage_files``…) : arborescence + onglets ouverts
                    // revérifiés tout de suite, au lieu d'attendre le sondage de
                    // 30 s (E8).
                    ctx.loadSandboxFiles();
                    if (ctx.checkExternalModsSoon) ctx.checkExternalModsSoon();
                }
            }
            // Timestamp du dernier tool_result : utilisé côté UI pour afficher
            // les 3 points animés quand les tools sont repliés et que le modèle
            // "réfléchit" avant le prochain token (tool_call ou content).
            _mergeFilesChanged(idx, data.files);
            _patch(idx, { _lastToolResultAt: Date.now() });
            // Auto-scroll pour garder le résultat visible.
            nextTick(() => scrollToBottom());

        } else if (data.type === 'tool_progress') {
            // v18 (Tier 1 MCP best practices) — progress notification
            // émise par le tool serveur via ``ctx.report_progress()``.
            // Le backend l'a forwardée via le wrapper + l'orchestrateur.
            // Forme du payload :
            //   { type: 'tool_progress', name, progress, total, message }
            //
            // On localise le step ``running`` correspondant (par nom de
            // tool, comme tool_result) et on y attache la dernière
            // valeur de progression — la diff card peut afficher une
            // barre, un % textuel, ou juste le message selon le
            // template. Si plusieurs steps en cours portent le même
            // nom (parallélisme), on patche le dernier — la cible la
            // plus récente est presque toujours celle qui émet.
            const _pName = data.name || '';
            const _curP = msgs[idx];
            if (_curP) {
                const stepsP = [...(_curP.toolSteps || [])];
                for (let i = stepsP.length - 1; i >= 0; i--) {
                    if (stepsP[i].name === _pName && stepsP[i].status === 'running') {
                        const _total = (typeof data.total === 'number' && data.total > 0) ? data.total : null;
                        const _pct = _total ? Math.max(0, Math.min(100, Math.round((data.progress / _total) * 100))) : null;
                        stepsP[i] = {
                            ...stepsP[i],
                            // ``progressInfo`` (not ``progress``) — keeps the
                            // namespace clean of the compression code, which
                            // uses ``step.progress`` as a number 0-100 on
                            // its pseudo-steps (chat.html line ~720).
                            // Different shape, different meaning, different
                            // step (compression matches by name===
                            // 'context_compress', this matches by tool name),
                            // but renaming costs nothing and removes a
                            // future foot-gun if templates ever start
                            // looking at step.progress regardless of step
                            // kind.
                            progressInfo: {
                                value:   Number(data.progress) || 0,
                                total:   _total,
                                pct:     _pct,
                                message: data.message || '',
                                at:      Date.now(),
                            },
                        };
                        _patch(idx, { toolSteps: stepsP });
                        break;
                    }
                }
            }

        } else if (data.type === 'tool_log') {
            // v18 (Tier 1) — log notification émise via ``ctx.info()``,
            // ``ctx.warning()`` ou ``ctx.error()`` côté tool serveur.
            // Forme du payload :
            //   { type: 'tool_log', name, level, logger, message }
            //
            // On l'ajoute à la liste ``logs`` du step ``running``
            // correspondant pour que la UI puisse l'afficher en
            // dépliant le step. Cap à 50 lignes par step pour ne pas
            // exploser la mémoire si un tool émet en boucle.
            const _lName = data.name || '';
            const _curL = msgs[idx];
            if (_curL) {
                const stepsL = [...(_curL.toolSteps || [])];
                for (let i = stepsL.length - 1; i >= 0; i--) {
                    if (stepsL[i].name === _lName && stepsL[i].status === 'running') {
                        const existing = stepsL[i].logs || [];
                        const newEntry = {
                            level:   data.level || 'info',
                            message: data.message || '',
                            logger:  data.logger || '',
                            at:      Date.now(),
                        };
                        // Cap to last 50 entries — tools that loop and log
                        // can otherwise inflate the toolSteps state.
                        const cappedLogs = existing.length >= 50
                            ? [...existing.slice(-49), newEntry]
                            : [...existing, newEntry];
                        stepsL[i] = { ...stepsL[i], logs: cappedLogs };
                        _patch(idx, { toolSteps: stepsL });
                        break;
                    }
                }
            }

        } else if (data.type === 'shell_output') {
            // Terminal en direct : sortie incrémentale d'``execute_shell``,
            // streamée par le bridge exec (batches ≤ ~2 Ko, cap live 64 Ko).
            // Forme du payload :
            //   chunk : { type, name, stream:'stdout'|'stderr', chunk, seq }
            //   done  : { type, name, done:true, seq, returncode,
            //             duration_ms, timed_out, live_truncated }
            // Attachée au step ``running`` correspondant (mêmes règles de
            // ciblage que tool_log) mais rendue HORS de la carte outil — bloc
            // terminal dans le fil de conversation (grp.shells, chat.html).
            if (settings.value.live_shell_enabled === false) return;
            const _sName = data.name || '';
            const _curS = msgs[idx];
            if (_curS) {
                const stepsS = [...(_curS.toolSteps || [])];
                let si = -1;
                // Ciblage par call_id d'abord : seul discriminant fiable
                // quand PLUSIEURS execute_shell tournent en parallèle.
                if (data.call_id) {
                    for (let i = stepsS.length - 1; i >= 0; i--) {
                        if (stepsS[i].callId === data.call_id) { si = i; break; }
                    }
                }
                if (si < 0) {
                    for (let i = stepsS.length - 1; i >= 0; i--) {
                        if (stepsS[i].name === _sName && stepsS[i].status === 'running') { si = i; break; }
                    }
                }
                if (si < 0) {
                    // Filet : événement arrivé après le tool_result (course
                    // rare) → dernier step execute_shell quel que soit l'état.
                    for (let i = stepsS.length - 1; i >= 0; i--) {
                        if (stepsS[i].name === _sName) { si = i; break; }
                    }
                }
                if (si >= 0) {
                    const st = stepsS[si];
                    const _pk = idx + ':' + si;
                    const _pend = _shellPend.get(_pk);
                    // Dédup/reprise : seq strictement croissant par exec —
                    // comparé au MAX(step, en attente) depuis le coalescing.
                    const _seqBase = Math.max(st.shellSeq || 0, (_pend && _pend.seq) || 0);
                    if (typeof data.seq === 'number' && data.seq <= _seqBase) return;
                    if (!data.done && typeof data.chunk === 'string' && data.chunk) {
                        // Chunk : coalescé, AUCUN _patch ici (cf. _flushShellPend).
                        const p = _pend || { chunk: '', seq: 0 };
                        p.chunk += data.chunk;
                        p.seq = Math.max(p.seq, data.seq || (_seqBase + 1));
                        _shellPend.set(_pk, p);
                        if (!_shellFlushTimer) {
                            _shellFlushTimer = setTimeout(_flushShellPend, _SHELL_FLUSH_MS);
                        }
                        return;
                    }
                    const upd = { ...st, shellSeq: data.seq || (_seqBase + 1) };
                    if (data.done) {
                        // Pas de sortie du tout → pas de bloc (shellOut reste
                        // null, la carte outil suffit pour une commande muette).
                        // La sortie en attente est fusionnée AVANT les champs
                        // de fin (sinon les derniers chunks seraient perdus).
                        if (_pend) {
                            upd.shellOut = _shellFoldPend(st, _pend);
                            _shellPend.delete(_pk);
                        }
                        upd.shellDone = true;
                        upd.shellRc = (typeof data.returncode === 'number') ? data.returncode : null;
                        upd.shellMs = data.duration_ms || 0;
                        upd.shellLiveTruncated = !!data.live_truncated;
                    }
                    stepsS[si] = upd;
                    _patch(idx, { toolSteps: stepsS });
                    // Autoscroll INTERNE de la console du segment (pas la
                    // page) : on suit la sortie si l'utilisateur est déjà en
                    // bas du bloc. Une console PAR SEGMENT → clé idx-seg.
                    const _gi = Math.max(upd.seg || 0, 0);
                    nextTick(() => {
                        try {
                            const el = document.querySelector('[data-shell-live="' + idx + '-' + _gi + '"]');
                            if (el && (el.scrollHeight - el.scrollTop - el.clientHeight) < 48) {
                                el.scrollTop = el.scrollHeight;
                            }
                        } catch (_) {}
                    });
                }
            }

        } else if (data.type === 'task_step') {
            // Sous-agent (outil `task`) : relais des events de l'ENFANT, rendus
            // dans la carte agent PERSISTANTE (msg.taskRuns — hors panneau
            // outils, jamais repliée). L'enfant étant éphémère (pas de session),
            // tout passe par le flux NDJSON du parent. Forme :
            //   tick               : { child_id, status:'tick', tokens }
            //   text               : { child_id, status:'text', text }  (narration)
            //   running/done/error : { child_id, agent, step, max_steps, tool,
            //                          args_preview, tokens, status,
            //                          result_preview (done/error) }
            //   final              : { child_id, status:'final', state,
            //                          steps_total, input_tokens, output_tokens,
            //                          duration_ms, transcript, result }
            const _cid = data.child_id || '';
            _mergeFilesChanged(idx, data.files);
            const _curT = msgs[idx];
            if (_curT) {
                const runsT = [...(_curT.taskRuns || [])];
                // Corrélation : le run RUNNING dont id===_cid (une reprise
                // task_id réutilise l'id d'un run TERMINÉ d'un tour précédent —
                // il ne faut jamais patcher celui-là) ; sinon le 1er run
                // `running` SANS id (batch sérialisé) → on lui assigne cet id.
                let ri = runsT.findIndex(r => r.id === _cid && r.state === 'running');
                if (ri < 0) ri = runsT.findIndex(r => r.state === 'running' && !r.id);
                if (ri >= 0) {
                    const run = { ...runsT[ri] };
                    if (!run.id) {
                        run.id = _cid;
                        // Annulation DIFFÉRÉE armée pendant la file (✕ cliqué
                        // sur un run pas encore spawné) : le POST part
                        // maintenant que l'id existe.
                        if (run.cancelRequested && !run.cancelSent) {
                            run.cancelSent = true;
                            try {
                                fetchAuth('/api/chat/task-cancel', {
                                    method:  'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    // child_id seul : l'endpoint scope par le
                                    // username d'auth, jamais par chat_id.
                                    body: JSON.stringify({ child_id: _cid }),
                                }).catch(() => {});
                            } catch (_) {}
                        }
                    }
                    // Compteur de tokens live (monotone) : chaque event peut le
                    // porter ; le `tick` (kv_cache enfant relayé) le fait monter
                    // même entre deux appels d'outils.
                    if (typeof data.tokens === 'number') run.tokens = data.tokens;
                    if (data.status === 'spawned') {
                        // Naissance : assigne l'id AVANT le 1er appel LLM (le
                        // bouton ✕ devient opérant) + profondeur (indentation).
                        if (typeof data.depth === 'number') run.depth = data.depth;
                    } else if (data.status === 'tick') {
                        // rien d'autre — tokens déjà mis à jour
                    } else if (data.status === 'text') {
                        // Narration de l'enfant (flush aux frontières de tool
                        // call) → déroulé LIVE de la modale « œil ».
                        const tr = [...(run.transcript || [])];
                        if (tr.length < 120 && data.text) tr.push({ text: String(data.text) });
                        run.transcript = tr;
                    } else if (data.status === 'final') {
                        run.state        = data.state || 'completed';
                        run.steps_total  = Number(data.steps_total) || 0;
                        run.input_tokens = Number(data.input_tokens) || 0;
                        run.output_tokens= Number(data.output_tokens) || 0;
                        run.duration_ms  = Number(data.duration_ms) || 0;
                        // Compteur = occupation de contexte RÉELLE de l'enfant
                        // (même mécanisme que la jauge parent — event kv_cache
                        // enfant relayé). Repli in+out (cumul comptable) pour
                        // les flux sans context_tokens.
                        run.tokens       = (Number(data.context_tokens) > 0)
                            ? Number(data.context_tokens)
                            : (run.tokens || run.input_tokens + run.output_tokens);
                        run.progress     = null;
                        // Déroulé AUTORITATIF du backend (borné à la source) :
                        // remplace l'accumulation live et repart tel quel dans
                        // les task_runs persistés (modale « œil » post-reload).
                        if (Array.isArray(data.transcript) && data.transcript.length) {
                            run.transcript = data.transcript;
                        }
                        // Résultat FINAL entier → bloc « Résultat » de la
                        // modale, dès la fin du run et sans rechargement.
                        if (typeof data.result === 'string' && data.result) {
                            run.result = data.result;
                        }
                    } else {
                        const subs = [...(run.tools || [])];
                        const tr   = [...(run.transcript || [])];
                        if (data.status === 'running') {
                            const entry = {
                                tool:         data.tool || '',
                                args_preview: data.args_preview || '',
                                status:       'running',
                            };
                            // Cap 50 (comme les logs) pour borner l'état.
                            run.tools = subs.length >= 50 ? [...subs.slice(-49), entry] : [...subs, entry];
                            if (tr.length < 120) tr.push({ ...entry, result_preview: '' });
                            run.transcript = tr;
                            // « étape N/M » : N et M viennent TOUS DEUX du backend
                            // et comptent des TOURS. Le repli d'avant
                            // (`subs.length + 1`) comptait des APPELS sur une
                            // liste plafonnée à 50 → numérateur faux (et figé à
                            // 50 au-delà) face à un dénominateur en tours. Sans
                            // valeur backend, on conserve la progression connue.
                            run.progress = {
                                step:      Number(data.step) || run.progress?.step || 1,
                                max_steps: Number(data.max_steps) || run.progress?.max_steps || 0,
                            };
                        } else {
                            // done / error : patcher la dernière entrée `running`
                            // du même outil (miroir dans le déroulé, avec
                            // l'aperçu de résultat émis par le backend).
                            for (let j = subs.length - 1; j >= 0; j--) {
                                if (subs[j].status === 'running' && subs[j].tool === (data.tool || '')) {
                                    subs[j] = { ...subs[j], status: data.status };
                                    break;
                                }
                            }
                            for (let j = tr.length - 1; j >= 0; j--) {
                                if (tr[j].status === 'running' && tr[j].tool === (data.tool || '')) {
                                    tr[j] = { ...tr[j], status: data.status,
                                              result_preview: data.result_preview || '' };
                                    break;
                                }
                            }
                            run.tools = subs;
                            run.transcript = tr;
                        }
                    }
                    runsT[ri] = run;
                    _patch(idx, { taskRuns: runsT });
                }
            }

        } else if (data.type === 'annotation_frame') {
            // Computer-use : trame annotée (screenshot + boxes) → Annotation
            // Studio. Pont vers app.js (_studio_menu.applyFrame).
            try { if (ctx.onAnnotationFrame) ctx.onAnnotationFrame(data); } catch (e) {}

        } else if (data.type === 'error') {
            _pendingAskUser = null;   // (passe 2) pas de questionnaire posthume
            isThinking.value = false; showToast(data.text || 'Erreur', 'error');
            // Revert les streams d'édition encore actifs : le tool a échoué
            // ou le chat a crash au milieu, on ne laisse pas l'éditeur sur
            // un état partiel. streamFinalize({success:false}) restaure le
            // preSnapshot capturé au premier delta.
            const _errChatId = data.chat_id || currentChatId.value || 'local';
            for (const [k, v] of Array.from(_toolStreamStates.entries())) {
                if (v.chatId === _errChatId && v.opened && !v.failed) {
                    try { await ctx.streamFinalize(v.path, { success: false }); } catch(_) {}
                }
            }
            _purgeToolStreams(_errChatId);
            // Clear pending screenshots (le spinner doit disparaître même sur erreur)
            const cur = msgs[idx];
            if (cur && cur.webScreenshots && cur.webScreenshots.length) {
                for (const s of cur.webScreenshots) s.pending = false;
            }
            // F7 — un event `error` backend n'est PAS suivi d'un `final` (le
            // partiel du finally est gardé par _was_cancelled). Sans remettre
            // `isStreaming:false` ICI, le message gardait isStreaming:true → la
            // pill « Réflexion… » et l'engrenage tournaient à l'infini à côté de
            // l'encart rouge (le reset global isStreaming.value ne pilote pas la
            // pill, qui lit entry.msg.isStreaming). On purge aussi l'état de
            // rendu stream, comme le chemin `final`/stopGeneration.
            _patch(idx, { isError: true, errorMessage: data.text || 'Erreur',
                          errorDetail: data.detail || '',
                          errorKind: data.kind || '',
                          isStreaming: false, ..._STREAM_RENDER_CLEAR });

        } else if (data.type === 'warning' || data.type === 'info') {
            // Ces deux types étaient émis par le backend depuis longtemps
            // (« Hoquet du moteur LLM — nouvelle tentative… », récupération
            // d'historique, budget de contexte) mais AUCUNE branche ne les
            // traitait : la chaîne de if/else s'arrêtait à 'error', donc ils
            // tombaient dans le vide. L'utilisateur ne voyait rien, et le
            // backend croyait l'avoir prévenu.
            if (!data.text) return;
            const _warn = data.type === 'warning';
            const _opts = { duration: _warn ? 12000 : 7000 };
            // Avertissement de contexte : on offre le geste directement,
            // plutôt que de demander à l'utilisateur d'aller le chercher.
            if (_warn && currentChatId.value && /contexte/i.test(data.text)) {
                _opts.actionLabel = 'Compacter';
                _opts.onAction = () => { try { manualCompress(); } catch (_) {} };
            }
            showToast(data.text, _warn ? 'warning' : 'info', _opts);
        } else if (data.type === 'notice') {
            // Événements d'état de la boucle d'outils (« contexte saturé —
            // arrêt des appels d'outils », arrêt anti-boucle, budget de
            // temps) : émis par le harnais avec {level, message} — aucune
            // branche ne les traitait, l'utilisateur ne voyait jamais
            // pourquoi le run s'arrêtait.
            if (!data.message) return;
            showToast(data.message,
                      data.level === 'warn' ? 'warning' : 'info',
                      { duration: data.level === 'warn' ? 12000 : 7000 });
        }
    }

    // ===========================================================
    //  STOP / CONTINUE / GENERATE
    // ===========================================================

    // AUDIT 2026-08-31 (passe 2) — remise à zéro de l'état ask_user. Le stash
    // posé au tool_call n'était consommé qu'au 'final' : après un Stop ou une
    // erreur, il restait armé et le questionnaire PÉRIMÉ surgissait au final
    // de la génération SUIVANTE — y compris dans un autre chat, où
    // submitAskUser écrasait le brouillon du composeur. Appelée au Stop, sur
    // erreur, et au changement de conversation (_resetTransientCompose).
    function resetAskUser() {
        _pendingAskUser = null;
        askUserPanel.value = null;
    }

    // (passe 2) Skills épinglés via « /skill » : même classe de fuite
    // inter-chat que les pièces jointes — resetSlash() ne les vidait pas.
    function clearPinnedSkills() {
        pinnedSkills.value = [];
    }

    // (2026-09-20) Supprimer une conversation qui GÉNÈRE : le run doit
    // s'arrêter d'abord — au premier plan (stopGeneration), suivi ou détaché
    // (annulation par chat_id + retrait de la pastille). Sinon il continuait
    // côté serveur et la suppression, 5 s plus tard, tombait sur un chat qui
    // écrivait encore : il « revenait ».
    function stopRunForChat(chatId) {
        const id = String(chatId || '');
        if (!id || id.startsWith('__')) return false;
        // ``stopGeneration`` vise le flux AFFICHÉ : seulement si c'est celui de
        // ce chat. Avant (2026-09-21), un chat SUIVI en arrière-plan passait ce
        // test pendant qu'un autre chat générait : on coupait l'autre, et
        // celui qu'on supprimait continuait.
        if (isStreaming.value && String(_streamingForChatId || '') === id) {
            stopGeneration();
            return true;
        }
        const followed = String(followedRunChatId.value || '') === id;
        if (followed || activeRunIds.value.includes(id)) {
            try {
                fetchAuth('/api/chat/cancel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: id }),
                }).catch(() => {});
            } catch (_) {}
            if (followed) { try { stopFollowRun(); } catch (_) {} }
            _markRunDone(id);
            return true;
        }
        return false;
    }

    function stopGeneration() {
        // Run RATTACHÉ : la bulle est finalisée ici, pas besoin de relire la
        // conversation quand la lecture s'arrête (cf. attachRun).
        if (_currentRun && _currentRun.attached) _currentRun.stopped = true;
        _clearLiveCtx();   // retire la ligne de stats live dès l'arrêt manuel
        resetAskUser();    // un questionnaire en attente meurt avec le tour
        // 1. Notifier le backend AVANT d'abort -- il set son flag d'annulation
        //    pour que le worker s'arrête à la prochaine itération/tool call.
        //    Fire-and-forget ; on n'attend pas la réponse.
        //    MULTI-TAB FIX : on envoie chat_id pour que le cancel soit scopé
        //    à CET onglet — sans ça, deux onglets de chats différents se
        //    cancellaient mutuellement (voir backend/routes/_state.py).
        // Chat du RUN (chantier C, R6) : pendant un suivi ou un rattachement,
        // c'est lui qu'il faut arrêter, pas forcément ``currentChatId``.
        const _stopChatId = String(_streamingForChatId || followedRunChatId.value
                                   || currentChatId.value || '');
        try {
            const _cid = _stopChatId.startsWith('__') ? (currentChatId.value || '') : _stopChatId;
            fetchAuth('/api/chat/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(_cid ? { chat_id: _cid } : {}),
            }).catch(() => {});
        } catch (_) {}

        // 2. Abort local du fetch (interrompt le stream côté client)
        if (abortController.value) {
            try { abortController.value.abort(); } catch (_) {}
            abortController.value = null;
        }
        // Suivi d'un run détaché : le Stop ci-dessus l'a visé par le bus
        // d'annulation, il n'y a plus rien à suivre (audit 2026-08-22, B3).
        try { stopFollowRun(); } catch (_) {}
        isStreaming.value = false;
        isThinking.value  = false;
        statusText.value  = '';

        // ── Ce que le Stop laissait derrière lui (2026-09-22) ──────────────
        // Les trois témoins ci-dessous n'étaient retirés QUE par des
        // événements de fin de flux (``queue_cleared``, ``final``). Or le Stop
        // abort le fetch juste au-dessus : ces événements ne sont jamais lus,
        // et l'interface continuait d'annoncer un travail en cours alors que
        // plus rien ne tournait — jusqu'au changement de conversation.
        //
        // 1. Le bandeau file d'attente : il décrit une attente qui n'a plus de
        //    consommateur.
        queueStatus.value = null;
        // 2. La ligne de statut du message en cours (« Mode RAG », « Réflexion
        //    … ») : elle s'affiche avec un spinner, et disait donc qu'une
        //    génération tournait encore.
        {
            const _sM = _getStreamMsgs();
            const _sI = _streamIdx(_sM);
            if (_sI >= 0 && _sM[_sI] && _sM[_sI]._statusLine) {
                _sM[_sI] = Object.assign({}, _sM[_sI], { _statusLine: '' });
            }
        }
        // 3. Le témoin « run en cours » de la liste des conversations : il est
        //    soldé par le ``final``, qui peut ne jamais être lu. Le Stop vient
        //    de viser CE run : on le solde ici, le rafraîchissement périodique
        //    des runs corrigera si le serveur dit autre chose.
        if (_stopChatId && !_stopChatId.startsWith('__')) {
            try { _markRunDone(_stopChatId); } catch (_) {}
        }
        // 4. La bulle de suivi (pseudo-message ``isStreaming``) : ``stopFollowRun``
        //    ne la retire que s'il connaissait un run suivi. Un Stop après un
        //    rattachement perdu la laissait tourner indéfiniment.
        try { _setFollowBubble(false); } catch (_) {}

        // Lignes agents (outil `task`) : le Stop tue aussi les enfants — on
        // fige localement toute ligne encore `running` en `cancelled`. Le
        // bilan task_step final émis par le backend pendant le unwinding se
        // perd dans l'abort du fetch ci-dessus : sans ce marquage, la ligne
        // restait en spinner à vie.
        {
            const _sMsgs = _getStreamMsgs();
            for (let i = _sMsgs.length - 1; i >= 0; i--) {
                const _runs = _sMsgs[i] && _sMsgs[i].taskRuns;
                if (!_runs || !_runs.length || !_runs.some(r => r.state === 'running')) continue;
                _sMsgs[i] = Object.assign({}, _sMsgs[i], {
                    taskRuns: _runs.map(r => r.state === 'running'
                        ? { ...r, state: 'cancelled', progress: null }
                        : r),
                });
            }
        }

        _stopThinkFlush();
        _stopPreContentFlush();  // vider le buffer preContent
        _stopStreamFlush();
        if (typeof _cancelPendingChatSearch === 'function') {
            _cancelPendingChatSearch();
        }

        // Stop le ticker de compression et finalise le pseudo-step si une
        // condensation était en cours quand l'user a cliqué Stop : sinon le
        // setInterval(250ms) tourne indéfiniment (garde interne jamais armée
        // car compressionStatus n'est jamais remis à null) et le step reste
        // 'running'/figé sur la bulle assistant.
        _stopCompressionTick();
        if (compressionStatus.value) {
            const _cIdx = (typeof compressionStatus.value.msg_idx === 'number')
                ? compressionStatus.value.msg_idx
                : -1;
            if (_cIdx >= 0) {
                try {
                    const _cMsgs = _getStreamMsgs();
                    const _cCur = _cMsgs && _cMsgs[_cIdx];
                    if (_cCur && Array.isArray(_cCur.toolSteps)) {
                        const _cSteps = _cCur.toolSteps.slice();
                        for (let i = _cSteps.length - 1; i >= 0; i--) {
                            const st = _cSteps[i];
                            if (st && st._kind === 'compression' && st.status === 'running') {
                                _cSteps.splice(i, 1);  // compression interrompue : on retire le step
                                _patch(_cIdx, { toolSteps: _cSteps });
                                break;
                            }
                        }
                    }
                } catch (_) { /* non-fatal */ }
            }
        }
        compressionProgress.value = 0;
        compressionStatus.value = null;

        // Revert les streams d'édition en cours (tool_call_delta → Monaco).
        // Si l'user cancel au milieu d'un write_file partiellement streamé
        // on ne veut PAS laisser un fichier à moitié écrit dans l'éditeur.
        // streamFinalize({success:false}) restaure le preSnapshot initial.
        for (const [k, v] of Array.from(_toolStreamStates.entries())) {
            if (v.opened && !v.failed) {
                try { ctx.streamFinalize(v.path, { success: false }); } catch(_) {}
            }
        }
        _toolStreamStates.clear();

        const rem = _streamBuf;
        _streamBuf = '';

        // Flush remaining into the correct messages array
        const msgs    = _getStreamMsgs();
        const lastIdx = _streamIdx(msgs);            // (passe 9, F2)
        if (lastIdx >= 0) {
            const cur = msgs[lastIdx];
            if (cur.role === 'assistant') {
                // Clear pending screenshots (le spinner doit disparaître sur cancel)
                if (cur.webScreenshots && cur.webScreenshots.length) {
                    for (const s of cur.webScreenshots) s.pending = false;
                }
                const hasThinking = !!(cur.thinking && cur.thinking.trim());
                // (passe 8, F4) — phase outils : le texte en cours vit dans la
                // ligne live (narration ou réponse finale) ; il devient le
                // corps du partiel au lieu d'être jeté — on stoppe souvent
                // PARCE QU'on a déjà lu la réponse. Le 'final' annulé du
                // backend (assistant = partiel accumulé) recalera si besoin.
                const _bodyStop = (cur.content || '') + rem;
                const _liveStop = (cur._pendingPreContent || '').trim();
                // AUDIT 2026-09-26 — Stop en pleine boucle d'outils SANS texte :
                // la bulle vide était retirée du prochain envoi
                // (``_keepForPersist``) alors que le serveur avait persisté ce
                // partiel AVEC le travail d'outils déjà fait. Le tour suivant ne
                // le voyait plus (outils rejoués) et l'écrasait en base. Même
                // placeholder que le serveur : la bulle reste alignée sur la
                // base, qui lui recolle son historique d'outils.
                const _hadTools = !!((cur.toolSteps && cur.toolSteps.length)
                                     || (cur.taskRuns && cur.taskRuns.length));
                const _txtStop = _bodyStop || (_liveStop ? cur._pendingPreContent : '');
                msgs[lastIdx] = Object.assign({}, cur, {
                    content:            _txtStop || (_hadTools && !hasThinking
                                                     ? '_(génération interrompue)_' : ''),
                    _pendingPreContent: '',
                    _pendingToolThinking: '',
                    isStreaming: false,
                    isTruncated: !hasThinking,
                }, _STREAM_RENDER_CLEAR, _PRE_RENDER_CLEAR);
            }
        }

        // Le run arrêté n'est plus « en cours » (pastille de la barre latérale) ;
        // la lecture est terminée, son jeton ne doit plus rien écrire.
        _markRunDone(_stopChatId);
        _currentRun = null;
        _streamingForChatId = null;

        nextTick(() => { scrollToBottom(); addCodeCopyButtons(); loadAvailableModels(); });
    }

    // ── Marqueurs de reprise (bandeau « Continuer » / « Reprendre ») ──────
    // (2026-09-24) Ils ne valent QUE pour la DERNIÈRE bulle assistant : c'est
    // elle, et elle seule, que continueGeneration() reprend. Un tour coupé
    // suivi d'un nouveau message gardait pourtant son ``isTruncated`` en
    // session (le serveur, lui, l'oublie au tour suivant) : son bouton restait
    // affiché dans le fil et un clic dessus ne faisait RIEN (la reprise vise
    // la dernière bulle, non tronquée) — « le bouton Continuer ne disparaît
    // pas ». Le gabarit ne l'affiche plus que sur la dernière bulle hors
    // génération (chat.html) ; ce helper purge les marqueurs périmés pour que
    // ni l'instantané de session ni une suppression de tour ne les ressuscite.
    // Remplacement d'objet : les messages chargés sont gelés (cf. setMsgUi).
    const _REPRISE_CLEAR = { isTruncated: false, toolLoopTruncated: false, toolLoopStats: null };
    function _retirerReprisesPerimees(msgs, sauf) {
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            if (i !== sauf && m && m.role === 'assistant' && (m.isTruncated || m.toolLoopTruncated))
                msgs[i] = Object.assign({}, m, _REPRISE_CLEAR);
        }
    }

    async function continueGeneration() {
        // Un tour tourne déjà (reprise lancée, run suivi en arrière-plan) :
        // le bandeau est masqué, un clic résiduel ne relance rien.
        if (isStreaming.value) return;
        // Cherche le DERNIER message assistant en sautant d'éventuelles lignes
        // de fin non-assistant (ex. le `notice` de compaction poussé par
        // /compact) : sans ça, `length-1` tombe sur le notice et le bouton
        // « Continuer » devient un no-op silencieux. MÊME règle que
        // ``lastAssistantIdx`` (_virtual_scroll.js), qui borne le bandeau.
        let lastIdx = messages.value.length - 1;
        while (lastIdx >= 0 && messages.value[lastIdx].role !== 'assistant') lastIdx--;
        const lastMsg = messages.value[lastIdx];
        if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.isTruncated) return;
        _retirerReprisesPerimees(messages.value, lastIdx);
        // Clear tous les marqueurs d'interruption (texte ET tool-loop). Le
        // _doGenerate(true) qui suit va re-envoyer la conversation COMPLÈTE
        // (y compris les tool_calls et tool_results déjà exécutés, préservés
        // côté backend dans l'historique persisté). Le LLM voit donc tout
        // son propre travail passé et reprend naturellement.
        // NB : on ne touche PAS à ``thinkingTruncated`` ici — la projection du
        // payload (_projectForPersist) s'en sert pour envoyer resume_thinking
        // au backend (reprise du raisonnement). Le handler `final` du tour de
        // reprise le réinitialise d'après ``data.truncated_in_think``.
        messages.value[lastIdx] = Object.assign({}, lastMsg, _REPRISE_CLEAR, {
            // (passe 9, F2/F13) — l'assistant REPRIS redevient la cible de
            // stream (_streamIdx) : sans ce drapeau, un notice de /compact en
            // fin de fil recevait tous les patchs du tour, et la pill/engrenage
            // restaient absents pendant la phase outils du tour continué.
            isStreaming:        true,
        });
        await _doGenerate(true);
    }

    // ─────────────────────────────────────────────────────────────────
    //  RESPOND NOW — interrompt le raisonnement en cours et force le
    //  modèle à produire directement sa réponse finale.
    //
    //  Contexte UX : les modèles reasoning (Qwen3, DeepSeek-R1) ont
    //  tendance à partir en boucle de thinking après 10-15 tool calls.
    //  Ce bouton court-circuite la réflexion en cours : on abort le
    //  stream, on repackage le thinking partiel comme un bloc
    //  <think>...</think> déjà fermé dans le *prefill* de l'assistant,
    //  et on relance en continuation avec thinking_mode=false.
    //
    //  Mécanique prefill : llama.cpp accepte un dernier message
    //  assistant avec du contenu comme "prompt completion" — il génère
    //  des tokens qui S'AJOUTENT à ce contenu. En mettant le thinking
    //  partiel fermé par </think> dans le prefill, on communique au
    //  modèle "ton raisonnement est déjà capturé, donne la réponse
    //  directe maintenant". C'est infiniment plus fiable que d'essayer
    //  de stopper proprement le reasoning côté serveur.
    //
    //  Invariant affichage : le <think>...</think> n'est JAMAIS posé
    //  dans msg.content local — il n'apparaît que dans le payload
    //  construit au vol. L'UI garde content='' côté partial, puis se
    //  remplit des vrais tokens de réponse. Le thinking partiel reste
    //  visible dans le bloc thinking (collapsé par défaut).
    // ─────────────────────────────────────────────────────────────────
    async function respondNow(assistantIdx) {
        const msgs = _getStreamMsgs();
        if (typeof assistantIdx !== 'number' || assistantIdx < 0 || assistantIdx >= msgs.length) return;
        const cur = msgs[assistantIdx];
        if (!cur || cur.role !== 'assistant') return;

        const partialThinking = (cur.thinking || '').trim();
        if (!partialThinking) return;   // rien à court-circuiter
        if (!isStreaming.value) return; // protection : bouton affiché seulement pendant stream

        // ── 0. VOIE NATIVE (llama-server b10545+) ───────────────────────────
        // Le moteur sait fermer le bloc de raisonnement d'une génération EN
        // COURS : le modèle enchaîne sur sa réponse dans le MÊME flux. Rien
        // n'est annulé, rien n'est ré-évalué. Sur un contexte long, le repli
        // ci-dessous coûte au contraire un pré-remplissage complet — des
        // dizaines de secondes pour une réponse que le modèle allait écrire.
        try {
            const _cid0 = currentChatId.value || '';
            if (_cid0) {
                const r = await fetchAuth('/api/chat/reasoning-end', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: _cid0 }),
                });
                const d = await r.json().catch(() => null);
                if (d && d.ok) {
                    // Le flux continue tout seul : on replie le raisonnement
                    // (l'utilisateur vient de déclarer qu'il ne l'intéresse
                    // plus) et on ne touche à RIEN d'autre.
                    _patch(assistantIdx, { thinkingOpen: false });
                    return;
                }
            }
        } catch (_) { /* moteur ancien ou route absente → repli ci-dessous */ }

        // ── Repli historique : annuler, puis relancer le tour avec le
        //    raisonnement déjà produit en préfixe. Correct, mais coûteux.
        // 1. Notifier le backend de l'annulation (fire-and-forget)
        //    puis abort côté client. Même séquence que stopGeneration
        //    MAIS on ne finalise PAS le message comme truncated — on
        //    veut que _doGenerate(true) reprenne immédiatement.
        //    MULTI-TAB FIX : on envoie chat_id (cf. stopGeneration).
        try {
            const _cid = currentChatId.value || '';
            fetchAuth('/api/chat/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(_cid ? { chat_id: _cid } : {}),
            }).catch(() => {});
        } catch (_) {}
        if (abortController.value) {
            try { abortController.value.abort(); } catch (_) {}
            abortController.value = null;
        }

        // 2. Nettoyer tous les timers / buffers de stream en cours
        //    (sinon des tokens en transit pourraient s'injecter après
        //    le redémarrage et corrompre le nouveau stream).
        _stopThinkFlush();
        _stopPreContentFlush();
        _stopStreamFlush();
        _streamBuf = '';

        // 3. Annoter le message assistant avec le marqueur de prefill.
        //    Le marqueur est consommé (lu + effacé) lors de la prochaine
        //    construction de payload dans _doGenerate. Ne modifie PAS
        //    cur.content (affichage reste propre).
        //    thinkingOpen=false : on collapse le bloc puisque l'user a
        //    explicitement choisi de sauter le reasoning — laisser le
        //    bloc ouvert attirerait l'attention sur un contenu qu'on
        //    vient de déclarer "pas pertinent".
        msgs[assistantIdx] = Object.assign({}, cur, {
            _respondNowPrefill:   '<think>\n' + partialThinking + '\n</think>\n\n',
            content:              '',
            thinking:             partialThinking,
            thinkingOpen:         false,
            isStreaming:          true,
            isTruncated:          false,
            isError:              false,
            errorMessage:         '',
            _statusLine:          '',
            _pendingPreContent:   '',
            _pendingToolThinking: '',
        }, _STREAM_RENDER_CLEAR, _PRE_RENDER_CLEAR);

        // 4. Petit délai pour laisser le AbortController propager avant
        //    de relancer — évite une race condition où le nouveau fetch
        //    recevrait un signal déjà aborted.
        await new Promise(r => setTimeout(r, 50));

        // 5. Relancer en continuation. _doGenerate lit _respondNowPrefill
        //    sur le dernier assistant au moment de construire le payload,
        //    transforme son content en <think>...</think>\n\n et force
        //    thinking_mode=false pour cette requête uniquement.
        await _doGenerate(true);
    }

    // La jauge de contexte (n_ctx + tokens réels) n'a de sens que pour le
    // llama.cpp LOCAL intégré : c'est la seule cible dont le poll /api/llm/models
    // (props.n_ctx, /tokenize, /metrics) décrit le modèle réellement utilisé. Via
    // un CONNECTEUR (cloud/backend alternatif, selectedConnector non vide), le poll
    // reste celui du serveur local → son n_ctx ne correspond PAS au modèle distant
    // et le comptage retomberait sur une estimation en CARACTÈRES. On masque donc
    // la jauge plutôt que d'afficher de faux « tokens ». Le backend gate déjà ses
    // events kv_cache de la même façon (is_local_llamacpp) ; on reste cohérent.
    //
    // 2026-09-16 — un connecteur llama.cpp a désormais sa jauge : le serveur lit
    // SA fenêtre (/props de ce serveur) et pousse ses events kv_cache ; le n_ctx
    // du sélecteur vient de ``selectedEngineMeta`` (props du connecteur), jamais
    // du poll de l'intégré.
    function _ctxGaugeApplicable() {
        if (!(selectedConnector && selectedConnector.value)) return true;
        return !!(selectedEngineMeta.value && selectedEngineMeta.value.llamacpp);
    }

    function _getCtxSize() {
        if (!_ctxGaugeApplicable()) return 0;
        if (selectedConnector && selectedConnector.value) {
            return (selectedEngineMeta.value && selectedEngineMeta.value.n_ctx) || 0;
        }
        return (llmHealth.value && llmHealth.value.props && llmHealth.value.props.n_ctx) || 0;
    }

    // ─── Contexte LIVE — ligne de stats dynamique sous le composeur ────
    //  ``liveGen`` (modèle · temps · tok/s · K contexte) : le débit se remplit
    //  à chaque token, mais la partie CONTEXTE n'affiche QUE le réel serveur
    //  (event kv_cache de fin de requête). Un ticker 200 ms recalcule
    //  ``liveGen`` (lu par le template). total = n_ctx du slot (0 si inconnu →
    //  partie ctx masquée, modèle/temps/débit restent affichés).
    function _seedLiveCtx() {
        // Via un connecteur : total=0 → jauge masquée (cf. _ctxGaugeApplicable).
        // On n'utilise NI le n_ctx local NI le kv_cache du poll (tous deux locaux,
        // donc faux pour un modèle distant).
        const _applicable = _ctxGaugeApplicable();
        // kv_cache du POLL = serveur intégré : jamais pour un connecteur.
        const _kv = (_applicable && !(selectedConnector && selectedConnector.value)
                     && llmHealth.value && llmHealth.value.kv_cache) || null;
        const total = _applicable ? (_getCtxSize() || (_kv && _kv.total) || 0) : 0;
        // base = dernière occupation RÉELLE connue (event kv_cache d'une requête
        // précédente). 0 tant qu'aucune mesure réelle n'existe (1er tour d'un
        // chat neuf ou rechargé) : la partie ctx reste masquée jusqu'au premier
        // event kv_cache — on n'affiche plus d'estimation, jamais.
        _ctxLive = { base: (_lastCtxUsed > 0 ? _lastCtxUsed : 0), gen: 0, total };
        _inThinkPhase = false;
        _genStartMs = Date.now();
        _startGenTicker();
    }
    function _startGenTicker() {
        _stopGenTicker();
        const tick = () => {
            if (!_ctxLive) { _stopGenTicker(); liveGen.value = null; return; }
            // Stream d'arrière-plan : on ne montre pas la ligne sur une AUTRE conv.
            const sec  = Math.max(0, (Date.now() - _genStartMs) / 1000);
            const rawUsed = _ctxLive.base;   // dernier RÉEL serveur connu (0 = aucun)
            if (rawUsed > 0) _lastCtxUsed = rawUsed;   // mémorise pour seed + snapshot
            const used = (_ctxLive.total && rawUsed > 0) ? Math.min(_ctxLive.total, rawUsed) : 0;
            const next = {
                model:     selectedModel.value || '',
                sec,
                // Chrono en cours : « 0 s » au démarrage, pas « <1 s ».
                secLabel:  fmtElapsed(sec, { live: true }),
                // débit = TOUT le généré (content + thinking), pas seulement le ctx
                // null pendant la réflexion → la ligne live masque le compteur
            // (cf. _inThinkPhase). Sinon : débit cumulé du tour.
            // (2026-09-02) null aussi tant qu'AUCUN token n'est arrivé : le
            // tick initial (posé avant le 1er thinking_token) affichait
            // « ↑ 0 tok/s » pendant ~200 ms à chaque début de tour, réflexion
            // comprise (course vue au harnais toolvis S1).
            tokPerSec: (_inThinkPhase || !_ctxLive.gen) ? null
                : (sec > 0.3 ? Math.round(_ctxLive.gen / sec) : 0),
                // Partie ctx affichée dès que n_ctx est connu : « 0 / n_ctx »
                // pendant la 1re réflexion (avant tout event kv_cache), puis
                // « réel / n_ctx » une fois la 1re mesure remontée. Masquée
                // seulement si total=0 (connecteur : n_ctx local non fiable).
                ctxLabel:  _ctxLive.total > 0
                    ? (_fmtTokens(used) + ' / ' + _fmtTokens(_ctxLive.total)) : '',
                pct:       used > 0 ? Math.min(100, Math.round(used / _ctxLive.total * 100)) : 0,
            };
            // AUDIT 2026-08-31 (passe 4, F13) — le template ne lit que
            // secLabel (granularité 1 s), tokPerSec, ctxLabel et pct : 4
            // ticks sur 5 produisaient un objet à VALEURS AFFICHÉES
            // identiques mais de référence neuve → re-rendu racine gratuit
            // toutes les 200 ms. On ne réassigne que si l'affichage change.
            const cur = liveGen.value;
            if (!cur || cur.model !== next.model || cur.secLabel !== next.secLabel
                    || cur.tokPerSec !== next.tokPerSec || cur.ctxLabel !== next.ctxLabel
                    || cur.pct !== next.pct) {
                liveGen.value = next;
            }
        };
        tick();
        _genTicker = setInterval(tick, 200);
    }
    function _stopGenTicker() { if (_genTicker) { clearInterval(_genTicker); _genTicker = null; } }
    function _clearLiveCtx()  {
        _ctxLive = null; _inThinkPhase = false; _stopGenTicker(); liveGen.value = null;
    }

    // ─── DEPRECATED : la compression est désormais 100 % backend ───────
    //
    // Historiquement, cette fonction appelait POST /api/chat/compress et
    // mutait messages.value en y insérant un marker isCompressedSummary.
    // C'était en conflit avec backend/services/conversation_compressor.py
    // (qui a son propre cycle de compression, structuré XML-like, cumulatif,
    // déclenché sur SSE pendant le streaming). Résultat : les deux systèmes
    // se marchaient dessus et des résumés étaient parfois écrasés.
    //
    // Source de vérité unique : le backend décide et émet
    // compression_start / compression_done via SSE. Le front se contente
    // d'afficher le widget compressionStatus pendant l'opération.
    //
    // On garde le nom de la fonction pour ne pas avoir à traquer tous les
    // call-sites : elle retourne simplement les messages sans modification.
    async function _compressIfNeeded(payloadMsgs, _assistantIdx) {
        return payloadMsgs;
    }

    // Crée le chat côté serveur s'il n'existe pas encore (sidebar immédiate,
    // persistance garantie). ``titleSource`` = texte du premier message pour
    // le titre rapide. La lecture seule ARMÉE (« /plan » avant le premier
    // message) est scellée dans le MÊME appel : atomique, la route de
    // génération relit meta_json — aucune fenêtre où un tour partirait avec
    // les outils d'écriture. Retourne true si le chat existe à la sortie.
    async function _ensureServerChat(titleSource, run) {
        if (currentChatId.value) return currentChatId.value;
        try {
            const res = await fetchAuth('/api/saved/chats/new', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan_mode: !!planMode.value }),
            });
            if (!res || !res.ok) return false;
            const d = await res.json();
            if (!d || !d.id) return false;
            const quickTitle = String(titleSource || '')
                .substring(0, 60).trim().replace(/\n.*/s, '') || 'Nouveau chat';
            // Conversation QUITTÉE pendant la création (chantier C, R10) : ne
            // pas écraser l'identifiant de la conversation désormais affichée —
            // le tour part quand même sous SON identifiant (cf. _doGenerate).
            if (!run || !run.detached) {
                currentChatId.value = d.id;
                currentChatTitle.value = quickTitle;
            }
            // Insert at the top of the sidebar list
            chats.value.unshift({ id: d.id, title: quickTitle, updated_at: Date.now() / 1000 });
            return d.id;
        } catch (e) { return false; }
    }

    async function _doGenerate(isContinue) {
        isContinue = !!isContinue;

        // ANTI DOUBLE-SEND — pose le garde SYNCHRONE avant TOUT await. Entre le
        // check isStreaming de sendMessage() et l'ancien set (après cleanup /
        // create-chat / abort, donc après des await), un 2e envoi rapide voyait
        // isStreaming===false et passait. On pose le flag maintenant, dans un
        // try/catch qui le relâche en cas d'erreur précoce (le reset nominal
        // reste plus bas, atteint en fin de génération réussie).
        isStreaming.value = true;
        // La voix ne doit jamais faire tomber une génération — d'où le
        // try/catch. Mais l'avaler en silence, c'est se condamner à chercher
        // à l'aveugle le jour où la lecture ne part pas : la console le dit.
        try { _voiceMod.onAssistantStart(isContinue); } catch (e) { console.error('[voix]', e); }
        // Nouveau tour → la liste todo n'a encore rien reçu (cf. logique de
        // fin de tour : liste ouverte non touchée de tout le tour = abandon).
        _todoTouchedThisTurn = false;
        // Jeton de CETTE génération — incrémenté AVANT les awaits de cleanup
        // ci-dessous. Indispensable : l'épilogue d'une ancienne génération
        // (rejet AbortError en microtâche pendant nos awaits) compare son
        // jeton à _activeGen ; sans incrément précoce, il s'exécuterait avec
        // un jeton encore « courant » et écraserait isStreaming/abortController
        // de la NOUVELLE génération (composer bloqué sur Envoyer pendant tout
        // le stream, double-envoi possible, Stop mort). L'incrément précoce ne
        // coupe que le dispatch d'events d'un stream abandonné.
        const myGen = ++_activeGen;
        // Run de CE tour (chantier C) : chat et messages figés ici. Si
        // l'utilisateur quitte la conversation avant l'envoi, le tour part
        // quand même avec SES messages et SON identifiant, puis se lit en
        // arrière-plan côté serveur.
        const _runMsgs = messages.value;
        const run = { gen: myGen, chatId: null, posted: false, detached: false };
        _currentRun = run;
        _pendingReattach = null;
        try {

        // -- Skills épinglés (/skill) : snapshot one-shot ----------------
        // On capture les noms AVANT la boucle de retry et on vide les chips
        // tout de suite (portée = ce message). Le snapshot survit aux retries ;
        // les chips, eux, disparaissent dès l'envoi.
        const _pinnedSkillNames = (pinnedSkills.value || []).map(s => s.name);
        pinnedSkills.value = [];
        // Un envoi (groupé via le panneau ask_user OU saisie libre) clôt le
        // questionnaire en cours : l'utilisateur a répondu, d'une façon ou d'une autre.
        askUserPanel.value = null;

        // -- Cleanup blob URLs des messages précédents ------------------
        // Les screenshots ne sont pas persistés en DB ; on libère la mémoire.
        try {
            for (let _i = 0; _i < messages.value.length; _i++) {
                const m = messages.value[_i];
                if (m.webScreenshots && m.webScreenshots.length) {
                    for (const s of m.webScreenshots) {
                        if (s.blobUrl) {
                            try { URL.revokeObjectURL(s.blobUrl); } catch (_) {}
                        }
                    }
                    // Remplacement d'objet (compat v-memo) : la ligne doit
                    // re-rendre pour ne pas afficher des blobs révoqués.
                    messages.value[_i] = Object.assign({}, m, {
                        webScreenshots: [], webScreenshotIdx: null, webScreenshotExpanded: false,
                    });
                }
            }
        } catch (_) {}


        // un abort qui suit immédiatement un autre abort
        // peut laisser le reader.cancel() précédent en cours d'exécution
        // (cancel est asynchrone). Le 2e fetch démarrait pendant que le
        // 1er reader était encore en train de finaliser → connexion
        // HTTP qui restait ouverte côté backend, double consommation
        // de quota éventuel, et logs server avec deux requests parallèles
        // pour le même chat. On laisse 1 tick d'event loop au cleanup.
        if (abortController.value) {
            try { abortController.value.abort(); } catch (_) {}
            abortController.value = null;
            await new Promise(r => setTimeout(r, 0));
        }
        abortController.value = new AbortController();

        // -- Ensure the chat exists on the server BEFORE streaming --
        // This lets the sidebar show the chat immediately (with spinner).
        // Extrait en _ensureServerChat : sendMessage fait le MÊME appel en
        // pré-vol quand la lecture seule est armée sur un chat vierge.
        if (!currentChatId.value && !isContinue) {
            const _firstUser = messages.value.find(m => m.role === 'user');
            const created = await _ensureServerChat(
                _firstUser ? (_firstUser.displayContent || _firstUser.content || '') : '', run);
            if (created) run.chatId = String(created);
            if (!created) {
                // Échec SILENCIEUX auparavant : la génération démarrait
                // quand même, la réponse s'affichait normalement… mais
                // currentChatId restait null, donc la conversation
                // n'existait nulle part côté serveur et disparaissait
                // entièrement au rechargement de la page. On prévient
                // avant, pendant que la réponse est encore copiable —
                // même contrat que le toast `persisted === false`.
                // (Lecture seule armée : ce chemin est INATTEIGNABLE — le
                // pré-vol de sendMessage a déjà créé le chat ou annulé
                // l'envoi. Aucun tour ne peut mentir sur le mode.)
                showToast('Conversation non enregistrée côté serveur : '
                        + 'cette réponse sera perdue si vous rechargez la '
                        + 'page. Copiez ce qui vous importe.',
                          'warning', { duration: 15000 });
            }
        }

        // Track which chat this stream belongs to
        if (!run.chatId) run.chatId = String(currentChatId.value || ('__pending_' + Date.now()));
        if (!run.detached) _streamingForChatId = run.chatId;
        // Un nouveau tour prend le relais du suivi éventuel sur ce chat.
        if (followedRunChatId.value
                && String(followedRunChatId.value) === String(_streamingForChatId)) {
            try { stopFollowRun(); } catch (_) {}
        }

        // Conversation QUITTÉE avant l'envoi (chantier C) : le tour part
        // quand même (fil figé ``_runMsgs``), mais plus rien ne touche à l'état
        // d'écran — il appartient désormais à la conversation affichée.
        const _early = run.detached;
        if (!_early) {
        // -- RESET COMPLET de tous les buffers et timers -----------------
        // Indispensable pour éviter la contamination entre requêtes
        // (buffers polués si la requête précédente a crashé ou été interrompue)
        _stopStreamFlush();
        if (_thinkFlushTimer)      { clearInterval(_thinkFlushTimer);      _thinkFlushTimer      = null; }
        if (_preContentFlushTimer) { clearInterval(_preContentFlushTimer); _preContentFlushTimer = null; }
        _streamBuf      = '';
        _thinkBuf       = '';
        _preContentBuf  = '';
        _seedLiveCtx();   // démarre la jauge ctx LIVE (croît à chaque token)
        // Reset des tool streams — les clés `${chatId}:${iter}:${index}` se
        // recyclent entre prompts (iter repart à 0). Si un state survivait
        // d'un prompt précédent (cleanup raté, race condition sur `final`),
        // le premier tool_call_delta du nouveau prompt retomberait sur ce
        // zombie → comportement imprévisible (a déclenché un bug où un
        // read_file en prompt N+1 héritait de l'état write_file du prompt N).
        // On revert toute édition optimiste encore ouverte pour ne pas
        // laisser l'éditeur dans un état partiel, puis on purge la Map.
        if (!isContinue) {
            // Seulement CETTE conversation : les flux d'un chat détaché ont été
            // fermés au détachement, ceux d'un autre chat ne nous regardent pas.
            _closeToolStreamsFor(currentChatId.value || _streamingForChatId || null);
        }
        // ----------------------------------------------------------------

        // isStreaming déjà posé au début du try (avant tout await) — anti double-send.
        isThinking.value      = true;
        statusText.value      = '';
        isUserScrolling.value = false;
        if (ctx._lockAutoScroll) ctx._lockAutoScroll();
        }

        if (!isContinue) {
            // Nouveau tour : les bulles précédentes ne sont plus reprenables
            // (cf. _retirerReprisesPerimees).
            _retirerReprisesPerimees(_runMsgs, -1);
            // Strip thinking data from all previous assistant messages
            // to free memory -- only the latest response keeps its thinking.
            for (let i = 0; i < _runMsgs.length; i++) {
                if (_runMsgs[i].role === 'assistant' && _runMsgs[i].thinking) {
                    _runMsgs[i] = Object.assign({}, _runMsgs[i], { thinking: '', thinkingOpen: false });
                }
            }
            _runMsgs.push({
                role: 'assistant', content: '',
                thinking: '', thinkingOpen: false,
                _statusLine: '', isStreaming: true,
                isError: false, errorMessage: '', isTruncated: false,
            });
        }

        let retryCount = 0;
        if (!_early) {
            nextTick(() => scrollToBottom(true));
            _toolsExecutedThisTurn = false;   // audit 2026-08-02 (W3) — nouveau tour
            _streamToolPhase       = false;   // (2026-09-02) routage du contenu : corps
            _resetDeltaStatus();              // (passe 8, F7)
        }

        while (true) {
            if (retryCount > 0) {
                // au lieu de présumer que le dernier message du tableau
                // est l'assistant à reset (faux si un stream bg a pushé entre
                // temps ou si l'user a switché de chat pendant le wait), on
                // recherche EXPLICITEMENT le message en cours de streaming
                // (isStreaming=true). Si rien ne matche, on abandonne le retry.
                const retryMsgs = _getStreamMsgs();
                let resetIdx = -1;
                for (let _ri = retryMsgs.length - 1; _ri >= 0; _ri--) {
                    if (retryMsgs[_ri].role === 'assistant' && retryMsgs[_ri].isStreaming) {
                        resetIdx = _ri; break;
                    }
                }
                if (resetIdx >= 0) {
                    retryMsgs[resetIdx] = Object.assign({}, retryMsgs[resetIdx], {
                        content: '', thinking: '', _pendingPreContent: '',
                        isError: false, errorMessage: '', isTruncated: false,
                    }, _STREAM_RENDER_CLEAR, _PRE_RENDER_CLEAR);
                }
                _streamBuf = '';
                // (2026-09-02) un tool_call_delta a pu poser la phase outils
                // avant l'erreur (coupure en pleine génération des args) : le
                // tour rejoué repart corps markdown.
                if (_preContentFlushTimer) { clearInterval(_preContentFlushTimer); _preContentFlushTimer = null; }
                _preContentBuf = ''; _streamToolPhase = false;
                await new Promise(r => setTimeout(r, retryCount * 1500));
            }

            try {
                const sMsgs = run.detached ? _runMsgs : _getStreamMsgs();
                const rawPayloadMsgs = isContinue ? sMsgs : sMsgs.slice(0, -1);

                // ── Respond-now : capture + consommation du marqueur ───────
                // On CAPTURE le prefill AVANT de l'effacer. L'effacement
                // est one-shot (évite qu'un retry-after-error le ré-applique).
                // Le prefill capturé est ré-injecté juste après le .map()
                // en tant que dernier message {role:'assistant', content:prefill}
                // — le filtre laisserait tomber l'assistant nettoyé (content=''
                // et plus de _respondNowPrefill), donc il faut l'ajouter à la
                // main sinon le prefill serait PERDU (c'était un bug latent
                // de l'implémentation précédente : le marqueur était effacé
                // avant que le .map() puisse le lire, car rawPayloadMsgs
                // pointe sur la même array que sMsgs).
                //
                // IMPORTANT — llama.cpp CONTRAINTE : un "assistant prefill"
                // (dernier message role=assistant dans les inputs) est
                // INCOMPATIBLE avec `enable_thinking=true`. Le serveur
                // renvoie un 400 "Assistant prefill is incompatible with
                // enable_thinking". On DOIT donc envoyer thinking_mode=false
                // pour cette requête précise. C'est une contrainte technique
                // du backend, pas un choix UX.
                //
                // Conséquence : le tool-loop démarré par cette requête
                // tourne entièrement en thinking_mode=false, y compris ses
                // itérations internes éventuelles. Cela reste cohérent avec
                // l'intention : respond-now signifie "réponds maintenant,
                // plus de raisonnement" pour CE tour. Le PROCHAIN tour
                // utilisateur retrouve normalement son thinking (dérivé du
                // budget, forceThinkingOff n'est pas persistant — une fois
                // le marqueur consommé, il ne se réactive pas).
                let respondNowPrefill = null;
                if (isContinue && rawPayloadMsgs.length > 0) {
                    const lastSrc = rawPayloadMsgs[rawPayloadMsgs.length - 1];
                    if (lastSrc && lastSrc.role === 'assistant' && lastSrc._respondNowPrefill) {
                        respondNowPrefill = lastSrc._respondNowPrefill;
                        // Efface le marqueur sur la source (one-shot)
                        const cleared = Object.assign({}, lastSrc);
                        delete cleared._respondNowPrefill;
                        sMsgs[sMsgs.length - 1] = cleared;
                    }
                }

                // NOTE : plus de filtrage isCompressedSummary. La
                // compression est backend-only désormais ; les résumés
                // vivent côté serveur comme system messages invisibles
                // dans l'UI, et sont réinjectés automatiquement à chaque
                // appel LLM par le backend. Le front envoie les messages
                // utilisateur bruts et laisse le backend décider.
                // Projection PARTAGÉE avec _saveSession
                // (cf. _keepForPersist / _projectForPersist) : ce blob sert à
                // la fois de payload LLM et de source du persist serveur, donc
                // toute divergence entre les trois chemins se paie en perte de
                // données. `notice` est renvoyé TEL QUEL (exclu de la vue LLM
                // côté serveur) ; `tool_history` est replayée par la route
                // ``/api/chat-saved-stream3`` pour que Continue retrouve le
                // contexte agentic complet.
                let payloadMsgs = rawPayloadMsgs
                    .filter(_keepForPersist)
                    .map(_projectForPersist);

                // Respond-now : on injecte le prefill capturé comme dernier
                // message assistant. llama.cpp prend un message assistant
                // terminal comme "prompt completion" et génère des tokens
                // qui s'AJOUTENT à son contenu. Le bloc `<think>…</think>\n\n`
                // déjà fermé signale au modèle que le raisonnement est
                // capturé → il enchaîne directement sur la réponse.
                if (respondNowPrefill) {
                    payloadMsgs.push({ role: 'assistant', content: respondNowPrefill });
                }

                // Compression : gérée par le backend pendant le stream.
                // _compressIfNeeded() est un no-op conservé pour compat.
                const assistantIdx = sMsgs.length - 1;
                payloadMsgs = await _compressIfNeeded(payloadMsgs, assistantIdx);

                let activeServers = [];
                // Interrupteur « Outils externes » (settings.enable_mcp) : il ne
                // masquait que le bouton et le panneau, pendant que les catégories
                // cochées continuaient de partir au modèle — et le panneau caché
                // rendait impossible de les décocher. On n'envoie donc plus rien
                // quand il est coupé. Le backend applique la MÊME règle (c'est lui
                // qui fait autorité) et réinjecte les seuls outils de mémoire.
                // Clé absente = ON, comme côté serveur (fail-open).
                const _mcpOn = settings.value.enable_mcp !== false;
                if (_mcpOn) {
                    const activeCategories = Object.keys(localTools.value).filter(k => localTools.value[k]);
                    if (activeCategories.length > 0)
                        activeServers.push({ type: 'stdio', name: 'Outils Locaux', command: 'DEFAULT_LOCAL_PYTHON', filter_categories: activeCategories });
                    // Serveurs déclarés dans mcp.json : RÉFÉRENCE par nom, le
                    // backend résout URL / en-têtes / commande depuis le manifeste.
                    for (const s of (manifestServers.value || [])) {
                        if (s && manifestTools.value[s.name])
                            activeServers.push({ manifest: s.name, name: s.name, type: 'manifest' });
                    }
                    config.value.active_mcp_ids.forEach(id => {
                        const srv = _pinnedServers().find(s => s.id === id);
                        if (!srv) return;
                        // RÉFÉRENCE seule, perso comme partagé : le backend
                        // résout URL + en-tête d'auth depuis son magasin. Le
                        // navigateur ne détient plus les identifiants (chiffrés
                        // en base), et une config forgée côté client ne peut
                        // plus faire ouvrir une URL arbitraire au serveur.
                        activeServers.push({ id: srv.id, name: srv.name,
                                             type: srv.type,
                                             ...(srv.shared ? { shared: true } : {}) });
                    });
                }

                // Contrôleur du run : celui de l'écran, ou un contrôleur local si
                // la conversation a été quittée avant l'envoi (le détachement a
                // rendu l'écran à la conversation suivante).
                const _ctl = (!run.detached && abortController.value) || new AbortController();
                run.posted = true;
                const response = await fetch('/api/chat-saved-stream3', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messages:            payloadMsgs,
                        // Identifiant FIGÉ du run (jamais ``currentChatId`` relu
                        // après un await : la conversation affichée a pu changer).
                        chat_id:             (run.chatId && !run.chatId.startsWith('__')) ? run.chatId : '',
                        // Run reprenable (chantier C) : journalisé côté serveur et
                        // détaché — non annulé — si la lecture s'arrête.
                        resumable:           true,
                        use_rag:             config.value.use_rag,
                        rag_collection:      config.value.rag_collection,
                        rag_search_mode:     config.value.rag_search_mode || 'classic',
                        rag_top_k:           config.value.rag_top_k || 8,
                        // was `!== true` → envoyait l'inverse de la config utilisateur.
                        // Quand l'utilisateur activait MMR, le backend recevait false, et vice-versa.
                        rag_use_mmr:         config.value.rag_use_mmr === true,
                        ctx_size:            _getCtxSize(),   // n_ctx du modèle -- limite doc à 80%
                        active_mcp_servers:  activeServers,
                        // Outils décochés un par un (2026-09-12). Canal séparé
                        // des serveurs : c'est une donnée du CHAT, appliquée
                        // côté serveur après connexion (``deny_tool_names``).
                        excluded_tools:      _mcpOn ? _excludedNames() : [],
                        model:               selectedModel.value || null,
                        connector_id:        selectedConnector.value || null,
                        // thinking_mode est DÉRIVÉ du budget dans le panneau
                        // Sampling — source de vérité unique depuis la refonte :
                        //   samplingOverride.thinking_budget_tokens > 0 → réflexion ON
                        //   null / 0                                    → réflexion OFF
                        // Le toggle switch séparé a été retiré (redondant avec
                        // la capacité de mettre le budget à 0).
                        //
                        // EXCEPTION respond-now : si un prefill a été injecté
                        // (respondNowPrefill capturé plus haut), on force
                        // thinking_mode=false. C'est une CONTRAINTE llama.cpp —
                        // le serveur refuse avec 400 "Assistant prefill is
                        // incompatible with enable_thinking" si on lui envoie
                        // un dernier message role=assistant avec enable_thinking
                        // actif en même temps.
                        //
                        // Note : pour isContinue, plus besoin de forcer false
                        // car le backend strippe le content du dernier
                        // assistant et expand sa tool_history à la place →
                        // pas de prefill du tout, juste un contexte agentique
                        // complet pour reprendre le travail.
                        thinking_mode:       respondNowPrefill
                                                ? false
                                                : (typeof samplingOverride.value.thinking_budget_tokens === 'number'
                                                    && samplingOverride.value.thinking_budget_tokens > 0),
                        is_continue:         isContinue,
                        // Skills épinglés via /skill : injectés de force pour ce
                        // message (en plus de l'auto-matching). Snapshot one-shot.
                        pinned_skills:       _pinnedSkillNames,
                        // Override des paramètres de sampling pour ce chat.
                        // null => backend utilise /props du modèle.
                        sampling_override:   _cleanSamplingOverride(),
                    }),
                    signal:      _ctl.signal,
                    credentials: 'same-origin',
                });

                // Conversation quittée pendant l'envoi : le serveur a le tour,
                // il le mène à terme ; on ne lit pas son flux ici.
                if (run.detached) {
                    if (response.ok) _markRunActive(run.chatId);
                    try { _ctl.abort(); } catch (_) {}
                    break;
                }
                if (response.ok) _markRunActive(run.chatId);
                if (response.status === 401) throw Object.assign(new Error('401'), { _is401: true });
                // F14 — 409 = état MÉTIER (compression manuelle en cours sur ce
                // chat, éventuellement depuis un autre onglet/worker), PAS une
                // panne réseau : ne PAS lancer les « Reconnexion (1/2)… » ni un
                // faux « Erreur de connexion ». Message clair + arrêt propre.
                // 429 = plafond de générations simultanées pour ce compte
                // (audit 2026-08-22, D4). État MÉTIER, comme le 409 : ni
                // retry, ni « erreur de connexion ».
                if (response.status === 429) {
                    const _msg = 'Trop de générations en cours sur votre compte '
                               + '— attendez qu\'une d\'elles se termine.';
                    const _emsgs429 = _getStreamMsgs();
                    const _li429 = _emsgs429.length - 1;
                    if (_li429 >= 0 && _emsgs429[_li429]
                            && _emsgs429[_li429].role === 'assistant') {
                        _patch(_li429, { isError: true, errorMessage: _msg,
                                         isStreaming: false, ..._STREAM_RENDER_CLEAR });
                    }
                    showToast(_msg, 'info');
                    break;
                }
                if (response.status === 409) {
                    let _reason = '';
                    let _detail = null;
                    try {
                        _detail = ((await response.json()) || {}).detail;
                        _reason = (typeof _detail === 'string') ? _detail
                            : ((_detail && _detail.code) || '');
                    } catch (_) {}
                    // Serveur supprimé, désactivé ou fermé à ce compte (2026-09-16) :
                    // plus de repli muet sur l'intégré. Message clair, et la paire
                    // (connecteur, modèle) est abandonnée pour ne pas re-échouer.
                    if (_reason === 'engine_unavailable') {
                        const _em = (_detail && _detail.message) || 'Serveur indisponible.';
                        const _emsgs = _getStreamMsgs();
                        const _li = _streamIdx(_emsgs);
                        if (_li >= 0 && _emsgs[_li] && _emsgs[_li].role === 'assistant') {
                            _patch(_li, { isError: true,
                                          errorMessage: _em + ' Choisissez un autre serveur dans le sélecteur de modèle.',
                                          isStreaming: false, ..._STREAM_RENDER_CLEAR });
                        }
                        showToast(_em, 'error');
                        if (selectedConnector.value) {
                            selectedConnector.value = '';
                            try { localStorage.setItem('selected_connector', ''); } catch (_) {}
                        }
                        try { loadLlmConnectors(); loadAvailableModels(); } catch (_) {}
                        break;   // pas de retry
                    }
                    const _isGen = (_reason === 'generation_running');
                    const _msg = (_reason === 'compression_running')
                        ? 'Compression du contexte en cours — réessaie dans un instant.'
                        : (_isGen
                            ? 'Une génération est déjà en cours sur cette '
                              + 'conversation — elle se rechargera à la fin.'
                            : 'Une autre opération est en cours sur ce chat — réessaie dans un instant.');
                    const _emsgs = _getStreamMsgs();
                    const _li = _streamIdx(_emsgs);      // (passe 9, F2)
                    if (_li >= 0 && _emsgs[_li] && _emsgs[_li].role === 'assistant') {
                        _patch(_li, { isError: !_isGen, errorMessage: _msg,
                                      isStreaming: false, ..._STREAM_RENDER_CLEAR });
                    }
                    showToast(_msg, 'info');
                    // AUDIT 2026-08-22 (B1/B3) — ce 409 signifie qu'un run
                    // tourne toujours sur ce chat (l'onglet précédent est
                    // parti, le serveur l'a détaché). On le SUIT au lieu de
                    // laisser l'utilisateur deviner : la conversation se
                    // rechargera d'elle-même quand il aura fini.
                    if (_isGen) {
                        const _sfc409 = String(_streamingForChatId || '');
                        followRun(currentChatId.value
                                  || (_sfc409.indexOf('__pending_') === 0 ? '' : _sfc409),
                                  { silent: true });
                    }
                    break;   // pas de retry
                }
                if (!response.ok) throw new Error('HTTP ' + response.status);

                // déclarer reader AVANT le try interne pour qu'il
                // soit accessible dans le catch lors d'un retry ou d'une AbortError.
                let reader = null;
                try {
                    reader  = response.body.getReader();
                    const decoder = new TextDecoder('utf-8');
                    let   buf     = '';
                    // AUDIT moteur d'événements 2026-09-25 (B4) — fin de flux
                    // PROPRE sans ``final`` ni ``error`` (worker mort avant sa
                    // conclusion, run détaché qui plante) : l'épilogue la
                    // traitait comme une réussite, la bulle restait vide ou
                    // tronquée sans rien dire. Le chemin de rattachement gérait
                    // déjà ce cas (``!sawFinal`` → rechargement) ; même filet ici.
                    let _sawTerminal = false;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            if (!_sawTerminal && myGen === _activeGen) {
                                const _sfc = String(_streamingForChatId || '');
                                const _endId = currentChatId.value
                                          || (_sfc.indexOf('__pending_') === 0 ? '' : _sfc);
                                if (_endId) _pendingReattach = String(_endId);
                            }
                            break;
                        }
                        buf += decoder.decode(value, { stream: true });
                        const lines = buf.split('\n');
                        buf = lines.pop();
                        for (const line of lines) {
                            if (!line.trim()) continue;
                            // Cette génération a-t-elle été supplantée ? Si oui, on
                            // arrête net : continuer écrirait des events de ce stream
                            // abandonné dans le chat courant (potentiellement un autre).
                            if (myGen !== _activeGen) break;
                            let _evt = null;
                            try { _evt = JSON.parse(line); } catch(e) { continue; }
                            if (_evt && (_evt.type === 'final' || _evt.type === 'error')) _sawTerminal = true;
                            try { await handleStreamEvent(_evt); }
                            catch(e) { console.error('[chat] handleStreamEvent a échoué :', e, _evt && _evt.type); }
                        }
                        if (myGen !== _activeGen) break;
                    }
                } finally {
                    // Fermer le reader dans tous les cas (abort, erreur, retry)
                    // pour libérer la connexion HTTP vers le backend.
                    // ⚠ cancel() renvoie une PROMESSE : après un abort (Stop),
                    // elle rejette « BodyStreamBuffer was aborted » — le catch
                    // synchrone ne la voit pas → unhandled rejection à chaque
                    // Stop. On l'avale explicitement.
                    try {
                        if (reader) {
                            const _p = reader.cancel();
                            if (_p && typeof _p.catch === 'function') _p.catch(() => {});
                        }
                    } catch(_) {}
                }

                break;

            } catch(e) {
                if (e.name === 'AbortError') {
                    break;
                }
                if (e._is401 || e.message === '401') {
                    showToast('Session expirée, reconnexion...', 'error');
                    await ctx.checkAuth();
                    break;
                }
                // AUDIT 2026-08-02 (W3) — ne JAMAIS rejouer automatiquement
                // un tour dont des outils ont déjà été exécutés : le re-POST
                // relance la boucle d'outils côté serveur (aucune clé
                // d'idempotence) → fichiers réécrits, commits en double.
                // C'est exactement le cas d'une coupure en plein run agentic
                // (recyclage/redémarrage de worker à 80 % du tour).
                if (retryCount < MAX_RETRIES && !_toolsExecutedThisTurn) {
                    retryCount++;
                    statusText.value = 'Reconnexion (' + retryCount + '/' + MAX_RETRIES + ')...';
                    continue;
                }
                const _errMsgs = _getStreamMsgs();
                const li = _streamIdx(_errMsgs);        // (passe 9, F2)
                // Ne marquer l'erreur que si le dernier message est bien
                // l'assistant en cours de stream (évite de flagger par erreur
                // un message user si la liste a été mutée entre-temps).
                if (li >= 0 && _errMsgs[li] && _errMsgs[li].role === 'assistant') {
                    // AUDIT 2026-08-22 (B3) — quand des outils ont tourné, le
                    // serveur DÉTACHE le run au lieu de l'annuler : il va au
                    // bout et persiste seul. Le message n'est donc pas en
                    // erreur, il est en cours ailleurs.
                    const _emsg = _toolsExecutedThisTurn
                        ? 'Connexion interrompue — la génération se poursuit '
                          + 'côté serveur. Cette conversation se rechargera '
                          + 'automatiquement à la fin.'
                        : (e.message || 'Erreur réseau');
                    _patch(li, { isError: !_toolsExecutedThisTurn,
                                 errorMessage: _emsg, isStreaming: false,
                                 ..._STREAM_RENDER_CLEAR });
                }
                if (_toolsExecutedThisTurn) {
                    // Chat neuf : ``_streamingForChatId`` peut encore être le
                    // marqueur « __pending_ » (l'id définitif est attribué par
                    // le serveur et posé sur currentChatId à l'event chat_id).
                    // Chantier C : le run est journalisé — on s'y RATTACHE (bulle,
                    // étapes et Stop reviennent) ; sondage en repli seulement.
                    const _sfc = String(_streamingForChatId || '');
                    const _cutId = currentChatId.value
                              || (_sfc.indexOf('__pending_') === 0 ? '' : _sfc);
                    if (_cutId) _pendingReattach = String(_cutId);
                    showToast('Connexion interrompue — la génération se poursuit '
                              + 'côté serveur, reprise de l’affichage…', 'info');
                } else {
                    showToast('Erreur de connexion', 'error');
                }
                break;
            } finally {
                _stopStreamFlush();
            }
        }


        // Épilogue gardé par le jeton de génération : si une NOUVELLE
        // génération a pris la main (myGen périmé), ne toucher NI aux flags
        // UI NI à abortController/_streamingForChatId — ils appartiennent
        // désormais à la nouvelle génération (sinon : isStreaming écrasé à
        // false pendant son stream, et son Stop devient inopérant).
        if (myGen === _activeGen) {
            // AUDIT 2026-08-31 (passe 4, F1) — sorties d'erreur (429, 409,
            // échec réseau après retries) : seuls 'final' et stopGeneration
            // appelaient _clearLiveCtx. La ligne de stats live restait
            // affichée, suivait l'utilisateur d'une conversation à l'autre,
            // et son ticker réassignait ``liveGen`` 5×/s pour le reste de la
            // session (re-rendu racine permanent). Les timers de flush
            // thinking/pré-contenu fuyaient pareil. Filet unique ici, gardé
            // par le jeton : une génération supplantée ne touche pas à l'état
            // re-seedé par sa remplaçante.
            if (_ctxLive) _clearLiveCtx();
            if (_thinkFlushTimer)      { clearInterval(_thinkFlushTimer);      _thinkFlushTimer      = null; }
            if (_preContentFlushTimer) { clearInterval(_preContentFlushTimer); _preContentFlushTimer = null; }
            // Passe 4 (F11) — questionnaire ask_user stashé pendant un tour
            // qui vient d'échouer (coupure HTTP/réseau) : sans purge, il
            // ressurgissait au ``final`` du TOUR SUIVANT (posthume).
            _pendingAskUser = null;
            // Only reset UI flags if no other stream took over
            {
                // AUDIT 2026-08-22 (B3) — si on SUIT un run détaché sur la
                // conversation affichée, la génération n'est pas finie : elle
                // se poursuit sur le serveur. On garde donc l'état « en
                // cours », ce qui laisse le bouton Arrêter disponible (le Stop
                // atteint le bon worker par le bus d'annulation) et empêche
                // d'envoyer un message qui serait de toute façon refusé.
                const _following = !!followedRunChatId.value
                    && String(followedRunChatId.value) === String(currentChatId.value);
                isStreaming.value = _following;
                isThinking.value  = false;
                if (_following) statusText.value = 'Génération en arrière-plan…';
            }
            abortController.value = null;
            pendingWrite.value    = null;
            // Sortie sans ``final`` (erreur, coupure, 409/429) : le run n'est plus
            // lu ici. Coupure après outils : rattachement au journal.
            if (!_pendingReattach) _markRunDone(run.chatId);
            _streamingForChatId   = null;
            if (_currentRun === run) _currentRun = null;
        }
        if (_pendingReattach && myGen === _activeGen) {
            const _rid = _pendingReattach;
            _pendingReattach = null;
            _reattachOrFollow(_rid);
        }

        nextTick(() => { addCodeCopyButtons(); if (user.value) loadChatsList(); });

        } catch (e) {
            // Erreur précoce (avant le reset nominal en fin de génération) : on
            // relâche le garde anti double-send, sinon l'UI resterait bloquée.
            // Gardé par le jeton : une génération supplantée ne doit pas
            // écraser les flags de celle qui l'a remplacée.
            if (myGen === _activeGen) {
                isStreaming.value = false;
                isThinking.value = false;
                // Passe 4 (F1) — même filet que l'épilogue nominal.
                if (_ctxLive) _clearLiveCtx();
            }
            throw e;
        }
    }

    async function generateResponse() { await _doGenerate(false); }

    // ===========================================================
    //  FILE BLOCKS PARSER (for display)
    // ===========================================================
    function _parseFileBlocks(content) {
        if (!content || !content.includes('FILE:')) return { files: undefined, displayContent: undefined };
        // Regex tolérante : espaces optionnels, \r\n ou \n, contenu qui finit ou pas par \n
        const regex = /---\s*FILE:\s*(.+?)\s*---\r?\n([\s\S]*?)\r?\n?---\s*END FILE\s*---/g;
        const files = [];
        let match;
        while ((match = regex.exec(content)) !== null) {
            const name = match[1].trim();
            const body = match[2] || '';
            const lines = body.split('\n').length;
            files.push({ name, lines });
        }
        if (files.length === 0) return { files: undefined, displayContent: undefined };
        const displayContent = content.replace(/---\s*FILE:\s*.+?\s*---\r?\n[\s\S]*?\r?\n?---\s*END FILE\s*---\s*/g, '').trim();
        return { files, displayContent };
    }

    // ===========================================================
    //  SEND / RETRY
    // ===========================================================

    async function sendMessage() {
        closeMentionDropdown();

        // ── Commande « / » tapée intégralement à la main ──────────────
        // Second point d'entrée du menu (le premier étant la sélection
        // d'une rangée) : sans lui, « /plan on » suivi d'Entrée partirait
        // au modèle comme un message. Une commande INCONNUE, elle, part
        // normalement — slashResolve renvoie null.
        //
        // Placé AVANT la garde isStreaming pour qu'un refus soit DIT
        // (toast) au lieu d'être silencieux, et avant toute consommation
        // de attachedFiles : une commande ne doit pas détruire une pièce
        // jointe en attente.
        const _slashHit = slashResolve ? slashResolve(inputMessage.value) : null;
        if (_slashHit) {
            inputMessage.value = '';
            if (slashDismiss) slashDismiss();
            nextTick(() => { ctx.autoResize && ctx.autoResize(); });
            await slashRun(_slashHit);
            return;
        }

        // anti double-send : on check isStreaming AVANT
        // de consommer attachedFiles. Avant, l'ordre était :
        //   1. Build filesMeta + imageMetas
        //   2. attachedFiles.value = []          ← fichiers vidés ici
        //   3. if (!hasContent || isStreaming) return;
        // Si l'utilisateur cliquait 2 fois pendant un stream :
        //   - 1er clic : OK, fichiers envoyés
        //   - 2e clic pendant que le 1er stream tourne : fichiers vidés
        //     en (2), puis return en (3) → l'utilisateur a perdu ses
        //     attachments sans s'en rendre compte.
        // On vérifie isStreaming d'abord ; les fichiers ne sont consommés
        // que si on va vraiment les envoyer.
        if (isStreaming.value) return;

        // ── Lecture seule ARMÉE sur chat vierge : pré-vol fail-FERMÉ ──
        // Le chat doit exister côté serveur AVANT le stream, sinon la route
        // de génération le créerait avec un meta_json vide → premier tour
        // AVEC les outils d'écriture pendant que le témoin annonce la
        // lecture seule. Placé AVANT toute consommation (message pas encore
        // poussé, pièces jointes intactes) : un échec n'a rien perdu,
        // l'utilisateur peut réessayer tel quel.
        if (planMode.value && !currentChatId.value) {
            const ok = await _ensureServerChat(inputMessage.value.trim());
            if (!ok) {
                showToast('Mode plan impossible à garantir (le serveur '
                        + "n'a pas créé la conversation) — message non envoyé. "
                        + 'Réessayez, ou coupez le mode avec /plan off.',
                          'error', { duration: 10000 });
                return;
            }
        }

        let text = inputMessage.value.trim();
        let filesMeta  = [];
        let imageMetas = [];   // { name, dataUrl, mimeType } -- for display in bubble

        if (attachedFiles.value.length > 0) {
            const textFiles  = attachedFiles.value.filter(f => !f.isImage);
            const imageFiles = attachedFiles.value.filter(f =>  f.isImage);

            // Text files → injected as plain context blocks
            if (textFiles.length > 0) {
                filesMeta = textFiles.map(f => ({ name: f.name, lines: (f.content || '').split('\n').length }));
                const fileCtx = textFiles
                    .map(f => '--- FILE: ' + f.name + ' ---\n' + f.content + '\n--- END FILE ---')
                    .join('\n\n');
                text = fileCtx + (text ? '\n\n' + text : '');
            }

            // Images → kept as data URLs for display + API
            imageMetas = imageFiles.map(f => ({ name: f.name, dataUrl: f.content, mimeType: f.mimeType }));

            attachedFiles.value = [];
        }

        const hasContent = text || imageMetas.length > 0;
        if (!hasContent) return;

        // Envoyer = « j'ai fini de dicter » : le micro se coupe. Placé APRÈS
        // les gardes, pour qu'un envoi refusé (génération en cours, message
        // vide) ne coupe pas une dictée qui continue.
        try { _voiceMod.stopDictation(); } catch (e) { console.error('[voix]', e); }

        messages.value.push({
            role:           'user',
            content:        text || '',
            files:          filesMeta.length   > 0 ? filesMeta   : undefined,
            images:         imageMetas.length  > 0 ? imageMetas  : undefined,
            displayContent: (filesMeta.length > 0 || imageMetas.length > 0)
                            ? inputMessage.value.trim()
                            : undefined,
        });
        // (passe 8, F14) — réponses ask_user envoyées : le brouillon revient.
        inputMessage.value = _composeRestoreDraft !== null ? _composeRestoreDraft : '';
        _composeRestoreDraft = null;
        nextTick(() => { autoResize(); if (inputRef.value) inputRef.value.focus(); });
        await generateResponse();
    }

    // ── REPRENDRE après erreur (préserve les tool calls réussis) ────────────
    // Appelé par le bouton « Reprendre » de l'encart d'erreur QUAND le message
    // porte une tool_history (des outils ont réussi avant l'erreur — cas « erreur
    // LLM dans la boucle d'outils »). On NE JETTE PAS ce travail : on efface les
    // marqueurs d'erreur, on GARDE la tool_history, et on relance en CONTINUATION
    // (is_continue) — même chemin que continueGeneration. Le backend ré-expanse
    // la tool_history (_expand_history_for_llm) → le modèle voit ses outils déjà
    // exécutés et POURSUIT au lieu de tout re-processer. Distinct de
    // retryGeneration (qui, lui, régénère du zéro — icône « régénérer » + bouton
    // « Réessayer » quand il n'y a rien à préserver).
    async function resumeAfterError(index) {
        if (isStreaming.value) return;
        const target = messages.value[index];
        if (!target || target.role !== 'assistant') return;
        // La continuation reprend la FIN de la conversation : seul le dernier
        // assistant est reprenable. Sinon (message ancien) → régénération.
        if (index !== messages.value.length - 1 ||
            !(target.tool_history && target.tool_history.length)) {
            return retryGeneration(index);
        }
        messages.value[index] = Object.assign({}, target, {
            isError:            false,
            errorMessage:       '',
            isTruncated:        false,
            toolLoopTruncated:  false,
            toolLoopStats:      null,
            // Repasse en streaming ; la continuation APPEND — on ne vide NI
            // content NI toolSteps : le travail déjà fait reste affiché.
            isStreaming:        true,
        });
        await _doGenerate(true);   // continuation : préserve la tool_history
    }

    async function retryGeneration(index) {
        // Garde anti-réentrance : relancer pendant un stream actif décale les
        // index pendant que la boucle écrit à length-1 → suppression du mauvais
        // message. On exige un état non-streaming et un index pointant bien sur
        // un message assistant.
        if (isStreaming.value) return;
        const target = messages.value[index];
        if (!target || target.role !== 'assistant') return;
        // Sémantique alignée sur submitEditMessage : on TRONQUE à partir de
        // l'index (pas splice(index, 1) qui retirait UN message au milieu —
        // la nouvelle réponse partait en FIN de chat, laissait le user
        // d'origine orphelin, et le payload finissait par un message
        // assistant → prefill llama.cpp / 400 avec thinking).
        const willLoseCount = messages.value.length - index - 1;
        if (willLoseCount > 0) {
            const msgWord = willLoseCount > 1 ? 'messages' : 'message';
            const ok = await openConfirm(
                'Régénérer cette réponse ?',
                `La conversation sera régénérée depuis ce point. Les ${willLoseCount} ${msgWord} qui suivent seront perdus.`,
                false,
                'Régénérer',
                'Annuler'
            );
            if (!ok) return;
        }
        messages.value.splice(index);
        // Les index de messages sont RÉUTILISÉS après troncature → purge
        // l'état des diff cards (même contrat que submitEditMessage).
        if (typeof resetDiffCardState === 'function') resetDiffCardState();
        await generateResponse();
    }

    // ===========================================================
    //  ASSISTANT MESSAGE ACTIONS (UX option 1)
    //
    //  Deux actions exposées sur les messages assistant terminés :
    //    * copier la réponse en markdown brut
    //    * régénérer (proxy vers retryGeneration -- même sémantique
    //      que le bouton "Relancer" du bloc erreur)
    // ===========================================================

    async function copyAssistantMessage(content) {
        if (!content) return;
        try {
            // Préfère navigator.clipboard (https + même origine garanti
            // sur claude.ai-like setups). execCommand fallback pour les
            // contextes sans permission Clipboard API.
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(content);
            } else {
                const ta = document.createElement('textarea');
                ta.value = content;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            showToast('Réponse copiée');
        } catch (e) {
            showToast('Impossible de copier : ' + (e.message || ''), 'error');
        }
    }

    // Copie le contenu BRUT de la console d'un segment (commandes + sorties,
    // sans les spans ANSI) — format session de terminal.
    async function copyShellConsole(grp) {
        const runs = (grp && grp.shellRuns) || [];
        const raw = runs.map((r) => {
            const cmd = (r.step.args && (r.step.args.command || r.step.args.cmd)) || '';
            let t = '$ ' + cmd + '\n';
            if (r.step.shellOut) t += r.step.shellOut + (/\n$/.test(r.step.shellOut) ? '' : '\n');
            return t;
        }).join('\n');
        if (!raw) { showToast('Aucune sortie à copier.'); return; }
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(raw);
            } else {
                const ta = document.createElement('textarea');
                ta.value = raw;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            showToast('Sortie du terminal copiée');
        } catch (e) {
            showToast('Impossible de copier : ' + (e.message || ''), 'error');
        }
    }

    // ===========================================================
    //  TOOL PILLS preview (UX option 2)
    //
    //  Transforme entry.msg.toolSteps en une liste compacte de pills
    //  affichée à côté du compteur replié. Groupe les appels répétés
    //  d'un MÊME outil ("web_search ×3") pour ne pas saturer la ligne
    //  sur de longues séquences agentic.
    //
    //  Règles :
    //    * Skip les steps _kind === 'compression' (déjà comptés à part
    //      dans l'entête "+ N condensation(s)").
    //    * Groupe par nom (sans tenir compte de la position : si l'agent
    //      fait read → write → read, on affiche read ×2 / write ×1, plus
    //      lisible que 3 pills disjointes).
    //    * Tri par count desc, puis par première apparition pour stabilité.
    //    * Limite à 4 pills affichées ; au-delà, agrège les autres en
    //      "+N" (somme des counts restants).
    //
    //  Retourne { pills: [{name, count, icon}], extraCount: N }
    // ===========================================================

    function getToolPillsFor(toolSteps) {
        const out = { pills: [], extraCount: 0 };
        if (!Array.isArray(toolSteps) || toolSteps.length === 0) return out;

        // 1. Filtrer + grouper en préservant l'ordre de première apparition
        const order   = [];           // [name1, name2, ...] (insertion order)
        const counts  = Object.create(null);
        for (const s of toolSteps) {
            if (!s || s._kind === 'compression' || s._kind === 'memory' || s._kind === 'todo' || s._kind === 'task') continue;
            const name = s.name || '?';
            if (counts[name] === undefined) {
                counts[name] = 0;
                order.push(name);
            }
            counts[name]++;
        }
        if (!order.length) return out;

        // 2. Trier : count desc, puis ordre d'insertion (stable via index).
        const ordered = order
            .map((name, idx) => ({ name, count: counts[name], firstIdx: idx }))
            .sort((a, b) => (b.count - a.count) || (a.firstIdx - b.firstIdx));

        // 3. Cap à 4 pills + agréger le reste en "+N"
        const MAX_PILLS = 4;
        const head = ordered.slice(0, MAX_PILLS);
        const tail = ordered.slice(MAX_PILLS);
        const extraCount = tail.reduce((a, t) => a + t.count, 0);

        out.pills = head.map(p => ({
            name:  p.name,
            count: p.count,
            icon:  _toolIconFor(p.name),
        }));
        out.extraCount = extraCount;
        return out;
    }

    /** Heuristique nom d'outil → classe Phosphor. Volontairement permissive
     *  (substring match) pour couvrir les variantes (read_file, file_read,
     *  fileread, readFile...). Fallback sur ph-gear pour les inconnus. */
    function _toolIconFor(name) {
        const n = String(name || '').toLowerCase();
        if (n.includes('search') || n.includes('grep') || n.includes('find'))   return 'ph-magnifying-glass';
        if (n.includes('write') || n.includes('save') || n.includes('create'))  return 'ph-pencil-simple-line';
        if (n.includes('edit') || n.includes('replace') || n.includes('patch')) return 'ph-pencil-simple';
        if (n.includes('read') || n.includes('view') || n.includes('cat'))      return 'ph-eye';
        if (n.includes('delete') || n.includes('rm') || n.includes('remove'))   return 'ph-trash';
        if (n.includes('bash') || n.includes('shell') || n.includes('exec') ||
            n.includes('run')   || n.includes('command'))                       return 'ph-terminal';
        if (n.includes('git'))                                                  return 'ph-git-branch';
        if (n.includes('http') || n.includes('fetch') || n.includes('curl') ||
            n.includes('web')   || n.includes('browser'))                       return 'ph-globe';
        if (n.includes('rag') || n.includes('memory') || n.includes('todo'))    return 'ph-database';
        if (n.includes('chart') || n.includes('plot') || n.includes('graph'))   return 'ph-chart-bar';
        if (n.includes('mkdir') || n.includes('folder') || n.includes('dir'))   return 'ph-folder-simple';
        if (n.includes('move') || n.includes('rename'))                         return 'ph-arrows-left-right';
        return 'ph-gear';
    }

    // ===========================================================
    //  SEGMENTS texte/outils entrelacés (UX 2026-07-20)
    //
    //  Regroupe msg.toolSteps par segment (step.seg, posé au tool_call /
    //  reconstruit au reload) et associe chaque groupe à sa narration
    //  (msg.segTexts[gi]). Le template rend : texte du segment, puis
    //  compteur+dropdown des outils de CE segment — le compteur « repart
    //  à zéro » à chaque narration.
    //
    //  Dérivation PURE de (segTexts, toolSteps) — cache WeakMap sur
    //  l'identité du message : _patch()/setMsgUi() REMPLACENT l'objet à
    //  chaque mutation, l'invalidation est donc naturelle.
    //
    //  Retourne [{ gi, text, steps, disp, nTools, nComp, pills, running }]
    //    disp    = [{step, flat}] affichables (même filtre que
    //              toolStepsForDisplay : exclut memory/task, garde
    //              compression) ; flat = index PLAT dans msg.toolSteps
    //              (cible de _activeToolStep)
    //    nTools  = outils « vrais » du groupe (hors compression)
    //    nComp   = steps compression du groupe
    //    pills   = aperçu groupé (getToolPillsFor) limité au groupe
    //    running = un step affichable du groupe est en cours
    // ===========================================================
    // (passe 8, F13) — clé de cache = identité de (toolSteps, segTexts), pas du
    // message : la ligne live remplace l'objet message ~25×/s pendant la
    // rédaction et invalidait tout à chaque tick (groupes re-dérivés, pipeline
    // recalculé, console shell reconcaténée — jusqu'à 96 Ko — quand un
    // accordéon shell est ouvert). Les steps sont remplacés immutablement
    // (slice + _patch), donc l'identité de l'array suffit.
    const _segGroupsCache = new WeakMap();   // toolSteps → { segTexts, groups }
    const _NO_STEPS = [];
    function segGroupsFor(msg) {
        if (!msg) return [];
        const steps = Array.isArray(msg.toolSteps) ? msg.toolSteps : _NO_STEPS;
        const segTextsRaw = (Array.isArray(msg.segTexts) && msg.segTexts.length) ? msg.segTexts : null;
        const ent = _segGroupsCache.get(steps);
        if (ent && ent.segTexts === segTextsRaw) return ent.groups;
        // Repli : anciens messages live sans segTexts → tout dans un segment.
        const segTexts = segTextsRaw || (steps.length ? [''] : []);
        const groups = segTexts.map((t, gi) => ({
            gi, text: t || '', steps: [], disp: [],
            nTools: 0, nComp: 0, pills: null, running: false,
            shellRuns: [], shellMeta: null,
        }));
        for (let flat = 0; flat < steps.length; flat++) {
            const s = steps[flat];
            if (!s || !groups.length) continue;
            const gi = Math.min(Math.max(s.seg || 0, 0), groups.length - 1);
            const g = groups[gi];
            g.steps.push(s);
            // Terminal en direct : UNE console par segment, qui enchaîne les
            // commandes execute_shell du segment (façon session de terminal :
            // `$ cmd` puis sortie, à la suite). La console REMPLACE la carte
            // détail (Paramètres/Résultat) des steps shell — flag ``shell``
            // sur l'entrée disp. Inclus dès le tool_call (running → prompt
            // affiché immédiatement) ; exclus : background (rien à streamer)
            // et steps sans données console (résultat non-JSON d'anciens
            // chats — la carte outil classique les couvre).
            const isShellRun = s.name === 'execute_shell'
                && !(s.args && s.args.background)
                && (s.status === 'running' || s.shellDone || s.shellOut != null);
            if (toolStepsForDisplay([s]).length) {
                g.disp.push({ step: s, flat, shell: isShellRun });
                if (s._kind === 'compression') g.nComp++; else g.nTools++;
                if (s.status === 'running') g.running = true;
            }
            if (isShellRun) g.shellRuns.push({ step: s, flat });
        }
        for (const g of groups) {
            g.pills = getToolPillsFor(g.steps);
            if (g.shellRuns.length) {
                const runs = g.shellRuns;
                const n = runs.length;
                const running = runs.some(r => r.step.status === 'running');
                const nFail = runs.filter(r => r.step.shellDone
                    && typeof r.step.shellRc === 'number' && r.step.shellRc !== 0).length;
                const totalMs = runs.reduce((a, r) => a + (r.step.shellMs || 0), 0);
                const last = runs[n - 1].step;
                const cmd0 = (runs[0].step.args
                    && (runs[0].step.args.command || runs[0].step.args.cmd)) || 'shell';
                let chip = '';
                if (running) chip = 'en cours…';
                else if (n === 1 && typeof last.shellRc === 'number')
                    // precise : un outil rapide garde son dixième (0.2 s ≠ 0.9 s).
                    chip = 'code ' + last.shellRc + ' · ' + fmtElapsedMs(totalMs, { precise: true });
                else if (n > 1) chip = nFail
                    ? nFail + ' échec' + (nFail > 1 ? 's' : '')
                    : fmtElapsedMs(totalMs, { precise: true });
                g.shellMeta = {
                    n, running, nFail,
                    title: n === 1 ? String(cmd0).slice(0, 96) : n + ' commandes',
                    chip,
                    dot: running ? 'is-running' : (nFail ? 'is-err' : 'is-ok'),
                    truncated: runs.some(r => r.step.shellLiveTruncated),
                };
            }
        }
        _segGroupsCache.set(steps, { segTexts: segTextsRaw, groups });
        return groups;
    }

    // Aplati une narration markdown en UNE ligne de résumé pour le summary
    // du conteneur : blocs/inline code, liens, emphase et titres retirés,
    // espaces normalisés, coupe à `max` caractères.
    function _mdSnippet(t, max) {
        let s = String(t || '');
        s = s.replace(/```[\s\S]*?(```|$)/g, ' ');
        s = s.replace(/`([^`]*)`/g, '$1');
        s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
        s = s.replace(/^#{1,6}\s+/gm, '');
        s = s.replace(/(\*{1,3}|_{1,3}|~~)([^*_~]+)\1/g, '$2');
        s = s.replace(/\s+/g, ' ').trim();
        return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
    }

    // Agrégat par MESSAGE pour le conteneur « Travail de l'assistant »
    // (accordéon externe qui regroupe narration + segments d'outils hors
    // du fil principal). Dérivation pure de (segGroupsFor(msg), champs du
    // msg) — cache sur l'IDENTITÉ de l'array groups (déjà remplacé à
    // chaque _patch/setMsgUi, y compris quand _pendingPreContent grossit).
    // `summary` = début de la DERNIÈRE narration inter-outils (la LIVE en
    // priorité) : c'est le titre du summary replié, mis à jour au fil des
    // rounds. `label` = libellé de l'outil EN COURS (repli quand aucune
    // narration, + annonce a11y) — même normalisation que statusPhase.
    const _pipelineCache = new WeakMap();
    function pipelineFor(msg) {
        if (!msg) return { show: false };
        const groups = segGroupsFor(msg);
        if (!groups.length) return { show: false };
        const cached = _pipelineCache.get(groups);
        if (cached) return cached;
        let nTools = 0, nComp = 0, running = false;
        for (const g of groups) {
            nTools += g.nTools; nComp += g.nComp;
            if (g.running) running = true;
        }
        let label = '';
        if (running) {
            const steps = msg.toolSteps || [];
            for (let i = steps.length - 1; i >= 0; i--) {
                const s = steps[i];
                if (!s || s.status !== 'running' || s._kind === 'memory' || s._kind === 'todo' || s._kind === 'task') continue;
                if (s._kind === 'compression') label = 'compression du contexte';
                else if ((s.name || '').startsWith('rag_')) label = s.ragLabel || 'consultation documentaire';
                else { const a = toolKeyArg(s); label = a ? s.name + ' · ' + a : (s.name || 'outil'); }
                break;
            }
        }
        // Résumé = début de la DERNIÈRE narration FIGÉE. (passe 8, F8) — plus
        // la ligne live : elle est désormais visible SOUS le conteneur (la
        // recopier ici était redondant et invalidait les caches à chaque tick).
        let summary = '';
        const st = Array.isArray(msg.segTexts) ? msg.segTexts : [];
        for (let i = st.length - 1; i >= 0; i--) {
            if ((st[i] || '').trim()) { summary = st[i]; break; }
        }
        summary = _mdSnippet(summary, 140);
        const out = {
            show: groups.some(g => g.text || g.disp.length),
            nTools, nComp, running, label, summary,
        };
        _pipelineCache.set(groups, out);
        return out;
    }

    // HTML mémoïsé de la CONSOLE d'un segment : concatène, dans l'ordre des
    // steps, `$ commande` + sortie ANSI + éventuel code retour ≠ 0. Cache à
    // deux étages sur l'IDENTITÉ des objets (invalidation naturelle : _patch
    // remplace le step modifié et le msg → grp ; les steps au repos gardent
    // leur fragment rendu).
    const _shellStepHtmlCache = new WeakMap();
    function _shellStepHtml(step, isLast) {
        const cached = _shellStepHtmlCache.get(step);
        if (cached !== undefined && cached.isLast === isLast) return cached.html;
        const esc = window.elpisAnsi ? window.elpisAnsi.escapeHtml : (t) => t;
        const cmd = (step.args && (step.args.command || step.args.cmd)) || '';
        let html = '<span class="sh-prompt">$</span> <span class="sh-cmd">'
            + esc(String(cmd)) + '</span>\n';
        if (step.shellOut != null && step.shellOut !== '') {
            let out = '';
            try {
                out = window.elpisAnsi ? window.elpisAnsi.ansiToHtml(step.shellOut) : '';
            } catch (_) { out = ''; }
            html += out;
            if (!/\n$/.test(step.shellOut)) html += '\n';
        }
        if (step.status === 'running' && isLast) {
            html += '<span class="sh-cursor">▋</span>';
        } else if (step.shellDone && typeof step.shellRc === 'number' && step.shellRc !== 0) {
            html += '<span class="sh-rc">↳ code ' + step.shellRc + '</span>\n';
        }
        _shellStepHtmlCache.set(step, { html, isLast });
        return html;
    }

    // Ouverture de l'accordéon d'un segment : cale la console shell en bas
    // (suivi du flux) — repliée, l'élément n'a pas de layout et son scroll
    // ne peut pas être positionné pendant le stream.
    function shellScrollOnOpen(ev) {
        try {
            if (!ev || !ev.target || !ev.target.open) return;
            const el = ev.target.querySelector('.shell-live-body');
            if (el) nextTick(() => { try { el.scrollTop = el.scrollHeight; } catch (_) {} });
        } catch (_) {}
    }

    // Toggle de la carte détail d'un step (clic sur la pill). Même contrat
    // que l'ancien setMsgUi inline + à l'OUVERTURE d'un step shell, cale la
    // console (qui vient de monter) en bas pour suivre le flux en cours.
    function toggleToolDetail(entry, flat, gi) {
        const opening = !entry || !entry.msg || entry.msg._activeToolStep !== flat;
        setMsgUi(entry, { _activeToolStep: opening ? flat : null });
        if (opening) {
            nextTick(() => {
                try {
                    const el = document.querySelector(
                        '[data-shell-live="' + entry.idx + '-' + (gi || 0) + '"]');
                    if (el) el.scrollTop = el.scrollHeight;
                } catch (_) {}
            });
        }
    }

    const _shellConsoleCache = new WeakMap();
    function renderShellConsole(grp) {
        if (!grp || !grp.shellRuns || !grp.shellRuns.length) return '';
        const cached = _shellConsoleCache.get(grp);
        if (cached !== undefined) return cached;
        const parts = grp.shellRuns.map((r, i) =>
            _shellStepHtml(r.step, i === grp.shellRuns.length - 1));
        const html = parts.join('\n');
        _shellConsoleCache.set(grp, html);
        return html;
    }

    // ===========================================================
    //  CHATS CRUD
    // ===========================================================

    // loadChatsList lives in chat/_history.js now (set up after the
    // models module so that loadAvailableModels is available).

    // -- Multi-model management  (extracted)  ------------------
    // See static/js/chat/_models.js for the full implementation.
    // Must be set up BEFORE the SSE module because SSE captures
    // _applyModelData and loadAvailableModels as callbacks.
    const _models = window.setupChatModels(vue, {
        availableModels, selectedModel, activeModelIds,
        llmHealth, isLoadingModel,
        showModelProps, modelPropsData, modelPropsLoading,
        showModelManager, selectedConnector, selectedEngineMeta,
    }, ctx);
    const {
        loadAvailableModels, isModelLoaded, toggleLlmModel,
        loadLlmModel, unloadLlmModel,
        fetchModelProps, fmtPropVal, kvColor,
        kvTextClass, kvDimClass, kvBarClass,
        _applyModelData,
        modelsLoading, modelsError, toggleModelMenu, onModelMenuKeydown,
        pickerConnectors, pickerConnModels, pickerConnLoading, pickerConnFree,
        pickerConnState, retryConnModels, isConnModelLoaded, toggleConnModel,
        selectedModelLabel, builtinAllowed, canManageModels, noEngineAllowed,
        loadLlmConnectors,
        pickLocalModel, pickConnectorModel,
        modelLoadPct, modelLoadStage, modelLoadingId,
    } = _models;


    // -- Chat history (extracted to chat/_history.js) --------------
    // 6 fonctions CRUD : loadChatsList, startNewChat, loadChat,
    // archiveChat, renameChat, deleteChat. Le sous-module reçoit les
    // helpers via `deps` parce qu'ils viennent de plusieurs origines
    // (function declarations hoistées + autres sous-modules).
    const _historyMod = window.setupChatHistory(
        vue,
        {
            messages, currentChatId, currentChatTitle, currentView,
            isStreaming, isThinking, statusText, isUserScrolling,
            chats, inputRef, attachedFiles,
            user,   // audit 2026-08-02 : distinguer 401 traité d'une panne réseau
        },
        {
            fetchAuth, showToast, openConfirm, openPrompt,
            showSidebar: ctx.showSidebar,
        },
        {
            // function declarations hoistées dans app-chat.js
            // Chantier C : quitter = arrêter la lecture ; revenir = se rattacher.
            detachFromStream: _detachFromStream,
            stopRunForChat,
            attachRun,
            _parseFileBlocks,
            _deferHeavyRender,
            scrollToBottom,
            settleScrollBottom,
            // helpers d'autres sous-modules (déjà destructurés au top)
            _revokeAllWebShotBlobs,
            _vsReset, _vsInitTail,
            clearMarkdownCache,
            clearChartInstances,
            resetDiffCardState,
            resetMessageSearch,
            addCodeCopyButtons,
            loadAvailableModels,
            cancelEditMessage,   // reset de l'état d'édition au changement de chat
            // Seed/reset du panneau todo (meta_json["todos"] du chat chargé).
            setTodoList: _seedTodoList,
            // Toggles d'outils par chat (meta_json["tools"]) : lecture de
            // l'état courant + restauration. Le snapshot de session (app.js)
            // en a besoin des DEUX côtés — il court-circuite loadChat, donc
            // sans ça l'état repart à zéro et le PUT /tools suivant écrit
            // cette liste vide EN BASE.
            activeToolCats: _activeToolCats,
            applyChatTools,
            defaultToolKeys: _defaultToolKeys,
            // Menu « / » : fermeture au changement de chat.
            resetSlash,
            // (passe 2) skills épinglés + questionnaire ask_user : purgés au
            // changement de conversation, comme les pièces jointes.
            clearPinnedSkills,
            resetAskUser,
            // (passe 4, F10) modale « œil » d'agent : son idx/ri pointe les
            // messages du chat COURANT — au switch elle re-résoudrait un
            // autre message (ou du vide). Fermée comme le reste du transient.
            closeTaskModal,
            // Lecture seule par chat (meta_json["plan_mode"]).
            applyChatPlanMode,
            // Occupation de contexte persistée (meta_json["ctx_usage"]).
            applyChatCtxUsage,
            // Suivi d'un run détaché (audit 2026-08-22, B3) : la sonde de
            // chargement de chat démarre le suivi quand une génération tourne
            // déjà sur la conversation ouverte.
            followRun,
        }
    );
    const {
        loadChatsList,
        startNewChat,
        loadChat,
        archiveChat,
        renameChat,
        _doRenameChat,
        deleteChat,
        chatSelectMode, chatSelected,
        toggleChatSelectMode, toggleChatSelect, bulkArchiveChats, bulkDeleteChats,
    } = _historyMod;


    // ===========================================================
    //  INLINE CHAT TITLE EDITING (UX option 2)
    //
    //  Le titre dans le header devient editable au double-click :
    //    * editingChatTitle (bool)  -- visibilité du champ <input>
    //    * chatTitleDraft (string)  -- valeur en cours d'édition
    //
    //  Le commit (Entrée) appelle _doRenameChat -- même PATCH /api/saved
    //  /chats/:id que le rename via popup. Échap revert + ferme. Blur
    //  ferme aussi (sans commit) pour éviter un état d'édition orphelin
    //  si l'utilisateur clique ailleurs.
    // ===========================================================

    const editingChatTitle = ref(false);
    const chatTitleDraft   = ref('');

    function startChatTitleEdit() {
        if (!currentChatId.value) return;
        chatTitleDraft.value = currentChatTitle.value || '';
        editingChatTitle.value = true;
        nextTick(() => {
            const el = document.getElementById('chat-title-edit-input');
            if (el && typeof el.focus === 'function') {
                el.focus();
                try { el.select(); } catch (_) {}
            }
        });
    }

    async function commitChatTitleEdit() {
        if (!editingChatTitle.value) return;
        const id    = currentChatId.value;
        const draft = (chatTitleDraft.value || '').trim();
        editingChatTitle.value = false;
        if (!id || !draft || draft === currentChatTitle.value) return;
        await _doRenameChat(id, draft);
    }

    function cancelChatTitleEdit() {
        editingChatTitle.value = false;
        chatTitleDraft.value   = '';
    }


    // Helper _revokeAllWebShotBlobs lives in chat/_webshot.js now (set up
    // at top of setupChat), exposed as a local destructured variable.

    // Défer le travail lourd de rendu (addCodeCopyButtons parse tous les
    // <pre>, déclenche potentiellement Chart.js / Mermaid / SVG render).
    // Sur un long chat, faire ça dans le même frame que le load bloque le
    // thread principal → écran blanc. On le met après le first-paint via
    // requestIdleCallback, avec un fallback setTimeout pour Safari/anciens.
    function _deferHeavyRender(fn) {
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(fn, { timeout: 200 });
        } else {
            setTimeout(fn, 50);
        }
    }

    // loadChat / archiveChat / renameChat / deleteChat all live in
    // chat/_history.js now. Setup is right after multi-model module init.

    // The message-edit functions (startEditMessage, cancelEditMessage,
    // submitEditMessage) live in chat/_message_edit.js now (set up at
    // top of setupChat below the compose call). Refs editingMessageIndex
    // and editMessageText are also created there and destructured here.

    // -- Drag & drop + file upload  (extracted)  ---------------
    // See static/js/chat/_dnd.js for the full implementation.
    const _dnd = window.setupChatDnd(vue, { attachedFiles }, ctx);
    const {
        chatDragOver,
        handleChatDragEnter, handleChatDragOver, handleChatDragLeave, handleChatDrop,
        triggerFileUpload, handleFileUpload, removeAttachedFile,
    } = _dnd;


    // -- System SSE  (extracted)  ------------------------------
    // Implementation in static/js/chat/_system_sse.js.
    // We capture the model/chat callbacks here because they reference
    // functions defined later in this file (hoisted → resolved at call time).
    const _sse = window.setupChatSystemSSE(vue, {
        user, isLoadingModel, isStreaming,
    }, ctx, {
        onReconnect:    () => { loadAvailableModels(); loadChatsList(); if (ctx.refreshNotifBadge) ctx.refreshNotifBadge(); },
        onModelStatus:  (data) => _applyModelData(data),
        onModelChanged: () => loadAvailableModels(),
        onNotification: (data) => { if (ctx.onNotificationEvent) ctx.onNotificationEvent(data); },
        pollModels:     () => loadAvailableModels(),
    });
    const { connectSystemEvents, disconnectSystemEvents, _modelPollTimer } = _sse;

    // ── Nettoyage de session côté chat (appelé par logout via ctx) ────
    // Poste partagé : l'utilisateur suivant ne doit retrouver NI le
    // brouillon, NI les pièces jointes, NI une génération en cours, NI un
    // stream parqué en arrière-plan du compte précédent. logout() (app-auth)
    // référençait ctx.attachedFiles / ctx.stopGeneration / etc. — clés
    // jamais exposées par ctx → tout ce cleanup était mort.
    function resetOnLogout(explicit) {
        // Micro relâché et voix coupée AVANT tout le reste : une session qui
        // se termine ne doit laisser ni l'indicateur micro de l'OS allumé, ni
        // une réponse qui continue de se lire dans la pièce.
        try { cancelVoice(); } catch (_) {}
        // AUDIT 2026-08-22 (B4) — ``explicit`` distingue le DÉPART VOLONTAIRE
        // (bouton Déconnexion) de la simple fin de session (401 sur une
        // requête de fond, event ``session_expired``, cookie arrivé à
        // échéance : ``max_age_sec`` vaut 24 h par défaut, une mission longue
        // le franchit). Dans le second cas, envoyer un Stop TUAIT une
        // génération que le serveur, lui, ne demandait qu'à finir : le run
        // était détaché côté serveur, et c'est le NAVIGATEUR qui l'achevait,
        // en pleine mission, parce qu'un cookie avait expiré. On se contente
        // désormais de fermer le flux local ; le run va au bout, et le
        // rechargement après reconnexion affiche son résultat.
        if (explicit) {
            try { stopGeneration(); } catch (_) {}
        } else {
            try {
                if (abortController.value) abortController.value.abort();
            } catch (_) {}
            abortController.value = null;
            isStreaming.value = false;
            isThinking.value  = false;
            statusText.value  = '';
        }
        try { stopFollowRun(); } catch (_) {}
        // Fin de session : plus aucun run n'est lu ni affiché pour ce compte.
        _currentRun = null;
        _streamingForChatId = null;
        activeRunIds.value = [];
        if (_activeRunsTimer) { clearTimeout(_activeRunsTimer); _activeRunsTimer = null; }
        attachedFiles.value = [];
        inputMessage.value  = '';
        pinnedSkills.value  = [];
        // (passe 8, F12) — état de TOUR jamais purgé sur une fin de session
        // NON volontaire (seul le logout explicite passait par stopGeneration) :
        // questionnaire ask_user, liste todo et file d'attente du compte
        // précédent réapparaissaient au login suivant.
        try { resetAskUser(); } catch (_) {}
        todoList.value    = [];
        queueStatus.value = null;
        // Ferme l'EventSource + stoppe le polling modèles (interne au
        // module SSE) ; le watch(user) d'app.js reconnectera au prochain login.
        try { disconnectSystemEvents(); } catch (_) {}
    }

    // -- Live web screenshot carousel handlers ----------------------
    // The webshot carousel navigation (prev/next/goto/toggleExpand) lives
    // in chat/_webshot.js now (set up at top of setupChat), exposed as
    // local destructured variables.

    // ── Dynamic MCP local categories ───────────────────────────────────
    // ``localTools`` and ``mcpUserCategories`` are declared near the top of
    // setupChat (with attachedFiles). They are hydrated by this loader the
    // first time onMounted (in app.js) calls into chatMod after auth.
    //
    // Backend endpoint: GET /api/mcp/categories — returns categories the
    // admin marked visible (registry-driven, see backend/services/
    // _mcp_categories.py).
    //
    // The function is idempotent and forgiving: a network error keeps
    // mcpUserCategories empty, and the panel falls back to its empty
    // state (instead of breaking the chat). User toggles are preserved
    // across reloads when categories don't change (we only init missing
    // keys, never overwrite existing ``true`` values).
    async function loadMcpUserCategories() {
        try {
            const r = await fetchAuth('/api/mcp/categories');
            if (!r || !r.ok) return;
            const data = await r.json();
            if (!data || !data.ok) return;
            const cats = Array.isArray(data.categories) ? data.categories : [];
            mcpUserCategories.value = cats;
            // Initialize missing keys to false; preserve existing toggles
            // (so the user doesn't lose their selection if they reload
            // after the registry was refreshed).
            const next = { ...localTools.value };
            for (const c of cats) {
                if (!(c.name in next)) next[c.name] = false;
            }
            // Drop keys for categories that disappeared (admin hid them)
            // — otherwise sendMessage() would still send them as active.
            const validNames = new Set(cats.map(c => c.name));
            for (const k of Object.keys(next)) {
                if (!validNames.has(k)) delete next[k];
            }
            localTools.value = next;
        } catch (e) {
            // Silent: panel renders the empty state when this fails.
            console.warn('[mcp] loadMcpUserCategories failed:', e && e.message || e);
        }
        await loadManifestServers();
    }

    // Serveurs déclarés dans ``mcp.json`` (rôle externe). Idempotent et
    // tolérant : un échec laisse la liste vide, le panneau n'affiche rien.
    async function loadManifestServers() {
        try {
            const r = await fetchAuth('/api/mcp/manifest-servers');
            if (!r || !r.ok) return;
            const data = await r.json();
            if (!data || !data.ok) return;
            const list = Array.isArray(data.servers) ? data.servers : [];
            manifestServers.value = list;
            const next = { ...manifestTools.value };
            for (const s of list) if (!(s.name in next)) next[s.name] = false;
            const valid = new Set(list.map(s => s.name));
            for (const k of Object.keys(next)) if (!valid.has(k)) delete next[k];
            manifestTools.value = next;
        } catch (e) {
            console.warn('[mcp] loadManifestServers failed:', e && e.message || e);
        }
    }

    // Clés d'outils PRÉ-COCHÉES dans un nouveau chat : catégories
    // ``default_on`` du manifeste + serveurs déclarés ``default_on``. Vide par
    // défaut (aucun outil sélectionné d'office — décision 2026-07-13) ; c'est
    // ``mcp.json`` qui décide désormais.
    function _defaultToolKeys() {
        const out = [];
        for (const c of (mcpUserCategories.value || [])) if (c && c.default_on) out.push(c.name);
        for (const s of (manifestServers.value || [])) if (s && s.default_on) out.push('mf:' + s.name);
        return out;
    }

    // ── Toggles d'outils PAR CHAT (chats.meta_json["tools"]) ───────────
    // Moitié frontend de la persistance par chat (la moitié backend —
    // migration 0008, PUT /tools, snapshot fin de tour — existe déjà) :
    //   * applyChatTools(saved) — restauration au loadChat (et au retour
    //     sur un stream parqué). null = chat d'avant la feature → on ne
    //     touche pas aux toggles courants ; [] = « tout décoché » VALIDE.
    //   * watcher deep sur localTools — chaque coche/décoche du panneau
    //     programme un PUT débouncé vers le chat courant, dédoublonné par
    //     signature (les réécritures sans changement — refresh du registre
    //     de catégories, restauration — ne PUTent pas).
    // Un nouveau chat (currentChatId null) ne PUT rien : le snapshot de
    // fin de tour pose l'état à la création. startNewChat remet les
    // toggles à ZÉRO (aucun outil sélectionné par défaut — demande user
    // 2026-07-13) ; ce que l'utilisateur coche ensuite est persisté au
    // premier tour.
    let _toolsPutTimer   = null;
    let _toolsPutPending = null;   // {chatId, tools} débouncé, pas encore envoyé
    let _toolsLastSentSig = '';    // "<chatId>|cat1,cat2" du dernier état connu du serveur

    function _activeToolCats() {
        // Catégories locales cochées + serveurs EXTERNES actifs (préfixe
        // ``ext:<id>``) : UN seul état per-chat pour tout le panneau Outils.
        // Avant, les externes vivaient dans les settings GLOBAUX
        // (config.active_mcp_ids persisté via saveSettings) : jamais
        // mémorisés par chat, et « collants » sur un nouveau chat.
        const cats = Object.keys(localTools.value).filter(k => localTools.value[k]).sort();
        const ext  = (config.value.active_mcp_ids || []).map(id => 'ext:' + id).sort();
        const mf   = Object.keys(manifestTools.value).filter(k => manifestTools.value[k]).map(n => 'mf:' + n).sort();
        // Outils décochés : préfixe ``-``. Seuls comptent ceux d'une catégorie
        // ACTIVE — une exclusion sous une catégorie éteinte n'a rien à dire.
        const excl = _excludedNames().map(n => '-' + n).sort();
        return cats.concat(ext, mf, excl);
    }

    // Noms des outils réellement retirés : ceux d'une catégorie cochée. Une
    // exclusion sous une catégorie éteinte est ignorée (et non persistée) —
    // sinon rallumer la catégorie ferait revenir des trous invisibles.
    function _excludedNames() {
        const actives = new Set();
        for (const c of (mcpUserCategories.value || []))
            if (localTools.value[c.name]) for (const t of (c.tools || [])) actives.add(t.name);
        return Object.keys(excludedTools.value)
            .filter(n => excludedTools.value[n] && actives.has(n));
    }

    // Un outil est-il actif ? Tout est coché par défaut : seule une exclusion
    // explicite le retire.
    function isToolOn(nom) { return !excludedTools.value[nom]; }

    function setToolOn(nom, on) {
        const next = { ...excludedTools.value };
        if (on) delete next[nom]; else next[nom] = true;
        excludedTools.value = next;
    }

    function toggleTool(nom) { setToolOn(nom, !isToolOn(nom)); }

    // « 4/6 » sous le libellé d'une catégorie : rien n'est affiché quand tout
    // est coché (le cas normal ne doit pas faire de bruit).
    function catToolsCount(cat) {
        const tools = (cat && cat.tools) || [];
        if (!tools.length) return '';
        const on = tools.filter(t => isToolOn(t.name)).length;
        return on === tools.length ? '' : (on + '/' + tools.length);
    }

    function toggleToolCatOpen(nom) {
        openToolCats.value = { ...openToolCats.value, [nom]: !openToolCats.value[nom] };
    }

    // « Tout » recoche les outils de la catégorie. Pas de « Aucun » en face :
    // tout décocher, c'est éteindre la catégorie — l'interrupteur de la ligne
    // le dit déjà, et mieux (il coupe aussi la connexion au serveur).
    function resetCatTools(cat) {
        const next = { ...excludedTools.value };
        for (const t of ((cat && cat.tools) || [])) delete next[t.name];
        excludedTools.value = next;
    }

    // Fiche d'un outil (bouton « i » de sa case). La modale vit dans
    // ``includes/modals/misc.html`` : le panneau glissant passe en
    // ``overflow-hidden``, il clipperait tout ce qui déborde de sa colonne.
    const toolInfo = ref(null);   // {name, title, description, read_only, cat}

    function openToolInfo(outil, cat) {
        toolInfo.value = Object.assign({}, outil || {},
                                       { cat: (cat && (cat.label || cat.name)) || '' });
    }

    function closeToolInfo() { toolInfo.value = null; }

    function _flushToolsPut() {
        const p = _toolsPutPending;
        _toolsPutPending = null;
        if (_toolsPutTimer) { clearTimeout(_toolsPutTimer); _toolsPutTimer = null; }
        if (!p || !p.chatId) return;
        _toolsLastSentSig = p.chatId + '|' + p.tools.join(',');
        fetchAuth('/api/saved/chats/' + encodeURIComponent(p.chatId) + '/tools', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tools: p.tools }),
        }, true).catch(() => { /* best-effort : le snapshot de fin de tour rattrape */ });
    }

    function applyChatTools(saved) {
        if (!Array.isArray(saved)) return;   // meta jamais posée → état courant conservé
        const next = {};
        for (const k of Object.keys(localTools.value)) next[k] = false;
        const nextMf = {};
        for (const k of Object.keys(manifestTools.value)) nextMf[k] = false;
        const extIds = [];
        const nextExcl = {};
        for (const k of saved) {
            if (typeof k !== 'string' || !k) continue;
            if (k.startsWith('ext:')) extIds.push(k.slice(4));
            else if (k.startsWith('mf:')) nextMf[k.slice(3)] = true;
            // Outil décoché (2026-09-12). Restauré TEL QUEL, sans le confronter
            // au registre : celui-ci arrive d'un fetch asynchrone, et filtrer
            // ici rendrait un outil décoché au premier chargement de chat.
            else if (k.startsWith('-')) nextExcl[k.slice(1)] = true;
            else next[k] = true;
        }
        localTools.value = next;
        manifestTools.value = nextMf;
        excludedTools.value = nextExcl;
        // Serveurs externes PER-CHAT : on restaure les ids TELS QUELS, sans les
        // confronter à la liste des serveurs connus.
        //
        // Ce filtre existait pour écarter un id orphelin, mais la liste dont il
        // dépend (serveurs perso + bibliothèque partagée) arrive de DEUX fetchs
        // asynchrones : restaurer un chat pendant qu'ils sont en vol — ou après
        // l'échec de l'un d'eux — vidait la sélection, et le PUT /tools suivant
        // écrivait ce vide EN BASE. Le chat perdait ses serveurs pour de bon.
        //
        // Ne rien filtrer ici ne réintroduit aucun fantôme : le panneau n'affiche
        // que ``pinnedServers`` (un id orphelin n'a pas de ligne), l'envoi ignore
        // un id qu'il ne résout pas, et le backend re-valide de son côté toute
        // entrée ``shared:`` (publiée, active, et affichée par CE compte).
        config.value.active_mcp_ids = extIds;
        // L'état restauré EST l'état serveur : le watcher qui va tirer sur ce
        // remplacement retombe sur cette signature et ne re-PUT pas.
        _toolsLastSentSig = (currentChatId.value || '') + '|' + _activeToolCats().join(',');
    }

    // Restauration du témoin de lecture seule au chargement d'un chat.
    // Purement local : c'est le serveur qui applique le mode (il relit
    // meta_json), ceci ne fait qu'aligner l'affichage.
    function applyChatPlanMode(v) { planMode.value = !!v; }

    // Re-seed de l'occupation de contexte PERSISTÉE (meta_json["ctx_usage"])
    // au chargement d'un chat : jauge live du prochain tour (_lastCtxUsed),
    // bannière « presque plein » (ctxRealPct) et puce « ctx » au repos.
    // Différé d'un tick : le watcher de currentChatId remet ces états à zéro
    // juste après le switch — semer avant lui serait aussitôt effacé.
    function applyChatCtxUsage(usage, chatId) {
        nextTick(() => {
            if (String(currentChatId.value) !== String(chatId)) return;
            const used  = usage && Number(usage.used)  || 0;
            const total = usage && Number(usage.total) || 0;
            if (!(used > 0) || !(total > 0)) return;
            const pct = (typeof usage.pct === 'number')
                ? usage.pct : Math.min(100, Math.round(used / total * 100));
            _lastCtxUsed = Math.min(used, total);
            ctxRealPct.value = pct;
            ctxUsage.value = { used: Math.min(used, total), total, pct, persisted: true };
        });
    }

    // Mode lecture seule (« /plan »). Écrit en meta_json par le même canal
    // que les catégories d'outils. On ne touche le miroir local qu'APRÈS un
    // aller-retour réussi : un témoin qui annoncerait la lecture seule alors
    // que le serveur ne l'applique pas serait le pire des mensonges.
    async function setPlanMode(on) {
        const id = currentChatId.value;
        if (!id) {
            // Chat vierge : rien à écrire côté serveur (le chat n'existe pas
            // encore). Le mode est ARMÉ localement et scellé À LA CRÉATION
            // (pré-vol de sendMessage → _ensureServerChat, fail-fermé).
            // Le témoin ne peut pas mentir : aucun tour ne peut avoir lieu
            // tant que le chat n'existe pas. Reset au switch de chat par
            // _applyPlan (loadChat / startNewChat), comme l'état persisté.
            planMode.value = !!on;
            return true;
        }
        try {
            const res = await fetchAuth('/api/saved/chats/' + encodeURIComponent(id) + '/plan-mode', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan_mode: !!on }),
            }, true);
            if (!res || !res.ok) return false;
        } catch (e) { return false; }
        planMode.value = !!on;
        return true;
    }

    function _scheduleToolsPut() {
        const chatId = currentChatId.value;
        if (!chatId) return;
        const sig = chatId + '|' + _activeToolCats().join(',');
        if (sig === _toolsLastSentSig && !_toolsPutPending) return;
        // Switch de chat avec un PUT encore débouncé : il appartient à
        // l'ANCIEN chat → envoi immédiat (le debounce ne lisse que des
        // retouches successives du MÊME chat).
        if (_toolsPutPending && _toolsPutPending.chatId !== chatId) _flushToolsPut();
        _toolsPutPending = { chatId: chatId, tools: _activeToolCats() };
        if (_toolsPutTimer) clearTimeout(_toolsPutTimer);
        _toolsPutTimer = setTimeout(() => { _toolsPutTimer = null; _flushToolsPut(); }, 600);
    }
    watch(localTools, _scheduleToolsPut, { deep: true });
    // Les cases par outil suivent le MÊME canal per-chat que les catégories.
    watch(excludedTools, _scheduleToolsPut, { deep: true });
    // Les serveurs EXTERNES suivent le MÊME chemin per-chat que les
    // catégories locales (entrées ``ext:`` du même PUT /tools).
    watch(() => (config.value.active_mcp_ids || []).join(','), _scheduleToolsPut);
    // Serveurs déclarés dans mcp.json : entrées ``mf:`` du même PUT /tools.
    watch(manifestTools, _scheduleToolsPut, { deep: true });

    // ── Assistant de création de skill (lancé depuis la page Skills) ──────
    // 1. Le bouton « Assistant » ouvre d'abord un FORMULAIRE DE CADRAGE (sujet,
    //    objectif, domaine, scripts) — les bases sont posées sans dialogue.
    // 2. launchSkillAssistantChat ouvre un chat NEUF pré-configuré où le LLM
    //    mène l'entretien en posant ses questions groupées et numérotées en
    //    texte (un tour à la fois), puis rédige, enregistre et vérifie le skill.
    //    La procédure vit dans le skill global « creer-un-skill », épinglé →
    //    corps injecté au 1er message. Outils : catégorie « skill »
    //    (skill_save/skill_add_file/skill_get) + « fs ».
    const skillAssistForm = ref({ open: false, sujet: '', objectif: '', domaine: '', scripts: '' });

    function startSkillAssistantChat() {
        skillAssistForm.value = { open: true, sujet: '', objectif: '', domaine: '', scripts: '' };
    }

    async function launchSkillAssistantChat() {
        const f = skillAssistForm.value;
        if (!(f.sujet || '').trim()) { showToast('Sujet requis', 'error'); return; }
        skillAssistForm.value = { ...f, open: false };
        // Ouvert depuis l'onglet Skills de la modal Paramètres : fermer la
        // modal SANS confirm dirty (skip=true) puis revert les mutations live
        // non enregistrées — sinon le nouveau chat s'ouvrirait derrière elle.
        try { ctx.closeSettings(true); ctx.loadSettingsData(); } catch (e) { /* noop */ }
        currentView.value = 'chat';
        await startNewChat();
        const lt = { ...localTools.value };
        const missing = [];
        for (const cat of ['skill', 'fs']) {
            if (cat in lt) lt[cat] = true; else missing.push(cat);
        }
        localTools.value = lt;
        if (missing.includes('skill')) {
            showToast('Outils « Skills » indisponibles : l’assistant rédigera le skill sans pouvoir l’enregistrer lui-même', 'info');
        }
        if (!pinnedSkills.value.some(s => s.name === 'creer-un-skill')) {
            pinnedSkills.value.push({
                name: 'creer-un-skill',
                description: 'Entretien guidé de création de skill',
                domain: '',
            });
        }
        const lines = [
            'Je veux créer un nouveau skill. Voici le cadrage initial :',
            `**Sujet :** ${f.sujet.trim()}`,
        ];
        if ((f.objectif || '').trim()) lines.push(`**Objectif / résultat attendu :** ${f.objectif.trim()}`);
        if ((f.domaine || '').trim())  lines.push(`**Domaine :** ${f.domaine.trim()}`);
        if (f.scripts)                 lines.push(`**Scripts à embarquer :** ${f.scripts}`);
        lines.push('', "Mène l'entretien pour le reste en posant tes questions groupées "
                       + 'et numérotées en texte (plusieurs à la fois), puis rédige, '
                       + 'enregistre et vérifie le skill.');
        // '  \n' = hard break markdown : sans lui les lignes du cadrage fusionnent.
        inputMessage.value = lines.join('  \n');
        await sendMessage();
    }

    // ── « Interroger ce document » (deep-link #ask depuis rag_app) ────────
    // L'onglet Documents (OCR) vit dans rag_app depuis 2026-07-23 ; son
    // bouton Interroger ouvre le chatbot sur /#ask?collection=…&doc=…&rag=…
    // (handler maybeHandleAskDeepLink, app.js). Chat NEUF pré-configuré :
    // RAG activé sur la collection OCR, consigne de cadrage injectée au 1er
    // message (rag_search filtré sur le fichier indexé + rag_cite, pages
    // citées depuis les en-têtes « [doc — page N] » posés par l'indexation).
    // Patron launchSkillAssistantChat.
    async function startDocumentChat(p) {
        const docName = (p && p.docName) || 'document';
        const ragName = (p && p.ragName) || '';
        const collection = (p && p.collection) || '';
        const question = ((p && p.question) || '').trim();
        currentView.value = 'chat';
        await startNewChat();
        // Réglage RAG de SESSION (panneau livres) — per-request, pas persisté.
        config.value.use_rag = true;
        config.value.rag_collection = collection;
        config.value.rag_search_mode = config.value.rag_search_mode || 'classic';
        showToast('Consultation documentaire activée (collection ' + (collection || 'par défaut') + ')', 'info');
        const lines = [
            'Vous répondez UNIQUEMENT à partir du document « ' + docName + ' », '
            + 'indexé sous le fichier « ' + ragName + ' » de la collection « '
            + collection + ' ».',
            'Méthode : rag_search avec filters={"file_glob": "' + ragName + '"} '
            + 'pour chercher, puis rag_cite pour sourcer vos réponses.',
            'Chaque extrait commence par « [' + docName + ' — page N] » : '
            + 'citez SYSTÉMATIQUEMENT les pages dans vos réponses.',
            '',
            question || 'Présentez ce document : objet, structure, points clés.',
        ];
        // '  \n' = hard break markdown : sans lui les lignes de consigne fusionnent.
        inputMessage.value = lines.join('  \n');
        await sendMessage();
    }

    // ── Questionnaire interactif (outil ask_user) ─────────────────────────
    // Le modèle appelle l'outil interne ``ask_user`` (catégorie skill) avec
    // ses questions ; le front intercepte l'événement tool_call et ouvre, à la
    // FIN du tour, un panneau au-dessus de la barre de prompt : une question à
    // la fois (progression), options cliquables + champ de saisie, navigation
    // Précédent/Suivant, envoi groupé en UN message markdown.
    const askUserPanel = ref(null);    // { items: [{q,options,multi,_sel,_free}], idx }
    let _pendingAskUser = null;        // stash entre tool_call et final

    function _normalizeAskUser(raw) {
        if (!Array.isArray(raw) || !raw.length) return null;
        const items = raw.slice(0, 8).map(x => ({
            q:       String((x && (x.q || x.question)) || '').trim().slice(0, 300),
            options: Array.isArray(x && x.options)
                         ? x.options.slice(0, 12).map(o => String(o).slice(0, 120)) : [],
            multi:   !!(x && x.multi),
            _sel:    [],
            _free:   '',
        })).filter(x => x.q);
        return items.length ? items : null;
    }

    const askUserCurrent = computed(() => {
        const p = askUserPanel.value;
        return p ? p.items[p.idx] : null;
    });

    function isAskOptionOn(opt) {
        const qq = askUserCurrent.value;
        return !!qq && qq._sel.includes(opt);
    }
    function toggleAskOption(opt) {
        const qq = askUserCurrent.value;
        if (!qq) return;
        const i = qq._sel.indexOf(opt);
        if (i >= 0) qq._sel.splice(i, 1);
        else {
            if (!qq.multi) qq._sel.length = 0;   // choix simple : remplace
            qq._sel.push(opt);
        }
    }
    function askUserPrev() {
        const p = askUserPanel.value;
        if (p && p.idx > 0) p.idx--;
    }
    // Suivant — ou envoi groupé sur la dernière question.
    function askUserNext() {
        const p = askUserPanel.value;
        if (!p) return;
        if (p.idx < p.items.length - 1) { p.idx++; return; }
        submitAskUser();
    }
    function dismissAskUser() { askUserPanel.value = null; }
    let _composeRestoreDraft = null;   // (passe 8, F14) brouillon à rendre après envoi
    function submitAskUser() {
        const p = askUserPanel.value;
        if (!p || isStreaming.value) return;
        const lines = [];
        for (const qq of p.items) {
            const parts = [...(qq._sel || [])];
            if ((qq._free || '').trim()) parts.push(qq._free.trim());
            if (parts.length) lines.push(`**${qq.q}**  \n${parts.join(' ; ')}`);
        }
        if (!lines.length) { showToast('Réponds à au moins une question', 'info'); return; }
        // (passe 8, F14) — le brouillon tapé dans le composeur était ÉCRASÉ par
        // les réponses ; il est remis en place dès que sendMessage a consommé
        // le texte (cf. _composeRestoreDraft).
        const _draft = inputMessage.value;
        _composeRestoreDraft = (_draft && _draft.trim()) ? _draft : null;
        inputMessage.value = lines.join('\n\n');
        sendMessage();                 // sendMessage ferme le panneau
    }

    // Tailwind class helpers consumed by panel_mcp.html. La couleur PAR
    // CATÉGORIE (cat.color, config backend) est RESPECTÉE (correctif skins
    // 2026-07 : les remontées utilisateurs ont tranché contre l'aplat
    // « accent unique » pour ces repères fonctionnels).
    //
    // ⚠ CLASSES ÉCRITES EN ENTIER, JAMAIS COMPOSÉES. La feuille Tailwind est
    // PRÉCOMPILÉE (tools/generate_tailwind_css.mjs, 2026-08) : l'extracteur
    // lit les littéraux des sources, il ne peut pas deviner un nom construit
    // à la volée. L'ancienne forme ('peer-checked:bg-' + h + '-600') datait
    // du CDN JIT, qui compilait à l'apparition dans le DOM ; depuis la
    // précompilation, aucune de ces classes n'existait plus dans le CSS —
    // toggles gris une fois activés, pastilles sans fond (donc transparentes)
    // pour lime/pink/fuchsia/purple. Ajouter une teinte ici = ajouter ses
    // deux lignes de littéraux, puis rejouer le générateur.
    //
    // red/rose : la nuance -50 n'est pas bridgée par le skin engine → -100.
    const MCP_CAT_STYLES = {
        blue:    { bg: 'bg-blue-50 text-blue-600',       toggle: 'peer-checked:bg-blue-600 peer-checked:border-blue-600' },
        sky:     { bg: 'bg-sky-50 text-sky-600',         toggle: 'peer-checked:bg-sky-600 peer-checked:border-sky-600' },
        cyan:    { bg: 'bg-cyan-50 text-cyan-600',       toggle: 'peer-checked:bg-cyan-600 peer-checked:border-cyan-600' },
        teal:    { bg: 'bg-teal-50 text-teal-600',       toggle: 'peer-checked:bg-teal-600 peer-checked:border-teal-600' },
        emerald: { bg: 'bg-emerald-50 text-emerald-600', toggle: 'peer-checked:bg-emerald-600 peer-checked:border-emerald-600' },
        green:   { bg: 'bg-green-50 text-green-600',     toggle: 'peer-checked:bg-green-600 peer-checked:border-green-600' },
        lime:    { bg: 'bg-lime-50 text-lime-600',       toggle: 'peer-checked:bg-lime-600 peer-checked:border-lime-600' },
        amber:   { bg: 'bg-amber-50 text-amber-600',     toggle: 'peer-checked:bg-amber-600 peer-checked:border-amber-600' },
        orange:  { bg: 'bg-orange-50 text-orange-600',   toggle: 'peer-checked:bg-orange-600 peer-checked:border-orange-600' },
        yellow:  { bg: 'bg-yellow-50 text-yellow-600',   toggle: 'peer-checked:bg-yellow-600 peer-checked:border-yellow-600' },
        red:     { bg: 'bg-red-100 text-red-600',        toggle: 'peer-checked:bg-red-600 peer-checked:border-red-600' },
        rose:    { bg: 'bg-rose-100 text-rose-600',      toggle: 'peer-checked:bg-rose-600 peer-checked:border-rose-600' },
        pink:    { bg: 'bg-pink-50 text-pink-600',       toggle: 'peer-checked:bg-pink-600 peer-checked:border-pink-600' },
        fuchsia: { bg: 'bg-fuchsia-50 text-fuchsia-600', toggle: 'peer-checked:bg-fuchsia-600 peer-checked:border-fuchsia-600' },
        purple:  { bg: 'bg-purple-50 text-purple-600',   toggle: 'peer-checked:bg-purple-600 peer-checked:border-purple-600' },
        violet:  { bg: 'bg-violet-50 text-violet-600',   toggle: 'peer-checked:bg-violet-600 peer-checked:border-violet-600' },
        indigo:  { bg: 'bg-indigo-50 text-indigo-600',   toggle: 'peer-checked:bg-indigo-600 peer-checked:border-indigo-600' },
    };
    function _mcpCatStyle(cat) {
        const c = (cat && typeof cat.color === 'string') ? cat.color.toLowerCase() : '';
        return Object.prototype.hasOwnProperty.call(MCP_CAT_STYLES, c) ? MCP_CAT_STYLES[c] : null;
    }
    function mcpCategoryBgClass(cat) {
        const s = _mcpCatStyle(cat);
        return s ? s.bg : 'bg-slate-100 text-slate-600';
    }

    function mcpCategoryToggleClass(cat) {
        const s = _mcpCatStyle(cat);
        return (s || MCP_CAT_STYLES.blue).toggle;
    }

    // Auto-load categories the first time the user is authenticated.
    // We watch ``user`` rather than calling on factory init because the
    // user object isn't populated until the auth module finishes its
    // /api/me-lite probe in app.js's onMounted. Also re-runs on logout
    // → relogin so a different account picks up its own admin scope.
    watch(user, (val) => {
        if (val && !(typeof window !== 'undefined' && window.__ADMIN_ONLY_MODE__)) loadMcpUserCategories();
        else { localTools.value = {}; mcpUserCategories.value = []; excludedTools.value = {}; }
    }, { immediate: true });

    // Refetch categories whenever the user opens the MCP side panel.
    // Cheap (one tiny GET to /api/mcp/categories with a 5 s in-process
    // cache on the server). Lets a freshly-registered category appear
    // after the operator restarts the app, without forcing a browser
    // reload.
    watch(showMcpPanel, (open) => {
        if (open && user.value) loadMcpUserCategories();
    });

    // NOTE : le regroupement des chats par date de la sidebar est assuré par
    // ``groupedHistory`` (app.js), seule source consommée par le template. Un
    // ancien ``groupedChats`` dupliqué ici n'était lié par AUCUN binding (double
    // logique de bucketing divergeable) → retiré.

    // ===========================================================
    //  COMPRESSION : formatage du delta tokens (UX option 3)
    //
    //  Le backend (conversation_compressor.py) expose dans stats :
    //    tokens_before, tokens_after, tokens_saved, ratio, duration_ms
    //
    //  fmtCompression() retourne un string "32k → 8k tokens (-75%)"
    //  prêt à injecter dans la meta inline du step compression.
    //  Helper interne _fmtTokens utilisé partout où on veut une
    //  abréviation k/M cohérente.
    // ===========================================================

    //  Durée lisible (« 42 s », « 3 min 07 s », « 1 h 04 min ») : source
    //  unique dans utils.js#elpisFmtElapsed, partagée avec l'export PDF.
    //  Repli local si utils.js n'est pas chargé (tests unitaires du module).
    function fmtElapsed(sec, opts) {
        if (typeof window !== 'undefined' && typeof window.elpisFmtElapsed === 'function')
            return window.elpisFmtElapsed(sec, opts);
        const raw = Math.max(0, Number(sec) || 0), s = Math.floor(raw);
        if (s < 1) {
            if (opts && opts.live)    return '0 s';
            if (opts && opts.precise)
                return raw < 0.1 ? '<0.1 s' : (Math.floor(raw * 10) / 10).toFixed(1) + ' s';
            return '<1 s';
        }
        if (s < 60)   return s + ' s';
        if (s < 3600) return Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
        return Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ' min';
    }
    // Même rendu, entrée en millisecondes (durées d'étapes : outils,
    // compression, sous-agents).
    function fmtElapsedMs(ms, opts) { return fmtElapsed((Number(ms) || 0) / 1000, opts); }
    // Durée d'un OUTIL : garde un dixième sous la seconde. Helper nommé
    // plutôt qu'un objet littéral dans les moustaches Vue (une accolade
    // fermante collée à `}}` casserait l'interpolation).
    function fmtToolMs(ms) { return fmtElapsedMs(ms, { precise: true }); }

    function _fmtTokens(n) {
        if (n == null || n === 0) return '0';
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1000)      return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(Math.round(n));
    }

    // Étapes d'un chargement de modèle, telles que nommées par le moteur.
    // Un modèle de texte seul n'en a qu'une (on n'affiche alors rien) ; un
    // modèle multimodal ou à décodage spéculatif en enchaîne plusieurs, et
    // chacune repart de 0 % — sans ce repère, la barre semblerait reculer.

    function fmtCompression(stats) {
        if (!stats || !stats.tokens_before) return '';
        const before = _fmtTokens(stats.tokens_before);
        const after  = _fmtTokens(stats.tokens_after || 0);
        const saved  = stats.tokens_saved || 0;
        const pct    = stats.tokens_before > 0 ? Math.round((saved / stats.tokens_before) * 100) : 0;
        // Cas d'une compression "négligeable" (token_saved ≈ 0) : on
        // affiche quand même before/after pour cohérence, sans le pct.
        return pct > 0
            ? `${before} → ${after} tokens (-${pct}%)`
            : `${before} → ${after} tokens`;
    }

    // ===========================================================
    //  KV CACHE METRIC (UX round 4)
    //
    //  fmtKvCache(metrics) -- formate l'état du KV cache au moment où
    //  le message s'est terminé (snapshot fait dans le handler 'final').
    //  Format : "12k/32k" (used / total). Le pct est dispo séparément
    //  via metrics.kv_cache.pct pour la coloration.
    //
    //  Retour string vide si pas de snapshot (ancien message sauvegardé,
    //  llmHealth indisponible, ou modèle sans kv_cache exposé).
    // ===========================================================

    function fmtCtxUsage(u) {
        if (!u || !(u.total > 0)) return '';
        return `${_fmtTokens(u.used)}/${_fmtTokens(u.total)}`;
    }

    function fmtKvCache(metrics) {
        if (!metrics || !metrics.kv_cache || !metrics.kv_cache.total) return '';
        const used  = _fmtTokens(metrics.kv_cache.used);
        const total = _fmtTokens(metrics.kv_cache.total);
        return `${used}/${total}`;
    }

    // Tooltip détaillé de la ligne métriques d'un message assistant.
    // Sémantique des compteurs (cf. docs/token-counters.md) :
    //   - input_tokens  = tokens SOUMIS au modèle (en mode outils : cumul des
    //     itérations, l'historique re-soumis compte à chaque round → c'est la
    //     vérité de facturation API, PAS l'occupation du contexte) ;
    //   - last_prompt_tokens = taille du DERNIER prompt (= contexte fin de tour) ;
    //   - output_tokens = tokens GÉNÉRÉS, dont thinking_tokens (raisonnement) et
    //     response_tokens (réponse visible + appels d'outils). Le raisonnement
    //     est un SOUS-ENSEMBLE de la sortie, jamais un poste à additionner ;
    //     thinking_tokens_estimated dit quand le compte est approché (cible
    //     distante sans tokenizer accessible) — l'UI préfixe alors « ≈ » ;
    //   - cache_read/creation_input_tokens = décomposition du cache Anthropic.

    // Nombre de tokens de réflexion d'un message, ou 0. Les anciens messages
    // (métriques d'avant la mesure) n'ont pas le champ : on ne montre rien
    // plutôt qu'un « 0 » qui affirmerait à tort l'absence de raisonnement.
    function thinkingTokensOf(m) {
        return (m && typeof m.thinking_tokens === 'number' && m.thinking_tokens > 0)
            ? m.thinking_tokens : 0;
    }

    // Formatage commun aux deux surfaces (chip + infobulle) : « ≈ » quand la
    // mesure est estimée.
    function fmtThinkingTokens(m) {
        const n = thinkingTokensOf(m);
        if (!n) return '';
        return (m.thinking_tokens_estimated ? '≈ ' : '') + n.toLocaleString('fr-FR');
    }

    function metricsTooltip(m) {
        if (!m) return '';
        const L = [];
        L.push('Modèle : ' + (m.model || '?'));
        L.push('Durée : ' + (m.duration || '?') + ' s');
        L.push('Vitesse génération : ' + (m.write_tps || '?') + ' tok/s');
        if (m.read_tps) L.push('Vitesse lecture prompt : ' + m.read_tps + ' tok/s');
        const _hasCumul = typeof m.last_prompt_tokens === 'number'
            && m.input_tokens && m.input_tokens !== m.last_prompt_tokens;
        if (m.input_tokens)
            L.push((_hasCumul ? 'Tokens soumis (cumul outils) : ' : 'Tokens soumis : ') + m.input_tokens.toLocaleString('fr-FR'));
        if (typeof m.last_prompt_tokens === 'number' && m.last_prompt_tokens > 0)
            L.push('Contexte fin de tour : ' + m.last_prompt_tokens.toLocaleString('fr-FR') + ' tokens');
        if (m.output_tokens) L.push('Tokens générés : ' + m.output_tokens.toLocaleString('fr-FR'));
        // Découpe de la sortie : la réflexion pesait dans « Tokens générés »
        // sans jamais être nommée. Indentée pour dire qu'elle en fait PARTIE.
        const _think = thinkingTokensOf(m);
        if (_think) {
            L.push('  · dont réflexion : ' + fmtThinkingTokens(m));
            const _resp = (typeof m.response_tokens === 'number')
                ? m.response_tokens
                : Math.max(0, (m.output_tokens || 0) - _think);
            L.push('  · dont réponse et outils : ' + _resp.toLocaleString('fr-FR'));
        }
        if (m.cache_read_input_tokens || m.cache_creation_input_tokens)
            L.push('Cache : ' + (m.cache_read_input_tokens || 0).toLocaleString('fr-FR') + ' lus / '
                   + (m.cache_creation_input_tokens || 0).toLocaleString('fr-FR') + ' créés');
        return L.join('\n');
    }

    // ===========================================================
    //  THINKING META (UX option 3 round 4)
    //
    //  Petite ligne meta affichée à côté du label "Thinking..." /
    //  "Réponse" dans le summary du <details>. Donne le bon signal
    //  pour décider de déplier ou pas un long bloc de raisonnement.
    //
    //  fmtThinkingMeta(msg) retourne la DURÉE du raisonnement (« 47 s »,
    //  « 2 min 13 s »), ou '' tant qu'elle n'est pas connue (pendant le
    //  stream) — l'appelant masque alors la ligne.
    //
    //  Le compteur de caractères a été RETIRÉ : il ne disait rien d'utile
    //  (un raisonnement ne se juge pas au volume de texte) et il était faux
    //  — le thinking est strippé en base, donc au rechargement d'un chat le
    //  décompte ne correspondait plus à ce qui avait réellement été produit.
    //
    //  La durée vient de _thinkingStartedAt / _thinkingEndedAt
    //  capturés sur le message côté handlers thinking_content +
    //  content_token (avec fallback dans 'final').
    // ===========================================================

    function fmtThinkingMeta(msg) {
        if (!msg || !msg.thinking) return '';
        if (msg._thinkingStartedAt && msg._thinkingEndedAt)
            return fmtElapsedMs(msg._thinkingEndedAt - msg._thinkingStartedAt);
        return '';
    }

    // ===========================================================
    //  Statut live "in-place" (UX refonte)
    //
    //  AVANT : une ligne de statut affichait le texte BRUT du
    //  backend (_statusLine : "Connecté : Local (12 outil(s))",
    //  "Génération en cours…", "Outils prêts…", "Réflexion…", nom
    //  d'outil…) avec l'icône DEVINÉE par includes() sur la chaîne,
    //  et un double clignotement (icône + texte). Les libellés
    //  hétérogènes + les sauts entre phases rendaient l'affichage
    //  peu lisible.
    //
    //  APRÈS : statusPhase(msg) normalise l'activité en cours en
    //  une phase propre {kind, label}. La pill rend UN point animé
    //  monochrome + un libellé court, qui se met à jour SUR PLACE.
    //
    //  Source de vérité, par priorité :
    //    1. un tool step en cours → kind tool/rag + "nom · arg clé"
    //    2. sinon le _statusLine brut, mappé vers une phase stable
    //  kind ∈ connect | think | tool | rag | wait | generate | run
    // ===========================================================

    // Argument le plus parlant d'un appel d'outil, raccourci pour
    // l'affichage "nom · arg". Couvre les outils courants (fs/shell/
    // git/rag…) ; bascule sur le basename pour les chemins.
    function toolKeyArg(step) {
        const a = (step && step.args) || {};
        let v = a.path || a.filename || a.file || a.query || a.q
             || a.name || a.url || a.cmd || a.command || a.pattern
             || a.branch || a.repo || a.message || '';
        if (Array.isArray(v)) v = v[0] || '';
        v = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
        if (!v) return '';
        if (v.includes('/')) v = v.split('/').filter(Boolean).pop() || v;
        return v.length > 40 ? v.slice(0, 40) + '…' : v;
    }

    // ── Annulation d'UN sous-agent (outil `task`) ────────────────────────
    // POST le flag ciblé ; l'enfant s'arrête au prochain check de sa boucle
    // (le tour parent CONTINUE — il reçoit une enveloppe task_cancelled).
    // Best-effort : pas de retour d'état à attendre, le task_step final
    // (state:'cancelled') recale la ligne agent quand l'arrêt est effectif.

    // Localise `run` dans le message streamé et le REMPLACE (immutabilité →
    // réactivité, même pattern que _patch). Repli par id si l'objet a été
    // remplacé entre le render et le clic.
    function _patchTaskRun(run, patch) {
        const msgs = _getStreamMsgs();
        for (let i = msgs.length - 1; i >= 0; i--) {
            const runs = msgs[i] && msgs[i].taskRuns;
            if (!runs || !runs.length) continue;
            let ri = runs.indexOf(run);
            if (ri < 0 && run.id) ri = runs.findIndex(r => r.id === run.id);
            if (ri < 0) continue;
            const next = [...runs];
            next[ri] = { ...runs[ri], ...patch };
            msgs[i] = Object.assign({}, msgs[i], { taskRuns: next });
            return next[ri];
        }
        return null;
    }

    // ── Modale « œil » : déroulé complet d'un sous-agent ─────────────────
    // Ouverture depuis la ligne agent (entry.idx + index du run). Les runs
    // étant REMPLACÉS à chaque patch (immutabilité), la modale résout le run
    // à CHAQUE rendu via taskModalRun() — le déroulé se met donc à jour en
    // direct pendant le run. `snap` = photo du run à l'ouverture, repli si
    // le message n'existe plus (changement de chat pendant la consultation).
    function openTaskModal(entry, ri) {
        const run = entry && entry.msg && entry.msg.taskRuns && entry.msg.taskRuns[ri];
        if (!run) return;
        taskModalStep.value = null;
        taskModal.value = { idx: entry.idx, ri, cid: run.id || null, snap: run };
    }
    function closeTaskModal() { taskModal.value = null; taskModalStep.value = null; }
    function taskModalRun() {
        const tm = taskModal.value;
        if (!tm) return null;
        const m = messages.value[tm.idx];
        const run = m && m.taskRuns && m.taskRuns[tm.ri];
        if (run && (!tm.cid || !run.id || run.id === tm.cid)) return run;
        return tm.snap || null;
    }

    async function cancelTaskRun(run) {
        if (!run || run.state !== 'running' || run.cancelRequested) return;
        // La ligne passe en « annulation… » (le ✕ disparaît, anti double-clic).
        _patchTaskRun(run, { cancelRequested: true });
        // Batch sérialisé : un enfant EN FILE n'a pas encore d'id (pas spawné)
        // → annulation DIFFÉRÉE, le POST part dès l'event `spawned` qui
        // assigne l'id (handler task_step). Avant ce fix, seul l'enfant en
        // cours d'exécution était annulable.
        if (!run.id) return;
        try {
            await fetchAuth('/api/chat/task-cancel', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                // child_id seul : l'endpoint scope par le username d'auth,
                // jamais par chat_id.
                body: JSON.stringify({ child_id: run.id }),
            });
        } catch (e) { /* best-effort */ }
    }

    function statusPhase(msg) {
        if (!msg) return null;
        // 1. Un outil en cours prime : c'est l'action la plus concrète.
        //    (passe 8, F9) — le DERNIER step EN COURS, pas le dernier step tout
        //    court : en parallel-tool-use un outil antérieur tourne encore
        //    alors que le dernier a déjà fini (pill fausse ou absente).
        const steps = (msg.toolSteps && msg.toolSteps.length) ? msg.toolSteps : null;
        let running = null;
        if (steps) {
            for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i] && steps[i].status === 'running') { running = steps[i]; break; }
            }
        }
        // Sous-agent en cours : AUCUNE pill de statut — la carte agent (spinner,
        // tokens live, étape x/N) est déjà l'affordance live ; une pill « task »
        // en doublon serait du bruit.
        if (running && running._kind === 'task') {
            return null;
        }
        if (running && running._kind !== 'compression' && running._kind !== 'memory' && running._kind !== 'todo') {
            if ((running.name || '').startsWith('rag_')) {
                return { kind: 'rag', label: running.ragLabel || 'Consultation documentaire' };
            }
            const arg = toolKeyArg(running);
            return { kind: 'tool', label: arg ? `${running.name} · ${arg}` : (running.name || 'Outil') };
        }
        // 1bis. (passe 8, F7) — arguments d'un appel en cours de génération :
        //       libellé posé au tool_call_delta (« Appel d'outil · write_file… »).
        const _s0 = (msg._statusLine || '').trim();
        if (_s0.startsWith(_DELTA_STATUS_PREFIX)) {
            return { kind: 'tool', label: _s0 };
        }
        // 1ter. Rédaction dans la ligne live (passe 8, F8 : visible SOUS le
        //       conteneur, comme le corps) : le texte qui s'écrit EST le retour
        //       — pas de pill, même règle que le corps.
        if (msg._pendingPreContent) {
            return null;
        }
        // 2. Réflexion active : raisonnement en cours, pas encore de réponse ni
        //    d'outil. msg.thinking est vidé/transféré dès le 1er content_token,
        //    donc cette phase s'efface d'elle-même quand la rédaction démarre.
        if (msg.thinking && !msg.content) {
            return { kind: 'think', label: 'Réflexion…' };
        }
        // 2bis. PRÉ-REMPLISSAGE : le moteur lit le prompt, aucun token n'est
        //       encore sorti. Sur un long contexte c'est la phase la plus
        //       longue du tour (26 s mesurées pour 5 600 tokens) et elle était
        //       muette. Le pourcentage s'incrémente à côté du libellé.
        if (typeof msg._prefillPct === 'number' && !msg.content) {
            return { kind: 'think', label: 'Réflexion… ' + msg._prefillPct + ' %' };
        }
        // 3. Sinon : normalise le texte de statut brut du backend.
        const s = (msg._statusLine || '').trim();
        if (!s) return null;
        const has = (...xs) => xs.some(x => s.includes(x));
        if (has('Connexion', 'Connecté', 'MCP', 'prêt')) return { kind: 'connect',  label: 'Connexion aux outils…' };
        if (has('Recherche', 'Lecture', 'Consultation', 'Exploration', 'documentaire')) return { kind: 'rag', label: s };
        if (has('attente'))                               return { kind: 'wait',     label: 'En attente…' };
        // « Génération en cours… » (chemin sans MCP) et « Réflexion… » (chemin MCP)
        // décrivent la même phase « le modèle travaille » → libellé unifié
        // « Réflexion… » (point vert) pour que ce soit cohérent partout.
        if (has('Génération', 'Generation', 'Réflexion', 'eflexion'))
            return { kind: 'think', label: 'Réflexion…' };
        return { kind: 'run', label: s };
    }

    // Couleur du point animé selon la phase. Sobre : slate par défaut,
    // une teinte par famille d'action (outil = bleu, RAG = violet).
    function statusDotClass(kind) {
        if (kind === 'think')                      return 'bg-emerald-500';
        if (kind === 'rag')                        return 'bg-purple-400';
        if (kind === 'tool' || kind === 'connect') return 'bg-blue-400';
        if (kind === 'wait')                       return 'bg-slate-300';
        return 'bg-slate-400';
    }

    return {
        _modelPollTimer,
        // State
        chats, currentChatTitle, titleFlash, chatContainer, isThinking, statusText, queueStatus, todoList, todoPanelOpen, composeColRef, chatBottomPad, scrollBtnBottom, compressionStatus, compressionProgress, compressionCapped, abortController, pendingWrite,
        compressionState, manualCompressBusy, manualCompress,
        compactionNotice, manualCompressChatId, fmtNoticeTs,
        conversationTooLong,
        ctxRealPct,
        ctxUsage, fmtCtxUsage, applyChatCtxUsage,
        toolLimitLabel,
        editingMessageIndex, editMessageText, chatSearch, chatSearchResults, isSearchingChats, searchOpen, chatSearchRef, openChatSearch, closeChatSearch,
        attachedFiles, localTools, mcpUserCategories, showMcpPanel, showRagPanel, ragDropdownRef, ragCollections,
        manifestServers, manifestTools, loadManifestServers,
        // Composer "+" menu (UX option 4)
        showComposerPlus, composerPlusRef,
        messageSearch, messageSearchActive, messageSearchQ, messageSearchCount,
        showChatMenu, availableModels, selectedModel, activeModelIds,
        llmHealth, isLoadingModel, showModelManager,
        modelLoadPct, modelLoadStage, modelLoadingId,
        showModelProps, modelPropsData, modelPropsLoading, fetchModelProps, fmtPropVal,
        // a11y + états de chargement du sélecteur de modèle
        modelsLoading, modelsError, toggleModelMenu, onModelMenuKeydown,
        // Connecteurs LLM (sélecteur provider-aware)
        selectedConnector, pickerConnectors, pickerConnModels, pickerConnLoading,
        // ``pickerConnFree`` était lu par le gabarit sans être exposé : la
        // pastille « gratuit » ne s'affichait jamais (AUDIT 2026-09-16, A3).
        pickerConnFree, pickerConnState, retryConnModels, isConnModelLoaded,
        toggleConnModel, selectedModelLabel, builtinAllowed, canManageModels,
        noEngineAllowed, selectedEngineMeta,
        pickLocalModel, pickConnectorModel,

        // MCP local categories (dynamic; sourced from /api/mcp/categories)
        loadMcpUserCategories, mcpCategoryBgClass, mcpCategoryToggleClass,

        // Sampling override (UI paramètres avancés par modèle)
        showSamplingPanel, samplingOverride, thinkingEnabled, clampThinkingBudget, effectiveParamsData, effectiveParamsLoading,
        ignoredByEngine, isIgnoredByEngine,
        openSamplingPanel, closeSamplingPanel, loadEffectiveParams, resetSamplingOverride,
        // Raisonnement conservé (toggle panneau sampling, capacité /props)
        preserveReasoningSupported, preserveReasoningEnabled,
        // Effort de réflexion (chip à côté du sélecteur de modèle)
        reasoningEffortValues, showReasoningEffortMenu, toggleReasoningEffortMenu, pickReasoningEffort,

        // Virtual scroll
        visibleMessages, vsTopPad, vsBotPad, onChatScroll, lastAssistantIdx, scrollToMessage,

        togglePanel,

        // Runs en cours (pastilles de la barre latérale, rattachement)
        activeRunIds, refreshActiveRuns, attachRun,

        // @mention
        showMentionDropdown, mentionQuery, mentionFiles, mentionIndex, mentionRecentCount, isMentionLoading,
        mentionHasMore, loadMoreMentionFiles, onMentionScroll,
        closeMentionDropdown, selectMention, handleInputKeydown, handleInputInput,
        // @mention display helpers (UX option 1 round 3)
        mentionIconClass, mentionFilenameOf, mentionDirOf,
        // Menu « / » : commandes, valeurs d'argument, skills, prompts
        showSlash, slashLevel, slashList, slashIdx, slashRaw, pinnedSkills,
        selectSlash, removePinnedSkill, slashDismiss, slashSetIdx, slashCmdOk,
        slashRowKey, slashRowTitle, promptPreview, slashHeaderIcon, slashHeaderLabel,
        // Templates de prompt : fenêtre des variables (includes/modals/template_fill.html)
        // + appels depuis les Paramètres (ctx.openTemplate, ctx.loadTemplates)
        templatesAll, loadTemplates, openTemplate, templateFill, submitTemplateFill,
        cancelTemplateFill, templateFillKeydown, templateVarsLabel,
        // Mode lecture seule de la conversation (/plan) — setPlanMode exposé
        // pour le chip actionnable de la barre de prompt (clic = /plan off)
        planMode, setPlanMode,
        // Questionnaire interactif (outil ask_user → panneau au-dessus du composer)
        askUserPanel, askUserCurrent, isAskOptionOn, toggleAskOption,
        askUserPrev, askUserNext, dismissAskUser, submitAskUser,
        // Assistant de création de skill (bouton de la page Skills)
        startSkillAssistantChat, launchSkillAssistantChat, skillAssistForm,
        startDocumentChat,

        // Render
        renderMarkdown, renderMarkdownHighlight, handleMarkdownClick, renderMarkdownLive,

        // Chat actions
        loadChatsList, loadAvailableModels, startNewChat, loadChat,
        // Toggles d'outils par chat : le snapshot de session (app.js
        // _saveSession/_restoreSession) les lit ICI, sur le module public —
        // pas seulement via l'objet d'aides passé à setupChatHistory. Sans
        // ces deux exports, ``chatMod.activeToolCats`` valait undefined : le
        // snapshot sauvait ``tools: null``, un F5 restaurait des toggles
        // VIDES et le PUT /tools suivant effaçait la sélection EN BASE
        // (catégories locales et serveurs externes). Régression 2026-09-04.
        activeToolCats: _activeToolCats, applyChatTools, defaultToolKeys: _defaultToolKeys,
        // Cases à cocher par outil (panneau Outils) : l'état ET ses gestes
        // doivent être exposés, le template n'atteint que ce qui est ici.
        excludedTools, openToolCats, isToolOn, toggleTool, setToolOn,
        resetCatTools, catToolsCount, toggleToolCatOpen,
        toolInfo, openToolInfo, closeToolInfo,
        loadLlmModel, unloadLlmModel, toggleLlmModel, isModelLoaded,
        // kvColor reste exposé (teinte nue) ; les classes passent par ces
        // helpers — jamais de nom de classe composé dans un template.
        kvColor, kvTextClass, kvDimClass, kvBarClass,
        archiveChat, renameChat, deleteChat,
        chatSelectMode, chatSelected,
        toggleChatSelectMode, toggleChatSelect, bulkArchiveChats, bulkDeleteChats,
        startEditMessage, cancelEditMessage, submitEditMessage,

        // Streaming
        stopGeneration, continueGeneration, respondNow, generateResponse, retryGeneration, resumeAfterError,
        handleStreamEvent, sendMessage,

        // Assistant message actions (UX option 1)
        copyAssistantMessage,

        // Tool pills preview (UX option 2)
        getToolPillsFor,

        // Segments texte/outils entrelacés (UX 2026-07-20)
        segGroupsFor,

        // Conteneur « Travail de l'assistant » (accordéon externe par message)
        pipelineFor,

        // Terminal en direct (console par segment, remplace la carte détail
        // des steps shell)
        renderShellConsole,
        copyShellConsole,
        shellScrollOnOpen,
        toggleToolDetail,

        // Ligne de stats LIVE sous le composeur (génération en cours)
        liveGen,

        // Compression token delta formatting (UX option 3 round 2)
        fmtCompression,
        // Formatage compact des tokens (1234 → "1.2k") — sous-agents `task`
        fmtTokens: _fmtTokens,
        // Annulation d'UN sous-agent (bouton ✕ de la ligne agent) — le tour
        // parent survit, le modèle reçoit une enveloppe task_cancelled.
        cancelTaskRun,
        // Modale « œil » : déroulé complet d'un sous-agent (UX 2026-07-24)
        taskModal, taskModalStep, openTaskModal, closeTaskModal, taskModalRun,

        // Statut live in-place (pill unique normalisée)
        statusPhase,
        statusDotClass,
        toolKeyArg,

        // KV cache snapshot per-message (UX round 4)
        fmtKvCache,
        metricsTooltip,
        // Part de réflexion d'un message (chip de la ligne métriques)
        thinkingTokensOf,
        fmtThinkingTokens,
        // Durées lisibles (métriques de fin de réponse, durées d'étapes).
        // Noms distincts de fmtDuration() (_routines_menu.js) : même setup
        // Vue, pas de collision de clé.
        fmtElapsed, fmtElapsedMs, fmtToolMs,

        // Thinking metadata in summary line (UX option 3 round 4)
        fmtThinkingMeta,

        // Inline chat title editing (UX option 2 round 3)
        editingChatTitle, chatTitleDraft,
        startChatTitleEdit, commitChatTitleEdit, cancelChatTitleEdit,

        // UI
        scrollToBottom, addCodeCopyButtons, autoResize, composerPlaceholder,
        exportChatAs, showExportFormatMenu,

        // File attach
        triggerFileUpload, handleFileUpload, removeAttachedFile,
        chatDragOver, handleChatDragEnter, handleChatDragOver, handleChatDragLeave, handleChatDrop,

        // SSE
        connectSystemEvents, disconnectSystemEvents, formatToolResult, fmtToolArgVal,
        // Nettoyage de session (proxifié par ctx.resetChatOnLogout)
        resetOnLogout,

        // Live web screenshot carousel
        webShotPrev, webShotNext, webShotToggleExpand, webShotGoto,
        // Voix
        voiceState, voiceLevel, voiceBusy, voiceReading, voiceReadingIdx,
        voiceCanDictate, voiceCanRead,
        toggleDictation, cancelVoice, voiceEscape, speakMessage, stopSpeaking,
        setMsgUi,

        // -- Diff rows (lignes "fichiers modifiés", style Cline) -------
        // Source unique de vérité côté UI : voir js/chat/_diff_card.js.
        // Clic : diff Monaco si l'éditeur est activé, sinon diff unifié déplié.
        diffCardState,
        diffFilesFor,
        hasDiffFiles,
        diffCardRev,
        isDiffEditorEnabled,
        onDiffRowClick,
        downloadOneFile,
        downloadAllFilesAsZip,

        // -- « Détails » d'une réponse (L5.3) -- js/chat/_run_details.js
        ..._runDetailsMod,

        // -- Ligne "sauvegardé en mémoire" (live only) -- js/chat/_memory_card.js
        memorySavesFor,
        effectLinesFor, effectIsOpen, effectDetail, toggleEffect, undoMemoryEffect,
        manageMemory, effectUiRev,
        toolStepsForDisplay,
    };
}

// Formate UNE valeur d'argument de tool call pour l'affichage (params du step).
// Objectif : JSON INDENTÉ et lisible.
//   - objet/array       → JSON.stringify(indent 2)
//   - chaîne QUI EST du JSON (ex. un arg passé stringifié par le modèle)
//                        → re-parse + indent (sinon affiché sur une ligne compacte)
//   - chaîne simple      → telle quelle (préserve les vrais retours à la ligne,
//                          ex. le contenu d'un write_file, que JSON.stringify
//                          aurait échappés en « \n »).
function fmtToolArgVal(val) {
    if (val === null || val === undefined) return String(val);
    if (typeof val === 'object') return JSON.stringify(val, null, 2);
    if (typeof val === 'string') {
        const t = val.trim();
        if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
            try { return JSON.stringify(JSON.parse(t), null, 2); } catch (e) { /* pas du JSON → brut */ }
        }
        return val;
    }
    return String(val);
}

function formatToolResult(raw) {
    if (raw === null || raw === undefined || raw === '') return '--';
    let obj;
    try { obj = JSON.parse(raw); } catch(e) { return raw; }

    if (typeof obj === 'string') return obj;
    if (typeof obj !== 'object' || obj === null) return String(obj);

    if (Array.isArray(obj)) {
        if (obj.length === 0) return '(aucun résultat)';
        return obj.map(item => {
            if (typeof item === 'string') return '• ' + item;
            if (typeof item === 'object' && item !== null) {
                const label = item.text || item.content || item.name || item.path || item.value || item.output;
                return '• ' + (label !== undefined ? String(label) : JSON.stringify(item));
            }
            return '• ' + String(item);
        }).join('\n');
    }

    if (obj.error !== undefined) return 'Erreur : ' + String(obj.error);

    for (const f of ['content', 'text', 'output', 'result', 'stdout', 'data', 'message']) {
        if (obj[f] !== undefined && obj[f] !== null && typeof obj[f] === 'string') {
            const extra = Object.entries(obj).filter(([k]) => k !== f && k !== 'ok');
            if (extra.length === 0) return obj[f];
            return obj[f] + '\n' + extra.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
        }
    }

    if (obj.ok !== undefined && Object.keys(obj).length <= 4) {
        const status = obj.ok ? '✓ OK' : '✗ Erreur';
        const extra = Object.entries(obj).filter(([k]) => k !== 'ok')
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
        return extra ? `${status} -- ${extra}` : status;
    }

    return Object.entries(obj)
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}`)
        .join('\n');
}
