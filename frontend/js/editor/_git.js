// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/editor/_git.js -- Extracted from app-editor.js
//
//  Personal-sandbox Git workspace: all backend calls for clone,
//  init, commit, push, pull, merge, rebase, stash, remote config,
//  file tree / log / diff / restore, and credentials.
//
//  Responsibilities
//  ----------------
//  • Reactive state for repo list, current repo, status, branches,
//    modals, forms, credentials.
//  • CRUD-style HTTP wrappers (_gq / _gb / _gcreds) that encode
//    the `repo=` query parameter and the credentials field.
//  • All top-level git* operations -- each follows the same
//    gitLoading → fetchAuth → showToast → refresh cascade.
//  • Merge with conflict detection + resolve + abort modal flow.
//  • _gitAutoRefresh: called from file save/rename/move/delete in
//    app-editor.js to re-query status + tree when the Git tab is open.
//  • _gitReloadOpenTabs: re-opens every tab whose path is inside the
//    current repo after a branch switch / pull / merge / restore.
//
//  Contract
//  --------
//  Loaded BEFORE app-editor.js. Exposes on window:
//      window.setupEditorGit(vue, sharedRefs, ctx, callbacks)
//
//  Dependencies
//  ------------
//  From sharedRefs : openTabs, models
//  From ctx        : showToast, fetchAuth, openPrompt
//  From callbacks  : openFile, loadSandboxFiles, _modelOk,
//                    showDiffForMessage
//                    (captured at setup time; resolved at call time
//                    so they can reference functions defined later
//                    in app-editor.js).
// ============================================================

