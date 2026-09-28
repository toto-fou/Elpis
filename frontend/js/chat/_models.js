// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/chat/_models.js -- Extracted from app-chat.js
//
//  Multi-model lifecycle: list, load, unload, poll, inspect.
//
//  Responsibilities
//  ----------------
//  • Fetch /api/llm/models and apply the payload to reactive state
//    (shape-tolerant: accepts both `models_with_status` and
//    `models_loaded` field layouts).
//  • Cache `n_ctx` per model so we don't re-fetch /props on every
//    poll. Cache is keyed by model id and invalidated on unload.
//  • Load a model (POST /api/llm/models/load) with a 2-minute
//    status poll loop and friendly toast feedback.
//  • Unload a model (POST /api/llm/models/unload) with confirm
//    dialog + same poll loop.
//  • fetchModelProps: open the "model properties" modal with
//    live-fetched /props data.
//  • fmtPropVal: human-readable formatter for arbitrary prop
//    values (numbers, arrays, nested objects).
//  • kvColor: maps a KV-cache % to a tailwind color hint.
//  • Persist selectedModel to localStorage via a watcher.
//
//  Contract
//  --------
//  Loaded BEFORE app-chat.js. Exposes on window:
//      window.setupChatModels(vue, sharedRefs, ctx)
//
//  Dependencies
//  ------------
//  From sharedRefs : availableModels, selectedModel, activeModelIds,
//                    llmHealth, isLoadingModel,
//                    showModelProps, modelPropsData, modelPropsLoading
//  From ctx        : showToast, fetchAuth, openConfirm
//  From vue        : watch
// ============================================================

