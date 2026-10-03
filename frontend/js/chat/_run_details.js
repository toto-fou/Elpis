// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_run_details.js -- « Détails » d'une réponse : chronologie de
//  l'exécution qui l'a produite (L5.3, 2026-09-30).
//
//  Un message assistant porte ses exécutions (``run_ids`` : plusieurs après
//  un « Continuer »). La modale lit GET /api/runs/{id}/timeline : agrégats
//  (jetons, temps LLM, appels d'outils, fichiers, pics de la sandbox), puis
//  les événements horodatés (tours LLM, appels d'outils avec argument
//  principal et extrait du résultat, sous-agents et compactions, dépliables).
//  Export JSON (secrets masqués côté serveur) : GET …/export.
//  Console (L5.7) : ``showRunDetails(id, ids, {admin: true})`` lit les routes
//  /api/admin/runs/… (exécution de n'importe quel compte) ; le mode suit la
//  navigation dans la modale (onglets, sous-exécutions).
//
//  Exporte
//  -------
//    runDetails (ref) -- état de la modale, ou null
//    openRunDetails(msg), closeRunDetails(), showRunDetails(runId, ids, opts)
//    runEventLabel(ev), runEventMeta(ev), runDuration(ms), runExportHref(id)
// ============================================================
(function () {
    'use strict';

    function setupRunDetails(_vue, _ctx) {
        const _ref = (_vue && _vue.ref) ? _vue.ref : (v) => ({ value: v });
        const runDetails = _ref(null);
        const _fetch = (_ctx && typeof _ctx.fetchAuth === 'function')
            ? _ctx.fetchAuth : (u, o) => fetch(u, o);

        const _base = (admin) => admin ? '/api/admin/runs/' : '/api/runs/';

        async function showRunDetails(runId, ids, opts) {
            const liste = Array.isArray(ids) && ids.length ? ids : [runId];
            const admin = (opts && typeof opts.admin === 'boolean') ? opts.admin
                : !!(runDetails.value && runDetails.value.admin);
            runDetails.value = { runId, ids: liste, admin, loading: true, error: '', data: null, open: {} };
            try {
                const r = await _fetch(_base(admin) + encodeURIComponent(runId) + '/timeline', {}, true);
                // Modale fermée ou autre onglet demandé entre-temps : cette
                // réponse n'a plus le droit d'écrire (succès comme échec).
                if (!runDetails.value || runDetails.value.runId !== runId) return;
                if (!r || !r.ok) {
                    runDetails.value = Object.assign({}, runDetails.value, { loading: false,
                        error: (r && r.status === 404) ? 'Détails indisponibles (exécution purgée ou antérieure à cette version).'
                                                       : 'Détails indisponibles.' });
                    return;
                }
                const data = await r.json();
                if (runDetails.value && runDetails.value.runId === runId) {
                    runDetails.value = Object.assign({}, runDetails.value, { loading: false, data });
                }
            } catch (_) {
                if (!runDetails.value || runDetails.value.runId !== runId) return;
                runDetails.value = Object.assign({}, runDetails.value, { loading: false,
                    error: 'Détails indisponibles (réseau).' });
            }
        }

        function openRunDetails(msg) {
            const ids = (msg && Array.isArray(msg.run_ids)) ? msg.run_ids.filter(Boolean) : [];
            if (!ids.length) return;
            showRunDetails(ids[ids.length - 1], ids, { admin: false });
        }

        function closeRunDetails() { runDetails.value = null; }

        function toggleRunEvent(i) {
            const d = runDetails.value;
            if (!d) return;
            const open = Object.assign({}, d.open);
            open[i] = !open[i];
            runDetails.value = Object.assign({}, d, { open });
        }

        function runDuration(ms) {
            const n = Math.round(Number(ms) || 0);
            if (n < 1000) return n + ' ms';
            if (n < 60000) return (n / 1000).toFixed(1).replace('.', ',') + ' s';
            return Math.floor(n / 60000) + ' min ' + Math.round((n % 60000) / 1000) + ' s';
        }

        const _KINDS = { chat: 'Tour de chat', routine: 'Routine', subagent: 'Sous-agent',
                         compaction: 'Compaction', image: 'Images' };

        function runEventLabel(ev) {
            if (!ev) return '';
            if (ev.type === 'llm') return 'Modèle' + (ev.model ? ' · ' + ev.model : '');
            if (ev.type === 'tool') return ev.tool_name || 'Outil';
            if (ev.type === 'child') return _KINDS[ev.kind] || 'Exécution';
            return '';
        }

        // Entrée et sortie d'une ligne de tokens (exécution ou tour du modèle),
        // découpées comme partout (utils.js : tokenBreakdown) :
        // « 12,3 k (cache 96 %) » et « 1,1 k (réflexion 820) ».
        function _parts(r) {
            return window.elpisTokenBreakdown(r && r.input_tokens, r && r.output_tokens,
                                              r && r.cache_read_tokens, r && r.thinking_tokens,
                                              r && r.tool_tokens);
        }

        function runInput(r) {
            const b = _parts(r);
            return window.elpisFmtTokens(b.input) + (b.cache ? ' (cache ' + b.cache_pct + ' %)' : '');
        }

        function runOutput(r) {
            const b = _parts(r);
            return window.elpisFmtTokens(b.output)
                + (b.thinking ? ' (réflexion ' + window.elpisFmtTokens(b.thinking) + ')' : '');
        }

        // Comptes exacts, pour l'infobulle des tuiles.
        function runTokensTitle(r) {
            const b = _parts(r), n = (x) => x.toLocaleString('fr-FR');
            let t = 'Entrée ' + n(b.input) + ' : cache ' + n(b.cache) + ' · utile ' + n(b.input_new)
                + (b.tools ? ' · outils ≈ ' + n(b.tools) : '')
                + '\nSortie ' + n(b.output) + ' : réflexion ' + n(b.thinking) + ' · réponse ' + n(b.response);
            if (r && r.cache_creation_tokens) t += '\nMis en cache ' + n(r.cache_creation_tokens);
            return t;
        }

        function runEventMeta(ev) {
            if (!ev) return '';
            if (ev.type === 'llm') return runInput(ev) + ' → ' + runOutput(ev);
            if (ev.type === 'tool') {
                const parts = [];
                if (ev.exit_code !== null && ev.exit_code !== undefined) parts.push('code ' + ev.exit_code);
                if (ev.argument) parts.push(ev.argument);
                return parts.join(' · ');
            }
            if (ev.type === 'child') return ev.status || '';
            return '';
        }

        function runEventState(ev) {
            const s = String((ev && ev.status) || 'ok');
            if (s === 'ok' || s === 'success') return 'ok';
            if (s === 'cancelled' || s === 'aborted') return 'stop';
            return 'error';
        }

        function runClock(ts) {
            try { return new Date(Number(ts) * 1000).toLocaleTimeString('fr-FR'); } catch (_) { return ''; }
        }

        function runExportHref(id) {
            return _base(!!(runDetails.value && runDetails.value.admin)) + encodeURIComponent(id) + '/export';
        }

        return { runDetails, openRunDetails, closeRunDetails, showRunDetails, toggleRunEvent,
                 runDuration, runEventLabel, runEventMeta, runEventState, runClock, runExportHref,
                 runInput, runOutput, runTokensTitle };
    }

    window.setupRunDetails = setupRunDetails;
})();