(function() {
    'use strict';

    function setupEditorGit(vue, sharedRefs, ctx, callbacks) {
        const { ref, computed } = vue;
        // originalFileContent : map path→contenu disque (snapshot serveur).
        // readOnlyTabs        : ref(Set) des paths actuellement non-sauvegardables.
        // Tous deux vivent dans app-editor.js et sont passés ici (sinon hors
        // de portée → _gitReloadOpenTabs ne rechargeait jamais aucun onglet,
        // cf. fix P1).
        const { openTabs, models, originalFileContent, readOnlyTabs } = sharedRefs;
        const { showToast, fetchAuth, openPrompt, openConfirm } = ctx;
        const {
            openFile            = () => {},
            reloadTab           = () => Promise.resolve(false),
            // Revérifie les onglets contre le disque (empreinte de contenu).
            checkDisk           = () => {},
            loadSandboxFiles    = () => {},
            _modelOk            = () => false,
            _tabIsDirty         = () => false,
            showDiffForMessage  = () => {},
            applyActiveReadOnly = () => {},
            isViewerPath        = () => false,
        } = callbacks || {};

        // -- Reactive state ------------------------------------------
        const explorerTab          = ref('files');
        const gitRepos             = ref([]);
        const gitCurrentRepo       = ref('');
        const gitStatus            = ref(null);
        const gitBranches          = ref({ current: '', local: [], remote: [] });
        const gitCommitMsg         = ref('');
        const gitLoading           = ref(false);
        const showGitCloneModal    = ref(false);
        const gitCloneForm         = ref({ url: '', dir: '' });
        // Picker « cloner depuis un connecteur » : on sélectionne un connecteur
        // (Réglages), on liste ses dépôts via l'API du provider, et un clic
        // pré-remplit gitCloneForm.url (l'utilisateur confirme avec « Cloner »).
        const gitCloneConnectorId  = ref('');
        const gitCloneRepos        = ref([]);
        const gitCloneReposLoading = ref(false);
        const gitCloneReposError   = ref('');
        const gitCloneRepoFilter   = ref('');
        const showGitBranchMenu    = ref(false);
        const showGitRemoteModal   = ref(false);
        const gitRemoteForm        = ref({ url: '' });
        const showGitInitModal     = ref(false);
        const gitInitForm          = ref({ user_name: '', user_email: '', dir: '' });
        const showGitMoreMenu      = ref(false);
        const gitError             = ref('');
        const showGitRepoMenu      = ref(false);
        const showExplorerMenu     = ref(false);  // dropdown Fichiers/Git (ligne unique de l'explorateur)
        const showGitMergeModal    = ref(false);
        const gitMergePreview      = ref(null);  // {branch, commits, files, total_add, total_del}
        const gitMergeBranch       = ref('');
        const showGitPushAuth      = ref(false);
        const gitCredShowPwd       = ref(false);
        let _gitPendingPushForce   = false;

        // -- Git: file tree, log, diff, restore, credentials ---------
        const gitTree              = ref([]);
        const gitLog               = ref([]);
        const gitDiffData          = ref(null);
        const gitCredUser          = ref('');
        const gitCredToken         = ref('');

        // Nettoyage de session (poste partagé) : purge l'état git —
        // SURTOUT les credentials (gitCredUser/gitCredToken, préremplis
        // dans la modale push) — pour que l'utilisateur suivant ne
        // retrouve rien du compte précédent. Appelé par logout() via
        // ctx.resetEditorOnLogout (app.js) → app-editor.resetOnLogout.
        function resetOnLogout() {
            gitCredUser.value  = '';
            gitCredToken.value = '';
            gitCredShowPwd.value = false;
            showGitPushAuth.value = false;
            showGitMergeModal.value = false;
            gitStatus.value    = null;
            gitBranches.value  = { current: '', local: [], remote: [] };
            gitRepos.value     = [];
            gitCurrentRepo.value = '';
            gitTree.value      = [];
            gitLog.value       = [];
            gitDiffData.value  = null;
            gitCommitMsg.value = '';
            gitError.value     = '';
            explorerTab.value  = 'files';
        }
        const gitSectionOpen       = ref({ changes: true, tree: false, log: false, creds: false });

        // -- Query / body / credentials helpers ----------------------
        function _gq() { return gitCurrentRepo.value ? '?repo=' + encodeURIComponent(gitCurrentRepo.value) : ''; }
        function _gb(o) { var b = o || {}; if (gitCurrentRepo.value) b.repo = gitCurrentRepo.value; return b; }
        function _gcreds(o) { if (gitCredUser.value && gitCredToken.value) { o.cred_user = gitCredUser.value; o.cred_token = gitCredToken.value; } return o; }

        // -- Erreur git centralisée ----------------------------------
        // fetchAuth renvoie `null` sur 401 / erreur réseau. Plusieurs flux
        // faisaient `var e = await r.json()` sans tester `r` → TypeError
        // avalée par un `catch(e){}` vide → opération échouée SANS aucun
        // retour à l'utilisateur (le bouton se réactive comme si tout avait
        // réussi). Ce helper produit le bon toast :
        //   • r null      → « Session expirée / erreur réseau »
        //   • r non-ok    → detail du backend, sinon `fallback`.
        // À appeler dans la branche d'échec, après avoir vérifié !(r && r.ok).
        async function _gitShowErr(r, fallback) {
            if (!r) { showToast('Session expirée / erreur réseau', 'error'); return; }
            var msg = fallback || 'Erreur';
            try { var e = await r.json(); if (e && e.detail) msg = e.detail; } catch(_) {}
            showToast(msg, 'error');
        }

        // -- Repo discovery & status --------------------------------
        async function gitLoadRepos() {
            try {
                var r = await fetchAuth('/api/sandbox/git/repos', {}, true);
                if (r && r.ok) {
                    var d = await r.json();
                    gitRepos.value = d.repos || [];
                    if (gitRepos.value.length > 0 && !gitRepos.value.find(x => x.path === gitCurrentRepo.value))
                        gitCurrentRepo.value = gitRepos.value[0].path;
                    else if (gitRepos.value.length === 0)
                        gitCurrentRepo.value = '';
                }
            } catch(e) {}
        }
        // AUDIT 2026-08-31 (passe 4, F3) — jeton de fraîcheur : ces loaders
        // sont tirés en rafale NON await-ée par gitSelectRepo. Deux bascules
        // de dépôt rapprochées faisaient afficher la réponse du PREMIER
        // (arrivée en retard) sous le nom du second — arbre préfixé du
        // mauvais dépôt, chaque clic ouvrait un chemin invalide. Chaque
        // loader capture SON dépôt à l'entrée et jette la réponse si la
        // sélection a changé pendant l'await.
        async function gitRefresh() {
            var repo = gitCurrentRepo.value;
            if (!repo) { gitStatus.value = null; return; }
            try {
                var r = await fetchAuth('/api/sandbox/git/status' + _gq(), {}, true);
                if (repo !== gitCurrentRepo.value) return;   // réponse périmée
                if (r && r.ok) gitStatus.value = await r.json();
                else gitStatus.value = null;
            } catch(e) { if (repo === gitCurrentRepo.value) gitStatus.value = null; }
        }
        async function gitLoadBranches() {
            var repo = gitCurrentRepo.value;
            if (!repo) return;
            try {
                var r = await fetchAuth('/api/sandbox/git/branches' + _gq(), {}, true);
                if (repo !== gitCurrentRepo.value) return;   // réponse périmée
                if (r && r.ok) gitBranches.value = await r.json();
            } catch(e) {}
        }
        async function gitOpenTab() {
            explorerTab.value = 'git';
            await gitLoadRepos();
            if (gitCurrentRepo.value) { await gitRefresh(); await gitLoadBranches(); await gitLoadTree(); }
        }
        function gitSelectRepo(p) {
            gitCurrentRepo.value = p; showGitRepoMenu.value = false;
            gitDiffData.value = null;
            gitRefresh(); gitLoadBranches();
            if (gitSectionOpen.value.tree) gitLoadTree();
            if (gitSectionOpen.value.log) gitLoadLog();
        }

        // -- Init / Clone --------------------------------------------
        async function gitInit() {
            gitLoading.value = true; gitError.value = '';
            try {
                var r = await fetchAuth('/api/sandbox/git/init', {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify(gitInitForm.value)
                });
                if (r && r.ok) {
                    var d = await r.json();
                    showToast('Dépôt Git initialisé'); showGitInitModal.value = false;
                    await gitLoadRepos();
                    if (d.repo) gitCurrentRepo.value = d.repo;
                    await gitRefresh(); loadSandboxFiles();
                } else { await _gitShowErr(r, 'Erreur'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitClone() {
            if (!gitCloneForm.value.url) return;
            gitLoading.value = true; gitError.value = '';
            try {
                var r = await fetchAuth('/api/sandbox/git/clone', {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify(gitCloneForm.value)
                });
                if (r && r.ok) {
                    var d = await r.json();
                    showToast(d.message || 'Clone terminé !');
                    showGitCloneModal.value = false; gitCloneForm.value = { url: '', dir: '' };
                    await gitLoadRepos();
                    if (d.repo) gitCurrentRepo.value = d.repo;
                    await gitRefresh(); loadSandboxFiles();
                } else { var ce = 'Erreur'; if (r) { try { var e = await r.json(); if (e && e.detail) ce = e.detail; } catch(_) {} } else { ce = 'Session expirée / erreur réseau'; } gitError.value = ce; showToast(ce, 'error'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }

        // -- Clone depuis un connecteur (liste de dépôts) ------------
        // Liste filtrée client-side (sur full_name + description).
        const gitFilteredCloneRepos = computed(function() {
            var q = (gitCloneRepoFilter.value || '').trim().toLowerCase();
            if (!q) return gitCloneRepos.value;
            return gitCloneRepos.value.filter(function(r) {
                return ((r.full_name || '') + ' ' + (r.description || '')).toLowerCase().indexOf(q) !== -1;
            });
        });
        // Ouvre la modale de clone en repartant d'un état propre. Le chargement
        // des connecteurs (loadGitConnectors) vit dans le module Réglages : il est
        // déclenché en parallèle depuis le template (cf. editor.html).
        function gitOpenCloneModal() {
            gitCloneConnectorId.value  = '';
            gitCloneRepos.value        = [];
            gitCloneReposError.value   = '';
            gitCloneRepoFilter.value   = '';
            gitError.value             = '';
            gitCloneForm.value         = { url: '', dir: '' };
            showGitCloneModal.value    = true;
        }
        async function gitLoadConnectorRepos(cid) {
            gitCloneRepoFilter.value = '';
            gitCloneReposError.value = '';
            gitCloneRepos.value = [];
            if (!cid) return;
            gitCloneReposLoading.value = true;
            try {
                var r = await fetchAuth('/api/git/connectors/' + encodeURIComponent(cid) + '/repos', {}, true);
                if (!r) { gitCloneReposError.value = 'Session expirée / erreur réseau'; return; }
                var d = await r.json().catch(function() { return {}; });
                if (r.ok && d && d.ok) {
                    gitCloneRepos.value = d.repos || [];
                    if (!gitCloneRepos.value.length) gitCloneReposError.value = 'Aucun dépôt accessible';
                } else {
                    var err = (d && (d.error || d.detail)) || 'Erreur';
                    gitCloneReposError.value = (err === 'no_api')
                        ? 'Ce connecteur ne supporte pas le listing des dépôts'
                        : ('Listing impossible : ' + err);
                }
            } catch (e) { gitCloneReposError.value = 'Erreur réseau'; }
            finally { gitCloneReposLoading.value = false; }
        }
        // Clic sur un dépôt : pré-remplit l'URL (l'utilisateur confirme « Cloner »).
        function gitPickRepo(repo) {
            if (!repo || !repo.clone_url) return;
            gitCloneForm.value.url = repo.clone_url;
            gitError.value = '';
        }

        // -- Stage / Unstage / Discard / Commit ---------------------
        async function gitStage(paths) {
            gitLoading.value = true;
            try { var r = await fetchAuth('/api/sandbox/git/stage', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({paths:paths||[]})) }); if (r && r.ok) { await gitRefresh(); } else { await _gitShowErr(r, 'Erreur stage'); } } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitUnstage(paths) {
            gitLoading.value = true;
            try { var r = await fetchAuth('/api/sandbox/git/unstage', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({paths:paths||[]})) }); if (r && r.ok) { await gitRefresh(); } else { await _gitShowErr(r, 'Erreur unstage'); } } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitDiscard(paths) {
            // UX: confirm() natif → openConfirm (modal Vue homogène).
            const msg = paths && paths.length
                ? `Annuler les modifications de ${paths.join(', ')} ?`
                : 'Annuler TOUTES les modifications ?';
            if (!await openConfirm(
                'Annuler les modifications',
                msg + '\n\nCette opération est irréversible.',
                true,
                'Annuler les modifs'
            )) return;
            gitLoading.value = true;
            try { var r = await fetchAuth('/api/sandbox/git/discard', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({paths:paths||[]})) }); if (r && r.ok) { await gitRefresh(); gitLoadTree(); loadSandboxFiles(); _gitReloadOpenTabs(); showToast('Modifications annulées'); } else { await _gitShowErr(r, 'Erreur'); } } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitCommit() {
            if (!gitCommitMsg.value.trim()) return;
            gitLoading.value = true;
            try {
                var r = await fetchAuth('/api/sandbox/git/commit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({message:gitCommitMsg.value})) });
                if (r && r.ok) { showToast('Commit effectué'); gitCommitMsg.value = ''; await gitRefresh(); gitLoadTree(); }
                else { await _gitShowErr(r, 'Erreur'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }

        // -- Push / Pull / Fetch -------------------------------------
        async function gitPush(force) {
            // On TENTE d'abord : le serveur résout les credentials depuis les
            // Connecteurs Git (Réglages). La modale d'auth ne s'affiche qu'en
            // cas d'échec d'authentification réel (branche else ci-dessous) —
            // plus de prompt proactif si un connecteur correspond au remote.
            gitLoading.value = true;
            try {
                var r = await fetchAuth('/api/sandbox/git/push', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gcreds(_gb({force:!!force}))) });
                if (r && r.ok) { showToast('Push réussi'); await gitRefresh(); }
                else if (!r) { showToast('Session expirée / erreur réseau', 'error'); }
                else {
                    var e = await r.json().catch(() => ({}));
                    var msg = e.detail || 'Erreur push';
                    // Auth error → show auth modal. 409 = refus du relais Git
                    // (ref hors de l'opération, redirection…) : pas une
                    // question d'identifiants, les redemander bouclerait.
                    if (r.status !== 409 && (msg.toLowerCase().indexOf('auth') !== -1 || msg.toLowerCase().indexOf('credential') !== -1 || msg.indexOf('403') !== -1 || msg.indexOf('401') !== -1)) {
                        _gitPendingPushForce = !!force;
                        showGitPushAuth.value = true;
                        showToast('Authentification requise', 'error');
                    } else {
                        showToast(msg, 'error');
                    }
                }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitPushAfterAuth() {
            showGitPushAuth.value = false;
            if (!gitCredUser.value || !gitCredToken.value) { showToast('Identifiants requis', 'error'); return; }
            await gitPush(_gitPendingPushForce);
        }
        async function gitPull(rebase) {
            gitLoading.value = true;
            try {
                var r = await fetchAuth('/api/sandbox/git/pull', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gcreds(_gb({rebase:!!rebase}))) });
                if (r && r.ok) { showToast('Pull réussi'); await gitRefresh(); gitLoadTree(); loadSandboxFiles(); _gitReloadOpenTabs(); }
                else { await _gitShowErr(r, 'Erreur pull'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitFetch() {
            gitLoading.value = true;
            try {
                var r = await fetchAuth('/api/sandbox/git/fetch', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({})) });
                if (r && r.ok) { showToast('Fetch terminé'); await gitLoadBranches(); }
                else { await _gitShowErr(r, 'Erreur fetch'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }

        // -- Branches ------------------------------------------------
        async function gitCheckout(branch, create) {
            gitLoading.value = true; showGitBranchMenu.value = false;
            try {
                var r = await fetchAuth('/api/sandbox/git/checkout', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({branch:branch,create:!!create})) });
                if (r && r.ok) { showToast('Branche : '+branch); await gitRefresh(); await gitLoadBranches(); gitLoadTree(); loadSandboxFiles(); _gitReloadOpenTabs(); }
                else { await _gitShowErr(r, 'Erreur'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitCreateBranch() {
            showGitBranchMenu.value = false;
            var name = await openPrompt('Nouvelle branche', '', 'nom-de-la-branche');
            if (name && name.trim()) gitCheckout(name.trim(), true);
        }

        // -- Merge / Rebase / Stash / Remote -------------------------
        async function gitRebase(branch) {
            if (!branch) return; gitLoading.value = true;
            try {
                var r = await fetchAuth('/api/sandbox/git/rebase', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({branch:branch})) });
                if (r && r.ok) { showToast('Rebase terminé'); await gitRefresh(); gitLoadTree(); loadSandboxFiles(); _gitReloadOpenTabs(); }
                else { await _gitShowErr(r, 'Erreur rebase'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        // (2026-09-19) « Merge » ouvre la fenêtre d'APERÇU (branche choisie
        // dans une liste, commits et fichiers montrés avant de fusionner) —
        // elle existait mais aucun bouton ne l'ouvrait.
        async function gitPromptMerge() {
            showGitMoreMenu.value = false;
            await gitOpenMergeModal();
        }
        async function gitPromptRebase() {
            showGitMoreMenu.value = false;
            var b = await openPrompt('Rebase sur quelle branche', '', 'nom-de-la-branche');
            if (b && b.trim()) gitRebase(b.trim());
        }
        async function gitStash(action, message) {
            gitLoading.value = true;
            try {
                var r = await fetchAuth('/api/sandbox/git/stash', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({action:action||'push',message:message||''})) });
                if (r && r.ok) { showToast(action==='pop'?'Stash appliqué':'Stash créé'); await gitRefresh(); gitLoadTree(); if (action !== 'list') { loadSandboxFiles(); _gitReloadOpenTabs(); } }
                else { await _gitShowErr(r, 'Erreur stash'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitSetRemote() {
            if (!gitRemoteForm.value.url) return; gitLoading.value = true;
            try {
                var r = await fetchAuth('/api/sandbox/git/remote', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({url:gitRemoteForm.value.url})) });
                if (r && r.ok) { showToast('Remote configuré'); showGitRemoteModal.value = false; await gitRefresh(); }
                else { await _gitShowErr(r, 'Erreur'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }

        // -- Merge modal (preview / execute / abort / resolve) ------
        async function gitOpenMergeModal() {
            await gitLoadBranches();
            gitMergeBranch.value = '';
            gitMergePreview.value = null;
            showGitMergeModal.value = true;
        }
        async function gitLoadMergePreview(branch) {
            if (!branch) { gitMergePreview.value = null; return; }
            gitMergeBranch.value = branch;
            gitLoading.value = true;
            try {
                var qp = _gq(); var sep = qp ? '&' : '?';
                var r = await fetchAuth('/api/sandbox/git/merge-preview' + qp + sep + 'branch=' + encodeURIComponent(branch), {}, true);
                if (r && r.ok) gitMergePreview.value = await r.json();
                else { await _gitShowErr(r, 'Erreur'); gitMergePreview.value = null; }
            } catch(e) { showToast('Erreur réseau', 'error'); gitMergePreview.value = null; }
            finally { gitLoading.value = false; }
        }
        async function gitExecuteMerge(strategy) {
            if (!gitMergeBranch.value) return;
            gitLoading.value = true;
            try {
                var r = await fetchAuth('/api/sandbox/git/merge', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({branch:gitMergeBranch.value, strategy: strategy || ''})) });
                if (r && r.ok) {
                    var d = await r.json();
                    if (d.conflicts) {
                        // Marqueurs de conflit écrits sur le disque : onglets
                        // propres rechargés pour les montrer (E9).
                        loadSandboxFiles(); _gitReloadOpenTabs();
                        // Merge has conflicts -- show them in the modal
                        gitMergePreview.value = Object.assign(
                            { commits: [], files: [], total_add: 0, total_del: 0 },
                            gitMergePreview.value || {},
                            { conflicts: d.conflicted_files || [] });
                        showToast(d.message || 'Conflits détectés', 'error');
                    } else {
                        showToast('Merge terminé');
                        showGitMergeModal.value = false;
                        await gitRefresh(); gitLoadTree(); loadSandboxFiles(); _gitReloadOpenTabs();
                    }
                } else { await _gitShowErr(r, 'Erreur merge'); }
            } catch(e) { showToast('Erreur', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitMergeAbort() {
            gitLoading.value = true;
            try {
                // FIX — avant, on affichait toujours « Merge annulé » même si
                // le backend renvoyait 401/erreur (réponse non testée) → faux
                // succès. On vérifie maintenant r.ok avant de notifier.
                var r = await fetchAuth('/api/sandbox/git/merge-abort', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({})) });
                if (r && r.ok) {
                    showToast('Merge annulé');
                    if (gitMergePreview.value) gitMergePreview.value.conflicts = null;
                    await gitRefresh(); gitLoadTree(); loadSandboxFiles(); _gitReloadOpenTabs();
                } else { await _gitShowErr(r, 'Erreur annulation merge'); }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            finally { gitLoading.value = false; }
        }
        async function gitMergeResolve(strategy, files) {
            gitLoading.value = true;
            try {
                var body = { strategy: strategy };
                if (Array.isArray(files) && files.length) body.files = files;
                var r = await fetchAuth('/api/sandbox/git/merge-resolve', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb(body)) });
                if (r && r.ok) {
                    var d = await r.json();
                    if (d.all_resolved) {
                        showToast('Conflits résolus -- merge commité');
                        showGitMergeModal.value = false;
                        if (gitMergePreview.value) gitMergePreview.value.conflicts = null;
                        await gitRefresh(); gitLoadTree(); loadSandboxFiles(); _gitReloadOpenTabs();
                    } else {
                        showToast(d.resolved + ' fichier(s) résolu(s)');
                        await gitRefresh();
                        // La liste de la fenêtre suit : seuls les fichiers encore
                        // en conflit restent.
                        if (gitMergePreview.value && gitStatus.value && Array.isArray(gitStatus.value.conflicted)) {
                            gitMergePreview.value = Object.assign({}, gitMergePreview.value, {
                                conflicts: gitStatus.value.conflicted.map(function(c) { return c.path; }),
                            });
                        }
                        loadSandboxFiles(); _gitReloadOpenTabs();
                    }
                } else { await _gitShowErr(r, 'Erreur'); }
            } catch(e) { showToast('Erreur', 'error'); }
            finally { gitLoading.value = false; }
        }

        // -- File tree / Log / Commit diff / Restore -----------------
        async function gitLoadTree() {
            var repo = gitCurrentRepo.value;   // (F3) capturé AVANT l'await — le préfixe aussi
            if (!repo) { gitTree.value = []; return; }
            try {
                var r = await fetchAuth('/api/sandbox/git/tree' + _gq(), {}, true);
                if (repo !== gitCurrentRepo.value) return;   // réponse périmée
                if (r && r.ok) {
                    var items = (await r.json()).items || [];
                    var pre = (repo && repo !== '.') ? (repo + '/') : '';
                    if (pre) { (function pfx(ns) { for (let n of ns) { n.path = pre + n.path; if (n.children) pfx(n.children); } })(items); }
                    if (repo !== gitCurrentRepo.value) return;   // (le json() a pu attendre aussi)
                    gitTree.value = items;
                }
            } catch(e) { if (repo === gitCurrentRepo.value) gitTree.value = []; }
        }
        async function gitLoadLog() {
            var repo = gitCurrentRepo.value;
            if (!repo) { gitLog.value = []; return; }
            try { var qp = _gq(); var sep = qp ? '&' : '?'; var r = await fetchAuth('/api/sandbox/git/log' + qp + sep + 'n=40', {}, true); if (repo !== gitCurrentRepo.value) return; if (r && r.ok) gitLog.value = (await r.json()).commits || []; } catch(e) { if (repo === gitCurrentRepo.value) gitLog.value = []; }
        }
        function gitOpenRepoFile(relPath) {
            var prefix = (gitCurrentRepo.value && gitCurrentRepo.value !== '.') ? (gitCurrentRepo.value + '/') : '';
            openFile(prefix + relPath);
        }
        async function gitViewCommitDiff(hash) {
            gitLoading.value = true;
            try {
                var qp = _gq(); var sep = qp ? '&' : '?';
                var r = await fetchAuth('/api/sandbox/git/commit-diff' + qp + sep + 'hash=' + encodeURIComponent(hash), {}, true);
                if (r && r.ok) {
                    var d = await r.json();
                    gitDiffData.value = { hash: hash, files: d.files || [], diff: d.diff, message: d.message, author: d.author, timestamp: d.timestamp };
                }
            } catch(e) {}
            finally { gitLoading.value = false; }
        }
        async function gitShowFileDiff(hash, filePath) {
            // Show side-by-side diff: file at hash~1 (before) vs file at hash (after)
            var prefix = (gitCurrentRepo.value && gitCurrentRepo.value !== '.') ? (gitCurrentRepo.value + '/') : '';
            var tabPath = prefix + filePath;
            // Binaire / aperçu Office : un diff texte n'aurait pas de sens.
            if (isViewerPath(tabPath)) {
                showToast('Diff indisponible pour ce type de fichier', 'info');
                return;
            }
            // (2026-09-21) L'affichage remplace le contenu du modèle VIVANT :
            // sur un onglet modifié, le travail non enregistré disparaissait
            // (et Ctrl+Z avec). On refuse tant qu'il n'est pas enregistré.
            if (_tabIsDirty(tabPath)) {
                showToast('Enregistrez d’abord ' + tabPath.split('/').pop()
                          + ' : la version du commit remplacerait vos modifications.', 'warning');
                return;
            }
            var qp = _gq(); var sep = qp ? '&' : '?';
            try {
                // Fetch before version (parent commit)
                var rBefore = await fetchAuth('/api/sandbox/git/show-file' + qp + sep + 'hash=' + encodeURIComponent(hash + '~1') + '&path=' + encodeURIComponent(filePath), {}, true);
                var before = (rBefore && rBefore.ok) ? (await rBefore.json()).content || '' : '';
                // Fetch after version (the commit itself)
                var rAfter = await fetchAuth('/api/sandbox/git/show-file' + qp + sep + 'hash=' + encodeURIComponent(hash) + '&path=' + encodeURIComponent(filePath), {}, true);
                var after = (rAfter && rAfter.ok) ? (await rAfter.json()).content || '' : '';
                // Open the file normally (creates tab + model with proper URI)
                await openFile(tabPath, false);
                // Modifié PENDANT les deux lectures ci-dessus : même refus.
                if (_tabIsDirty(tabPath)) {
                    showToast('Enregistrez d’abord ' + tabPath.split('/').pop()
                              + ' : la version du commit remplacerait vos modifications.', 'warning');
                    return;
                }
                // FIX (P0) — On affiche le contenu HISTORIQUE du commit dans le
                // model vivant. Sans précaution, ce setValue marque l'onglet
                // « dirty » et arme l'autosave / Ctrl+S, qui POSTeraient alors
                // l'ancienne version du commit sur le disque → écrasement
                // silencieux du travail courant sur un simple clic « voir le
                // diff ». On ferme la faille de deux façons :
                //   1. readOnlyTabs.add(path) → saveEditorContent() refuse de
                //      sauvegarder cet onglet (Ctrl+S et autosave bloqués).
                //   2. originalFileContent[path] = after → le baseline « disque »
                //      colle au contenu affiché, donc _tabIsDirty() = false :
                //      le timer d'autosave ne déclenche aucun POST.
                // Le verrou est levé par openFile dès que le model est
                // resynchronisé au disque (recréation du model ou
                // forceReload) — cf. purge readOnlyTabs dans la branche
                // texte d'openFile. Le diff sert à CONSULTER l'historique,
                // pas à éditer.
                if (_modelOk(tabPath)) {
                    if (readOnlyTabs && readOnlyTabs.value && typeof readOnlyTabs.value.add === 'function') {
                        readOnlyTabs.value.add(tabPath);
                    }
                    models[tabPath].setValue(after);
                    if (originalFileContent) originalFileContent[tabPath] = after;
                    // Si le fichier était DÉJÀ l'onglet actif, le watcher
                    // readOnly (déclenché uniquement sur CHANGEMENT
                    // d'activeTabPath) ne se redéclenche pas : Monaco
                    // resterait éditable sur du contenu historique (frappes
                    // perdues à la fermeture, autosave refusé en silence).
                    // Application explicite de l'option pour l'onglet actif.
                    applyActiveReadOnly();
                }
                // Use the existing diff viewer with "before" as original
                showDiffForMessage(tabPath, before);
            } catch(e) { showToast('Erreur chargement diff', 'error'); }
        }
        async function gitRestoreCommit(hash) {
            if (!await openConfirm(
                'Restaurer un commit',
                `Restaurer vers ${hash.substring(0,8)} ?\n\nUn nouveau commit sera créé pour enregistrer la restauration.`,
                false,
                'Restaurer'
            )) return;
            gitLoading.value = true;
            try { var r = await fetchAuth('/api/sandbox/git/restore-commit', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({hash:hash})) }); if (r && r.ok) { showToast('Restauré'); await gitRefresh(); await gitLoadLog(); gitLoadTree(); loadSandboxFiles(); _gitReloadOpenTabs(); } else { await _gitShowErr(r, 'Erreur'); } } catch(e) { showToast('Erreur','error'); }
            finally { gitLoading.value = false; }
        }
        async function gitRevertLast() {
            if (!await openConfirm(
                'Annuler le dernier commit',
                'Un commit de revert sera ajouté par-dessus. L\'historique reste intact.',
                false,
                'Annuler le commit'
            )) return;
            gitLoading.value = true;
            try { var r = await fetchAuth('/api/sandbox/git/revert-last', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_gb({})) }); if (r && r.ok) { showToast('Commit annulé'); await gitRefresh(); await gitLoadLog(); gitLoadTree(); loadSandboxFiles(); _gitReloadOpenTabs(); } else { await _gitShowErr(r, 'Erreur'); } } catch(e) { showToast('Erreur','error'); }
            finally { gitLoading.value = false; }
        }

        // Résoudre UN fichier en conflit (mienne = ours, leur = theirs).
        function gitResolveFile(strategy, file) {
            if (!file) return;
            return gitMergeResolve(strategy, [file]);
        }

        // -- Message de commit proposé par l'IA ----------------------
        // Diff INDEXÉ → complétion (même serveur et même choix de modèle que
        // les actions IA de l'éditeur). Le message reste modifiable.
        const gitCommitSuggesting = ref(false);
        async function gitSuggestCommitMessage() {
            if (gitCommitSuggesting.value) return;
            if (!gitStatus.value || !gitStatus.value.staged || !gitStatus.value.staged.length) {
                showToast('Indexez d\'abord les fichiers à commiter', 'info');
                return;
            }
            var all    = (ctx.availableModels && ctx.availableModels.value) || [];
            var loaded = (ctx.activeModelIds  && ctx.activeModelIds.value)  || [];
            var modelId = loaded.find(function(id) { return all.includes(id); }) || all[0] || null;
            if (!modelId) { showToast('Aucun modèle disponible', 'warning'); return; }
            gitCommitSuggesting.value = true;
            try {
                var qp = _gq(); var sep = qp ? '&' : '?';
                var rd = await fetchAuth('/api/sandbox/git/diff' + qp + sep + 'staged=1', {}, true);
                if (!rd || !rd.ok) { await _gitShowErr(rd, 'Diff indisponible'); return; }
                var diff = ((await rd.json()).diff || '').slice(0, 8000);
                if (!diff.trim()) { showToast('Rien d\'indexé', 'info'); return; }
                var prefix = 'Diff des changements indexés :\n\n' + diff
                    + '\n\nMessage de commit Git correspondant, une seule ligne, à l\'impératif, '
                    + '72 caractères maximum, sans guillemets :\n';
                var r = await fetchAuth('/api/llm/infill', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input_prefix: prefix, input_suffix: '\n', model: modelId }),
                });
                if (!r || !r.ok) { await _gitShowErr(r, 'Suggestion impossible'); return; }
                var d = await r.json();
                var line = String((d && d.content) || '').split('\n')
                    .map(function(l) { return l.trim(); })
                    .find(function(l) { return l && !/^```/.test(l); }) || '';
                line = line.replace(/^["'`«\s]+|["'`»\s]+$/g, '').slice(0, 100);
                if (!line) { showToast('Pas de suggestion', 'warning'); return; }
                gitCommitMsg.value = line;
            } catch (e) { showToast('Erreur réseau', 'error'); }
            finally { gitCommitSuggesting.value = false; }
        }

        // -- Statut en arrière-plan (2026-09-19) ---------------------
        // Pastilles de l'arbre, branche de la barre d'état et marge du code
        // ont besoin du statut même quand la vue Git est fermée.
        async function gitBackgroundInit() {
            await gitLoadRepos();
            if (gitCurrentRepo.value) await gitRefresh();
        }

        // -- Cross-module helpers ------------------------------------
        // Auto-refresh git status after saving / renaming / moving / deleting.
        // Called from file CRUD paths in app-editor.js. Le STATUT se rafraîchit
        // toujours (débouncé : une rafale d'enregistrements = un appel) ;
        // l'arborescence du dépôt seulement si la vue Git est ouverte.
        let _autoRefreshTimer = null;
        function _gitAutoRefresh() {
            clearTimeout(_autoRefreshTimer);
            _autoRefreshTimer = setTimeout(function() {
                if (!gitRepos.value.length) { gitLoadRepos().then(function() { if (gitCurrentRepo.value) gitRefresh(); }); return; }
                if (!gitCurrentRepo.value) return;
                gitRefresh();
                if (explorerTab.value === 'git') gitLoadTree();
            }, 600);
        }
        // After branch switch / pull / merge / restore: reload every tab
        // inside the current repo so stale buffers aren't saved back.
        // Dirty tabs are preserved (no silent data-loss) and flagged instead.
        function _gitReloadOpenTabs() {
            var pre = (gitCurrentRepo.value && gitCurrentRepo.value !== '.') ? (gitCurrentRepo.value + '/') : '';
            var kept = [];
            openTabs.value.forEach(function(tab) {
                if (!pre || tab.path.startsWith(pre)) {
                    // FIX (P1) — On délègue la détection « dirty » à _tabIsDirty
                    // (app-editor.js), qui compare models[path].getValue() au
                    // baseline originalFileContent[path]. L'ancien code testait
                    // `typeof originalFileContent` dans cette closure où la const
                    // n'a jamais été en portée → toujours 'undefined' → orig=null
                    // → dirty=true pour TOUT onglet → aucun reload disque après
                    // pull/merge/checkout/rebase/restore/revert, et un faux toast
                    // « Modifs non sauvegardées conservées ». originalFileContent
                    // est désormais passé dans sharedRefs.
                    if (_tabIsDirty(tab.path)) { kept.push(tab.path); return; }
                    // Sans changer d'onglet actif (cf. _gitReloadTab).
                    Promise.resolve(reloadTab(tab.path)).catch(function() {});
                }
            });
            // Onglets modifiés : plus d'alerte générale pour tout le dépôt —
            // la comparaison par empreinte ne signale (bandeau) que ceux dont
            // le fichier a VRAIMENT changé sur le disque.
            if (kept.length) checkDisk();
        }

        // -- Public surface ------------------------------------------
        return {
            // State
            explorerTab,
            gitRepos, gitCurrentRepo,
            gitStatus, gitBranches, gitCommitMsg, gitLoading, gitError,
            showGitCloneModal, gitCloneForm, showGitBranchMenu,
            gitCloneConnectorId, gitCloneRepos, gitCloneReposLoading,
            gitCloneReposError, gitCloneRepoFilter, gitFilteredCloneRepos,
            showGitRemoteModal, gitRemoteForm,
            showGitInitModal, gitInitForm, showGitMoreMenu,
            showGitRepoMenu, showExplorerMenu,
            showGitMergeModal, gitMergePreview, gitMergeBranch,
            showGitPushAuth, gitCredShowPwd,
            gitTree, gitLog, gitDiffData,
            gitCredUser, gitCredToken, gitSectionOpen,

            // Actions
            gitOpenTab, gitSelectRepo, gitLoadRepos, gitRefresh, gitLoadBranches,
            gitInit, gitClone, gitOpenCloneModal, gitLoadConnectorRepos, gitPickRepo,
            gitStage, gitUnstage, gitDiscard, gitCommit,
            gitPush, gitPushAfterAuth, gitPull, gitFetch,
            gitCheckout, gitCreateBranch,
            gitRebase, gitPromptMerge, gitPromptRebase, gitStash, gitSetRemote,
            gitOpenMergeModal, gitLoadMergePreview, gitExecuteMerge,
            gitMergeAbort, gitMergeResolve,
            gitLoadTree, gitLoadLog, gitOpenRepoFile,
            gitViewCommitDiff, gitShowFileDiff, gitRestoreCommit, gitRevertLast,

            gitBackgroundInit, gitResolveFile, gitSuggestCommitMessage, gitCommitSuggesting,

            // Cross-module hooks (called from app-editor.js)
            _gitAutoRefresh,
            _gitReloadOpenTabs,
            resetOnLogout,
        };
    }

    window.setupEditorGit = setupEditorGit;
})();