(function() {
    'use strict';

    function setupChatModels(vue, sharedRefs, ctx) {
        const { watch, ref, nextTick, computed } = vue;
        const onScopeDispose = vue.onScopeDispose || function(_) {};
        const {
            availableModels, selectedModel, activeModelIds,
            llmHealth, isLoadingModel,
            showModelProps, modelPropsData, modelPropsLoading,
            showModelManager, selectedConnector, selectedEngineMeta,
        } = sharedRefs;

        // Progression du chargement en cours (0-100), ``null`` quand le
        // moteur ne la donne pas — c'est ce ``null`` qui laisse la roue.
        const modelLoadPct = ref(null);
        const modelLoadStage = ref('');
        // Modèle dont le CHARGEMENT est en cours. Distinct de
        // ``isLoadingModel``, qui vaut aussi pendant un DÉCHARGEMENT : c'est
        // ce qui faisait réapparaître la barre pleine du chargement précédent
        // au moment de décharger. La barre appartient au chargement, et à lui
        // seul — ce drapeau le dit dans le gabarit, sans dépendre d'un état
        // partagé avec une autre opération.
        const modelLoadingId = ref('');

        // ── Connecteurs LLM (sélecteur provider-aware) ────────────────────────
        // Liste des connecteurs visibles (perso + partagés) et leurs modèles,
        // pour permettre de chatter via un fournisseur cloud / backend alternatif
        // sans quitter le sélecteur de modèle. Le connecteur par défaut (llama.cpp
        // local) reste représenté par la liste `availableModels` existante.
        const pickerConnectors  = ref([]);   // [{id,label,provider_type,wire,scope,...}]
        const pickerConnModels  = ref({});   // { connId: [modelId, …] }
        // Modèles SANS FACTURATION du connecteur (OpenCode Zen : suffixe
        // ``-free``). Le serveur les remonte déjà en tête de liste ; la pastille
        // dit pourquoi ils y sont.
        const pickerConnFree    = ref({});   // { connId: { modelId: true } }
        const pickerConnLoading = ref({});   // { connId: bool }
        // État de la DERNIÈRE lecture des modèles d'un connecteur (2026-09-16) :
        // { ok, at, error, router, statuses: {modèle: loaded|unloaded|loading},
        //   canManage }. Avant, une liste vide rendue pendant une coupure d'une
        // seconde restait en mémoire (``[]`` est vrai en JS) et n'était plus
        // JAMAIS redemandée : « Aucun modèle » jusqu'au rechargement de la page.
        const pickerConnState   = ref({});
        // Politique d'accès (lot B4) renvoyée par /api/llm/connectors.
        const builtinAllowed    = ref(true);
        const canManageModels   = ref(true);
        const connectorsLoaded  = ref(false);
        // Une lecture réussie reste fraîche 30 s ; un échec est retenté dès
        // 5 s (à l'ouverture du sélecteur, ou par le rafraîchissement
        // périodique tant qu'il est ouvert).
        const _CONN_OK_TTL_MS = 30000;
        const _CONN_FAIL_TTL_MS = 5000;
        // One-shot : loadLlmConnectors() déclenché au premier loadAvailableModels
        // (restauration du connecteur au boot — voir commentaire là-bas).
        let _connectorsBootstrapped = false;

        async function loadLlmConnectors() {
            if (window.__ADMIN_ONLY_MODE__) return;
            try {
                const res = await fetchAuth('/api/llm/connectors', {}, true);
                if (!res || !res.ok) return;
                const d = await res.json();
                // ``provider_allowed:false`` = fournisseur retiré de
                // l'allowlist de l'instance : le connecteur reste éditable dans
                // les réglages, mais ne peut plus servir (le serveur refuse).
                const own    = (d.connectors || []).filter(c => c.enabled && c.provider_allowed !== false);
                const shared = (d.shared || []).filter(c => c.enabled);
                pickerConnectors.value = shared.concat(own);
                builtinAllowed.value  = d.builtin_allowed !== false;
                canManageModels.value = d.can_manage_models !== false;
                connectorsLoaded.value = true;
                // Restaure le connecteur sélectionné (et son modèle) depuis
                // localStorage si le connecteur existe encore — symétrique de
                // selectedModel. On n'écrase PAS un choix explicite déjà fait
                // dans la session (!selectedConnector.value).
                try {
                    const savedConn = localStorage.getItem('selected_connector') || '';
                    if (savedConn && selectedConnector && !selectedConnector.value) {
                        const _conn = pickerConnectors.value.find(c => String(c.id) === String(savedConn));
                        if (_conn) {
                            // Modèle depuis la clé SCELLÉE au connecteur : la clé
                            // partagée `selected_model` peut avoir été réécrite par
                            // _applyModelData au boot (modèle cloud absent de la
                            // liste locale → élection d'un modèle local). La
                            // restaurer ici recomposerait une paire incohérente
                            // (connecteur cloud + modèle local) → 404 fournisseur.
                            // Legacy (clé scellée absente) : default_model du
                            // connecteur ; sans modèle sûr, on NE restaure PAS —
                            // rester sur le local élu est cohérent, l'inverse non.
                            const savedModel = localStorage.getItem('selected_conn_model')
                                || _conn.default_model || '';
                            if (savedModel) {
                                // Id repris du CATALOGUE (pas la chaîne localStorage) :
                                // le template compare en === strict → un id string ne
                                // matcherait jamais conn.id numérique (pastille éteinte).
                                selectedConnector.value = _conn.id;
                                selectedModel.value = savedModel;
                            }
                        } else {
                            // Connecteur supprimé/désactivé → purge, sinon chaque
                            // ouverture du picker retente une restauration morte.
                            localStorage.setItem('selected_connector', '');
                        }
                    }
                } catch (_) {}
                // Connecteur sélectionné qui n'est plus visible (supprimé, désactivé,
                // retiré à ce compte) : on quitte la paire — jamais de repli muet.
                if (selectedConnector && selectedConnector.value
                        && !pickerConnectors.value.some(c => String(c.id) === String(selectedConnector.value))) {
                    selectedConnector.value = '';
                    try { localStorage.setItem('selected_connector', ''); } catch (_) {}
                }
                // Serveur intégré fermé à ce compte : aucune élection locale ; on
                // se place sur le premier serveur autorisé.
                if (!builtinAllowed.value && !(selectedConnector && selectedConnector.value)) {
                    _pickFirstAllowedConnector();
                }
                // Modèles de chaque connecteur : relus s'ils sont périmés ou en échec.
                pickerConnectors.value.forEach(c => loadConnModels(c.id));
            } catch (_) {}
        }

        function _pickFirstAllowedConnector() {
            const c = pickerConnectors.value[0];
            if (!c) {
                if (!builtinAllowed.value) selectedModel.value = '';
                return;
            }
            const m = c.default_model || ((pickerConnModels.value[c.id] || [])[0]) || '';
            if (!m) return;          // re-tenté quand la liste du connecteur arrive
            pickConnectorModel(c, m, { silent: true });
        }

        async function loadConnModels(connId, opts) {
            const force = !!(opts && opts.force);
            if (pickerConnLoading.value[connId]) return;
            const st = pickerConnState.value[connId];
            if (!force && st) {
                const age = Date.now() - (st.at || 0);
                if (age < (st.ok ? _CONN_OK_TTL_MS : _CONN_FAIL_TTL_MS)) return;
            }
            pickerConnLoading.value = Object.assign({}, pickerConnLoading.value, { [connId]: true });
            let next = { ok: false, at: Date.now(), error: '', router: false, statuses: {}, canManage: false };
            try {
                const res = await fetchAuth('/api/llm/connectors/' + connId + '/models'
                                            + (force ? '?fresh=1' : ''), {}, true);
                if (res && res.ok) {
                    const d = await res.json();
                    let ids = (d.models || []);
                    const reached = d.ok !== false;
                    if (!ids.length && d.default_model) ids = [d.default_model];
                    next = {
                        ok: reached, at: Date.now(),
                        error: reached ? '' : (d.error || 'injoignable'),
                        router: !!d.router,
                        statuses: (d.statuses && typeof d.statuses === 'object') ? d.statuses : {},
                        canManage: !!d.can_manage,
                        providerType: d.provider_type || '',
                    };
                    // Un ÉCHEC n'efface pas une liste déjà connue (coupure brève) ;
                    // une réussite la remplace.
                    const prev = pickerConnModels.value[connId];
                    if (reached || !prev || !prev.length) {
                        pickerConnModels.value = Object.assign({}, pickerConnModels.value, { [connId]: ids });
                    }
                    const freeMap = {};
                    (d.free || []).forEach(m => { freeMap[m] = true; });
                    pickerConnFree.value = Object.assign({}, pickerConnFree.value, { [connId]: freeMap });
                } else {
                    next.error = res ? ('HTTP ' + res.status) : 'injoignable';
                }
            } catch (_) {
                next.error = 'injoignable';
            } finally {
                pickerConnState.value = Object.assign({}, pickerConnState.value, { [connId]: next });
                pickerConnLoading.value = Object.assign({}, pickerConnLoading.value, { [connId]: false });
            }
            if (!builtinAllowed.value && !(selectedConnector && selectedConnector.value)) {
                _pickFirstAllowedConnector();
            }
        }

        function retryConnModels(connId) {
            loadConnModels(connId, { force: true });
        }

        function isConnModelLoaded(connId, m) {
            const st = pickerConnState.value[connId];
            return !!(st && st.statuses && st.statuses[m] === 'loaded');
        }

        function pickLocalModel(m) {
            selectedModel.value = m;
            if (selectedConnector) selectedConnector.value = '';   // → llama.cpp local
            // Persistance DIRECTE (pas via les watch) : un watch Vue ne tire pas
            // quand la valeur ne change pas ('' → ''). Or la restauration de
            // loadLlmConnectors relit localStorage APRÈS son fetch — sans écriture
            // immédiate ici, elle ressusciterait le connecteur abandonné et ce
            // choix local explicite partirait quand même vers le cloud.
            try {
                localStorage.setItem('selected_connector', '');
                localStorage.setItem('selected_model', m);
            } catch (_) {}
            showModelManager.value = false;
            try { ctx.announce && ctx.announce('Modèle sélectionné : ' + m); } catch (_) {}
        }

        function pickConnectorModel(conn, model, opts) {
            selectedModel.value = model;
            if (selectedConnector) selectedConnector.value = conn.id;
            // Paire persistée ENSEMBLE + copie du modèle sous une clé propre au
            // connecteur (`selected_conn_model`) : `selected_model` est partagée
            // avec le sélecteur local et peut être réécrite au boot suivant —
            // la clé scellée permet de restaurer une paire cohérente.
            try {
                localStorage.setItem('selected_connector', String(conn.id));
                localStorage.setItem('selected_model', model);
                localStorage.setItem('selected_conn_model', model);
            } catch (_) {}
            if (opts && opts.silent) return;
            showModelManager.value = false;
            try { ctx.announce && ctx.announce('Modèle ' + model + ' via ' + (conn.label || conn.provider_type)); } catch (_) {}
        }

        // Libellé du bouton : le modèle SEUL ne dit pas quel serveur répond —
        // deux serveurs exposant les mêmes noms étaient indiscernables
        // (AUDIT 2026-09-16, M3).
        const selectedConnectorObj = computed(() => {
            const id = selectedConnector ? selectedConnector.value : '';
            if (!id) return null;
            return pickerConnectors.value.find(c => String(c.id) === String(id)) || null;
        });
        const selectedModelLabel = computed(() => {
            const m = selectedModel.value;
            if (!m) return noEngineAllowed.value ? 'Aucun serveur' : 'Aucun modèle';
            const c = selectedConnectorObj.value;
            return c ? (m + ' · ' + (c.label || c.provider_type)) : m;
        });
        // Plus AUCUN serveur ouvert à ce compte (intégré fermé, aucun connecteur).
        const noEngineAllowed = computed(() =>
            connectorsLoaded.value && !builtinAllowed.value && pickerConnectors.value.length === 0);

        // Métadonnées du serveur SÉLECTIONNÉ, lues par le panneau de sampling et
        // la jauge de contexte : un connecteur llama.cpp a les mêmes mécanismes
        // que l'intégré (valeurs du modèle, fenêtre réelle) dès qu'il est chargé.
        const _connCtx = {};     // 'conn:<id>|<modèle>' → n_ctx
        function _refreshEngineMeta() {
            if (!selectedEngineMeta) return;
            const c = selectedConnectorObj.value;
            if (!c) {
                selectedEngineMeta.value = {
                    key: 'builtin', llamacpp: true, label: '',
                    loaded: (activeModelIds.value || []).slice(), n_ctx: 0,
                };
                return;
            }
            const st = pickerConnState.value[c.id] || {};
            const llama = (st.providerType || c.provider_type) === 'llamacpp';
            const statuses = st.statuses || {};
            const loaded = Object.keys(statuses).filter(k => statuses[k] === 'loaded');
            // Serveur llama.cpp sans API de modèles (mono-modèle) : le modèle
            // servi est chargé par définition.
            if (llama && st.ok && !st.router) (pickerConnModels.value[c.id] || []).forEach(m => loaded.push(m));
            const key = 'conn:' + c.id;
            selectedEngineMeta.value = {
                key, llamacpp: llama, label: c.label || c.provider_type,
                loaded, n_ctx: _connCtx[key + '|' + selectedModel.value] || 0,
            };
            if (llama && selectedModel.value && loaded.includes(selectedModel.value)
                    && !_connCtx[key + '|' + selectedModel.value]) {
                _fetchConnCtx(key, selectedModel.value);
            }
        }
        async function _fetchConnCtx(engineKey, modelId) {
            const ck = engineKey + '|' + modelId;
            if (_connCtx['_p_' + ck]) return;
            _connCtx['_p_' + ck] = true;
            try {
                const res = await fetchAuth('/api/llm/models/' + encodeURIComponent(modelId)
                                            + '/props?engine=' + encodeURIComponent(engineKey), {}, true);
                if (res && res.ok) {
                    const d = await res.json();
                    const n = (d && d.default_generation_settings && d.default_generation_settings.n_ctx) || 0;
                    if (n > 0) { _connCtx[ck] = n; _refreshEngineMeta(); }
                }
            } catch (_) {
            } finally { delete _connCtx['_p_' + ck]; }
        }
        watch([() => (selectedConnector ? selectedConnector.value : ''), selectedModel,
               pickerConnectors, pickerConnState, pickerConnModels, activeModelIds],
              _refreshEngineMeta, { immediate: true });
        const { showToast, fetchAuth, openConfirm } = ctx;

        // B2 — états de chargement/erreur du catalogue :
        // avant, un dropdown vide était ambigu (chargement ? zéro modèle ?
        // erreur réseau ?) et l'échec était avalé en silence.
        const modelsLoading = ref(false);
        const modelsError = ref('');

        // cleanup des polls. Un compteur global incrémenté à chaque
        // démontage (ou démarrage d'un nouveau poll) invalide les boucles en
        // vol. Sans ça, plusieurs polls de 2 minutes pouvaient s'accumuler
        // après navigation / reload (closure sur l'état Vue → fuite mémoire
        // + appels API zombies).
        let _pollGen = 0;
        onScopeDispose(function() { _pollGen++; });

        // -- Per-model n_ctx cache -----------------------------------
        // Only fetched once per load, not on every poll.
        // Special key `_pending_<id>` guards against concurrent fetches.
        const _ctxCache = {};

        async function _fetchModelCtx(modelId) {
            if (!modelId) return;
            // ── ADMIN-ONLY GUARD ─────────────────────────────────────
            // The admin process does not mount /api/llm/* (those live on
            // the main port). When admin.html serves this page, calling
            // through still happens because chat/_models.js is part of
            // the SSE plumbing app-chat.js relies on. Skip to avoid 404
            // spam in the live Logs console.
            if (window.__ADMIN_ONLY_MODE__) return;
            try {
                const res = await fetchAuth('/api/llm/models/' + encodeURIComponent(modelId) + '/props', {}, true);
                if (res && res.ok) {
                    const data = await res.json();
                    const nCtx = data?.default_generation_settings?.n_ctx || 0;
                    if (nCtx > 0) {
                        _ctxCache[modelId] = nCtx;
                        if (llmHealth.value) {
                            llmHealth.value = { ...llmHealth.value, props: { ...llmHealth.value.props, n_ctx: nCtx } };
                        }
                    }
                }
            } catch(_) {}
            delete _ctxCache['_pending_' + modelId];
        }

        /** Apply model data from either HTTP response or SSE event. */
        function _applyModelData(json) {
            if (!json) return;
            // un event SSE model_status peut arriver avec une liste
            // vide pendant un hoquet / redémarrage de llama.cpp ({models:[]}).
            // L'appliquer effacerait availableModels, ce qui resetterait le
            // modèle sélectionné à '' (cf. bloc 2 plus bas) puis écraserait la
            // préférence valide dans localStorage. On ignore donc un payload
            // sans modèles tant qu'on en avait déjà : c'est un état transitoire,
            // pas une vraie disparition du catalogue.
            // Serveur intégré fermé à ce compte (lot B4) : catalogue vidé
            // EXPLICITEMENT (pas l'état transitoire ci-dessous) et aucune élection.
            if (json.allowed === false) {
                builtinAllowed.value = false;
                availableModels.value = [];
                activeModelIds.value = [];
                llmHealth.value = null;
                if (!(selectedConnector && selectedConnector.value)) _pickFirstAllowedConnector();
                return;
            }
            const incomingModels = Array.isArray(json.models) ? json.models : [];
            if (incomingModels.length === 0 && Array.isArray(availableModels.value) && availableModels.value.length > 0) {
                return;
            }
            availableModels.value = incomingModels;

            let loaded = [];
            if (Array.isArray(json.models_with_status)) {
                json.models_with_status.forEach(m => {
                    if (m.id && m.status === 'loaded') loaded.push(m.id);
                });
            } else if (Array.isArray(json.models_loaded)) {
                json.models_loaded.forEach(m => {
                    const id = typeof m === 'object' ? (m.id || m.model || m.name) : m;
                    if (id) loaded.push(id);
                });
            }
            activeModelIds.value = [...new Set(loaded)];

            const health = {
                server_reachable: json.server_reachable,
                status: json.status,
                kv_cache: json.kv_cache || { used: 0, total: 0, pct: 0 },
                props: json.props || {},
            };
            if (health.kv_cache.total > 0) {
                health.kv_cache.pct = Math.round((health.kv_cache.used / health.kv_cache.total) * 100) || 0;
            }
            if (loaded.length > 0) {
                const mid = loaded[0];
                if (_ctxCache[mid]) {
                    health.props.n_ctx = _ctxCache[mid];
                } else if ((!health.props.n_ctx || health.props.n_ctx === 0) && !_ctxCache['_pending_' + mid]) {
                    _ctxCache['_pending_' + mid] = true;
                    _fetchModelCtx(mid);
                } else if (health.props.n_ctx > 0) {
                    _ctxCache[mid] = health.props.n_ctx;
                }
            }
            llmHealth.value = health;

            // Connecteur cloud / backend alternatif actif : le modèle sélectionné
            // appartient AU CONNECTEUR (pas à la liste locale). On ne touche donc
            // pas à selectedModel — sinon le poller local (toutes les 10 s) le
            // ré-écraserait par un modèle local. La santé/jauge KV locale reste
            // mise à jour ci-dessus (informatif).
            if (selectedConnector && selectedConnector.value) return;

            let saved = ''; try { saved = localStorage.getItem('selected_model') || ''; } catch(_) {}

            // 1. Initialisation : selectedModel est encore vide (premier chargement)
            if (!selectedModel.value) {
                if (saved && availableModels.value.includes(saved)) {
                    selectedModel.value = saved;
                } else if (activeModelIds.value.length > 0) {
                    selectedModel.value = activeModelIds.value[0];
                } else if (availableModels.value.length > 0) {
                    selectedModel.value = availableModels.value[0];
                }
                try { if (selectedModel.value) localStorage.setItem('selected_model', selectedModel.value); } catch(_) {}
            }

            // 2. Le modèle sélectionné n'est plus dans la liste disponible → reset
            if (selectedModel.value && !availableModels.value.includes(selectedModel.value)) {
                selectedModel.value = activeModelIds.value[0] || availableModels.value[0] || '';
                try { if (selectedModel.value) localStorage.setItem('selected_model', selectedModel.value); } catch(_) {}
            }

            // 3. Des modèles sont chargés en RAM mais le modèle sélectionné n'en fait pas partie
            //    → basculer automatiquement sur le modèle effectivement chargé.
            //    (Le payload vide d'un hoquet est déjà court-circuité par le return en
            //    tête de _applyModelData ; inutile de garder ici sur availableModels.)
            if (activeModelIds.value.length > 0 && !activeModelIds.value.includes(selectedModel.value)) {
                selectedModel.value = activeModelIds.value[0];
                try { if (selectedModel.value) localStorage.setItem('selected_model', selectedModel.value); } catch(_) {}
            }
        }

        async function loadAvailableModels() {
            // ── ADMIN-ONLY GUARD ─────────────────────────────────────
            // Same rationale as _fetchModelCtx above: the admin port
            // does not expose /api/llm/models. Without this guard, the
            // SSE-reconnect callback in app-chat.js triggers this on
            // every reconnection (which happens at every visibility
            // change!) and spams the live Logs console with 404s.
            if (window.__ADMIN_ONLY_MODE__) return;
            // Restauration du connecteur au BOOT (one-shot) : avant, la paire
            // (connecteur, modèle) sauvegardée n'était restaurée qu'à la
            // PREMIÈRE OUVERTURE du picker — jusque-là l'app tournait sur un
            // modèle local élu par défaut, puis basculait de moteur en pleine
            // session sans action utilisateur. Ancré ici (premier fetch de
            // modèles = post-auth garanti) plutôt qu'au setup du module.
            if (!_connectorsBootstrapped) {
                _connectorsBootstrapped = true;
                loadLlmConnectors();
            }
            modelsLoading.value = true;
            modelsError.value = '';
            try {
                const res = await fetchAuth('/api/llm/models', {}, true);
                if (res && res.ok) {
                    _applyModelData(await res.json());
                } else if (res) {
                    modelsError.value = 'Erreur serveur (HTTP ' + res.status + ')';
                } else {
                    modelsError.value = 'Serveur LLM injoignable';
                }
            } catch(e) {
                modelsError.value = 'Erreur de chargement des modèles';
            } finally {
                modelsLoading.value = false;
            }
        }

        // ── a11y (06, P1.9) — pilotage clavier du sélecteur ──
        // Ouverture : focus sur l'option sélectionnée (ou la 1re). Flèches
        // haut/bas + Home/End entre les options, Échap referme et rend le
        // focus au bouton déclencheur.
        function _modelMenuOptions() {
            const root = document.querySelector('[data-model-manager]');
            return root ? Array.prototype.slice.call(root.querySelectorAll('[role="option"]')) : [];
        }

        // Tant que le sélecteur est ouvert, les états des connecteurs se
        // rafraîchissent (TTL respecté : 30 s après un succès, 5 s après un
        // échec) — un serveur revenu après une coupure réapparaît seul.
        let _menuPoll = null;
        watch(showModelManager, (open) => {
            if (_menuPoll) { clearInterval(_menuPoll); _menuPoll = null; }
            if (open) _menuPoll = setInterval(loadLlmConnectors, 5000);
        });
        onScopeDispose(function() { if (_menuPoll) clearInterval(_menuPoll); });

        function toggleModelMenu() {
            showModelManager.value = !showModelManager.value;
            if (!showModelManager.value) return;
            loadAvailableModels();
            loadLlmConnectors();
            nextTick(function() {
                const opts = _modelMenuOptions();
                const current = opts.find(function(el) { return el.getAttribute('aria-selected') === 'true'; });
                (current || opts[0]) && (current || opts[0]).focus();
            });
        }

        function onModelMenuKeydown(e) {
            const opts = _modelMenuOptions();
            if (e.key === 'Escape') {
                e.preventDefault();
                showModelManager.value = false;
                const trigger = document.querySelector('[data-model-manager] > button');
                if (trigger) trigger.focus();
                return;
            }
            if (!opts.length) return;
            const cur = opts.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') {
                e.preventDefault(); opts[(cur + 1 + opts.length) % opts.length].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault(); opts[(cur - 1 + opts.length) % opts.length].focus();
            } else if (e.key === 'Home') {
                e.preventDefault(); opts[0].focus();
            } else if (e.key === 'End') {
                e.preventDefault(); opts[opts.length - 1].focus();
            }
        }

        function isModelLoaded(modelId) {
            if (!modelId || !activeModelIds.value) return false;
            return activeModelIds.value.includes(modelId);
        }

        async function toggleLlmModel(modelId) {
            if (!modelId || isLoadingModel.value) return;
            if (isModelLoaded(modelId)) {
                await unloadLlmModel(modelId);
            } else {
                await loadLlmModel(modelId);
            }
        }

        // AUDIT 2026-09-01 (passe 5, F16) — jeton : le chemin d'erreur d'une
        // requête PÉRIMÉE (modèle A) fermait la modale du modèle B consulté
        // juste après, avec un toast hors sujet.
        let _propsSeq = 0;
        async function fetchModelProps(modelId, engineKey) {
            if (!modelId) return;
            // Admin console has no model-props button, but defend anyway.
            if (window.__ADMIN_ONLY_MODE__) return;
            const mySeq = ++_propsSeq;
            modelPropsLoading.value = true;
            modelPropsData.value = null;
            showModelProps.value = true;
            try {
                const res = await fetchAuth('/api/llm/models/' + encodeURIComponent(modelId) + '/props'
                    + (engineKey && engineKey !== 'builtin' ? '?engine=' + encodeURIComponent(engineKey) : ''), {}, true);
                if (mySeq !== _propsSeq) return;   // réponse périmée
                if (res && res.ok) {
                    const d = await res.json();
                    if (mySeq !== _propsSeq) return;
                    modelPropsData.value = d;
                } else {
                    showModelProps.value = false;
                    showToast('Impossible de récupérer les infos du modèle', 'error');
                }
            } catch(e) {
                if (mySeq !== _propsSeq) return;
                showModelProps.value = false;
                showToast('Erreur réseau', 'error');
            } finally {
                if (mySeq === _propsSeq) modelPropsLoading.value = false;
            }
        }

        function fmtPropVal(val) {
            if (val === null || val === undefined) return '--';
            if (typeof val === 'boolean') return val ? 'true' : 'false';
            if (typeof val === 'number') {
                if (Number.isInteger(val)) return String(val);
                return parseFloat(val.toFixed(2)).toString();
            }
            if (Array.isArray(val)) {
                return val.map(v => fmtPropVal(v)).join(', ');
            }
            if (typeof val === 'object') {
                return JSON.stringify(val, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? parseFloat(v.toFixed(2)) : v, 2);
            }
            return String(val);
        }

        async function _pollModelStatus(modelId, expectLoaded, maxWaitMs = 120000) {
            const interval = 2000;
            const deadline = Date.now() + maxWaitMs;
            // fige la génération au démarrage : si le composant est
            // démonté (ou un autre poll démarre via _pollGen++), la boucle
            // sort proprement au prochain tick.
            const myGen = _pollGen;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, interval));
                if (myGen !== _pollGen) return false;
                try {
                    const res = await fetchAuth('/api/llm/models', {}, true);
                    if (res && res.ok) {
                        const json = await res.json();
                        const models = json.models_with_status || [];
                        const target = models.find(m => m.id === modelId);
                        if (target) {
                            const isLoaded = target.status === 'loaded';
                            if (isLoaded === expectLoaded) return true;
                        }
                    }
                } catch(e) {}
            }
            return false;
        }

        // ── Progression RÉELLE d'un chargement (llama.cpp ≥ b10545) ───────
        // La roue tourne aussi bien pour trois secondes que pour trois
        // minutes : elle ne dit ni où on en est, ni si quelque chose avance
        // encore. Le moteur connaît le pourcentage exact et l'émet toutes les
        // 200 ms ; on l'affiche À LA PLACE de la roue quand il est là.
        //
        // ⚠ Ce flux est DÉCORATIF : la fin du chargement reste établie par
        // ``_pollModelStatus``, qui marche sur tous les moteurs. Un moteur
        // trop ancien répond ``{"supported": false}`` et la roue reste.
        function _watchModelLoadProgress(modelId, engineKey) {
            modelLoadPct.value = null;
            modelLoadStage.value = '';
            let es = null;
            try {
                es = new EventSource(
                    '/api/llm/models/load-progress?model_id=' + encodeURIComponent(modelId)
                    + (engineKey && engineKey !== 'builtin' ? '&engine=' + encodeURIComponent(engineKey) : ''));
            } catch (_) { return function() {}; }
            es.onmessage = function(ev) {
                let d = null;
                try { d = JSON.parse(ev.data); } catch (_) { return; }
                if (!d || d.supported === false || d.done) {
                    // Terminer À 100 % : le dernier échantillon reçu peut être
                    // à 91 %, et la barre s'évanouirait à mi-course. On ne
                    // ment que dans le sens du vrai — uniquement si le moteur
                    // confirme que le modèle est chargé.
                    if (d && d.done && d.loaded === true) modelLoadPct.value = 100;
                    try { es.close(); } catch (_) {}
                    return;
                }
                if (typeof d.pct === 'number') modelLoadPct.value = d.pct;
                if (typeof d.stage === 'string') modelLoadStage.value = d.stage;
            };
            // Une erreur de flux n'est jamais fatale : on retombe sur la roue.
            es.onerror = function() { try { es.close(); } catch (_) {} };
            return function() {
                try { es.close(); } catch (_) {}
                modelLoadPct.value = null;
                modelLoadStage.value = '';
            };
        }

        async function loadLlmModel(modelId) {
            if (!modelId) return;
            // Annule tout poll de statut encore en vol (load/unload précédent) :
            // sans ça, des clics rapides empilaient des boucles de 2 min de GET
            // /api/llm/models en parallèle (cf. _pollModelStatus / myGen).
            _pollGen++;
            isLoadingModel.value = modelId;
            // AVANT le POST : celui-ci attend les slots libres puis le
            // chargement lui-même. Ouvrir le flux après reviendrait à
            // n'afficher la progression qu'une fois terminée.
            modelLoadingId.value = modelId;
            const arreterSuivi = _watchModelLoadProgress(modelId);
            try {
                const res = await fetchAuth('/api/llm/models/load', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model_path: modelId })
                });
                if (res && res.ok) {
                    const data = await res.json();
                    if (data.ok) {
                        showToast('Chargement en cours...', 'info');
                        const ready = await _pollModelStatus(modelId, true);
                        if (ready) {
                            showToast('Modèle chargé !');
                            if (!activeModelIds.value.includes(modelId)) activeModelIds.value.push(modelId);
                            // Charger un modèle LOCAL le sélectionne : même
                            // sémantique que pickLocalModel, RETOUR AU MOTEUR
                            // LOCAL inclus. Sans ça, connecteur cloud actif,
                            // l'UI affichait le modèle fraîchement chargé mais
                            // connector_id partait toujours au fournisseur
                            // externe → 404 « model not found » systématique.
                            selectedModel.value = modelId;
                            if (selectedConnector) selectedConnector.value = '';
                            try {
                                localStorage.setItem('selected_model', modelId);
                                localStorage.setItem('selected_connector', '');
                            } catch(_) {}
                            _fetchModelCtx(modelId);
                        } else {
                            showToast('Timeout -- vérifiez le serveur', 'warning');
                        }
                    } else {
                        showToast(data.error || data.hint || 'Échec', 'error');
                    }
                } else { showToast('Erreur serveur', 'error'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally {
                // ⚠ ICI, et pas dans le finally du DÉCHARGEMENT : c'est ce
                // chargement-ci qui a ouvert le flux de progression. Le
                // placer ailleurs laissait la barre figée à 100 % après un
                // chargement, et son EventSource ouvert.
                arreterSuivi();
                modelLoadingId.value = '';
                isLoadingModel.value = false;
                loadAvailableModels();
            }
        }

        async function unloadLlmModel(modelId) {
            if (!modelId) return;
            if (!await openConfirm('Décharger « ' + modelId + ' » ?', 'Le serveur attendra la fin des requêtes en cours.', false, 'Décharger')) return;
            // Annule tout poll de statut encore en vol avant d'en démarrer un nouveau.
            _pollGen++;
            isLoadingModel.value = modelId;
            // ⚠ La barre appartient au CHARGEMENT. Sans cette remise à zéro,
            // un déchargement qui suit un chargement réaffiche la barre pleine
            // du chargement précédent — « 100 % » pendant qu'on décharge, ce
            // qui ne veut rien dire.
            modelLoadPct.value = null;
            modelLoadStage.value = '';
            showToast('Attente fin des requêtes...', 'info');
            try {
                const res = await fetchAuth('/api/llm/models/unload', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model_id: modelId })
                });
                if (res && res.ok) {
                    const data = await res.json();
                    if (data.ok) {
                        showToast('Déchargement en cours...', 'info');
                        const ready = await _pollModelStatus(modelId, false);
                        if (ready) {
                            showToast('Modèle déchargé');
                            activeModelIds.value = activeModelIds.value.filter(id => id !== modelId);
                            delete _ctxCache[modelId];
                            delete _ctxCache['_pending_' + modelId];
                        } else {
                            showToast('Timeout -- vérifiez le serveur', 'warning');
                        }
                    } else {
                        showToast(data.error || data.hint || 'Non supporté', 'warning');
                    }
                } else { showToast('Erreur serveur', 'error'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally {
                // ``arreterSuivi`` n'existe PAS dans cette portée : l'appeler
                // ici levait une ReferenceError en plein finally, donc
                // ``isLoadingModel`` ne repassait jamais à false — la roue du
                // sélecteur tournait indéfiniment après un déchargement.
                isLoadingModel.value = false;
                loadAvailableModels();
            }
        }

        // ── Charger / décharger un modèle d'un CONNECTEUR llama.cpp ─────────
        // Mêmes gestes que pour l'intégré (AUDIT 2026-09-16) : la route vise le
        // serveur du connecteur (``engine``), l'état est relu sur SON inventaire.
        async function _pollConnModelStatus(connId, modelId, expectLoaded, maxWaitMs = 120000) {
            const deadline = Date.now() + maxWaitMs;
            const myGen = _pollGen;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 2000));
                if (myGen !== _pollGen) return false;
                await loadConnModels(connId, { force: true });
                const st = pickerConnState.value[connId];
                const v = st && st.statuses ? st.statuses[modelId] : undefined;
                if (v !== undefined && (v === 'loaded') === expectLoaded) return true;
            }
            return false;
        }

        async function toggleConnModel(conn, modelId) {
            if (!conn || !modelId || isLoadingModel.value) return;
            const engine = 'conn:' + conn.id;
            const loaded = isConnModelLoaded(conn.id, modelId);
            if (loaded && !await openConfirm('Décharger « ' + modelId + ' » ?',
                    'Sur ' + (conn.label || conn.provider_type) + '. Le serveur attendra la fin des requêtes en cours.',
                    false, 'Décharger')) return;
            _pollGen++;
            isLoadingModel.value = engine + '|' + modelId;
            let arreterSuivi = function() {};
            if (!loaded) {
                modelLoadingId.value = modelId;
                arreterSuivi = _watchModelLoadProgress(modelId, engine);
            }
            try {
                const res = await fetchAuth('/api/llm/models/' + (loaded ? 'unload' : 'load'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(loaded ? { model_id: modelId, engine } : { model_path: modelId, engine }),
                });
                const data = res ? await res.json().catch(() => ({})) : {};
                if (res && res.ok && data.ok) {
                    const ready = await _pollConnModelStatus(conn.id, modelId, !loaded);
                    if (!ready) showToast('Timeout -- vérifiez le serveur', 'warning');
                    else if (!loaded) {
                        showToast('Modèle chargé !');
                        pickConnectorModel(conn, modelId, { silent: true });
                    } else {
                        showToast('Modèle déchargé');
                    }
                } else {
                    showToast((data && (data.error || data.detail)) || 'Échec', res && res.status === 403 ? 'warning' : 'error');
                }
            } catch (_) {
                showToast('Erreur réseau', 'error');
            } finally {
                arreterSuivi();
                modelLoadingId.value = '';
                isLoadingModel.value = false;
                loadConnModels(conn.id, { force: true });
            }
        }

        // Seuils de la jauge de contexte. ⚠ Le palier « accent » (classe
        // text-blue-600) n'est PAS bleu à l'écran : style.css le mappe sur
        // --accent-text, que chaque skin recolore — or/terracotta (#8d6834)
        // dans Elpis, le skin par défaut. Il se LIT donc comme un
        // avertissement. À 50 % il s'allumait sur un contexte à peine à
        // moitié plein : demande utilisateur 2026-09-07, plancher remonté à
        // 65 % — en dessous, la jauge reste verte.
        function kvColor(pct) {
            if (pct >= 90) return 'red';
            if (pct >= 75) return 'amber';
            if (pct >= 65) return 'blue';
            return 'emerald';
        }

        // ⚠ CLASSES ÉCRITES EN ENTIER, JAMAIS COMPOSÉES — même règle que
        // MCP_CAT_STYLES (app-chat.js). La feuille Tailwind est PRÉCOMPILÉE :
        // son extracteur lit les littéraux des sources et ne peut pas deviner
        // un `'text-' + kvColor(pct) + '-600'`. Ces quatre teintes existaient
        // par chance dans le CSS (écrites en dur ailleurs) ; changer un seuil
        // ou une nuance suffisait à produire une classe absente, donc muette.
        const KV_TONES = {
            red:     { text: 'text-red-600',     dim: 'text-red-500',     bar: 'bg-red-500' },
            amber:   { text: 'text-amber-600',   dim: 'text-amber-500',   bar: 'bg-amber-500' },
            blue:    { text: 'text-blue-600',    dim: 'text-blue-500',    bar: 'bg-blue-500' },
            emerald: { text: 'text-emerald-600', dim: 'text-emerald-500', bar: 'bg-emerald-500' },
        };
        const _kvTone     = (pct) => KV_TONES[kvColor(pct)] || KV_TONES.emerald;
        // Texte accentué (jauge du header, ligne live du composeur).
        const kvTextClass = (pct) => _kvTone(pct).text;
        // Même teinte en plus discret (snapshot KV d'un message terminé).
        const kvDimClass  = (pct) => _kvTone(pct).dim;
        // Remplissage de la barre de progression.
        const kvBarClass  = (pct) => _kvTone(pct).bar;

        // Persist selection to localStorage.
        // ne jamais persister une chaîne vide. Un reset transitoire
        // de selectedModel à '' (ex. liste de modèles momentanément vide pendant
        // un redémarrage de llama.cpp) ne doit PAS effacer la préférence valide :
        // on garde la dernière valeur non vide pour la restaurer au reload.
        watch(selectedModel, val => {
            try {
                if (val) {
                    localStorage.setItem('selected_model', val);
                    // Connecteur actif → miroir sous la clé scellée au connecteur
                    // (cf. pickConnectorModel) pour que la restauration retrouve
                    // LE modèle du connecteur même si `selected_model` est
                    // réécrite par l'élection d'un modèle local au boot.
                    if (selectedConnector && selectedConnector.value)
                        localStorage.setItem('selected_conn_model', val);
                }
            } catch(_) {}
        });
        // Persiste aussi le connecteur sélectionné (symétrique de selectedModel).
        // Sans ça, un connecteur cloud était oublié au reload → retour silencieux
        // sur le llama local alors que le modèle, lui, restait persisté. On persiste
        // y compris la chaîne vide (= retour explicite au local doit être mémorisé).
        if (selectedConnector) {
            watch(selectedConnector, val => {
                try { localStorage.setItem('selected_connector', val || ''); } catch(_) {}
            });
        }

        // -- Public surface ------------------------------------------
        // _applyModelData is exposed under its underscore name because
        // the SSE module receives it as a direct callback (onModelStatus).
        return {
            modelLoadPct,
            modelLoadStage,
            modelLoadingId,
            loadAvailableModels,
            isModelLoaded,
            toggleLlmModel,
            loadLlmModel,
            unloadLlmModel,
            fetchModelProps,
            fmtPropVal,
            kvColor, kvTextClass, kvDimClass, kvBarClass,
            _applyModelData,
            modelsLoading,
            modelsError,
            toggleModelMenu,
            onModelMenuKeydown,
            // Connecteurs LLM
            pickerConnectors,
            pickerConnModels,
            pickerConnFree,
            pickerConnLoading,
            pickerConnState,
            loadLlmConnectors,
            pickLocalModel,
            pickConnectorModel,
            retryConnModels,
            isConnModelLoaded,
            toggleConnModel,
            selectedModelLabel,
            builtinAllowed,
            canManageModels,
            noEngineAllowed,
        };
    }

    window.setupChatModels = setupChatModels;
})();
