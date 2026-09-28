// SPDX-License-Identifier: MIT
/*
 * chat/_skills_menu.js — SKILLS management page.
 *
 * Backs the "Skills" sidebar navigation entry (à la Claude "Projects").
 * Selecting it switches the main view (currentView='skills') to a FULL
 * PAGE that replaces the chat column — not a modal overlay. The page lists
 * every skill grouped by scope (global / learned / perso), and supports
 * view / create / edit / delete, plus learned->global promotion (admin
 * only — 403 enforced).
 *
 * -- Architecture fit -------------------------------------------------
 * This is a standard "module factory" like the other setupChat* /
 * setupSettings modules: it is loaded as a plain <script> BEFORE app.js
 * (UMD Vue in window.Vue, no ESM/build). app.js calls
 *     setupSkillsMenu(Vue, sharedRefs, ctx)
 * and spreads the returned {refs, methods} into the root setup() return so
 * the bindings below are usable in the .html fragments.
 *
 *   - Gating                  : settingsTab==='skills' (modal Paramètres) gates the
 *                               page; busy/error/list/form refs live below.
 *   - Entrée dans l'onglet    : openSkillsTab() reset + recharge (flip
 *                               currentView; clicking a chat or "Nouveau Chat"
 *                               also resets it to 'chat' (chat/_history.js).
 *
 * -- Endpoints (all via ctx.fetchAuth, session-cookie auth) -----------
 *   GET    /api/skills?scope=user|learned|global   un-merged inventory
 *   GET    /api/skills/{name}?scope=               summary + full body
 *   POST   /api/skills        {scope,name,description,body,tags,domain}
 *   PUT    /api/skills/{name}  (same body)          idempotent update
 *   DELETE /api/skills/{name}?scope=                scoped delete
 *   POST   /api/skills/promote {name}               learned->global (admin)
 * Sous-skills (`pkg/child`) : un `/` dans le path ne matche pas la route →
 * {name} = name de FEUILLE + `?id=<id qualifié>` en query (GET/PUT/DELETE/
 * export). La liste expose id/parent_id/depth/is_folder/files : l'arbre
 * (skillsTreeByScope) est construit ici, rendu par <skill-tree-node>.
 *
 * fetchAuth() returns null on 401 / network error, so every call is guarded
 * with `if (res && res.ok)`.
 */
