// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_memory_card.js -- Lignes « effets » du message assistant :
//  écritures en mémoire.
//
//  (2026-09-19) Une écriture mémoire RÉUSSIE reste visible (avant : la
//  ligne disparaissait à la fin de l'appel, seuls les échecs restaient).
//  Même pratique que LibreChat, hermes, letta : libellé au passé,
//  dépliable pour voir ce qui a été écrit, persistant au rechargement
//  (dérivé de msg.toolSteps, que _tool_segments.js reconstruit depuis
//  tool_history).
//
//  Mémoire : le résultat de l'outil ne porte que l'identifiant `op` du
//  journal ; le détail (entrées ajoutées / retirées) est lu À LA DEMANDE
//  (GET /api/memory/ops/{op}) et l'annulation passe par
//  POST /api/memory/ops/{op}/undo. « Mémoire pleine » (over_limit) est
//  ambre, pas rouge : c'est une négociation de budget, pas une panne.
//
//  Tâches (2026-09-21) : plus RIEN dans le fil — la liste vit dans le chip
//  « Tâches » de la barre de prompt (todoList, event ``todo_updated``) ; la
//  ligne « Tâches N/M » par message la dupliquait. Les steps `todowrite`
//  restent exclus des outils affichés.
//
//  Exporte
//  -------
//    effectLinesFor(msg)        -- lignes mémoire, dans l'ordre
//    memorySavesFor(msg)        -- alias (compat, tests)
//    toolStepsForDisplay(steps) -- toolSteps SANS mémoire / tâches / task
//    toggleEffect(line), effectIsOpen(line), effectDetail(line)
//    undoMemoryEffect(line), manageMemory(), effectUiRev (ref : v-memo)
// ============================================================

