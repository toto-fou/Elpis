// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_history.js -- CRUD des chats sauvegardés.
//
//  Extrait de app-chat.js (lignes 2262-2505 dans la version v11).
//  Comportement identique à la version inline :
//
//    * loadChatsList()       -- fetch ``/api/saved/chats?archived=0``,
//                                refresh le sidebar (skip silencieux
//                                en mode admin-only)
//    * startNewChat()        -- reset complet du chat courant + cleanup
//                                blob URLs + reset virtual scroll
//    * loadChat(id)          -- charge un chat depuis le serveur OU
//                                restaure un stream parqué en
//                                background si l'id matche
//    * archiveChat(id)       -- POST archive + retire de la liste
//    * renameChat(id, old)   -- prompt + PATCH titre
//    * deleteChat(id)        -- toast undoable (5s) puis DELETE
//
//  Subtilités préservées :
//
//    * loadChat() FREEZE (Object.freeze) tous les messages chargés
//      pour éviter que Vue 3 wrappe chaque objet dans un Proxy
//      réactif. Sur 200+ messages : -40 % CPU au load, mémoire
//      divisée par ~3. ``_patch()`` (qui reste dans app-chat.js)
//      remplace l'objet à son index pour les mutations — l'array
//      reste réactif, ça suffit pour Vue.
//
//    * deleteChat() est OPTIMISTE + UNDOABLE : retrait immédiat de
//      la liste + toast 5s avec bouton Annuler. Le DELETE serveur
//      ne part qu'à l'expiration du toast. Si l'user clique Annuler,
//      le chat est restauré à sa position d'origine et aucun fetch
//      n'est fait.
//
//    * loadChat() / startNewChat() arrêtent la LECTURE d'un tour en cours
//      (deps.detachFromStream — le run continue côté serveur) ; loadChat
//      se RATTACHE ensuite au run de la conversation chargée s'il tourne
//      encore (deps.attachRun : rejeu du journal puis direct). Chantier C,
//      2026-09-16 — l'ancien parcage en mémoire (``_bgStream``) a disparu.
//
//  Dépendances injectées :
//    * sharedRefs.messages, currentChatId, currentChatTitle,
//      currentView, isStreaming, isThinking, statusText,
//      isUserScrolling, chats, inputRef
//    * ctx.fetchAuth, showToast, openConfirm, openPrompt, showSidebar
//    * deps.* : voir signature, regroupe les fonctions hoistées
//      (function declarations) et les helpers d'autres sous-modules
//      qui doivent être passés en référence parce que définis hors
//      de ce sous-module.
//
//  Exporte :
//    * loadChatsList, startNewChat, loadChat, archiveChat,
//      renameChat, deleteChat
// ============================================================

