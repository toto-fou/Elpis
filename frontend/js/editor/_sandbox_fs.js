// SPDX-License-Identifier: MIT
// ============================================================
//  static/js/editor/_sandbox_fs.js -- Extracted from app-editor.js
//
//  All sandbox file-system operations for the editor explorer.
//
//  Responsibilities
//  ----------------
//  • loadSandboxFiles / loadSandboxQuota -- refresh the tree + quota
//    badge.
//  • downloadFile -- open the backend's download stream in a new tab.
//  • createFolder / createFile -- prompt for name, POST, refresh, open.
//  • moveItem / renameItem / deleteFile -- the three destructive ops.
//    moveItem is guarded by an in-flight flag (_movePending) so a
//    user-held drop-and-hold doesn't fire twice. renameItem closes
//    and re-opens the moved tab because Monaco can't mutate URIs.
//  • Sandbox search -- both a backend-side debounced search AND a
//    client-side computed filteredFilesList (VS Code quick-open style
//    flat list over the in-memory tree). Two watchers: one on the query
//    text with a 350ms debounce, one on the mode toggle.
//  • openFileAtLine -- open file then center-scroll + position cursor.
//  • triggerSandboxImport / handleSandboxImport -- drive the hidden
//    <input type="file"> and <input webkitdirectory>, multipart-upload
//    the result. Preserves folder structure via webkitRelativePath.
//
//  Contract
//  --------
//  Loaded BEFORE app-editor.js. Exposes on window:
//      window.setupEditorSandboxFs(vue, sharedRefs, ctx, callbacks)
//
//  Dependencies
//  ------------
//  From sharedRefs : sandboxFiles, sandboxQuota, isLoadingFiles,
//                    sandboxSearch, sandboxSearchMode,
//                    sandboxSearchResults, isSearchingSandbox,
//                    sandboxFileInput, sandboxFolderInput, showImportMenu,
//                    openTabs, activeTabPath, editorFilePath,
//                    models, originalFileContent, monacoRef
//  From ctx        : showToast, fetchAuth, openConfirm, openPrompt
//  From callbacks  : _sbUrl, openFile, closeTab, _migrateModel,
//                    _gitAutoRefresh
//                    (all captured at setup time, resolved at call
//                    time so they may reference later-defined fns.)
// ============================================================