(function () {
    'use strict';

    // Libellés : en cours / terminé.
    const _RUN_LABELS = {
        add:     'Écriture en mémoire',
        replace: 'Mise à jour de la mémoire',
        remove:  'Retrait de la mémoire',
        rewrite: 'Réorganisation de la mémoire',
    };
    const _DONE_LABELS = {
        add:     'Mémorisé',
        replace: 'Mémoire mise à jour',
        remove:  'Retiré de la mémoire',
        rewrite: 'Mémoire réorganisée',
    };
    // Nuance d'espace : `user` = profil utilisateur ; `memory` = notes projet.
    const _STORE_LABELS = { user: 'profil utilisateur', memory: 'notes projet' };
    const _MAX_TITLE = 140;     // plafond DOM ; le CSS `truncate` fait la coupe visuelle 1 ligne

    // Première ligne du texte, tronquée proprement sur une frontière de mot.
    function _firstLineTruncated(s, n) {
        if (s == null) return '';
        let t = String(s).replace(/\r\n?/g, '\n');
        const nl = t.indexOf('\n');
        if (nl >= 0) t = t.slice(0, nl);
        t = t.trim();
        if (t.length > n) t = t.slice(0, n).replace(/\s+\S*$/, '').trim() + '…';
        return t;
    }

    // Un step est une SAUVEGARDE mémoire si l'outil est `memory` avec une action
    // mutante. On reconnaît d'abord le marqueur posé à la création (_kind),
    // sinon on retombe sur nom+action (robustesse / messages sans marqueur).
    function _isMemorySave(step) {
        if (!step) return false;
        if (step._kind === 'memory') return true;
        if (step.name !== 'memory') return false;
        const a = step.args && String(step.args.action || '').toLowerCase();
        return a === 'add' || a === 'replace' || a === 'remove' || a === 'rewrite';
    }

    function _isTodoStep(step) {
        return !!step && (step._kind === 'todo' || step.name === 'todowrite');
    }

    // Résultat d'outil (string JSON, éventuellement tronquée à 2000 c par le
    // backend — les résultats mémoire sont courts) → objet ou null.
    function _parseResult(step) {
        const r = step && step.result;
        if (r && typeof r === 'object') return r;
        if (typeof r !== 'string' || !r) return null;
        try {
            const o = JSON.parse(r);
            return (o && typeof o === 'object') ? o : null;
        } catch (_) {}
        return null;
    }

    function _memoryLine(step, idx, scope) {
        const args   = step.args || {};
        const action = String(args.action || '').toLowerCase();
        const store  = String(args.store || 'memory').toLowerCase();
        const res    = _parseResult(step);
        const running = step.status === 'running';
        const errCode = res && res.ok === false ? String(res.error || '') : '';
        const full    = !running && errCode === 'over_limit';
        const error   = !running && !full && (!!step._is_error || !!(res && res.ok === false));
        const op      = (res && typeof res.op === 'string') ? res.op : '';
        // Ajout d'un texte déjà présent tel quel : succès sans écriture
        // (op vide dans un résultat au nouveau format).
        const unchanged = !running && !error && !full && action === 'add'
            && !!res && res.ok === true && typeof res.op === 'string' && res.op === '';
        // Phrase affichée : le `title` fourni par l'outil `memory` prime
        // (pensé pour l'affichage) ; sinon repli sur un extrait du contenu
        // ajouté/remplacé (ou la cible pour un remove). `target` a
        // remplacé `old_text` côté outil — on lit les deux.
        const tgt = args.target || args.old_text || '';
        const src = (action === 'remove')
            ? (tgt || args.content || '')
            : (args.content || tgt);
        const displayText = (typeof args.title === 'string' && args.title.trim())
            ? args.title : src;
        let label;
        if (running)        label = _RUN_LABELS[action] || 'Écriture en mémoire';
        else if (full)      label = 'Mémoire pleine';
        else if (error)     label = 'Échec — ' + (_RUN_LABELS[action] || 'Écriture en mémoire');
        else if (unchanged) label = 'Déjà en mémoire';
        else                label = _DONE_LABELS[action] || 'Mémorisé';
        return {
            kind: 'memory',
            // ``op`` est unique partout ; sinon chat + message + rang du step.
            // (``callId`` = call_{itération}_{rang} se RÉPÈTE d'un tour à
            // l'autre : deux messages ouvraient leurs lignes ensemble.)
            key: op ? 'mem:' + op : 'mem:' + scope + ':' + idx,
            action,
            store,
            title:      _firstLineTruncated(displayText, _MAX_TITLE),
            label,
            storeLabel: _STORE_LABELS[store] || '',
            running,
            error,
            full,
            unchanged,
            op,
            content: typeof args.content === 'string' ? args.content : '',
            target:  typeof tgt === 'string' ? tgt : '',
            message: (res && res.ok === false)
                ? String(res.message || res.error || '') : '',
            fix: (res && res.ok === false) ? String(res.fix || '') : '',
        };
    }

    function setupChatMemoryCard(_vue, _sharedRefs, _ctx) {
        const _ref = (_vue && _vue.ref) ? _vue.ref : (v) => ({ value: v });
        const _reactive = (_vue && _vue.reactive) ? _vue.reactive : (o) => o;

        // État d'interface des lignes (ouverture, détail chargé, annulation).
        // Hors des messages (gelés) ; ``effectUiRev`` entre dans le v-memo de
        // la ligne de message pour forcer son re-rendu.
        const effectUiRev = _ref(0);
        const _open = _reactive({});      // key -> bool
        const _detail = _reactive({});    // op  -> { state, data, error, undoing }
        const _bump = () => { effectUiRev.value++; };
        // fetchAuth (app.js) : 401 → écran de session expirée ; null = échec.
        const _fetch = (_ctx && typeof _ctx.fetchAuth === 'function')
            ? (u, o) => _ctx.fetchAuth(u, o || {}, true)
            : (u, o) => fetch(u, Object.assign({ credentials: 'same-origin' }, o || {}));

        function _lines(msg, msgIdx) {
            if (!msg || !Array.isArray(msg.toolSteps)) return [];
            const chat = (_sharedRefs && _sharedRefs.currentChatId && _sharedRefs.currentChatId.value) || '';
            const scope = String(chat) + ':' + (msgIdx == null ? '' : msgIdx);
            const out = [];
            msg.toolSteps.forEach((step, i) => {
                if (_isMemorySave(step)) out.push(_memoryLine(step, i, scope));
            });
            return out;
        }

        /** Lignes mémoire du message, prêtes pour le template.
         *  ``msgIdx`` = rang du message dans le chat (unicité des clés). */
        function effectLinesFor(msg, msgIdx) { return _lines(msg, msgIdx); }

        /** Alias (compat). */
        function memorySavesFor(msg, msgIdx) { return _lines(msg, msgIdx); }

        /** toolSteps SANS les sauvegardes mémoire, la liste de tâches NI les
         *  sous-agents `task` (rendus à part : lignes d'effet / chip Tâches de
         *  la barre de prompt / carte agent persistante). Les steps de
         *  compression sont conservés. */
        function toolStepsForDisplay(steps) {
            if (!Array.isArray(steps)) return [];
            return steps.filter(s => !_isMemorySave(s) && !_isTodoStep(s)
                && !(s && (s._kind === 'task' || s.name === 'task')));
        }

        function effectIsOpen(line) { return !!(line && _open[line.key]); }

        function effectDetail(line) {
            return (line && line.op && _detail[line.op]) || null;
        }

        async function _loadDetail(op) {
            _detail[op] = { state: 'loading', data: null, error: '' };
            _bump();
            try {
                const r = await _fetch('/api/memory/ops/' + encodeURIComponent(op));
                if (!r) {
                    _detail[op] = { state: 'error', data: null, error: 'Détail indisponible (réseau)' };
                } else if (!r.ok) {
                    let msg = 'Détail indisponible';
                    try { const j = await r.json(); if (j && j.detail) msg = String(j.detail); } catch (_) {}
                    _detail[op] = { state: 'error', data: null, error: msg };
                } else {
                    _detail[op] = { state: 'ok', data: await r.json(), error: '' };
                }
            } catch (_) {
                _detail[op] = { state: 'error', data: null, error: 'Détail indisponible (réseau)' };
            }
            _bump();
        }

        function toggleEffect(line) {
            if (!line || line.kind !== 'memory' || line.running) return;
            _open[line.key] = !_open[line.key];
            // Un chargement en ÉCHEC est retenté à la réouverture.
            const d = line.op ? _detail[line.op] : null;
            if (_open[line.key] && line.op && (!d || d.state === 'error')) _loadDetail(line.op);
            _bump();
        }

        async function undoMemoryEffect(line) {
            if (!line || !line.op) return;
            const cur = _detail[line.op] || { state: 'ok', data: null, error: '' };
            if (cur.undoing) return;
            _detail[line.op] = Object.assign({}, cur, { undoing: true, error: '' });
            _bump();
            try {
                const r = await _fetch('/api/memory/ops/' + encodeURIComponent(line.op) + '/undo',
                                       { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                let j = null;
                if (r) { try { j = await r.json(); } catch (_) {} }
                if (r && r.ok && j && j.op) {
                    _detail[line.op] = { state: 'ok', data: j.op, error: '' };
                    if (_ctx && typeof _ctx.onMemoryChanged === 'function') {
                        try { _ctx.onMemoryChanged(); } catch (_) {}
                    }
                } else {
                    // « Annuler » ne disparaît que si le SERVEUR dit que ce n'est
                    // plus possible : un 409 passager (« écriture en cours,
                    // réessayez ») ou une coupure réseau laissent le bouton.
                    const msg = (j && j.detail) ? String(j.detail) : 'Annulation impossible';
                    let data = cur.data;
                    try {
                        const r2 = await _fetch('/api/memory/ops/' + encodeURIComponent(line.op));
                        if (r2 && r2.ok) data = await r2.json();
                    } catch (_) {}
                    _detail[line.op] = { state: 'ok', data, undoing: false,
                                         error: msg.charAt(0).toUpperCase() + msg.slice(1) };
                }
            } catch (_) {
                _detail[line.op] = Object.assign({}, cur, { undoing: false, error: 'Annulation impossible (réseau)' });
            }
            _bump();
        }

        function manageMemory() {
            if (_ctx && typeof _ctx.openSettingsTab === 'function') _ctx.openSettingsTab('memory');
        }

        return {
            effectLinesFor, memorySavesFor, toolStepsForDisplay,
            effectIsOpen, effectDetail, toggleEffect, undoMemoryEffect, manageMemory,
            effectUiRev,
        };
    }

    window.setupChatMemoryCard = setupChatMemoryCard;
})();
