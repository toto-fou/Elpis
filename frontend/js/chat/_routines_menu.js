// SPDX-License-Identifier: MIT
/*
 * chat/_routines_menu.js — ROUTINES management page (tâches récurrentes).
 *
 * Backs the "Routines" sidebar entry (placed under "Éditeur"). Selecting it
 * flips the shared currentView to 'routines', and includes/main/routines_page.html
 * renders a FULL PAGE over the chat column (same pattern as the Skills page).
 *
 * A routine = a recurring automated task: on a cron schedule, the chatbot's
 * agentic tool-loop runs a configured task (model + system prompt + task prompt)
 * with a user-selected set of MCP servers (local categories + external servers).
 * Execution is headless and journaled (runs table) — no chat is created.
 *
 * Architecture fit : standard module factory like setupSkillsMenu. Loaded as a
 * plain <script> before app.js ; app.js calls setupRoutinesMenu(Vue, sharedRefs,
 * ctx) and spreads the returned {refs, methods} into the root setup() return so
 * the bindings are usable in routines_page.html.
 *
 * The page template runs in the ROOT scope, so it reads the spread refs
 * ``availableModels`` (chat module), ``pinnedServers`` (settings — serveurs
 *   perso visibles + bibliothèque MCP partagée affichée) and
 * ``mcpUserCategories`` (chat module) directly for the model/MCP pickers ; toggle
 * handlers below receive the full objects from the template, so this module does
 * not need those refs itself.
 *
 * Endpoints (all via ctx.fetchAuth, session-cookie auth) :
 *   GET    /api/routines                 list mine
 *   POST   /api/routines                 create  {name,cron_expr,model,system_prompt,task_prompt,mcp_servers,skills,thinking_mode,enabled,
 *                                                 runs_keep,notify_on,notify_keep}   (historique : 0 = tout conserver)
 *   PUT    /api/routines/{id}            update (same fields)
 *   GET    /api/skills                   merged list (picker « skills attachés » ; learned exclu côté client)
 *   POST   /api/routines/{id}/{enable,disable}
 *   DELETE /api/routines/{id}
 *   POST   /api/routines/{id}/run-now    launch immediately
 *   GET    /api/routines/{id}/runs       journal
 */