(function() {
    'use strict';

    function setupEditorSandboxFs(vue, sharedRefs, ctx, callbacks) {
        const { ref, watch } = vue;
        const {
            sandboxFiles, sandboxQuota, isLoadingFiles,
            sandboxSearch, sandboxSearchMode,
            sandboxSearchResults, isSearchingSandbox,
            sandboxFileInput, sandboxFolderInput, showImportMenu,
            openTabs, activeTabPath, editorFilePath,
            models, originalFileContent, monacoRef,
            showHiddenFiles,
        } = sharedRefs;
        const { showToast, fetchAuth, openConfirm, openPrompt } = ctx;
        const {
            _sbUrl            = (e) => '/api/sandbox/' + e,
            openFile          = () => Promise.resolve(),
            closeTab          = () => {},
            _migrateModel     = () => {},
            _gitAutoRefresh   = () => {},
            // Vrai si le chemin s'affiche hors Monaco (image, hex, office, docx).
            isSpecialPath     = () => false,
            // Onglet ouvert ET modifié (exclu d'un remplacement multi-fichiers).
            isPathDirty       = () => false,
            // Fichiers réécrits par « Remplacer » : l'éditeur recharge ses onglets.
            onFilesReplaced   = () => {},
            // Chemin → mtime connu après une écriture faite hors de /save.
            setBaseMtime      = () => {},
            // Renommage / déplacement réussi : l'éditeur migre ses états liés
            // au chemin (version de base pour /save, conflits, copies gardées).
            onPathsMoved      = () => {},
        } = callbacks || {};
        // État d'arbre partagé (utils.js) ; repli neutre si absent (tests,
        // page sans explorateur) : une action vise alors la seule ligne.
        const _TREE_STUB = {
            targetsFor: (p) => (p ? [p] : []), clearSelection() {}, reveal() {}, select() {},
        };
        const _T = () => (typeof window !== 'undefined' && window.elpisTree) || _TREE_STUB;

        // Réponse d'erreur lisible (FastAPI : ``detail`` texte ou objet).
        async function _errDetail(res, fallback) {
            if (!res) return 'Session expirée / erreur réseau';
            try {
                const d = await res.json();
                const det = d && d.detail;
                if (typeof det === 'string' && det) return det;
                if (det && typeof det === 'object' && det.message) return det.message;
            } catch (_) {}
            return fallback;
        }

        // Tous les fichiers (pas les dossiers) sous ``path`` d'après l'arbre
        // chargé ; ``path`` lui-même s'il s'agit d'un fichier.
        function _filesUnder(path) {
            const out = [];
            const walk = (nodes) => {
                for (const n of (nodes || [])) {
                    if (n.path === path || n.path.startsWith(path + '/')) {
                        if (n.type === 'file') out.push(n.path);
                        else if (n.children) walk(n.children);
                    } else if (n.type === 'folder' && path.startsWith(n.path + '/') && n.children) {
                        walk(n.children);
                    }
                }
            };
            walk(sandboxFiles.value);
            return out;
        }
        function _isFolderPath(path) {
            let found = null;
            const walk = (nodes) => {
                for (const n of (nodes || [])) {
                    if (found !== null) return;
                    if (n.path === path) { found = n.type === 'folder'; return; }
                    if (n.type === 'folder' && path.startsWith(n.path + '/')) walk(n.children);
                }
            };
            walk(sandboxFiles.value);
            return !!found;
        }

        // ==============================================================
        //  FILE SYSTEM OPERATIONS
        // ==============================================================

        // Arborescence tronquée par le plafond serveur : { max } ou null.
        const treeTruncated = ref(null);

        // (passe sandbox 2026-09-26) — appels CONCURRENTS fusionnés : chaque
        // opération (mkdir, rename, copie, suppression…) rechargeait tout
        // l'arbre (/tree : jusqu'à 20 000 entrées, un JSON de plusieurs Mo,
        // remplacé en bloc dans Vue). Une rafale d'actions ne déclenche plus
        // qu'un chargement en vol + au plus un rechargement final.
        let _treeLoading = null, _treeAgain = false;
        function loadSandboxFiles() {
            if (_treeLoading) { _treeAgain = true; return _treeLoading; }
            _treeLoading = (async () => {
                try {
                    do { _treeAgain = false; await _loadSandboxFilesOnce(); } while (_treeAgain);
                } finally { _treeLoading = null; }
            })();
            return _treeLoading;
        }
        async function _loadSandboxFilesOnce() {
            isLoadingFiles.value = true;
            try {
                // Dotfiles masqués par défaut ; ré-inclus si le toggle est actif.
                const url = (showHiddenFiles && showHiddenFiles.value)
                    ? _sbUrl('tree') + '?include_hidden=1' : _sbUrl('tree');
                const res = await fetchAuth(url, {}, true);
                if (res && res.ok) {
                    const data = await res.json();
                    sandboxFiles.value = data.items || [];
                    // Le serveur plafonne le nombre d'entrées (une sandbox avec
                    // node_modules figeait l'explorateur). On le DIT plutôt que
                    // de laisser croire que des fichiers ont disparu.
                    treeTruncated.value = data.truncated
                        ? { max: data.max_entries || 0 } : null;
                }
            } catch(e) {}
            finally { isLoadingFiles.value = false; }
            scheduleQuotaRefresh();
        }
        // Bascule « Afficher les fichiers cachés » (persisté par appareil) + recharge.
        function toggleHiddenFiles() {
            if (!showHiddenFiles) return;
            showHiddenFiles.value = !showHiddenFiles.value;
            try { localStorage.setItem('elpis.showHiddenFiles', showHiddenFiles.value ? '1' : '0'); } catch (_) {}
            loadSandboxFiles();
        }


        // ==============================================================
        //  QUOTA SANDBOX — refresh fiable et debouncé
        // ==============================================================
        //  Avant : loadSandboxQuota n'était appelé QUE depuis
        //  loadSandboxFiles → le quota ne se rafraîchissait jamais après
        //  un save éditeur ni après une commande terminal. D'où un
        //  affichage "aléatoire".
        //
        //  Maintenant :
        //   • ``loadSandboxQuota()``    — fetch immédiat (boot, refresh manuel)
        //   • ``scheduleQuotaRefresh()` — version debouncée (600ms) : à
        //     appeler après chaque opération qui modifie le sandbox
        //     (save, create, delete, upload, git…). Les appels rapprochés
        //     se fondent en un seul fetch.
        //
        //  Le polling périodique (capter les changements terminal) est
        //  géré dans app-editor.js.
        // ==============================================================
        let _quotaDebounceTimer = null;

        async function loadSandboxQuota() {
            try {
                const res = await fetchAuth(_sbUrl('quota'), {}, true);
                if (res && res.ok) sandboxQuota.value = await res.json();
            } catch(e) {}
        }

        function scheduleQuotaRefresh() {
            if (_quotaDebounceTimer) clearTimeout(_quotaDebounceTimer);
            _quotaDebounceTimer = setTimeout(() => {
                _quotaDebounceTimer = null;
                loadSandboxQuota();
            }, 600);
        }

        async function downloadFile(path) {
            const targets = _T().targetsFor(path);
            if (targets.length <= 1) {
                window.open(_sbUrl('download?path=') + encodeURIComponent(path), '_blank');
                return;
            }
            // Sélection multiple : un seul zip (les dossiers sont développés en
            // leurs fichiers — la route multi ne prend que des fichiers).
            const files = [];
            targets.forEach(p => _filesUnder(p).forEach(f => { if (!files.includes(f)) files.push(f); }));
            if (!files.length) { showToast('Rien à télécharger', 'error'); return; }
            try {
                const res = await fetchAuth(_sbUrl('download-multi'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paths: files }),
                });
                if (!res || !res.ok) { showToast(await _errDetail(res, 'Téléchargement impossible'), 'error'); return; }
                const blob = await res.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'sandbox-' + files.length + '-fichiers.zip';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
            } catch (_) { showToast('Erreur réseau', 'error'); }
        }

        async function createFolder(parentPath) {
            // Ceinture-bretelles : un handler template en référence de méthode
            // passerait l'event DOM (truthy) — il serait stringifié dans le chemin.
            if (typeof parentPath !== 'string') parentPath = '';
            const label = parentPath ? `Nouveau dossier dans ${parentPath}/` : 'Nouveau dossier';
            const name = await openPrompt(label, '', parentPath ? 'nom du dossier' : 'ex: src/utils');
            if (!name || !name.trim()) return;
            const fullPath = parentPath ? parentPath + '/' + name.trim() : name.trim();
            try {
                const res = await fetchAuth(_sbUrl('mkdir'), {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ path: fullPath }),
                });
                if (res && res.ok) { showToast('Dossier créé'); loadSandboxFiles(); }
                else showToast('Erreur création dossier', 'error');
            } catch(e) { showToast('Erreur réseau', 'error'); }
        }

        async function createFile(parentPath) {
            // Ceinture-bretelles : cf. createFolder — jamais d'event DOM en chemin.
            if (typeof parentPath !== 'string') parentPath = '';
            const label = parentPath ? `Nouveau fichier dans ${parentPath}/` : 'Nouveau fichier';
            const name = await openPrompt(label, '', parentPath ? 'nom du fichier' : 'ex: main.py');
            if (!name || !name.trim()) return;
            const fullPath = parentPath ? parentPath + '/' + name.trim() : name.trim();
            try {
                const res = await fetchAuth(_sbUrl('save'), {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // ``if_absent`` : un nom déjà pris n'est jamais vidé.
                    body:    JSON.stringify({ path: fullPath, content: '', if_absent: true }),
                });
                if (res && res.status === 409) {
                    const choice = ctx.openChoice
                        ? await ctx.openChoice('Ce fichier existe déjà', fullPath, [
                              { id: 'open', label: 'Ouvrir', tone: 'primary' },
                          ])
                        : null;
                    if (choice === 'open') await openFile(fullPath, true);
                    return;
                }
                if (res && res.ok) {
                    showToast('Fichier créé');
                    await loadSandboxFiles();
                    // await pour que activeTabPath soit bien
                    // positionné avant que l'utilisateur ne presse Ctrl+S.
                    // Sans await, un Ctrl+S immédiat ciblait l'ancien onglet
                    // actif (ou null) et la création semblait "sans effet".
                    await openFile(fullPath, true);
                } else {
                    showToast('Erreur création fichier', 'error');
                }
            } catch(e) { showToast('Erreur réseau', 'error'); }
        }

        // Déplacements EN FILE : glisser une sélection multiple en émet un par
        // élément (l'ancien verrou « un seul à la fois » jetait les suivants).
        // Un doublon exact rapproché (dépôt qui tire deux fois) est ignoré.
        let _moveChain = Promise.resolve();
        let _lastMove = { key: '', at: 0 };
        function moveItem(oldPath, newParentPath) {
            if (!oldPath) return _moveChain;
            const key = oldPath + '\u0000' + (newParentPath || '');
            if (_lastMove.key === key && Date.now() - _lastMove.at < 1500) return _moveChain;
            _lastMove = { key, at: Date.now() };
            _moveChain = _moveChain.then(() => _moveOne(oldPath, newParentPath)).catch(() => {});
            return _moveChain;
        }
        async function _moveOne(oldPath, newParentPath) {
            const fileName = oldPath.split('/').pop();
            const newPath = newParentPath ? newParentPath + '/' + fileName : fileName;
            if (oldPath === newPath) return;
            try {
                const res = await fetchAuth(_sbUrl('rename'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
                });
                if (res && res.ok) {
                    showToast('Déplacé vers ' + (newParentPath || '/')); _gitAutoRefresh();

                    // Migrate Monaco models (file or all files inside moved folder)
                    const pathsToMigrate = Object.keys(models).filter(p => p === oldPath || p.startsWith(oldPath + '/'));
                    for (const p of pathsToMigrate) {
                        const migrated = p === oldPath ? newPath : newPath + p.substring(oldPath.length);
                        _migrateModel(p, migrated);
                        // Migrate original content snapshot for diff/dirty detection
                        if (originalFileContent[p] !== undefined) {
                            originalFileContent[migrated] = originalFileContent[p];
                            delete originalFileContent[p];
                        }
                    }
                    try { onPathsMoved(oldPath, newPath); } catch (_) {}

                    // Update open tabs
                    openTabs.value = openTabs.value.map(t => {
                        if (t.path === oldPath) return { ...t, path: newPath, name: fileName };
                        if (t.path.startsWith(oldPath + '/')) {
                            const np = newPath + t.path.substring(oldPath.length);
                            return { ...t, path: np, name: np.split('/').pop() };
                        }
                        return t;
                    });
                    if (activeTabPath.value === oldPath) activeTabPath.value = newPath;
                    else if (activeTabPath.value && activeTabPath.value.startsWith(oldPath + '/')) activeTabPath.value = newPath + activeTabPath.value.substring(oldPath.length);

                } else {
                    // PASSE — FIX UX : sans branche else, un échec backend
                    // (collision de nom à destination, 4xx, 401 → res null)
                    // était silencieux : le loadSandboxFiles ci-dessous
                    // faisait re-snapper l'item à sa place d'origine, donnant
                    // l'impression que « le fichier ne bouge pas ». On lit le
                    // detail comme dans renameItem pour expliquer la cause.
                    var errData = {};
                    try { errData = await res.json(); } catch(_) {}
                    showToast(errData.detail || 'Déplacement impossible (nom déjà utilisé ?)', 'error');
                }
                await loadSandboxFiles();
            } catch(e) {
                showToast('Erreur réseau', 'error');
                await loadSandboxFiles();
            }
        }

        async function renameItem(oldPath) {
            // FIX UX/DATA-LOSS : on demande désormais le nouveau
            // BASENAME (pas le path complet). Avant, openPrompt remplissait
            // l'input avec oldPath ('src/utils/foo.py') et utilisait newName
            // tel quel comme new_path. Deux pièges :
            //   • l'utilisateur ne sélectionnait que la portion basename
            //     puis tapait par-dessus → le fichier sautait au root.
            //   • un clear accidentel envoyait '' au backend.
            // Maintenant : prompt = basename, on reconstruit le path complet.
            var oldBase = oldPath.split('/').pop();
            var parent  = oldPath.includes('/')
                ? oldPath.substring(0, oldPath.lastIndexOf('/'))
                : '';
            var newName = await openPrompt('Renommer', oldBase, 'nouveau nom');
            if (!newName) return;
            newName = newName.trim();
            if (!newName || newName === oldBase) return;
            // Garde-fou : interdire séparateur dans le basename (sinon c'est
            // un déplacement déguisé — qu'on veut faire passer par moveItem).
            if (newName.includes('/') || newName.includes('\\')) {
                showToast('Le nom ne peut pas contenir « / » — utilisez le drag-and-drop pour déplacer', 'error');
                return;
            }
            var newPath = parent ? (parent + '/' + newName) : newName;
            // Détection des extensions à viewer spécial (image,
            // hex, docx). Pour ces fichiers, _migrateModel seul ne suffit
            // pas : readOnlyTabs / imageViewerPath / hexViewerData portent
            // l'ancien path et NE SONT PAS MIGRÉS ici (ils vivent dans
            // app-editor.js, pas dans sharedRefs). On retombe sur le flux
            // historique closeTab+openFile qui re-initialise tout
            // proprement pour ces cas. Pas de perte UX : aucun curseur/
            // scroll/undo à préserver dans un viewer image ou hex.
            // (2026-09-15) Même règle que l'éditeur (mode de vue ≠ Monaco),
            // aperçus Office et binaires détectés compris — plus de liste
            // d'extensions dupliquée qui dérive.
            var _isSpecial = isSpecialPath(newPath) || isSpecialPath(oldPath);
            try {
                const res = await fetchAuth(_sbUrl('rename'), {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ old_path: oldPath, new_path: newPath }),
                });
                if (res && res.ok) {
                    showToast('Renommé !'); _gitAutoRefresh();
                    if (_isSpecial) {
                        // Flux historique : ferme l'onglet (force=true, le
                        // rename est intentionnel) puis ré-ouvre au nouveau
                        // path. openFile() re-initialise tous les viewers
                        // (image, hex, docx) et readOnlyTabs correctement.
                        const wasOpen = !!openTabs.value.find(t => t.path === oldPath);
                        if (wasOpen) {
                            // Fermeture NON forcée si l'onglet est modifié (E24) :
                            // la confirmation habituelle propose d'enregistrer
                            // (sous l'ancien nom) au lieu de jeter le tampon.
                            try { await closeTab(oldPath, null, !isPathDirty(oldPath)); } catch(_) {}
                            try { await openFile(newPath, true); } catch(_) {}
                        }
                        await loadSandboxFiles();
                        return;
                    }
                    // Migration in-place du modèle Monaco
                    // (préserve curseur/scroll/dirty) au lieu de
                    // closeTab + openFile qui :
                    //  • affichait une confirm "fermer sans sauvegarder ?"
                    //    en plein milieu d'un rename intentionnel,
                    //  • reset le viewState,
                    //  • laissait un état dual si l'user cliquait Annuler.
                    // ⚠ L'historique Ctrl+Z, lui, repart de zéro : Monaco
                    // n'a aucune API pour transférer une pile d'annulation,
                    // et garder l'ancien modèle (URI de l'ancien chemin)
                    // ferait partager ce tampon à un fichier recréé à
                    // l'ancien chemin (constat 2026-09-21, laissé en l'état).
                    const pathsToMigrate = Object.keys(models).filter(p => p === oldPath || p.startsWith(oldPath + '/'));
                    for (const p of pathsToMigrate) {
                        const migrated = (p === oldPath) ? newPath : (newPath + p.substring(oldPath.length));
                        try { _migrateModel(p, migrated); } catch(_) {}
                        if (originalFileContent[p] !== undefined) {
                            originalFileContent[migrated] = originalFileContent[p];
                            delete originalFileContent[p];
                        }
                    }
                    try { onPathsMoved(oldPath, newPath); } catch (_) {}
                    // Met à jour les onglets ouverts
                    openTabs.value = openTabs.value.map(t => {
                        if (t.path === oldPath) return { ...t, path: newPath, name: newName };
                        if (t.path.startsWith(oldPath + '/')) {
                            const np = newPath + t.path.substring(oldPath.length);
                            return { ...t, path: np, name: np.split('/').pop() };
                        }
                        return t;
                    });
                    if (activeTabPath.value === oldPath) {
                        activeTabPath.value = newPath;
                    } else if (activeTabPath.value && activeTabPath.value.startsWith(oldPath + '/')) {
                        activeTabPath.value = newPath + activeTabPath.value.substring(oldPath.length);
                    }
                    await loadSandboxFiles();
                } else {
                    var errData = {};
                    try { errData = await res.json(); } catch(_) {}
                    showToast(errData.detail || 'Erreur renommage', 'error');
                }
            } catch(e) { showToast('Erreur réseau', 'error'); }
        }

        async function deleteFile(path) {
            // Sélection multiple : toute la sélection (sans les descendants
            // d'un dossier déjà choisi), une seule confirmation.
            const targets = _T().targetsFor(path);
            if (!targets.length) return;
            const confirmed = targets.length > 1
                ? await openConfirm('Supprimer ' + targets.length + ' éléments ?', targets.join('\n'), true)
                : await openConfirm('Supprimer ?', path, true);
            if (!confirmed) return;
            // (passe sandbox 2026-09-26) — un élément contenu dans un dossier
            // lui-même sélectionné partirait avec lui : sa propre requête
            // tombait en 404 et comptait comme un échec.
            const roots = targets.filter(t => !targets.some(o => o !== t && t.startsWith(o + '/')));
            // Fermer les onglets AVANT les requêtes backend, avec force=true
            // (l'utilisateur vient d'accepter la perte de données). Un DOSSIER
            // ferme aussi les onglets de ses fichiers : avant, ils restaient
            // ouverts sur des fichiers morts.
            for (const target of roots) {
                const doomed = openTabs.value.map(t => t.path)
                    .filter(p => p === target || p.startsWith(target + '/'));
                for (const p of doomed) {
                    try { await closeTab(p, null, true); } catch(_) {}
                }
            }
            // Suppressions en parallèle, 4 à la fois (avant : N allers-retours
            // en série — 50 éléments = 50 latences cumulées).
            let failed = 0, next = 0;
            const worker = async () => {
                while (next < roots.length) {
                    const target = roots[next++];
                    try {
                        const res = await fetchAuth(
                            _sbUrl('delete?path=') + encodeURIComponent(target),
                            { method: 'DELETE' }
                        );
                        if (!res || !res.ok) failed++;
                    } catch(e) { failed++; }
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, roots.length) }, worker));
            _T().clearSelection();
            await loadSandboxFiles();
            _gitAutoRefresh();
            if (failed) showToast(failed === roots.length ? 'Erreur suppression' : (failed + ' élément(s) non supprimé(s)'), 'error');
            else showToast(targets.length > 1 ? targets.length + ' éléments supprimés' : 'Supprimé');
        }

        // « Dupliquer » : « nom copie.ext », puis « nom copie 2.ext »… — jamais
        // d'écrasement (la route refuse une cible existante).
        function _copyName(path, n) {
            const slash = path.lastIndexOf('/');
            const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
            const base = path.slice(slash + 1);
            const dot = base.lastIndexOf('.');
            const stem = dot > 0 ? base.slice(0, dot) : base;
            const ext = dot > 0 ? base.slice(dot) : '';
            return dir + stem + ' copie' + (n > 1 ? ' ' + n : '') + ext;
        }
        function _pathExists(p) {
            let found = false;
            const walk = (nodes) => {
                for (const n of (nodes || [])) {
                    if (found) return;
                    if (n.path === p) { found = true; return; }
                    if (n.type === 'folder' && p.startsWith(n.path + '/')) walk(n.children);
                }
            };
            walk(sandboxFiles.value);
            return found;
        }
        async function duplicateItem(path) {
            if (!path) return;
            let n = 1, dst = _copyName(path, 1);
            while (_pathExists(dst) && n < 100) { n++; dst = _copyName(path, n); }
            const isFolder = _isFolderPath(path);
            try {
                const res = await fetchAuth(_sbUrl('copy'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ src: path, dst }),
                });
                if (!res || !res.ok) { showToast(await _errDetail(res, 'Copie impossible'), 'error'); return; }
                await loadSandboxFiles();
                _gitAutoRefresh();
                _T().reveal(dst);
                _T().select(dst, 'single');
                if (!isFolder) await openFile(dst, true);
                showToast('Copie créée : ' + dst.split('/').pop());
            } catch (_) { showToast('Erreur réseau', 'error'); }
        }

        // -- Sandbox search (debounced) -------------------------------
        // Options du mode « Contenu » (2026-09-19) : casse, regex, filtre de
        // nom — servies par POST /grep (500 résultats, fichiers ≤ 5 Mo).
        const searchCase    = ref(false);
        const searchRegex   = ref(false);
        const searchGlob    = ref('');
        const searchTruncated = ref(false);
        const searchError   = ref('');
        // Remplacement multi-fichiers : aperçu d'abord, application ensuite.
        const showReplace    = ref(false);
        const replaceText    = ref('');
        const replacePreview = ref(null);  // { files:[{path,count,samples,skip}], total }
        const replaceBusy    = ref(false);
        let _sandboxSearchTimer = null;

        // AUDIT 2026-08-31 (passe 3) — jeton d'obsolescence : le mode
        // « Contenu » greppe toute la sandbox (plusieurs secondes) ; sans
        // jeton, une réponse LENTE arrivée après une plus récente écrasait
        // les bons résultats et son finally éteignait le spinner de la
        // requête encore en vol. Même patron que la recherche in-chat
        // (passe 1) et loadChat (passe 2).
        let _sbSearchSeq = 0;

        async function _doSandboxSearch(val, mode) {
            if (!val || !val.trim()) {
                _sbSearchSeq++;                    // invalide tout fetch en vol
                sandboxSearchResults.value = [];
                isSearchingSandbox.value   = false;
                return;
            }
            const _seq = ++_sbSearchSeq;
            isSearchingSandbox.value = true;
            searchError.value = '';
            replacePreview.value = null;
            try {
                if (mode === 'content') {
                    const res = await fetchAuth(_sbUrl('grep'), {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            query: val, regex: searchRegex.value,
                            case_sensitive: searchCase.value,
                            glob: (searchGlob.value || '').trim(),
                            include_hidden: !!(showHiddenFiles && showHiddenFiles.value),
                        }),
                    }, true);
                    if (_seq !== _sbSearchSeq) return;
                    if (res && res.ok) {
                        const d = await res.json();
                        searchTruncated.value = !!d.truncated;
                        sandboxSearchResults.value = (d.matches || []).map(m => ({
                            path: m.path, line: m.line, col: m.col,
                            preview: m.snippet,
                            pre: m.snippet.slice(0, m.match_start),
                            hit: m.snippet.slice(m.match_start, m.match_end),
                            post: m.snippet.slice(m.match_end),
                        }));
                    } else {
                        sandboxSearchResults.value = [];
                        searchError.value = await _errDetail(res, 'Recherche impossible');
                    }
                    return;
                }
                const res = await fetchAuth(
                    _sbUrl('search?q=') + encodeURIComponent(val.trim()) + '&mode=' + mode,
                    {}, true
                );
                if (_seq !== _sbSearchSeq) return;  // requête plus récente en cours
                if (res && res.ok) sandboxSearchResults.value = (await res.json()).items || [];
            } catch(e) {}
            finally { if (_seq === _sbSearchSeq) isSearchingSandbox.value = false; }
        }
        // Relance immédiate quand une option change (même requête).
        watch([searchCase, searchRegex], () => {
            if (sandboxSearch.value.trim() && sandboxSearchMode.value === 'content') {
                _doSandboxSearch(sandboxSearch.value, 'content');
            }
        });
        let _globTimer = null;
        watch(searchGlob, () => {
            clearTimeout(_globTimer);
            _globTimer = setTimeout(() => {
                if (sandboxSearch.value.trim() && sandboxSearchMode.value === 'content') {
                    _doSandboxSearch(sandboxSearch.value, 'content');
                }
            }, 350);
        });
        // Résultats groupés par fichier (compteur + lignes).
        const searchResultGroups = Vue.computed(() => {
            const groups = [];
            const idx = new Map();
            for (const r of sandboxSearchResults.value) {
                if (!r || r.line == null) continue;
                let g = idx.get(r.path);
                if (!g) { g = { path: r.path, items: [] }; idx.set(r.path, g); groups.push(g); }
                g.items.push(r);
            }
            return groups;
        });

        function _replaceBody(extra) {
            return Object.assign({
                query: sandboxSearch.value, replacement: replaceText.value,
                regex: searchRegex.value, case_sensitive: searchCase.value,
                glob: (searchGlob.value || '').trim(),
                include_hidden: !!(showHiddenFiles && showHiddenFiles.value),
            }, extra || {});
        }
        async function previewReplace() {
            if (!sandboxSearch.value || replaceBusy.value) return;
            replaceBusy.value = true;
            try {
                const res = await fetchAuth(_sbUrl('replace'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(_replaceBody({ dry_run: true })),
                });
                if (!res || !res.ok) { showToast(await _errDetail(res, 'Aperçu impossible'), 'error'); return; }
                const d = await res.json();
                // Un onglet ouvert ET modifié est exclu : le réécrire sur disque
                // créerait un conflit avec le travail en cours.
                replacePreview.value = {
                    total: d.total, truncated: !!d.truncated,
                    files: (d.files || []).map(f => Object.assign({}, f, {
                        dirty: !!isPathDirty(f.path),
                        on: !isPathDirty(f.path),
                    })),
                };
                if (!replacePreview.value.files.length) showToast('Aucune occurrence', 'info');
            } catch (_) { showToast('Erreur réseau', 'error'); }
            finally { replaceBusy.value = false; }
        }
        const replaceSelectedCount = Vue.computed(() => {
            const p = replacePreview.value;
            if (!p) return 0;
            return p.files.filter(f => f.on).reduce((n, f) => n + f.count, 0);
        });
        async function applyReplace() {
            const p = replacePreview.value;
            if (!p || replaceBusy.value) return;
            // ``dirty`` est relu MAINTENANT : l'état figé à l'aperçu laissait
            // réécrire sur disque un fichier modifié entre-temps dans son onglet.
            const _pick = () => p.files.filter(f => f.on && !f.dirty && !isPathDirty(f.path)).map(f => f.path);
            if (!_pick().length) { showToast('Aucun fichier à modifier (onglets modifiés exclus)', 'info'); return; }
            let paths = _pick();
            const ok = await openConfirm(
                'Remplacer dans ' + paths.length + ' fichier(s) ?',
                replaceSelectedCount.value + ' occurrence(s) de « ' + sandboxSearch.value + ' » → « ' + replaceText.value + ' ».',
                true, 'Remplacer');
            if (!ok) return;
            paths = _pick();
            if (!paths.length) return;
            replaceBusy.value = true;
            try {
                const res = await fetchAuth(_sbUrl('replace'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(_replaceBody({ paths })),
                });
                if (!res || !res.ok) { showToast(await _errDetail(res, 'Remplacement impossible'), 'error'); return; }
                const d = await res.json();
                // La version de base d'un onglet n'avance QUE s'il est rechargé
                // (fait par l'éditeur) : l'avancer ici pour un onglet modifié
                // aurait laissé Ctrl+S annuler le remplacement sans conflit.
                await onFilesReplaced((d.files || []).map(f => f.path));
                replacePreview.value = null;
                const nSkipped = (d.skipped || []).length;
                if (d.failed) {
                    showToast('Remplacement interrompu sur « ' + d.failed.path + ' » : ' + d.failed.error
                              + ' (' + (d.files || []).length + ' fichier(s) déjà modifié(s))', 'error');
                } else {
                    showToast(d.total + ' remplacement(s) dans ' + (d.files || []).length + ' fichier(s)'
                              + (nSkipped ? ' · ' + nSkipped + ' ignoré(s)' : ''), nSkipped ? 'warning' : undefined);
                }
                _gitAutoRefresh();
                _doSandboxSearch(sandboxSearch.value, 'content');
            } catch (_) { showToast('Erreur réseau', 'error'); }
            finally { replaceBusy.value = false; }
        }

        watch(sandboxSearch, (val) => {
            clearTimeout(_sandboxSearchTimer);
            if (!val || !val.trim()) { _sbSearchSeq++; sandboxSearchResults.value = []; isSearchingSandbox.value = false; return; }
            isSearchingSandbox.value = true;
            _sandboxSearchTimer = setTimeout(() => _doSandboxSearch(val, sandboxSearchMode.value), 350);
        });
        watch(sandboxSearchMode, () => {
            // (passe 3) Purge à la bascule Contenu↔Nom : les deux modes ne
            // renvoient pas la même FORME ({path,line,preview} vs
            // {path,name,type}) — d'anciens résultats affichaient des lignes
            // au libellé vide dans l'autre branche du template. Le timer du
            // debounce est aussi annulé (il relancerait l'ANCIEN mode).
            clearTimeout(_sandboxSearchTimer);
            _sbSearchSeq++;
            sandboxSearchResults.value = [];
            if (sandboxSearch.value.trim()) _doSandboxSearch(sandboxSearch.value, sandboxSearchMode.value);
        });

        // -- Client-side filename filter (flat list, VS Code quick-open) --
        const filteredFilesList = Vue.computed(() => {
            const q = (sandboxSearch.value || '').trim().toLowerCase();
            if (!q) return [];
            const results = [];
            function walk(items) {
                if (!items) return;
                for (const item of items) {
                    if (item.name.toLowerCase().includes(q)) results.push(item);
                    if (item.type === 'folder' && item.children) walk(item.children);
                }
            }
            walk(sandboxFiles.value);
            return results;
        });

        function openFileAtLine(path, line, col) {
            if (callbacks && callbacks.beforeJump) callbacks.beforeJump();
            return openFile(path, false).then(() => {
                // Un visualiseur n'a pas de lignes : ne pas voler le focus au profit d'un Monaco caché.
                if (!line || !monacoRef.instance || isSpecialPath(path)) return;
                setTimeout(() => {
                    try {
                        const pos = { lineNumber: line, column: col || 1 };
                        monacoRef.instance.revealPositionInCenter(pos);
                        monacoRef.instance.setPosition(pos);
                        monacoRef.instance.focus();
                    } catch(_) {}
                }, 150);
            });
        }

        // -- Sandbox import (files & folders) --------------------------
        function triggerSandboxImport(type) {
            showImportMenu.value = false;
            if (type === 'folder' && sandboxFolderInput.value) {
                sandboxFolderInput.value.value = '';
                sandboxFolderInput.value.click();
            } else if (sandboxFileInput.value) {
                sandboxFileInput.value.value = '';
                sandboxFileInput.value.click();
            }
        }

        async function handleSandboxImport(event) {
            const files = event.target.files;
            if (!files || files.length === 0) return;
            // Délègue à l'uploader partagé (app.js) : pré-contrôle d'espace,
            // découpage en lots pour les gros dossiers, barre de progression
            // annulable. webkitRelativePath est préservé à l'intérieur (import
            // de dossier → arbo conservée). L'uploader COPIE la liste à la mise
            // en file : vider l'<input> juste après est sans risque.
            // (L'ancien repli mono-requête est retiré : ``__elpisUploadFiles``
            // est toujours posé par app.js, le repli n'avait ni progression ni
            // quota ni annulation.)
            try {
                if (typeof window.__elpisUploadFiles === 'function') {
                    await window.__elpisUploadFiles(files, '');
                }
            } catch(e) { showToast('Erreur réseau', 'error'); }
            // Reset l'input pour ré-autoriser la sélection du même fichier.
            if (event.target) event.target.value = '';
            if (sandboxFileInput.value) sandboxFileInput.value.value = '';
        }

        // ==============================================================
        //  SANDBOX SNAPSHOTS  --  full-sandbox archive + restore
        //
        //  Permet à l'user de figer l'état complet de sa sandbox dans une
        //  archive .tar.gz côté serveur, puis de revenir à cet état si le
        //  modèle a fait n'importe quoi via les outils write_file / shell.
        //
        //  Communication avec le backend
        //  -----------------------------
        //  Pour create / restore : flux NDJSON (1 event JSON par ligne),
        //  exactement le même format que /api/chat — donc on réutilise le
        //  même pattern getReader() + TextDecoder + split('\n').
        //
        //  Events possibles :
        //    {event:"start",    phase, total_files, total_bytes}
        //    {event:"phase",    phase}                         // ex: "clearing"
        //    {event:"progress", phase, files_done, total_files,
        //                       bytes_done, total_bytes, pct, current_file}
        //    {event:"done",     phase, snapshot?, files_restored?, ...}
        //    {event:"error",    message}
        //
        //  État réactif exposé au template
        //  -------------------------------
        //  - snapshots          : Array       (liste serveur, newest-first)
        //  - snapshotsMax       : Number      (cap configuré côté backend)
        //  - snapshotBusy       : 'idle' | 'create' | 'restore'
        //  - snapshotProgress   : {pct, current_file, files_done, total_files,
        //                          bytes_done, total_bytes, phase}
        //  - showSnapshotPanel  : Boolean     (visibilité du dropdown)
        //  - snapshotName       : String      (nom user pour la création)
        //
        //  Restore — effets de bord côté UI
        //  --------------------------------
        //  Après un restore réussi, on (1) vide tous les onglets ouverts
        //  (leur contenu Monaco peut diverger du nouveau disque), (2)
        //  recharge le tree et (3) refresh le statut Git si applicable.
        // ==============================================================
        const snapshots         = ref([]);
        const snapshotsMax      = ref(10);
        const snapshotBusy      = ref('idle');   // 'idle'|'create'|'restore'
        const snapshotProgress  = ref({
            pct: 0, files_done: 0, total_files: 0,
            bytes_done: 0, total_bytes: 0,
            current_file: '', phase: '',
        });
        const showSnapshotPanel = ref(false);
        const snapshotName      = ref('');
        // Restauration interrompue (worker tué en pleine extraction) : le
        // backend pose un marqueur dans /work et l'expose ici. Sans ce
        // consommateur, l'utilisateur retrouvait un /work AMPUTÉ sans le
        // moindre signal — le filet posé côté serveur ne servait à rien.
        // { snap_id, ts } ou null.
        const restoreIncomplete = ref(null);

        function _resetSnapshotProgress() {
            snapshotProgress.value = {
                pct: 0, files_done: 0, total_files: 0,
                bytes_done: 0, total_bytes: 0,
                current_file: '', phase: '',
            };
        }

        async function loadSnapshots() {
            try {
                const res = await fetchAuth('/api/sandbox/snapshots', {}, true);
                if (res && res.ok) {
                    const data = await res.json();
                    snapshots.value    = data.items || [];
                    snapshotsMax.value = data.max  || 10;
                    restoreIncomplete.value = data.last_restore_incomplete || null;
                }
            } catch(_) {}
        }

        // Acquitte l'alerte : retire le marqueur côté serveur. Sans ça le
        // bandeau resterait affiché indéfiniment (le marqueur n'est levé que
        // par une restauration menée à son terme).
        async function dismissRestoreIncomplete() {
            const before = restoreIncomplete.value;
            restoreIncomplete.value = null;         // optimiste : bandeau off
            try {
                const res = await fetchAuth('/api/sandbox/snapshots/restore-marker',
                                            { method: 'DELETE' });
                if (!res || !res.ok) {
                    restoreIncomplete.value = before;   // échec → on ré-affiche
                    showToast('Impossible d\'effacer l\'alerte', 'error');
                }
            } catch(_) {
                restoreIncomplete.value = before;
                showToast('Erreur réseau', 'error');
            }
        }

        // Formatte le ts du marqueur (secondes epoch) pour le bandeau.
        function restoreIncompleteWhen() {
            const ts = restoreIncomplete.value && restoreIncomplete.value.ts;
            if (!ts) return '';
            try { return new Date(ts * 1000).toLocaleString('fr-FR'); } catch(_) { return ''; }
        }

        // Lit un flux NDJSON (1 JSON par ligne) depuis une Response
        // fetch et appelle onEvent(parsedObj) pour chaque event. Renvoie
        // une Promise qui se résout quand le stream se termine.
        async function _readNdjsonStream(response, onEvent) {
            const reader  = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let   buf     = '';
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    const lines = buf.split('\n');
                    buf = lines.pop();   // dernière ligne potentiellement incomplète
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try { onEvent(JSON.parse(line)); } catch(_) { /* skip ligne corrompue */ }
                    }
                }
                // Flush du buffer résiduel
                if (buf.trim()) {
                    try { onEvent(JSON.parse(buf)); } catch(_) {}
                }
            } finally {
                try { reader.cancel(); } catch(_) {}
            }
        }

        // Wire un event de progression vers le ref réactif. Centralisé
        // ici parce que create et restore parsent le même format.
        function _applyProgressEvent(evt) {
            if (evt.event === 'start') {
                snapshotProgress.value = {
                    pct: 0,
                    files_done: 0,
                    total_files: evt.total_files || 0,
                    bytes_done: 0,
                    total_bytes: evt.total_bytes || 0,
                    current_file: '',
                    phase: evt.phase || '',
                };
            } else if (evt.event === 'phase') {
                snapshotProgress.value = { ...snapshotProgress.value, phase: evt.phase || '' };
            } else if (evt.event === 'progress') {
                snapshotProgress.value = {
                    pct: typeof evt.pct === 'number' ? evt.pct : snapshotProgress.value.pct,
                    files_done:  evt.files_done  != null ? evt.files_done  : snapshotProgress.value.files_done,
                    total_files: evt.total_files != null ? evt.total_files : snapshotProgress.value.total_files,
                    bytes_done:  evt.bytes_done  != null ? evt.bytes_done  : snapshotProgress.value.bytes_done,
                    total_bytes: evt.total_bytes != null ? evt.total_bytes : snapshotProgress.value.total_bytes,
                    current_file: evt.current_file || '',
                    phase: evt.phase || snapshotProgress.value.phase,
                };
            }
        }

        async function createSnapshot() {
            if (snapshotBusy.value !== 'idle') return;
            const name = (snapshotName.value || '').trim();

            snapshotBusy.value = 'create';
            _resetSnapshotProgress();
            let lastEvent = null;
            let errMsg = null;

            try {
                const res = await fetchAuth('/api/sandbox/snapshots/create', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ name }),
                });
                if (!res || !res.ok) {
                    showToast('Erreur création snapshot', 'error');
                    return;
                }
                await _readNdjsonStream(res, (evt) => {
                    _applyProgressEvent(evt);
                    lastEvent = evt;
                    if (evt.event === 'error') errMsg = evt.message;
                });
            } catch(e) {
                errMsg = e && e.message || 'Erreur réseau';
            } finally {
                snapshotBusy.value = 'idle';
            }

            if (errMsg) {
                showToast(errMsg, 'error');
                return;
            }
            if (lastEvent && lastEvent.event === 'done') {
                snapshotName.value = '';
                showToast('Snapshot créée');
                await loadSnapshots();
                _resetSnapshotProgress();
            }
        }

        async function deleteSnapshot(snapId) {
            const confirmed = await openConfirm(
                'Supprimer cette snapshot ?',
                'Cette action est irréversible.',
                true
            );
            if (!confirmed) return;
            try {
                const res = await fetchAuth(
                    '/api/sandbox/snapshots/' + encodeURIComponent(snapId),
                    { method: 'DELETE' }
                );
                if (res && res.ok) {
                    showToast('Snapshot supprimée');
                    await loadSnapshots();
                } else {
                    showToast('Erreur suppression', 'error');
                }
            } catch(_) { showToast('Erreur réseau', 'error'); }
        }

        async function restoreSnapshot(snapId, snapName) {
            if (snapshotBusy.value !== 'idle') return;

            const confirmed = await openConfirm(
                'Restaurer cette snapshot ?',
                'Tous les fichiers actuels de votre sandbox seront remplacés par ceux de "' + (snapName || 'cette snapshot') + '". Les onglets ouverts seront fermés.',
                true,
                'Restaurer',
                'Annuler'
            );
            if (!confirmed) return;
            // Onglets modifiés : la restauration est refusée tant qu'ils ne
            // sont pas enregistrés ou fermés (E11). Avant, ils étaient fermés
            // de force AVANT de savoir si la restauration réussissait — un
            // échec perdait le travail pour rien.
            const _dirty = (openTabs.value || []).map(t => t.path).filter(p => isPathDirty(p));
            if (_dirty.length) {
                showToast('Enregistrez ou fermez d\'abord les onglets modifiés : '
                          + _dirty.map(p => p.split('/').pop()).join(', '), 'error');
                return;
            }

            // Avant de tout effacer côté serveur, on ferme les onglets
            // côté UI : sinon Monaco continue à proposer "sauvegarder"
            // sur des modèles dont le contenu disque vient de changer.
            //
            // fermeture FORCÉE et SÉQUENTIELLE. Avant, on
            // faisait `paths.forEach(p => closeTab(p))` : closeTab est
            // async et re-déclenche une confirmation « fermer sans
            // sauvegarder ? » par onglet dirty → plusieurs dialogues qui
            // se disputent le même modal, et la restauration serveur
            // partait pendant que ces dialogues étaient encore ouverts.
            // L'utilisateur a déjà accepté la perte de données dans la
            // confirmation ci-dessus → on passe `force=true` (pas de
            // re-prompt) et on `await` chaque fermeture.
            try {
                if (openTabs && openTabs.value && openTabs.value.length) {
                    // Copie pour éviter mutation pendant l'itération
                    const paths = openTabs.value.map(t => t.path);
                    for (const p of paths) {
                        try { await closeTab(p, null, true); } catch(_) {}
                    }
                }
            } catch(_) {}

            snapshotBusy.value = 'restore';
            _resetSnapshotProgress();
            let lastEvent = null;
            let errMsg = null;

            try {
                const res = await fetchAuth(
                    '/api/sandbox/snapshots/' + encodeURIComponent(snapId) + '/restore',
                    { method: 'POST' }
                );
                if (!res || !res.ok) {
                    showToast('Erreur restore', 'error');
                    return;
                }
                await _readNdjsonStream(res, (evt) => {
                    _applyProgressEvent(evt);
                    lastEvent = evt;
                    if (evt.event === 'error') errMsg = evt.message;
                });
            } catch(e) {
                errMsg = e && e.message || 'Erreur réseau';
            } finally {
                snapshotBusy.value = 'idle';
            }

            if (errMsg) {
                showToast(errMsg, 'error');
                return;
            }
            if (lastEvent && lastEvent.event === 'done') {
                // Entrées que la restauration n'a pu mettre en place telles
                // quelles (ancien contenu mis de côté, nouveau placé sous un
                // autre nom) : rien n'est perdu, mais l'utilisateur doit savoir.
                const n = lastEvent.conflicts || 0;
                if (n > 0) {
                    const noms = (lastEvent.conflict_paths || []).slice(0, 3).join(' ; ');
                    showToast(`Sandbox restaurée, ${n} entrée(s) à vérifier${noms ? ' : ' + noms : ''}`, 'warning');
                } else {
                    showToast('Sandbox restaurée');
                }
                // Refresh tree + git pour refléter le nouveau contenu disque.
                await loadSandboxFiles();
                try { _gitAutoRefresh(); } catch(_) {}
                _resetSnapshotProgress();
            }
        }

        function toggleSnapshotPanel() {
            const next = !showSnapshotPanel.value;
            showSnapshotPanel.value = next;
            if (next) loadSnapshots();
        }

        // -- Public surface ------------------------------------------
        return {
            // Core
            loadSandboxFiles,
            treeTruncated,
            toggleHiddenFiles,
            loadSandboxQuota,
            scheduleQuotaRefresh,

            // CRUD
            downloadFile,
            createFolder,
            createFile,
            moveItem,
            renameItem,
            deleteFile,

            // Search + navigation
            filteredFilesList,
            openFileAtLine,
            searchCase, searchRegex, searchGlob, searchTruncated, searchError, searchResultGroups,
            showReplace, replaceText, replacePreview, replaceBusy, replaceSelectedCount,
            previewReplace, applyReplace,
            duplicateItem,

            // Import
            triggerSandboxImport,
            handleSandboxImport,

            // Snapshots
            snapshots, snapshotsMax,
            snapshotBusy, snapshotProgress,
            showSnapshotPanel, snapshotName,
            loadSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot,
            toggleSnapshotPanel,
            restoreIncomplete, dismissRestoreIncomplete, restoreIncompleteWhen,
        };
    }

    window.setupEditorSandboxFs = setupEditorSandboxFs;
})();
