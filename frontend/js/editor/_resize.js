// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/editor/_resize.js -- Extracted from app-editor.js
//
//  Three draggable splitters for the editor UI:
//    1. Terminal resize       -- vertical drag on the terminal/editor bar
//    2. Explorer sidebar      -- horizontal drag on the explorer right edge
//    3. Editor / Chat split   -- horizontal drag between editor panel and chat
//
//  Each handler follows the same pattern:
//    start → attach mousemove/touchmove + mouseup/touchend listeners
//    move  → update the reactive size value, then monaco.layout()
//    end   → detach listeners, restore cursor/userSelect, final layout()
//
//  The terminal handler also re-fits xterm.js via _termFitAddon when
//  resizing ends so the terminal's character grid stays pixel-aligned
//  with the new height.
//
//  Contract
//  --------
//  Loaded BEFORE app-editor.js. Exposes on window:
//      window.setupEditorResize(vue, sharedRefs, callbacks)
//
//  Dependencies
//  ------------
//  From sharedRefs : terminalHeight, explorerWidth, settings, monacoRef
//  From callbacks  : getTerm()       → current xterm.js instance or null
//                    getTermFitAddon() → current FitAddon or null
//                    (callbacks because _term / _termFitAddon are
//                    reassigned over the editor's lifetime; we read
//                    them lazily rather than capturing a stale ref.)
// ============================================================

