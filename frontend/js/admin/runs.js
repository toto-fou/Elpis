// SPDX-License-Identifier: MIT
// ============================================================================
//  frontend/js/admin/runs.js — console › Supervision › Exécutions (L5.7)
// ============================================================================
//  Gabarit : includes/admin/tab_runs.html. Routes : /api/admin/runs*
//  (shared_infra/routes/admin/runs.py).
//
//  Deux vues sur la même fenêtre (24 h, 7 j, 30 j) : le coût en ressources
//  par compte (jetons, temps du modèle, attente, outils, fichiers, pics de la
//  sandbox — jamais en monnaie), puis les exécutions de premier niveau,
//  filtrables par compte (clic sur une ligne de la première table), genre et
//  statut. Un administrateur ouvre la chronologie d'une exécution dans la
//  modale « Détails » (chat/_run_details.js, mode admin).
// ============================================================================
function setupAdminRuns(vue, sharedRefs, ctx) {
    const { ref } = vue;
    const fetchAuth = ctx.fetchAuth;

    const admRunsScope = ref(24);
    const admRunsLoading = ref(false);
    const admRunsAccounts = ref([]);
    const admRunsItems = ref([]);
    // Filtres de la liste : compte (id + nom affiché), genre, statut.
    const admRunsFilter = ref({ userId: null, username: '', kind: '', status: '' });

    // Seule la dernière demande écrit (deux clics de période rapprochés).
    let _seq = 0;

    function _qs() {
        const f = admRunsFilter.value;
        const p = ['hours=' + admRunsScope.value];
        if (f.userId !== null && f.userId !== undefined) p.push('user_id=' + encodeURIComponent(f.userId));
        if (f.kind) p.push('kind=' + encodeURIComponent(f.kind));
        if (f.status) p.push('status=' + encodeURIComponent(f.status));
        return p.join('&');
    }

    async function loadAdminRuns() {
        const moi = ++_seq;
        admRunsLoading.value = true;
        try {
            const [ra, rl] = await Promise.all([
                fetchAuth('/api/admin/runs/accounts?hours=' + admRunsScope.value, {}, true),
                fetchAuth('/api/admin/runs?' + _qs(), {}, true),
            ]);
            if (moi !== _seq) return;
            if (ra && ra.ok) { const d = await ra.json(); if (moi === _seq) admRunsAccounts.value = d.items || []; }
            if (rl && rl.ok) { const d = await rl.json(); if (moi === _seq) admRunsItems.value = d.items || []; }
        } catch (_) {
            // Best-effort : les anciennes valeurs restent affichées.
        } finally {
            if (moi === _seq) admRunsLoading.value = false;
        }
    }

    function setAdmRunsScope(h) {
        admRunsScope.value = (h === 168 || h === 720) ? h : 24;
        loadAdminRuns();
    }

    function setAdmRunsFilter(patch) {
        admRunsFilter.value = Object.assign({}, admRunsFilter.value, patch || {});
        loadAdminRuns();
    }

    // Clic sur un compte : filtre la liste sur lui ; second clic : retire le filtre.
    function toggleAdmRunsAccount(a) {
        const f = admRunsFilter.value;
        if (a && f.userId !== a.user_id) setAdmRunsFilter({ userId: a.user_id, username: a.username || ('#' + a.user_id) });
        else setAdmRunsFilter({ userId: null, username: '' });
    }

    function admRunsTokens(n) {
        const v = Number(n) || 0;
        if (v >= 1e6) return (v / 1e6).toFixed(1).replace('.', ',') + ' M';
        if (v >= 1e3) return (v / 1e3).toFixed(1).replace('.', ',') + ' k';
        return String(v);
    }

    function admRunsDuration(ms) {
        const n = Number(ms) || 0;
        if (n < 1000) return n + ' ms';
        if (n < 60000) return (n / 1000).toFixed(1).replace('.', ',') + ' s';
        if (n < 3600000) return Math.floor(n / 60000) + ' min ' + Math.round((n % 60000) / 1000) + ' s';
        return Math.floor(n / 3600000) + ' h ' + Math.round((n % 3600000) / 60000) + ' min';
    }

    return { admRunsScope, admRunsLoading, admRunsAccounts, admRunsItems, admRunsFilter,
             loadAdminRuns, setAdmRunsScope, setAdmRunsFilter, toggleAdmRunsAccount,
             admRunsTokens, admRunsDuration };
}