function setupChatHistory(vue, sharedRefs, ctx, deps) {
    const { nextTick, ref } = vue;

    const {
        messages, currentChatId, currentChatTitle, currentView,
        isStreaming, isThinking, statusText, isUserScrolling,
        chats, inputRef, attachedFiles,
        user = { value: null },   // audit 2026-08-02 (défensif si absent)
    } = sharedRefs;

    const {
        fetchAuth, showToast, openConfirm, openPrompt,
        showSidebar,  // ref(bool) du parent
    } = ctx;

    const {
        // Fonctions hoistées dans app-chat.js (function declarations)
        // Chantier C (2026-09-16) : quitter une conversation qui génère arrête
        // la LECTURE (le run continue côté serveur) ; y revenir s'y RATTACHE.
        detachFromStream,
        stopRunForChat = null,   // (2026-09-20) arrêt du run d'un chat supprimé
        attachRun,
        _parseFileBlocks,
        _deferHeavyRender,
        scrollToBottom,
        settleScrollBottom,
        // Functions de sous-modules
        _revokeAllWebShotBlobs,   // chat/_webshot.js
        _vsReset, _vsInitTail,    // chat/_virtual_scroll.js
        clearMarkdownCache,       // chat/_rendering.js
        clearChartInstances,      // chat/_rendering.js (anti memory-leak Chart.js)
        resetDiffCardState,       // chat/_diff_card.js (état indexé par msgIdx)
        addCodeCopyButtons,       // chat/_rendering.js
        loadAvailableModels,      // chat/_models.js
        resetMessageSearch,       // chat/_search.js (reset barre de recherche in-message)
        cancelEditMessage,        // chat/_message_edit.js (reset édition au switch)
        setTodoList,              // app-chat.js (panneau todo — seed/reset)
        applyChatTools,           // app-chat.js (toggles d'outils par chat)
        resetSlash,               // chat/_slash.js (menu « / » — fermeture au switch)
        applyChatPlanMode,        // app-chat.js (lecture seule par chat)
        applyChatCtxUsage,        // app-chat.js (occupation de contexte persistée)
        clearPinnedSkills,        // chat/_slash.js (skills épinglés — passe 2)
        resetAskUser,             // app-chat.js (questionnaire ask_user — passe 2)
        closeTaskModal,           // app-chat.js (modale « œil » d'agent — passe 4)
    } = deps;

    // Garde-fou cache : applyChatTools peut être absent si un ancien
    // app-chat.js est servi. null/undefined = chat d'avant la feature →
    // la fonction ne touche pas aux toggles courants (comportement hérité).
    const _applyTools = (typeof applyChatTools === 'function')
        ? applyChatTools
        : function () { /* no-op fallback */ };

    // Même garde-fou : la lecture seule (meta_json["plan_mode"]) est un
    // booléen simple — absent ⇒ false, il n'y a pas d'état « jamais posé ».
    // Occupation de contexte persistée : absente sur un ancien app-chat.js
    // ou un chat jamais mesuré → aucun effet (jauge masquée, comme avant).
    const _applyCtxUsage = (typeof applyChatCtxUsage === 'function')
        ? applyChatCtxUsage
        : function () { /* no-op fallback */ };

    const _applyPlan = (typeof applyChatPlanMode === 'function')
        ? applyChatPlanMode
        : function () { /* no-op fallback */ };

    // (2026-09-11) Clés d'outils pré-cochées d'un NOUVEAU chat : ``default_on``
    // du manifeste mcp.json (vide par défaut — décision 2026-07-13 conservée).
    const _defaultTools = (typeof deps.defaultToolKeys === 'function')
        ? deps.defaultToolKeys
        : function () { return []; };

    // Guard-rail : si app-chat.js n'a pas encore été redéployé (ou si un
    // ancien cache navigateur est servi), clearChartInstances peut être
    // undefined. Fallback no-op pour ne pas casser le switch de chat.
    const _clearCharts = (typeof clearChartInstances === 'function')
        ? clearChartInstances
        : function() { /* no-op fallback */ };
    // Même garde-fou que _clearCharts : resetDiffCardState peut être absent
    // si un ancien cache de _diff_card.js est servi.
    const _resetDiffCards = (typeof resetDiffCardState === 'function')
        ? resetDiffCardState
        : function() { /* no-op fallback */ };
    // Même garde-fou : resetMessageSearch peut être absent si app-chat.js
    // n'injecte pas encore le helper (ancien cache / déploiement partiel).
    const _resetMsgSearch = (typeof resetMessageSearch === 'function')
        ? resetMessageSearch
        : function() { /* no-op fallback */ };
    // Réinitialise l'état transitoire de composition/édition au changement de
    // chat. Sans ça : les pièces jointes EN ATTENTE (non envoyées) suivaient
    // vers le chat suivant (et s'y attachaient à l'envoi), et la boîte d'édition
    // restait ouverte sur un index de message qui pointe désormais un AUTRE
    // message dans le nouveau chat (les index sont par-chat).
    function _resetTransientCompose() {
        try { if (attachedFiles) attachedFiles.value = []; } catch (_) {}
        if (typeof cancelEditMessage === 'function') { try { cancelEditMessage(); } catch (_) {} }
        // Menu « / » : ses disponibilités (/compact, /plan) sont calculées
        // sur le chat COURANT — le laisser ouvert au switch afficherait un
        // état périmé. Même garde-fou de cache que _applyTools.
        if (typeof resetSlash === 'function') { try { resetSlash(); } catch (_) {} }
        // AUDIT 2026-08-31 (passe 2) — même classe de fuite inter-chat que
        // les pièces jointes : un skill épinglé via /skill suivait le switch
        // et s'injectait dans le premier message d'un AUTRE chat ; le
        // questionnaire ask_user (stash + panneau) n'était réinitialisé par
        // AUCUN chemin — un panneau périmé pouvait surgir sur la mauvaise
        // conversation et sa soumission écraser le brouillon.
        if (typeof clearPinnedSkills === 'function') { try { clearPinnedSkills(); } catch (_) {} }
        if (typeof resetAskUser === 'function') { try { resetAskUser(); } catch (_) {} }
        // (passe 4, F10) — la modale « œil » d'agent référence un message par
        // index dans le chat qu'on quitte : périmée dès le switch.
        if (typeof closeTaskModal === 'function') { try { closeTaskModal(); } catch (_) {} }
    }

    async function loadChatsList() {
        // ── ADMIN-ONLY GUARD ─────────────────────────────────────────
        // /api/saved/chats lives on the main port. SSE reconnect callbacks
        // (onReconnect in setupChatSystemSSE below) routinely invoke this
        // helper to refresh the chat list after a network blip — on admin
        // that's just a 404 stream. Skip silently.
        if (window.__ADMIN_ONLY_MODE__) return;
        try {
            const res = await fetchAuth('/api/saved/chats?archived=0', {}, true);
            if (res && res.ok) {
                const data = await res.json();
                chats.value = data.items || [];
                if (currentChatId.value) {
                    const cur = chats.value.find(c => c.id === currentChatId.value);
                    if (cur) currentChatTitle.value = cur.title;
                }
            }
        } catch (e) { /* non-fatal */ }
    }

    // AUDIT 2026-08-31 (passe 2) — jeton d'obsolescence des chargements.
    // ``loadChat`` assignait INCONDITIONNELLEMENT après son await : sur deux
    // clics rapides, la réponse la plus LENTE gagnait (B s'affiche puis se
    // fait remplacer par A une seconde plus tard). Même garde-fou que la
    // recherche globale (_search.js, _chatSearchSeq) : seul le DERNIER
    // demandé a le droit d'écrire. ``startNewChat`` incrémente aussi — un
    // « Nouveau chat » ne doit pas être écrasé par un load encore en vol.
    let _loadChatSeq = 0;

    async function startNewChat() {
        currentView.value = 'chat';
        _loadChatSeq++;                 // invalide tout loadChat en vol
        detachFromStream();
        // B3 — révoquer les blob URLs des screenshots AVANT de
        // remplacer messages.value. Avant, on faisait directement
        // messages.value = [] sans cleanup → chaque "Nouveau chat"
        // accumulait les blobs des screenshots Playwright précédents
        // (1-2 MB par screenshot, persistants jusqu'à fermeture du
        // navigateur). Plus aucun snapshot ne partage ces blobs depuis que
        // quitter une conversation arrête la lecture de son flux (chantier C).
        _revokeAllWebShotBlobs();
        _vsReset();
        clearMarkdownCache();
        _clearCharts();
        _resetDiffCards();
        _resetMsgSearch();
        _resetTransientCompose();
        messages.value = []; currentChatId.value = null; currentChatTitle.value = '';
        if (setTodoList) setTodoList([]);   // nouveau chat = panneau todo vide
        // Nouveau chat = AUCUN héritage des toggles du chat précédent ; seuls
        // les défauts DÉCLARÉS (mcp.json › default_on, vide par défaut —
        // demande user 2026-07-13) sont cochés. currentChatId est déjà null →
        // le watcher de persistance ne PUT rien.
        _applyTools(_defaultTools());
        _applyPlan(false);
        // Un nouveau chat repart bas collé : sans ce reset, l'état
        // « autoscroll cassé » hérité du chat précédent survivait et
        // désactivait l'autoscroll dès les premiers messages.
        isUserScrolling.value = false;
        // (passe 6, F10) — clé namespacée par user (cf. app.js _sessionKey) :
        // la clé nue supprimée ici ne correspondait à rien depuis le
        // namespacing → le snapshot du chat précédent survivait à « Nouveau
        // chat » et ressuscitait au prochain crash/rechargement.
        try { ctx.clearSavedSession && ctx.clearSavedSession(); } catch (_) {}
        if (window.innerWidth < 1024) showSidebar.value = false;
        // Rafraîchit la liste des modèles (le modèle courant peut avoir changé
        // entre 2 chats via le router ou un chargement auto côté serveur).
        loadAvailableModels();
        nextTick(() => { if (inputRef.value) inputRef.value.focus(); });
    }

    async function loadChat(id, opts) {
        currentView.value = 'chat';
        // ``opts.force`` (audit 2026-08-22, B3) — RELIRE la conversation
        // COURANTE depuis le serveur. Le court-circuit ci-dessous existe pour
        // qu'un clic sur la conversation déjà ouverte ne coûte rien ; mais à
        // la fin d'un run détaché, c'est précisément la conversation affichée
        // qu'il faut rafraîchir : sans cette échappatoire, l'appel ne faisait
        // rien et l'utilisateur restait devant son tour interrompu alors que
        // le résultat était en base.
        if (currentChatId.value === id && !(opts && opts.force)) return;

        // Conversation qui génère : on arrête d'en LIRE le flux (le run
        // continue côté serveur et se rejouera au retour). Le jeton de
        // génération est avancé tout de suite : aucun événement du flux
        // quitté ne s'écrit dans la conversation qu'on charge (R4).
        const _seq = ++_loadChatSeq;    // (passe 2) seul le dernier clic écrit
        detachFromStream();
        // Revoke blob URLs avant de remplacer le tableau messages (anti-leak).
        _revokeAllWebShotBlobs();
        _vsReset();
        clearMarkdownCache();
        _clearCharts();
        _resetDiffCards();
        _resetMsgSearch();
        _resetTransientCompose();
        try {
            const res = await fetchAuth('/api/saved/chats/' + id, {}, true);
            if (_seq !== _loadChatSeq) return;   // un clic plus récent a pris la main
            if (res && res.ok) {
                const d = await res.json();
                if (_seq !== _loadChatSeq) return;
                currentChatId.value = d.id; currentChatTitle.value = d.title;
                // Seed du panneau todo depuis meta_json["todos"] (replace-all).
                // Une liste ENTIÈREMENT soldée (completed/cancelled) ne
                // réapparaît pas : même règle qu'à la fin de tour (le panneau
                // ne se ré-affiche que s'il reste du travail ouvert).
                if (setTodoList) {
                    const _td = d.todos || [];
                    const _open = _td.some(t => t && t.status !== 'completed' && t.status !== 'cancelled');
                    setTodoList(_open ? _td : []);
                }
                // Restauration des toggles d'outils PAR CHAT (meta_json["tools"],
                // snapshot fin de tour + PUT débouncé). null = chat d'avant la
                // feature → les toggles courants restent tels quels.
                _applyTools(d.tools);
                _applyPlan(d.plan_mode);
                // backend renvoyait parfois {id, title} sans messages
                // (chat tout neuf, race avec upsert) → crash sur d.messages.length.
                if (!Array.isArray(d.messages)) d.messages = [];
                // L'état de compression (résumé + round) est persisté comme
                // message system EN TÊTE de messages_json — usage serveur
                // uniquement, jamais une bulle. Filtre défensif : tout system.
                d.messages = d.messages.filter(m => m && m.role !== 'system');
                // Find the index of the last assistant message
                let lastAsstIdx = -1;
                for (let i = d.messages.length - 1; i >= 0; i--) {
                    if (d.messages[i].role === 'assistant') { lastAsstIdx = i; break; }
                }
                // Construction + GELAGE des messages persistés.
                //
                // Object.freeze() évite que Vue 3 wrappe chaque objet dans
                // un Proxy réactif lorsqu'on l'assigne à messages.value. Un
                // chat de 500 messages = 500 proxies + 500 × N champs
                // observés pour rien, puisque les anciens messages ne sont
                // JAMAIS mutés en place — _patch() fait un Object.assign
                // qui REMPLACE le message à son index (l'array est réactif,
                // ça suffit à déclencher le re-render).
                //
                // Gain mesuré : ~40 % de temps CPU en moins au load sur
                // 200+ messages + empreinte mémoire divisée par ~3.
                // Source : Vue 3 RFC-0013 (shallowReactive optimization).
                //
                // _prevTH : tool_history du message assistant tooled PRÉCÉDENT,
                // threadée au parseur de segments (tool_history est CUMULATIVE
                // inter-tours — le préfixe déjà affiché sur les messages
                // antérieurs doit être sauté, sinon chaque message ré-afficherait
                // les rounds de tous les tours d'avant).
                let _prevTH = null;
                const builtMsgs = d.messages.map((m, mi) => {
                    // FIX (image en pièce jointe → « [object Object] » après
                    // changement de chat) : un message vision est persisté avec un
                    // content MULTIMODAL (liste [{type:'image_url'},{type:'text'}]).
                    // ``renderMarkdown(liste)`` affichait « [object Object] » et
                    // l'image était perdue (msg.images jamais réhydraté). On
                    // reconstruit donc content (texte) + images comme à l'envoi :
                    // msg.content = string, msg.images = [{dataUrl}].
                    let _content = m.content;
                    let _images  = (m.images && m.images.length) ? m.images : null;
                    if (Array.isArray(_content)) {
                        if (!_images) {
                            const _imgs = _content
                                .filter(p => p && p.type === 'image_url' && p.image_url && p.image_url.url)
                                .map(p => ({ dataUrl: p.image_url.url }));
                            if (_imgs.length) _images = _imgs;
                        }
                        const _tp = _content.find(p => p && p.type === 'text');
                        _content = (_tp && typeof _tp.text === 'string') ? _tp.text : '';
                    }
                    const parsed = m.role === 'user' ? _parseFileBlocks(_content) : {};
                    const keepThinking = (mi === lastAsstIdx) ? (m.thinking || '') : '';
                    const msg = {
                        role:           m.role,
                        content:        _content,
                        metrics:        m.metrics,
                        isError:        m.isError,
                        thinking:       keepThinking,
                        thinkingOpen:   false,
                        files:          parsed.files,
                        displayContent: parsed.displayContent,
                    };
                    // FIX (« Continuer » redémarre à zéro) : la
                    // reconstruction ne recopiait QUE les 9 champs
                    // ci-dessus. ``tool_history`` (la séquence agentic
                    // structurée que le backend rejoue pour reprendre le
                    // travail) et les marqueurs de troncature étaient
                    // perdus dès le moindre reload de page ou changement
                    // de chat. Conséquence : sur un tour tronqué rechargé,
                    // le bouton « Continuer » renvoyait un message
                    // assistant SANS tool_history → la route le jetait du
                    // payload → le LLM repartait de zéro.
                    //
                    // On réhydrate donc explicitement ces champs depuis le
                    // message persisté. Ils sont ``undefined`` si absents
                    // (tour normal non tronqué) — sans effet de bord.
                    if (_images && _images.length) msg.images = _images;
                    // Marqueur persistant (notice de compaction) : champs
                    // structurés réhydratés pour le rendu (taille, quand).
                    if (m.role === 'notice') {
                        msg.kind         = m.kind || 'compaction';
                        msg.ts           = m.ts || null;
                        msg.tokens_after = m.tokens_after || null;
                        // Résumé produit → accordéon « Vérifier le compact ».
                        msg.summary      = m.summary || '';
                    }
                    if (m.tool_history)       msg.tool_history      = m.tool_history;
                    // Marqueur de format DELTA (2026-07-27) : réhydraté pour
                    // survivre au prochain POST (round-trip) et piloter le
                    // parseur de segments (start=0, pas d'heuristique legacy).
                    if (m.tool_history_delta) msg.tool_history_delta = true;
                    // Reconstruction de la vue ENTRELACÉE texte/outils (UX
                    // 2026-07-20) depuis tool_history : segTexts (narration
                    // par round) + toolSteps taggés ``seg``, rendus par
                    // segGroupsFor/chat.html exactement comme en live. Avant :
                    // tout l'affichage outils disparaissait au reload.
                    if (m.role === 'assistant' && Array.isArray(m.tool_history) && m.tool_history.length
                        && window.elpisToolSegments) {
                        const _segs = window.elpisToolSegments.parseToolHistorySegments(
                            m.tool_history,
                            { prevHistory: _prevTH,
                              delta: !!m.tool_history_delta,
                              finalContent: (typeof _content === 'string' ? _content : '') || '' });
                        if (_segs && _segs.toolSteps.length) {
                            msg.toolSteps = _segs.toolSteps;
                            msg.segTexts  = _segs.segTexts;
                        }
                        _prevTH = m.tool_history;
                    }
                    if (m.isTruncated)        msg.isTruncated       = m.isTruncated;
                    if (m.toolLoopTruncated)  msg.toolLoopTruncated = m.toolLoopTruncated;
                    if (m.toolLoopStats)      msg.toolLoopStats     = m.toolLoopStats;
                    // Tour coupé en PLEIN raisonnement : ``resume_thinking``
                    // (seul thinking persisté, cf. save_chat) re-peuple le bloc
                    // Réflexion + le marqueur — le « Continuer » d'après reload
                    // repart du raisonnement au lieu de re-raisonner de zéro.
                    if (m.thinkingTruncated && m.resume_thinking) {
                        msg.thinking          = msg.thinking || m.resume_thinking;
                        msg.resume_thinking   = m.resume_thinking;
                        msg.thinkingTruncated = true;
                    }
                    // Sous-agents (outil `task`) : records persistés côté serveur
                    // → carte agent PERSISTANTE re-rendue au rechargement.
                    // `tokens` normalisé : occupation réelle finale
                    // (context_tokens, même mécanisme que la jauge parent) ;
                    // repli in+out pour les anciens records.
                    if (Array.isArray(m.task_runs) && m.task_runs.length) {
                        msg.taskRuns = m.task_runs.map(r => ({
                            ...r,
                            tokens: (Number(r.context_tokens) > 0)
                                ? Number(r.context_tokens)
                                : (r.input_tokens || 0) + (r.output_tokens || 0),
                        }));
                    }
                    // errorMessage : sans ça, un message en erreur rechargé
                    // affichait « Erreur inconnue » (isError réhydraté mais pas
                    // son texte). Réhydraté pour garder l'encart cohérent + le
                    // bouton « Reprendre » (si tool_history présente).
                    if (m.errorMessage)       msg.errorMessage      = m.errorMessage;
                    if (Array.isArray(m.files_changed) && m.files_changed.length)
                        msg.files_changed = m.files_changed;
                    // Exécutions du message (``runs``) : renvoyées telles quelles.
                    if (Array.isArray(m.run_ids) && m.run_ids.length)
                        msg.run_ids = m.run_ids;
                    // Compactions du tour (L5.5) : le pseudo-step « compression
                    // du contexte » vu en direct est reconstruit, placé après
                    // les appels du round où il a eu lieu (``round`` = appels
                    // LLM faits avant la compaction).
                    if (m.role === 'assistant' && Array.isArray(m.compactions) && m.compactions.length) {
                        msg.compactions = m.compactions;
                        const _steps = [...(msg.toolSteps || [])];
                        const _segs = (msg.segTexts && msg.segTexts.length) ? msg.segTexts : [''];
                        for (const c of m.compactions) {
                            if (!c || typeof c !== 'object') continue;
                            const _r = Number(c.round) || 0;
                            const _pos = _steps.findIndex(s => s._kind !== 'compression'
                                && typeof s.round === 'number' && s.round >= _r);
                            const _prev = _steps[(_pos < 0 ? _steps.length : _pos) - 1];
                            const _seg = _prev ? (_prev.seg || 0) : 0;
                            const _before = Number(c.tokens_before) || 0;
                            _steps.splice(_pos < 0 ? _steps.length : _pos, 0, {
                                _kind: 'compression', name: 'context_compress', status: 'done',
                                seg: _seg, path: c.path || '', reason: c.reason || '',
                                threshold: c.threshold || 0, ctx_size: c.ctx_size || 0,
                                args: null, result: null,
                                stats: { ...c, ratio: _before ? (Number(c.tokens_after) || 0) / _before : 0 },
                            });
                        }
                        msg.toolSteps = _steps;
                        if (!(msg.segTexts && msg.segTexts.length)) msg.segTexts = _segs;
                    }
                    if (m.pruned) msg.pruned = m.pruned;
                    // On gèle TOUS les messages chargés — même le dernier,
                    // car il n'est pas en cours de streaming (la conv est
                    // persistée, donc terminée). Si l'utilisateur clique
                    // sur "Reprendre" / "Continuer", _doGenerate poussera
                    // un NOUVEAU message (non gelé) à la fin de l'array.
                    return Object.freeze(msg);
                });
                // Init synchrone de la fenêtre AVANT l'assign : le 1er
                // computed visibleMessages renverra déjà la bonne slice,
                // pas une liste vide qui serait remplie au nextTick.
                _vsInitTail(builtMsgs.length);
                messages.value = builtMsgs;
                // Occupation réelle du contexte à la fin du dernier tour
                // (meta_json["ctx_usage"]) : re-sème la jauge et la puce
                // « ctx » — après un F5 ou un redémarrage, l'utilisateur
                // sait où en est le contexte avant de reprendre.
                _applyCtxUsage(d.ctx_usage, d.id);
                if (window.innerWidth < 1024) showSidebar.value = false;
                isUserScrolling.value = false;
                // Rafraîchit la liste des modèles (le modèle peut avoir été
                // chargé/déchargé côté serveur entre 2 consultations de chats).
                loadAvailableModels();
                nextTick(() => {
                    scrollToBottom(true);
                    // Re-colle le bas après les rendus différés : highlight.js
                    // et les fonts font grossir le contenu APRÈS ce premier
                    // saut → sans settle, l'ouverture d'un chat long depuis
                    // l'accueil laissait le viewport en haut.
                    if (settleScrollBottom) settleScrollBottom();
                    // Scan des <pre> + Chart.js/Mermaid/SVG : coûteux.
                    // Reporté après le first-paint pour ne pas bloquer
                    // l'apparition du texte.
                    _deferHeavyRender(() => addCodeCopyButtons(true));
                });
                // AUDIT 2026-08-02 (W14) — une génération lancée depuis un
                // autre onglet/session peut tourner sur ce chat : rien ne
                // le signalait, et le prochain envoi prenait un 409
                // « generation_running » déroutant. Sonde soft, best-effort.
                fetchAuth('/api/chat/' + encodeURIComponent(id) + '/generation-status', {}, true)
                    .then(r => (r && r.ok) ? r.json() : null)
                    .then(d => {
                        if (_seq !== _loadChatSeq) return;   // autre chat demandé entre-temps
                        if (d && d.generation_running
                                && currentChatId.value === id
                                && !isStreaming.value) {
                            // Chantier C (2026-09-16) — on se RATTACHE au run :
                            // son journal est rejoué puis suivi en direct (bulle,
                            // étapes d'outils, bouton Stop). Suivi par sondage,
                            // VISIBLE, seulement si le run n'est pas rejouable.
                            if (d.resumable && d.run_id && !(opts && opts.noAttach)
                                    && typeof attachRun === 'function') {
                                try { attachRun(id, d); } catch (_) {}
                            } else if (deps.followRun) {
                                try { deps.followRun(id, { silent: true }); } catch (_) {}
                            }
                        }
                    })
                    .catch(() => {});
            } else {
                // Il n'y avait AUCUNE branche d'échec ici : le `soft: true`
                // désarme le toast réseau de fetchAuth, et l'état de rendu
                // vient d'être purgé juste au-dessus. Résultat, un clic sur
                // une conversation qui ne se charge pas ne produisait
                // strictement rien — l'utilisateur recliquait, et continuait
                // de voir la conversation PRÉCÉDENTE en croyant être dans la
                // nouvelle (currentChatId n'est mis à jour qu'en cas de
                // succès). En soft, un 401 revient ici aussi (res non nul).
                if (!res && !user.value) {
                    // AUDIT 2026-08-02 (S-mineur) — fetchAuth vient de
                    // traiter un 401 (toast « Session expirée » + purge +
                    // écran de login via le watcher user). L'ancien code
                    // affichait ici un toast « reconnectez-vous » SANS
                    // jamais afficher le login ; ne rien empiler de plus.
                } else if (res && res.status === 404) {
                    showToast('Cette conversation n’existe plus.', 'error');
                    loadChatsList();   // resynchronise la sidebar
                } else {
                    showToast('Conversation impossible à charger'
                            + (res ? ' (erreur ' + res.status + ')' : ' : serveur injoignable')
                            + ' — réessayez.', 'error');
                }
            }
        } catch (e) {
            if (_seq !== _loadChatSeq) return;   // clic plus récent : silence
            // Idem : ce catch avalait aussi les JSON corrompus.
            showToast('Conversation illisible — son contenu est corrompu ou '
                    + 'la réponse du serveur est incomplète.', 'error');
        }
    }

    async function archiveChat(id) {
        if (!id) return;
        if (!await openConfirm('Archiver la conversation ?', '', false, 'Archiver')) return;
        try {
            const res = await fetchAuth('/api/saved/chats/' + id + '/archive', { method: 'POST' });
            if (res && res.ok) {
                chats.value = chats.value.filter(c => String(c.id) !== String(id));
                if (String(currentChatId.value) === String(id)) startNewChat();
                showToast('Conversation archivée');
            }
        } catch (e) { /* non-fatal */ }
    }

    // Rename interne sans prompt -- utilisé à la fois par renameChat
    // (qui demande le titre via openPrompt) et par l'édition inline du
    // header (UX option 2). Centraliser ici évite la duplication du PATCH
    // + des updates locaux quand on commit le nouveau titre.
    async function _doRenameChat(id, newTitle) {
        const title = (newTitle || '').trim();
        if (!title) return false;
        try {
            const res = await fetchAuth('/api/saved/chats/' + id, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title }),
            });
            if (res && res.ok) {
                const chat = chats.value.find(c => String(c.id) === String(id));
                if (chat) chat.title = title;
                if (String(currentChatId.value) === String(id)) currentChatTitle.value = title;
                return true;
            }
        } catch (e) { /* non-fatal */ }
        return false;
    }

    async function renameChat(id, oldTitle) {
        const title = await openPrompt('Renommer la conversation', oldTitle);
        if (!title || !title.trim()) return;
        await _doRenameChat(id, title);
    }

    // Suivi des suppressions en attente (toast d'annulation de 5 s). Si
    // l'utilisateur recharge/ferme l'onglet avant l'expiration du toast, le
    // DELETE n'était jamais émis → le chat « supprimé » réapparaissait au
    // reload. On flush les suppressions encore en attente sur ``beforeunload``
    // via ``keepalive:true`` (la requête survit au déchargement de la page).
    const _pendingDeletes = new Set();
    if (typeof window !== 'undefined' && !window.__elpisDeleteFlushBound) {
        window.__elpisDeleteFlushBound = true;
        window.addEventListener('beforeunload', function() {
            for (const pid of _pendingDeletes) {
                try { fetchAuth('/api/saved/chats/' + pid, { method: 'DELETE', keepalive: true }); } catch (_) {}
            }
            _pendingDeletes.clear();
        });
    }

    async function deleteChat(id) {
        if (!id) return;
        if (!await openConfirm('Supprimer définitivement ?', '', true)) return;

        const idStr = String(id);
        // (2026-09-20) Le run de cette conversation — au premier plan, suivi
        // ou détaché — est arrêté AVANT le retrait : sinon il continuait côté
        // serveur et la suppression, 5 s plus tard, tombait sur un chat qui
        // écrivait encore (il « revenait », pastille orpheline).
        if (typeof stopRunForChat === 'function') {
            try { stopRunForChat(idStr); } catch (_) {}
        }

        // Retrait optimiste de la liste (UX immédiate)
        const idx = chats.value.findIndex(c => String(c.id) === idStr);
        if (idx < 0) return;
        const removed = chats.value[idx];
        chats.value.splice(idx, 1);
        const wasCurrent = String(currentChatId.value) === idStr;
        if (wasCurrent) startNewChat();

        let cancelled = false;
        // restauration par IDENTITÉ et non par index périmé.
        // Pendant les 5 s du toast, ``chats.value`` peut être muté (nouveau
        // chat streamé via unshift, ou tableau entier remplacé par un
        // loadChatsList sur reconnexion SSE). Réinsérer à l'``idx`` capturé
        // créait un doublon (clé Vue ``:key`` dupliquée → glitch de rendu)
        // ou un placement erroné. On ne réinsère donc que si le chat est
        // réellement absent, à un index borné à la taille courante.
        const _restoreChat = () => {
            if (chats.value.some(c => String(c.id) === idStr)) return;  // déjà présent
            const insertAt = Math.min(idx, chats.value.length);
            chats.value.splice(insertAt, 0, removed);
        };
        _pendingDeletes.add(idStr);
        showToast('Conversation supprimée', 'success', {
            duration: 5000,
            actionLabel: 'Annuler',
            onAction: () => {
                cancelled = true;
                _pendingDeletes.delete(idStr);
                _restoreChat();
                showToast('Suppression annulée');
            },
            onExpire: async () => {
                if (cancelled) return;
                try {
                    const res = await fetchAuth('/api/saved/chats/' + id, { method: 'DELETE' });
                    if (!res || !res.ok) {
                        // Échec réseau : on restaure localement
                        _restoreChat();
                        showToast('Échec de la suppression', 'error');
                    }
                } catch (e) {
                    _restoreChat();
                    showToast('Erreur réseau', 'error');
                } finally {
                    _pendingDeletes.delete(idStr);
                }
            },
        });
    }

    // ════════════════════════════════════════════════════════════════════
    //  Bulk actions (sélection multiple) — patron de archiveSelectMode.
    //  Suppression groupée = endpoint batch existant ; archivage groupé =
    //  boucle sur l'endpoint unitaire (idempotent, pas de batch côté serveur).
    // ════════════════════════════════════════════════════════════════════
    const chatSelectMode = ref(false);
    const chatSelected   = ref([]);   // ids sélectionnés

    function toggleChatSelectMode() {
        chatSelectMode.value = !chatSelectMode.value;
        chatSelected.value = [];
    }

    function toggleChatSelect(id) {
        const i = chatSelected.value.indexOf(id);
        if (i >= 0) chatSelected.value.splice(i, 1);
        else chatSelected.value.push(id);
    }

    function _endBulk(msg, kind) {
        if (msg) showToast(msg, kind || 'success');
        if (ctx.announce) ctx.announce(msg || '');
        chatSelected.value = [];
        chatSelectMode.value = false;
    }

    async function bulkArchiveChats() {
        const ids = chatSelected.value.slice();
        if (!ids.length) return;
        if (!await openConfirm(`Archiver ${ids.length} conversation(s) ?`, '', false, 'Archiver')) return;
        // AUDIT 2026-08-31 (passe 2) — endpoint BATCH + retrait optimiste,
        // comme la suppression groupée. L'ancien code faisait N POST
        // séquentiels avec un remplacement complet de ``chats.value`` (donc
        // un recalcul de groupedHistory + re-render racine) ENTRE chaque
        // requête, bouton « Archiver (N) » toujours cliquable pendant ce
        // temps : sur 25 conversations, la liste se vidait ligne par ligne
        // pendant plusieurs secondes.
        const idSet = new Set(ids.map(String));
        chats.value = chats.value.filter(c => !idSet.has(String(c.id)));
        if (idSet.has(String(currentChatId.value))) startNewChat();
        try {
            const res = await fetchAuth('/api/saved/chats/archive-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
            });
            if (res && res.ok) {
                const data = await res.json().catch(() => ({}));
                _endBulk(`${data.archived != null ? data.archived : ids.length} conversation(s) archivée(s)`);
            } else {
                // Échec : restaurer la liste locale (rechargement autoritatif).
                if (ctx.loadChatsList) ctx.loadChatsList();
                _endBulk('Échec de l\'archivage', 'error');
            }
        } catch (e) {
            if (ctx.loadChatsList) ctx.loadChatsList();
            _endBulk('Erreur réseau', 'error');
        }
    }

    async function bulkDeleteChats() {
        const ids = chatSelected.value.slice();
        if (!ids.length) return;
        if (!await openConfirm(`Supprimer ${ids.length} conversation(s) ?`,
                               'Cette action est irréversible.', true, 'Supprimer')) return;
        // Retrait optimiste local.
        const idSet = new Set(ids.map(String));
        const removed = chats.value.filter(c => idSet.has(String(c.id)));
        chats.value = chats.value.filter(c => !idSet.has(String(c.id)));
        if (idSet.has(String(currentChatId.value))) startNewChat();
        try {
            const res = await fetchAuth('/api/saved/chats/delete-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
            });
            if (res && res.ok) {
                const data = await res.json().catch(() => ({}));
                _endBulk(`${data.deleted != null ? data.deleted : ids.length} conversation(s) supprimée(s)`);
            } else {
                // Échec : restaurer la liste locale (rechargement autoritatif).
                if (ctx.loadChatsList) ctx.loadChatsList();
                _endBulk('Échec de la suppression', 'error');
            }
        } catch (e) {
            if (ctx.loadChatsList) ctx.loadChatsList();
            _endBulk('Erreur réseau', 'error');
        }
    }

    return {
        loadChatsList,
        startNewChat,
        loadChat,
        archiveChat,
        renameChat,
        _doRenameChat,
        deleteChat,
        // Bulk
        chatSelectMode, chatSelected,
        toggleChatSelectMode, toggleChatSelect, bulkArchiveChats, bulkDeleteChats,
    };
}

window.setupChatHistory = setupChatHistory;
