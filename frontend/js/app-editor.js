// SPDX-License-Identifier: MIT
// ============================================================
//  app-editor.js  -- Monaco editor module  (production-ready)
//
//  Fixes vs. original:
//   • Blank after inactivity / reopen:
//     - initPromise now reset in disposeAll → initMonaco re-creates instance
//     - watch(showEditor) re-lays out once after the CSS transition
//   • Disposed-model crash: _modelOk() + _dropModel() guards everywhere
//   • switchTab with stale model: falls back to full reload from server
//   • openFile URI collision: recovers existing Monaco model safely
//   • initMonaco idempotent: handles rapid open/close races
//   • disposeAll fully resets monacoRef for safe reinit
//   • Custom languages: Robot Framework Monarch tokenizer,
//     extended file-type map (yaml, xml, sql, dockerfile, ini,
//     toml, bash, go, rust, java, c, cpp, c#, ruby, php, etc.)
// ============================================================

function setupEditor(vue, sharedRefs, ctx) {
    const { ref, watch, nextTick } = vue;
    const { user, settings } = sharedRefs;
    const { showToast, fetchAuth, openConfirm, openPrompt } = ctx;

    // -- Reactive state ------------------------------------------
    const showEditor           = ref(false);
    const showExplorer         = ref(true);
    const explorerWidth        = ref(224);   // default w-56 = 224px (restauré plus bas)
    const editorFullscreen     = ref(false);
    // ── Vue scindée (split view) — 2 fichiers côte à côte, en plein écran ──
    // splitView : panneau de droite visible ? splitTabPath : fichier du panneau
    // droit. activePane : panneau focalisé ('left'|'right') — un clic d'onglet
    // ouvre dans le panneau actif. splitRatio : largeur % du panneau GAUCHE.
    const splitView            = ref(false);
    const splitTabPath         = ref(null);
    const activePane           = ref('left');
    const splitRatio           = ref(50);
    // splitMode : ce qu'affiche le panneau DROIT.
    //   'code'    → 2e éditeur Monaco (comparer/éditer 2 fichiers)
    //   'preview' → rendu web de la page, à côté de son code
    // Le diviseur, le ratio et la contrainte « plein écran » sont partagés.
    const splitMode            = ref('code');
    // Aperçu « live » : enregistre le buffer puis recharge l'iframe pendant la
    // frappe (opt-in — voir _schedulePreviewLive plus bas).
    const previewLive          = ref(false);
    const showEscapeHint       = ref(false);   // hint « Échap pour quitter »
    // Menu « + » de la barre d'en-tête (UX 2026-07-25) : regroupe toutes les
    // actions sauf Plein écran et Fermer. Fermé par backdrop, Échap (chaîne
    // globale app.js + garde _handleFullscreenEsc) et au clic d'une entrée.
    const showEditorMore       = ref(false);
    let   _escapeHintTimer     = null;

    // ── Protection du travail en cours (2026-09-19) ─────────────────────
    // diskConflicts  : { [path]: { mtime, missing } } — le disque a changé
    //                  alors que l'onglet a des modifications non enregistrées
    //                  (ou un enregistrement a été refusé par la précondition).
    // assistantStash : { [path]: { content, ts } } — copie des modifications
    //                  NON ENREGISTRÉES qu'une écriture de l'assistant vient de
    //                  remplacer dans l'onglet. Rien n'est perdu : un bandeau
    //                  propose de les restaurer ou de comparer.
    // Objets REMPLACÉS à chaque mutation (réactivité simple).
    const diskConflicts  = ref({});
    const assistantStash = ref({});
    function _mapSet(r, path, val) {
        const next = Object.assign({}, r.value);
        if (val == null) delete next[path]; else next[path] = val;
        r.value = next;
    }

    // ── Disposition mémorisée (par appareil) ─────────────────────────────
    const _LAYOUT_KEY = 'elpis.editor.layout.v1';
    function _readLayout() {
        try { return JSON.parse(localStorage.getItem(_LAYOUT_KEY) || '{}') || {}; } catch (_) { return {}; }
    }
    const _layout0 = _readLayout();
    function _num(v, lo, hi, dflt) {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
    }
    const sandboxFiles         = ref([]);
    const sandboxQuota         = ref({ used_mb: 0, quota_mb: 5120, pct: 0 });
    const isLoadingFiles       = ref(false);
    // Fichiers cachés (.dotfiles) masqués de l'explorateur par défaut (toggle
    // par appareil ; le terminal y accède toujours).
    const showHiddenFiles      = ref(false);
    try { showHiddenFiles.value = (typeof localStorage !== 'undefined' && localStorage.getItem('elpis.showHiddenFiles') === '1'); } catch (_) {}

    // (Feature « Équipes » retirée 2026-06 : sandbox/terminal uniquement
    //  personnels — les helpers _sbUrl/_termUrl/_termWsUrl restent comme
    //  points de passage uniques vers les routes API.)
    function _sbUrl(endpoint)   { return '/api/sandbox/' + endpoint; }

    function _termUrl(endpoint) { return '/api/terminal/' + endpoint; }

    // Build the WebSocket URL for the terminal. Uses wss:// when the page
    // is served over HTTPS so secure cookies (session) are sent.
    function _termWsUrl() {
        var proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        return proto + '//' + window.location.host + '/ws/terminal';
    }



    // -- Line-diff helper -- applies the minimal edit needed to go   --
    //    from oldText to newText. Used for LLM file rewrites, so
    //    unchanged regions stay put and the user can actually see
    //    what changed.
    //
    //    Strategy: skip the common prefix AND common suffix (in lines),
    //    then push a single replace edit over the middle window. For
    //    contiguous edits (the common case for LLM rewrites) this is
    //    optimal. For scattered edits it still beats setValue(): cursor
    //    position, scroll position and undo granularity are preserved.
    //
    //    Returns an object { startLine, endLine, changed } describing
    //    the edited range in the NEW content (1-indexed, inclusive),
    //    or null if no edit was applied or if setValue fallback kicked in.
    function _applyMinimalLineEdit(model, oldText, newText) {
        // Calcul dans editor/_minimal_edit.js (module pur, testé à part) :
        // l'ancienne version locale corrompait le tampon sur une pure
        // insertion / suppression de lignes — cf. l'en-tête du module.
        var edit = window.elpisMinimalEdit
            ? window.elpisMinimalEdit.compute(oldText, newText) : null;
        if (!window.elpisMinimalEdit) {
            if (oldText === newText) return null;
            try { model.setValue(newText); } catch (_) {}
            return null;
        }
        if (!edit) return null;

        try {
            model.pushEditOperations([], [{ range: edit.range, text: edit.text }],
                                     function() { return null; });
        } catch (e) {
            // Fallback: Monaco refused the edit (bad range, disposed model...)
            try { model.setValue(newText); } catch(_) {}
            return null;
        }
        // Filet : le résultat DOIT être le nouveau texte (fins de ligne du
        // modèle près). Sinon on repose le texte entier plutôt que de laisser
        // un tampon faux — qui serait ensuite enregistré.
        try {
            var _norm = function (t) { return String(t).replace(/\r\n?/g, '\n'); };
            if (_norm(model.getValue()) !== _norm(newText)) model.setValue(newText);
        } catch (_) {}

        return { startLine: edit.startLine, endLine: edit.endLine, changed: edit.changed };
    }

    // -- Visual flash on the lines that were just changed (3s fade) --
    //    Called after a minimal edit to make the diff visually obvious.
    //    Uses two Monaco decorations: a full-line background tint on the
    //    line body and a thicker bar in the gutter (line-number column).
    //    Both are tagged with CSS classes that animate opacity down over
    //    3 seconds, then we deltaDecorations them away to keep the DOM
    //    light.
    function _flashChangedLines(model, range) {
        if (!monacoRef.instance || !range || !window.monaco) return;
        if (monacoRef.instance.getModel() !== model) return;
        // Réglage utilisateur : surbrillance des lignes éditées par l'agent
        // (défaut ON). OFF → on ne pose aucune décoration.
        if (settings.value && settings.value.editor_edit_highlight === false) return;

        var decos = [];
        for (var ln = range.startLine; ln <= range.endLine; ln++) {
            decos.push({
                range: new window.monaco.Range(ln, 1, ln, 1),
                options: {
                    isWholeLine: true,
                    className: 'elpis-changed-line-highlight',
                    linesDecorationsClassName: 'elpis-changed-line-gutter',
                    // Decorations should stick to the lines as the user types
                    stickiness: (window.monaco.editor &&
                                 window.monaco.editor.TrackedRangeStickiness)
                                ? window.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
                                : 1,
                }
            });
        }

        var ids = [];
        try { ids = monacoRef.instance.deltaDecorations([], decos); }
        catch (_) { return; }

        // vérifier que le modèle ET l'instance sont toujours
        // valides avant de retirer les décorations. Si l'utilisateur a
        // changé de fichier ou si l'éditeur a été disposé entre-temps,
        // deltaDecorations sur des ids du mauvais modèle plante ou crée
        // des décos fantômes invisibles qui tirent sur le GC.
        setTimeout(function() {
            try {
                if (!monacoRef.instance || !ids.length) return;
                if (model.isDisposed()) return;
                if (monacoRef.instance.getModel() !== model) return;
                monacoRef.instance.deltaDecorations(ids, []);
            } catch(_) {}
        }, 3200);  // slightly longer than CSS fade to avoid flicker
    }

    const fileInput            = ref(null);
    const openTabs             = ref([]);
    const activeTabPath        = ref(null);
    // Breadcrumb : segments cliquables du chemin du fichier
    // actif. Chaque segment intermédiaire porte son ``prefix`` cumulatif
    // (pour révéler le dossier dans l'arbre) ; le dernier (le fichier) est
    // marqué isLast (non cliquable, ou ré-ouvre le fichier).
    const breadcrumbSegments = vue.computed(() => {
        const p = activeTabPath.value;
        if (!p) return [];
        const parts = String(p).split('/').filter(Boolean);
        let prefix = '';
        return parts.map((name, i) => {
            prefix = prefix ? prefix + '/' + name : name;
            return { name, prefix, isLast: i === parts.length - 1 };
        });
    });
    const isEditorDirty        = ref(false);
    const isTypingEffect       = ref(false);
    const editorFilePath       = ref('');
    const isDiffView           = ref(false);
    const editorMode           = ref('code');
    const previewPath          = ref('index.html');
    const previewKey           = ref(0);
    // Aperçu (onglet Web) — deux sources (UX 2026-07-25) :
    //  'file'   : fichier statique de la sandbox (/api/sandbox/serve, historique)
    //  'server' : VRAI état d'un serveur qui tourne DANS le conteneur, via le
    //             proxy authentifié /api/sandbox/preview/<port>/<chemin>
    //             (routes/user_sandbox.py — nécessite un profil réseau non isolé).
    const previewSource        = ref('file');    // 'file' | 'server'
    const previewPort          = ref(8080);
    const previewServerPath    = ref('/');
    // Champ unique de la source « serveur » : accepte le copier-coller d'une
    // URL complète telle que l'affichent les serveurs de dev
    // (« http://localhost:5173/app?debug=1 »), un port nu (« 8080 ») ou un
    // chemin seul (« /docs »). Le texte n'est PARSÉ qu'à la validation
    // (Entrée, perte de focus, bouton recharger) : parser à chaque frappe
    // rechargerait l'iframe sur des URLs partielles.
    const previewServerUrl     = ref('localhost:8080/');
    // Hôte saisi lorsqu'il ne désigne pas la sandbox : l'aperçu proxifie
    // TOUJOURS le conteneur de l'utilisateur, on le signale au lieu de
    // laisser croire qu'on est allé chercher ailleurs.
    const previewServerHostWarn = ref('');
    const _PREVIEW_LOCAL_HOSTS = ['', 'localhost', '127.0.0.1', '0.0.0.0',
                                  '::1', '[::1]'];

    /** Éclate une saisie libre en { port, path, host }. `port` vaut null quand
     *  la saisie n'en porte pas (chemin seul) : l'appelant garde le sien. */
    function parsePreviewServerUrl(raw) {
        let s = String(raw ?? '').trim();
        if (!s) return { port: null, path: '/', host: '' };
        s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//i, '');     // http://, https://…
        if (s.startsWith('/')) return { port: null, path: s, host: '' };
        const slash    = s.indexOf('/');
        const authority = slash === -1 ? s : s.slice(0, slash);
        const path      = slash === -1 ? '/' : s.slice(slash);
        let host = '', portStr = '';
        if (authority.startsWith('[')) {                     // IPv6 littéral
            const end = authority.indexOf(']');
            host    = authority.slice(0, end + 1);
            portStr = authority.slice(end + 1).replace(/^:/, '');
        } else {
            const i = authority.lastIndexOf(':');
            if (i === -1) { portStr = authority; }
            else { host = authority.slice(0, i); portStr = authority.slice(i + 1); }
        }
        if (portStr && !/^\d+$/.test(portStr)) {             // « localhost » sans port
            if (!host) host = portStr;
            portStr = '';
        }
        const port = Number(portStr);
        return {
            port: (/^\d+$/.test(portStr) && port >= 1 && port <= 65535) ? port : null,
            path: path || '/',
            host,
        };
    }

    /** Ré-affiche la cible réellement atteinte (port retenu, chemin normalisé). */
    function syncPreviewServerUrl() {
        previewServerUrl.value =
            'localhost:' + previewPort.value + previewServerPath.value;
    }

    function commitPreviewServerUrl() {
        const t = parsePreviewServerUrl(previewServerUrl.value);
        if (t.port !== null) previewPort.value = t.port;
        previewServerPath.value = t.path.startsWith('/') ? t.path : '/' + t.path;
        previewServerHostWarn.value =
            _PREVIEW_LOCAL_HOSTS.includes(t.host.toLowerCase()) ? '' : t.host;
        syncPreviewServerUrl();
        refreshPreview();
    }

    /** Bouton « recharger » : en mode serveur il valide d'abord la saisie,
     *  sinon un chemin tapé sans Entrée serait ignoré. */
    function reloadPreview() {
        if (previewSource.value === 'server') commitPreviewServerUrl();
        else refreshPreview();
    }

    // Jeton d'URL de l'aperçu (audit 2026-09-22, H1) : la page s'affiche avec
    // une origine OPAQUE (iframe sandbox + CSP), qui n'envoie plus le cookie
    // à ses CSS/JS/fetch. L'identité voyage donc dans le chemin, jeton signé
    // d'une heure, renouvelé au rechargement de l'aperçu.
    const previewToken         = ref('');
    let _previewTokenExp = 0, _previewTokenP = null;
    function _ensurePreviewToken() {
        if (previewToken.value && _previewTokenExp - Date.now() / 1000 > 300) return Promise.resolve();
        if (!_previewTokenP) {
            _previewTokenP = fetchAuth('/api/sandbox/preview-token', {}, true)
                .then(r => (r && r.ok) ? r.json() : null)
                .then(d => { if (d && d.token) { previewToken.value = d.token; _previewTokenExp = d.expires; } })
                .catch(() => {})
                .finally(() => { _previewTokenP = null; });
        }
        return _previewTokenP;
    }
    const previewSrc           = computed(() => {
        const tok = previewToken.value;
        if (!tok) { _ensurePreviewToken(); return 'about:blank'; }
        if (previewSource.value === 'server') {
            const port = Math.max(1, Math.min(65535, Number(previewPort.value) || 8080));
            let p = String(previewServerPath.value || '/');
            if (!p.startsWith('/')) p = '/' + p;
            return '/api/sandbox/pvs/' + tok + '/' + port + p;
        }
        return '/api/sandbox/pv/' + tok + '/' + String(previewPath.value || '')
            .split('/').map(encodeURIComponent).join('/');
    });
    const sandboxSearch        = ref('');
    const sandboxSearchResults = ref([]);
    const isSearchingSandbox   = ref(false);
    const sandboxSearchMode    = ref('content');  // 'content' | 'name' 
    const sandboxFileInput     = ref(null);
    const sandboxFolderInput   = ref(null);
    const showImportMenu       = ref(false);

    // -- Ruff linter --------------------------------------------------
    let _lintTimer = null;   // debounce handle

    // -- Auto-save (debounced) ----------------------------------------
    // Timer ID for the debounced auto-save. Reset on each keystroke.
    // Delays in ms — mapping from the user-facing setting value.
    let _autoSaveTimer = null;
    const _AUTO_SAVE_DELAYS = { off: 0, '30s': 30_000, '1min': 60_000, '2min': 120_000, on_blur: 0 };
    function _scheduleAutoSave() {
        // Cancel any pending fire — debounce semantics : we save only
        // after the user has stopped typing for ``delay`` ms.
        if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
        const mode = (settings.value && settings.value.editor_auto_save) || 'off';
        const delay = _AUTO_SAVE_DELAYS[mode] || 0;
        if (delay <= 0) return;       // 'off' or 'on_blur' → no timer-based save
        const p = activeTabPath.value;
        _autoSaveTimer = setTimeout(() => {
            _autoSaveTimer = null;
            if (_tabIsDirty(p)) saveEditorContent({ silent: true, path: p });
        }, delay);
    }
    // Auto-save dédié au panneau DROIT (vue scindée). Timer séparé pour ne pas
    // annuler l'auto-save du panneau gauche et vice-versa.
    let _autoSaveTimerRight = null;
    function _scheduleAutoSaveRight() {
        if (_autoSaveTimerRight) { clearTimeout(_autoSaveTimerRight); _autoSaveTimerRight = null; }
        const mode = (settings.value && settings.value.editor_auto_save) || 'off';
        const delay = _AUTO_SAVE_DELAYS[mode] || 0;
        if (delay <= 0) return;
        const p = splitTabPath.value;
        _autoSaveTimerRight = setTimeout(() => {
            _autoSaveTimerRight = null;
            if (p && _tabIsDirty(p)) saveEditorContent({ silent: true, path: p });
        }, delay);
    }

    // -- FIM + Editor Context Menu -----------------------------
    const fimLoading           = ref(false);
    const fimGhostText         = ref('');
    const editorCtxMenu        = ref({ show: false, x: 0, y: 0, hasSelection: false, selectionText: '', lineCount: 0 });

    // -- Markdown preview ---------------------------------------
    const mdPreview            = ref(false);

    // ============================================================
    //  Visualiseurs spéciaux — image, hex, office (docx/pptx/xlsx/pdf), docx texte
    // ============================================================
    //  Pour les fichiers non-texte, on bypasse Monaco et on affiche un
    //  viewer dédié dans l'éditeur :
    //    - **image**  (.png/.jpg/etc.) → <img> direct via le endpoint download
    //    - **hex**    binaires connus OU reconnus à l'ouverture → 4 premiers Ko
    //    - **office** docx/pptx/xlsx convertis côté serveur (LibreOffice isolé)
    //                 + pdf → visualiseur PDF natif ; xlsx → grille
    //    - **docx**   repli texte (aperçu Office coupé ou LibreOffice absent) :
    //                 /api/sandbox/read-docx dans Monaco en READ-ONLY
    //
    //  Le choix vit dans ``elpisOffice.viewModeForPath`` (editor/_office_model.js,
    //  testé sous node). Pour 'image', 'hex' et 'office' il n'y a AUCUN modèle
    //  Monaco : rien à éditer, rien à sauvegarder (cf. officeIsViewerPath).
    //  Cf. docs/editor-office-preview-design-2026-09-15.md
    // ============================================================
    // Sets REMPLACÉS (jamais mutés en place) : le computed de mode recalcule.
    const binaryPaths        = ref(new Set());   // reconnus binaires à l'ouverture
    const officeTextFallback = ref(new Set());   // docx basculés sur le texte brut
    function _officeFeatureOn() {
        const f = ctx.features && ctx.features.value;
        return !f || f.office_preview !== false;
    }
    function _resolveFileViewMode(path) {
        return window.elpisOffice.viewModeForPath(path, {
            officeEnabled: _officeFeatureOn(),
            binaryPaths:   binaryPaths.value,
            textFallback:  officeTextFallback.value,
        });
    }
    const activeFileViewMode = vue.computed(() =>
        _resolveFileViewMode(activeTabPath.value)
    );
    // Onglet actif sans modèle Monaco (image / hex / office).
    const activeIsViewer = vue.computed(() =>
        window.elpisOffice.isViewerMode(activeFileViewMode.value)
    );
    function officeIsViewerPath(path) {
        return !!path && window.elpisOffice.isViewerMode(_resolveFileViewMode(path));
    }
    function _setWith(setRef, item) {
        if (setRef.value.has(item)) return;
        const s = new Set(setRef.value); s.add(item); setRef.value = s;
    }
    function _setWithout(setRef, item) {
        if (!setRef.value.has(item)) return;
        const s = new Set(setRef.value); s.delete(item); setRef.value = s;
    }

    // État des viewers spéciaux
    const imageViewerPath  = ref('');                  // URL à afficher (image active)
    const hexViewerData    = ref(null);                // { bytes: Uint8Array (4 Ko), path, size }
    const hexViewerLoading = ref(false);
    const readOnlyTabs     = ref(new Set());           // paths actuellement read-only (docx)
    // Onglets texte dont le fichier est devenu binaire sur disque (409 au save).
    const _binaryRefused   = new Set();

    function _isReadOnlyTab(path) {
        return readOnlyTabs.value.has(path);
    }
    // Ré-applique l'option readOnly pour l'onglet ACTIF — à appeler après
    // toute mutation de readOnlyTabs sur l'onglet courant (le watcher
    // ci-dessous ne se déclenche que sur CHANGEMENT d'activeTabPath).
    function _applyActiveReadOnly() {
        if (!monacoRef.instance) return;
        try {
            monacoRef.instance.updateOptions({ readOnly: _isReadOnlyTab(activeTabPath.value) });
        } catch(_) {}
    }
    // Watcher : applique readOnly à Monaco selon l'onglet actif
    watch(activeTabPath, (path) => {
        if (!monacoRef.instance) return;
        try {
            monacoRef.instance.updateOptions({ readOnly: _isReadOnlyTab(path) });
        } catch(_) {}
    });

    // Helper : formate des bytes en lignes hex offset/hex/ascii (16 par ligne)
    function _formatHexDump(bytes, maxBytes) {
        const lines = [];
        const limit = Math.min(bytes.length, maxBytes || 65536);
        for (let i = 0; i < limit; i += 16) {
            const slice = bytes.slice(i, i + 16);
            const offset = i.toString(16).padStart(8, '0');
            const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
            const ascii = Array.from(slice).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
            lines.push({ offset, hex: hex.padEnd(48, ' '), ascii });
        }
        return lines;
    }
    const hexViewerLines = vue.computed(() => {
        if (!hexViewerData.value || !hexViewerData.value.bytes) return [];
        return _formatHexDump(hexViewerData.value.bytes, 4096);  // first 4 KB
    });

    // Concatène des morceaux de flux en un Uint8Array de ``n`` octets au plus.
    function _concatBytes(parts, n) {
        const out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) {
            if (o >= n) break;
            const take = Math.min(p.length, n - o);
            out.set(p.subarray(0, take), o);
            o += take;
        }
        return out;
    }
    // Lit au plus ``n`` octets puis coupe le flux (un binaire de plusieurs Go
    // n'est jamais téléchargé pour afficher 4 Ko).
    async function _readHeadBytes(res, n) {
        if (!res.body || !res.body.getReader) {
            return new Uint8Array(await res.arrayBuffer()).slice(0, n);
        }
        const reader = res.body.getReader();
        const parts = [];
        let size = 0;
        try {
            while (size < n) {
                const { done, value } = await reader.read();
                if (done) break;
                parts.push(value);
                size += value.length;
            }
        } finally {
            reader.cancel().catch(() => {});
        }
        return _concatBytes(parts, Math.min(size, n));
    }
    // Décodage FIDÈLE (audit éditeur 2026-09-23, E3/E14/E15) : UTF-8 strict,
    // BOM retiré mais MÉMORISÉ (réinjecté à l'enregistrement), fins de ligne
    // relevées. Un contenu non UTF-8 est décodé avec remplacement mais marqué
    // ``lossy`` : l'onglet passe en lecture seule, sinon l'enregistrement
    // remplaçait chaque accent latin-1 par U+FFFD.
    function _eolOf(text) {
        let crlf = 0, lf = 0, cr = 0;
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i);
            if (c === 13) { if (text.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++; }
            else if (c === 10) lf++;
        }
        const kinds = (crlf > 0) + (lf > 0) + (cr > 0);
        if (!kinds) return null;
        if (kinds > 1) return 'mixed';
        return crlf ? 'crlf' : (lf ? 'lf' : 'cr');
    }
    function _decodeText(bytes) {
        const bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
        const body = bom ? bytes.subarray(3) : bytes;
        let text, lossy = false;
        try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
        } catch (_) {
            text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(body);
            lossy = true;
        }
        return { text, bom, lossy, eol: _eolOf(text) };
    }
    window.elpisDecodeText = _decodeText;
    // Contenu texte, ou { binary: true } dès que les premiers octets trahissent
    // un binaire (flux coupé aussitôt). Rend ``{ text, bom, lossy, eol }``.
    async function _readTextOrBinary(res) {
        const O = window.elpisOffice;
        if (!res.body || !res.body.getReader) {
            const all = new Uint8Array(await res.arrayBuffer());
            if (O.looksBinary(all.subarray(0, O.SNIFF_BYTES))) return { binary: true };
            return _decodeText(all);
        }
        const reader = res.body.getReader();
        const parts = [];
        let size = 0;
        let sniffed = false;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            size += value.length;
            if (!sniffed && size >= O.SNIFF_BYTES) {
                sniffed = true;
                if (O.looksBinary(_concatBytes(parts, O.SNIFF_BYTES))) {
                    reader.cancel().catch(() => {});
                    return { binary: true };
                }
            }
        }
        const all = _concatBytes(parts, size);
        if (!sniffed && O.looksBinary(all)) return { binary: true };
        return _decodeText(all);
    }

    // Visualiseur hex : 4 premiers Ko seulement (Range), taille totale lue
    // dans Content-Range. Séquence + onglet actif : une lecture lente ne
    // s'affiche jamais dans un autre onglet.
    let _hexSeq = 0;
    async function _openHex(path) {
        const seq = ++_hexSeq;
        hexViewerLoading.value = true;
        try {
            const res = await fetchAuth(_sbUrl('download?path=') + encodeURIComponent(path),
                                        { headers: { Range: 'bytes=0-4095' } });
            if (res && res.ok) {
                const range = window.elpisOffice.parseContentRange(res.headers.get('Content-Range'));
                const bytes = await _readHeadBytes(res, 4096);
                let size = range && range.total != null ? range.total : null;
                if (size == null && res.status === 200) size = Number(res.headers.get('Content-Length')) || bytes.length;
                if (seq === _hexSeq && activeTabPath.value === path) {
                    hexViewerData.value = { bytes, path, size: size == null ? bytes.length : size };
                }
            } else if (seq === _hexSeq) {
                showToast('Lecture binaire échouée', 'error');
            }
        } catch (e) {
            if (seq === _hexSeq) showToast('Erreur lecture binaire', 'error');
        } finally {
            if (seq === _hexSeq) hexViewerLoading.value = false;
        }
    }

    // ============================================================
    //  External modification detection
    // ============================================================
    //  Tracker le mtime de chaque fichier ouvert (capturé depuis le
    //  header X-Mtime renvoyé par /api/sandbox/download). Périodiquement
    //  + au focus de la fenêtre, on POST /api/sandbox/check-mtimes pour
    //  détecter les modifs hors éditeur (terminal, git pull, LLM…).
    //  Affiche un toast avec bouton "Recharger" par fichier.
    //
    //  Garde-fous :
    //   - Pas de check si le fichier est dirty (l'utilisateur a des modifs
    //     locales — on l'avertit mais on ne reload pas sans demander)
    //   - Throttling : check max 1× par fichier dans une fenêtre 5s
    //   - Notification : 1 toast par fichier, déduplication par path
    // ============================================================
    // ``fileMtimes`` = mtime de la version DISQUE sur laquelle chaque onglet est
    // fondé (lu à l'ouverture dans X-Mtime, mis à jour à chaque enregistrement
    // ou rechargement). Il sert de PRÉCONDITION à /save (``expected_mtime``) :
    // une notification ne l'avance donc plus — sinon un enregistrement fait
    // après l'alerte écrasait quand même la version disque.
    const fileMtimes = ref({});                 // { [path]: number }
    // Dernier mtime déjà traité par chemin : le sondage revient toutes les 30 s
    // avec le même « stale » tant que l'utilisateur n'a pas tranché.
    const _handledDiskMtime = Object.create(null);
    let _mtimeCheckTimer = null;
    const _MTIME_CHECK_INTERVAL_MS = 30_000;     // 30s en background

    function _mtimeOf(response) {
        try {
            const mt = response && response.headers.get('X-Mtime');
            return mt ? parseFloat(mt) : null;
        } catch (_) { return null; }
    }
    function _setBaseMtime(path, mtime) {
        if (!path) return;
        if (typeof mtime === 'number' && Number.isFinite(mtime)) fileMtimes.value[path] = mtime;
        else delete fileMtimes.value[path];
    }
    // ── Base de contenu (audit éditeur 2026-09-23, lot B) ───────────────
    // Le mtime seul ne suffit pas : ``cp -p``/``tar``/``rsync -t`` gardent la
    // date, et deux écritures dans le même tick d'horloge (~4 ms) ont le même
    // mtime. ``fileShas`` = sha256 des octets de la version disque sur
    // laquelle l'onglet est fondé : c'est LUI la précondition de /save
    // (``expected_sha256``), le mtime ne sert plus qu'au repli. Mtime, sha et
    // contenu viennent TOUJOURS de la même réponse (download ou save) — plus
    // de relevé après coup (l'ex-``_resyncBaseMtime`` absorbait une écriture
    // intercalée, écrasée ensuite sans conflit).
    const fileShas = Object.create(null);      // { [path]: sha256 hex }
    // Format disque par onglet : BOM, fins de ligne, décodage avec perte.
    const fileFormats = vue.reactive({});      // { [path]: { bom, eol, lossy } }
    function _shaOf(response) {
        try {
            const h = response && response.headers.get('X-Sha256');
            return h && /^[0-9a-f]{64}$/.test(h) ? h : null;
        } catch (_) { return null; }
    }
    function _setBase(path, mtime, sha) {
        _setBaseMtime(path, mtime);
        if (sha) fileShas[path] = sha; else delete fileShas[path];
        // Identité disque déjà traitée par le sondage : sha si connu.
        if (sha || mtime != null) _handledDiskMtime[path] = sha || mtime;
    }
    function _dropBase(path) {
        delete fileMtimes.value[path];
        delete fileShas[path];
        delete fileFormats[path];
        delete _handledDiskMtime[path];
    }
    function _setFormat(path, read) {
        if (!read) return;
        fileFormats[path] = { bom: !!read.bom, eol: read.eol || null, lossy: !!read.lossy };
        // Contenu non UTF-8 : lecture seule, sinon l'enregistrement remplacerait
        // chaque octet invalide par U+FFFD (E3).
        if (read.lossy) {
            readOnlyTabs.value.add(path);
            if (activeTabPath.value === path) _applyActiveReadOnly();
        }
    }
    // Aligne la fin de ligne du modèle sur celle du disque (E14) : sans ça un
    // ``dos2unix`` ou une réécriture de l'assistant n'était jamais adopté, et
    // l'enregistrement suivant remettait l'ancienne convention. ``pushEOL`` =
    // annulable (Ctrl+Z).
    function _syncModelEol(model, eol) {
        if (!model || (eol !== 'lf' && eol !== 'crlf')) return;
        try {
            const want = eol === 'crlf' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
            const cur = model.getEOL() === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
            if (cur !== want) model.pushEOL(want);
        } catch (_) {}
    }
    // Le modèle reflète désormais EXACTEMENT la version disque décrite par
    // ``disk`` ({ text?, mtime, sha, bom, eol, lossy }) : référence de l'onglet
    // (= texte du MODÈLE, fins de ligne normalisées comprises — sinon un
    // fichier à fins mixtes paraissait modifié dès l'ouverture), base de
    // précondition, format, conflit levé.
    function _adoptDisk(path, disk) {
        if (_modelOk(path)) originalFileContent[path] = models[path].getValue();
        _setBase(path, disk.mtime, disk.sha);
        _setFormat(path, disk);
        _mapSet(diskConflicts, path, null);
    }

    async function _checkExternalMods() {
        // RACE (mtime périmé) : on EXCLUT les fichiers avec un save en vol — leur
        // mtime tracké date d'avant le save tant que celui-ci n'a pas répondu,
        // ce qui produirait un faux « modifié sur disque » sur notre propre save.
        const tabs = openTabs.value.map(t => t.path).filter(p => (fileMtimes.value[p] !== undefined || fileShas[p]) && !_savingPaths.has(p) && !isStreamActive(p));
        if (tabs.length === 0) return;
        try {
            const res = await fetchAuth('/api/sandbox/check-mtimes', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    files: tabs.map(p => {
                        const f = { path: p, mtime: typeof fileMtimes.value[p] === 'number' ? fileMtimes.value[p] : -1 };
                        if (fileShas[p]) f.sha256 = fileShas[p];
                        return f;
                    }),
                }),
            }, true);
            if (!res || !res.ok) return;
            const data = await res.json();
            const closed = [];
            for (const item of (data.stale || [])) {
                // Même contenu, date seule changée (``touch``, ``sed -i`` sans
                // correspondance) : on avance la base en silence — plus de faux
                // conflit sur un onglet modifié (E11).
                if (item.sha256 && fileShas[item.path] && item.sha256 === fileShas[item.path]) {
                    _setBase(item.path, item.new_mtime, item.sha256);
                    continue;
                }
                const key = item.missing ? 'missing' : (item.not_file ? 'not_file'
                    : (item.unreadable ? 'unreadable' : (item.sha256 || item.new_mtime)));
                if (_handledDiskMtime[item.path] === key) continue;
                _handledDiskMtime[item.path] = key;
                _handleExternalMod(item, closed);
            }
            // Un seul message pour tous les onglets fermés (sandbox vidée,
            // dossier supprimé…) au lieu d'une avalanche de toasts (E32).
            if (closed.length) {
                showToast(closed.length === 1
                    ? `« ${closed[0]} » n'existe plus sur le disque : onglet fermé`
                    : `${closed.length} fichiers n'existent plus sur le disque : onglets fermés`, 'info');
            }
        } catch (_) { /* silencieux */ }
    }
    // Vérification « bientôt » (après une commande shell, une action git de
    // l'assistant, une rafale de sortie du terminal) — regroupée.
    let _checkSoonTimer = null;
    function checkExternalModsSoon(delay) {
        if (_checkSoonTimer) clearTimeout(_checkSoonTimer);
        _checkSoonTimer = setTimeout(() => { _checkSoonTimer = null; _checkExternalMods(); }, delay == null ? 400 : delay);
    }

    function _handleExternalMod(item, closed) {
        const fname = item.path.split('/').pop();
        // Fichier supprimé : on le dit ; un onglet modifié garde son contenu et
        // porte le bandeau (Enregistrer le recréera, après confirmation).
        if (item.missing || item.not_file) {
            // Onglet modifié : bandeau (Enregistrer recréera, après confirmation).
            // Onglet propre : fermé — il ne représente plus rien sur le disque
            // (avant : onglet orphelin et un toast d'erreur à chaque sondage).
            if (_tabIsDirty(item.path)) {
                _mapSet(diskConflicts, item.path, { mtime: null, missing: true });
            } else {
                closeTab(item.path, null, true);
                if (closed) closed.push(fname);
                else showToast(`« ${fname} » n'existe plus sur le disque : onglet fermé`, 'info');
            }
            return;
        }
        if (item.unreadable) {
            showToast(`« ${fname} » n'est plus lisible (droits) : enregistrement impossible`, 'error');
            return;
        }
        // Aperçu Office : aucun buffer local à protéger — l'onglet ACTIF se
        // reconvertit en silence (fichier régénéré par l'IA, le terminal…),
        // un onglet inactif le fera à son activation.
        if (_resolveFileViewMode(item.path) === 'office') {
            _setBase(item.path, item.new_mtime, item.sha256 || null);
            if (activeTabPath.value === item.path) officeOpen(item.path, { force: true });
            return;
        }
        // Visionneuses image / hex : rechargées si actives (E31).
        const _vm = _resolveFileViewMode(item.path);
        if (_vm === 'image' || _vm === 'hex') {
            _setBase(item.path, item.new_mtime, item.sha256 || null);
            if (activeTabPath.value === item.path) openFile(item.path, true);
            return;
        }
        if (_vm !== 'monaco') return;
        // Onglet PROPRE : rechargement silencieux, curseur et défilement gardés.
        // Onglet MODIFIÉ : jamais écrasé — bandeau Recharger / Comparer / Écraser.
        if (_tabIsDirty(item.path)) {
            _mapSet(diskConflicts, item.path, { mtime: item.new_mtime, missing: false });
        } else if (item.size > 20 * 1024 * 1024) {
            // Gros fichier qui grossit (journal ouvert) : plus de
            // re-téléchargement complet toutes les 30 s (E31) — bandeau,
            // l'utilisateur recharge quand il le veut.
            _mapSet(diskConflicts, item.path, { mtime: item.new_mtime, missing: false });
        } else {
            _reloadFromDisk(item.path, { quiet: true });
        }
    }

    // Recharge un onglet texte depuis le disque SANS changer l'onglet actif.
    // Différence minimale appliquée au modèle : curseur, défilement et plis
    // restent en place. Rend true si le modèle reflète le disque.
    async function _reloadFromDisk(path, opts) {
        opts = opts || {};
        if (!_modelOk(path) || isStreamActive(path)) return false;
        // Rechargement SILENCIEUX (onglet propre) : s'il devient modifié
        // pendant le téléchargement (frappe entre les deux ``await``), on ne
        // l'écrase pas — il reçoit le bandeau de conflit. « Recharger » cliqué
        // par l'utilisateur (non quiet) reste un écrasement voulu.
        const _wasDirty = _tabIsDirty(path);
        try {
            const res = await fetchAuth(_sbUrl('download?path=') + encodeURIComponent(path), {}, true);
            if (!res || !res.ok) {
                if (!opts.quiet) showToast('Rechargement impossible', 'error');
                return false;
            }
            const mt = _mtimeOf(res);
            const sha = _shaOf(res);
            const read = await _readTextOrBinary(res);
            if (read.binary || !_modelOk(path) || isStreamActive(path)) return false;
            if (opts.quiet && !_wasDirty && _tabIsDirty(path)) {
                _mapSet(diskConflicts, path, { mtime: mt, missing: false });
                if (mt != null) _handledDiskMtime[path] = sha || mt;
                return false;
            }
            const model = models[path];
            _syncModelEol(model, read.eol);
            const cur = model.getValue();
            if (cur !== read.text) _applyMinimalLineEdit(model, cur, read.text);
            _adoptDisk(path, Object.assign({}, read, { mtime: mt, sha }));
            if (activeTabPath.value === path) {
                isEditorDirty.value = false;
                if (isDiffView.value) updateDiffView();
            }
            _scheduleDirtyRefresh();
            _scheduleScmRefresh(path);
            return true;
        } catch (_) {
            if (!opts.quiet) showToast('Rechargement impossible', 'error');
            return false;
        }
    }

    // Après une opération git (pull, checkout, restauration, résolution) :
    // resynchronise un onglet PROPRE sans changer d'onglet actif. Avant
    // (2026-09-21), chaque onglet passait par openFile, qui pose
    // ``activeTabPath`` : l'éditeur sautait sur le dernier onglet rechargé, le
    // diff ouvert se fermait et l'historique Alt+← se remplissait.
    async function _gitReloadTab(path) {
        if (_tabIsDirty(path)) return false;
        const frozen = readOnlyTabs.value.has(path);       // version de commit, .docx…
        if (activeTabPath.value === path && (frozen || !_modelOk(path))) {
            await openFile(path, true);
            return true;
        }
        if (!_modelOk(path)) return false;      // aperçu : relu à son activation
        if (frozen) {
            // Relu depuis le disque à son activation (switchTab → openFile).
            _dropModel(path);
            readOnlyTabs.value.delete(path);
            delete originalFileContent[path];
            return true;
        }
        return _reloadFromDisk(path, { quiet: true });
    }

    // Contenu disque actuel (comparaison) ; null si illisible.
    async function _fetchDiskText(path) {
        try {
            const res = await fetchAuth(_sbUrl('download?path=') + encodeURIComponent(path), {}, true);
            if (!res || !res.ok) return res && res.status === 404 ? '' : null;
            const read = await _readTextOrBinary(res);
            return read.binary ? null : read.text;
        } catch (_) { return null; }
    }

    // ── Actions du bandeau « modifié sur le disque » ──────────────────────
    async function conflictReload(path) {
        path = path || activeTabPath.value;
        if (!path) return;
        if (_tabIsDirty(path)) {
            const ok = await openConfirm('Recharger depuis le disque ?',
                'Vos modifications non enregistrées de « ' + path.split('/').pop() + ' » seront remplacées.',
                true, 'Recharger');
            if (!ok) return;
        }
        if (isDiffView.value && activeTabPath.value === path) isDiffView.value = false;
        await _reloadFromDisk(path);
    }
    async function conflictCompare(path) {
        path = path || activeTabPath.value;
        if (!path) return;
        const disk = await _fetchDiskText(path);
        if (disk === null) { showToast('Version disque illisible', 'error'); return; }
        showDiffForMessage(path, disk, 'disk');
    }
    async function conflictOverwrite(path) {
        path = path || activeTabPath.value;
        if (!path) return;
        await saveEditorContent({ path, force: true });
        // Conflit tranché : la comparaison avec l'ancienne version disque
        // n'a plus d'objet.
        if (!diskConflicts.value[path] && isDiffView.value && diffBase.value === 'disk'
                && activeTabPath.value === path) {
            isDiffView.value = false;
            diffBase.value = 'saved';
            nextTick(() => robustLayout());
        }
    }
    function conflictDismiss(path) {
        _mapSet(diskConflicts, path || activeTabPath.value, null);
    }

    // ── Actions du bandeau « l'assistant a réécrit ce fichier » ───────────
    function stashRestore(path) {
        path = path || activeTabPath.value;
        const st = assistantStash.value[path];
        if (!st || !_modelOk(path)) { _mapSet(assistantStash, path, null); return; }
        const model = models[path];
        _applyMinimalLineEdit(model, model.getValue(), st.content);
        _mapSet(assistantStash, path, null);
        if (activeTabPath.value === path) isEditorDirty.value = _tabIsDirty(path);
        if (isDiffView.value && activeTabPath.value === path) isDiffView.value = false;
        _scheduleDirtyRefresh();
        showToast('Vos modifications sont restaurées (non enregistrées)');
    }
    function stashCompare(path) {
        path = path || activeTabPath.value;
        const st = assistantStash.value[path];
        if (!st) return;
        showDiffForMessage(path, st.content, 'stash');
    }
    function stashDismiss(path) {
        path = path || activeTabPath.value;
        _mapSet(assistantStash, path, null);
        if (isDiffView.value && diffBase.value === 'stash') isDiffView.value = false;
    }
    // Bandeau affiché au-dessus du code pour l'onglet actif (le plus urgent).
    const activeBanner = vue.computed(() => {
        const p = activeTabPath.value;
        if (!p) return null;
        if (assistantStash.value[p]) return { kind: 'stash', path: p };
        const c = diskConflicts.value[p];
        if (c) return { kind: c.missing ? 'missing' : 'disk', path: p };
        if (fileFormats[p] && fileFormats[p].lossy) return { kind: 'encoding', path: p };
        return null;
    });

    // Periodic check (30s) when tab visible
    function _startMtimeChecks() {
        _stopMtimeChecks();
        _mtimeCheckTimer = setInterval(() => {
            if (document.visibilityState === 'visible') _checkExternalMods();
        }, _MTIME_CHECK_INTERVAL_MS);
    }
    function _stopMtimeChecks() {
        if (_mtimeCheckTimer) { clearInterval(_mtimeCheckTimer); _mtimeCheckTimer = null; }
    }
    // Au focus de la fenêtre : check immédiat (cas typique : l'user était
    // dans son terminal, a touché un fichier, revient sur l'onglet navigateur)
    window.addEventListener('focus', () => {
        // AUDIT 2026-09-01 (passe 5, F12) — gardes : sans elles, chaque focus
        // fenêtre déclenchait un GET /api/sandbox/quota authentifié, y
        // compris sur l'écran de login (401) et pour un utilisateur qui n'a
        // jamais ouvert l'éditeur — neutralisant l'idle-timeout serveur.
        // Mêmes conditions que le poll périodique (user + éditeur ouvert).
        if (!user.value) return;
        _checkExternalMods();
        if (showEditor.value) _gitAutoRefresh();
        // refresh aussi le quota au focus : si l'user a créé
        // ou supprimé des fichiers via le terminal, le taux de
        // remplissage est mis à jour dès qu'il revient sur l'app.
        if (showEditor.value) loadSandboxQuota();
    });

    // ============================================================
    //  Aperçus Office / PDF (docx, pptx, xlsx, pdf)
    // ============================================================
    //  POST /api/sandbox/office/prepare convertit au besoin (LibreOffice isolé,
    //  cache serveur par clé = contenu du fichier) et rend un manifeste :
    //  URL du PDF (visualiseur natif, iframe) ou description de la grille xlsx.
    //
    //  Garanties d'affichage :
    //   • une requête par onglet (AbortController) + numéro de séquence : une
    //     réponse lente n'écrase jamais l'état d'un autre onglet ni une
    //     demande plus récente ;
    //   • un aperçu PRÊT reste affiché pendant qu'on le revalide (activation
    //     d'onglet, modif disque) : pas de flash ; il n'est remplacé que si la
    //     clé change ;
    //   • le spinner n'apparaît qu'après 400 ms (cache chaud = instantané) et
    //     l'horloge « Conversion… N s » ne tourne que pendant un chargement ;
    //   • tout est purgé à la fermeture d'onglet, au logout et au dispose
    //     (watch de réconciliation sur openTabs en filet).
    // ============================================================
    const officeDocs = ref({});                 // { [path]: entrée } — objet REMPLACÉ
    const officeNow  = ref(Date.now());
    const _officeCtl = Object.create(null);     // path → { ac, seq, spinTimer }
    let   _officeSeq   = 0;
    let   _officeClock = null;
    const _OFFICE_SPIN_DELAY_MS = 400;
    const _OFFICE_TRANSIENT = ['busy', 'timeout', 'network', 'changed'];

    const officeActive = vue.computed(() => {
        const p = activeTabPath.value;
        if (!p || activeFileViewMode.value !== 'office') return null;
        return officeDocs.value[p] || null;
    });

    function _officeSet(path, entry) {
        const next = Object.assign({}, officeDocs.value);
        if (entry) next[path] = entry; else delete next[path];
        officeDocs.value = next;
        _officeSyncClock();
    }
    function _officeSyncClock() {
        const spinning = Object.values(officeDocs.value)
            .some(e => e && e.status === 'loading' && e.spin);
        if (spinning && !_officeClock) {
            officeNow.value = Date.now();
            _officeClock = setInterval(() => { officeNow.value = Date.now(); }, 1000);
        } else if (!spinning && _officeClock) {
            clearInterval(_officeClock);
            _officeClock = null;
        }
    }
    function _officeAbort(path) {
        const c = _officeCtl[path];
        if (!c) return;
        if (c.spinTimer) clearTimeout(c.spinTimer);
        delete _officeCtl[path];
        try { c.ac.abort(); } catch (_) {}
    }
    // Suivi des passes complètes de PDF en cours, par chemin.
    const _officeFullWatch = {};
    const _OFFICE_FULL_POLL_MS = 2500;
    const _OFFICE_FULL_MAX = 120;              // ~5 min

    function _officeForget(path) {
        _officeAbort(path);
        _officeStopWatchFullPdf(path);       // onglet fermé : plus rien à suivre
        if (officeDocs.value[path]) _officeSet(path, null);
    }
    function _officeResetAll() {
        Object.keys(_officeCtl).forEach(_officeAbort);
        Object.keys(_officeFullWatch).forEach(_officeStopWatchFullPdf);
        officeDocs.value = {};
        _officeSyncClock();
    }

    async function officeOpen(path, opts) {
        opts = opts || {};
        const kind = window.elpisOffice.officeKind(path);
        if (!path || !kind) return;
        const prev = officeDocs.value[path] || null;
        const view = opts.view || (prev && prev.view) || (kind === 'xlsx' ? 'grid' : 'pages');
        _officeAbort(path);
        const ctl = { ac: new AbortController(), seq: ++_officeSeq, spinTimer: null };
        _officeCtl[path] = ctl;
        const keepReady = !!(prev && prev.status === 'ready' && prev.view === view);
        if (!keepReady) {
            _officeSet(path, {
                status: 'loading', kind, view, spin: false, startedAt: Date.now(),
                key: null, pdfUrl: null, pages: null, grid: null,
                has: (prev && prev.has) || {}, error: null,
                reloadSeq: prev ? prev.reloadSeq : 0,
            });
            ctl.spinTimer = setTimeout(() => {
                const cur = officeDocs.value[path];
                if (_officeCtl[path] === ctl && cur && cur.status === 'loading') {
                    _officeSet(path, Object.assign({}, cur, { spin: true }));
                }
            }, _OFFICE_SPIN_DELAY_MS);
        }
        let res = null;
        try {
            res = await fetchAuth(_sbUrl('office/prepare'), {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ path, view }),
                signal:  ctl.ac.signal,
            }, true);
        } catch (_) { res = null; }
        let data = null;
        if (res) { try { data = await res.json(); } catch (_) { data = null; } }
        // Abandonnée (onglet fermé, changement de vue, logout) ou supplantée.
        if (_officeCtl[path] !== ctl || ctl.ac.signal.aborted) return;
        if (ctl.spinTimer) clearTimeout(ctl.spinTimer);
        delete _officeCtl[path];
        if (!openTabs.value.some(t => t.path === path)) { _officeSet(path, null); return; }

        const cur = officeDocs.value[path] || null;
        if (res && res.ok && data && data.key) {
            try { _setBaseMtime(path, data.mtime); } catch (_) {}
            const same = !!(cur && cur.status === 'ready' && cur.key === data.key && cur.view === data.view);
            if (same && !opts.reload) return;               // rien n'a changé : pas de re-rendu
            _officeSet(path, {
                status: 'ready', kind: data.kind, view: data.view, spin: false,
                key: data.key, has: data.has || {},
                pdfUrl: data.pages ? data.pages.url : null,
                pages: data.pages || null,
                grid: data.grid || null,
                error: null,
                reloadSeq: (cur ? cur.reloadSeq : 0) + (opts.reload ? 1 : 0),
            });
            // Aperçu de TÊTE (2026-09-18) : sur un document lourd, le serveur
            // rend les premières pages tout de suite et convertit le reste en
            // fond. On revient chercher le manifeste jusqu'à ce que la version
            // complète soit là — l'URL porte sa révision, donc l'iframe se
            // recharge toute seule.
            if (data.pages && data.pages.partial) _officeWatchFullPdf(path, data.key);
            return;
        }
        const detail = data && data.detail;
        let code = (detail && typeof detail === 'object' && detail.code) || '';
        const message = (detail && typeof detail === 'object' && detail.message) || '';
        if (!res) code = 'network';
        else if (!code) code = res.status === 404 ? 'not_found' : 'failed';
        if (code === 'not_found') {
            // Même geste que la branche texte : pas d'onglet fantôme.
            showToast('Fichier introuvable : ' + path.split('/').pop(), 'error');
            closeTab(path, null, true);
            return;
        }
        // Revalidation en échec passager : on garde l'aperçu affiché.
        if (cur && cur.status === 'ready' && _OFFICE_TRANSIENT.includes(code)) return;
        _officeSet(path, {
            status: 'error', kind, view, spin: false,
            key: null, pdfUrl: null, pages: null, grid: null,
            has: (cur && cur.has) || {},
            error: { code, message: message || window.elpisOffice.errorLabel(code) },
            reloadSeq: cur ? cur.reloadSeq : 0,
        });
    }

    function officeSetView(view) {
        const p = activeTabPath.value;
        if (p && officeActive.value && officeActive.value.view !== view) officeOpen(p, { view });
    }
    function officeReload() {
        const p = activeTabPath.value;
        if (p) officeOpen(p, { force: true, reload: true });
    }
    // Repli texte d'un docx quand LibreOffice manque (extraction python-docx).
    function officeUseText() {
        const p = activeTabPath.value;
        if (!p || window.elpisOffice.officeKind(p) !== 'docx') return;
        _officeForget(p);
        _setWith(officeTextFallback, p);
        openFile(p, true);
    }
    // Suivi de la passe complète d'un PDF : on repasse chercher le manifeste
    // (réponse en cache côté serveur : c'est une lecture de fichier) jusqu'à ce
    // que ``partial`` retombe, ou jusqu'au plafond — au-delà, la tête reste
    // affichée avec sa pastille « Début ».

    function _officeWatchFullPdf(path, key) {
        if (_officeFullWatch[path] && _officeFullWatch[path].key === key) return;
        _officeStopWatchFullPdf(path);
        const suivi = { key: key, n: 0, timer: null };
        _officeFullWatch[path] = suivi;
        const tick = async () => {
            suivi.timer = null;
            const doc = officeDocs.value[path];
            if (!doc || doc.key !== key || doc.view !== 'pages'
                    || !openTabs.value.some(t => t.path === path)) {
                _officeStopWatchFullPdf(path); return;
            }
            if (++suivi.n > _OFFICE_FULL_MAX) { _officeStopWatchFullPdf(path); return; }
            let data = null;
            try {
                const res = await fetchAuth(_sbUrl('office/prepare'), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: path, view: 'pages' }),
                }, true);
                if (res && res.ok) data = await res.json();
            } catch (_) { data = null; }
            const cur = officeDocs.value[path];
            if (!cur || cur.key !== key) { _officeStopWatchFullPdf(path); return; }
            if (data && data.pages && data.key === key) {
                if (!data.pages.partial) {
                    _officeSet(path, Object.assign({}, cur, {
                        pages: data.pages, pdfUrl: data.pages.url,
                    }));
                    _officeStopWatchFullPdf(path);
                    return;
                }
            }
            suivi.timer = setTimeout(tick, _OFFICE_FULL_POLL_MS);
        };
        suivi.timer = setTimeout(tick, _OFFICE_FULL_POLL_MS);
    }

    function _officeStopWatchFullPdf(path) {
        const suivi = _officeFullWatch[path];
        if (suivi && suivi.timer) clearTimeout(suivi.timer);
        delete _officeFullWatch[path];
    }

    // Taille de feuille annoncée par les en-têtes d'un morceau : appliquée au
    // document affiché si elle diffère (la grille se redimensionne toute seule,
    // le composant observe ``grid.sheets``).
    function _officeApplySheetSize(key, sheet, headers) {
        if (!headers || typeof headers.get !== 'function') return;
        const rows = parseInt(headers.get('X-Office-Rows') || '', 10);
        const cols = parseInt(headers.get('X-Office-Cols') || '', 10);
        if (!Number.isFinite(rows) || rows <= 0) return;
        const path = activeTabPath.value;
        const doc = path ? officeDocs.value[path] : null;
        if (!doc || doc.key !== key || !doc.grid) return;
        const sh = (doc.grid.sheets || [])[sheet];
        if (!sh || (sh.rows === rows && (!Number.isFinite(cols) || sh.cols === cols))) return;
        const sheets = doc.grid.sheets.slice();
        sheets[sheet] = Object.assign({}, sh, {
            rows: rows,
            cols: Number.isFinite(cols) && cols > 0 ? Math.max(cols, sh.cols || 0) : sh.cols,
        });
        _officeSet(path, Object.assign({}, doc, {
            grid: Object.assign({}, doc.grid, { sheets: sheets }),
        }));
    }

    // Morceau de grille xlsx (appelé par le composant office-grid).
    async function officeFetchChunk(key, sheet, chunk, signal) {
        const res = await fetchAuth(_sbUrl('office/sheet/' + key + '/' + sheet + '/' + chunk),
                                    { signal }, true);
        if (res && res.ok) {
            // Taille RÉELLE de la feuille (2026-09-18) : la grille est bâtie à
            // la demande côté serveur, et un classeur sans ``<dimension>`` est
            // annoncé court dans le manifeste. Le premier morceau ramène la
            // vraie taille — sans quoi le tableau resterait tronqué en silence.
            _officeApplySheetSize(key, sheet, res.headers);
            return res.json();
        }
        if (res && res.status === 404) {
            // Cache élagué côté serveur : on reprépare l'onglet actif.
            const p = activeTabPath.value;
            if (p && !(signal && signal.aborted)) officeOpen(p, { force: true });
        }
        throw new Error('office-chunk');
    }
    // Un outil (IA) a écrit un fichier affiché par un visualiseur : on
    // rafraîchit l'aperçu au lieu d'injecter son contenu dans Monaco.
    async function editorRefreshViewer(path) {
        path = _canonSandboxPath(path);
        if (!path || !settings.value.enable_editor) return;
        if (openTabs.value.some(t => t.path === path)) {
            if (activeTabPath.value === path) await openFile(path, true);
            return;
        }
        if (!showEditor.value && settings.value.auto_open_editor_on_write === false) return;
        await openFile(path, true);
    }
    // Filet : un onglet retiré par un autre chemin que closeTab (échec
    // d'ouverture, stream annulé, logout) ne doit laisser ni requête en vol ni
    // entrée d'aperçu, ni marque binaire.
    watch(() => openTabs.value.map(t => t.path).join('\n'), () => {
        const open = new Set(openTabs.value.map(t => t.path));
        Object.keys(_officeCtl).forEach(p => { if (!open.has(p)) _officeAbort(p); });
        Object.keys(officeDocs.value).forEach(p => { if (!open.has(p)) _officeForget(p); });
        [binaryPaths, officeTextFallback].forEach(r => {
            if ([...r.value].some(p => !open.has(p))) r.value = new Set([...r.value].filter(p => open.has(p)));
        });
        _binaryRefused.forEach(p => { if (!open.has(p)) _binaryRefused.delete(p); });
    });

    // ============================================================
    //  Polling périodique du quota sandbox
    // ============================================================
    //  Le quota peut changer SANS que le frontend en soit informé :
    //   • commande terminal (rm, dd, wget, build qui génère des fichiers…)
    //   • le LLM qui écrit via les tools
    //  → polling toutes les 10s quand l'éditeur est visible. Combiné au
    //    refresh immédiat après save/file-ops, le taux affiché ne dérive
    //    jamais de plus de 10s vs la réalité.
    //
    //  Le calcul backend utilise ``du`` (rapide) — un poll 10s est
    //  négligeable même sur un gros sandbox.
    // ============================================================
    let _quotaPollTimer = null;
    const _QUOTA_POLL_INTERVAL_MS = 10_000;
    function _startQuotaPoll() {
        if (_quotaPollTimer) clearInterval(_quotaPollTimer);
        _quotaPollTimer = setInterval(() => {
            if (document.visibilityState === 'visible' && showEditor.value) {
                loadSandboxQuota();
            }
        }, _QUOTA_POLL_INTERVAL_MS);
    }

    // Démarre le poll au boot de l'éditeur (premier showEditor)
    let _mtimeStarted = false;
    watch(showEditor, (v) => {
        if (v && !_mtimeStarted) {
            _mtimeStarted = true;
            _startMtimeChecks();
            _startQuotaPoll();
            // Refresh immédiat à la première ouverture
            loadSandboxQuota();
            // Statut Git en arrière-plan : pastilles de l'arbre, branche de la
            // barre d'état, marge du code — sans ouvrir la vue Git.
            if (gitBackgroundInit) gitBackgroundInit().catch(() => {});
            // Sonde « restauration interrompue » : une restore tuée en plein
            // vol (recyclage de worker — max_requests=2000, graceful 330 s)
            // laisse /work AMPUTÉ. Le backend pose un marqueur mais il
            // n'était lu par personne : on le remonte ici, au premier accès
            // à l'éditeur, sans attendre que l'utilisateur pense à ouvrir le
            // panneau Snapshots.
            loadSnapshots().then(() => {
                if (restoreIncomplete.value) {
                    showToast(
                        '⚠ Une restauration de snapshot a été interrompue — '
                        + 'vos fichiers sont peut-être incomplets. Voir le panneau Snapshots.',
                        'error',
                    );
                }
            }).catch(() => {});
        }
    });

    // ============================================================
    //  Tab management — context menu, reopen closed, restore on reload
    // ============================================================
    //  Le state des onglets se compose de :
    //    • openTabs              : liste actuelle (déjà existant)
    //    • _closedTabsStack      : pile des onglets fermés (LIFO),
    //                              max 20, sert pour Ctrl+Shift+T
    //    • tabCtxMenu            : menu contextuel droit-clic
    //
    //  Restore au reload : on persiste {paths, active} dans localStorage
    //  à chaque change de openTabs/activeTabPath. Au boot, si le user
    //  est identifié, on ré-ouvre les fichiers (ignore silencieusement
    //  ceux qui ont disparu).
    // ============================================================
    const tabCtxMenu = ref({ show: false, x: 0, y: 0, path: '' });
    const _closedTabsStack = [];                       // pile {path, name}
    const _MAX_CLOSED_HISTORY = 20;

    // localStorage key scopé par user. Le suffixe `personal` date de la
    // feature Équipes (retirée 2026-06) — conservé tel quel pour ne pas
    // perdre les onglets déjà persistés sous cette clé.
    function _tabsStorageKey() {
        const uid = (user.value && user.value.id) || 'anon';
        return `elpis.tabs.v2.${uid}.personal`;
    }
    // Mémorisation des onglets (réglage `editor_persist_tabs`) : ACTIVÉE par
    // défaut depuis le 2026-09-19 (auparavant opt-in). Désactivée, on n'écrit
    // RIEN et on PURGE la clé existante (désactiver = oublier), et le boot ne
    // restaure rien. Clé absente (réglages pas encore chargés) = activée : un
    // purge sur une valeur transitoire effaçait sinon la session à restaurer.
    function _tabsPersistEnabled() {
        return !!(settings.value && settings.value.editor_persist_tabs !== false);
    }
    // Position à mémoriser pour un onglet : curseur + défilement, lus dans
    // l'éditeur pour l'onglet actif, dans le cache d'état de vue sinon.
    function _tabPosition(path) {
        try {
            let vs = null;
            if (path === activeTabPath.value && monacoRef.instance
                    && monacoRef.instance.getModel() === models[path]) {
                vs = monacoRef.instance.saveViewState();
            } else if (typeof _tabViewStates !== 'undefined') {
                vs = _tabViewStates[path];
            }
            if (!vs || !vs.cursorState || !vs.cursorState[0]) return null;
            const pos = vs.cursorState[0].position || vs.cursorState[0].selectionStart;
            if (!pos) return null;
            return { line: pos.lineNumber, col: pos.column,
                     top: (vs.viewState && vs.viewState.scrollTop) || 0 };
        } catch (_) { return null; }
    }
    // Positions restaurées au démarrage, appliquées au premier affichage.
    const _pendingPositions = Object.create(null);
    // Debounced persist : openTabs et activeTabPath changent en cascade
    // au switch d'onglet, pas besoin d'écrire le localStorage 5x dans
    // la même frame. (Les données sont capturées à la planification : si
    // openTabs change encore avant que le timer tire, on les remplace.)
    let _persistTabsTimer = null;
    let _persistTabsData  = null;       // données capturées à la planification
    // Onglets mémorisés dont la réouverture a échoué pour une cause passagère
    // (cf. restoreTabsFromStorage) : ils restent dans la session persistée.
    let _deferredRestore = [];
    function _buildTabsData() {
        const positions = {};
        openTabs.value.forEach(t => {
            const pos = _tabPosition(t.path) || _pendingPositions[t.path];
            if (pos) positions[t.path] = pos;
        });
        const _open = openTabs.value.map(t => t.path);
        return {
            // Onglets en attente de réouverture (échec passager au démarrage) :
            // gardés en mémoire tant qu'ils n'ont pas pu être rouverts.
            paths:  _open.concat(_deferredRestore.filter(p => !_open.includes(p))),
            active: activeTabPath.value || null,
            pinned: openTabs.value.filter(t => t.pinned).map(t => t.path),
            positions,
        };
    }
    function _schedulePersistTabs() {
        if (!_tabsPersistEnabled()) {
            // Désactivé : rien à écrire (et on purge une éventuelle clé
            // d'avant la désactivation). _persistTabsData reste null → le
            // flush beforeunload ne réécrit rien non plus.
            try { localStorage.removeItem(_tabsStorageKey()); } catch (_) {}
            return;
        }
        _persistTabsData = _buildTabsData();
        if (_persistTabsTimer) clearTimeout(_persistTabsTimer);
        _persistTabsTimer = setTimeout(() => {
            _persistTabsTimer = null;
            try {
                localStorage.setItem(_tabsStorageKey(), JSON.stringify(_persistTabsData));
            } catch (_) {}
            _persistTabsData = null;
        }, 150);
    }
    // Watcher sur les arrays — Vue 3 deep par défaut pour ref(array)
    watch(openTabs, _schedulePersistTabs, { deep: true });
    watch(activeTabPath, _schedulePersistTabs);

    // ── Indicateur « non sauvegardé » PAR onglet (point ambre) ─────────
    // models/originalFileContent ne sont PAS réactifs → on maintient un Set
    // réactif recalculé (débouncé 120 ms) via _tabIsDirty (la source de
    // vérité existante). Déclencheurs : frappe dans les 2 panneaux (appel
    // explicite dans les onDidChangeModelContent), bascule de isEditorDirty
    // (posée à false par TOUS les chemins de save/reset), et changements
    // d'onglets. L'undo qui revient au contenu d'origine efface le point.
    const dirtyTabs = ref(new Set());
    let _dirtyRefreshTimer = null;
    function _refreshDirtyTabs() {
        const s = new Set();
        for (const t of openTabs.value) {
            try { if (_tabIsDirty(t.path)) s.add(t.path); } catch (_) {}
        }
        const cur = dirtyTabs.value;
        if (s.size !== cur.size || [...s].some(p => !cur.has(p))) dirtyTabs.value = s;
    }
    function _scheduleDirtyRefresh() {
        if (_dirtyRefreshTimer) clearTimeout(_dirtyRefreshTimer);
        _dirtyRefreshTimer = setTimeout(() => { _dirtyRefreshTimer = null; _refreshDirtyTabs(); }, 120);
    }
    watch(isEditorDirty, _scheduleDirtyRefresh);
    watch(openTabs, _scheduleDirtyRefresh, { deep: true });

    // ── Débordement d'onglets : badge « +X » + liste de rattrapage ─────
    // La barre scrolle avec sa scrollbar MASQUÉE (no-scrollbar) : sans
    // indicateur, les onglets au-delà du bord étaient invisibles. On compte
    // les onglets ENTIÈREMENT hors de la fenêtre visible (gauche + droite) ;
    // le badge « +X » ouvre une liste de TOUS les onglets (bascule au clic).
    const tabStripRef      = ref(null);   // conteneur scrollable (tablist)
    const hiddenTabsCount  = ref(0);
    const showTabsOverflow = ref(false);
    let _tabStripRO = null;
    function updateHiddenTabs() {
        const el = tabStripRef.value;
        if (!el || el.clientWidth === 0) { hiddenTabsCount.value = 0; return; }
        const box = el.getBoundingClientRect();
        let hidden = 0;
        for (const child of el.children) {
            if (!child.getAttribute || child.getAttribute('role') !== 'tab') continue;
            const r = child.getBoundingClientRect();
            if (r.right <= box.left + 1 || r.left >= box.right - 1) hidden++;
        }
        hiddenTabsCount.value = hidden;
    }
    // ResizeObserver : suit l'apparition (v-show), le drag du splitter et le
    // resize de la fenêtre — évite un listener window global.
    watch(tabStripRef, (el) => {
        if (_tabStripRO) { try { _tabStripRO.disconnect(); } catch (_) {} _tabStripRO = null; }
        if (el && typeof ResizeObserver !== 'undefined') {
            _tabStripRO = new ResizeObserver(() => updateHiddenTabs());
            _tabStripRO.observe(el);
        }
        updateHiddenTabs();
    });
    watch(openTabs, () => nextTick(updateHiddenTabs), { deep: true });
    // L'onglet ACTIF est toujours ramené dans la vue (2026-09-20) : avant,
    // seule la liste « +N » le faisait ; après Ctrl+PageUp/PageDown, Alt+←/→,
    // un clic dans l'arbre ou une ouverture par l'assistant, il pouvait rester
    // hors de la fenêtre visible. Défilement HORIZONTAL seul (pas de
    // scrollIntoView, qui peut aussi déplacer les ancêtres verticalement).
    function scrollTabIntoView(path) {
        const strip = tabStripRef.value;
        if (!strip || !path || strip.clientWidth === 0) return;
        try {
            const sel = '[data-path="' + (window.CSS && CSS.escape ? CSS.escape(path) : path) + '"]';
            const el = strip.querySelector(sel);
            if (!el) return;
            const r = el.getBoundingClientRect(), b = strip.getBoundingClientRect();
            if (r.left < b.left) strip.scrollLeft += r.left - b.left;
            else if (r.right > b.right) strip.scrollLeft += Math.min(r.right - b.right, r.left - b.left);
        } catch (_) {}
    }
    watch(activeTabPath, (p) => nextTick(() => { scrollTabIntoView(p); updateHiddenTabs(); }));
    function pickTabFromOverflow(path) {
        showTabsOverflow.value = false;
        switchTab(path);
        nextTick(() => { scrollTabIntoView(path); updateHiddenTabs(); });
    }

    async function _retryDeferredTabs(attempt) {
        if (!_deferredRestore.length) return;
        const keep = activeTabPath.value;
        for (const p of _deferredRestore.slice()) {
            if (openTabs.value.find(t => t.path === p)) continue;
            try { await openFile(p, false, { quiet: true }); } catch (_) {}
        }
        _deferredRestore = _deferredRestore.filter(
            p => !openTabs.value.find(t => t.path === p) && _openTransientFail.has(p));
        // La réouverture ne vole pas l'onglet sur lequel on travaille.
        if (keep && keep !== activeTabPath.value && openTabs.value.find(t => t.path === keep)) {
            try { await switchTab(keep); } catch (_) {}
        }
        _schedulePersistTabs();
        if (_deferredRestore.length && attempt < 4) {
            setTimeout(() => _retryDeferredTabs(attempt + 1), 5000 * attempt);
        } else if (_deferredRestore.length) {
            showToast('Réouverture impossible : ' + _deferredRestore.map(p => p.split('/').pop()).join(', ')
                      + '. Rouvrez-les depuis l’arbre quand l’environnement répond.', 'warning');
            _deferredRestore = [];
            _schedulePersistTabs();
        }
    }

    async function restoreTabsFromStorage() {
        // Appelé après loadSandboxFiles dans le bootstrap du composant.
        // No-op si pas de user identifié.
        //
        // Avant, on early-exit si openTabs.value.length > 0,
        // ce qui éjectait silencieusement tous les onglets persistés dès
        // qu'un tool result (LLM streamOpenForWrite) arrivait avant que
        // ce handler n'ait fini ses nextTick. Maintenant on SKIP les
        // doublons individuellement — les onglets restorés s'ajoutent
        // proprement à ceux déjà ouverts par le LLM.
        if (!user.value || !user.value.id) return;
        // Opt-out (défaut) : pas de restauration, et la clé résiduelle est
        // purgée pour que rien ne « revienne » si le réglage est réactivé.
        if (!_tabsPersistEnabled()) {
            try { localStorage.removeItem(_tabsStorageKey()); } catch (_) {}
            return;
        }
        let saved;
        try {
            const raw = localStorage.getItem(_tabsStorageKey());
            if (!raw) return;
            saved = JSON.parse(raw);
        } catch (_) { return; }
        if (!saved || !Array.isArray(saved.paths) || saved.paths.length === 0) return;

        // Positions (curseur + défilement) : appliquées au premier affichage.
        if (saved.positions && typeof saved.positions === 'object') {
            Object.keys(saved.positions).forEach(p => {
                const pos = saved.positions[p];
                if (pos && pos.line > 0) _pendingPositions[p] = pos;
            });
        }
        // Ouvre chaque fichier en série pour ne pas saturer le backend.
        // Les paths qui n'existent plus → openFile renvoie 404 et splice
        // l'onglet ; on retient ceux réellement ouverts.
        for (const p of saved.paths) {
            if (openTabs.value.find(t => t.path === p)) continue;   // déjà ouvert (LLM)
            // Aperçu Office : onglet seulement — la conversion attendra son
            // activation (sinon N conversions LibreOffice au démarrage).
            if (_resolveFileViewMode(p) === 'office') {
                openTabs.value.push({ path: p, name: p.split('/').pop() });
                continue;
            }
            try { await openFile(p, false, { quiet: true }); } catch(_) {}
        }
        // Échec PASSAGER (sandbox pas prête, réseau) : l'onglet reste en
        // mémoire et sera rouvert dès que l'environnement répond — avant, la
        // session était réécrite sans lui, donc perdue pour de bon.
        _deferredRestore = saved.paths.filter(
            p => !openTabs.value.find(t => t.path === p) && _openTransientFail.has(p));
        if (_deferredRestore.length) {
            showToast(_deferredRestore.length + ' onglet' + (_deferredRestore.length > 1 ? 's' : '')
                      + ' en attente : réouverture dès que l’environnement répond.', 'info');
            setTimeout(() => _retryDeferredTabs(1), 4000);
        }
        // Purge SYNCHRONE des paths qui n'ont pas pu être
        // rouverts (fichier temporaire purgé → 404). Sans ça, la seule
        // éviction est le watcher debouncé (150ms) déclenché par le splice
        // dans openFile ; comme _pendingOpen ne dédoublonne que les appels
        // concurrents, les openFile séquentiels suivants au même boot
        // (switchTab(saved.active), retriggers) re-fetchent en boucle → 404
        // répétés (cf. error.log). On réécrit la clé immédiatement avec les
        // seuls survivants pour ne plus jamais redemander un fichier mort.
        const _alive = new Set(openTabs.value.map(t => t.path));
        const _survivors = saved.paths.filter(p => _alive.has(p) || _deferredRestore.includes(p));
        // Épinglés : groupe de gauche, dans l'ordre mémorisé.
        if (Array.isArray(saved.pinned) && saved.pinned.length) {
            const pin = new Set(saved.pinned);
            const tabs = openTabs.value.map(t => pin.has(t.path) ? Object.assign({}, t, { pinned: true }) : t);
            openTabs.value = tabs.filter(t => t.pinned).concat(tabs.filter(t => !t.pinned));
        }
        if (_survivors.length !== saved.paths.length) {
            try {
                localStorage.setItem(_tabsStorageKey(), JSON.stringify({
                    paths:  _survivors,
                    active: (saved.active && _alive.has(saved.active)) ? saved.active : null,
                }));
            } catch (_) {}
        }
        // Restaure l'onglet actif UNIQUEMENT s'il a survécu (sinon on
        // aurait re-déclenché openFile(saved.active,true) → re-fetch 404).
        if (saved.active
            && _alive.has(saved.active)
            && !activeTabPath.value) {
            try { await switchTab(saved.active); } catch(_) {}
        }
    }

    // ---- Context menu actions --------------------------------------
    function openTabCtxMenu(e, path) {
        e.preventDefault();
        e.stopPropagation();
        // Position du menu — clamp pour rester dans la viewport.
        const w = 220, h = 380;
        const x = Math.min(e.clientX, window.innerWidth - w - 8);
        const y = Math.min(e.clientY, window.innerHeight - h - 8);
        tabCtxMenu.value = { show: true, x, y, path };
    }
    function closeTabCtxMenu() { tabCtxMenu.value = { ...tabCtxMenu.value, show: false }; }

    // Ferme tous les onglets sauf celui passé en param.
    // Réutilise closeTab() pour bénéficier de la confirmation dirty.
    // Les onglets ÉPINGLÉS survivent à « Fermer les autres / à droite / tout »
    // (seul un geste ciblé — croix, Alt+W, clic milieu — les ferme).
    async function closeOtherTabs(path) {
        closeTabCtxMenu();
        const others = openTabs.value.filter(t => t.path !== path && !t.pinned).map(t => t.path);
        for (const p of others) {
            try { await closeTab(p, null); } catch(_) {}
        }
    }
    async function closeTabsToRight(path) {
        closeTabCtxMenu();
        const idx = openTabs.value.findIndex(t => t.path === path);
        if (idx < 0) return;
        const toClose = openTabs.value.slice(idx + 1).filter(t => !t.pinned).map(t => t.path);
        for (const p of toClose) {
            try { await closeTab(p, null); } catch(_) {}
        }
    }
    async function closeAllTabs() {
        closeTabCtxMenu();
        const all = openTabs.value.filter(t => !t.pinned).map(t => t.path);
        for (const p of all) {
            try { await closeTab(p, null); } catch(_) {}
        }
    }

    // ── Épingler / réordonner / identifier les onglets ────────────────────
    function togglePinTab(path) {
        closeTabCtxMenu();
        const tabs = openTabs.value.slice();
        const i = tabs.findIndex(t => t.path === path);
        if (i < 0) return;
        const tab = Object.assign({}, tabs[i], { pinned: !tabs[i].pinned });
        tabs.splice(i, 1);
        // Épinglé → fin du groupe épinglé ; désépinglé → début des autres.
        const lastPinned = tabs.reduce((n, t, k) => (t.pinned ? k + 1 : n), 0);
        tabs.splice(lastPinned, 0, tab);
        openTabs.value = tabs;
        // L'ordre et la largeur changent (épinglé = compact) : le défilement
        // de la barre est borné à la nouvelle largeur totale et l'onglet actif
        // pouvait sortir de la vue.
        nextTick(() => scrollTabIntoView(activeTabPath.value));
    }
    let _tabDragPath = null;
    const tabDropTarget = ref('');
    function onTabDragStart(e, path) {
        _tabDragPath = path;
        try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/x-elpis-tab', path);
        } catch (_) {}
    }
    function onTabDragOver(e, path) {
        if (!_tabDragPath) return;
        e.preventDefault();
        tabDropTarget.value = path;
    }
    function onTabDragEnd() { _tabDragPath = null; tabDropTarget.value = ''; }
    function onTabDrop(e, path) {
        const src = _tabDragPath;
        onTabDragEnd();
        if (!src || src === path) return;
        const tabs = openTabs.value.slice();
        const from = tabs.findIndex(t => t.path === src);
        if (from < 0) return;
        const moved = tabs.splice(from, 1)[0];
        let to = tabs.findIndex(t => t.path === path);
        if (to < 0) return;
        // Déposé sur un onglet situé APRÈS sa place d'origine : il passe derrière.
        if (from <= to) to += 1;
        // PUIS on le borne à son groupe (épinglés à gauche, les autres après).
        // Dans l'ordre inverse (avant le 2026-09-21), le +1 appliqué après la
        // borne faisait passer un épinglé parmi les non épinglés.
        const pinnedCount = tabs.filter(t => t.pinned).length;
        if (moved.pinned) to = Math.min(to, pinnedCount);
        else to = Math.max(to, pinnedCount);
        to = Math.min(to, tabs.length);
        tabs.splice(to, 0, moved);
        openTabs.value = tabs;
    }
    // Icône du type de fichier (même table que l'arbre).
    function tabIcon(tab) {
        try { return getFileMeta(tab.name || ''); } catch (_) { return { icon: 'ph-file', color: 'text-slate-400' }; }
    }
    // Nom d'onglet en deux parts (2026-09-20) : la TÊTE (coupée en ellipse
    // quand l'onglet atteint son plafond, cf. .elpis-editor-tab) et la QUEUE
    // gardée entière — extension + quelques caractères — pour que
    // « …_2026_09_19.py » reste distinguable de « …_2026_09_20.py ». Sous le
    // plafond, les deux parts se lisent d'un seul tenant.
    function tabLabelParts(name) {
        const s = String(name || '');
        if (s.length <= 12) return { head: s, tail: '' };
        const dot = s.lastIndexOf('.');
        const ext = (dot > 0 && s.length - dot <= 8) ? s.length - dot : 0;
        const keep = Math.min(s.length - 4, ext ? ext + 4 : 5);
        return { head: s.slice(0, s.length - keep), tail: s.slice(s.length - keep) };
    }
    // Deux onglets de même nom : on affiche le dossier parent (le plus court
    // qui les distingue) en gris à côté du nom.
    const tabHints = vue.computed(() => {
        const byName = {};
        openTabs.value.forEach(t => { (byName[t.name] = byName[t.name] || []).push(t.path); });
        const hints = {};
        Object.keys(byName).forEach(name => {
            const paths = byName[name];
            if (paths.length < 2) return;
            paths.forEach(p => {
                const dirs = p.split('/').slice(0, -1);
                let n = 1, hint = dirs.slice(-1).join('/');
                while (n < dirs.length && paths.some(q => q !== p
                        && q.split('/').slice(0, -1).slice(-n).join('/') === hint)) {
                    n++; hint = dirs.slice(-n).join('/');
                }
                hints[p] = hint || '/';
            });
        });
        return hints;
    });
    // Copie robuste : navigator.clipboard n'existe QU'en contexte sécurisé
    // (https ou localhost). L'app tourne souvent en HTTP sur IP LAN → l'API
    // clipboard est absente et la copie échouait silencieusement. Fallback
    // execCommand('copy') via un textarea hors-écran (même pattern que
    // chat/_rendering.js). Renvoie true si la copie a réussi.
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
    function copyTabPath(path) {
        closeTabCtxMenu();
        if (!path) return;
        const ok   = () => showToast('Chemin copié : ' + path);
        const fail = () => { if (_copyTextFallback(path)) ok(); else showToast('Copie impossible', 'error'); };
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(path).then(ok).catch(fail);
        } else {
            fail();
        }
    }
    // ---- Reopen last closed (Ctrl+Shift+T) -----------------------
    // Hook dans closeTab : push le path fermé sur la pile AVANT de
    // détruire le model. Pour cela, on observe le array openTabs et
    // détecte les suppressions — mais c'est fragile. À la place, on
    // wrappe closeTab pour pousser sur la pile.
    //
    // Implementation note : closeTab() est déjà défini plus bas dans
    // le module. On ne le re-déclare pas. Au lieu de ça, on intercepte
    // via un watcher sur openTabs : si un path disparaît de openTabs,
    // on l'ajoute à la pile.
    let _lastOpenTabPaths = [];
    watch(openTabs, (cur) => {
        const curPaths = cur.map(t => t.path);
        // Trouve les paths qui étaient là et ne le sont plus.
        for (const oldPath of _lastOpenTabPaths) {
            if (!curPaths.includes(oldPath)) {
                // Push sur la pile (LIFO, dedup) avec son nom de base
                const name = oldPath.split('/').pop();
                _closedTabsStack.push({ path: oldPath, name });
                if (_closedTabsStack.length > _MAX_CLOSED_HISTORY) {
                    _closedTabsStack.shift();
                }
            }
        }
        _lastOpenTabPaths = curPaths.slice();
    }, { deep: true });

    async function reopenLastClosed() {
        // Pop jusqu'à trouver un path qui n'est pas déjà ouvert (Au cas
        // où l'user aurait ré-ouvert manuellement entre temps).
        while (_closedTabsStack.length > 0) {
            const last = _closedTabsStack.pop();
            if (!openTabs.value.find(t => t.path === last.path)) {
                try {
                    await openFile(last.path, false);
                    return;
                } catch (_) {
                    // file vanished — try the next one
                }
            }
        }
        showToast('Aucun onglet à ré-ouvrir');
    }

    // ── POURQUOI CES HANDLERS SONT EN CAPTURE (2026-08-30) ──────────────
    // Monaco appelle stopPropagation() sur les keydown qu'il reconnaît (toute
    // touche liée à une de ses commandes : Ctrl+S, Ctrl+P, Ctrl+F, Ctrl+/…).
    // Un écouteur `window` en phase BUBBLE — ce qu'étaient les cinq handlers
    // ci-dessous — ne voit alors JAMAIS l'événement dès que le curseur est
    // dans l'éditeur.
    //
    // Mesuré sur les trois moteurs (focus dans la textarea Monaco, Ctrl+S) :
    //
    //     moteur     window CAPTURE   window BUBBLE   fichier sauvé
    //     chromium         1                0              NON
    //     firefox          1                0              NON
    //     webkit           1                1              oui
    //
    // D'où le symptôme « ça marche sur un navigateur mais pas sur l'autre » :
    // WebKit laisse remonter, Blink et Gecko non. Et la commande Monaco
    // `addCommand(CtrlCmd|KeyS)` ne prenait pas le relais — elle avale
    // l'événement sans exécuter son callback. Résultat : Ctrl+S ne sauvait
    // rien, sans le moindre message.
    //
    // En CAPTURE, l'événement est vu à la descente, avant que Monaco puisse
    // l'arrêter : les trois moteurs le reçoivent (colonne de gauche). Les
    // addCommand Monaco restent en place comme second chemin ; `_savingPaths`
    // dédoublonne si les deux tirent.
    //
    // ⚠ Ne pas repasser ces écouteurs en bubble « pour faire comme ailleurs ».
    // ⚠ Un handler en capture s'exécute AVANT Monaco : celui qui veut LAISSER
    //   Monaco agir (Ctrl+/ = commenter la ligne) doit sortir sans
    //   preventDefault — c'est ce que fait la garde `.monaco-editor` plus bas.

    // Global Ctrl+Shift+T listener
    window.addEventListener('keydown', (e) => {
        if (!settings.value || !settings.value.enable_editor) return;
        const isCtrlShiftT = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'T' || e.key === 't');
        if (!isCtrlShiftT) return;
        // Hijack le Ctrl+Shift+T navigateur (réouvre l'onglet du navigateur)
        // au profit de notre raccourci éditeur. Acceptable : on est dans
        // un contexte d'éditeur où l'attente utilisateur est "ré-ouvrir
        // mon dernier fichier", pas un onglet navigateur.
        e.preventDefault();
        reopenLastClosed();
    }, true);          // CAPTURE — cf. bandeau ci-dessus

    // Global Ctrl+S / Cmd+S — filet de sécurité quand Monaco n'a PAS le focus
    // (curseur dans le terminal intégré, l'arbre de fichiers, un panneau…).
    // Les addCommand Monaco (instances principale / split / diff) ne tirent
    // QUE si l'éditeur a le focus DOM ; hors-focus, un Ctrl+S filait au
    // navigateur (« Enregistrer la page ») et l'onglet restait « dirty ».
    // ``_savingPaths`` dédoublonne si la commande Monaco tire elle aussi sur
    // le même événement (focus éditeur) → un seul save réel part.
    window.addEventListener('keydown', (e) => {
        if (!settings.value || !settings.value.enable_editor || !showEditor.value) return;
        const isCtrlS = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
                        && (e.key === 's' || e.key === 'S');
        if (!isCtrlS) return;
        e.preventDefault();
        // Sauve le panneau actif : le pane droit (split) sauve son propre
        // fichier, sinon l'onglet courant. Symétrique des addCommand Monaco.
        if (activePane.value === 'right' && splitTabPath.value) {
            saveEditorContent({ path: splitTabPath.value });
        } else {
            saveEditorContent();
        }
    }, true);          // CAPTURE — cf. bandeau ci-dessus

    // ============================================================
    //  Restore tabs : déclenché la première fois que l'éditeur
    //  s'ouvre pour un utilisateur donné dans cette session
    //  navigateur. Scoping par UID : si l'user change (logout/login
    //  d'un autre user), on restore à nouveau pour le nouveau UID.
    // ============================================================
    let _lastRestoredForUid = null;
    watch(() => [showEditor.value, user.value && user.value.id], async ([show, uid]) => {
        if (show && uid && uid !== _lastRestoredForUid) {
            _lastRestoredForUid = uid;
            // Laisse Vue terminer le mount avant de tirer les openFile
            await nextTick();
            await restoreTabsFromStorage();
        }
    });

    // ============================================================
    //  Liste statique groupée par catégorie. Construite à la main
    //  pour rester à jour à mesure que les raccourcis évoluent.
    //  Affichée en overlay (z-1001 pour être au-dessus de Quick Open
    //  qui est en 1000).
    // ============================================================
    const shortcutsModalVisible = ref(false);
    const shortcutGroups = [
        {
            title: 'Navigation',
            items: [
                { keys: ['Ctrl', 'P'],          desc: 'Ouvrir un fichier (récents d\'abord)' },
                { keys: ['Ctrl', 'Maj', 'F'],   desc: 'Rechercher dans les fichiers' },
                { keys: ['Alt', 'L'],           desc: 'Localiser le fichier dans l\'arbre' },
                { keys: ['Alt', '←'],           desc: 'Position précédente' },
                { keys: ['Alt', '→'],           desc: 'Position suivante' },
                { keys: ['Ctrl', 'G'],          desc: 'Aller à la ligne' },
                { keys: ['Ctrl', 'Maj', 'O'],   desc: 'Aller au symbole', note: 'dans le code' },
                { keys: ['F12'],                desc: 'Aller à la définition' },
                { keys: ['Ctrl', '/'],          desc: 'Afficher cette aide' },
            ],
        },
        {
            title: 'Édition',
            items: [
                { keys: ['Ctrl', 'S'],          desc: 'Enregistrer' },
                { keys: ['Ctrl', 'Alt', 'S'],   desc: 'Tout enregistrer' },
                { keys: ['Maj', 'Alt', 'F'],    desc: 'Formater le document' },
                { keys: ['Alt', '\\'],          desc: 'Complétion IA' },
                { keys: ['Ctrl', 'F'],          desc: 'Rechercher dans le fichier' },
                { keys: ['Ctrl', 'H'],          desc: 'Rechercher et remplacer' },
                { keys: ['Ctrl', 'D'],          desc: 'Occurrence suivante (multi-curseur)' },
                { keys: ['Alt', 'Clic'],        desc: 'Ajouter un curseur' },
                { keys: ['Ctrl', '/'],          desc: 'Commenter / décommenter', note: 'dans le code' },
            ],
        },
        {
            title: 'Affichage',
            items: [
                { keys: ['Ctrl', 'B'],          desc: 'Afficher / masquer l\'explorateur' },
                { keys: ['Ctrl', '`'],          desc: 'Terminal' },
                { keys: ['Ctrl', 'Maj', 'P'],   desc: 'Palette de commandes Monaco' },
            ],
        },
        {
            title: 'Onglets',
            items: [
                { keys: ['Alt', 'W'],           desc: 'Fermer l\'onglet' },
                { keys: ['Alt', 'PgSuiv'],      desc: 'Onglet suivant' },
                { keys: ['Alt', 'PgPréc'],      desc: 'Onglet précédent' },
                { keys: ['Ctrl', 'Maj', 'T'],   desc: 'Rouvrir le dernier onglet fermé' },
                { keys: ['Clic du milieu'],     desc: 'Fermer l\'onglet' },
                { keys: ['Glisser'],            desc: 'Réordonner' },
            ],
        },
        {
            title: 'Arbre',
            items: [
                { keys: ['↑', '↓'],             desc: 'Ligne précédente / suivante' },
                { keys: ['→', '←'],             desc: 'Ouvrir / fermer le dossier' },
                { keys: ['Ctrl', 'Clic'],       desc: 'Ajouter à la sélection' },
                { keys: ['Maj', 'Clic'],        desc: 'Sélectionner une plage' },
                { keys: ['F2'],                 desc: 'Renommer' },
                { keys: ['Suppr'],              desc: 'Supprimer' },
            ],
        },
    ];

    function openShortcutsModal()  { shortcutsModalVisible.value = true; }
    function closeShortcutsModal() { shortcutsModalVisible.value = false; }

    // Ctrl+/ — IMPORTANT : Monaco utilise aussi Ctrl+/ pour toggle
    // commentaire. On le laisse passer si l'éditeur a le focus (l'user
    // veut commenter du code), et on intercepte uniquement si le focus
    // est ailleurs. Détection : document.activeElement.
    window.addEventListener('keydown', (e) => {
        if (!settings.value || !settings.value.enable_editor) return;
        const isCtrlSlash = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === '/' || e.key === '?');
        if (!isCtrlSlash) return;
        // Si focus dans l'éditeur Monaco → laisser passer pour le
        // commentaire ligne. On détecte via la classe .monaco-editor
        // sur l'élément focus ou un ancêtre.
        const ae = document.activeElement;
        if (ae && ae.closest && ae.closest('.monaco-editor')) {
            return;  // Monaco gère
        }
        // Sinon → ouvrir la modale d'aide
        e.preventDefault();
        if (shortcutsModalVisible.value) closeShortcutsModal();
        else openShortcutsModal();
    }, true);          // CAPTURE — cf. bandeau ci-dessus

    // ============================================================
    //  Quick Open palette (Ctrl+P) — fuzzy file finder
    // ============================================================
    //  Pure-JS subsequence fuzzy matcher (no external lib). Returns
    //  a score 0..1 — higher = better. Matching characters score
    //  more when they're consecutive, at the start of a word/path
    //  segment, or in the basename. Non-matches return 0.
    // ============================================================
    const quickOpenVisible    = ref(false);
    const quickOpenQuery      = ref('');
    const quickOpenSelectedIdx = ref(0);

    function _fuzzyScore(needle, hay) {
        // Implémentation partagée (utils.js) : la console admin s'en sert
        // aussi pour sa recherche Ctrl+K.
        const m = window.elpisFuzzyMatch ? window.elpisFuzzyMatch(needle, hay) : null;
        return m ? m.score : 0;
    }

    const quickOpenResults = vue.computed(() => {
        const q = (quickOpenQuery.value || '').trim();
        // Flatten the file tree to a list of paths. ``sandboxFiles`` is
        // a nested {name, path, type, children} structure.
        const flat = [];
        const walk = (nodes) => {
            for (const n of (nodes || [])) {
                if (n.type === 'file') flat.push(n.path);
                else if (n.children) walk(n.children);
            }
        };
        walk(sandboxFiles.value);
        if (!q) {
            // Sans saisie : fichiers RÉCENTS d'abord (ceux qui existent encore),
            // puis le reste de l'arbre.
            const exists = new Set(flat);
            const rec = recentFiles.value.filter(p => exists.has(p)).slice(0, 15);
            const recSet = new Set(rec);
            return rec.concat(flat.filter(p => !recSet.has(p))).slice(0, 50);
        }
        const scored = [];
        for (const p of flat) {
            // Prioritize basename matches by weighting them.
            const base = p.split('/').pop();
            const baseScore = _fuzzyScore(q, base) * 1.5;
            const pathScore = _fuzzyScore(q, p);
            const s = Math.max(baseScore, pathScore);
            if (s > 0) scored.push({ path: p, score: s });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 50).map(x => x.path);
    });

    function openQuickOpen() {
        if (!settings.value.enable_editor) return;
        quickOpenVisible.value = true;
        quickOpenQuery.value = '';
        quickOpenSelectedIdx.value = 0;
        nextTick(() => {
            const inp = document.getElementById('elpis-quickopen-input');
            if (inp) inp.focus();
        });
    }
    function closeQuickOpen() { quickOpenVisible.value = false; }
    function quickOpenSelect(path) {
        closeQuickOpen();
        if (path) openFile(path, false);
    }
    // Fichiers récents présents dans la liste (étiquette « récent »).
    const quickOpenRecent = vue.computed(() => new Set(quickOpenQuery.value ? [] : recentFiles.value.slice(0, 15)));
    function quickOpenKeyDown(e) {
        const len = quickOpenResults.value.length;
        if (e.key === 'Escape') { e.preventDefault(); closeQuickOpen(); }
        else if (e.key === 'ArrowDown') {
            e.preventDefault();
            quickOpenSelectedIdx.value = Math.min(quickOpenSelectedIdx.value + 1, len - 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            quickOpenSelectedIdx.value = Math.max(quickOpenSelectedIdx.value - 1, 0);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const p = quickOpenResults.value[quickOpenSelectedIdx.value];
            if (p) quickOpenSelect(p);
        }
    }
    // Reset selection when query changes (results re-rank)
    watch(quickOpenQuery, () => { quickOpenSelectedIdx.value = 0; });

    // Global Ctrl+P listener — registered once, gated by enable_editor
    // and by "not typing in another input". Monaco's own Ctrl+P (open
    // command palette) is preempted because this listener runs in the
    // CAPTURE phase and calls preventDefault. That's intentional : we want
    // our file finder, not Monaco's command list.
    //   (2026-08-30 — ce commentaire disait « because we're at window-level ».
    //   C'était faux : au niveau window en BUBBLE on passe APRÈS Monaco, qui a
    //   déjà arrêté la propagation. C'est la phase de capture qui préempte,
    //   pas le niveau.)
    window.addEventListener('keydown', (e) => {
        if (!settings.value || !settings.value.enable_editor) return;
        const isCtrlP = (e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P');
        if (!isCtrlP) return;
        // Allow native Ctrl+Shift+P (Monaco command palette) to pass.
        if (e.shiftKey) return;
        e.preventDefault();
        if (quickOpenVisible.value) closeQuickOpen();
        else openQuickOpen();
    }, true);          // CAPTURE — cf. bandeau ci-dessus

    // ============================================================
    //  Ctrl+Shift+F — recherche dans les fichiers
    // ============================================================
    //  L'onglet "Search" séparé a été retiré (doublon avec
    //  la barre "Rechercher" de l'onglet Fichiers, qui a déjà un mode
    //  Contenu = recherche full-text). Le raccourci Ctrl+Shift+F bascule
    //  désormais sur l'onglet Fichiers et focus sa barre de recherche.
    //
    //  Tout l'ancien état du panel grep (searchQuery, runSandboxSearch,
    //  scheduleSearch, searchResultsByFile…) a été supprimé. Le backend
    //  POST /api/sandbox/grep n'est plus utilisé (dead code inoffensif —
    //  laissé en place pour éviter un redémarrage gunicorn).
    // ============================================================
    window.addEventListener('keydown', (e) => {
        if (!settings.value || !settings.value.enable_editor) return;
        const isCtrlShiftF = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f');
        if (!isCtrlShiftF) return;
        e.preventDefault();
        showEditor.value = true;
        showExplorer.value = true;
        explorerTab.value = 'files';
        // Le mode "Contenu" (recherche full-text) est le défaut pertinent
        // pour Ctrl+Shift+F — on le force au cas où l'utilisateur avait
        // laissé le toggle sur "Nom".
        sandboxSearchMode.value = 'content';
        nextTick(() => {
            const inp = document.getElementById('elpis-file-search-input');
            if (inp) { inp.focus(); inp.select(); }
        });
    }, true);          // CAPTURE — cf. bandeau ci-dessus

    // ============================================================
    //  Status bar — cursor pos, language, EOL, indent
    // ============================================================
    const statusCursor = ref({ line: 1, col: 1 });
    const statusLineCount = ref(0);
    function _updateStatusFromEditor() {
        // En vue scindée, la barre de statut suit le panneau FOCALISÉ.
        const ed = (splitView.value && activePane.value === 'right' && monacoRef.instance2)
            ? monacoRef.instance2 : monacoRef.instance;
        if (!ed) return;
        try {
            const pos = ed.getPosition();
            if (pos) statusCursor.value = { line: pos.lineNumber, col: pos.column };
            const model = ed.getModel();
            if (model) statusLineCount.value = model.getLineCount();
        } catch(_) {}
        _updateStatusExtras();
    }
    // Le listener onDidChangeCursorPosition est câblé UNE fois à la création
    // de l'instance, dans initMonaco() (l'ancien câblage dans ce watch ne
    // marchait jamais à la PREMIÈRE ouverture — toggleEditor pose
    // showEditor=true AVANT initMonaco, donc monacoRef.instance était null —
    // puis empilait un listener dupliqué à chaque réouverture suivante).
    // Le watch ne sert plus qu'à rafraîchir l'affichage à l'ouverture.
    watch(showEditor, (v) => {
        if (v && monacoRef.instance) {
            _updateStatusFromEditor();
        }
    });
    // Computed for the language label (derived from active file).
    const statusLanguage = vue.computed(() => {
        const p = activeTabPath.value;
        if (!p) return 'plaintext';
        try { return _getLang(p); } catch(_) { return 'plaintext'; }
    });
    // Indentation RÉELLE du fichier (détectée par Monaco), à défaut celle des
    // réglages — l'ancienne barre affichait toujours les réglages.
    const statusIndent = vue.computed(() => {
        if (statusModelIndent.value) return statusModelIndent.value;
        const s = settings.value || {};
        const useSpaces = s.editor_insert_spaces !== false;
        const sz = Math.max(1, Math.min(8, Number(s.editor_tab_size) || 4));
        return (useSpaces ? 'Espaces' : 'Tabs') + ' : ' + sz;
    });

    const isCurrentFileMd = vue.computed(() => {
        const p = (activeTabPath.value || '').toLowerCase();
        return p.endsWith('.md') || p.endsWith('.mdx') || p.endsWith('.markdown');
    });

    // Reset markdown preview when switching files
    watch(activeTabPath, () => { mdPreview.value = false; });

    // -- SVG preview (mirror of the markdown preview pattern) -----
    // Shows a rendered, sanitized SVG instead of the raw markup when
    // the active file is .svg. Uses the same sanitizer as the chat
    // (exposed as window.elpisSvg.sanitizeSvg from _rendering.js).
    const svgPreview          = ref(false);

    const isCurrentFileSvg = vue.computed(() => {
        const p = (activeTabPath.value || '').toLowerCase();
        return p.endsWith('.svg');
    });

    function toggleSvgPreview() { toggleSplitRender(); }

    // Reset SVG preview when switching files
    watch(activeTabPath, () => { svgPreview.value = false; });

    // ══════════════════════════════════════════════════════════════
    //  Terminal panel state (multi-session, VS-Code-style)
    // ══════════════════════════════════════════════════════════════
    //  We keep TWO parallel modes:
    //
    //  1. Multi-session (default when the browser + network allow WS):
    //     Each tab = one named session in the DB. Tabs are rendered via
    //     v-for on ``termSessions``; each pane attaches to its own
    //     ``[data-term-sid=<id>]`` container. Per-session xterm +
    //     WebSocket live in ``_termStatesBySid``.
    //
    //  2. Legacy single-session fallback (WS blocked by proxy/WAF):
    //     ``termMultiSession`` flips to false. One synthetic tab with
    //     sid ``_LEGACY_SID`` is shown; its xterm attaches to a
    //     dedicated legacy container and connects through the legacy
    //     /api/terminal/{input,stream,...} endpoints (SSE+POST). The
    //     tab UI hides close/rename/"+" to reflect the single-slot UX.
    //
    //  This split lets us offer VS-Code-style multi-terminal to every
    //  user whose environment supports WebSockets without breaking
    //  terminals for the ones behind restrictive proxies.
    // ══════════════════════════════════════════════════════════════

    const showTerminal         = ref(false);

    // ── Phase 2 : Sandbox container init overlay ────────────────────────
    // État du container Docker au moment d'ouvrir le terminal. Si le
    // container n'est pas running, on affiche un overlay au-dessus du
    // panel terminal avec barre de progression pendant qu'on init.
    const terminalInitOverlay = ref({
        visible: false,
        label: '',
        progress: 0,
        error: null,
    });

    // Promise mémorisée de l'init sandbox courante. Permet de partager
    // le même init entre l'auto-déclenchement à l'ouverture de l'éditeur
    // (watch showEditor) et le déclenchement explicite à l'ouverture du
    // terminal (toggleTerminal). Si l'init est déjà en cours quand le user
    // ouvre le terminal, il voit l'overlay avec la progression réelle.
    // Reset à null en cas d'échec pour permettre un retry.
    let _sandboxInitPromise = null;

    /**
     * Vérifie que le container Docker user est prêt. S'il ne l'est pas,
     * affiche l'overlay de progression et lance l'init.
     * Retourne true si le container est prêt à la fin, false sinon.
     * Idempotent : appels concurrents partagent la même promise.
     */
    async function _ensureSandboxContainerReady() {
        if (_sandboxInitPromise) return _sandboxInitPromise;

        _sandboxInitPromise = (async () => {
            // 1. Check current state — si déjà running, court-circuit
            let sbStatus;
            try {
                const r = await fetchAuth('/api/sandbox/me');
                sbStatus = r.ok ? await r.json() : null;
            } catch (_) { sbStatus = null; }

            if (sbStatus && sbStatus.container && sbStatus.container.running) {
                return true;
            }

            // 2. Show overlay + init (visible UNIQUEMENT si user ouvre
            //    le terminal pendant l'init, sinon transparent en background)
            terminalInitOverlay.value = {
                visible: true,
                label: 'Démarrage du container Docker…',
                progress: 8,
                error: null,
            };

            try {
                const r = await fetchAuth('/api/sandbox/me', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: 'docker' }),
                });
                if (!r.ok) {
                    throw new Error(await r.text() || `HTTP ${r.status}`);
                }
                const data = await r.json();

                if (data.bootstrap?.container?.running) {
                    terminalInitOverlay.value.progress = 100;
                    await new Promise(r => setTimeout(r, 300));
                    terminalInitOverlay.value.visible = false;
                    return true;
                }

                if (data.bootstrap?.container?.error) {
                    throw new Error(data.bootstrap.container.error);
                }

                // 3. Poll jusqu'à running ou timeout 60s
                terminalInitOverlay.value.label = 'Préparation de l\'image…';
                terminalInitOverlay.value.progress = 30;

                const start = Date.now();
                while (Date.now() - start < 60000) {
                    await new Promise(r => setTimeout(r, 800));
                    const r2 = await fetchAuth('/api/sandbox/me');
                    if (!r2.ok) continue;
                    const s = await r2.json();
                    if (s.container && s.container.running) {
                        terminalInitOverlay.value.label = 'Container prêt';
                        terminalInitOverlay.value.progress = 100;
                        await new Promise(r => setTimeout(r, 350));
                        terminalInitOverlay.value.visible = false;
                        return true;
                    }
                    terminalInitOverlay.value.progress = Math.min(95,
                        terminalInitOverlay.value.progress + 3);
                    if (terminalInitOverlay.value.progress > 60) {
                        terminalInitOverlay.value.label = 'Démarrage du container…';
                    }
                }
                throw new Error('Timeout init container (60s)');
            } catch (e) {
                terminalInitOverlay.value.error = e.message || String(e);
                terminalInitOverlay.value.label = 'Échec du démarrage';
                return false;
            }
        })();

        let result;
        try {
            result = await _sandboxInitPromise;
        } catch (_) {
            result = false;
        }

        // Reset si échec : permet un retry à l'ouverture du terminal.
        // Si succès, on garde la promise comme cache positif (les appels
        // suivants retourneront true immédiatement sans re-checker).
        if (!result) {
            _sandboxInitPromise = null;
        }
        return result;
    }

    function dismissTerminalInitOverlay() {
        terminalInitOverlay.value.visible = false;
        showTerminal.value = false;
        // Permet aussi un retry si l'utilisateur veut réessayer
        _sandboxInitPromise = null;
    }
    const terminalHeight       = ref(250);

    // Reactive UI state
    const termSessions     = ref([]);        // [{id, name, created_at, ...}]
    const termActiveSid    = ref(null);      // sid of the visible tab
    const termMaxSessions  = ref(4);         // from server
    const termMultiSession = ref(true);      // false once we detect WS blocked
    const termRenamingSid  = ref(null);      // sid being renamed inline
    const termRenameValue  = ref("");        // model for the inline rename input
    // État de connexion PAR onglet, pour la pastille de la barre d'onglets.
    // Le state transport (_termStatesBySid) n'est volontairement PAS réactif ;
    // ce miroir minimal l'est, pour que l'utilisateur voie enfin la différence
    // entre « shell vivant », « pas encore ouvert » et « en reconnexion » —
    // jusqu'ici les onglets étaient tous identiques, y compris ceux dont le
    // shell était mort depuis longtemps (lignes DB conservées 7 jours).
    //   'idle' (jamais monté) | 'connecting' | 'open' | 'reconnecting' | 'closed'
    const termSessionStatus = ref({});        // { [sid]: string }

    function _setTermStatus(sid, status) {
        if (!sid) return;
        if (termSessionStatus.value[sid] === status) return;
        termSessionStatus.value = Object.assign({}, termSessionStatus.value, { [sid]: status });
    }
    function _clearTermStatus(sid) {
        if (!sid || !(sid in termSessionStatus.value)) return;
        const next = Object.assign({}, termSessionStatus.value);
        delete next[sid];
        termSessionStatus.value = next;
    }

    // État de l'onglet, consommé par la pastille (classe `is-<état>`).
    // Un onglet jamais ouvert reste 'idle' : ses panes sont montés à la
    // demande, donc « pas de shell » n'est pas une erreur.
    function termSessionState(sid) {
        return termSessionStatus.value[sid] || 'idle';
    }

    const _TERM_STATE_LABELS = {
        idle:         'Pas encore ouvert — cliquez pour démarrer le shell',
        connecting:   'Connexion au shell…',
        open:         'Connecté',
        reconnecting: 'Connexion perdue — reconnexion…',
        closed:       'Déconnecté',
    };

    function termSessionTitle(sid) {
        const label = _TERM_STATE_LABELS[termSessionState(sid)] || '';
        return termMultiSession.value
            ? label + ' · double-clic pour renommer'
            : label;
    }

    // Sentinel sid for the legacy fallback tab. Never sent to the
    // server — we branch on "sid === _LEGACY_SID" in transport code.
    const _LEGACY_SID = "__legacy__";

    // Per-session xterm + transport state. NOT reactive — we mutate
    // entries in place and Vue never needs to observe them.
    // Shape: sid -> {
    //   term, fitAddon, container, resizeObserver,
    //   ws, sse, transport ('ws'|'sse'|null),
    //   inputBuffer, inputTimer, sseWatchdog,
    //   wsHeartbeat, wsReconnectTimer,
    // }
    const _termStatesBySid = new Map();


    const _TERM_WS_RECONNECT_MS = 1200;
    const _TERM_WS_HEARTBEAT_MS = 25000;
    // Fenêtre de coalescence des frappes (cf. term.onData). En WS elle ne
    // s'applique QU'APRÈS un premier envoi immédiat ; en repli POST elle
    // reste un debounce classique.
    const _TERM_INPUT_COALESCE_MS = 30;

    // Convenience accessor for the currently active session's state.
    // Used by the resize drag callbacks (below) and anywhere we need
    // the "current" term/fitAddon in a lazy, re-evaluated way.
    function _activeTermState() {
        const sid = termActiveSid.value;
        if (!sid) return null;
        return _termStatesBySid.get(sid) || null;
    }

    // -- Monaco internal state -----------------------------------
    // Plain object (not reactive) -- mutated directly.
    const monacoRef = {
        instance:      null,
        instance2:     null,  // 2e éditeur (vue scindée) — créé dans initMonaco
        diff:          null,
        initPromise:   null,  // ← MUST be reset to null in disposeAll()
        originalModel: null,
    };
    const models              = {};   // path → ITextModel
    const originalFileContent = {};   // path → string (server snapshot)
    let   editorResizeObserver = null;
    let   _layoutScheduled     = false;

    // -- Language detection + Monaco languages  (extracted)  ----
    // Pure data + helpers. See static/js/editor/_languages.js.
    // Also called on init: _registerRobotFramework() below.
    const _languages = window.setupEditorLanguages();
    const {
        LANG_MAP, FILENAME_LANG_MAP,
        _getLang,
        _registerRobotFramework,
    } = _languages;


    // -- Git (personal sandbox only)  (extracted)  -------------
    // See static/js/editor/_git.js for the full implementation.
    // Callbacks reference functions defined later in this file --
    // they're resolved at call time (closures + hoisting).
    const _git = window.setupEditorGit(vue, {
        openTabs, models,
        // FIX (P1 reload) — originalFileContent + readOnlyTabs étaient hors
        // de portée dans _git.js (const locales à setupEditor, jamais passées).
        // _gitReloadOpenTabs lisait `typeof originalFileContent` → toujours
        // 'undefined' → aucun onglet rechargé. On les expose ici.
        // FIX (P0 diff) — readOnlyTabs permet de geler l'onglet pendant
        // l'affichage du diff d'un commit (cf. gitShowFileDiff).
        originalFileContent, readOnlyTabs,
    }, ctx, {
        openFile:           (path, forceReload) => openFile(path, forceReload),
        reloadTab:          (path) => _gitReloadTab(path),
        checkDisk:          () => checkExternalModsSoon(0),
        loadSandboxFiles:   () => loadSandboxFiles(),
        _modelOk:           (path) => _modelOk(path),
        _tabIsDirty:        (path) => _tabIsDirty(path),
        showDiffForMessage: (path, before) => showDiffForMessage(path, before),
        // Ré-applique l'option readOnly de Monaco pour l'onglet ACTIF.
        // Nécessaire après readOnlyTabs.add/delete sur l'onglet courant :
        // le watcher ne surveille que les CHANGEMENTS d'activeTabPath.
        applyActiveReadOnly: () => _applyActiveReadOnly(),
        isViewerPath:        (p) => officeIsViewerPath(p),
    });
    const {
        explorerTab,
        gitRepos, gitCurrentRepo,
        gitStatus, gitBranches, gitCommitMsg, gitLoading, gitError,
        showGitCloneModal, gitCloneForm, showGitBranchMenu,
        gitCloneConnectorId, gitCloneRepos, gitCloneReposLoading,
        gitCloneReposError, gitCloneRepoFilter, gitFilteredCloneRepos,
        gitOpenCloneModal, gitLoadConnectorRepos, gitPickRepo,
        showGitRemoteModal, gitRemoteForm,
        showGitInitModal, gitInitForm, showGitMoreMenu,
        showGitRepoMenu, showExplorerMenu,
        showGitMergeModal, gitMergePreview, gitMergeBranch,
        showGitPushAuth, gitCredShowPwd,
        gitTree, gitLog, gitDiffData,
        gitCredUser, gitCredToken, gitSectionOpen,
        gitOpenTab, gitSelectRepo, gitLoadRepos, gitRefresh, gitLoadBranches,
        gitInit, gitClone,
        gitStage, gitUnstage, gitDiscard, gitCommit,
        gitPush, gitPushAfterAuth, gitPull, gitFetch,
        gitCheckout, gitCreateBranch,
        gitRebase, gitPromptMerge, gitPromptRebase, gitStash, gitSetRemote,
        gitOpenMergeModal, gitLoadMergePreview, gitExecuteMerge,
        gitMergeAbort, gitMergeResolve,
        gitLoadTree, gitLoadLog, gitOpenRepoFile,
        gitViewCommitDiff, gitShowFileDiff, gitRestoreCommit, gitRevertLast,
        gitBackgroundInit, gitResolveFile, gitSuggestCommitMessage, gitCommitSuggesting,
        _gitAutoRefresh, _gitReloadOpenTabs,
        resetOnLogout: _gitResetOnLogout,
    } = _git;

    // Nettoyage de session côté éditeur (appelé par logout via
    // ctx.resetEditorOnLogout). Le gros du teardown éditeur (dispose des
    // models Monaco, openTabs, showEditor) marche déjà via les getters ctx
    // dans logout() ; ce qui était MORT, c'est la purge de l'état git —
    // notamment les credentials préremplis dans la modale push.
    function resetOnLogout() {
        try { _gitResetOnLogout(); } catch (_) {}
        // AUDIT 2026-08-02 (M8) — détruire aussi les terminaux. Sinon, en repli
        // legacy (session unique `__legacy__`), l'utilisateur suivant récupérait
        // le scrollback (jusqu'à 5000 lignes, secrets potentiels) du sortant ;
        // et en multi-sessions, les xterm / ResizeObservers / conteneurs DOM
        // détachés fuyaient à chaque cycle logout→login (`_termStatesBySid`
        // jamais vidé). Fire-and-forget (le kill serveur est best-effort).
        try { _destroyAllTerminals(); } catch (_) {}
        _resetViewersState();
    }

    // Visualiseurs : requêtes en vol, aperçus, marques binaires, octets hex.
    // Appelé au logout ET au dispose (poste partagé : rien ne passe au
    // compte suivant).
    function _resetViewersState() {
        _officeResetAll();
        binaryPaths.value = new Set();
        officeTextFallback.value = new Set();
        _binaryRefused.clear();
        _hexSeq++;
        hexViewerData.value = null;
        hexViewerLoading.value = false;
        imageViewerPath.value = '';
    }


    // ==============================================================
    //  LAYOUT HELPERS
    // ==============================================================

    function _forceLayout() {
        if (monacoRef.instance)  monacoRef.instance.layout();
        if (monacoRef.diff)      monacoRef.diff.layout();
        if (monacoRef.instance2 && splitView.value) monacoRef.instance2.layout();
    }

    // Verrou « ouverture en cours » : neutralise le ResizeObserver et
    // robustLayout pendant l'animation d'ouverture du panneau (cf.
    // _smoothOpenLayout). Déclaré ici car robustLayout le lit.
    let _editorOpening = false;
    let _openSettleTimer = null;
    let _robustLayoutTimers = [];
    function robustLayout() {
        // Pendant la fenêtre d'ouverture du panneau (_editorOpening), on ne
        // déclenche AUCUN layout : la transition de largeur est en cours et
        // toute rafale saccaderait. _smoothOpenLayout a déjà programmé l'unique
        // layout de settle à la fin de la transition. (Hors ouverture, RAS.)
        if (_editorOpening) return;
        _forceLayout();
        // Annule les cascades précédentes (évite l'empilage si appelé
        // plusieurs fois en <600ms — typiquement openFile + switchTab
        // qui s'enchaînent ou stream qui ouvre/ferme rapidement).
        _robustLayoutTimers.forEach(id => { try { clearTimeout(id); } catch(_) {} });
        _robustLayoutTimers = [];
        // Belt-and-suspenders: re-layout at intervals covering any CSS transition
        [50, 150, 320, 600].forEach(t => {
            _robustLayoutTimers.push(setTimeout(() => {
                if (monacoRef.instance) {
                    try { monacoRef.instance.layout(); } catch(_) {}
                }
                if (monacoRef.instance2 && splitView.value) {
                    try { monacoRef.instance2.layout(); } catch(_) {}
                }
            }, t));
        });
    }

    // ==============================================================
    //  OUVERTURE FLUIDE DE L'ÉDITEUR
    //
    //  Pourquoi l'OUVERTURE saccadait et pas la FERMETURE — la VRAIE cause :
    //  un ResizeObserver (cf. initMonaco) observe le conteneur de l'éditeur
    //  et appelle `_forceLayout()` à CHAQUE redimensionnement. Or le panneau
    //  anime sa `width` 0%→ratio% (260ms, .elpis-slide-panel) : le conteneur
    //  change de largeur à CHAQUE frame → le RO refait un layout Monaco
    //  complet à chaque frame → tempête de reflows = saccade visible.
    //
    //  La FERMETURE est fluide parce que le callback du RO court-circuite
    //  quand `showEditor.value === false` (il ne layoute QUE si l'éditeur
    //  est ouvert). Monaco garde alors sa dernière mise en page et le parent
    //  flex (`overflow-hidden`, index.html:254) le rogne au fur et à mesure
    //  que le panneau rétrécit : les pixels glissent, rien ne reflue.
    //
    //  Le fix rend l'OUVERTURE symétrique : pendant la fenêtre d'ouverture
    //  on pose `_editorOpening = true`, ce qui neutralise le RO EXACTEMENT
    //  comme `showEditor=false` le neutralise à la fermeture. Monaco
    //  conserve sa dernière mise en page (à la ré-ouverture = déjà la
    //  largeur finale) et le panneau qui s'élargit ne fait que la RÉVÉLER.
    //  Un UNIQUE layout de « settle » à la fin de la transition fixe la
    //  largeur finale (utile surtout à la 1ʳᵉ ouverture, où Monaco a été
    //  créé sur un conteneur encore étroit). Aucune rafale entre-temps.
    function _smoothOpenLayout() {
        _editorOpening = true;   // neutralise le RO pendant la transition
        if (_openSettleTimer) { clearTimeout(_openSettleTimer); _openSettleTimer = null; }
        _openSettleTimer = setTimeout(() => {
            _openSettleTimer = null;
            _editorOpening = false;
            if (!showEditor.value) return;
            _forceLayout();      // un seul layout, APRÈS la transition
        }, 300);
    }

    // Watch showEditor : pilote la mise en page Monaco à l'ouverture/fermeture.
    // Ouverture = _smoothOpenLayout (verrou anti-saccade + settle unique après
    // la transition, cf. bloc ci-dessus). Fermeture = aucun layout (le RO se
    // court-circuite tout seul → fluide).
    //
    // On conserve les ids des setTimeout résiduels (filet de ré-attache du
    // modèle) pour les annuler à la prochaine fermeture : ouvrir puis fermer
    // rapidement l'éditeur laissait sinon des timers tirer sur monacoRef.instance
    // déjà disposé → exceptions silencieuses + corruption possible de l'instance
    // pour la prochaine ouverture (« écran blanc » au prochain toggleEditor).
    let _showEditorTimers = [];
    function _clearShowEditorTimers() {
        _showEditorTimers.forEach(id => { try { clearTimeout(id); } catch(_) {} });
        _showEditorTimers = [];
    }
    watch(showEditor, async (visible) => {
        // Toujours annuler les cascades précédentes — on enchaîne ouverture
        // → fermeture → ouverture rapide sans laisser de timers fantômes.
        _clearShowEditorTimers();
        if (!visible) {
            // Fermeture : on lève le verrou d'ouverture (au cas où on ferme
            // pendant l'animation d'ouverture) et on annule le settle en
            // attente — sinon il rappellerait _forceLayout après coup.
            _editorOpening = false;
            if (_openSettleTimer) { clearTimeout(_openSettleTimer); _openSettleTimer = null; }
            // Avant de fermer : capture le viewState de l'onglet actif.
            // Sans ça, la ré-ouverture perdrait le scroll — même si c'est
            // le même onglet qu'avant.
            _saveCurrentViewState();
            // If the typewriter was running when the editor was closed,
            // the model may have been partially cleared (setValue('') was called
            // before writing started). Mark this path so toggleEditor() reloads
            // from the server on the next open instead of showing an empty model.
            if (isTypingEffect.value && activeTabPath.value) {
                _pathsNeedingReload.add(activeTabPath.value);
            }
            return;
        }

        // ── Init sandbox Docker en background à l'ouverture de l'éditeur ──
        // Le container est nécessaire pour le terminal éditeur (docker exec)
        // et pour les MCPs locaux. On le lance en fire-and-forget : si user
        // ouvre le terminal pendant que ça init, l'overlay s'affichera avec
        // la progression réelle. Si l'init est déjà finie quand il l'ouvre,
        // ouverture instantanée. La promise est mémorisée → un seul init
        // simultané même si watch se redéclenche.
        _ensureSandboxContainerReady().catch(e =>
            console.warn('[editor] sandbox init au mount:', e));

        await nextTick();
        // Ouverture FLUIDE : un seul layout à la taille finale + un settle
        // après la transition. PAS de reset width:0 (re-mesure forcée)
        // ni de rafale 330/660ms : c'est ce qui faisait saccader l'ouverture.
        // (cf. _smoothOpenLayout). Sur la 1ʳᵉ ouverture, monacoRef.instance
        // n'existe pas encore ici — toggleEditor() rappelle _smoothOpenLayout
        // après initMonaco().
        _smoothOpenLayout();
        // Filet de sécurité (1 seule passe, sans layout en rafale) : si Monaco
        // a perdu son modèle, on le ré-attache après la transition.
        _showEditorTimers.push(setTimeout(() => {
            if (!showEditor.value) return;  // user a fermé entre-temps
            // Re-attach current model if Monaco lost it
            if (monacoRef.instance && activeTabPath.value) {
                const m = models[activeTabPath.value];
                if (_modelOk(activeTabPath.value)) {
                    try {
                        if (monacoRef.instance.getModel() !== m) {
                            monacoRef.instance.setModel(m);
                            // Re-attacher un modèle = re-perdre scroll/cursor.
                            // On restaure depuis le cache si on en a un —
                            // typiquement mis en cache par switchTab quand
                            // l'user a quitté l'onglet puis fermé l'éditeur.
                            _restoreViewStateFor(activeTabPath.value);
                            _forceLayout();
                        }
                    } catch(_) {}
                }
            }
        }, 330));
    });

    // ==============================================================
    //  MODEL SAFETY HELPERS
    // ==============================================================

    function _modelOk(path) {
        return !!(models[path] && !models[path].isDisposed());
    }

    function _dropModel(path) {
        const m = models[path];
        if (!m) return;
        try {
            if (monacoRef.instance && monacoRef.instance.getModel() === m) {
                monacoRef.instance.setModel(null);
            }
            if (monacoRef.diff) {
                const dm = monacoRef.diff.getModel();
                if (dm && (dm.original === m || dm.modified === m)) {
                    monacoRef.diff.setModel(null);
                }
            }
            if (monacoRef.instance2 && monacoRef.instance2.getModel() === m) {
                monacoRef.instance2.setModel(null);
            }
            if (!m.isDisposed()) m.dispose();
        } catch(_) {}
        delete models[path];
    }

    /**
     * Migrate a Monaco model from oldPath to newPath.
     * Preserves content, cursor position and scroll state.
     */
    function _migrateModel(oldPath, newPath) {
        if (!_modelOk(oldPath)) return;
        const oldModel = models[oldPath];
        const content = oldModel.getValue();
        // Save view state if this model is active
        let viewState = null;
        const isActive = monacoRef.instance && monacoRef.instance.getModel() === oldModel;
        if (isActive) {
            try { viewState = monacoRef.instance.saveViewState(); } catch(_) {}
        }
        // Drop old, create new
        _dropModel(oldPath);
        const newModel = _ensureModel(newPath, content, _getLang(newPath));
        // Transfère le viewState en cache (rename d'un onglet non-actif :
        // on ne veut pas perdre le scroll de l'ancien onglet). `typeof`
        // guard : fonction appelée potentiellement avant que le `const`
        // _tabViewStates soit déclaré plus bas (en pratique c'est toujours
        // après, mais ceinture + bretelles).
        if (typeof _tabViewStates !== 'undefined') {
            if (_tabViewStates[oldPath]) {
                _tabViewStates[newPath] = _tabViewStates[oldPath];
                delete _tabViewStates[oldPath];
            }
        }
        // Restore editor state if it was active
        if (isActive && monacoRef.instance) {
            try {
                monacoRef.instance.setModel(newModel);
                if (viewState) monacoRef.instance.restoreViewState(viewState);
            } catch(_) {}
        }
    }

    /**
     * Safely get or (re)create a Monaco text model.
     * Handles:
     *  - disposed models
     *  - URI collisions (Monaco caches models by URI globally)
     *  - language re-detection
     *  - paths starting with `/` or containing `//` (was throwing UriError)
     */
    function _ensureModel(path, content, lang) {
        // Drop if disposed
        if (models[path] && models[path].isDisposed()) {
            delete models[path];
        }
        if (models[path]) return models[path];

        // `monaco.Uri.parse('file:///' + path)` plante
        // avec [UriError] dès que `path` commence par `/` (ex `/foo.py`) ou
        // contient `//` quelque part. Le LLM peut générer des paths absolus
        // dans ses tool_calls, et la concat de chemins (sandbox + sub) peut
        // produire des `//`. Cette exception remontait jusqu'à
        // streamOpenForWrite qui n'avait pas de try/catch → "Uncaught (in
        // promise)" sur chaque tool_call_delta, en boucle.
        //
        // Solution : (1) normaliser les slashes du path,
        //            (2) garder `monaco.Uri.parse('file://' + cleanPath)`
        //                pour produire LA MÊME URI string que l'ancien
        //                code (`file:///<path>`). Tout autre code qui
        //                aurait pré-créé un modèle avec l'ancien Uri.parse
        //                continuera à être trouvé via getModel().
        //            (3) try/catch en garde-fou ultime → si Monaco refuse
        //                quand même (caractères exotiques) on tombe sur une
        //                URI inmemory unique pour ne pas bloquer le stream.
        //
        // RÉGRESSION CORRIGÉE — la version précédente utilisait `Uri.file()`
        // qui PEUT produire une instance Uri différente de celle créée par
        // `Uri.parse()` même si la URI string finale est identique. Monaco
        // garde son map interne des models keyed sur l'instance Uri (pas
        // toujours la string), donc `getModel(uri_via_file)` ne retrouvait
        // pas un modèle créé via `uri_via_parse`. Conséquence pour
        // edit_file : `_ensureModel` ne retrouvait pas le modèle pré-ouvert
        // → créait un modèle vide → `streamLocateEdit` voyait preSnapshot=''
        // → return false → fallback sur `streamOpenForWrite` qui efface
        // tout et réécrit. Symptôme user : "le code apparaît APRÈS la modif
        // au lieu d'avant avec vue sur la modif et la réécriture".
        //
        // Important : la CLÉ `models[path]` reste le `path` reçu (non
        // normalisé) pour préserver la transparence vis-à-vis des callers
        // — switchTab, openFile, _writeStreams, originalFileContent
        // utilisent tous le path tel qu'envoyé par le serveur ou le LLM.
        const _cleanPath = '/' + String(path).replace(/^\/+/, '').replace(/\/{2,}/g, '/');
        // Le scheme `personal://` date du namespacing par contexte de la
        // feature Équipes (retirée 2026-06) — conservé pour ne pas
        // invalider les URIs des modèles existants.
        const _uriScheme = 'personal://';
        let fileUri;
        try {
            // ex. 'personal:///foo.py' ou 'team-42:///foo.py' (3 slashes, comme
            // l'ancien 'file://' + '/foo.py' = 'file:///foo.py').
            fileUri = monaco.Uri.parse(_uriScheme + _cleanPath);
        } catch (_) {
            // Garde-fou : si Uri.parse échoue (caractères de contrôle dans
            // le path, path vide après normalisation), on génère une URI
            // inmemory unique. Le model sera quand même créé et affiché —
            // l'éditeur reste fonctionnel pour ce fichier, juste sans
            // persistance d'URI entre les sessions Monaco.
            try {
                fileUri = monaco.Uri.parse('inmemory://model/' +
                    Date.now() + '-' +
                    Math.random().toString(36).slice(2, 10));
            } catch (__) {
                // Si même ça échoue, on bail out proprement.
                return null;
            }
        }

        // Monaco may already have a model at this URI from a previous session
        let existing = null;
        try { existing = monaco.editor.getModel(fileUri); } catch(_) {}
        if (existing) {
            if (existing.isDisposed()) {
                // Edge case: Monaco returned a disposed model -- recreate
                existing = null;
            } else {
                // Modèle déjà tenu par une AUTRE clé (même fichier sous une
                // autre graphie) : on le partage tel quel — jamais de
                // ``setValue`` qui écraserait ses modifications et son Ctrl+Z
                // (E13). Seul un modèle orphelin est réaligné.
                const _owned = Object.keys(models).some(k => k !== path && models[k] === existing);
                if (!_owned && typeof content === 'string' && existing.getValue() !== content) {
                    try { existing.setValue(content); } catch(_) {}
                }
                models[path] = existing;
                return existing;
            }
        }
        let model = null;
        try {
            model = monaco.editor.createModel(
                typeof content === 'string' ? content : '',
                lang || _getLang(path),
                fileUri
            );
        } catch (_) {
            // Dernière chance : créer un modèle SANS URI (Monaco le fera
            // tourner avec une URI auto-générée). Pas idéal mais évite
            // de retourner null aux callers qui ne checkent pas toujours.
            try {
                model = monaco.editor.createModel(
                    typeof content === 'string' ? content : '',
                    lang || _getLang(path)
                );
            } catch (__) { return null; }
        }
        if (model) models[path] = model;
        return model;
    }

    // Robot Framework Monarch tokenizer  → static/js/editor/_languages.js
    // (_registerRobotFramework is already destructured above and is
    //  called from initMonaco(); nothing else needs to change.)


    // ==============================================================
    //  MONACO INIT / DISPOSE
    // ==============================================================

    function initMonaco() {
        // Guard 1: already running
        if (monacoRef.instance) return Promise.resolve();
        // Guard 2: already initialising -- return the in-flight promise
        if (monacoRef.initPromise) return monacoRef.initPromise;
        // Guard 3: AMD loader not available.
        //
        // Le loader n'est plus posé en dur dans la page : monaco pèse 13 Mo et
        // ne sert que si l'éditeur s'ouvre. On le demande ici — c'est le seul
        // point d'entrée. ``ensureVendor`` est idempotent et mémoïsé, donc
        // deux ouvertures rapprochées ne téléchargent qu'une fois.
        if (typeof require === 'undefined') {
            if (!window.ensureVendor) return Promise.resolve();
            monacoRef.initPromise = window.ensureVendor('monaco')
                .then(() => { monacoRef.initPromise = null; return initMonaco(); })
                .catch(() => { monacoRef.initPromise = null; });
            return monacoRef.initPromise;
        }

        monacoRef.initPromise = new Promise((resolve) => {
            require.config({ paths: { 'vs': 'static/vendor/monaco/vs' } });
            require(['vs/editor/editor.main'], function() {
                const el = document.getElementById('monaco-editor');
                if (!el) { resolve(); return; }

                // Register custom languages before creating the editor
                _registerRobotFramework();

                // Resolve theme from user settings — default to dark for
                // backward compat (the editor has always shipped dark).
                // Light theme = 'vs' is Monaco's built-in white theme,
                // visually consistent with the rest of the app.
                const _resolveEditorTheme = () => {
                    const dark = (settings.value && settings.value.editor_dark_mode !== false);
                    return dark ? 'vs-dark' : 'vs';
                };

                // Resolve user prefs (font, tabs, wrap, minimap, line
                // numbers) from settings.value with sane fallbacks. Called
                // at creation AND from the watcher when settings change.
                const _resolveEditorPrefs = () => {
                    const s = settings.value || {};
                    return {
                        fontSize:    Math.max(8, Math.min(32, Number(s.editor_font_size) || 14)),
                        fontFamily:  String(s.editor_font_family || 'JetBrains Mono'),
                        tabSize:     Math.max(1, Math.min(8, Number(s.editor_tab_size) || 4)),
                        insertSpaces: s.editor_insert_spaces !== false,
                        wordWrap:    ['off','on','bounded'].includes(s.editor_word_wrap) ? s.editor_word_wrap : 'off',
                        minimap:     !!s.editor_minimap,
                        lineNumbers: (s.editor_line_numbers === false) ? 'off' : 'on',
                    };
                };
                const _prefs = _resolveEditorPrefs();

                // Main editor
                monacoRef.instance = monaco.editor.create(el, {
                    value: '',
                    language:             'plaintext',
                    theme:                _resolveEditorTheme(),
                    automaticLayout:      false,   // we manage layout manually
                    minimap:              { enabled: _prefs.minimap },
                    glyphMargin:          true,    // needed for comment decorations
                    fontSize:             _prefs.fontSize,
                    fontFamily:           _prefs.fontFamily + ', "Fira Code", "Cascadia Code", Consolas, monospace',
                    lineHeight:           22,
                    lineNumbers:          _prefs.lineNumbers,
                    tabSize:              _prefs.tabSize,
                    insertSpaces:         _prefs.insertSpaces,
                    wordWrap:             _prefs.wordWrap,
                    scrollBeyondLastLine: false,
                    smoothScrolling:      true,
                    cursorBlinking:       'smooth',
                    cursorSmoothCaretAnimation: 'on',
                    padding:              { top: 12, bottom: 12 },
                    renderWhitespace:     'selection',
                    bracketPairColorization: { enabled: true },
                    'semanticHighlighting.enabled': true,
                    suggest:              { showWords: false },
                    contextmenu:          false,   // we provide our own right-click menu
                    // Sticky scroll : le header de la fonction/classe en cours
                    // reste collé en haut quand on scrolle. Très utile sur les
                    // gros fichiers — l'utilisateur garde toujours le contexte
                    // (signature de la fonction, def de la classe) visible.
                    // Activé par défaut, profondeur 5 (Monaco accepte 1-10).
                    stickyScroll:         { enabled: true, maxLineCount: 5 },
                });

                // Status bar : câblé ICI (une fois par instance) et pas dans
                // le watch(showEditor) — le watcher s'exécutait avant
                // initMonaco à la première ouverture (instance null → status
                // figé sur « Ln 1, Col 1 ») puis dupliquait le listener à
                // chaque réouverture. initMonaco re-crée l'instance après
                // disposeAll (logout), donc le câblage survit au cycle.
                monacoRef.instance.onDidChangeCursorPosition(_updateStatusFromEditor);

                monacoRef.instance.onDidChangeModelContent(() => {
                    // (passe 9, F6) — « ce fichier est-il streamé ? », pas le booléen global.
                    if (!isStreamActive(activeTabPath.value)) {
                        isEditorDirty.value = true;
                        // Auto-save : programme une sauvegarde après le
                        // délai configuré. Chaque keystroke reset le timer
                        // (debounce). Si la pref est 'off' ou 'on_blur',
                        // la fonction no-op.
                        _scheduleAutoSave();
                        // Aperçu live (vue scindée code|rendu) : enregistre puis
                        // recharge l'iframe après une pause dans la frappe.
                        // No-op si le mode live est off.
                        _schedulePreviewLive();
                        // Point « non sauvegardé » de l'onglet (appel explicite :
                        // isEditorDirty reste true pendant la frappe, son watcher
                        // ne re-tire pas — l'undo vers l'origine doit effacer).
                        _scheduleDirtyRefresh();
                    }
                    // Lint PENDANT la frappe (Python), marge Git, aperçu à
                    // côté : tous débouncés, le contenu est lu au déclenchement.
                    const _p = activeTabPath.value;
                    if (_p && /\.pyi?$/i.test(_p)) scheduleLint(_p);
                    if (_p) _scheduleScmRefresh(_p);
                    _scheduleRenderPane();
                });
                monacoRef.instance.onDidChangeCursorSelection(_updateStatusExtras);
                monacoRef.instance.onDidChangeModel(() => { _updateStatusExtras(); _refreshProblems(); });
                monacoRef.instance.onDidChangeModelOptions(_updateStatusExtras);
                // Complétion IA au clavier (Alt+\) — auparavant clic droit seul.
                monacoRef.instance.addCommand(
                    monaco.KeyMod.Alt | monaco.KeyCode.Backslash,
                    () => editorCtxComplete()
                );
                // Une seule fois par page (Monaco est global) : formateur Python
                // (ruff format, serveur) et suivi des marqueurs (problèmes).
                if (!window.__elpisEditorGlobalsRegistered) {
                    window.__elpisEditorGlobalsRegistered = true;
                    try {
                        monaco.languages.registerDocumentFormattingEditProvider('python', {
                            provideDocumentFormattingEdits: (model) => _formatPython(model),
                        });
                    } catch (_) {}
                    try { monaco.editor.onDidChangeMarkers(() => _refreshProblems()); } catch (_) {}
                }
                // Auto-save on_blur : quand l'éditeur perd le focus
                // (clic ailleurs, alt-tab, etc.), on flush si dirty.
                monacoRef.instance.onDidBlurEditorText(() => {
                    // Garde par ONGLET (E12) : le drapeau global pouvait être
                    // faux après un enregistrement pendant lequel on avait tapé.
                    const _p = activeTabPath.value;
                    if ((settings.value && settings.value.editor_auto_save) === 'on_blur'
                        && _p && _tabIsDirty(_p)) {
                        saveEditorContent({ silent: true, path: _p });
                    }
                });
                monacoRef.instance.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                    () => saveEditorContent()
                );

                // Right-click → custom context menu (replaces @ FIM picker)
                monacoRef.instance.onContextMenu((e) => {
                    e.event.preventDefault();
                    e.event.stopPropagation();
                    _openEditorCtxMenu(e.event.browserEvent);
                });

                // Diff editor
                const diffEl = document.getElementById('monaco-diff-editor');
                if (diffEl) {
                    monacoRef.diff = monaco.editor.createDiffEditor(diffEl, {
                        theme:             _resolveEditorTheme(),
                        automaticLayout:   false,
                        originalEditable:  false,
                        readOnly:          false,
                        renderSideBySide:  true,
                    });
                    monacoRef.originalModel = monaco.editor.createModel('', 'plaintext');
                    monacoRef.diff.getModifiedEditor().addCommand(
                        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                        () => saveEditorContent()
                    );
                }

                // Focus sur l'éditeur principal → panneau gauche actif.
                monacoRef.instance.onDidFocusEditorText(() => { activePane.value = 'left'; });

                // ── 2e éditeur : vue scindée (split view) ──
                // Créé caché (le conteneur est en v-show) avec les MÊMES options
                // que l'instance principale ; le thème Monaco est global donc
                // partagé. Affiché via enterSplit() puis layout(). Chaque panneau
                // édite/sauvegarde son propre fichier indépendamment.
                const el2 = document.getElementById('monaco-editor-2');
                if (el2) {
                    monacoRef.instance2 = monaco.editor.create(el2, {
                        value: '', language: 'plaintext',
                        theme:                _resolveEditorTheme(),
                        automaticLayout:      false,
                        minimap:              { enabled: _prefs.minimap },
                        glyphMargin:          true,
                        fontSize:             _prefs.fontSize,
                        fontFamily:           _prefs.fontFamily + ', "Fira Code", "Cascadia Code", Consolas, monospace',
                        lineHeight:           22,
                        lineNumbers:          _prefs.lineNumbers,
                        tabSize:              _prefs.tabSize,
                        insertSpaces:         _prefs.insertSpaces,
                        wordWrap:             _prefs.wordWrap,
                        scrollBeyondLastLine: false,
                        smoothScrolling:      true,
                        padding:              { top: 12, bottom: 12 },
                        bracketPairColorization: { enabled: true },
                        contextmenu:          false,
                        stickyScroll:         { enabled: true, maxLineCount: 5 },
                    });
                    monacoRef.instance2.onDidFocusEditorText(() => { activePane.value = 'right'; });
                    monacoRef.instance2.onDidChangeCursorPosition(_updateStatusFromEditor);
                    monacoRef.instance2.onDidChangeModelContent(() => {
                        // Garde PAR FICHIER (E23) : le drapeau global bloquait la
                        // frappe à droite pendant N'IMPORTE QUEL stream.
                        const _sp = splitTabPath.value;
                        if (_sp && !isStreamActive(_sp)) {
                            if (_sp === activeTabPath.value) isEditorDirty.value = true;
                            _scheduleAutoSaveRight(); _scheduleDirtyRefresh();
                        }
                    });
                    monacoRef.instance2.onDidBlurEditorText(() => {
                        if ((settings.value && settings.value.editor_auto_save) === 'on_blur'
                            && splitTabPath.value && _tabIsDirty(splitTabPath.value)) {
                            saveEditorContent({ silent: true, path: splitTabPath.value });
                        }
                    });
                    monacoRef.instance2.addCommand(
                        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                        () => { if (splitTabPath.value) saveEditorContent({ path: splitTabPath.value }); }
                    );
                    monacoRef.instance2.onContextMenu((e) => {
                        e.event.preventDefault();
                        e.event.stopPropagation();
                    });
                }

                // ResizeObserver on the container (single registration)
                const container = el.parentElement;
                if (window.ResizeObserver && container && !editorResizeObserver) {
                    editorResizeObserver = new ResizeObserver(() => {
                        // `_editorOpening` : pendant l'animation d'ouverture du
                        // panneau, on NE re-layoute PAS à chaque frame (sinon
                        // tempête de reflows = saccade). Symétrique du court-
                        // circuit `showEditor=false` qui rend la fermeture fluide.
                        if (showEditor.value && settings.value.enable_editor && !_editorOpening && !_layoutScheduled) {
                            _layoutScheduled = true;
                            window.requestAnimationFrame(() => {
                                _layoutScheduled = false;
                                _forceLayout();
                            });
                        }
                    });
                    editorResizeObserver.observe(container);
                }

                // ré-attacher le listener Esc s'il a été
                // détaché par un disposeAll précédent (logout/login cycle).
                _bindFullscreenEsc();

                resolve();
                // Tampons mis de côté à la fin de la session précédente (E2).
                setTimeout(() => { _maybeRestoreRescued(); }, 0);
            });
        });
        return monacoRef.initPromise;
    }

    // ── Tampons non enregistrés : jamais perdus (audit éditeur 2026-09-23, E2)
    // Toute désauthentification (401 d'un sondage de fond, expiration,
    // déconnexion) et la désactivation de l'éditeur détruisaient les modèles
    // Monaco — et avec eux le travail non enregistré. Avant la purge, les
    // onglets modifiés sont copiés dans le navigateur (clé PAR COMPTE), avec la
    // base disque sur laquelle ils reposent ; à la prochaine ouverture de
    // l'éditeur par ce compte, on propose de les restaurer. Enregistrer passe
    // alors par la précondition habituelle : si le disque a bougé entre-temps,
    // c'est un conflit (Comparer / Recharger / Écraser), jamais un écrasement.
    const _RESCUE_PREFIX = 'elpis.editor.rescue.';
    const _RESCUE_MAX_CHARS = 3 * 1024 * 1024;
    let _rescueOwner = null;
    let _rescueChecked = false;
    watch(() => user.value && user.value.username, (u) => {
        if (u) { _rescueOwner = u; _rescueChecked = false; }
    }, { immediate: true });

    function rescueDirtyBuffers() {
        const owner = _rescueOwner;
        if (!owner) return 0;
        const items = [];
        let total = 0;
        for (const t of openTabs.value) {
            const p = t.path;
            if (!_modelOk(p) || _isReadOnlyTab(p) || !_tabIsDirty(p)) continue;
            const content = models[p].getValue();
            if (total + content.length > _RESCUE_MAX_CHARS) continue;
            total += content.length;
            items.push({ path: p, content, sha: fileShas[p] || null,
                         mtime: typeof fileMtimes.value[p] === 'number' ? fileMtimes.value[p] : null,
                         bom: !!(fileFormats[p] && fileFormats[p].bom), ts: Date.now() });
        }
        if (!items.length) return 0;
        try {
            const key = _RESCUE_PREFIX + owner;
            const prev = JSON.parse(localStorage.getItem(key) || '[]');
            const merged = (Array.isArray(prev) ? prev : []).filter(x => !items.some(i => i.path === x.path));
            localStorage.setItem(key, JSON.stringify(merged.concat(items)));
            _rescueChecked = false;
            return items.length;
        } catch (_) { return 0; }
    }

    async function _maybeRestoreRescued() {
        if (_rescueChecked || !_rescueOwner || !user.value) return;
        _rescueChecked = true;
        const key = _RESCUE_PREFIX + _rescueOwner;
        let items = [];
        try { items = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) { items = []; }
        if (!Array.isArray(items) || !items.length) return;
        const ok = await openConfirm('Modifications non enregistrées',
            items.length + ' fichier(s) n\'étaient pas enregistrés quand la session s\'est fermée : '
            + items.map(i => i.path.split('/').pop()).join(', ') + '. Les restaurer ?',
            false, 'Restaurer');
        try { localStorage.removeItem(key); } catch (_) {}
        if (!ok) return;
        let n = 0;
        for (const it of items) {
            if (!it || typeof it.path !== 'string' || typeof it.content !== 'string') continue;
            try { await openFile(it.path, true, { quiet: true }); } catch (_) { continue; }
            if (!_modelOk(it.path)) continue;
            const m = models[it.path];
            if (m.getValue() !== it.content) _applyMinimalLineEdit(m, m.getValue(), it.content);
            // Base = la version disque sur laquelle ces modifications reposent.
            _setBase(it.path, it.mtime, it.sha);
            if (fileFormats[it.path]) fileFormats[it.path].bom = !!it.bom;
            n++;
        }
        _scheduleDirtyRefresh();
        if (activeTabPath.value) isEditorDirty.value = _tabIsDirty(activeTabPath.value);
        if (n) showToast(n + ' fichier(s) restauré(s) — non enregistrés');
    }

    async function disposeAll() {
        await _destroyTerminal();
        showTerminal.value = false;
        _resetViewersState();
        editorFullscreen.value = false;
        // Reset de la vue scindée (l'instance2 est disposée plus bas).
        splitView.value = false;
        splitTabPath.value = null;
        activePane.value = 'left';
        if (editorResizeObserver) {
            editorResizeObserver.disconnect();
            editorResizeObserver = null;
        }

        // purger _writeStreams. Sans ça, des entrées zombies
        // (state.active=true, _scrollDisp non disposé) survivent à un
        // logout/login → fuite de listener Monaco onDidScrollChange et
        // comportement erratique du prochain stream sur le même path
        // (le streamFinalize précédent n'a jamais clos l'état).
        for (const p of Object.keys(_writeStreams)) {
            const st = _writeStreams[p];
            if (st && st._scrollDisp) {
                try { st._scrollDisp.dispose(); } catch(_) {}
                st._scrollDisp = null;
            }
            if (st) st.active = false;
            delete _writeStreams[p];
        }

        // garantir reset de isTypingEffect. Si un stream a
        // été interrompu en plein vol (exception, deadline streamFinalize,
        // disposition du modèle), isTypingEffect.value pouvait rester à
        // true → _saveCurrentViewState early-return permanent, openFile ne
        // recharge plus, saveEditorContent bloqué. Symptôme : "obligé de
        // rafraîchir l'app". On force le reset ici en garde-fou ultime.
        isTypingEffect.value = false;
        isEditorDirty.value  = false;

        Object.keys(models).forEach(p => _dropModel(p));

        if (monacoRef.originalModel && !monacoRef.originalModel.isDisposed()) {
            monacoRef.originalModel.dispose();
        }
        if (monacoRef.instance) {
            try { monacoRef.instance.dispose(); } catch(_) {}
            monacoRef.instance = null;
        }
        if (monacoRef.instance2) {
            try { monacoRef.instance2.dispose(); } catch(_) {}
            monacoRef.instance2 = null;
        }
        if (monacoRef.diff) {
            try { monacoRef.diff.dispose(); } catch(_) {}
            monacoRef.diff = null;
        }

        // *** CRITICAL FIX: reset initPromise so next initMonaco() re-creates ***
        monacoRef.initPromise   = null;
        monacoRef.originalModel = null;

        _pathsNeedingReload.clear();
        Object.keys(originalFileContent).forEach(k => delete originalFileContent[k]);
        // Purger le cache viewState : tous les modèles ont été disposés,
        // les viewStates pointent dans le vide.
        if (typeof _tabViewStates !== 'undefined') {
            for (var k in _tabViewStates) delete _tabViewStates[k];
        }

        // annuler le lint timer pendant. Sinon il peut tirer
        // sur un modèle déjà disposé après logout (le check models[path]
        // protège, mais on évite le bruit + on libère la closure).
        if (_lintTimer) { clearTimeout(_lintTimer); _lintTimer = null; }

        // arrêter les intervals mtime/quota au teardown.
        // Sans ça, après un logout ils continuaient à tourner
        // indéfiniment : `_mtimeCheckTimer` faisait un appel API
        // authentifié (`_checkExternalMods`) toutes les 30 s sur l'écran
        // de login. De plus le latch `_mtimeStarted` n'était jamais
        // remis à false → au re-login les intervals n'étaient pas
        // relancés (le watcher sur showEditor restait inerte). On stoppe
        // ici et on remet le latch à zéro pour un redémarrage propre.
        _stopMtimeChecks();
        if (_quotaPollTimer) { clearInterval(_quotaPollTimer); _quotaPollTimer = null; }
        _mtimeStarted = false;

        // Annuler les cascades de layout (showEditor/robustLayout) + le verrou
        // d'ouverture et son settle (sinon _forceLayout post-dispose).
        _clearShowEditorTimers();
        _editorOpening = false;
        if (_openSettleTimer) { clearTimeout(_openSettleTimer); _openSettleTimer = null; }
        _robustLayoutTimers.forEach(id => { try { clearTimeout(id); } catch(_) {} });
        _robustLayoutTimers = [];
        // Annuler la boucle rAF du fullscreen-transition.
        if (_relayoutRafId != null) {
            try { cancelAnimationFrame(_relayoutRafId); } catch(_) {}
            _relayoutRafId = null;
        }

        // Remove global event listeners
        document.removeEventListener('keydown', _handleFullscreenEsc);
        // re-attacher le listener fullscreen-Esc lors du
        // prochain initMonaco. Flag posé ici, consumé dans initMonaco.
        _fullscreenEscBound = false;
    }

    // ==============================================================
    //  TOGGLE / OPEN EDITOR
    // ==============================================================

    async function toggleEditor() {
        if (!settings.value.enable_editor) return;
        showEditor.value = !showEditor.value;
        if (!showEditor.value) return;

        loadSandboxFiles();
        await nextTick();
        await initMonaco();

        if (activeTabPath.value) {
            const path = activeTabPath.value;
            // Reload from server if:
            //  - model is gone/disposed, OR
            //  - typewriter was aborted mid-write (model may be empty or partial)
            const needsReload = !_modelOk(path) || _pathsNeedingReload.has(path);
            _pathsNeedingReload.delete(path);
            if (needsReload) {
                _dropModel(path);
                await openFile(path, true);
            } else {
                try { monacoRef.instance.setModel(models[path]); } catch(_) {}
                // Restore du viewState (saved juste avant par le watch
                // showEditor=false). Sans ça, ré-ouvrir l'éditeur resetait
                // le scroll même sur l'onglet qui était actif avant fermeture.
                _restoreViewStateFor(path);
                // Ouverture fluide : layout unique à la taille finale (pas la
                // rafale de robustLayout qui faisait saccader l'animation).
                _smoothOpenLayout();
            }
        } else {
            _smoothOpenLayout();
        }
    }

    // ==============================================================
    //  Beforeunload : warning on dirty close of the browser tab.
    //  Standard pattern — returning a truthy value triggers the
    //  browser's "Reload site? Changes you made may not be saved"
    //  dialog. Browser ignores our custom string for security, only
    //  cares whether we returnValue at all.
    // ==============================================================
    function _anyTabDirty() {
        for (const t of openTabs.value) {
            if (_tabIsDirty(t.path)) return true;
        }
        // Copie de secours d'avant une écriture de l'assistant (2026-09-21) :
        // l'onglet paraît propre, mais recharger la page la perdrait.
        return Object.keys(assistantStash.value || {}).length > 0;
    }
    window.addEventListener('beforeunload', (e) => {
        // PASSE 15 (B15) — Si un persist d'onglets est en attente (timer
        // debounce 150ms toujours actif), le flusher synchrone avant que
        // le navigateur ferme la page. Sans ça, si l'utilisateur ferme
        // le tab dans la fenêtre <150ms après le dernier change, l'état
        // final des onglets n'est pas sauvegardé → restore au prochain
        // load montre un état périmé.
        if (_persistTabsTimer) {
            try { clearTimeout(_persistTabsTimer); } catch(_) {}
            _persistTabsTimer = null;
        }
        // Écriture FINALE, recalculée maintenant : la position du curseur de
        // l'onglet actif a bougé depuis le dernier changement d'onglet.
        // (La clé se calcule via _tabsStorageKey(), symétrique au callback
        // debounce plus haut.)
        _persistTabsData = null;
        // Rien n'est écrit tant que la restauration de CE compte n'a pas eu
        // lieu : un rechargement pendant le démarrage effacerait sinon la
        // session mémorisée avec une liste encore vide.
        if (_tabsPersistEnabled() && user.value && user.value.id
                && (openTabs.value.length || _lastRestoredForUid === user.value.id)) {
            try {
                localStorage.setItem(_tabsStorageKey(), JSON.stringify(_buildTabsData()));
            } catch(_) {}
        }
        if (_anyTabDirty()) {
            e.preventDefault();
            e.returnValue = '';  // required for Chrome
            return '';
        }
    });

    // ==============================================================
    //  RUNTIME TOGGLE : settings.enable_editor flippé en plein vol
    //
    //  Sans ce watch, désactiver l'éditeur dans les paramètres
    //  laissait Monaco tourner en arrière-plan (resources, listeners,
    //  ResizeObserver, models en mémoire) tout en cachant juste son
    //  conteneur via Tailwind. Symptômes :
    //    * RAM qui ne baisse pas après désactivation
    //    * Tool streams (write_file/edit_file) tentaient encore
    //      d'écrire dans des models cachés -> errors silencieuses
    //    * Au passage admin -> main, l'éditeur "ré-apparaissait"
    //      ouvert là où il était avant la désactivation
    //
    //  Comportement attendu :
    //    * désactivation : showEditor=false + disposeAll() complet
    //    * réactivation  : rien à faire, l'utilisateur cliquera
    //      sur le bouton éditeur pour le rouvrir (toggleEditor
    //      réinit Monaco à la demande).
    // ==============================================================
    watch(() => settings.value && settings.value.enable_editor, async (enabled, prev) => {
        // Premier appel synchronisé après mount : prev === undefined.
        // Pas de cleanup à ce moment-là.
        if (prev === undefined) return;

        if (!enabled) {
            // Fermeture propre : sauvegarder le viewState courant pour
            // le restaurer si l'utilisateur réactive plus tard, puis
            // disposer toutes les ressources Monaco.
            try { _saveCurrentViewState && _saveCurrentViewState(); } catch (_) {}
            // Modifications non enregistrées : mises de côté, proposées à la
            // réactivation (E2) — avant, perdues sans question.
            const _kept = rescueDirtyBuffers();
            if (_kept) showToast(_kept + ' fichier(s) non enregistré(s) mis de côté — proposés à la réactivation de l\'éditeur', 'info');
            showEditor.value = false;
            try { await disposeAll(); } catch (_) {}
        }
        // Re-enable : rien à faire ici. L'éditeur est réinitialisé
        // paresseusement à la prochaine ouverture (toggleEditor /
        // openFile / showDiffForMessage).
    });

    // ==============================================================
    //  Watcher : changement de thème éditeur à chaud
    // ==============================================================
    //  L'utilisateur peut basculer le thème depuis le panneau Settings
    //  (Apparence → Thème sombre). ``monaco.editor.setTheme(name)`` est
    //  global : un seul appel re-skin TOUTES les instances Monaco (main
    //  + diff). On ne re-crée pas les éditeurs — Monaco gère le swap
    //  in-place sans perdre le contenu ni le viewState.
    // ==============================================================
    watch(() => settings.value && settings.value.editor_dark_mode, (dark, prev) => {
        if (prev === undefined) return;
        // Garde : si Monaco n'est pas chargé (éditeur jamais ouvert),
        // rien à faire — le thème sera appliqué au prochain create()
        // via _resolveEditorTheme().
        if (typeof monaco === 'undefined' || !monaco.editor) return;
        try {
            monaco.editor.setTheme(dark === false ? 'vs' : 'vs-dark');
        } catch (e) {
            // setTheme peut throw si appelé avant qu'aucun éditeur
            // n'existe sur certaines versions Monaco — silencieux.
        }
    });

    // ==============================================================
    //  MODE SOMBRE APP + SKIN : les appliers de classes ``<body>``
    //  (``elpis-app-dark`` / ``elpis-skin-*`` / ``elpis-dark-surface``)
    //  vivent désormais dans app-settings.js (correctif skins 2026-07) —
    //  admin.html ne charge pas app-editor.js mais doit suivre le skin.
    //  Le thème de l'ÉDITEUR (``editor_dark_mode``, watcher ci-dessus)
    //  reste ici : il est INDÉPENDANT du mode sombre de la page.
    // ==============================================================

    // ==============================================================
    //  Watcher : préférences éditeur à chaud (font, tabs, wrap, etc.)
    // ==============================================================
    //  Quand l'utilisateur modifie une préférence dans Settings, on
    //  ré-applique sur les deux instances Monaco sans les recréer.
    //  ``updateOptions`` est in-place et préserve le contenu, le
    //  viewState, et les modèles. Le ``deep:false`` (par défaut Vue)
    //  ne nous suffit pas — chaque pref est une feuille du settings
    //  object donc on watch un getter computed.
    // ==============================================================
    function _applyEditorPrefsToMonaco() {
        if (typeof monaco === 'undefined' || !monaco.editor) return;
        const s = settings.value || {};
        const opts = {
            fontSize:    Math.max(8, Math.min(32, Number(s.editor_font_size) || 14)),
            fontFamily:  String(s.editor_font_family || 'JetBrains Mono')
                         + ', "Fira Code", "Cascadia Code", Consolas, monospace',
            tabSize:     Math.max(1, Math.min(8, Number(s.editor_tab_size) || 4)),
            insertSpaces: s.editor_insert_spaces !== false,
            wordWrap:    ['off','on','bounded'].includes(s.editor_word_wrap) ? s.editor_word_wrap : 'off',
            minimap:     { enabled: !!s.editor_minimap },
            lineNumbers: (s.editor_line_numbers === false) ? 'off' : 'on',
        };
        try { if (monacoRef.instance) monacoRef.instance.updateOptions(opts); } catch(_) {}
        try {
            if (monacoRef.diff) {
                monacoRef.diff.updateOptions(opts);
            }
        } catch(_) {}
        // tabSize / insertSpaces sont par modèle : on RE-DÉTECTE avec les
        // nouvelles valeurs par défaut — un fichier indenté garde son style
        // (avant, les réglages l'écrasaient, et Tab insérait 4 espaces dans un
        // fichier en tabulations).
        try {
            for (const m of monaco.editor.getModels()) _detectIndentation(m);
        } catch(_) {}
        _updateStatusExtras();
        // l'éditeur tourne en
        // ``automaticLayout: false`` (on gère le resize via ResizeObserver).
        // Quand on toggle le minimap ou wordWrap via updateOptions, Monaco
        // ne recalcule PAS les dimensions internes par lui-même : la
        // minimap apparaît collée à la colonne des numéros de ligne,
        // sans largeur dédiée → glitch visuel. Un appel explicite à
        // ``layout()`` après l'updateOptions force le recalcul des
        // zones (gutter, editor area, minimap, overlays). Idem pour le
        // diff editor (les deux sous-éditeurs original + modifié).
        try {
            if (monacoRef.instance) monacoRef.instance.layout();
            if (monacoRef.diff) monacoRef.diff.layout();
        } catch(_) {}
    }
    watch(() => {
        const s = settings.value || {};
        return [
            s.editor_font_size, s.editor_font_family, s.editor_tab_size,
            s.editor_insert_spaces, s.editor_word_wrap, s.editor_minimap,
            s.editor_line_numbers,
        ].join('|');
    }, (cur, prev) => {
        if (prev === undefined) return;
        _applyEditorPrefsToMonaco();
    });

    // ==============================================================
    //  OPEN / SWITCH / CLOSE TABS
    // ==============================================================

    const _pendingOpen = {};        // path → Promise -- dedup concurrent open calls
    const _pathsNeedingReload = new Set(); // paths where typewriter was aborted mid-write

    // ==============================================================
    //  PER-TAB VIEW STATE (scroll + cursor + selection + folding)
    //
    //  Quand l'user passe d'un onglet à l'autre, Monaco oublie par défaut
    //  la position de scroll et du curseur — il revient tout en haut du
    //  fichier. Agaçant sur les longs fichiers (perdre sa place à chaque
    //  aller-retour entre ref/impl par exemple).
    //
    //  On cache ici le `viewState` produit par `editor.saveViewState()`
    //  par chemin. Sauvé à chaque départ d'onglet (via _saveCurrentViewState),
    //  restauré après setModel (via _restoreViewStateFor). Le viewState
    //  capture scroll Y/X, position du curseur, selection, et les régions
    //  pliées (folding) — tout ce qu'il faut pour se réinstaller au même
    //  endroit.
    //
    //  Scope : cache en mémoire uniquement, purgé à la fermeture de l'onglet.
    //  Pas de persistance cross-session (pas de localStorage) — reste dans
    //  le comportement du projet qui évite les APIs browser-storage.
    // ==============================================================
    const _tabViewStates = Object.create(null);   // path → Monaco viewState

    function _saveCurrentViewState() {
        // Snapshot du viewState de l'onglet courant, associé à activeTabPath.
        // No-op si pas d'instance, pas de modèle actif, ou si un stream
        // d'édition est en cours (viewState capturé pendant un applyEdits
        // massif pourrait être incohérent — on préfère garder le dernier
        // état stable).
        if (!monacoRef.instance) return;
        const path = activeTabPath.value;
        if (!path) return;
        const cur = monacoRef.instance.getModel();
        if (!cur || cur.isDisposed() || cur !== models[path]) return;
        // Pendant un stream d'écriture : on skip — le user n'a pas la main,
        // l'état visible peut évoluer, pas pertinent à sauvegarder.
        if (_writeStreams[path] && _writeStreams[path].active) return;
        try {
            const vs = monacoRef.instance.saveViewState();
            if (vs) _tabViewStates[path] = vs;
        } catch(_) {}
    }

    function _restoreViewStateFor(path) {
        // Restaure le viewState cache pour `path` — suppose que le modèle
        // associé est déjà actif dans l'éditeur (setModel déjà fait). No-op
        // si pas de viewState cache (premier affichage) — Monaco reste en
        // haut du fichier, comportement antérieur.
        if (!monacoRef.instance || !path) return false;
        const vs = _tabViewStates[path];
        if (!vs) {
            // Onglet restauré au démarrage : curseur et défilement mémorisés.
            const pos = _pendingPositions[path];
            if (!pos) return false;
            delete _pendingPositions[path];
            try {
                const ed = monacoRef.instance;
                const m = ed.getModel();
                const line = Math.min(Math.max(1, pos.line), m ? m.getLineCount() : pos.line);
                ed.setPosition({ lineNumber: line, column: Math.max(1, pos.col || 1) });
                if (pos.top) ed.setScrollTop(pos.top); else ed.revealLineInCenter(line);
                return true;
            } catch (_) { return false; }
        }
        try {
            monacoRef.instance.restoreViewState(vs);
            return true;
        } catch(_) { return false; }
    }

    function _clearViewStateFor(path) {
        if (path && _tabViewStates[path]) delete _tabViewStates[path];
    }

    // Fichiers déjà signalés comme volumineux (évite de re-toaster à chaque
    // reload/poll du même onglet).
    const _largeFileWarned = new Set();

    // Chemins dont la dernière ouverture a échoué pour une cause PASSAGÈRE
    // (sandbox qui redémarre, réseau, 5xx) — pas un 404. La restauration de
    // session les garde au lieu de les rayer de la mémoire (2026-09-21).
    const _openTransientFail = new Set();

    async function openFile(path, forceReload, opts) {
        path = _canonSandboxPath(path);
        if (!path) return;
        forceReload = (forceReload !== false);  // default true
        const _quiet = !!(opts && opts.quiet);

        if (_pendingOpen[path]) return _pendingOpen[path];

        const promise = (async () => {
            if (!showEditor.value) {
            showEditor.value = true;
            await nextTick();
            // Populate the file tree when the AI opens the editor
            // (toggleEditor() normally does this, but the AI bypasses it)
            loadSandboxFiles();
        }
            await initMonaco();
            if (!monacoRef.instance) return;

            editorMode.value = 'code';
            isDiffView.value = false;  // Exit diff mode when opening a file normally

            // On quitte un autre onglet : sa position rejoint l'historique
            // (Alt+←) et son état de vue est mémorisé — avant, ouvrir un
            // fichier depuis l'arbre perdait le défilement de l'onglet quitté.
            if (activeTabPath.value && activeTabPath.value !== path) {
                _pushNav();
                _saveCurrentViewState();
            }
            // Add tab if not already present
            // Onglet DÉJÀ ouvert avec son modèle : un échec de relecture ne doit
            // jamais le retirer (il peut porter des modifications non enregistrées).
            const _keepOnFailure = !!openTabs.value.find(t => t.path === path) && _modelOk(path);
            if (!openTabs.value.find(t => t.path === path)) {
                openTabs.value.push({ path, name: path.split('/').pop() });
            }
            activeTabPath.value  = path;
            editorFilePath.value = path;

            // ──────────────────────────────────────────────────────────
            //  Branches viewers spéciaux (image / hex / docx)
            //  Avant de tomber sur le download texte par défaut, on
            //  détecte le type de fichier et on aiguille :
            //   • image → on remplit imageViewerPath (le template fait
            //     <img :src="...">). Pas de Monaco model créé.
            //   • hex   → on télécharge en blob, parse en Uint8Array,
            //     on remplit hexViewerData. Pas de Monaco model.
            //   • docx  → fetch /api/sandbox/read-docx (extrait texte),
            //     model Monaco créé avec ce texte + READ-ONLY (le tab
            //     est ajouté à readOnlyTabs pour interdire save).
            // ──────────────────────────────────────────────────────────
            const _mode = _resolveFileViewMode(path);

            if (_mode === 'office') {
                // Aucun modèle Monaco : un modèle texte résiduel (fichier
                // ouvert avant cette version, écriture d'outil) est retiré.
                if (models[path]) _dropModel(path);
                originalFileContent[path] = '';
                await officeOpen(path, { force: forceReload });
                robustLayout();
                return;
            }

            if (_mode === 'image') {
                imageViewerPath.value = _sbUrl('download?path=') + encodeURIComponent(path);
                // Pas de model Monaco — l'image est juste rendue par <img>.
                // Quand l'utilisateur switch sur cet onglet, le template
                // affiche imageViewerPath au lieu du div Monaco.
                originalFileContent[path] = '';   // placeholder pour _tabIsDirty
                robustLayout();
                return;
            }

            if (_mode === 'hex') {
                if (models[path]) _dropModel(path);
                await _openHex(path);
                originalFileContent[path] = '';
                robustLayout();
                return;
            }

            if (_mode === 'docx') {
                // Endpoint dédié — extraction plaintext via python-docx
                try {
                    const res = await fetchAuth(
                        _sbUrl('read-docx?path=') + encodeURIComponent(path)
                    );
                    if (res && res.ok) {
                        const data = await res.json();
                        const text = (data && data.text) || '';
                        originalFileContent[path] = text;
                        readOnlyTabs.value.add(path);
                        if (!_modelOk(path)) {
                            _dropModel(path);
                            _ensureModel(path, text, 'plaintext');
                        } else {
                            models[path].setValue(text);
                            monaco.editor.setModelLanguage(models[path], 'plaintext');
                        }
                        // Toast informatif
                        showToast('Lecture seule (fichier .docx)');
                    } else if (res && res.status === 501) {
                        showToast('Support .docx non installé côté serveur', 'error');
                    } else {
                        showToast('Lecture .docx échouée', 'error');
                    }
                } catch (e) {
                    showToast('Erreur lecture .docx', 'error');
                }
                // Onglet changé pendant la lecture : le modèle reste en cache,
                // on ne l'affiche pas dans l'onglet courant.
                if (_modelOk(path) && activeTabPath.value === path) {
                    try {
                        monacoRef.instance.setModel(models[path]);
                        monacoRef.instance.updateOptions({ readOnly: true });
                    } catch(_) {}
                }
                robustLayout();
                return;
            }

            // ── Fichier texte normal : flux existant (download → setValue Monaco)
            try {
                const res = await fetchAuth(
                    _sbUrl('download?path=') + encodeURIComponent(path)
                );
                // mtime lu ici, APPLIQUÉ seulement si le modèle est aligné sur
                // le disque (sinon la précondition de /save serait faussée).
                const _diskMtime = _mtimeOf(res);
                const _diskSha = _shaOf(res);
                if (res && res.ok) {
                    // Un binaire non répertorié (.dat renommé, sortie de
                    // programme…) ne doit JAMAIS finir dans Monaco : une
                    // sauvegarde réécrirait le texte décodé par-dessus.
                    const _read = await _readTextOrBinary(res);
                    if (_read.binary) {
                        _setWith(binaryPaths, path);
                        if (models[path]) _dropModel(path);
                        originalFileContent[path] = '';
                        if (activeTabPath.value === path) await _openHex(path);
                        robustLayout();
                        return;
                    }
                    const content    = _read.text;
                    _openTransientFail.delete(path);
                    // Garde gros-fichier : au-delà de ~5 Mo, Monaco peut se figer
                    // à la tokenisation. On prévient l'utilisateur une fois ;
                    // l'ouverture se poursuit (pas de blocage du flux, notamment
                    // quand l'IA ouvre un fichier programmatiquement).
                    if (content.length > 5 * 1024 * 1024 && !_largeFileWarned.has(path)) {
                        _largeFileWarned.add(path);
                        showToast('Fichier volumineux (' + Math.round(content.length / 1048576) + ' Mo) — l\'éditeur peut être ralenti', 'info');
                    }
                    const lang       = _getLang(path);

                    let _resyncedToDisk = false;
                    if (!_modelOk(path)) {
                        // Drop stale / disposed model first
                        _dropModel(path);
                        _ensureModel(path, content, lang);
                        _detectIndentation(models[path]);
                        _resyncedToDisk = true;
                    } else if (forceReload) {
                        // ⚠ Un onglet MODIFIÉ n'est jamais écrasé par un
                        // rechargement (clic dans l'arbre, résultat de recherche,
                        // réouverture…) : avant, le disque remplaçait en silence
                        // les modifications non enregistrées. Si le disque a
                        // bougé entre-temps, c'est un conflit : bandeau.
                        const _prevOrig = originalFileContent[path];
                        const _localDirty = _prevOrig !== undefined && models[path].getValue() !== _prevOrig;
                        if (_localDirty && !isStreamActive(path)) {
                            const _sameBase = _diskSha ? _diskSha === fileShas[path] : content === _prevOrig;
                            if (_sameBase || content === _prevOrig) {
                                // Disque identique à la base (simple ``touch``) :
                                // la base avance, aucun faux conflit (E11).
                                _setBase(path, _diskMtime, _diskSha);
                            } else {
                                _mapSet(diskConflicts, path, { mtime: _diskMtime, missing: false });
                                _handledDiskMtime[path] = _diskSha || _diskMtime;
                            }
                        } else {
                            _syncModelEol(models[path], _read.eol);
                            if (models[path].getValue() !== content && !isStreamActive(path)) {
                                _applyMinimalLineEdit(models[path], models[path].getValue(), content);
                            }
                            _resyncedToDisk = true;
                        }
                        // Re-apply language in case extension changed
                        if (models[path].getLanguageId() !== lang) {
                            monaco.editor.setModelLanguage(models[path], lang);
                        }
                    }
                    if (_resyncedToDisk) {
                        _adoptDisk(path, Object.assign({}, _read, { mtime: _diskMtime, sha: _diskSha }));
                    }
                    // Lève le verrou lecture-seule posé par gitShowFileDiff
                    // (consultation d'un diff de commit) UNIQUEMENT si le
                    // model vient d'être (re)synchronisé au contenu DISQUE.
                    // Sans forceReload sur un model existant, le contenu
                    // HISTORIQUE reste affiché : garder le verrou, sinon
                    // Ctrl+S écraserait le disque avec l'ancienne version.
                    // (Les .docx ne passent jamais ici — branche dédiée plus
                    // haut avec early return.)
                    if (_resyncedToDisk && readOnlyTabs.value.has(path)
                            && !(fileFormats[path] && fileFormats[path].lossy)) {
                        readOnlyTabs.value.delete(path);
                        // Le watcher ne couvre que les changements d'onglet —
                        // si on recharge l'onglet ACTIF, ré-appliquer ici.
                        if (activeTabPath.value === path) _applyActiveReadOnly();
                    }
                    _rememberRecent(path);
                    scheduleLint(path, models[path] ? models[path].getValue() : '');
                    _scheduleScmRefresh(path);
                } else {
                    // TOUT échec de lecture, pas seulement le 404. L'onglet et
                    // ``activeTabPath`` sont posés AVANT ce fetch : sans cette
                    // branche, un 500 / 503 (sandbox arrêtée) / 401 laissait un
                    // onglet au bon nom mais SANS modèle Monaco. L'utilisateur
                    // croyait le fichier vide, tapait dedans, et récupérait un
                    // « Modèle non disponible » incompréhensible au Ctrl+S. On
                    // nomme la cause et on retire l'onglet fantôme.
                    var _nom = path.split('/').pop();
                    var _msg;
                    if (!res) {
                        _msg = 'Session expirée — reconnectez-vous pour ouvrir ' + _nom + '.';
                    } else if (res.status === 404) {
                        _msg = 'Fichier introuvable : ' + _nom;
                    } else if (res.status === 503) {
                        _msg = 'Impossible d’ouvrir ' + _nom + ' : environnement sandbox '
                             + 'indisponible (redémarrage en cours) — réessayez dans quelques instants.';
                    } else {
                        _msg = 'Impossible d’ouvrir ' + _nom + ' (erreur ' + res.status + ') — réessayez.';
                    }
                    if (!res || res.status !== 404) _openTransientFail.add(path);
                    else _openTransientFail.delete(path);
                    if (_keepOnFailure && _modelOk(path)) {
                        // (2026-09-21) Onglet déjà ouvert : on garde l'onglet,
                        // son modèle et ses modifications — seule la relecture
                        // a échoué (sandbox qui redémarre, réseau coupé). Avant,
                        // il était retiré et le travail non enregistré perdu ;
                        // au démarrage, la session mémorisée était vidée.
                        showToast(_msg.replace(/ — réessayez\.?$/, '')
                                  + (_tabIsDirty(path) ? ' — vos modifications sont conservées.' : ''),
                                  'error');
                        if (activeTabPath.value === path) {
                            try { monacoRef.instance.setModel(models[path]); } catch(_) {}
                            _restoreViewStateFor(path);
                            updateDiffView();
                        }
                        robustLayout();
                        return;
                    }
                    if (!_quiet) showToast(_msg, 'error');
                    var tabIdx = openTabs.value.findIndex(function(t) { return t.path === path; });
                    if (tabIdx !== -1) {
                        openTabs.value.splice(tabIdx, 1);
                        _dropModel(path);
                        delete originalFileContent[path];
                    }
                    if (activeTabPath.value === path) {
                        activeTabPath.value = openTabs.value.length ? openTabs.value[openTabs.value.length - 1].path : null;
                        if (activeTabPath.value && _modelOk(activeTabPath.value)) {
                            try { monacoRef.instance.setModel(models[activeTabPath.value]); } catch(_) {}
                        } else if (!activeTabPath.value) {
                            try { monacoRef.instance.setModel(null); } catch(_) {}
                        }
                    }
                    return;
                }
            } catch(e) {
                // Réponse illisible (corps tronqué, JSON invalide) : l'onglet
                // est là mais vide, on le dit au lieu de « Erreur lecture
                // fichier » qui ne suggérait aucune suite.
                showToast('Lecture de ' + path.split('/').pop() + ' interrompue — '
                        + 'réponse incomplète du serveur. Refermez l’onglet et réessayez.',
                          'error');
            }

            // RACE (réponses out-of-order) : si l'utilisateur a changé d'onglet
            // pendant le fetch download ci-dessus, ``path`` n'est plus l'onglet
            // actif. Sans ce guard, on collait le modèle du fichier fraîchement
            // chargé dans l'éditeur alors qu'un autre onglet est affiché → le
            // contenu du fichier A apparaissait dans l'onglet B. On ne pose le
            // modèle que s'il correspond toujours à l'onglet actif (le modèle
            // reste en cache pour quand l'utilisateur y revient).
            if (_modelOk(path) && activeTabPath.value === path) {
                try { monacoRef.instance.setModel(models[path]); } catch(_) {}
                // Restore du viewState si on a en cache (retour sur un
                // onglet déjà visité, ou reload après disposal dans
                // switchTab qui avait save juste avant). No-op au premier
                // affichage — Monaco reste en haut, comportement d'origine.
                // On le fait APRÈS setModel, avant updateDiffView (pour que
                // le diff pane prenne le bon scroll aussi).
                _restoreViewStateFor(path);
                updateDiffView();
            }

            robustLayout();
            if (path.toLowerCase().endsWith('.html')) previewPath.value = path;
        })();

        _pendingOpen[path] = promise;
        try   { await promise; }
        finally { delete _pendingOpen[path]; }
    }

    async function switchTab(path) {
        // 1. Snapshot du viewState de l'onglet QU'ON QUITTE avant tout
        //    changement — on le fait ici (pas dans un watch sur
        //    activeTabPath) pour saisir l'état exact au moment précis où
        //    l'user clique sur un autre onglet. `activeTabPath` pointe
        //    encore vers l'ancien onglet à ce stade.
        if (activeTabPath.value && activeTabPath.value !== path) {
            _pushNav();
            _saveCurrentViewState();
        }

        // flush le timer d'autosave en
        // attente AVANT de réassigner activeTabPath. Sans ça, les frappes
        // de l'onglet qu'on quitte ne seraient persistées qu'à l'échéance
        // du timer, qui ciblerait alors le NOUVEL onglet actif (mauvais
        // onglet, voire rien si le nouvel onglet n'est pas dirty).
        const _prevTab = activeTabPath.value;
        if (_autoSaveTimer) {
            clearTimeout(_autoSaveTimer); _autoSaveTimer = null;
            if (_tabIsDirty(_prevTab)) saveEditorContent({ silent: true, path: _prevTab });
        } else if (_prevTab && _prevTab !== path
                   && (settings.value && settings.value.editor_auto_save) === 'on_blur'
                   && _tabIsDirty(_prevTab)) {
            // Mode « à la perte de focus » : changer d'onglet au clavier ne
            // fait pas perdre le focus à Monaco — l'onglet quitté n'était
            // jamais enregistré.
            saveEditorContent({ silent: true, path: _prevTab });
        }

        activeTabPath.value  = path;
        editorFilePath.value = path;
        // Drapeau global recalculé pour l'onglet affiché (E12) : il gardait
        // l'état de l'onglet quitté.
        isEditorDirty.value = _tabIsDirty(path);

        // Si l'onglet cible est un viewer spécial
        // (image / hex / office), pas de model Monaco — il faut juste
        // restaurer l'état du viewer correspondant via openFile (pour un
        // aperçu Office : revalidation légère, l'aperçu prêt reste affiché).
        const _mode = _resolveFileViewMode(path);
        if (window.elpisOffice.isViewerMode(_mode)) {
            await openFile(path, true);
            return;
        }

        if (!_modelOk(path)) {
            // Model gone or disposed → full reload from server.
            // openFile se chargera du restore du viewState si on en a un.
            _dropModel(path);
            await openFile(path, true);
            return;
        }
        try {
            monacoRef.instance.setModel(models[path]);
            // 2. Restauration du viewState de l'onglet qu'on AFFICHE.
            //    No-op si premier affichage (pas de viewState en cache) —
            //    Monaco reste en haut, comportement antérieur.
            _restoreViewStateFor(path);
            if (isDiffView.value) updateDiffView();
        } catch(_) {}
        if (path.toLowerCase().endsWith('.html')) previewPath.value = path;
        robustLayout();
        // Lint on tab switch (Python only, debounced)
        scheduleLint(path, models[path] ? models[path].getValue() : '');
        _rememberRecent(path);
        _scheduleScmRefresh(path);
    }

    // Detect "dirty" state for ANY tab by comparing the current model
    // value against the last-known on-disk content. We can't rely on
    // ``isEditorDirty.value`` which only tracks the active tab.
    function _tabIsDirty(path) {
        if (!path || !_modelOk(path)) return false;
        try {
            const current = models[path].getValue();
            const original = originalFileContent[path];
            return original !== undefined && current !== original;
        } catch (_) { return false; }
    }

    async function closeTab(path, event, force) {
        if (event) event.stopPropagation();
        // PASSE 15 (B12) — On re-résoudra ``idx`` APRÈS l'await openConfirm
        // ci-dessous. Si l'utilisateur clique X sur deux onglets en rapide
        // succession, le 1er await suspend la fonction, le 2e closeTab
        // démarre et splice son tab, puis le 1er reprend avec un idx
        // périmé et splice le mauvais onglet. La résolution finale juste
        // avant le splice ferme ce trou.
        let idx = openTabs.value.findIndex(t => t.path === path);
        if (idx === -1) return;

        // FEATURE — Confirmation avant fermeture d'un onglet contenant
        // des modifications non sauvegardées. ``_tabIsDirty`` compare
        // le contenu courant du modèle Monaco avec l'original loadé
        // depuis disque (originalFileContent map). Couvre l'onglet
        // actif ET les onglets inactifs (middle-click).
        //
        // ``force`` (P2 FIX) : court-circuite la confirmation. Utilisé
        // par les flux qui ont DÉJÀ obtenu l'accord explicite de
        // l'utilisateur pour une perte de données (ex: restore snapshot).
        // Par défaut undefined → comportement inchangé pour tous les
        // appelants existants.
        if (!force && _tabIsDirty(path)) {
            // FLUSH AUTOSAVE — si l'autosave est actif, l'utilisateur s'attend à
            // ce que ses modifications soient sauvegardées automatiquement. On
            // flush le timer en attente et on sauvegarde (silencieux) plutôt que
            // de l'avertir d'une perte. On ne demande confirmation QUE si, après
            // tentative, l'onglet est encore « dirty » (autosave off, ou save
            // échoué → on ne perd jamais de données silencieusement).
            const _autoMode = (settings.value && settings.value.editor_auto_save) || 'off';
            if (_autoMode !== 'off') {
                if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
                await saveEditorContent({ silent: true, path: path });
            }
            if (_tabIsDirty(path)) {
                const fname = path.split('/').pop();
                // Trois issues (2026-09-19) : l'ancienne fenêtre n'offrait que
                // « Fermer sans sauvegarder » ou « Annuler » — enregistrer
                // imposait d'annuler, Ctrl+S, puis refermer.
                const choice = ctx.openChoice
                    ? await ctx.openChoice(
                        'Enregistrer « ' + fname + ' » ?',
                        'Ce fichier contient des modifications non enregistrées.',
                        [
                            { id: 'discard', label: 'Ne pas enregistrer', tone: 'danger' },
                            { id: 'save',    label: 'Enregistrer',        tone: 'primary' },
                        ])
                    : ((await openConfirm('Fermer sans sauvegarder ?', fname, true,
                                          'Fermer sans sauvegarder', 'Annuler')) ? 'discard' : null);
                if (!choice) return;
                if (choice === 'save') {
                    await saveEditorContent({ path });
                    // Échec, conflit disque ou lecture seule : l'onglet reste.
                    if (_tabIsDirty(path)) return;
                }
            }
        }

        // Copie de secours d'avant une écriture de l'assistant : l'onglet est
        // propre, mais la fermer perd ce que le bandeau promettait de garder
        // (« Rien n'est perdu »). Avant (2026-09-21), aucune question.
        if (!force && assistantStash.value[path]) {
            const fname = path.split('/').pop();
            if (!await openConfirm(
                    'Fermer « ' + fname + ' » ?',
                    'Vos modifications mises de côté avant l’écriture de l’assistant seront perdues.',
                    true, 'Fermer quand même', 'Annuler')) return;
        }

        // PASSE 15 (B12) — re-résoudre idx APRÈS l'await. Un closeTab
        // concurrent (deuxième clic X pendant qu'on attendait l'user
        // sur le confirm) a pu modifier openTabs entre temps.
        idx = openTabs.value.findIndex(t => t.path === path);
        if (idx === -1) return;   // déjà fermé par un autre flux

        // Si on ferme l'onglet actif, on quitte cet onglet —
        // pas besoin de sauvegarder son viewState puisqu'il ne sera
        // plus revu. Pour les autres onglets (fermeture via middle-click
        // par exemple), on purge aussi leur cache.
        _clearViewStateFor(path);
        // AUDIT 2026-08-31 (passe 4, F17) — le suivi mtime et la dédup de
        // notification n'étaient JAMAIS purgés : sur une longue session, les
        // maps grossissaient onglet après onglet (et un path fermé restait
        // sondé indirectement au ré-open avec un mtime d'une autre vie).
        _dropBase(path);
        _restorePending.delete(path);
        _mapSet(diskConflicts, path, null);
        _mapSet(assistantStash, path, null);
        _clearScm(path);

        openTabs.value.splice(idx, 1);
        // Fermer un onglet à GAUCHE de l'actif décale l'actif vers la gauche,
        // hors de la vue s'il était au bord : on le ramène (no-op sinon).
        nextTick(() => scrollTabIntoView(activeTabPath.value));
        _dropModel(path);
        delete originalFileContent[path];
        // nettoyage des viewers spéciaux pour cet onglet
        if (readOnlyTabs.value.has(path)) readOnlyTabs.value.delete(path);
        if (imageViewerPath.value && imageViewerPath.value.includes(encodeURIComponent(path))) {
            imageViewerPath.value = '';
        }
        if (hexViewerData.value && hexViewerData.value.path === path) {
            hexViewerData.value = null;
        }
        _officeForget(path);
        _setWithout(binaryPaths, path);
        _setWithout(officeTextFallback, path);
        _binaryRefused.delete(path);

        if (path === activeTabPath.value) {
            if (openTabs.value.length > 0) {
                switchTab(openTabs.value[Math.min(idx, openTabs.value.length - 1)].path);
            } else {
                activeTabPath.value = null;
                try { if (monacoRef.instance) monacoRef.instance.setModel(null); } catch(_) {}
                try { if (monacoRef.diff)     monacoRef.diff.setModel(null);     } catch(_) {}
            }
        }
        // Vue scindée : si on ferme le fichier du panneau droit, on réassigne
        // (autre onglet) ou on referme la vue scindée.
        // (sans effet quand le panneau droit affiche l'aperçu : il ne montre
        //  aucun onglet, fermer un fichier ne doit ni le réassigner ni le fermer)
        if (path === splitTabPath.value && splitMode.value === 'code') {
            const other = openTabs.value.find(t => t.path !== activeTabPath.value && !officeIsViewerPath(t.path));
            if (splitView.value && other) setSplitFile(other.path);
            else { splitTabPath.value = null; exitSplit(); }
        }
    }

    // ==============================================================
    //  VUE SCINDÉE (SPLIT VIEW)
    // ==============================================================
    // Affecte le fichier du panneau DROIT. Le modèle existe déjà pour un onglet
    // ouvert ; sinon repli sur openFile (panneau gauche).
    function setSplitFile(path) {
        if (!path) return;
        // Le panneau droit est un 2e Monaco : un visualiseur (image, hex,
        // aperçu Office) n'y a pas de modèle à afficher.
        if (officeIsViewerPath(path)) {
            showToast('Aperçu disponible dans le panneau gauche', 'info');
            return;
        }
        splitTabPath.value = path;
        if (!_modelOk(path)) { openFile(path); return; }
        try { if (monacoRef.instance2) monacoRef.instance2.setModel(models[path]); } catch(_) {}
        activePane.value = 'right';
        nextTick(() => {
            robustLayout();
            try { if (monacoRef.instance2) monacoRef.instance2.focus(); } catch(_) {}
        });
    }
    function enterSplit() {
        if (!activeTabPath.value) return;          // rien à scinder
        // (2026-09-19) Plus de plein écran FORCÉ : la vue scindée marche aussi
        // à côté du chat ; le plein écran reste à un clic.
        splitView.value = true;
        splitMode.value = 'code';
        // Fichier par défaut à droite : un AUTRE onglet ouvert, sinon le même
        // (comparer 2 zones d'un gros fichier).
        if (!splitTabPath.value || !openTabs.value.find(t => t.path === splitTabPath.value)
                || officeIsViewerPath(splitTabPath.value)) {
            const other = openTabs.value.find(t => t.path !== activeTabPath.value && !officeIsViewerPath(t.path));
            splitTabPath.value = other ? other.path
                : (officeIsViewerPath(activeTabPath.value) ? null : activeTabPath.value);
        }
        nextTick(() => {
            if (monacoRef.instance2 && _modelOk(splitTabPath.value)) {
                try { monacoRef.instance2.setModel(models[splitTabPath.value]); } catch(_) {}
            }
            activePane.value = 'right';
            _relayoutMonacoDuringTransition();
            robustLayout();
        });
    }
    function exitSplit() {
        splitView.value = false;
        splitMode.value = 'code';
        previewLive.value = false;
        _cancelPreviewLive();
        activePane.value = 'left';
        try { if (monacoRef.instance2) monacoRef.instance2.setModel(null); } catch(_) {}
        nextTick(() => { robustLayout(); });
    }
    function toggleSplit() {
        // Depuis le mode aperçu, « Vue scindée » bascule vers les 2 éditeurs
        // plutôt que de tout refermer (sinon il faut 2 allers-retours).
        if (splitView.value && splitMode.value === 'preview') { enterSplit(); return; }
        if (splitView.value) exitSplit(); else enterSplit();
    }

    // ── Panneau droit = rendu web de la page (code | aperçu) ─────────────
    // Réutilise l'état d'aperçu de l'onglet « Web » (previewPath /
    // previewSource / previewSrc) : les deux surfaces montrent la même chose
    // et bénéficient des mêmes correctifs serveur.
    function enterSplitPreview() {
        splitView.value = true;
        splitMode.value = 'preview';
        activePane.value = 'left';                 // on tape dans le code, on regarde à droite
        // Pré-remplit la cible avec la page en cours d'édition, si c'en est une.
        const p = activeTabPath.value || '';
        if (p.toLowerCase().endsWith('.html')) previewPath.value = p;
        try { if (monacoRef.instance2) monacoRef.instance2.setModel(null); } catch(_) {}
        nextTick(() => {
            _relayoutMonacoDuringTransition();
            robustLayout();
        });
    }
    function toggleSplitPreview() {
        if (splitView.value && splitMode.value === 'preview') exitSplit();
        else enterSplitPreview();
    }

    // ── Rafraîchissement « live » de l'aperçu ────────────────────────────
    // L'aperçu sert l'état ENREGISTRÉ (il passe par le serveur de fichiers de
    // la sandbox) : un buffer Monaco modifié mais non sauvegardé n'apparaît
    // pas. En mode live on enregistre donc avant de recharger l'iframe.
    // Opt-in explicite (défaut OFF) parce que ça écrit sur disque à la frappe ;
    // sans lui, l'aperçu se met à jour à chaque enregistrement manuel.
    // (``previewLive`` est déclaré plus haut avec les refs de la vue scindée :
    //  ``exitSplit`` le remet à false et est défini avant ce bloc.)
    const _PREVIEW_LIVE_DELAY  = 700;   // ms sans frappe avant save+reload
    let   _previewLiveTimer    = null;
    function _cancelPreviewLive() {
        if (_previewLiveTimer) { clearTimeout(_previewLiveTimer); _previewLiveTimer = null; }
    }
    function _schedulePreviewLive() {
        if (!previewLive.value) return;
        if (!splitView.value || splitMode.value !== 'preview') return;
        if (previewSource.value !== 'file') return;   // mode serveur : c'est le serveur qui décide
        // Capturer le path MAINTENANT : l'utilisateur peut changer d'onglet
        // pendant le debounce (même piège que _scheduleAutoSave).
        const path = activeTabPath.value;
        if (!path) return;
        _cancelPreviewLive();
        _previewLiveTimer = setTimeout(async () => {
            _previewLiveTimer = null;
            try { await saveEditorContent({ silent: true, path }); } catch (_) {}
            refreshPreview();
        }, _PREVIEW_LIVE_DELAY);
    }
    function togglePreviewLive() {
        previewLive.value = !previewLive.value;
        if (previewLive.value) _schedulePreviewLive();
        else _cancelPreviewLive();
    }
    // Ouvre l'aperçu dans un onglet navigateur (utile pour les devtools).
    function openPreviewInNewTab() {
        try { window.open(previewSrc.value, '_blank', 'noopener'); } catch (_) {}
    }
    // Clic d'onglet → ouvre dans le panneau ACTIF (droit si scindé + focus droit).
    function onTabActivate(path) {
        if (splitView.value && activePane.value === 'right') {
            // Un visualiseur ne s'ouvre qu'à gauche : on y bascule le focus.
            if (officeIsViewerPath(path)) { activePane.value = 'left'; switchTab(path); return; }
            setSplitFile(path);
        } else switchTab(path);
    }
    // Menu contextuel d'onglet → « Ouvrir à droite » : force scindé + plein écran.
    function openInSplit(path) {
        closeTabCtxMenu();
        if (!path || officeIsViewerPath(path)) return;
        splitView.value = true;
        splitMode.value = 'code';   // « Ouvrir à droite » veut un éditeur, pas l'aperçu
        nextTick(() => setSplitFile(path));
    }
    // Diviseur redimensionnable entre les deux panneaux (drag → splitRatio %).
    function splitResizeStart(e) {
        if (e && e.preventDefault) e.preventDefault();
        const row = e.currentTarget && e.currentTarget.parentElement;
        if (!row) return;
        const rect = row.getBoundingClientRect();
        const move = (ev) => {
            const x = (ev.touches && ev.touches[0]) ? ev.touches[0].clientX : ev.clientX;
            let pct = ((x - rect.left) / rect.width) * 100;
            splitRatio.value = Math.max(15, Math.min(85, pct));
            _forceLayout();
        };
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            document.removeEventListener('touchmove', move);
            document.removeEventListener('touchend', up);
            robustLayout();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', up);
    }

    // ==============================================================
    //  DIFF VIEW
    // ==============================================================

    // Référence du mode diff (2026-09-19) :
    //   'saved'    — dernier contenu chargé ou enregistré (historique) ;
    //   'head'     — dernière version commitée (Git) ;
    //   'disk' / 'stash' / 'external' / 'proposal' — posés par l'appelant
    //                (conflit disque, copie de secours, carte du chat,
    //                proposition de l'IA) : updateDiffView ne les touche pas.
    const diffBase = ref('saved');

    function updateDiffView() {
        if (!isDiffView.value || !activeTabPath.value) return;
        if (!monacoRef.diff || !monacoRef.originalModel) return;
        if (!_modelOk(activeTabPath.value)) return;
        if (diffBase.value !== 'saved' && diffBase.value !== 'head') return;

        const modifiedModel = models[activeTabPath.value];
        const _head = _headCache[activeTabPath.value];
        const originalText  = diffBase.value === 'head'
            ? ((_head && typeof _head.text === 'string') ? _head.text : '')
            : (originalFileContent[activeTabPath.value] || '');

        try {
            if (monacoRef.originalModel.getValue() !== originalText) {
                monacoRef.originalModel.setValue(originalText);
            }
            monaco.editor.setModelLanguage(monacoRef.originalModel, modifiedModel.getLanguageId());
            monacoRef.diff.setModel({ original: monacoRef.originalModel, modified: modifiedModel });
            monacoRef.diff.layout();
        } catch(_) {}
    }

    // ``base`` : 'saved' (défaut, historique) ou 'head' (dernier commit).
    // Rappeler avec la base déjà affichée referme le diff.
    async function toggleDiffMode(base) {
        base = (base === 'head') ? 'head' : 'saved';
        if (isDiffView.value && diffBase.value === base) {
            isDiffView.value = false;
            diffBase.value = 'saved';
            nextTick(() => robustLayout());
            return;
        }
        if (base === 'head') {
            const path = activeTabPath.value;
            const text = path ? await _loadHead(path) : null;
            if (typeof text !== 'string') {
                showToast('Pas de version commitée pour ce fichier', 'info');
                return;
            }
        }
        diffBase.value = base;
        isDiffView.value = true;
        showExplorer.value     = false;
        ctx.showSidebar.value  = false;
        nextTick(() => {
            updateDiffView();
            robustLayout();
        });
    }
    // Quitter l'onglet referme un diff « ponctuel » (conflit, copie de
    // secours, proposition) : son côté gauche appartient à l'autre fichier.
    watch(activeTabPath, () => {
        if (isDiffView.value && !['saved', 'head'].includes(diffBase.value)) {
            if (diffBase.value === 'proposal') rejectAiProposal({ silent: true });
            isDiffView.value = false;
            diffBase.value = 'saved';
        }
    });

    // ==============================================================
    //  SAVE
    // ==============================================================

    // Chemins ayant un POST /save EN VOL. Sert à deux gardes anti-race :
    //   • saveEditorContent : un seul save concurrent par fichier (évite que
    //     l'autosave et un Ctrl+S partent en parallèle sur le même fichier).
    //   • _checkExternalMods : ne PAS signaler « modifié en externe » pour un
    //     fichier qu'on est en train de sauver (le mtime tracké est périmé tant
    //     que le save n'a pas répondu → faux positif + prompt de reload).
    const _savingPaths = new Set();

    async function saveEditorContent(opts) {
        // opts.silent : true pour les sauvegardes auto-save (pas de toast
        // au succès, on évite la pollution visuelle). Erreurs toujours
        // affichées car silencieux = bug invisible sinon.
        const silent = !!(opts && opts.silent);
        const force  = !!(opts && opts.force);
        if (!activeTabPath.value && !(opts && opts.path)) return;
        // (passe 9, F6) — verrou PAR FICHIER : seul l'onglet en cours
        // d'écriture par un stream est bloqué (avant : le booléen global
        // refusait EN SILENCE Ctrl+S/autosave/fermeture sur tout autre onglet
        // pendant qu'un stream — désormais possible en arrière-plan — écrivait).
        if (isStreamActive((opts && opts.path) || activeTabPath.value)) {
            if (!silent) showToast('Écriture en cours sur ce fichier : sauvegarde refusée', 'info');
            return;
        }
        // capturer le path UNE SEULE FOIS. Si l'utilisateur
        // change d'onglet pendant le `await fetchAuth` (cas très réaliste
        // avec l'autosave silencieux), `activeTabPath.value` pointera sur
        // un autre fichier au retour de l'await. Tout ce qui suit doit
        // utiliser `path` — sinon on écrasait la détection « dirty » du
        // NOUVEL onglet avec le contenu de l'ANCIEN.
        //
        // honorer un path explicite passé par
        // l'appelant (ex: _scheduleAutoSave qui capture le path AU MOMENT de
        // la frappe, switchTab qui flush l'onglet qu'on quitte). Sans ça le
        // timer d'autosave ciblait toujours l'onglet ACTIF au fire, pas
        // celui où la frappe avait eu lieu → on sauvait le mauvais onglet
        // (ou rien) après un switch rapide.
        const path = (opts && opts.path) || activeTabPath.value;
        // Visualiseur (image, hex, aperçu Office) : rien d'éditable.
        if (officeIsViewerPath(path)) {
            if (!silent) showToast('Lecture seule', 'info');
            return;
        }
        // Refuse de sauvegarder les onglets read-only. Deux cas :
        // .docx (sauver le texte extrait écraserait le binaire ZIP → perte
        // du formatting) et consultation d'un diff de commit (le model
        // affiche le contenu HISTORIQUE — sauver écraserait le disque avec
        // l'ancienne version). Le message ne mentionne .docx que pour les
        // .docx — avant, un .py verrouillé par le diff git recevait le toast
        // mensonger « (.docx) ».
        if (_isReadOnlyTab(path)) {
            if (!silent) {
                const _why = _resolveFileViewMode(path) === 'docx'
                    ? 'Fichier en lecture seule (.docx) — sauvegarde refusée'
                    : (fileFormats[path] && fileFormats[path].lossy)
                    ? 'Encodage non UTF-8 : lecture seule (l\'enregistrement corromprait les accents)'
                    : (_binaryRefused.has(path)
                        ? 'Fichier binaire sur disque — sauvegarde refusée'
                        : 'Onglet en lecture seule (consultation d\'un diff de commit) — rechargez le fichier depuis l\'arborescence pour rééditer');
                showToast(_why, 'error');
            }
            return;
        }
        if (!_modelOk(path)) {
            if (!silent) showToast('Modèle non disponible', 'error');
            return;
        }
        // RACE (autosave vs Ctrl+S / deux autosaves) : un seul save en vol par
        // fichier. Audit éditeur 2026-09-23 (E1) : un Ctrl+S tombé pendant un
        // enregistrement en vol était AVALÉ (et le toast « Sauvegardé ! » du
        // premier laissait croire que la frappe était partie). Désormais il
        // attend la fin du premier puis repart — une seule reprise en file
        // par fichier, qui prend le contenu le plus récent.
        if (_savingPaths.has(path)) {
            let q = _saveQueued.get(path);
            if (!q) {
                q = { silent, force, promise: null };
                q.promise = (_savingPromises.get(path) || Promise.resolve())
                    .then(() => { _saveQueued.delete(path); return saveEditorContent(Object.assign({}, opts, { path, silent: q.silent, force: q.force })); });
                _saveQueued.set(path, q);
            } else {
                q.silent = q.silent && silent;           // un geste explicite l'emporte
                q.force = q.force || force;
            }
            return q.promise;
        }
        // Conflit disque déjà signalé : l'enregistrement AUTOMATIQUE ne
        // réessaie pas en boucle (il échouerait à chaque frappe) — seul un
        // geste explicite (Ctrl+S, Écraser) tranche.
        if (silent && !force && diskConflicts.value[path]) return;
        _savingPaths.add(path);
        let _releaseSave;
        _savingPromises.set(path, new Promise(r => { _releaseSave = r; }));
        // Conflit 412 à présenter APRÈS la libération du verrou ci-dessous :
        // ouverte sous verrou, la fenêtre rendait son « Écraser » inopérant
        // (l'enregistrement forcé butait sur ``_savingPaths`` et sortait sans
        // un mot) et pouvait laisser le fichier verrouillé pour de bon.
        let _conflictToPrompt = null;
        const content = models[path].getValue();
        // Précondition : empreinte (sha256) de la version disque sur laquelle
        // l'onglet est fondé, à défaut son mtime. Omise pour « Écraser »
        // (``force``) ou si inconnue.
        const _base = fileMtimes.value[path];
        const _fmt = fileFormats[path];
        // BOM mémorisé à l'ouverture : réinjecté, sinon l'enregistrement le
        // retirait (E15).
        const _body = { path: path, content: (_fmt && _fmt.bom) ? '\uFEFF' + content : content };
        if (opts && opts.source) _body.source = opts.source;
        else if (_restorePending.has(path)) _body.source = 'restore';
        if (!force) {
            if (fileShas[path]) _body.expected_sha256 = fileShas[path];
            else if (typeof _base === 'number') _body.expected_mtime = _base;
        }
        try {
            const res = await fetchAuth(_sbUrl('save'), {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(_body),
            });
            if (res && res.ok) {
                // lire le mtime que le backend renvoie maintenant
                // pour éviter d'utiliser Date.now() côté client (cause de
                // faux positifs "modifié sur disque" quand l'horloge
                // navigateur dérive de l'horloge serveur de plus d'1s).
                let respMtime = null, respSha = null;
                try {
                    const respData = await res.clone().json();
                    if (respData && typeof respData.mtime === 'number') respMtime = respData.mtime;
                    if (respData && typeof respData.sha256 === 'string') respSha = respData.sha256;
                } catch (_) { /* corps illisible : base inconnue, cf. plus bas */ }
                originalFileContent[path] = content;
                // Le point « non sauvegardé » de l'onglet est piloté par
                // ``dirtyTabs`` (recalculé via _tabIsDirty depuis la baseline
                // ci-dessus). On le rafraîchit explicitement : pour un save
                // d'onglet INACTIF (autosave ciblé, flush à la fermeture),
                // ``isEditorDirty`` n'est pas touché plus bas, donc son watcher
                // ne déclenche pas le refresh — le point resterait ambre malgré
                // le save réussi. Couvre aussi l'onglet actif (déterministe,
                // sans dépendre du changement de valeur d'isEditorDirty).
                _scheduleDirtyRefresh();
                // isEditorDirty suit l'onglet ACTIF : ne le clear (ni
                // rafraîchir le diff) que si l'utilisateur n'a pas changé
                // d'onglet pendant le save.
                // Frappe pendant le vol : l'onglet reste modifié (E12) — avant,
                // le drapeau repassait à false et le mode « à la perte de
                // focus » n'enregistrait plus la suite.
                const _stillDirty = _modelOk(path) && models[path].getValue() !== content;
                if (path === activeTabPath.value) {
                    isEditorDirty.value = _stillDirty;
                    if (isDiffView.value) updateDiffView();
                }
                if (!silent) showToast(_stillDirty ? 'Sauvegardé — modifications plus récentes à enregistrer' : 'Sauvegardé !');
                refreshPreview();
                scheduleLint(path, content);
                _gitAutoRefresh();
                // Refresh mtime tracké après save pour éviter
                // l'auto-notif "modifié sur disque" sur notre propre save.
                // Utilise le mtime serveur si disponible (cas
                // nominal), sinon fallback approximatif sur Date.now().
                // Base = ce que le serveur dit avoir écrit. Plus de repli
                // ``Date.now()`` (E21) : il garantissait un faux 412 ensuite ;
                // à défaut, l'empreinte du contenu envoyé fait foi.
                if (!respSha) {
                    try { respSha = await _sha256Hex(_body.content); } catch (_) { respSha = null; }
                }
                _setBase(path, respMtime, respSha);
                _restorePending.delete(path);
                _mapSet(diskConflicts, path, null);
                // Vue Historique ouverte : la nouvelle version y apparaît.
                if (explorerTab.value === 'history') loadHistorySession();
                // Enregistrer = trancher en faveur du contenu de l'onglet :
                // la copie mise de côté lors d'une écriture de l'assistant n'a
                // plus d'objet.
                _mapSet(assistantStash, path, null);
                _scheduleScmRefresh(path);
                // Refresh du quota sandbox après save : le
                // fichier vient de changer de taille sur disque, on
                // rafraîchit le taux de remplissage (debouncé).
                scheduleQuotaRefresh();
            } else if (!res) {
                // fetchAuth rend null sur 401 ou panne réseau et affiche DÉJÀ
                // son propre message ; un second toast (« Session expirée »,
                // faux sur une coupure réseau) brouillait la cause (E22). Le
                // contenu reste dans l'onglet, marqué modifié.
                if (!silent) showToast('Non enregistré — le contenu reste dans l\'onglet', 'error');
            } else if (res.status === 503) {
                // Contrat backend (_sandbox_exec) : container sandbox
                // arrêté/mort = 503. Le backend a déjà tenté ensure_running
                // + un retry — si on arrive ici, le redémarrage a échoué ou
                // est encore en cours. On invalide le cache positif de
                // readiness (sinon même rouvrir le terminal ne re-vérifierait
                // pas l'état réel) et on parle à l'utilisateur en langage
                // utilisateur, pas en instruction d'API. L'onglet reste
                // dirty : un simple Ctrl+S retente (et relance le container).
                _sandboxInitPromise = null;
                showToast('Environnement sandbox indisponible — redémarrage en cours, réessayez dans quelques instants (le fichier reste ouvert, rien n\'est perdu)', 'error');
            } else if (res.status === 412) {
                // Le disque a bougé depuis la version de l'onglet (terminal,
                // outil de l'assistant, git…) : on n'écrase PAS en silence.
                const errData = await res.json().catch(() => ({}));
                const det = (errData && errData.detail) || {};
                if (det.unreadable) {
                    // Fichier devenu illisible (droits changés dans le
                    // conteneur) : pas un conflit de contenu (E26).
                    showToast('« ' + path.split('/').pop() + ' » n\'est plus lisible (droits) : enregistrement refusé', 'error');
                    return;
                }
                _mapSet(diskConflicts, path, { mtime: det.mtime == null ? null : det.mtime, missing: !!det.missing });
                if (!silent) _conflictToPrompt = det;
            } else if (res.status === 409) {
                const errData = await res.json().catch(() => ({}));
                const _det = errData && errData.detail;
                if (_det && typeof _det === 'object' && (_det.code === 'is_dir' || _det.code === 'not_dir')) {
                    // Le chemin est devenu un dossier (ou un de ses parents un
                    // fichier) : rien n'est écrit (E25/E26).
                    _mapSet(diskConflicts, path, { mtime: null, missing: true });
                    showToast('« ' + path.split('/').pop() + ' » : '
                              + (_det.code === 'is_dir' ? 'c\'est désormais un dossier sur le disque' : 'un dossier parent est devenu un fichier')
                              + ' — enregistrement refusé', 'error');
                    return;
                }
                if (_det && typeof _det === 'object' && _det.code === 'exists') {
                    showToast(_det.message || 'Un fichier porte déjà ce nom', 'error');
                    return;
                }
                // Garde serveur : le fichier est (devenu) binaire sur disque.
                // L'onglet passe en lecture seule pour que l'autosave cesse
                // de réessayer (et de toaster) à chaque frappe.
                _binaryRefused.add(path);
                readOnlyTabs.value.add(path);
                if (activeTabPath.value === path) _applyActiveReadOnly();
                showToast((errData && typeof errData.detail === 'string' && errData.detail)
                          || 'Fichier binaire : sauvegarde refusée', 'error');
            } else {
                const errData = await res.json().catch(() => ({}));
                showToast(errData.detail || 'Erreur sauvegarde', 'error');
            }
        } catch(e) {
            showToast('Erreur réseau', 'error');
        } finally {
            _savingPaths.delete(path);
            _savingPromises.delete(path);
            _releaseSave();
        }
        if (_conflictToPrompt) await _promptSaveConflict(path, _conflictToPrompt);
    }
    // ── Historique de la session (2026-09-23) ────────────────────────────
    // Tout ce qui a été écrit pendant la session (vos enregistrements, les
    // write/edit de l'assistant, « Remplacer », les imports, les
    // restaurations) est gardé côté serveur par rapport à l'ORIGINAL — l'état
    // du fichier avant sa première modification de la session
    // (shared_infra/sandbox/file_history.py). Vue « Historique » de
    // l'explorateur : fichiers modifiés, versions, Comparer / Restaurer.
    const historySession = ref(null);        // { session, started, files }
    const historyEntries = ref({});          // { [path]: entrée | 'loading' }
    const historyLoading = ref(false);
    const _historyTexts = new Map();         // sha → texte (contenu adressé : immuable)
    const _restorePending = new Set();       // prochain enregistrement = « restauration »
    const HISTORY_SOURCES = { editor: 'Vous', assistant: 'Assistant', replace: 'Remplacer',
                              upload: 'Import', restore: 'Restauration', git: 'Git', shell: 'Commande', other: 'Externe' };

    async function loadHistorySession() {
        historyLoading.value = true;
        try {
            const res = await fetchAuth('/api/sandbox/history', {}, true);
            if (res && res.ok) historySession.value = await res.json();
            // Entrées dépliées : relues (de nouvelles versions ont pu arriver).
            for (const p of Object.keys(historyEntries.value)) _loadHistoryEntry(p);
        } catch (_) {}
        finally { historyLoading.value = false; }
    }
    function openHistoryPanel() {
        showEditorMore.value = false;
        explorerTab.value = 'history';
        showExplorer.value = true;
        loadHistorySession();
    }
    async function _loadHistoryEntry(path) {
        try {
            const res = await fetchAuth('/api/sandbox/history/file?path=' + encodeURIComponent(path), {}, true);
            if (!res || !res.ok) { _mapSet(historyEntries, path, null); return null; }
            const e = await res.json();
            e.versions = (e.versions || []).slice().reverse();      // plus récente d'abord
            _mapSet(historyEntries, path, e);
            return e;
        } catch (_) { _mapSet(historyEntries, path, null); return null; }
    }
    function toggleHistoryFile(path) {
        if (historyEntries.value[path]) { _mapSet(historyEntries, path, null); return; }
        _mapSet(historyEntries, path, 'loading');
        _loadHistoryEntry(path);
    }
    async function _historyText(sha) {
        if (_historyTexts.has(sha)) return _historyTexts.get(sha);
        const res = await fetchAuth('/api/sandbox/history/blob?sha=' + encodeURIComponent(sha), {}, true);
        if (!res || !res.ok) return null;
        const dec = _decodeText(new Uint8Array(await res.arrayBuffer()));
        if (_historyTexts.size > 64) _historyTexts.clear();
        _historyTexts.set(sha, dec.text);
        return dec.text;
    }
    function historyTime(ts) {
        if (!ts) return '';
        try { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
        catch (_) { return ''; }
    }
    // ``snap`` = { sha, exists, too_big } (original ou version).
    function _historySnapError(snap) {
        if (!snap) return 'Version introuvable';
        if (snap.too_big) return 'Version trop volumineuse pour être gardée';
        if (snap.unknown) return 'Contenu non relevé (modifié par une commande)';
        if (!snap.exists) return 'Le fichier n\'existait pas à ce moment';
        if (!snap.sha) return 'Version indisponible';
        return null;
    }
    async function historyCompare(path, snap) {
        const err = _historySnapError(snap);
        if (err) { showToast(err, 'info'); return; }
        const text = await _historyText(snap.sha);
        if (text === null) { showToast('Version illisible', 'error'); return; }
        const e = historyEntries.value[path];
        if (e && e.current && e.current.exists === false && !openTabs.value.some(t => t.path === path)) {
            showToast('Fichier supprimé : restaurez une version pour le comparer', 'info');
            return;
        }
        if (!openTabs.value.some(t => t.path === path)) await openFile(path, true, { quiet: true });
        showDiffForMessage(path, text, 'history');
    }
    async function historyRestore(path, snap) {
        const err = _historySnapError(snap);
        if (err) { showToast(err, 'info'); return; }
        const text = await _historyText(snap.sha);
        if (text === null) { showToast('Version illisible', 'error'); return; }
        const e = historyEntries.value[path];
        const missing = !!(e && e.current && e.current.exists === false);
        if (missing && !openTabs.value.some(t => t.path === path)) {
            // Fichier supprimé depuis : recréé tel quel (jamais par-dessus un
            // fichier réapparu entre-temps : ``if_absent``).
            const res = await fetchAuth(_sbUrl('save'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path, content: text, if_absent: true, source: 'restore' }),
            });
            if (res && res.ok) {
                showToast('« ' + path.split('/').pop() + ' » recréé');
                loadSandboxFiles();
                await openFile(path, true);
                loadHistorySession();
            } else if (res) {
                const d = await res.json().catch(() => ({}));
                showToast((d.detail && (d.detail.message || d.detail)) || 'Restauration impossible', 'error');
            }
            return;
        }
        if (!openTabs.value.some(t => t.path === path) || !_modelOk(path)) await openFile(path, true, { quiet: true });
        if (!_modelOk(path)) { showToast('Fichier non ouvrable', 'error'); return; }
        if (_isReadOnlyTab(path)) { showToast('Onglet en lecture seule', 'error'); return; }
        const m = models[path];
        if (m.getValue() !== text) _applyMinimalLineEdit(m, m.getValue(), text);
        _restorePending.add(path);
        if (activeTabPath.value !== path) await switchTab(path);
        isEditorDirty.value = _tabIsDirty(path);
        _scheduleDirtyRefresh();
        showToast('Version restaurée dans l\'onglet — Ctrl+S pour l\'enregistrer (annulable par Ctrl+Z)');
    }
    // « Diff depuis l'original » (menu « + ») : l'onglet actif comparé à son
    // état du début de session.
    async function toggleOriginalDiff() {
        showEditorMore.value = false;
        const path = activeTabPath.value;
        if (!path) return;
        if (isDiffView.value && diffBase.value === 'history') {
            isDiffView.value = false; diffBase.value = 'saved';
            nextTick(() => robustLayout());
            return;
        }
        const e = await _loadHistoryEntry(path);
        if (!e) { showToast('Aucune modification de ce fichier dans la session', 'info'); return; }
        await historyCompare(path, e.original);
    }

    // Enregistrements en vol / en file (E1).
    const _savingPromises = new Map();
    const _saveQueued = new Map();
    async function _sha256Hex(text) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Fenêtre de conflit à l'enregistrement.
    async function _promptSaveConflict(path, det) {
        const fname = path.split('/').pop();
        const missing = !!(det && det.missing);
        const choice = await ctx.openChoice(
            missing ? '« ' + fname + ' » a été supprimé du disque' : '« ' + fname + ' » a changé sur le disque',
            missing
                ? 'Enregistrer recréera le fichier avec le contenu de l\'onglet.'
                : 'Une autre modification (terminal, assistant, git…) a eu lieu depuis son ouverture.',
            missing
                ? [{ id: 'overwrite', label: 'Recréer', tone: 'primary' }]
                : [
                    { id: 'reload',    label: 'Recharger', tone: 'neutral' },
                    { id: 'compare',   label: 'Comparer',  tone: 'neutral' },
                    { id: 'overwrite', label: 'Écraser',   tone: 'danger' },
                  ]);
        if (choice === 'overwrite') await saveEditorContent({ path, force: true });
        else if (choice === 'compare') await conflictCompare(path);
        else if (choice === 'reload') await _reloadFromDisk(path);
    }

    // « Tout enregistrer » (menu « + », Ctrl+Alt+S).
    async function saveAllTabs() {
        showEditorMore.value = false;
        closeTabCtxMenu();
        const dirty = openTabs.value.map(t => t.path).filter(p => _tabIsDirty(p) && !officeIsViewerPath(p));
        if (!dirty.length) { showToast('Rien à enregistrer'); return; }
        for (const p of dirty) {
            try { await saveEditorContent({ path: p, silent: true }); } catch (_) {}
        }
        const left = dirty.filter(p => _tabIsDirty(p));
        if (!left.length) { showToast(dirty.length + ' fichier(s) enregistré(s)'); return; }
        // Cause par fichier (E20) : un conflit disque restait muet.
        const why = (p) => {
            const c = diskConflicts.value[p];
            if (c) return c.missing ? 'supprimé du disque' : 'modifié sur le disque';
            if (_isReadOnlyTab(p)) return 'lecture seule';
            return 'erreur';
        };
        showToast(left.length + ' fichier(s) non enregistré(s) : '
                  + left.map(p => p.split('/').pop() + ' (' + why(p) + ')').join(', '), 'error');
        // Premier conflit : on l'affiche, bandeau Comparer / Recharger / Écraser.
        const firstConflict = left.find(p => diskConflicts.value[p]);
        if (firstConflict && activeTabPath.value !== firstConflict) switchTab(firstConflict);
    }

    // « Formater le document » (Maj+Alt+F) pour Python : ruff format côté
    // serveur. Une erreur de syntaxe laisse le document intact.
    async function _formatPython(model) {
        if (!model || model.isDisposed()) return [];
        const path = Object.keys(models).find(k => models[k] === model) || 'file.py';
        try {
            const res = await fetchAuth(_sbUrl('format'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: model.getValue(), filename: path.split('/').pop() }),
            }, true);
            if (!res || !res.ok) {
                let msg = 'Formatage impossible';
                try { const d = await res.json(); if (d && typeof d.detail === 'string') msg = d.detail; } catch (_) {}
                showToast(msg, 'error');
                return [];
            }
            const d = await res.json();
            if (typeof d.content !== 'string' || d.content === model.getValue()) return [];
            return [{ range: model.getFullModelRange(), text: d.content }];
        } catch (_) {
            showToast('Formatage impossible', 'error');
            return [];
        }
    }

    // ==============================================================
    //  RUFF LINTER
    // ==============================================================

    async function lintCurrentFile(path, code) {
        if (!path || !path.endsWith('.py')) {
            if (window.monaco && models[path]) {
                window.monaco.editor.setModelMarkers(models[path], 'ruff', []);
            }
            return;
        }
        try {
            const res = await fetchAuth(_sbUrl('lint'), {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ content: code, filename: path.split('/').pop() }),
            });
            if (!res || !res.ok) return;
            const data = await res.json();
            if (!window.monaco || !models[path] || models[path].isDisposed()) return;
            const markers = (data.diagnostics || []).map(d => ({
                startLineNumber: d.row,
                startColumn:     d.col,
                endLineNumber:   d.end_row,
                endColumn:       d.end_col + 1,
                message:         `[${d.code}] ${d.message}`,
                severity:        d.severity,
                source:          'ruff',
            }));
            window.monaco.editor.setModelMarkers(models[path], 'ruff', markers);
        } catch(e) {}
    }

    function scheduleLint(path, code) {
        if (_lintTimer) clearTimeout(_lintTimer);
        // capturer (path, code) dans le closure du setTimeout.
        // Le bug était subtil : si l'utilisateur switche d'onglet rapidement
        // (Python A → JS B), scheduleLint était appelé avec path=B mais
        // _lintTimer existait encore pour A. clearTimeout l'annulait, mais
        // un timer pour B était créé. Pas de bug réel ici. Le bug réel est :
        // si scheduleLint(A) puis scheduleLint(A) avec un nouveau code en
        // <800ms, le 1er timer est cleared, le 2e tire — OK.
        // Le seul risque : models[path] disposé entre la planification et
        // l'exécution. lintCurrentFile vérifie déjà models[path] et
        // !isDisposed.
        const _path = path;
        const _code = code;
        _lintTimer = setTimeout(() => {
            _lintTimer = null;
            // Skip si l'éditeur a été teardown entre-temps
            if (!monacoRef.instance) return;
            // Pendant la frappe, le contenu est lu MAINTENANT (pas à chaque
            // touche : getValue() d'un gros fichier coûte).
            const code2 = (typeof _code === 'string') ? _code
                : (_modelOk(_path) ? models[_path].getValue() : '');
            lintCurrentFile(_path, code2);
        }, 800);
    }

    // ``disk`` ({ mtime, sha, bom, eol, lossy }) : décrit la version disque
    // dont ``content`` est le texte — lue dans la MÊME réponse (lot B).
    async function updateEditor(path, content, disk) {
        path = _canonSandboxPath(path);
        disk = disk || {};
        if (!settings.value.enable_editor) return;
        // Fichier affiché par un visualiseur : son « contenu texte » n'a pas de
        // sens (binaire décodé) — on rafraîchit l'aperçu à la place.
        if (officeIsViewerPath(path)) { await editorRefreshViewer(path); return; }

        // Ensure editor is open
        if (!showEditor.value) {
            // FEATURE — Auto-ouverture gardée par le setting utilisateur.
            // Même logique que dans ``_ensureFileInEditor`` : si l'user
            // a désactivé l'option dans Settings → Apparence → Éditeur →
            // "Ouvrir automatiquement", on bail out ici sans toucher au
            // layout. Le tool a déjà réussi côté backend (le fichier est
            // sur disque), seule la visualisation est sautée.
            //
            // Ce path (updateEditor) est le fallback non-streaming
            // utilisé par app-chat.js quand le décodeur de tool_call_delta
            // ne capture pas le stream (backend legacy, tool non-reconnu).
            // ``_ensureFileInEditor`` gère le path streaming. Les deux
            // doivent appliquer la même règle.
            if (settings.value.auto_open_editor_on_write === false) {
                return;
            }
            // Ouverture par le LLM → on ferme l'explorer pour laisser toute
            // la place au code (même UX que _ensureFileInEditor). Si l'user
            // était déjà dans l'éditeur, on ne touche à rien.
            showEditor.value   = true;
            showExplorer.value = false;
            await nextTick();
            loadSandboxFiles();
        }
        await initMonaco();
        if (!monacoRef.instance) return;

        editorMode.value = 'code';

        // Add tab if not present
        if (!openTabs.value.find(t => t.path === path)) {
            openTabs.value.push({ path, name: path.split('/').pop() });
        }
        activeTabPath.value  = path;
        editorFilePath.value = path;

        // Create or update model directly with the content we already have
        const lang = _getLang(path);
        _stashBeforeAssistantWrite(path);
        originalFileContent[path] = content;
        _mapSet(diskConflicts, path, null);

        if (!_modelOk(path)) {
            _dropModel(path);
            _ensureModel(path, content, lang);
        }

        // Set model in editor
        if (_modelOk(path)) {
            try { monacoRef.instance.setModel(models[path]); } catch(_) {}
        }
        robustLayout();

        // Apply as a MINIMAL LINE EDIT rather than full setValue():
        //   - unchanged regions keep their cursor and scroll position
        //   - Monaco undo stack stays granular
        //   - we know exactly which lines changed, so we can highlight them
        const model = models[path];
        if (!model || model.isDisposed()) return;

        _syncModelEol(model, disk.eol);
        const currentVal = model.getValue();
        if (currentVal === content) {
            // Still refresh the dirty flag and preview for consistency
            _adoptDisk(path, disk);
            isEditorDirty.value = false;
            refreshPreview();
            if (path.toLowerCase().endsWith('.html')) previewPath.value = path;
            return;
        }

        const changeRange = _applyMinimalLineEdit(model, currentVal, content);
        _adoptDisk(path, disk);
        isEditorDirty.value = false;

        // Flash the changed lines (yellow gutter bar + background, 3s fade)
        // and scroll to the first edited line instead of the top of the file.
        if (changeRange) {
            _flashChangedLines(model, changeRange);
            try {
                if (monacoRef.instance && monacoRef.instance.getModel() === model) {
                    monacoRef.instance.revealLineInCenter(changeRange.startLine);
                }
            } catch(_) {}
        } else {
            // Full-setValue fallback path (rare): go back to the classic
            // "reveal top" behaviour so we don't leave the viewport random.
            try {
                if (monacoRef.instance && monacoRef.instance.getModel() === model) {
                    monacoRef.instance.revealPositionInCenter({ lineNumber: 1, column: 1 });
                }
            } catch(_) {}
        }

        refreshPreview();
        if (path.toLowerCase().endsWith('.html')) previewPath.value = path;
    }

    // ==============================================================
    //  TOOL-STREAMING WRITE  (write_file / edit_file → Monaco live)
    // ==============================================================
    //
    //  Les méthodes ci-dessous sont appelées depuis app-chat.js quand un
    //  tool_call_delta arrive pour un outil d'écriture. Le frontend les
    //  invoque dans cet ordre :
    //    1. streamOpenForWrite(path, { append })           — write_file
    //       OU streamLocateEdit(path, { action, ... })     — edit_file
    //    2. streamWriteChunk(path, chunk)  (plusieurs fois)
    //    3. streamFinalize(path, { success, finalContent })
    //
    //  État par path, stocké dans `_writeStreams`. Un seul stream actif
    //  par fichier à la fois (si un deuxième tool_call arrive pour le même
    //  path, le précédent est d'abord finalisé).
    //
    //  Auto-scroll : Monaco revealPosition suit le curseur d'insertion.
    //  Si l'utilisateur clique / scrolle ailleurs pendant le stream on
    //  NE force PAS le scroll (respect de l'utilisateur), détection via
    //  _writeStreams[path].userGrabbed.
    // ==============================================================

    const _writeStreams = Object.create(null);  // path → stream state

    // Clé CANONIQUE d'onglet/modèle pour tout chemin venant d'un outil.
    // Le LLM peut émettre "repo/f.py", "./repo/f.py", "/work/repo/f.py" ou
    // le chemin hôte absolu, et le tool_result renvoie sa propre forme :
    // sans normalisation, le stream ouvre l'onglet sous une clé et la
    // réconciliation en ouvre un DEUXIÈME sous une autre (bug « deux
    // onglets du même fichier » après un retry). Une seule forme : le
    // chemin relatif sandbox, comme l'arbre de fichiers.
    function _canonSandboxPath(p) {
        if (!p) return p;
        return window.elpisCanonPath(p, settings.value.sandbox_path_display);
    }

    async function _ensureFileInEditor(path, initialContent) {
        // Même préambule que updateEditor : ouvre l'éditeur, crée l'onglet,
        // prépare le modèle. Retourne le model ou null si échec.
        if (!settings.value.enable_editor) return null;
        // Pas d'écriture streamée dans un visualiseur (le résultat d'outil
        // rafraîchira l'aperçu via editorRefreshViewer).
        if (officeIsViewerPath(path)) return null;
        if (!showEditor.value) {
            // FEATURE — Si l'utilisateur a désactivé l'auto-ouverture
            // de l'éditeur sur écriture du LLM (Settings → Apparence →
            // Éditeur → Ouvrir automatiquement), on bail out ici sans
            // ouvrir le panneau ni créer de modèle Monaco. Le tool
            // write_file / edit_file réussit côté backend (le fichier
            // est bien écrit sur disque via le MCP), seule la
            // visualisation streaming est sautée. L'utilisateur peut
            // ouvrir l'éditeur plus tard pour voir le résultat.
            //
            // Défaut : true (auto-open) — comportement historique préservé.
            if (settings.value.auto_open_editor_on_write === false) {
                return null;
            }
            // L'user n'était pas dans l'éditeur — on l'ouvre pour lui et on
            // ferme l'explorer par la même occasion, pour maximiser la place
            // réservée au code streamé (effet "j'ai cliqué sur Play,
            // regardez-moi coder"). Si l'user était DÉJÀ dans l'éditeur
            // avec l'explorer ouvert, on ne touche pas à son layout.
            showEditor.value   = true;
            showExplorer.value = false;
            await nextTick();
            loadSandboxFiles();
        }
        await initMonaco();
        if (!monacoRef.instance) return null;

        editorMode.value = 'code';

        if (!openTabs.value.find(t => t.path === path)) {
            openTabs.value.push({ path, name: path.split('/').pop() });
        }
        activeTabPath.value  = path;
        editorFilePath.value = path;

        const lang = _getLang(path);
        // Si le modèle n'existe pas, on le crée avec `initialContent` (0 = vide).
        // S'il existe déjà (user a ouvert le fichier avant), on le réutilise tel quel.
        //
        // try/catch autour de _ensureModel : même
        // si _ensureModel a son propre garde-fou, on protège ici en
        // double pour éviter qu'une exception inattendue (cas exotique
        // de path) ne remonte jusqu'à streamOpenForWrite/streamLocateEdit
        // et casse la boucle de tool_call_delta.
        if (!_modelOk(path)) {
            _dropModel(path);
            try {
                _ensureModel(path, initialContent || '', lang);
            } catch (e) {
                console.warn('[editor] _ensureModel a échoué pour', path, e);
                return null;
            }
        }
        if (_modelOk(path)) {
            try { monacoRef.instance.setModel(models[path]); } catch(_) {}
        }
        robustLayout();
        return _modelOk(path) ? models[path] : null;
    }

    // L'assistant va réécrire ``path`` : si l'onglet porte des modifications
    // NON ENREGISTRÉES, on en garde une copie (bandeau Restaurer / Comparer).
    // Le fichier disque, lui, reçoit l'écriture de l'assistant quoi qu'il
    // arrive — c'est l'outil qui écrit, l'éditeur ne fait que la montrer.
    function _stashBeforeAssistantWrite(path) {
        if (!_modelOk(path) || !_tabIsDirty(path)) return;
        // Une copie existe ET un flux écrit encore : c'est la MÊME écriture
        // (le modèle porte du texte partiel de l'assistant) — on garde la
        // copie. Hors flux, un onglet modifié porte forcément du texte de
        // l'UTILISATEUR (une écriture terminée laisse l'onglet propre) : on
        // prend la copie la plus récente. L'ancien garde « copie déjà prise »
        // laissait une 2e écriture de l'assistant effacer sans filet ce que
        // l'utilisateur avait tapé après la première.
        const prev = assistantStash.value[path];
        if (prev && isStreamActive(path)) return;
        const cur = models[path].getValue();
        if (prev && prev.content === cur) return;
        _mapSet(assistantStash, path, { content: cur, ts: Date.now() });
    }

    function _attachStreamScrollWatch(state, path) {
        // Détecte si l'utilisateur scrolle / clique manuellement pendant le
        // stream → on coupe l'auto-reveal pour ne pas lui voler le viewport.
        //
        // Heuristique : tant qu'un applyEdits/reveal est en cours (ou l'était
        // dans les 200ms précédents), on considère le scroll comme "interne".
        // Ça couvre les scrolls déclenchés IMPLICITEMENT par Monaco suite à
        // un applyEdits (auto-follow du curseur d'insertion quand le texte
        // s'étend hors viewport) — que le bool _internalScroll manquait.
        // Au-delà de 200ms sans action interne : scroll = utilisateur.
        if (!monacoRef.instance) return;
        state._lastInternalAction = Date.now();
        state._scrollDisp = monacoRef.instance.onDidScrollChange(() => {
            if (!state.active) return;
            const sinceInternal = Date.now() - (state._lastInternalAction || 0);
            if (sinceInternal < 200) return;    // scroll induit par nos edits/reveal
            state.userGrabbed = true;
        });
    }

    function _markInternalAction(state) {
        state._lastInternalAction = Date.now();
    }

    function _revealStreamCursor(state) {
        if (state.userGrabbed) return;
        if (!monacoRef.instance) return;
        const m = models[state.path];
        if (!m || m.isDisposed() || monacoRef.instance.getModel() !== m) return;
        try {
            _markInternalAction(state);
            // `revealPosition` scrolle MINIMUM pour garder le curseur
            // visible ET proche du bord bas quand on écrit vers le bas.
            // Previously : revealPositionInCenterIfOutsideViewport — mais
            // celui-ci ne scrolle QUE quand le curseur sort du viewport,
            // ce qui n'arrive jamais en typewriter continu (la scrollbar
            // restait figée jusqu'à ce que l'user scrolle à la main).
            // revealPosition = toujours scroll minimal, comme un vrai
            // éditeur qui suit le curseur.
            monacoRef.instance.revealPosition({
                lineNumber: state.curLine,
                column:     state.curCol,
            });
        } catch(_) {}
    }

    /**
     * Prépare le streaming d'un write_file (fichier complet).
     * @param {string} path
     * @param {object} opts — { append: bool, preloadContent: string | null }
     *   preloadContent : contenu connu déjà depuis l'état serveur (optionnel) ;
     *   utilisé pour initialiser le modèle en mode append si l'utilisateur
     *   n'a pas encore ouvert le fichier. Null = on ne précharge pas.
     */
    async function streamOpenForWrite(path, opts = {}) {
        // try/catch global. Avant, une exception dans
        // _ensureFileInEditor (via _ensureModel sur path malformé) remontait
        // ici puis vers le caller (_handleToolCallDelta dans app-chat.js)
        // qui la log mais re-tente quand même au prochain delta → boucle
        // d'erreurs en console pour chaque chunk du LLM. Maintenant on
        // contient l'erreur ici et on retourne false proprement.
        try {
            path = _canonSandboxPath(path);
            if (!path || !settings.value.enable_editor) return false;
            const append = !!opts.append;

            // Finaliser un stream précédent sur ce path (edge case).
            if (_writeStreams[path] && _writeStreams[path].active) {
                await streamFinalize(path, { success: false });
            }

            // L'onglet existait-il AVANT le stream ? Si c'est le stream qui
            // le crée et que l'écriture échoue, streamFinalize le retirera
            // (pas d'onglet fantôme sur un fichier inexistant).
            const tabExisted = openTabs.value.some(t => t.path === path);
            // Le contenu d'avant n'est CONNU que si le modèle existait déjà ou
            // a été préchargé depuis le disque : un modèle créé vide pour un
            // écrasement ne dit rien du fichier (l'ancien diff montrait alors
            // tout le fichier comme ajouté).
            const preKnown = !!(models[path] && !models[path].isDisposed())
                || typeof opts.preloadContent === 'string';
            _stashBeforeAssistantWrite(path);

            const model = await _ensureFileInEditor(path, opts.preloadContent || '');
            if (!model) return false;

            // Snapshot AVANT toute modification (utilisé pour revert + diff UI)
            const preSnapshot = model.getValue();
            const preOriginal = originalFileContent[path];

            let startLine, startCol;
            if (append) {
                // Cursor en fin de fichier
                startLine = model.getLineCount();
                startCol  = model.getLineMaxColumn(startLine);
            } else {
                // Mode write : on vide tout le modèle et on part de (1,1)
                try {
                    const lastLine = model.getLineCount();
                    const lastCol  = model.getLineMaxColumn(lastLine);
                    model.applyEdits([{
                        range: new monaco.Range(1, 1, lastLine, lastCol),
                        text:  '',
                    }]);
                } catch(_) { return false; }
                startLine = 1;
                startCol  = 1;
            }

            const state = {
                path, kind: append ? 'write_append' : 'write_full',
                createdTab: !tabExisted,
                preSnapshot, preOriginal, preKnown,
                curLine: startLine, curCol: startCol,
                // startLineStream : ligne de DÉBUT du bloc modifié. Utilisée
                // par streamFinalize pour appliquer le surlignage jaune (flash)
                // sur l'ensemble du bloc écrit — même effet visuel que
                // `_flashChangedLines` en v1 du flow updateEditor.
                startLineStream: startLine,
                active: true, userGrabbed: false,
                _scrollDisp: null, _lastInternalAction: Date.now(),
            };
            _writeStreams[path] = state;
            isTypingEffect.value = true;
            // Seulement pour l'onglet streamé (E12) : un stream vers un AUTRE
            // fichier effaçait le « modifié » de l'onglet en cours d'édition.
            if (activeTabPath.value === path) isEditorDirty.value = false;

            // IMPORTANT : attach watch AVANT le reveal initial pour que l'event
            // de scroll déclenché par revealPositionInCenter soit absorbé par
            // la fenêtre temporelle _lastInternalAction. Sans ça, selon les
            // versions de Monaco le watch pouvait ne pas être encore attaché
            // au moment du reveal (ordre OK) OU l'être et le reveal suivant
            // déclencher userGrabbed après conso du bool.
            _attachStreamScrollWatch(state, path);

            // Scroll au point de départ
            try {
                _markInternalAction(state);
                monacoRef.instance.revealPositionInCenter({
                    lineNumber: startLine, column: startCol,
                });
            } catch(_) {}

            return true;
        } catch (e) {
            console.warn('[editor] streamOpenForWrite a échoué pour', path, e);
            // En cas d'exception, s'assurer qu'on n'a pas laissé un état
            // partiel (isTypingEffect bloqué, _writeStreams orphelin).
            isTypingEffect.value = false;
            const st = _writeStreams[path];
            if (st) {
                if (st._scrollDisp) {
                    try { st._scrollDisp.dispose(); } catch(_) {}
                    st._scrollDisp = null;
                }
                st.active = false;
                delete _writeStreams[path];
            }
            return false;
        }
    }

    /**
     * Prépare le streaming d'un edit_file (édition chirurgicale).
     * @param {string} path
     * @param {object} spec — { action, old_str?, start_line?, end_line?,
     *                          preloadContent? }
     *
     * Actions supportées :
     *   'str_replace' : trouve `old_str` dans le modèle, le supprime, place
     *                   le curseur à l'emplacement → stream du new_str.
     *   'replace'     : supprime les lignes [start_line..end_line] et place
     *                   le curseur au début → stream du content.
     *   'insert'      : place le curseur au début de start_line (0 = top,
     *                   -1 = fin de fichier) → stream du content en insertion.
     *
     * Retourne true si on a pu localiser la zone (stream possible),
     * false sinon (le caller doit fallback sur le flux tool_result classique).
     */
    async function streamLocateEdit(path, spec = {}) {
        // try/catch global, comme streamOpenForWrite.
        // Garantit qu'on ne propage jamais d'exception au handler de
        // tool_call_delta côté chat (qui retenterait à chaque chunk).
        try {
            path = _canonSandboxPath(path);
            if (!path || !settings.value.enable_editor) return false;
            const action = (spec.action || '').toLowerCase();

            if (_writeStreams[path] && _writeStreams[path].active) {
                await streamFinalize(path, { success: false });
            }

            const tabExisted = openTabs.value.some(t => t.path === path);
            _stashBeforeAssistantWrite(path);

            const model = await _ensureFileInEditor(path, spec.preloadContent || '');
            if (!model) return false;

            const preSnapshot = model.getValue();
            const preOriginal = originalFileContent[path];
            let startLine = 1, startCol = 1;

            try {
                if (action === 'str_replace') {
                    const oldStr = String(spec.old_str || '');
                    if (!oldStr) return false;
                    // Si le modèle est vide (user n'avait pas ouvert le fichier)
                    // on ne peut pas localiser old_str → fallback.
                    if (!preSnapshot) return false;
                    const matches = model.findMatches(
                        oldStr, true, false, true, null, false,
                    );
                    if (!matches || matches.length === 0) return false;
                    // Première occurrence (comportement par défaut de edit_file count=1).
                    const r = matches[0].range;
                    model.applyEdits([{ range: r, text: '' }]);
                    startLine = r.startLineNumber;
                    startCol  = r.startColumn;
                } else if (action === 'replace') {
                    const s = Math.max(1, parseInt(spec.start_line, 10) || 1);
                    const e = Math.max(s, parseInt(spec.end_line, 10) || s);
                    const lineCount = model.getLineCount();
                    const sClamped = Math.min(s, lineCount);
                    const eClamped = Math.min(e, lineCount);
                    const endCol   = model.getLineMaxColumn(eClamped);
                    model.applyEdits([{
                        range: new monaco.Range(sClamped, 1, eClamped, endCol),
                        text:  '',
                    }]);
                    startLine = sClamped; startCol = 1;
                } else if (action === 'insert') {
                    let s = parseInt(spec.start_line, 10);
                    if (isNaN(s)) s = 0;
                    const lineCount = model.getLineCount();
                    if (s === 0) {
                        // Prepend : curseur en (1,1), on insère un \n à la fin du stream
                        startLine = 1; startCol = 1;
                    } else if (s === -1 || s > lineCount) {
                        // Append : fin de fichier, préfixer par \n si le dernier
                        // caractère n'est pas déjà un newline.
                        const lastLine = Math.max(lineCount, 1);
                        const lastCol  = model.getLineMaxColumn(lastLine);
                        const lastLineText = model.getLineContent(lastLine);
                        if (lastLineText.length > 0) {
                            // Ajoute un saut de ligne avant de commencer à streamer
                            model.applyEdits([{
                                range: new monaco.Range(lastLine, lastCol, lastLine, lastCol),
                                text:  '\n',
                            }]);
                            startLine = lastLine + 1; startCol = 1;
                        } else {
                            startLine = lastLine; startCol = 1;
                        }
                    } else {
                        // Insert avant la ligne s : on place le curseur en (s, 1)
                        // et on insère — les lignes existantes sont poussées.
                        startLine = Math.min(s, lineCount); startCol = 1;
                    }
                } else {
                    // action='delete' ou inconnu → pas de streaming nécessaire
                    return false;
                }
            } catch(_) { return false; }

            const state = {
                path, kind: 'edit_' + action,
                createdTab: !tabExisted,
                preSnapshot, preOriginal,
                curLine: startLine, curCol: startCol,
                // startLineStream : ligne de DÉBUT du bloc modifié, pour le
                // flash jaune de fin. Pour les edits, c'est la ligne où le
                // curseur se place après avoir supprimé/ouvert la zone.
                startLineStream: startLine,
                active: true, userGrabbed: false,
                _scrollDisp: null, _lastInternalAction: Date.now(),
            };
            _writeStreams[path] = state;
            isTypingEffect.value = true;
            // Seulement pour l'onglet streamé (E12) : un stream vers un AUTRE
            // fichier effaçait le « modifié » de l'onglet en cours d'édition.
            if (activeTabPath.value === path) isEditorDirty.value = false;

            // IMPORTANT : attach watch AVANT le reveal initial (voir commentaire
            // dans streamOpenForWrite).
            _attachStreamScrollWatch(state, path);

            // Scroll AVANT de commencer à taper : l'user voit où ça va écrire.
            // `revealPositionInCenter` force le scroll même si le point est
            // déjà dans le viewport — indispensable pour montrer à l'user
            // "c'est ICI que ça va être édité".
            try {
                _markInternalAction(state);
                monacoRef.instance.revealPositionInCenter({
                    lineNumber: startLine, column: startCol,
                });
            } catch(_) {}

            return true;
        } catch (e) {
            console.warn('[editor] streamLocateEdit a échoué pour', path, e);
            isTypingEffect.value = false;
            const st = _writeStreams[path];
            if (st) {
                if (st._scrollDisp) {
                    try { st._scrollDisp.dispose(); } catch(_) {}
                    st._scrollDisp = null;
                }
                st.active = false;
                delete _writeStreams[path];
            }
            return false;
        }
    }

    /**
     * Insère un fragment à la position courante du stream.
     *
     * Les chunks reçus du LLM sont bufferisés dans `state.pendingChunk` et
     * flushés vers Monaco en lots coalescés via requestAnimationFrame. Deux
     * bénéfices : (1) on évite N applyEdits/layouts Monaco par token
     * (catastrophique sur les gros fichiers), (2) la taille de lot grandit
     * avec le backlog pour que le typewriter ne prenne pas de retard sur
     * le LLM — la vitesse visible s'adapte à la vitesse d'émission.
     *
     * Tuning :
     *   - MIN_FLUSH    : plancher pour garder un effet typewriter visible
     *   - MAX_FLUSH    : plafond par frame pour éviter un jank si 10000+
     *                    chars attendent. Au-delà on étale sur plusieurs
     *                    frames mais chaque frame reste fluide.
     *   - SPEEDUP      : facteur de rattrapage. À backlog=300, on flush
     *                    ceil(300/SPEEDUP) par frame → on rattrape vite
     *                    sans tout insérer d'un coup.
     */
    const TYPEWRITER_MIN_FLUSH = 2;
    const TYPEWRITER_MAX_FLUSH = 4096;
    const TYPEWRITER_SPEEDUP   = 3;     // flushSize ≈ backlog / SPEEDUP

    function streamWriteChunk(path, chunk) {
        const state = _writeStreams[_canonSandboxPath(path)];
        if (!state || !state.active || !chunk) return;
        state.pendingChunk = (state.pendingChunk || '') + chunk;
        _scheduleStreamFlush(state);
    }

    function _applyStreamChunkSync(state, chunk) {
        // Applique `chunk` au modèle à la position courante, avance le
        // curseur, scroll. Retourne false si le modèle est mort.
        const model = models[state.path];
        if (!model || model.isDisposed()) { state.active = false; return false; }
        // Marque l'action AVANT applyEdits — Monaco peut déclencher un
        // onDidScrollChange pendant l'edit (auto-follow quand le texte
        // s'étend hors viewport). On veut que ce scroll soit vu comme
        // interne et pas comme une intervention utilisateur.
        _markInternalAction(state);
        try {
            model.applyEdits([{
                range: new monaco.Range(
                    state.curLine, state.curCol,
                    state.curLine, state.curCol,
                ),
                text: chunk,
                forceMoveMarkers: true,
            }]);
        } catch(_) { state.active = false; return false; }

        const nl = (chunk.match(/\n/g) || []).length;
        if (nl > 0) {
            state.curLine += nl;
            const lastNl = chunk.lastIndexOf('\n');
            state.curCol  = (chunk.length - lastNl - 1) + 1;
        } else {
            state.curCol += chunk.length;
        }
        _revealStreamCursor(state);
        return true;
    }

    function _scheduleStreamFlush(state) {
        if (state._flushScheduled) return;
        state._flushScheduled = true;
        const doFlush = () => {
            state._flushScheduled = false;
            if (!state.active) { state.pendingChunk = ''; return; }
            const buf = state.pendingChunk || '';
            if (!buf) return;

            // Taille de lot = max(MIN, ceil(backlog / SPEEDUP)), plafonné à MAX
            let flushSize = Math.ceil(buf.length / TYPEWRITER_SPEEDUP);
            if (flushSize < TYPEWRITER_MIN_FLUSH) flushSize = TYPEWRITER_MIN_FLUSH;
            if (flushSize > TYPEWRITER_MAX_FLUSH) flushSize = TYPEWRITER_MAX_FLUSH;
            if (flushSize > buf.length)           flushSize = buf.length;

            const toApply   = buf.substring(0, flushSize);
            state.pendingChunk = buf.substring(flushSize);
            _applyStreamChunkSync(state, toApply);

            // Reste à flusher → re-schedule sur la prochaine frame. Ça
            // continue jusqu'à ce que pendingChunk soit vidé, même sans
            // nouveau delta LLM (important en fin de stream).
            if (state.pendingChunk.length > 0 && state.active) {
                _scheduleStreamFlush(state);
            }
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(doFlush);
        } else {
            setTimeout(doFlush, 16);
        }
    }

    function _drainStreamSync(state) {
        // Flush synchrone de tout ce qui reste dans pendingChunk.
        // Utilisé par streamFinalize AVANT le reconcile pour garantir que
        // le modèle contient bien tout le contenu streamé au moment du diff.
        if (!state.pendingChunk) return;
        const buf = state.pendingChunk;
        state.pendingChunk = '';
        if (state.active) _applyStreamChunkSync(state, buf);
    }

    /**
     * Clôt le streaming d'un path.
     * @param {object} opts — { success: bool, finalContent?: string }
     *   success=false → revert au preSnapshot (tool a échoué / cancel).
     *   finalContent → si fourni et success, réconcilie via minimal-diff
     *                  pour garantir que Monaco = serveur (cas d'escapes
     *                  JSON exotiques ou edit_file où le backend a fait
     *                  des choses qu'on ne pouvait pas prédire côté client).
     */
    async function streamFinalize(path, opts = {}) {
        path = _canonSandboxPath(path);
        const state = _writeStreams[path];
        if (!state) return;
        const success = (opts.success !== false);

        // try/finally ultime garde-fou : peu importe ce qui
        // se passe pendant le drain ou la réconciliation (exception
        // Monaco, deadline dépassée, modèle disposé en plein flush…),
        // on garantit que les flags reactifs reviennent à leur état
        // neutre. Sans ça, isTypingEffect=true bloquait : sauvegarde,
        // openFile, switchTab — et l'utilisateur devait refresh.
        try {
            // Si succès : on attend que le rAF-loop drain naturellement le
            // buffer (effet typewriter visible jusqu'à la fin). Sans ça, les
            // éditions rapides (small edit_file dont le new_str fait quelques
            // dizaines de chars) sont streamées en <50ms → tool_result arrive
            // avant le 1er rAF → drain tout-en-un → pas d'effet typewriter.
            //
            // Plafond de sécurité : 2 secondes pour qu'un problème quelconque
            // (tab en arrière-plan, bug Monaco) ne bloque pas la finalisation.
            // Au-delà on force le drain sync.
            if (success) {
                const deadline = Date.now() + 2000;
                while (state.active
                       && (state.pendingChunk || state._flushScheduled)
                       && Date.now() < deadline) {
                    // Endormi 1 frame (~16ms). Le rAF continue à tourner et
                    // à flusher des lots adaptatifs pendant ce temps.
                    await new Promise(r =>
                        (typeof requestAnimationFrame === 'function')
                            ? requestAnimationFrame(() => r())
                            : setTimeout(r, 16)
                    );
                }
                // Dernier drain sync au cas où il resterait un résidu après
                // le plafond (extrêmement rare).
                _drainStreamSync(state);
            }

            state.active = false;
            if (state._scrollDisp) {
                try { state._scrollDisp.dispose(); } catch(_) {}
                state._scrollDisp = null;
            }
            delete _writeStreams[path];

            // Écriture ÉCHOUÉE sur un onglet que le stream avait lui-même
            // créé (fichier pas ouvert avant) : on retire l'onglet au lieu
            // de laisser un fantôme — pour un write_file de fichier NEUF,
            // il pointerait sur un fichier qui n'existe pas sur disque. Le
            // retry du LLM repassera par la même clé canonique (pas de
            // doublon) et recréera l'onglet proprement.
            if (!success && state.createdTab) {
                _dropModel(path);
                delete originalFileContent[path];
                openTabs.value = openTabs.value.filter(t => t.path !== path);
                if (activeTabPath.value === path) {
                    const last = openTabs.value[openTabs.value.length - 1];
                    if (last) {
                        try { await switchTab(last.path); } catch(_) {}
                    } else {
                        activeTabPath.value  = null;
                        editorFilePath.value = '';
                        try { monacoRef.instance && monacoRef.instance.setModel(null); } catch(_) {}
                    }
                }
                isEditorDirty.value = false;
                refreshPreview();
                return;
            }

            const model = models[path];
            if (!model || model.isDisposed()) {
                return;
            }

            if (!success) {
                // détection d'édition utilisateur depuis le snapshot
                // pré-stream. Si l'utilisateur a tapé du texte dans l'éditeur
                // PENDANT le stream (rare mais possible : stream en background,
                // user qui édite manuellement le fichier dans son onglet actif
                // pour un autre stream qui se prend une exception), un revert
                // brutal au preSnapshot écraserait son travail. On ne revert
                // que si le contenu courant correspond bien à ce que le stream
                // a écrit (présence des marqueurs streamés ou contenu très
                // proche du snapshot+chunks). Heuristique simple : si la
                // longueur a changé d'une façon NON-cohérente avec ce qu'on
                // a streamé, on assume édition manuelle et on skip le revert.
                const currentVal = model.getValue();
                // Tolérance : si le contenu courant === preSnapshot, rien à
                // revert (le stream n'avait rien écrit ou a été annulé tôt).
                if (currentVal !== state.preSnapshot) {
                    // Stream a modifié quelque chose. On revient au snapshot par
                    // édition MINIMALE (annulable, Ctrl+Z gardé) — ``setValue``
                    // vidait tout l'historique d'annulation.
                    _applyMinimalLineEdit(model, currentVal, state.preSnapshot || '');
                }
                // La référence « disque » revient à celle d'AVANT le stream :
                // l'ancienne version la posait sur le snapshot, et un onglet
                // qui avait des modifications non enregistrées paraissait
                // soudain propre (Fermer ne demandait plus rien).
                if (state.preOriginal !== undefined) originalFileContent[path] = state.preOriginal;
                // L'écriture a échoué : l'onglet a retrouvé son contenu, la
                // copie de secours n'a plus d'objet.
                _mapSet(assistantStash, path, null);
                _scheduleDirtyRefresh();
                // (passe 9, F6) — drapeaux GLOBAUX (onglet actif, aperçu) touchés
                // seulement si le fichier finalisé est celui que l'utilisateur
                // regarde : un stream d'arrière-plan effaçait sinon le « non
                // sauvegardé » de l'onglet qu'il éditait.
                if (activeTabPath.value === path) isEditorDirty.value = false;
                if (activeTabPath.value === path || previewPath.value === path) refreshPreview();
                return;
            }

            // Succès : réconcilier si le serveur nous a donné le contenu final
            if (typeof opts.finalContent === 'string') {
                _syncModelEol(model, opts.disk && opts.disk.eol);
                const cur = model.getValue();
                if (cur !== opts.finalContent) {
                    // Applique la différence minimale — pas de typewriter, juste
                    // un patch silencieux (le stream a déjà fait le show).
                    _applyMinimalLineEdit(model, cur, opts.finalContent);
                }
                _adoptDisk(path, opts.disk || {});
            } else {
                // Contenu final illisible : le flux affiché n'est PAS une
                // preuve de ce qui est sur le disque (C7). La base de
                // précondition reste celle d'avant l'écriture — le prochain
                // enregistrement tombera sur un conflit (Comparer / Recharger)
                // au lieu d'écraser en silence — et on revérifie le disque.
                originalFileContent[path] = model.getValue();
                _mapSet(diskConflicts, path, null);
                checkExternalModsSoon(300);
            }
            if (activeTabPath.value === path) isEditorDirty.value = false;   // (passe 9, F6)
            _scheduleDirtyRefresh();
            _scheduleScmRefresh(path);

            // ── Flash jaune sur le bloc modifié ─────────────────────────
            // Même effet visuel que `_flashChangedLines` dans updateEditor
            // (v1 du flow tool_result) : surlignage jaune + marge de gouttière
            // jaune, fade sur ~3s. Donne un feedback visuel clair de "voici
            // les lignes qui viennent d'être modifiées par l'IA".
            //
            // Plage = [startLineStream, curLine] clampée sur le modèle final
            // (après la réconciliation). Pour un write_file complet, c'est
            // 1..N (tout le fichier flashe). Pour un edit, c'est juste le
            // bloc touché.
            try {
                const endLine = Math.min(
                    Math.max(state.curLine, state.startLineStream || 1),
                    model.getLineCount(),
                );
                const startLine = Math.max(1, Math.min(state.startLineStream || 1, endLine));
                _flashChangedLines(model, { startLine: startLine, endLine: endLine });
            } catch(_) {}

            // (passe 9, F6) — un stream d'arrière-plan ne détourne pas l'aperçu.
            if (activeTabPath.value === path || previewPath.value === path) refreshPreview();
            if (activeTabPath.value === path && path.toLowerCase().endsWith('.html')) previewPath.value = path;
        } finally {
            // Garde-fou ultime : que la branche success ou !success ait
            // pris une exception, on libère TOUJOURS isTypingEffect.
            // Sans ça l'éditeur reste bloqué côté UX (cf. bug "perte
            // d'affichage / refresh nécessaire" sur sessions longues).
            isTypingEffect.value = false;
            // Si le state est encore dans la map (early-return d'une
            // branche, ou exception avant le delete), on le purge ici.
            if (_writeStreams[path] === state) {
                if (state && state._scrollDisp) {
                    try { state._scrollDisp.dispose(); } catch(_) {}
                    state._scrollDisp = null;
                }
                if (state) state.active = false;
                delete _writeStreams[path];
            }
        }
    }

    function isStreamActive(path) {
        const s = _writeStreams[_canonSandboxPath(path)];
        return !!(s && s.active);
    }

    function getStreamPreSnapshot(path) {
        const s = _writeStreams[_canonSandboxPath(path)];
        return s && s.preKnown !== false ? s.preSnapshot : null;
    }

    // ==============================================================
    //  PREVIEW
    // ==============================================================

    function refreshPreview() { _ensurePreviewToken().then(() => { previewKey.value++; }); }

    // ==============================================================
    //  FILE SYSTEM OPERATIONS  (extracted)
    //
    //  Implementation in static/js/editor/_sandbox_fs.js.
    //  All file/folder CRUD, tree/quota refresh, import, search,
    //  and the client-side filteredFilesList quick-open computed.
    //  Callbacks reference functions defined later in this file.
    // ==============================================================
    const _fs = window.setupEditorSandboxFs(vue, {
        sandboxFiles, sandboxQuota, isLoadingFiles,
        sandboxSearch, sandboxSearchMode,
        sandboxSearchResults, isSearchingSandbox,
        sandboxFileInput, sandboxFolderInput, showImportMenu,
        openTabs, activeTabPath, editorFilePath,
        models, originalFileContent, monacoRef,
        showHiddenFiles,
    }, ctx, {
        _sbUrl:           (e) => _sbUrl(e),
        openFile:         (p, f) => openFile(p, f),
        closeTab:         (p, e, force) => closeTab(p, e, force),
        _migrateModel:    (a, b) => _migrateModel(a, b),
        _gitAutoRefresh:  () => _gitAutoRefresh(),
        isSpecialPath:    (p) => _resolveFileViewMode(p) !== 'monaco',
        isPathDirty:      (p) => openTabs.value.some(t => t.path === p) && _tabIsDirty(p),
        // Écriture faite hors de /save (import par-dessus un fichier ouvert…) :
        // onglet PROPRE → rechargé depuis le disque (base comprise) ; onglet
        // modifié → conflit signalé, jamais écrasé.
        setBaseMtime:     (p) => {
            if (!openTabs.value.some(t => t.path === p) || !_modelOk(p)) return;
            if (!_tabIsDirty(p)) _reloadFromDisk(p, { quiet: true });
            else _mapSet(diskConflicts, p, { mtime: null, missing: false });
        },
        // « Remplacer » a réécrit des fichiers : les onglets ouverts (propres)
        // reprennent le disque, curseur en place.
        onFilesReplaced:  async (paths) => {
            for (const p of paths) {
                if (!openTabs.value.some(t => t.path === p)) continue;
                if (_modelOk(p) && !_tabIsDirty(p)) await _reloadFromDisk(p, { quiet: true });
                // Onglet modifié entre-temps : jamais écrasé, conflit signalé.
                else if (_modelOk(p)) _mapSet(diskConflicts, p, { mtime: null, missing: false });
            }
        },
        // Renommage / déplacement : tout état indexé par chemin suit le
        // fichier. Sans cela ``fileMtimes[nouveau]`` restait vide → plus de
        // précondition à l'enregistrement ni de surveillance du disque.
        onPathsMoved:     (oldPath, newPath) => {
            const _to = (k) => (k === oldPath ? newPath
                : (k.startsWith(oldPath + '/') ? newPath + k.substring(oldPath.length) : null));
            const _moveKeys = (obj) => {
                for (const k of Object.keys(obj)) {
                    const nk = _to(k);
                    if (nk) { obj[nk] = obj[k]; delete obj[k]; }
                }
            };
            _moveKeys(_handledDiskMtime);
            _moveKeys(fileShas);
            _moveKeys(fileFormats);
            // Panneau droit de la vue scindée (E23) : il restait sur l'ancien
            // chemin — Ctrl+S à droite visait un fichier qui n'existait plus.
            if (splitTabPath.value) {
                const ns = _to(splitTabPath.value);
                if (ns) splitTabPath.value = ns;
            }
            for (const r of [fileMtimes, diskConflicts, assistantStash]) {
                const next = Object.assign({}, r.value);
                _moveKeys(next);
                r.value = next;
            }
            for (const k of Array.from(readOnlyTabs.value)) {
                const nk = _to(k);
                if (nk) { readOnlyTabs.value.delete(k); readOnlyTabs.value.add(nk); }
            }
        },
        beforeJump:       () => _pushNav(),
    });
    const {
        loadSandboxFiles, treeTruncated, toggleHiddenFiles, loadSandboxQuota, scheduleQuotaRefresh,
        downloadFile, createFolder, createFile,
        moveItem, renameItem, deleteFile, duplicateItem,
        searchCase, searchRegex, searchGlob, searchTruncated, searchError, searchResultGroups,
        showReplace, replaceText, replacePreview, replaceBusy, replaceSelectedCount,
        previewReplace, applyReplace,
        filteredFilesList, openFileAtLine,
        triggerSandboxImport, handleSandboxImport,
        // Snapshots (sandbox state archive + restore)
        snapshots, snapshotsMax,
        snapshotBusy, snapshotProgress,
        showSnapshotPanel, snapshotName,
        loadSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot,
        toggleSnapshotPanel,
        restoreIncomplete, dismissRestoreIncomplete, restoreIncompleteWhen,
    } = _fs;


    function capturePreWrite(path) {
        if (!path || !models[path] || models[path].isDisposed()) return null;
        try { return models[path].getValue(); } catch(_) { return null; }
    }

    // Diff d'un fichier modifié par un outil de l'assistant (carte du chat,
    // 2026-09-26) : ``before`` = version d'avant relue dans l'historique de
    // session. Le fichier est d'abord ouvert et rendu ACTIF : sans modèle,
    // l'ancien appel direct comparait l'avant à lui-même (diff vide), et un
    // changement d'onglet pendant l'ouverture refermait le diff (garde
    // ``watch(activeTabPath)``). ``before`` null : ouvre seulement le fichier.
    async function showToolDiff(path, before) {
        path = _canonSandboxPath(path);
        if (!path || !settings.value.enable_editor) return;
        if (officeIsViewerPath(path)) { openFile(path, true); return; }
        if (!models[path] || models[path].isDisposed() || activeTabPath.value !== path) {
            await openFile(path, !models[path], { quiet: true });
            await nextTick();
        }
        if (before === null || before === undefined) return;
        if (!models[path] || models[path].isDisposed()) {
            showToast('Fichier introuvable dans la sandbox', 'error');
            return;
        }
        showDiffForMessage(path, before, 'assistant');
    }

    function showDiffForMessage(path, beforeContent, base) {
        path = _canonSandboxPath(path);
        if (!path || beforeContent === null) return;
        diffBase.value = base || 'external';
        // Editor disabled in settings : on n'ouvre rien (l'utilisateur a
        // explicitement désactivé l'éditeur). Le diff card côté chat
        // gère ça avec un bouton "télécharger" à la place du clic.
        if (!settings.value.enable_editor) return;
        // Diff texte sans objet pour un visualiseur : on ouvre l'aperçu.
        if (officeIsViewerPath(path)) { openFile(path, true); return; }
        // Ensure editor is open and in code mode
        showEditor.value = true;
        editorMode.value = 'code';
        nextTick(async () => {
            await initMonaco();
            if (!monacoRef.instance || !monacoRef.diff || !monacoRef.originalModel) return;
            // Make sure the file tab is active
            if (activeTabPath.value !== path) {
                if (!openTabs.value.find(t => t.path === path)) {
                    openTabs.value.push({ path, name: path.split('/').pop() });
                }
                activeTabPath.value  = path;
                editorFilePath.value = path;
                if (models[path] && !models[path].isDisposed()) {
                    try { monacoRef.instance.setModel(models[path]); } catch(_) {}
                }
            }
            // Load before snapshot into the original model
            try {
                if (monacoRef.originalModel.getValue() !== beforeContent) {
                    monacoRef.originalModel.setValue(beforeContent);
                }
                const lang = _getLang(path);
                if (models[path] && !models[path].isDisposed()) {
                    monaco.editor.setModelLanguage(monacoRef.originalModel, lang);
                }
                monacoRef.diff.setModel({
                    original: monacoRef.originalModel,
                    modified: models[path] || monacoRef.originalModel,
                });
            } catch(_) {}
            isDiffView.value = true;
            robustLayout();
        });
    }



    // ==============================================================
    // ==============================================================
    //  EDITOR CONTEXT MENU  (replaces the old @ FIM picker)
    // ==============================================================

    function _openEditorCtxMenu(mouseEvent) {
        if (!monacoRef.instance) return;
        const sel = monacoRef.instance.getSelection();
        const hasSelection = sel && !sel.isEmpty();
        let selectionText = '';
        let lineCount = 0;
        if (hasSelection) {
            const model = monacoRef.instance.getModel();
            selectionText = model ? model.getValueInRange(sel) : '';
            lineCount = sel.endLineNumber - sel.startLineNumber + 1;
        }
        // Keep menu inside viewport
        const x = Math.min(mouseEvent.clientX, window.innerWidth - 272);
        const y = Math.max(8, Math.min(mouseEvent.clientY, window.innerHeight - 540));
        editorCtxMenu.value = { show: true, x, y, hasSelection, selectionText, lineCount };
    }

    function closeEditorCtxMenu() {
        editorCtxMenu.value = { ...editorCtxMenu.value, show: false };
        if (monacoRef.instance) monacoRef.instance.focus();
    }

    // -- FIM + AI actions on selection  (extracted)  -------------
    // See static/js/editor/_fim_ai.js for the full implementation.
    // closeEditorCtxMenu and _getLang are passed as callbacks because
    // they live in the main file (ctx menu is shared with Edition
    // helpers below) / come from the languages submodule.
    const _fimAi = window.setupEditorFimAi(vue, {
        monacoRef,
        fimLoading, fimGhostText, editorCtxMenu,
        activeTabPath, editorFilePath,
    }, ctx, {
        closeEditorCtxMenu: () => closeEditorCtxMenu(),
        _getLang:           (p) => _getLang(p),
        // Actions IA : résultat montré en diff, Accepter / Rejeter.
        proposeEdit:        (p) => proposeAiEdit(p),
    });
    const { editorCtxComplete, editorCtxRunAI } = _fimAi;


    // -- Edition helpers -------------------------------------------

    function editorCtxToggleComment() {
        closeEditorCtxMenu();
        if (!monacoRef.instance) return;
        monacoRef.instance.focus();
        monacoRef.instance.trigger('keyboard', 'editor.action.commentLine', null);
    }

    function editorCtxFormatDoc() {
        closeEditorCtxMenu();
        if (!monacoRef.instance) return;
        monacoRef.instance.focus();
        monacoRef.instance.trigger('keyboard', 'editor.action.formatDocument', null);
    }

    function editorCtxCopy() {
        const code = editorCtxMenu.value.selectionText;
        closeEditorCtxMenu();
        if (code) navigator.clipboard.writeText(code).then(() => showToast('Copié !')).catch(() => {});
    }

    function editorCtxGoToDef() {
        closeEditorCtxMenu();
        if (!monacoRef.instance) return;
        monacoRef.instance.focus();
        monacoRef.instance.trigger('keyboard', 'editor.action.revealDefinition', null);
    }

    function editorCtxFindRefs() {
        closeEditorCtxMenu();
        if (!monacoRef.instance) return;
        monacoRef.instance.focus();
        monacoRef.instance.trigger('keyboard', 'editor.action.goToReferences', null);
    }

    function editorCtxRename() {
        closeEditorCtxMenu();
        if (!monacoRef.instance) return;
        monacoRef.instance.focus();
        monacoRef.instance.trigger('keyboard', 'editor.action.rename', null);
    }

    // ==============================================================
    //  TERMINAL -- xterm.js + SSE output + POST input (real PTY)
    // ==============================================================

    // Load script via fetch+eval to bypass Monaco's AMD loader
    const _loadedScripts = {};
    async function _loadScript(src) {
        if (_loadedScripts[src]) return;
        const resp = await fetch(src);
        if (!resp.ok) throw new Error('Failed to load ' + src);
        const code = await resp.text();
        // Hide AMD define/require so UMD falls through to global assignment
        const savedDefine = window.define;
        const savedRequire = window.require;
        window.define = undefined;
        window.require = undefined;
        try {
            (new Function(code))();
        } finally {
            window.define = savedDefine;
            window.require = savedRequire;
        }
        _loadedScripts[src] = true;
    }

    function _loadCSS(href) {
        if (document.querySelector('link[href="' + href + '"]')) return;
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = href;
        document.head.appendChild(l);
    }

    async function toggleTerminal() {
        if (showTerminal.value) {
            showTerminal.value = false;
            nextTick(() => { if (monacoRef.instance) monacoRef.instance.layout(); });
            return;
        }

        showTerminal.value = true;
        await nextTick();

        // Lazy-load xterm on first open. Failure here is fatal for
        // the whole terminal feature (both modes) — no point trying
        // WS or SSE if there's no xterm to render into.
        try {
            await _ensureXtermLoaded();
        } catch (e) {
            console.error('[terminal] xterm load failed:', e);
            showToast('Erreur chargement terminal', 'error');
            showTerminal.value = false;
            return;
        }

        // ── Phase 2 : check Docker container avant d'ouvrir le terminal ──
        // Le terminal éditeur passe désormais via `docker exec -it <container>`
        // (cf. backend/routes/_pty.py::_spawn_terminal). Si le container n'est
        // pas démarré, on affiche un overlay de progression et on lance l'init.
        try {
            const ok = await _ensureSandboxContainerReady();
            if (!ok) {
                // L'utilisateur a annulé ou l'init a échoué, terminalInitOverlay
                // affiche l'erreur. On ne procède pas.
                return;
            }
        } catch (e) {
            console.error('[terminal] sandbox container check failed:', e);
        }

        // First open in this context, or after a full teardown:
        // initialise from server-side session list (creating one if
        // the user has none yet). Otherwise just refocus/refit.
        if (termSessions.value.length === 0) {
            await _initTerminalPanel();
        } else {
            const st = _activeTermState();
            if (!st) {
                // We have session rows in state but no live xterm
                // mounted — happens after a hide/show cycle with
                // keepOpen. Re-mount the active one lazily.
                await _mountSessionPane(termActiveSid.value);
                const mounted = _termStatesBySid.get(termActiveSid.value);
                if (mounted) _connectSessionTransport(mounted);
            } else {
                // Already mounted. Fit + focus after the CSS
                // transition settles; a 50ms delay matches the
                // legacy behaviour well enough for the container to
                // take its final size.
                setTimeout(() => {
                    try { st.fitAddon && st.fitAddon.fit(); } catch(e){}
                    if (monacoRef.instance) monacoRef.instance.layout();
                    setTimeout(() => {
                        try {
                            st.term.focus();
                            st.term.refresh(0, st.term.rows - 1);
                        } catch(e){}
                    }, 80);
                }, 50);
            }
        }

        nextTick(() => { if (monacoRef.instance) monacoRef.instance.layout(); });
    }

    // Breadcrumb éditeur : ouvre dans l'arbre tous les dossiers
    // ancêtres de ``prefix`` (signal partagé observé par chaque TreeItem). Si
    // l'explorateur est masqué, on le ré-affiche d'abord.
    function revealFolderInTree(prefix) {
        if (!prefix) return;
        if (!showExplorer.value) showExplorer.value = true;
        if (window.elpisRevealInTree) window.elpisRevealInTree(prefix);
    }

    function toggleEditorFullscreen() {
        editorFullscreen.value = !editorFullscreen.value;
        if (editorFullscreen.value) {
            ctx.showSidebar.value = false;
            // affordance de sortie : la sidebar disparaît,
            // l'utilisateur ne sait pas comment revenir. On montre un hint
            // « Échap pour quitter » qui s'estompe après 2,5 s.
            showEscapeHint.value = true;
            if (_escapeHintTimer) clearTimeout(_escapeHintTimer);
            _escapeHintTimer = setTimeout(() => { showEscapeHint.value = false; }, 2500);
        } else {
            showEscapeHint.value = false;
            if (_escapeHintTimer) { clearTimeout(_escapeHintTimer); _escapeHintTimer = null; }
            // La vue scindée survit à la sortie du plein écran (2026-09-19).
            nextTick(() => robustLayout());
        }
        // UX : la transition CSS de width dure 260ms (classe .elpis-slide-panel
        // dans static/css/style.css). Pendant toute la transition, on re-layoute
        // Monaco sur chaque frame pour qu'il suive la largeur qui évolue :
        // sans ça le contenu apparaîtrait "décalé" puis snaperait en place
        // à la fin. On stoppe après 320ms (260ms + marge de sécurité).
        _relayoutMonacoDuringTransition();
    }

    // Boucle de re-layout continue pendant ~320ms, sync avec la transition
    // CSS de la classe .elpis-slide-panel. Factorisé parce qu'utilisé
    // aussi par _handleFullscreenEsc.
    //
    // l'ancienne version créait une nouvelle récursion rAF
    // à chaque appel sans annuler la précédente. Toggle rapide du fullscreen
    // (2 clics en <320ms) → 2 boucles en parallèle, doublant le coût Monaco.
    // Sur un toggleEditorFullscreen + Esc + re-toggle ça pouvait empiler
    // jusqu'à 4-5 boucles. On garde un id de rAF courant et on annule la
    // boucle précédente avant d'en démarrer une nouvelle.
    let _relayoutRafId = null;
    function _relayoutMonacoDuringTransition(durationMs = 320) {
        if (_relayoutRafId != null) {
            try { cancelAnimationFrame(_relayoutRafId); } catch(_) {}
            _relayoutRafId = null;
        }
        const start = performance.now();
        const step = () => {
            _relayoutRafId = null;
            if (monacoRef.instance) {
                try { monacoRef.instance.layout(); } catch (_) {}
            }
            if (performance.now() - start < durationMs) {
                _relayoutRafId = requestAnimationFrame(step);
            }
        };
        _relayoutRafId = requestAnimationFrame(step);
    }

    // Sortie du plein écran par le canal OFFICIEL (cascade Échap d'app.js).
    function exitEditorFullscreen() {
        if (!editorFullscreen.value) return;
        editorFullscreen.value = false;
        nextTick(() => robustLayout());
        _relayoutMonacoDuringTransition();
    }

    // Escape exits fullscreen — REPLI seulement (passe 4, F7) : la cascade
    // Échap d'app.js (document, CAPTURE) est l'autorité — elle ferme la
    // couche la plus haute UNIQUEMENT (confirm, modale Raccourcis, menus,
    // puis le plein écran en dernier) et marque l'événement. Sans ce garde,
    // ce listener sortait du plein écran EN PLUS de l'action de la cascade
    // (double geste sur un seul Échap). Il ne sert plus que si la cascade
    // n'est pas montée (teardown/re-login).
    function _handleFullscreenEsc(e) {
        if (e.key === 'Escape' && editorFullscreen.value) {
            if (e._elpisCascadeSaw) return;
            if (monacoConsumesEscape(e)) return;
            // Listener document NON ordonné avec la chaîne Échap d'app.js :
            // si le menu « + » est ouvert, Échap ferme LE MENU seulement —
            // sans ce garde, les deux se fermaient d'un coup.
            if (showEditorMore.value) { showEditorMore.value = false; return; }
            exitEditorFullscreen();
        }
    }
    // flag d'idempotence. Le listener était attaché
    // une fois à l'init du module, mais retiré dans disposeAll().
    // Si l'utilisateur se reconnecte après un logout, plus aucun
    // handler Esc → fullscreen impossible à quitter au clavier.
    // Maintenant : attaché ici en safe-mode (s'il l'était déjà ça
    // ne fait rien), ré-attaché aussi par initMonaco si disposeAll
    // a posé _fullscreenEscBound=false.
    let _fullscreenEscBound = false;
    function _bindFullscreenEsc() {
        if (_fullscreenEscBound) return;
        document.addEventListener('keydown', _handleFullscreenEsc);
        _fullscreenEscBound = true;
    }
    _bindFullscreenEsc();

    // ──────────────────────────────────────────────────────────
    //  Asset loading + URL helpers (multi-session)
    // ──────────────────────────────────────────────────────────

    // Lazy-load xterm.js + fit addon once. Idempotent.
    let _xtermLoadPromise = null;
    function _ensureXtermLoaded() {
        if (_xtermLoadPromise) return _xtermLoadPromise;
        _xtermLoadPromise = (async () => {
            _loadCSS('static/vendor/xterm/xterm.css');
            await _loadScript('static/vendor/xterm/xterm.js');
            await _loadScript('static/vendor/xterm/xterm-addon-fit.js');
            if (typeof window.Terminal === 'undefined') {
                throw new Error('xterm.js Terminal global missing after load');
            }
        })().catch(err => {
            // Clear the cached promise so a later toggleTerminal can retry.
            _xtermLoadPromise = null;
            throw err;
        });
        return _xtermLoadPromise;
    }

    // Legacy endpoints (used by _LEGACY_SID fallback AND, transparently,
    // by the backend for the default implicit session).
    function _termLegacyUrl(endpoint) {
        return '/api/terminal/' + endpoint;
    }

    // Per-session REST endpoint base.
    function _termSessionsUrl() {
        return '/api/terminal/sessions';
    }

    // Per-session WebSocket URL. For _LEGACY_SID we return the
    // session-less legacy path (server treats it as the default
    // session, no DB row involved).
    function _termWsUrlForSid(sid) {
        const proto = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
        const host = window.location.host;
        if (sid === _LEGACY_SID) {
            return proto + '//' + host + '/ws/terminal';
        }
        return proto + '//' + host + '/ws/terminal/' + encodeURIComponent(sid);
    }

    // ──────────────────────────────────────────────────────────
    //  Session REST helpers (multi-session mode only)
    // ──────────────────────────────────────────────────────────

    async function _apiListSessions() {
        const res = await fetchAuth(_termSessionsUrl(), {}, true);
        if (!res || !res.ok) return null;
        return await res.json();
    }

    async function _apiCreateSession(name) {
        const body = name ? JSON.stringify({ name }) : '{}';
        const res = await fetchAuth(_termSessionsUrl(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });
        if (!res) return { error: 'network' };
        if (res.status === 429) return { error: 'limit' };
        if (!res.ok) return { error: 'http_' + res.status };
        try {
            return await res.json();
        } catch (e) {
            return { error: 'parse' };
        }
    }

    // Retourne true si le serveur a bien retiré la ligne. On a BESOIN de
    // cette information : l'appel était « fire-and-forget », donc un échec
    // (réseau, 500) laissait la ligne en base pendant que l'onglet
    // disparaissait de l'écran. L'utilisateur perdait un emplacement de son
    // quota de terminaux sans le savoir et se retrouvait bloqué sur
    // « Limite atteinte » avec moins d'onglets affichés que la limite.
    // Un 404 compte comme un succès : la ligne n'existe plus, c'est le but.
    async function _apiDeleteSession(sid) {
        try {
            const res = await fetchAuth(
                _termSessionsUrl() + '/' + encodeURIComponent(sid),
                { method: 'DELETE' });
            return !!res && (res.ok || res.status === 404);
        } catch(e) {
            return false;
        }
    }

    async function _apiRenameSession(sid, name) {
        try {
            const res = await fetchAuth(
                _termSessionsUrl() + '/' + encodeURIComponent(sid), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                }
            );
            return res && res.ok;
        } catch(e) {
            return false;
        }
    }

    // ──────────────────────────────────────────────────────────
    //  Panel initialisation: create/list sessions on first open
    // ──────────────────────────────────────────────────────────

    async function _initTerminalPanel() {
        // Step 1: list existing sessions from the server.
        const listed = await _apiListSessions();
        if (listed && Array.isArray(listed.sessions)) {
            termMaxSessions.value = listed.max || 4;
        }
        let rows = (listed && listed.sessions) || [];

        let weJustCreatedOne = false;
        if (rows.length === 0) {
            // Step 2: no sessions yet → create "Terminal 1".
            const created = await _apiCreateSession();
            if (created && created.session) {
                termMaxSessions.value = created.max || termMaxSessions.value;
                rows = [created.session];
                weJustCreatedOne = true;
            } else {
                // API entirely unavailable (network / backend down)
                // → fall straight to legacy mode. Rare, but we don't
                // want a blank terminal panel.
                _enterLegacyFallback();
                return;
            }
        }

        termSessions.value = rows;
        termActiveSid.value = rows[0].id;
        termMultiSession.value = true;

        // Step 3: mount the active session's pane and try WS.
        await _mountSessionPane(rows[0].id);
        const st = _termStatesBySid.get(rows[0].id);
        if (!st) {
            _enterLegacyFallback();
            return;
        }
        const ok = await _connectSessionTransport(st);
        if (!ok) {
            // WebSocket is blocked in this environment. Clean up the
            // row we *just* created (don't leave an orphan in the
            // user's limit), then switch to legacy single-session.
            // Pre-existing rows are left alone — they'll show up the
            // next time the user opens the terminal from a WS-capable
            // browser.
            if (weJustCreatedOne && rows[0] && rows[0].id) {
                _apiDeleteSession(rows[0].id);
            }
            _unmountSessionPane(rows[0].id);
            termSessions.value = [];
            termActiveSid.value = null;
            _enterLegacyFallback();
            return;
        }
        // Multi-session is live. The other existing sessions are
        // listed in the tab bar but their panes only get mounted
        // when the user clicks their tab (lazy — saves WS/memory
        // until actually needed).
    }

    function _enterLegacyFallback() {
        termMultiSession.value = false;
        termSessions.value = [{
            id: _LEGACY_SID,
            name: 'Terminal',
            created_at: Math.floor(Date.now() / 1000),
        }];
        termActiveSid.value = _LEGACY_SID;
        // Defer mount to next tick so the v-for has rendered the
        // container with [data-term-sid="__legacy__"].
        nextTick(async () => {
            await _mountSessionPane(_LEGACY_SID);
            const st = _termStatesBySid.get(_LEGACY_SID);
            if (st) _connectSessionTransport(st);
        });
    }

    // ──────────────────────────────────────────────────────────
    //  Per-session xterm mounting
    // ──────────────────────────────────────────────────────────

    const _TERM_XTERM_OPTIONS = {
        theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#aeafad',
            cursorAccent: '#1e1e1e',
            selectionBackground: '#264f78',
            selectionForeground: '#ffffff',
            black:   '#1e1e1e',
            red:     '#f44747',
            green:   '#6a9955',
            yellow:  '#d7ba7d',
            blue:    '#569cd6',
            magenta: '#c586c0',
            cyan:    '#4ec9b0',
            white:   '#d4d4d4',
            brightBlack:   '#808080',
            brightRed:     '#f14c4c',
            brightGreen:   '#73c991',
            brightYellow:  '#e2c08d',
            brightBlue:    '#6cb6ff',
            brightMagenta: '#d2a8ff',
            brightCyan:    '#58d1c9',
            brightWhite:   '#e8e8e8',
        },
        fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
        fontSize: 13, lineHeight: 1.35,
        cursorBlink: true, cursorStyle: 'bar', scrollback: 5000,
    };

    async function _mountSessionPane(sid) {
        if (_termStatesBySid.has(sid)) return _termStatesBySid.get(sid);

        // Wait one tick so the v-for has rendered the pane container.
        await nextTick();
        const container = document.querySelector(
            '[data-term-sid="' + (window.CSS && CSS.escape ? CSS.escape(sid) : sid) + '"]'
        );
        if (!container) return null;

        const term = new window.Terminal(_TERM_XTERM_OPTIONS);
        const fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);

        const state = {
            sid, term, fitAddon, container,
            ws: null, sse: null, transport: null,
            inputBuffer: '', inputTimer: null,
            sseWatchdog: null,
            wsHeartbeat: null, wsReconnectTimer: null,
            resizeObserver: null,
        };
        _termStatesBySid.set(sid, state);

        // ── Input → transport ────────────────────────────────────────
        // AVANT : debounce TRAILING de 30 ms — même la toute première frappe
        // d'une salve attendait 30 ms avant de partir, donc l'écho du shell
        // arrivait systématiquement en retard. Le nombre de frames envoyées
        // était pourtant le même (une frappe isolée = une frame), donc ces
        // 30 ms ne payaient rien sur le réseau : c'était de la latence pure.
        //
        // MAINTENANT : throttle LEADING sur le transport WS — la première
        // frappe part IMMÉDIATEMENT (latence d'écho nulle), et seules les
        // suivantes arrivées dans la fenêtre de coalescence sont regroupées
        // (collage, répétition auto de touche, sortie de `paste`). Le trafic
        // est inchangé ou meilleur ; la frappe redevient instantanée.
        //
        // Le repli POST (SSE legacy) garde le comportement trailing pur : là,
        // chaque envoi est une requête HTTP, donc la coalescence prime sur la
        // latence.
        const _now = () => (window.performance && performance.now
                            ? performance.now() : Date.now());
        _registerTermLinks(term);
        term.onData((data) => {
            // Entrée : une commande vient peut-être de créer, déplacer ou
            // modifier des fichiers — l'explorateur suit (2026-09-19).
            if (data.indexOf('\r') >= 0) _scheduleTreeRefreshAfterCommand();
            const wsReady = state.transport === 'ws'
                         && state.ws && state.ws.readyState === 1;
            if (wsReady && !state.inputTimer
                    && (_now() - (state.lastInputSentAt || 0)) >= _TERM_INPUT_COALESCE_MS) {
                state.lastInputSentAt = _now();
                _sendInputFor(state, data);
                return;
            }
            state.inputBuffer += data;
            if (!state.inputTimer) {
                state.inputTimer = setTimeout(() => {
                    const buf = state.inputBuffer;
                    state.inputBuffer = '';
                    state.inputTimer = null;
                    state.lastInputSentAt = _now();
                    if (buf) _sendInputFor(state, buf);
                }, _TERM_INPUT_COALESCE_MS);
            }
        });

        term.onResize(({ rows, cols }) => {
            if (state.transport === 'ws' && state.ws && state.ws.readyState === 1) {
                try {
                    state.ws.send(JSON.stringify({ op: 'resize', rows, cols }));
                    return;
                } catch(e) { /* fall through */ }
            }
            if (state.transport === 'sse' || sid === _LEGACY_SID) {
                fetchAuth(_termLegacyUrl('resize'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rows, cols }),
                }).catch(() => {});
            }
        });

        // Fit after the DOM settles. If this pane isn't visible yet
        // (user opened term, then clicked another tab before we got
        // here), fit() produces a 0x0 grid; we re-fit on tab switch,
        // so that's OK.
        setTimeout(() => {
            try { fitAddon.fit(); } catch(e){}
        }, 100);

        state.resizeObserver = new ResizeObserver(() => {
            try { fitAddon.fit(); } catch(e){}
        });
        state.resizeObserver.observe(container);

        return state;
    }

    function _unmountSessionPane(sid) {
        _clearTermStatus(sid);
        const st = _termStatesBySid.get(sid);
        if (!st) return;
        try { if (st.ws) st.ws.close(1000, 'unmount'); } catch(e){}
        try { if (st.sse) st.sse.close(); } catch(e){}
        if (st.wsHeartbeat)      { clearInterval(st.wsHeartbeat); st.wsHeartbeat = null; }
        if (st.wsReconnectTimer) { clearTimeout(st.wsReconnectTimer); st.wsReconnectTimer = null; }
        if (st.sseWatchdog)      { clearTimeout(st.sseWatchdog); st.sseWatchdog = null; }
        if (st.inputTimer)       { clearTimeout(st.inputTimer); st.inputTimer = null; }
        if (st.resizeObserver)   { try { st.resizeObserver.disconnect(); } catch(e){} }
        try { st.term && st.term.dispose(); } catch(e){}
        _termStatesBySid.delete(sid);
    }

    // ──────────────────────────────────────────────────────────
    //  Transport: WebSocket (preferred) with SSE+POST fallback
    //  (fallback is only used by _LEGACY_SID, not by named sessions
    //   — see the rationale above the session endpoints in the
    //   backend.)
    // ──────────────────────────────────────────────────────────

    function _sendInputFor(state, data) {
        if (!state.term) return;

        // Fast path: WebSocket.
        if (state.transport === 'ws' && state.ws && state.ws.readyState === 1) {
            try {
                state.ws.send(new TextEncoder().encode(data));
                return;
            } catch(e) { /* fall through */ }
        }

        // Legacy SSE+POST fallback path. Only valid for _LEGACY_SID
        // (named sessions have no POST endpoint on the backend).
        if (state.sid !== _LEGACY_SID) {
            // Session nommée sans WS : il n'existe aucun repli côté serveur,
            // la frappe est PERDUE. Avant, on la jetait en silence — l'écran
            // restait figé et l'utilisateur croyait le terminal planté. On le
            // dit maintenant, une seule fois par coupure.
            if (!state.inputDropWarned) {
                state.inputDropWarned = true;
                try {
                    state.term.write('\r\n\x1b[33m── connexion au terminal perdue : '
                        + 'les touches ne sont plus transmises. Reconnexion en '
                        + 'cours…\x1b[0m\r\n');
                } catch (e) {}
            }
            return;
        }
        fetchAuth(_termLegacyUrl('input'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data }),
        }).catch(() => {});

        // Stale-SSE reconnect guard (copied from the legacy path).
        if (!state.sse || state.sse.readyState === 2) {
            _connectSSEFor(state);
            return;
        }
        if (state.sseWatchdog) clearTimeout(state.sseWatchdog);
        state.sseWatchdog = setTimeout(() => {
            state.sseWatchdog = null;
            if (showTerminal.value && state.term && state.sse) {
                _connectSSEFor(state);
            }
        }, 3000);
    }

    /**
     * Open a transport for a mounted session.
     * @returns {Promise<boolean>} true if a transport is active,
     *                              false if WS failed AND legacy SSE
     *                              is not applicable (= named session
     *                              in a WS-blocked environment).
     */
    function _connectSessionTransport(state) {
        return new Promise((resolve) => {
            // Tear down any previous transport for this session.
            if (state.ws)   { try { state.ws.close();   } catch(e){} state.ws = null;  }
            if (state.sse)  { try { state.sse.close();  } catch(e){} state.sse = null; }
            if (state.wsHeartbeat)      { clearInterval(state.wsHeartbeat);      state.wsHeartbeat = null; }
            if (state.wsReconnectTimer) { clearTimeout(state.wsReconnectTimer);  state.wsReconnectTimer = null; }
            if (state.sseWatchdog)      { clearTimeout(state.sseWatchdog);       state.sseWatchdog = null; }

            _setTermStatus(state.sid, state.everOpened ? 'reconnecting' : 'connecting');
            let ws;
            try {
                ws = new WebSocket(_termWsUrlForSid(state.sid));
            } catch (e) {
                // Should basically never throw synchronously; treat
                // as a WS failure and decide fallback below.
                if (state.sid === _LEGACY_SID) {
                    _connectSSEFor(state);
                    resolve(true);
                } else {
                    _setTermStatus(state.sid, 'closed');
                    resolve(false);
                }
                return;
            }
            ws.binaryType = 'arraybuffer';
            state.ws = ws;

            let openedOnce = false;
            let resolved = false;
            const settle = (val) => { if (!resolved) { resolved = true; resolve(val); } };

            ws.onopen = () => {
                if (state.ws !== ws) { try { ws.close(); } catch(e){} return; }
                openedOnce = true;
                state.everOpened = true;
                state.inputDropWarned = false;    // nouvelle connexion : on ré-armera l'avertissement
                state.transport = 'ws';
                _setTermStatus(state.sid, 'open');
                try {
                    ws.send(JSON.stringify({
                        op: 'resize',
                        rows: state.term.rows,
                        cols: state.term.cols,
                    }));
                } catch(e){}
                state.wsHeartbeat = setInterval(() => {
                    if (state.ws !== ws || ws.readyState !== 1) return;
                    try { ws.send(JSON.stringify({ op: 'ping' })); } catch(e){}
                }, _TERM_WS_HEARTBEAT_MS);
                settle(true);
            };

            ws.onmessage = (ev) => {
                if (state.ws !== ws) return;
                const data = ev.data;
                if (data instanceof ArrayBuffer) {
                    try { state.term.write(new Uint8Array(data)); } catch(e){}
                    // Terminal redevenu calme (1,5 s sans sortie) : une commande
                    // a pu toucher des fichiers ouverts (``sed -i``, git…) — le
                    // focus fenêtre ne se déclenche pas, le terminal étant dans
                    // la page (E8). Regroupé : un seul contrôle par accalmie.
                    checkExternalModsSoon(1500);
                    // ⚠ NE PAS rafraîchir le quota ici (audit perf 2026-08-08).
                    // Le PTY fait l'ÉCHO de chaque frappe : ce handler tourne
                    // donc à chaque caractère tapé. L'ancien
                    // ``scheduleQuotaRefresh()`` (debounce 600 ms réarmé à
                    // chaque octet) partait à la moindre pause de frappe et
                    // déclenchait un ``GET /api/sandbox/quota`` → un ``du -sb``
                    // sur TOUTE la sandbox. Un utilisateur qui tape en génère
                    // plusieurs par minute ; à N utilisateurs, le serveur ne
                    // faisait plus que ça.
                    // Le poll périodique (_startQuotaPoll, 10 s, seulement si
                    // l'onglet est visible ET l'éditeur ouvert) couvre déjà les
                    // écritures faites depuis le terminal — c'est exactement ce
                    // pour quoi il a été ajouté.
                    return;
                }
                if (typeof data === 'string') {
                    let obj;
                    try { obj = JSON.parse(data); } catch(e){ return; }
                    if (!obj) return;
                    if (obj.type === 'hello') {
                        // AUDIT 2026-08-02 (W5) — le serveur annonce si le
                        // shell est NEUF. À la reconnexion après un recyclage
                        // de worker, le scrollback xterm est intact mais
                        // cwd/env/processus ont disparu : sans ce séparateur,
                        // l'utilisateur croyait être dans la même session.
                        if (obj.fresh_shell && state.hadShellOnce) {
                            try {
                                state.term.write('\r\n\x1b[33m── session précédente terminée '
                                    + '(serveur redémarré) : nouveau shell ──\x1b[0m\r\n');
                            } catch(e){}
                        }
                        state.hadShellOnce = true;
                        return;
                    }
                    if (obj.type === 'session_expired') {
                        // AUDIT 2026-08-02 (S1) — le close(4001) suit ; on
                        // marque l'état pour que onclose ne retente rien.
                        state.sessionExpired = true;
                        return;
                    }
                    if (obj.type === 'exit') {
                        try {
                            state.term.write('\r\n\x1b[90m[session terminée -- reconnexion...]\x1b[0m\r\n');
                        } catch(e){}
                        try { ws.close(); } catch(e){}
                    }
                }
            };

            ws.onerror = () => {
                if (state.ws !== ws) return;
                // Error before open → let onclose decide fallback.
            };

            ws.onclose = (ev) => {
                if (state.ws !== ws) return;
                state.ws = null;
                if (state.wsHeartbeat) { clearInterval(state.wsHeartbeat); state.wsHeartbeat = null; }

                // AUDIT 2026-08-02 (S9/S1) — 4001 = session expirée/révoquée
                // (le serveur accepte désormais AVANT de fermer, donc le code
                // arrive réellement ici au lieu d'un 1006 anonyme). Ni repli
                // SSE (il rebouclait sur 401 toutes les 2 s), ni reconnexion :
                // purge + écran de login via le handler global.
                if (ev.code === 4001 || state.sessionExpired) {
                    state.sessionExpired = false;
                    if (ctx.handleSessionExpired) ctx.handleSessionExpired();
                    settle(false);
                    return;
                }

                if (!openedOnce) {
                    // Never connected.
                    //  4004 = server says "unknown session" → drop
                    //         the tab locally. Happens if another
                    //         client deleted this session or if the
                    //         session DB row was purged.
                    if (ev.code === 4004 && state.sid !== _LEGACY_SID) {
                        showToast('Ce terminal n\'existe plus côté serveur — onglet retiré.',
                                  'warning');
                        _removeSessionTabLocal(state.sid);
                        settle(false);
                        return;
                    }
                    // Otherwise it's a proxy/WAF issue or similar
                    // transport-level failure.
                    if (state.sid === _LEGACY_SID) {
                        // Legacy: fall back to SSE.
                        console.warn('[terminal] WS failed, falling back to SSE');
                        _connectSSEFor(state);
                        settle(true);
                    } else {
                        // Named session: no SSE fallback available.
                        // Caller (_initTerminalPanel) handles the UX.
                        _setTermStatus(state.sid, 'closed');
                        settle(false);
                    }
                    return;
                }

                // Had a working connection and it dropped → reconnect
                // on the same transport. Falling back to SSE here
                // would defeat the multi-worker fix (that's the whole
                // point of WS).
                _setTermStatus(state.sid,
                    (showTerminal.value && _termStatesBySid.get(state.sid) === state)
                        ? 'reconnecting' : 'closed');
                if (showTerminal.value && _termStatesBySid.get(state.sid) === state) {
                    state.wsReconnectTimer = setTimeout(() => {
                        state.wsReconnectTimer = null;
                        if (showTerminal.value && _termStatesBySid.get(state.sid) === state) {
                            _connectSessionTransport(state);
                        }
                    }, _TERM_WS_RECONNECT_MS);
                }
            };
        });
    }

    function _connectSSEFor(state) {
        if (state.sid !== _LEGACY_SID) return;   // SSE is legacy-only
        _setTermStatus(state.sid, 'open');
        if (state.sse) { try { state.sse.close(); } catch(e){} state.sse = null; }
        state.transport = 'sse';

        // Initial resize: WS carries this as a frame, SSE needs an
        // explicit POST /resize.
        fetchAuth(_termLegacyUrl('resize'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: state.term.rows, cols: state.term.cols }),
        }).catch(() => {});

        const sse = new EventSource(_termLegacyUrl('stream'), { withCredentials: true });
        state.sse = sse;

        sse.onmessage = (event) => {
            if (state.sse !== sse) return;
            if (state.sseWatchdog) { clearTimeout(state.sseWatchdog); state.sseWatchdog = null; }
            const payload = event.data;
            if (payload === '[SESSION_EXPIRED]') {
                // AUDIT 2026-08-02 (S1) — émis par la revalidation périodique
                // du flux SSE legacy : purge + login, pas de reconnexion.
                state.sse = null;
                sse.close();
                if (ctx.handleSessionExpired) ctx.handleSessionExpired();
                return;
            }
            if (payload === '[EOF]') {
                try {
                    state.term.write('\r\n\x1b[90m[session terminée -- reconnexion...]\x1b[0m\r\n');
                } catch(e){}
                state.sse = null;
                sse.close();
                setTimeout(() => {
                    if (ctx.user && !ctx.user.value) return;   // audit 2026-08-02 (S2)
                    if (state.term && _termStatesBySid.get(state.sid) === state) {
                        _connectSSEFor(state);
                    }
                }, 1500);
                return;
            }
            try {
                const bin = atob(payload);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                state.term.write(bytes);
                checkExternalModsSoon(1500);
            } catch(e) {
                try { state.term.write(payload); } catch(_){}
            }
            // ⚠ Pas de refresh quota ici non plus — même raison que sur le
            // chemin WS (écho PTY à chaque frappe → un ``du -sb`` par pause).
            // Le poll périodique s'en charge.
        };
        sse.onerror = () => {
            if (state.sse !== sse) return;
            state.sse = null;
            sse.close();
            if (state.term && _termStatesBySid.get(state.sid) === state) {
                setTimeout(() => {
                    // AUDIT 2026-08-02 (S2) — garde d'auth : sans elle, après
                    // expiration de session ce repli SSE re-tentait un
                    // EventSource (401) toutes les 2 s pour toujours.
                    if (ctx.user && !ctx.user.value) return;
                    if (_termStatesBySid.get(state.sid) === state) _connectSSEFor(state);
                }, 2000);
            }
        };
    }

    // ──────────────────────────────────────────────────────────
    //  User actions: tab-bar interactions
    // ──────────────────────────────────────────────────────────

    async function termNewSession() {
        if (!termMultiSession.value) return;
        if (termSessions.value.length >= termMaxSessions.value) {
            showToast(
                'Limite atteinte (' + termMaxSessions.value + ' terminaux max)',
                'warning'
            );
            return;
        }
        const res = await _apiCreateSession();
        if (res.error === 'limit') {
            showToast(
                'Limite atteinte (' + termMaxSessions.value + ' max)',
                'warning'
            );
            return;
        }
        if (res.error || !res.session) {
            showToast('Erreur création terminal', 'error');
            return;
        }
        termMaxSessions.value = res.max || termMaxSessions.value;
        termSessions.value = [...termSessions.value, res.session];
        termActiveSid.value = res.session.id;
        await _mountSessionPane(res.session.id);
        const st = _termStatesBySid.get(res.session.id);
        if (st) _connectSessionTransport(st);
        // Focus the new tab's xterm so the user can start typing.
        setTimeout(() => {
            const s = _termStatesBySid.get(res.session.id);
            if (s && s.term) { try { s.term.focus(); } catch(e){} }
        }, 120);
    }

    async function termCloseSession(sid) {
        if (!termMultiSession.value) return;
        if (sid === _LEGACY_SID) return;
        const idx = termSessions.value.findIndex(s => s.id === sid);
        if (idx < 0) return;

        // On ATTEND la confirmation du serveur avant de retirer l'onglet.
        // Auparavant l'appel était fire-and-forget : en cas d'échec, la ligne
        // survivait en base alors que l'onglet avait disparu de l'écran →
        // l'utilisateur consommait un emplacement fantôme et se prenait
        // « Limite atteinte (4 max) » avec 2 onglets visibles.
        const ok = await _apiDeleteSession(sid);
        if (!ok) {
            showToast('Fermeture impossible — le terminal est toujours ouvert '
                      + 'côté serveur. Réessayez.', 'error');
            return;
        }
        _unmountSessionPane(sid);
        const next = termSessions.value.filter(s => s.id !== sid);
        termSessions.value = next;

        if (termActiveSid.value === sid) {
            if (next.length > 0) {
                const newActive = next[Math.max(0, idx - 1)];
                termActiveSid.value = newActive.id;
                // Lazily mount the newly-active pane if it wasn't
                // mounted yet.
                if (!_termStatesBySid.has(newActive.id)) {
                    await _mountSessionPane(newActive.id);
                    const st = _termStatesBySid.get(newActive.id);
                    if (st) _connectSessionTransport(st);
                }
                setTimeout(() => {
                    const st = _termStatesBySid.get(termActiveSid.value);
                    if (st) {
                        try { st.fitAddon.fit(); } catch(e){}
                        try { st.term.focus(); } catch(e){}
                    }
                }, 80);
            } else {
                // User closed the last tab → close the whole panel.
                termActiveSid.value = null;
                showTerminal.value = false;
                nextTick(() => { if (monacoRef.instance) monacoRef.instance.layout(); });
            }
        }
    }

    async function termSwitchTo(sid) {
        if (termActiveSid.value === sid) return;
        const target = termSessions.value.find(s => s.id === sid);
        if (!target) return;
        termActiveSid.value = sid;
        // Mount + connect on demand (panes are created lazily).
        if (!_termStatesBySid.has(sid)) {
            await _mountSessionPane(sid);
            const st = _termStatesBySid.get(sid);
            if (st) _connectSessionTransport(st);
        }
        // The pane just became visible; re-fit in case it was
        // rendered at 0x0 while hidden, then focus the xterm.
        setTimeout(() => {
            const st = _termStatesBySid.get(sid);
            if (st) {
                try { st.fitAddon.fit(); } catch(e){}
                try { st.term.focus(); } catch(e){}
                try { st.term.refresh(0, st.term.rows - 1); } catch(e){}
            }
        }, 40);
    }

    function termStartRename(sid) {
        if (!termMultiSession.value) return;
        if (sid === _LEGACY_SID) return;
        const sess = termSessions.value.find(s => s.id === sid);
        if (!sess) return;
        termRenamingSid.value = sid;
        termRenameValue.value = sess.name || '';
        // Focus+select after the <input> is in the DOM.
        nextTick(() => {
            const el = document.querySelector(
                '[data-term-rename-sid="' +
                (window.CSS && CSS.escape ? CSS.escape(sid) : sid) + '"]'
            );
            if (el) { try { el.focus(); el.select(); } catch(e){} }
        });
    }

    async function termCommitRename() {
        const sid = termRenamingSid.value;
        if (!sid) return;
        const newName = (termRenameValue.value || '').trim().slice(0, 64);
        termRenamingSid.value = null;
        termRenameValue.value = '';
        const sess = termSessions.value.find(s => s.id === sid);
        if (!sess || !newName || newName === sess.name) return;
        const ok = await _apiRenameSession(sid, newName);
        if (ok) {
            termSessions.value = termSessions.value.map(s =>
                s.id === sid ? Object.assign({}, s, { name: newName }) : s
            );
        } else {
            showToast('Renommage échoué', 'error');
        }
    }

    function termCancelRename() {
        termRenamingSid.value = null;
        termRenameValue.value = '';
    }

    // Remove a session locally without hitting the server — used
    // when the server tells us via close code 4004 that the session
    // no longer exists. We don't try to recreate; the user can
    // click "+" if they want another one.
    function _removeSessionTabLocal(sid) {
        const idx = termSessions.value.findIndex(s => s.id === sid);
        if (idx < 0) return;
        _unmountSessionPane(sid);
        const next = termSessions.value.filter(s => s.id !== sid);
        termSessions.value = next;
        if (termActiveSid.value === sid) {
            if (next.length > 0) {
                termActiveSid.value = next[Math.max(0, idx - 1)].id;
            } else {
                termActiveSid.value = null;
                showTerminal.value = false;
            }
        }
    }

    // ──────────────────────────────────────────────────────────
    //  Teardown
    // ──────────────────────────────────────────────────────────
    //  Called on logout (disposeAll). Preserves backward-compat name.

    async function _destroyAllTerminals(opts) {
        opts = opts || {};
        // Unmount every session pane (kills WS, clears timers, disposes xterm).
        for (const sid of Array.from(_termStatesBySid.keys())) {
            _unmountSessionPane(sid);
        }
        termSessions.value = [];
        termActiveSid.value = null;
        termRenamingSid.value = null;
        termRenameValue.value = '';
        termSessionStatus.value = {};
        termMultiSession.value = true;
        if (!opts.keepOpen) {
            showTerminal.value = false;
        }

        // Best-effort kill of the server-side legacy default session.
        // Named sessions are DB-scoped — not killed here because the
        // user might want to reconnect from a different tab with them
        // intact.
        try { await fetchAuth('/api/terminal/kill', { method: 'POST' }); } catch(e){}
    }

    // Back-compat shim: older code (disposeAll) calls
    // _destroyTerminal(). Keep the name available so git-diffs are
    // tight; it just forwards.
    async function _destroyTerminal() {
        return _destroyAllTerminals();
    }

    // -- Resize drag (terminal / explorer / editor-chat split)  (extracted)
    // See static/js/editor/_resize.js for the full implementation.
    // getTerm / getTermFitAddon are passed as LAZY getters that
    // resolve the CURRENTLY-ACTIVE terminal session's xterm and
    // FitAddon each time the drag handler fires. With multi-session,
    // "active" can change mid-drag if the user switches tabs (edge
    // case, but the lazy resolution covers it correctly).
    const _resize = window.setupEditorResize(vue, {
        terminalHeight, explorerWidth, settings, monacoRef,
    }, {
        getTerm:         () => { const s = _activeTermState(); return s ? s.term : null; },
        getTermFitAddon: () => { const s = _activeTermState(); return s ? s.fitAddon : null; },
    });
    const {
        editorSplitDragging,
        terminalResizeStart, explorerResizeStart, editorSplitStart,
    } = _resize;


    // ==============================================================
    //  PASSE UX 2026-09-19 — cf. docs/editeur-ux-design-2026-09-19.md
    // ==============================================================

    // ── Disposition restaurée (largeur explorateur, hauteur terminal,
    //    partage de la vue scindée) et mémorisée à chaque changement ──
    explorerWidth.value  = _num(_layout0.explorerWidth, 140, 640, 224);
    terminalHeight.value = _num(_layout0.terminalHeight, 90, 900, 250);
    splitRatio.value     = _num(_layout0.splitRatio, 15, 85, 50);
    let _layoutTimer = null;
    watch([explorerWidth, terminalHeight, splitRatio], () => {
        clearTimeout(_layoutTimer);
        _layoutTimer = setTimeout(() => {
            try {
                localStorage.setItem(_LAYOUT_KEY, JSON.stringify({
                    explorerWidth: explorerWidth.value,
                    terminalHeight: terminalHeight.value,
                    splitRatio: splitRatio.value,
                }));
            } catch (_) {}
        }, 400);
    });

    // ── Index de l'arbre chargé (chemin → 'file' | 'folder') ─────────────
    const _treeIndex = vue.computed(() => {
        const m = new Map();
        const walk = (nodes) => {
            for (const n of (nodes || [])) {
                m.set(n.path, n.type);
                if (n.children) walk(n.children);
            }
        };
        walk(sandboxFiles.value);
        return m;
    });
    // Chemin cité (chat, terminal) → fichier de la sandbox. Exact d'abord, puis
    // suffixe UNIQUE (« src/app.py » affiché depuis /work/projet).
    function _resolveSandboxPath(p) {
        p = _canonSandboxPath(p);
        if (!p) return null;
        const idx = _treeIndex.value;
        if (idx.get(p) === 'file') return p;
        let found = null;
        for (const [k, t] of idx) {
            if (t === 'file' && k.endsWith('/' + p)) {
                if (found) return null;           // ambigu : on ne devine pas
                found = k;
            }
        }
        return found;
    }

    // ── Arbre : fichier actif, « Localiser », sélection ──────────────────
    watch(() => user.value && user.value.id, (id) => {
        if (window.elpisTree) window.elpisTree.setUser(id || null);
    }, { immediate: true });
    watch(activeTabPath, (p) => {
        if (!window.elpisTree) return;
        window.elpisTree.setActive(p || '');
        if (p && settings.value && settings.value.editor_follow_active
                && showExplorer.value && explorerTab.value === 'files' && !sandboxSearch.value) {
            window.elpisTree.reveal(p);
        }
    });
    function revealActiveInTree(path) {
        const p = (typeof path === 'string' && path) || activeTabPath.value;
        closeTabCtxMenu();
        if (!p || !window.elpisTree) return;
        showExplorer.value = true;
        explorerTab.value = 'files';
        if (sandboxSearch.value) sandboxSearch.value = '';   // l'arbre réapparaît
        nextTick(() => window.elpisTree.reveal(p));
    }
    function collapseAllFolders() { if (window.elpisTree) window.elpisTree.collapseAll(); }
    function explorerMultiCount(item) {
        return (item && item.path && window.elpisTree) ? window.elpisTree.targetsFor(item.path).length : 0;
    }

    // ── Fichiers récents (Ctrl+P sans saisie) ─────────────────────────────
    const recentFiles = ref([]);
    function _recentKey() { return 'elpis.editor.recent.' + ((user.value && user.value.id) || 'anon'); }
    watch(() => user.value && user.value.id, () => {
        try {
            const arr = JSON.parse(localStorage.getItem(_recentKey()) || '[]');
            recentFiles.value = Array.isArray(arr) ? arr.filter(x => typeof x === 'string').slice(0, 30) : [];
        } catch (_) { recentFiles.value = []; }
    }, { immediate: true });
    function _rememberRecent(path) {
        if (!path) return;
        if (recentFiles.value[0] === path) return;
        const list = [path].concat(recentFiles.value.filter(p => p !== path)).slice(0, 30);
        recentFiles.value = list;
        try { localStorage.setItem(_recentKey(), JSON.stringify(list)); } catch (_) {}
    }

    // ── Précédent / Suivant (Alt+← / Alt+→) ───────────────────────────────
    const _navBack = [];
    const _navFwd  = [];
    let _navSilent = false;
    function _currentLoc() {
        const p = activeTabPath.value;
        if (!p) return null;
        let line = 1, col = 1;
        try {
            if (monacoRef.instance && monacoRef.instance.getModel() === models[p]) {
                const pos = monacoRef.instance.getPosition();
                if (pos) { line = pos.lineNumber; col = pos.column; }
            }
        } catch (_) {}
        return { path: p, line, col };
    }
    function _pushNav() {
        if (_navSilent) return;
        const loc = _currentLoc();
        if (!loc) return;
        const last = _navBack[_navBack.length - 1];
        if (last && last.path === loc.path && last.line === loc.line) return;
        _navBack.push(loc);
        if (_navBack.length > 100) _navBack.shift();
        _navFwd.length = 0;
    }
    async function _goLoc(loc) {
        _navSilent = true;
        try {
            if (openTabs.value.some(t => t.path === loc.path)) await switchTab(loc.path);
            else await openFile(loc.path, false);
        } finally { _navSilent = false; }
        const ed = monacoRef.instance;
        if (ed && ed.getModel() === models[loc.path]) {
            const pos = { lineNumber: loc.line, column: loc.col };
            try { ed.setPosition(pos); ed.revealPositionInCenterIfOutsideViewport(pos); ed.focus(); } catch (_) {}
        }
    }
    async function navBack() {
        if (!_navBack.length) return;
        const cur = _currentLoc();
        const loc = _navBack.pop();
        if (cur) _navFwd.push(cur);
        await _goLoc(loc);
    }
    async function navForward() {
        if (!_navFwd.length) return;
        const cur = _currentLoc();
        const loc = _navFwd.pop();
        if (cur) _navBack.push(cur);
        await _goLoc(loc);
    }

    // ── Git : marge (ajout / modif / suppression), pastilles, branche ─────
    const _headCache  = Object.create(null);   // path → { text: string | null }
    const _scmDecoIds = Object.create(null);   // path → ids de décorations Monaco
    let _scmTimer = null;
    let _scmPath  = null;
    function _repoFor(path) {
        let best = null;
        for (const r of (gitRepos.value || [])) {
            const rp = r && r.path;
            if (rp == null) continue;
            const pre = (rp && rp !== '.') ? rp + '/' : '';
            if (pre && !path.startsWith(pre)) continue;
            if (!best || pre.length > best.pre.length) best = { repo: rp, pre };
        }
        return best;
    }
    // Contenu du fichier dans HEAD (null : hors dépôt, non suivi, illisible).
    async function _loadHead(path, force) {
        if (!force && _headCache[path]) return _headCache[path].text;
        const rp = _repoFor(path);
        if (!rp) { _headCache[path] = { text: null }; return null; }
        const rel = path.slice(rp.pre.length);
        let text = null;
        try {
            const res = await fetchAuth('/api/sandbox/git/show-file?repo=' + encodeURIComponent(rp.repo)
                + '&hash=HEAD&path=' + encodeURIComponent(rel), {}, true);
            if (res && res.ok) {
                const d = await res.json();
                text = typeof d.content === 'string' ? d.content : null;
            }
        } catch (_) { text = null; }
        _headCache[path] = { text };
        return text;
    }
    function _scheduleScmRefresh(path) {
        if (!path) return;
        _scmPath = path;
        clearTimeout(_scmTimer);
        _scmTimer = setTimeout(() => { _refreshScm(_scmPath); }, 350);
    }
    async function _refreshScm(path) {
        if (!path || !_modelOk(path) || !window.monaco || !window.elpisLineDiff) return;
        if (!(gitRepos.value || []).length) { _applyScm(path); return; }
        if (!_headCache[path]) await _loadHead(path);
        _applyScm(path);
    }
    function _applyScm(path) {
        const model = models[path];
        if (!model || model.isDisposed()) return;
        const head = _headCache[path] ? _headCache[path].text : null;
        const decos = [];
        if (typeof head === 'string') {
            const D = window.elpisLineDiff;
            const hunks = D.hunks(D.lines(head), model.getLinesContent());
            const lc = model.getLineCount();
            for (const h of hunks) {
                const cls = h.type === 'add' ? 'elpis-scm-added'
                          : (h.type === 'mod' ? 'elpis-scm-modified' : 'elpis-scm-deleted');
                const start = Math.min(h.start, lc);
                const end = h.type === 'del' ? start : Math.min(h.end, lc);
                decos.push({
                    range: new monaco.Range(start, 1, end, 1),
                    options: {
                        isWholeLine: true,
                        linesDecorationsClassName: cls,
                        overviewRuler: {
                            color: h.type === 'add' ? '#3fb95088' : (h.type === 'mod' ? '#1f6feb88' : '#f8514988'),
                            position: 1,
                        },
                    },
                });
            }
        }
        try { _scmDecoIds[path] = model.deltaDecorations(_scmDecoIds[path] || [], decos); } catch (_) {}
    }
    function _clearScm(path) {
        const m = models[path];
        if (m && !m.isDisposed() && _scmDecoIds[path]) {
            try { m.deltaDecorations(_scmDecoIds[path], []); } catch (_) {}
        }
        delete _scmDecoIds[path];
        delete _headCache[path];
    }
    // Statut Git → pastilles de l'arbre ; tout changement invalide le cache
    // HEAD (commit, checkout, pull…) et redessine la marge de l'onglet actif.
    watch(() => [gitStatus.value, gitCurrentRepo.value], () => {
        const st = gitStatus.value;
        const map = {};
        if (st && st.is_repo) {
            const pre = (gitCurrentRepo.value && gitCurrentRepo.value !== '.') ? gitCurrentRepo.value + '/' : '';
            (st.untracked || []).forEach(f => { map[pre + f.path] = 'U'; });
            (st.staged || []).forEach(f => { map[pre + f.path] = f.status === 'A' ? 'A' : (f.status === 'D' ? 'D' : 'M'); });
            (st.modified || []).forEach(f => { map[pre + f.path] = f.status === 'D' ? 'D' : 'M'; });
            (st.conflicted || []).forEach(f => { map[pre + f.path] = 'C'; });
        }
        if (window.elpisTree) window.elpisTree.setGit(map);
        Object.keys(_headCache).forEach(k => { delete _headCache[k]; });
        if (activeTabPath.value) _scheduleScmRefresh(activeTabPath.value);
    });
    // Branche affichée dans la barre d'état (fichier du dépôt courant).
    const statusBranch = vue.computed(() => {
        const st = gitStatus.value;
        const p = activeTabPath.value;
        if (!st || !st.is_repo || !p) return '';
        const pre = (gitCurrentRepo.value && gitCurrentRepo.value !== '.') ? gitCurrentRepo.value + '/' : '';
        if (pre && !p.startsWith(pre)) return '';
        return st.branch || '';
    });
    // Clic sur un fichier de la vue Git : son diff par rapport à HEAD.
    async function gitOpenChange(relPath, kind) {
        const pre = (gitCurrentRepo.value && gitCurrentRepo.value !== '.') ? gitCurrentRepo.value + '/' : '';
        const path = pre + relPath;
        if (kind === 'D') { showToast('Fichier supprimé — son contenu reste dans le dernier commit', 'info'); return; }
        if (kind === 'U' || officeIsViewerPath(path)) { await openFile(path, false); return; }
        await openFile(path, false);
        const head = await _loadHead(path, true);
        if (typeof head !== 'string' || activeTabPath.value !== path) return;
        diffBase.value = 'head';
        isDiffView.value = true;
        nextTick(() => { updateDiffView(); robustLayout(); });
    }
    const activeInRepo = vue.computed(() => {
        const p = activeTabPath.value;
        return !!(p && (gitRepos.value || []).length && _repoFor(p));
    });

    // ── Barre d'état : fin de ligne, sélection, indentation réelle ────────
    const statusEol       = ref('LF');
    const statusSelection = ref('');
    const statusModelIndent = ref('');
    // Encodage RÉEL de l'onglet actif (avant : « UTF-8 » en dur, même pour un
    // fichier latin-1 ou avec BOM — E3/E15).
    const statusEncoding = vue.computed(() => {
        const f = fileFormats[activeTabPath.value];
        if (!f) return 'UTF-8';
        return f.lossy ? 'Non UTF-8' : (f.bom ? 'UTF-8 BOM' : 'UTF-8');
    });
    const statusEolMixed = vue.computed(() => {
        const f = fileFormats[activeTabPath.value];
        return !!(f && (f.eol === 'mixed' || f.eol === 'cr'));
    });
    // Conversion EXPLICITE des fins de ligne (clic sur LF/CRLF) : annulable,
    // l'onglet devient modifié. Remplace la normalisation muette (E14).
    function toggleEol() {
        const model = monacoRef.instance && monacoRef.instance.getModel();
        const path = activeTabPath.value;
        if (!model || !path || _isReadOnlyTab(path)) return;
        try {
            const toCrlf = model.getEOL() !== '\r\n';
            model.pushEOL(toCrlf ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
            _scheduleDirtyRefresh();
            if (activeTabPath.value === path) isEditorDirty.value = _tabIsDirty(path);
            _updateStatusExtras();
            showToast('Fins de ligne : ' + (toCrlf ? 'CRLF' : 'LF') + ' (à enregistrer)');
        } catch (_) {}
    }
    function _updateStatusExtras() {
        const ed = (splitView.value && activePane.value === 'right' && monacoRef.instance2)
            ? monacoRef.instance2 : monacoRef.instance;
        const model = ed && ed.getModel();
        if (!model) return;
        try {
            statusEol.value = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
            const o = model.getOptions();
            statusModelIndent.value = (o.insertSpaces ? 'Espaces' : 'Tabs') + ' : '
                + (o.insertSpaces ? (o.indentSize || o.tabSize) : o.tabSize);
            let chars = 0;
            (ed.getSelections() || []).forEach(sel => { chars += model.getValueLengthInRange(sel); });
            statusSelection.value = chars ? (chars + ' sélectionné' + (chars > 1 ? 's' : '')) : '';
        } catch (_) {}
    }
    function _detectIndentation(model) {
        if (!model) return;
        try {
            const s = settings.value || {};
            model.detectIndentation(s.editor_insert_spaces !== false,
                Math.max(1, Math.min(8, Number(s.editor_tab_size) || 4)));
        } catch (_) {}
    }

    // ── Problèmes (marqueurs Monaco : ruff, workers JS/TS/CSS/JSON) ──────
    const activeProblems = ref([]);
    const showProblems   = ref(false);
    function _refreshProblems() {
        const p = activeTabPath.value;
        if (!p || !_modelOk(p) || !window.monaco) { activeProblems.value = []; return; }
        try {
            activeProblems.value = monaco.editor.getModelMarkers({ resource: models[p].uri })
                .filter(m => m.severity >= 4)
                .map(m => ({ sev: m.severity >= 8 ? 'error' : 'warning', line: m.startLineNumber,
                             col: m.startColumn, message: m.message, source: m.source || '' }))
                .sort((a, b) => (a.sev === b.sev ? a.line - b.line : (a.sev === 'error' ? -1 : 1)));
        } catch (_) { activeProblems.value = []; }
        if (!activeProblems.value.length) showProblems.value = false;
    }
    watch(activeTabPath, () => { nextTick(_refreshProblems); });
    const problemCounts = vue.computed(() => ({
        errors: activeProblems.value.filter(x => x.sev === 'error').length,
        warnings: activeProblems.value.filter(x => x.sev === 'warning').length,
    }));
    function goToProblem(pb) {
        showProblems.value = false;
        const ed = monacoRef.instance;
        if (!ed || !pb) return;
        const pos = { lineNumber: pb.line, column: pb.col || 1 };
        try { ed.setPosition(pos); ed.revealPositionInCenter(pos); ed.focus(); } catch (_) {}
    }

    // ── Aperçu Markdown / SVG À CÔTÉ du code, en direct ───────────────────
    const renderPaneKind   = ref('');   // 'md' | 'svg' | ''
    const renderPaneSource = ref('');
    let _renderTimer = null;
    function _kindForRender(p) {
        p = (p || '').toLowerCase();
        if (/\.(md|mdx|markdown)$/.test(p)) return 'md';
        if (p.endsWith('.svg')) return 'svg';
        return '';
    }
    function _refreshRenderPane() {
        const p = activeTabPath.value;
        renderPaneKind.value = _kindForRender(p);
        renderPaneSource.value = (renderPaneKind.value && _modelOk(p)) ? models[p].getValue() : '';
    }
    function _scheduleRenderPane() {
        if (!(splitView.value && splitMode.value === 'render')) return;
        clearTimeout(_renderTimer);
        _renderTimer = setTimeout(_refreshRenderPane, 200);
    }
    watch(activeTabPath, () => { if (splitView.value && splitMode.value === 'render') _refreshRenderPane(); });
    function toggleSplitRender() {
        showEditorMore.value = false;
        if (splitView.value && splitMode.value === 'render') { exitSplit(); return; }
        splitView.value = true;
        splitMode.value = 'render';
        activePane.value = 'left';
        try { if (monacoRef.instance2) monacoRef.instance2.setModel(null); } catch (_) {}
        _refreshRenderPane();
        nextTick(() => { _relayoutMonacoDuringTransition(); robustLayout(); });
    }
    function renderSvgSafe(src) {
        const safe = (window.elpisSvg && window.elpisSvg.sanitizeSvg) ? window.elpisSvg.sanitizeSvg(src || '') : null;
        return safe || '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60">'
            + '<text x="10" y="35" fill="#ef4444" font-family="monospace" font-size="12">SVG invalide ou vide</text></svg>';
    }

    // ── Visionneuse d'image : zoom ────────────────────────────────────────
    const imageZoom    = ref('fit');       // 'fit' | facteur (1 = 100 %)
    const imageNatural = ref({ w: 0, h: 0 });
    watch(activeTabPath, () => { imageZoom.value = 'fit'; });
    function onImageLoad(e) {
        const img = e && e.target;
        if (img) imageNatural.value = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
    }
    function _imageFitScale() {
        const img = document.querySelector('[data-image-viewer] img');
        const nw = imageNatural.value.w;
        return (img && nw) ? (img.clientWidth / nw) : 1;
    }
    function imageZoomBy(f) {
        const cur = imageZoom.value === 'fit' ? _imageFitScale() : imageZoom.value;
        imageZoom.value = Math.max(0.05, Math.min(16, Math.round(cur * f * 100) / 100));
    }
    function imageZoomSet(v) { imageZoom.value = v; }
    function onImageWheel(e) {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        imageZoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }
    const imageStyle = vue.computed(() => imageZoom.value === 'fit' ? {} : {
        maxWidth: 'none', maxHeight: 'none',
        width: Math.max(1, Math.round((imageNatural.value.w || 0) * imageZoom.value)) + 'px',
    });
    const imageZoomLabel = vue.computed(() => imageZoom.value === 'fit' ? 'Ajusté' : Math.round(imageZoom.value * 100) + ' %');

    // ── Terminal : exécuter, ouvrir ici, liens, arbre à jour ──────────────
    function _shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
    async function _termSend(cmd) {
        if (!showTerminal.value) await toggleTerminal();
        if (!showTerminal.value) return false;
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            const st = _activeTermState();
            if (st && (st.transport === 'sse' || (st.transport === 'ws' && st.ws && st.ws.readyState === 1))) {
                _sendInputFor(st, cmd + '\r');
                _scheduleTreeRefreshAfterCommand();
                try { st.term.focus(); } catch (_) {}
                return true;
            }
            await new Promise(r => setTimeout(r, 150));
        }
        showToast('Terminal indisponible', 'error');
        return false;
    }
    const _RUNNERS = {
        py: 'python3', js: 'node', mjs: 'node', cjs: 'node', sh: 'bash', bash: 'bash',
        rb: 'ruby', pl: 'perl', php: 'php', lua: 'lua', r: 'Rscript', go: 'go run',
    };
    function canRunActive() {
        const p = activeTabPath.value || '';
        const ext = p.split('.').pop().toLowerCase();
        return !!_RUNNERS[ext] || ((ext === 'html' || ext === 'htm') && !!settings.value.enable_preview);
    }
    async function runActiveFile() {
        showEditorMore.value = false;
        closeEditorCtxMenu();
        const p = activeTabPath.value;
        if (!p) return;
        const ext = p.split('.').pop().toLowerCase();
        if (ext === 'html' || ext === 'htm') {
            if (!settings.value.enable_preview) { showToast('Activez l\'aperçu Web dans les réglages', 'info'); return; }
            if (_tabIsDirty(p)) await saveEditorContent({ path: p });
            previewPath.value = p;
            if (!(splitView.value && splitMode.value === 'preview')) enterSplitPreview();
            else refreshPreview();
            return;
        }
        const runner = _RUNNERS[ext];
        if (!runner) { showToast('Aucune commande d\'exécution pour .' + ext, 'info'); return; }
        if (_tabIsDirty(p)) {
            await saveEditorContent({ path: p });
            if (_tabIsDirty(p)) return;          // enregistrement refusé : on n'exécute pas l'ancienne version
        }
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        await _termSend('cd ' + _shq('/work' + (dir ? '/' + dir : '')) + ' && ' + runner + ' ' + _shq(p.split('/').pop()));
    }
    async function openTerminalHere(dir) {
        closeTabCtxMenu();
        await _termSend('cd ' + _shq('/work' + (dir ? '/' + dir : '')));
    }
    // Après une commande (Entrée dans le terminal) : l'arbre, les onglets
    // modifiés sur disque et Git se remettent à jour — deux passes, pour les
    // commandes courtes et celles qui prennent quelques secondes.
    let _cmdRefreshTimers = [];
    function _scheduleTreeRefreshAfterCommand() {
        _cmdRefreshTimers.forEach(clearTimeout);
        _cmdRefreshTimers = [1500, 6000].map(ms => setTimeout(() => {
            if (!showEditor.value || !user.value) return;
            loadSandboxFiles();
            _checkExternalMods();
            _gitAutoRefresh();
        }, ms));
    }
    // Liens cliquables dans la sortie : « src/a.py:12 », traces Python
    // (« File "/work/a.py", line 12 »). Seuls les fichiers présents dans
    // l'arbre deviennent des liens.
    const _TERM_PATH_RE = /(?:\.{0,2}\/)?(?:[\w@.\-]+\/)*[\w@\-][\w@.\-]*\.[A-Za-z0-9]{1,10}(?::\d+(?::\d+)?)?/g;
    function _registerTermLinks(term) {
        if (!term || typeof term.registerLinkProvider !== 'function') return;
        try {
            term.registerLinkProvider({
                provideLinks(y, callback) {
                    let text = '';
                    try {
                        const line = term.buffer.active.getLine(y - 1);
                        text = line ? line.translateToString(true) : '';
                    } catch (_) { text = ''; }
                    const links = [];
                    let m;
                    _TERM_PATH_RE.lastIndex = 0;
                    while ((m = _TERM_PATH_RE.exec(text))) {
                        const parsed = window.elpisParsePath && window.elpisParsePath(m[0]);
                        if (!parsed) continue;
                        const target = _resolveSandboxPath(parsed.path);
                        if (!target) continue;
                        let line = parsed.line;
                        if (!line) {
                            const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 20);
                            const tb = tail.match(/^"?,\s*line\s+(\d+)/);
                            if (tb) line = Number(tb[1]);
                        }
                        const col = parsed.col;
                        links.push({
                            range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
                            text: m[0],
                            decorations: { underline: true, pointerCursor: true },
                            activate() { _pushNav(); openFileAtLine(target, line, col); },
                        });
                    }
                    callback(links.length ? links : undefined);
                },
            });
        } catch (_) {}
    }

    // ── Éditeur ↔ chat ────────────────────────────────────────────────────
    function askChatAboutSelection() {
        const ed = monacoRef.instance;
        const code = editorCtxMenu.value.selectionText;
        const sel = ed && ed.getSelection();
        closeEditorCtxMenu();
        const p = activeTabPath.value;
        if (!code || !sel || !p || !ctx.insertIntoChat) return;
        const lang = _getLang(p);
        const fence = code.includes('```') ? '````' : '```';
        const lines = sel.startLineNumber === sel.endLineNumber
            ? 'ligne ' + sel.startLineNumber
            : 'lignes ' + sel.startLineNumber + '-' + sel.endLineNumber;
        ctx.insertIntoChat('`' + p + '` (' + lines + ') :\n' + fence
            + (lang && lang !== 'plaintext' ? lang : '') + '\n' + code.replace(/\s+$/, '') + '\n' + fence + '\n');
    }
    async function attachToChat(path) {
        closeTabCtxMenu();
        if (!ctx.attachFileToChat || !path) return;
        const targets = window.elpisTree ? window.elpisTree.targetsFor(path) : [path];
        const files = targets.filter(p => _treeIndex.value.get(p) !== 'folder');
        if (!files.length) { showToast('Seuls des fichiers peuvent être joints', 'info'); return; }
        for (const p of files) { try { await ctx.attachFileToChat(p); } catch (_) {} }
        if (files.length < targets.length) showToast('Dossiers ignorés : seuls les fichiers sont joints', 'info');
    }
    async function openPathFromChat(path, line, col) {
        if (!settings.value || !settings.value.enable_editor) {
            showToast('L\'éditeur est désactivé dans les réglages', 'info');
            return;
        }
        if (!sandboxFiles.value.length) { try { await loadSandboxFiles(); } catch (_) {} }
        const target = _resolveSandboxPath(path);
        if (!target && !treeTruncated.value) {
            showToast('Fichier introuvable dans la sandbox : ' + _canonSandboxPath(path), 'error');
            return;
        }
        _pushNav();
        await openFileAtLine(target || _canonSandboxPath(path), line || 0, col || 0);
    }

    // ── Échap : Monaco d'abord quand un de ses widgets est ouvert ─────────
    function monacoConsumesEscape(e) {
        const t = e && e.target;
        if (!t || !t.closest) return false;
        const host = t.closest('.monaco-editor');
        if (!host) return false;
        if (host.querySelector('.find-widget.visible, .suggest-widget.visible, '
                + '.parameter-hints-widget.visible, .rename-box, .zone-widget, .peekview-widget')) return true;
        const eds = [monacoRef.instance, monacoRef.instance2,
                     monacoRef.diff && monacoRef.diff.getModifiedEditor()];
        for (const ed of eds) {
            try {
                if (ed && ed.getContainerDomNode().contains(t) && (ed.getSelections() || []).length > 1) return true;
            } catch (_) {}
        }
        return false;
    }

    // ── Proposition de l'IA : diff Accepter / Rejeter ─────────────────────
    const aiProposal = ref(null);          // { path, label } — pour le bandeau
    let _aiProposal = null;                // { model, versionId, range, text, tmp }
    function proposeAiEdit(p) {
        if (!p || !p.model || !monacoRef.diff || !monacoRef.originalModel || !window.monaco) return false;
        rejectAiProposal({ silent: true });
        const model = p.model;
        const original = model.getValue();
        const s0 = model.getOffsetAt({ lineNumber: p.range.startLineNumber, column: p.range.startColumn });
        const s1 = model.getOffsetAt({ lineNumber: p.range.endLineNumber, column: p.range.endColumn });
        const tmp = monaco.editor.createModel(original.slice(0, s0) + p.text + original.slice(s1), model.getLanguageId());
        try {
            monacoRef.originalModel.setValue(original);
            monaco.editor.setModelLanguage(monacoRef.originalModel, model.getLanguageId());
            monacoRef.diff.setModel({ original: monacoRef.originalModel, modified: tmp });
            monacoRef.diff.getModifiedEditor().updateOptions({ readOnly: true });
        } catch (_) { try { tmp.dispose(); } catch (__) {} return false; }
        _aiProposal = { model, versionId: p.versionId, range: p.range, text: p.text, tmp };
        aiProposal.value = { path: activeTabPath.value, label: p.label || 'Proposition de l\'IA' };
        diffBase.value = 'proposal';
        isDiffView.value = true;
        nextTick(() => {
            robustLayout();
            try { monacoRef.diff.getModifiedEditor().revealLineInCenter(p.range.startLineNumber); } catch (_) {}
        });
        return true;
    }
    function _closeAiProposal() {
        const pr = _aiProposal;
        _aiProposal = null;
        aiProposal.value = null;
        try { monacoRef.diff.getModifiedEditor().updateOptions({ readOnly: false }); } catch (_) {}
        if (isDiffView.value && diffBase.value === 'proposal') {
            isDiffView.value = false;
            diffBase.value = 'saved';
        }
        try { if (monacoRef.diff && pr) monacoRef.diff.setModel(null); } catch (_) {}
        try { if (pr && pr.tmp) pr.tmp.dispose(); } catch (_) {}
        nextTick(() => robustLayout());
    }
    function acceptAiProposal() {
        const pr = _aiProposal;
        if (!pr) return;
        if (pr.model.isDisposed() || pr.model.getVersionId() !== pr.versionId) {
            showToast('Document modifié entre-temps — proposition abandonnée', 'warning');
            _closeAiProposal();
            return;
        }
        _closeAiProposal();
        try {
            if (monacoRef.instance && monacoRef.instance.getModel() === pr.model) {
                monacoRef.instance.executeEdits('ai-infill', [{ range: pr.range, text: pr.text }]);
                monacoRef.instance.focus();
            } else {
                pr.model.pushEditOperations([], [{ range: pr.range, text: pr.text }], () => null);
            }
            showToast('Modification appliquée');
        } catch (_) { showToast('Application impossible', 'error'); }
    }
    function rejectAiProposal(opts) {
        if (!_aiProposal) return;
        _closeAiProposal();
        if (!(opts && opts.silent)) showToast('Proposition rejetée');
    }

    // ── Raccourcis de l'éditeur (capture : avant Monaco) ──────────────────
    // Ctrl+W / Ctrl+Tab / Ctrl+T sont RÉSERVÉS par les navigateurs (jamais
    // livrés à la page) : fermer = Alt+W, onglet voisin = Alt+PgPréc/PgSuiv.
    const _IS_MAC = typeof navigator !== 'undefined'
        && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
    function _focusInEditor() {
        const ae = document.activeElement;
        if (ae && ae.closest && ae.closest('[data-editor-root]')) return true;
        return editorFullscreen.value && (!ae || ae === document.body);
    }
    function _cycleTab(dir) {
        const tabs = openTabs.value;
        if (!tabs.length) return;
        const i = tabs.findIndex(t => t.path === activeTabPath.value);
        const next = tabs[(i + dir + tabs.length) % tabs.length];
        if (next) switchTab(next.path);
    }
    window.addEventListener('keydown', (e) => {
        if (!settings.value || !settings.value.enable_editor || !showEditor.value) return;
        const mod = e.ctrlKey || e.metaKey;
        const code = e.code;
        // Ctrl+` : terminal (éditeur ouvert, où que soit le focus).
        if (mod && !e.altKey && !e.shiftKey && code === 'Backquote') {
            e.preventDefault(); e.stopPropagation();
            toggleTerminal();
            return;
        }
        if (!_focusInEditor()) return;
        // Le TERMINAL garde toutes ses touches : Ctrl+B (vim, less, préfixe
        // tmux), Alt+←/→ (mots de readline), Alt+W… y ont un sens propre.
        const _ae = document.activeElement;
        if (_ae && _ae.closest && _ae.closest('.xterm')) return;
        // Champ de saisie ordinaire (recherche, remplacement, message de
        // commit) — PAS la zone de frappe de Monaco : les touches de
        // déplacement lui reviennent.
        const _inField = !!(_ae && (_ae.tagName === 'INPUT' || _ae.tagName === 'TEXTAREA'
                                    || _ae.isContentEditable)
                            && !(_ae.closest && _ae.closest('.monaco-editor')));
        if (mod && e.altKey && !e.shiftKey && code === 'KeyS') {
            e.preventDefault(); e.stopPropagation();
            saveAllTabs();
            return;
        }
        if (mod && !e.altKey && !e.shiftKey && code === 'KeyB' && !_inField) {
            e.preventDefault(); e.stopPropagation();
            showExplorer.value = !showExplorer.value;
            return;
        }
        if (e.altKey && !mod && !e.shiftKey) {
            // Alt+W, Alt+C… sont aussi des bascules de la recherche Monaco.
            const ae = document.activeElement;
            if (ae && ae.closest && ae.closest('.find-widget')) return;
            let handled = true;
            if (code === 'KeyW')            { if (activeTabPath.value) closeTab(activeTabPath.value); }
            else if (code === 'PageDown')   _cycleTab(1);
            else if (code === 'PageUp')     _cycleTab(-1);
            else if (code === 'KeyL')       revealActiveInTree();
            // Option+←/→ = déplacement par mot sur macOS ; et dans un champ
            // de saisie les flèches appartiennent au champ.
            else if (code === 'ArrowLeft' && !_inField && !_IS_MAC)  navBack();
            else if (code === 'ArrowRight' && !_inField && !_IS_MAC) navForward();
            else handled = false;
            if (handled) { e.preventDefault(); e.stopPropagation(); }
        }
    }, true);

    // ==============================================================
    //  PUBLIC API
    // ==============================================================

    return {
        // State
        showEditor, showExplorer, explorerWidth, sandboxFiles, sandboxQuota, isLoadingFiles, showHiddenFiles, fileInput,
        openTabs, activeTabPath, isEditorDirty, isTypingEffect, editorFilePath,
        isDiffView, editorMode, previewPath, previewKey,
        previewSource, previewPort, previewServerPath, previewSrc,
        previewServerUrl, previewServerHostWarn,
        commitPreviewServerUrl, reloadPreview,
        sandboxSearch, sandboxSearchMode, sandboxSearchResults, isSearchingSandbox, filteredFilesList,
        sandboxFileInput, sandboxFolderInput, showImportMenu,

        // Monaco internals (needed by app.js for dispose on logout)
        monacoRef, models,

        // Core editor
        initMonaco, toggleEditor, openFile, refreshPreview,
        updateDiffView, toggleDiffMode, switchTab, closeTab,
        saveEditorContent, lintCurrentFile, capturePreWrite, showDiffForMessage, showToolDiff, robustLayout, disposeAll,

        // Typewriter
        updateEditor, checkExternalModsSoon, rescueDirtyBuffers,
        // Historique de la session
        historySession, historyEntries, historyLoading, HISTORY_SOURCES,
        loadHistorySession, openHistoryPanel, toggleHistoryFile, historyCompare,
        historyRestore, historyTime, toggleOriginalDiff,

        // Tool-streaming write (write_file / edit_file live in editor)
        streamOpenForWrite, streamLocateEdit, streamWriteChunk,
        streamFinalize, isStreamActive, getStreamPreSnapshot,

        // File system
        loadSandboxFiles, treeTruncated, toggleHiddenFiles, loadSandboxQuota, scheduleQuotaRefresh, downloadFile, createFolder, createFile, openFileAtLine,
        renameItem, deleteFile, moveItem,
        triggerSandboxImport, handleSandboxImport,

        // Snapshots (sandbox state archive + restore)
        snapshots, snapshotsMax,
        snapshotBusy, snapshotProgress,
        showSnapshotPanel, snapshotName,
        loadSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot,
        toggleSnapshotPanel,
        restoreIncomplete, dismissRestoreIncomplete, restoreIncompleteWhen,

        // Editor Context Menu + FIM
        fimLoading, fimGhostText,
        editorCtxMenu,
        closeEditorCtxMenu, editorCtxComplete,
        editorCtxRunAI, editorCtxToggleComment, editorCtxFormatDoc,
        editorCtxCopy, editorCtxGoToDef, editorCtxFindRefs, editorCtxRename,

        // Terminal
        showTerminal, terminalHeight,
        terminalInitOverlay, dismissTerminalInitOverlay,
        toggleTerminal, terminalResizeStart,
        // Multi-session terminal
        termSessions, termActiveSid, termMaxSessions,
        termMultiSession, termRenamingSid, termRenameValue,
        termSessionStatus, termSessionState, termSessionTitle,
        termNewSession, termCloseSession, termSwitchTo,
        termStartRename, termCommitRename, termCancelRename,

        // Editor split resize
        editorSplitDragging, editorSplitStart,

        // Explorer resize
        explorerResizeStart,

        // Markdown preview
        mdPreview, isCurrentFileMd,
        svgPreview, isCurrentFileSvg, toggleSvgPreview,

        // Fullscreen
        editorFullscreen, toggleEditorFullscreen, exitEditorFullscreen, showEscapeHint,
        // Menu « + » de la barre d'en-tête
        showEditorMore,
        // Vue scindée (split view)
        splitView, splitTabPath, activePane, splitRatio, splitMode,
        toggleSplit, enterSplit, exitSplit, setSplitFile,
        toggleSplitPreview, enterSplitPreview,
        previewLive, togglePreviewLive, openPreviewInNewTab,
        onTabActivate, openInSplit, splitResizeStart,
        revealFolderInTree, breadcrumbSegments,

        // Git
        explorerTab, gitRepos, gitCurrentRepo, showGitRepoMenu, showExplorerMenu,
        gitStatus, gitBranches, gitCommitMsg, gitLoading, gitError,
        showGitCloneModal, gitCloneForm, showGitBranchMenu,
        gitCloneConnectorId, gitCloneRepos, gitCloneReposLoading,
        gitCloneReposError, gitCloneRepoFilter, gitFilteredCloneRepos,
        gitOpenCloneModal, gitLoadConnectorRepos, gitPickRepo,
        showGitRemoteModal, gitRemoteForm,
        showGitInitModal, gitInitForm, showGitMoreMenu,
        showGitMergeModal, gitMergePreview, gitMergeBranch,
        showGitPushAuth, gitCredShowPwd, gitPushAfterAuth,
        gitOpenMergeModal, gitLoadMergePreview, gitExecuteMerge,
        gitMergeAbort, gitMergeResolve,
        gitTree, gitLog, gitDiffData, gitCredUser, gitCredToken, gitSectionOpen,
        gitOpenTab, gitSelectRepo, gitLoadRepos, gitRefresh, gitLoadBranches,
        gitLoadTree, gitLoadLog, gitOpenRepoFile,
        gitViewCommitDiff, gitShowFileDiff, gitRestoreCommit, gitRevertLast,
        gitInit, gitClone, gitStage, gitUnstage, gitDiscard,
        gitCommit, gitPush, gitPull, gitFetch,
        gitCheckout, gitCreateBranch, gitPromptMerge, gitRebase, gitPromptRebase, gitStash, gitSetRemote,

        // Language helpers (exported for optional use by other modules)
        _getLang,

        // Quick Open (Ctrl+P)
        quickOpenVisible, quickOpenQuery, quickOpenSelectedIdx, quickOpenResults,
        openQuickOpen, closeQuickOpen, quickOpenSelect, quickOpenKeyDown,

        // Status bar
        statusCursor, statusLineCount, statusLanguage, statusIndent,

        // Tab management (right-click menu + reopen + restore)
        tabCtxMenu, openTabCtxMenu, closeTabCtxMenu,
        closeOtherTabs, closeTabsToRight, closeAllTabs, copyTabPath,
        reopenLastClosed,
        // Indicateur dirty par onglet + badge de débordement « +X »
        dirtyTabs, tabStripRef, hiddenTabsCount, showTabsOverflow,
        updateHiddenTabs, pickTabFromOverflow, scrollTabIntoView,

        // Shortcuts help modal (Ctrl+/)
        shortcutsModalVisible, shortcutGroups,
        openShortcutsModal, closeShortcutsModal,

        // Passe 11 — viewers spéciaux (image / hex / docx)
        activeFileViewMode,
        imageViewerPath,
        hexViewerData, hexViewerLines, hexViewerLoading,
        readOnlyTabs,
        // Aperçus Office / PDF (2026-09-15)
        activeIsViewer, officeActive, officeNow,
        officeSetView, officeReload, officeUseText, officeFetchChunk,
        officeIsViewerPath, editorRefreshViewer,

        // Nettoyage de session (proxifié par ctx.resetEditorOnLogout)
        resetOnLogout,

        // ── Passe UX 2026-09-19 ──────────────────────────────────────
        // Protection du travail : conflits disque, copie de secours
        diskConflicts, assistantStash, activeBanner,
        conflictReload, conflictCompare, conflictOverwrite, conflictDismiss,
        stashRestore, stashCompare, stashDismiss,
        saveAllTabs,
        // Arbre : localiser, replier, sélection, dupliquer
        revealActiveInTree, collapseAllFolders, explorerMultiCount, duplicateItem,
        // Onglets : épingler, réordonner, icône, homonymes
        togglePinTab, tabIcon, tabLabelParts, tabHints, tabDropTarget,
        onTabDragStart, onTabDragOver, onTabDrop, onTabDragEnd,
        // Navigation
        navBack, navForward, recentFiles, quickOpenRecent,
        // Recherche / remplacement dans les fichiers
        searchCase, searchRegex, searchGlob, searchTruncated, searchError, searchResultGroups,
        showReplace, replaceText, replacePreview, replaceBusy, replaceSelectedCount,
        previewReplace, applyReplace,
        // Git
        diffBase, statusBranch, activeInRepo, gitOpenChange,
        gitResolveFile, gitSuggestCommitMessage, gitCommitSuggesting,
        // Barre d'état + problèmes
        statusEol, statusEncoding, statusEolMixed, toggleEol, statusSelection, activeProblems, problemCounts, showProblems, goToProblem,
        // Aperçus à côté, image
        renderPaneKind, renderPaneSource, toggleSplitRender, renderSvgSafe,
        imageZoom, imageZoomLabel, imageStyle, imageZoomBy, imageZoomSet, onImageLoad, onImageWheel,
        // Terminal
        runActiveFile, canRunActive, openTerminalHere,
        // Éditeur ↔ chat
        askChatAboutSelection, attachToChat, openPathFromChat,
        // IA : proposition en diff
        aiProposal, acceptAiProposal, rejectAiProposal,
        // Échap : Monaco d'abord (cascade d'app.js)
        monacoConsumesEscape,
    };
}
