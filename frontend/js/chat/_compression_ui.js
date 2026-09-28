// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_compression_ui.js -- Historique moving-median + tickers
//  de progression pour la compression de contexte.
//
//  Extrait de app-chat.js (lignes 65-185). Comportement identique :
//
//    * 3 fonctions pures (localStorage I/O) :
//        _readCompressionHistory, _recordCompressionDuration,
//        _estimateCompressionMs
//    * 2 fonctions ticker (couplées au state Vue) :
//        _startCompressionTick, _stopCompressionTick
//
//  Dépendances injectées :
//    * sharedRefs.compressionStatus     -- ref(null|object)  lecture seule
//    * sharedRefs.compressionProgress   -- ref(0..100)       écriture
//    * ctx._getStreamMsgs               -- function (hoistée dans app-chat.js)
//    * ctx._patch                       -- function (hoistée dans app-chat.js)
//
//  IMPORTANT : ``_getStreamMsgs`` et ``_patch`` sont des function
//  declarations dans app-chat.js — donc hoistées au top du scope de
//  ``setupChat``. Les passer ici en argument est sûr même si ce
//  sous-module est appelé AVANT la ligne où elles apparaissent dans
//  la source : à l'invocation effective (depuis ``setInterval``), les
//  références pointent bien sur les vraies fonctions.
//
//  Exporte :
//    * _readCompressionHistory()
//    * _recordCompressionDuration(path, ms)
//    * _estimateCompressionMs(path) → ms
//    * _startCompressionTick(msgIdx)
//    * _stopCompressionTick()
// ============================================================

function setupChatCompressionUI(vue, sharedRefs, ctx) {
    const { compressionStatus, compressionProgress } = sharedRefs;
    const { _getStreamMsgs, _patch }                 = ctx;

    // ── Constantes localStorage ───────────────────────────────────
    // localStorage key : elpis_compression_history_v1
    // Structure : { endpoint: [ms,ms,…], external_model: [ms,…], self: [ms,…] }
    // On garde les 10 dernières durées par path, on estime via MÉDIANE
    // (plus robuste aux outliers qu'une moyenne arithmétique : un timeout
    // à 60s ne fait pas exploser l'estimation des prochaines).
    const _COMPR_HIST_KEY = 'elpis_compression_history_v1';
    const _COMPR_HIST_MAX = 10;
    const _COMPR_DEFAULT_MS = { endpoint: 4000, external_model: 8000, self: 10000 };

    function _readCompressionHistory() {
        try {
            const raw = localStorage.getItem(_COMPR_HIST_KEY);
            const obj = raw ? JSON.parse(raw) : {};
            return (obj && typeof obj === 'object') ? obj : {};
        } catch (_) { return {}; }
    }
    function _recordCompressionDuration(path, ms) {
        if (!path || !ms || ms < 100 || ms > 600000) return;  // filtre valeurs absurdes
        try {
            const hist = _readCompressionHistory();
            const arr = (hist[path] || []).concat([Math.round(ms)]).slice(-_COMPR_HIST_MAX);
            hist[path] = arr;
            localStorage.setItem(_COMPR_HIST_KEY, JSON.stringify(hist));
        } catch (_) {}
    }
    function _estimateCompressionMs(path) {
        const hist = _readCompressionHistory()[path] || [];
        if (hist.length === 0) return _COMPR_DEFAULT_MS[path] || _COMPR_DEFAULT_MS.self;
        const sorted = [...hist].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];  // médiane
    }

    // ── Tick timer (~250 ms) ──────────────────────────────────────
    // Met à jour ``compressionProgress`` selon une courbe en deux phases :
    //
    //   Phase 1 (t ≤ est) : cubic ease-out 0 → 70 %
    //     - t=est×0.25 → 30.6 %
    //     - t=est×0.5  → 52.5 %
    //     - t=est×0.75 → 65.6 %
    //     - t=est      → 70 %   ← "plateau" quand on atteint l'estimation
    //
    //   Phase 2 (t > est) : asymptote très lente 70 → 88 %
    //     - t=est×1.5  → 75.2 %
    //     - t=est×2    → 79 %
    //     - t=est×3    → 84 %
    //     - t=est×5    → 88 %   ← cap (jamais 100 % avant compression_done)
    //
    // Le tick patche DEUX cibles :
    //   1. ``compressionProgress`` (ref globale, conservée pour compat interne)
    //   2. le pseudo-toolStep ``_kind='compression'`` injecté dans le message
    //      assistant courant — c'est ce qui fait avancer la barre grise
    //      sous la pill "context_compress" dans le flux de messages.
    //
    // La cible (2) est la source de vérité visuelle désormais. La (1) n'est
    // plus rendue (l'ancien widget amber a été retiré du template) mais
    // reste reactive : certaines conditions côté template ou code externe
    // peuvent encore la lire comme "une compression est en cours ?".
    let _compressionTickTimer = null;
    let _compressionTickCtx   = null;   // { msgIdx: <index du message assistant porteur du step> }

    function _startCompressionTick(msgIdx) {
        _stopCompressionTick();
        compressionProgress.value = 0;
        _compressionTickCtx = { msgIdx: (typeof msgIdx === 'number' ? msgIdx : -1) };
        _compressionTickTimer = setInterval(() => {
            const s = compressionStatus.value;
            if (!s) { _stopCompressionTick(); return; }
            const elapsed = Date.now() - (s.started_at || Date.now());
            const est = s.est_ms || 10000;
            const ratio = elapsed / est;
            let p;
            if (ratio <= 1.0) {
                // Cubic ease-out vers 70 %
                p = 70 * (1 - Math.pow(1 - ratio, 2));
            } else {
                // Asymptote lente de 70 à 88 % passé le temps estimé
                const overrun = ratio - 1.0;
                p = 70 + 18 * (1 - Math.exp(-overrun * 0.6));
            }
            const capped = Math.min(88, Math.round(p * 10) / 10);
            compressionProgress.value = capped;

            // Patche le step compression inline dans le message assistant.
            // On évite de patcher si la valeur n'a pas bougé (pas de re-render
            // Vue inutile toutes les 250 ms sur une grosse liste de steps).
            const mi = _compressionTickCtx && _compressionTickCtx.msgIdx;
            if (typeof mi === 'number' && mi >= 0) {
                try {
                    const _msgs = _getStreamMsgs();
                    const cur = _msgs && _msgs[mi];
                    if (cur && Array.isArray(cur.toolSteps) && cur.toolSteps.length) {
                        for (let i = cur.toolSteps.length - 1; i >= 0; i--) {
                            const st = cur.toolSteps[i];
                            if (st && st._kind === 'compression' && st.status === 'running') {
                                if ((st.progress || 0) === capped) break;   // no-op
                                const newSteps = cur.toolSteps.slice();
                                newSteps[i] = Object.assign({}, st, { progress: capped });
                                _patch(mi, { toolSteps: newSteps });
                                break;
                            }
                        }
                    }
                } catch (_) { /* non-fatal */ }
            }
        }, 250);
    }
    function _stopCompressionTick() {
        if (_compressionTickTimer) {
            clearInterval(_compressionTickTimer);
            _compressionTickTimer = null;
        }
        _compressionTickCtx = null;
    }

    return {
        _readCompressionHistory,
        _recordCompressionDuration,
        _estimateCompressionMs,
        _startCompressionTick,
        _stopCompressionTick,
    };
}

window.setupChatCompressionUI = setupChatCompressionUI;
