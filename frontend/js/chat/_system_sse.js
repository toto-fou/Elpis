// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/chat/_system_sse.js -- Extracted from app-chat.js
//
//  System-wide Server-Sent Events channel.
//  Handles:
//    • Connection to /api/system-events with auto-reconnect
//      (exponential backoff 1s / 2s / 4s / 8s / 16s, capped at 30s)
//    • visibilitychange listener -- reconnect immediately when the
//      tab comes back from background
//    • Message dispatch:
//        - "restart"       → show system alert + poll /api/health until
//                            server is back, then reload the page
//        - "log"           → push into ctx.liveLogs
//        - "model_status"  → apply directly via the onModelStatus callback
//                            (avoids an extra HTTP fetch)
//        - "model_changed" → legacy fallback → onModelChanged callback
//        - "notification"  → onNotification callback (badge cloche sidebar)
//    • Fallback 60-second model polling (used only if SSE is down)
//
//  Contract
//  --------
//  Loaded BEFORE app-chat.js. Exposes a single factory on window:
//
//      window.setupChatSystemSSE(vue, sharedRefs, ctx, callbacks)
//
//  Dependencies
//  ------------
//  From sharedRefs : user, isLoadingModel
//  From ctx        : systemAlert (ref), liveLogs (ref)
//  From callbacks  : onReconnect, onModelStatus, onModelChanged,
//                    pollModels (used by the 60s fallback)
//
//  The callbacks are captured at setup time but resolved at call
//  time -- the caller can therefore pass closures that reference
//  functions defined LATER in app-chat.js (hoisting + closure).
// ============================================================