function setupSkillsMenu(vue, sharedRefs, ctx) {
    const { ref, computed } = vue;
    const { user } = sharedRefs;
    const { showToast, fetchAuth, openConfirm, announce, nextTick } = ctx;

    // -- Tab data state (l'onglet vit dans la modal Paramètres,
    //    gated sur settingsTab === 'skills') ----
    const skillsLoading   = ref(false);    // list fetch in flight
    const skillsError     = ref('');       // last load error (banner)
    const skillsBusy      = ref(false);    // a mutation is in flight
    const skillsFilter    = ref('');       // text filter (name/desc/domain)

    // Inventory by scope (un-merged real storage per source).
    const skillsByScope = ref({ user: [], learned: [], global: [] });

    // Detail / editor panel. mode: '' | 'view' | 'create' | 'edit'.
    const skillEditMode = ref('');
    const skillDetail   = ref(null);       // selected skill summary (+ body)
    const skillForm     = ref(_emptyForm());
    const skillFileView = ref(null);        // {path, content, loading} d'un fichier ouvert (lecture seule)
    const collapsedSkills = ref(new Set()); // ids des skills repliés dans l'arbre
    // Renommé showSkillImportMenu (2026-07-18) : l'éditeur exporte déjà un
    // ``showImportMenu`` qui GAGNE au spread du root (app.js) — collision.
    const showSkillImportMenu = ref(false); // menu « Importer » (.zip / dossier / .md) de la toolbar
    const importMenuBtn  = ref(null);       // déclencheur du menu (focus de retour à Échap)
    const skillsImporting = ref('');        // '' | 'zip' | 'folder' | 'md' — import en vol (busy header)
    const skillBodyView  = ref('rendered'); // 'rendered' | 'source' — corps + fichiers .md du détail
    const skillsDragOver = ref(false);      // overlay drag-and-drop de la page
    let   _skillsDragDepth = 0;             // compteur enter/leave (même recette que chat/_dnd.js)
    // Jeton de navigation : tout changement de sélection l'incrémente ; un fetch
    // de corps asynchrone qui revient APRÈS une navigation est ignoré (anti-race).
    let   _navSeq       = 0;

    function _emptyForm() {
        return { scope: 'user', name: '', description: '', domain: '', tags: '', body: '', _original: '', _depth: 0 };
    }

    // Miroir EXACT du gate backend des skills (_require_admin → is_admin == 1
    // STRICT). Les modérateurs (is_admin=2) reçoivent 403 côté serveur : on ne
    // leur montre donc PAS de contrôles learned/global qui échoueraient (dead
    // controls). is_admin étant exposé en booléen par /me-lite (vrai pour admin
    // ET modérateur), on discrimine sur le rôle.
    const isAdmin = computed(() => {
        const u = user.value;
        return !!(u && u.role === 'admin');
    });

    // Notifie les autres modules (menu /skill de la barre de prompt) qu'un CRUD
    // skill vient d'avoir lieu → ils invalident leur cache au lieu d'attendre
    // l'expiration du TTL.
    function _notifySkillsChanged() {
        try { window.dispatchEvent(new CustomEvent('skills:changed')); } catch (e) { /* noop */ }
    }

    // Scopes the current user is allowed to mutate. 'user' is always
    // editable; learned/global require admin (the backend enforces this with
    // 403 — we mirror it in the UI so we don't show dead controls).
    const editableScopes = computed(() => isAdmin.value
        ? ['user', 'learned', 'global']
        : ['user']);

    function canEditScope(scope) { return editableScopes.value.indexOf(scope) !== -1; }

    // Live-filtered groups for the template (keeps source ordering).
    const filteredByScope = computed(() => {
        const q = skillsFilter.value.trim().toLowerCase();
        const out = { user: [], learned: [], global: [] };
        for (const scope of ['global', 'learned', 'user']) {
            const list = skillsByScope.value[scope] || [];
            out[scope] = !q ? list : list.filter(s => {
                const hay = ((s.name || '') + ' ' + (s.description || '') + ' ' +
                             (s.domain || '') + ' ' + ((s.tags || []).join(' '))).toLowerCase();
                return hay.indexOf(q) !== -1;
            });
        }
        return out;
    });

    const totalSkillsCount = computed(() =>
        (skillsByScope.value.user || []).length +
        (skillsByScope.value.learned || []).length +
        (skillsByScope.value.global || []).length);

    const filteredTotalCount = computed(() => {
        const f = filteredByScope.value;
        return (f.user || []).length + (f.learned || []).length + (f.global || []).length;
    });

    // -- Entrée dans l'onglet Skills de la modal Paramètres -----------
    // Reset à CHAQUE entrée d'onglet (recette de l'ex-openSkillsPage) : pas de
    // détail/filtre/menu périmés d'une visite à l'autre. Pas de close dédié —
    // la fermeture de la modal ne reset rien, la prochaine entrée s'en charge.
    function openSkillsTab() {
        showSkillImportMenu.value = false;
        skillsDragOver.value = false;
        _skillsDragDepth = 0;
        _resetEditor();
        loadAllSkills(true);            // replier l'arbre par défaut à l'ouverture
    }

    function _resetEditor() {
        _navSeq++;                          // annule tout fetch de corps en vol
        skillEditMode.value = '';
        skillDetail.value = null;
        skillFileView.value = null;
        skillBodyView.value = 'rendered';
        skillForm.value = _emptyForm();
    }

    // Fermeture clavier du menu Importer : Échap referme ET rend le focus au
    // déclencheur (les items sont des inputs sr-only — sans ça le focus meurt).
    // Appelée AUSSI en pré-check du handler Échap global d'app.js (capture) pour
    // que le menu se ferme SANS fermer la modal Paramètres.
    function closeSkillImportMenu() {
        if (!showSkillImportMenu.value) return;
        showSkillImportMenu.value = false;
        nextTick(function() {
            try { importMenuBtn.value && importMenuBtn.value.focus(); } catch (e) { /* noop */ }
        });
    }

    // -- Load: per-scope inventory (un-merged) ------------------------
    // We query each scope separately so a globally-defined skill stays
    // visible under "global" even when a same-named user skill shadows it
    // in the merged view. Non-admins still see learned/global (read-only).
    // Clés des nœuds « expandables » (à enfants) de l'arbre — pour replier par
    // défaut à l'ouverture. Récursif sur children.
    function _collectExpandableKeys(nodes, acc) {
        for (const n of (nodes || [])) {
            if ((n.children || []).length > 0) {
                acc.add(n.key);
                _collectExpandableKeys(n.children, acc);
            }
        }
        return acc;
    }

    async function loadAllSkills(resetCollapse = false) {
        // AUDIT 2026-08-31 (passe 4, F6) — piège connu des refs de méthode
        // in-DOM : ``@click="loadAllSkills"`` passe le MouseEvent en 1er
        // argument (truthy) → « Rafraîchir »/« Réessayer » repliaient tout
        // l'arbre. Seul ``true`` STRICT vaut demande de repli.
        resetCollapse = (resetCollapse === true);
        skillsLoading.value = true;
        skillsError.value = '';
        try {
            const scopes = ['global', 'learned', 'user'];
            const results = await Promise.all(scopes.map(async (scope) => {
                const res = await fetchAuth('/api/skills?scope=' + scope, {}, true);
                if (res && res.ok) {
                    const data = await res.json().catch(() => ({}));
                    return [scope, Array.isArray(data.skills) ? data.skills : []];
                }
                return [scope, []];
            }));
            const next = { user: [], learned: [], global: [] };
            for (const pair of results) { next[pair[0]] = pair[1]; }
            skillsByScope.value = next;
            if (resetCollapse) {
                // Replier par défaut à l'OUVERTURE : tout nœud à enfants démarre
                // replié. Le composant <skill-tree-node> traite « clé absente du
                // Set » comme déplié → on remplit le Set avec les clés des nœuds
                // expandables. Les refreshs post-mutation NE passent PAS true,
                // pour ne pas re-replier un dossier que l'utilisateur vient d'ouvrir.
                const _t = skillsTreeByScope.value;
                collapsedSkills.value = _collectExpandableKeys(
                    [].concat(_t.user || [], _t.learned || [], _t.global || []),
                    new Set());
            }
        } catch (e) {
            skillsError.value = 'Impossible de charger les skills.';
            showToast('Erreur chargement des skills', 'error');
        } finally {
            skillsLoading.value = false;
        }
    }

    // Retire un éventuel bloc frontmatter ``---\n…\n---`` en tête (le détail
    // affiche déjà description/tags/domaine séparément).
    function _stripFrontmatter(t) {
        const m = /^---\s*\n[\s\S]*?\n---\s*\n?/.exec(t || '');
        return m ? t.slice(m[0].length) : (t || '');
    }

    // -- View detail : corps complet via /file (id-safe pour les sous-skills) --
    async function viewSkill(sk) {
        const seq = ++_navSeq;
        skillEditMode.value = 'view';
        skillFileView.value = null;
        skillBodyView.value = 'rendered';
        skillDetail.value = Object.assign({}, sk, { body: sk.body || sk.body_preview || '' });
        try {
            const id = sk.id || sk.name;
            const res = await fetchAuth('/api/skills/file?id=' + encodeURIComponent(id) +
                                        '&path=SKILL.md&scope=' + encodeURIComponent(sk.source || 'user'), {}, true);
            if (res && res.ok) {
                const data = await res.json().catch(() => ({}));
                if (seq === _navSeq && typeof data.content === 'string') {
                    skillDetail.value = Object.assign({}, sk, { body: _stripFrontmatter(data.content) });
                }
            }
        } catch (e) { /* body stays at preview; non-fatal */ }
    }

    // -- Create / edit forms ------------------------------------------
    function startCreate() {
        _navSeq++;
        skillEditMode.value = 'create';
        skillDetail.value = null;
        skillForm.value = Object.assign(_emptyForm(), { scope: 'user' });
    }

    async function startEdit(sk) {
        const seq = ++_navSeq;
        skillEditMode.value = 'edit';
        // Load the full body before populating the editor. ``id`` qualifié en
        // query : un sous-skill (``pkg/child``) est visé sans ambiguïté.
        let body = sk.body || '';
        try {
            const res = await fetchAuth('/api/skills/' + encodeURIComponent(sk.name) +
                                        '?scope=' + encodeURIComponent(sk.source || 'user') +
                                        '&id=' + encodeURIComponent(sk.id || sk.name), {}, true);
            if (res && res.ok) {
                const data = await res.json().catch(() => ({}));
                body = data.body || body;
            }
        } catch (e) { /* fall back to preview body */ }
        if (seq !== _navSeq) return;        // navigation survenue pendant le fetch
        skillForm.value = {
            scope:       sk.source || 'user',
            name:        sk.name || '',
            description: sk.description || '',
            domain:      sk.domain || '',
            tags:        Array.isArray(sk.tags) ? sk.tags.join(', ') : (sk.tags || ''),
            body:        body,
            _original:   sk.id || sk.name || '',   // identité (id QUALIFIÉ pour un sous-skill)
            _depth:      sk.depth || 0,            // >0 : domaine hérité du package (champ gelé)
        };
        skillDetail.value = sk;
    }

    function cancelEdit() { _resetEditor(); }

    // Retour drill-down détail/formulaire → liste : reset SANS rechargement.
    // La liste est montée en v-show (settings_skills.html) — son scroll, le
    // filtre et l'état de dépli sont intacts au retour.
    function backToSkillsList() { _resetEditor(); }

    // -- Persist (create via POST, edit via PUT) ----------------------
    async function saveSkill() {
        const f = skillForm.value;
        if (!f.name.trim() || !f.body.trim()) {
            showToast('Nom et corps requis', 'error');
            return;
        }
        if (!canEditScope(f.scope)) {
            showToast('Réservé aux administrateurs', 'error');
            return;
        }
        skillsBusy.value = true;
        try {
            const tags = String(f.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            const payload = {
                scope: f.scope,
                name: f.name.trim(),
                description: f.description || '',
                body: f.body,
                tags: tags,
                domain: f.domain || undefined,
            };
            let url, method;
            if (skillEditMode.value === 'edit') {
                method = 'PUT';
                // URL = name de FEUILLE (un ``/`` dans le path ne matche pas la
                // route) ; l'id qualifié passe en query et prime côté backend.
                const original = String(f._original || f.name.trim());
                const leaf = original.split('/').pop();
                url = '/api/skills/' + encodeURIComponent(leaf) +
                      '?id=' + encodeURIComponent(original);
            } else {
                method = 'POST';
                url = '/api/skills';
            }
            const res = await fetchAuth(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (res && res.ok) {
                showToast(skillEditMode.value === 'edit' ? 'Skill mis à jour' : 'Skill créé');
                _resetEditor();
                await loadAllSkills();
                _notifySkillsChanged();
            } else if (res && res.status === 409) {
                showToast('Un skill de ce nom existe déjà — édite-le plutôt', 'error');
            } else if (res && res.status === 403) {
                showToast('Action réservée aux administrateurs', 'error');
            } else {
                const e = res ? await res.json().catch(() => ({})) : {};
                showToast(e.detail || 'Erreur enregistrement', 'error');
            }
        } catch (e) {
            showToast('Erreur réseau', 'error');
        } finally {
            skillsBusy.value = false;
        }
    }

    // -- Delete (scoped, folder-aware) ---------------------------------
    async function deleteSkill(sk) {
        const scope = sk.source || 'user';
        if (!canEditScope(scope)) {
            showToast('Suppression réservée aux administrateurs', 'error');
            return;
        }
        const id = sk.id || sk.name;
        // Confirm EXPLICITE : supprimer un package emporte ses sous-skills et
        // tout le dossier (scripts/références) — rmtree côté backend.
        const kids = _descendantSkills(scope, id);
        let label = sk.name + (scope !== 'user' ? ' (' + scope + ')' : '');
        if (kids.length) {
            label += ' — supprime aussi ' + kids.length + ' sous-skill(s) et tous les fichiers du dossier';
        } else if (sk.is_folder && (sk.files || []).length) {
            label += ' — supprime le dossier et ses ' + sk.files.length + ' fichier(s)';
        }
        const ok = await openConfirm('Supprimer ce skill ?', label, true);
        if (!ok) return;
        skillsBusy.value = true;
        try {
            const leaf = String(id).split('/').pop();
            const res = await fetchAuth('/api/skills/' + encodeURIComponent(leaf) +
                                        '?scope=' + encodeURIComponent(scope) +
                                        '&id=' + encodeURIComponent(id), { method: 'DELETE' });
            if (res && res.ok) {
                showToast('Skill supprimé');
                // Reset si le détail affiché est le supprimé OU un de ses descendants.
                const cur = skillDetail.value;
                const curId = cur ? (cur.id || cur.name) : '';
                if (cur && (cur.source || 'user') === scope &&
                    (curId === id || curId.indexOf(id + '/') === 0)) _resetEditor();
                await loadAllSkills();
                _notifySkillsChanged();
            } else if (res && res.status === 403) {
                showToast('Suppression réservée aux administrateurs', 'error');
            } else if (res && res.status === 404) {
                showToast('Skill introuvable', 'error');
            } else {
                showToast('Suppression impossible', 'error');
            }
        } catch (e) {
            showToast('Erreur réseau', 'error');
        } finally {
            skillsBusy.value = false;
        }
    }

    // -- Promote learned -> global (admin only) -----------------------
    async function promoteSkill(sk) {
        if (!isAdmin.value) {
            showToast('Promotion réservée aux administrateurs', 'error');
            return;
        }
        const ok = await openConfirm('Promouvoir vers global ?',
            sk.name + ' sera visible par tous les utilisateurs.', false, 'Promouvoir');
        if (!ok) return;
        skillsBusy.value = true;
        try {
            const res = await fetchAuth('/api/skills/promote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: sk.name }),
            });
            if (res && res.ok) {
                showToast('Skill promu en global');
                if (skillDetail.value && skillDetail.value.name === sk.name) _resetEditor();
                await loadAllSkills();
                _notifySkillsChanged();
            } else if (res && res.status === 403) {
                showToast('Promotion réservée aux administrateurs', 'error');
            } else {
                const e = res ? await res.json().catch(() => ({})) : {};
                showToast(e.detail || 'Promotion impossible (conflit de nom ?)', 'error');
            }
        } catch (e) {
            showToast('Erreur réseau', 'error');
        } finally {
            skillsBusy.value = false;
        }
    }

    // Small helper used by the template badge.
    function scopeLabel(scope) {
        return scope === 'user' ? 'perso' : (scope === 'learned' ? 'learned' : 'global');
    }

    // ══ Import d'un skill : .zip, dossier (webkitdirectory / DnD) ou SKILL.md ══
    // Multipart via fetchAuth WITHOUT headers (browser sets the boundary —
    // même pattern que /api/mcp/upload, /api/sandbox/upload). Machine commune :
    // busy (skillsImporting) → succès (toast précis + sélection auto) / 409
    // « existe déjà » (openConfirm Remplacer → retry overwrite=1, fichiers
    // gardés en closure) / 400 (detail backend actionnable, toast long) /
    // réseau (fetchAuth toaste et déconnecte déjà sur 401).

    function _checkImportScope(scope) {
        const sc = (scope === 'global') ? 'global' : 'user';
        if (sc === 'global' && !isAdmin.value) {
            showToast('Import global réservé aux administrateurs', 'error');
            return null;
        }
        return sc;
    }

    // Slug côté client — MIROIR de llm_core.skills.slugify_name (accents
    // retirés, minuscules, espaces→tirets, [a-z0-9_-] seulement). Sert de
    // filet quand le detail d'un 409 ne porte pas le slug.
    function _clientSlug(s) {
        return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .trim().toLowerCase().replace(/ /g, '-')
            .replace(/[^a-z0-9_-]+/g, '').replace(/-{2,}/g, '-')
            .replace(/^[-_]+|[-_]+$/g, '');
    }

    // Sélection auto du skill fraîchement importé : déplie le domaine + le
    // nœud et ouvre le détail — en drill-down, la vue DÉTAIL plein cadre
    // s'ouvre directement : l'utilisateur VOIT le skill importé (retour
    // « ← Skills » pour la liste). (Onglet quitté pendant l'upload : sélection
    // en fond, inoffensive — la prochaine entrée d'onglet reset via openSkillsTab.)
    function _selectImportedSkill(name, sc) {
        if (!name) return;
        const sk = (skillsByScope.value[sc] || []).find(
            s => (s.id || s.name) === name || s.name === name);
        if (!sk) return;
        const open = new Set(collapsedSkills.value);   // réassigné, jamais muté
        const dom = (sk.domain || '').trim();
        if (dom) open.delete(sc + ':dom:' + dom);
        open.delete(sc + ':' + (sk.id || sk.name));
        collapsedSkills.value = open;
        viewSkill(sk);
    }

    // Réponse commune aux deux routes multipart ({imported, count, name, scope}).
    // ``retry(overwrite)`` relance le MÊME import — flux 409.
    async function _handleImportResponse(res, fallbackName, retry) {
        if (res && res.ok) {
            const data = await res.json().catch(() => ({}));
            const imported = Array.isArray(data.imported) ? data.imported : [];
            const name = data.name || fallbackName || 'skill';
            showToast(imported.length > 1
                ? (imported.length + ' skills importés')
                : ('Skill « ' + name + ' » importé'));
            announce('Skill ' + name + ' importé');
            await loadAllSkills();
            _notifySkillsChanged();
            _selectImportedSkill(data.name, (data.scope === 'global') ? 'global' : 'user');
            return;
        }
        if (!res) return;               // réseau / 401 : fetchAuth a déjà réagi
        if (res.status === 403) {
            showToast('Import global réservé aux administrateurs', 'error');
            return;
        }
        if (res.status === 409 && retry) {
            const d = await res.json().catch(() => ({}));
            const name = d.name || fallbackName || 'skill';
            const ok = await openConfirm('Remplacer le skill « ' + name + ' » ?',
                'Un skill du même nom existe déjà. Le remplacer écrase son contenu et tous ses fichiers.',
                true, 'Remplacer');
            if (ok) await retry(true);
            return;
        }
        const e = await res.json().catch(() => ({}));
        showToast(e.detail || 'Import refusé : archive invalide ou SKILL.md manquant',
                  'error', { duration: 8000 });
    }

    // Accepts either a File or a change-Event from a hidden <input type=file>.
    async function importSkillZip(fileOrEvent, scope) {
        const file = (fileOrEvent && fileOrEvent.target)
            ? (fileOrEvent.target.files || [])[0] : fileOrEvent;
        if (fileOrEvent && fileOrEvent.target) { try { fileOrEvent.target.value = ''; } catch (e) {} }
        if (!file) return;
        const sc = _checkImportScope(scope);
        if (!sc) return;
        await _postZip(file, sc, false);
    }

    async function _postZip(file, sc, overwrite) {
        skillsImporting.value = 'zip';
        announce('Import du skill en cours');
        try {
            const fd = new FormData();      // reconstruit à CHAQUE tentative
            fd.append('file', file);
            const res = await fetchAuth('/api/skills/import?scope=' + sc +
                                        (overwrite ? '&overwrite=1' : ''),
                                        { method: 'POST', body: fd });
            await _handleImportResponse(res, String(file.name || '').replace(/\.zip$/i, ''),
                                        (ow) => _postZip(file, sc, ow));
        } catch (e) {
            showToast('Import interrompu — réessaie', 'error');
        } finally {
            skillsImporting.value = '';
        }
    }

    // Dossier complet via <input webkitdirectory> OU drag-and-drop : un champ
    // ``paths`` par fichier (chemin relatif ``<dossier>/…`` préservé). Le
    // backend ré-empaquette en zip mémoire → même pipeline durci que le .zip.
    async function importSkillFolder(evt, scope) {
        const files = Array.from((evt && evt.target && evt.target.files) || []);
        if (evt && evt.target) { try { evt.target.value = ''; } catch (e) {} }
        if (!files.length) return;
        const sc = _checkImportScope(scope);
        if (!sc) return;
        await _postFolder(files.map(f => ({ file: f, relPath: f.webkitRelativePath || f.name })),
                          sc, false);
    }

    async function _postFolder(entries, sc, overwrite) {
        skillsImporting.value = 'folder';
        announce('Import du skill en cours');
        try {
            const fd = new FormData();      // reconstruit à CHAQUE tentative
            for (const en of entries) {
                fd.append('files', en.file);
                fd.append('paths', en.relPath);
            }
            const res = await fetchAuth('/api/skills/import-folder?scope=' + sc +
                                        (overwrite ? '&overwrite=1' : ''),
                                        { method: 'POST', body: fd });
            const rootName = String(entries[0].relPath || '').split('/')[0] || 'skill';
            await _handleImportResponse(res, rootName, (ow) => _postFolder(entries, sc, ow));
        } catch (e) {
            showToast('Import interrompu — réessaie', 'error');
        } finally {
            skillsImporting.value = '';
        }
    }

    // SKILL.md seul → PAS de route dédiée : POST /api/skills {raw_md, filename}
    // (le backend dérive name/description/tags du frontmatter, ou du nom de
    // fichier). 409 en collision → confirm puis PUT /api/skills/{slug}.
    async function importSkillMd(evt, scope) {
        const file = (evt && evt.target && (evt.target.files || [])[0]) || null;
        if (evt && evt.target) { try { evt.target.value = ''; } catch (e) {} }
        if (!file) return;
        const sc = _checkImportScope(scope);
        if (!sc) return;
        if (file.size > 1024 * 1024) {
            showToast('Fichier .md trop volumineux (1 Mo max — utilise l\'import dossier/zip)', 'error');
            return;
        }
        let raw;
        try { raw = await file.text(); }
        catch (e) { showToast('Lecture du fichier impossible', 'error'); return; }
        await _postMd(raw, file.name, sc);
    }

    async function _postMd(rawMd, filename, sc) {
        skillsImporting.value = 'md';
        announce('Import du skill en cours');
        const stem = String(filename || '').replace(/\.(md|markdown)$/i, '');
        try {
            const res = await fetchAuth('/api/skills', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope: sc, raw_md: rawMd, filename: filename }),
            });
            if (res && res.ok) {
                const data = await res.json().catch(() => ({}));
                const name = data.name || stem;
                showToast('Skill « ' + name + ' » importé');
                announce('Skill ' + name + ' importé');
                await loadAllSkills();
                _notifySkillsChanged();
                _selectImportedSkill(_clientSlug(name), sc);
                return;
            }
            if (!res) return;           // réseau / 401 : fetchAuth a déjà réagi
            if (res.status === 403) {
                showToast('Import global réservé aux administrateurs', 'error');
                return;
            }
            if (res.status === 409) {
                // detail = "un skill '<slug>' existe déjà (…)" → slug entre quotes.
                const d = await res.json().catch(() => ({}));
                const m = /'([^']+)'/.exec(String(d.detail || ''));
                const slug = (m && m[1]) || _clientSlug(stem);
                const ok = await openConfirm('Remplacer le skill « ' + slug + ' » ?',
                    'Un skill du même nom existe déjà. Le remplacer écrase son contenu.',
                    true, 'Remplacer');
                if (!ok) return;
                const res2 = await fetchAuth('/api/skills/' + encodeURIComponent(slug), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scope: sc, raw_md: rawMd, filename: filename }),
                });
                if (res2 && res2.ok) {
                    const d2 = await res2.json().catch(() => ({}));
                    showToast('Skill « ' + (d2.name || slug) + ' » remplacé');
                    await loadAllSkills();
                    _notifySkillsChanged();
                    _selectImportedSkill(slug, sc);
                } else if (res2) {
                    const e2 = await res2.json().catch(() => ({}));
                    showToast(e2.detail || 'Remplacement impossible', 'error', { duration: 8000 });
                }
                return;
            }
            const e = await res.json().catch(() => ({}));
            showToast(e.detail || 'Import refusé : SKILL.md invalide', 'error', { duration: 8000 });
        } catch (e) {
            showToast('Import interrompu — réessaie', 'error');
        } finally {
            skillsImporting.value = '';
        }
    }

    // ── Drag-and-drop sur toute la page (décalque du compteur chat/_dnd.js) ──
    // 1 élément à la fois : .zip → _postZip ; .md → _postMd ; dossier →
    // traversée webkitGetAsEntry → même multipart files+paths que l'input.
    function _dragHasFiles(event) {
        try {
            const types = event.dataTransfer && event.dataTransfer.types;
            if (!types) return false;
            for (let i = 0; i < types.length; i++) {
                if (types[i] === 'Files') return true;
            }
        } catch (e) { /* noop */ }
        return false;
    }

    function onSkillsDragEnter(event) {
        if (!_dragHasFiles(event)) return;
        event.preventDefault();
        _skillsDragDepth++;
        skillsDragOver.value = true;
    }

    function onSkillsDragOver(event) {
        if (!_dragHasFiles(event)) return;
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        skillsDragOver.value = true;
    }

    function onSkillsDragLeave(event) {
        if (!_dragHasFiles(event)) return;
        _skillsDragDepth = Math.max(0, _skillsDragDepth - 1);
        if (_skillsDragDepth === 0) skillsDragOver.value = false;
    }

    // Lit TOUTES les entrées d'un directoryReader (readEntries rend des lots
    // de ≤100 : on boucle jusqu'au lot vide).
    function _readAllEntries(reader) {
        return new Promise(function(resolve, reject) {
            const out = [];
            (function step() {
                reader.readEntries(function(batch) {
                    if (!batch.length) { resolve(out); return; }
                    for (const b of batch) out.push(b);
                    step();
                }, reject);
            })();
        });
    }

    async function _collectDirEntries(dirEntry, prefix, acc) {
        const children = await _readAllEntries(dirEntry.createReader());
        for (const en of children) {
            if (!en || !en.name || en.name.charAt(0) === '.') continue;   // cachés ignorés (comme le backend)
            if (acc.length > 500) return;                                  // cap précoce — le backend re-vérifie
            if (en.isDirectory) {
                await _collectDirEntries(en, prefix + '/' + en.name, acc);
            } else if (en.isFile) {
                const file = await new Promise(function(res, rej) { en.file(res, rej); });
                acc.push({ file: file, relPath: prefix + '/' + en.name });
            }
        }
    }

    async function onSkillsDrop(event) {
        _skillsDragDepth = 0;
        skillsDragOver.value = false;
        window.__dropHandled = Date.now();      // convention anti double-drop (cf. _dnd.js)
        const dt = event && event.dataTransfer;
        if (!dt) return;
        const items = dt.items ? Array.from(dt.items).filter(i => i.kind === 'file') : [];
        // Dossier déposé (webkitGetAsEntry : Chrome/Firefox desktop).
        const entry = (items.length === 1 && items[0].webkitGetAsEntry)
            ? items[0].webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) {
            const sc = _checkImportScope('user');
            if (!sc) return;
            const collected = [];
            try { await _collectDirEntries(entry, entry.name, collected); }
            catch (e) { showToast('Lecture du dossier déposé impossible', 'error'); return; }
            if (!collected.length) { showToast('Dossier vide (ou uniquement des fichiers cachés)', 'error'); return; }
            if (collected.length > 500) { showToast('Trop de fichiers (500 max)', 'error'); return; }
            await _postFolder(collected, sc, false);
            return;
        }
        const files = Array.from(dt.files || []);
        if (files.length !== 1) {
            showToast('Dépose un seul élément : archive .zip, dossier de skill ou fichier SKILL.md', 'error');
            return;
        }
        const f = files[0];
        const sc = _checkImportScope('user');
        if (!sc) return;
        if (/\.zip$/i.test(f.name || '')) { await _postZip(f, sc, false); return; }
        if (/\.(md|markdown)$/i.test(f.name || '')) {
            if (f.size > 1024 * 1024) { showToast('Fichier .md trop volumineux (1 Mo max)', 'error'); return; }
            let raw;
            try { raw = await f.text(); }
            catch (e) { showToast('Lecture du fichier impossible', 'error'); return; }
            await _postMd(raw, f.name, sc);
            return;
        }
        showToast('Format non géré — dépose un .zip, un dossier de skill ou un SKILL.md', 'error');
    }

    // -- Export a skill as .zip (authenticated GET → navigateur télécharge) --
    function exportSkillZip(sk) {
        if (!sk || !sk.name) return;
        let url = '/api/skills/' + encodeURIComponent(sk.name) + '/export';
        const qp = [];
        if (sk.source) qp.push('scope=' + encodeURIComponent(sk.source));
        if (sk.id && sk.id !== sk.name) qp.push('id=' + encodeURIComponent(sk.id));
        if (qp.length) url += '?' + qp.join('&');
        try {
            const a = document.createElement('a');
            a.href = url; a.rel = 'noopener'; a.download = sk.name + '.zip';
            document.body.appendChild(a); a.click(); a.remove();
        } catch (e) {
            showToast('Téléchargement impossible', 'error');
        }
    }

    // -- Arbre réel : nœuds récursifs {key, kind, label, skill, path, children} --
    // Rendu par le composant global <skill-tree-node> (utils.js / x-template
    // index.html). key = "<scope>:<id>" (skill), "<scope>:dom:<domaine>"
    // (dossier de domaine), "<scope>:<id>::<path>" (fichier bundlé).
    function toggleCollapse(key) {
        const s = new Set(collapsedSkills.value);
        s.has(key) ? s.delete(key) : s.add(key);
        collapsedSkills.value = s;          // réassignation → réactif
    }
    const skillsTreeByScope = computed(() => {
        const out = { user: [], learned: [], global: [] };
        for (const scope of ['global', 'learned', 'user']) {
            const list = filteredByScope.value[scope] || [];
            const nodes = {};
            for (const s of list) {
                const id = s.id || s.name;
                nodes[id] = { key: scope + ':' + id, kind: 'skill', label: s.name,
                              skill: s, children: [], childSkillCount: 0 };
            }
            // Rattachement parent→enfant (orphelin → racine, même règle que le
            // build_skill_tree backend). Deux passes : l'ordre de la liste ne
            // garantit pas parent-avant-enfant.
            const roots = [];
            for (const s of list) {
                const node = nodes[s.id || s.name];
                const parent = s.parent_id ? nodes[s.parent_id] : null;
                (parent ? parent.children : roots).push(node);
                if (parent) parent.childSkillCount++;
            }
            // Feuilles fichiers (bundle Agent Skill) APRÈS les sous-skills.
            for (const s of list) {
                const node = nodes[s.id || s.name];
                for (const f of (s.files || [])) {
                    node.children.push({ key: node.key + '::' + f, kind: 'file',
                                         label: f, path: f, skill: s, children: [] });
                }
            }
            // Regroupement par domaine — nœud dossier seulement si non vide.
            const byDomain = {};
            const top = [];
            for (const r of roots) {
                const dom = (r.skill.domain || '').trim();
                if (!dom) { top.push(r); continue; }
                if (!byDomain[dom]) {
                    byDomain[dom] = { key: scope + ':dom:' + dom, kind: 'domain',
                                      label: dom, children: [] };
                    top.push(byDomain[dom]);
                }
                byDomain[dom].children.push(r);
            }
            // Hoisting : un domaine qui ne contient QUE le package homonyme
            // (ex. domaine "jenkins" → package "jenkins") serait un niveau
            // redondant — on remonte le package à la place du dossier.
            for (let i = 0; i < top.length; i++) {
                const n = top[i];
                if (n.kind === 'domain' && n.children.length === 1 &&
                    n.children[0].kind === 'skill' && n.children[0].skill.name === n.label) {
                    top[i] = n.children[0];
                }
            }
            out[scope] = top;
        }
        return out;
    });
    // Clés de surbrillance (sélection / fichier ouvert) alignées sur les keys de nœud.
    const selectedNodeKey = computed(() => {
        const d = skillDetail.value;
        return d ? (d.source || 'user') + ':' + (d.id || d.name) : '';
    });
    const activeFileNodeKey = computed(() => {
        const f = skillFileView.value;
        return (f && f.path && selectedNodeKey.value)
            ? selectedNodeKey.value + '::' + f.path : '';
    });
    // Clic sur une feuille fichier : sélectionne le skill (si besoin) PUIS ouvre
    // le lecteur — viewSkill remet skillFileView à null à l'entrée, l'ordre compte.
    function onTreeOpenFile(payload) {
        if (!payload || !payload.skill) return;
        const sk = payload.skill;
        const cur = skillDetail.value;
        const same = cur && (cur.id || cur.name) === (sk.id || sk.name) &&
                     (cur.source || 'user') === (sk.source || 'user');
        if (!same) viewSkill(sk);           // fetch corps async, anti-race _navSeq
        openSkillFile(sk, payload.path);
    }
    function childSkills(sk) {
        if (!sk) return [];
        const id = sk.id || sk.name;
        const scope = sk.source || 'user';
        return (skillsByScope.value[scope] || []).filter(s => s.parent_id === id);
    }
    function _descendantSkills(scope, id) {
        return (skillsByScope.value[scope] || [])
            .filter(s => (s.id || s.name).indexOf(id + '/') === 0);
    }
    // Chaîne des ancêtres du skill affiché (breadcrumb du détail d'un sous-skill).
    const skillBreadcrumb = computed(() => {
        const d = skillDetail.value;
        if (!d || !d.parent_id) return [];
        const byId = {};
        for (const s of (skillsByScope.value[d.source || 'user'] || [])) byId[s.id || s.name] = s;
        const chain = [];
        let p = d.parent_id;
        while (p && byId[p]) { chain.unshift(byId[p]); p = byId[p].parent_id; }
        return chain;
    });
    // AUDIT 2026-09-01 (passe 5, F10) — jeton : deux clics rapprochés dans
    // l'arbre affichaient le fichier LENT sous la sélection récente, et une
    // réponse en vol ROUVRAIT le lecteur que « ✕ » venait de fermer.
    let _skillFileSeq = 0;
    async function openSkillFile(sk, path) {
        if (!sk) return;
        const id = sk.id || sk.name;
        const mySeq = ++_skillFileSeq;
        skillFileView.value = { path: path, content: '', loading: true };
        try {
            const res = await fetchAuth('/api/skills/file?id=' + encodeURIComponent(id) +
                '&path=' + encodeURIComponent(path) +
                '&scope=' + encodeURIComponent(sk.source || 'user'), {}, true);
            const data = (res && res.ok) ? await res.json().catch(() => ({})) : {};
            if (mySeq !== _skillFileSeq || !skillFileView.value) return;   // périmé ou fermé
            skillFileView.value = { path: path, content: (data.content != null ? data.content : '(vide ou illisible)'), loading: false };
        } catch (e) {
            if (mySeq !== _skillFileSeq || !skillFileView.value) return;
            skillFileView.value = { path: path, content: '(erreur de lecture)', loading: false };
        }
    }
    function closeSkillFile() { _skillFileSeq++; skillFileView.value = null; }

    // Fichier bundlé markdown ? → le lecteur propose Rendu | Source.
    const skillFileIsMd = computed(() => {
        const f = skillFileView.value;
        return !!(f && f.path && /\.(md|markdown)$/i.test(f.path));
    });

    return {
        // onglet de la modal Paramètres (gated sur settingsTab==='skills')
        openSkillsTab: openSkillsTab,
        // list state
        skillsLoading: skillsLoading,
        skillsError: skillsError,
        skillsBusy: skillsBusy,
        skillsFilter: skillsFilter,
        skillsByScope: skillsByScope,
        filteredByScope: filteredByScope,
        totalSkillsCount: totalSkillsCount,
        filteredTotalCount: filteredTotalCount,
        // editor state
        skillEditMode: skillEditMode,
        skillDetail: skillDetail,
        skillForm: skillForm,
        // perms
        isSkillAdmin: isAdmin,
        canEditScope: canEditScope,
        editableScopes: editableScopes,
        scopeLabel: scopeLabel,
        // actions
        loadAllSkills: loadAllSkills,
        viewSkill: viewSkill,
        startCreate: startCreate,
        startEdit: startEdit,
        cancelEdit: cancelEdit,
        backToSkillsList: backToSkillsList,
        saveSkill: saveSkill,
        deleteSkill: deleteSkill,
        promoteSkill: promoteSkill,
        importSkillZip: importSkillZip,
        importSkillFolder: importSkillFolder,
        importSkillMd: importSkillMd,
        skillsImporting: skillsImporting,
        showSkillImportMenu: showSkillImportMenu,
        importMenuBtn: importMenuBtn,
        closeSkillImportMenu: closeSkillImportMenu,
        exportSkillZip: exportSkillZip,
        // drag-and-drop d'import (overlay scopé à l'onglet)
        skillsDragOver: skillsDragOver,
        onSkillsDragEnter: onSkillsDragEnter,
        onSkillsDragOver: onSkillsDragOver,
        onSkillsDragLeave: onSkillsDragLeave,
        onSkillsDrop: onSkillsDrop,
        // rendu markdown du détail (corps + fichiers .md)
        skillBodyView: skillBodyView,
        skillFileIsMd: skillFileIsMd,
        // arbre / sous-skills / fichiers
        collapsedSkills: collapsedSkills,
        toggleCollapse: toggleCollapse,
        skillsTreeByScope: skillsTreeByScope,
        selectedNodeKey: selectedNodeKey,
        activeFileNodeKey: activeFileNodeKey,
        onTreeOpenFile: onTreeOpenFile,
        skillBreadcrumb: skillBreadcrumb,
        childSkills: childSkills,
        skillFileView: skillFileView,
        openSkillFile: openSkillFile,
        closeSkillFile: closeSkillFile,
    };
}
if (typeof window !== 'undefined') { window.setupSkillsMenu = setupSkillsMenu; }
