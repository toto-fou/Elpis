// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/chat/_tool_segments.js — modèle PUR (sans Vue) des segments texte/outils
 * d'un message assistant.
 *
 * Deux responsabilités :
 *   1. parseToolHistorySegments() : reconstruit, depuis la ``tool_history``
 *      persistée (séquence OpenAI cumulative), la vue entrelacée
 *      { segTexts, toolSteps } d'un message assistant rechargé — narration
 *      de chaque round + steps taggés ``seg``. Sans ça, tout l'affichage
 *      outils disparaissait au reload (seul le texte final restait).
 *   2. Helpers de présentation PARTAGÉS avec les handlers live de
 *      app-chat.js (ragCallLabel / ragResultLabel / resultIsError) : une
 *      seule source de vérité, le live et le reload ne peuvent pas dériver.
 *
 * Isolé du glue Vue pour être testable en Node
 * (tests/frontend/test_tool_segments.js). Exporté en CommonJS ET en global
 * navigateur (window.elpisToolSegments).
 * ==========================================================================*/
(function (root) {
    "use strict";

    /* ── Helpers de présentation (source unique live + reload) ────────── */

    // Label friendly d'un APPEL RAG (affiché à la place du nom brut).
    function ragCallLabel(name, args) {
        if (String(name || '').indexOf('rag_') !== 0) return '';
        if (name === 'rag_search') {
            var q = (args && args.query) || '';
            return 'Recherche : ' + (q.length > 45 ? q.substring(0, 45) + '...' : q);
        }
        if (name === 'rag_get_document')
            return 'Lecture : ' + ((args && args.filename) || '');
        if (name === 'rag_list_collections')
            return 'Exploration des collections';
        return 'Consultation documentaire';
    }

    // Résumé friendly d'un RÉSULTAT RAG ("3 sources trouvées"…).
    function ragResultLabel(name, resultStr) {
        if (String(name || '').indexOf('rag_') !== 0) return '';
        try {
            var parsed = JSON.parse(resultStr || '{}');
            var n = parsed.count || (parsed.results && parsed.results.length) || 0;
            if (name === 'rag_search')
                return n > 0 ? n + ' source' + (n > 1 ? 's' : '') + ' trouvée' + (n > 1 ? 's' : '') : 'Aucun résultat';
            if (name === 'rag_get_document')
                return n > 0 ? n + ' section' + (n > 1 ? 's' : '') + ' chargée' + (n > 1 ? 's' : '') : 'Document vide';
            if (name === 'rag_list_collections') {
                var cols = parsed.collections || [];
                return cols.length + ' collection' + (cols.length > 1 ? 's' : '');
            }
            return '';
        } catch (_) { return 'Résultat reçu'; }
    }

    // Détection d'un résultat d'outil en ERREUR. Deux formes sur le fil :
    //   (A) legacy ``{"error": "<msg>"}`` — une seule clé, pas de ``ok`` ;
    //   (B) enveloppe structurée _toolkit.err() : ``{"ok": false, ...}``.
    function resultIsError(result) {
        if (!result || typeof result !== 'string') return false;
        try {
            var parsed = JSON.parse(result);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
            if ('ok' in parsed && parsed.ok === false) return true;
            return !!('error' in parsed && Object.keys(parsed).length === 1);
        } catch (_) { return false; }
    }

    // Terminal en direct — champs console d'un step execute_shell depuis la
    // chaîne JSON de son RÉSULTAT. Source unique pour le reload
    // (parseToolHistorySegments) et le fill au tool_result live
    // (app-chat.js, quand aucun chunk n'a été streamé). Retourne null pour
    // un résultat non-JSON (erreur executor), un mode background (le
    // wrapper ne sort rien) ou une forme inattendue. ``shellOut`` absent si
    // la sortie est vide (la console affiche quand même la ligne `$ cmd`).
    // Sortie recoupée queue-first à 64 Ko (aligné sur le cap du live).
    function shellFieldsFromResult(resStr) {
        if (!resStr || typeof resStr !== 'string') return null;
        try {
            var pr = JSON.parse(resStr);
            if (!pr || typeof pr !== 'object' || pr.background) return null;
            if (typeof pr.stdout !== 'string') return null;
            var full = pr.stdout + (pr.stderr
                ? (pr.stdout ? '\n' : '') + pr.stderr : '');
            var out = {
                shellRc: (typeof pr.returncode === 'number') ? pr.returncode : null,
                shellMs: pr.duration_ms || 0,
            };
            if (full) out.shellOut = full.length > 65536 ? full.slice(-65536) : full;
            return out;
        } catch (_) { return null; }
    }

    /* ── Parse de tool_history → segments ─────────────────────────────── */

    // _kind d'un step reconstruit : mêmes règles que le live (app-chat.js
    // tool_call) — miroir de _isMemorySave (_memory_card.js) pour `memory`.
    function _kindFor(name, args) {
        if (name === 'task') return 'task';
        if (name === 'todowrite') return 'todo';
        if (name === 'memory') {
            var a = args && String(args.action || '').toLowerCase();
            if (a === 'add' || a === 'replace' || a === 'remove' || a === 'rewrite')
                return 'memory';
        }
        return undefined;
    }

    // Signature d'une entrée d'historique — sert à retrouver la frontière
    // entre le préfixe cumulé (tours précédents) et le tour courant.
    function _entrySig(e) {
        if (!e || typeof e !== 'object') return '';
        if (e.role === 'tool') return 't:' + (e.tool_call_id || '');
        if (e.role === 'assistant' && Array.isArray(e.tool_calls) && e.tool_calls.length) {
            var tc = e.tool_calls[e.tool_calls.length - 1];
            return 'a:' + ((tc && tc.id) || '');
        }
        return (e.role || '') + ':' + String(e.content == null ? '' : e.content).slice(0, 60);
    }

    // Index juste après la DERNIÈRE entrée ``user`` simple (le prompt du
    // tour courant, dans le cas nominal). 0 si aucune entrée user.
    function _afterLastPlainUser(h) {
        for (var i = h.length - 1; i >= 0; i--) {
            if (h[i] && h[i].role === 'user') return i + 1;
        }
        return 0;
    }

    /**
     * Reconstruit la vue entrelacée d'un message assistant depuis sa
     * ``tool_history`` persistée.
     *
     * Deux formats coexistent :
     *   • DELTA (``opts.delta``, messages portant ``tool_history_delta``) :
     *     l'historique ne contient QUE le travail du run de ce message →
     *     ``start = 0``, aucune heuristique de frontière.
     *   • LEGACY (chats antérieurs) : tool_history CUMULATIVE inter-tours
     *     (le backend capturait depuis le premier message agentic) :
     *     l'historique du message N contient ceux des tours précédents. On
     *     dédoublonne via ``prevHistory`` (tool_history de l'assistant
     *     tooled PRÉCÉDENT, threadée par l'appelant) : préfixe exact si la
     *     signature de fin concorde, sinon recherche de signature (une
     *     compression de contexte peut réécrire la tête), sinon repli après
     *     la dernière entrée ``user`` simple.
     *
     * @param {Array}  toolHistory   tool_history du message (format OpenAI)
     * @param {Object} opts          { prevHistory, finalContent, delta }
     * @returns {{segTexts: string[], toolSteps: Object[]}|null}
     *   segTexts[i] = narration du segment i ('' possible pour le premier :
     *   outils avant tout texte) ; steps taggés ``seg`` (index de segment).
     *   null si rien d'affichable.
     */
    function parseToolHistorySegments(toolHistory, opts) {
        opts = opts || {};
        if (!Array.isArray(toolHistory) || !toolHistory.length) return null;
        var prev = Array.isArray(opts.prevHistory) && opts.prevHistory.length
            ? opts.prevHistory : null;
        var finalContent = typeof opts.finalContent === 'string' ? opts.finalContent : '';

        // ── 1. Frontière du tour courant ───────────────────────────────
        // Format DELTA : tout l'historique appartient à ce message, et les
        // heuristiques legacy pourraient MAL couper (les ids call_{iter}_{idx}
        // se répètent d'un run à l'autre → fausse frontière par signature).
        var start = 0;
        if (!opts.delta) {
            if (prev && toolHistory.length > prev.length) {
                var wantSig = _entrySig(prev[prev.length - 1]);
                if (_entrySig(toolHistory[prev.length - 1]) === wantSig) {
                    start = prev.length;
                } else {
                    var found = -1;
                    for (var j = toolHistory.length - 1; j >= 0; j--) {
                        if (_entrySig(toolHistory[j]) === wantSig) { found = j; break; }
                    }
                    start = (found >= 0) ? found + 1 : _afterLastPlainUser(toolHistory);
                }
            } else if (prev) {
                // Historique plus court que le préfixe attendu (tête réécrite
                // par compression) → repli sur le dernier prompt user.
                start = _afterLastPlainUser(toolHistory);
            } else {
                // Pas de tour tooled antérieur : s'il y a des entrées user, le
                // tour courant commence après la dernière (vieux chats où seule
                // la fin porte l'historique cumulé) ; sinon tout est à nous.
                // (Un delta NON marqué — marqueur perdu — dégrade ici en
                // start=0 : les deltas ne contiennent pas d'entrées user.)
                start = _afterLastPlainUser(toolHistory);
            }
        }

        // ── 2/3. Itération : rounds → segments + steps ─────────────────
        var segTexts = [];
        var toolSteps = [];
        var byId = Object.create(null);
        var sawToolRound = false;

        for (var i = start; i < toolHistory.length; i++) {
            var e = toolHistory[i];
            if (!e || typeof e !== 'object') continue;

            if (e.role === 'user') continue; // prompt / nudge mid-turn : jamais affiché

            if (e.role === 'tool') {
                var st = e.tool_call_id ? byId[e.tool_call_id] : null;
                if (st) {
                    var resStr = (typeof e.content === 'string')
                        ? e.content
                        : (e.content == null ? '' : JSON.stringify(e.content));
                    // Détection d'erreur sur la chaîne COMPLÈTE (la troncature
                    // casserait le JSON.parse), puis cap aligné sur le fil
                    // live (tool_result ≤ 2000 chars).
                    st._is_error = resultIsError(resStr);
                    st.result = resStr.slice(0, 2000);
                    if (String(st.name).indexOf('rag_') === 0)
                        st.ragResultLabel = ragResultLabel(st.name, resStr);
                    // Terminal en direct : reconstruit l'entrée console d'un
                    // execute_shell depuis le résultat persisté (chaîne
                    // COMPLÈTE, avant le cap 2000 du détail). Même helper que
                    // le fill au tool_result live (app-chat.js).
                    if (st.name === 'execute_shell') {
                        var shf = shellFieldsFromResult(resStr);
                        if (shf) {
                            st.shellDone = true;
                            st.shellRc = shf.shellRc;
                            st.shellMs = shf.shellMs;
                            if (shf.shellOut != null) st.shellOut = shf.shellOut;
                        }
                    }
                }
                continue;
            }

            if (e.role !== 'assistant') continue;

            var calls = Array.isArray(e.tool_calls) && e.tool_calls.length ? e.tool_calls : null;
            var txt = (typeof e.content === 'string') ? e.content.trim() : '';

            if (!calls) {
                // Assistant SANS tool_calls : avant le premier round c'est la
                // réponse finale d'un tour précédent (skip) ; après, c'est un
                // texte intermédiaire (ex : tour tronqué en plein tool-call)
                // → segment texte-seul.
                if (txt && sawToolRound) segTexts.push(txt);
                continue;
            }

            sawToolRound = true;
            // Narration du round → nouveau segment ; round muet → les calls
            // rejoignent le segment courant (même comportement que le live).
            if (txt) segTexts.push(txt);
            else if (!segTexts.length) segTexts.push('');
            var seg = segTexts.length - 1;

            for (var c = 0; c < calls.length; c++) {
                var fn = (calls[c] && calls[c].function) || {};
                var name = fn.name || '?';
                var args = null;
                if (typeof fn.arguments === 'string' && fn.arguments) {
                    try { args = JSON.parse(fn.arguments); } catch (_) { args = null; }
                } else if (fn.arguments && typeof fn.arguments === 'object') {
                    args = fn.arguments;
                }
                var step = {
                    name: name, args: args, result: null,
                    // 'done' même sans résultat apparié (un 'running' figé
                    // afficherait un spinner éternel sur un message rechargé).
                    status: 'done', seg: seg,
                    thinking: '', thinkingOpen: false,
                    isRag: false,
                    ragLabel: ragCallLabel(name, args),
                };
                var kind = _kindFor(name, args);
                if (kind) step._kind = kind;
                toolSteps.push(step);
                if (calls[c] && calls[c].id) byId[calls[c].id] = step;
            }
        }

        // ── 5. Garde anti-doublon : un segment texte-seul FINAL identique
        // au début de la réponse finale (msg.content) serait affiché deux
        // fois — la tool_history d'un tour tronqué-puis-continué peut se
        // terminer par le texte que le continue a promu en réponse. ──────
        if (segTexts.length) {
            var lastIdx = segTexts.length - 1;
            var lastTxt = segTexts[lastIdx];
            var hasSteps = false;
            for (var k = 0; k < toolSteps.length; k++) {
                if (toolSteps[k].seg === lastIdx) { hasSteps = true; break; }
            }
            if (lastTxt && !hasSteps) {
                var fc = finalContent.trim();
                if (fc && (fc === lastTxt || fc.indexOf(lastTxt) === 0)) segTexts.pop();
            }
        }

        if (!toolSteps.length) return null;
        return { segTexts: segTexts, toolSteps: toolSteps };
    }

    var api = {
        parseToolHistorySegments: parseToolHistorySegments,
        ragCallLabel: ragCallLabel,
        ragResultLabel: ragResultLabel,
        resultIsError: resultIsError,
        shellFieldsFromResult: shellFieldsFromResult,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;                     // Node (tests)
    }
    if (root) root.elpisToolSegments = api;       // Navigateur
})(typeof window !== 'undefined' ? window : this);
