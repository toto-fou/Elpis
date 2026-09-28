// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/chat/_virtual_scroll.js -- Extracted from app-chat.js
//
//  Windowed rendering for long conversations.
//
//  Only activates when the chat has more than VS_THRESHOLD messages.
//  Renders only the messages inside the viewport plus a buffer above
//  and below. Two spacer <div>s occupy the space of hidden messages
//  so the scrollbar behaves naturally.
//
//  Contract
//  --------
//  Loaded BEFORE app-chat.js. Exposes a single factory on window:
//
//      window.setupChatVirtualScroll(vue, sharedRefs)
//
//  Returns an object whose properties are merged into the chat
//  mixin by app-chat.js.
//
//  Dependencies
//  ------------
//  From sharedRefs : messages, chatContainer, isUserScrolling
//  From vue        : ref, computed, watch, nextTick
//
//  Internals (underscore-prefixed in the return): _vsReset and
//  _vsEnsureTail are kept in the public surface because the main
//  chat file still calls them directly across boundaries (on chat
//  load, on scroll-to-bottom, on stream-tick). Everything else
//  stays private to this module.
// ============================================================

(function() {
    'use strict';

    function setupChatVirtualScroll(vue, sharedRefs, ctx) {
        const { ref, computed, watch, nextTick } = vue;
        // onScopeDispose : cleanup au teardown du setup() parent. Fallback
        // muet si l'instance Vue ne l'expose pas (ne casse rien).
        const onScopeDispose = vue.onScopeDispose || function(_) {};
        const { messages, chatContainer, isUserScrolling } = sharedRefs;
        ctx = ctx || {};   // ctx._lockAutoScroll lu paresseusement (cf. scrollToMessage)

        // -- Tuning constants ----------------------------------------
        const VS_THRESHOLD      = 30;   // min messages before enabling
        const VS_BUFFER         = 10;   // extra messages above & below viewport
        const VS_DEFAULT_HEIGHT = 180;  // estimated px per unrendered message
        const VS_GAP            = 32;   // space-y-8 = 2rem = 32px

        // -- Internal state ------------------------------------------
        const _heightCache = [];        // measured height per message index
        const vsTopPad     = ref(0);
        const vsBotPad     = ref(0);
        // _vsStart / _vsEnd DOIVENT être réactifs : ils sont
        // lus par le ``computed`` ``visibleMessages``. En simples ``let``
        // non réactifs, mettre à jour la fenêtre au scroll (``_vsRecalc``)
        // ne déclenchait AUCUNE recomputation du computed (sa seule
        // dépendance trackée était ``messages``, inchangé pendant un
        // scroll) → la fenêtre restait figée sur la queue et l'historique
        // d'une conversation > VS_THRESHOLD devenait inatteignable. En
        // ``ref``, toute mutation de la fenêtre invalide proprement
        // ``visibleMessages``.
        const _vsStart     = ref(0);
        const _vsEnd       = ref(0);
        let   _vsRafId     = null;
        let   _vsJumpSeq   = 0;   // invalide les chaînes de correction de jump obsolètes

        function _vsGetH(i) { return (_heightCache[i] || VS_DEFAULT_HEIGHT) + VS_GAP; }

        function _vsSumH(from, to) {
            let h = 0;
            for (let i = from; i < to; i++) h += _vsGetH(i);
            return h;
        }

        /** Measure rendered message DOM nodes and cache their heights. */
        function _vsMeasure() {
            if (!chatContainer.value) return;
            const els = chatContainer.value.querySelectorAll('[data-vs-idx]');
            els.forEach(function(el) {
                const i = parseInt(el.dataset.vsIdx, 10);
                if (!isNaN(i)) _heightCache[i] = el.offsetHeight;
            });
        }

        /** Recalculate which messages are inside the viewport + buffer. */
        function _vsRecalc() {
            const total = messages.value.length;
            if (total <= VS_THRESHOLD || !chatContainer.value) {
                _vsStart.value = 0;
                _vsEnd.value   = total;
                vsTopPad.value = 0;
                vsBotPad.value = 0;
                return;
            }

            const el  = chatContainer.value;
            const st  = el.scrollTop;
            const vh  = el.clientHeight;

            // Find first message overlapping the viewport
            let acc = 0, first = 0;
            for (let i = 0; i < total; i++) {
                const h = _vsGetH(i);
                if (acc + h > st) { first = i; break; }
                acc += h;
                if (i === total - 1) first = total;
            }

            // si scrollTop dépasse la somme totale (suppression de
            // messages, redimensionnement, etc.) first vaut `total` et la
            // fenêtre devient vide → blank screen. On clamp pour toujours
            // garder au moins le dernier message dans la fenêtre.
            if (first >= total) first = Math.max(0, total - 1);

            // Find last message overlapping the viewport
            let last = first;
            let viewAcc = acc;
            for (let i = first; i < total; i++) {
                last = i;
                viewAcc += _vsGetH(i);
                if (viewAcc >= st + vh) break;
            }

            const start = Math.max(0, first - VS_BUFFER);
            const end   = Math.min(total, last + VS_BUFFER + 1);

            _vsStart.value = start;
            _vsEnd.value   = end;
            vsTopPad.value = _vsSumH(0, start);
            vsBotPad.value = _vsSumH(end, total);
        }

        /** Called from app.js scroll handler. */
        function onChatScroll() {
            if (_vsRafId) return;
            _vsRafId = requestAnimationFrame(function() {
                _vsRafId = null;
                _vsMeasure();
                _vsRecalc();
            });
        }

        /** Computed list of visible messages for the template. */
        const visibleMessages = computed(function() {
            const msgs  = messages.value;
            const total = msgs.length;
            if (total <= VS_THRESHOLD) {
                return msgs.map(function(m, i) { return { msg: m, idx: i }; });
            }
            const s = _vsStart.value;
            const e = Math.min(_vsEnd.value, total);
            const out = [];
            for (let i = s; i < e; i++) {
                out.push({ msg: msgs[i], idx: i });
            }
            return out;
        });

        /** Index of the last assistant message -- used to scope
         *  the thinking/réflexion block to only the latest response. */
        const lastAssistantIdx = computed(function() {
            const msgs = messages.value;
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant') return i;
            }
            return -1;
        });

        /** Reset caches when switching chat. */
        function _vsReset() {
            // Annuler un RAF en vol : sinon un onChatScroll planifié juste avant
            // le switch de chat s'exécute APRÈS _vsReset/_vsInitTail et mesure
            // l'ancien DOM → écrase la fenêtre fraîchement initialisée.
            if (_vsRafId) { cancelAnimationFrame(_vsRafId); _vsRafId = null; }
            _vsJumpSeq++;   // tue une chaîne de scrollToMessage en vol (changement de chat)
            _heightCache.length = 0;
            _vsStart.value = 0;
            _vsEnd.value   = 0;
            vsTopPad.value = 0;
            vsBotPad.value = 0;
        }

        /** Initialise SYNCHRONEMENT la fenêtre de rendu sur les N derniers
         *  messages d'un total donné, SANS attendre nextTick. À appeler
         *  juste APRÈS ``messages.value = [...]`` pour éviter le gap où
         *  ``visibleMessages`` renverrait [] (s=0, e=0) entre l'assign et
         *  le premier watch/nextTick qui positionne la fenêtre.
         *
         *  Sans ça, sur un chat de 500 messages :
         *    1. messages.value = [500 items]       → render vide
         *    2. computed visibleMessages() = []    → DOM vide
         *    3. nextTick : watch fire → _vsEnsureTail → DOM rempli
         *  Ce délai visuel (1–2 frames) + Vue qui doit faire 2 passes
         *  de reconciliation expliquent le "flash puis refresh nécessaire"
         *  sur les longues conversations. Avec _vsInitTail appelé avant
         *  le render, la 1re passe affiche déjà la bonne fenêtre. */
        function _vsInitTail(total) {
            if (total <= VS_THRESHOLD) {
                _vsStart.value = 0;
                _vsEnd.value   = total;
                vsTopPad.value = 0;
                vsBotPad.value = 0;
                return;
            }
            // Fenêtre initiale : les 2× BUFFER + quelques derniers messages.
            // Avec BUFFER=10 on affiche ~25 messages, largement assez pour
            // couvrir le viewport initial sur la plupart des écrans.
            const start = Math.max(0, total - (VS_BUFFER * 2 + 5));
            _vsStart.value = start;
            _vsEnd.value   = total;
            vsTopPad.value = _vsSumH(0, start);
            vsBotPad.value = 0;
        }

        /** Ensure the tail of the conversation is in the visible window
         *  (used during streaming and scrollToBottom). */
        function _vsEnsureTail() {
            const total = messages.value.length;
            if (total <= VS_THRESHOLD) return;
            const end   = total;
            const start = Math.max(0, end - VS_BUFFER * 3);
            // Garde rapide (perf vague 1) : appelé à CHAQUE flush de stream
            // (~25×/s). Quand la fenêtre est déjà en queue — le cas nominal
            // pendant tout le streaming — recalculer _vsSumH (somme O(n) des
            // hauteurs) et réassigner les refs ne sert à rien.
            if (_vsStart.value === start && _vsEnd.value === end) return;
            _vsStart.value = start;
            _vsEnd.value   = end;
            vsTopPad.value = _vsSumH(0, start);
            vsBotPad.value = 0;
        }

        // ── scrollToMessage(idx) ────────────────────────────
        // Saut fiable vers un message dans une conversation à virtual scroll
        // (outline, sauter à un résultat de recherche). Pièges traités :
        //  - geler l'auto-scroll AVANT de poser la fenêtre (sinon le watch de
        //    streaming la ramène en queue) ;
        //  - correction par getBoundingClientRect (delta exact sur le seul
        //    chatContainer) plutôt que scrollIntoView (qui scrolle les
        //    ancêtres et étale sur plusieurs frames) ;
        //  - 3 passes pour absorber highlight.js/KaTeX puis charts/mermaid à
        //    hauteur différée ; _vsJumpSeq invalide une chaîne obsolète.
        function _vsCorrectTo(idx, opts, seq, flash) {
            const cont = chatContainer.value;
            if (!cont || idx >= messages.value.length) return;
            const el = cont.querySelector('[data-vs-idx="' + idx + '"]');
            if (!el) return;   // fenêtre écrasée entre-temps → passe suivante réessaie
            const offset = (opts && opts.offset != null) ? opts.offset : 16;
            const delta = el.getBoundingClientRect().top - cont.getBoundingClientRect().top - offset;
            if (Math.abs(delta) > 2) {
                if (ctx._lockAutoScroll) ctx._lockAutoScroll();   // scroll programmatique
                cont.scrollTop += delta;
            }
            if (flash && (!opts || opts.highlight !== false) && seq === _vsJumpSeq) {
                el.classList.add('vs-jump-flash');
                setTimeout(function() { el.classList.remove('vs-jump-flash'); }, 1200);
            }
        }

        function scrollToMessage(idx, opts) {
            opts = opts || {};
            const total = messages.value.length;
            const cont = chatContainer.value;
            if (!cont || total === 0) return;
            idx = Math.max(0, Math.min(Math.floor(idx), total - 1));
            const seq = ++_vsJumpSeq;

            // (a) Dernier message → logique tail existante.
            if (idx === total - 1) {
                isUserScrolling.value = false;
                _vsEnsureTail();
                nextTick(function() {
                    if (ctx._lockAutoScroll) ctx._lockAutoScroll();
                    if (chatContainer.value) chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
                });
                return;
            }

            // (b) Geler l'auto-scroll AVANT de toucher la fenêtre.
            isUserScrolling.value = true;
            if (ctx._lockAutoScroll) ctx._lockAutoScroll();
            // (c) Annuler le recalc RAF en vol (il a capturé l'ancien scrollTop).
            if (_vsRafId) { cancelAnimationFrame(_vsRafId); _vsRafId = null; }
            // Couper l'ancrage de scroll du navigateur : sans ça, changer la
            // hauteur du contenu au-dessus du viewport (vsTopPad) fait
            // auto-ajuster scrollTop et se bat avec notre correction.
            // Et forcer scroll-behavior:auto : le conteneur a `scroll-smooth`
            // (CSS), donc `scrollTop += delta` ANIME — chaque passe de
            // correction se battait avec l'animation de la précédente
            // (convergence lente). En auto, chaque correction est instantanée.
            const _prevAnchor = cont.style.overflowAnchor;
            const _prevBehavior = cont.style.scrollBehavior;
            cont.style.overflowAnchor = 'none';
            cont.style.scrollBehavior = 'auto';

            // (d) Poser la fenêtre autour de idx (si mode virtuel et hors fenêtre).
            // PAS d'estimation de scrollTop ici : la poser sur l'ANCIEN DOM (la
            // queue) est inutile et déclenche l'ancrage. On positionne en
            // absolu APRÈS le render, quand le message cible est mesurable.
            if (total > VS_THRESHOLD) {
                const inWindow = idx >= _vsStart.value + 2 && idx < _vsEnd.value - 2;
                if (!inWindow) {
                    const start = Math.max(0, idx - VS_BUFFER);
                    const end   = Math.min(total, idx + VS_BUFFER + 1);
                    _vsStart.value = start;
                    _vsEnd.value   = end;
                    vsTopPad.value = _vsSumH(0, start);
                    vsBotPad.value = _vsSumH(end, total);
                }
            }

            // (e) Attendre le render, mesurer, corriger en absolu (3 passes pour
            // absorber highlight.js/KaTeX puis charts/mermaid à hauteur différée).
            // On NE rappelle PAS onChatScroll() : il re-dériverait la fenêtre
            // depuis un scrollTop transitoire et la ferait dériver vers la queue.
            nextTick(function() {
                if (seq !== _vsJumpSeq) return;
                _vsMeasure();
                _vsCorrectTo(idx, opts, seq, false);
                requestAnimationFrame(function() {
                    if (seq !== _vsJumpSeq) return;
                    _vsMeasure();
                    _vsCorrectTo(idx, opts, seq, false);
                    setTimeout(function() {
                        if (seq === _vsJumpSeq) {
                            _vsMeasure();
                            _vsCorrectTo(idx, opts, seq, true);   // flash sur la passe finale
                        }
                        cont.style.overflowAnchor = _prevAnchor || '';   // restaurer
                        cont.style.scrollBehavior = _prevBehavior || '';
                    }, 250);
                });
            });
        }

        // Re-measure after every messages change and recalc
        watch(function() { return messages.value.length; }, function() {
            nextTick(function() {
                _vsMeasure();
                if (!isUserScrolling.value) {
                    _vsEnsureTail();
                } else {
                    _vsRecalc();
                }
            });
        });

        // Re-calculer la fenêtre quand le CONTENEUR change de taille sans
        // scroll ni nouveau message (rotation mobile, repli sidebar, ouverture
        // d'un panneau latéral, plein écran éditeur). Sans ça, vsTopPad/vsBotPad
        // restaient calculés pour l'ancienne hauteur → messages manquants.
        // On observe le conteneur réel et on délègue à onChatScroll (qui
        // throttle déjà via RAF). Le watch (re)branche l'observer quand le ref
        // pointe vers un nouveau noeud (changement de vue).
        if (typeof ResizeObserver !== 'undefined') {
            let _vsRO = null;
            watch(chatContainer, function(el) {
                if (_vsRO) { _vsRO.disconnect(); _vsRO = null; }
                if (el) {
                    _vsRO = new ResizeObserver(function() { onChatScroll(); });
                    _vsRO.observe(el);
                }
            }, { immediate: true });
            // sans onScopeDispose, l'observer restait actif quand le
            // composant parent était démonté (logout, changement de view) et
            // retenait le DOM en vie. Le watch ne se déclenche pas sur
            // l'unmount (le ref n'est pas reset à null).
            onScopeDispose(function() {
                if (_vsRO) { _vsRO.disconnect(); _vsRO = null; }
                if (_vsRafId) { cancelAnimationFrame(_vsRafId); _vsRafId = null; }
            });
        }

        // -- Public surface ------------------------------------------
        // Note: _vsReset and _vsEnsureTail are exposed (despite the
        // underscore) because the chat switching / streaming pipeline
        // in app-chat.js still calls them directly.
        return {
            // Template bindings
            visibleMessages,
            vsTopPad,
            vsBotPad,
            lastAssistantIdx,

            // Event handlers
            onChatScroll,
            scrollToMessage,

            // Cross-module internals
            _vsReset,
            _vsEnsureTail,
            _vsInitTail,
        };
    }

    window.setupChatVirtualScroll = setupChatVirtualScroll;
})();
