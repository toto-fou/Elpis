// SPDX-License-Identifier: MIT
// ============================================================================
//  frontend/js/settings/connexions.js — Paramètres › Connexions (EXT.1)
// ============================================================================
//  Jetons personnels du compte pour brancher ses outils Elpis sur un client
//  externe : clients MCP (relais /api/mcp-bridge/<famille>), clients OpenAPI
//  (/api/tools/<famille>, Open WebUI), opencode (plugin elpis-remote).
//  Routes : /api/tokens* (shared_infra/accounts/routes_tokens.py).
//
//  Un jeton n'est montré qu'UNE fois, à sa création ou à sa régénération
//  (empreinte seule côté serveur) : les blocs à copier le portent à ce
//  moment-là ; ensuite un espace réservé le remplace.
//
//  Exporte (setupConnexions) : cnxState, loadConnexions, cnxNew, cnxCancel,
//  cnxCreate, cnxRegenerate, cnxRevoke, cnxShowConfig, cnxCloseReveal,
//  cnxBlocks, cnxCopy, cnxSchemaHref, cnxOpenapiHref, cnxKindLabel, cnxDate.
// ============================================================================
(function () {
    'use strict';

    const PLACEHOLDER = '<VOTRE_JETON>';

    // Blocs de configuration prêts à copier, pour un jeton (ou l'espace
    // réservé), ses familles et l'origine de l'app. Pur : testé à part.
    function buildBlocks(token, families, bridgeUrl, toolsUrl, kind) {
        const tok = token || PLACEHOLDER;
        if (kind === 'opencode') {
            return [{ id: 'remote', label: 'opencode', lang: 'text',
                      text: '/remote ' + tok }];
        }
        const fams = (families || []).filter(Boolean);
        const auth = { Authorization: 'Bearer ' + tok };
        const mcp = {}, vscode = {}, oc = {};
        fams.forEach((f) => {
            const url = bridgeUrl + '/' + f;
            mcp['elpis-' + f] = { type: 'http', url, headers: auth };
            vscode['elpis-' + f] = { type: 'http', url, headers: auth };
            oc['elpis-' + f] = { type: 'remote', url, enabled: true, headers: auth };
        });
        const f0 = fams[0] || 'fs';
        return [
            { id: 'mcp', label: 'MCP', lang: 'json',
              text: JSON.stringify({ mcpServers: mcp }, null, 2) },
            { id: 'vscode', label: 'VS Code', lang: 'json',
              text: JSON.stringify({ servers: vscode }, null, 2) },
            { id: 'opencode', label: 'opencode', lang: 'json',
              text: JSON.stringify({ mcp: oc }, null, 2) },
            { id: 'openapi', label: 'OpenAPI', lang: 'text',
              text: fams.map((f) => 'URL : ' + toolsUrl + '/' + f + '\nClé (Bearer) : ' + tok).join('\n\n') },
            { id: 'curl', label: 'curl', lang: 'shell',
              text: 'curl -s -H "Authorization: Bearer ' + tok + '" \\\n  ' + toolsUrl + '/' + f0 + '/openapi.json' },
        ];
    }

    function setupConnexions(vue, ctx) {
        const _ref = (vue && vue.ref) ? vue.ref : (v) => ({ value: v });
        const _fetch = (ctx && typeof ctx.fetchAuth === 'function') ? ctx.fetchAuth : (u, o) => fetch(u, o);
        const _toast = (ctx && typeof ctx.showToast === 'function') ? ctx.showToast : () => {};
        const _confirm = (ctx && typeof ctx.openConfirm === 'function') ? ctx.openConfirm : null;

        // tokens, policy, bridgeUrl, toolsUrl, opencode, form (null = fermé),
        // reveal ({token, item} affiché UNE fois, ou {item, placeholder}),
        // tab (bloc actif), busy, error.
        const cnxState = _ref({ tokens: [], policy: null, bridgeUrl: '', toolsUrl: '',
                                opencode: false, form: null, reveal: null, tab: 'mcp',
                                busy: false, error: '' });

        function _set(patch) { cnxState.value = Object.assign({}, cnxState.value, patch); }

        async function _err(r, fallback) {
            try { const d = await r.json(); return (d && d.detail) || fallback; } catch (_) { return fallback; }
        }

        async function loadConnexions() {
            try {
                const r = await _fetch('/api/tokens', {}, true);
                if (!r || !r.ok) return;
                const d = await r.json();
                _set({ tokens: d.tokens || [], policy: d.policy || null, bridgeUrl: d.bridge_url || '',
                       toolsUrl: d.tools_url || '', opencode: !!d.opencode_enabled });
            } catch (_) { /* best-effort */ }
        }

        function cnxNew() {
            const pol = cnxState.value.policy || { families: [], max_days: 90 };
            // desktop (pilote des machines hors de la sandbox) et browser
            // (navigation) jamais cochés d'office.
            const fams = {};
            (pol.families || []).forEach((f) => { fams[f.name] = f.name !== 'desktop' && f.name !== 'browser'; });
            const days = pol.max_days ? Math.min(30, pol.max_days) : 30;
            _set({ form: { kind: 'tools', name: '', families: fams, days }, reveal: null, error: '' });
        }

        function cnxCancel() { _set({ form: null, error: '' }); }

        async function cnxCreate() {
            const f = cnxState.value.form;
            if (!f || cnxState.value.busy) return;
            const families = Object.keys(f.families || {}).filter((k) => f.families[k]);
            _set({ busy: true, error: '' });
            try {
                const r = await _fetch('/api/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ kind: f.kind, name: f.name, families, days: f.days }) }, true);
                if (!r || !r.ok) { _set({ error: r ? await _err(r, 'Création refusée.') : 'Erreur réseau.' }); return; }
                const d = await r.json();
                _set({ form: null, reveal: { token: d.token, item: d.item }, tab: d.item.kind === 'opencode' ? 'remote' : 'mcp' });
                await loadConnexions();
            } catch (_) {
                _set({ error: 'Erreur réseau.' });
            } finally {
                _set({ busy: false });
            }
        }

        async function _doRegenerate(item) {
            _set({ busy: true, error: '' });
            try {
                const r = await _fetch('/api/tokens/' + encodeURIComponent(item.id) + '/regenerate', { method: 'POST' }, true);
                if (!r || !r.ok) { _toast(r ? await _err(r, 'Régénération refusée.') : 'Erreur réseau.', 'error'); return; }
                const d = await r.json();
                _set({ reveal: { token: d.token, item: d.item }, form: null, tab: d.item.kind === 'opencode' ? 'remote' : 'mcp' });
                await loadConnexions();
            } catch (_) {
                _toast('Erreur réseau.', 'error');
            } finally {
                _set({ busy: false });
            }
        }

        async function cnxRegenerate(item) {
            const msg = 'Un nouveau jeton remplace « ' + item.name + ' » ; l\'ancien cesse de fonctionner tout de suite.';
            if (_confirm && !(await _confirm('Régénérer le jeton ?', msg, false, 'Régénérer'))) return;
            return _doRegenerate(item);
        }

        async function _doRevoke(item) {
            try {
                const r = await _fetch('/api/tokens/' + encodeURIComponent(item.id), { method: 'DELETE' }, true);
                if (!r || !r.ok) { _toast('Révocation refusée.', 'error'); return; }
                const rv = cnxState.value.reveal;
                if (rv && rv.item && rv.item.id === item.id) _set({ reveal: null });
                await loadConnexions();
            } catch (_) {
                _toast('Erreur réseau.', 'error');
            }
        }

        async function cnxRevoke(item) {
            const msg = 'Les clients qui utilisent « ' + item.name + ' » perdront l\'accès immédiatement.';
            if (_confirm && !(await _confirm('Révoquer le jeton ?', msg, true, 'Révoquer'))) return;
            return _doRevoke(item);
        }

        // Blocs d'un jeton existant : l'espace réservé remplace le jeton.
        function cnxShowConfig(item) {
            _set({ reveal: { token: '', item }, form: null, tab: item.kind === 'opencode' ? 'remote' : 'mcp' });
        }

        function cnxCloseReveal() { _set({ reveal: null }); }

        function cnxBlocks() {
            const rv = cnxState.value.reveal;
            if (!rv || !rv.item) return [];
            return buildBlocks(rv.token, rv.item.families, cnxState.value.bridgeUrl,
                               cnxState.value.toolsUrl, rv.item.kind);
        }

        async function cnxCopy(text) {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    // HTTP sur le LAN : pas de presse-papiers asynchrone.
                    const ta = document.createElement('textarea');
                    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
                    document.body.appendChild(ta); ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                _toast('Copié.');
            } catch (_) {
                _toast('Copie impossible : sélectionnez le texte.', 'error');
            }
        }

        function cnxSchemaHref(family) { return '/api/tokens/schema/' + encodeURIComponent(family); }
        function cnxOpenapiHref(family) { return (cnxState.value.toolsUrl || '/api/tools') + '/' + encodeURIComponent(family) + '/openapi.json'; }

        function cnxKindLabel(kind) {
            return { tools: 'Outils', opencode: 'opencode', vision: 'Vision' }[kind] || kind;
        }

        function cnxDate(ts) {
            if (!ts) return '';
            try { return new Date(Number(ts) * 1000).toLocaleDateString('fr-FR'); } catch (_) { return ''; }
        }

        return { cnxState, loadConnexions, cnxNew, cnxCancel, cnxCreate, cnxRegenerate, cnxRevoke,
                 cnxShowConfig, cnxCloseReveal, cnxBlocks, cnxCopy, cnxSchemaHref, cnxOpenapiHref,
                 cnxKindLabel, cnxDate };
    }

    window.setupConnexions = setupConnexions;
    window.elpisConnexionBlocks = buildBlocks;
})();
