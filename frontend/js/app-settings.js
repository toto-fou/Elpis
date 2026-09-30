// SPDX-License-Identifier: MIT
function setupSettings(vue, sharedRefs, ctx) {
    const { ref, computed, watch, nextTick } = vue;
    const { user, settings, config, inputMessage, inputRef } = sharedRefs;
    const { showToast, fetchAuth, openConfirm, openPrompt } = ctx;

    const showSettingsModal = ref(false);
    const settingsDialogEl = ref(null);    // a11y : cible de focus à l'ouverture de la modale
    const showMcpManagerModal = ref(false);
    const settingsTab = ref('profile');
    const showPasswordChange = ref(false);
    // États « prod » du panneau Paramètres.
    const settingsSaving = ref(false);     // sauvegarde explicite en cours (anti double-clic + spinner)
    const passwordSaving = ref(false);     // changement de mot de passe en cours
    const _settingsSnapshot = ref('');     // image de settings à l'ouverture (détection « non enregistré »)
    const settingsDirty = computed(() => !!_settingsSnapshot.value && JSON.stringify(settings.value) !== _settingsSnapshot.value);
    function _settingsErrorMsg(status, err) {
        if (status === 401 || status === 403) return 'Session expirée : reconnectez-vous puis réessayez.';
        if (status === 413) return 'Données trop volumineuses : raccourcis le prompt système.';
        if (status >= 500) return 'Erreur serveur : paramètres non enregistrés, réessaie.';
        const d = (err && typeof err.detail === 'string') ? err.detail : '';
        return (d && d.length < 120) ? d : 'Paramètres non enregistrés : vérifie les valeurs puis réessaie.';
    }
    // (``editorPrefsExpanded`` retiré 2026-08-16 avec l'accordéon « Plus
    //  d'options » de l'onglet Fonctionnalités : les réglages de l'éditeur sont
    //  désormais rangés dans deux groupes NOMMÉS — affichage / comportement —
    //  qui n'apparaissent que si le module est activé. Un en-tête qui dit ce
    //  qu'il contient remplace avantageusement un repli qui ne dit rien.)
    // ── Skins (habillages visuels interchangeables) ──────────────
    // Registre SERVEUR depuis le 2026-09-28 : les intégrés sont décrits par
    // frontend/css/skins/skins.json, les skins importés vivent dans le dossier
    // de l'instance, et l'administrateur choisit ceux qui sont proposés
    // (console › Système › Apparence). ``GET /api/skins`` ne rend que les
    // skins ACTIVÉS. Le skin id='' (Ardoise) = style.css sans classe
    // ``elpis-skin-*``. Repli minimal si l'appel échoue : Elpis + Ardoise.
    const _SKINS_REPLI = [
        { id: 'elpis', label: 'Elpis',   desc: '', builtin: true, sw: ['#f3efe8', '#fcfbf9', '#b88a3d'] },
        { id: '',      label: 'Ardoise', desc: '', builtin: true, sw: ['#0f172a', '#f8fafc', '#2563eb'] },
    ];
    const APP_SKINS = ref(_SKINS_REPLI.slice());
    const skinsDefaut = ref('elpis');
    const _skinsBody = (d) => (d && Array.isArray(d.skins) && d.skins.length) ? d.skins : null;
    async function loadAppSkins() {
        try {
            const r = await fetchAuth('/api/skins', {}, true);
            if (!r || !r.ok) return false;
            const d = await r.json();
            const liste = _skinsBody(d);
            if (liste) APP_SKINS.value = liste;
            if (d && typeof d.default === 'string') skinsDefaut.value = d.default;
            return true;
        } catch (_) { return false; }
    }

    /* Le skin RETENU, pour afficher sa description sous la liste. Le sélecteur
     * est passé de six pavés à une liste déroulante : le nom seul ne dit pas
     * « colonne centrée » ni « Comic Sans », et c'est justement ce qu'on veut
     * savoir avant de choisir. Repli sur la première entrée plutôt que sur
     * rien — une valeur inconnue en base ne doit pas vider la ligne. */
    /* LE NOM AFFICHÉ DANS LE RAIL. Un skin qui porte une marque (``brand``,
     * ex. « Kiki ») renomme l'assistant — mais
     * seulement si personne ne l'a déjà renommée : un nom d'assistant choisi
     * par l'utilisateur l'emporte sur le skin. « Elpis » (app.js) et
     * « Assistant » (repli de loadSettingsData) sont les deux DÉFAUTS : ils
     * comptent comme « pas renommé ». */
    const nomMarque = computed(() => {
        const s = settings.value || {};
        const nom = s.assistant_name || 'Elpis';
        const parDefaut = nom === 'Elpis' || nom === 'Assistant';
        const marque = skinCourant.value && skinCourant.value.brand && skinCourant.value.brand.name;
        return marque && parDefaut ? marque : nom;
    });

    const skinCourant = computed(() => {
        const id = (settings.value && settings.value.skin) || '';
        const liste = APP_SKINS.value;
        return liste.find(k => k.id === id) || liste[0] || _SKINS_REPLI[0];
    });

    // ── Application au <body> : skin, mode sombre, marqueur dark-surface ──
    // Déplacé depuis app-editor.js (correctif skins 2026-07) : admin.html ne
    // charge PAS app-editor.js mais doit suivre le skin — app-settings.js est
    // chargé par les deux pages. Le thème Monaco (``editor_dark_mode``) reste
    // dans app-editor.js (découplage UX inchangé).
    //
    // ``elpis-dark-surface`` (MARQUEUR) : posé quand le mode sombre est ON
    // OU quand le skin est à base sombre (``darkBase``, ex. Émeraude). C'est
    // lui qui active les remaps utilitaires « claire-sur-sombre » de
    // style.css ; ``elpis-app-dark`` ne porte plus que le bloc de tokens
    // neutres du toggle (et les blocs sombres des skins).
    function _applyAppDarkMode(on) {
        try {
            if (on) document.body.classList.add('elpis-app-dark');
            else document.body.classList.remove('elpis-app-dark');
        } catch (_) {}
    }
    function _applyAppSkin(id) {
        try {
            const cls = document.body.classList;
            // Retire toute classe elpis-skin-* précédemment posée.
            Array.from(cls).forEach(c => { if (c.indexOf('elpis-skin-') === 0) cls.remove(c); });
            if (id) cls.add('elpis-skin-' + id);
        } catch (_) {}
    }
    // Mode sombre EFFECTIF : « Système » (dark_mode_auto) suit la préférence
    // de l'OS, en direct ; sinon le choix explicite (dark_mode).
    const _prefersDark = ref(false);
    try {
        const _mq = window.matchMedia('(prefers-color-scheme: dark)');
        _prefersDark.value = !!_mq.matches;
        const _onMq = (e) => { _prefersDark.value = !!e.matches; };
        if (_mq.addEventListener) _mq.addEventListener('change', _onMq);
        else if (_mq.addListener) _mq.addListener(_onMq);
    } catch (_) {}
    const appDark = computed(() => {
        const s = settings.value || {};
        return s.dark_mode_auto ? _prefersDark.value : !!s.dark_mode;
    });
    function _applyDarkSurface() {
        try {
            const s = settings.value || {};
            const sk = APP_SKINS.value.find(k => k.id === (s.skin || ''));
            const on = appDark.value || !!(sk && sk.darkBase);
            document.body.classList.toggle('elpis-dark-surface', on);
        } catch (_) {}
    }
    // (passe 3 2026-08-31) — re-thème des graphiques/diagrammes DÉJÀ rendus :
    // Chart.js fige ses couleurs à la création et Mermaid cuit son thème dans
    // le SVG — sans ce hook, basculer en sombre laissait des libellés
    // illisibles et des cartes blanches jusqu'au rechargement. Différé d'un
    // tick pour que les classes <body> soient posées avant la relecture.
    function _rethemeVisuals() {
        try {
            if (window.elpisRethemeVisuals) setTimeout(window.elpisRethemeVisuals, 0);
        } catch (_) {}
    }
    watch(appDark, (on) => {
        _applyAppDarkMode(on);
        _applyDarkSurface();
        _rethemeVisuals();
    }, { immediate: true });
    watch(() => settings.value && settings.value.skin, (id) => {
        _applyAppSkin(id || '');
        _applyDarkSurface();
        _rethemeVisuals();
    }, { immediate: true });
    // Skin IMPORTÉ : sa feuille est générée par le serveur et liée À LA
    // DEMANDE — seulement celle du skin actif (les intégrés gardent leurs
    // <link> statiques d'index.html / admin.html). Ajoutée en fin de <head>,
    // donc après style.css : elle gagne les égalités de spécificité.
    function _applyPluginSkinCss(sk) {
        try {
            const url = sk && !sk.builtin && sk.css_url ? sk.css_url : '';
            let el = document.getElementById('elpis-plugin-skin');
            if (!url) { if (el) el.remove(); return; }
            if (!el) {
                el = document.createElement('link');
                el.id = 'elpis-plugin-skin';
                el.rel = 'stylesheet';
                document.head.appendChild(el);
            }
            if (el.getAttribute('href') !== url) el.setAttribute('href', url);
        } catch (_) {}
    }
    watch(() => skinCourant.value && (skinCourant.value.id + '|' + (skinCourant.value.css_url || '')),
          () => { _applyPluginSkinCss(skinCourant.value); _applyDarkSurface(); }, { immediate: true });
    const passwordForm = ref({ old_password: '', new_password: '', confirm_password: '' });
    const newMcp = ref({ name: '', type: 'sse', url: '', command: '',
                         auth_mode: '', auth_user: '', auth_secret: '',
                         has_auth: false, _idx: null });
    const savedPromptsList = ref([]);
    // ── Mes skills (mémoire procédurale perso) ───────────────────
    const archivesList = ref([]);
    const archiveSelectMode = ref(false);
    const archiveSelected = ref([]);
    // ── Onglet « Utilisation » (métriques de l'utilisateur courant) ──────
    const usageData = ref(null);          // payload de /api/usage/me
    const usageLoading = ref(false);
    const usageError = ref('');
    const usageDays = ref(30);            // 1 | 7 | 30 | 90
    const customMcpList = ref([]);
    const mcpFileInput = ref(null);
    const mcpSearch = ref('');
    const showSharedPrompts = ref(false);
    const sharedPromptsList = ref([]);
    const inboxCount         = ref(0);   // total shared prompts + pipelines waiting
    let   _inboxPollTimer    = null;
    const sharedSelectMode = ref(false);
    const sharedSelected = ref([]);
    const isShareModalOpen = ref(false);
    const promptToShare = ref(null);
    const allUsersLite = ref([]);
    const myGroups = ref([]);
    const selectedGroupFilter = ref(null);
    const shareTargetUsers = ref([]);
    const selectAllUsers = ref(false);
    // Returns [{groupLabel, users}] for grouped display, or flat list when filter active
    const groupedShareUsers = vue.computed(() => {
        const users = allUsersLite.value;
        if (selectedGroupFilter.value) {
            const gname = myGroups.value.find(g => g.id === selectedGroupFilter.value)?.name;
            const filtered = gname ? users.filter(u => u.groups && u.groups.split(', ').includes(gname)) : users;
            return [{ groupLabel: gname || 'Groupe', users: filtered }];
        }
        if (!myGroups.value.length) return [{ groupLabel: null, users }];
        const grouped = {};
        const noGroup = [];
        users.forEach(u => {
            const gs = u.groups ? u.groups.split(', ').filter(Boolean) : [];
            if (!gs.length) { noGroup.push(u); return; }
            gs.forEach(g => {
                if (!grouped[g]) grouped[g] = [];
                grouped[g].push(u);
            });
        });
        const result = Object.entries(grouped)
            .sort(([a],[b]) => a.localeCompare(b))
            .map(([label, us]) => ({ groupLabel: label, users: us.sort((a,b) => a.username.localeCompare(b.username)) }));
        if (noGroup.length) result.push({ groupLabel: 'Sans groupe', users: noGroup });
        return result;
    });

    const filteredShareUsers = vue.computed(() => groupedShareUsers.value.flatMap(g => g.users));
    const showHelpModal = ref(false);
    const readmeContent = ref('');
    const isLoadingReadme = ref(false);
    // Aide in-app : deux documents (guide utilisateur vs doc dev) + conteneur
    // de la modal pour hydrater les diagrammes Mermaid après rendu (v-html ne
    // déclenche pas, seul, le pipeline mermaid/chart partagé avec le chat).
    const helpDoc = ref('user');           // 'user' | 'dev'
    const helpBodyRef = ref(null);

    // ── Bibliothèque MCP PARTAGÉE (publiée par l'admin, lue par tous) ────
    // La liste vient de GET /api/mcp/shared-servers ; elle ne contient JAMAIS
    // d'identifiant d'accès (le backend ne rend que ``has_auth`` et résout
    // URL + en-tête côté serveur au moment du tour de chat). Ce que le compte
    // choisit d'AFFICHER vit dans settings.shared_mcp_visible — vide par
    // défaut, donc rien ne s'ajoute au panneau Outils sans geste explicite.
    const sharedMcpServers = ref([]);
    const sharedMcpForm    = ref(null);   // admin : null | {id?, name, type, …}
    const sharedMcpError   = ref('');

    async function loadSharedMcpServers() {
        try {
            const r = await fetchAuth('/api/mcp/shared-servers', {}, true);
            if (!r || !r.ok) return;
            const data = await r.json();
            sharedMcpServers.value = (data && data.servers) || [];
        } catch (e) { /* réseau : la bibliothèque reste vide, le reste marche */ }
    }

    function isSharedVisible(id) {
        return ((settings.value.shared_mcp_visible) || []).includes(id);
    }

    async function toggleSharedVisibility(id) {
        const list = settings.value.shared_mcp_visible || (settings.value.shared_mcp_visible = []);
        const i = list.indexOf(id);
        if (i >= 0) {
            list.splice(i, 1);
            // Masquer un serveur le retire aussi du chat courant : laisser un
            // toggle actif sur une entrée invisible serait un outil fantôme.
            config.value.active_mcp_ids = (config.value.active_mcp_ids || []).filter(x => x !== id);
        } else {
            list.push(id);
        }
        await saveSettings(false);
    }

    // Projection UNIQUE de la bibliothèque partagée vers la forme « serveur »
    // du panneau Outils. Les deux listes ci-dessous en dérivent : dupliquer le
    // critère (actif ET coché par ce compte) les ferait diverger au premier
    // changement de règle.
    const visibleSharedServers = computed(() => sharedMcpServers.value
        .filter(s => s.enabled && isSharedVisible(s.id))
        .map(s => ({ id: s.id, name: s.name, type: s.type,
                     visible: true, shared: true })));

    // Serveurs affichables dans le panneau Outils : les perso marqués visibles
    // + la bibliothèque partagée cochée. Source UNIQUE pour le panneau, la page
    // Routines, et ce que le chat envoie au backend.
    const pinnedServers = computed(
        () => (settings.value.mcp_servers || []).filter(s => s.visible)
                  .concat(visibleSharedServers.value));

    // Serveurs référençables par un agent CUSTOM (``mcp_server_ids``) : TOUS
    // les serveurs perso (même masqués du panneau — les masquer est un choix
    // d'affichage du chat, pas une dépublication) + la bibliothèque partagée
    // affichée. Le backend résout la même union côté chat.
    const agentMcpChoices = computed(
        () => (settings.value.mcp_servers || []).concat(visibleSharedServers.value));

    // Liste des serveurs MCP enregistrés filtrée par la recherche.
    // Chaque item conserve son index d'origine dans _idx pour que les actions
    // (toggleServerVisibility, removeMcpServer) ciblent la bonne entrée même
    // après filtrage.
    const filteredMcpServers = computed(() => {
        const list = (settings.value.mcp_servers || []).map((s, i) => Object.assign({}, s, { _idx: i }));
        const q = (mcpSearch.value || '').trim().toLowerCase();
        if (!q) return list;
        return list.filter(s => {
            const hay = [s.name, s.url, s.command, s.type].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(q);
        });
    });

    async function loadSettingsData() {
        // La liste des skins arrive EN PARALLÈLE des réglages : le sélecteur
        // et la classe <body> la lisent, pas l'enregistrement.
        loadAppSkins();
        try {
            const res = await fetchAuth('/api/settings', {}, true);
            if (res && res.ok) {
                const data = await res.json();
                if (data.enable_editor === undefined) data.enable_editor = true;
                if (data.enable_preview === undefined) data.enable_preview = false;
                if (data.enable_rag === undefined) data.enable_rag = true;
                // Fail-open, ALIGNÉ sur le backend : clé absente = outils actifs.
                // À false, l'UI aurait montré « coupé » alors que le serveur
                // (défaut ON) laissait passer les outils — pire que le bug d'avant.
                if (data.enable_mcp === undefined) data.enable_mcp = true;
                if (data.enable_charts === undefined) data.enable_charts = false;
                if (data.auto_open_editor_on_write === undefined) data.auto_open_editor_on_write = true;
                if (data.dark_mode === undefined) data.dark_mode = false;
                if (data.dark_mode_auto === undefined) data.dark_mode_auto = false;
                if (data.hide_thinking === undefined) data.hide_thinking = false;
                if (data.live_shell_enabled === undefined) data.live_shell_enabled = true;  // terminal en direct = défaut ON
                // Voix — opt-in strict des DEUX côtés. Ces lignes miroitent les
                // défauts de ``api_get_settings`` : désalignées, la valeur affichée
                // dépendrait de qui du GET ou du PUT a peuplé la ligne en premier.
                if (data.voice_input_enabled === undefined) data.voice_input_enabled = false;
                if (data.voice_reply_enabled === undefined) data.voice_reply_enabled = false;
                if (data.voice_reply_tools_enabled === undefined) data.voice_reply_tools_enabled = false;
                if (data.memory_enabled === undefined) data.memory_enabled = false;  // mémoire long-terme = opt-in
                if (data.agents_enabled === undefined) data.agents_enabled = false;  // sous-agents (outil task) = opt-in
                // opencode : familles d'outils activées. Clé absente ou famille
                // absente de l'objet = ACTIVE (fail-open, aligné sur le serveur
                // qui publie ``enabled: true`` par défaut).
                if (!data.opencode_mcp_families || typeof data.opencode_mcp_families !== 'object'
                        || Array.isArray(data.opencode_mcp_families)) data.opencode_mcp_families = {};
                if (data.compression_enabled === undefined) data.compression_enabled = false;  // compaction auto = opt-in
                // Seuil de compaction : 0 des DEUX côtés = auto (plafond
                // technique) — c'est aussi ce que renvoie le serveur quand le
                // compte n'a rien réglé. Les deux unités sont exclusives (cf.
                // compactionUnit) ; les tokens priment côté serveur.
                if (data.compression_threshold_pct === undefined) data.compression_threshold_pct = 0;
                if (data.compression_threshold_tokens === undefined) data.compression_threshold_tokens = 0;
                // Compactions max par conversation : 0 = auto (plafond de
                // l'instance), -1 = illimité, n > 0 = plafond choisi.
                if (data.compression_max_rounds === undefined) data.compression_max_rounds = 0;
                compactionUnitPin.value = '';   // l'unité redevient celle des valeurs servies
                compactionRoundsPin.value = '';
                if (!Array.isArray(data.custom_agents)) data.custom_agents = [];     // agents custom (façon OpenCode /agent)
                // Bibliothèque MCP partagée : ids affichés par CE compte. Vide
                // par défaut ⇒ rien ne s'ajoute au panneau sans geste explicite.
                if (!Array.isArray(data.shared_mcp_visible)) data.shared_mcp_visible = [];
                if (data.skin === undefined) data.skin = '';   // '' = skin par défaut (aucune classe)
                // Mascotte d'accueil : le coffre par défaut. Clé ABSENTE seulement
                // pour un compte jamais migré — "" est un choix (« le logo »), et
                // `undefined` ne doit pas s'y confondre (cf. `??` dans _mascotte.js).
                if (data.welcome_mascot === undefined) data.welcome_mascot = 'boite_or';
                // Editor preferences (added in pass 7) — defaults match
                // the backend so user sees the same value whether GET or
                // PUT is the first to populate the row.
                if (data.editor_font_size === undefined) data.editor_font_size = 14;
                if (data.editor_font_family === undefined) data.editor_font_family = 'JetBrains Mono';
                if (data.editor_tab_size === undefined) data.editor_tab_size = 4;
                if (data.editor_insert_spaces === undefined) data.editor_insert_spaces = true;
                if (data.editor_word_wrap === undefined) data.editor_word_wrap = 'off';
                if (data.editor_minimap === undefined) data.editor_minimap = false;
                if (data.editor_line_numbers === undefined) data.editor_line_numbers = true;
                if (data.editor_edit_highlight === undefined) data.editor_edit_highlight = true;
                if (data.editor_auto_save === undefined) data.editor_auto_save = 'off';
                if (data.editor_persist_tabs === undefined) data.editor_persist_tabs = true;   // mémoriser les onglets = défaut ON (2026-09-19)
                if (data.editor_follow_active === undefined) data.editor_follow_active = false; // l'arbre suit le fichier ouvert = opt-in
                if (data.editor_ratio === undefined) data.editor_ratio = 50;
                if (data.chat_width === undefined) data.chat_width = 60;
                if (data.assistant_name === undefined) data.assistant_name = 'Assistant';
                if (data.assistant_icon === undefined) data.assistant_icon = 'ph-robot';
                if (data.assistant_avatar === undefined) data.assistant_avatar = '';
                data.mcp_servers = (data.mcp_servers || []).map((s, idx) => ({
                    ...s, visible: (s.visible !== undefined) ? s.visible : true,
                    type: s.type || 'sse', command: s.command || '',
                    id: s.id || `server_${idx}_${Date.now()}`
                }));
                settings.value = data;
                // Serveurs MCP actifs : l'état est désormais PER-CHAT (entrées
                // ``ext:<id>`` de meta_json["tools"], même logique que les
                // catégories locales — bug 2026-08-02 : l'état global
                // ``settings.active_mcp_ids`` « collait » d'un chat à l'autre
                // et re-s'activait sur les nouveaux chats). On n'hydrate donc
                // PLUS config.active_mcp_ids ici : loadChat/startNewChat font
                // autorité (``settings.active_mcp_ids`` reste une clé legacy
                // ignorée en lecture).
                if (settings.value.enable_model_selector) await ctx.loadAvailableModels();
                // Bibliothèque partagée : chargée ICI (et pas seulement à
                // l'ouverture des Paramètres) — ``pinnedServers`` la consomme
                // pour le panneau Outils, qui s'affiche dès la connexion.
                // Console admin seule : pas de panneau Outils, et la route
                // n'existe pas sur le processus admin.
                if (!window.__ADMIN_ONLY_MODE__) loadSharedMcpServers();
            }
        } catch(e) {}
    }

    async function openSettings() {
        await loadSettingsData();
        _settingsSnapshot.value = JSON.stringify(settings.value);   // base de comparaison « non enregistré »
        // ``usePrompt`` ferme la modale en écrivant showSettingsModal=false, sans
        // passer par closeSettings : sans ce reset, on rouvrirait sur un brouillon
        // mémoire orphelin. L'ouverture est le seul point de passage garanti.
        cancelMemoryEdit();
        // Refresh all tab data so the user never sees stale content
        loadSavedPrompts();
        loadSharedPrompts();
        loadArchives();
        // Onglet sur lequel la modale se rouvre : ses données sont relues (la
        // fermeture a pu les vider — Connexions oublie jetons et politique —,
        // ou elles ont changé depuis). Sans ça, liste vide jusqu'au rechargement.
        const _rouvert = _TAB_LOADERS[settingsTab.value];
        if (_rouvert) { try { _rouvert(); } catch (_) { /* best-effort */ } }
        showSettingsModal.value = true;
        // a11y : déplacer le focus dans la modale à l'ouverture (sortie au clavier via Échap).
        try { await nextTick(); settingsDialogEl.value && settingsDialogEl.value.focus(); } catch(_) {}
    }
    // Ouverture sur un onglet précis (commandes « / » : /settings, /memory,
    // /usage). Chaque bouton de la barre latérale déclenche SON chargeur —
    // openSettings n'en appelle que quelques-uns, donc sans cette table
    // l'onglet ciblé s'ouvrirait vide. Table LITTÉRALE, alignée sur les
    // @click de includes/modals/settings.html.
    const _TAB_LOADERS = {
        ai_models:  () => loadLlmConnectors(),
        usage:      () => loadUsageData(),
        memory:     () => loadUserMemory(),
        prompts:    () => Promise.all([loadSavedPrompts(), loadPromptTemplates()]),
        archives:   () => loadArchives(),
        sandbox:    () => loadSandboxState(),
        connectors: () => loadGitConnectors(),
        connexions: () => _cnxMod.loadConnexions(),
        // Ces deux-là vivent hors du module Paramètres (cf. proxies d'app.js).
        agents:     () => ctx.loadMcpUserCategories && ctx.loadMcpUserCategories(),
        skills:     () => ctx.openSkillsTab && ctx.openSkillsTab(),
    };

    async function openSettingsTab(tab) {
        await openSettings();
        if (!tab) return;
        // Sous-vue « onglet:vue » : « prompts:templates » ouvre la section
        // Templates sur un formulaire neuf (« Nouveau template » du menu « / »).
        let sub = '';
        if (typeof tab === 'string' && tab.indexOf(':') > 0) [tab, sub] = tab.split(':');
        settingsTab.value = tab;
        const load = _TAB_LOADERS[tab];
        if (load) { try { await load(); } catch (_) { /* onglet ouvert quand même */ } }
        if (tab === 'prompts' && sub === 'templates') startNewTemplate();
    }

    async function closeSettings(skipReload = false) {
        // Robustesse : les handlers template en référence de méthode passent
        // l'event DOM (truthy) — seul ``true`` strict signifie « ne pas
        // recharger » (réservé à saveSettings).
        skipReload = (skipReload === true);
        // Modifications non enregistrées → confirmer l'abandon (la fermeture
        // revert l'état via loadSettingsData plus bas).
        // ``memoryDirty`` compte AUSSI : l'éditeur de mémoire persiste par sa
        // propre route, donc un brouillon en cours n'apparaît pas dans
        // ``settings`` — sans lui, Échap le jetait sans un mot.
        if (!skipReload && (settingsDirty.value || memoryDirty.value || templateDirty.value)) {
            const ok = await openConfirm('Abandonner les modifications ?', 'Vos changements non enregistrés seront perdus.', true, 'Abandonner');
            if (!ok) return;
        }
        showSettingsModal.value = false;
        // Stopper le polling sandbox quand la modal se ferme
        _stopSandboxPolling();
        // Réinitialiser l'état transitoire pour ne pas rouvrir sur une vue
        // "sale". Important pour la sécurité : on ne laisse pas le mot de passe
        // saisi en clair dans la mémoire réactive après fermeture.
        showPasswordChange.value = false;
        passwordForm.value = { old_password: '', new_password: '', confirm_password: '' };
        archiveSelectMode.value = false;
        archiveSelected.value = [];
        sharedSelectMode.value = false;
        sharedSelected.value = [];
        mcpSearch.value = '';
        promptSearch.value = '';
        promptOpen.value = {};
        cancelMemoryEdit();   // ne pas rouvrir sur un brouillon abandonné
        // Jeton montré une fois : jamais gardé au-delà de la fermeture (la
        // déconnexion passe aussi par ici — compte suivant, même onglet).
        try { _cnxMod.cnxReset && _cnxMod.cnxReset(); } catch (_) {}
        // Fermer par X / Échap / clic backdrop = ANNULER. Les contrôles
        // d'apparence (skin, mode sombre…) mutent settings.value en live
        // (watchers immediate) sans rien persister : sans revert, l'UI
        // affichait des choix non sauvés comme s'ils étaient enregistrés —
        // jusqu'au F5 ou à la réouverture des Préférences où tout sautait.
        // Re-fetch de l'état serveur → les watchers skin/dark_mode
        // ré-appliquent les valeurs réellement persistées. saveSettings
        // passe skipReload=true (les valeurs viennent d'être sauvées).
        if (!skipReload) { try { loadSettingsData(); } catch (_) {} }
    }

    async function saveSettings(closeModal = true) {
        // Anti double-soumission sur le bouton Enregistrer explicite.
        if (closeModal && settingsSaving.value) return;
        if (closeModal) settingsSaving.value = true;
        try {
            // (``active_mcp_ids`` n'est PLUS synchronisé vers les settings :
            // l'état des serveurs externes est per-chat — entrées ``ext:`` de
            // meta_json["tools"], persistées par le watcher du panneau Outils.)
            // (passe 3 2026-08-31) — la chaîne ENVOYÉE est figée ici : le
            // rebase du snapshot plus bas doit se faire sur ELLE, pas sur
            // ``settings.value`` relu APRÈS l'await — toute frappe faite
            // pendant l'aller-retour était sinon absorbée dans l'instantané
            // sans avoir jamais été envoyée (badge « non enregistré » jamais
            // allumé, saisie perdue au rechargement).
            const _sentBody = JSON.stringify(settings.value);
            const res = await fetchAuth('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: _sentBody });
            // l'ancienne version silencieux les erreurs (pas de toast).
            // Un utilisateur qui modifiait ses serveurs MCP ne savait jamais si la
            // sauvegarde avait réussi ou échoué (ex: session expirée, réseau coupé).
            if (!res) {
                showToast('Erreur réseau : paramètres non enregistrés.', 'error');
                return;
            }
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                showToast(_settingsErrorMsg(res.status, err), 'error');
                return;
            }
            // Succès : l'état serveur == ce qui a été ENVOYÉ → on rebase le
            // snapshot sur la chaîne émise (une frappe survenue pendant le PUT
            // garde le badge « non enregistré » allumé).
            _settingsSnapshot.value = _sentBody;
            if (closeModal) {
                showToast('Paramètres enregistrés.');
                closeSettings(true);
            }
        } catch(e) {
            showToast('Erreur réseau : paramètres non enregistrés.', 'error');
        } finally {
            if (closeModal) settingsSaving.value = false;
        }
    }

    // (passe 8, F10/F11) — persistance CIBLÉE d'une ou plusieurs clés (le
    // backend FUSIONNE) : fermer le gestionnaire MCP, ajouter/supprimer un
    // serveur ou un agent, changer l'avatar n'enregistrent plus TOUT le
    // formulaire Préférences en douce (contrat Enregistrer/Abandonner).
    // ``rollback`` est rejoué si le PUT échoue : plus de mutation optimiste
    // orpheline (liste déjà modifiée à l'écran, serveur inchangé).
    function _cloneVal(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    async function _persistKeys(keys, opts = {}) {
        const body = {};
        for (const k of keys) body[k] = settings.value[k];
        let ok = false;
        try {
            const r = await fetchAuth('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            ok = !!(r && r.ok);
            if (!r) showToast('Erreur réseau : modification non enregistrée.', 'error');
            else if (!ok) { const err = await r.json().catch(() => ({})); showToast(_settingsErrorMsg(r.status, err), 'error'); }
        } catch (_) { showToast('Erreur réseau : modification non enregistrée.', 'error'); }
        if (!ok) {
            if (opts.rollback) { try { opts.rollback(); } catch (_) {} }
            return false;
        }
        try {
            const s = JSON.parse(_settingsSnapshot.value || '{}');
            for (const k of keys) {
                const v = _cloneVal(settings.value[k]);
                if (v === undefined) delete s[k]; else s[k] = v;
            }
            _settingsSnapshot.value = JSON.stringify(s);
        } catch (_) { /* snapshot best-effort */ }
        if (opts.okMsg) showToast(opts.okMsg);
        return true;
    }

    // ── Apparence : mode (Système · Clair · Sombre) et thème ─────────────
    // ``applyThemeMode`` ne fait que MUTER (le modal Paramètres enregistre au
    // clic sur Enregistrer) ; ``setThemeMode`` / ``setAppSkin`` enregistrent
    // tout de suite — c'est le contrat du menu d'apparence de la console.
    const themeMode = computed(() => {
        const s = settings.value || {};
        return s.dark_mode_auto ? 'system' : (s.dark_mode ? 'dark' : 'light');
    });
    function applyThemeMode(mode) {
        if (!settings.value) return;
        if (mode === 'system') { settings.value.dark_mode_auto = true; return; }
        settings.value.dark_mode_auto = false;
        settings.value.dark_mode = (mode === 'dark');
    }
    async function setThemeMode(mode) {
        if (!settings.value || !['system', 'light', 'dark'].includes(mode)) return false;
        const prev = { a: settings.value.dark_mode_auto, d: settings.value.dark_mode };
        applyThemeMode(mode);
        return _persistKeys(['dark_mode', 'dark_mode_auto'], {
            rollback: () => { settings.value.dark_mode_auto = prev.a; settings.value.dark_mode = prev.d; },
        });
    }
    function toggleThemeMode() { return setThemeMode(appDark.value ? 'light' : 'dark'); }
    async function setAppSkin(id) {
        if (!settings.value || !APP_SKINS.value.some(k => k.id === id)) return false;
        const prev = settings.value.skin;
        settings.value.skin = id;
        return _persistKeys(['skin'], { rollback: () => { settings.value.skin = prev; } });
    }

    async function changeMyPassword() {
        if (passwordSaving.value) return;
        if (!passwordForm.value.old_password || !passwordForm.value.new_password) return;
        if (passwordForm.value.new_password !== passwordForm.value.confirm_password) {
            showToast('Les mots de passe ne correspondent pas', 'error');
            return;
        }
        passwordSaving.value = true;
        try {
            const res = await fetchAuth('/api/users/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    old_password: passwordForm.value.old_password,
                    new_password: passwordForm.value.new_password,
                }),
            });
            if (res && res.ok) {
                showToast('Mot de passe mis à jour !');
                passwordForm.value = { old_password: '', new_password: '', confirm_password: '' };
                showPasswordChange.value = false;
            } else {
                const err = await res.json().catch(() => ({}));
                showToast(err.detail || 'Erreur', 'error');
            }
        } catch(e) {
            showToast('Erreur réseau', 'error');
        } finally {
            passwordSaving.value = false;
        }
    }

    // ces trois fonctions appelaient saveSettings(false) en fire-and-forget
    // (sans await). Si la sauvegarde échouait, l'utilisateur ne voyait rien -- le serveur
    // MCP semblait ajouté/supprimé localement mais n'était pas persisté côté serveur.
    // Elles sont désormais async et awaited pour que les toasts d'erreur s'affichent.

    function _blankMcp() {
        return { name: '', type: 'sse', url: '', command: '', auth_mode: '',
                 auth_user: '', auth_secret: '', has_auth: false,
                 headers: [], env: [], _idx: null };
    }

    // ── Créneaux supplémentaires : en-têtes (HTTP/SSE) et variables (stdio) ──
    // Un serveur peut demander DEUX identifiants — un jeton de transport et une
    // clé applicative — et un serveur local se configure par variables
    // d'environnement. Même contrat que le secret principal : la valeur n'est
    // jamais relue depuis le serveur, un champ laissé vide sur une paire
    // existante = valeur INCHANGÉE (report par nom côté backend).
    function _mcpPairs(src) {
        return (src || []).map(p => ({ name: p.name || '', value: '',
                                       has_value: !!p.has_value }));
    }

    // Badge « auth » de la liste : le créneau principal N'EST PLUS le seul —
    // un serveur local configuré uniquement par variables d'environnement
    // porte bien des identifiants, et n'en montrait aucun signe.
    function mcpHasCreds(srv) {
        if (!srv) return false;
        const any = (l) => (l || []).some(p => p && p.has_value);
        return !!srv.has_auth || any(srv.headers) || any(srv.env);
    }

    function mcpAddPair(form, kind) {
        if (!form) return;
        if (!Array.isArray(form[kind])) form[kind] = [];
        if (form[kind].length >= 20) return;
        form[kind].push({ name: '', value: '', has_value: false });
    }

    function mcpRemovePair(form, kind, idx) {
        if (form && Array.isArray(form[kind])) form[kind].splice(idx, 1);
    }

    // Payload d'une liste de paires : les entrées sans nom sont des lignes
    // ouvertes puis abandonnées, elles ne partent pas.
    function _mcpPairsPayload(form, kind) {
        return (form[kind] || [])
            .filter(p => (p.name || '').trim())
            .map(p => ({ name: p.name.trim(), value: p.value || '' }));
    }

    async function addMcpServer() {
        if (!newMcp.value.name) return;
        if (newMcp.value.type !== 'stdio' && !newMcp.value.url) {
            showToast('URL requise pour un serveur SSE/HTTP', 'error');
            return;
        }
        if (newMcp.value.type === 'stdio' && !newMcp.value.command) {
            showToast('Commande requise pour un serveur stdio', 'error');
            return;
        }
        if (!settings.value.mcp_servers) settings.value.mcp_servers = [];
        // Le secret part en clair AU SERVEUR (HTTPS), qui le chiffre et ne le
        // renvoie plus jamais : le navigateur ne voit ensuite que `has_auth`.
        // Champ vide sur une entrée existante = secret INCHANGÉ (la fusion
        // serveur reporte celui en base) — même contrat que les connecteurs LLM.
        const editing = newMcp.value._idx != null;
        const prev = editing ? (settings.value.mcp_servers[newMcp.value._idx] || {}) : {};
        const srv = {
            name: newMcp.value.name,
            type: newMcp.value.type,
            url: newMcp.value.url || '',
            command: newMcp.value.command || '',
            visible: editing ? (prev.visible !== false) : true,
            id: editing ? prev.id : `server_${Date.now()}`,
        };
        if (newMcp.value.type !== 'stdio') {
            const mode = (newMcp.value.auth_mode || '').trim();
            srv.auth_mode = mode;
            // ``header`` : ``auth_user`` porte le NOM de l'en-tête, pas un
            // identifiant — même créneau, autre sémantique.
            if (mode === 'basic' || mode === 'header') srv.auth_user = newMcp.value.auth_user || '';
            if (mode && newMcp.value.auth_secret) srv.auth_secret = newMcp.value.auth_secret;
            srv.headers = _mcpPairsPayload(newMcp.value, 'headers');
        } else {
            srv.env = _mcpPairsPayload(newMcp.value, 'env');
        }
        const _before = _cloneVal(settings.value.mcp_servers);
        if (editing) settings.value.mcp_servers[newMcp.value._idx] = srv;
        else settings.value.mcp_servers.push(srv);
        // (passe 8, F10/F11) — clé ciblée + rollback ; le formulaire reste
        // rempli en cas d'échec pour réessayer.
        if (!await _persistKeys(['mcp_servers'], { rollback: () => { settings.value.mcp_servers = _before; } })) return;
        newMcp.value = _blankMcp();
    }

    function editMcpServer(idx) {
        const srv = settings.value.mcp_servers[idx];
        if (!srv) return;
        // Le secret n'est JAMAIS relu depuis le serveur : le champ repart vide
        // et `has_auth` fait afficher « inchangé ».
        newMcp.value = {
            name: srv.name || '', type: srv.type || 'sse', url: srv.url || '',
            command: srv.command || '', auth_mode: srv.auth_mode || '',
            auth_user: srv.auth_user || '', auth_secret: '',
            has_auth: !!srv.has_auth,
            headers: _mcpPairs(srv.headers), env: _mcpPairs(srv.env),
            _idx: idx,
        };
        _clearMcpTest();
    }

    function cancelMcpEdit() { newMcp.value = _blankMcp(); _clearMcpTest(); }

    // ── Bouton « Tester » ────────────────────────────────────────────────
    // Éprouve la config TELLE QU'ELLE EST SAISIE, sans l'enregistrer. Secret
    // laissé vide = celui déjà stocké (le serveur le reporte), donc on peut
    // retester une entrée existante sans re-saisir le jeton.
    const mcpTest = ref({ busy: false, ok: null, msg: '', scope: '' });

    function _clearMcpTest() { mcpTest.value = { busy: false, ok: null, msg: '', scope: '' }; }

    async function testMcpServer(scope) {
        const f = scope === 'shared' ? sharedMcpForm.value : newMcp.value;
        if (!f) return;
        const body = {
            name: f.name || '', type: f.type || 'sse',
            url: f.url || '', command: f.command || '',
            auth_mode: f.auth_mode || '', auth_user: f.auth_user || '',
            auth_secret: f.auth_secret || '',
            headers: _mcpPairsPayload(f, 'headers'),
            env: _mcpPairsPayload(f, 'env'),
        };
        if (scope === 'shared') {
            body.shared = true;
            if (f.id) body.id = f.id;
        } else if (f._idx != null) {
            const cur = (settings.value.mcp_servers || [])[f._idx];
            if (cur && cur.id) body.id = cur.id;
        }
        mcpTest.value = { busy: true, ok: null, msg: '', scope };
        try {
            const r = await fetchAuth('/api/mcp/test', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) {
                mcpTest.value = { busy: false, ok: false, scope,
                                  msg: d.detail || `Erreur ${r.status}` };
            } else if (d.ok) {
                mcpTest.value = { busy: false, ok: true, scope,
                                  msg: `${(d.tools || []).length} outil(s) — ${d.ms} ms` };
            } else {
                mcpTest.value = { busy: false, ok: false, scope, msg: d.error || 'Échec' };
            }
        } catch (e) {
            mcpTest.value = { busy: false, ok: false, scope, msg: 'Requête impossible' };
        }
    }

    async function closeMcpManager() {
        showMcpManagerModal.value = false;
        // (passe 8, F10) — n'enregistre que la liste des serveurs, et
        // seulement si elle diffère de l'état connu du serveur (chaque
        // ajout/suppression/bascule persiste déjà) : avant, TOUT le formulaire
        // Préférences partait en douce à la fermeture du gestionnaire.
        try {
            const snap = JSON.parse(_settingsSnapshot.value || '{}');
            if (JSON.stringify(settings.value.mcp_servers || []) !== JSON.stringify(snap.mcp_servers || [])) {
                await _persistKeys(['mcp_servers']);
            }
        } catch (_) {}
        // Sécurité: ne pas laisser les identifiants MCP saisis (user/token/raw)
        // en clair dans la mémoire réactive après fermeture sans ajout.
        newMcp.value = _blankMcp();
    }

    async function removeMcpServer(idx) {
        const srv = settings.value.mcp_servers[idx];
        if (!srv) return;
        const srvId = srv.id;
        const ok = await openConfirm('Supprimer ce serveur MCP ?', srv.name || '', true);
        if (!ok) return;
        const _before = _cloneVal(settings.value.mcp_servers);
        const _beforeActive = _cloneVal(config.value.active_mcp_ids || []);
        settings.value.mcp_servers.splice(idx, 1);
        config.value.active_mcp_ids = (config.value.active_mcp_ids || []).filter(id => id !== srvId);
        await _persistKeys(['mcp_servers'], { rollback: () => {
            settings.value.mcp_servers = _before; config.value.active_mcp_ids = _beforeActive;
        } });
    }

    async function toggleServerVisibility(idx) {
        const srv = settings.value.mcp_servers[idx];
        if (!srv) return;
        const _beforeActive = _cloneVal(config.value.active_mcp_ids || []);
        srv.visible = !srv.visible;
        if (!config.value.active_mcp_ids) config.value.active_mcp_ids = [];
        if (!srv.visible) config.value.active_mcp_ids = config.value.active_mcp_ids.filter(id => id !== srv.id);
        await _persistKeys(['mcp_servers'], { rollback: () => {
            srv.visible = !srv.visible; config.value.active_mcp_ids = _beforeActive;
        } });
    }

    async function activateExternalServer(id) {
        if (!config.value.active_mcp_ids) config.value.active_mcp_ids = [];
        const idx = config.value.active_mcp_ids.indexOf(id);
        if (idx > -1) config.value.active_mcp_ids.splice(idx, 1);
        else config.value.active_mcp_ids.push(id);
        // Persistance PER-CHAT : le watcher du panneau Outils (app-chat.js)
        // pousse l'état — catégories + ``ext:<id>`` — via PUT /tools débouncé
        // sur le chat courant, exactement comme les catégories locales. Plus
        // de saveSettings ici : l'état global « collait » entre chats.
    }

    // ── Bibliothèque partagée : CRUD ADMIN ───────────────────────────────
    // Le formulaire ne renvoie le secret QUE s'il a été saisi : un admin qui
    // renomme un serveur ne re-tape pas le token (le backend conserve celui en
    // place quand ``auth_secret`` est vide). Aucun secret n'est jamais relu
    // depuis le serveur — le champ repart vide à chaque édition.
    function newSharedMcp() {
        sharedMcpError.value = '';
        _clearMcpTest();
        sharedMcpForm.value = { id: '', name: '', type: 'sse', url: '', command: '',
                                auth_mode: '', auth_user: '', auth_secret: '',
                                headers: [], env: [],
                                enabled: true, has_auth: false };
    }

    function editSharedMcp(srv) {
        sharedMcpError.value = '';
        _clearMcpTest();
        sharedMcpForm.value = { id: srv.id, name: srv.name || '', type: srv.type || 'sse',
                                url: srv.url || '', command: srv.command || '',
                                auth_mode: srv.auth_mode || '', auth_user: srv.auth_user || '',
                                auth_secret: '', enabled: srv.enabled !== false,
                                headers: _mcpPairs(srv.headers), env: _mcpPairs(srv.env),
                                has_auth: !!srv.has_auth };
    }

    function cancelSharedMcp() { sharedMcpForm.value = null; sharedMcpError.value = ''; _clearMcpTest(); }

    // ── Recettes ────────────────────────────────────────────────────────────
    // Remplit un formulaire avec une configuration connue ; il ne reste que
    // l'URL réelle et les jetons à compléter. Source UNIQUE des deux
    // formulaires (perso et partagé) : la recette Jenkins vivait en double,
    // recopiée en dur dans le HTML, et les deux copies avaient divergé.
    const MCP_PRESETS = {
        jenkins: { name: 'Jenkins', type: 'sse',
                   url: 'https://VOTRE-JENKINS/mcp-server/sse',
                   auth_mode: 'basic', auth_user: '', headers: [], env: [] },
        // Deux identifiants : le Bearer garde l'accès au serveur MCP, la clé
        // d'API sert au wiki lui-même. C'est le cas qui a motivé les en-têtes
        // supplémentaires.
        wikijs: { name: 'Wiki.js', type: 'http',
                  url: 'http://VOTRE-HOTE:4445/mcp',
                  auth_mode: 'bearer', auth_user: '',
                  headers: [{ name: 'X-API-Key', value: '', has_value: false }],
                  env: [] },
        wikijs_local: { name: 'Wiki.js (local)', type: 'stdio',
                        command: 'npx -y wikijs-mcp',
                        auth_mode: '', auth_user: '', headers: [],
                        env: [{ name: 'WIKIJS_URL', value: '', has_value: false },
                              { name: 'WIKIJS_TOKEN', value: '', has_value: false }] },
    };

    function applyMcpPreset(scope, key) {
        const p = MCP_PRESETS[key];
        if (!p) return;
        if (scope === 'shared') {
            if (!sharedMcpForm.value) newSharedMcp();
            Object.assign(sharedMcpForm.value, JSON.parse(JSON.stringify(p)));
        } else {
            newMcp.value = Object.assign(_blankMcp(),
                                         JSON.parse(JSON.stringify(p)),
                                         { _idx: newMcp.value._idx });
        }
        _clearMcpTest();
    }

    // (passe 6, F16) — verrou anti double-clic : deux POST partaient et
    // publiaient le serveur EN DOUBLE (pas d'idempotence côté API).
    const sharedMcpSaving = ref(false);
    async function saveSharedMcp() {
        const f = sharedMcpForm.value;
        if (!f || sharedMcpSaving.value) return;
        if (!(f.name || '').trim()) { sharedMcpError.value = 'Nom requis.'; return; }
        // HTTP streamable exige une URL autant que SSE — le test ne visait que
        // 'sse', donc une publication HTTP sans URL partait au serveur pour
        // n'être refusée qu'en 400.
        if (f.type !== 'stdio' && !(f.url || '').trim()) { sharedMcpError.value = 'URL requise pour un serveur HTTP/SSE.'; return; }
        if (f.type === 'stdio' && !(f.command || '').trim()) { sharedMcpError.value = 'Commande requise pour un serveur local.'; return; }
        const body = { name: f.name.trim(), type: f.type, url: f.url || '', command: f.command || '',
                       auth_mode: f.auth_mode || '', auth_user: f.auth_user || '',
                       auth_secret: f.auth_secret || '',
                       headers: _mcpPairsPayload(f, 'headers'),
                       env: _mcpPairsPayload(f, 'env'),
                       enabled: f.enabled !== false };
        const url = f.id ? '/api/mcp/shared-servers/' + encodeURIComponent(f.id)
                         : '/api/mcp/shared-servers';
        sharedMcpSaving.value = true;
        try {
            const r = await fetchAuth(url, {
                method: f.id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r || !r.ok) {
                let d = '';
                try { d = ((await r.json()) || {}).detail || ''; } catch (e) {}
                sharedMcpError.value = d || 'Publication refusée.';
                return;
            }
            sharedMcpForm.value = null;
            await loadSharedMcpServers();
            showToast('Serveur publié pour tous les utilisateurs.', 'success');
        } catch (e) { sharedMcpError.value = 'Erreur réseau.'; }
        finally { sharedMcpSaving.value = false; }
    }

    async function deleteSharedMcp(srv) {
        const ok = await openConfirm('Dépublier ce serveur ?',
                                     (srv.name || '') + ' — il disparaîtra de tous les comptes.',
                                     true, 'Dépublier');
        if (!ok) return;
        try {
            const r = await fetchAuth('/api/mcp/shared-servers/' + encodeURIComponent(srv.id),
                                      { method: 'DELETE' });
            if (r && r.ok) {
                await loadSharedMcpServers();
                if (sharedMcpForm.value && sharedMcpForm.value.id === srv.id) cancelSharedMcp();
            }
        } catch (e) { /* best-effort */ }
    }

    async function loadCustomMcpServers() {
        try {
            const res = await fetchAuth('/api/mcp/custom-servers', {}, true);
            if (res && res.ok) customMcpList.value = (await res.json()).servers || [];
        } catch(e) {}
    }

    function triggerMcpUpload() { if (mcpFileInput.value) mcpFileInput.value.click(); }

    async function handleMcpUpload(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
            formData.append('files', files[i]);
            formData.append('paths', files[i].webkitRelativePath || files[i].name);
        }
        try {
            const res = await fetchAuth('/api/mcp/upload', { method: 'POST', body: formData });
            if (res && res.ok) loadCustomMcpServers();
        } catch(e) {}
        if (mcpFileInput.value) mcpFileInput.value.value = '';
    }

    async function deleteCustomServer(name) {
        const confirmed = await openConfirm('Supprimer ce serveur MCP ?', name || '', true, 'Supprimer');
        if (!confirmed) return;
        try { await fetchAuth(`/api/mcp/custom-servers/${name}`, { method: 'DELETE' }); loadCustomMcpServers(); } catch(e) {}
    }

    function useCustomServer(srv) {
        newMcp.value.name = srv.name;
        newMcp.value.type = 'stdio';
        newMcp.value.command = srv.suggested_cmd || `python ${srv.name}/main.py`;
        newMcp.value.url = '';
    }

    async function uploadAvatar(event) {
        const file = event.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        try {
            const res = await fetchAuth('/api/settings/avatar', { method: 'POST', body: formData });
            if (res && res.ok) user.value.avatar = (await res.json()).avatar;
        } catch(e) {}
    }

    async function removeAvatar() {
        const ok = await openConfirm('Supprimer la photo de profil ?', '', true);
        if (!ok) return;
        try {
            const res = await fetchAuth('/api/settings/avatar', { method: 'DELETE' });
            if (res && res.ok) user.value.avatar = '';
        } catch(e) {}
    }

    async function uploadAssistantAvatar(event) {
        const file = event.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        try {
            const res = await fetchAuth('/api/settings/assistant-avatar', { method: 'POST', body: formData });
            if (res && res.ok) { settings.value.assistant_avatar = (await res.json()).avatar; await _persistKeys(['assistant_avatar']); }
        } catch(e) {}
    }

    async function removeAssistantAvatar() {
        const ok = await openConfirm("Supprimer l'image de l'assistant ?", '', true);
        if (!ok) return;
        const _before = settings.value.assistant_avatar;
        settings.value.assistant_avatar = '';
        await _persistKeys(['assistant_avatar'], { rollback: () => { settings.value.assistant_avatar = _before; } });
    }

    async function loadSavedPrompts() {
        try {
            const res = await fetchAuth('/api/prompts', {}, true);
            if (res && res.ok) savedPromptsList.value = (await res.json()).items || [];
        } catch(e) {}
    }

    // ── Prompts : liste dépliable, recherche, tri ────────────────────────────
    // La grille de cartes montrait 3 lignes de contenu tronquées et AUCUNE date :
    // impossible de retrouver un prompt long, ni de savoir lequel est le plus
    // récent. Liste + date + dépliage + recherche + tri.
    const promptSearch = ref('');
    const promptSort   = ref('recent');   // recent | ancien | titre
    const promptOpen   = ref({});         // id → déplié

    function togglePrompt(id) {
        promptOpen.value = { ...promptOpen.value, [id]: !promptOpen.value[id] };
    }

    // Copie le prompt TEL QUEL. C'est le pendant de l'affichage : le contenu
    // n'est jamais passé au rendu Markdown (ni ici, ni dans le dépliage), donc
    // `#`, `**`, les accents graves et les balises littérales survivent au
    // copier-coller — un prompt est un TEXTE SOURCE à réutiliser, pas un
    // document à mettre en page.
    // Repli ``execCommand`` comme ``copyAssistantMessage`` : l'API Clipboard
    // n'existe qu'en contexte sécurisé (une instance servie en clair sur le LAN
    // ne l'a pas).
    async function copyPrompt(content) {
        if (!content) return;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(content);
            } else {
                const ta = document.createElement('textarea');
                ta.value = content;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            showToast('Prompt copié');
        } catch (e) {
            showToast('Impossible de copier : ' + (e.message || ''), 'error');
        }
    }

    // Insensible à la casse ET aux accents (« resume » doit trouver « résumé »).
    // Normalisation caractère par caractère : ``normalize('NFD')`` sur la chaîne
    // entière change sa LONGUEUR, et les index ne pointeraient plus au bon
    // endroit dans le texte d'origine (cf. promptExtrait).
    function _promptNorm(s) {
        let out = '';
        for (const c of String(s == null ? '' : s)) {
            const d = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            out += (d || c);
        }
        return out.toLowerCase();
    }

    const promptsAffiches = computed(() => {
        const q = _promptNorm(promptSearch.value).trim();
        let list = savedPromptsList.value.slice();
        if (q) list = list.filter(p => _promptNorm((p.title || '') + ' ' + (p.content || '')).includes(q));
        const mode = promptSort.value;
        list.sort((a, b) => {
            if (mode === 'titre') {
                return String(a.title || '').localeCompare(String(b.title || ''), 'fr', { sensitivity: 'base' });
            }
            const ta = Number(a.created_at) || 0, tb = Number(b.created_at) || 0;
            return mode === 'ancien' ? ta - tb : tb - ta;
        });
        return list;
    });

    function promptDate(ts) {
        if (!ts) return '';
        try {
            return new Date(Number(ts) * 1000)
                .toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
        } catch (_) { return ''; }
    }
    function promptDateFull(ts) {
        if (!ts) return '';
        try { return new Date(Number(ts) * 1000).toLocaleString('fr-FR'); } catch (_) { return ''; }
    }

    // Extrait centré sur la correspondance. Sans lui, un prompt trouvé par son
    // CONTENU s'affiche avec son seul titre : la ligne a l'air d'un faux positif.
    function promptExtrait(p) {
        const q = _promptNorm(promptSearch.value).trim();
        if (!q) return '';
        const brut = String((p && p.content) || '');
        const norm = _promptNorm(brut);
        const i = norm.indexOf(q);
        // i < 0 : trouvé par le titre, il est déjà affiché juste au-dessus.
        // Longueurs divergentes (cas exotiques de casse) : on ne découpe pas à
        // l'aveugle, mieux vaut pas d'extrait qu'un extrait décalé.
        if (i < 0 || norm.length !== brut.length) return '';
        const debut = Math.max(0, i - 35);
        const fin = Math.min(brut.length, i + q.length + 55);
        return (debut > 0 ? '…' : '') + brut.slice(debut, fin).replace(/\s+/g, ' ').trim()
             + (fin < brut.length ? '…' : '');
    }

    // Le menu « / » du composeur sert les prompts sauvegardés depuis un
    // cache : sans ce signal, un prompt créé ou supprimé ici n'y
    // apparaîtrait (ou disparaîtrait) qu'à l'expiration du TTL. Même
    // idiome que 'skills:changed'.
    function _promptsChanged() {
        try { window.dispatchEvent(new Event('prompts:changed')); } catch (_) {}
    }

    async function saveThisPrompt(content) {
        const title = await openPrompt('Sauvegarder', '');
        if (title) try {
            await fetchAuth('/api/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }) });
            _promptsChanged();
        } catch(e) {}
    }

    async function deleteSavedPrompt(id, title) {
        const confirmed = await openConfirm('Supprimer ce prompt ?', title || '', true, 'Supprimer');
        if (!confirmed) return;
        try { await fetchAuth(`/api/prompts/${id}`, { method: 'DELETE' }); loadSavedPrompts(); _promptsChanged(); } catch(e) {}
    }

    async function usePrompt(content) {
        // AUDIT 2026-08-31 (passe 4, F5) — la fermeture directe
        // (showSettingsModal=false) court-circuitait closeSettings : pas de
        // dirty-confirm, polling sandbox orphelin, mot de passe saisi
        // conservé en mémoire réactive, réglages d'apparence mutés en live
        // jamais revertés. On passe par le chemin officiel ; si l'utilisateur
        // refuse d'abandonner ses modifications, on n'insère pas.
        await closeSettings();
        if (showSettingsModal.value) return;
        inputMessage.value = content;
        nextTick(() => { ctx.autoResize(); inputRef.value?.focus(); });
    }

    // ── Templates de prompt (2026-09-21) ─────────────────────────────────────
    // Appelés dans le chat par « /template <raccourci> » ; variables {{…}}
    // remplies à l'insertion (chat/_templates.js). Section « Templates » de
    // l'onglet Prompts. Conception : docs/templates-prompt-design-2026-09-21.md.
    const promptsView       = ref('saved');       // saved | templates
    const templatesList     = ref([]);
    const templateSearch    = ref('');
    const templateOpen      = ref({});             // id → déplié
    const templateForm      = ref(null);           // { id, name, title, content } | null
    const _templateFormSnap = ref('');
    const templateSaving    = ref(false);
    const templateFormError = ref('');
    const templateDirty = computed(() => !!templateForm.value
        && JSON.stringify(templateForm.value) !== _templateFormSnap.value);
    // Aide de syntaxe : en infobulle (règle UX : pas de paragraphe).
    const templateSyntaxHelp =
        'Variables : {{nom}} · {{nom | textarea}} · {{nom | select:options=["a","b"]}}\n'
        + 'Options : :placeholder="…" :default="…" :required\n'
        + 'Automatiques : {{date}} {{heure}} {{jour}} {{utilisateur}} {{presse_papier}}\n'
        + 'Dans le chat : /template <raccourci>';

    function _tplApi() { return window.elpisTemplates || null; }

    async function loadPromptTemplates() {
        try {
            const res = await fetchAuth('/api/prompt-templates', {}, true);
            if (res && res.ok) templatesList.value = (await res.json()).items || [];
        } catch (e) {}
    }
    function _templatesChanged() {
        try { window.dispatchEvent(new Event('templates:changed')); } catch (_) {}
    }

    const templatesAffiches = computed(() => {
        const q = _promptNorm(templateSearch.value).trim();
        let list = templatesList.value.slice();
        if (q) list = list.filter(t => _promptNorm(t.name + ' ' + (t.title || '') + ' ' + (t.content || '')).includes(q));
        return list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    });

    function templateVarsOf(t) {
        const T = _tplApi();
        if (!T || !t) return { vars: [], system: [] };
        return T.parse(t.content || '');
    }
    const templateFormVars = computed(() => templateVarsOf(templateForm.value));

    function toggleTemplate(id) {
        templateOpen.value = { ...templateOpen.value, [id]: !templateOpen.value[id] };
    }

    // Raccourci proposé depuis un titre : « Résumé d'un texte » → « resume-d-un-texte ».
    function _templateSlug(s) {
        return _promptNorm(s).replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
            .replace(/-{2,}/g, '-').slice(0, 40).replace(/-+$/, '');
    }

    function _openTemplateForm(data) {
        promptsView.value = 'templates';
        templateForm.value = { id: data.id || null, name: data.name || '',
                               title: data.title || '', content: data.content || '' };
        _templateFormSnap.value = JSON.stringify(templateForm.value);
        templateFormError.value = '';
        nextTick(() => {
            const el = document.getElementById(data.id ? 'tpl-content' : 'tpl-name');
            if (el) el.focus();
        });
    }
    function startNewTemplate(prefill) { _openTemplateForm(prefill || {}); }
    function editTemplate(t) { if (t) _openTemplateForm(t); }
    // Un prompt sauvegardé devient un template : formulaire pré-rempli.
    function templateFromPrompt(p) {
        if (!p) return;
        _openTemplateForm({ name: _templateSlug(p.title || ''), title: p.title || '', content: p.content || '' });
    }
    function templateTitleBlur() {
        const f = templateForm.value;
        if (f && !f.id && !f.name.trim() && f.title.trim()) f.name = _templateSlug(f.title);
    }

    async function cancelTemplateEdit() {
        if (templateDirty.value) {
            const ok = await openConfirm('Abandonner ce template ?', 'Les modifications seront perdues.', true, 'Abandonner');
            if (!ok) return;
        }
        templateForm.value = null;
        templateFormError.value = '';
    }

    async function saveTemplate() {
        const f = templateForm.value;
        if (!f || templateSaving.value) return;
        const name = String(f.name || '').trim().replace(/^\//, '').toLowerCase();
        const T = _tplApi();
        if (T && !T.validName(name)) {
            templateFormError.value = 'Raccourci : minuscules, chiffres, - et _, sans espace.';
            return;
        }
        if (!String(f.content || '').trim()) { templateFormError.value = 'Contenu requis.'; return; }
        templateSaving.value = true;
        templateFormError.value = '';
        try {
            const res = await fetchAuth(f.id ? `/api/prompt-templates/${f.id}` : '/api/prompt-templates', {
                method: f.id ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, title: f.title || '', content: f.content }),
            });
            if (res && res.ok) {
                showToast(f.id ? 'Template mis à jour' : 'Template créé : /template ' + name, 'success');
                templateForm.value = null;
                await loadPromptTemplates();
                _templatesChanged();
            } else {
                let msg = 'Enregistrement refusé';
                try { const j = await res.json(); if (j && j.detail) msg = String(j.detail); } catch (_) {}
                templateFormError.value = msg;
            }
        } catch (e) {
            templateFormError.value = 'Erreur réseau';
        } finally {
            templateSaving.value = false;
        }
    }

    async function deleteTemplate(t) {
        if (!t) return;
        const ok = await openConfirm('Supprimer ce template ?', '/template ' + t.name, true, 'Supprimer');
        if (!ok) return;
        try {
            const res = await fetchAuth(`/api/prompt-templates/${t.id}`, { method: 'DELETE' });
            if (res && res.ok) {
                if (templateForm.value && templateForm.value.id === t.id) templateForm.value = null;
                await loadPromptTemplates();
                _templatesChanged();
            } else showToast('Suppression refusée', 'error');
        } catch (e) { showToast('Erreur réseau', 'error'); }
    }

    // « Insérer » : même chemin que « /template » dans le chat (variables
    // demandées, texte inséré au curseur) — après fermeture des Paramètres.
    async function insertTemplate(t) {
        await closeSettings();
        if (showSettingsModal.value) return;
        if (ctx.openTemplate) ctx.openTemplate(t);
    }

    async function loadSharedPrompts() {
        try {
            const res = await fetchAuth('/api/prompts/shared', {}, true);
            if (res && res.ok) sharedPromptsList.value = (await res.json()).items || [];
        } catch(e) {}
    }

    async function refreshInboxCount() {
        try {
            const res = await fetchAuth('/api/inbox/count', {}, true);
            if (res && res.ok) {
                const d = await res.json();
                inboxCount.value = d.count || 0;
            }
        } catch(e) {}
    }

    function startInboxPolling() {
        refreshInboxCount();
        if (_inboxPollTimer) clearInterval(_inboxPollTimer);
        // AUDIT 2026-08-02 (S5) — garde de visibilité, comme le poll modèles
        // et le poll quota. Sans elle, ce poll tournait onglet minimisé,
        // week-end compris, et comme chaque requête authentifiée bumpe
        // ``_last_activity_ts`` côté serveur, il NEUTRALISAIT à lui seul
        // l'idle-timeout de session configuré par l'admin (tab Sécurité).
        _inboxPollTimer = setInterval(() => {
            if (document.visibilityState === 'visible') refreshInboxCount();
        }, 30000);
    }

    function stopInboxPolling() {
        if (_inboxPollTimer) { clearInterval(_inboxPollTimer); _inboxPollTimer = null; }
    }

    async function useSharedPrompt(content) {
        showSharedPrompts.value = false;
        // (F5) ouvert depuis les Préférences : les fermer par le chemin
        // officiel avant d'insérer (mêmes raisons que usePrompt).
        if (showSettingsModal.value) {
            await closeSettings();
            if (showSettingsModal.value) return;
        }
        inputMessage.value = content;
        nextTick(() => { ctx.autoResize(); inputRef.value?.focus(); });
    }

    async function deleteSharedPrompt(id, event, title) {
        if (event) event.stopPropagation();
        const confirmed = await openConfirm('Supprimer ce partage ?', title || '', true, 'Supprimer');
        if (!confirmed) return;
        try {
            const res = await fetchAuth(`/api/prompts/shared/${id}`, { method: 'DELETE' });
            if (res && res.ok) { loadSharedPrompts(); refreshInboxCount(); }
        } catch(e) {}
    }

    async function clearAllSharedPrompts() {
        const n = sharedPromptsList.value.length;
        const confirmed = await openConfirm('Vider les partages reçus ?',
            n ? `${n} partage(s) seront supprimés.` : '', true, 'Vider');
        if (!confirmed) return;
        try {
            const res = await fetchAuth('/api/prompts/shared/all', { method: 'DELETE' });
            if (res && res.ok) { loadSharedPrompts(); refreshInboxCount(); }
        } catch(e) {}
    }

    async function openShareModal(prompt) {
        promptToShare.value = prompt;
        shareTargetUsers.value = [];
        selectAllUsers.value = false;
        selectedGroupFilter.value = null;
        isShareModalOpen.value = true;
        try {
            const res = await fetchAuth('/api/users/lite', {}, true);
            if (res && res.ok) {
                const data = await res.json();
                allUsersLite.value = data.users || [];
                myGroups.value = data.my_groups || [];
            }
        } catch(e) {}
    }

    function toggleSelectAllUsers() {
        if (selectAllUsers.value) shareTargetUsers.value = filteredShareUsers.value.map(u => u.id);
        else shareTargetUsers.value = [];
    }

    watch(shareTargetUsers, (newVal) => {
        selectAllUsers.value = filteredShareUsers.value.length > 0 && newVal.length === filteredShareUsers.value.length;
    });

    // (passe 6, F16) — verrou anti double-clic : chaque clic envoyait un
    // partage (notification en double chez les destinataires).
    const shareSending = ref(false);
    async function confirmShare() {
        if (shareTargetUsers.value.length === 0 || !promptToShare.value || shareSending.value) return;
        shareSending.value = true;
        try {
            const res = await fetchAuth('/api/prompts/share', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt_id: promptToShare.value.id, user_ids: shareTargetUsers.value })
            });
            if (res && res.ok) {
                showToast('Prompt partagé');
                isShareModalOpen.value = false;
            } else {
                const err = res ? await res.json().catch(() => ({})) : {};
                showToast(err.detail || 'Échec du partage', 'error');
            }
        } catch(e) {
            showToast('Erreur réseau — partage non effectué', 'error');
        } finally {
            shareSending.value = false;
        }
    }

    async function loadArchives() {
        try {
            const res = await fetchAuth('/api/saved/chats?archived=1', {}, true);
            if (res && res.ok) archivesList.value = (await res.json()).items || [];
        } catch(e) {}
    }

    async function restoreArchive(id) {
        try {
            const res = await fetchAuth(`/api/saved/chats/${id}/unarchive`, { method: 'POST' });
            if (res && res.ok) { loadArchives(); ctx.loadChatsList(); }
        } catch(e) {}
    }

    async function deleteArchive(id, title) {
        const confirmed = await openConfirm('Supprimer cette conversation archivée ?', title || '', true, 'Supprimer');
        if (!confirmed) return;
        try {
            const res = await fetchAuth(`/api/saved/chats/${id}`, { method: 'DELETE' });
            if (res && res.ok) loadArchives();
        } catch(e) {}
    }

    // (passe 5, F17) — jeton : un aller-retour Guide → Doc dév → Guide
    // laissait la réponse LENTE réécrire contenu ET onglet (le sélecteur
    // revenait tout seul sur le document quitté).
    let _helpSeq = 0;
    async function openHelp(doc) {
        // doc optionnel : 'user' (guide) | 'dev' (doc développeur). Défaut = sélection courante.
        const target = (doc === 'user' || doc === 'dev') ? doc : (helpDoc.value || 'user');
        const mySeq = ++_helpSeq;
        helpDoc.value = target;
        showHelpModal.value = true;
        isLoadingReadme.value = true;
        try {
            const res = await fetchAuth('/api/help/readme?doc=' + encodeURIComponent(target), {}, true);
            if (mySeq !== _helpSeq) return;   // réponse périmée
            if (res && res.ok) {
                const data = await res.json();
                if (mySeq !== _helpSeq) return;
                readmeContent.value = data.content;
                if (data.doc === 'user' || data.doc === 'dev') helpDoc.value = data.doc;
            } else {
                readmeContent.value = '# Erreur lors du chargement de la documentation.';
            }
        } catch(e) {
            if (mySeq !== _helpSeq) return;
            readmeContent.value = '# Erreur réseau lors du chargement de la documentation.';
        } finally {
            if (mySeq !== _helpSeq) return;
            isLoadingReadme.value = false;
            // Hydrate les diagrammes Mermaid (+ charts/SVG/boutons copier) dans la
            // modal une fois le v-html appliqué — réutilise le pipeline du chat,
            // scopé au conteneur de l'aide pour ne pas toucher le reste du DOM.
            nextTick(() => {
                if (ctx && typeof ctx.addCodeCopyButtons === 'function' && helpBodyRef.value) {
                    ctx.addCodeCopyButtons(true, helpBodyRef.value);
                }
            });
        }
    }

    // Bascule entre guide utilisateur et doc développeur (recharge le contenu).
    function switchHelpDoc(doc) {
        if (doc !== 'user' && doc !== 'dev') return;
        if (doc === helpDoc.value && readmeContent.value) return;   // déjà affiché
        openHelp(doc);
    }

    async function clearSandbox() {
        const confirmed = await openConfirm(
            'Vider l\'espace de développement ?',
            'Tous les fichiers et dossiers de votre sandbox seront définitivement supprimés.',
            true,
            'Tout supprimer'
        );
        if (!confirmed) return;
        try {
            const res = await fetchAuth('/api/sandbox/clear', { method: 'POST' });
            if (res && res.ok) {
                const data = await res.json();
                showToast(`${data.deleted} élément(s) supprimé(s)`);
                if (ctx.loadSandboxFiles) ctx.loadSandboxFiles();
                // Onglets ouverts : propres fermés, modifiés signalés (E32).
                if (ctx.checkExternalModsSoon) ctx.checkExternalModsSoon(0);
            } else {
                showToast('Erreur lors du nettoyage', 'error');
            }
        } catch(e) {
            showToast('Erreur réseau', 'error');
        }
    }

    async function clearAllChats() {
        const confirmed = await openConfirm(
            'Supprimer toutes les conversations ?',
            'Toutes vos conversations actives seront définitivement supprimées. Les archives ne sont pas affectées.',
            true,
            'Tout supprimer'
        );
        if (!confirmed) return;
        try {
            const res = await fetchAuth('/api/saved/chats/clear-all', { method: 'POST' });
            if (res && res.ok) {
                const data = await res.json();
                showToast(`${data.deleted} conversation(s) supprimée(s)`);
                if (ctx.loadChatsList) ctx.loadChatsList();
            } else {
                showToast('Erreur', 'error');
            }
        } catch(e) {
            showToast('Erreur réseau', 'error');
        }
    }

    // ── Utilisation : charge les métriques du user sur la période ────────
    async function loadUsageData() {
        usageLoading.value = true;
        usageError.value = '';
        try {
            const res = await fetchAuth('/api/usage/me?days=' + usageDays.value, {}, true);
            if (res && res.ok) {
                usageData.value = await res.json();
            } else if (res) {
                usageError.value = 'Erreur serveur (HTTP ' + res.status + ')';
            } else {
                usageError.value = 'Service injoignable';
            }
        } catch (e) {
            usageError.value = 'Erreur de chargement';
        } finally {
            usageLoading.value = false;
        }
    }

    function setUsageDays(d) {
        usageDays.value = [1, 7, 90].includes(d) ? d : 30;
        loadUsageData();
    }

    // Origines de consommation : l'identifiant technique ne va pas à l'écran.
    const USAGE_SOURCE_LABELS = Object.freeze({
        chat: 'Chat', routine: 'Routines', webhook: 'Webhooks',
        subagent: 'Sous-agents', title: 'Titres', compression: 'Compression',
        scenario: 'Studio', remote: 'Remote code', unknown: 'Non attribué',
    });
    function usageSourceLabel(s) {
        return USAGE_SOURCE_LABELS[s] || s || 'Autre';
    }

    // Part de raisonnement DANS LA SORTIE (pas dans le total : le raisonnement
    // ne concerne pas l'entrée). Un chiffre relatif se lit mieux qu'un absolu
    // pour juger « ce modèle réfléchit-il trop ? ».
    const usageThinkingPct = computed(() => {
        const t = usageData.value && usageData.value.tokens;
        if (!t || !t.output) return 0;
        return Math.round(1000 * (t.thinking || 0) / t.output) / 10;
    });

    function toggleArchiveSelect(id) {
        const idx = archiveSelected.value.indexOf(id);
        if (idx >= 0) archiveSelected.value.splice(idx, 1);
        else archiveSelected.value.push(id);
    }

    // ── Désarchivage groupé (bulk) — boucle sur l'endpoint unitaire
    //    /unarchive (idempotent ; pas d'endpoint batch côté serveur). ──────
    async function unarchiveSelectedArchives() {
        const ids = archiveSelected.value.slice();
        if (!ids.length) return;
        let ok = 0;
        for (const id of ids) {
            try {
                const res = await fetchAuth(`/api/saved/chats/${id}/unarchive`, { method: 'POST' });
                if (res && res.ok) ok++;
            } catch (e) { /* compté comme échec */ }
        }
        showToast(`${ok} conversation(s) restaurée(s)` + (ok < ids.length ? ` (${ids.length - ok} échec)` : ''),
                  ok === ids.length ? 'success' : 'error');
        archiveSelected.value = [];
        archiveSelectMode.value = false;
        loadArchives();
        if (ctx.loadChatsList) ctx.loadChatsList();
    }

    async function deleteSelectedArchives() {
        const confirmed = await openConfirm(
            `Supprimer ${archiveSelected.value.length} archive(s) ?`,
            'Cette action est irréversible.',
            true
        );
        if (!confirmed) return;
        try {
            const res = await fetchAuth('/api/saved/chats/delete-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: archiveSelected.value })
            });
            if (res && res.ok) {
                const data = await res.json();
                showToast(`${data.deleted} archive(s) supprimée(s)`);
                archiveSelected.value = [];
                archiveSelectMode.value = false;
                loadArchives();
            }
        } catch(e) { showToast('Erreur réseau', 'error'); }
    }

    function toggleSharedSelect(id) {
        const idx = sharedSelected.value.indexOf(id);
        if (idx >= 0) sharedSelected.value.splice(idx, 1);
        else sharedSelected.value.push(id);
    }

    async function deleteSelectedSharedPrompts() {
        const confirmed = await openConfirm(
            `Supprimer ${sharedSelected.value.length} prompt(s) ?`,
            '', true
        );
        if (!confirmed) return;
        try {
            const res = await fetchAuth('/api/prompts/shared/delete-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: sharedSelected.value })
            });
            if (res && res.ok) {
                const data = await res.json();
                showToast(`${data.deleted} prompt(s) supprimé(s)`);
                sharedSelected.value = [];
                sharedSelectMode.value = false;
                loadSharedPrompts();
            }
        } catch(e) { showToast('Erreur réseau', 'error'); }
    }

    // ─────────────────────────────────────────────────────────────────
    //  SANDBOX MODE (folder vs docker) — par utilisateur
    // ─────────────────────────────────────────────────────────────────
    const sandboxState = ref({
        user_mode: 'folder',
        effective_mode: 'folder',
        force_admin: false,
        daemon_ok: true,
        daemon_info: '',
        image: '',
        limits: {},
        idle_kill_hours: 24,
        container: null,
        stats: null,
        image_status: null,        // {status, progress_msg, elapsed_s, error}
    });
    const sandboxBusy = ref(false);
    // Profil réseau sélectionné (détail affiché sous le menu déroulant).
    const activeNetProfile = computed(() =>
        (sandboxState.value.network_profiles || []).find(
            p => p.id === sandboxState.value.network_profile_id) || null);

    // ── Statut de la sandbox : UN SEUL modèle ────────────────────────────
    // Le gabarit portait six branches v-if/v-else-if, chacune avec sa propre
    // recette de carte — CINQ combinaisons fond/bordure distinctes pour le
    // MÊME emplacement d'écran. L'état est une donnée : on le calcule une
    // fois ici, le gabarit n'a plus qu'une rangée à rendre.
    //   tone   : ok | idle | busy | warn | danger
    //   label  : l'état, en clair — c'est la ligne que l'œil doit trouver
    //   detail : ligne secondaire (message d'erreur, progression…)
    //   mono   : nom du container, quand il en existe un
    //   action : 'start' | 'create' | null — quel bouton proposer
    // ⚠ L'ORDRE reproduit exactement l'ancienne chaîne v-if/v-else-if : mode
    // d'abord, puis daemon, image, pending, running, exists. Le changer
    // changerait le comportement, pas seulement l'apparence.
    const sandboxStatus = computed(() => {
        const s = sandboxState.value;
        const c = s.container;
        const img = s.image_status;
        if (s.effective_mode !== 'docker') {
            return { tone: 'idle', label: 'Container arrêté',
                     detail: 'Mode dossier actif.', mono: '', action: 'create' };
        }
        if (!s.daemon_ok) {
            return { tone: 'danger', label: 'Docker injoignable',
                     detail: s.daemon_info || '(aucun détail)', mono: '', action: null };
        }
        if (img && img.status === 'loading') {
            const el = img.elapsed_s ? ` (${img.elapsed_s} s)` : '';
            return { tone: 'busy', label: "Préparation de l'image…",
                     detail: (img.progress_msg || "Premier chargement, jusqu'à une minute.") + el,
                     mono: '', action: null };
        }
        if (img && img.status === 'not_found') {
            return { tone: 'warn', label: 'Image indisponible',
                     detail: "L'administrateur doit fournir l'archive de l'image.",
                     mono: '', action: null };
        }
        if (img && img.status === 'error') {
            return { tone: 'danger', label: "Échec du chargement de l'image",
                     detail: img.error || '', mono: '', action: null };
        }
        if (c && c.pending) {
            return { tone: 'busy',
                     label: c.pending === 'image_loading' ? 'Image en cours…' : 'Démarrage…',
                     detail: '', mono: c.container_name || '', action: null };
        }
        if (c && c.running) {
            return { tone: 'ok', label: 'Actif', detail: '',
                     mono: c.container_name || '', action: null };
        }
        if (c && c.exists) {
            return { tone: 'idle', label: 'Arrêté', detail: '',
                     mono: c.container_name || '', action: 'start' };
        }
        return { tone: 'idle', label: 'Aucun container',
                 detail: 'Il sera créé au démarrage.', mono: '', action: 'create' };
    });

    // Tonalités. ⚠ La couleur ne porte JAMAIS l'information seule : le libellé
    // dit l'état en toutes lettres, la pastille ne fait que le renforcer.
    // C'est aussi ce qui garde le texte lisible en mode sombre — les accents
    // Tailwind (emerald-700, red-700…) ne sont PAS remappés par les skins,
    // seuls les neutres le sont ; un libellé coloré posé sur la surface
    // sombre tomberait sous le seuil de contraste.
    const SANDBOX_TONES = {
        ok:     { dot: 'bg-emerald-500', alert: '' },
        idle:   { dot: 'bg-slate-300',   alert: '' },
        busy:   { dot: 'bg-blue-500',    alert: '' },
        warn:   { dot: 'bg-amber-500',   alert: 'bg-amber-50 border-amber-200 text-amber-800' },
        danger: { dot: 'bg-red-500',     alert: 'bg-red-50 border-red-200 text-red-700' },
    };
    const sandboxTone = computed(
        () => SANDBOX_TONES[sandboxStatus.value.tone] || SANDBOX_TONES.idle);

    // ── Profil réseau : menu déroulant maison ────────────────────────────
    // Le <select> natif ne se style pas — il restait CLAIR en mode sombre
    // alors que `.set-select` est pourtant tokenisé — et il ne peut pas
    // montrer, sous chaque option, ce que le profil IMPLIQUE. Or c'est
    // exactement l'information qui manque au moment de choisir.
    // On décalque le menu « effort de réflexion » du composeur : mêmes
    // rôles ARIA, même transition `popover`, même contrat clavier, même
    // fermeture par `closest()` dans onGlobalClick. Rien d'inventé.
    const netMenuOpen = ref(false);

    // Mot d'usage du mode, pour le déclencheur et les options.
    function netProfileMode(prof) {
        if (!prof) return '';
        return prof.mode === 'none' ? 'isolé'
             : (prof.mode === 'bridge' ? 'ouvert' : 'filtré');
    }
    // Ce que le profil implique, en clair. Le `description` de l'admin prime.
    function netProfileDetail(prof) {
        if (!prof) return '';
        if (prof.description) return prof.description;
        if (prof.mode === 'none') return 'Aucun accès réseau sortant.';
        if (prof.mode === 'bridge') return 'Accès réseau complet.';
        return 'Accès limité aux adresses listées.';
    }
    function _netMenuOptions() {
        const root = document.querySelector('[data-net-menu]');
        return root ? Array.prototype.slice.call(root.querySelectorAll('[role="option"]')) : [];
    }
    function toggleNetMenu() {
        // Verrouillé par l'admin ou transition en cours : le déclencheur est
        // déjà `disabled`, cette garde couvre l'appel clavier.
        if (sandboxBusy.value || sandboxState.value.network_profile_locked) return;
        netMenuOpen.value = !netMenuOpen.value;
        if (!netMenuOpen.value) return;
        nextTick(() => {
            const opts = _netMenuOptions();
            const cur = opts.find(el => el.getAttribute('aria-selected') === 'true');
            (cur || opts[0]) && (cur || opts[0]).focus();
        });
    }
    function pickNetProfile(id) {
        netMenuOpen.value = false;
        // Re-choisir le profil courant ne déclenche AUCUNE transition (elle
        // recrée le conteneur) — garde identique à celle de l'ancien @change.
        if (id !== sandboxState.value.network_profile_id) onChangeProfile(id);
    }
    // Fermeture + restitution du focus au déclencheur. Appelée par la
    // cascade Échap globale (app.js), qui est en CAPTURE : c'est elle qui
    // doit fermer le menu, sinon elle fermerait la modale entière.
    function closeNetMenu() {
        netMenuOpen.value = false;
        const t = document.querySelector('[data-net-menu] > div > button');
        t && t.focus();
    }
    function onNetMenuKeydown(e) {
        // ⚠ Ne RIEN intercepter quand le menu est fermé : sans cette garde,
        // une Échap frappée alors que le focus est sur la rangée était
        // avalée ici — et surtout, `preventDefault()` seul n'arrête PAS la
        // propagation : l'événement remontait au gestionnaire de la modale,
        // qui FERMAIT TOUTE LA MODALE au lieu du menu (mesuré au harnais).
        if (!netMenuOpen.value) return;
        const opts = _netMenuOptions();
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeNetMenu();
            return;
        }
        if (!opts.length) return;
        const cur = opts.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); opts[(cur + 1 + opts.length) % opts.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); opts[(cur - 1 + opts.length) % opts.length].focus(); }
        else if (e.key === 'Home') { e.preventDefault(); opts[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); opts[opts.length - 1].focus(); }
    }

    // Barre de progression de transition (folder ↔ docker, change profil)
    const transitionState = ref({
        active: false,
        progress: 0,    // 0-100
        label: '',
        step: 0,
        total: 0,
        error: null,
        containerLogs: null,  // logs du container si crash
    });

    /**
     * Lance une transition avec barre de progression à étapes.
     * @param {Array} steps    - [{label, target}] où target ∈ [0, 100]
     * @param {Function} action - async function qui fait le vrai boulot.
     *                             Elle reçoit (advance) où advance(idx) saute à l'étape idx.
     */
    async function runTransition(steps, action) {
        transitionState.value = {
            active: true, progress: 0, label: steps[0]?.label || '',
            step: 1, total: steps.length, error: null, containerLogs: null,
        };
        sandboxBusy.value = true;

        // Animation interpolée vers chaque target
        let currentProgress = 0;
        let currentTarget = steps[0]?.target || 5;
        let animTimer = null;

        function startAnim() {
            if (animTimer) clearInterval(animTimer);
            animTimer = setInterval(() => {
                if (currentProgress < currentTarget - 0.5) {
                    // Easing : avance plus vite quand loin, ralentit en approchant
                    const delta = Math.max(0.3, (currentTarget - currentProgress) * 0.08);
                    currentProgress += delta;
                    transitionState.value.progress = Math.min(currentProgress, currentTarget);
                }
            }, 80);
        }

        function advance(idx) {
            if (idx >= steps.length) idx = steps.length - 1;
            const s = steps[idx];
            if (!s) return;
            currentTarget = s.target;
            transitionState.value.step = idx + 1;
            transitionState.value.label = s.label;
        }

        startAnim();

        try {
            await action(advance);
            // Fin. ⚠ La barre doit suivre le LIBELLÉ, pas l'inverse : on
            // posait la dernière étape puis on laissait l'interpolation
            // rattraper, si bien qu'un dos rapide affichait « Container prêt
            // — étape 3 sur 3 » avec une barre à 34 % (vu en capture). On
            // synchronise les deux : le CSS de la barre porte déjà un
            // `transition-transform` de 500 ms, le remplissage reste donc
            // animé, il ne ment simplement plus.
            currentTarget = 100;
            currentProgress = 100;
            advance(steps.length - 1);
            transitionState.value.label = steps[steps.length - 1].label;
            transitionState.value.progress = 100;
            // On laisse la barre pleine à l'écran le temps de la lire.
            await new Promise(r => setTimeout(r, 600));
        } catch (e) {
            transitionState.value.error = e.message || String(e);
            // Si on a des logs du container, les afficher (visible plus longtemps)
            const logs = sandboxState.value.container?.logs;
            if (logs) {
                transitionState.value.containerLogs = logs;
                // Avec logs : on garde 8s pour que l'user puisse lire
                await new Promise(r => setTimeout(r, 8000));
            } else {
                await new Promise(r => setTimeout(r, 2500));
            }
            throw e;
        } finally {
            if (animTimer) clearInterval(animTimer);
            transitionState.value.active = false;
            sandboxBusy.value = false;
        }
    }

    async function onChangeProfile(newProfileId) {
        if (sandboxBusy.value) return;
        if (sandboxState.value.network_profile_locked) return;
        if (newProfileId === sandboxState.value.network_profile_id) return;
        const newProf = (sandboxState.value.network_profiles || []).find(p => p.id === newProfileId);
        const ok = await openConfirm(
            `Changer pour "${newProf?.name || newProfileId}" ?`,
            "Le container Docker sera détruit puis recréé avec le nouveau profil. Vos fichiers restent intacts.",
            false, 'Changer le profil'
        );
        if (!ok) return;

        const steps = [
            { label: 'Sauvegarde du profil…',                target: 12 },
            { label: 'Destruction de l\'ancien container…',  target: 35 },
            { label: 'Création du nouveau container…',       target: 60 },
            { label: 'Démarrage…',                            target: 82 },
            { label: 'Configuration réseau…',                 target: 95 },
            { label: 'Container prêt',                        target: 100 },
        ];

        try {
            await runTransition(steps, async (advance) => {
                advance(0);
                const r = await fetchAuth('/api/sandbox/me', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'docker', network_profile_id: newProfileId }),
                });
                if (!r || !r.ok) {
                    throw new Error(r ? await r.text() : 'no response');
                }
                const data = await r.json();
                if (data.bootstrap?.container?.logs) {
                    sandboxState.value.container = {
                        ...sandboxState.value.container,
                        logs: data.bootstrap.container.logs,
                    };
                }
                if (data.bootstrap?.container?.error) {
                    throw new Error(data.bootstrap.container.error);
                }

                advance(1);  // destruction (déjà faite par le backend dans le POST)
                await new Promise(r => setTimeout(r, 200));

                advance(2);  // création
                await loadSandboxState();

                advance(3);  // démarrage
                await waitFor(() => {
                    const c = sandboxState.value.container;
                    return c && c.running;
                }, 30000, 500);

                advance(4);  // iptables
                await new Promise(r => setTimeout(r, 200));
                advance(5);
            });
            showToast(`Profil réseau changé : ${newProf?.name}`, 'success');
        } catch (e) {
            showToast('Échec : ' + e.message, 'error');
            await loadSandboxState();
        }
    }

    // Polling auto : tourne tant que le container n'est pas prêt
    // (image en cours de chargement OU container en démarrage)
    let _sandboxPollTimer = null;

    function _shouldKeepPolling() {
        const s = sandboxState.value;
        if (s.effective_mode !== 'docker') return false;
        if (!s.daemon_ok) return false;

        const imgStatus = s.image_status && s.image_status.status;
        if (imgStatus === 'loading') return true;

        const c = s.container;
        if (c && c.pending) return true;
        if (c && c.exists && !c.running) return false;
        if (!c || (!c.running && imgStatus === 'loaded')) return true;

        return false;
    }

    // AUDIT 2026-09-01 (passe 5, F19) — cadence la plus agressive du dépôt
    // (1,5 s) : garde de visibilité (onglet caché = pas de requête) + borne
    // d'échecs consécutifs (``loadSandboxState`` sortait sur !r.ok SANS
    // réévaluer l'état : un daemon bloqué « pending » = 40 req/min à vie).
    let _sandboxPollErrs = 0;
    function _startSandboxPolling() {
        if (_sandboxPollTimer) return;
        _sandboxPollErrs = 0;
        _sandboxPollTimer = setInterval(async () => {
            if (!_shouldKeepPolling()) {
                _stopSandboxPolling();
                return;
            }
            if (document.visibilityState !== 'visible') return;
            const before = sandboxState.value;
            await loadSandboxState({ silent: true });
            // loadSandboxState sort en avance sur !r.ok sans toucher l'état :
            // la référence inchangée trahit l'échec.
            if (sandboxState.value === before) {
                if (++_sandboxPollErrs >= 20) { _stopSandboxPolling(); }
            } else {
                _sandboxPollErrs = 0;
            }
        }, 1500);
    }

    function _stopSandboxPolling() {
        if (_sandboxPollTimer) {
            clearInterval(_sandboxPollTimer);
            _sandboxPollTimer = null;
        }
    }

    async function loadSandboxState(opts = {}) {
        try {
            const r = await fetchAuth('/api/sandbox/me');
            if (!r || !r.ok) return;
            const data = await r.json();
            sandboxState.value = {
                user_mode: data.user_mode || 'folder',
                effective_mode: data.effective_mode || 'folder',
                force_admin: !!data.force_admin,
                daemon_ok: data.daemon_ok !== false,
                daemon_info: data.daemon_info || '',
                image: data.image || '',
                limits: data.limits || {},
                idle_kill_hours: data.idle_kill_hours || 24,
                container: data.container || null,
                stats: data.stats || null,
                image_status: data.image_status || null,
                network_profile_id: data.network_profile_id || 'isolated',
                network_profiles: data.network_profiles || [],
                // Imposé par l'admin → sélecteur verrouillé (le serveur refuse
                // de toute façon tout autre profil).
                network_profile_locked: !!data.network_profile_locked,
            };
            // Démarrer/arrêter le polling selon l'état
            if (_shouldKeepPolling()) {
                _startSandboxPolling();
            } else {
                _stopSandboxPolling();
            }
        } catch (e) {
            if (!opts.silent) console.error('loadSandboxState', e);
        }
    }

    async function changeSandboxMode(mode) {
        if (sandboxBusy.value) return;
        // Note : 'mode' était folder|docker. Le mode folder n'existe plus
        // côté UI. On force docker pour rester compatible avec l'API.
        if (mode !== 'docker') mode = 'docker';

        const steps = [
            { label: 'Sauvegarde de la configuration…', target: 12 },
            { label: 'Préparation de l\'image Docker…',  target: 35 },
            { label: 'Création du container…',            target: 60 },
            { label: 'Démarrage…',                        target: 80 },
            { label: 'Configuration réseau…',             target: 92 },
            { label: 'Container prêt',                    target: 100 },
        ];

        try {
            await runTransition(steps, async (advance) => {
                advance(0);
                const r = await fetchAuth('/api/sandbox/me', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode }),
                });
                if (!r || !r.ok) {
                    const txt = r ? await r.text() : 'no response';
                    throw new Error(txt);
                }
                const data = await r.json();

                if (data.bootstrap?.container?.logs) {
                    sandboxState.value.container = {
                        ...sandboxState.value.container,
                        logs: data.bootstrap.container.logs,
                    };
                }
                if (data.bootstrap?.container?.error) {
                    throw new Error(data.bootstrap.container.error);
                }

                sandboxState.value.user_mode = mode;
                sandboxState.value.effective_mode = 'docker';

                const imgStatus = data.bootstrap?.image_status?.status;
                if (imgStatus === 'loading') {
                    advance(1);
                    await waitFor(() => {
                        const s = sandboxState.value.image_status;
                        return s && s.status === 'loaded';
                    }, 60000, 1000);
                }

                advance(2);
                await loadSandboxState();

                advance(3);
                await waitFor(() => {
                    const c = sandboxState.value.container;
                    return c && c.running;
                }, 30000, 500);

                advance(4);
                await new Promise(r => setTimeout(r, 200));
                advance(5);
            });

            showToast('Container Docker prêt.', 'success');
        } catch (e) {
            showToast('Échec : ' + e.message, 'error');
            await loadSandboxState();
        }
    }

    /**
     * Attend qu'une condition soit vraie en pollant le sandbox state.
     * @param {Function} predicate - retourne true quand on peut continuer
     * @param {number} timeoutMs   - timeout total
     * @param {number} intervalMs  - intervalle entre les polls
     */
    async function waitFor(predicate, timeoutMs = 30000, intervalMs = 500) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            await loadSandboxState();
            if (predicate()) return true;
            await new Promise(r => setTimeout(r, intervalMs));
        }
        throw new Error('Timeout en attendant l\'état attendu');
    }

    // Démarrage / redémarrage du container.
    //
    // Ces deux actions n'ont JAMAIS eu la barre de progression : seules la
    // création (`changeSandboxMode`) et le changement de profil passaient par
    // `runTransition`. Elles durent pourtant plusieurs secondes, pendant
    // lesquelles l'écran ne disait rien — un `sandboxBusy` muet et un toast à
    // la fin. Elles la reçoivent donc, avec des étapes réelles.
    //
    // ``intent`` distingue les deux appelants : le même endpoint sert à
    // démarrer un container ARRÊTÉ et à en redémarrer un ACTIF, mais parler
    // de « processus en cours seront arrêtés » à quelqu'un dont le container
    // est à l'arrêt était faux.
    async function restartSandboxContainer(intent = 'restart') {
        const restarting = intent !== 'start';
        if (!await openConfirm(
            restarting ? 'Redémarrer votre container ?' : 'Démarrer votre container ?',
            restarting
                ? 'Les processus en cours seront arrêtés mais vos fichiers restent intacts.'
                : 'Votre dossier de travail sera monté sur /work.',
            false, restarting ? 'Redémarrer' : 'Démarrer'
        )) return;

        // ⚠ La DERNIÈRE étape n'est pas à annoncer ici : `runTransition` la
        // pose lui-même une fois l'action résolue, puis pousse la barre à
        // 100 %. L'annoncer depuis l'action affichait « Container prêt —
        // étape 3 sur 3 » alors que la barre était encore à 34 % (l'animation
        // interpole vers sa cible, le libellé, lui, saute). Vu en capture.
        const steps = restarting
            ? [
                { label: 'Arrêt du container…',      target: 35 },
                { label: 'Redémarrage…',             target: 80 },
                { label: 'Container prêt',           target: 100 },
              ]
            : [
                { label: 'Démarrage du container…',  target: 45 },
                { label: 'Configuration réseau…',    target: 85 },
                { label: 'Container prêt',           target: 100 },
              ];

        try {
            await runTransition(steps, async (advance) => {
                advance(0);
                const r = await fetchAuth('/api/sandbox/me/restart', { method: 'POST' });
                if (!r || !r.ok) throw new Error(r ? await r.text() : 'no response');
                // Avant-dernière étape pendant le rechargement de l'état :
                // tant qu'il n'est pas là, le container n'est pas « prêt ».
                advance(steps.length - 2);
                await loadSandboxState();
            });
            showToast(restarting ? 'Container redémarré.' : 'Container démarré.', 'success');
        } catch (e) {
            // runTransition a déjà affiché l'erreur dans la barre (et les logs
            // du container s'il y en a) avant de la relancer.
            showToast('Échec : ' + e.message, 'error');
        }
    }

    async function destroySandboxContainer() {
        if (!await openConfirm(
            'Détruire votre container ?',
            "Le container Docker sera supprimé. Votre dossier de travail reste intact, vous pourrez toujours le réutiliser.",
            true, 'Détruire'
        )) return;
        sandboxBusy.value = true;
        try {
            const r = await fetchAuth('/api/sandbox/me', { method: 'DELETE' });
            if (!r || !r.ok) throw new Error(r ? await r.text() : 'no response');
            showToast('Container détruit. Il sera recréé au prochain usage.', 'success');
            await loadSandboxState();
        } catch (e) {
            showToast('Échec : ' + e.message, 'error');
        } finally {
            sandboxBusy.value = false;
        }
    }

    // Auto-charge au passage sur l'onglet sandbox
    const _origOpenSettings = openSettings;
    if (typeof _origOpenSettings === 'function') {
        // On wrappe : si on ouvre les settings, charger l'état sandbox.
        // (pas indispensable, mais évite un flash)
    }

    // ════════════ Connecteurs Git (credentials par-host, host-only) ══════════
    // Remplace le fichier .git-credentials.json de la sandbox. Le token est
    // write-only : l'API ne renvoie que ``has_token``, jamais le secret.
    // ════════════ Connexions (jetons personnels, EXT.1) ═══════════════════════
    // Module à part (settings/connexions.js) ; repli inerte s'il manque.
    const _cnxMod = (typeof window !== 'undefined' && typeof window.setupConnexions === 'function')
        ? window.setupConnexions(vue, ctx)
        : { loadConnexions: async () => {} };

    const gitConnectors = ref([]);
    const gitConnTypes  = ref([]);
    const gitConnForm   = ref(null);     // null = aucun formulaire ouvert
    const gitConnBusy   = ref(false);
    const gitConnTest   = ref({});       // { [id]: {ok|testing|error|login} }
    const gitConnAdvanced = ref(false);  // toggle « + Avancé » (host/api_base override)

    async function loadGitConnectors() {
        try {
            const r = await fetchAuth('/api/git/connectors', {}, true);
            if (r && r.ok) {
                const d = await r.json();
                gitConnectors.value = d.connectors || [];
                gitConnTypes.value = d.provider_types || [];
            }
        } catch (e) { /* best-effort */ }
    }

    // ════════════ Mémoire long-terme ═════════════════════════════════════════
    // Onglet Réglages « Mémoire » : affiche ce que l'assistant a curé pour ce
    // user (USER.md profil + MEMORY.md notes) via GET /api/memory/state
    // (require_user_id → per-user). La curation reste son travail ; le mode
    // ÉDITION (PUT /api/memory/state/{user|memory}) sert à corriger ou retirer
    // ce qu'il a mal retenu — avant, le seul recours était « Effacer tout ».
    const userMemory        = ref(null);
    const userMemoryLoading = ref(false);
    const userMemoryError   = ref('');
    const userMemoryDeleting = ref(false);
    async function loadUserMemory() {
        userMemoryLoading.value = true;
        userMemoryError.value = '';
        try {
            const r = await fetchAuth('/api/memory/state', {}, true);
            if (r && r.ok) { userMemory.value = await r.json(); }
            else { userMemoryError.value = 'Impossible de charger la mémoire.'; }
        } catch (e) {
            userMemoryError.value = 'Erreur réseau.';
        } finally {
            userMemoryLoading.value = false;
        }
    }

    // ── Origine des notes (2026-09-19) ───────────────────────────────────────
    // ``origins`` = liste PARALLÈLE à ``entries`` lue dans le journal des
    // écritures : date, source (assistant / Réglages / annulation) et chat
    // qui a écrit la note. ``null`` pour une note antérieure au journal.
    function memoryOrigin(kind, i) {
        const st = ((userMemory.value || {})[_MEM_KEY[kind]]) || {};
        const o = Array.isArray(st.origins) ? st.origins[i] : null;
        if (!o || !o.ts) return null;
        const d = new Date(o.ts * 1000);
        const sameYear = d.getFullYear() === new Date().getFullYear();
        const date = d.toLocaleDateString('fr-FR', sameYear
            ? { day: '2-digit', month: '2-digit' }
            : { day: '2-digit', month: '2-digit', year: 'numeric' });
        let label = '';
        if (o.source === 'settings') label = 'Réglages';
        else if (o.source === 'undo') label = 'annulation';
        else if (o.chat_id && o.chat_title) label = '« ' + o.chat_title + ' »';
        else if (o.chat_id) label = 'chat supprimé';
        else label = 'assistant';
        return { date, label, chatId: o.chat_id || null,
                 canOpen: !!(o.source === 'tool' && o.chat_id && o.chat_exists) };
    }

    async function openMemoryOrigin(kind, i) {
        const o = memoryOrigin(kind, i);
        if (!o || !o.canOpen || !ctx.openChatById) return;
        // Fermeture NORMALE (confirmation si des réglages ne sont pas
        // enregistrés, puis retour à l'état serveur) : ``true`` est réservé à
        // saveSettings — il laissait des réglages non enregistrés actifs, que
        // l'enregistrement suivant aurait validés en douce.
        await closeSettings();
        if (showSettingsModal.value) return;          // abandon refusé
        ctx.openChatById(o.chatId);
    }

    // ── Mode édition ─────────────────────────────────────────────────────────
    // Brouillon local tant qu'on n'a pas enregistré : on ne touche jamais à
    // ``userMemory`` (l'image du disque), pour qu'Annuler soit un vrai retour
    // arrière et que l'affichage lecture reste véridique.
    const memoryEditing   = ref(false);
    const memorySaving    = ref(false);
    const memorySaveError = ref('');
    const memoryDraft     = ref({ user: [], memory: [] });

    const _MEM_KEY = { user: 'user_md', memory: 'memory_md' };
    function _memStored(kind) {
        return (((userMemory.value || {})[_MEM_KEY[kind]]) || {}).entries || [];
    }

    function startMemoryEdit() {
        if (!userMemory.value) return;
        memoryDraft.value = { user: _memStored('user').slice(),
                              memory: _memStored('memory').slice() };
        memorySaveError.value = '';
        memoryEditing.value = true;
    }
    function cancelMemoryEdit() {
        memoryEditing.value = false;
        memorySaveError.value = '';
        memoryDraft.value = { user: [], memory: [] };
    }
    function addMemoryEntry(kind) { memoryDraft.value[kind].push(''); }
    function removeMemoryEntry(kind, i) { memoryDraft.value[kind].splice(i, 1); }

    // Longueur SÉRIALISÉE — la formule du store (entrées jointes par une ligne
    // « § »), pas la somme brute : celle-ci laisserait croire qu'on tient sous
    // la limite alors que le serveur compte aussi les séparateurs.
    function memoryDraftChars(kind) {
        const list = (memoryDraft.value[kind] || [])
            .map(e => String(e == null ? '' : e).trim()).filter(Boolean);
        return list.length ? list.join('\n§\n').length : 0;
    }
    function memoryLimit(kind) {
        return (((userMemory.value || {})[_MEM_KEY[kind]]) || {}).limit || 0;
    }
    function memoryOver(kind) {
        const lim = memoryLimit(kind);
        return !!lim && memoryEditing.value && memoryDraftChars(kind) > lim;
    }
    const memoryOverLimit = computed(() => memoryOver('user') || memoryOver('memory'));

    // Brouillon différent du disque → même traitement que ``settingsDirty``
    // (badge « Modifications non enregistrées » + garde à la fermeture).
    const memoryDirty = computed(() => {
        if (!memoryEditing.value) return false;
        return ['user', 'memory'].some((kind) => {
            const before = _memStored(kind);
            const after = (memoryDraft.value[kind] || [])
                .map(e => String(e == null ? '' : e).trim()).filter(Boolean);
            return after.length !== before.length || after.some((e, i) => e !== before[i]);
        });
    });

    // N'envoie QUE les magasins réellement modifiés : un PUT inutile réécrirait
    // le fichier et pourrait entrer en concurrence avec une écriture de
    // l'assistant pour rien.
    async function saveMemoryEdit() {
        if (memorySaving.value || !userMemory.value) return;
        const jobs = [];
        for (const kind of ['user', 'memory']) {
            const before = _memStored(kind);
            const after = (memoryDraft.value[kind] || [])
                .map(e => String(e == null ? '' : e).trim()).filter(Boolean);
            if (after.length === before.length && after.every((e, i) => e === before[i])) continue;
            jobs.push({ kind, entries: after, emptied: !after.length && before.length > 0 });
        }
        if (!jobs.length) { cancelMemoryEdit(); return; }
        // Vider un magasin supprime son fichier : même famille d'action que
        // « Effacer tout », donc même confirmation.
        if (jobs.some(j => j.emptied)) {
            const ok = await openConfirm(
                'Vider ce que l\'assistant a retenu ?',
                'Les entrées supprimées ne sont pas récupérables.',
                true, 'Vider',
            );
            if (!ok) return;
        }
        memorySaving.value = true;
        memorySaveError.value = '';
        const errors = [];
        try {
            for (const j of jobs) {
                let r = null;
                try {
                    r = await fetchAuth('/api/memory/state/' + j.kind, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entries: j.entries }),
                    }, true);
                } catch (_) { r = null; }
                if (r && r.ok) continue;
                let msg = r ? 'enregistrement refusé' : 'erreur réseau';
                try {
                    const d = await r.json();
                    if (d && d.detail) msg = String(d.detail);
                } catch (_) {}
                errors.push((j.kind === 'user' ? 'Profil' : 'Notes') + ' : ' + msg);
            }
        } finally {
            memorySaving.value = false;
        }
        if (errors.length) {
            // On RESTE en édition sans recharger : recharger réécraserait le
            // brouillon refusé, et l'utilisateur perdrait le texte à corriger.
            memorySaveError.value = errors.join(' · ');
            return;
        }
        memoryEditing.value = false;
        memoryDraft.value = { user: [], memory: [] };
        showToast('Mémoire enregistrée.', 'success');
        await loadUserMemory();
    }

    // Effacement TOTAL de la mémoire long-terme (destructif, opt-in). Réutilise
    // la modale de confirmation danger partagée (openConfirm) — même UX que les
    // autres suppressions. DELETE /api/memory/state supprime USER.md + MEMORY.md
    // + scopes/ + .audit.jsonl côté serveur, puis on recharge l'affichage.
    async function deleteUserMemory() {
        if (userMemoryDeleting.value) return;
        const ok = await openConfirm(
            'Effacer toute la mémoire ?',
            "Tout ce que l'assistant a retenu (profil, notes, scopes) sera supprimé définitivement. Cette action est irréversible.",
            true, 'Effacer',
        );
        if (!ok) return;
        userMemoryDeleting.value = true;
        try {
            const r = await fetchAuth('/api/memory/state', { method: 'DELETE' }, true);
            if (r && r.ok) {
                showToast('Mémoire effacée.', 'success');
                await loadUserMemory();
            } else {
                showToast('Échec de la suppression de la mémoire.', 'error');
            }
        } catch (e) {
            showToast('Mémoire : erreur réseau.', 'error');
        } finally {
            userMemoryDeleting.value = false;
        }
    }

    // Persistance IMMÉDIATE du toggle mémoire, indépendante du bouton Enregistrer :
    // un interrupteur de préférence doit tenir dès qu'on le bascule (et survivre à
    // un redémarrage serveur). PUT ciblé {memory_enabled} — le backend FUSIONNE,
    // donc les autres réglages non enregistrés restent intacts. On rebase la clé
    // dans le snapshot pour ne pas la compter comme « non enregistrée ».
    async function persistMemoryEnabled() {
        const val = !!settings.value.memory_enabled;
        try {
            const r = await fetchAuth('/api/settings', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ memory_enabled: val }),
            });
            if (!r || !r.ok) { showToast('Mémoire : enregistrement échoué.', 'error'); return; }
            try {
                const s = JSON.parse(_settingsSnapshot.value || '{}');
                s.memory_enabled = val;
                _settingsSnapshot.value = JSON.stringify(s);
            } catch (_) { /* snapshot best-effort */ }
            showToast(val ? 'Mémoire long-terme activée.' : 'Mémoire long-terme désactivée.');
        } catch (e) {
            showToast('Mémoire : erreur réseau.', 'error');
        }
    }

    // Persistance IMMÉDIATE du toggle sous-agents — même contrat que la mémoire.
    async function persistAgentsEnabled() {
        const val = !!settings.value.agents_enabled;
        try {
            const r = await fetchAuth('/api/settings', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agents_enabled: val }),
            });
            if (!r || !r.ok) { showToast('Sous-agents : enregistrement échoué.', 'error'); return; }
            try {
                const s = JSON.parse(_settingsSnapshot.value || '{}');
                s.agents_enabled = val;
                _settingsSnapshot.value = JSON.stringify(s);
            } catch (_) { /* snapshot best-effort */ }
            showToast(val ? 'Sous-agents activés.' : 'Sous-agents désactivés.');
        } catch (e) {
            showToast('Sous-agents : erreur réseau.', 'error');
        }
    }

    // opencode : une entrée MCP par famille d'outils, donc une bascule par
    // famille dans son TUI. Cette bascule-LÀ n'est pas persistée par opencode
    // (connect/disconnect en mémoire) et un re-sync réécrit ``opencode.json``
    // en entier : le choix ne survit que stocké ICI, côté compte.
    function opencodeFamilyOn(name) {
        const m = settings.value.opencode_mcp_families;
        return !(m && m[name] === false);
    }
    async function toggleOpencodeFamily(name) {
        const before = { ...(settings.value.opencode_mcp_families || {}) };
        const next = { ...before };
        next[name] = !opencodeFamilyOn(name);
        settings.value.opencode_mcp_families = next;
        await _persistKeys(['opencode_mcp_families'], {
            rollback: () => { settings.value.opencode_mcp_families = before; },
        });
    }

    // Persistance IMMÉDIATE du toggle compaction automatique — même contrat.
    // Ne gouverne QUE l'automatique : /compact reste disponible dans les deux
    // états, d'où le libellé du toast (« automatique »).
    async function persistCompressionEnabled() {
        const val = !!settings.value.compression_enabled;
        try {
            const r = await fetchAuth('/api/settings', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ compression_enabled: val }),
            });
            if (!r || !r.ok) { showToast('Compaction : enregistrement échoué.', 'error'); return; }
            try {
                const s = JSON.parse(_settingsSnapshot.value || '{}');
                s.compression_enabled = val;
                _settingsSnapshot.value = JSON.stringify(s);
            } catch (_) { /* snapshot best-effort */ }
            showToast(val ? 'Compaction automatique activée.'
                          : 'Compaction automatique désactivée.');
        } catch (e) {
            showToast('Compaction : erreur réseau.', 'error');
        }
    }

    // ── Seuil de compaction (« contexte max avant compaction ») ─────────────
    // Deux unités EXCLUSIVES, stockées dans deux clés : ``compression_threshold_pct``
    // (% de la fenêtre) et ``compression_threshold_tokens``. Le serveur fait
    // primer les tokens et efface l'autre clé à l'enregistrement ; l'interface
    // tient la même règle pour que l'affichage ne mente jamais entre deux PUT.
    //
    // ``compactionUnit`` est DÉRIVÉ des valeurs (pas une 3e clé persistée) :
    // un mode stocké à part pourrait contredire les valeurs et il faudrait
    // arbitrer. Ici l'état est toujours cohérent par construction.
    //
    // ``compactionUnitPin`` est la SEULE exception, et elle ne vit que le temps
    // d'une saisie : vider le champ tokens met la valeur à 0, ce qui ferait
    // retomber l'unité dérivée sur « Auto » — le champ disparaîtrait sous les
    // doigts de qui efface pour retaper. L'épingle tient l'unité choisie à la
    // main tant qu'aucune valeur ne parle à sa place. Jamais persistée, et
    // remise à plat à chaque chargement des réglages.
    const compactionUnitPin = ref('');
    const compactionUnit = computed(() => {
        if (Number(settings.value.compression_threshold_tokens) > 0) return 'tokens';
        if (Number(settings.value.compression_threshold_pct) > 0) return 'pct';
        return compactionUnitPin.value || 'auto';
    });

    // Valeur affichée par le curseur quand l'unité est « % ». 70 est la
    // position de départ d'un compte qui vient de choisir cette unité : assez
    // bas pour que le réglage se voie, assez haut pour rester raisonnable.
    const COMPACTION_PCT_DEFAUT = 70;
    const COMPACTION_TOKENS_DEFAUT = 80000;
    const compactionPct = computed(() =>
        Number(settings.value.compression_threshold_pct) || COMPACTION_PCT_DEFAUT);

    // « 80 k » / « 1.2M » — même écriture que la jauge de contexte du chat.
    const compactionTokensLabel = computed(() => {
        const n = Number(settings.value.compression_threshold_tokens) || 0;
        if (!n) return '—';
        if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1000)    return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(n);
    });

    // Une phrase, qui dit ce que CE réglage fait — pas ce que la compaction est.
    const compactionThresholdHint = computed(() => {
        if (compactionUnit.value === 'pct')
            return 'Compacte dès que le contexte atteint cette part de la fenêtre du modèle.';
        if (compactionUnit.value === 'tokens')
            return 'Compacte dès que le contexte atteint ce nombre de tokens. Plafonné à ce que le modèle courant supporte.';
        return 'Compacte quand la fenêtre du modèle est pleine.';
    });

    function setCompactionUnit(unit) {
        compactionUnitPin.value = unit;
        // Changer d'unité efface l'autre : c'est la règle du serveur, tenue
        // ici aussi. Chaque unité repart sur sa valeur par défaut plutôt que
        // sur un souvenir — un ancien 30 % qui ressurgit six semaines plus
        // tard se lit comme un bug.
        if (unit === 'pct') {
            settings.value.compression_threshold_pct = COMPACTION_PCT_DEFAUT;
            settings.value.compression_threshold_tokens = 0;
        } else if (unit === 'tokens') {
            settings.value.compression_threshold_pct = 0;
            settings.value.compression_threshold_tokens = COMPACTION_TOKENS_DEFAUT;
        } else {
            settings.value.compression_threshold_pct = 0;
            settings.value.compression_threshold_tokens = 0;
        }
        persistCompactionThreshold();
    }

    function setCompactionPct(raw) {
        const v = Math.round(Number(raw) || 0);
        settings.value.compression_threshold_pct = Math.max(30, Math.min(95, v));
        settings.value.compression_threshold_tokens = 0;
    }

    function setCompactionTokens(raw) {
        // Champ vidé : on garde l'unité « tokens » affichée (0 basculerait le
        // sélecteur sur « Auto » en pleine frappe, curseur perdu). Le clamp
        // final appartient au serveur ; ici on ne fait que borner l'aberrant.
        const v = Math.round(Number(raw) || 0);
        settings.value.compression_threshold_tokens = v > 0 ? Math.min(4000000, v) : 0;
        settings.value.compression_threshold_pct = 0;
    }

    // Persistance IMMÉDIATE du seuil — même contrat que les toggles voisins.
    // Déclenchée au ``change`` (fin de geste), pas à chaque ``input`` : un drag
    // du curseur émettrait une quinzaine de PUT. Les DEUX clés partent
    // ensemble — c'est le couple qui porte le sens, en envoyer une seule
    // laisserait l'autre à sa valeur d'avant côté serveur.
    async function persistCompactionThreshold() {
        const pct = Number(settings.value.compression_threshold_pct) || 0;
        let tok = Number(settings.value.compression_threshold_tokens) || 0;
        // Champ tokens vidé en cours de frappe : rien à enregistrer encore.
        if (compactionUnit.value === 'tokens' && !tok) return;
        // Bornage au moment du geste (pas à la frappe : « 2 » doit pouvoir
        // devenir « 20000 »). Le serveur clampe de toute façon ; le faire AUSSI
        // ici évite que l'écran affiche 2 pendant que la base a 2048.
        if (tok) {
            tok = Math.max(2048, Math.min(4000000, tok));
            settings.value.compression_threshold_tokens = tok;
        }
        const body = { compression_threshold_pct: pct, compression_threshold_tokens: tok };
        try {
            const r = await fetchAuth('/api/settings', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r || !r.ok) { showToast('Seuil de compaction : enregistrement échoué.', 'error'); return; }
            try {
                const s = JSON.parse(_settingsSnapshot.value || '{}');
                s.compression_threshold_pct = pct;
                s.compression_threshold_tokens = tok;
                _settingsSnapshot.value = JSON.stringify(s);
            } catch (_) { /* snapshot best-effort */ }
            if (tok)      showToast('Compaction à partir de ' + compactionTokensLabel.value + ' de contexte.');
            else if (pct) showToast('Compaction à partir de ' + pct + ' % du contexte.');
            else          showToast('Compaction automatique : seuil auto.');
        } catch (e) {
            showToast('Seuil de compaction : erreur réseau.', 'error');
        }
    }

    // ── Compactions max par conversation ───────────────────────────────────
    // Une seule clé, trois états : 0 = auto (plafond d'instance), -1 =
    // illimité, n > 0 = plafond choisi. Le mode est DÉRIVÉ de la valeur, même
    // raison que pour l'unité du seuil : un mode stocké à part pourrait
    // contredire la valeur. L'épingle joue le même rôle que ``compactionUnitPin``
    // — vider le champ met la valeur à 0, ce qui ferait retomber le sélecteur
    // sur « Auto » en pleine frappe.
    const compactionRoundsPin = ref('');
    const COMPACTION_ROUNDS_DEFAUT = 24;
    const compactionRoundsMode = computed(() => {
        const n = Number(settings.value.compression_max_rounds) || 0;
        if (n < 0) return 'unlimited';
        if (n > 0) return 'custom';
        return compactionRoundsPin.value || 'auto';
    });

    // Une phrase par état, qui dit la CONSÉQUENCE — pas la mécanique.
    const compactionRoundsHint = computed(() => {
        if (compactionRoundsMode.value === 'unlimited')
            return 'Aucun plafond : la conversation continue d\'être résumée aussi longtemps qu\'elle tourne.';
        if (compactionRoundsMode.value === 'custom')
            return 'Plafond atteint, les tours les plus anciens sont retirés du contexte au lieu d\'être résumés.';
        return 'Plafond défini par l\'instance.';
    });

    function setCompactionRoundsMode(mode) {
        compactionRoundsPin.value = mode;
        if (mode === 'unlimited')   settings.value.compression_max_rounds = -1;
        else if (mode === 'custom') settings.value.compression_max_rounds = COMPACTION_ROUNDS_DEFAUT;
        else                        settings.value.compression_max_rounds = 0;
        persistCompactionMaxRounds();
    }

    function setCompactionRounds(raw) {
        // Champ vidé : 0 en mémoire, l'épingle garde « Nombre » à l'écran.
        const v = Math.round(Number(raw) || 0);
        settings.value.compression_max_rounds = v > 0 ? Math.min(200, v) : 0;
    }

    // Persistance IMMÉDIATE — même contrat que le seuil : au ``change`` (fin
    // de geste), et rien à enregistrer tant que le champ « Nombre » est vide.
    async function persistCompactionMaxRounds() {
        let n = Math.round(Number(settings.value.compression_max_rounds) || 0);
        if (compactionRoundsMode.value === 'custom' && n <= 0) return;
        if (n > 0) {
            n = Math.max(1, Math.min(200, n));
            settings.value.compression_max_rounds = n;
        }
        try {
            const r = await fetchAuth('/api/settings', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ compression_max_rounds: n }),
            });
            if (!r || !r.ok) { showToast('Compactions max : enregistrement échoué.', 'error'); return; }
            try {
                const snap = JSON.parse(_settingsSnapshot.value || '{}');
                snap.compression_max_rounds = n;
                _settingsSnapshot.value = JSON.stringify(snap);
            } catch (_) { /* snapshot best-effort */ }
            if (n < 0)      showToast('Compactions : sans limite.');
            else if (n > 0) showToast('Compactions : ' + n + ' au maximum par conversation.');
            else            showToast('Compactions : plafond de l\'instance.');
        } catch (e) {
            showToast('Compactions max : erreur réseau.', 'error');
        }
    }

    // Persistance IMMÉDIATE du toggle terminal en direct — même contrat.
    async function persistLiveShell() {
        const val = !!settings.value.live_shell_enabled;
        try {
            const r = await fetchAuth('/api/settings', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ live_shell_enabled: val }),
            });
            if (!r || !r.ok) { showToast('Terminal en direct : enregistrement échoué.', 'error'); return; }
            try {
                const s = JSON.parse(_settingsSnapshot.value || '{}');
                s.live_shell_enabled = val;
                _settingsSnapshot.value = JSON.stringify(s);
            } catch (_) { /* snapshot best-effort */ }
            showToast(val ? 'Terminal en direct activé.' : 'Terminal en direct désactivé.');
        } catch (e) {
            showToast('Terminal en direct : erreur réseau.', 'error');
        }
    }

    // ── Voix ────────────────────────────────────────────────────────────────
    // Bascules qui doivent tenir DÈS le clic : on vient de les cocher pour
    // s'en servir tout de suite, pas pour cliquer ensuite sur « Enregistrer ».
    // Même contrat que persistLiveShell, mise à jour de l'instantané comprise
    // — sans elle la modale resterait marquée « non enregistré » à vie.
    async function _persistVoix(cle, val, libelle) {
        const corps = {};
        corps[cle] = val;
        try {
            const r = await fetchAuth('/api/settings', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(corps),
            });
            if (!r || !r.ok) { showToast(libelle + ' : enregistrement échoué.', 'error'); return; }
            try {
                const s = JSON.parse(_settingsSnapshot.value || '{}');
                s[cle] = val;
                _settingsSnapshot.value = JSON.stringify(s);
            } catch (_) { /* instantané best-effort */ }
            showToast(val ? (libelle + ' activée.') : (libelle + ' désactivée.'));
        } catch (e) {
            showToast(libelle + ' : erreur réseau.', 'error');
        }
    }

    function persistVoiceInput() {
        return _persistVoix('voice_input_enabled', !!settings.value.voice_input_enabled, 'Dictée');
    }

    function persistVoiceReplyTools() {
        return _persistVoix('voice_reply_tools_enabled',
                            !!settings.value.voice_reply_tools_enabled,
                            'Lecture entre les outils');
    }

    function persistVoiceReply() {
        const val = !!settings.value.voice_reply_enabled;
        // Couper la lecture automatique doit faire taire ce qui est en train
        // d'être lu : garder la voix en vie après avoir décoché est
        // exactement le contraire de ce que le geste demande.
        if (!val && ctx.stopSpeaking) { try { ctx.stopSpeaking(); } catch (_) {} }
        return _persistVoix('voice_reply_enabled', val, 'Réponse vocale');
    }

    // Le micro exige une origine sécurisée. Quand elle manque, l'interface le
    // dit au lieu de laisser cliquer sur un bouton qui échouera.
    // ``isSecureContext`` d'abord : en HTTP sur le réseau local, Firefox
    // n'expose même pas ``navigator.mediaDevices``, Chromium l'expose parfois
    // sans jamais accorder le micro.
    // Le diagnostic complet vit dans voice/_compat.js (navigateur, version
    // minimale, HTTPS, AudioWorklet) ; ici on l'expose aux Paramètres.
    const _voiceCompat = (typeof window !== 'undefined' && typeof window.voiceCompat === 'function')
        ? window.voiceCompat() : null;
    const voiceMicSupported = computed(function () {
        if (_voiceCompat) return _voiceCompat.dictee.ok;
        return !!(typeof window !== 'undefined' && window.isSecureContext !== false
            && typeof navigator !== 'undefined' && navigator.mediaDevices
            && navigator.mediaDevices.getUserMedia);
    });
    const voiceReadSupported = computed(function () { return !_voiceCompat || _voiceCompat.lecture.ok; });
    const voiceCompatInfo = computed(function () {
        return _voiceCompat || { navigateur: { nom: '', version: 0 }, dictee: { ok: true, raison: '' },
                                 lecture: { ok: true, raison: '' }, avertissement: null };
    });

    // ── Agents custom (façon OpenCode /agent) ────────────────────────────────
    // CRUD sur ``settings.custom_agents`` — persiste immédiatement au
    // « Enregistrer » / « Ajouter » du formulaire via saveSettings(false)
    // (précédent : toggles MCP), pas de second commit global. La validation
    // serveur (source de vérité : llm_core validate_custom_agents) est miroitée
    // ici pour un feedback immédiat.
    const AGENT_NAME_RE = /^[a-z0-9]([a-z0-9_-]{0,30}[a-z0-9])?$/;
    // Seul « task » est réservé (miroir de task_tool.RESERVED_AGENT_NAMES).
    // Les noms INTÉGRÉS ne le sont plus : une entrée de ``custom_agents`` qui
    // porte l'un d'eux est une SURCHARGE du modèle livré — c'est la banque
    // d'agents (docs/agents-bank-design-2026-09-11.md).
    const RESERVED_AGENT_NAMES = window.ELPIS_RESERVED_AGENT_NAMES || ['task'];

    // ── Banque d'agents : les intégrés sont des MODÈLES ─────────────────────
    // ``agentTemplates`` = les intégrés tels que livrés (persona entière,
    // catégories, budget), servis par GET /api/settings/agent-templates. Repli
    // sur le roster de utils.js (noms + infobulles) si l'API ne répond pas :
    // la banque reste lisible, seule la persona manquera au pré-remplissage —
    // et un prompt vide enregistré vaut « persona livrée », donc sans dégât.
    const agentTemplates = ref([]);
    let _agentTemplatesLoaded = false;
    async function loadAgentTemplates(force) {
        if (_agentTemplatesLoaded && !force) return;
        try {
            const r = await fetchAuth('/api/settings/agent-templates');
            if (r && r.ok) {
                const d = await r.json();
                if (Array.isArray(d.templates) && d.templates.length) {
                    agentTemplates.value = d.templates;
                    _agentTemplatesLoaded = true;
                    return;
                }
            }
        } catch (_) { /* repli ci-dessous */ }
        if (!agentTemplates.value.length) {
            agentTemplates.value = (window.ELPIS_BUILTIN_AGENTS || []).map(a => ({
                name: a.name, summary: a.hint || '', prompt: '', tool_categories: [], max_iters: 0,
            }));
        }
    }
    const _AGENT_ICONS = {};
    (window.ELPIS_BUILTIN_AGENTS || []).forEach(a => { if (a && a.name) _AGENT_ICONS[a.name] = a.icon; });
    const _isTemplateName = (name) => agentTemplates.value.some(t => t.name === name);
    function _overrideOf(name) {
        const list = settings.value.custom_agents || [];
        const idx = list.findIndex(a => a && a.name === name);
        return { idx, entry: idx >= 0 ? list[idx] : null };
    }
    // Une surcharge n'est écrite QUE si elle porte un écart : le serveur la
    // retire sinon (validate_custom_agents), on fait pareil ici pour que la
    // carte ne dise pas « modifié » sur une entrée vide.
    function _overrideIsEmpty(e) {
        return !e || (!e.description && !e.prompt
            && !(e.tool_categories || []).length && !(e.mcp_server_ids || []).length
            && !(e.max_iters > 0) && e.enabled !== false);
    }
    // UNE liste : les modèles (surchargés en place), puis les personnalisés.
    // Chaque rangée porte ses valeurs EFFECTIVES (écart ou modèle) — c'est ce
    // que l'utilisateur lit, et ce que le formulaire pré-remplit.
    const agentBank = computed(() => {
        const list = settings.value.custom_agents || [];
        const rows = [];
        agentTemplates.value.forEach(t => {
            const { idx, entry } = _overrideOf(t.name);
            const o = entry || {};
            rows.push({
                name: t.name, template: true, icon: _AGENT_ICONS[t.name] || 'ph-robot',
                _idx: idx, modified: !!entry, enabled: o.enabled !== false,
                description: o.description || t.summary || '',
                prompt: o.prompt || t.prompt || '',
                tool_categories: (o.tool_categories || []).length ? o.tool_categories : (t.tool_categories || []),
                mcp_server_ids: o.mcp_server_ids || [],
                max_iters: o.max_iters || t.max_iters || 0,
                _tplPrompt: t.prompt || '', _tplCats: t.tool_categories || [],
                _tplIters: t.max_iters || 0, _tplSummary: t.summary || '',
                _ownDescription: o.description || '', _ownIters: o.max_iters || '',
            });
        });
        list.forEach((a, i) => {
            if (!a || !a.name || _isTemplateName(a.name)) return;
            rows.push({
                name: a.name, template: false, icon: 'ph-robot', _idx: i, modified: false,
                enabled: a.enabled !== false, description: a.description || 'custom agent',
                prompt: a.prompt || '', tool_categories: a.tool_categories || [],
                mcp_server_ids: a.mcp_server_ids || [], max_iters: a.max_iters || 0,
            });
        });
        return rows;
    });
    const agentCustomCount = computed(() =>
        (settings.value.custom_agents || []).filter(a => a && a.name && !_isTemplateName(a.name)).length);
    // Miroir de llm_core/tools/task_tool.py (source de vérité serveur).
    const CUSTOM_AGENTS_MAX = 30;
    const CUSTOM_ITERS_MAX = 200;
    const CUSTOM_PROMPT_MAX = 16000;
    // Miroir de llm_core.tools.task_tool.CUSTOM_DEFAULT_CATEGORIES : un agent
    // sans outils n'est pas un agent. Appliqué ICI aussi pour que la carte
    // affiche tout de suite ce que le serveur va enregistrer (saveSettings ne
    // relit pas la réponse) — sans ça l'UI dirait « sans outils » sur un agent
    // qui, en base, a bien son socle.
    const CUSTOM_DEFAULT_CATEGORIES = ['fs', 'shell', 'git'];
    const agentForm = ref(null);        // null | {_idx, name, description, prompt, tool_categories[]} (_idx:-1 = création)
    const agentFormError = ref('');

    function startCreateAgent(prefill) {
        if (agentCustomCount.value >= CUSTOM_AGENTS_MAX) {
            showToast(`Maximum ${CUSTOM_AGENTS_MAX} agents personnalisés.`, 'warning');
            return;
        }
        agentFormError.value = '';
        // max_iters vide = suit le défaut serveur (et ses relèvements futurs).
        agentForm.value = Object.assign(
            { _idx: -1, _template: false, name: '', description: '', prompt: '',
              tool_categories: [], mcp_server_ids: [], max_iters: '', enabled: true },
            prefill || {});
    }
    // ``row`` = une rangée de ``agentBank``. Un MODÈLE s'ouvre pré-rempli de sa
    // persona livrée, de ses catégories et de son budget : on part du texte
    // livré et on le retouche — le nom, lui, ne se saisit pas (c'est l'identité
    // que le modèle appelle ; une variante se fait par « Dupliquer »).
    function startEditAgent(row) {
        if (!row) return;
        agentFormError.value = '';
        agentForm.value = {
            _idx: row._idx, _template: !!row.template, name: row.name || '',
            description: row.template ? (row._ownDescription || '') : (row.description || ''),
            prompt: row.prompt || '',
            tool_categories: [...(row.tool_categories || [])],
            mcp_server_ids: [...(row.mcp_server_ids || [])],
            max_iters: row.template ? (row._ownIters || '')
                                    : ((row.max_iters > 0) ? row.max_iters : ''),
            enabled: row.enabled !== false,
            _tplPrompt: row._tplPrompt || '', _tplCats: row._tplCats || [],
            _tplIters: row._tplIters || 0, _tplSummary: row._tplSummary || '',
        };
    }
    function cancelAgentForm() { agentForm.value = null; agentFormError.value = ''; }
    // « Prompt livré » : rend la persona du modèle, tant que le champ en diffère.
    function restoreTemplatePrompt() {
        if (agentForm.value && agentForm.value._template) agentForm.value.prompt = agentForm.value._tplPrompt;
    }
    const agentFormPromptDiffers = computed(() => {
        const f = agentForm.value;
        return !!(f && f._template && (f.prompt || '').trim() !== (f._tplPrompt || '').trim());
    });
    // Dupliquer : un NOUVEL agent personnalisé, pré-rempli des valeurs
    // effectives de la rangée — c'est ainsi qu'on fait une variante d'un modèle
    // sans toucher au modèle.
    function duplicateAgent(row) {
        if (!row) return;
        const taken = new Set((settings.value.custom_agents || []).map(a => a && a.name)
            .concat(agentTemplates.value.map(t => t.name)));
        let name = row.name + '-2', n = 2;
        while (taken.has(name)) { n += 1; name = row.name + '-' + n; }
        startCreateAgent({
            name, description: row.description || '', prompt: row.prompt || '',
            tool_categories: [...(row.tool_categories || [])],
            mcp_server_ids: [...(row.mcp_server_ids || [])],
            max_iters: row.max_iters > 0 ? row.max_iters : '',
        });
    }
    // Interrupteur Actif : un intégré désactivé disparaît du roster du tool
    // ``task`` (enum + description) — le modèle ne peut plus le demander.
    async function toggleAgentEnabled(row) {
        if (!row) return;
        const list = settings.value.custom_agents || (settings.value.custom_agents = []);
        const _before = _cloneVal(list);
        if (row._idx >= 0 && list[row._idx]) {
            const e = list[row._idx];
            if (row.enabled) e.enabled = false; else delete e.enabled;
            if (row.template && _overrideIsEmpty(e)) list.splice(row._idx, 1);
        } else if (row.template) {
            list.push({ name: row.name, enabled: false });
        } else {
            return;
        }
        await _persistKeys(['custom_agents'], { rollback: () => { settings.value.custom_agents = _before; } });
    }
    // Réinitialiser : effacer la surcharge, rien d'autre — le modèle livré
    // n'a jamais bougé.
    async function resetAgentToTemplate(row) {
        if (!row || !row.template || row._idx < 0) return;
        const ok = await openConfirm('Réinitialiser cet agent ?',
            `« ${row.name} » reprendra le modèle livré : prompt, outils et budget.`,
            false, 'Réinitialiser');
        if (!ok) return;
        const list = settings.value.custom_agents || [];
        const _before = _cloneVal(list);
        list.splice(row._idx, 1);
        if (agentForm.value && agentForm.value.name === row.name) cancelAgentForm();
        await _persistKeys(['custom_agents'], { rollback: () => { settings.value.custom_agents = _before; } });
    }
    // Gabarit de persona — MÊME structure que les agents intégrés (rôle,
    // objectif, guidage outil, méthode, calibrage d'effort, contraintes,
    // rapport, exemples). En ANGLAIS, comme tous les prompts model-facing du
    // repo. Deux points portent l'essentiel de la fiabilité :
    //   * on ouvre sur le MÉTIER, jamais sur « tu es un sous-agent » — le statut
    //     de plomberie occupe la place la plus lue du prompt sans rien apporter ;
    //   * les EXEMPLES travaillés (cas normal, cas tordu, cas où il faut savoir
    //     s'arrêter) font plus pour le format de sortie qu'une liste de consignes.
    // Cf. docs/agents-specialises-design-2026-08-04.md.
    const AGENT_PROMPT_TEMPLATE = [
        "# Role",
        "",
        "You are a <profession> specialised in <domain>. <One sentence on what you are",
        "good at and why people trust your work.>",
        "",
        "# Objective",
        "",
        "You are given <one unit of work>. <What done looks like.>",
        "",
        "Your report travels alone. Whoever asked sees none of your tool calls and none of",
        "your reasoning — only what you write at the end.",
        "",
        "# Your tools",
        "",
        "- `<tool>` — <what it is for, and when to reach for it rather than another one>",
        "- `<tool>` — <same>",
        "",
        "# Method",
        "",
        "1. Restate the mission in one line: what must be obtained, and what the report must",
        "   contain to be useful.",
        "2. <Establish the real state before acting on it.>",
        "3. <The main work.>",
        "4. <Verify your own work.>",
        "5. Stop as soon as the mission is answered.",
        "",
        "# Effort",
        "",
        "Apply this rule, do not deliberate over it.",
        "- <simple case>: <n> to <m> calls.",
        "- <normal case>: <n> to <m> calls.",
        "- <hard case>: <n> to <m> calls.",
        "",
        "# Constraints",
        "",
        "- <What this agent NEVER does, in the negative, without exception.>",
        "- An error result is never a success: never continue as though a failed call had",
        "  worked.",
        "- If the mission needs a tool you do not have, stop and say so in the report. Never",
        "  improvise a workaround.",
        "- Every path exactly as the tools take it — relative to your sandbox root.",
        "- No emojis. Write the report in the language of the mission you were given.",
        "",
        "# Report",
        "",
        "End with exactly these headings.",
        "",
        "## Result",
        "<the direct answer to the mission, in a few lines>",
        "",
        "## Detail",
        "<what the caller needs: paths, values, quotes, links, commands and their output>",
        "",
        "## Left open",
        "<what you deliberately did not do, and what must be reviewed. \"nothing\" otherwise>",
        "",
        "# Examples",
        "",
        "<example>",
        "Mission: <a normal case>",
        "",
        "<the two or three calls you would make, and what they return>",
        "",
        "## Result",
        "<...>",
        "",
        "## Detail",
        "<...>",
        "",
        "## Left open",
        "nothing",
        "</example>",
        "",
        "<example>",
        "Mission: <an awkward case — something unexpected in the way>",
        "",
        "<how you handle it without widening the mission>",
        "",
        "## Result",
        "<...>",
        "",
        "## Detail",
        "<...>",
        "",
        "## Left open",
        "<what you flagged instead of fixing>",
        "</example>",
    ].join("\n");
    function insertAgentTemplate() {
        if (!agentForm.value || (agentForm.value.prompt || '').trim()) return;
        agentForm.value.prompt = AGENT_PROMPT_TEMPLATE;
    }
    function toggleAgentCat(name) {
        if (!agentForm.value) return;
        const cats = agentForm.value.tool_categories;
        const i = cats.indexOf(name);
        if (i >= 0) cats.splice(i, 1); else cats.push(name);
    }
    function toggleAgentMcp(id) {
        if (!agentForm.value) return;
        const ids = agentForm.value.mcp_server_ids;
        const i = ids.indexOf(id);
        if (i >= 0) ids.splice(i, 1); else ids.push(id);
    }
    async function saveAgentForm() {
        const f = agentForm.value;
        if (!f) return;
        const name = (f.name || '').trim().toLowerCase();
        const prompt = (f.prompt || '').trim();
        const description = (f.description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!AGENT_NAME_RE.test(name)) { agentFormError.value = 'Nom invalide : 1-32 caractères a-z 0-9 - _, commence et finit par un alphanumérique.'; return; }
        if (RESERVED_AGENT_NAMES.includes(name)) { agentFormError.value = `« ${name} » est un nom réservé.`; return; }
        if (!f._template && _isTemplateName(name)) { agentFormError.value = `« ${name} » est un modèle livré : modifiez-le dans la banque, ou dupliquez-le.`; return; }
        if (!prompt && !f._template) { agentFormError.value = 'Le prompt système est requis.'; return; }
        if (prompt.length > CUSTOM_PROMPT_MAX) { agentFormError.value = `Prompt trop long (max ${CUSTOM_PROMPT_MAX} caractères).`; return; }
        const list = settings.value.custom_agents || (settings.value.custom_agents = []);
        const dup = list.findIndex((a, i) => a && a.name === name && i !== f._idx);
        if (dup >= 0) { agentFormError.value = `Un agent « ${name} » existe déjà.`; return; }
        const cats = [...new Set(f.tool_categories)];
        const mcpIds = [...new Set(f.mcp_server_ids)];
        if (f._template) {
            // Surcharge d'un modèle : SEULS les écarts sont écrits. Prompt
            // identique au livré → vide (l'agent suit alors les mises à jour du
            // fichier) ; mêmes catégories → vides ; même budget → absent. Une
            // surcharge sans écart n'est pas écrite du tout.
            const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
            const over = { name, description,
                           prompt: prompt === (f._tplPrompt || '').trim() ? '' : prompt,
                           tool_categories: sameSet(cats, f._tplCats || []) ? [] : cats,
                           mcp_server_ids: mcpIds };
            const iters = parseInt(f.max_iters, 10);
            if (Number.isFinite(iters) && iters > 0 && iters !== f._tplIters) over.max_iters = Math.min(iters, CUSTOM_ITERS_MAX);
            if (f.enabled === false) over.enabled = false;
            const _before = _cloneVal(list);
            if (_overrideIsEmpty(over)) { if (f._idx >= 0) list.splice(f._idx, 1); }
            else if (f._idx >= 0) list.splice(f._idx, 1, over);
            else list.push(over);
            if (!await _persistKeys(['custom_agents'], { rollback: () => { settings.value.custom_agents = _before; } })) return;
            agentForm.value = null; agentFormError.value = '';
            return;
        }
        const entry = { name, description, prompt,
                        // Rien de coché : socle de travail par défaut, comme le
                        // serveur. Écrit dans l'agent (visible sur sa carte,
                        // modifiable) plutôt qu'appliqué en douce au lancement.
                        tool_categories: (!cats.length && !mcpIds.length)
                            ? [...CUSTOM_DEFAULT_CATEGORIES] : cats,
                        mcp_server_ids: mcpIds };
        // Budget d'itérations propre à l'agent : n'écrire la clé QUE si elle est
        // renseignée, sinon l'agent suit le défaut serveur.
        const iters = parseInt(f.max_iters, 10);
        if (Number.isFinite(iters) && iters > 0) entry.max_iters = Math.min(iters, CUSTOM_ITERS_MAX);
        if (f.enabled === false) entry.enabled = false;
        const _before = _cloneVal(list);
        if (f._idx >= 0) list.splice(f._idx, 1, entry); else list.push(entry);
        // (passe 8, F10/F11) — clé ciblée + rollback ; le formulaire reste
        // ouvert en cas d'échec.
        if (!await _persistKeys(['custom_agents'], { rollback: () => { settings.value.custom_agents = _before; } })) return;
        agentForm.value = null; agentFormError.value = '';
    }
    async function deleteCustomAgent(row) {
        const idx = row && typeof row === 'object' ? row._idx : row;
        const a = (settings.value.custom_agents || [])[idx];
        if (!a || (row && row.template)) return;      // un modèle se réinitialise, ne se supprime pas
        const ok = await openConfirm('Supprimer cet agent ?', a.name || '', true, 'Supprimer');
        if (!ok) return;
        const _before = _cloneVal(settings.value.custom_agents || []);
        (settings.value.custom_agents || []).splice(idx, 1);
        if (agentForm.value && agentForm.value._idx === idx) cancelAgentForm();
        else if (agentForm.value && agentForm.value._idx > idx) agentForm.value._idx -= 1;
        await _persistKeys(['custom_agents'], { rollback: () => { settings.value.custom_agents = _before; } });
    }

    function newGitConnector() {
        gitConnForm.value = { provider_type: 'github', repo_url: '', host: '', api_base: '', label: '', username: '', token: '' };
        gitConnAdvanced.value = false;
    }
    function editGitConnector(c) {
        gitConnForm.value = { id: c.id, provider_type: c.provider_type, repo_url: '', host: c.host, api_base: c.api_base || '', label: c.label || '', username: c.username || '', token: '' };
        gitConnAdvanced.value = false;
    }
    function cancelGitConnector() { gitConnForm.value = null; }
    // Aide-saisie : depuis l'URL du dépôt collée, pré-remplit host/api_base/type.
    async function parseGitRepoUrl() {
        const f = gitConnForm.value; if (!f) return;
        const url = (f.repo_url || '').trim(); if (!url) return;
        try {
            const r = await fetchAuth('/api/git/connectors/parse', { method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, provider_type: f.provider_type }) });
            if (!r || !r.ok) return;
            const d = await r.json(); if (!d.ok) return;
            // type détecté fiable (github/gitlab/bitbucket) → on l'applique ; pour
            // gitea/self-hosted indétectable, on garde le choix de l'utilisateur.
            if (d.detected_provider_type && d.detected_provider_type !== 'generic') {
                f.provider_type = d.detected_provider_type;
            }
            if (d.host) f.host = d.host;
            if (d.api_base) f.api_base = d.api_base;
        } catch (e) { /* best-effort */ }
    }
    async function saveGitConnector() {
        const f = gitConnForm.value; if (!f) return;
        // host = host extrait, sinon l'URL du dépôt brute (le serveur en extrait
        // le host[:port] via normalize_host → tolérant au copier-coller).
        const host = (f.host || '').trim() || (f.repo_url || '').trim();
        if (!host) { showToast('URL du dépôt (ou host) requise', 'error'); return; }
        if (!f.id && !(f.token || '').trim()) { showToast('Token / mot de passe requis', 'error'); return; }
        gitConnBusy.value = true;
        try {
            const isEdit = !!f.id;
            const url = isEdit ? ('/api/git/connectors/' + f.id) : '/api/git/connectors';
            const body = { provider_type: f.provider_type, host: host,
                           api_base: (f.api_base || '').trim(), label: (f.label || '').trim(),
                           username: (f.username || '').trim() };
            if ((f.token || '').trim()) body.token = f.token.trim();
            const r = await fetchAuth(url, { method: isEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (r && r.ok) {
                gitConnForm.value = null;
                await loadGitConnectors();
                showToast(isEdit ? 'Connecteur mis à jour' : 'Connecteur ajouté', 'success');
            } else {
                const e = r ? await r.json().catch(() => ({})) : {};
                showToast(e.detail || 'Échec de l\'enregistrement', 'error');
            }
        } finally { gitConnBusy.value = false; }
    }
    async function deleteGitConnector(c) {
        const ok = await openConfirm('Supprimer le connecteur ?',
            (c.provider_type + ' · ' + c.host + (c.label ? ' · ' + c.label : '')), true);
        if (!ok) return;
        const r = await fetchAuth('/api/git/connectors/' + c.id, { method: 'DELETE' });
        if (r && r.ok) { await loadGitConnectors(); showToast('Connecteur supprimé', 'success'); }
    }
    async function testGitConnector(c) {
        gitConnTest.value = Object.assign({}, gitConnTest.value, { [c.id]: { testing: true } });
        try {
            const r = await fetchAuth('/api/git/connectors/' + c.id + '/test', { method: 'POST' });
            const d = r ? await r.json().catch(() => ({ ok: false, error: 'parse' }))
                        : { ok: false, error: 'network' };
            gitConnTest.value = Object.assign({}, gitConnTest.value, { [c.id]: d });
        } catch (e) {
            gitConnTest.value = Object.assign({}, gitConnTest.value, { [c.id]: { ok: false, error: String(e) } });
        }
    }

    // ── Connecteurs LLM (fournisseurs cloud perso) ────────────────────────────
    // L'utilisateur ajoute SES connecteurs cloud (Anthropic, OpenAI…) avec SA clé
    // API. La base_url est imposée par le preset officiel (jamais saisie).
    const llmConnectors  = ref([]);   // perso
    const llmConnShared  = ref([]);   // partagés (admin, lecture seule)
    const llmConnPresets = ref({});   // provider_type → {wire, base_url, label, …}
    const llmConnAllowed = ref([]);   // provider_types autorisés pour les users
    const llmConnForm    = ref(null);
    const llmConnBusy    = ref(false);
    const llmConnTest    = ref({});

    async function loadLlmConnectors() {
        try {
            const r = await fetchAuth('/api/llm/connectors', {}, true);
            if (r && r.ok) {
                const d = await r.json();
                llmConnectors.value  = d.connectors || [];
                llmConnShared.value  = d.shared || [];
                llmConnPresets.value = d.presets || {};
                llmConnAllowed.value = d.allowed_provider_types || [];
            }
        } catch (e) { /* best-effort */ }
    }
    function llmPresetLabel(pt) {
        const p = llmConnPresets.value[pt];
        return (p && p.label) || pt;
    }
    function newLlmConnector() {
        const first = llmConnAllowed.value[0] || 'anthropic';
        llmConnForm.value = { provider_type: first, api_key: '', label: '', default_model: '' };
    }
    function editLlmConnector(c) {
        llmConnForm.value = { id: c.id, provider_type: c.provider_type, api_key: '',
                              label: c.label || '', default_model: c.default_model || '' };
    }
    function cancelLlmConnector() { llmConnForm.value = null; }
    async function saveLlmConnector() {
        const f = llmConnForm.value; if (!f) return;
        if (!f.id && !(f.api_key || '').trim()) { showToast('Clé API requise', 'error'); return; }
        llmConnBusy.value = true;
        try {
            const isEdit = !!f.id;
            const url = isEdit ? ('/api/llm/connectors/' + f.id) : '/api/llm/connectors';
            const body = { label: (f.label || '').trim(), default_model: (f.default_model || '').trim() };
            if (!isEdit) body.provider_type = f.provider_type;
            if ((f.api_key || '').trim()) body.api_key = f.api_key.trim();
            const r = await fetchAuth(url, { method: isEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (r && r.ok) {
                llmConnForm.value = null;
                await loadLlmConnectors();
                showToast(isEdit ? 'Connecteur mis à jour' : 'Connecteur ajouté', 'success');
            } else {
                const e = r ? await r.json().catch(() => ({})) : {};
                showToast(e.detail || 'Échec de l\'enregistrement', 'error');
            }
        } finally { llmConnBusy.value = false; }
    }
    async function deleteLlmConnector(c) {
        const ok = await openConfirm('Supprimer le connecteur ?',
            (llmPresetLabel(c.provider_type) + (c.label ? ' · ' + c.label : '')), true);
        if (!ok) return;
        const r = await fetchAuth('/api/llm/connectors/' + c.id, { method: 'DELETE' });
        if (r && r.ok) { await loadLlmConnectors(); showToast('Connecteur supprimé', 'success'); }
    }
    async function testLlmConnector(c) {
        llmConnTest.value = Object.assign({}, llmConnTest.value, { [c.id]: { testing: true } });
        try {
            const r = await fetchAuth('/api/llm/connectors/' + c.id + '/test', { method: 'POST' });
            const d = r ? await r.json().catch(() => ({ ok: false, error: 'parse' }))
                        : { ok: false, error: 'network' };
            llmConnTest.value = Object.assign({}, llmConnTest.value, { [c.id]: d });
        } catch (e) {
            llmConnTest.value = Object.assign({}, llmConnTest.value, { [c.id]: { ok: false, error: String(e) } });
        }
    }

    return {
        llmConnectors, llmConnShared, llmConnPresets, llmConnAllowed,
        llmConnForm, llmConnBusy, llmConnTest, llmPresetLabel,
        loadLlmConnectors, newLlmConnector, editLlmConnector, cancelLlmConnector,
        saveLlmConnector, deleteLlmConnector, testLlmConnector,
        ..._cnxMod,
        gitConnectors, gitConnTypes, gitConnForm, gitConnBusy, gitConnTest, gitConnAdvanced,
        loadGitConnectors, newGitConnector, editGitConnector, cancelGitConnector,
        saveGitConnector, deleteGitConnector, testGitConnector, parseGitRepoUrl,
        userMemory, userMemoryLoading, userMemoryError, loadUserMemory, persistMemoryEnabled,
        memoryEditing, memorySaving, memorySaveError, memoryDraft, memoryOverLimit, memoryDirty,
        startMemoryEdit, cancelMemoryEdit, saveMemoryEdit,
        addMemoryEntry, removeMemoryEntry, memoryDraftChars, memoryLimit, memoryOver,
        persistAgentsEnabled, persistLiveShell, persistCompressionEnabled,
        persistVoiceInput, persistVoiceReply, persistVoiceReplyTools, voiceMicSupported,
        voiceReadSupported, voiceCompatInfo,
        opencodeFamilyOn, toggleOpencodeFamily,
        compactionUnit, compactionPct, compactionTokensLabel, compactionThresholdHint,
        setCompactionUnit, setCompactionPct, setCompactionTokens,
        persistCompactionThreshold,
        compactionRoundsMode, compactionRoundsHint,
        setCompactionRoundsMode, setCompactionRounds, persistCompactionMaxRounds,
        agentForm, agentFormError, startCreateAgent, startEditAgent,
        cancelAgentForm, toggleAgentCat, toggleAgentMcp, saveAgentForm, deleteCustomAgent,
        CUSTOM_ITERS_MAX, CUSTOM_AGENTS_MAX,
        // banque d'agents (modèles surchargeables)
        agentTemplates, loadAgentTemplates, agentBank, agentCustomCount,
        restoreTemplatePrompt, agentFormPromptDiffers, duplicateAgent,
        toggleAgentEnabled, resetAgentToTemplate,
        insertAgentTemplate,
        userMemoryDeleting, deleteUserMemory,
        showSettingsModal, showMcpManagerModal, settingsTab, newMcp, savedPromptsList, archivesList, customMcpList, mcpFileInput,
        mcpSearch, filteredMcpServers,
        promptSearch, promptSort, promptOpen, promptsAffiches,
        togglePrompt, promptDate, promptDateFull, promptExtrait, copyPrompt,
        archiveSelectMode, archiveSelected,
        usageData, usageLoading, usageError, usageDays, loadUsageData, setUsageDays,
        usageSourceLabel, usageThinkingPct,
        unarchiveSelectedArchives,
        showPasswordChange, passwordForm,
        APP_SKINS, skinsDefaut, loadAppSkins, skinCourant, nomMarque,
        appDark, themeMode, applyThemeMode, setThemeMode, toggleThemeMode, setAppSkin,
        showSharedPrompts, sharedPromptsList, inboxCount,
        sharedSelectMode, sharedSelected,
        isShareModalOpen, promptToShare, shareSending,
        allUsersLite, myGroups, selectedGroupFilter, filteredShareUsers, groupedShareUsers, shareTargetUsers, selectAllUsers, showHelpModal, readmeContent, isLoadingReadme, helpDoc, helpBodyRef, switchHelpDoc,
        pinnedServers, agentMcpChoices,
        // Bibliothèque MCP partagée (admin → tous) + visibilité par compte.
        sharedMcpServers, sharedMcpForm, sharedMcpError, sharedMcpSaving,
        loadSharedMcpServers, isSharedVisible, toggleSharedVisibility,
        newSharedMcp, editSharedMcp, cancelSharedMcp,
        applyMcpPreset, mcpAddPair, mcpRemovePair, mcpHasCreds,
        saveSharedMcp, deleteSharedMcp,
        loadSettingsData, openSettings, openSettingsTab, closeSettings, saveSettings, changeMyPassword,
        memoryOrigin, openMemoryOrigin,
        settingsSaving, settingsDirty, passwordSaving, settingsDialogEl,
        addMcpServer, editMcpServer, cancelMcpEdit, closeMcpManager, removeMcpServer, toggleServerVisibility, activateExternalServer,
        mcpTest, testMcpServer,
        loadCustomMcpServers, triggerMcpUpload, handleMcpUpload, deleteCustomServer, useCustomServer,
        uploadAvatar, removeAvatar, uploadAssistantAvatar, removeAssistantAvatar,
        loadSavedPrompts, saveThisPrompt, deleteSavedPrompt, usePrompt,
        // Templates de prompt (Paramètres → Prompts → Templates)
        promptsView, templatesList, templateSearch, templateOpen, templateForm,
        templateSaving, templateFormError, templateDirty, templateSyntaxHelp,
        templatesAffiches, templateFormVars, templateVarsOf, toggleTemplate,
        loadPromptTemplates, startNewTemplate, editTemplate, templateFromPrompt,
        templateTitleBlur, cancelTemplateEdit, saveTemplate, deleteTemplate, insertTemplate,
        loadSharedPrompts, useSharedPrompt, deleteSharedPrompt, clearAllSharedPrompts, refreshInboxCount,
        openShareModal, toggleSelectAllUsers, confirmShare,
        loadArchives, restoreArchive, deleteArchive, openHelp, clearSandbox,
        clearAllChats, toggleArchiveSelect, deleteSelectedArchives,
        toggleSharedSelect, deleteSelectedSharedPrompts,
        startInboxPolling, stopInboxPolling,
        // Sandbox mode
        sandboxState, sandboxBusy, sandboxStatus, sandboxTone, transitionState, activeNetProfile,
        netMenuOpen, toggleNetMenu, pickNetProfile, onNetMenuKeydown, closeNetMenu,
        netProfileMode, netProfileDetail,
        onChangeProfile,
        loadSandboxState, changeSandboxMode,
        restartSandboxContainer, destroySandboxContainer,
    };
}