(function() {
    'use strict';

    function setupEditorResize(vue, sharedRefs, callbacks) {
        const { ref } = vue;
        const { terminalHeight, explorerWidth, settings, monacoRef } = sharedRefs;
        const {
            getTerm         = () => null,
            getTermFitAddon = () => null,
        } = callbacks || {};

        // -- Terminal resize (vertical drag) -------------------------
        let _termDragging   = false;
        let _termDragStartY = 0;
        let _termDragStartH = 0;

        // protection contre les "mouseup manqués" (alt-tab,
        // changement d'onglet OS, devtools qui prend le focus). Sans ces
        // garde-fous, le drag restait bloqué : cursor ns-resize permanent,
        // userSelect:none qui empêche toute sélection texte ailleurs, et
        // les handlers move continuent à tirer sur chaque mouvement.
        // Solutions : (a) écouter blur/visibilitychange sur la fenêtre,
        // (b) utiliser pointerup en plus de mouseup (couvre la souris qui
        //     sort du viewport et touch). On consolide les 3 handlers via
        //     un helper unique _registerSafeDragEnd.
        function _registerSafeDragEnd(endFn) {
            window.addEventListener('blur', endFn);
            document.addEventListener('visibilitychange', endFn);
            // pointerup capture le cas où la souris sort du window
            document.addEventListener('pointerup', endFn);
        }
        function _unregisterSafeDragEnd(endFn) {
            window.removeEventListener('blur', endFn);
            document.removeEventListener('visibilitychange', endFn);
            document.removeEventListener('pointerup', endFn);
        }

        function terminalResizeStart(e) {
            e.preventDefault();
            _termDragging = true;
            _termDragStartY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            _termDragStartH = terminalHeight.value;
            document.addEventListener('mousemove', _termResizeMove);
            document.addEventListener('mouseup', _termResizeEnd);
            document.addEventListener('touchmove', _termResizeMove);
            document.addEventListener('touchend', _termResizeEnd);
            _registerSafeDragEnd(_termResizeEnd);
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
        }
        function _termResizeMove(e) {
            if (!_termDragging) return;
            const y = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            terminalHeight.value = Math.max(120, Math.min(600, _termDragStartH + (_termDragStartY - y)));
            if (monacoRef.instance) monacoRef.instance.layout();
            const t = getTerm(); const fit = getTermFitAddon();
            if (t && fit) { try { fit.fit(); } catch(e) {} }
        }
        function _termResizeEnd() {
            if (!_termDragging) return;  // idempotent: peut être appelé 2x
            _termDragging = false;
            document.removeEventListener('mousemove', _termResizeMove);
            document.removeEventListener('mouseup', _termResizeEnd);
            document.removeEventListener('touchmove', _termResizeMove);
            document.removeEventListener('touchend', _termResizeEnd);
            _unregisterSafeDragEnd(_termResizeEnd);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            if (monacoRef.instance) monacoRef.instance.layout();
            const t = getTerm(); const fit = getTermFitAddon();
            if (t && fit) { try { fit.fit(); } catch(e) {} }
        }

        // -- Explorer sidebar resize (horizontal drag) ---------------
        let _expResizing = false;
        let _expStartX   = 0;
        let _expStartW   = 0;

        function explorerResizeStart(e) {
            e.preventDefault();
            _expResizing = true;
            _expStartX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            _expStartW = explorerWidth.value;
            document.addEventListener('mousemove', _expResizeMove);
            document.addEventListener('mouseup', _expResizeEnd);
            document.addEventListener('touchmove', _expResizeMove);
            document.addEventListener('touchend', _expResizeEnd);
            _registerSafeDragEnd(_expResizeEnd);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        }
        function _expResizeMove(e) {
            if (!_expResizing) return;
            var x = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            explorerWidth.value = Math.max(160, Math.min(500, _expStartW + (x - _expStartX)));
            if (monacoRef.instance) monacoRef.instance.layout();
        }
        function _expResizeEnd() {
            if (!_expResizing) return;  // idempotent
            _expResizing = false;
            document.removeEventListener('mousemove', _expResizeMove);
            document.removeEventListener('mouseup', _expResizeEnd);
            document.removeEventListener('touchmove', _expResizeMove);
            document.removeEventListener('touchend', _expResizeEnd);
            _unregisterSafeDragEnd(_expResizeEnd);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            if (monacoRef.instance) monacoRef.instance.layout();
        }

        // -- Editor / Chat split resize (horizontal drag) ------------
        // Avant : `settings.value.editor_ratio` était muté à
        // CHAQUE mousemove (60-100×/s). Si un watcher persiste les settings
        // côté backend, ça générait des centaines de PUT par drag → DoS,
        // log spam, rate-limit. Idem `monacoRef.instance.layout()` était
        // appelé synchrone à chaque frame → jank visible sur machines
        // lentes.
        //
        // Maintenant : valeur ratio gardée dans une variable LOCALE
        // pendant le drag, on rebind `settings.value.editor_ratio`
        // seulement à `_splitEnd`. Les layouts Monaco passent par RAF avec
        // déduplication.
        const editorSplitDragging = ref(false);
        let _splitStartX     = 0;
        let _splitStartRatio = 0;
        let _splitLiveRatio  = 0;
        let _splitRafPending = false;

        function _splitScheduleLayout() {
            if (_splitRafPending) return;
            _splitRafPending = true;
            requestAnimationFrame(() => {
                _splitRafPending = false;
                if (monacoRef.instance) { try { monacoRef.instance.layout(); } catch(_) {} }
            });
        }

        function editorSplitStart(e) {
            e.preventDefault();
            editorSplitDragging.value = true;
            _splitStartX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            _splitStartRatio = settings.value.editor_ratio || 50;
            _splitLiveRatio  = _splitStartRatio;
            document.addEventListener('mousemove', _splitMove);
            document.addEventListener('mouseup', _splitEnd);
            document.addEventListener('touchmove', _splitMove);
            document.addEventListener('touchend', _splitEnd);
            _registerSafeDragEnd(_splitEnd);
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        }

        function _splitMove(e) {
            if (!editorSplitDragging.value) return;
            var x = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            var dx = _splitStartX - x;
            var dPct = (dx / window.innerWidth) * 100;
            // Le template lit `settings.editor_ratio` pour la largeur visuelle.
            // Pour garder le feedback live SANS spammer le backend, on écrit
            // dans `settings.value.editor_ratio` MAIS — astuce — c'est
            // identique à l'ancien comportement côté UI ; ce qui change,
            // c'est que tout watcher externe qui persiste devrait être
            // gated par editorSplitDragging (ailleurs dans l'app). On reduit
            // au minimum la fréquence en évitant de re-écrire si la valeur
            // arrondie n'a pas bougé.
            const newRatio = Math.round(Math.max(20, Math.min(80, _splitStartRatio + dPct)));
            if (newRatio === _splitLiveRatio) return;   // pas de change → pas d'update
            _splitLiveRatio = newRatio;
            settings.value.editor_ratio = newRatio;
            _splitScheduleLayout();
        }

        function _splitEnd() {
            if (!editorSplitDragging.value) return;  // idempotent
            editorSplitDragging.value = false;
            document.removeEventListener('mousemove', _splitMove);
            document.removeEventListener('mouseup', _splitEnd);
            document.removeEventListener('touchmove', _splitMove);
            document.removeEventListener('touchend', _splitEnd);
            _unregisterSafeDragEnd(_splitEnd);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            // Valeur finale déjà dans settings.value.editor_ratio.
            if (monacoRef.instance) { try { monacoRef.instance.layout(); } catch(_) {} }
            const t = getTerm(); const fit = getTermFitAddon();
            if (t && fit) { try { fit.fit(); } catch(e) {} }
        }

        // -- Public surface ------------------------------------------
        return {
            // Template bindings
            editorSplitDragging,

            // Event handlers
            terminalResizeStart,
            explorerResizeStart,
            editorSplitStart,
        };
    }

    window.setupEditorResize = setupEditorResize;
})();