(function() {
    'use strict';

    function setupChatSystemSSE(vue, sharedRefs, ctx, callbacks) {
        // isStreaming (audit 2026-08-02, W10) : garde anti-reload pendant un
        // streaming en cours. Défensif si absent (vieux appelants).
        const { user, isLoadingModel, isStreaming = { value: false } } = sharedRefs;
        const {
            onReconnect     = () => {},
            onModelStatus   = () => {},
            onModelChanged  = () => {},
            onNotification  = () => {},
            pollModels      = () => {},
        } = callbacks || {};

        // -- Internal state ------------------------------------------
        let evtSource            = null;
        let _sseReconnectTimer   = null;
        let _sseReconnectAttempt = 0;
        // Le flux a-t-il déjà été ouvert depuis le login ? (toute réouverture
        // = trou possible → onReconnect).
        let _sseEverOpened       = false;
        // (passe 4, F16) — une seule chaîne de sondes /api/health post-restart.
        let _restartProbeActive  = false;
        const _sseMaxDelay       = 30000;
        // BUG FIX (mineur) : compteur monotone pour rendre les ids des
        // logs SSE uniques même quand plusieurs events partagent le même
        // ``ts`` (résolution seconde côté backend). Évite les warnings
        // Vue "Duplicate keys detected" dans l'admin Logs tab.
        let _logSeq = 0;
        let _logBuf = [];
        let _logFlushTimer = null;
        function _flushLogs() {
            _logFlushTimer = null;
            if (!_logBuf.length) return;
            const next = (ctx.liveLogs.value || []).concat(_logBuf);
            _logBuf = [];
            ctx.liveLogs.value = next.length > 800 ? next.slice(-800) : next;
        }

        // B8 — handler nommé pour visibilitychange. Avant, c'était
        // une closure anonyme attachée au document → impossible à retirer
        // dans disconnectSystemEvents. Sur logout/login successifs, des
        // handlers s'accumulaient (chacun garde sa closure → plusieurs
        // appels à connectSystemEvents en chaîne).
        function _onVisibilityChange() {
            if (document.visibilityState === 'visible' && (!evtSource || evtSource.readyState === 2)) {
                _sseReconnectAttempt = 0;  // reset pour une reconnexion immédiate
                if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
                connectSystemEvents();
            }
        }
        let _visibilityBound = false;
        function _bindVisibility() {
            if (_visibilityBound) return;
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', _onVisibilityChange);
                _visibilityBound = true;
            }
        }
        function _unbindVisibility() {
            if (!_visibilityBound) return;
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', _onVisibilityChange);
            }
            _visibilityBound = false;
        }

        function connectSystemEvents() {
            if (evtSource) evtSource.close();
            if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
            // AUDIT 2026-08-02 (S2) — garde d'authentification. Sans elle,
            // après expiration de session la boucle onerror →
            // _scheduleSseReconnect → connectSystemEvents retentait un
            // EventSource (qui prend 401) toutes les 30 s POUR TOUJOURS —
            // invisible de surcroît (la route est exclue des access-logs).
            // Le watcher user (app.js) rappelle connectSystemEvents au
            // prochain login.
            if (!user.value) return;
            // Re-bind du handler visibilitychange : disconnectSystemEvents
            // (appelé au logout) l'unbind, et sans re-bind ici la logique
            // de reconnexion en onglet caché resterait morte après un cycle
            // logout→relogin. _bindVisibility est idempotent.
            _bindVisibility();
            // (passe 3 2026-08-31) — même cycle de vie pour le POLLING de
            // secours des modèles (60 s) : démarré une seule fois à l'init du
            // module et arrêté par disconnectSystemEvents, il n'était JAMAIS
            // relancé après un logout→relogin — si le SSE tombait ensuite, la
            // pastille d'état du modèle restait figée jusqu'au F5.
            // _startModelPolling est idempotent (clearInterval avant set).
            _startModelPolling();

            try {
                evtSource = new EventSource('/api/system-events', { withCredentials: true });
            } catch (e) {
                _scheduleSseReconnect();
                return;
            }

            evtSource.onopen = () => {
                // AUDIT moteur d'événements 2026-09-25 — ``_sseEverOpened`` :
                // quand le SERVEUR ferme proprement le flux (client saturé,
                // évacuation), c'est le navigateur qui se reconnecte seul, sans
                // passer par _scheduleSseReconnect : le compteur restait à 0 et
                // l'état perdu pendant la coupure n'était jamais rattrapé.
                if (_sseReconnectAttempt > 0 || _sseEverOpened) {
                    console.info('[sse] Reconnecté après ' + _sseReconnectAttempt + ' tentative(s)');
                    // Refresh l'état complet après une reconnexion : les events
                    // émis pendant le downtime ont été perdus, on rattrape.
                    if (user.value) {
                        onReconnect();
                    }
                }
                _sseReconnectAttempt = 0;
                _sseEverOpened = true;
            };

            evtSource.onerror = () => {
                // readyState === 2 (CLOSED) signifie que le navigateur a renoncé
                // à se reconnecter. readyState === 0 (CONNECTING) est un état
                // transitoire normal. On ne relance qu'en CLOSED ou après fermeture.
                if (!evtSource || evtSource.readyState === 2) {
                    try { evtSource && evtSource.close(); } catch (_) {}
                    evtSource = null;
                    _scheduleSseReconnect();
                }
            };

            evtSource.onmessage = event => {
                // B10 — try/catch autour de JSON.parse. Avant, un
                // event SSE avec contenu non-JSON (corruption proxy, bug
                // serveur, deconnexion réseau qui truncate le message)
                // levait une exception non catchée → le navigateur arrête
                // de dispatcher les events suivants jusqu'à un onerror.
                // Sur une connexion lente avec packets fragmentés, ça
                // pouvait cacher des events valides.
                let data;
                try {
                    data = JSON.parse(event.data);
                } catch (e) {
                    console.warn('[sse] event SSE non-JSON ignoré:', event.data && event.data.slice ? event.data.slice(0, 80) : event.data);
                    return;
                }
                if (data.type === 'session_expired') {
                    // AUDIT 2026-08-02 (S1/S2) — émis par le serveur quand la
                    // revalidation périodique du flux détecte une session
                    // expirée/révoquée, juste avant de fermer le flux. C'est
                    // LA déconnexion instantanée côté client : purge complète
                    // + écran de login via le handler partagé d'app.js.
                    disconnectSystemEvents();
                    if (ctx.handleSessionExpired) ctx.handleSessionExpired();
                    return;
                }
                if (data.type === 'worker_recycling') {
                    // Recyclage invisible (audit 2026-08-02) — le worker qui
                    // porte CE flux s'arrête, mais les autres servent déjà
                    // (SO_REUSEPORT). AUCUNE bannière, aucun signe visible :
                    // on ferme et on se rebranche après un court délai (le
                    // temps que la socket mourante ferme, pour ne pas
                    // retomber dessus). _sseReconnectAttempt = 1 pour que
                    // onopen déclenche onReconnect() (resync de l'état perdu
                    // pendant la micro-coupure).
                    try { evtSource && evtSource.close(); } catch (_) {}
                    evtSource = null;
                    if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); }
                    _sseReconnectAttempt = 1;
                    _sseReconnectTimer = setTimeout(() => {
                        _sseReconnectTimer = null;
                        connectSystemEvents();
                    }, 750);
                    return;
                }
                if (data.type === 'restart' || data.type === 'app_restarting') {
                    // AUDIT 2026-08-02 (W9) — ``app_restarting`` (publié par
                    // lifecycle.py avec un éventuel force_logout) n'avait
                    // AUCUN handler : personne ne voyait la bannière. Il est
                    // traité comme ``restart``, plus le force_logout.
                    ctx.systemAlert.value = data.message || 'Le serveur redémarre…';
                    if (data.force_logout) {
                        disconnectSystemEvents();
                        if (ctx.handleSessionExpired) ctx.handleSessionExpired();
                    }
                    // AUDIT 2026-08-31 (passe 4, F16) — garde d'unicité : un
                    // redémarrage émet souvent PLUSIEURS events (restart puis
                    // app_restarting, ou une réémission après reconnexion du
                    // flux). Chaque event lançait SA chaîne de sondes
                    // /api/health → sondes concurrentes et double
                    // window.location.reload() possibles. Une seule chaîne
                    // vit à la fois ; le reload la solde.
                    if (_restartProbeActive) return;
                    _restartProbeActive = true;
                    // Attendre que le serveur redémarre, puis recharger.
                    const _tryReconnect = async (attempt) => {
                        // AUDIT 2026-08-02 (W10) — deux gardes :
                        //  • ne JAMAIS recharger pendant un streaming en
                        //    cours (le partiel affiché serait perdu) — on
                        //    re-teste 3 s plus tard ;
                        //  • après 20 échecs, continuer de sonder toutes
                        //    les 5 s au lieu de recharger AVEUGLÉMENT un
                        //    serveur toujours à terre (l'utilisateur
                        //    atterrissait sur une 502 brute du proxy, en
                        //    perdant la bannière « reconnexion… »).
                        try {
                            const r = await fetch('/api/health', { cache: 'no-store' });
                            if (r.ok) {
                                if (isStreaming.value) {
                                    setTimeout(() => _tryReconnect(attempt), 3000);
                                    return;
                                }
                                window.location.reload();
                                return;
                            }
                        } catch(e) {}
                        setTimeout(() => _tryReconnect(attempt + 1),
                                   attempt > 20 ? 5000 : 1000);
                    };
                    // Laisser le serveur se terminer, puis commencer les tentatives
                    setTimeout(() => _tryReconnect(0), 6000);
                } else if (data.type === 'log') {
                    // Legacy SSE log payload: { type, message, level }
                    // Enriched payload (from access_logging bridge):
                    //   { type, message, level, category, service, ts }
                    // Both shapes coexist — older Python loggers (uvicorn
                    // direct emits via SSELogHandler) still send the legacy
                    // shape; the new RequestLoggingMiddleware + log_event()
                    // path adds the structured fields.
                    //
                    // We propagate every available field downstream so the
                    // admin Logs tab can render service / category badges
                    // and apply per-axis filters. Missing fields are simply
                    // omitted — the template's v-if guards handle absence.
                    //
                    // clé Vue unique : avant on faisait
                    // ``id: data.ts || Date.now()+Math.random()``. Plusieurs
                    // events SSE avec le même ``ts`` (résolution seconde
                    // côté serveur) produisaient des keys dupliquées →
                    // warnings Vue "Duplicate keys detected" et rendu
                    // potentiellement sauté. On combine maintenant ts +
                    // un compteur monotone pour garantir l'unicité.
                    const _logId = (typeof data.ts === 'number')
                        ? (data.ts + '-' + (++_logSeq))
                        : (Date.now() + '-' + (++_logSeq));
                    const entry = {
                        id:       _logId,
                        ts:       data.ts || (Date.now() / 1000),
                        message:  data.message,
                        level:    data.level,
                    };
                    if (data.category) entry.category = data.category;
                    if (data.service)  entry.service  = data.service;
                    // AUDIT 2026-09-01 (passe 5, F1) — le tampon partagé est
                    // trié CROISSANT par le loader HTTP (récent en BAS, où
                    // pointe l'auto-scroll). ``unshift`` insérait la nouvelle
                    // ligne en TÊTE (hors champ) et ``pop`` retirait… la plus
                    // récente : console désordonnée ET destructive pendant un
                    // incident. Append en queue, éviction en tête.
                    // Cap à 800 (aligné sur le slice(-800) du loader HTTP)
                    // pour garder le tampon sain. L'historique persistant vit
                    // dans le JSONL — « Recharger » pour remonter plus loin.
                    // (passe d'optimisation 2026-09-26) — par LOTS : un
                    // push + shift réactif par ligne réécrivait les 800 index,
                    // refiltrait la console et forçait un layout, À CHAQUE
                    // ligne d'une rafale (50-200/s). Une seule réaffectation
                    // toutes les 200 ms.
                    _logBuf.push(entry);
                    if (!_logFlushTimer) _logFlushTimer = setTimeout(_flushLogs, 200);
                } else if (data.type === 'model_status' && data.data) {
                    // SSE push -- apply directly without HTTP fetch
                    onModelStatus(data.data);
                } else if (data.type === 'model_changed') {
                    // Legacy fallback
                    onModelChanged();
                } else if (data.type === 'notification') {
                    // Centre de notifications : maj du badge non-lus (+ liste si
                    // le panneau est ouvert). Le filtrage destinataire est fait
                    // côté handler (data.data.user_id vs user courant).
                    onNotification(data.data);
                }
            };
        }

        function _scheduleSseReconnect() {
            if (_sseReconnectTimer) return;
            // Backoff exponentiel capé à 30s : 1s, 2s, 4s, 8s, 16s, 30s, 30s...
            const delay = Math.min(1000 * Math.pow(2, _sseReconnectAttempt), _sseMaxDelay);
            _sseReconnectAttempt += 1;
            console.warn('[sse] Déconnecté -- reconnexion dans ' + (delay / 1000) + 's (tentative ' + _sseReconnectAttempt + ')');
            _sseReconnectTimer = setTimeout(() => {
                _sseReconnectTimer = null;
                if (document.visibilityState === 'visible') {
                    connectSystemEvents();
                } else {
                    // Onglet en arrière-plan : on retentera quand il redevient visible
                    _sseReconnectTimer = null;
                }
            }, delay);
        }

        // Reconnecter aussi quand l'onglet redevient visible (après veille par ex.)
        // B8 — bind via fonction nommée (idempotent + retirable).
        _bindVisibility();

        function disconnectSystemEvents() {
            if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
            if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
            _logBuf = [];
            _sseEverOpened = false;
            if (evtSource) { evtSource.close(); evtSource = null; }
            // B8 — retirer le visibilitychange ET arrêter le polling
            // 60s. Avant, ces deux choses continuaient à tourner après
            // logout : le polling /api/llm/models faisait des 401 toutes
            // les 60s (bruit serveur), et le visibilitychange pouvait
            // re-déclencher connectSystemEvents juste après un disconnect
            // si le user changeait d'onglet (surprise, l'EventSource se
            // re-créait sur un user déconnecté).
            _unbindVisibility();
            _stopModelPolling();
        }

        // Fallback polling (60s) -- only needed if SSE disconnects.
        // The primary update path is via SSE model_status events.
        //
        // avant on exportait ``_modelPollTimer`` (la
        // primitive) directement dans le return. Comme JS copie les
        // primitives par valeur, le caller récupérait ``null`` (la
        // valeur initiale) et le ``_modelPollTimer = setInterval(...)``
        // ultérieur ne le mettait à jour QUE dans le scope local. Au
        // logout, ``ctx._modelPollTimer`` valait toujours null →
        // clearInterval(null) = no-op → le timer continuait de tourner
        // après logout, faisant un poll /api/llm/models toutes les 60s
        // qui retournait 401 silencieusement.
        // Fix : on exporte la FONCTION stopModelPolling (qui ferme sur
        // la variable réelle) au lieu de la valeur.
        let _modelPollTimer = null;
        function _startModelPolling() {
            if (_modelPollTimer) clearInterval(_modelPollTimer);
            _modelPollTimer = setInterval(() => {
                if (user.value && !isLoadingModel.value && document.visibilityState === 'visible') {
                    pollModels();
                }
            }, 60000);
        }
        function _stopModelPolling() {
            if (_modelPollTimer) { clearInterval(_modelPollTimer); _modelPollTimer = null; }
        }
        _startModelPolling();

        // -- Public surface ------------------------------------------
        return {
            connectSystemEvents,
            disconnectSystemEvents,
            stopModelPolling: _stopModelPolling,
            // Conservé pour compat avec app-auth.js si jamais un caller
            // legacy lit la propriété — null permanent, le vrai stop se
            // fait via stopModelPolling().
            _modelPollTimer: null,
        };
    }

    window.setupChatSystemSSE = setupChatSystemSSE;
})();
