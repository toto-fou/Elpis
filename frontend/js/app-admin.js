// SPDX-License-Identifier: MIT
function setupAdmin(vue, sharedRefs, ctx) {
    const { ref, computed, watch } = vue;
    const { user } = sharedRefs;
    const { showToast, fetchAuth, openConfirm } = ctx;
    // Confirmation saisie (irréversible) ; repli sur la confirmation simple
    // si l'hôte ne la fournit pas (harnais de test minimal).
    const openTypedConfirm = ctx.openTypedConfirm
        || ((title, message, _word, label) => openConfirm(title, message, true, label));

    // ── Navigation : arborescence décrite par frontend/js/admin/_registry.js ──
    // (source UNIQUE : barre latérale, titres, liens profonds, alias des anciens
    // identifiants, chargeurs et blocs enregistrés de chaque page).
    const NAV = window.ELPIS_ADMIN_NAV || { entries: [], pages: {}, resolve: () => '' };
    const DEFAULT_PAGE = 'overview';
    const adminTab = ref(DEFAULT_PAGE);
    // Lien profond : admin.html#<page> (ou un ancien identifiant, via les
    // alias). Honoré au chargement pour ouvrir directement la bonne page.
    try {
        const _h = (typeof location !== 'undefined' && location.hash) ? location.hash.slice(1) : '';
        const _resolved = NAV.resolve(_h);
        if (_resolved) adminTab.value = _resolved;
    } catch (_) {}
    const _isAdminRole = () => !!(user.value && user.value.role === 'admin');
    const adminIsAdmin = computed(() => _isAdminRole());
    // Une page est-elle ouverte au rôle courant ? (liens de la Vue d'ensemble :
    // un modérateur n'a que la supervision.)
    function adminCanOpen(id) {
        const p = NAV.pages[NAV.resolve(id)];
        return !!p && (p.role === 'staff' || _isAdminRole());
    }
    // Entrées visibles pour le rôle courant : les modérateurs ne voient que
    // la supervision (les routes de configuration refusent de toute façon
    // tout autre rôle que « admin »).
    const adminNav = computed(() => NAV.entries.filter(e => e.role === 'staff' || _isAdminRole()));
    const adminPage = computed(() => NAV.pages[adminTab.value] || NAV.pages[DEFAULT_PAGE] || { id: adminTab.value, label: 'Admin', entry: '', entryLabel: '', wide: true, stores: [], loaders: [] });
    const adminTabTitle = computed(() => adminPage.value.label);
    // Dernière sous-page ouverte de chaque entrée : cliquer sur l'entrée y
    // ramène plutôt qu'en tête de liste.
    const _lastPageOfEntry = {};
    async function goAdminPage(id) {
        const target = NAV.resolve(id);
        if (!target) return false;
        const page = NAV.pages[target];
        if (page.role === 'admin' && !_isAdminRole()) return false;
        if (target === adminTab.value) return true;
        // Garde de sortie : une page modifiée ne se quitte pas en silence
        // (Enregistrer · Ignorer · Rester). Définie plus bas, lue à l'appel.
        if (!(await adminConfirmLeave())) return false;
        adminTab.value = target;
        return true;
    }
    function goAdminEntry(entry) {
        if (!entry || !entry.pages || !entry.pages.length) return;
        const last = _lastPageOfEntry[entry.id];
        goAdminPage(last && entry.pages.some(p => p.id === last) ? last : entry.pages[0].id);
    }
    // Menu « Compte et apparence » du pied de la barre latérale.
    const adminMeOpen = ref(false);
    // Titre de la page : reçoit le focus à chaque changement de page (un
    // lecteur d'écran annonce la nouvelle page, Tab repart du contenu).
    const adminH1 = ref(null);
    const adminScroller = ref(null);
    if (vue.watch) {
        vue.watch(adminTab, function (tab) {
            const page = NAV.pages[tab];
            if (page) _lastPageOfEntry[page.entry] = tab;
            adminMeOpen.value = false;
            // Le détail « Voir » d'une page ne se rouvre pas tout seul sur la
            // suivante (il restait déplié, prêt à s'afficher avec sa barre).
            adminChangesOpen.value = false;
            // Adresse de la page : écrite seulement dans la console dédiée
            // (admin.html). La vue embarquée d'index.html partage son URL avec
            // le chat, qui se sert de l'ancre (#ask…).
            if (typeof window !== 'undefined' && window.__ADMIN_ONLY_MODE__ && page) {
                try {
                    if (location.hash.slice(1) !== tab) history.pushState(null, '', '#' + tab);
                } catch (_) {}
            }
            ctx.nextTick(function () {
                const sc = adminScroller.value;
                if (sc) sc.scrollTop = 0;
            });
        });
    }
    // Précédent / Suivant du navigateur : la console suit l'ancre — sauf page
    // modifiée : l'ancre est remise sur la page courante le temps de demander.
    async function _onAdminPopState() {
        if (!(typeof window !== 'undefined' && window.__ADMIN_ONLY_MODE__)) return;
        const target = NAV.resolve(location.hash.slice(1));
        if (!target || target === adminTab.value) return;
        if (adminDirtyCount.value) {
            try { history.pushState(null, '', '#' + adminTab.value); } catch (_) {}
            if (!(await adminConfirmLeave())) return;
        }
        adminTab.value = target;
    }
    window.addEventListener('popstate', _onAdminPopState);
    // Fermeture du menu Compte au clic extérieur.
    function _onAdminDocClick(e) {
        // Chemin figé au début de l'événement : un clic qui change la vue du
        // menu détache sa cible AVANT ce gestionnaire (rendu Vue en microtâche),
        // et ``closest`` sur un nœud détaché ne trouverait plus le menu.
        const path = e.composedPath ? e.composedPath() : [e.target];
        const inside = sel => path.some(n => n && n.matches && n.matches(sel));
        if (adminMeOpen.value && !inside('[data-adm-me]')) adminMeOpen.value = false;
        if (dashMenu.value && !inside('[data-dash-menu]')) dashMenu.value = null;
    }
    document.addEventListener('click', _onAdminDocClick);
    function focusAdminTitle() {
        ctx.nextTick(function () {
            const h = adminH1.value;
            if (h && typeof h.focus === 'function') h.focus({ preventScroll: true });
        });
    }

    // ── Vue d'ensemble (page d'arrivée, lot 6) ─────────────────────────────
    // Une tournée serveur (/api/admin/overview, cache 15 s côté serveur) :
    // « À traiter », services, dernières 24 h, installation. Rafraîchie toutes
    // les 30 s tant que la page est ouverte et l'onglet visible.
    const overview = ref(null);
    const overviewLoading = ref(false);
    const overviewFailed = ref(false);
    const overviewNow = ref(Date.now());
    let _overviewTimer = null;
    async function loadOverview(refresh) {
        overviewLoading.value = true;
        try {
            const r = await fetchAuth('/api/admin/overview' + (refresh === true ? '?refresh=1' : ''), {}, true);
            const d = (r && r.ok) ? await r.json() : null;
            // Réponse validée puis complétée : un corps partiel (serveur plus
            // ancien, proxy) ne doit pas faire tomber le rendu de la page.
            if (d && Array.isArray(d.alerts) && Array.isArray(d.services)) {
                overview.value = Object.assign({ generated_at: 0, setup: [], backup: {}, restart: { pending: [] } }, d,
                    { kpis: Object.assign({ users: 0, turns: 0, tokens: 0, failures: 0, tool_calls: 0, tool_failures: 0 }, d.kpis || {}),
                      setup: Array.isArray(d.setup) ? d.setup : [] });
                overviewFailed.value = false;
                const rs = overview.value.restart;
                if (rs && Array.isArray(rs.pending)) restartPending.value = rs.pending;
            } else overviewFailed.value = true;
        } catch (_) { overviewFailed.value = true; }
        finally { overviewLoading.value = false; overviewNow.value = Date.now(); }
    }
    function stopOverviewPolling() {
        if (_overviewTimer) { clearInterval(_overviewTimer); _overviewTimer = null; }
    }
    function startOverviewPolling() {
        stopOverviewPolling();
        _overviewTimer = setInterval(() => {
            overviewNow.value = Date.now();
            if (document.hidden || overviewLoading.value) return;
            const at = overview.value && overview.value.generated_at;
            if (!at || Date.now() / 1000 - at >= 30) loadOverview();
        }, 5000);
    }
    // « Actualisé il y a 12 s » — relu toutes les 5 s via overviewNow.
    const overviewAge = computed(() => {
        const at = overview.value && overview.value.generated_at;
        if (!at) return '';
        const s = Math.max(0, Math.round(overviewNow.value / 1000 - at));
        if (s < 5) return 'à l’instant';
        if (s < 60) return 'il y a ' + s + ' s';
        return 'il y a ' + Math.round(s / 60) + ' min';
    });
    const overviewAttention = computed(() => ((overview.value && overview.value.alerts) || []).length);
    const overviewSetupLeft = computed(() => ((overview.value && overview.value.setup) || []).filter(x => !x.done).length);
    const _OV_STATES = Object.freeze({
        ok: ['Joignable', 'ph-check-circle'], down: ['Injoignable', 'ph-x-circle'],
        warn: ['À vérifier', 'ph-warning'], off: ['Désactivé', 'ph-minus-circle'],
        unknown: ['Inconnu', 'ph-question'],
    });
    function overviewStateLabel(st) { return (_OV_STATES[st] || _OV_STATES.unknown)[0]; }
    function overviewStateIcon(st) { return (_OV_STATES[st] || _OV_STATES.unknown)[1]; }
    // Pages concernées par des chemins de config.json (« Inférence, Entretien »).
    function overviewPagesFor(paths) {
        const out = [];
        let other = false;
        for (const p of (paths || [])) {
            const id = NAV.pageForPath ? NAV.pageForPath(p) : '';
            const label = id && NAV.pages[id] ? NAV.pages[id].label : '';
            if (label) { if (!out.includes(label)) out.push(label); }
            else other = true;
        }
        if (other) out.push('autres réglages');
        return out.join(', ');
    }
    function overviewAlertDetail(a) {
        if (a.id === 'restart') return overviewPagesFor(a.paths);
        return a.detail || '';
    }
    function _relTime(ts) {
        if (!ts) return 'jamais';
        const s = Math.max(0, Date.now() / 1000 - ts);
        if (s < 3600) return 'il y a ' + Math.max(1, Math.round(s / 60)) + ' min';
        if (s < 86400) return 'il y a ' + Math.round(s / 3600) + ' h';
        return 'il y a ' + Math.round(s / 86400) + ' j';
    }
    function overviewBackupLabel() {
        const b = overview.value && overview.value.backup;
        return _relTime(b && b.at);
    }
    function fmtCompact(n) {
        const v = Number(n) || 0;
        if (v >= 1e6) return (Math.round(v / 1e5) / 10).toLocaleString('fr-FR') + ' M';
        if (v >= 1e4) return Math.round(v / 1e3).toLocaleString('fr-FR') + ' k';
        return v.toLocaleString('fr-FR');
    }
    async function runOverviewAction(a) {
        if (!a || !a.action) return;
        if (a.action === 'restart') { await restartServer(); return; }
        if (a.action === 'backup') { await downloadBackup('full'); loadOverview(true); return; }
        if (a.page) goAdminPage(a.page);
    }
    // Raccourcis : ouvrir la page puis le bon objet.
    async function overviewShortcut(kind) {
        if (kind === 'account') {
            if (await goAdminPage('accounts')) ctx.nextTick(() => { if (ctx.showNewUserModal) ctx.showNewUserModal.value = true; });
        } else if (kind === 'engine') {
            if (await goAdminPage('inference')) ctx.nextTick(() => { engineSel.value = '__new__'; onEngineSelect(); });
        } else if (kind === 'logs') goAdminPage('logs');
        else if (kind === 'backup') { await downloadBackup('full'); loadOverview(true); }
    }

    // ── « Redémarrage nécessaire » ─────────────────────────────────────────
    // Chemins qui n'agissent qu'au redémarrage (inventaire serveur) et ceux qui
    // l'attendent. Rechargés après chaque enregistrement de config.json.
    const restartPaths = ref(new Set());
    const restartPending = ref([]);
    async function loadRestartStatus() {
        if (!_isAdminRole()) return;
        try {
            const r = await fetchAuth('/api/admin/restart-status', {}, true);
            if (r && r.ok) {
                const d = await r.json();
                restartPaths.value = new Set(Array.isArray(d && d.paths) ? d.paths : []);
                restartPending.value = Array.isArray(d && d.pending) ? d.pending : [];
            }
        } catch (_) {}
    }
    function adminChangeNeedsRestart(c) {
        return !!c && c.store === 'config' && restartPaths.value.has(c.path);
    }

    // ── Recherche Ctrl+K (lot 7) ───────────────────────────────────────────
    // Pages, réglages et actions de la console. Les pages sont en v-if : le DOM
    // des autres n'existe pas, donc les réglages viennent d'un INDEX généré
    // depuis les gabarits (frontend/js/admin/_fields.js, même attribut
    // data-field que la barre d'enregistrement). Score : elpisFuzzyMatch.
    const paletteOpen = ref(false);
    const paletteQuery = ref('');
    const paletteIndex = ref(0);
    const paletteInput = ref(null);
    let _paletteReturn = null;
    function _paletteActions() {
        const out = [];
        const adm = _isAdminRole();
        const add = (label, icon, run, keywords, admin) => {
            if (admin && !adm) return;
            out.push({ kind: 'action', label, icon, run, keywords: keywords || '' });
        };
        add('Tester toutes les connexions', 'ph-arrows-clockwise',
            async () => { if (await goAdminPage('overview')) loadOverview(true); }, 'services sondes état joignable', true);
        add('Redémarrer le serveur', 'ph-power', () => restartServer(), 'relancer appliquer réglages', true);
        add('Télécharger une sauvegarde', 'ph-download-simple', () => downloadBackup('full'), 'archive backup export', true);
        add('Révoquer toutes les sessions', 'ph-sign-out', () => revokeAllSessions(), 'déconnecter tout le monde cookies', true);
        add('Créer un compte', 'ph-user-plus', () => overviewShortcut('account'), 'utilisateur nouveau ajouter', true);
        add('Ajouter un moteur', 'ph-plugs', () => overviewShortcut('engine'), 'connecteur llm vllm serveur', true);
        const theme = ctx.themeApi;
        if (theme && theme.toggleThemeMode) {
            add('Basculer le mode sombre', 'ph-moon', () => theme.toggleThemeMode(), 'clair sombre apparence nuit');
            for (const sk of (theme.skins || [])) {
                add('Thème : ' + sk.label, 'ph-palette', () => theme.setAppSkin(sk.id), 'apparence couleurs skin');
            }
        }
        return out;
    }
    const _paletteCorpus = computed(() => {
        const items = [];
        for (const e of adminNav.value) {
            for (const p of e.pages) {
                items.push({ kind: 'page', label: p.label, meta: e.label !== p.label ? e.label : '',
                             icon: e.icon, page: p.id, keywords: '' });
            }
        }
        const seen = new Set();
        for (const f of (window.ELPIS_ADMIN_FIELDS || [])) {
            if (!adminCanOpen(f.page) || !NAV.pages[f.page]) continue;
            // Une rangée à plusieurs contrôles (hôte, port, délai) : le libellé
            // du contrôle distingue ; sinon une seule entrée par rangée.
            const label = f.control && f.control !== f.label ? f.label + ' › ' + f.control : f.label;
            const key = f.page + '|' + label;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({ kind: 'field', label, meta: NAV.pages[f.page].label, icon: 'ph-sliders-horizontal',
                         page: f.page, field: f.store + ':' + f.path, keywords: (f.hint || '') + ' ' + f.path });
        }
        return items.concat(_paletteActions());
    });
    const _KIND_LABELS = { page: 'Page', field: 'Réglage', action: 'Action' };
    const _KIND_ORDER = { page: 0, action: 1, field: 2 };
    function _segments(text, idx) {
        const hits = new Set(idx || []);
        const segs = [];
        for (let i = 0; i < text.length; i++) {
            const hit = hits.has(i);
            const last = segs[segs.length - 1];
            if (last && last.hit === hit) last.t += text[i];
            else segs.push({ t: text[i], hit });
        }
        return segs;
    }
    // Classement : le sous-mot contigu d'abord (début de mot en tête), puis
    // tous les mots de la saisie dans le libellé, puis une correspondance
    // floue COMPACTE (initiales, lettres proches). Le matcher partagé, glouton,
    // éparpillait « sess » sur « Reprise sur échec… secondes » avant « Mots de
    // passe & sessions » ; et un texte long (aide, chemin) contient à peu près
    // toutes les suites de lettres : il ne compte qu'en sous-mot exact.
    const _norm = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const _SEP = /[\s'’›&(/._:-]/;
    function _rankText(q, text, fuzzyOk) {
        const t = _norm(text), n = _norm(q).trim();
        if (!n) return null;
        const range = (p, len) => Array.from({ length: len }, (_, k) => p + k);
        const pos = t.indexOf(n);
        if (pos >= 0) {
            const start = pos === 0 || _SEP.test(t[pos - 1]);
            return { score: (start ? 400 : 300) - pos * 0.5 - t.length * 0.05, idx: range(pos, n.length) };
        }
        const words = n.split(/\s+/).filter(Boolean);
        if (words.length > 1) {
            let score = 200 - t.length * 0.05;
            const idx = [];
            for (const w of words) {
                const p = t.indexOf(w);
                if (p < 0) return fuzzyOk ? _fuzzyCompact(q, text, n) : null;
                if (!(p === 0 || _SEP.test(t[p - 1]))) score -= 10;
                idx.push(...range(p, w.length));
            }
            return { score, idx };
        }
        return fuzzyOk ? _fuzzyCompact(q, text, n) : null;
    }
    function _fuzzyCompact(q, text, n) {
        const m = window.elpisFuzzyMatch ? window.elpisFuzzyMatch(q, text) : null;
        if (!m || n.length < 2 || !m.idx.length) return null;
        const span = m.idx[m.idx.length - 1] - m.idx[0] + 1;
        return span <= Math.max(2 * n.length, n.length + 3) ? { score: 50 + m.score, idx: m.idx } : null;
    }
    const paletteResults = computed(() => {
        const q = paletteQuery.value.trim();
        const scored = [];
        for (const it of _paletteCorpus.value) {
            let score = 0, idx = [];
            if (q) {
                const m = _rankText(q, it.label, true);
                if (m) { score = m.score; idx = m.idx; }
                else {
                    // Entrée, aide, chemin : sous-mot exact seulement, rien à surligner.
                    const alt = _rankText(q, (it.meta || '') + ' ' + it.keywords, false);
                    if (!alt) continue;
                    score = alt.score * 0.3;
                }
            } else if (it.kind === 'field') continue;   // sans saisie : pages et actions
            scored.push({ it, score, idx });
        }
        scored.sort((a, b) => (b.score - a.score) || (_KIND_ORDER[a.it.kind] - _KIND_ORDER[b.it.kind]));
        return scored.slice(0, 40).map((r, i) => Object.assign({}, r.it, {
            key: r.it.kind + ':' + (r.it.field || r.it.page || r.it.label) + ':' + i,
            kindLabel: _KIND_LABELS[r.it.kind], segs: _segments(r.it.label, r.idx),
        }));
    });
    if (vue.watch) vue.watch(paletteQuery, () => { paletteIndex.value = 0; });
    function openPalette() {
        if (paletteOpen.value) return;
        _paletteReturn = document.activeElement;
        paletteQuery.value = '';
        paletteIndex.value = 0;
        paletteOpen.value = true;
        adminMeOpen.value = false;
        dashMenu.value = null;
        ctx.nextTick(() => { if (paletteInput.value) paletteInput.value.focus(); });
    }
    function closePalette(keepFocus) {
        if (!paletteOpen.value) return;
        paletteOpen.value = false;
        if (keepFocus !== true && _paletteReturn && typeof _paletteReturn.focus === 'function') {
            try { _paletteReturn.focus({ preventScroll: true }); } catch (_) {}
        }
        _paletteReturn = null;
    }
    async function _revealField(field) {
        const sel = '[data-field="' + String(field).replace(/"/g, '\\"') + '"]';
        let el = null;
        // Les chargeurs de la page sont asynchrones : on attend le champ.
        for (let i = 0; i < 40 && !el; i++) {
            el = document.querySelector(sel);
            if (!el) await new Promise(r => setTimeout(r, 50));
        }
        if (!el) return false;
        // Réglage replié sous « Avancé » : on déplie.
        for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        try { el.focus({ preventScroll: true }); } catch (_) {}
        const row = el.closest('.adm-row') || el;
        row.classList.add('adm-flash');
        setTimeout(() => row.classList.remove('adm-flash'), 1600);
        return true;
    }
    async function runPaletteItem(r) {
        if (!r) return;
        if (r.kind === 'action') { closePalette(); await r.run(); return; }
        closePalette(r.kind === 'field');
        if (!(await goAdminPage(r.page))) return;
        if (r.kind === 'field') await _revealField(r.field);
        else focusAdminTitle();
    }
    function onPaletteKey(e) {
        const n = paletteResults.value.length;
        if (e.key === 'ArrowDown') { e.preventDefault(); if (n) paletteIndex.value = (paletteIndex.value + 1) % n; }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) paletteIndex.value = (paletteIndex.value - 1 + n) % n; }
        else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); paletteIndex.value = 0; }
        else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); paletteIndex.value = Math.max(0, n - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); runPaletteItem(paletteResults.value[paletteIndex.value]); }
        else if (e.key === 'Tab') { e.preventDefault(); }   // le focus reste dans le champ
        else return;
        ctx.nextTick(() => {
            const act = document.getElementById('adm-pal-' + paletteIndex.value);
            if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
        });
    }
    function _adminPaletteShortcut(e) {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'k') return;
        if (sharedRefs.isAdminView && !sharedRefs.isAdminView.value) return;
        e.preventDefault();
        if (paletteOpen.value) closePalette(); else openPalette();
    }
    document.addEventListener('keydown', _adminPaletteShortcut);

    // ── Rapport quotidien d'usage IA (zone Métriques) ──────────────────────
    const dailyReport = ref(null);
    const dailyReportLoading = ref(false);
    const dailyReportGenerating = ref(false);
    const reportHistory = ref([]);
    const dailyDigestAuto = ref(true);   // rapport quotidien AUTOMATIQUE (+ notif) on/off
    async function loadDailyReport(date) {
        dailyReportLoading.value = true;
        try {
            const url = '/api/admin/report/daily' + (date ? ('?date=' + encodeURIComponent(date)) : '');
            const res = await fetchAuth(url, {}, true);
            if (res && res.ok) dailyReport.value = await res.json();
            // Historique léger (jours précédents) — best-effort.
            const hist = await fetchAuth('/api/admin/report/daily/list?limit=30', {}, true);
            if (hist && hist.ok) reportHistory.value = (await hist.json()).reports || [];
            // État du digest automatique.
            const auto = await fetchAuth('/api/admin/report/daily/auto', {}, true);
            if (auto && auto.ok) dailyDigestAuto.value = !!(await auto.json()).enabled;
        } catch (e) {} finally { dailyReportLoading.value = false; }
    }
    async function setDailyDigestAuto(enabled) {
        try {
            const res = await fetchAuth('/api/admin/report/daily/auto', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !!enabled }),
            });
            if (res && res.ok) {
                dailyDigestAuto.value = !!(await res.json()).enabled;
                showToast(dailyDigestAuto.value ? 'Rapport quotidien automatique activé' : 'Rapport quotidien automatique désactivé', 'success');
            } else showToast('Échec de la mise à jour', 'error');
        } catch (e) { showToast('Erreur réseau', 'error'); }
    }
    async function generateDailyReport() {
        dailyReportGenerating.value = true;
        try {
            const res = await fetchAuth('/api/admin/report/daily/generate', { method: 'POST' });
            if (res && res.ok) { showToast('Rapport généré et notifié aux admins', 'success'); await loadDailyReport(); }
            else showToast('Échec de la génération', 'error');
        } catch (e) { showToast('Erreur réseau', 'error'); }
        finally { dailyReportGenerating.value = false; }
    }
    function printDailyReport() { window.print(); }
    // Valeur affichable d'un KPI ``value`` du rapport (avec unité), ou « — ».
    function reportVal(wid) {
        const w = (dailyReport.value && dailyReport.value.widgets) || {};
        const d = w[wid];
        if (!d || typeof d !== 'object' || ('error' in d) || d.value === null || d.value === undefined) return '—';
        return d.unit ? (d.value + ' ' + d.unit) : String(d.value);
    }
    function reportTitle(wid) {
        const t = (dailyReport.value && dailyReport.value.titles) || {};
        return t[wid] || wid;
    }
    // Sections « valeur » seulement (les graphiques restent au tableau de bord).
    const reportValueSections = computed(() =>
        ((dailyReport.value && dailyReport.value.sections) || [])
            .filter(s => s.id !== 'charts'));
    const usersList = ref([]);
    // Profils réseau sandbox, renvoyés avec la liste des comptes : la colonne
    // « Réseau » impose un profil à un utilisateur donné.
    const usersNetProfiles = ref([]);
    const usersDesktopTargets = ref([]);
    // ── Tri / filtre / pagination du tableau Utilisateurs ───────────────
    // Tout charger d'un coup tenait tant que l'instance restait petite ;
    // au-delà de quelques dizaines de comptes la page devient un scroll
    // sans fin. Tri côté client (la liste est déjà entière en mémoire).
    const USERS_PAGE_SIZE = 25;
    const usersSearch = ref('');
    const usersSort   = ref({ field: 'id', dir: 1 });
    const usersPage   = ref(1);
    const filteredSortedUsers = computed(() => {
        const q = usersSearch.value.trim().toLowerCase();
        let list = usersList.value;
        if (q) list = list.filter(u =>
            (u.username || '').toLowerCase().includes(q)
            || (u.group_names || '').toLowerCase().includes(q));
        const { field, dir } = usersSort.value;
        return [...list].sort((a, b) => {
            const va = a[field], vb = b[field];
            if (typeof va === 'string' || typeof vb === 'string')
                return String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true }) * dir;
            return ((va ?? 0) - (vb ?? 0)) * dir;
        });
    });
    const usersPageCount = computed(() =>
        Math.max(1, Math.ceil(filteredSortedUsers.value.length / USERS_PAGE_SIZE)));
    const pagedUsers = computed(() => {
        const page = Math.min(usersPage.value, usersPageCount.value);
        return filteredSortedUsers.value.slice((page - 1) * USERS_PAGE_SIZE, page * USERS_PAGE_SIZE);
    });
    function toggleUsersSort(field) {
        const s = usersSort.value;
        usersSort.value = (s.field === field)
            ? { field, dir: -s.dir }
            : { field, dir: 1 };
    }
    watch(usersSearch, () => { usersPage.value = 1; });
    const dashboardData = ref({ layout: [], data: {} });
    const chartInstances = {};
    const configForm = ref(null);
    // (L'instantané « propre » de config.json vit désormais dans
    //  ``adminPristine`` avec ceux des autres blocs — cf. la sauvegarde
    //  unifiée plus bas. Il sert toujours d'anti-clobber au rechargement.)
    const resetTarget = ref(null);
    const newPasswordInput = ref('');
    const liveLogs = ref([]);
    // Menu « ⋯ » de Supervision › Métriques : null (fermé) ou la vue
    // affichée — 'main', 'widgets', 'export', 'collect'. Un seul menu au lieu
    // de trois popovers et de deux compteurs sans libellé dans la barre.
    const dashMenu = ref(null);
    // UX: locks anti click-spam sur les actions async (save config, save project).
    // Exposés dans le return — les boutons correspondants utilisent
    // :disabled pour l'empêcher visuellement ET afficher un spinner.
    const isSavingAdminConfig = ref(false);
    // LLM scheduling mode : chargé via GET /api/admin/llm-capabilities,
    // re-probé via POST .../probe, sauvegardé via POST /api/admin/llm-scheduling-mode.
    // Null tant que non chargé → template affiche "Chargement…".
    const llmScheduling = ref(null);
    const llmSchedulingProbing = ref(false);
    const llmSchedulingSaving = ref(false);
    // Compression conversationnelle — config admin.
    // Chargé via GET /api/admin/compression-config lorsqu'on ouvre l'onglet
    // Config. Sauvegarde via POST du même endpoint.
    const compressionCfg = ref(null);
    const compressionSaving = ref(false);

    // ─────────────────────────────────────────────────────────────────
    //  SAUVEGARDE UNIFIÉE PAR PAGE
    // ─────────────────────────────────────────────────────────────────
    //  AVANT : une même page mélangeait « Sauvegarder » (config.json),
    //  « Appliquer le mode », « Appliquer la compression » et « Enregistrer
    //  l'allowlist » — quatre boutons de portées différentes, l'opérateur
    //  devait deviner lequel couvrait quel champ.
    //
    //  APRÈS : un bouton par page. Il n'appelle QUE les endpoints des blocs
    //  réellement modifiés (comparaison à un instantané « propre » pris au
    //  chargement) et rapporte les échecs bloc par bloc.
    //
    //  EXCEPTION ASSUMÉE : le CRUD des connecteurs LLM partagés garde ses
    //  propres boutons. Un bouton de page ne peut pas exprimer « supprimer
    //  cet objet » ; le panneau est identifié visuellement comme l'éditeur
    //  d'un objet distinct.
    //
    //  Les stores sont volontairement génériques (lecture/écriture/étiquette)
    //  pour qu'ajouter un bloc n'oblige pas à toucher saveAdminPage().
    const ADMIN_STORES = {
        config: {
            label: 'réglages',
            snapshot: () => (configForm.value ? JSON.stringify(configForm.value) : null),
            save: () => _saveConfigStore(),
            reload: () => { adminPristine.value.config = null; return loadAdminConfig('main'); },
        },
        compression: {
            label: 'compression',
            snapshot: () => (compressionCfg.value ? JSON.stringify(compressionCfg.value) : null),
            save: () => saveCompressionCfg(),
            reload: () => loadCompressionCfg(),
        },
        scheduling: {
            label: 'planification',
            snapshot: () => (llmScheduling.value ? String(llmScheduling.value.configured_mode || '') : null),
            save: () => saveLlmSchedulingMode(),
            reload: () => loadLlmScheduling(),
        },
        allowed: {
            label: 'fournisseurs autorisés',
            snapshot: () => JSON.stringify(admLlmAllowed.value || []),
            save: () => saveAdmAllowed(),
            reload: () => loadAdminLlmConnectors(),
        },
        exec: {
            label: 'sandbox',
            // Sérialiseur PARTAGÉ avec le POST : les clés d'UI (_draft, _err…)
            // ne comptent pas dans « modifications non enregistrées », sinon
            // taper une valeur avant de l'ajouter salissait la page.
            snapshot: () => (execConfig.value ? JSON.stringify(execConfigPayload()) : null),
            save: () => saveExecConfig(),
            reload: () => loadExecConfig(),
        },
    };

    // Quels blocs chaque page enregistre : décrit par le registre (stores).
    const ADMIN_PAGE_STORES = Object.freeze(Object.fromEntries(
        Object.values(NAV.pages).filter(p => p.stores && p.stores.length).map(p => [p.id, p.stores])));

    // Instantanés « propres ». RÉACTIF, et ce n'est pas un détail : un simple
    // objet de closure ne réveille pas le computed ci-dessous quand un bloc
    // finit de charger, et l'indicateur de modifications reste figé à zéro
    // pour toute la vie de la page.
    const adminPristine = ref({ config: null, compression: null, scheduling: null, allowed: null, exec: null });
    function _storeSnapshot(id) {
        try { return ADMIN_STORES[id].snapshot(); } catch (_) { return null; }
    }
    function markAdminStoreClean(id) {
        adminPristine.value[id] = _storeSnapshot(id);
    }

    // ── Diff champ par champ ────────────────────────────────────────────
    // Feuilles d'un objet JSON : un objet se déplie, tout le reste (tableau,
    // scalaire, null) est une feuille. Clé = chemin pointé.
    function _flatten(obj, prefix, out) {
        out = out || {};
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            for (const k of Object.keys(obj)) _flatten(obj[k], prefix ? prefix + '.' + k : k, out);
        } else if (prefix) {
            out[prefix] = obj;
        }
        return out;
    }
    const _json = (v) => (v === undefined ? 'undefined' : JSON.stringify(v));
    function _diffLeaves(before, after) {
        const a = _flatten(before || {}), b = _flatten(after || {});
        const out = [];
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (_json(a[k]) !== _json(b[k])) out.push({ path: k, before: a[k], after: b[k], removed: !(k in b) });
        }
        return out;
    }
    function _digPath(obj, path) {
        let cur = obj;
        for (const k of String(path).split('.')) {
            if (!cur || typeof cur !== 'object' || !(k in cur)) return { found: false, value: undefined };
            cur = cur[k];
        }
        return { found: true, value: cur };
    }
    function _setPath(obj, path, value) {
        const parts = String(path).split('.');
        let cur = obj;
        for (const k of parts.slice(0, -1)) {
            if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
            cur = cur[k];
        }
        const last = parts[parts.length - 1];
        if (value === undefined) delete cur[last];
        else cur[last] = (value && typeof value === 'object') ? JSON.parse(JSON.stringify(value)) : value;
    }

    // Modifications de la page ouverte, une ligne par champ. La barre
    // d'enregistrement les compte, « Voir » les liste avec leur retour arrière.
    // L'instantané est lu AVANT le test sur la référence : sortir plus tôt
    // laisserait le computed sans dépendance sur le bloc (jamais réévalué).
    const adminPageChanges = computed(() => {
        const out = [];
        for (const id of (ADMIN_PAGE_STORES[adminTab.value] || [])) {
            const snap = _storeSnapshot(id);
            const base = adminPristine.value[id];
            if (base === null || base === undefined || snap === base) continue;
            let rows;
            try {
                if (id === 'scheduling') rows = [{ path: 'configured_mode', before: base, after: snap }];
                else if (id === 'allowed') rows = [{ path: 'allowed_provider_types', before: JSON.parse(base), after: JSON.parse(snap) }];
                else rows = _diffLeaves(JSON.parse(base), JSON.parse(snap));
            } catch (_) { rows = [{ path: id, before: null, after: null }]; }
            for (const r of rows) out.push(Object.assign({ store: id }, r));
        }
        if (adminTab.value === 'prompts' && promptsEditorDirty.value) {
            out.push({ store: 'prompt', path: promptsSelected.value || 'prompt', before: null, after: null });
        }
        return out;
    });
    const adminDirtyCount = computed(() => adminPageChanges.value.length);
    // Blocs de la page ouverte qui diffèrent de leur référence.
    const adminDirtyStores = computed(() => {
        const ids = new Set(adminPageChanges.value.map(c => c.store));
        return [...ids];
    });
    const adminPageSavable = computed(() => (ADMIN_PAGE_STORES[adminTab.value] || []).length > 0 || adminTab.value === 'prompts');
    const isSavingAdminPage = ref(false);
    // (Aucun watch sur le compteur : il évaluerait la liste PENDANT
    //  l'initialisation du module, avant la déclaration des blocs prompts /
    //  sandbox — erreur de zone morte sur un lien profond #prompts. Le
    //  gabarit masque « Voir » quand la liste est vide.)
    const adminChangesOpen = ref(false);

    // Libellé d'une modification : celui de la ligne qui porte le champ
    // (``data-field="<bloc>:<chemin>"`` sur le contrôle), précisé par
    // l'aria-label du contrôle quand une ligne en porte plusieurs.
    const _STORE_LABELS = { scheduling: 'Mode de planification', allowed: 'Fournisseurs autorisés' };
    function adminChangeLabel(c) {
        if (c.store === 'prompt') return 'Prompt « ' + c.path + ' »';
        if (_STORE_LABELS[c.store]) return _STORE_LABELS[c.store];
        if (c.store === 'exec' && /^network_profiles/.test(c.path)) return 'Profils réseau';
        try {
            const el = document.querySelector('[data-field="' + c.store + ':' + c.path + '"]');
            if (el) {
                const row = el.closest('.adm-row');
                const lbl = row && row.querySelector('.adm-row__label');
                const main = lbl ? lbl.textContent.trim() : '';
                const aria = (el.getAttribute('aria-label') || '').trim();
                if (main && aria && aria !== main) return main + ' › ' + aria;
                if (main || aria) return main || aria;
            }
        } catch (_) {}
        const last = String(c.path).split('.').pop() || c.path;
        return last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, ' ');
    }
    function adminChangeValue(v) {
        if (v === undefined || v === null || v === '') return '(vide)';
        if (v === true) return 'Activé';
        if (v === false) return 'Désactivé';
        if (Array.isArray(v)) return v.length ? v.length + ' élément' + (v.length > 1 ? 's' : '') : '(aucun)';
        if (typeof v === 'object') return 'modifié';
        const t = String(v);
        return t.length > 42 ? t.slice(0, 41) + '…' : t;
    }
    // Retour arrière d'UN champ (les profils réseau et le prompt se
    // rétablissent en bloc, par « Annuler »).
    function adminChangeRevertable(c) {
        return c.store === 'config' || c.store === 'compression' || c.store === 'scheduling'
            || c.store === 'allowed' || (c.store === 'exec' && !/^network_profiles/.test(c.path));
    }
    function revertAdminChange(c) {
        if (!adminChangeRevertable(c)) return;
        if (c.store === 'config' && configForm.value) _setPath(configForm.value, c.path, c.before);
        else if (c.store === 'compression' && compressionCfg.value) _setPath(compressionCfg.value, c.path, c.before);
        else if (c.store === 'scheduling' && llmScheduling.value) llmScheduling.value.configured_mode = c.before;
        else if (c.store === 'allowed') admLlmAllowed.value = Array.isArray(c.before) ? [...c.before] : [];
        else if (c.store === 'exec' && execConfig.value) _setPath(execConfig.value, c.path, c.before);
        // Dernier champ rétabli : la barre disparaît, son détail se referme.
        if (ctx.nextTick) ctx.nextTick(() => { if (!adminDirtyCount.value) adminChangesOpen.value = false; });
    }

    // Enregistre les blocs modifiés de la page. Rend true si TOUT est parti.
    async function saveAdminPage() {
        if (isSavingAdminPage.value) return false;
        const dirty = adminDirtyStores.value.slice();
        if (!dirty.length) return true;
        isSavingAdminPage.value = true;
        const failed = [];
        try {
            // Séquentiel : deux POST concurrents sur config.json se
            // marchaient dessus. L'ordre suit le registre, config.json d'abord.
            for (const id of dirty) {
                let ok = false;
                try {
                    ok = id === 'prompt' ? await savePrompt() : await ADMIN_STORES[id].save();
                } catch (_) { ok = false; }
                if (ok && id !== 'prompt') markAdminStoreClean(id);
                if (!ok) failed.push(id === 'prompt' ? 'prompt' : ADMIN_STORES[id].label);
            }
        } finally {
            isSavingAdminPage.value = false;
        }
        if (!failed.length) {
            showToast('Modifications enregistrées', 'success');
            adminChangesOpen.value = false;
        } else if (failed.length === dirty.length) {
            showToast('Enregistrement échoué : ' + failed.join(', '), 'error');
        } else {
            showToast('Enregistré en partie — échec : ' + failed.join(', '), 'warning');
        }
        return !failed.length;
    }

    // Abandonne les modifications de la page : les blocs sont relus depuis
    // le serveur. Pas de confirmation : « Annuler » est un geste explicite, et
    // la garde de sortie demande déjà avant de quitter une page modifiée.
    async function discardAdminPage(silent) {
        const dirty = adminDirtyStores.value.slice();
        adminChangesOpen.value = false;
        if (!dirty.length) return;
        for (const id of dirty) {
            if (id === 'prompt') { try { await reloadPrompt(); } catch (_) {} continue; }
            try { await ADMIN_STORES[id].reload(); } catch (_) {}
            markAdminStoreClean(id);
        }
        if (silent !== true) showToast('Modifications annulées');
    }

    // Garde de sortie. Rend true si l'on peut quitter la page.
    async function adminConfirmLeave() {
        const n = adminDirtyCount.value;
        if (!n) return true;
        const choice = await ctx.openChoice(
            'Modifications non enregistrées',
            n + ' modification' + (n > 1 ? 's' : '') + ' sur « ' + adminPage.value.label + ' ».',
            [{ id: 'discard', label: 'Ignorer', tone: 'neutral' },
             { id: 'save', label: 'Enregistrer', tone: 'primary' }],
            'Rester');
        if (choice === 'save') return saveAdminPage();
        if (choice === 'discard') { await discardAdminPage(true); return true; }
        return false;
    }

    // Fermeture ou rechargement de l'onglet avec une page modifiée : garde
    // native du navigateur (le texte n'est plus personnalisable).
    function _adminUnloadGuard(e) {
        if (sharedRefs.isAdminView && !sharedRefs.isAdminView.value) return;
        if (!adminDirtyCount.value) return;
        e.preventDefault();
        e.returnValue = '';
        return '';
    }
    window.addEventListener('beforeunload', _adminUnloadGuard);
    // Ctrl+S (⌘S) : enregistre la page de la console, si elle est modifiée.
    function _adminSaveShortcut(e) {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || String(e.key).toLowerCase() !== 's') return;
        if (sharedRefs.isAdminView && !sharedRefs.isAdminView.value) return;
        if (!adminDirtyCount.value) return;
        e.preventDefault();
        saveAdminPage();
    }
    document.addEventListener('keydown', _adminSaveShortcut);

    // ─────────────────────────────────────────────────────────────────
    //  COOKIES & SESSIONS — Admin actions for the new Configuration
    //  section. The fields themselves (cookie_name, same_site, max_age_sec
    //  …) are bound to ``configForm.security.session`` and saved through
    //  the standard POST /api/admin/config-file pipeline. The buttons
    //  below are for ACTIONS that have side effects beyond writing
    //  config.json :
    //    • bumping global_min_ts (revokes every active session)
    //    • bumping users.session_min_ts (revokes one user's sessions)
    //
    //  The reactive ref ``securityOverview`` mirrors GET /api/admin/security/
    //  sessions and is refreshed:
    //    - on every loadAdminConfig('main') call (covers the initial
    //      tab-switch into Configuration),
    //    - after every successful action (so counters update live).
    //
    //  HISTORICAL NOTE — login rate-limit
    //  Earlier iterations had a per-(IP, username) brute-force limiter
    //  with its own admin endpoints (login-attempts / reset). It was
    //  removed in v3.4 because Elpis runs in trusted local-team
    //  deployments where 5 fat-fingered passwords causing a 15-minute
    //  lockout cost more than the protection bought. See auth.py
    //  module docstring for the full rationale.
    // ─────────────────────────────────────────────────────────────────
    const securityOverview = ref(null);   // /api/admin/security/sessions payload
    const securityBusy     = ref(false);  // any in-flight admin action → disables UI

    async function loadSecurityOverview() {
        try {
            const res = await fetchAuth('/api/admin/security/sessions', {}, true);
            if (res && res.ok) {
                securityOverview.value = await res.json();
            }
        } catch(e) { /* silent — toolbar will show "—" instead of stats */ }
    }

    // ── Revoke all sessions ───────────────────────────────────────────
    // Asks the operator to confirm because the consequence is global :
    // every connected user (admins included, except the one issuing
    // the request — the cookie they're using carries the new epoch
    // timestamp via the session save on the response) will be kicked
    // on their next request.
    async function revokeAllSessions() {
        const confirmed = await openConfirm(
            'Révoquer toutes les sessions ?',
            'Tous les utilisateurs connectés (sauf vous) seront déconnectés ' +
            'à leur prochaine requête. Action immédiate, irréversible — les ' +
            'utilisateurs devront se reconnecter.',
            true,
            'Révoquer'
        );
        if (!confirmed) return;
        securityBusy.value = true;
        try {
            const res = await fetchAuth('/api/admin/security/sessions/revoke-all', {
                method: 'POST',
            });
            if (res && res.ok) {
                showToast('Toutes les sessions ont été révoquées', 'success');
                await loadSecurityOverview();
            } else {
                showToast('Échec de la révocation', 'error');
            }
        } catch(e) {
            showToast('Erreur réseau', 'error');
        } finally {
            securityBusy.value = false;
        }
    }

    // ── Accès HTTPS (toggle Caddy) ────────────────────────────────────
    // Action orchestrée côté serveur (garde anti-lockout + bascule des
    // binds + reload gunicorn) — le panneau lit l'état via GET, le bouton
    // POSTe puis redirige l'opérateur vers la nouvelle URL une fois le
    // reload passé (planifié à +5 s côté serveur, marge à 8 s ici).
    const httpsStatus = ref(null);        // GET /api/admin/security/https payload
    const httpsBusy = ref(false);
    const httpsRedirectUrl = ref('');     // affiché pendant le compte à rebours

    async function loadHttpsStatus() {
        try {
            const res = await fetchAuth('/api/admin/security/https', {}, true);
            if (res && res.ok) {
                httpsStatus.value = await res.json();
            }
        } catch(e) { /* silent — le panneau reste sur « Chargement… » */ }
    }

    async function toggleHttps() {
        if (!httpsStatus.value || httpsBusy.value) return;
        const enabling = !httpsStatus.value.enabled;
        const confirmed = await openConfirm(
            enabling ? 'Activer le HTTPS ?' : 'Repasser en HTTP direct ?',
            enabling
                ? "L'application redémarre : elle n'écoutera plus qu'en loopback " +
                  "(Caddy devient le seul point d'entrée) et le cookie de session " +
                  "devient Secure. Vous serez redirigé vers la nouvelle URL en https."
                : "L'application redémarre : l'accès direct http (ports 8001/8002) " +
                  "est rétabli. Le cookie Secure n'étant plus envoyé en clair, " +
                  "une reconnexion sera nécessaire.",
            true,
            enabling ? 'Activer' : 'Repasser en HTTP'
        );
        if (!confirmed) return;
        httpsBusy.value = true;
        try {
            const res = await fetchAuth('/api/admin/security/https', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: enabling }),
            });
            if (res && res.ok) {
                const data = await res.json();
                // La bascule a écrit security.https + security.session.https_only
                // côté serveur. configForm, lui, garde la copie chargée à
                // l'ouverture de l'onglet : la ré-enregistrer republierait
                // l'ANCIEN mode d'accès. Le serveur refuse désormais cet
                // écrasement (admin/config.py › _OWNED_PATHS), mais on remet
                // quand même la copie locale d'aplomb — sinon les cases
                // afficheraient un état faux jusqu'au prochain rechargement.
                if (configForm.value) {
                    // « Le bloc était-il propre AVANT notre réalignement ? » —
                    // on ne re-référence que dans ce cas, sinon on ferait passer
                    // les édits en cours de l'opérateur pour enregistrés et le
                    // prochain rechargement les jetterait.
                    const _wasClean = adminPristine.value.config === null
                        || adminPristine.value.config === _storeSnapshot('config');
                    if (!configForm.value.security) configForm.value.security = {};
                    const _s = configForm.value.security;
                    _s.https = Object.assign({}, _s.https || {}, { enabled: enabling });
                    if (!_s.session) _s.session = {};
                    _s.session.https_only = enabling;
                    if (!enabling && String(_s.session.same_site || '').toLowerCase() === 'none') {
                        _s.session.same_site = 'lax';
                    }
                    _patchRaw('security.https.enabled', enabling);
                    _patchRaw('security.session.https_only', enabling);
                    if (_wasClean) markAdminStoreClean('config');
                }
                showToast(enabling ? 'HTTPS activé — redémarrage en cours'
                                   : 'Retour en HTTP direct — redémarrage en cours', 'success');
                const target = data.urls && data.urls.admin;
                if (target) {
                    httpsRedirectUrl.value = target;
                    setTimeout(() => { window.location.href = target; }, 8000);
                }
            } else if (res && res.status === 409) {
                // Garde anti-lockout : Caddy n'écoute pas — rien n'a été écrit.
                let msg = 'Caddy non détecté — HTTPS non activé';
                try { msg = (await res.json()).detail || msg; } catch(_) {}
                showToast(msg, 'error');
                await loadHttpsStatus();
            } else {
                showToast('Échec de la bascule HTTPS', 'error');
            }
        } catch(e) {
            showToast('Erreur réseau', 'error');
        } finally {
            httpsBusy.value = false;
        }
    }

    // Écoute hors HTTPS (security.listen) : écrite côté serveur puis
    // redémarrage. Le serveur refuse « local » depuis le réseau (409).
    async function setListen(listen, ev) {
        if (!httpsStatus.value || httpsBusy.value || listen === httpsStatus.value.listen) return;
        const local = listen === 'local';
        const confirmed = await openConfirm(
            local ? 'Écouter sur ce serveur seulement ?' : 'Ouvrir au réseau local ?',
            local
                ? "L'application redémarre et n'écoute plus qu'en 127.0.0.1 : " +
                  "les autres machines perdent l'accès aux ports 8001/8002."
                : "L'application redémarre et écoute sur 0.0.0.0 : les ports " +
                  "8001/8002 deviennent joignables en clair depuis le réseau.",
            true,
            local ? 'Restreindre' : 'Ouvrir'
        );
        if (!confirmed) { if (ev && ev.target) ev.target.value = httpsStatus.value.listen; return; }
        httpsBusy.value = true;
        try {
            const res = await fetchAuth('/api/admin/security/listen', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ listen }),
            });
            if (res && res.ok) {
                httpsStatus.value = Object.assign({}, httpsStatus.value, { listen });
                showToast('Écoute modifiée — redémarrage en cours', 'success');
            } else {
                let msg = "Échec du changement d'écoute";
                try { msg = (await res.json()).detail || msg; } catch(_) {}
                showToast(msg, 'error');
                await loadHttpsStatus();
            }
        } catch(e) {
            showToast('Erreur réseau', 'error');
        } finally {
            httpsBusy.value = false;
            if (ev && ev.target && httpsStatus.value) ev.target.value = httpsStatus.value.listen;
        }
    }

    async function clearUserRevocation(userId, username) {
        securityBusy.value = true;
        try {
            const res = await fetchAuth('/api/admin/security/sessions/clear-user-revocation/' + userId, {
                method: 'POST',
            });
            if (res && res.ok) {
                showToast('Révocation levée pour ' + (username || ('uid=' + userId)), 'success');
                await loadSecurityOverview();
            } else {
                showToast('Échec', 'error');
            }
        } catch(e) {
            showToast('Erreur réseau', 'error');
        } finally {
            securityBusy.value = false;
        }
    }

    // (La garde des prompts « après coup » — un observateur d'adminTab qui
    //  ramenait sur la page — est remplacée par la garde de sortie générale,
    //  demandée AVANT de changer de page : cf. goAdminPage / adminConfirmLeave.
    //  La garde native de l'onglet est _adminUnloadGuard.)
    if (vue.onUnmounted) {
        vue.onUnmounted(function() {
            destroyAllCharts();
            window.removeEventListener('popstate', _onAdminPopState);
            document.removeEventListener('click', _onAdminDocClick);
            window.removeEventListener('beforeunload', _adminUnloadGuard);
            document.removeEventListener('keydown', _adminSaveShortcut);
            document.removeEventListener('keydown', _adminPaletteShortcut);
            // (passe 5, F18) — le voisin beforeunload était retiré, pas
            // celui-ci : il survivait au démontage et pouvait relancer le
            // polling (« _pollingDesired » jamais remis à zéro).
            document.removeEventListener('visibilitychange', _onAdminVisibility);
            _pollingDesired = false;
        });
    }

    let dashboardInterval = null;
    let liveInterval = null;
    let _renderTimer = null;

    // Perf (vague 4) : suspendre les polls quand l'onglet est en arrière-plan.
    // L'admin est souvent laissé ouvert dans un onglet caché pendant qu'on
    // discute dans un autre → ses polls (live 2-3 s, dashboard 5 s) tournaient
    // dans le vide, consommaient un slot des 6 connexions HTTP/1.1 par origine
    // (en concurrence avec le SSE + le stream chat) et déclenchaient des
    // re-render Chart.js inutiles. ``_pollingDesired`` mémorise l'intention
    // (dashboard ouvert) ; ``visibilitychange`` met en pause/reprend sans
    // toucher à cette intention. ``loadAdminStats``/``refreshLiveWidgets``
    // sont réassignés plus bas — on les appelle via wrapper paresseux.
    let _pollingDesired = false;
    function _onAdminVisibility() {
        if (document.hidden) {
            if (dashboardInterval) { clearInterval(dashboardInterval); dashboardInterval = null; }
            if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
        } else if (_pollingDesired) {
            startDashboardPolling();
        }
    }
    document.addEventListener('visibilitychange', _onAdminVisibility);

    // -- Préférence : ouvrir automatiquement le dashboard admin après connexion
    //    (au lieu d'arriver sur le chat). Valeur par défaut : true.
    const ADMIN_AUTO_KEY = 'elpis_admin_auto_open';
    let _initAutoAdmin = true;
    try { const v = localStorage.getItem(ADMIN_AUTO_KEY); if (v === '0' || v === 'false') _initAutoAdmin = false; } catch(_) {}
    const adminAutoOpen = ref(_initAutoAdmin);
    function toggleAdminAutoOpen() {
        adminAutoOpen.value = !adminAutoOpen.value;
        try { localStorage.setItem(ADMIN_AUTO_KEY, adminAutoOpen.value ? '1' : '0'); } catch(_) {}
        showToast(adminAutoOpen.value
            ? 'La console s\'ouvrira à la connexion.'
            : 'Le chat s\'ouvrira à la connexion.');
    }
    const POLL_KEY = 'elpis_dashboard_poll_ms';
    const LIVE_POLL_KEY = 'elpis_live_poll_ms';
    const POLL_STEPS = [2000, 3000, 5000, 10000, 15000, 30000, 60000];
    const LIVE_STEPS = [500, 1000, 2000, 3000, 5000, 10000];
    let _initPoll = 5000;
    // Perf (vague 4) : défaut live 2000→3000 ms. 2 s était agressif (widgets
    // système/IO toutes les 2 s = re-render Chart.js + requête synchrone) pour
    // un gain de fraîcheur imperceptible. Réglable par l'utilisateur (LIVE_STEPS).
    let _initLive = 3000;
    try { const v = parseInt(localStorage.getItem(POLL_KEY)); if (POLL_STEPS.includes(v)) _initPoll = v; } catch(_) {}
    try { const v = parseInt(localStorage.getItem(LIVE_POLL_KEY)); if (LIVE_STEPS.includes(v)) _initLive = v; } catch(_) {}
    const dashboardPollMs = ref(_initPoll);
    const livePollMs = ref(_initLive);

    function pollLabel() {
        const ms = dashboardPollMs.value;
        return ms >= 60000 ? (ms / 60000) + ' min' : (ms / 1000) + ' s';
    }
    function livePollLabel() {
        const ms = livePollMs.value;
        return ms < 1000 ? ms + ' ms' : (ms / 1000) + ' s';
    }
    function setPollInterval(ms) {
        if (!POLL_STEPS.includes(ms)) return;
        dashboardPollMs.value = ms;
        try { localStorage.setItem(POLL_KEY, String(ms)); } catch(_) {}
        if (dashboardInterval) { stopDashboardPolling(); startDashboardPolling(); }
    }
    function setLiveInterval(ms) {
        if (!LIVE_STEPS.includes(ms)) return;
        livePollMs.value = ms;
        try { localStorage.setItem(LIVE_POLL_KEY, String(ms)); } catch(_) {}
        if (liveInterval) { stopLivePolling(); startLivePolling(); }
    }
    function pollFaster() {
        const idx = POLL_STEPS.indexOf(dashboardPollMs.value);
        if (idx > 0) setPollInterval(POLL_STEPS[idx - 1]);
    }
    function pollSlower() {
        const idx = POLL_STEPS.indexOf(dashboardPollMs.value);
        if (idx >= 0 && idx < POLL_STEPS.length - 1) setPollInterval(POLL_STEPS[idx + 1]);
    }
    function liveFaster() {
        const idx = LIVE_STEPS.indexOf(livePollMs.value);
        if (idx > 0) setLiveInterval(LIVE_STEPS[idx - 1]);
    }
    function liveSlower() {
        const idx = LIVE_STEPS.indexOf(livePollMs.value);
        if (idx >= 0 && idx < LIVE_STEPS.length - 1) setLiveInterval(LIVE_STEPS[idx + 1]);
    }

    // Rafraîchit uniquement les widgets "live" (CPU/RAM + Disk I/O) sans retoucher
    // aux KPIs ou autres charts lents. Met à jour directement les Chart.js instances.
    const LIVE_WIDGETS = ['system_load', 'disk_io'];
    async function refreshLiveWidgets() {
        try {
            // ``ids=`` : ne recalcule QUE ces deux graphiques. Sans ce filtre,
            // la boucle live relançait les ~60 providers (donc toute la charge
            // SQL du tableau de bord) toutes les 3 secondes pour n'en afficher
            // que deux.
            const res = await fetchAuth(
                '/api/admin/stats-dynamic?ids=' + encodeURIComponent(LIVE_WIDGETS.join(',')));
            if (!res || !res.ok) return;
            const json = await res.json();
            LIVE_WIDGETS.forEach(wid => {
                const newData = json.data && json.data[wid];
                if (!newData || newData.error) return;
                if (dashboardData.value.data) dashboardData.value.data[wid] = newData;
                const inst = chartInstances[wid];
                if (inst) { inst.data = newData; inst.update('none'); }
            });
        } catch(e) {}
    }
    function startLivePolling() {
        if (liveInterval) return;
        if (document.hidden) return;   // perf : pas de poll en onglet caché
        liveInterval = setInterval(refreshLiveWidgets, livePollMs.value);
    }
    function stopLivePolling() {
        if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
    }

    // ── Visibilité des widgets : set CURÉ par défaut, choix explicite gagnant ──
    // Avant : une liste de widgets MASQUÉS, donc tout ce que le serveur
    // enregistrait s'affichait — soixante cartes d'emblée, où l'opérateur
    // devait chercher l'information au lieu de la voir. Désormais le serveur
    // marque les widgets du set curé (``layout[].default``) et l'utilisateur
    // ne stocke QUE ses écarts à ce défaut : un widget ajouté plus tard
    // apparaît (ou non) selon la curation, sans écraser les choix existants.
    const WIDGET_PREFS_KEY = 'elpis_widget_prefs';
    const HIDDEN_KEY = 'elpis_hidden_widgets';   // legacy (migré une fois)
    let _initPrefs = {};
    try { _initPrefs = JSON.parse(localStorage.getItem(WIDGET_PREFS_KEY) || '{}') || {}; } catch(_) {}
    try {
        // Migration : l'ancienne liste de masqués devient autant de « non »
        // explicites. On la retire ensuite pour ne pas migrer deux fois.
        const legacy = JSON.parse(localStorage.getItem(HIDDEN_KEY) || 'null');
        if (Array.isArray(legacy)) {
            legacy.forEach(id => { if (_initPrefs[id] === undefined) _initPrefs[id] = false; });
            localStorage.setItem(WIDGET_PREFS_KEY, JSON.stringify(_initPrefs));
            localStorage.removeItem(HIDDEN_KEY);
        }
    } catch(_) {}
    const widgetPrefs = ref(_initPrefs);

    // v17 — Global dashboard time scope (24h / 7j / 30j). Propagé aux
    // widgets scope-aware (cf. _v17_providers.py). Persisté en
    // localStorage pour respecter le choix entre sessions.
    const SCOPE_KEY = 'elpis_dashboard_scope_hours';
    let _initScope = 24;
    try {
        const s = parseInt(localStorage.getItem(SCOPE_KEY) || '24', 10);
        if ([24, 168, 720].includes(s)) _initScope = s;
    } catch(_) {}
    const dashboardScope = ref(_initScope);
    function setDashboardScope(hours) {
        if (![24, 168, 720].includes(hours)) return;
        dashboardScope.value = hours;
        try { localStorage.setItem(SCOPE_KEY, String(hours)); } catch(_) {}
        loadAdminStats();
    }

    function _widgetDefault(id) {
        const w = (dashboardData.value.layout || []).find(l => l.id === id);
        return w ? w.default !== false : false;
    }
    function isWidgetVisible(id) {
        const pref = widgetPrefs.value[id];
        return pref === undefined ? _widgetDefault(id) : !!pref;
    }
    function toggleWidgetVisibility(id) {
        const wasHiding = isWidgetVisible(id);   // visible → on masque
        const next = !wasHiding;
        // Retour au défaut si le choix redevient celui de la curation : on ne
        // fige pas une préférence qui n'en est plus une.
        if (next === _widgetDefault(id)) delete widgetPrefs.value[id];
        else widgetPrefs.value[id] = next;
        widgetPrefs.value = { ...widgetPrefs.value };
        try { localStorage.setItem(WIDGET_PREFS_KEY, JSON.stringify(widgetPrefs.value)); } catch(_) {}
        // FIX visibilité↔poll : un widget GRAPHE masqué laissait son instance
        // Chart.js vivante (canvas détaché + listener resize global) ; au poll
        // suivant Chart.js réutilisait/réinsérait le canvas → le graphe
        // « réapparaissait ». On synchronise l'instance avec la visibilité
        // immédiatement : destroy au masquage, recréation (nextTick, le canvas
        // vient d'être rajouté au DOM par Vue) à l'affichage.
        if (wasHiding) {
            if (chartInstances[id]) { try { chartInstances[id].destroy(); } catch(_) {} delete chartInstances[id]; }
        } else if (ctx.nextTick) {
            ctx.nextTick(renderDynamicDashboard);
        }
    }
    // ─────────────────────────────────────────────────────────────────
    //  KPI CATEGORIES — visual grouping in the dashboard
    // ─────────────────────────────────────────────────────────────────
    // The backend assigns each KPI a ``category`` ('activity' / 'volume' /
    // 'performance' / 'system'). The dashboard renders them in this
    // explicit order with section headers, instead of one giant 4-col
    // grid where related metrics are scattered. Why it matters: an
    // operator scanning for "is the platform healthy ?" wants to see
    // performance and system KPIs near each other, not next to "messages
    // total" or "groupes".
    //
    // The catalogue below is THE source of truth for the section order.
    // Anything not matched falls into the "Autres" section.
    const KPI_CATEGORIES = Object.freeze([
        { id: 'activity',    label: 'Activité',    icon: 'ph-users-three',  color: 'blue'    },
        { id: 'volume',      label: 'Volume',      icon: 'ph-stack',        color: 'emerald' },
        { id: 'performance', label: 'Performance', icon: 'ph-gauge',        color: 'rose'    },
        { id: 'system',      label: 'Système',     icon: 'ph-cpu',          color: 'amber'   },
        { id: 'general',     label: 'Autres',      icon: 'ph-circle',       color: 'slate'   },
    ]);

    // KPIs of the given category that are currently visible. Backed by
    // the layout's per-widget ``category`` field exposed by metrics_engine.
    function kpisInCategory(catId) {
        if (!dashboardData.value.layout) return [];
        return dashboardData.value.layout.filter(w => {
            if (w.type !== 'value' || !isWidgetVisible(w.id)) return false;
            const c = w.category || 'general';
            return c === catId;
        });
    }

    // Graphes visibles d'une catégorie (le backend expose w.category aussi
    // pour les charts). Sert aux sous-pages par groupe de la zone Métriques.
    function chartsInCategory(catId) {
        if (!dashboardData.value.layout) return [];
        return dashboardData.value.layout.filter(w => {
            if (w.type === 'value' || !isWidgetVisible(w.id)) return false;
            return (w.category || 'general') === catId;
        });
    }

    // ── Groupes de la page Métriques (refonte 2026-09-27) ─────────────────
    // Plus d'onglets de catégorie : tous les indicateurs se lisent d'un coup,
    // rangés par groupe (Activité, Volume…), puis les graphes du même groupe.
    // Les groupes vides disparaissent.
    const kpiGroups = computed(() => KPI_CATEGORIES
        .map(c => ({ id: c.id, label: c.label, items: kpisInCategory(c.id) }))
        .filter(g => g.items.length));
    const chartGroups = computed(() => KPI_CATEGORIES
        .map(c => ({ id: c.id, label: c.label, items: chartsInCategory(c.id) }))
        .filter(g => g.items.length));
    try { localStorage.removeItem('elpis_metrics_subtab'); } catch(_) {}

    // État d'un indicateur : le serveur ne pose ``state`` ('warn' | 'danger')
    // que sur une valeur ANORMALE (serveur hors ligne, disque plein, runs en
    // erreur…). Les icônes restent monochromes le reste du temps : la couleur
    // décorative des fournisseurs (``color``) n'est plus affichée.
    function kpiState(id) {
        const d = dashboardData.value.data && dashboardData.value.data[id];
        const s = d && d.state;
        return s === 'danger' || s === 'warn' ? s : '';
    }

    // Résumé texte d'un graphe pour les lecteurs d'écran : un <canvas> est
    // muet. Peu de libellés (répartition, percentiles) → chaque valeur ;
    // série temporelle → nombre de points, dernière valeur et maximum.
    function chartSummary(widget) {
        const d = dashboardData.value.data && dashboardData.value.data[widget.id];
        if (!d || d.error || !(d.labels && d.labels.length)) return widget.title + ' : aucune donnée';
        const fmt = v => {
            const n = Number(v);
            return Number.isFinite(n) ? (Math.round(n * 100) / 100).toLocaleString('fr-FR') : String(v);
        };
        const sets = (d.datasets || []).slice(0, 4);
        let parts;
        if (d.labels.length <= 8) {
            parts = sets.map(ds => (ds.label && sets.length > 1 ? ds.label + ' : ' : '')
                + d.labels.map((l, i) => l + ' ' + fmt((ds.data || [])[i])).join(', '));
        } else {
            parts = sets.map(ds => {
                const vals = (ds.data || []).map(Number).filter(Number.isFinite);
                if (!vals.length) return '';
                return (ds.label ? ds.label + ' : ' : '') + 'dernier ' + fmt(vals[vals.length - 1])
                    + ', maximum ' + fmt(Math.max(...vals));
            }).filter(Boolean);
            parts.unshift(d.labels.length + ' points');
        }
        return widget.title + '. ' + parts.join(' ; ');
    }

    function allWidgetsList() {
        if (!dashboardData.value.layout) return [];
        return dashboardData.value.layout.map(w => ({
            id: w.id,
            title: w.title,
            type: w.type,
            category: w.category || 'general',
            isDefault: w.default !== false,
            visible: isWidgetVisible(w.id)
        }));
    }
    // Retour au set curé : efface tous les écarts mémorisés.
    function resetWidgetPrefs() {
        widgetPrefs.value = {};
        try { localStorage.removeItem(WIDGET_PREFS_KEY); } catch(_) {}
        destroyAllCharts();
        if (ctx.nextTick) ctx.nextTick(renderDynamicDashboard);
        showToast('Affichage revenu au set par défaut');
    }
    // ── Réinitialisation des métriques ────────────────────────────────────
    // Deux temps, toujours : on annonce d'abord le volume exact qui sera
    // supprimé (``dry_run``), puis on confirme. Un tableau de bord dont on ne
    // peut pas remettre une série à zéro oblige à vivre des mois avec les
    // chiffres d'un incident ou d'une campagne de tests.
    const PURGE_LABELS = Object.freeze({
        usage_events: 'registre de consommation',
        metric_events: 'compteurs',
        tool_call_metrics: 'appels d\'outils',
        daily_usage_reports: 'rapports quotidiens',
        editor_routine_runs: 'journal des runs de routines',
    });

    async function _purge(body, title, extraWarning, typedWord) {
        const probe = await fetchAuth('/api/admin/metrics/purge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, body, { dry_run: true })),
        });
        if (!probe || !probe.ok) { showToast('Purge indisponible', 'error'); return false; }
        const info = await probe.json();
        const total = Object.values(info.counted || {}).reduce((a, b) => a + b, 0);
        if (!total) { showToast('Rien à supprimer sur ce périmètre'); return false; }
        const detail = Object.entries(info.counted || {})
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${n} ${PURGE_LABELS[k] || k}`).join(' · ');
        const msg = `${detail}. Suppression définitive.` + (extraWarning ? ' ' + extraWarning : '');
        const ok = typedWord
            ? await openTypedConfirm(title, msg, typedWord, 'Supprimer')
            : await openConfirm(title, msg, true, 'Supprimer');
        if (!ok) return false;
        const res = await fetchAuth('/api/admin/metrics/purge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({}, body, { dry_run: false })),
        });
        if (!res || !res.ok) { showToast('Échec de la purge', 'error'); return false; }
        const done = await res.json();
        const n = Object.values(done.deleted || {}).reduce((a, b) => a + b, 0);
        showToast(`${n} ligne(s) supprimée(s)`, 'success');
        await loadAdminStats();
        return true;
    }

    async function resetWidget(widget) {
        const spec = widget && widget.purge;
        if (!spec || !spec.target) return;
        await _purge(
            { targets: [spec.target], event_types: spec.event_types || undefined },
            `Réinitialiser « ${widget.title} »`,
            spec.destructive
                ? 'Ce périmètre contient le journal des runs, pas seulement des compteurs.'
                : '');
    }

    async function resetAllMetrics() {
        await _purge(
            { targets: ['usage_events', 'metric_events', 'tool_call_metrics'] },
            'Remettre toutes les métriques à zéro',
            'Le journal des runs de routines et les rapports quotidiens sont conservés.',
            'PURGER');
    }

    // Export du périmètre AVANT purge — filet proposé à côté de chaque action.
    function exportUsage(days) {
        downloadWithModal('/api/admin/export-metrics?target=usage_events&days=' + (days || 30),
                          'Export du registre de consommation', 'usage_events.csv');
    }

    // ── Jeton de scrape Prometheus ────────────────────────────────────────
    const scrapeToken = ref({ configured: false, token: null, loading: false });
    async function loadScrapeToken() {
        scrapeToken.value.loading = true;
        try {
            const res = await fetchAuth('/api/admin/metrics/scrape-token');
            if (res && res.ok) {
                const j = await res.json();
                scrapeToken.value = { configured: !!j.configured, token: j.token, loading: false };
                return;
            }
        } catch(_) {}
        scrapeToken.value.loading = false;
    }
    async function setScrapeToken(action) {
        if (action === 'revoke') {
            const ok = await openConfirm('Révoquer le jeton',
                'Les collecteurs qui l\'utilisent cesseront de recevoir les métriques.',
                true, 'Révoquer');
            if (!ok) return;
        }
        const res = await fetchAuth('/api/admin/metrics/scrape-token', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
        });
        if (!res || !res.ok) { showToast('Opération refusée', 'error'); return; }
        const j = await res.json();
        scrapeToken.value = { configured: !!j.configured, token: j.token, loading: false };
        showToast(action === 'revoke' ? 'Jeton révoqué' : 'Jeton généré', 'success');
    }
    function copyScrapeToken() {
        const t = scrapeToken.value.token;
        if (!t) return;
        navigator.clipboard.writeText(t)
            .then(() => showToast('Jeton copié'))
            .catch(() => showToast('Erreur de copie', 'error'));
    }

    function prometheusUrl() {
        return window.location.origin + '/api/admin/metrics/prometheus';
    }
    function copyPrometheusUrl() {
        navigator.clipboard.writeText(prometheusUrl()).then(() => {
            showToast('URL copiée dans le presse-papier');
        }).catch(() => {
            showToast('Erreur de copie', 'error');
        });
    }

    // ``notify`` : true depuis le bouton Rafraîchir (feedback explicite),
    // absent lors des chargements automatiques (boot, retour d'onglet).
    async function loadUsers(notify) {
        if (!user.value?.is_admin) return;
        try {
            const res = await fetchAuth('/api/admin/users-with-groups');
            if (res && res.ok) {
                const data = await res.json();
                usersList.value = data.users || [];
                // Profils réseau connus : alimentent la colonne « Réseau »
                // sans dépendre d'un passage par la page Sandbox.
                usersNetProfiles.value = data.network_profiles || [];
                // Machines desktop (accès par machine, 2026-09-23).
                usersDesktopTargets.value = data.desktop_targets || [];
                // Dénominateur de la colonne « Serveurs » (N / M).
                loadAdmLlmAccessOptions(notify === true);
                if (notify === true) showToast('Liste des utilisateurs rechargée', 'success');
            } else if (notify === true) {
                showToast('Échec du rechargement', 'error');
            }
        } catch(e) {
            if (notify === true) showToast('Erreur réseau', 'error');
        }
    }

    // (passe 5, F9) — jeton : la réponse 24 h (rapide) ne doit pas écraser
    // celle de 30 j (lente) demandée juste après, ni l'inverse.
    let _statsSeq = 0;
    async function loadAdminStats() {
        const mySeq = ++_statsSeq;
        try {
            // v17 — dashboardScope (24h/7j/30j) propagé aux widgets
            // scope-aware (cf. _v17_providers.py). Les widgets legacy
            // ignorent le param (fallback TypeError côté registry).
            const scope = dashboardScope.value || 24;
            const res = await fetchAuth('/api/admin/stats-dynamic?scope_hours=' + scope);
            if (mySeq !== _statsSeq) return;   // réponse périmée (F9)
            if (res && res.ok) {
                const json = await res.json();
                if (mySeq !== _statsSeq) return;
                // ⚠ Ne PAS écrire la réponse telle quelle : ``dashboardData``
                // est initialisé à ``{ layout: [], data: {} }`` et tout le
                // fichier compte sur cette forme. Une réponse sans ``layout``
                // (backend plus ancien, payload d'erreur, réponse partielle)
                // la remplaçait et faisait exploser ``renderDynamicDashboard``
                // sur ``layout.forEach`` — à chaque tour de rafraîchissement,
                // donc en boucle. Les autres lecteurs, eux, se gardent déjà
                // (``|| []``, ``if (!layout) return []``) : seul le rendu ne
                // le faisait pas. On normalise ici, une fois, à la source.
                dashboardData.value = {
                    ...(json && typeof json === 'object' ? json : {}),
                    layout: Array.isArray(json && json.layout) ? json.layout : [],
                    data: (json && json.data && typeof json.data === 'object') ? json.data : {},
                };
                if (_renderTimer) clearTimeout(_renderTimer);
                _renderTimer = setTimeout(() => { _renderTimer = null; ctx.nextTick(renderDynamicDashboard); }, 150);
            }
        } catch(e) {}
    }

    function renderDynamicDashboard() {
        // chart.js n'est plus chargé en dur par admin.html : le dashboard est
        // le seul écran de cette page qui en a besoin. On le demande ici, une
        // seule fois (ensureVendor est mémoïsé), puis on rejoue le rendu.
        // Sortir tôt plutôt que rendre à moitié : le reste de la fonction
        // suppose ``Chart`` disponible de bout en bout.
        if (typeof Chart === 'undefined') {
            if (window.ensureVendor) {
                window.ensureVendor('chart').then(renderDynamicDashboard).catch(() => {});
            }
            return;
        }
        Object.keys(chartInstances).forEach(id => {
            const canvasId = `chart_${id}`;
            const canvasInDom = document.getElementById(canvasId);
            if (!dashboardData.value.layout.find(l => l.id === id) || !canvasInDom || !isWidgetVisible(id)) {
                if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
            }
        });
        dashboardData.value.layout.forEach(widget => {
            const widgetId = widget.id;
            if (!isWidgetVisible(widgetId)) return;
            const widgetData = dashboardData.value.data[widgetId];
            if (widget.type === 'value' || widget.type === 'table') return;
            if (!widgetData || widgetData.error) return;
            const canvas = document.getElementById(`chart_${widgetId}`);
            if (!canvas) return;
            const meta = widgetData.meta || {};
            const chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 500 },
                plugins: { legend: { display: widget.type !== 'bar', position: 'bottom' } }
            };
            // Séries temporelles : les libellés sont des débuts de seau ISO
            // (« 2026-08-12T14:00 »). On n'affiche que l'heure — ou le jour
            // au changement de journée — pour garder une frise lisible sans
            // perdre l'information de date, qui reste dans l'infobulle.
            if (meta.granularity) {
                const labels = widgetData.labels || [];
                const short = labels.map((l, i) => {
                    if (meta.granularity === 'day') return String(l).slice(5);
                    const day = String(l).slice(0, 10), hour = String(l).slice(11, 16);
                    const prevDay = i > 0 ? String(labels[i - 1]).slice(0, 10) : null;
                    return (i === 0 || day !== prevDay) ? day.slice(5) + ' ' + hour : hour;
                });
                chartOptions.scales = Object.assign({}, chartOptions.scales, {
                    x: { ticks: { autoSkip: true, maxRotation: 0,
                                  callback: (v, i) => short[i] ?? '' } },
                    y: { beginAtZero: true },
                });
                chartOptions.plugins.tooltip = {
                    callbacks: { title: (items) => (items && items[0]) ? labels[items[0].dataIndex] : '' },
                };
                if (meta.timezone) {
                    chartOptions.plugins.subtitle = {
                        display: true, text: 'Fuseau : ' + meta.timezone,
                        position: 'bottom', font: { size: 10 },
                    };
                }
            }
            if (widgetId === 'system_load') { chartOptions.scales = { y: { min: 0, max: 100 } }; chartOptions.animation = { duration: 0 }; }
            if (widgetId === 'disk_io') { chartOptions.scales = { y: { min: 0, beginAtZero: true } }; chartOptions.animation = { duration: 0 }; }
            if (widgetId === 'models_usage') {
                chartOptions.scales = {
                    y:  { type: 'linear', position: 'left',  beginAtZero: true, title: { display: true, text: 'Appels' } },
                    y1: { type: 'linear', position: 'right', beginAtZero: true, title: { display: true, text: 'Tokens' }, grid: { drawOnChartArea: false } }
                };
                chartOptions.plugins.legend = { display: true, position: 'bottom' };
            }
            // Heatmap-like activity chart — 24-bucket stacked bar where each
            // hour is a column split by day-of-week. Stacking is what turns
            // it visually into a "when is the platform busy" view, with the
            // total height of each bar = activity for that hour across the
            // 7 days. Legend stays on (the operator needs to see day colours).
            if (widget.type === 'bar_stacked') {
                const xPrev = (chartOptions.scales || {}).x || {};
                chartOptions.scales = {
                    x: Object.assign({ ticks: { autoSkip: false, maxRotation: 0, font: { size: 10 } } },
                                     xPrev, { stacked: true }),
                    y: { stacked: true, beginAtZero: true }
                };
                chartOptions.plugins.legend = { display: true, position: 'bottom' };
            }
            // Chart.js doesn't recognise "bar_stacked" as a primitive chart
            // type — it's just a bar chart with stacked scales. Translate
            // before instantiation so Chart.js sees "bar".
            const cjsType = (widget.type === 'bar_stacked') ? 'bar' : widget.type;
            if (chartInstances[widgetId] && chartInstances[widgetId].ctx.canvas === canvas) {
                chartInstances[widgetId].data = widgetData;
                chartInstances[widgetId].update('none');
            } else {
                if (chartInstances[widgetId]) chartInstances[widgetId].destroy();
                chartInstances[widgetId] = new Chart(canvas, { type: cjsType, data: widgetData, options: chartOptions });
            }
        });
    }

    function startDashboardPolling() {
        _pollingDesired = true;
        if (!dashboardInterval && !document.hidden) dashboardInterval = setInterval(loadAdminStats, dashboardPollMs.value);
        startLivePolling();
    }

    function stopDashboardPolling() {
        _pollingDesired = false;
        if (dashboardInterval) { clearInterval(dashboardInterval); dashboardInterval = null; }
        if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
        stopLivePolling();
        destroyAllCharts();
    }

    // Détruit toutes les instances Chart.js encore vivantes et vide le
    // registre. Les charts responsive enregistrent un listener resize
    // global ; sans destroy() ils survivent (avec leur listener) une fois
    // leur canvas retiré du DOM par le v-if. Appelé en quittant le
    // dashboard et au démontage de la vue admin.
    function destroyAllCharts() {
        Object.keys(chartInstances).forEach(id => {
            try { chartInstances[id].destroy(); } catch(_) {}
            delete chartInstances[id];
        });
    }

    // ─────────────────────────────────────────────────────────────────
    //  LOG FILTERS — driven by the toolbar in tab_logs.html
    // ─────────────────────────────────────────────────────────────────
    // Persisted in localStorage so that switching between tabs / pages
    // doesn't reset the operator's filter selection. Schema is small
    // and stable; if it ever changes, we just drop the key.
    const LOG_FILTERS_KEY = 'elpis_admin_log_filters';
    let _logFiltersInit;
    try {
        const raw = localStorage.getItem(LOG_FILTERS_KEY);
        _logFiltersInit = raw ? JSON.parse(raw) : null;
    } catch(_) { _logFiltersInit = null; }
    const logFilters = ref(_logFiltersInit || {
        services:   [],   // empty = all services
        levels:     [],   // empty = all levels
        categories: [],   // empty = all categories
        query:      '',
    });
    // Persist on change (debounced via watchEffect).
    if (vue.watch) {
        vue.watch(logFilters, function(v) {
            try { localStorage.setItem(LOG_FILTERS_KEY, JSON.stringify(v)); } catch(_) {}
        }, { deep: true });
    }
    const logAutoScroll = ref(true);
    const logsConsoleRef = ref(null);

    // Computed: live filter applied client-side on the buffer. The backend
    // /api/admin/logs/recent ALSO supports the same filters (so a "Recharger"
    // narrows the historical fetch to relevant entries) — but client-side
    // filtering keeps the live SSE stream responsive without a round-trip.
    const filteredLogs = vue.computed(function() {
        const t = ctx.liveLogs;
        if (!t || !t.value) return [];
        const f = logFilters.value;
        const hasSvc = f.services && f.services.length > 0;
        const hasLvl = f.levels && f.levels.length > 0;
        const hasCat = f.categories && f.categories.length > 0;
        const q = (f.query || '').toLowerCase().trim();
        return t.value.filter(function(l) {
            if (hasSvc && (!l.service || !f.services.includes(l.service))) return false;
            if (hasLvl && (!l.level   || !f.levels.includes(l.level)))     return false;
            if (hasCat && (!l.category|| !f.categories.includes(l.category))) return false;
            if (q && !(l.message || '').toLowerCase().includes(q)) return false;
            return true;
        });
    });

    // Amorçage de la console depuis le ring buffer serveur (300 dernières
    // entrées) : sans lui, l'opérateur qui ouvre la page ne voit QUE ce qui
    // arrive après son arrivée — inutile pour diagnostiquer ce qui vient de
    // se passer. Les entrées sont fusionnées dans le tampon live partagé.
    const logsLoading = ref(false);
    // (passe d'optimisation 2026-09-26) — un formateur Intl PARTAGÉ :
    // ``toLocaleTimeString`` en recrée un à chaque appel, soit 800 par rendu
    // de la console.
    let _logTsFmt = null;
    function fmtLogTs(ts) {
        if (!ts) return '';
        try {
            if (!_logTsFmt) _logTsFmt = new Intl.DateTimeFormat('fr-FR', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            return _logTsFmt.format(new Date(ts * 1000));
        } catch (_) { return ''; }
    }
    async function loadRecentLogs() {
        const t = ctx.liveLogs;
        if (!t) return;
        logsLoading.value = true;
        try {
            const f = logFilters.value;
            const qs = new URLSearchParams({ limit: '300' });
            if (f.services && f.services.length) qs.set('services', f.services.join(','));
            if (f.levels && f.levels.length) qs.set('levels', f.levels.join(','));
            if (f.categories && f.categories.length) qs.set('categories', f.categories.join(','));
            const res = await fetchAuth('/api/admin/logs/recent?' + qs.toString(), {}, true);
            if (!res || !res.ok) return;
            const items = (await res.json()).items || [];
            // Dédup par (ts, message) : le flux SSE a pu livrer les mêmes
            // lignes pendant que la requête était en vol.
            const vus = new Set((t.value || []).map(l => `${l.ts}|${l.message}`));
            const neufs = items.filter(l => !vus.has(`${l.ts}|${l.message}`));
            t.value = [...neufs, ...(t.value || [])]
                .sort((a, b) => (a.ts || 0) - (b.ts || 0))
                .slice(-800);
        } catch (_) {
        } finally {
            logsLoading.value = false;
        }
    }

    // Auto-scroll the console container when new filtered entries arrive.
    // (passe d'optimisation 2026-09-26) — surveille le TAMPON (réaffecté une
    // fois par lot) et non ``filteredLogs`` : ce watch gardait le filtre des
    // 800 lignes actif et recalculé en permanence, même onglet Journaux fermé.
    // Le défilement ne se fait que si la console est montée.
    if (vue.watch) {
        vue.watch(function() { return ctx.liveLogs && ctx.liveLogs.value; }, function() {
            if (!logAutoScroll.value || !logsConsoleRef.value) return;
            ctx.nextTick(function() {
                const el = logsConsoleRef.value;
                if (el) el.scrollTop = el.scrollHeight;
            });
        });
    }

    // ── Modale de transfert (backup / restauration / exports) ────────────
    // Règle UX : tout import/export de données admin passe par CETTE modale
    // avec progression in-app — jamais par une navigation navigateur
    // (window.open / location.href). Téléchargement = fetch streamé
    // (progression réelle si Content-Length, sinon octets seuls) puis Blob
    // → <a download> local ; upload = XMLHttpRequest (fetch ne rapporte pas
    // la progression d'envoi), cookies same-origin comme fetchAuth.
    //
    // ``waiting`` : le SERVEUR travaille et aucun octet ne circule (archive
    // en cours de compression avant l'envoi, restauration après l'upload).
    // La modale affiche alors une roue + ``waitLabel`` + le temps écoulé,
    // au lieu d'un « 0 o » figé qui laissait croire à un blocage.
    const transferModal = ref({
        active: false, mode: 'download', title: '', filename: '',
        loaded: 0, total: 0, percent: 0, indeterminate: false,
        error: null, done: false, waiting: false, waitLabel: '', elapsed: 0,
    });
    let _transferAbort = null;
    let _transferTimer = null;

    function _transferWait(label) {
        const t = transferModal.value;
        t.waiting = true; t.waitLabel = label; t.indeterminate = true; t.elapsed = 0;
        const t0 = Date.now();
        if (_transferTimer) clearInterval(_transferTimer);
        _transferTimer = setInterval(() => {
            transferModal.value.elapsed = Math.floor((Date.now() - t0) / 1000);
        }, 1000);
    }
    function _transferStopWait() {
        if (_transferTimer) { clearInterval(_transferTimer); _transferTimer = null; }
        transferModal.value.waiting = false;
    }
    /** Durée d'attente lisible : « 8 s », « 1 min 05 s ». */
    function fmtElapsed(sec) {
        sec = Math.max(0, Math.floor(Number(sec) || 0));
        if (sec < 60) return sec + ' s';
        return Math.floor(sec / 60) + ' min ' + String(sec % 60).padStart(2, '0') + ' s';
    }

    function closeTransferModal() {
        if (_transferAbort) { try { _transferAbort(); } catch (e) {} _transferAbort = null; }
        _transferStopWait();
        transferModal.value.active = false;
    }
    function _openTransfer(mode, title, filename) {
        _transferStopWait();
        transferModal.value = {
            active: true, mode, title, filename: filename || '',
            loaded: 0, total: 0, percent: 0, indeterminate: false,
            error: null, done: false, waiting: false, waitLabel: '', elapsed: 0,
        };
    }
    function _transferProgress(loaded, total) {
        const t = transferModal.value;
        t.loaded = loaded;
        if (total > 0) {
            t.total = total; t.indeterminate = false;
            t.percent = Math.min(100, (loaded / total) * 100);
        } else t.indeterminate = true;
    }
    function _transferFail(e) {
        _transferStopWait();
        if (!transferModal.value.active) return;   // modale fermée = annulation assumée
        transferModal.value.error =
            (e && e.name === 'AbortError') ? 'Annulé.' : ('Échec : ' + ((e && e.message) || e));
    }

    // ``waitLabel`` : ce que fait le serveur avant le premier octet (l'archive
    // de sauvegarde est construite ENTIÈRE avant l'envoi).
    async function downloadWithModal(url, title, fallbackName, waitLabel = 'Préparation…') {
        _openTransfer('download', title, fallbackName);
        _transferWait(waitLabel);
        const ac = new AbortController();
        _transferAbort = () => ac.abort();
        try {
            const res = await fetch(url, { credentials: 'same-origin', signal: ac.signal });
            _transferStopWait();
            if (res && res.status === 401) {
                // AUDIT 2026-08-02 (S-mineur) — fetch brut (hors fetchAuth
                // pour le streaming de progression) : le 401 s'affichait en
                // « Échec : HTTP 401 » dans la modale, sans déconnexion. On
                // route vers le traitement global de fin de session.
                transferModal.value.active = false;
                if (ctx.handleSessionExpired) ctx.handleSessionExpired();
                return;
            }
            if (!res || !res.ok) {
                // Message serveur (detail FastAPI) plutôt qu'un « HTTP 404 » nu —
                // ex. « Aucun tableau détecté dans ce document. »
                let detail = '';
                try { detail = (await res.json()).detail || ''; } catch (e) {}
                throw new Error(detail || ('HTTP ' + (res ? res.status : '?')));
            }
            const m = /filename="?([^";]+)"?/i.exec(res.headers.get('content-disposition') || '');
            if (m) transferModal.value.filename = m[1];
            const total = Number(res.headers.get('content-length') || 0);
            let blob;
            if (res.body && res.body.getReader) {
                const reader = res.body.getReader();
                const chunks = [];
                let loaded = 0;
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    loaded += value.byteLength;
                    _transferProgress(loaded, total);
                }
                blob = new Blob(chunks);
            } else {
                transferModal.value.indeterminate = true;
                blob = await res.blob();
            }
            _transferProgress(blob.size, blob.size);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = transferModal.value.filename || fallbackName || 'export.bin';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
            transferModal.value.done = true;
        } catch (e) { _transferFail(e); }
        finally { _transferAbort = null; _transferStopWait(); }
    }

    // ``waitLabel`` : affiché une fois l'envoi fini, pendant que le serveur
    // traite le fichier (restauration).
    function uploadWithModal(url, formData, title, filename, waitLabel = 'Traitement côté serveur…') {
        _openTransfer('upload', title, filename);
        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            _transferAbort = () => xhr.abort();
            xhr.open('POST', url);
            xhr.responseType = 'json';
            xhr.upload.onprogress = (e) => _transferProgress(e.loaded, e.lengthComputable ? e.total : 0);
            xhr.upload.onload = () => { if (transferModal.value.active) _transferWait(waitLabel); };
            xhr.onload  = () => {
                _transferAbort = null;
                _transferStopWait();
                // AUDIT 2026-08-02 (S-mineur) — aucun appelant ne testait le
                // 401 de ce XHR : l'upload échouait sans message ni logout.
                if (xhr.status === 401) {
                    transferModal.value.active = false;
                    if (ctx.handleSessionExpired) ctx.handleSessionExpired();
                    resolve(null);
                    return;
                }
                resolve({ status: xhr.status, data: xhr.response });
            };
            xhr.onerror = () => { _transferAbort = null; _transferFail(new Error('Erreur réseau')); resolve(null); };
            xhr.onabort = () => { _transferAbort = null; _transferStopWait(); resolve(null); };
            xhr.send(formData);
        });
    }

    async function exportMetrics(days = 7) {
        await downloadWithModal(`/api/admin/export-metrics?days=${days}`,
                                'Export des métriques', `metrics-${days}j.csv`);
    }

    async function downloadBackup(scope = 'full') {
        const label = { full: 'complète', db: 'de la base', sandboxes: 'des sandboxes', mcp: 'des serveurs MCP' }[scope] || scope;
        await downloadWithModal(`/api/admin/backup?scope=${scope}`,
                                `Sauvegarde ${label}`, `backup-${scope}.zip`, 'Compression en cours…');
    }

    // ── Sauvegarde distante (SFTP par clé / dossier monté / rsync) ─────────
    const remoteBackup = ref({
        enabled: false, connector: 'sftp', scope: 'full',
        host: '', port: 22, user: '', remote_path: '', dest_path: '',
        strict_host_key_checking: true, key_present: false, last_send: null,
        password_present: false,
        schedule_enabled: false, schedule_every: 1, schedule_unit: 'days', next_run_at: null,
    });
    const remoteKeyFp = ref('');
    const remoteBackupBusy = ref(false);
    // Mot de passe SSH du connecteur rsync : saisi ici, envoyé à part à
    // l'enregistrement, jamais relu (le serveur ne dit que s'il en existe un).
    const remoteRsyncPassword = ref('');
    function remoteDateLabel(ts) {
        if (!ts) return '';
        try {
            return new Date(Number(ts) * 1000).toLocaleString('fr-FR', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch (_) { return ''; }
    }
    // Prochain envoi automatique : calculé par le serveur (next_run_at), relu
    // après chaque enregistrement ou envoi.
    const remoteNextRunLabel = computed(() => {
        const r = remoteBackup.value;
        if (!r.schedule_enabled) return 'Envoi automatique désactivé.';
        if (!r.enabled) return 'Activez la sauvegarde distante pour planifier.';
        if (!r.next_run_at) return 'Enregistrez pour planifier.';
        if (r.next_run_at * 1000 <= Date.now() + 60000) return 'Prochain envoi : dans la minute.';
        return 'Prochain envoi : ' + remoteDateLabel(r.next_run_at) + '.';
    });
    async function loadRemoteBackup() {
        try {
            const res = await fetchAuth('/api/admin/backup/remote', {}, true);
            if (res && res.ok) {
                remoteBackup.value = await res.json();
                remoteKeyFp.value = remoteBackup.value.key_present ? 'Clé installée' : '';
            }
        } catch (e) {}
    }
    async function saveRemoteBackup() {
        remoteBackupBusy.value = true;
        try {
            const res = await fetchAuth('/api/admin/backup/remote', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(remoteBackup.value),
            });
            if (res && res.ok) {
                if (remoteBackup.value.connector === 'rsync' && remoteRsyncPassword.value) {
                    const ok = await _storeRsyncPassword(remoteRsyncPassword.value);
                    if (!ok) return;
                    remoteRsyncPassword.value = '';
                }
                showToast('Configuration enregistrée', 'success'); await loadRemoteBackup();
            }
            else showToast((await res.json().catch(() => ({}))).detail || 'Échec de l\'enregistrement', 'error');
        } catch (e) { showToast('Erreur réseau', 'error'); }
        finally { remoteBackupBusy.value = false; }
    }
    async function _storeRsyncPassword(password) {
        const res = await fetchAuth('/api/admin/backup/remote/password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        if (res && res.ok) {
            remoteBackup.value.password_present = !!(await res.json()).password_present;
            return true;
        }
        showToast((res && (await res.json().catch(() => ({}))).detail) || 'Mot de passe refusé', 'error');
        return false;
    }
    async function clearRsyncPassword() {
        remoteBackupBusy.value = true;
        try {
            if (await _storeRsyncPassword('')) showToast('Mot de passe retiré', 'success');
        } catch (e) { showToast('Erreur réseau', 'error'); }
        finally { remoteBackupBusy.value = false; }
    }
    async function uploadBackupKey(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        ev.target.value = '';
        const key = await file.text();
        remoteBackupBusy.value = true;
        try {
            const res = await fetchAuth('/api/admin/backup/remote/key', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key }),
            });
            if (res && res.ok) {
                const d = await res.json();
                remoteKeyFp.value = d.fingerprint || 'Clé installée';
                remoteBackup.value.key_present = true;
                showToast('Clé SSH installée', 'success');
            } else showToast((await res.json().catch(() => ({}))).detail || 'Clé invalide', 'error');
        } catch (e) { showToast('Erreur réseau', 'error'); }
        finally { remoteBackupBusy.value = false; }
    }
    async function testRemoteBackup() {
        remoteBackupBusy.value = true;
        try {
            await saveRemoteBackup();
            const res = await fetchAuth('/api/admin/backup/remote/test', { method: 'POST' });
            const d = res && res.ok ? await res.json() : { ok: false, error: 'Erreur serveur' };
            showToast(d.ok ? 'Connexion OK' : ('Échec : ' + (d.error || '')), d.ok ? 'success' : 'error');
        } catch (e) { showToast('Erreur réseau', 'error'); }
        finally { remoteBackupBusy.value = false; }
    }
    async function sendRemoteBackup() {
        remoteBackupBusy.value = true;
        try {
            await saveRemoteBackup();
            showToast('Envoi en cours…', 'info');
            const res = await fetchAuth('/api/admin/backup/remote/send', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: remoteBackup.value.scope }),
            });
            const d = res && res.ok ? await res.json() : { ok: false, error: 'Erreur serveur' };
            showToast(d.ok ? ('Sauvegarde envoyée : ' + (d.filename || '')) : ('Échec : ' + (d.error || '')),
                      d.ok ? 'success' : 'error');
            await loadRemoteBackup();
        } catch (e) { showToast('Erreur réseau', 'error'); }
        finally { remoteBackupBusy.value = false; }
    }

    // Périmètre choisi dans Système › Données › Zone sensible.
    const restoreScope = ref('full');
    const RESTORE_LABELS = Object.freeze({
        full: 'complète', db: 'de la base', sandboxes: 'des sandboxes', mcp: 'des serveurs MCP',
    });
    async function triggerRestore(scope) {
        const input = document.getElementById('restore-file-input');
        if (!input) return;
        input.value = '';
        const confirmed = await openTypedConfirm(
            `Restauration ${RESTORE_LABELS[scope] || scope}`,
            'Les données existantes seront remplacées par celles de l\'archive. Sans retour arrière.',
            'RESTAURER', 'Choisir l\'archive'
        );
        if (!confirmed) return;
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            input.onchange = null;
            const formData = new FormData();
            formData.append('file', file);
            formData.append('scope', scope);
            // Upload via la modale de transfert (progression d'envoi réelle).
            const r = await uploadWithModal('/api/admin/restore', formData,
                                            `Restauration ${RESTORE_LABELS[scope] || scope}`, file.name,
                                            'Restauration en cours…');
            if (!r) return;                    // annulé, ou erreur réseau déjà affichée
            if (r.status >= 200 && r.status < 300) {
                const data = r.data || {};
                transferModal.value.done = true;
                if (data.errors && data.errors.length > 0) {
                    showToast(`${data.restored} fichiers restaurés, ${data.errors.length} erreur(s)`, 'error');
                } else {
                    showToast(data.restart_required
                        ? `${data.restored} fichiers restaurés. Redémarrage conseillé.`
                        : `${data.restored} fichiers restaurés avec succès`);
                    if (scope === 'db' || scope === 'full') {
                        setTimeout(() => { window.location.reload(); }, 1500);
                    }
                }
            } else {
                transferModal.value.error =
                    (r.data && r.data.detail) || 'Erreur lors de la restauration';
            }
        };
        input.click();
    }

    async function deleteUser(u) {
        const confirmed = await openConfirm(
            `Supprimer l'utilisateur "${u.username}" ?`,
            'Cette action est irréversible. Toutes ses conversations seront supprimées.',
            true
        );
        if (!confirmed) return;

        // Second modal: ask about sandbox
        const deleteSandbox = await openConfirm(
            'Supprimer également sa sandbox ?',
            `Voulez-vous aussi supprimer tous les fichiers de la sandbox de "${u.username}" ?`,
            true,
            'Supprimer la sandbox',
            'Non, conserver'
        );

        try {
            const url = `/api/admin/users/${u.id}` + (deleteSandbox ? '?delete_sandbox=true' : '');
            const res = await fetchAuth(url, { method: 'DELETE' });
            if (res && res.ok) {
                const data = await res.json();
                if (data.sandbox_deleted) {
                    showToast(`Utilisateur et sandbox supprimés`);
                } else if (data.sandbox_error) {
                    // Docker arrêté, image absente… : le dossier reste, à supprimer
                    // une fois Docker revenu (le compte, lui, est supprimé).
                    showToast(`Utilisateur supprimé, sandbox NON supprimée : ${data.sandbox_error}`, 'warning');
                } else {
                    showToast(`Utilisateur supprimé` + (deleteSandbox ? ' (sandbox introuvable)' : ''));
                }
                loadUsers(); loadAdminStats();
            }
        } catch(e) {}
    }

    async function setUserSandboxQuota(u, newMb) {
        const mb = parseInt(newMb, 10);
        if (isNaN(mb) || mb < 0) { showToast('Quota invalide', 'error'); return; }
        try {
            const res = await fetchAuth(`/api/admin/users/${u.id}/sandbox-quota`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quota_mb: mb })
            });
            if (res && res.ok) {
                showToast(`Quota de ${u.username} : ${mb} Mo`);
                u.sandbox_quota_mb = mb;
            } else {
                const err = await res.json().catch(() => ({}));
                showToast(err.detail || 'Erreur', 'error');
            }
        } catch(e) { showToast('Erreur réseau', 'error'); }
    }

    /** Impose un profil réseau à un compte (valeur vide = choix rendu à
     *  l'utilisateur). Le conteneur en marche est détruit côté serveur si le
     *  profil effectif change — l'imposition mord tout de suite.
     *
     *  On reçoit l'ÉVÉNEMENT, pas la valeur : en cas d'annulation ou de refus
     *  serveur, remettre la propriété du modèle à son ancienne valeur ne
     *  suffit pas à re-synchroniser un <select> (le vnode n'a pas changé) —
     *  il faut réécrire ``el.value``. */
    async function setUserNetworkProfile(u, ev) {
        const el = ev && ev.target;
        const pid = String((el && el.value) || '');
        const prev = u.forced_network_profile_id || '';
        if (pid === prev) return;
        const _revert = () => { u.forced_network_profile_id = prev; if (el) el.value = prev; };
        if (pid) {
            const prof = usersNetProfiles.value.find(p => p.id === pid);
            const ok = await openConfirm(
                `Imposer « ${prof ? prof.name : pid} » à ${u.username} ?`,
                "L'utilisateur ne pourra plus changer de profil réseau, et son container sera recréé.",
                false, 'Imposer'
            );
            if (!ok) { _revert(); return; }
        }
        try {
            const res = await fetchAuth(`/api/admin/users/${u.id}/network-profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile_id: pid || null }),
            });
            if (res && res.ok) {
                const d = await res.json().catch(() => ({}));
                u.forced_network_profile_id = d.forced_network_profile_id || '';
                u.network_profile_id = d.network_profile_id || u.network_profile_id;
                showToast(pid ? `${u.username} : profil imposé` : `${u.username} : choix rendu`, 'success');
            } else {
                const err = await res.json().catch(() => ({}));
                _revert();
                showToast(err.detail || 'Erreur', 'error');
            }
        } catch(e) {
            _revert();
            showToast('Erreur réseau', 'error');
        }
    }

    async function restartServer() {
        const n = restartPending.value.length;
        const confirmed = await openConfirm('Redémarrer le serveur ?',
            (n ? `Applique ${n} réglage${n > 1 ? 's' : ''} en attente. ` : '')
            + 'Les conversations en cours se terminent avant l’arrêt ; les sessions se reconnectent seules.',
            true, 'Redémarrer');
        if (!confirmed) return;
        try { await fetchAuth('/api/admin/restart', { method: 'POST' }); } catch(e) {}
        // Afficher la modale immédiatement (sans attendre le SSE)
        ctx.systemAlert.value = 'Redémarrage du serveur. Reconnexion automatique…';
        const _tryReconnect = async (attempt) => {
            if (attempt > 20) { window.location.reload(); return; }
            try {
                const r = await fetch('/api/health', { cache: 'no-store' });
                if (r.ok) { window.location.reload(); return; }
            } catch(e) {}
            setTimeout(() => _tryReconnect(attempt + 1), 1000);
        };
        setTimeout(() => _tryReconnect(0), 6000);
    }

    // ── LLM scheduling (Performances LLM) ────────────────────────────────
    // Charge l'état actuel (mode configuré + détection). Appelé quand on
    // ouvre l'onglet Config. Mutations locales du mode configured_mode
    // n'ont effet qu'après saveLlmSchedulingMode().
    async function loadLlmScheduling() {
        try {
            const res = await fetchAuth('/api/admin/llm-capabilities');
            if (res && res.ok) {
                llmScheduling.value = await res.json();
                markAdminStoreClean('scheduling');
            }
        } catch (e) {
            console.warn('[admin] loadLlmScheduling failed', e);
        }
    }

    // Re-déclenche le probe côté backend. Utile si llama-server a redémarré
    // ou que l'utilisateur vient d'ajouter --slots à sa ligne de commande.
    async function probeLlmCapabilities() {
        if (llmSchedulingProbing.value) return;
        llmSchedulingProbing.value = true;
        try {
            const res = await fetchAuth('/api/admin/llm-capabilities/probe', { method: 'POST' });
            if (res && res.ok) {
                const data = await res.json();
                if (llmScheduling.value) {
                    llmScheduling.value.capabilities = data.capabilities || {};
                }
                showToast?.('Capacités llama re-détectées', 'success');
            } else {
                showToast?.('Erreur lors du probe', 'error');
            }
            // Recharge aussi le mode effectif (peut changer si on était en "auto")
            await loadLlmScheduling();
        } catch (e) {
            showToast?.('Erreur: ' + (e?.message || e), 'error');
        } finally {
            llmSchedulingProbing.value = false;
        }
    }

    // Persiste le mode choisi en radio. Hot-reload côté backend :
    // prochaine requête LLM utilisera le nouveau mode, pas besoin de reboot.
    // Renvoie true/false : c'est saveAdminPage() qui affiche le bilan, un
    // toast par bloc en produirait quatre pour un seul clic.
    async function saveLlmSchedulingMode() {
        if (!llmScheduling.value || llmSchedulingSaving.value) return false;
        llmSchedulingSaving.value = true;
        try {
            const mode = llmScheduling.value.configured_mode;
            const res = await fetchAuth('/api/admin/llm-scheduling-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode })
            });
            if (res && res.ok) {
                const data = await res.json();
                llmScheduling.value.configured_mode = data.configured_mode;
                llmScheduling.value.effective_mode = data.effective_mode;
                return true;
            }
            return false;
        } catch (e) {
            return false;
        } finally {
            llmSchedulingSaving.value = false;
        }
    }

    // ── Compression conversationnelle (config admin) ────────────────────
    async function loadCompressionCfg() {
        try {
            const res = await fetchAuth('/api/admin/compression-config');
            if (res && res.ok) {
                compressionCfg.value = await res.json();
                markAdminStoreClean('compression');
            }
        } catch (e) {
            console.warn('[admin] loadCompressionCfg failed', e);
        }
    }

    async function saveCompressionCfg() {
        if (!compressionCfg.value || compressionSaving.value) return false;
        compressionSaving.value = true;
        try {
            const res = await fetchAuth('/api/admin/compression-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(compressionCfg.value),
            });
            if (res && res.ok) {
                compressionCfg.value = await res.json();
                return true;
            }
            return false;
        } catch (e) {
            return false;
        } finally {
            compressionSaving.value = false;
        }
    }

    async function loadAdminConfig(type) {
        if (type !== 'main') return; // RAG is now inside main config
        // Anti-clobber : le watch (app.js) rappelle loadAdminConfig à CHAQUE
        // entrée sur l'onglet Config. Si le formulaire diffère du dernier état
        // chargé/sauvé (= édits non sauvegardés en cours), on les PRÉSERVE au
        // lieu de les écraser. 1er chargement (configForm null) ou retour sans
        // édit → rechargement normal (rafraîchit d'éventuels changements externes).
        if (configForm.value && adminPristine.value.config !== null
            && JSON.stringify(configForm.value) !== adminPristine.value.config) {
            return;
        }
        try {
            const res = await fetchAuth(`/api/admin/config-file?type=${type}`);
            if (res && res.ok) {
                const data = await res.json();
                    try {
                        // Copie de ce qui est SUR DISQUE, avant tout défaut
                        // rempli côté client : c'est la valeur « from » du PATCH.
                        try { _configRaw = JSON.parse(data.content) || {}; } catch (_) { _configRaw = {}; }
                        configForm.value = JSON.parse(data.content);
                        // Welcome defaults — couleurs/fond retirés (suivent le
                        // skin), espacements retirés (figés dans chat.html) ;
                        // restent : type, icône, taille. Les clés gap_* d'anciens
                        // configs sont purgées pour que la prochaine sauvegarde
                        // persiste un bloc propre.
                        if (!configForm.value.welcome) {
                            configForm.value.welcome = { type: 'icon', icon: 'ph-sparkle', width: 96, height: 96, image_b64: '' };
                        } else {
                            if (!configForm.value.welcome.width) configForm.value.welcome.width = 96;
                            if (!configForm.value.welcome.height) configForm.value.welcome.height = 96;
                            delete configForm.value.welcome.gap_text;
                            delete configForm.value.welcome.gap_bottom;
                            delete configForm.value.welcome.bg_color;
                            delete configForm.value.welcome.icon_bg;
                            delete configForm.value.welcome.text_color;
                            // Strip color class from icon name if present
                            if (configForm.value.welcome.icon && configForm.value.welcome.icon.includes(' ')) {
                                configForm.value.welcome.icon = configForm.value.welcome.icon.split(' ')[0] || 'ph-sparkle';
                            }
                        }
                        /* Mot animé : la typo et les DEUX échelles. Bloc à part
                         * du type icône/image — il ne s'affiche pas à leur
                         * place, mais quand l'UTILISATEUR a choisi une mascotte
                         * dans ses réglages ; l'admin n'en règle que le style.
                         * Normalisé ici pour que la carte s'affiche aussi sur
                         * un config.json antérieur, où la clé n'existe pas. */
                        const _sc = configForm.value.welcome.scene || {};
                        const _tous = ['boite_or','flamme','flamme_bleue',
                                       'fantome','elpis'];
                        const _act = (_sc.mascottes_actives || []).filter(
                            m => _tous.includes(m));
                        configForm.value.welcome.scene = {
                            // L'INTERRUPTEUR MAÎTRE. `!== false` et non
                            // `|| true` : la clé absente vaut ALLUMÉ, c'est le
                            // comportement d'avant ce réglage, et une config
                            // antérieure ne doit pas voir ses mascottes
                            // disparaître au premier chargement de la console.
                            mascottes_on: _sc.mascottes_on !== false,
                            motif:        _sc.motif || 'or',
                            word_scale:   Number(_sc.word_scale)   || 1,
                            mascot_scale: Number(_sc.mascot_scale) || 0.78,
                            // Repli sur TOUT actif : une config antérieure à ce
                            // réglage ne doit pas se retrouver sans mascotte.
                            mascottes_actives: _act.length ? _act : _tous,
                            mascotte_defaut: _sc.mascotte_defaut || 'boite_or',
                        };
                        // Entretien : heure de passe + rétentions (jours ; 0 = sans
                        // limite). Défauts = ceux de shared_infra/config.py ; le
                        // PATCH n'écrit que les champs réellement modifiés.
                        {
                            const m = configForm.value.maintenance = configForm.value.maintenance || {};
                            const _md = { hour: 6, metrics_retention_days: 90, usage_events_retention_days: 180,
                                          session_messages_retention_days: 180, tool_metrics_retention_days: 90,
                                          routine_runs_retention_days: 180, daily_report_retention_days: 400 };
                            Object.keys(_md).forEach(k => { if (m[k] === undefined || m[k] === null) m[k] = _md[k]; });
                        }
                        // Security defaults
                        if (!configForm.value.security) configForm.value.security = {};
                        if (!configForm.value.security.password_policy) {
                            configForm.value.security.password_policy = { min_length: 0, require_uppercase: false, require_lowercase: false, require_numbers: false, require_special: false };
                        }
                        // Login page defaults
                        if (!configForm.value.login_page) {
                            configForm.value.login_page = { title:'Connexion', subtitle:'', icon_type:'phosphor', icon:'ph-robot', icon_color:'#ffffff', icon_bg:'#2563eb', logo_b64:'', bg_color:'#ffffff', card_color:'#ffffff', text_color:'#0f172a', btn_color:'#0f172a' };
                        } else {
                            if (!configForm.value.login_page.icon) configForm.value.login_page.icon = 'ph-robot';
                            if (!configForm.value.login_page.icon_color) configForm.value.login_page.icon_color = '#ffffff';
                            if (!configForm.value.login_page.icon_bg) configForm.value.login_page.icon_bg = '#2563eb';
                            if (!configForm.value.login_page.bg_color) configForm.value.login_page.bg_color = '#ffffff';
                            if (!configForm.value.login_page.card_color) configForm.value.login_page.card_color = '#ffffff';
                            if (!configForm.value.login_page.text_color) configForm.value.login_page.text_color = '#0f172a';
                            if (!configForm.value.login_page.btn_color) configForm.value.login_page.btn_color = '#0f172a';
                        }
                        // App info defaults
                        if (!configForm.value.app_info) {
                            configForm.value.app_info = { name: 'Elpis', version: '1.0.0', team_name: '', engine: 'llama.cpp', description: '', icon_type: 'phosphor', icon: 'ph-robot', icon_color: '#ffffff', icon_bg: '#0f172a', logo_b64: '', use_welcome_image: false };
                        } else {
                            if (!configForm.value.app_info.icon) configForm.value.app_info.icon = 'ph-robot';
                            if (!configForm.value.app_info.icon_color) configForm.value.app_info.icon_color = '#ffffff';
                            if (!configForm.value.app_info.icon_bg) configForm.value.app_info.icon_bg = '#0f172a';
                            if (!configForm.value.app_info.engine) configForm.value.app_info.engine = 'llama.cpp';
                            if (configForm.value.app_info.description === undefined) configForm.value.app_info.description = '';
                        }
                        // Llama defaults
                        if (configForm.value.llama) {
                            // Type du moteur LOCAL : llamacpp (défaut, optimisé) | vllm | generic.
                            if (configForm.value.llama.engine === undefined) configForm.value.llama.engine = 'llamacpp';
                            if (configForm.value.llama.url === undefined) configForm.value.llama.url = '';
                            if (configForm.value.llama.model === undefined) configForm.value.llama.model = 'local-model';
                            if (configForm.value.llama.retries === undefined) configForm.value.llama.retries = 1;
                            if (configForm.value.llama.retry_backoff_sec === undefined) configForm.value.llama.retry_backoff_sec = 0.6;
                            if (configForm.value.llama.max_concurrency === undefined) configForm.value.llama.max_concurrency = 3;
                            if (configForm.value.llama.max_models === undefined) configForm.value.llama.max_models = 1;
                            if (configForm.value.llama.n_ctx === undefined) configForm.value.llama.n_ctx = 4096;
                        }
                        // MCP defaults. Le bloc est désormais amorcé même absent :
                        // la page « Connexions » lui consacre une section, une
                        // carte vide serait illisible (avant, la section était
                        // simplement masquée au fond de « Réglages »).
                        if (!configForm.value.mcp) configForm.value.mcp = {};
                        if (configForm.value.mcp.server_cmd === undefined) configForm.value.mcp.server_cmd = '';
                        if (configForm.value.mcp.servers_dir === undefined) configForm.value.mcp.servers_dir = '../mcp_custom_servers';
                        if (configForm.value.mcp.tools_cache_ttl_sec === undefined) configForm.value.mcp.tools_cache_ttl_sec = 0;
                        // Jetons d'outils externes (EXT.1) — mêmes défauts que tokens.policy().
                        if (!configForm.value.mcp.tokens) configForm.value.mcp.tokens = {};
                        {
                            const _t = configForm.value.mcp.tokens;
                            if (_t.tools_enabled === undefined) _t.tools_enabled = true;
                            if (_t.tools_families === undefined) _t.tools_families = 'fs,shell,git,desktop,browser,skill_run';
                            if (_t.max_days === undefined) _t.max_days = 90;
                            if (_t.max_per_user === undefined) _t.max_per_user = 20;
                        }
                        // Autorisation OAuth des clients MCP (EXT.4) — mêmes défauts que oauth.policy().
                        if (!configForm.value.mcp.oauth) configForm.value.mcp.oauth = {};
                        {
                            const _o = configForm.value.mcp.oauth;
                            if (_o.enabled === undefined) _o.enabled = true;
                            if (_o.dcr_enabled === undefined) _o.dcr_enabled = true;
                            if (_o.access_ttl_s === undefined) _o.access_ttl_s = 3600;
                            if (_o.refresh_days === undefined) _o.refresh_days = 30;
                        }
                        // RAG defaults — même raison.
                        if (!configForm.value.rag) configForm.value.rag = {};
                        if (configForm.value.rag.service_url === undefined) configForm.value.rag.service_url = '';
                        if (configForm.value.rag.service_token === undefined) configForm.value.rag.service_token = '';
                        if (configForm.value.rag.service_timeout === undefined) configForm.value.rag.service_timeout = 60;
                        // App defaults
                        if (configForm.value.app) {
                            if (configForm.value.app.upload_dir === undefined) configForm.value.app.upload_dir = 'user_db/uploads';
                            if (configForm.value.app.sandbox_dir === undefined) configForm.value.app.sandbox_dir = '../user_sandboxes';
                        }
                        // Features defaults (toggles globaux) — activé par défaut (rétro-compat).
                        if (!configForm.value.features) configForm.value.features = {};
                        if (configForm.value.features.opencode === undefined) configForm.value.features.opencode = true;
                        if (configForm.value.features.office_preview === undefined) configForm.value.features.office_preview = true;
                        // Cookies & sessions defaults — fill missing keys so the
                        // form doesn't show "undefined" placeholders before the
                        // first save. Pre-existing keys are left untouched so
                        // the operator's overrides survive.
                        if (!configForm.value.security) configForm.value.security = {};
                        if (!configForm.value.security.session) {
                            configForm.value.security.session = {
                                max_age_sec: 86400, idle_timeout_sec: 0,
                                cookie_name: 'mcpwebui_session',
                                same_site: 'lax', https_only: false,
                                global_min_ts: 0,
                            };
                        } else {
                            const s = configForm.value.security.session;
                            if (s.max_age_sec === undefined)      s.max_age_sec      = 86400;
                            if (s.idle_timeout_sec === undefined) s.idle_timeout_sec = 0;
                            if (s.cookie_name === undefined)      s.cookie_name      = 'mcpwebui_session';
                            if (s.same_site === undefined)        s.same_site        = 'lax';
                            if (s.https_only === undefined)       s.https_only       = false;
                            if (s.global_min_ts === undefined)    s.global_min_ts    = 0;
                        }
                        // NOTE: ``security.login.*`` (rate-limit policy) was
                        // removed in v3.4 along with the rate-limiter itself.
                        // We don't seed defaults so saving the form doesn't
                        // re-introduce the now-unused keys into config.json.
                        // Existing keys in user config files are simply
                        // ignored by the auth module.
                        // Vision & Desktop defaults (annotation endpoint + control
                        // agents) — seed so the form never shows "undefined".
                        if (!configForm.value.vision) {
                            configForm.value.vision = { endpoint_url: '', format: 'omniparser', prompt: '', model: '', passes: 2 };
                        } else {
                            const v = configForm.value.vision;
                            if (v.endpoint_url === undefined) v.endpoint_url = '';
                            if (v.format       === undefined) v.format       = 'omniparser';
                            if (v.prompt       === undefined) v.prompt       = '';
                            if (v.model        === undefined) v.model        = '';
                            if (v.passes       === undefined) v.passes       = 2;
                        }
                        // Moteur vocal — deux sous-objets, amorcés séparément :
                        // une instance peut n'avoir que la dictée, ou que la lecture.
                        if (!configForm.value.voice) configForm.value.voice = {};
                        const _vx = configForm.value.voice;
                        if (_vx.enabled === undefined) _vx.enabled = false;
                        if (!_vx.stt) _vx.stt = {};
                        if (!_vx.tts) _vx.tts = {};
                        const _vdef = {
                            // ⚠ Miroir de shared_infra/voice/config.py : un défaut
                            // qui diverge ici s'ÉCRIT au premier « Enregistrer »
                            // (logprob_min -0,6 rejetait des phrases réelles).
                            stt: { endpoint_url: '', format: 'whisper.cpp', model: '', language: 'fr',
                                   prompt: '', token: '', logprob_min: -1.0, timeout_sec: 30,
                                   max_upload_mb: 10, max_utterance_sec: 30, max_concurrent: 1,
                                   verify: true },
                            tts: { endpoint_url: '', format: 'elpis-tts', token: '', model: '',
                                   voice: 'fr_FR-siwis-medium', speed: 1.0, timeout_sec: 30,
                                   max_chars: 4000, max_concurrent: 2, verify: true },
                        };
                        for (const _sect of ['stt', 'tts']) {
                            for (const _k in _vdef[_sect]) {
                                if (_vx[_sect][_k] === undefined) _vx[_sect][_k] = _vdef[_sect][_k];
                            }
                        }
                        // Les modèles et voix ne se saisissent pas : on lit ce
                        // que chaque serveur a chargé au démarrage.
                        if (typeof loadVoiceModels === 'function') {
                            setTimeout(function () { loadVoiceModels('stt'); loadVoiceModels('tts'); }, 0);
                        }
                        if (!configForm.value.desktop) configForm.value.desktop = { targets: [] };
                        if (!Array.isArray(configForm.value.desktop.targets)) configForm.value.desktop.targets = [];
                        if (configForm.value.desktop.screenshot_format === undefined) configForm.value.desktop.screenshot_format = 'png';
                        if (configForm.value.desktop.screenshot_quality === undefined) configForm.value.desktop.screenshot_quality = 85;
                    } catch(e) { configForm.value = {}; }
                    // Baseline « propre » APRÈS remplissage des défauts : toute
                    // divergence ultérieure = édit utilisateur non sauvegardé.
                    markAdminStoreClean('config');
            }
        } catch(e) {}
        // ── Side-fetches for the Cookies & sessions section ──────────
        // Refresh the overview (counts of revoked users, current
        // session_cfg, etc.). Failure is silent — the panel just shows
        // "—" instead of stats.
        loadSecurityOverview();
        // Panneau « Accès HTTPS » : état du toggle + sondes Caddy.
        loadHttpsStatus();
    }

    // ── Vision & Desktop — control-agent target rows ───────────────────
    // Editable add/remove list bound to configForm.desktop.targets. A single
    // "default" target is enforced by setDefaultTarget. Saved via the normal
    // "Sauvegarder" action (saveAdminConfig POSTs the whole configForm).
    function addDesktopTarget() {
        if (!configForm.value.desktop) configForm.value.desktop = { targets: [] };
        if (!Array.isArray(configForm.value.desktop.targets)) configForm.value.desktop.targets = [];
        configForm.value.desktop.targets.push({ name: '', os: 'win', agent_url: '', default: false, access: 'all', allowed_users: [] });
    }
    function removeDesktopTarget(i) {
        if (configForm.value.desktop && Array.isArray(configForm.value.desktop.targets)) {
            configForm.value.desktop.targets.splice(i, 1);
        }
    }
    function setDefaultTarget(i) {
        if (configForm.value.desktop && Array.isArray(configForm.value.desktop.targets)) {
            configForm.value.desktop.targets.forEach((t, j) => { t.default = (j === i); });
        }
    }
    // les routes /api/desktop/* ne vivent que sur le
    // process PRINCIPAL (:8001) : en mode split, la console admin tourne sur
    // :8002 et les URLs relatives / window.location.origin produisaient des
    // 404. On préfère donc `mainAppUrl` (public-config → URL du process
    // main), avec repli sur l'origine courante (mode embarqué : même process).
    const _installBase = computed(() => {
        const main = ctx.mainAppUrl && ctx.mainAppUrl.value;
        return (typeof main === 'string' && main) ? main.replace(/\/+$/, '') : window.location.origin;
    });
    // Download the desktop-agent/ bundle (zip) from the server, ready to run on
    // a target machine. EXCEPTION à la règle « modale de transfert » : endpoint
    // PUBLIC potentiellement cross-origin (_installBase = autre machine) — un
    // fetch serait bloqué par CORS là où la navigation passe. window.open gardé.
    function downloadAgentBundle() {
        window.open(_installBase.value + '/api/desktop/agent-bundle', '_blank');
    }
    // One-command install lines shown in the admin; the TARGET machine runs them.
    // The install scripts + bundle are public so a cookie-less VM can fetch them.
    //
    // AMORÇAGE EN CLAIR (:80) quand l'app est derrière le frontal TLS : la VM
    // cible ne connaît pas encore la CA locale (cert LAN auto-signé), donc en
    // https il fallait neutraliser la vérification AVANT de télécharger le
    // script — préambule PowerShell de ~400 caractères (TLS 1.2 forcé + callback
    // C# compilé), long et cassant selon la version de .NET. Caddy sert ces
    // routes publiques en clair (deploy/caddy › @bootstrap) → commande triviale.
    const _bootBase = computed(() => {
        const b = _installBase.value;
        try {
            return b.startsWith('https:') ? 'http://' + new URL(b).hostname : b;
        } catch (e) { return b; }
    });
    const installShCmd  = computed(() => 'curl -fsSL ' + _bootBase.value + '/agent | bash');
    // irm (Invoke-RestMethod) plutôt que iwr : jamais de moteur de parsing HTML
    // d'IE dans la boucle — rien à configurer sur un Windows vierge.
    const installPs1Cmd = computed(() => 'iex(irm ' + _bootBase.value + '/agent.ps1)');
    function copyInstallCmd(cmd) {
        try { navigator.clipboard.writeText(cmd); showToast('Commande copiée'); }
        catch (e) { showToast('Copie impossible', 'error'); }
    }

    // Écriture de config.json. Renvoie true/false ; c'est saveAdminPage() qui
    // affiche le bilan. Plus de openConfirm ici : l'écriture n'est ni
    // destructive ni irréversible, et l'indicateur « N modifications » + le
    // bouton explicite portent déjà l'intention — une confirmation à chaque
    // sauvegarde n'ajoutait qu'un clic.
    // Écriture de config.json CHAMP PAR CHAMP (PATCH /api/admin/config) :
    // seuls les champs modifiés partent, chacun avec la valeur lue sur disque
    // au chargement. Un champ changé ailleurs entre-temps → 409 : on propose
    // de reprendre la valeur du serveur ou d'écraser.
    let _configRaw = {};
    function _patchRaw(path, value) { _setPath(_configRaw, path, value); }
    async function _saveConfigStore(force) {
        if (isSavingAdminConfig.value) return false;
        if (!configForm.value || adminPristine.value.config == null) return false;
        const diff = _diffLeaves(JSON.parse(adminPristine.value.config), configForm.value);
        if (!diff.length) return true;
        const changes = diff.map(function (d) {
            const c = { path: d.path };
            if (d.removed) c.delete = true; else c.to = d.after;
            const r = _digPath(_configRaw, d.path);
            if (r.found) c.from = r.value; else c.from_absent = true;
            return c;
        });
        isSavingAdminConfig.value = true;
        let res = null;
        try {
            res = await fetchAuth('/api/admin/config', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(force === true ? { changes, force: true } : { changes }),
            });
        } catch (_) { res = null; }
        finally { isSavingAdminConfig.value = false; }
        if (!res) return false;
        if (res.ok) {
            for (const c of changes) _patchRaw(c.path, c.delete ? undefined : c.to);
            ctx.loadPublicConfig();
            // Un réglage lu au démarrage vient peut-être de changer : la barre
            // « Redémarrage nécessaire » le dira.
            loadRestartStatus();
            return true;
        }
        let body = {};
        try { body = await res.json(); } catch (_) {}
        if (res.status === 409 && Array.isArray(body.conflicts) && body.conflicts.length) {
            const names = body.conflicts.map(c => adminChangeLabel({ store: 'config', path: c.path })).join(', ');
            const choice = await ctx.openChoice(
                'Modifié ailleurs entre-temps',
                names + ' : la valeur a changé sur le serveur depuis l’ouverture de la page.',
                [{ id: 'force', label: 'Écraser', tone: 'danger' },
                 { id: 'reload', label: 'Reprendre la valeur du serveur', tone: 'primary' }],
                'Annuler');
            if (choice === 'force') return _saveConfigStore(true);
            if (choice === 'reload') {
                // On adopte la valeur du serveur pour les champs en conflit ;
                // les autres modifications restent en attente d'enregistrement.
                const pristine = JSON.parse(adminPristine.value.config);
                for (const c of body.conflicts) {
                    const v = c.absent ? undefined : c.current;
                    _setPath(configForm.value, c.path, v);
                    _setPath(pristine, c.path, v);
                    _patchRaw(c.path, v);
                }
                adminPristine.value.config = JSON.stringify(pristine);
            }
            return false;
        }
        if (body && body.detail) showToast(typeof body.detail === 'string' ? body.detail : 'Enregistrement refusé', 'error');
        return false;
    }

    function handleLoginLogoUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            if (!configForm.value.login_page) return;
            configForm.value.login_page.logo_b64 = e.target.result;
            configForm.value.login_page.icon_type = 'image';
        };
        reader.readAsDataURL(file);
    }

    function handleAppInfoLogoUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            if (!configForm.value.app_info) return;
            configForm.value.app_info.logo_b64 = e.target.result;
            configForm.value.app_info.use_welcome_image = false;
        };
        reader.readAsDataURL(file);
    }

    function handleAdminWelcomeUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 1024 * 1024) showToast("L'image est un peu lourde (>1Mo).", 'warning');
        const reader = new FileReader();
        reader.onload = (e) => {
            if (!configForm.value.welcome) configForm.value.welcome = { type: 'image', icon: 'ph-sparkle text-blue-500', width: 96, height: 96, image_b64: '' };
            configForm.value.welcome.image_b64 = e.target.result;
            configForm.value.welcome.type = 'image';
        };
        reader.readAsDataURL(file);
    }

    /* ────────────────────────────────────────────────────────────────────
     *  Aperçu VIVANT du mot animé, dans la carte « Écran d'accueil ».
     *
     *  Un formulaire qui demande « taille du mot : 115 % » sans rien montrer
     *  n'est pas réglable : on enregistre, on va voir, on revient. Ici la
     *  vraie scène tourne dans la carte, à la taille du bloc réel, et suit
     *  les trois champs au fur et à mesure.
     *
     *  Le module est chargé À LA DEMANDE : la console admin n'a aucune raison
     *  de télécharger le moteur d'accueil tant qu'on n'ouvre pas cet onglet.
     * ──────────────────────────────────────────────────────────────────── */
    const BASE_MASCOTTE = '/static/assets/mascotte/';
    // Les quatre en rotation (PERSOS dans accueil.js). Recopiés plutôt
    // qu'importés : la liste ne sert ici qu'à peupler un sélecteur, et la
    // console admin ne doit pas charger le moteur pour afficher un formulaire.
    /* Le jeu COMPLET : le registre UNIQUE assets/mascotte/mascottes.json
     * (2026-09-28), lu en statique — le serveur valide avec le même fichier.
     * L'admin choisit ce qu'il en publie. Repli sur les cinq d'origine tant
     * que le fichier n'est pas arrivé (ou s'il est illisible). */
    const MASCOTTES_ADMIN = ref([
        { id: 'boite_or',     label: 'Coffre'            },
        { id: 'flamme',       label: 'Flamme'            },
        { id: 'flamme_bleue', label: 'Flamme bleue', apercu: false },
        { id: 'fantome',      label: 'Fantôme'           },
        { id: 'elpis',        label: 'Elpis'             },
    ]);
    (async () => {
        try {
            const r = await fetch(BASE_MASCOTTE + 'mascottes.json', { credentials: 'same-origin' });
            const d = r.ok ? await r.json() : null;
            const l = d && Array.isArray(d.mascottes) ? d.mascottes.filter(m => m && m.id) : [];
            if (l.length) MASCOTTES_ADMIN.value = l;
        } catch (_) { /* repli ci-dessus */ }
    })();

    function mascotteActive(id) {
        const sc = configForm.value && configForm.value.welcome
                 && configForm.value.welcome.scene;
        return !!sc && (sc.mascottes_actives || []).includes(id);
    }

    /* Décocher la DERNIÈRE mascotte est refusé : plus aucune n'étant
     * disponible, tout le monde retomberait sur le logo sans qu'aucun message
     * ne l'explique. Et décocher celle qui sert de défaut déplace le défaut —
     * un défaut désactivé est un réglage qui ment. */
    function basculerMascotte(id) {
        const sc = configForm.value.welcome.scene;
        const a = new Set(sc.mascottes_actives || []);
        if (a.has(id)) {
            if (a.size <= 1) {
                showToast('Il faut en garder au moins une active.', 'warning');
                return;
            }
            a.delete(id);
        } else {
            a.add(id);
        }
        sc.mascottes_actives = MASCOTTES_ADMIN.value
            .map(m => m.id).filter(x => a.has(x));
        if (!a.has(sc.mascotte_defaut)) sc.mascotte_defaut = sc.mascottes_actives[0];
    }

    // Les personnages de l'aperçu : ceux du registre que la scène fait
    // tourner (« apercu »: false les écarte).
    const MASCOTTES_APERCU = computed(() => MASCOTTES_ADMIN.value.filter(m => m.apercu !== false));
    const apercuAccueil = ref(null);       // <div ref="apercuAccueil">
    const apercuPerso = ref('boite_or');   // sur quel personnage on juge
    let sceneApercu = null, montageApercu = 0;

    async function _monterApercuAccueil() {
        const hote = apercuAccueil.value;
        const sc = configForm.value && configForm.value.welcome
                 && configForm.value.welcome.scene;
        if (!hote || !sc) return;
        const jeton = ++montageApercu;
        let mod;
        try {
            mod = await import(BASE_MASCOTTE + 'accueil.js');
        } catch (e) {
            console.error('[admin] accueil.js illisible :', e);
            return;
        }
        if (jeton !== montageApercu) return;
        sceneApercu?.detruire();
        sceneApercu = mod.montrerAccueil(hote, {
            base: BASE_MASCOTTE,
            perso: apercuPerso.value,
            motif: sc.motif || 'or',
            scenario: 'vol',
            intro: false,
            // L'aperçu anime TOUJOURS : on règle une taille, pas une
            // préférence d'accessibilité, et une image fixe ne dirait pas si
            // la mascotte sort du cadre en sautant.
            mouvement: 'toujours',
            echelleMot: Number(sc.word_scale) || 1,
            echellePerso: Number(sc.mascot_scale) || 0.78,
        });
    }

    watch(apercuAccueil, (h) => {
        if (h) _monterApercuAccueil();
        else { sceneApercu?.detruire(); sceneApercu = null; }
    });
    // Remonter à CHAQUE réglage : les échelles sont lues à la construction
    // (elles décident de la hauteur de scène, donc de `k`).
    watch(() => {
        const sc = configForm.value && configForm.value.welcome
                 && configForm.value.welcome.scene;
        return sc ? `${sc.motif}|${sc.word_scale}|${sc.mascot_scale}|${apercuPerso.value}`
                  : '';
    }, () => { if (apercuAccueil.value) _monterApercuAccueil(); });

    function openResetModal(u) { resetTarget.value = u; newPasswordInput.value = ''; }

    async function confirmReset() {
        if (!resetTarget.value || !newPasswordInput.value) return;
        try {
            const res = await fetchAuth('/api/admin/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_id: resetTarget.value.id, new_password: newPasswordInput.value })
            });
            if (res && res.ok) {
                showToast('Ok');
                resetTarget.value = null;
            } else {
                const err = await res.json();
                showToast(err.detail || 'Erreur', 'error');
            }
        } catch(e) {}
    }

    const groupsList = ref([]);
    const allUsersWithGroups = ref([]);
    const groupModal = ref({ show: false, isEdit: false, id: null, name: '', description: '',
                             ..._admLlmAccessForm(null, null) });
    const groupMembersModal = ref({ show: false, group: null });

    // ── Accès aux serveurs d'inférence (lot B4, 2026-09-16) ────────────────
    // Serveurs utilisables + droit de charger/décharger les modèles, réglés
    // sur un COMPTE (modale « groupes » de l'utilisateur, devenue sa modale
    // d'accès) ou sur un GROUPE (modale d'édition du groupe). Résolution côté
    // serveur (shared_infra/llm/engine_access.py) : liste du compte > union
    // des groupes > tous ; admin = tout. On réutilise ces deux modales plutôt
    // que d'en ouvrir une troisième : Échap, piège Tab et restitution du focus
    // y sont déjà câblés (cascade d'app.js).
    //
    // Formulaire : ``engineMode`` ∈ inherit | all | list (``inherit`` = null
    // côté API, ``all`` = ["*"]) ; ``manage`` ∈ inherit | allow | deny.
    const admLlmAccessOptions = ref([]);
    let _admLlmAccessOptionsLoaded = false;

    function _admLlmAccessForm(keys, manage) {
        const k = Array.isArray(keys) ? keys : null;
        const engineMode = k === null ? 'inherit' : (k.includes('*') ? 'all' : 'list');
        return {
            engineMode,
            engineKeys: k ? k.filter(x => x !== '*') : [],
            manage: manage === true ? 'allow' : (manage === false ? 'deny' : 'inherit'),
            _origKeys: k ? JSON.stringify(k) : null,
            _origManage: manage === true || manage === false ? manage : null,
        };
    }

    function _admLlmAccessPayload(m) {
        const keys = m.engineMode === 'inherit' ? null
            : (m.engineMode === 'all' ? ['*'] : m.engineKeys.filter(x => x !== '*'));
        const manage = m.manage === 'allow' ? true : (m.manage === 'deny' ? false : null);
        const changed = (keys === null ? null : JSON.stringify(keys)) !== m._origKeys
            || manage !== m._origManage;
        return { body: { engine_keys: keys, can_manage_models: manage }, changed };
    }

    async function loadAdmLlmAccessOptions(force) {
        if (_admLlmAccessOptionsLoaded && !force) return;
        try {
            const res = await fetchAuth('/api/admin/llm/engine-options');
            if (res && res.ok) {
                admLlmAccessOptions.value = (await res.json()).engines || [];
                _admLlmAccessOptionsLoaded = true;
            }
        } catch (e) {}
    }

    const _ADM_LLM_SOURCES = {
        admin: 'Administrateur : accès complet',
        user: 'Réglé sur le compte',
        groups: 'Hérité des groupes',
        default: 'Aucune restriction',
    };

    function _admLlmEngineLabel(key) {
        const o = admLlmAccessOptions.value.find(e => e.key === key);
        return o ? o.label : key;
    }

    function admLlmAccessServersLabel(u) {
        const eff = u && u.llm_effective_engine_keys;
        if (!u || u.is_admin === 1 || eff == null) return 'Tous';
        if (!eff.length) return 'Aucun';
        const total = admLlmAccessOptions.value.length;
        return total ? `${eff.length} / ${total}` : String(eff.length);
    }

    function admLlmAccessServersTitle(u) {
        if (!u) return '';
        const src = _ADM_LLM_SOURCES[u.llm_engine_source] || '';
        const eff = u.llm_effective_engine_keys;
        if (u.is_admin === 1 || eff == null) return src;
        return src + (eff.length ? ' — ' + eff.map(_admLlmEngineLabel).join(', ') : ' — aucun serveur');
    }

    function admLlmAccessManageLabel(u) {
        return (!u || u.llm_effective_can_manage_models !== false) ? 'Oui' : 'Non';
    }

    function admLlmAccessManageTitle(u) {
        if (!u) return '';
        return 'Charger / décharger les modèles — ' + (_ADM_LLM_SOURCES[u.llm_manage_source] || '');
    }

    async function _admLlmAccessSave(url, m) {
        const { body, changed } = _admLlmAccessPayload(m);
        if (!changed) return true;
        const res = await fetchAuth(url, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (res && res.ok) return true;
        const err = res ? await res.json().catch(() => ({})) : {};
        showToast(err.detail || 'Accès aux serveurs non enregistré', 'error');
        return false;
    }

    async function loadGroups() {
        try {
            const res = await fetchAuth('/api/admin/groups');
            if (res && res.ok) groupsList.value = (await res.json()).groups || [];
        } catch(e) {}
    }

    async function loadAllUsersWithGroups() {
        try {
            const res = await fetchAuth('/api/admin/users-with-groups');
            if (res && res.ok) allUsersWithGroups.value = (await res.json()).users || [];
        } catch(e) {}
    }

    function openCreateGroup() {
        groupModal.value = { show: true, isEdit: false, id: null, name: '', description: '',
                             ..._admLlmAccessForm(null, null) };
        loadAdmLlmAccessOptions(true);
    }

    function openEditGroup(g) {
        groupModal.value = { show: true, isEdit: true, id: g.id, name: g.name, description: g.description || '',
                             ..._admLlmAccessForm(g.llm_engine_keys, g.llm_can_manage_models) };
        loadAdmLlmAccessOptions(true);
    }

    async function saveGroup() {
        const m = groupModal.value;
        if (!m.name.trim()) return;
        const url = m.isEdit ? `/api/admin/groups/${m.id}` : '/api/admin/groups';
        const method = m.isEdit ? 'PUT' : 'POST';
        try {
            const res = await fetchAuth(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: m.name.trim(), description: m.description.trim() }) });
            if (res && res.ok) {
                // Accès aux serveurs : sur l'id créé (POST) ou édité. Un refus
                // garde la modale ouverte (toast d'erreur déjà affiché).
                const created = m.isEdit ? null : await res.json().catch(() => ({}));
                const gid = m.isEdit ? m.id : (created && created.id);
                if (gid && !(await _admLlmAccessSave(`/api/admin/groups/${gid}/llm-access`, m))) {
                    await loadGroups();
                    if (!m.isEdit) groupModal.value = { ...m, isEdit: true, id: gid };
                    return;
                }
                groupModal.value.show = false;
                await loadGroups();
                await loadUsers();
                showToast(m.isEdit ? 'Groupe modifié' : 'Groupe créé');
            } else {
                const err = await res.json().catch(() => ({}));
                showToast(err.detail || 'Erreur', 'error');
            }
        } catch(e) { showToast('Erreur réseau', 'error'); }
    }

    async function confirmDeleteGroup(g) {
        const ok = await openConfirm(`Supprimer "${g.name}" ?`, `Les ${g.member_count} membre(s) seront désaffectés.`, true);
        if (!ok) return;
        try {
            const res = await fetchAuth(`/api/admin/groups/${g.id}`, { method: 'DELETE' });
            if (res && res.ok) { await loadGroups(); await loadUsers(); showToast('Groupe supprimé'); }
        } catch(e) {}
    }

    async function openGroupMembers(g) {
        groupMembersModal.value = { show: true, group: g };
        await loadAllUsersWithGroups();
    }

    function isInCurrentGroup(u) {
        const gid = groupMembersModal.value.group?.id;
        return gid ? u.group_ids.includes(gid) : false;
    }

    async function toggleMembership(u) {
        const gid = groupMembersModal.value.group?.id;
        if (!gid) return;
        const inGroup = isInCurrentGroup(u);
        const url = inGroup
            ? `/api/admin/users/${u.id}/groups`
            : `/api/admin/users/${u.id}/groups`;
        const newIds = inGroup
            ? u.group_ids.filter(x => x !== gid)
            : [...u.group_ids, gid];
        try {
            const res = await fetchAuth(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_ids: newIds }) });
            if (res && res.ok) {
                await loadAllUsersWithGroups();
                await loadGroups();
                await loadUsers();
            }
        } catch(e) {}
    }

    // ── Éditeur de compte en ligne (refonte 2026-09-23) ──────────────────
    // Remplace les contrôles semés dans la table (rôle, quota, réseau) et la
    // modale « groupes et accès » : un seul formulaire déplié sous la ligne,
    // un seul Enregistrer qui n'envoie QUE ce qui a changé, dans l'ordre
    // rôle → groupes → inférence → quota → réseau → machines.
    const userEdit = ref(null);

    const _ROLE_OF = (u) => u.is_admin === 1 ? 'admin' : (u.is_admin === 2 ? 'moderator' : 'user');
    function admRoleLabel(u) {
        return { admin: 'Administrateur', moderator: 'Modérateur', user: 'Utilisateur' }[_ROLE_OF(u)];
    }
    function admNetProfileName(id) {
        const p = usersNetProfiles.value.find(x => x.id === id);
        return p ? p.name : (id || '—');
    }
    function _admDesktopAllowed(u) {
        const ts = usersDesktopTargets.value;
        if (u.is_admin === 1) return ts.map(t => t.name);
        return ts.filter(t => t.access !== 'list' || (t.allowed_users || []).includes(u.username)).map(t => t.name);
    }
    function admDesktopLabel(u) {
        const total = usersDesktopTargets.value.length;
        if (!total) return '—';
        const n = _admDesktopAllowed(u).length;
        return n === total ? 'Toutes' : (n ? `${n} / ${total}` : 'Aucune');
    }
    function admDesktopTitle(u) {
        if (u.is_admin === 1) return 'Administrateur : toutes les machines';
        const names = _admDesktopAllowed(u);
        return names.length ? names.join(', ') : 'Aucune machine pilotable';
    }

    function _userEditSnapshot(e) {
        const p = _admLlmAccessPayload(e).body;
        return JSON.stringify({
            role: e.role, groups: [...e.groups].sort(), llm: p, quota: e.quota,
            network: e.network, desktop: [...e.desktop].sort(),
        });
    }
    // Accès par jeton du compte (jetons personnels, applications OAuth) : vue
    // de réponse à compromission, tout se coupe d'un geste.
    async function loadUserAccess(id) {
        try {
            const r = await fetchAuth(`/api/admin/users/${id}/access`, {}, true);
            const d = (r && r.ok) ? await r.json() : {};
            const access = { tokens: Array.isArray(d.tokens) ? d.tokens : [], grants: Array.isArray(d.grants) ? d.grants : [] };
            if (userEdit.value && userEdit.value.id === id) userEdit.value = { ...userEdit.value, access };
        } catch (_) { /* best-effort : la ligne reste « Chargement… » */ }
    }

    async function revokeUserAccess(u) {
        const ok = await openConfirm('Révoquer les accès par jeton ?',
            `Tous les jetons personnels et applications autorisées de ${u.username} seront révoqués.`, true, 'Révoquer');
        if (!ok) return;
        const r = await fetchAuth(`/api/admin/users/${u.id}/access/revoke`, { method: 'POST' }, true);
        if (r && r.ok) { showToast('Accès par jeton révoqués.'); loadUserAccess(u.id); }
        else showToast('Révocation impossible.', 'error');
    }

    function userEditOpen(u) { return !!(userEdit.value && userEdit.value.id === u.id); }
    function closeUserEdit() { userEdit.value = null; }
    function toggleUserEdit(u) {
        if (userEditOpen(u)) { closeUserEdit(); return; }
        const e = {
            id: u.id, user: u, saving: false,
            role: _ROLE_OF(u),
            groups: u.group_ids ? [...u.group_ids] : [],
            ..._admLlmAccessForm(u.llm_engine_keys, u.llm_can_manage_models),
            quota: Number(u.sandbox_quota_mb) || 0,
            network: u.forced_network_profile_id || '',
            desktop: usersDesktopTargets.value
                .filter(t => t.access === 'list' && (t.allowed_users || []).includes(u.username))
                .map(t => t.name),
        };
        e._orig = _userEditSnapshot(e);
        userEdit.value = e;
        loadAdmLlmAccessOptions(true);
        loadUserAccess(u.id);
        ctx.nextTick(() => {
            const el = document.querySelector(`#user-edit-${u.id} [data-user-edit-first]`)
                || document.querySelector(`#user-edit-${u.id} input, #user-edit-${u.id} select`);
            if (el && !el.disabled) el.focus();
        });
    }
    const userEditDirty = computed(() => !!userEdit.value && _userEditSnapshot(userEdit.value) !== userEdit.value._orig);

    async function _userEditCall(url, method, body, what) {
        const res = await fetchAuth(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (res && res.ok) return res;
        const err = res ? await res.json().catch(() => ({})) : {};
        showToast(err.detail || `${what} : échec`, 'error');
        return null;
    }

    async function saveUserEdit() {
        const e = userEdit.value;
        if (!e || e.saving || !userEditDirty.value) return;
        const u = e.user;
        const o = JSON.parse(e._orig);
        const quota = parseInt(e.quota, 10);
        if (isNaN(quota) || quota < 0) { showToast('Quota invalide', 'error'); return; }
        if (e.network && e.network !== o.network) {
            const prof = usersNetProfiles.value.find(p => p.id === e.network);
            const ok = await openConfirm(
                `Imposer « ${prof ? prof.name : e.network} » à ${u.username} ?`,
                'Son profil réseau sera verrouillé et son conteneur recréé.', false, 'Imposer');
            if (!ok) return;
        }
        e.saving = true;
        const base = `/api/admin/users/${u.id}`;
        let ok = true;
        try {
            if (ok && e.role !== o.role)
                ok = !!(await _userEditCall(`${base}/role`, 'POST', { role: e.role }, 'Rôle'));
            if (ok && JSON.stringify([...e.groups].sort()) !== JSON.stringify(o.groups))
                ok = !!(await _userEditCall(`${base}/groups`, 'PUT', { group_ids: e.groups }, 'Groupes'));
            if (ok) ok = await _admLlmAccessSave(`${base}/llm-access`, e);
            if (ok && quota !== o.quota)
                ok = !!(await _userEditCall(`${base}/sandbox-quota`, 'POST', { quota_mb: quota }, 'Quota'));
            if (ok && e.network !== o.network)
                ok = !!(await _userEditCall(`${base}/network-profile`, 'POST', { profile_id: e.network || null }, 'Réseau'));
            if (ok && JSON.stringify([...e.desktop].sort()) !== JSON.stringify(o.desktop)) {
                const r = await _userEditCall(`${base}/desktop-targets`, 'PUT', { targets: e.desktop }, 'Machines');
                ok = !!r;
                if (r) _syncDesktopForm((await r.json().catch(() => ({}))).desktop_targets);
            }
        } catch (_) {
            ok = false;
            showToast('Erreur réseau', 'error');
        }
        e.saving = false;
        await loadUsers();
        if (ok) { closeUserEdit(); showToast(`${u.username} : réglages enregistrés`); }
    }

    // Les listes ``allowed_users`` vivent dans config.json : le formulaire de
    // Connexions, s'il est chargé, doit les reprendre — sinon son prochain
    // enregistrement réécrirait l'ancienne liste.
    function _syncDesktopForm(targets) {
        if (!Array.isArray(targets)) return;
        usersDesktopTargets.value = targets;
        const form = configForm.value && configForm.value.desktop && configForm.value.desktop.targets;
        if (!Array.isArray(form)) return;
        // Écrit par le serveur, pas une modification de l'admin : si le bloc
        // était propre, il le reste (sinon la garde de sortie réclamerait un
        // enregistrement que personne n'a demandé).
        const wasClean = adminPristine.value.config === null
            || adminPristine.value.config === _storeSnapshot('config');
        for (const t of form) {
            const n = targets.find(x => x.name === t.name);
            if (n) t.allowed_users = [...(n.allowed_users || [])];
        }
        const rawTargets = _digPath(_configRaw, 'desktop.targets');
        if (rawTargets.found && Array.isArray(rawTargets.value)) {
            for (const t of rawTargets.value) {
                const n = targets.find(x => x.name === t.name);
                if (n) t.allowed_users = [...(n.allowed_users || [])];
            }
        }
        if (wasClean) markAdminStoreClean('config');
    }

    // ==================================================================
    // AX MEMORY -- liste sites, accordion, actions groupees
    // ==================================================================
    const axSites = ref([]);
    const axSelected = ref([]);
    const axExpanded = ref({});
    const axTrees = ref({});
    const axTreeLoading = ref({});
    const axLoading = ref(false);

    // Modale accessible aux users depuis la barre d'outils du chat
    const showAxModal = ref(false);

    async function openAxModal() {
        showAxModal.value = true;
        await loadAxSites();
    }

    async function loadAxSites() {
        axLoading.value = true;
        try {
            const res = await fetchAuth('/api/ax/sites');
            if (!res || !res.ok) {
                showToast('Erreur chargement AX sites', 'error');
                return;
            }
            const data = await res.json();
            axSites.value = data.sites || [];
            // Reset state on fresh load
            axSelected.value = [];
        } catch (e) {
            showToast('Erreur AX: ' + e.message, 'error');
        } finally {
            axLoading.value = false;
        }
    }

    async function toggleAxSite(site) {
        if (axExpanded.value[site]) {
            axExpanded.value = Object.assign({}, axExpanded.value, { [site]: false });
            return;
        }
        axExpanded.value = Object.assign({}, axExpanded.value, { [site]: true });
        // Charge le rendu ASCII (meme format qu'injecte au LLM)
        if (!axTrees.value[site]) {
            axTreeLoading.value = Object.assign({}, axTreeLoading.value, { [site]: true });
            try {
                const res = await fetchAuth('/api/ax/sites/' + encodeURIComponent(site) + '/tree-ascii');
                if (res && res.ok) {
                    const data = await res.json();
                    axTrees.value = Object.assign({}, axTrees.value, { [site]: data.ascii || '(vide)' });
                } else {
                    showToast('Erreur chargement arbre ' + site, 'error');
                }
            } catch (e) {
                showToast('Erreur: ' + e.message, 'error');
            } finally {
                axTreeLoading.value = Object.assign({}, axTreeLoading.value, { [site]: false });
            }
        }
    }

    function toggleSelectAllAx(ev) {
        if (ev.target.checked) {
            axSelected.value = axSites.value.map(function (s) { return s.site; });
        } else {
            axSelected.value = [];
        }
    }

    async function deleteSite(site, includeCreds) {
        const msg = includeCreds
            ? 'Supprimer le site "' + site + '" ET ses credentials ? Action irreversible.'
            : 'Supprimer le site "' + site + '" (garde les credentials) ?';
        const ok = await openConfirm(msg, '', false, 'Supprimer');
        if (!ok) return;
        try {
            const url = '/api/ax/sites/' + encodeURIComponent(site)
                + (includeCreds ? '?include_credentials=true' : '');
            const res = await fetchAuth(url, { method: 'DELETE' });
            if (res && res.ok) {
                const data = await res.json();
                const d = data.deleted || {};
                showToast('Site supprime : ' + (d.nodes || 0) + ' noeuds, ' + (d.transitions || 0) + ' transitions', 'success');
                // Invalide le cache local et reload
                delete axTrees.value[site];
                delete axExpanded.value[site];
                await loadAxSites();
            } else {
                showToast('Erreur suppression', 'error');
            }
        } catch (e) {
            showToast('Erreur: ' + e.message, 'error');
        }
    }

    async function deleteCreds(site) {
        const ok = await openConfirm('Supprimer les credentials de "' + site + '" ?', '', false, 'Supprimer');
        if (!ok) return;
        try {
            const res = await fetchAuth('/api/ax/sites/' + encodeURIComponent(site) + '/credentials', { method: 'DELETE' });
            if (res && res.ok) {
                showToast('Credentials supprimes', 'success');
                await loadAxSites();
            } else {
                showToast('Erreur', 'error');
            }
        } catch (e) {
            showToast('Erreur: ' + e.message, 'error');
        }
    }

    async function markStale(site) {
        try {
            const res = await fetchAuth('/api/ax/sites/' + encodeURIComponent(site) + '/mark-stale', { method: 'POST' });
            if (res && res.ok) {
                const data = await res.json();
                showToast((data.marked || 0) + ' elements marques stale sur ' + site, 'success');
                // Invalider le cache de l'arbre si ouvert pour forcer reload
                delete axTrees.value[site];
                if (axExpanded.value[site]) {
                    await toggleAxSite(site); // close
                    await toggleAxSite(site); // reopen (reload)
                }
            } else {
                showToast('Erreur mark stale', 'error');
            }
        } catch (e) {
            showToast('Erreur: ' + e.message, 'error');
        }
    }

    async function bulkDelete(includeCreds) {
        if (axSelected.value.length === 0) return;
        const msg = 'Supprimer ' + axSelected.value.length + ' site(s) ?'
            + (includeCreds ? ' Les credentials seront aussi supprimes.' : '');
        const ok = await openConfirm(msg, '', false, 'Supprimer');
        if (!ok) return;
        try {
            const res = await fetchAuth('/api/ax/bulk-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sites: axSelected.value,
                    include_credentials: includeCreds,
                }),
            });
            if (res && res.ok) {
                const data = await res.json();
                const d = data.deleted || {};
                showToast('Supprime : ' + (d.sites_processed || 0) + ' sites, ' + (d.nodes || 0) + ' noeuds', 'success');
                axTrees.value = {};
                axExpanded.value = {};
                await loadAxSites();
            } else {
                showToast('Erreur bulk delete', 'error');
            }
        } catch (e) {
            showToast('Erreur: ' + e.message, 'error');
        }
    }

    async function bulkMarkStale() {
        if (axSelected.value.length === 0) return;
        const ok = await openConfirm('Marquer ' + axSelected.value.length + ' site(s) comme stale ?', '', false, 'Confirmer');
        if (!ok) return;
        try {
            const res = await fetchAuth('/api/ax/bulk-mark-stale', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sites: axSelected.value, include_credentials: false }),
            });
            if (res && res.ok) {
                const data = await res.json();
                showToast((data.marked || 0) + ' elements marques stale', 'success');
                axTrees.value = {};
                await loadAxSites();
            } else {
                showToast('Erreur bulk mark stale', 'error');
            }
        } catch (e) {
            showToast('Erreur: ' + e.message, 'error');
        }
    }

    async function confirmWipeAll() {
        const ok = await openTypedConfirm(
            'Effacer toute la mémoire AX',
            'Tous les sites et tous les identifiants enregistrés. Sans retour arrière.',
            'EFFACER', 'Effacer',
        );
        if (!ok) return;
        try {
            const res = await fetchAuth('/api/ax/all?confirm=WIPE', { method: 'DELETE' });
            if (res && res.ok) {
                const data = await res.json();
                const d = data.deleted || {};
                showToast('Mémoire AX effacée : ' + (d.nodes || 0) + ' nœuds, ' + (d.credentials || 0) + ' identifiants', 'success');
                axTrees.value = {};
                axExpanded.value = {};
                axSelected.value = [];
                await loadAxSites();
            } else {
                showToast('Effacement refusé', 'error');
            }
        } catch (e) {
            showToast('Erreur: ' + e.message, 'error');
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  RAG SERVICE — "Tester la connexion" panel
    // ─────────────────────────────────────────────────────────────────
    // The admin types a candidate URL/token in the form and clicks Test
    // BEFORE saving. The endpoint POSTs whatever's currently in the form
    // to /api/admin/rag-service/test (which forwards to rag_app's
    // /api/health). Result is a small status block under the form:
    //   • busy   — request in flight, button disabled
    //   • ok     — green check, shows version/collection from health
    //   • err    — red cross, shows the network/auth error message
    //   • idle   — nothing rendered, default state
    // ── Base de données (chantier multi-moteurs, lot E) ─────────────────────
    // Formulaire propre à la page (pas de configForm : le mot de passe ne
    // transite jamais par config.json) ; actions à effet immédiat.
    const dbState = ref(null);
    const dbForm = ref({ backend: 'postgres', host: '127.0.0.1', port: 5432, name: 'elpis', user: 'elpis', tls: 'off', password: '' });
    const dbTest = ref({ state: 'idle', detail: null });
    const dbSim = ref({ state: 'idle', detail: null });
    const dbJob = ref({ state: 'idle' });
    const dbBusy = ref(false);
    let _dbJobTimer = null;

    function _dbBody() {
        const f = dbForm.value;
        return { backend: f.backend, host: (f.host || '').trim(), port: Number(f.port) || null,
                 name: (f.name || '').trim(), user: (f.user || '').trim(), tls: f.tls, password: f.password || '' };
    }
    async function _dbPost(path, body) {
        const r = await fetchAuth('/api/admin/database' + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        if (!r) return { ok: false, error: 'Session expirée ou réseau indisponible' };
        let data = null;
        try { data = await r.json(); } catch (_) { data = null; }
        if (!r.ok) return { ok: false, error: (data && data.detail) || ('HTTP ' + r.status) };
        return data || { ok: false, error: 'Réponse vide' };
    }
    async function loadDatabase() {
        const r = await fetchAuth('/api/admin/database');
        if (!r || !r.ok) return;
        const data = await r.json();
        dbState.value = data;
        const s = data.saved || {};
        if (s.backend && s.backend !== 'sqlite') dbForm.value.backend = s.backend;
        Object.assign(dbForm.value, {
            host: s.host || dbForm.value.host, name: s.name || dbForm.value.name,
            user: s.user || dbForm.value.user, tls: s.tls || 'off', password: '',
        });
        dbForm.value.port = s.port || (dbForm.value.backend === 'mysql' ? 3306 : 5432);
        dbJob.value = data.job || { state: 'idle' };
        if (dbJob.value.state === 'running') _pollDbJob();
    }
    function dbBackendChanged() {
        const f = dbForm.value;
        if (!f.port || f.port === 5432 || f.port === 3306) f.port = f.backend === 'mysql' ? 3306 : 5432;
    }
    async function testDatabase() {
        dbTest.value = { state: 'busy', detail: null };
        const d = await _dbPost('/test', _dbBody());
        dbTest.value = d.ok ? { state: 'ok', detail: d } : { state: 'err', detail: d.error || 'Erreur inconnue' };
    }
    async function saveDatabase() {
        dbBusy.value = true;
        try {
            const d = await _dbPost('/save', _dbBody());
            if (d.ok) { showToast('Réglages de base enregistrés', 'success'); dbForm.value.password = ''; await loadDatabase(); }
            else showToast(d.error || 'Échec', 'error');
        } finally { dbBusy.value = false; }
    }
    async function simulateDatabase() {
        dbSim.value = { state: 'busy', detail: null };
        const d = await _dbPost('/simulate', _dbBody());
        dbSim.value = d.ok ? { state: 'ok', detail: d } : { state: 'err', detail: d.error || 'Erreur inconnue' };
    }
    function _pollDbJob() {
        clearTimeout(_dbJobTimer);
        _dbJobTimer = setTimeout(async () => {
            const r = await fetchAuth('/api/admin/database/job');
            if (r && r.ok) dbJob.value = await r.json();
            if (dbJob.value.state === 'running') _pollDbJob();
        }, 1500);
    }
    async function migrateDatabase() {
        const ok = await openTypedConfirm('Migrer et basculer',
            'Écritures suspendues pendant la copie, puis redémarrage sur la nouvelle base.',
            'MIGRER', 'Migrer');
        if (!ok) return;
        const d = await _dbPost('/migrate', _dbBody());
        if (!d.ok) { showToast(d.error || 'Échec', 'error'); return; }
        dbJob.value = { state: 'running', step: 'préparation' };
        _pollDbJob();
    }
    async function revertDatabaseToSqlite() {
        const ok = await openConfirm('Revenir à SQLite ?',
            'Copie vers un fichier neuf (l’ancien est gardé en .bak), puis redémarrage.',
            true, 'Revenir');
        if (!ok) return;
        const d = await _dbPost('/sqlite', {});
        if (!d.ok) { showToast(d.error || 'Échec', 'error'); return; }
        dbJob.value = { state: 'running', step: 'préparation' };
        _pollDbJob();
    }

    const ragServiceTest = ref({ state: 'idle', detail: null });

    // Moteur vocal : deux services sondés en un clic, résultats séparés. La
    // liste des voix remontée par le test alimente le <datalist> du champ Voix
    // — plus fiable qu'une liste écrite en dur, qui périmerait au premier ajout.
    const voiceTest = ref({ state: 'idle', parts: [], voices: [], allOk: false, error: null });

    async function testVoiceConnection() {
        const cfg = (configForm.value && configForm.value.voice) || {};
        const stt = cfg.stt || {}, tts = cfg.tts || {};
        voiceTest.value = { state: 'busy', parts: [], voices: voiceTest.value.voices, allOk: false, error: null };
        try {
            const r = await fetchAuth('/api/admin/voice/test', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled: !!cfg.enabled,
                    stt: { endpoint_url: stt.endpoint_url || '', format: stt.format || 'whisper.cpp',
                           model: stt.model || '', language: stt.language || 'fr',
                           prompt: stt.prompt || '', token: stt.token || '',
                           verify: stt.verify !== false },
                    tts: { endpoint_url: tts.endpoint_url || '', format: tts.format || 'elpis-tts',
                           model: tts.model || '', voice: tts.voice || '', token: tts.token || '',
                           verify: tts.verify !== false },
                }),
            });
            if (!r) { voiceTest.value = { state: 'err', parts: [], voices: [], allOk: false, error: 'Session expirée ou réseau indisponible' }; return; }
            const data = await r.json();
            const stt_r = (data && data.stt) || {}, tts_r = (data && data.tts) || {};
            voiceTest.value = {
                state: 'done',
                allOk: !!(data && data.ok),
                error: null,
                // Ce que le test ne peut pas montrer à lui seul : config non
                // enregistrée, moteur désactivé, cases utilisateur, HTTPS.
                warnings: Array.isArray(data && data.warnings) ? data.warnings : [],
                voices: Array.isArray(tts_r.voices) ? tts_r.voices : [],
                parts: [
                    { id: 'stt', ok: !!stt_r.ok, title: 'Reconnaissance',
                      detail: stt_r.ok
                          ? ('Service joignable (' + (stt_r.format || '—') + ').')
                          : ((stt_r.error || 'Erreur inconnue') + (stt_r.detail ? ' — ' + stt_r.detail : '')) },
                    { id: 'tts', ok: !!tts_r.ok, title: 'Synthèse',
                      detail: tts_r.ok
                          ? ((tts_r.bytes || 0) + ' octets rendus'
                             + (tts_r.voices && tts_r.voices.length ? ', ' + tts_r.voices.length + ' voix installée(s).' : '.'))
                          : ((tts_r.error || 'Erreur inconnue') + (tts_r.detail ? ' — ' + tts_r.detail : '')) },
                ],
            };
        } catch (e) {
            voiceTest.value = { state: 'err', parts: [], voices: [], allOk: false, error: String(e && e.message || e) };
        }
    }

    // Modèles et voix CHARGÉS par les serveurs : l'administrateur choisit
    // dans une liste au lieu de saisir un nom qu'il faudrait connaître par
    // cœur. whisper.cpp n'a qu'un modèle, chargé au démarrage : rien à choisir.
    const _voiceModelsVide = function () { return { state: 'idle', models: [], current: null, detail: '', error: '' }; };
    const voiceModels = ref({ stt: _voiceModelsVide(), tts: _voiceModelsVide() });
    const _voiceModelsSeq = { stt: 0, tts: 0 };

    async function loadVoiceModels(section) {
        const cfg = (configForm.value && configForm.value.voice) || {};
        const sect = cfg[section];
        if (!sect) return;
        const seq = ++_voiceModelsSeq[section];
        if (!(sect.endpoint_url || '').trim()) {
            voiceModels.value[section] = _voiceModelsVide();
            return;
        }
        voiceModels.value[section] = Object.assign(_voiceModelsVide(), { state: 'busy' });
        let res = null;
        try {
            const r = await fetchAuth('/api/admin/voice/models', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ section: section, endpoint_url: sect.endpoint_url || '',
                                       format: sect.format || '', token: sect.token || '',
                                       verify: sect.verify !== false }),
            }, true);
            res = r && r.ok ? await r.json() : null;
        } catch (e) { res = null; }
        if (seq !== _voiceModelsSeq[section]) return;        // réponse périmée
        if (!res || !res.ok) {
            voiceModels.value[section] = Object.assign(_voiceModelsVide(), {
                state: 'err', error: (res && res.error) || 'Serveur injoignable.',
                detail: (res && res.detail) || '' });
            return;
        }
        const models = Array.isArray(res.models) ? res.models : [];
        voiceModels.value[section] = { state: 'ok', models: models, current: res.current,
                                       detail: res.detail || '', error: '' };
        // Pré-remplissage : le champ vide (ou absent du serveur) prend ce
        // que le serveur a chargé — la valeur « par défaut » qui marche.
        const champ = _voiceModelField(section, sect.format);
        if (!champ || res.current === null || res.current === undefined || res.current === '') return;
        const ids = models.map(function (m) { return m.id; });
        if (!sect[champ] || ids.indexOf(sect[champ]) < 0) {
            // Un pré-remplissage fait au CHARGEMENT n'est pas une modification
            // de l'opérateur : sans ce recalage, la page s'ouvrait marquée
            // « non enregistrée ». Si l'opérateur avait déjà modifié autre
            // chose, la référence reste celle d'origine.
            const propre = adminPristine.value.config === _storeSnapshot('config');
            sect[champ] = res.current;
            if (propre) markAdminStoreClean('config');
        }
    }

    /** Le champ que la liste renseigne, selon la section et le format. */
    function _voiceModelField(section, format) {
        if (section === 'stt') return format === 'whisper.cpp' ? null : 'model';
        return format === 'openai' ? 'model' : 'voice';
    }

    // Adresse, format ou jeton changés : on relit la liste, après une pause
    // de frappe — pas une requête par caractère.
    const _voiceModelsTimers = { stt: null, tts: null };
    for (const _sec of ['stt', 'tts']) {
        watch(function () {
            const v = configForm.value && configForm.value.voice && configForm.value.voice[_sec];
            return v ? [v.endpoint_url, v.format, v.token, v.verify].join('|') : '';
        }, function (nouv, anc) {
            if (!anc || nouv === anc) return;      // premier remplissage : géré au chargement
            clearTimeout(_voiceModelsTimers[_sec]);
            _voiceModelsTimers[_sec] = setTimeout(function () { loadVoiceModels(_sec); }, 700);
        });
    }

    async function testRagServiceConnection() {
        // Pull current form values; fall back to empty so the backend
        // uses its own saved config when the field is blank.
        const cfg = (configForm.value && configForm.value.rag) || {};
        const body = {
            url:     (cfg.service_url || '').trim(),
            token:   cfg.service_token || '',
            timeout: cfg.service_timeout || 5,
        };
        ragServiceTest.value = { state: 'busy', detail: null };
        try {
            const r = await fetchAuth('/api/admin/rag-service/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            // ``fetchAuth`` retourne ``null`` sur 401
            // ou erreur réseau. Avant, ``await r.json()`` plantait avec
            // TypeError "Cannot read properties of null" — l'erreur
            // remontait dans le catch sous une forme cryptique au lieu
            // d'un état clair. On guard explicitement.
            if (!r) {
                ragServiceTest.value = { state: 'err', detail: 'Session expirée ou réseau indisponible' };
                return;
            }
            const data = await r.json();
            if (data && data.ok) {
                ragServiceTest.value = { state: 'ok', detail: data.status || {} };
            } else {
                ragServiceTest.value = { state: 'err', detail: (data && data.error) || 'Erreur inconnue' };
            }
        } catch (e) {
            ragServiceTest.value = { state: 'err', detail: String(e && e.message || e) };
        }
    }


    // ── System Prompts admin tab ────────────────────────────────────────
    // Manage system_prompts/<category>.md files. Each file is the protocol
    // injected when its tool category is active in a chat. The runtime
    // assembler in backend/services/_system_prompts.py picks them up
    // via mtime-based caching, so a Save here takes effect on the very
    // next chat call without a server restart.
    const promptsList         = ref([]);                   // [{category, size_chars, mtime, exists}, ...]
    const promptsSelected     = ref('');                   // current category in editor (or '_TEMPLATE')
    const promptsEditorText   = ref('');                   // textarea-bound content
    const promptsEditorDirty  = ref(false);                // true while unsaved edits pending
    const promptsLoading      = ref(false);                // suppresses double-clicks during fetches
    const promptsPreview      = ref(null);                 // assembled-prompt response from backend
    const promptsPreviewCats  = ref([]);                   // category names included in the preview

    // ── Catégorisation des prompts (front-only, dérivée — aucun changement
    //    backend). Mappe chaque fichier .md vers un groupe thématique + un
    //    libellé humain + une icône + où il est utilisé. ──────────────────────
    const PROMPT_GROUPS = Object.freeze([
        { id: 'base',     label: 'Base chatbot',     icon: 'ph-robot' },
        { id: 'compress', label: 'Compression',      icon: 'ph-arrows-in' },
        { id: 'memory',   label: 'Mémoire',          icon: 'ph-brain' },
        { id: 'vision',   label: 'Vision & Desktop', icon: 'ph-eye' },
        { id: 'other',    label: 'Autres',           icon: 'ph-file-text' },
    ]);
    const PROMPT_META = Object.freeze({
        CHATBOT_SYSTEM:      { group: 'base',     label: 'Identité du chatbot',      icon: 'ph-robot',     desc: 'Prompt de base de toutes les sessions',  usage: 'Injecté en tête de chaque conversation.' },
        COMPRESSOR_SYSTEM:   { group: 'compress', label: 'Compression de conversation', icon: 'ph-arrows-in', desc: 'Résume/compacte les longues conversations', usage: 'Utilisé par le compresseur de contexte.' },
        AX_MEMORY_HEADER:    { group: 'memory',   label: 'Mémoire navigateur (AX)',  icon: 'ph-brain',     desc: 'En-tête du bloc mémoire DOM par site',   usage: 'Préfixe le bloc mémoire AX des sessions navigateur.' },
        VISION_DETECT:       { group: 'vision',   label: 'Vision — détection',       icon: 'ph-scan',      desc: 'Détecte tous les éléments interactifs',  usage: 'Grounding UI complet (moteur de vision desktop).' },
        VISION_DETECT_EDGE:  { group: 'vision',   label: 'Vision — barre des tâches',icon: 'ph-scan',      desc: 'Détection de la barre du bas',           usage: 'Grounding ciblé sur la taskbar.' },
        VISION_DETECT_QUERY: { group: 'vision',   label: 'Vision — ciblé',           icon: 'ph-scan',      desc: 'Détection ciblée par requête',           usage: 'Grounding desktop ciblé par {query}.' },
        VISION_READ:         { group: 'vision',   label: 'Vision — lecture (OCR)',   icon: 'ph-eye',       desc: "Transcription de texte d'image",         usage: "OCR / lecture de texte à l'écran." },
    });
    function promptMeta(cat) {
        return PROMPT_META[cat] || { group: 'other', label: cat, icon: 'ph-file-text', desc: '', usage: '' };
    }
    // Groupes peuplés (dans l'ordre de PROMPT_GROUPS) → [{...group, items:[…]}].
    const promptsGrouped = computed(() => {
        const byGroup = {};
        for (const it of (promptsList.value || [])) {
            const g = promptMeta(it.category).group;
            (byGroup[g] = byGroup[g] || []).push(it);
        }
        return PROMPT_GROUPS
            .map(g => ({ ...g, items: byGroup[g.id] || [] }))
            .filter(g => g.items.length > 0);
    });
    // Pliage d'accordéon — Set réassigné (jamais muté en place) pour la
    // réactivité Vue (même pattern que l'arbre des skills).
    const promptsCollapsed = ref(new Set());
    function isPromptGroupCollapsed(id) { return promptsCollapsed.value.has(id); }
    function togglePromptGroup(id) {
        const s = new Set(promptsCollapsed.value);
        if (s.has(id)) s.delete(id); else s.add(id);
        promptsCollapsed.value = s;
    }
    function fmtBytes(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' o';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
        return (n / 1024 / 1024).toFixed(1) + ' Mo';
    }

    /**
     * Load the directory listing. Called when the tab is opened and
     * when the user clicks "Recharger". Initializes the preview-cats
     * to "all" the first time so the preview starts non-empty.
     */
    async function loadSystemPrompts() {
        promptsLoading.value = true;
        try {
            const r = await fetchAuth('/api/admin/system-prompts');
            if (!r || !r.ok) {
                showToast('Erreur chargement prompts', 'error');
                return;
            }
            const data = await r.json();
            promptsList.value = data.items || [];
            if (promptsPreviewCats.value.length === 0) {
                promptsPreviewCats.value = promptsList.value.map(it => it.category);
            }
            if (!promptsSelected.value && promptsList.value.length > 0) {
                await selectPrompt(promptsList.value[0].category);
            } else {
                await refreshPreview();
            }
        } catch (e) {
            showToast('Erreur réseau: ' + e.message, 'error');
        } finally {
            promptsLoading.value = false;
        }
    }

    /**
     * Load a single category into the editor. Special-cases ``_TEMPLATE``
     * via the read-only endpoint. Prompts an unsaved-changes confirmation
     * if there are dirty local edits before switching.
     */
    async function selectPrompt(category) {
        if (promptsEditorDirty.value) {
            const ok = await openConfirm(
                'Modifications non sauvegardées',
                `Tu as des modifications non sauvegardées sur "${promptsSelected.value}". Les abandonner ?`,
                true,
                'Abandonner',
            );
            if (!ok) return;
        }
        promptsLoading.value = true;
        try {
            const url = category === '_TEMPLATE'
                ? '/api/admin/system-prompts/_template'
                : `/api/admin/system-prompts/${encodeURIComponent(category)}`;
            const r = await fetchAuth(url);
            if (!r || !r.ok) {
                showToast(`Erreur chargement ${category}`, 'error');
                return;
            }
            const data = await r.json();
            promptsSelected.value = category;
            promptsEditorText.value = data.content || '';
            promptsEditorDirty.value = false;
        } catch (e) {
            showToast('Erreur réseau: ' + e.message, 'error');
        } finally {
            promptsLoading.value = false;
        }
    }

    /** Persist the editor content. Refreshes the list and preview after. */
    async function savePrompt() {
        const cat = promptsSelected.value;
        if (!cat || cat === '_TEMPLATE') return;
        if (!promptsEditorDirty.value) return;
        promptsLoading.value = true;
        try {
            const r = await fetchAuth(`/api/admin/system-prompts/${encodeURIComponent(cat)}`, {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ content: promptsEditorText.value }),
            });
            if (!r || !r.ok) {
                let msg = 'Erreur d’enregistrement';
                try { msg = (await r.json()).detail || msg; } catch(_) {}
                showToast(msg, 'error');
                return false;
            }
            promptsEditorDirty.value = false;
            showToast(`${cat}.md enregistré`, 'success');
            await loadSystemPrompts();
            await refreshPreview();
            return true;
        } catch (e) {
            showToast('Erreur réseau: ' + e.message, 'error');
            return false;
        } finally {
            promptsLoading.value = false;
        }
    }

    /** Discard local edits, refetch from disk. */
    async function reloadPrompt() {
        if (!promptsSelected.value) return;
        promptsEditorDirty.value = false;  // bypass the confirm
        await selectPrompt(promptsSelected.value);
    }

    /** Refetch the assembled preview for the currently-selected categories. */
    async function refreshPreview() {
        const cats = promptsPreviewCats.value || [];
        const qs = cats.length ? `?categories=${encodeURIComponent(cats.join(','))}` : '';
        try {
            const r = await fetchAuth(`/api/admin/system-prompts/_preview${qs}`);
            if (!r || !r.ok) return;
            promptsPreview.value = await r.json();
        } catch (e) {
            // Preview is non-critical; swallow errors silently rather
            // than spamming toasts during rapid toggling.
        }
    }



    // ─────────────────────────────────────────────────────────────────
    //  EXEC / SANDBOX ADMIN (Docker local uniquement)
    // ─────────────────────────────────────────────────────────────────
    const { onBeforeUnmount } = vue;   // `computed` déjà destructuré en tête

    const execLoading      = ref(false);
    const execConfig       = ref({
        image: 'elpis/sandbox:1.0.0',
        limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
        force_user_docker: false,
        idle_kill_hours: 24,
        network_profiles: [],
        // Avancé (exposé 2026-07-19 — validé/persisté par admin/executors.py)
        exec_user: '10001:10001',
        runtime: '',
        extra_run_args: [],
    });
    const execHealthcheck  = ref(null);

    // ── Manifeste mcp.json (2026-09-11) — outils par défaut ────────────────
    // Lecture seule + « Recharger » : le fichier est édité sur le serveur
    // (jamais de PUT libre d'une commande stdio — cf. B1 passe 9).
    const mcpManifest      = ref(null);
    const mcpManifestBusy  = ref(false);
    // (2026-09-12) Export « prêt à coller » vers un autre applicatif : une
    // entrée par famille, sur le transport choisi.
    const mcpExportTransport = ref('http');
    const mcpExportToken     = ref(false);

    // ── Clients OAuth des clients MCP (EXT.4) ──────────────────────────────
    const oauthClients = ref([]);

    async function loadOauthClients() {
        try {
            const r = await fetchAuth('/api/admin/oauth/clients');
            if (!r || !r.ok) { oauthClients.value = []; return; }
            const d = await r.json();
            oauthClients.value = (d && d.items) || [];
        } catch (e) {
            oauthClients.value = [];
        }
    }

    async function deleteOauthClient(c) {
        const ok = await openConfirm('Supprimer ce client ?',
            '« ' + (c.name || c.client_id) + ' » perd toutes ses autorisations ; il devra se réenregistrer.',
            true, 'Supprimer');
        if (!ok) return;
        try {
            const r = await fetchAuth('/api/admin/oauth/clients?client_id=' + encodeURIComponent(c.client_id),
                                      { method: 'DELETE' }, true);
            if (!r || !r.ok) { showToast('Suppression impossible', 'error'); return; }
            await loadOauthClients();
        } catch (e) {
            showToast('Suppression impossible', 'error');
        }
    }

    async function loadMcpManifest() {
        try {
            const r = await fetchAuth('/api/admin/mcp/manifest');
            if (!r || !r.ok) { mcpManifest.value = null; return; }
            const d = await r.json();
            mcpManifest.value = (d && d.ok) ? d.manifest : null;
        } catch (e) {
            mcpManifest.value = null;
        }
    }

    async function reloadMcpManifest() {
        if (mcpManifestBusy.value) return;
        mcpManifestBusy.value = true;
        try {
            const r = await fetchAuth('/api/admin/mcp/manifest/reload', { method: 'POST' }, true);
            const d = r ? await r.json().catch(() => null) : null;
            if (d && d.ok) {
                showToast((d.errors && d.errors.length) ? 'Manifeste rechargé avec erreurs' : 'Manifeste rechargé', (d.errors && d.errors.length) ? 'warning' : 'success');
            } else {
                showToast('Rechargement impossible', 'error');
            }
        } catch (e) {
            showToast('Rechargement impossible', 'error');
        } finally {
            mcpManifestBusy.value = false;
            await loadMcpManifest();
        }
    }

    async function copyMcpExport() {
        if (mcpManifestBusy.value) return;
        mcpManifestBusy.value = true;
        try {
            const q = new URLSearchParams({ transport: mcpExportTransport.value,
                                            with_token: mcpExportToken.value ? '1' : '0' });
            const r = await fetchAuth('/api/admin/mcp/manifest/export?' + q.toString());
            const d = r && r.ok ? await r.json().catch(() => null) : null;
            if (!d || !d.ok) { showToast('Export impossible', 'error'); return; }
            const txt = JSON.stringify({ mcpServers: d.mcpServers }, null, 2);
            await navigator.clipboard.writeText(txt);
            showToast('Configuration copiée (' + Object.keys(d.mcpServers || {}).length + ' serveurs)');
        } catch (e) {
            showToast('Export impossible', 'error');
        } finally {
            mcpManifestBusy.value = false;
        }
    }

    // ── Hôtes d'outils (mcp.json › sandboxHosts) — P5 ─────────────────────
    const toolhosts         = ref(null);
    const toolhostMoveTarget = ref({});
    const toolhostBusy      = ref(false);

    async function loadToolhosts() {
        try {
            const r = await fetchAuth('/api/admin/toolhosts');
            if (!r || !r.ok) { toolhosts.value = null; return; }
            const d = await r.json();
            toolhosts.value = (d && d.ok) ? d : null;
        } catch (e) {
            toolhosts.value = null;
        }
    }

    async function _toolhostAction(userId, migrate) {
        const host = toolhostMoveTarget.value[userId];
        if (!host || toolhostBusy.value) return;
        const ok = await openConfirm(
            migrate ? 'Migrer le sandbox' : "Réaffecter l'hôte",
            migrate ? ('Déplacer les fichiers du compte #' + userId + ' vers « ' + host + ' » ? L\'ancien contenu est conservé sur l\'hôte de départ.')
                    : ('Affecter le compte #' + userId + ' à « ' + host + ' » sans déplacer ses fichiers ?'),
            migrate, migrate ? 'Migrer' : 'Affecter');
        if (!ok) return;
        toolhostBusy.value = true;
        try {
            const url = '/api/admin/toolhosts/placements/' + encodeURIComponent(userId) + (migrate ? '/migrate' : '');
            const r = await fetchAuth(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                             body: JSON.stringify({ host_id: host }) }, true);
            const d = r ? await r.json().catch(() => null) : null;
            if (r && r.ok && d && d.ok) {
                showToast(migrate ? ('Migré : ' + (d.files || 0) + ' fichiers') : 'Compte affecté', 'success');
                toolhostMoveTarget.value[userId] = '';
            } else {
                showToast((d && d.detail) || 'Opération impossible', 'error');
            }
        } catch (e) {
            showToast('Opération impossible', 'error');
        } finally {
            toolhostBusy.value = false;
            await loadToolhosts();
        }
    }
    function migrateToolhostPlacement(userId) { return _toolhostAction(userId, true); }
    function assignToolhostPlacement(userId)  { return _toolhostAction(userId, false); }

    function mcpManifestRoleLabel(role) {
        return role === 'toolhost' ? 'intégré' : role === 'app' ? 'app' : 'externe';
    }
    const sandboxContainers = ref([]);
    // Textarea « un flag par ligne » ↔ liste extra_run_args.
    const execExtraArgsText = computed({
        get: () => (execConfig.value.extra_run_args || []).join('\n'),
        set: (v) => { execConfig.value.extra_run_args = String(v || '').split('\n').map(s => s.trim()).filter(Boolean); },
    });

    // Conteneurs en marche dont les règles réseau ont dérivé du profil après
    // la dernière sauvegarde (renvoyés par POST /api/admin/executors). La
    // recréation est de toute façon paresseuse au prochain exec — ce bloc
    // permet de la déclencher tout de suite.
    const staleNetContainers = ref([]);
    const staleNetBusy = ref(false);

    // Champs d'une allowlist. Une seule description pilote le rendu (une puce
    // par valeur) et la validation — l'ancien markup répétait quatre fois le
    // même bloc « valeurs séparées par des virgules ».
    const netFields = Object.freeze([
        { key: 'ips',     label: 'Réseaux & IP', ph: '10.0.0.0/24', hint: 'IP ou CIDR',
          title: 'Une IP (10.0.0.5) ou un réseau CIDR (10.0.0.0/24). Plusieurs valeurs acceptées, séparées par un espace ou une virgule.' },
        { key: 'domains', label: 'Domaines',     ph: 'github.com',  hint: 'résolu au démarrage',
          title: "Résolu côté hôte à la création du conteneur et épinglé dans /etc/hosts : pas besoin d'ouvrir le DNS, et le rebinding est neutralisé." },
        { key: 'ports',   label: 'Ports',        ph: '443',         hint: 'TCP sortant',
          title: 'Ports TCP sortants autorisés. Nécessite une image sandbox ≥ 1.6.0 ; en deçà, le filtrage par port est ignoré.',
          quick: [{ label: 'Web', values: [80, 443] }, { label: 'SSH', values: [22] }] },
        { key: 'dns',     label: 'Résolveurs DNS', ph: '10.0.0.1', hint: 'IP du serveur',
          title: "Résolveurs joignables (--dns + port 53). Utile seulement si le conteneur doit résoudre en direct ; les domaines listés ci-dessus n'en ont pas besoin." },
    ]);

    let _netProfileUid = 0;

    // Champs d'UI attachés à un profil : brouillon de saisie par champ,
    // message d'erreur par champ, clé stable pour le v-for. Tous préfixés
    // « _ » et retirés par execConfigPayload().
    function _decorateProfile(p) {
        return {
            domains: [], ports: [], dns: [], ips: [], ...p,
            _uid: `np${++_netProfileUid}`,
            _open: false,           // carte repliée : badge + résumé sur une ligne
            _portsMode: ((p.ports || []).length ? 'list' : 'all'),
            _draft: { ips: '', domains: '', ports: '', dns: '' },
            _err: { ips: '', domains: '', ports: '', dns: '' },
        };
    }

    // ── Carte de profil : badge, résumé, alerte ──────────────────────────
    function netModeKey(prof) {
        return prof.mode === 'bridge' ? 'open' : (prof.mode === 'allowlist_ip' ? 'filter' : 'block');
    }
    function netModeLabel(prof) {
        return prof.mode === 'bridge' ? 'Ouvert' : (prof.mode === 'allowlist_ip' ? 'Filtré' : 'Bloqué');
    }
    function netModeIcon(prof) {
        return prof.mode === 'bridge' ? 'ph-globe-hemisphere-west'
             : (prof.mode === 'allowlist_ip' ? 'ph-funnel' : 'ph-prohibit');
    }

    /** Résumé lisible des règles, affiché sur la carte repliée : on doit
     *  savoir ce que fait un profil SANS le déplier. */
    function netProfileSummary(prof) {
        if (prof.mode === 'none') return 'Aucune sortie réseau';
        if (prof.mode === 'bridge') return 'Internet, LAN et métadonnées cloud';
        const n = (a) => (a || []).length;
        const bits = [];
        if (n(prof.ips)) bits.push(n(prof.ips) + ' réseau' + (n(prof.ips) > 1 ? 'x' : ''));
        if (n(prof.domains)) bits.push(n(prof.domains) + ' domaine' + (n(prof.domains) > 1 ? 's' : ''));
        bits.push(netPortsMode(prof) === 'list' && n(prof.ports)
            ? 'ports ' + prof.ports.join(', ') : 'tous ports');
        if (n(prof.dns)) bits.push(n(prof.dns) + ' DNS');
        return bits.join(' · ');
    }

    /** Motif de refus par le serveur, ou '' si le profil est sauvegardable.
     *  Rendu visible sur la carte REPLIÉE : sinon l'opérateur ne découvre le
     *  problème qu'au 400, après avoir tout replié. */
    function netProfileIssue(prof) {
        if (!prof.name || !String(prof.name).trim()) return 'Donnez un nom à ce profil.';
        if (!/^[a-z0-9_-]+$/.test(String(prof.id || ''))) {
            return "Identifiant invalide : minuscules, chiffres, _ ou - uniquement.";
        }
        if (prof.mode === 'allowlist_ip' && !(prof.ips || []).length && !(prof.domains || []).length) {
            return 'Ajoutez au moins une IP ou un domaine — sinon la sauvegarde est refusée.';
        }
        return '';
    }

    /** Déplie / replie une carte. À la fermeture, les brouillons encore en
     *  cours de frappe sont validés : la carte se vide du DOM, ils seraient
     *  perdus en silence. */
    function toggleProfile(prof) {
        if (prof._open) {
            for (const f of netFields) commitNetValue(prof, f.key);
        }
        prof._open = !prof._open;
    }

    function execConfigPayload() {
        const c = execConfig.value || {};
        return {
            ...c,
            network_profiles: (c.network_profiles || []).map(p => {
                const out = {};
                for (const k of Object.keys(p)) {
                    if (k.charAt(0) !== '_') out[k] = p[k];
                }
                // « Tous » force la liste vide : une liste résiduelle masquée
                // ne doit pas partir en douce.
                out.ports = netPortsMode(p) === 'list' ? (p.ports || []) : [];
                return out;
            }),
        };
    }

    function netPortsMode(prof) {
        return prof._portsMode || ((prof.ports || []).length ? 'list' : 'all');
    }

    function setPortsMode(prof, mode) {
        prof._portsMode = mode;
        if (mode === 'all') { prof.ports = []; prof._err.ports = ''; prof._draft.ports = ''; }
    }

    function setProfileMode(prof, mode) {
        // « isolated » est le repli fail-closed du serveur (profil d'un user
        // supprimé, résolution impossible…) : son mode reste « Tout bloquer ».
        if (prof.id === 'isolated') return;
        prof.mode = mode;
    }

    // ── Validation à la saisie ───────────────────────────────────────────
    // Le serveur revalide tout (il reste l'autorité) ; ici on empêche juste
    // qu'une faute de frappe ne se découvre qu'au 400 de la sauvegarde.
    const _IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
    const _IPV6_RE = /^[0-9a-f:]+$/i;
    const _DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

    function _isIp(s) {
        return _IPV4_RE.test(s) || (s.indexOf(':') >= 0 && _IPV6_RE.test(s));
    }

    function _normalizeNetValue(key, raw) {
        const s = String(raw || '').trim();
        if (!s) return { value: null };
        if (key === 'ports') {
            if (!/^\d{1,5}$/.test(s)) return { error: `« ${s} » n'est pas un port` };
            const n = parseInt(s, 10);
            if (n < 1 || n > 65535) return { error: `Port hors plage : ${s}` };
            return { value: n };
        }
        if (key === 'dns') {
            if (!_isIp(s)) return { error: `« ${s} » doit être l'IP d'un résolveur` };
            return { value: s };
        }
        if (key === 'domains') {
            // Tolère un copier-coller d'URL : on garde l'hôte.
            let d = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0].split('?')[0];
            d = d.split('@').pop().replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');
            if (!_DOMAIN_RE.test(d)) return { error: `« ${s} » n'est pas un domaine valide` };
            return { value: d };
        }
        // ips : IP seule ou CIDR
        const [addr, prefix, ...extra] = s.split('/');
        if (extra.length || !_isIp(addr)) return { error: `« ${s} » n'est ni une IP ni un CIDR` };
        if (prefix !== undefined) {
            const max = addr.indexOf(':') >= 0 ? 128 : 32;
            if (!/^\d{1,3}$/.test(prefix) || parseInt(prefix, 10) > max) {
                return { error: `Préfixe invalide dans « ${s} » (0 à ${max})` };
            }
        }
        return { value: s };
    }

    /** Ajoute le brouillon du champ à la liste. Accepte plusieurs valeurs
     *  d'un coup (espace, virgule ou point-virgule). Les valeurs refusées
     *  RESTENT dans le champ avec le motif — rien n'est perdu en silence. */
    function commitNetValue(prof, key) {
        const draft = String((prof._draft && prof._draft[key]) || '').trim();
        prof._err[key] = '';
        if (!draft) return;
        if (!Array.isArray(prof[key])) prof[key] = [];
        const rejected = [];
        let firstErr = '';
        for (const part of draft.split(/[\s,;]+/).filter(Boolean)) {
            const res = _normalizeNetValue(key, part);
            if (res.error) {
                rejected.push(part);
                if (!firstErr) firstErr = res.error;
                continue;
            }
            if (res.value === null) continue;
            if (!prof[key].some(x => String(x) === String(res.value))) prof[key].push(res.value);
        }
        prof._draft[key] = rejected.join(' ');
        prof._err[key] = rejected.length ? firstErr : '';
    }

    function removeNetValue(prof, key, idx) {
        if (Array.isArray(prof[key])) prof[key].splice(idx, 1);
        prof._err[key] = '';
    }

    function addNetPreset(prof, key, values) {
        if (!Array.isArray(prof[key])) prof[key] = [];
        for (const v of values) {
            if (!prof[key].some(x => String(x) === String(v))) prof[key].push(v);
        }
        prof._err[key] = '';
    }

    function addNetworkProfile() {
        const idx = execConfig.value.network_profiles.length;
        // Un profil neuf naît DÉPLIÉ (il n'a rien à résumer) et en mode
        // filtré : c'est la seule raison d'en créer un — « isolated » et un
        // profil ouvert se règlent en un clic depuis n'importe quelle carte.
        const p = _decorateProfile({
            id: `profil_${idx}`,
            name: `Profil ${idx + 1}`,
            mode: 'allowlist_ip',
            ips: [],
            domains: [],
            ports: [],
            dns: [],
            description: '',
        });
        p._open = true;
        execConfig.value.network_profiles.push(p);
    }

    async function recreateStaleNetContainers() {
        if (!staleNetContainers.value.length || staleNetBusy.value) return;
        staleNetBusy.value = true;
        let okCount = 0;
        try {
            for (const c of staleNetContainers.value) {
                try {
                    const r = await fetchAuth(`/api/admin/sandbox/containers/${c.user_id}`, { method: 'DELETE' });
                    if (r && r.ok) okCount++;
                } catch (e) { /* continue : bilan global ci-dessous */ }
            }
            showToast(okCount === staleNetContainers.value.length
                ? `${okCount} conteneur(s) recréé(s) au prochain accès`
                : `${okCount}/${staleNetContainers.value.length} conteneur(s) traités`,
                okCount ? 'success' : 'error');
            staleNetContainers.value = [];
            await loadSandboxContainers();
        } finally {
            staleNetBusy.value = false;
        }
    }

    async function removeNetworkProfile(idx) {
        const p = execConfig.value.network_profiles[idx];
        if (p && p.id === 'isolated') {
            showToast("Le profil 'isolated' ne peut pas être supprimé.", 'warn');
            return;
        }
        const ok = await openConfirm(
            'Supprimer le profil ?',
            `Le profil "${p.name}" sera retiré. Les utilisateurs qui l'avaient sélectionné repasseront en "isolated".`,
            true, 'Supprimer'
        );
        if (!ok) return;
        execConfig.value.network_profiles.splice(idx, 1);
    }

    async function loadExecConfig() {
        execLoading.value = true;
        try {
            const r = await fetchAuth('/api/admin/executors');
            if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : '?'));
            const data = await r.json();
            const cfg = data.config || {};
            execConfig.value = {
                // L'image vit à la RACINE de la réponse, pas dans `config` :
                // `cfg.image` était toujours undefined et on retombait sur un
                // tag codé en dur (et périmé). Elle est en lecture seule ici —
                // c'est config.json qui fait foi, le POST ne la modifie pas.
                image: data.image || '',
                limits: cfg.limits || {
                    memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600
                },
                force_user_docker: !!cfg.force_user_docker,
                idle_kill_hours: cfg.idle_kill_hours || 24,
                // Normalise les nouveaux champs (config sauvée avant la
                // fonctionnalité) : les listes manquantes et l'état d'UI
                // (brouillons, erreurs, mode ports) sont posés ici.
                network_profiles: (cfg.network_profiles || []).map(_decorateProfile),
                exec_user: cfg.exec_user || '10001:10001',
                runtime: cfg.runtime || '',
                extra_run_args: cfg.extra_run_args || [],
            };
            markAdminStoreClean('exec');
            await loadExecHealthcheck();
            await loadSandboxContainers();
        } catch (e) {
            showToast('Erreur chargement : ' + e.message, 'error');
        } finally {
            execLoading.value = false;
        }
    }

    async function loadExecHealthcheck() {
        try {
            const r = await fetchAuth('/api/admin/executors/healthcheck');
            execHealthcheck.value = r ? await r.json() : null;
        } catch (e) {
            execHealthcheck.value = { daemon_ok: false, error: e.message };
        }
    }

    // Renvoie true/false comme les autres blocs — saveAdminPage() affiche le
    // bilan. Le détail du refus serveur reste utile ici (règles de validation
    // des profils réseau), donc il garde son propre toast d'erreur.
    async function saveExecConfig() {
        execLoading.value = true;
        try {
            // Un brouillon encore dans un champ de saisie serait perdu à la
            // sauvegarde : on le valide d'abord, comme si l'opérateur avait
            // appuyé sur Entrée.
            for (const p of (execConfig.value.network_profiles || [])) {
                if (p.mode !== 'allowlist_ip' || !p._draft) continue;
                for (const f of netFields) commitNetValue(p, f.key);
            }
            const payload = execConfigPayload();
            const r = await fetchAuth('/api/admin/executors', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ executors: payload }),
            });
            if (!r || !r.ok) throw new Error(r ? await r.text() : 'no response');
            const d = await r.json().catch(() => ({}));
            // Avertissements non bloquants (CIDR 0.0.0.0/0, plage métadonnées…).
            for (const w of (d.warnings || [])) showToast(w, 'warn');
            // Conteneurs en marche restés sur les anciennes règles → bloc
            // « Recréer maintenant » dans le panneau Profils réseau.
            staleNetContainers.value = d.stale_containers || [];
            await loadExecHealthcheck();
            return true;
        } catch (e) {
            showToast('Sauvegarde refusée : ' + e.message, 'error');
            return false;
        } finally {
            execLoading.value = false;
        }
    }

    async function loadSandboxContainers() {
        try {
            const r = await fetchAuth('/api/admin/sandbox/containers');
            if (!r || !r.ok) {
                sandboxContainers.value = [];
                return;
            }
            const data = await r.json();
            sandboxContainers.value = data.containers || [];
        } catch (e) {
            sandboxContainers.value = [];
        }
    }

    async function adminStopUserSandbox(userId) {
        if (!await openConfirm(
            'Arrêter ce container ?',
            `Le container de l'utilisateur ${userId} sera arrêté. Les processus en cours seront tués.`,
            false, 'Arrêter'
        )) return;
        try {
            const r = await fetchAuth(`/api/admin/sandbox/containers/${userId}/stop`, { method: 'POST' });
            if (!r || !r.ok) throw new Error(r ? await r.text() : 'no response');
            showToast('Container arrêté.', 'success');
            await loadSandboxContainers();
        } catch (e) {
            showToast('Échec : ' + e.message, 'error');
        }
    }

    async function adminDestroyUserSandbox(userId) {
        if (!await openConfirm(
            'Détruire ce container ?',
            `Le container de l'utilisateur ${userId} sera supprimé. Son dossier de travail reste intact.`,
            true, 'Détruire'
        )) return;
        try {
            const r = await fetchAuth(`/api/admin/sandbox/containers/${userId}`, { method: 'DELETE' });
            if (!r || !r.ok) throw new Error(r ? await r.text() : 'no response');
            showToast('Container détruit.', 'success');
            await loadSandboxContainers();
        } catch (e) {
            showToast('Échec : ' + e.message, 'error');
        }
    }

    async function triggerSandboxGc() {
        if (!await openConfirm(
            'Lancer le GC ?',
            "Les containers Docker inactifs depuis plus de la durée configurée seront arrêtés.",
            false, 'Lancer le GC'
        )) return;
        try {
            const r = await fetchAuth('/api/admin/sandbox/gc', { method: 'POST' });
            if (!r || !r.ok) throw new Error(r ? await r.text() : 'no response');
            const data = await r.json();
            showToast(`GC terminé — ${(data.stopped || []).length} container(s) arrêté(s).`, 'success');
            await loadSandboxContainers();
        } catch (e) {
            showToast('GC échec : ' + e.message, 'error');
        }
    }


    // ──────────────────────────────────────────────────────────────────────
    // Observability tab (Phase 1 task #5)
    // ----------------------------------------------------------------------
    // Consomme les 3 endpoints /api/admin/observability/* :
    //   - tool-summary   → KPI cards + table per-tool
    //   - tool-failures  → table des dernières erreurs d'outils
    //   - audit-recent   → table d'audit filtrable
    //
    // Pas de chart ici (le dashboard existant a déjà ToolCallVolumeProvider /
    // ToolCallLatencyProvider via le système de widgets) — cet onglet
    // complémente avec une vue tabulaire + détail d'erreur.
    // ──────────────────────────────────────────────────────────────────────
    const obsScope = ref(24);                  // hours : 24 | 168 | 720
    const obsAuditPrefix = ref('');            // filter "pipeline." / "tool." / "auth." / "rbac." / ...
    const obsLoading = ref(false);
    const obsSummary = ref({ totals: { n: 0 }, per_tool: [] });
    const obsFailures = ref([]);
    const obsAudit = ref([]);

    function fmtTs(ts) {
        if (!ts) return '';
        try {
            const d = new Date(ts * 1000);
            return d.toLocaleString('fr-FR', { hour12: false });
        } catch (_) { return ''; }
    }

    function setObsScope(h) {
        obsScope.value = (h === 168 || h === 720) ? h : 24;
        loadObservability();
    }

    function setObsAuditPrefix(prefix) {
        obsAuditPrefix.value = String(prefix || '');
        loadObservability();
    }

    // AUDIT 2026-09-01 (passe 5, F8) — jeton de fraîcheur : deux clics de
    // portée (24 h → 30 j) ou de filtre d'audit rapprochés laissaient la
    // réponse LENTE écraser la récente (bouton surligné sur le mauvais
    // choix). Seule la DERNIÈRE demande a le droit d'écrire.
    let _obsSeq = 0;
    async function loadObservability() {
        const mySeq = ++_obsSeq;
        obsLoading.value = true;
        const hours = obsScope.value;
        // 3 fetches parallèles — tous indépendants
        try {
            const [rSummary, rFails, rAudit] = await Promise.all([
                fetchAuth(`/api/admin/observability/tool-summary?hours=${hours}&limit=50`, {}, true),
                fetchAuth(`/api/admin/observability/tool-failures?hours=${hours}&limit=100`, {}, true),
                fetchAuth(
                    `/api/admin/observability/audit-recent?hours=${Math.min(hours, 168)}&limit=200`
                    + (obsAuditPrefix.value ? `&action_prefix=${encodeURIComponent(obsAuditPrefix.value)}` : ''),
                    {}, true,
                ),
            ]);
            if (mySeq !== _obsSeq) return;   // réponse périmée
            if (rSummary && rSummary.ok) { const d = await rSummary.json(); if (mySeq === _obsSeq) obsSummary.value = d; }
            if (rFails   && rFails.ok)   { const d = await rFails.json();   if (mySeq === _obsSeq) obsFailures.value = d.items || []; }
            if (rAudit   && rAudit.ok)   { const d = await rAudit.json();   if (mySeq === _obsSeq) obsAudit.value = d.items || []; }
            if (mySeq !== _obsSeq) return;
            // Journaux : le ring buffer serveur amorce la console, puis le flux
            // SSE l'alimente en direct. L'endpoint existait déjà et n'avait
            // plus aucune IHM depuis la suppression de l'onglet « Logs ».
            await loadRecentLogs();
        } catch (e) {
            // Best-effort : on garde les anciennes valeurs en cas d'échec
        } finally {
            // (F8) le finally d'une requête PÉRIMÉE ne doit pas éteindre le
            // spinner de la requête courante encore en vol.
            if (mySeq === _obsSeq) obsLoading.value = false;
        }
    }

    // ── Connecteurs LLM partagés (admin) + allowlist ─────────────────────────
    const admLlmConnectors = ref([]);   // connecteurs partagés
    const admLlmPresets    = ref({});
    const admLlmAllProviders = ref([]); // tous les types (incl. locaux admin-only)
    const admLlmCloudTypes = ref([]);   // types cloud (allowlist users)
    const admLlmAllowed    = ref([]);   // allowlist users actuelle
    const admLlmForm       = ref(null);
    const admLlmBusy       = ref(false);
    const admLlmTest       = ref({});

    // ── Sélecteur de moteur unique (widget « Moteurs disponibles ») ───────────
    // Une liste déroulante choisit LE moteur affiché dans le panneau unique :
    //   '__local__' → serveur llama.cpp intégré (config.json, configForm.llama.*)
    //   '__new__'   → formulaire d'ajout d'un connecteur partagé vierge
    //   <id>        → connecteur partagé existant (édité via admLlmForm)
    const engineSel        = ref('__local__');
    const engineConnector = computed(() =>
        admLlmConnectors.value.find(c => String(c.id) === String(engineSel.value)) || null);
    // Un connecteur s'édite dans un TIROIR (refonte 2026-09-27) : plus de
    // carte dans la carte sous la liste. Le moteur intégré reste en ligne.
    const engineDrawer = ref(null);
    const _drawerFocus = window.elpisFocusGuard ? window.elpisFocusGuard() : { remember() {}, restore() {} };
    function onEngineSelect() {
        const v = engineSel.value;
        if (v === '__local__') { closeEngineDrawer(); return; }
        if (!admLlmForm.value) _drawerFocus.remember();
        if (v === '__new__') newAdmLlmConnector();
        else {
            const c = admLlmConnectors.value.find(x => String(x.id) === String(v));
            if (c) editAdmLlmConnector(c);
            else { closeEngineDrawer(); return; }
        }
        if (ctx.nextTick) ctx.nextTick(() => {
            const el = engineDrawer.value;
            const first = el && el.querySelector('select, input, textarea');
            (first || el) && (first || el).focus();
        });
    }
    function closeEngineDrawer() {
        const wasOpen = !!admLlmForm.value;
        engineSel.value = '__local__';
        admLlmForm.value = null;
        if (wasOpen) _drawerFocus.restore();
    }
    function onEngineDrawerKey(e) {
        if (window.elpisTrapTab) window.elpisTrapTab(e, engineDrawer.value);
    }

    async function loadAdminLlmConnectors() {
        try {
            const r = await fetchAuth('/api/admin/llm/connectors', {}, true);
            if (r && r.ok) {
                const d = await r.json();
                admLlmConnectors.value = d.connectors || [];
                admLlmPresets.value = d.presets || {};
                admLlmAllProviders.value = d.all_provider_types || [];
            }
            const a = await fetchAuth('/api/admin/llm/allowed-providers', {}, true);
            if (a && a.ok) {
                const d = await a.json();
                admLlmAllowed.value = d.allowed || [];
                admLlmCloudTypes.value = d.cloud_provider_types || [];
                markAdminStoreClean('allowed');
            }
        } catch (e) { /* best-effort */ }
    }
    function admLlmLabel(pt) { const p = admLlmPresets.value[pt]; return (p && p.label) || pt; }
    function newAdmLlmConnector() {
        admLlmForm.value = { provider_type: 'vllm', base_url: '', api_key: '', label: '', default_model: '', models_json: '',
                             context_window: null, max_models: null, max_concurrency: null };
    }
    function editAdmLlmConnector(c) {
        admLlmForm.value = { id: c.id, provider_type: c.provider_type, base_url: c.base_url || '',
                             api_key: '', label: c.label || '', default_model: c.default_model || '',
                             models_json: c.models_json || '',
                             context_window: c.context_window || null, max_models: c.max_models || null,
                             max_concurrency: c.max_concurrency || null };
    }
    async function saveAdmLlmConnector() {
        const f = admLlmForm.value; if (!f) return;
        admLlmBusy.value = true;
        try {
            const isEdit = !!f.id;
            const url = isEdit ? ('/api/admin/llm/connectors/' + f.id) : '/api/admin/llm/connectors';
            const body = { base_url: (f.base_url || '').trim(), label: (f.label || '').trim(),
                           default_model: (f.default_model || '').trim(), models_json: (f.models_json || '').trim() };
            if (!isEdit) body.provider_type = f.provider_type;
            if ((f.api_key || '').trim()) body.api_key = f.api_key.trim();
            // Capacité d'un serveur llama.cpp : vide = découverte (null côté serveur).
            if (f.provider_type === 'llamacpp') {
                for (const k of ['context_window', 'max_models', 'max_concurrency']) {
                    const v = f[k];
                    body[k] = (typeof v === 'number' && v > 0) ? Math.round(v) : null;
                }
            }
            const r = await fetchAuth(url, { method: isEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (r && r.ok) {
                // Récupère l'id (création → réponse {id} ; édition → f.id) pour
                // garder le widget centré sur le connecteur après sauvegarde.
                let cid = f.id;
                if (!isEdit) { const d = await r.json().catch(() => ({})); cid = d.id || null; }
                await loadAdminLlmConnectors();
                // Enregistrer referme le tiroir ; la ligne porte Tester.
                closeEngineDrawer();
                showToast(isEdit ? 'Connecteur mis à jour' : 'Connecteur ajouté', 'success');
            }
            else { const e = r ? await r.json().catch(() => ({})) : {}; showToast(e.detail || 'Échec', 'error'); }
        } finally { admLlmBusy.value = false; }
    }
    async function deleteAdmLlmConnector(c) {
        const ok = await openConfirm('Supprimer le connecteur partagé ?', (admLlmLabel(c.provider_type) + (c.label ? ' · ' + c.label : '')), true);
        if (!ok) return;
        const r = await fetchAuth('/api/admin/llm/connectors/' + c.id, { method: 'DELETE' });
        if (r && r.ok) {
            // Le moteur supprimé était peut-être sélectionné → repli sur l'intégré.
            closeEngineDrawer();
            await loadAdminLlmConnectors(); showToast('Supprimé', 'success');
        }
    }
    async function testAdmLlmConnector(c) {
        admLlmTest.value = Object.assign({}, admLlmTest.value, { [c.id]: { testing: true } });
        try {
            const r = await fetchAuth('/api/admin/llm/connectors/' + c.id + '/test', { method: 'POST' });
            const d = r ? await r.json().catch(() => ({ ok: false })) : { ok: false };
            admLlmTest.value = Object.assign({}, admLlmTest.value, { [c.id]: d });
        } catch (e) { admLlmTest.value = Object.assign({}, admLlmTest.value, { [c.id]: { ok: false, error: String(e) } }); }
    }
    function toggleAdmAllowed(pt) {
        const cur = admLlmAllowed.value.slice();
        const i = cur.indexOf(pt);
        if (i >= 0) cur.splice(i, 1); else cur.push(pt);
        admLlmAllowed.value = cur;
    }
    async function saveAdmAllowed() {
        try {
            const r = await fetchAuth('/api/admin/llm/allowed-providers', { method: 'PUT',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowed: admLlmAllowed.value }) });
            if (r && r.ok) { const d = await r.json(); admLlmAllowed.value = d.allowed || []; return true; }
            return false;
        } catch (e) { return false; }
    }

    return {
        // ── Connecteurs LLM (admin) ──
        admLlmConnectors, admLlmPresets, admLlmAllProviders, admLlmCloudTypes, admLlmAllowed,
        admLlmForm, admLlmBusy, admLlmTest, admLlmLabel,
        loadAdminLlmConnectors, newAdmLlmConnector, editAdmLlmConnector,
        saveAdmLlmConnector, deleteAdmLlmConnector, testAdmLlmConnector, toggleAdmAllowed, saveAdmAllowed,
        engineSel, engineConnector, onEngineSelect, engineDrawer, closeEngineDrawer, onEngineDrawerKey,
        // ── Navigation (registre frontend/js/admin/_registry.js) ──
        adminNav, adminPage, goAdminPage, goAdminEntry, adminMeOpen, adminH1, adminScroller, focusAdminTitle,
        // Vue d'ensemble + redémarrage en attente (lot 6)
        adminIsAdmin, adminCanOpen, overview, overviewLoading, overviewFailed, loadOverview,
        startOverviewPolling, stopOverviewPolling, overviewAge, overviewAttention, overviewSetupLeft,
        overviewStateLabel, overviewStateIcon, overviewAlertDetail, overviewBackupLabel, fmtCompact,
        runOverviewAction, overviewShortcut,
        restartPaths, restartPending, loadRestartStatus, adminChangeNeedsRestart,
        // Recherche Ctrl+K (lot 7)
        paletteOpen, paletteQuery, paletteIndex, paletteInput, paletteResults,
        openPalette, closePalette, runPaletteItem, onPaletteKey,
        // ── Rapport quotidien d'usage IA + maintenance ──
        dailyReport, dailyReportLoading, dailyReportGenerating, reportHistory,
        dailyDigestAuto, setDailyDigestAuto,
        loadDailyReport, generateDailyReport, printDailyReport,
        reportVal, reportTitle, reportValueSections,
        adminTab, adminTabTitle, usersList, dashboardData, configForm, resetTarget, newPasswordInput, liveLogs,
        dashMenu, widgetPrefs,
        // v17 — Global time scope (24h/7j/30j) for scope-aware widgets
        dashboardScope, setDashboardScope,
        isSavingAdminConfig,
        isWidgetVisible, toggleWidgetVisibility, allWidgetsList, resetWidgetPrefs,
        // Réinitialisation des métriques + jeton de scrape
        resetWidget, resetAllMetrics, exportUsage,
        scrapeToken, loadScrapeToken, setScrapeToken, copyScrapeToken,
        // KPI categorization (Activité / Volume / Performance / Système)
        kpiCategories: KPI_CATEGORIES,
        kpisInCategory,
        // Sous-pages Métriques par groupe
        chartsInCategory, kpiGroups, chartGroups, kpiState, chartSummary,
        prometheusUrl, copyPrometheusUrl,
        groupsList, allUsersWithGroups, groupModal, groupMembersModal,
        userEdit, userEditDirty, userEditOpen, toggleUserEdit, closeUserEdit, saveUserEdit, revokeUserAccess,
        usersDesktopTargets, admRoleLabel, admNetProfileName, admDesktopLabel, admDesktopTitle,
        loadUsers, loadAdminStats, renderDynamicDashboard, startDashboardPolling, stopDashboardPolling, destroyAllCharts, setUserSandboxQuota,
        usersNetProfiles, setUserNetworkProfile,
        usersSearch, usersSort, usersPage, usersPageCount, pagedUsers, filteredSortedUsers, toggleUsersSort,
        // Logs page (filter toolbar + console)
        logFilters, logAutoScroll, logsConsoleRef, filteredLogs,
        logsLoading, loadRecentLogs, fmtLogTs,
        // Enregistrement par page (barre du bas, garde de sortie, Ctrl+S)
        adminDirtyStores, adminDirtyCount, adminPageSavable, isSavingAdminPage,
        adminPageChanges, adminChangesOpen, adminChangeLabel, adminChangeValue,
        adminChangeRevertable, revertAdminChange, adminConfirmLeave,
        saveAdminPage, discardAdminPage,
        // Vision & Desktop — control-agent target rows + client bundle/install
        addDesktopTarget, removeDesktopTarget, setDefaultTarget, downloadAgentBundle,
        installShCmd, installPs1Cmd, copyInstallCmd,
        // Cookies & sessions admin section
        securityOverview, securityBusy,
        loadSecurityOverview,
        revokeAllSessions, clearUserRevocation,
        // Accès HTTPS (toggle Caddy)
        httpsStatus, httpsBusy, httpsRedirectUrl,
        loadHttpsStatus, toggleHttps, setListen,
        dashboardPollMs, pollLabel, pollFaster, pollSlower,
        livePollMs, livePollLabel, liveFaster, liveSlower,
        adminAutoOpen, toggleAdminAutoOpen,
        downloadBackup, triggerRestore, restoreScope, transferModal, closeTransferModal, fmtElapsed,
        // Helpers de transfert EXPORTÉS (règle : import/export = modale de
        // progression in-app) — consommés par backup/restore/exports admin.
        uploadWithModal, downloadWithModal,
        deleteUser, restartServer, loadAdminConfig,
        // Sauvegarde distante (connecteurs SFTP / dossier monté)
        remoteBackup, remoteKeyFp, remoteBackupBusy,
        remoteRsyncPassword, clearRsyncPassword, remoteNextRunLabel, remoteDateLabel,
        loadRemoteBackup, saveRemoteBackup, uploadBackupKey, testRemoteBackup, sendRemoteBackup,
        // LLM scheduling (panneau "Performances LLM" dans config)
        llmScheduling, llmSchedulingProbing, llmSchedulingSaving,
        loadLlmScheduling, probeLlmCapabilities, saveLlmSchedulingMode,
        // Compression conversationnelle (panneau "Compression" dans config)
        compressionCfg, compressionSaving,
        loadCompressionCfg, saveCompressionCfg,
        // RAG service — Intégrations panel (Tester la connexion)
        ragServiceTest, testRagServiceConnection,
        dbState, dbForm, dbTest, dbSim, dbJob, dbBusy, loadDatabase, dbBackendChanged,
        testDatabase, saveDatabase, simulateDatabase, migrateDatabase, revertDatabaseToSqlite,
        voiceTest, testVoiceConnection, voiceModels, loadVoiceModels,
        handleAdminWelcomeUpload, handleAppInfoLogoUpload, handleLoginLogoUpload, openResetModal, confirmReset,
        // Aperçu vivant du mot animé (carte « Écran d'accueil »)
        apercuAccueil, apercuPerso, MASCOTTES_APERCU,
        MASCOTTES_ADMIN, mascotteActive, basculerMascotte,
        exportMetrics,
        loadGroups, saveGroup, openCreateGroup, openEditGroup, confirmDeleteGroup,
        openGroupMembers, isInCurrentGroup, toggleMembership,
        // Accès aux serveurs d'inférence par compte / groupe (lot B4)
        admLlmAccessOptions, loadAdmLlmAccessOptions,
        admLlmAccessServersLabel, admLlmAccessServersTitle,
        admLlmAccessManageLabel, admLlmAccessManageTitle,
        // AX Memory
        axSites, axSelected, axExpanded, axTrees, axTreeLoading, axLoading,
        showAxModal, openAxModal,
        loadAxSites, toggleAxSite, toggleSelectAllAx,
        deleteSite, deleteCreds, markStale,
        bulkDelete, bulkMarkStale, confirmWipeAll,
        // System Prompts admin tab
        promptsList, promptsSelected, promptsEditorText, promptsEditorDirty,
        promptsLoading, promptsPreview, promptsPreviewCats,
        loadSystemPrompts, selectPrompt, savePrompt, reloadPrompt,
        refreshPreview,
        // Prompts — catégorisation graphique (front-only)
        promptsGrouped, isPromptGroupCollapsed, togglePromptGroup, promptMeta, fmtBytes,
        // ── Exec / Sandbox admin (v3 user-centric) ──
        execLoading, execConfig, execHealthcheck, execExtraArgsText,
        sandboxContainers,
        staleNetContainers, staleNetBusy, recreateStaleNetContainers,
        addNetworkProfile, removeNetworkProfile,
        // Éditeur d'allowlist en puces (validation à la saisie)
        netFields, netPortsMode, setPortsMode, setProfileMode,
        commitNetValue, removeNetValue, addNetPreset,
        // Cartes de profil repliables
        toggleProfile, netModeKey, netModeLabel, netModeIcon,
        netProfileSummary, netProfileIssue,
        loadExecConfig, loadExecHealthcheck, saveExecConfig,
        loadSandboxContainers,
        // Manifeste mcp.json (outils par défaut)
        mcpManifest, mcpManifestBusy, loadMcpManifest, reloadMcpManifest, mcpManifestRoleLabel,
        oauthClients, loadOauthClients, deleteOauthClient,
        mcpExportTransport, mcpExportToken, copyMcpExport,
        // Hôtes d'outils (P5)
        toolhosts, toolhostMoveTarget, toolhostBusy, loadToolhosts, migrateToolhostPlacement, assignToolhostPlacement,
        adminStopUserSandbox, adminDestroyUserSandbox, triggerSandboxGc,
        // ── Observability tab (Phase 1 task #5) ──
        obsScope, obsAuditPrefix, obsLoading,
        obsSummary, obsFailures, obsAudit,
        setObsScope, setObsAuditPrefix, loadObservability, fmtTs,
    };
}