function setupRoutinesMenu(vue, sharedRefs, ctx) {
    const { ref, computed } = vue;
    const { currentView } = sharedRefs;
    const { showToast, fetchAuth, openConfirm } = ctx;

    const routinesLoading = ref(false);
    const routinesBusy    = ref(false);
    const routinesError   = ref('');
    const routines        = ref([]);

    // Skills attachables (picker du formulaire + libellés des puces en vue
    // lecture). Vue FUSIONNÉE user+global (learned = SAS admin, jamais injecté
    // au run → exclu du picker). Chargée à l'ouverture de la page.
    const routineSkills         = ref([]);
    const routineSkillsLoading  = ref(false);
    // true après un chargement réussi : tant que c'est false on ne juge pas un
    // id « introuvable » (pas de faux ⚠ pendant le fetch / sur erreur réseau).
    const routineSkillsLoadedOk = ref(false);
    // Miroir du cap backend (_SKILLS_MAX dans routes/routines.py).
    const ROUTINE_SKILLS_MAX = 12;
    // Historique par routine — miroirs de KEEP_MAX / NOTIFY_ON_VALUES
    // (routines_store.py). 0 = tout conserver (comportement d'avant).
    const ROUTINE_KEEP_MAX = 500;
    const ROUTINE_NOTIFY_MODES = [
        { id: 'all',   label: 'Toutes' },
        { id: 'error', label: 'Échecs seulement' },
        { id: 'none',  label: 'Aucune' },
    ];
    function notifyOnLabel(v) {
        const m = ROUTINE_NOTIFY_MODES.find(x => x.id === v);
        return m ? m.label : 'Toutes';
    }
    // « 50 dernières » / « Toutes » — même libellé pour le journal et les notifs.
    function keepLabel(n) {
        const k = parseInt(n, 10);
        return (k > 0) ? `${k} dernières` : 'Toutes';
    }

    // Casting intégré affiché dans l'onglet Agents. SOURCE UNIQUE :
    // ``window.ELPIS_BUILTIN_AGENTS`` (utils.js), miroir vérifié de
    // ``llm_core.tools.task_tool._AGENTS``. Les agents PERSONNALISÉS ne sont
    // pas listés ici : ils viennent de ``settings.custom_agents``, que la
    // routine voit tels quels au run.
    const ROUTINE_BUILTIN_AGENTS = window.ELPIS_BUILTIN_AGENTS || [];

    // '' (placeholder) | 'create' | 'edit'
    const routineEditMode   = ref('');
    const selectedRoutineId = ref(null);
    const routineForm       = ref(_emptyRoutineForm());
    // Édition plein écran par GROUPES : la liste de gauche est masquée et le
    // header porte le menu des sections — un seul groupe affiché à la fois
    // (v-show : l'état des champs survit au changement d'onglet).
    const routineEditTab  = ref('general');
    const routineEditTabs = [
        { id: 'general',  label: 'Nom',           icon: 'ph-textbox' },
        // Planification cron ET webhook vivent dans le même onglet : le
        // libellé doit annoncer les deux (« la config webhook est introuvable »
        // quand l'onglet s'appelait Planification).
        { id: 'schedule', label: 'Déclencheurs', icon: 'ph-clock' },
        { id: 'prompt',   label: 'Prompt',        icon: 'ph-chat-text' },
        { id: 'mcp',      label: 'MCP',           icon: 'ph-plugs-connected' },
        { id: 'skills',   label: 'Skills',        icon: 'ph-graduation-cap' },
        // Onglet DÉDIÉ (2026-08-07) : déléguer à des sous-agents pendant un run
        // headless se décide en connaissance de cause — pas au détour d'une
        // case perdue dans « Nom », et jamais hérité du réglage de chat.
        { id: 'agents',   label: 'Agents',        icon: 'ph-user-gear' },
    ];
    const routineIsEditing = computed(() =>
        routineEditMode.value === 'create' || routineEditMode.value === 'edit');

    // Constructeur de planification VISUEL (au lieu d'un cron brut). On produit
    // l'expression cron à partir de cet état (et on la re-parse au chargement).
    const schedule = ref(_defaultSchedule());
    const viewed   = ref(null);   // routine affichée en mode 'view' (lecture seule)

    const routineRuns       = ref([]);
    const routineRunsLoading = ref(false);
    // Run dont la réponse finale / l'erreur est dépliée (lecture intégrale).
    const expandedRunId     = ref(null);
    // Rafraîchissement VIVANT : tant qu'un run est « running », on re-sonde le
    // journal (et la liste, pour le statut au survol). Les timers s'auto-arrêtent
    // dès qu'il n'y a plus rien en cours, et sont purgés en quittant la page.
    let _runsPollTimer = null;
    let _listPollTimer = null;
    function _clearPolls() {
        if (_runsPollTimer) { clearTimeout(_runsPollTimer); _runsPollTimer = null; }
        if (_listPollTimer) { clearTimeout(_listPollTimer); _listPollTimer = null; }
    }

    // Perf (vague 4) : en onglet caché, on coupe les chaînes de polling
    // (elles ne se ré-arment pas tant que document.hidden, cf. loadRoutines/
    // loadRuns). Au retour au premier plan, on relance un cycle si le panneau
    // concerné est toujours ouvert — le ré-armement reprend alors tout seul
    // selon l'état « running » réel.
    function _onRoutinesVisibility() {
        if (document.hidden) { _clearPolls(); return; }
        if (currentView.value === 'routines') {
            loadRoutines();
            if (selectedRoutineId.value &&
                (routineEditMode.value === 'edit' || routineEditMode.value === 'view')) {
                loadRuns(selectedRoutineId.value);
            }
        }
    }
    document.addEventListener('visibilitychange', _onRoutinesVisibility);

    // Puces des jours de la semaine. ⚠ Le matcher backend (_cron_matches) utilise
    // now.weekday()+1 → Lundi=1 … Dimanche=7 ; on reste cohérent avec ça.
    const weekdayChips = [
        { n: 1, l: 'Lun' }, { n: 2, l: 'Mar' }, { n: 3, l: 'Mer' }, { n: 4, l: 'Jeu' },
        { n: 5, l: 'Ven' }, { n: 6, l: 'Sam' }, { n: 7, l: 'Dim' },
    ];
    const _dayNames = { 1: 'lundi', 2: 'mardi', 3: 'mercredi', 4: 'jeudi',
                        5: 'vendredi', 6: 'samedi', 7: 'dimanche' };

    function _defaultSchedule() {
        return {
            freq: 'daily',          // none | minutes | hourly | daily | weekly | monthly | custom
            everyMinutes: 30,       // freq=minutes
            atMinute: 0,            // freq=hourly
            time: '09:00',          // freq=daily|weekly|monthly (HH:MM)
            weekdays: [1],          // freq=weekly (1=Lun … 7=Dim)
            dayOfMonth: 1,          // freq=monthly
            custom: '0 9 * * *',    // freq=custom (cron brut)
        };
    }

    function _parseTime(t) {
        const p = String(t || '09:00').split(':');
        let h = parseInt(p[0], 10), m = parseInt(p[1], 10);
        if (isNaN(h) || h < 0 || h > 23) h = 9;
        if (isNaN(m) || m < 0 || m > 59) m = 0;
        return [h, m];
    }
    const _pad = n => String(n).padStart(2, '0');

    // état planif → expression cron 5 champs
    function _cronFromSchedule(s) {
        const [h, m] = _parseTime(s.time);
        switch (s.freq) {
            // cron vide = « aucune planification » (déclenchement manuel ou
            // webhook uniquement) — le backend l'accepte et le scheduler ne
            // matche jamais une expression vide.
            case 'none': return '';
            case 'minutes': {
                let n = parseInt(s.everyMinutes, 10);
                if (isNaN(n) || n < 1) n = 1; if (n > 59) n = 59;
                return `*/${n} * * * *`;
            }
            case 'hourly': {
                let mm = parseInt(s.atMinute, 10);
                if (isNaN(mm) || mm < 0) mm = 0; if (mm > 59) mm = 59;
                return `${mm} * * * *`;
            }
            case 'daily':  return `${m} ${h} * * *`;
            case 'weekly': {
                const days = (s.weekdays && s.weekdays.length)
                    ? s.weekdays.slice().sort((a, b) => a - b).join(',') : '1';
                return `${m} ${h} * * ${days}`;
            }
            case 'monthly': {
                let dom = parseInt(s.dayOfMonth, 10);
                if (isNaN(dom) || dom < 1) dom = 1; if (dom > 31) dom = 31;
                return `${m} ${h} ${dom} * *`;
            }
            case 'custom': return (s.custom || '').trim();
            default: return '0 9 * * *';
        }
    }

    // expression cron → état planif (best-effort ; sinon repli 'custom')
    function _scheduleFromCron(expr) {
        const s = _defaultSchedule();
        const trimmed = String(expr || '').trim();
        if (!trimmed) { s.freq = 'none'; return s; }
        const parts = trimmed.split(/\s+/);
        if (parts.length !== 5) { s.freq = 'custom'; s.custom = expr || ''; return s; }
        const [mi, h, dom, mo, dow] = parts;
        const isInt = v => /^\d+$/.test(v);
        const hm = () => `${_pad(parseInt(h, 10))}:${_pad(parseInt(mi, 10))}`;
        const every = mi.match(/^\*\/(\d+)$/);
        if (every && h === '*' && dom === '*' && mo === '*' && dow === '*') {
            s.freq = 'minutes'; s.everyMinutes = parseInt(every[1], 10); return s;
        }
        if (isInt(mi) && h === '*' && dom === '*' && mo === '*' && dow === '*') {
            s.freq = 'hourly'; s.atMinute = parseInt(mi, 10); return s;
        }
        if (isInt(mi) && isInt(h) && dom === '*' && mo === '*' && dow === '*') {
            s.freq = 'daily'; s.time = hm(); return s;
        }
        // ⚠ Uniquement une LISTE simple de jours (1,3,5). Une plage « 1-5 » ou
        // un pas passait par parseInt('1-5') → 1 : la routine était réécrite
        // « lundi seulement » au premier réenregistrement, sans avertissement.
        // Toute forme non représentable par les puces → mode custom (fidèle).
        if (isInt(mi) && isInt(h) && dom === '*' && mo === '*' && /^[1-7](,[1-7])*$/.test(dow)) {
            const days = [...new Set(dow.split(',').map(x => parseInt(x, 10)))];
            if (days.length) { s.freq = 'weekly'; s.weekdays = days; s.time = hm(); return s; }
        }
        if (isInt(mi) && isInt(h) && isInt(dom) && mo === '*' && dow === '*') {
            s.freq = 'monthly'; s.dayOfMonth = parseInt(dom, 10); s.time = hm(); return s;
        }
        s.freq = 'custom'; s.custom = expr || '';
        return s;
    }

    const builtCron = computed(() => _cronFromSchedule(schedule.value));
    // Mêmes clamps que _cronFromSchedule : le résumé affichait la valeur BRUTE
    // (« Toutes les 90 minute(s) ») alors que le cron enregistré était clampé
    // à */59 — le libellé mentait sur ce qui allait réellement tourner.
    function _clampInt(v, lo, hi, dflt) {
        let n = parseInt(v, 10);
        if (isNaN(n)) n = dflt;
        return Math.min(hi, Math.max(lo, n));
    }
    function _summarize(s) {
        const t = s.time || '09:00';
        switch (s.freq) {
            case 'none':    return 'Aucune planification (manuel / webhook)';
            case 'minutes': return `Toutes les ${_clampInt(s.everyMinutes, 1, 59, 1)} minute(s)`;
            case 'hourly':  return `Toutes les heures (à :${_pad(_clampInt(s.atMinute, 0, 59, 0))})`;
            case 'daily':   return `Tous les jours à ${t}`;
            case 'weekly': {
                const days = (s.weekdays || []).slice().sort((a, b) => a - b).map(n => _dayNames[n]).join(', ');
                return days ? `Chaque ${days} à ${t}` : `Chaque semaine à ${t}`;
            }
            case 'monthly': return `Le ${s.dayOfMonth || 1} du mois à ${t}`;
            case 'custom':  return 'Planification personnalisée (cron)';
            default: return '';
        }
    }
    // expression cron → résumé lisible (liste + vue lecture seule)
    function cronToHuman(expr) { return _summarize(_scheduleFromCron(expr || '')); }
    // snapshot MCP → libellés (catégories locales + noms des serveurs externes).
    // ``cats`` (mcpUserCategories, passé par le template) : ids → libellés du
    // formulaire — la vue lecture affichait « fs »/« shell » là où le
    // formulaire dit « Fichiers »/« Terminal ».
    function mcpSummary(snapshot, cats) {
        const byName = {};
        (cats || []).forEach(c => { if (c && c.name) byName[c.name] = c.label || c.name; });
        const out = [];
        (snapshot || []).forEach(cfg => {
            if (!cfg || typeof cfg !== 'object') return;
            if (cfg.command === 'DEFAULT_LOCAL_PYTHON') (cfg.filter_categories || []).forEach(c => out.push(byName[c] || c));
            else if (cfg.name) out.push(cfg.name);
        });
        return out;
    }

    const scheduleSummary = computed(() => _summarize(schedule.value));

    function isWeekday(n) { return (schedule.value.weekdays || []).includes(n); }
    function toggleWeekday(n) {
        const w = schedule.value.weekdays || [];
        const i = w.indexOf(n);
        if (i >= 0) w.splice(i, 1); else w.push(n);
        schedule.value.weekdays = w;
    }

    function _emptyRoutineForm() {
        return {
            name: '', model: '',
            connector_id: null,     // serveur d'inférence (null = intégré)
            system_prompt: '', task_prompt: '',
            thinking_mode: false, enabled: true,
            agents_enabled: false,  // sous-agents (outil task) — opt-in par routine
            localCats: [],          // noms de catégories MCP locales sélectionnées
            externalServers: [],    // serveurs MCP externes sélectionnés (objets)
            skills: [],             // ids de skills attachés (corps injectés au run)
            trigger_after_id: null, // enchaînement : routine amont (à la Jenkins)
            trigger_after_on: 'ok', // condition : ok | error | always
            runs_keep: 0,           // journal : exécutions conservées (0 = toutes)
            notify_on: 'all',       // notifications : all | error | none
            notify_keep: 0,         // notifications conservées pour cette routine (0 = toutes)
        };
    }

    // Serveur d'inférence de la routine (M5, 2026-09-17). Le couple
    // (serveur, modèle) est ATOMIQUE : deux serveurs peuvent exposer le même
    // nom de modèle, donc la liste des modèles suit le serveur choisi et
    // changer de serveur REMET le modèle au défaut plutôt que d'en garder un
    // qui n'existe pas en face.
    const routineModelOptions = computed(() => {
        try { return ctx.engineModels ? (ctx.engineModels(routineForm.value.connector_id) || []) : []; }
        catch (_) { return []; }
    });

    function onRoutineConnectorChange() {
        routineForm.value.model = '';
    }

    // Nom d'une routine par id (chip « après X » + select d'enchaînement).
    function routineNameById(id) {
        const r = (routines.value || []).find(x => x.id === id);
        return r ? r.name : `#${id}`;
    }

    // ── Skills attachés ────────────────────────────────────────────────────────
    async function _loadRoutineSkills() {
        routineSkillsLoading.value = true;
        try {
            const res = await fetchAuth('/api/skills', {}, true);
            if (res && res.ok) {
                const data = await res.json();
                routineSkills.value = (data.skills || []).filter(s => s && s.source !== 'learned');
                routineSkillsLoadedOk.value = true;
            }
        } catch (e) {}
        routineSkillsLoading.value = false;
    }

    function _knownSkillIds() {
        const known = new Set();
        (routineSkills.value || []).forEach(s => {
            known.add(s.id || s.name);
            if (s.name) known.add(s.name);
        });
        return known;
    }

    // ── Arbre du picker : skills principaux dépliables → sous-skills ──────────
    // Racines = depth 0 ; descendants rattachés à LEUR racine par préfixe d'id
    // qualifié (« pkg/child », « pkg/child/x »), indentés selon depth. Cocher la
    // racine embarque tout le paquet au run (le modèle applique ce qui convient) ;
    // déplier permet de cibler un sous-skill précis.
    const routineSkillTree = computed(() => {
        const list = routineSkills.value || [];
        const roots = list.filter(s => !s.parent_id);
        const claimed = new Set(roots.map(s => s.id || s.name));
        const nodes = roots.map(r => {
            const rid = r.id || r.name;
            const children = list.filter(s => s.parent_id && (s.id || '').indexOf(rid + '/') === 0);
            children.forEach(c => claimed.add(c.id || c.name));
            return { skill: r, children };
        });
        // Orphelins (descendant sans racine listée — ne devrait pas arriver) :
        // affichés à plat plutôt que perdus.
        list.forEach(s => {
            if (!claimed.has(s.id || s.name)) nodes.push({ skill: s, children: [] });
        });
        return nodes;
    });

    // Paquets REPLIÉS (ids) — tout est déplié PAR DÉFAUT, comme la page Skills.
    // Repliés d'office derrière un chevron discret, les skills individuels d'un
    // paquet passaient pour absents du sélecteur (bug remonté 2026-09-08 :
    // « les skills individuels ne sont pas dans le menu »). Réassigné (pas
    // muté) → réactivité simple.
    const collapsedSkillParents = ref([]);
    function isSkillExpanded(id) { return !collapsedSkillParents.value.includes(id); }
    function toggleSkillExpand(id) {
        const cur = collapsedSkillParents.value;
        collapsedSkillParents.value = cur.includes(id)
            ? cur.filter(x => x !== id) : [...cur, id];
    }
    // Libellé d'un sous-skill : chemin relatif à sa racine (« deploy », « deploy/x »).
    function skillLeafLabel(child, root) {
        const cid = child.id || child.name;
        const rid = root.id || root.name;
        return cid.indexOf(rid + '/') === 0 ? cid.slice(rid.length + 1) : cid;
    }
    // Nb de descendants connus d'un id (puces de la vue lecture : « pkg +n »).
    function skillDescendantCount(id) {
        if (!routineSkillsLoadedOk.value) return 0;
        const prefix = id + '/';
        return (routineSkills.value || []).filter(s => (s.id || '').indexOf(prefix) === 0).length;
    }

    function isRoutineSkillOn(id) {
        return (routineForm.value.skills || []).includes(id);
    }
    function toggleRoutineSkill(id) {
        const list = routineForm.value.skills || [];
        const i = list.indexOf(id);
        if (i >= 0) list.splice(i, 1);
        else {
            // Cap mesuré sur ce qui sera RÉELLEMENT envoyé (_pruneSkills) : les
            // ids orphelins comptaient dans la limite et bloquaient une case
            // alors que le backend en aurait accepté davantage.
            if (_pruneSkills(list).length >= ROUTINE_SKILLS_MAX) {
                showToast(`Maximum ${ROUTINE_SKILLS_MAX} skills par routine`, 'info');
                return;
            }
            list.push(id);
        }
        routineForm.value.skills = list;
    }
    // Compteur affiché (« n sélectionné(s) ») : ids réellement envoyés — les
    // orphelins sont montrés à part en ambre.
    const routineSkillsCount = computed(() => _pruneSkills(routineForm.value.skills).length);
    function removeRoutineSkill(id) {
        const list = routineForm.value.skills || [];
        const i = list.indexOf(id);
        if (i >= 0) list.splice(i, 1);
    }

    // Ids sélectionnés qui n'existent plus (skill supprimé/renommé depuis) :
    // affichés en ambre dans le formulaire, retirés du payload à l'enregistrement.
    const orphanRoutineSkills = computed(() => {
        if (!routineSkillsLoadedOk.value) return [];
        const known = _knownSkillIds();
        return (routineForm.value.skills || []).filter(id => !known.has(id));
    });

    // Un id est « connu » tant qu'on n'a pas la liste (pas de faux ⚠).
    function isKnownSkill(id) {
        if (!routineSkillsLoadedOk.value) return true;
        return _knownSkillIds().has(id);
    }
    // Badge domaine du picker — vide quand l'id affiché le montre déjà
    // (« jenkins » ou « jenkins/deploy » n'ont pas besoin du badge « jenkins »).
    function skillDomainBadge(s) {
        const dom = (s && s.domain) || '';
        if (!dom) return '';
        const shown = s.id || s.name || '';
        if (shown === dom || shown.indexOf(dom + '/') === 0) return '';
        return dom;
    }
    function skillTooltip(id) {
        const s = (routineSkills.value || []).find(
            x => (x.id || x.name) === id || x.name === id);
        if (s) return s.description || '';
        return routineSkillsLoadedOk.value ? 'Skill introuvable (supprimé ou renommé ?)' : '';
    }
    // Payload : on retire les ids inconnus (le backend les refuserait en 400) —
    // l'utilisateur les a vus en ambre dans le formulaire.
    function _pruneSkills(ids) {
        const list = (ids || []).filter(id => typeof id === 'string' && id.trim());
        if (!routineSkillsLoadedOk.value) return list;
        const known = _knownSkillIds();
        return list.filter(id => known.has(id));
    }

    // ── Construction / parsing du snapshot MCP (forme active_mcp_servers) ──────
    function _buildMcpServers() {
        const arr = [];
        const cats = routineForm.value.localCats || [];
        if (cats.length) {
            arr.push({ type: 'stdio', name: 'Outils Locaux',
                       command: 'DEFAULT_LOCAL_PYTHON', filter_categories: [...cats] });
        }
        // RÉFÉRENCE seule : le scheduler ré-hydrate URL + auth depuis le
        // magasin serveur à chaque run (rotation de clé honorée, aucun
        // identifiant figé dans la routine).
        (routineForm.value.externalServers || []).forEach(s => arr.push({
            id: s.id, name: s.name, type: s.type,
            ...(s.shared ? { shared: true } : {}),
        }));
        return arr;
    }

    function _parseSnapshot(snapshot) {
        const localCats = [];
        const externalServers = [];
        (snapshot || []).forEach(cfg => {
            if (!cfg || typeof cfg !== 'object') return;
            if (cfg.command === 'DEFAULT_LOCAL_PYTHON') {
                (cfg.filter_categories || []).forEach(c => localCats.push(c));
            } else {
                externalServers.push(cfg);
            }
        });
        return { localCats, externalServers };
    }

    // ── Sélection MCP (handlers appelés depuis le template) ───────────────────
    function isLocalCatOn(name) {
        return (routineForm.value.localCats || []).includes(name);
    }
    function toggleRoutineLocalCat(name) {
        const cats = routineForm.value.localCats || [];
        const i = cats.indexOf(name);
        if (i >= 0) cats.splice(i, 1); else cats.push(name);
        routineForm.value.localCats = cats;
    }
    function isExternalOn(id) {
        return (routineForm.value.externalServers || []).some(s => s.id === id);
    }
    function toggleRoutineExternal(srv) {
        const list = routineForm.value.externalServers || [];
        const i = list.findIndex(s => s.id === srv.id);
        if (i >= 0) list.splice(i, 1); else list.push({ ...srv });
        routineForm.value.externalServers = list;
    }

    // ── Navigation page ───────────────────────────────────────────────────────
    async function openRoutinesPage() {
        currentView.value = 'routines';
        _resetEditor();
        _loadRoutineSkills();   // picker + libellés des puces (non bloquant)
        // Serveurs d'inférence autorisés + leurs modèles : le select « Serveur »
        // de l'éditeur serait vide sur un onglet ouvert directement sur la page.
        try { if (ctx.loadEngines) ctx.loadEngines(); } catch (_) {}
        await loadRoutines();
        // Par défaut, on affiche les INFOS DE RUN de la 1re routine (au lieu d'un
        // panneau vide). L'édition n'apparaît que sur clic « Configurer ».
        if (!selectedRoutineId.value && (routines.value || []).length) viewRoutine(routines.value[0]);
    }
    function closeRoutinesPage() {
        currentView.value = 'chat';
        _clearPolls();
        _resetEditor();
        routines.value = [];
        routinesError.value = '';
    }
    function _resetEditor() {
        routineEditMode.value = '';
        selectedRoutineId.value = null;
        viewed.value = null;
        routineForm.value = _emptyRoutineForm();
        schedule.value = _defaultSchedule();
        routineRuns.value = [];
        expandedRunId.value = null;
        if (_runsPollTimer) { clearTimeout(_runsPollTimer); _runsPollTimer = null; }
    }

    // ── CRUD ───────────────────────────────────────────────────────────────────
    async function loadRoutines() {
        routinesLoading.value = true;
        routinesError.value = '';
        try {
            const res = await fetchAuth('/api/routines', {}, true);
            if (res && res.ok) {
                const data = await res.json();
                routines.value = data.items || [];
                // ``viewed`` pointait un objet de l'ANCIEN tableau : la vue
                // lecture ne voyait jamais les rafraîchissements (puce webhook
                // après rotation, modifs d'une autre session), et « Configurer »
                // réhydratait — puis réenregistrait — une version périmée.
                if (viewed.value) {
                    const fresh = routines.value.find(x => x.id === viewed.value.id);
                    if (fresh) viewed.value = fresh;
                }
            } else {
                routinesError.value = 'Chargement impossible.';
            }
        } catch (e) {
            routinesError.value = 'Erreur réseau.';
        }
        routinesLoading.value = false;
        // Polling VIVANT de la liste tant qu'au moins une routine a un run en cours
        // (met à jour les pastilles de statut sans intervention). S'auto-arrête.
        if (_listPollTimer) { clearTimeout(_listPollTimer); _listPollTimer = null; }
        const anyRunning = (routines.value || []).some(r => (r.running_count || 0) > 0);
        if (anyRunning && currentView.value === 'routines' && !document.hidden) {
            _listPollTimer = setTimeout(loadRoutines, 4000);
        }
    }

    function startCreateRoutine() {
        routineForm.value = _emptyRoutineForm();
        schedule.value = _defaultSchedule();
        selectedRoutineId.value = null;
        viewed.value = null;
        routineRuns.value = [];
        collapsedSkillParents.value = [];
        // État webhook remis à zéro : sinon le badge « Actif » (et le secret
        // encore en mémoire) de la routine précédemment configurée fuyaient
        // dans le formulaire d'une routine qui n'existe pas encore.
        webhookEnabled.value = false;
        webhookSecret.value = null;
        webhookEventsInput.value = '';
        webhookFilterForm.value = { events: [], branch: '', repo: '' };
        routineEditTab.value = 'general';
        routineEditMode.value = 'create';
    }

    // Vue LECTURE SEULE : infos + journal des runs (affichée par défaut au clic
    // sur une routine ; l'édition n'arrive que via « Configurer »).
    function viewRoutine(r) {
        viewed.value = r;
        selectedRoutineId.value = r.id;
        expandedRunId.value = null;
        routineEditMode.value = 'view';
        loadRuns(r.id);
    }

    function editRoutine(r) {
        const parsed = _parseSnapshot(r.mcp_snapshot);
        routineForm.value = {
            name: r.name || '',
            model: r.model || '',
            connector_id: r.connector_id || null,
            system_prompt: r.system_prompt || '',
            task_prompt: r.task_prompt || '',
            thinking_mode: !!r.thinking_mode,
            enabled: !!r.enabled,
            agents_enabled: !!r.agents_enabled,
            localCats: parsed.localCats,
            externalServers: parsed.externalServers,
            skills: Array.isArray(r.skills)
                ? r.skills.filter(id => typeof id === 'string' && id.trim()) : [],
            trigger_after_id: r.trigger_after_id || null,
            trigger_after_on: r.trigger_after_on || 'ok',
            runs_keep: _clampInt(r.runs_keep, 0, ROUTINE_KEEP_MAX, 0),
            notify_on: ROUTINE_NOTIFY_MODES.some(m => m.id === r.notify_on) ? r.notify_on : 'all',
            notify_keep: _clampInt(r.notify_keep, 0, ROUTINE_KEEP_MAX, 0),
        };
        // Tout déplié : une case cochée sous un paquet est toujours visible.
        collapsedSkillParents.value = [];
        schedule.value = _scheduleFromCron(r.cron_expr || '');
        // Déclencheur webhook : état + filtre hydratés depuis la routine ; le
        // secret n'existe côté client qu'après une rotation (affiché UNE fois).
        webhookEnabled.value = !!r.webhook_enabled;
        webhookSecret.value = null;
        const wf = r.webhook_filter || {};
        webhookFilterForm.value = {
            events: Array.isArray(wf.events) ? wf.events.slice() : [],
            branch: wf.branch || '',
            repo: wf.repo || '',
        };
        webhookEventsInput.value = webhookFilterForm.value.events.join(', ');
        selectedRoutineId.value = r.id;
        routineEditTab.value = 'general';
        routineEditMode.value = 'edit';
        loadRuns(r.id);
    }

    function cancelRoutineEdit() {
        // Retour à la vue lecture seule de la routine éditée (ou liste vide).
        if (routineEditMode.value === 'edit' && viewed.value) { viewRoutine(viewed.value); return; }
        const first = (routines.value || [])[0];
        if (first) viewRoutine(first); else _resetEditor();
    }

    function _formPayload() {
        const f = routineForm.value;
        return {
            name: (f.name || '').trim(),
            cron_expr: builtCron.value,
            model: f.model || null,
            connector_id: f.connector_id || null,
            system_prompt: f.system_prompt || '',
            task_prompt: f.task_prompt || '',
            thinking_mode: !!f.thinking_mode,
            enabled: !!f.enabled,
            agents_enabled: !!f.agents_enabled,
            mcp_servers: _buildMcpServers(),
            skills: _pruneSkills(f.skills),
            trigger_after_id: f.trigger_after_id || null,
            trigger_after_on: f.trigger_after_on || 'ok',
            // Historique : champ vidé → 0 (= tout conserver), bornes du backend.
            runs_keep: _clampInt(f.runs_keep, 0, ROUTINE_KEEP_MAX, 0),
            notify_on: ROUTINE_NOTIFY_MODES.some(m => m.id === f.notify_on) ? f.notify_on : 'all',
            notify_keep: _clampInt(f.notify_keep, 0, ROUTINE_KEEP_MAX, 0),
        };
    }

    async function saveRoutine() {
        const payload = _formPayload();
        // Bascule sur l'onglet du champ fautif : le toast seul pointait un
        // champ INVISIBLE (onglets v-show) — aucun moyen de voir l'erreur.
        if (!payload.name) {
            routineEditTab.value = 'general';
            showToast('Nom requis', 'error'); return;
        }
        if (!payload.task_prompt.trim()) {
            routineEditTab.value = 'prompt';
            showToast('Tâche requise', 'error'); return;
        }
        // cron vide = « aucune planification » (autorisé) ; non vide = 5 champs.
        const _cron = (payload.cron_expr || '').trim();
        if (_cron && _cron.split(/\s+/).length !== 5) {
            routineEditTab.value = 'schedule';
            showToast('Planification invalide (cron : 5 champs)', 'error'); return;
        }
        routinesBusy.value = true;
        try {
            const editing = routineEditMode.value === 'edit' && selectedRoutineId.value;
            const url = editing ? `/api/routines/${selectedRoutineId.value}` : '/api/routines';
            const res = await fetchAuth(url, {
                method: editing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (res && res.ok) {
                let savedId = selectedRoutineId.value;
                if (!editing) { try { const d = await res.json(); savedId = d.id; } catch (e) {} }
                // Le filtre webhook a son propre endpoint : sans cet appel, le
                // bouton « Enregistrer » global JETAIT la saisie de l'onglet
                // Déclencheurs (deux boutons de save, périmètres différents).
                if (editing && webhookEnabled.value) await saveWebhookFilter({ silent: true });
                showToast(editing ? 'Routine enregistrée' : 'Routine créée');
                await loadRoutines();
                // Après sauvegarde → vue lecture seule de la routine (infos + runs).
                const saved = (routines.value || []).find(x => x.id === savedId);
                if (saved) viewRoutine(saved); else _resetEditor();
            } else {
                let msg = 'Erreur sauvegarde';
                try { const d = await res.json(); if (d && d.detail) msg = d.detail; } catch (e) {}
                showToast(msg, 'error');
            }
        } catch (e) {
            showToast('Erreur réseau', 'error');
        }
        routinesBusy.value = false;
    }

    async function deleteRoutine(r) {
        const target = r || (selectedRoutineId.value && routines.value.find(x => x.id === selectedRoutineId.value));
        if (!target) return;
        // Busy AVANT la confirmation : posé après, un double-clic empilait
        // deux modales → deux DELETE → toast d'erreur sur le 404 du second.
        if (routinesBusy.value) return;
        routinesBusy.value = true;
        const ok = await openConfirm('Supprimer cette routine ?',
            'Ses exécutions journalisées seront aussi supprimées.', true);
        if (!ok) { routinesBusy.value = false; return; }
        try {
            const res = await fetchAuth(`/api/routines/${target.id}`, { method: 'DELETE' });
            if (res && res.ok) {
                showToast('Routine supprimée');
                if (selectedRoutineId.value === target.id) _resetEditor();
                await loadRoutines();
                const first = (routines.value || [])[0];
                if (routineEditMode.value === '' && first) viewRoutine(first);
            } else {
                showToast('Suppression impossible', 'error');
            }
        } catch (e) { showToast('Erreur réseau', 'error'); }
        routinesBusy.value = false;
    }

    async function toggleRoutineEnabled(r) {
        const action = r.enabled ? 'disable' : 'enable';
        try {
            const res = await fetchAuth(`/api/routines/${r.id}/${action}`, { method: 'POST' });
            if (res && res.ok) {
                r.enabled = !r.enabled;
                if (selectedRoutineId.value === r.id) routineForm.value.enabled = r.enabled;
                if (viewed.value && viewed.value.id === r.id) viewed.value.enabled = r.enabled;
            } else {
                showToast('Action impossible', 'error');
            }
        } catch (e) { showToast('Erreur réseau', 'error'); }
    }

    async function runRoutineNow() {
        if (!selectedRoutineId.value) return;
        routinesBusy.value = true;
        try {
            const res = await fetchAuth(`/api/routines/${selectedRoutineId.value}/run-now`, { method: 'POST' });
            if (res && res.ok) {
                const d = await res.json().catch(() => ({}));
                // La raison vient du serveur (cap user ≠ run déjà en cours) —
                // le libellé codé en dur accusait le cap à tort.
                if (d && d.skipped) showToast('Non lancé : ' + (d.reason || 'cap de runs simultanés atteint'), 'info');
                else showToast('Exécution lancée');
                // Laisse le run démarrer puis rafraîchit le journal ET la liste :
                // loadRuns/loadRoutines enchaînent ensuite le polling vivant tant
                // que le run est « en cours » (la réponse finale s'affichera seule).
                setTimeout(() => { loadRuns(selectedRoutineId.value); loadRoutines(); }, 800);
            } else {
                let msg = 'Lancement impossible';
                try { const d = await res.json(); if (d && d.detail) msg = d.detail; } catch (e) {}
                showToast(msg, 'error');
            }
        } catch (e) { showToast('Erreur réseau', 'error'); }
        routinesBusy.value = false;
    }

    // ── Déclencheur webhook (tout émetteur HTTP → run de routine) ──────────────
    // Pas seulement Git : supervision, CI, n8n, script curl… L'auth est le
    // secret per-routine, en signature HMAC (Gitea/GitHub/générique) OU en
    // token simple (header X-Webhook-Token / ?token=). Le secret n'est connu
    // du client qu'à la ROTATION (affiché une fois) ; l'état persistant exposé
    // par l'API se limite à webhook_enabled / webhook_has_secret / webhook_filter.
    const webhookEnabled = ref(false);
    const webhookSecret = ref(null);          // visible UNE fois après rotate
    const webhookBusy = ref(false);
    const webhookFilterForm = ref({ events: [], branch: '', repo: '' });
    // Saisie brute du champ « Événements » : un input dérivé (:value=join +
    // @input=re-split) était réécrit à chaque frappe → caret expulsé en fin
    // de champ. On ne parse qu'à l'enregistrement.
    const webhookEventsInput = ref('');

    // Répercute l'état webhook fraîchement écrit côté serveur sur la routine
    // en mémoire (liste + vue lecture) — sans ça, la puce « webhook » de la
    // vue lecture ne reflétait jamais rotate/disable/filter avant un reload.
    function _patchViewedWebhook(patch) {
        const id = selectedRoutineId.value;
        [routines.value.find(x => x.id === id), viewed.value && viewed.value.id === id ? viewed.value : null]
            .filter(Boolean).forEach(o => Object.assign(o, patch));
    }

    function webhookUrl() {
        if (!selectedRoutineId.value) return '';
        return `${window.location.origin}/api/webhooks/routines/${selectedRoutineId.value}`;
    }
    async function rotateWebhook() {
        if (!selectedRoutineId.value || webhookBusy.value) return;
        webhookBusy.value = true;
        try {
            const res = await fetchAuth(`/api/routines/${selectedRoutineId.value}/webhook/rotate`, { method: 'POST' });
            if (res && res.ok) {
                const d = await res.json();
                webhookSecret.value = d.secret || null;
                webhookEnabled.value = true;
                _patchViewedWebhook({ webhook_enabled: true, webhook_has_secret: true });
                showToast('Webhook activé — copiez le secret maintenant, il ne sera plus affiché');
            } else {
                showToast('Activation impossible', 'error');
            }
        } catch (e) { showToast('Erreur réseau', 'error'); }
        webhookBusy.value = false;
    }
    async function disableWebhook() {
        if (!selectedRoutineId.value || webhookBusy.value) return;
        webhookBusy.value = true;
        try {
            const res = await fetchAuth(`/api/routines/${selectedRoutineId.value}/webhook/disable`, { method: 'POST' });
            if (res && res.ok) {
                webhookEnabled.value = false;
                webhookSecret.value = null;
                _patchViewedWebhook({ webhook_enabled: false });
                showToast('Webhook désactivé');
            } else {
                showToast('Désactivation impossible', 'error');
            }
        } catch (e) { showToast('Erreur réseau', 'error'); }
        webhookBusy.value = false;
    }
    async function saveWebhookFilter(opts) {
        const silent = !!(opts && opts.silent);   // appel groupé depuis saveRoutine
        if (!selectedRoutineId.value || webhookBusy.value) return;
        webhookBusy.value = true;
        try {
            // Le champ « Événements » est parsé ICI (saisie brute conservée
            // telle quelle pendant la frappe — pas de re-normalisation du champ).
            webhookFilterForm.value.events = String(webhookEventsInput.value || '')
                .split(',').map(s => s.trim().toLowerCase()).filter(s => s);
            const res = await fetchAuth(`/api/routines/${selectedRoutineId.value}/webhook/filter`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(webhookFilterForm.value),
            });
            if (res && res.ok) {
                _patchViewedWebhook({ webhook_filter: { ...webhookFilterForm.value } });
                if (!silent) showToast('Webhook enregistré');
            } else {
                let msg = 'Enregistrement impossible';
                try { const d = await res.json(); if (d && d.detail) msg = d.detail; } catch (e) {}
                showToast(msg, 'error');
            }
        } catch (e) { showToast('Erreur réseau', 'error'); }
        webhookBusy.value = false;
    }
    async function copyWebhookText(t) {
        if (!t) return;
        try { await navigator.clipboard.writeText(t); showToast('Copié'); }
        catch (e) { showToast('Copie impossible', 'error'); }
    }

    // Arrêt d'un run EN COURS. Réponse optimiste (« stopping ») : l'arrêt est
    // coopératif côté serveur (un outil long peut retarder la transition), le
    // statut final « Arrêté » apparaît au poll du journal.
    //
    // Les ids en cours d'arrêt vivent dans un Set MODULE (pas un flag sur
    // l'objet run) : le poll remplace les objets par ceux du serveur — le flag
    // ``run._stopping`` disparaissait au refresh suivant et le bouton
    // redevenait cliquable en boucle pendant tout l'arrêt coopératif.
    const _stoppingRunIds = ref(new Set());
    function runStopping(run) { return !!run && _stoppingRunIds.value.has(run.id); }
    function _setStopping(id, on) {
        const s = new Set(_stoppingRunIds.value);
        if (on) s.add(id); else s.delete(id);
        _stoppingRunIds.value = s;              // réassigné → réactif
    }
    async function stopRoutineRun(run) {
        const rid = (run && run.routine_id) || selectedRoutineId.value;
        if (!rid || !run || run.status !== 'running' || runStopping(run)) return;
        _setStopping(run.id, true);
        try {
            const res = await fetchAuth(`/api/routines/${rid}/runs/${run.id}/stop`, { method: 'POST' });
            if (res && res.ok) {
                const d = await res.json().catch(() => ({}));
                if (d && d.stopping) showToast('Arrêt demandé');
                else if (d && d.status === 'cancelled') showToast('Run arrêté (le processus exécutant était déjà mort)');
                else showToast('Run déjà terminé', 'info');
                setTimeout(() => { loadRuns(rid); loadRoutines(); }, 800);
            } else {
                _setStopping(run.id, false);
                showToast('Arrêt impossible', 'error');
            }
        } catch (e) { _setStopping(run.id, false); showToast('Erreur réseau', 'error'); }
    }
    // Variante « bouton unique » du header : au plus UN run actif par routine
    // (garde anti-chevauchement serveur), on arrête celui-là.
    function stopActiveRun() {
        const run = (routineRuns.value || []).find(r => r.status === 'running');
        if (run) stopRoutineRun(run);
    }

    async function loadRuns(routineId) {
        if (!routineId) return;
        routineRunsLoading.value = true;
        try {
            const res = await fetchAuth(`/api/routines/${routineId}/runs?limit=50`, {}, true);
            if (res && res.ok) {
                const data = await res.json();
                // Garde anti-course : si la sélection a changé pendant le fetch
                // (clic rapide A→B, deep-link notification, refresh différé du
                // stop), la réponse PÉRIMÉE écrasait le journal de la routine
                // affichée par celui d'une autre.
                if (selectedRoutineId.value !== routineId) {
                    routineRunsLoading.value = false;
                    return;
                }
                routineRuns.value = data.items || [];
                // Purge des ids « arrêt en cours » dont le run a quitté 'running'.
                if (_stoppingRunIds.value.size) {
                    const still = new Set();
                    routineRuns.value.forEach(r => {
                        if (r.status === 'running' && _stoppingRunIds.value.has(r.id)) still.add(r.id);
                    });
                    _stoppingRunIds.value = still;
                }
            }
        } catch (e) {}
        routineRunsLoading.value = false;
        // Tant qu'un run de CETTE routine est en cours, re-sonde le journal toutes
        // les 3 s (la réponse finale apparaîtra dès la fin). Auto-arrêt sinon, et
        // on n'enchaîne que si l'utilisateur est toujours sur la page Routines
        // (quitter par la sidebar ne passe pas par closeRoutinesPage) et sur la
        // même routine.
        if (_runsPollTimer) { clearTimeout(_runsPollTimer); _runsPollTimer = null; }
        const stillRunning = (routineRuns.value || []).some(r => r.status === 'running');
        if (stillRunning && selectedRoutineId.value === routineId &&
            currentView.value === 'routines' &&
            (routineEditMode.value === 'edit' || routineEditMode.value === 'view') && !document.hidden) {
            _runsPollTimer = setTimeout(() => loadRuns(routineId), 3000);
        }
    }

    // ── État « en cours » dérivé (pour l'indicateur live de la section) ─────────
    const anyRunActive = computed(() => (routineRuns.value || []).some(r => r.status === 'running'));
    // Le run actif est-il déjà en cours d'arrêt ? (désactive le bouton du header)
    const activeRunStopping = computed(() =>
        (routineRuns.value || []).some(r => r.status === 'running' && _stoppingRunIds.value.has(r.id)));

    function toggleRunExpand(id) {
        expandedRunId.value = expandedRunId.value === id ? null : id;
    }
    function runStatusLabel(status) {
        return {
            ok: 'Réussi', error: 'Échec', running: 'En cours',
            skipped: 'Ignoré', orphaned: 'Interrompu', cancelled: 'Arrêté',
        }[status] || status || '—';
    }
    // Markup de raisonnement dans les summaries DÉJÀ persistés (runs lancés
    // avant le strip backend) : paires <think>…</think> ou <|thinking|>…
    // retirées, et tout ce qui suit une balise ouverte jamais fermée (summary
    // tronqué à 4000 au milieu du raisonnement). Le backend n'en produit plus.
    function _stripThinkMarkup(t) {
        let s = String(t || '');
        if (!/<think>|<\|thinking\|>/i.test(s)) return s;
        s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
        s = s.replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, '');
        s = s.replace(/<think>[\s\S]*$/i, '');
        s = s.replace(/<\|thinking\|>[\s\S]*$/i, '');
        return s.trim();
    }

    // Texte intégral à afficher dans le détail déplié (réponse finale OU erreur
    // OU raison de skip — « profondeur max », « LLM injoignable », « run déjà
    // en cours » étaient en base mais jamais montrés : l'UI affichait un texte
    // figé et souvent faux).
    function runDetailText(run) {
        if (!run) return '';
        if (run.status === 'error' || run.status === 'orphaned' || run.status === 'skipped') {
            return run.error || '';
        }
        return _stripThinkMarkup(run.summary || '');
    }
    // La réponse d'un agent est du Markdown (titres, listes, tableaux, blocs de
    // code) : en texte brut le journal était illisible. Les erreurs restent en
    // <pre> — une stack trace ne veut pas passer par un moteur Markdown.
    function runIsMarkdown(run) {
        return !!run && run.status !== 'error' && run.status !== 'orphaned'
            && run.status !== 'skipped';
    }
    // Aperçu d'UNE ligne (ligne repliée) : on ne peut pas y rendre du HTML, donc
    // on aplatit le markup au lieu de l'afficher tel quel — sinon la colonne
    // montrait « ## Rapport de veille » ou « | Dépôt | Commits | ».
    function runPreviewText(run) {
        let t = runDetailText(run);
        if (!t || !runIsMarkdown(run)) return t;
        return t
            .replace(/```[\s\S]*?```/g, ' ')        // blocs de code
            .replace(/^\s*\|.*$/gm, ' ')            // lignes de tableau
            .replace(/^\s{0,3}#{1,6}\s+/gm, '')     // titres
            .replace(/^\s{0,3}[-*+]\s+/gm, '')      // puces
            .replace(/[`*_>#]/g, '')                // emphase / citations résiduelles
            .replace(/\s+/g, ' ')
            .trim();
    }
    // Le backend tronque le summary à 4000 caractères : le dire, plutôt que de
    // laisser croire à une réponse qui s'arrête au milieu d'une phrase.
    const RUN_SUMMARY_CAP = 4000;
    function runIsTruncated(run) {
        // Mesure sur le summary BRUT : le backend tronque AVANT le strip du
        // markup de thinking — mesurer après strip masquait la mention sur les
        // vieux summaries contenant du <think>.
        return runIsMarkdown(run) && String((run && run.summary) || '').length >= RUN_SUMMARY_CAP;
    }
    async function copyRunDetail(run) {
        const t = runDetailText(run);
        if (!t) return;
        try { await navigator.clipboard.writeText(t); showToast('Réponse copiée'); }
        catch (e) { showToast('Copie impossible', 'error'); }
    }

    // ── Fichiers produits par un run ───────────────────────────────────────────
    // Persistés par le scheduler (chemins des écritures réussies). Sans eux, il
    // fallait deviner ce que la routine avait produit puis fouiller l'éditeur.
    function runFiles(run) {
        return (run && Array.isArray(run.files)) ? run.files : [];
    }
    function fileBaseName(p) {
        const s = String(p || '');
        const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return (i >= 0 ? s.slice(i + 1) : s) || s;
    }
    // Ouvre le fichier dans l'éditeur. On quitte d'abord la page Routines : elle
    // se superpose à la colonne de chat (inset-0 z-[45]) et masquerait l'éditeur.
    function openRunFile(path) {
        if (!path) return;
        if (!ctx.openFile) { showToast('Éditeur indisponible', 'error'); return; }
        closeRoutinesPage();
        try { ctx.openFile(path); }
        catch (e) { showToast('Ouverture impossible', 'error'); }
    }
    function fmtRelTime(ts) {
        if (!ts) return '';
        const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
        if (s < 60) return "à l'instant";
        if (s < 3600) return 'il y a ' + Math.floor(s / 60) + ' min';
        if (s < 86400) return 'il y a ' + Math.floor(s / 3600) + ' h';
        return 'il y a ' + Math.floor(s / 86400) + ' j';
    }

    // ── Helpers d'affichage (template) ─────────────────────────────────────────
    function runStatusClass(status) {
        return {
            ok:        'bg-emerald-100 text-emerald-700',
            error:     'bg-red-100 text-red-700',
            running:   'bg-blue-100 text-blue-700',
            skipped:   'bg-slate-100 text-slate-500',
            orphaned:  'bg-amber-100 text-amber-700',
            cancelled: 'bg-slate-200 text-slate-600',
        }[status] || 'bg-slate-100 text-slate-500';
    }
    function fmtRunTime(ts) {
        if (!ts) return '—';
        try { return new Date(ts * 1000).toLocaleString('fr-FR'); } catch (e) { return '—'; }
    }
    function fmtDuration(ms) {
        // Un run de routine est souvent long : « 2520.0 s » pour 42 min était
        // illisible — bascule s → min → h au-delà des seuils usuels.
        if (ms === null || ms === undefined) return '—';
        if (ms < 1000) return ms + ' ms';
        const s = ms / 1000;
        if (s < 90) return s.toFixed(1) + ' s';
        const m = s / 60;
        if (m < 90) return Math.round(m) + ' min';
        const h = Math.floor(m / 60);
        return h + ' h ' + String(Math.round(m % 60)).padStart(2, '0');
    }

    return {
        // state
        routinesLoading, routinesBusy, routinesError, routines,
        routineEditMode, selectedRoutineId, routineForm, viewed,
        routineEditTab, routineEditTabs, routineIsEditing,
        ROUTINE_BUILTIN_AGENTS,
        // historique par routine (journal borné + notifications)
        ROUTINE_KEEP_MAX, ROUTINE_NOTIFY_MODES, notifyOnLabel, keepLabel,
        routineRuns, routineRunsLoading, expandedRunId, anyRunActive, activeRunStopping,
        // schedule builder (visuel)
        schedule, builtCron, scheduleSummary, weekdayChips, toggleWeekday, isWeekday,
        // navigation
        openRoutinesPage, closeRoutinesPage,
        // crud
        loadRoutines, startCreateRoutine, viewRoutine, editRoutine, cancelRoutineEdit,
        saveRoutine, deleteRoutine, toggleRoutineEnabled, runRoutineNow, loadRuns,
        stopRoutineRun, stopActiveRun, runStopping,
        // webhook
        webhookEnabled, webhookSecret, webhookBusy, webhookFilterForm, webhookEventsInput,
        webhookUrl, rotateWebhook, disableWebhook, saveWebhookFilter, copyWebhookText,
        // enchaînement
        routineNameById,
        // serveur d'inférence de la routine
        routineModelOptions, onRoutineConnectorChange,
        // mcp selection
        isLocalCatOn, toggleRoutineLocalCat, isExternalOn, toggleRoutineExternal,
        // skills attachés
        routineSkills, routineSkillsLoading, routineSkillsLoadedOk, reloadRoutineSkills: _loadRoutineSkills,
        orphanRoutineSkills, routineSkillsCount,
        isRoutineSkillOn, toggleRoutineSkill, removeRoutineSkill,
        isKnownSkill, skillTooltip, skillDomainBadge,
        routineSkillTree, isSkillExpanded, toggleSkillExpand,
        skillLeafLabel, skillDescendantCount,
        // display helpers
        runStatusClass, fmtRunTime, fmtDuration, cronToHuman, mcpSummary,
        runStatusLabel, runDetailText, fmtRelTime, toggleRunExpand,
        // journal : rendu de la réponse + fichiers produits
        runIsMarkdown, runIsTruncated, copyRunDetail, runPreviewText,
        runFiles, fileBaseName, openRunFile,
    };
}
