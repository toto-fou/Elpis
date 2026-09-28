// SPDX-License-Identifier: MIT
/*
 * _code_menu.js — page « Code » : sessions opencode remontées ET pilotables.
 *
 * L'utilisateur lance opencode où il veut ; la commande /remote <jeton> (plugin
 * `elpis-remote`, servi par /api/code/plugin.ts) remonte ses sessions vers l'app.
 * Cette page LISTE les sessions publiées, affiche le transcript live (SSE) et
 * PILOTE la session à distance : composer → POST /api/code/sessions/{sid}/prompt
 * (le plugin tire la commande en long-poll et l'injecte dans la session locale).
 *
 * Style : code_page.html — utilitaires Tailwind bridgés → skin-aware.
 */
function setupCodeMenu(vue, sharedRefs, ctx) {
    const { ref, computed, nextTick, watch } = vue;
    // (passe d'optimisation 2026-09-26) — parts stockées BRUTES : aucune n'est
    // jamais modifiée en place (une mise à jour la remplace par splice, et le
    // compteur ``_rev`` invalide le v-memo). La réactivité profonde ne faisait
    // qu'envelopper chaque sortie d'outil dans des proxies, que codeSteps
    // parcourait ensuite à chaque flush.
    const _raw = (typeof vue.markRaw === 'function') ? vue.markRaw : (x => x);
    const { currentView } = sharedRefs;
    // fetchAuth (réponse brute) EN PLUS de fetchJsonAuth : l'appairage doit
    // distinguer « code inconnu/expiré » (404) d'une vraie panne serveur —
    // fetchJsonAuth renvoie null dans les deux cas.
    const { showToast, fetchJsonAuth, fetchAuth, openConfirm } = ctx;

    // Rendu riche du transcript (_code_render.js, livré avec ce module).
    const render = (typeof setupCodeRender === 'function') ? setupCodeRender(vue) : null;

    // ── État ────────────────────────────────────────────────────────────
    const codeAvailable  = ref(true);
    const codeConnected  = ref(false);       // une CLI a poussé / tiré récemment
    const codeLoading    = ref(false);
    const codeSessions   = ref([]);
    const codeActiveId   = ref('');
    const codeMessages   = ref([]);          // [{id, role, parts:[…], info}]
    const codeBusy       = ref({});           // sid -> génération en cours ?
    const codeShowConnect = ref(false);
    const codeConfig     = ref({ app_url: '', token: '', plugin_url: '' });
    const codePluginStale = ref(false);       // un client actif a un plugin plus vieux
    const codePluginVersion = ref(0);         // min des versions des clients actifs
    const codePerms      = ref([]);           // demandes de validation opencode (session active)
    // Questions de l'outil `question` d'opencode (greffon v14) — BLOQUANTES :
    // le tour attend la réponse. Une demande = N sous-questions, chacune avec
    // des options (choix unique ou multiple) et, sauf `custom:false`, une
    // saisie libre. Sans cette bannière, la page voyait une session « occupée »
    // sans fin, la question n'étant visible que dans le terminal.
    const codeQuestions  = ref([]);           // [{id, sessionID, questions:[{question, header, options, multiple, custom}]}]
    const codeQPick      = ref({});           // qid -> [[libellés cochés] par sous-question]
    const codeQText      = ref({});           // qid + ':' + idx -> saisie libre
    const codeRenamingId = ref('');           // session en cours de renommage (landing)
    const codeRenameText = ref('');
    const codePrompt     = ref('');
    const codeSending    = ref(false);
    const codeRefreshing = ref(false);
    const codeCommands   = ref([]);           // slash commands de la CLI [{name, description, agent?, model?, has_args?}]
    const codeSlashIdx   = ref(0);
    const codeSlashDismissed = ref(false);    // Échap ferme le menu jusqu'à la prochaine frappe
    const transcriptEl   = ref(null);
    const codeInputRef   = ref(null);
    // Sélecteur /model : modèles remontés par la CLI (plugin v3+) + choix par session.
    const codeModels     = ref([]);           // [{id, name, models:[{id,name}]}]
    const codeModelsDefault = ref({});        // providerID -> modelID (défauts CLI)
    const codeModelOpen  = ref(false);
    const codeModelIdx   = ref(0);
    const codeModelSel   = ref({});           // sid -> {providerID, modelID, name}
    // Sélecteur d'agent (plugin v12+) : les MODES d'opencode — `build` (édite)
    // et `plan` (lecture seule), plus les agents primaires personnalisés. Côté
    // TUI c'est la touche tab ; depuis la page il n'existait aucun moyen d'en
    // changer, ni même de savoir dans lequel on était.
    const codeAgents      = ref([]);          // [{name, description}]
    const codeAgentDefault = ref('');         // agent par défaut de la CLI
    const codeAgentSel    = ref({});          // sid -> name (choix par session)
    // CLI connectées SANS session publiée. opencode ne matérialise la session
    // qu'au premier message : sans cette liste, la page affiche « CLI connectée »
    // au-dessus d'une liste vide, sans rien expliquer.
    const codeClients     = ref([]);           // [{id, directory, plugin_version}]
    // Picker /session : reprendre une autre session de la même CLI.
    const codeSessionOpen = ref(false);
    const codeSessionIdx  = ref(0);

    let evtSource = null, _sseAttempt = 0, _sseTimer = null, _healthTimer = null;
    // Le flux a-t-il déjà été ouvert depuis l'entrée sur la page ? (B8 : une
    // réouverture = trou possible → resynchronisation.)
    let _sseEverOpened = false;
    const _SSE_MAX = 30000;
    // Scroll lock : on ne colle au bas que si l'user y est déjà (± 120 px) —
    // il peut relire plus haut pendant que la session streame.
    let _codeStick = true;

    const activeSession = computed(() =>
        codeSessions.value.find(s => s.id === codeActiveId.value) || null);

    // ── Autocomplétion « / » (calquée sur le dropdown /skill du chat) ────
    // Fragment de commande en cours : le prompt commence par "/" et on est
    // encore sur le premier mot (pas d'espace/retour) — sinon null (menu fermé).
    // Le menu mélange les commandes de la CLI (poussées par le plugin) et les
    // commandes « app » exécutées par l'interface elle-même : /model ouvre le
    // sélecteur, les autres = actions NATIVES opencode relayées par le plugin
    // (endpoints session : revert/summarize/share/init/create — elles ne sont
    // pas dans command.list()). PAS de skills ici : la page pilote opencode.
    const APP_CMDS = [
        { name: 'model',   description: "Choisir le modèle d'inférence de la session", app: true },
        { name: 'session', description: 'Reprendre une autre session de cette CLI', app: true },
        { name: 'compact', description: 'Résumer la conversation (libère du contexte)', app: true, action: 'compact' },
        { name: 'undo',    description: 'Annuler le dernier échange', app: true, action: 'undo' },
        { name: 'redo',    description: "Rétablir l'échange annulé", app: true, action: 'redo' },
        { name: 'init',    description: 'Analyser le projet et créer AGENTS.md', app: true, action: 'init' },
        { name: 'share',   description: 'Partager la session (lien public)', app: true, action: 'share' },
        { name: 'unshare', description: 'Désactiver le partage de la session', app: true, action: 'unshare' },
        // `new` et `exit` ne sont PAS des actions de session : elles visent la CLI
        // elle-même. Elles passent donc par leurs endpoints à CIBLAGE STRICT
        // (/api/code/new, /api/code/clients/{cid}/exit) — cf. sendNewSession /
        // sendExit. Les router en action de session laissait le serveur choisir
        // le destinataire par propriétaire, donc potentiellement une AUTRE CLI
        // que celle affichée : la session naissait dans un opencode invisible.
        // `exit` doit rester ici : sans entrée `app`, un « /exit » tapé dans le
        // composer tombait dans le cas « commande inconnue » et partait comme
        // PROMPT au modèle.
        { name: 'new',     description: 'Créer une nouvelle session sur cette CLI', app: true, appFn: 'new' },
        { name: 'exit',    description: 'Fermer opencode sur cette CLI', app: true, appFn: 'exit' },
    ];
    // Modes de la CLI → une commande PAR agent primaire : /build, /plan, et les
    // agents primaires personnalisés s'il y en a. Construites depuis ce que la
    // CLI a réellement remonté (jamais en dur) : proposer /plan à une CLI qui ne
    // l'expose pas produirait un tour refusé, sans explication.
    const codeAgentCmds = computed(() => codeAgents.value.map(a => ({
        name: a.name,
        description: a.description || ('Basculer en mode ' + codeAgentLabel(a.name)),
        // `toAgent` et PAS `agent` : le dropdown affiche une pastille pour le
        // champ `agent` d'une commande CLI (l'agent qu'elle utilise) — ici elle
        // ferait doublon avec le nom de la commande elle-même.
        app: true, appFn: 'agent', toAgent: a.name,
    })));
    const codeAppCmds = computed(() => [...APP_CMDS, ...codeAgentCmds.value]);
    const codeSlashQuery = computed(() => {
        const m = codePrompt.value.match(/^\/(\S*)$/);
        return m ? m[1] : null;
    });
    const codeSlashList = computed(() => {
        const q = (codeSlashQuery.value || '').toLowerCase();
        const byName = (a, b) => a.name.localeCompare(b.name);
        const apps = codeAppCmds.value.filter(c => c.name.toLowerCase().includes(q));
        const all = codeCommands.value;
        const starts = all.filter(c => c.name.toLowerCase().startsWith(q));
        const contains = q ? all.filter(c => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)) : [];
        return [...apps.sort(byName), ...starts.sort(byName), ...contains.sort(byName)];
    });
    const codeSlashOpen = computed(() =>
        codeSlashQuery.value !== null && !codeSlashDismissed.value
        && !codeModelOpen.value && !codeSessionOpen.value && codeSlashList.value.length > 0);

    // snippet prêt à copier pour le panneau « Connecter » (l'install du plugin
    // passe par l'installeur OpenCode du menu chat — pas de curl manuel ici)
    const codeRemoteCmd = computed(() =>
        `/remote ${codeConfig.value.token || '<jeton>'}`);

    // ── Sélecteur /model ─────────────────────────────────────────────────
    // Liste aplatie (groupes provider rendus par le template au changement de
    // providerID) ; 1re entrée = « modèle par défaut » (efface le choix).
    const codeModelList = computed(() => {
        const out = [{ def: true, providerID: '', modelID: '', name: 'Modèle par défaut de la session',
                       provider: '' }];
        for (const p of codeModels.value) {
            for (const m of (p.models || [])) {
                out.push({ providerID: p.id, modelID: m.id, name: m.name || m.id,
                           provider: p.name || p.id });
            }
        }
        return out;
    });
    // Modèle choisi pour la session active (chip du composer).
    const codeModelChip = computed(() => {
        const sel = codeModelSel.value[codeActiveId.value];
        return sel ? (sel.name || sel.modelID) : '';
    });
    // Session pilotable ? (CLI propriétaire encore vivante — `connected` du store ;
    // absent sur un payload ancien → on ne bloque pas)
    const codeCanDrive = computed(() =>
        !!activeSession.value && activeSession.value.connected !== false);

    function openModelPicker() {
        if (!codeModels.value.length) loadModels();
        codeSlashDismissed.value = true;
        codeModelOpen.value = true;
        const sel = codeModelSel.value[codeActiveId.value];
        const i = sel ? codeModelList.value.findIndex(r =>
            r.providerID === sel.providerID && r.modelID === sel.modelID) : 0;
        codeModelIdx.value = i >= 0 ? i : 0;
        nextTick(() => { const el = codeInputRef.value; if (el) el.focus(); _scrollModelItem(codeModelIdx.value); });
    }
    function selectModel(row) {
        const sid = codeActiveId.value;
        if (!sid || !row) return;
        if (row.def) delete codeModelSel.value[sid];
        else codeModelSel.value = { ...codeModelSel.value,
            [sid]: { providerID: row.providerID, modelID: row.modelID, name: row.name } };
        codeModelOpen.value = false;
        nextTick(() => { const el = codeInputRef.value; if (el) el.focus(); });
    }
    function clearModel() {
        delete codeModelSel.value[codeActiveId.value];
        codeModelSel.value = { ...codeModelSel.value };
    }
    // ── Agent (mode plan / build) ────────────────────────────────────────
    // Agent EFFECTIF de la session : choix explicite de l'utilisateur, sinon
    // celui du dernier message assistant (ce que la CLI a réellement employé —
    // l'utilisateur a pu basculer avec tab côté TUI), sinon le défaut de la CLI.
    // C'est ce dernier point qui évite d'afficher « Build » alors que le TUI est
    // passé en Plan : la page reflète la CLI, elle ne la contredit pas.
    const codeAgentLive = computed(() => {
        const msgs = codeMessages.value;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const info = (msgs[i] && msgs[i].info) || {};
            if (info.agent) return String(info.agent);
        }
        return '';
    });
    const codeAgentCur = computed(() =>
        codeAgentSel.value[codeActiveId.value] || codeAgentLive.value || codeAgentDefault.value || '');
    // L'indicateur n'a de sens qu'avec au moins deux modes remontés.
    const codeAgentShow = computed(() => codeAgents.value.length > 1);
    const codeAgentLabel = (name) => name ? name.charAt(0).toUpperCase() + name.slice(1) : '';
    // Infobulle de l'indicateur : description de l'agent COURANT + comment en
    // changer. C'est le seul endroit qui explique la commande.
    const codeAgentDesc = computed(() => {
        const cur = codeAgentCur.value;
        const a = codeAgents.value.find(x => x.name === cur);
        const others = codeAgents.value.filter(x => x.name !== cur).map(x => '/' + x.name);
        return 'Mode ' + codeAgentLabel(cur) + (a && a.description ? ' — ' + a.description : '')
             + (others.length ? '\nChanger : ' + others.join(' ou ') : '');
    });
    function selectAgent(name) {
        const sid = codeActiveId.value;
        if (!sid || !name) return;
        const already = codeAgentCur.value === name;
        codeAgentSel.value = { ...codeAgentSel.value, [sid]: name };
        // Une commande doit CONFIRMER : sans retour, « /plan » ressemble à une
        // frappe perdue. Le mode ne prend effet qu'au prochain prompt — on le dit
        // plutôt que de laisser croire à une bascule immédiate côté CLI.
        showToast(already
            ? 'Déjà en mode ' + codeAgentLabel(name) + '.'
            : 'Mode ' + codeAgentLabel(name) + ' — appliqué au prochain message.',
            already ? 'info' : 'success');
        nextTick(() => { const el = codeInputRef.value; if (el) el.focus(); });
    }
    // Raccourci de la pastille : mode suivant — exactement ce que fait « tab »
    // dans le TUI. Même chemin que /plan et /build, pas une seconde mécanique.
    function cycleAgent() {
        const list = codeAgents.value;
        if (list.length < 2) return;
        const i = list.findIndex(a => a.name === codeAgentCur.value);
        selectAgent(list[(i + 1) % list.length].name);
    }
    function _scrollModelItem(idx) {
        nextTick(() => {
            const list = document.getElementById('code-model-list');
            const row = list && list.querySelectorAll('li[data-code-model-row]')[idx];
            if (row) row.scrollIntoView({ block: 'nearest' });
        });
    }

    // ── Jauge de contexte (header session) ──────────────────────────────
    // Occupation réelle de la fenêtre au prochain tour = tokens du DERNIER
    // message assistant (input + cache + output + reasoning, parité TUI) vs
    // limit.context du modèle de ce message (remontée par le plugin v5).
    const _fmtTk = (n) => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
    const codeCtx = computed(() => {
        const msgs = codeMessages.value;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const info = (msgs[i] && msgs[i].info) || {};
            if (info.role !== 'assistant' || !info.tokens || typeof info.tokens !== 'object') continue;
            const tk = info.tokens;
            const cache = (tk.cache && typeof tk.cache === 'object') ? tk.cache : {};
            const used = (tk.input || 0) + (cache.read || 0) + (cache.write || 0)
                       + (tk.output || 0) + (tk.reasoning || 0);
            if (!used) continue;
            let limit = 0;
            if (info.providerID && info.modelID) {
                const prov = codeModels.value.find(p => p.id === info.providerID);
                const mdl = prov && (prov.models || []).find(x => x.id === info.modelID);
                if (mdl && mdl.limit && mdl.limit.context > 0) limit = mdl.limit.context;
            }
            const pct = limit ? Math.min(999, Math.round(used * 100 / limit)) : 0;
            return {
                used, limit, pct,
                label: limit ? pct + '% ctx' : _fmtTk(used) + ' tk',
                title: limit
                    ? _fmtTk(used) + ' / ' + _fmtTk(limit) + ' tokens' + (info.modelID ? ' (' + info.modelID + ')' : '')
                    : _fmtTk(used) + ' tokens — limite du modèle inconnue (plugin v5 requis)',
            };
        }
        return null;
    });

    // CLI en attente = connectée, mais dont AUCUNE session n'est publiée.
    // C'est le cas signalé : opencode n'ouvre réellement la session qu'au premier
    // message, il n'y a donc rien à remonter — la page doit le dire plutôt que
    // d'afficher « CLI connectée » au-dessus d'une liste vide.
    const codeIdleClients = computed(() => {
        const withSession = new Set(codeSessions.value.map(s => s.client).filter(Boolean));
        return codeClients.value.filter(c => c && c.id && !withSession.has(c.id));
    });

    // ── Landing : sessions groupées connectées / historique ─────────────
    const codeSessionGroups = computed(() => {
        const live = [], past = [];
        for (const s of codeSessions.value) (s.connected !== false ? live : past).push(s);
        const out = [];
        if (live.length) out.push({ key: 'live', label: 'Connectées', sessions: live });
        if (past.length) out.push({ key: 'past', label: 'Historique', sessions: past });
        return out;
    });

    // ── Picker /session : reprendre une session de la MÊME CLI ──────────
    const codeSessionPickList = computed(() => {
        const cur = activeSession.value;
        return codeSessions.value.filter(s => s.id !== codeActiveId.value
            && s.connected !== false
            && (!cur || !cur.client || !s.client || s.client === cur.client));
    });
    function openSessionPicker() {
        loadSessions();                 // liste fraîche (badges connected à jour)
        codeSlashDismissed.value = true;
        codeModelOpen.value = false;
        codeSessionOpen.value = true;
        codeSessionIdx.value = 0;
        nextTick(() => { const el = codeInputRef.value; if (el) el.focus(); _scrollSessionItem(0); });
    }
    function pickSession(row) {
        codeSessionOpen.value = false;
        if (row && row.id) selectSession(row.id);
    }
    function _scrollSessionItem(idx) {
        nextTick(() => {
            const list = document.getElementById('code-session-list');
            const row = list && list.querySelectorAll('li[data-code-session-row]')[idx];
            if (row) row.scrollIntoView({ block: 'nearest' });
        });
    }

    // ── Renommage (landing) : la session opencode elle-même est renommée ──
    function startRename(s) {
        codeRenamingId.value = s.id;
        codeRenameText.value = s.title || '';
        nextTick(() => {
            const el = document.getElementById('code-rename-input');
            if (el) { el.focus(); el.select(); }
        });
    }
    function cancelRename() { codeRenamingId.value = ''; }
    async function submitRename() {
        const sid = codeRenamingId.value, title = codeRenameText.value.trim();
        codeRenamingId.value = '';
        if (!sid || !title) return;
        const r = await fetchJsonAuth(`/api/code/sessions/${sid}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title }),
        });
        // maj visuelle au round-trip session.updated (le plugin fait session.update)
        if (r && r.ok) showToast('Renommage envoyé à la CLI.', 'info');
    }

    // ── Permissions : demandes de validation opencode (bannière composer) ──
    async function loadPermissions(sid) {
        const d = await fetchJsonAuth(`/api/code/sessions/${sid}/permissions`, {}, { soft: true });
        if (Array.isArray(d) && sid === codeActiveId.value) codePerms.value = d;
    }
    async function replyPermission(perm, response) {
        const sid = codeActiveId.value;
        if (!sid || !perm || !perm.id) return;
        const r = await fetchJsonAuth(`/api/code/sessions/${sid}/permissions/${perm.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response }),
        });
        // retrait optimiste — le round-trip permission.replied confirme
        if (r && r.ok) codePerms.value = codePerms.value.filter(x => x.id !== perm.id);
    }

    // ── Questions : outil `question` (greffon v14) ─────────────────────────
    // Réponse = un tableau de libellés PAR sous-question, dans l'ordre (shape
    // QuestionReply d'opencode) ; la saisie libre est un libellé comme un autre.
    async function loadQuestions(sid) {
        const d = await fetchJsonAuth(`/api/code/sessions/${sid}/questions`, {}, { soft: true });
        if (Array.isArray(d) && sid === codeActiveId.value) codeQuestions.value = d;
    }
    const _qKey = (q, i) => q.id + ':' + i;
    function questionPicked(q, i, label) {
        return (((codeQPick.value[q.id] || [])[i]) || []).includes(label);
    }
    function toggleAnswer(q, i, label) {
        const all = { ...codeQPick.value };
        const rows = (all[q.id] || []).slice();
        const cur = (rows[i] || []).slice();
        const sq = (q.questions || [])[i] || {};
        const at = cur.indexOf(label);
        if (at !== -1) cur.splice(at, 1);
        else if (sq.multiple) cur.push(label);
        else cur.splice(0, cur.length, label);       // choix unique : remplace
        rows[i] = cur;
        all[q.id] = rows;
        codeQPick.value = all;
    }
    function questionAnswers(q) {
        return (q.questions || []).map((sq, i) => {
            const picked = (((codeQPick.value[q.id] || [])[i]) || []).slice();
            const free = String(codeQText.value[_qKey(q, i)] || '').trim();
            if (free) picked.push(free);
            return picked;
        });
    }
    // prêt = chaque sous-question a au moins une réponse (option ou texte)
    function questionReady(q) {
        const a = questionAnswers(q);
        return a.length > 0 && a.every(x => x.length > 0);
    }
    function _dropQuestion(qid) {
        codeQuestions.value = codeQuestions.value.filter(x => x.id !== qid);
        if (codeQPick.value[qid]) { const all = { ...codeQPick.value }; delete all[qid]; codeQPick.value = all; }
        const txt = { ...codeQText.value };
        let changed = false;
        for (const k of Object.keys(txt)) if (k.startsWith(qid + ':')) { delete txt[k]; changed = true; }
        if (changed) codeQText.value = txt;
    }
    async function answerQuestion(q, reject) {
        const sid = codeActiveId.value;
        if (!sid || !q || !q.id) return;
        if (!reject && !questionReady(q)) return;
        const body = reject ? { reject: true } : { answers: questionAnswers(q) };
        const r = await fetchJsonAuth(`/api/code/sessions/${sid}/questions/${q.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, { errorMsg: 'Réponse non transmise — CLI déconnectée ou plugin à mettre à jour (/remote update côté CLI).' });
        // retrait optimiste — le round-trip question.replied/rejected confirme
        if (r && r.ok) _dropQuestion(q.id);
    }

    // Temps relatif court pour la liste des sessions (time.updated opencode = ms).
    function codeAgo(t) {
        if (!t) return '';
        if (t > 1e12) t = t / 1000;
        const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
        if (s < 60) return "à l'instant";
        if (s < 3600) return 'il y a ' + Math.floor(s / 60) + ' min';
        if (s < 86400) return 'il y a ' + Math.floor(s / 3600) + ' h';
        return 'il y a ' + Math.floor(s / 86400) + ' j';
    }

    // ── Helpers ─────────────────────────────────────────────────────────
    function _scrollBottom(force) {
        if (!force && !_codeStick) return;
        nextTick(() => { const el = transcriptEl.value; if (el) el.scrollTop = el.scrollHeight; });
    }
    function onTranscriptScroll() {
        const el = transcriptEl.value;
        if (el) _codeStick = (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
    }
    // Génération en cours sur la session active ? (statut + Abort)
    //
    // Le drapeau du store ne suffit pas : il retombe sur `session.idle`, que
    // opencode 1.18 n'émet plus systématiquement (il publie `session.status`,
    // que le greffon v13 ne remonte pas). Sans garde-fou, l'indicateur reste
    // allumé sur une session terminée depuis longtemps. Un dernier message
    // assistant TERMINÉ est une preuve suffisante que plus rien ne tourne.
    const codeBusyActive = computed(() => {
        if (!codeBusy.value[codeActiveId.value]) return false;
        const msgs = codeMessages.value;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (!m || m.role !== 'assistant') continue;
            return !(((m.info || {}).time || {}).completed);
        }
        return true;
    });
    // Index du message que la CLI est en train d'écrire — c'est LUI qui porte
    // le statut d'activité (donc aligné sur sa propre colonne). -1 = la CLI
    // travaille sans avoir encore ouvert de message assistant.
    const codeLiveIdx = computed(() => {
        if (!codeBusyActive.value) return -1;
        const msgs = codeMessages.value;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (!m || m.role === 'note') continue;
            if (m.role !== 'assistant') return -1;
            return (((m.info || {}).time || {}).completed) ? -1 : i;
        }
        return -1;
    });
    // Erreur portée par un message assistant (opencode la met dans `info.error`).
    // Elle n'existait que le temps d'une toast — le transcript n'en gardait rien.
    function codeMsgError(m) {
        const e = (m && m.info && m.info.error) || null;
        if (!e || typeof e !== 'object') return null;
        const data = (e.data && typeof e.data === 'object') ? e.data : {};
        const msg = typeof data.message === 'string' ? data.message
            : typeof e.message === 'string' ? e.message : '';
        return { name: String(e.name || 'Erreur'), message: msg };
    }
    // Horloge du statut : armée pendant la génération, désarmée sinon — aucun
    // timer ne tourne au repos.
    if (render) watch(codeBusyActive, (v) => render.codeClock(v));
    function _setBusy(sid, v) {
        if (sid && !!codeBusy.value[sid] !== !!v) codeBusy.value = { ...codeBusy.value, [sid]: !!v };
    }
    function _mapMessages(raw) {
        return (raw || []).map(m => ({
            id: (m.info && m.info.id) || '',
            role: (m.info && m.info.role) || 'assistant',
            parts: (m.parts || []).map(p => (p && typeof p === 'object') ? _raw(p) : p),
            info: m.info || {},
        }));
    }

    // ── Chargement ──────────────────────────────────────────────────────
    async function loadHealth() {
        const d = await fetchJsonAuth('/api/code/health', {}, { soft: true });
        if (d) {
            codeAvailable.value = !!d.available;
            codeConnected.value = !!d.connected;
            codePluginVersion.value = d.plugin_version || 0;
            codePluginStale.value = !!(d.plugin_version && d.plugin_current
                && d.plugin_version < d.plugin_current);
        }
    }
    async function loadConfig() {
        const d = await fetchJsonAuth('/api/code/config', {}, { soft: true });
        if (d) codeConfig.value = d;
    }
    // (passe d'optimisation 2026-09-26) — opencode émet ``session.updated``
    // plusieurs fois par tour (horodatage, titre, résumé) : un GET complet +
    // le remplacement de codeSessions/codeBusy à CHAQUE fois. Regroupés.
    let _loadSessionsTimer = null;
    function _loadSessionsSoon() {
        if (_loadSessionsTimer) clearTimeout(_loadSessionsTimer);
        _loadSessionsTimer = setTimeout(() => { _loadSessionsTimer = null; loadSessions(); }, 400);
    }
    async function loadSessions() {
        const d = await fetchJsonAuth('/api/code/sessions', {}, { soft: true });
        if (Array.isArray(d)) {
            codeSessions.value = d;
            const b = {};
            d.forEach(s => { if (s && s.id) b[s.id] = !!s.busy; });
            // vérité serveur (persistée par le store) — réaffectée seulement si
            // elle change : un nouvel objet invalidait codeBusyActive puis le
            // v-memo de la ligne live, même à l'identique.
            const cur = codeBusy.value || {};
            const ks = Object.keys(b);
            if (ks.length !== Object.keys(cur).length || ks.some(k => cur[k] !== b[k])) {
                codeBusy.value = b;
            }
        }
    }
    async function loadMessages(sid) {
        const d = await fetchJsonAuth(`/api/code/sessions/${sid}/messages`, {}, { soft: true });
        codeMessages.value = _mapMessages(d);
        _scrollBottom();
    }
    async function loadCommands() {
        const d = await fetchJsonAuth('/api/code/commands', {}, { soft: true });
        if (Array.isArray(d)) codeCommands.value = d;
    }
    async function loadModels() {
        const d = await fetchJsonAuth('/api/code/models', {}, { soft: true });
        if (Array.isArray(d)) codeModels.value = d;                       // payload v3
        else if (d && Array.isArray(d.providers)) {
            codeModels.value = d.providers;
            codeModelsDefault.value = d.default || {};
        }
    }
    async function loadClients() {
        const d = await fetchJsonAuth('/api/code/clients', {}, { soft: true });
        if (Array.isArray(d)) codeClients.value = d;
    }
    async function loadAgents() {
        const d = await fetchJsonAuth('/api/code/agents', {}, { soft: true });
        if (d && Array.isArray(d.agents)) {
            codeAgents.value = d.agents;
            codeAgentDefault.value = d.default || '';
        }
    }

    // ── Actions ─────────────────────────────────────────────────────────
    async function openCodePage() {
        currentView.value = 'code';
        // on arrive TOUJOURS sur la liste des sessions (landing), jamais dans
        // une session résiduelle d'une visite précédente
        codeActiveId.value = '';
        codeMessages.value = [];
        codeModelOpen.value = false;
        codeSessionOpen.value = false;
        codePerms.value = [];
        codeQuestions.value = [];
        codeRenamingId.value = '';
        codeLoading.value = true;
        await loadHealth();
        // AUDIT 2026-09-01 (passe 5, F5) — l'utilisateur a pu QUITTER la page
        // pendant les await (Échap, clic sidebar) : disconnectStream() a déjà
        // tourné, et armer SSE + poll ICI les laissait orphelins, sans aucun
        // chemin d'arrêt (EventSource sain + 3 endpoints/15 s depuis le chat).
        if (currentView.value !== 'code') { codeLoading.value = false; return; }
        if (codeAvailable.value) {
            await Promise.all([loadConfig(), loadSessions(), loadCommands(), loadModels(),
                               loadAgents(), loadClients()]);
            if (currentView.value !== 'code') { codeLoading.value = false; return; }
            _sseEverOpened = false;          // état fraîchement chargé ci-dessus
            connectStream();
            // aide auto-ouverte si rien n'est encore connecté
            codeShowConnect.value = !codeSessions.value.length && !codeConnected.value;
            // le « connecté » (global + par session) vient du heartbeat pull →
            // rafraîchir pendant que la page est ouverte. (passe 5, F13) —
            // garde de visibilité : seul poll du dépôt qui tournait onglet
            // minimisé (12 req/min, idle-timeout serveur neutralisé).
            if (!_healthTimer) _healthTimer = setInterval(() => {
                if (document.visibilityState !== 'visible') return;
                loadHealth(); loadSessions(); loadClients();
            }, 15000);
        }
        codeLoading.value = false;
    }
    // Échap (chaîne globale app.js, listener en CAPTURE — le stopPropagation
    // du textarea ne suffit pas) : ferme les popovers de la page en priorité.
    // Retourne true si l'événement est consommé.
    function handleEscape() {
        if (codeRenamingId.value) { codeRenamingId.value = ''; return true; }
        if (codeSessionOpen.value) { codeSessionOpen.value = false; return true; }
        if (codeModelOpen.value) { codeModelOpen.value = false; return true; }
        if (codeSlashOpen.value) { codeSlashDismissed.value = true; return true; }
        if (codeShowConnect.value) { codeShowConnect.value = false; return true; }
        return false;
    }

    // Vue session → retour à la liste ; liste → retour au chat (chaîne Échap).
    function backToList() {
        codeActiveId.value = '';
        codeMessages.value = [];
        codeModelOpen.value = false;
        codeSessionOpen.value = false;
        codePerms.value = [];
        codeQuestions.value = [];
        if (render) render.resetCodeUi();
        loadSessions();
    }
    function closeCodePage() {
        if (codeActiveId.value) { backToList(); return; }
        currentView.value = 'chat';
        disconnectStream();
    }
    async function selectSession(sid) {
        codeActiveId.value = sid;
        codeModelOpen.value = false;
        codeSessionOpen.value = false;
        codePerms.value = [];
        codeQuestions.value = [];
        if (render) render.resetCodeUi();
        _codeStick = true;                    // nouvelle session → collé au bas
        await Promise.all([loadMessages(sid), loadPermissions(sid), loadQuestions(sid)]);
    }
    async function dismissSession(sid) {
        const r = await fetchJsonAuth(`/api/code/sessions/${sid}`, { method: 'DELETE' });
        if (r !== null) {
            if (codeActiveId.value === sid) { codeActiveId.value = ''; codeMessages.value = []; }
            await loadSessions();
        }
    }
    async function refreshSessions() {
        if (codeRefreshing.value) return;
        codeRefreshing.value = true;
        try {
            const jobs = [loadHealth(), loadSessions(), loadCommands(), loadModels()];
            if (codeActiveId.value) jobs.push(loadMessages(codeActiveId.value),
                                              loadPermissions(codeActiveId.value),
                                              loadQuestions(codeActiveId.value));
            await Promise.all(jobs);
        } finally {
            codeRefreshing.value = false;
        }
    }

    // autogrow du textarea (même comportement que le composer du chat)
    function _autoGrow() {
        const el = codeInputRef.value;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }
    function promptInput() {
        codeSlashDismissed.value = false;
        codeSlashIdx.value = 0;
        _autoGrow();
    }
    // Action native opencode (undo/redo/compact/share/…) → relayée par le plugin.
    async function sendAction(action) {
        const sid = codeActiveId.value;
        if (!sid) return;
        const r = await fetchJsonAuth(`/api/code/sessions/${sid}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
        });
        if (r && r.ok) showToast('Commande /' + action + ' envoyée à la CLI.', 'info');
    }

    // ── Commandes visant la CLI (pas une session) ─────────────────────────────
    // La cible est la CLI PROPRIÉTAIRE de la session ouverte : c'est le terminal
    // que l'utilisateur a sous les yeux. Sans cible explicite, le serveur route
    // par propriétaire de session et, si celui-ci est inconnu ou hors ligne,
    // n'importe quelle CLI connectée peut ramasser la commande — avec deux
    // opencode ouverts, la session se créait dans le mauvais (donc invisible).
    const codeActiveClient = computed(() => (activeSession.value || {}).client || '');

    // `target` explicite depuis la landing (une CLI connectée sans session) ;
    // sinon la CLI propriétaire de la session ouverte.
    async function sendNewSession(target) {
        const cid = (typeof target === 'string' && target) || codeActiveClient.value;
        const r = await fetchJsonAuth('/api/code/new', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cid ? { client: cid } : {}),
        });
        if (r && r.ok) {
            showToast('Nouvelle session demandée à la CLI.', 'info');
            // La session est créée POUR DE VRAI par le greffon (v13) puis
            // publiée : on rafraîchit sans attendre le prochain battement.
            setTimeout(() => { loadSessions(); loadClients(); }, 1200);
        }
    }

    async function sendExit() {
        const cid = codeActiveClient.value;
        if (!cid) { showToast('CLI inconnue pour cette session.', 'error'); return; }
        // Fermeture d'un process distant : irréversible depuis la page, donc on
        // confirme (une frappe « /exit » dans le composer ne doit pas tuer
        // l'opencode de quelqu'un par accident).
        const okGo = await openConfirm('Fermer opencode ?',
            'La CLI se ferme sur la machine distante ; les sessions restent dans l\'historique.');
        if (!okGo) return;
        const r = await fetchJsonAuth(`/api/code/clients/${encodeURIComponent(cid)}/exit`,
                                      { method: 'POST' });
        if (r && r.ok) showToast('Fermeture demandée à la CLI.', 'info');
    }
    function selectSlash(c) {
        if (!c) return;
        if (c.app) {
            // commande exécutée par l'INTERFACE (pas une slash command CLI) :
            // /model → sélecteur ; les autres → action native relayée.
            codePrompt.value = '';
            codeSlashDismissed.value = true;
            nextTick(_autoGrow);
            if (c.name === 'model') openModelPicker();
            else if (c.name === 'session') openSessionPicker();
            else if (c.appFn === 'agent') selectAgent(c.toAgent);
            else if (c.appFn === 'new') sendNewSession();
            else if (c.appFn === 'exit') sendExit();
            else if (c.action) sendAction(c.action);
            return;
        }
        codePrompt.value = '/' + c.name + ' ';
        codeSlashDismissed.value = true;    // menu fermé, l'user tape les arguments
        nextTick(() => { const el = codeInputRef.value; if (el) { el.focus(); _autoGrow(); } });
    }
    // Garde l'item actif visible pendant la nav clavier (clone de _scrollSkillItem).
    function _scrollSlashItem(idx) {
        nextTick(() => {
            const list = document.getElementById('code-slash-list');
            const row = list && list.querySelectorAll('li[data-code-slash-row]')[idx];
            if (row) row.scrollIntoView({ block: 'nearest' });
        });
    }
    function promptKeydown(e) {
        // Picker /session ouvert : priorité maximale (session > model > slash).
        if (codeSessionOpen.value) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                codeSessionIdx.value = Math.min(codeSessionIdx.value + 1, codeSessionPickList.value.length - 1);
                _scrollSessionItem(codeSessionIdx.value);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                codeSessionIdx.value = Math.max(codeSessionIdx.value - 1, 0);
                _scrollSessionItem(codeSessionIdx.value);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickSession(codeSessionPickList.value[codeSessionIdx.value]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                codeSessionOpen.value = false;
                return;
            }
        }
        // Sélecteur /model ouvert : il capte la navigation avant le menu slash.
        if (codeModelOpen.value) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                codeModelIdx.value = Math.min(codeModelIdx.value + 1, codeModelList.value.length - 1);
                _scrollModelItem(codeModelIdx.value);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                codeModelIdx.value = Math.max(codeModelIdx.value - 1, 0);
                _scrollModelItem(codeModelIdx.value);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                selectModel(codeModelList.value[codeModelIdx.value]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                codeModelOpen.value = false;
                return;
            }
        }
        if (codeSlashOpen.value) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                codeSlashIdx.value = Math.min(codeSlashIdx.value + 1, codeSlashList.value.length - 1);
                _scrollSlashItem(codeSlashIdx.value);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                codeSlashIdx.value = Math.max(codeSlashIdx.value - 1, 0);
                _scrollSlashItem(codeSlashIdx.value);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                selectSlash(codeSlashList.value[codeSlashIdx.value]);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();        // ne pas déclencher la chaîne Échap globale
                codeSlashDismissed.value = true;
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendPrompt();
        }
    }

    // Retire les échos optimistes (tous, ou un seul par id).
    function _dropPending(id) {
        codeMessages.value = codeMessages.value.filter(x => !(x.pending && (!id || x.id === id)));
    }
    async function sendPrompt() {
        const sid = codeActiveId.value, text = codePrompt.value.trim();
        if (!sid || !text || codeSending.value) return;
        // « /commande args » connue → vraie slash command opencode ; sinon prompt.
        const m = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
        // commande « app » tapée à la main (/model, /plan, /undo, /compact…) →
        // l'interface la traite. ⚠ `codeAppCmds` et PAS `APP_CMDS` : les modes
        // (/build, /plan) sont dérivés de ce que la CLI expose, donc absents de
        // la liste statique — tapés à la main ils seraient partis au modèle
        // comme un prompt ordinaire.
        const appCmd = m && codeAppCmds.value.find(c => c.name === m[1]);
        if (appCmd) {
            codePrompt.value = '';
            nextTick(_autoGrow);
            if (appCmd.name === 'model') openModelPicker();
            else if (appCmd.name === 'session') openSessionPicker();
            else if (appCmd.appFn === 'agent') selectAgent(appCmd.toAgent);
            else if (appCmd.appFn === 'new') sendNewSession();
            else if (appCmd.appFn === 'exit') sendExit();
            else if (appCmd.action) sendAction(appCmd.action);
            return;
        }
        const known = m && codeCommands.value.find(c => c.name === m[1]);
        codeSending.value = true;
        // Écho optimiste : bulle user « pending » (horloge + opacité réduite),
        // remplacée quand la CLI renvoie le vrai message par l'ingest.
        const pending = { id: 'pending-' + Date.now(), role: 'user', pending: true,
                          info: { role: 'user' },
                          parts: [{ id: 'p0', type: 'text', text }] };
        codeMessages.value.push(pending);
        _scrollBottom(true);
        try {
            const r = known
                ? await fetchJsonAuth(`/api/code/sessions/${sid}/command`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: m[1], arguments: m[2] || '' }),
                })
                : await fetchJsonAuth(`/api/code/sessions/${sid}/prompt`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // modèle de la session choisi via /model (sinon défaut opencode)
                    // + agent (mode plan/build) : envoyé UNIQUEMENT quand
                    // l'utilisateur a choisi explicitement, pour ne pas figer le
                    // mode que le TUI vient éventuellement de changer avec tab.
                    body: JSON.stringify(Object.assign(
                        { text },
                        codeModelSel.value[sid]
                            ? { model: { providerID: codeModelSel.value[sid].providerID,
                                         modelID: codeModelSel.value[sid].modelID } }
                            : {},
                        codeAgentSel.value[sid] ? { agent: codeAgentSel.value[sid] } : {})),
                });
            if (r && r.ok) {
                codePrompt.value = '';      // le vrai message reviendra via les events
                nextTick(_autoGrow);
            } else {
                _dropPending(pending.id);   // refus/injoignable — toast déjà émis par fetchJsonAuth
            }
        } finally {
            codeSending.value = false;
        }
    }
    async function abortSession() {
        const sid = codeActiveId.value;
        if (!sid) return;
        const r = await fetchJsonAuth(`/api/code/sessions/${sid}/abort`, { method: 'POST' });
        if (r && r.ok) showToast('Interruption demandée.', 'info');
    }
    async function rotateToken() {
        const d = await fetchJsonAuth('/api/code/token/rotate', { method: 'POST' });
        if (d && d.token) {
            codeConfig.value = { ...codeConfig.value, token: d.token };
            showToast('Nouveau jeton généré — ré-appairez vos postes avec /remote login.', 'success');
        }
    }

    // ── Appairage par code (device flow) ───────────────────────────────────────
    // `/remote login` côté CLI ouvre la demande et affiche un code à 6 caractères ;
    // c'est ICI qu'on le confirme, depuis une session web authentifiée — c'est ce
    // qui rattache le poste au bon utilisateur. L'endpoint existait déjà
    // (/api/code/pair/confirm) mais la page n'offrait aucune saisie : la CLI
    // renvoyait vers un panneau qui ne demandait rien.
    const codePairCode = ref('');
    const codePairBusy = ref(false);
    async function submitPairCode() {
        const raw = String(codePairCode.value || '');
        // Le code est affiché « ABC-123 » : on tolère tiret, espaces et minuscules.
        const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length !== 6) {
            showToast('Le code d\'appairage fait 6 caractères.', 'error');
            return;
        }
        codePairBusy.value = true;
        try {
            const res = await fetchAuth('/api/code/pair/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            }, true);                       // soft : on rend le message nous-mêmes
            if (!res) return;               // réseau / 401 : déjà géré en amont
            if (res.ok) {
                codePairCode.value = '';
                showToast('Poste appairé — la session va apparaître.', 'success');
                refreshSessions();
            } else if (res.status === 404) {
                showToast('Code inconnu ou expiré — relancez /remote login.', 'error');
            } else if (res.status === 429) {
                showToast('Trop d\'essais — réessayez dans quelques minutes.', 'error');
            } else {
                showToast('Appairage impossible (HTTP ' + res.status + ').', 'error');
            }
        } finally {
            codePairBusy.value = false;
        }
    }
    // Copie robuste : navigator.clipboard n'existe PAS en contexte non sécurisé
    // (HTTP sur le LAN, déploiement courant ici) et writeText est asynchrone —
    // l'ancienne version annonçait « Copié » avant la résolution et échouait en
    // silence si l'API manquait. Repli execCommand + toast APRÈS résolution.
    function _copyTextFallback(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (_) { return false; }
    }
    function copyText(t) {
        const ok   = () => showToast('Copié', 'success');
        const fail = () => { if (_copyTextFallback(t)) ok(); else showToast('Copie impossible', 'error'); };
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(t).then(ok).catch(fail);
        } else {
            fail();
        }
    }

    // ── SSE : events ingérés (rediffusés) ──────────────────────────────
    function _upsertMessage(info) {
        if (!info || !info.id || info.sessionID !== codeActiveId.value) return;
        // le vrai message user est arrivé par l'ingest → retirer les échos optimistes
        if (info.role === 'user') _dropPending();
        let m = codeMessages.value.find(x => x.id === info.id);
        if (!m) codeMessages.value.push({ id: info.id, role: info.role || 'assistant', parts: [], info });
        else { m.role = info.role || m.role; m.info = info; m._rev = (m._rev || 0) + 1; }
    }
    // Pendant qu'un bloc thinking OUVERT streame, garder son <pre> collé au bas
    // (pattern du chat : rAF sur [data-code-think][open] pre).
    function _syncThinkScroll() {
        requestAnimationFrame(() => {
            const el = transcriptEl.value;
            if (!el) return;
            el.querySelectorAll('details[data-code-think][open] pre')
              .forEach(p => { p.scrollTop = p.scrollHeight; });
        });
    }
    function _applyPart(part) {
        if (!part || !part.messageID || part.sessionID !== codeActiveId.value) return false;
        let m = codeMessages.value.find(x => x.id === part.messageID);
        if (!m) {
            m = { id: part.messageID, role: 'assistant', parts: [],
                  info: { id: part.messageID, role: 'assistant', sessionID: part.sessionID } };
            codeMessages.value.push(m);
        }
        const i = m.parts.findIndex(p => p.id === part.id);
        if (i === -1) m.parts.push(_raw(part)); else m.parts.splice(i, 1, _raw(part));
        // (passe 6, F3) — compteur de révision : c'est LUI qui invalide le
        // v-memo de cette ligne du transcript ; les autres lignes ne re-diffent
        // plus à chaque delta.
        m._rev = (m._rev || 0) + 1;
        return true;
    }
    // AUDIT 2026-09-01 (passe 6, F4) — coalescence : opencode émet un
    // ``message.part.updated`` par delta, et chaque application faisait une
    // mutation réactive + un nextTick avec lecture de layout
    // (scrollHeight/scrollTop) — un layout forcé PAR ÉVÉNEMENT dès que la CLI
    // génère vite. On tamponne et on applique par rafale de 40 ms (même
    // cadence que le flush du chat principal) : une mutation + UN scroll.
    let _partBuf = [];
    let _partTimer = null;
    function _flushPartBuf() {
        _partTimer = null;
        // Chaque ``message.part.updated`` porte la part COMPLÈTE : dans une
        // rafale, seule la dernière version d'une part compte (on garde sa
        // position d'apparition, l'ordre des parts nouvelles est préservé).
        const last = new Map();
        for (const part of _partBuf) if (part && part.id) last.set(part.id, part);
        const buf = _partBuf.filter(part => !(part && part.id) || last.get(part.id) === part);
        _partBuf = [];
        let applied = false, think = false;
        for (const part of buf) {
            if (_applyPart(part)) {
                applied = true;
                if (part.type === 'reasoning') think = true;
            }
        }
        if (!applied) return;
        // thinking REPLIÉ par défaut (pas d'auto-ouverture) : le libellé animé
        // signale l'activité ; si l'user l'a ouvert, garder le <pre> collé au bas.
        if (think) _syncThinkScroll();
        _scrollBottom();
    }
    function _upsertPart(part) {
        _partBuf.push(part);
        if (_partTimer === null) _partTimer = setTimeout(_flushPartBuf, 40);
    }
    function _onEvent(ev) {
        const t = ev.type, p = ev.properties || {};
        if (t === 'client.disconnected') {
            // fermeture propre d'opencode (bye) : refléter l'état réel tout de
            // suite — surtout ne PAS forcer codeConnected à true pour cet event
            loadHealth();
            loadSessions();
            return;
        }
        codeConnected.value = true;
        if (t === 'message.updated') {
            _upsertMessage(p.info);
            const info = p.info || {};
            if (info.role === 'assistant' && info.sessionID) {
                _setBusy(info.sessionID, !((info.time || {}).completed));
            }
        }
        else if (t === 'message.part.updated') {
            _upsertPart(p.part);
            if (p.part && p.part.sessionID) _setBusy(p.part.sessionID, true);
        }
        else if (t === 'message.removed') {
            // /undo côté CLI (ou côté page) : le message n'existe plus là-bas,
            // il ne doit plus exister ici. Sans ça il restait à l'écran jusqu'au
            // prochain rechargement — la page contredisait la CLI.
            if (p.sessionID === codeActiveId.value && p.messageID) {
                codeMessages.value = codeMessages.value.filter(x => x.id !== p.messageID);
                // (passe 7, R9) — une part encore dans le tampon 40 ms
                // recréerait le message supprimé au flush (_applyPart
                // re-crée un message absent) : on la purge.
                _partBuf = _partBuf.filter(x => !x || x.messageID !== p.messageID);
            }
        }
        else if (t === 'session.snapshot') {
            // historique complet ré-ingéré : recharger liste + transcript actif
            loadSessions();
            const sid = (p.session || {}).id;
            if (sid && sid === codeActiveId.value) loadMessages(sid);
        }
        else if (t === 'client.commands') { if (Array.isArray(p.commands)) codeCommands.value = p.commands; }
        else if (t === 'client.models') {
            if (Array.isArray(p.providers)) codeModels.value = p.providers;
            if (p.default && typeof p.default === 'object') codeModelsDefault.value = p.default;
        }
        else if (t === 'client.agents') {
            if (Array.isArray(p.agents)) codeAgents.value = p.agents;
            if (p.default) codeAgentDefault.value = String(p.default);
        }
        else if (t === 'code.note') {
            // trace de commande (/cmd, /action) posée par l'app → timeline live
            const note = p.note;
            if (note && note.info && p.sessionID === codeActiveId.value
                && !codeMessages.value.some(x => x.id === note.info.id)) {
                codeMessages.value.push({ id: note.info.id, role: 'note', parts: [], info: note.info });
                _scrollBottom();
            }
        }
        else if (t === 'permission.updated') {
            // demande de validation opencode → bannière au-dessus du composer
            if (p.id && p.sessionID === codeActiveId.value) {
                const i = codePerms.value.findIndex(x => x.id === p.id);
                if (i === -1) codePerms.value.push(p);
                else codePerms.value.splice(i, 1, p);
            }
        }
        else if (t === 'permission.replied') {
            // répondu (depuis la page OU le TUI) → la bannière disparaît
            if (p.sessionID === codeActiveId.value) {
                codePerms.value = codePerms.value.filter(x => x.id !== p.permissionID);
            }
        }
        else if (t === 'question.asked') {
            // question de l'outil `question` (greffon v14) → bannière au-dessus du composer
            if (p.id && p.sessionID === codeActiveId.value) {
                const i = codeQuestions.value.findIndex(x => x.id === p.id);
                if (i === -1) codeQuestions.value.push(p);
                else codeQuestions.value.splice(i, 1, p);
            }
        }
        else if (t === 'question.replied' || t === 'question.rejected') {
            // répondu ou refusé (depuis la page OU le TUI) → la bannière disparaît
            if (p.sessionID === codeActiveId.value && p.questionID) _dropQuestion(p.questionID);
        }
        else if (t === 'session.idle') _setBusy(p.sessionID || (p.info || {}).id, false);
        else if (t === 'session.created' || t === 'session.updated' || t === 'session.deleted') _loadSessionsSoon();
        else if (t === 'session.error') {
            _setBusy(p.sessionID || (p.info || {}).id, false);
            const msg = (p.error && p.error.data && p.error.data.message) || (p.error && p.error.name) || '';
            if (msg) showToast('opencode : ' + msg, 'error');
        }
    }
    function connectStream() {
        disconnectStream();
        // AUDIT 2026-08-02 (S2) — garde d'auth : session expirée = boucle de
        // reconnexion infinie sur 401 sinon (même motif que _system_sse.js).
        if (ctx.user && !ctx.user.value) return;
        try { evtSource = new EventSource('/api/code/stream', { withCredentials: true }); }
        catch (e) { _scheduleReconnect(); return; }
        evtSource.onopen = () => {
            _sseAttempt = 0;
            // AUDIT moteur d'événements 2026-09-25 (B8) — le bus n'a pas de
            // rejeu : tout ce qui a été émis pendant la coupure (recyclage de
            // worker, réseau, reconnexion native du navigateur) est perdu.
            // Sans resynchronisation, le transcript restait troué et un
            // ``session.idle`` manqué laissait le spinner « occupé » tourner.
            // À chaque (ré)ouverture qui n'est pas la première, on relit
            // l'état serveur.
            if (_sseEverOpened) _resyncAfterGap();
            _sseEverOpened = true;
        };
        evtSource.onmessage = (e) => {
            let d; try { d = JSON.parse(e.data); } catch (_) { return; }
            if (d && d.__control) { _onControl(d.__control); return; }
            try { _onEvent(d); } catch (_) {}
        };
        evtSource.onerror = () => {
            if (evtSource && evtSource.readyState === 2) {
                try { evtSource.close(); } catch (_) {}
                evtSource = null;
                if (currentView.value === 'code') _scheduleReconnect();
            }
        };
    }
    // Messages de contrôle du flux (enveloppe ``__control``, cf. routes_code
    // ``_STREAM_CONTROL_TYPES``) — audit moteur d'événements 2026-09-25 (B2).
    function _onControl(c) {
        const t = c && c.type;
        if (t === 'session_expired') {
            // Revalidation serveur ou révocation : purge + écran de connexion
            // (handler partagé d'app.js) — plus de boucle de 401 muette.
            disconnectStream();
            if (ctx.handleSessionExpired) ctx.handleSessionExpired();
        } else if (t === 'worker_recycling') {
            // Worker qui s'arrête : reconnexion silencieuse sur un worker sain,
            // puis resynchronisation (onopen).
            if (evtSource) { try { evtSource.close(); } catch (_) {} evtSource = null; }
            if (_sseTimer) { clearTimeout(_sseTimer); }
            _sseTimer = setTimeout(() => { _sseTimer = null; if (currentView.value === 'code') connectStream(); }, 750);
        } else if (t === 'error') {
            // Ex. trop de flux ouverts : fermer NOUS-MÊMES, sinon le navigateur
            // se reconnecte toutes les ~3 s sans backoff.
            if (evtSource) { try { evtSource.close(); } catch (_) {} evtSource = null; }
            if (currentView.value === 'code') _scheduleReconnect();
        }
    }
    function _resyncAfterGap() {
        loadHealth();
        loadSessions();
        if (codeActiveId.value) loadMessages(codeActiveId.value);
    }
    function _scheduleReconnect() {
        if (_sseTimer) return;
        const delay = Math.min(1000 * Math.pow(2, _sseAttempt++), _SSE_MAX);
        _sseTimer = setTimeout(() => { _sseTimer = null; if (currentView.value === 'code') connectStream(); }, delay);
    }
    function disconnectStream() {
        if (_sseTimer) { clearTimeout(_sseTimer); _sseTimer = null; }
        if (_loadSessionsTimer) { clearTimeout(_loadSessionsTimer); _loadSessionsTimer = null; }
        if (_healthTimer) { clearInterval(_healthTimer); _healthTimer = null; }
        if (evtSource) { try { evtSource.close(); } catch (_) {} evtSource = null; }
        // Quitter la page ne doit laisser AUCUN timer derrière soi (l'horloge du
        // statut compris : le watch ne repasse pas si la session reste « busy »).
        if (render) render.codeClock(false);
    }

    // AUDIT 2026-08-02 (E7) — la page Code échappait à la purge de logout (S3) :
    // ``currentView`` restait 'code', aucune reconnexion au login, et l'état
    // n'était vidé nulle part → l'utilisateur suivant, dans le même onglet,
    // voyait les sessions opencode, le transcript ET le token du compte
    // précédent. On coupe le flux ET on vide tout l'état sensible.
    function codeResetOnLogout() {
        try { disconnectStream(); } catch (_) {}
        codeSessions.value    = [];
        codeMessages.value    = [];
        codeActiveId.value    = '';
        codeConnected.value   = false;
        codeShowConnect.value = false;
        codePerms.value       = [];
        codeBusy.value        = {};
        codePrompt.value      = '';
        codeSending.value     = false;
        codeCommands.value    = [];
        codeAgents.value      = [];
        codeClients.value     = [];
        codeAgentDefault.value = '';
        codeAgentSel.value    = {};
        codePairCode.value    = '';
        codeConfig.value      = { app_url: '', token: '', plugin_url: '' };
        codePluginStale.value = false;
    }

    return {
        // rendu riche du transcript (helpers + état de repli, _code_render.js)
        ...(render || {}),
        // état
        codeAvailable, codeConnected, codeLoading, codeSessions, codeActiveId,
        codeMessages, codeBusy, codeBusyActive, codeLiveIdx, codeMsgError,
        codeShowConnect, codeConfig,
        codePluginStale, codePrompt, codeSending,
        codeRefreshing, codeCommands, codeSlashIdx, codeSlashOpen, codeSlashList,
        codeSlashQuery, transcriptEl, codeInputRef, activeSession, codeRemoteCmd,
        codeModels, codeModelsDefault, codeModelOpen, codeModelIdx, codeModelList,
        codeModelChip, codeModelSel, codeCanDrive, codeAgo, codeCtx,
        codeClients, codeIdleClients,
        codeAgents, codeAgentDefault, codeAgentSel, codeAgentCur, codeAgentShow,
        codeAgentLabel, codeSelectAgent: selectAgent, codeAgentDesc,
        codeCycleAgent: cycleAgent,
        codePluginVersion, codePerms, codeQuestions, codeQPick, codeQText,
        codeSessionGroups, codeSessionPickList,
        codeSessionOpen, codeSessionIdx, codeRenamingId, codeRenameText,
        // actions
        openCodePage, closeCodePage, codeBackToList: backToList,
        codeEscape: handleEscape,
        codeOpenModelPicker: openModelPicker, codeSelectModel: selectModel,
        codeClearModel: clearModel, codeSetModelIdx: (i) => { codeModelIdx.value = i; },
        codeOpenSessionPicker: openSessionPicker, codePickSession: pickSession,
        codeSetSessionIdx: (i) => { codeSessionIdx.value = i; },
        codeStartRename: startRename, codeCancelRename: cancelRename,
        codeSubmitRename: submitRename, codeReplyPermission: replyPermission,
        codeAnswerQuestion: answerQuestion, codeToggleAnswer: toggleAnswer,
        codeQuestionPicked: questionPicked, codeQuestionReady: questionReady,
        codeSelectSession: selectSession, codeDismissSession: dismissSession,
        codeSendPrompt: sendPrompt, codeAbortSession: abortSession,
        codeRefreshSessions: refreshSessions,
        codeTranscriptScroll: onTranscriptScroll,
        codePromptKeydown: promptKeydown, codePromptInput: promptInput,
        codeSelectSlash: selectSlash, codeSetSlashIdx: (i) => { codeSlashIdx.value = i; },
        codeRotateToken: rotateToken, codeCopy: copyText,
        codeActiveClient, codeNewSession: sendNewSession, codeExit: sendExit,
        codePairCode, codePairBusy, codeSubmitPairCode: submitPairCode,
        codeDisconnectStream: disconnectStream,
        codeResetOnLogout,
    };
}
