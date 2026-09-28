// SPDX-License-Identifier: MIT
// === JETON DE CONSOLE (audit 2026-09-21) ===
// Dès qu'un jeton de service est configuré, l'API de la console répond 401
// sans le cookie posé par /api/console/login. On demande alors le jeton UNE
// fois (les requêtes concurrentes attendent la même saisie), puis on rejoue
// la requête. Les EventSource reprennent seuls : le cookie part avec eux.
//
// (passe RAG 2 2026-09-26) Plus de boucle de saisie : si le serveur répond
// « ouvert » (aucun jeton configuré, mais accès hors boucle locale refusé),
// redemander un jeton ne sert à rien → bannière « non autorisé » à la place.
// Les XHR d'import passent par la même porte (window._ragAuth.login()).
(function () {
    const _fetch = window.fetch.bind(window);
    let _login = null;
    let _declined = false;      // saisie annulée : plus de fenêtre jusqu'au rechargement
    const _signal = (msg) => window.dispatchEvent(new CustomEvent('rag-auth', { detail: msg }));
    async function _askToken() {
        if (_declined) return false;
        const tok = window.prompt('Jeton du service RAG (fichier user_db/.rag_service_token ou réglage rag.service_token) :');
        if (!tok) { _declined = true; _signal('Accès refusé : jeton requis.'); return false; }
        let r;
        try {
            r = await _fetch('/api/console/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: tok.trim() }), credentials: 'same-origin',
            });
        } catch (e) { _signal('Serveur injoignable.'); return false; }
        if (!r.ok) { window.alert('Jeton refusé.'); return false; }
        const d = await r.json().catch(() => ({}));
        if (d && d.open) {
            // Aucun jeton côté serveur : le 401 vient de l'accès distant.
            _declined = true;
            _signal('Accès distant refusé : configurez un jeton de service.');
            return false;
        }
        _signal('');
        return true;
    }
    function login() {
        if (!_login) _login = _askToken().finally(() => { setTimeout(() => { _login = null; }, 0); });
        return _login;
    }
    window._ragAuth = { login, retry() { _declined = false; return login(); } };
    window.fetch = async function (input, init) {
        const res = await _fetch(input, init);
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (res.status !== 401 || !/^\/api\//.test(url) || /^\/api\/console\//.test(url)) return res;
        if (_declined) { _signal('Accès refusé : jeton requis.'); return res; }
        return (await login()) ? _fetch(input, init) : res;
    };
})();

// === APPELS API (passe RAG 2 2026-09-26) ===
// Un seul chemin pour tous les appels JSON : statut HTTP vérifié, corps
// d'erreur lu ({detail} FastAPI, {msg}/{error} maison, {status:"error"},
// {ok:false}), message lisible levé. Plus d'« OK » affiché sur un refus.
class ApiError extends Error {
    constructor(message, status = 0, data = null) { super(message); this.status = status; this.data = data; }
}
const _errText = (data, fallback) => {
    if (!data || typeof data !== 'object') return fallback;
    const d = data.detail;
    if (Array.isArray(d)) {
        // 422 pydantic : [{loc, msg}]
        return d.map(x => (x && x.msg ? ((x.loc || []).filter(p => p !== 'body').join('.') + ' : ' + x.msg).replace(/^ : /, '') : String(x))).join(' ; ') || fallback;
    }
    if (d && typeof d === 'object') return d.msg || d.message || JSON.stringify(d);
    return d || data.msg || data.error || data.message || fallback;
};
async function _api(url, opts = {}) {
    const init = { ...opts };
    delete init.json; delete init.allowFail;
    if (opts.json !== undefined) {
        init.method = init.method || 'POST';
        init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
        init.body = JSON.stringify(opts.json);
    }
    let res;
    try { res = await fetch(url, init); }
    catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw new ApiError('Serveur injoignable.', 0);
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    try {
        if (ct.includes('json')) data = await res.json();
        else { const t = await res.text(); data = t ? { text: t } : null; }
    } catch (e) { data = null; }
    if (!res.ok) {
        const fb = res.status === 401 ? 'Non autorisé.' : res.status === 404 ? 'Introuvable.' : `Erreur ${res.status}`;
        throw new ApiError(_errText(data, fb), res.status, data);
    }
    if (!opts.allowFail && data && typeof data === 'object' && !Array.isArray(data)
            && (data.status === 'error' || data.ok === false)) {
        throw new ApiError(_errText(data, 'Opération refusée.'), res.status, data);
    }
    return data;
}

// === NETTOYAGE HTML (audit 2026-09-22, M5) ===
// Tout HTML injecté par x-html (markdown OCR, README, aperçu CSV) passe par
// DOMPurify ; sans lui, texte échappé. Un document OCRisé ou un fichier
// indexé ne peut plus porter de script dans la console.
const _escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const _purify = (html) => (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function')
    ? window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : _escHtml(html);
const _mdToHtml = (md) => {
    const src = md || '';
    try { return window.marked ? window.marked.parse(src) : _escHtml(src); }
    catch (e) { return _escHtml(src); }
};

// === CONFIG : défauts profonds ===
// Chaque bloc imbriqué lié au formulaire existe toujours, y compris AVANT le
// premier chargement (sinon config.ocr.* / config.sparse.* levaient au rendu
// initial, et un rag_config.json sans bloc « sparse » cassait l'onglet).
function _cfgDefaults(c) {
    const cfg = (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
    const top = { allowed_ext: [], extension_rules: {}, folder_rules: {}, file_rules: {},
                  global_method: 'size', global_value: '', global_chunk_size: 1000,
                  global_chunk_overlap: 150, global_max_chunk_size: 4000, global_max_doc_length: 100000,
                  qdrant_url: '', collection: '', embed_base_url: '', embed_model: '', chatbot_url: '' };
    for (const k in top) if (cfg[k] === undefined || cfg[k] === null) cfg[k] = top[k];
    if (!cfg.global_method) cfg.global_method = 'size';
    const blocks = {
        reranker: { enabled: false, url: '', model: 'bge-reranker-v2-m3', top_k_before: 30, top_k_after: 8,
                    timeout: 10, api_key: '', min_score: 0.0 },
        sparse: { enabled: false, url: '', timeout: 30, prefetch_limit: 50 },
        contextual: { enabled: false, url: '', model: '', api_key: '', timeout: 30, max_doc_chars: 30000,
                      max_tokens: 200, temperature: 0.0 },
        ocr: { enabled: true, host: '', port: 8090, api_key: '', prompt: '', zone_prompt: '',
               default_model: '', max_side_px: 1280, max_upload_mb: 100, max_pages: 300,
               max_docs: 200, max_disk_mb: 8192, collection: 'ocr-documents', auto_index: false },
    };
    for (const b in blocks) {
        if (!cfg[b] || typeof cfg[b] !== 'object' || Array.isArray(cfg[b])) cfg[b] = {};
        for (const k in blocks[b]) if (cfg[b][k] === undefined) cfg[b][k] = blocks[b][k];
    }
    return cfg;
}

// === HIGHLIGHT.JS + MARKED ===
if (typeof window.marked !== 'undefined') {
    const renderer = new window.marked.Renderer();
    renderer.code = function(codeOrToken, language) {
        let codeText = typeof codeOrToken === 'string' ? codeOrToken : (codeOrToken.text || '');
        let lang = (typeof codeOrToken === 'string' ? language : codeOrToken.lang) || '';
        let match = lang.match(/\S*/); lang = match ? match[0] : '';
        let highlighted = _escHtml(codeText);
        if (!window.hljs) return `<pre><code>${highlighted}</code></pre>\n`;
        if (lang && window.hljs.getLanguage(lang)) {
            try { highlighted = window.hljs.highlight(codeText, { language: lang }).value; } catch (e) {}
        } else { try { highlighted = window.hljs.highlightAuto(codeText).value; } catch (e) {} }
        return `<pre><code class="hljs ${lang ? 'language-' + _escHtml(lang) : ''}">${highlighted}</code></pre>\n`;
    };

    // Anti-exfiltration (P0 audit harness 2026-07-24, même politique que le
    // chatbot) : une image EXTERNE auto-chargée dans le markdown = requête
    // réseau dont l'URL peut encoder le contenu affiché — un document OCRisé
    // malveillant suffit à la déclencher. data:image/*, blob: et même-origine
    // passent ; toute URL http(s) tierce devient un lien cliquable (aucun
    // chargement automatique). Branché en hook postprocess → couvre tous les
    // marked.parse() de l'app.
    const _isRemoteUrl = (v) => {
        const s = String(v == null ? '' : v).trim();
        if (!s) return false;
        if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return false;
        if (/^data:/i.test(s)) return true;
        try {
            const u = new URL(s, window.location.href);
            return (u.protocol === 'http:' || u.protocol === 'https:')
                ? u.origin !== window.location.origin : true;
        } catch (e) { return true; }
    };
    const _neutralizeRemoteMedia = (html) => {
        if (!html || !/<(img|video|audio|source|track|input)\b|style\s*=/i.test(html)) return html;
        try {
            const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
            const root = doc.body && doc.body.firstChild;
            if (!root) return html;
            root.querySelectorAll('img').forEach((img) => {
                img.removeAttribute('srcset'); img.removeAttribute('sizes');
                const src = img.getAttribute('src') || '';
                if (!_isRemoteUrl(src)) return;
                const a = doc.createElement('a');
                a.setAttribute('href', src);
                a.setAttribute('target', '_blank');
                a.setAttribute('rel', 'noopener noreferrer nofollow');
                a.title = "Image externe non chargée automatiquement — cliquer pour l'ouvrir";
                let host = 'lien';
                try { host = new URL(src, window.location.href).hostname; } catch (e) {}
                const alt = (img.getAttribute('alt') || '').trim();
                a.textContent = (alt ? alt + ' — ' : '') + 'image externe (' + host + ')';
                if (img.parentNode) img.parentNode.replaceChild(a, img);
            });
            root.querySelectorAll('video, audio, source, track, input').forEach((el) => {
                ['src', 'poster', 'srcset'].forEach((at) => {
                    if (el.hasAttribute(at) && _isRemoteUrl(el.getAttribute(at))) el.removeAttribute(at);
                });
            });
            root.querySelectorAll('[style]').forEach((el) => {
                if (/url\s*\(/i.test(el.getAttribute('style') || '')) el.removeAttribute('style');
            });
            return root.innerHTML;
        } catch (e) { return html; }
    };
    window.marked.use({ renderer, hooks: { postprocess: (html) => _neutralizeRemoteMedia(_purify(html)) } });
}

document.addEventListener('alpine:init', () => {
    Alpine.data('app', () => ({

        appInfo: { name: "Elpis RAG Manager", version: "2.5.0", author: "Elpis",
                   description: "Console de la base vectorielle et des documents OCR." },
        aboutModalOpen: false,
        tab: 'index',
        logTab: 'traces',

        files: [], treeNodes: [], folderStates: {}, searchQuery: '',
        selectedFiles: new Set(), selectionMode: false,

        // Défauts complets dès le premier rendu (voir _cfgDefaults).
        config: _cfgDefaults({}),

        // Reranker connectivity test result. ``null`` until the user
        // clicks "Tester le reranker"; then either ``{ok:true,...}`` or
        // ``{ok:false, msg:...}`` from /api/reranker/test.
        rerankerTest: null,
        rerankerTestBusy: false,
        // ── Sparse ────────────────────────────────────────────────────
        // Same UX pattern as the reranker: ``sparseTest`` holds the last
        // /api/sparse/test response (null = never tested), ``Busy`` gates
        // the spinner. Both reset to null on every fresh click so the
        // "Échec" banner from a previous attempt doesn't linger.
        sparseTest: null,
        sparseTestBusy: false,
        // ── Contextual Retrieval ──────────────────────────────────────
        // Same shape as sparse/reranker test slots. The success payload
        // contains ``sample_context`` — the actual LLM output on a
        // synthetic test pair — surfaced in the panel so the admin can
        // sanity-check the prompt is producing useful French output.
        contextualTest: null,
        contextualTestBusy: false,

        collections: [], oldCollection: '', newCollectionModalOpen: false, newCollectionName: '',
        traces: [], rawLogsContent: '', toasts: [], _toastSeq: 0,
        isDragging: false, uploadProgressModal: false, uploadProgress: 0, uploadLabel: '',
        restartingModal: false, restartMsg: '',
        fileViewerModalOpen: false, activeFileNode: null, fileViewerContent: '', isEditingFile: false, fileViewerLoading: false,
        _fileOriginal: '', editorHl: '', _editorHlTimer: null,
        isCsvEditing: false, csvData: [], csvSeparator: ',',
        converterSourcePath: '', converterTargetFormat: '', converterTargetFormats: [], converterLoading: false,
        converterFilter: '',
        qdrantStatus: 'checking', llmStatus: 'checking', qdrantLatency: null, llmLatency: null,
        qdrantTelemetry: null, telemetryLoading: false, telemetryError: '',
        collectionStats: null, statsLoading: false,
        duplicates: [], duplicatesLoading: false, duplicatesModalOpen: false,
        newExt: '', newMethod: 'size', newVal: '',

        // ── Robustesse (passe RAG 2 2026-09-26) ────────────────────────
        // busy[clé] : anti double-clic par action ; configLoaded : tant que
        // la config n'a pas été lue, AUCUNE sauvegarde (on écraserait le
        // serveur avec les défauts JS) ; _savedConfig : instantané JSON pour
        // signaler les modifications non enregistrées.
        busy: {},
        configLoaded: false, configError: '', _savedConfig: '{}',
        authError: '',
        ocrEnabled: true,
        treeLimit: 300,

        // ── Tâche d'indexation de fond (ingestion / réindexation globale) ──
        // Vit côté serveur : fermer l'onglet ne l'arrête pas ; au retour, on
        // relit /api/tasks/index et on reprend le flux là où on l'a laissé.
        indexTask: null,             // {id, kind, state, total, current, success, error}
        taskModalOpen: false,
        taskLogs: [],
        _taskEvents: null, _taskSeq: 0, _taskRetry: null, _taskRetryMs: 1000,

        // splitState: per chunk_index → { open, params, loading, error }
        splitState: {},

        // ── Reindex modal ──────────────────────────────────────────────
        reindexModalOpen: false, reindexFileTarget: null, reindexMode: 'default',
        reindexParams: { method: 'size', size: 1000, overlap: 150, value: '' },
        reindexPreviewChunks: [], reindexLoading: false,
        reindexRunning: false, reindexProgressPct: 0, reindexDone: false, reindexDoneMsg: '',
        reindexCurrentChunks: [], reindexChunksLoading: false, reindexRightTab: 'preview',
        previewSplitState: {}, previewHasSplits: false,
        startupStatus: null,

        // ── Reindex / Sync progress modal ─────────────────────────────
        reindexProgressModal: false, reindexProgressLabel: '', reindexProgressFile: '',
        reindexProgressPct2: 0, reindexProgressDone: false, reindexProgressChunks: 0,
        reindexProgressElapsed: 0, _reindexTimer: null, _reindexStart: 0, _reindexCloseTimer: null,

        // ── Node rule ──────────────────────────────────────────────────
        nodeRuleModalOpen: false, activeRuleNode: null,
        nodeRuleParams: { method: 'size', size: 1000, overlap: 150, value: '' },

        // ── Confirm modal ──────────────────────────────────────────────
        confirmModal: { open: false, title: '', message: '', confirmText: 'Confirmer', cancelText: 'Annuler', isDanger: false, resolve: null },

        // ── Help ───────────────────────────────────────────────────────
        helpModalOpen: false, readmeContent: '', isLoadingReadme: false,

        // ── Search Playground ──────────────────────────────────────────
        searchPlaygroundQuery: '', searchPlaygroundFolder: '', searchPlaygroundExt: '',
        searchPlaygroundTopK: 10, searchPlaygroundHybrid: true,
        searchPlaygroundResults: [], searchPlaygroundLoading: false,
        searchPlaygroundError: '', searchPlaygroundMode: '',

        // ── Documents (OCR) ────────────────────────────────────────────
        // Onglet lean : bibliothèque + file à gauche, lecteur à droite.
        // L'état de vérité vit côté serveur (meta.json) — le live SSE ne
        // fait que patcher ce qui est affiché.
        documents: [], docFilter: '', docsLoading: false,
        ocrStatus: null,                 // GET /api/ocr/status (bandeau config)
        selectedDocId: null,
        selectedDoc: null,               // meta détaillée (pages[])
        selectedPageN: 0,
        pageData: null,                  // GET pages/{n} → {md, boxes, status…}
        pageEditing: false, pageDraft: '', pageSaving: false,
        ocrQueue: { paused: false, active: null, items: [], batch: null },
        ocrRagStatus: null,              // GET /api/ocr/rag/status
        ocrDragging: false,
        _ocrEvents: null,                // EventSource /api/ocr/events
        ocrLive: 'off',                  // off | up | retry — bannière de flux
        _ocrRetryMs: 1000, _ocrRetryTimer: null,
        _docReq: 0, _pageReq: 0,         // jetons anti-réponse périmée
        ocrFollow: true,                 // le lecteur suit la page en cours d'OCR
        thumbLimit: 60,
        ocrSearchQuery: '', ocrSearchResults: null, ocrSearchBusy: false,
        tagDraft: '', tagEditing: false,
        // Découverte de modèles (carte Connexions → OCR)
        ocrModels: [], ocrModelsError: '', ocrModelsBusy: false,
        ocrModelActionBusy: '',

        // ── Computed ───────────────────────────────────────────────────
        // pageTitle / pageDesc drive the sticky header at the top of
        // every tab. They mirror the sidebar labels (max 2 words) but
        // expanded to a sentence so the user lands with full context.
        // Two principles:
        //   • Title = ONE descriptive noun phrase, not a marketing tagline.
        //   • Desc  = ONE sentence answering "what can I do here?".
        get pageTitle() {
            return {
                index:      'Fichiers',
                documents:  'Documents',
                strategies: 'Découpage',
                search:     'Recherche',
                converter:  'Outils',
                settings:   'Connexions',
                logs:       'Journaux',
            }[this.tab];
        },
        get pageDesc() {
            return {
                index:      'Importez et organisez vos documents source. Suivez l\'état d\'indexation.',
                documents:  'Déposez un PDF ou un Word, lisez-le par OCR, corrigez la transcription et indexez-la.',
                strategies: 'Définissez les règles de chunking par défaut, par dossier, par extension ou par fichier.',
                search:     'Testez vos requêtes sémantiques (vector + BM25/RRF) en temps réel.',
                converter:  'Utilitaires de conversion entre formats de fichiers.',
                settings:   'Configurez Qdrant, le modèle d\'embedding et le serveur OCR.',
                logs:       'Tracez les requêtes RAG et inspectez la santé du système.',
            }[this.tab];
        },
        get filteredDocuments() {
            const f = (this.docFilter || '').trim().toLowerCase();
            if (!f) return this.documents;
            return this.documents.filter(d => (d.name || '').toLowerCase().includes(f)
                || (d.tags || []).some(t => String(t).toLowerCase().includes(f)));
        },
        get selectedCount() { return this.selectedFiles.size; },
        get indexedFilesCount()   { return this.files.filter(f => f.indexed).length; },
        get unindexedFilesCount() { return this.files.filter(f => !f.indexed).length; },
        // Aliases courts utilisés dans index.html
        get indexedCount()   { return this.indexedFilesCount; },
        get unindexedCount() { return this.unindexedFilesCount; },
        get totalSizeHuman() { return this.formatBytes(this.files.reduce((acc, f) => acc + (f.size || 0), 0)); },
        // Arbre rendu par tranches : un corpus de milliers de fichiers ne
        // pose plus des milliers de lignes dans le DOM d'un coup.
        get visibleTreeNodes() { return this.treeNodes.slice(0, this.treeLimit); },
        get converterOptions() {
            const q = (this.converterFilter || '').trim().toLowerCase();
            const list = q ? this.files.filter(f => f.rel_path.toLowerCase().includes(q)) : this.files;
            return list.slice(0, 200);
        },
        get converterOptionsTruncated() {
            const q = (this.converterFilter || '').trim().toLowerCase();
            const n = q ? this.files.filter(f => f.rel_path.toLowerCase().includes(q)).length : this.files.length;
            return n > 200 ? n : 0;
        },
        get indexTaskRunning() { return !!(this.indexTask && this.indexTask.state === 'running'); },
        get indexTaskPct() {
            const t = this.indexTask;
            if (!t || !t.total) return t && t.state !== 'running' ? 100 : 0;
            return Math.min(100, Math.round((t.current || 0) / t.total * 100));
        },
        get indexTaskTitle() {
            const t = this.indexTask;
            if (!t) return '';
            const what = t.kind === 'bulk_reindex' ? 'Réindexation' : 'Synchronisation';
            return t.folder ? `${what} · ${t.folder}` : what;
        },
        get visibleThumbs() { return (this.selectedDoc?.pages || []).slice(0, this.thumbLimit); },
        get pageDirty() { return this.pageEditing && this.pageDraft !== (this.pageData?.md || ''); },
        get fileDirty() {
            if (!this.isEditingFile) return false;
            if (this.isCsvEditing) return this.serializeCSV(this.csvData, this.csvSeparator) !== this._fileOriginal;
            return this.fileViewerContent !== this._fileOriginal;
        },
        // Modifications de config non enregistrées, par section d'écran.
        _CONFIG_SECTIONS: {
            strategies: ['global_method', 'global_value', 'global_chunk_size', 'global_chunk_overlap',
                         'global_max_chunk_size', 'global_max_doc_length', 'extension_rules'],
            settings:   ['qdrant_url', 'collection', 'embed_base_url', 'embed_model', 'chatbot_url',
                         'sparse', 'ocr', 'reranker', 'contextual'],
            rules:      ['file_rules', 'folder_rules'],
            collection: ['collection'],
        },
        sectionDirty(section) {
            if (!this.configLoaded) return false;
            let saved;
            try { saved = JSON.parse(this._savedConfig); } catch (e) { return false; }
            return (this._CONFIG_SECTIONS[section] || []).some(k =>
                JSON.stringify(this.config[k] ?? null) !== JSON.stringify(saved[k] ?? null));
        },
        get configDirty() { return this.sectionDirty('strategies') || this.sectionDirty('settings'); },

        // ── Init ───────────────────────────────────────────────────────
        // Alpine appelle init() de lui-même : PAS de x-init="init()" sur le
        // <body> (il doublait écouteurs clavier, sondes et intervalles —
        // Échap ouvrait puis refermait aussitôt une confirmation).
        async init() {
            this.$watch('searchQuery', () => { this.treeLimit = 300; this.buildTree(); });
            // Fermer le flux SSE OCR en quittant l'onglet Documents.
            this.$watch('tab', (v, old) => {
                if (old === 'documents' && v !== 'documents') this.disconnectOcrEvents();
            });
            // Surlignage de l'éditeur en différé : plus de re-coloration
            // complète à chaque frappe.
            this.$watch('fileViewerContent', () => { if (this.isEditingFile && !this.isCsvEditing) this._scheduleEditorHl(); });
            window.addEventListener('rag-auth', (e) => { this.authError = e.detail || ''; });
            window.addEventListener('beforeunload', (e) => {
                if (this.configDirty || this.fileDirty || this.pageDirty) { e.preventDefault(); e.returnValue = ''; }
            });
            this._installModalFocus();
            await this.loadConfig();
            await this.loadCollections();
            await this.loadFiles();
            this.loadTraces();
            this.checkHealth();
            this.loadOcrStatus();
            setInterval(() => this.checkHealth(), 60000);
            this.pollStartupStatus();
            this.resumeIndexTask();

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { this.onEscape(); return; }
                const t = e.target;
                const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
                                     || t.tagName === 'SELECT' || t.isContentEditable);
                if (typing || this.anyModalOpen()) return;
                // « / » : focus du filtre de l'onglet courant. Ctrl+F reste
                // la recherche du navigateur.
                if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    const id = this.tab === 'documents' ? 'doc-filter-input' : (this.tab === 'index' ? 'file-search-input' : '');
                    const el = id && document.getElementById(id);
                    if (el) { e.preventDefault(); el.focus(); }
                }
                if (e.ctrlKey && (e.key === 'i' || e.key === 'I') && !this.indexTaskRunning) {
                    e.preventDefault(); this.startIngest(true);
                }
            });
        },

        // ── Modales : Échap, focus initial / retour, piège de tabulation ──
        anyModalOpen() {
            return !!(this.confirmModal.open || this.fileViewerModalOpen || this.reindexModalOpen
                || this.nodeRuleModalOpen || this.duplicatesModalOpen || this.newCollectionModalOpen
                || this.helpModalOpen || this.aboutModalOpen || this.taskModalOpen
                || this.uploadProgressModal || this.reindexProgressModal || this.restartingModal);
        },
        async onEscape() {
            if (this.confirmModal.open) return this.closeConfirm(false);
            if (this.fileViewerModalOpen) return this.closeFileViewer();
            if (this.reindexModalOpen && !this.reindexRunning) return this.closeReindexModal();
            if (this.nodeRuleModalOpen) { this.nodeRuleModalOpen = false; return; }
            if (this.newCollectionModalOpen) return this.cancelNewCollection();
            if (this.duplicatesModalOpen) { this.duplicatesModalOpen = false; return; }
            if (this.helpModalOpen) { this.helpModalOpen = false; return; }
            if (this.aboutModalOpen) { this.aboutModalOpen = false; return; }
            if (this.taskModalOpen) { this.taskModalOpen = false; return; }
            if (this.pageEditing) return this.cancelPageEdit();
        },
        _installModalFocus() {
            // Chaque modale porte role="dialog" (ou alertdialog) : à l'ouverture, focus sur son
            // premier contrôle ; à la fermeture, retour à l'élément d'origine.
            const flags = ['confirmModal.open', 'fileViewerModalOpen', 'reindexModalOpen', 'nodeRuleModalOpen',
                           'duplicatesModalOpen', 'newCollectionModalOpen', 'helpModalOpen', 'aboutModalOpen',
                           'taskModalOpen'];
            const stack = [];
            flags.forEach(f => this.$watch(f, (open) => {
                if (open) {
                    this._modalOpenedAt = performance.now();
                    stack.push(document.activeElement);
                    this.$nextTick(() => setTimeout(() => {
                        const dlg = this._topDialog();
                        const el = dlg && (dlg.querySelector('[data-autofocus]') || dlg.querySelector(this._FOCUSABLE));
                        if (el) el.focus();
                    }, 30));
                } else {
                    const prev = stack.pop();
                    if (prev && typeof prev.focus === 'function' && document.contains(prev)) prev.focus();
                }
            }));
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Tab') return;
                const dlg = this._topDialog();
                if (!dlg) return;
                const els = Array.from(dlg.querySelectorAll(this._FOCUSABLE)).filter(x => x.offsetParent !== null);
                if (!els.length) return;
                const first = els[0], last = els[els.length - 1];
                if (!dlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
                else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            });
        },
        // Clic hors d'une modale : on ne ferme PAS si le clic vient d'une
        // autre modale posée au-dessus (confirmation), ni si c'est le clic
        // même qui vient d'ouvrir une modale (sinon « Annuler » d'une
        // confirmation refermait la fenêtre du dessous, et le bouton qui
        // ouvre une confirmation pouvait la refermer dans la foulée).
        _modalOpenedAt: 0,
        awayOk(ev, el) {
            const dlg = ev && ev.target && ev.target.closest
                ? ev.target.closest('[role="dialog"], [role="alertdialog"]') : null;
            if (dlg && el && !dlg.contains(el)) return false;
            if (this.confirmModal.open && !(el && el.closest('[role="alertdialog"]'))) return false;
            if (ev && ev.timeStamp && ev.timeStamp < this._modalOpenedAt) return false;
            return true;
        },
        _FOCUSABLE: 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        _topDialog() {
            // Les voiles de modale sont en position fixe (offsetParent nul) :
            // « ouverte » = display différent de none.
            const open = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
                .filter(d => getComputedStyle(d).display !== 'none');
            if (!open.length) return null;
            // z-index le plus haut = modale du dessus.
            return open.reduce((a, b) => (parseInt(getComputedStyle(b).zIndex) || 0) >= (parseInt(getComputedStyle(a).zIndex) || 0) ? b : a);
        },

        // Exécute fn une seule fois à la fois pour la clé donnée.
        async withBusy(key, fn) {
            if (this.busy[key]) return;
            this.busy[key] = true;
            try { return await fn(); }
            finally { this.busy[key] = false; }
        },

        // ── Health ─────────────────────────────────────────────────────
        async checkHealth() {
            try {
                const d = await _api('/api/health', { allowFail: true });
                this.qdrantStatus  = d.qdrant ? 'ok' : 'error';
                this.llmStatus     = d.llm    ? 'ok' : 'error';
                this.qdrantLatency = d.qdrant_latency_ms ?? null;
                this.llmLatency    = d.llm_latency_ms ?? null;
            } catch(e) { this.qdrantStatus = this.llmStatus = 'error'; this.qdrantLatency = this.llmLatency = null; }
        },

        // ── Stats ──────────────────────────────────────────────────────
        async loadStats() {
            this.statsLoading = true;
            try {
                const d = await _api('/api/stats');
                this.collectionStats = d && d.ok !== false ? d : null;
            } catch(e) { this.collectionStats = null; }
            finally { this.statsLoading = false; }
        },

        statusColor(status) {
            if (!status) return 'text-slate-400';
            const s = status.toLowerCase();
            if (s === 'green' || s === 'ok') return 'text-green-600';
            if (s === 'yellow') return 'text-yellow-600';
            return 'text-red-600';
        },
        statusDot(status) {
            if (!status) return 'bg-slate-300';
            const s = status.toLowerCase();
            if (s === 'green' || s === 'ok') return 'bg-green-400';
            if (s === 'yellow') return 'bg-yellow-400';
            return 'bg-red-400';
        },

        // ── Démarrage ──────────────────────────────────────────────────
        // Tolérant : quelques échecs de suite (serveur qui redémarre) ne
        // figent plus la bannière ; au-delà, on la retire.
        async pollStartupStatus() {
            let failures = 0;
            const poll = async () => {
                try {
                    const d = await _api('/api/startup_status', { allowFail: true });
                    failures = 0;
                    this.startupStatus = d;
                    if (!d.done) setTimeout(poll, 2000);
                    else if (d.reindexed > 0) {
                        this.notify('info', `Démarrage : ${d.reindexed} fichier(s) ré-indexés.`);
                        await this.loadFiles();
                    }
                } catch(e) {
                    failures++;
                    if (failures < 10) setTimeout(poll, Math.min(15000, 2000 * failures));
                    else this.startupStatus = null;
                }
            };
            setTimeout(poll, 3000);
        },

        // ── Collections ────────────────────────────────────────────────
        async loadCollections() {
            // allowFail : Qdrant absent ({ok:false}) ne doit pas vider le
            // sélecteur — la collection active reste proposée.
            let cols = [];
            try {
                const d = await _api('/api/collections', { allowFail: true });
                cols = Array.isArray(d?.collections) ? [...d.collections] : [];
            } catch(e) { this.notify('error', 'Collections : ' + e.message); }
            if (this.config.collection && !cols.includes(this.config.collection)) cols.push(this.config.collection);
            this.collections = cols;
        },
        _resetCollectionScopedState() {
            // Ce qui visait des rel_path de l'ANCIENNE collection.
            this.selectedFiles = new Set(); this.selectionMode = false;
            this.searchPlaygroundResults = []; this.searchPlaygroundMode = ''; this.searchPlaygroundError = '';
            this.converterSourcePath = ''; this.converterFilter = ''; this.updateTargetFormats();
            this.folderStates = {}; this.treeLimit = 300;
            this.collectionStats = null;
        },
        async _onCollectionSaved(name) {
            this.oldCollection = name;
            this._resetCollectionScopedState();
            await this.loadFiles();
            await this.loadCollections();
            this.loadStats();
        },
        async changeCollection(val) {
            if (val === '__NEW__') {
                this.config.collection = this.oldCollection;
                this.newCollectionName = ''; this.newCollectionModalOpen = true;
                return;
            }
            if (val === this.oldCollection) return;
            const prev = this.oldCollection;
            this.config.collection = val;
            if (!(await this.saveConfig({ quiet: true, section: 'collection' }))) {
                this.config.collection = prev;      // le serveur est resté sur l'ancienne
                return;
            }
            // (bascule d'état faite par saveConfig : _onCollectionSaved)
            this.notify('info', `Espace actif : ${val}`);
        },
        async confirmNewCollection() {
            const cleanName = (this.newCollectionName || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
            if (!cleanName) { this.notify('error', 'Nom de collection invalide.'); return; }
            await this.withBusy('newCollection', async () => {
                const prev = this.oldCollection;
                this.config.collection = cleanName;
                if (!(await this.saveConfig({ quiet: true, section: 'collection' }))) {
                    this.config.collection = prev;
                    return;
                }
                this.newCollectionModalOpen = false;
                this.notify('success', `Espace créé : /DATA/${cleanName}/`);
            });
        },
        cancelNewCollection() {
            this.config.collection = this.oldCollection || (this.collections[0] || '');
            this.newCollectionModalOpen = false;
        },

        // ── Selection ──────────────────────────────────────────────────
        toggleSelectionMode() {
            this.selectionMode = !this.selectionMode;
            if (!this.selectionMode) this.selectedFiles = new Set();
            this.buildTree();
        },
        toggleFileSelection(rel_path) {
            const s = new Set(this.selectedFiles);
            s.has(rel_path) ? s.delete(rel_path) : s.add(rel_path);
            this.selectedFiles = s;
        },
        selectAll()    { this.selectedFiles = new Set(this.files.map(f => f.rel_path)); },
        clearSelection() { this.selectedFiles = new Set(); },
        async deleteSelected() {
            if (!this.selectedFiles.size) return;
            const confirmed = await this.askConfirm(`Supprimer ${this.selectedFiles.size} fichier(s)`,
                'Action irréversible.', { confirmText: 'Supprimer', isDanger: true });
            if (!confirmed) return;
            await this.withBusy('bulk', async () => {
                const list = [...this.selectedFiles];
                const failed = [];
                this._openReindexProgress('Suppression', `${list.length} fichier(s)`);
                for (let i = 0; i < list.length; i++) {
                    this.reindexProgressFile = list[i];
                    this.reindexProgressPct2 = Math.round(5 + (i / list.length) * 90);
                    try { await _api('/api/files/delete', { json: { rel_path: list[i] } }); }
                    catch(e) { failed.push(`${list[i]} (${e.message})`); }
                }
                this._closeReindexProgress(0);
                this.selectedFiles = new Set(); this.selectionMode = false;
                await this.loadFiles();
                if (failed.length) this.notify('error', `${list.length - failed.length}/${list.length} supprimé(s) ; échecs : ` + failed.slice(0, 3).join(' · '));
                else this.notify('success', `${list.length} fichier(s) supprimé(s).`);
            });
        },
        async reindexSelected() {
            if (!this.selectedFiles.size) return;
            const confirmed = await this.askConfirm(`Réindexer ${this.selectedFiles.size} fichier(s)`, '', { confirmText: 'Réindexer' });
            if (!confirmed) return;
            await this.withBusy('bulk', async () => {
                const list = [...this.selectedFiles];
                let ok = 0, chunks = 0;
                const failed = [];
                this._openReindexProgress('Réindexation', `${list.length} fichier(s)`);
                for (let i = 0; i < list.length; i++) {
                    this.reindexProgressFile = list[i];
                    this.reindexProgressPct2 = Math.round(5 + (i / list.length) * 90);
                    try {
                        const d = await _api('/api/files/reindex', { json: { rel_path: list[i] } });
                        ok++; chunks += d.chunks || 0;
                    } catch(e) { failed.push(`${list[i]} (${e.message})`); }
                }
                this._closeReindexProgress(chunks);
                this.selectedFiles = new Set(); this.selectionMode = false;
                await this.loadFiles();
                if (failed.length) this.notify('error', `${ok}/${list.length} réindexé(s) ; échecs : ` + failed.slice(0, 3).join(' · '));
                else this.notify('success', `${ok}/${list.length} fichier(s) réindexé(s).`);
            });
        },

        // ── Tâche d'indexation de fond ─────────────────────────────────
        // POST /api/tasks/index lance ; GET /api/tasks/index/events?since=
        // suit (SSE rejouable par numéro de séquence). La tâche survit à la
        // fermeture de l'onglet ; au chargement, resumeIndexTask() la
        // retrouve et rouvre le suivi.
        async startIngest(fromKeyboard = false) {
            if (this.indexTaskRunning) { this.taskModalOpen = true; return; }
            if (fromKeyboard) {
                const ok = await this.askConfirm('Synchroniser', 'Indexer les fichiers nouveaux ou modifiés ?', { confirmText: 'Lancer' });
                if (!ok) return;
            }
            await this._launchIndexTask({ kind: 'ingest' });
        },
        async startBulkReindex(folder = '') {
            if (this.indexTaskRunning) { this.taskModalOpen = true; return; }
            const confirmed = await this.askConfirm('Réindexation globale',
                folder ? `Réindexer tout le dossier « ${folder} » ?` : 'Réindexer toute la collection ?',
                { confirmText: 'Lancer' });
            if (!confirmed) return;
            await this._launchIndexTask(folder ? { kind: 'bulk_reindex', folder } : { kind: 'bulk_reindex' });
        },
        async _launchIndexTask(body) {
            await this.withBusy('indexTask', async () => {
                try {
                    const d = await _api('/api/tasks/index', { json: body });
                    this.taskLogs = []; this._taskSeq = 0;
                    this.indexTask = { id: d.task_id, kind: body.kind, folder: body.folder || '', state: 'running',
                                       total: 0, current: 0, success: 0, error: '' };
                    this.taskModalOpen = true;
                    this._connectTaskEvents();
                } catch(e) {
                    if (e.status === 409) {
                        this.notify('warning', e.message || 'Une indexation est déjà en cours.');
                        await this.resumeIndexTask(true);
                    } else this.notify('error', 'Indexation : ' + e.message);
                }
            });
        },
        async resumeIndexTask(open = false) {
            const followed = this.indexTaskRunning ? this.indexTask : null;
            let d;
            try { d = await _api('/api/tasks/index'); }
            catch(e) {
                // Serveur momentanément injoignable (redémarrage, proxy) : si on
                // suivait une tâche, on réessaie avec délai croissant.
                if (followed) this._scheduleTaskRetry();
                return;                                  // sinon : rien à reprendre
            }
            const t = d && d.task;
            if (followed && (!t || t.id !== followed.id)) {
                // La tâche suivie n'existe plus côté serveur (redémarrage…).
                this._taskLost();
                if (!t) return;
            }
            if (!t) return;
            const prevId = this.indexTask?.id;
            const wasRunning = !!(followed && followed.id === t.id);
            this.indexTask = { id: t.id, kind: t.kind, folder: t.folder || '', state: t.state,
                               total: t.total || 0, current: t.current || 0, success: t.success || 0,
                               error: t.error || '' };
            if (prevId !== t.id) { this.taskLogs = []; this._taskSeq = 0; }
            for (const ev of (t.events || [])) this._applyTaskEvent(ev, { replay: true });
            if (t.state === 'running') {
                if (open) this.taskModalOpen = true;
                this._connectTaskEvents();
            } else {
                this._closeTaskEvents();
                // Terminée pendant la coupure : même fin que par le flux.
                if (wasRunning) this._onTaskEnd();
            }
        },
        _scheduleTaskRetry() {
            if (this._taskRetry) clearTimeout(this._taskRetry);
            const wait = this._taskRetryMs || 1000;
            this._taskRetryMs = Math.min(30000, wait * 2);
            this._taskRetry = setTimeout(() => { this._taskRetry = null; this.resumeIndexTask(false); }, wait);
        },
        _taskLost() {
            const t = this.indexTask;
            this._closeTaskEvents();
            if (!t || t.state !== 'running') return;
            t.state = 'error';
            t.error = 'Tâche perdue (serveur redémarré ?).';
            this._taskLog(t.error, 'error');
            this.notify('error', `${this.indexTaskTitle} : tâche perdue côté serveur.`);
            this.loadFiles();
        },
        _connectTaskEvents() {
            this._closeTaskEvents();
            if (!this.indexTaskRunning) return;
            const evt = new EventSource(`/api/tasks/index/events?since=${this._taskSeq}`);
            evt.onopen = () => { this._taskRetryMs = 1000; };
            evt.onmessage = (e) => {
                let d; try { d = JSON.parse(e.data); } catch(err) { return; }
                this._applyTaskEvent(d);
            };
            evt.onerror = () => {
                // Pas de reconnexion native (elle rejouerait l'ancien ?since) :
                // on relit l'état puis on rouvre depuis la dernière séquence vue.
                if (this._taskEvents !== evt) return;
                this._closeTaskEvents();
                if (this.indexTaskRunning) this._scheduleTaskRetry();
            };
            this._taskEvents = evt;
        },
        _closeTaskEvents() {
            if (this._taskEvents) { this._taskEvents.close(); this._taskEvents = null; }
            if (this._taskRetry) { clearTimeout(this._taskRetry); this._taskRetry = null; }
        },
        _taskLog(msg, type) {
            this.taskLogs.unshift({ msg, type, time: new Date().toLocaleTimeString() });
            if (this.taskLogs.length > 500) this.taskLogs.length = 500;
        },
        _applyTaskEvent(d, { replay = false } = {}) {
            if (!d || typeof d !== 'object') return;
            if (d.seq !== undefined) {
                if (d.seq <= this._taskSeq) return;       // déjà vu (rejeu)
                this._taskSeq = d.seq;
            }
            const t = this.indexTask;
            if (!t) return;
            switch (d.type) {
                case 'ping': return;
                case 'idle':
                    // Le serveur n'a plus de tâche : celle qu'on suivait est perdue.
                    if (!replay) this._taskLost(); else this._closeTaskEvents();
                    return;
                case 'start': t.total = d.total || 0; t.current = 0; return;
                case 'progress':
                    // Avancement intra-fichier (lots de chunks) si le serveur l'envoie.
                    t.detail = d.file ? `${d.file} · ${d.done ?? 0}/${d.chunks ?? '?'} chunks` : '';
                    return;
                case 'ingest': case 'skip': case 'ok':
                    t.current = d.current ?? (t.current + 1);
                    if (d.total) t.total = d.total;
                    if (d.type !== 'skip') {
                        t.success = (t.success || 0) + 1;
                        this._taskLog(`✓ ${d.file} (${d.chunks ?? 0} chunks)`, 'ok');
                    }
                    t.detail = '';
                    return;
                case 'error':
                    if (d.current !== undefined) t.current = d.current;
                    {
                        // L'ingestion met déjà le nom dans msg (« a.md: … ») : pas de doublon.
                        const m = d.msg || 'erreur';
                        const pre = d.file && !m.includes(d.file) ? d.file + ' : ' : '';
                        this._taskLog(`✗ ${pre}${m}`, 'error');
                    }
                    if (!t.total && !t.current) t.error = d.msg || t.error;
                    return;
                case 'info': this._taskLog(d.msg || '', 'info'); return;
                case 'done':
                    if (d.total) t.total = d.total;
                    t.current = t.total || t.current;
                    if (d.success !== undefined) t.success = d.success;
                    if (d.updated !== undefined) t.success = d.updated;
                    return;
                case 'end':
                    t.state = d.state || 'done';
                    if (d.error) t.error = d.error;
                    this._closeTaskEvents();
                    if (!replay) this._onTaskEnd();
                    return;
                default:
                    if (d.msg) this._taskLog(d.msg, 'info');
            }
        },
        async _onTaskEnd() {
            const t = this.indexTask;
            await this.loadFiles();
            if (t.state === 'done') {
                const n = t.success || 0;
                this.notify(this.taskLogs.some(l => l.type === 'error') ? 'warning' : 'success',
                    `${this.indexTaskTitle} terminée : ${n} fichier(s) indexé(s).`);
            } else if (t.state === 'canceled') this.notify('info', `${this.indexTaskTitle} annulée.`);
            else this.notify('error', `${this.indexTaskTitle} en échec : ${t.error || 'voir le journal'}`);
        },
        async cancelIndexTask() {
            if (!this.indexTaskRunning) return;
            await this.withBusy('taskCancel', async () => {
                try { await _api('/api/tasks/index/cancel', { method: 'POST' }); this._taskLog('Annulation demandée…', 'info'); }
                catch(e) { this.notify('error', 'Annulation : ' + e.message); }
            });
        },

        // ── Duplicates ─────────────────────────────────────────────────
        async openDuplicates() {
            this.duplicatesModalOpen = true; this.duplicatesLoading = true; this.duplicates = [];
            try {
                const d = await _api('/api/files/duplicates');
                this.duplicates = Array.isArray(d) ? d : [];
            }
            catch(e) { this.notify('error', 'Doublons : ' + e.message); }
            finally { this.duplicatesLoading = false; }
        },
        async deleteOneDuplicate(rel_path) {
            await this.withBusy('dup:' + rel_path, async () => {
                try {
                    await _api('/api/files/delete', { json: { rel_path } });
                    this.notify('success', 'Doublon supprimé.');
                } catch(e) { this.notify('error', 'Suppression : ' + e.message); }
                await this.openDuplicates(); await this.loadFiles();
            });
        },

        // Stable UID generator — used as :key for chunks so Alpine
        // doesn't redraw every chunk when one is split. Counter avoids
        // crypto-API access (some embedded webviews don't expose it).
        _nextUid: 1,
        _mkUid() { return 'c' + (this._nextUid++); },

        // AbortController slots — one per long-running fetch type.
        // When the modal closes we abort everything still in flight.
        _abortPreview: null,
        _abortDbChunks: null,
        _abortFile: null,

        // Memo for the chunk size bars — invalidated when the array
        // reference changes. Saves O(n²) work on big files.
        _reindexMaxCharCache: { ref: null, value: 0 },
        _previewMaxCharCache: { ref: null, value: 0 },

        // Hard limit checked client-side before fetching the file. The
        // server enforces its own cap (see /api/file_text ``cap``); this
        // is just for UX — show a confirm dialog instead of silently
        // truncating.
        FILE_PREVIEW_WARN_BYTES: 2 * 1024 * 1024,    // 2 MB
        FILE_PREVIEW_HARD_BYTES: 10 * 1024 * 1024,   // 10 MB

        // ── Search Playground ──────────────────────────────────────────
        async runSearchPlayground() {
            if (this.searchPlaygroundLoading) return;
            if (!this.searchPlaygroundQuery.trim()) { this.searchPlaygroundError = 'Entrez une requête.'; return; }
            this.searchPlaygroundLoading = true; this.searchPlaygroundResults = [];
            this.searchPlaygroundError = ''; this.searchPlaygroundMode = '';
            try {
                const d = await _api('/api/search', { json: {
                    query: this.searchPlaygroundQuery, top_k: this.searchPlaygroundTopK,
                    folder: this.searchPlaygroundFolder || null, ext: this.searchPlaygroundExt || null,
                    use_hybrid: this.searchPlaygroundHybrid } });
                this.searchPlaygroundResults = d.results || []; this.searchPlaygroundMode = d.mode || '';
            } catch(e) { this.searchPlaygroundError = e.message || 'Erreur de recherche.'; }
            finally { this.searchPlaygroundLoading = false; }
        },
        getScoreColor(score) {
            if (score >= 0.75) return 'bg-green-100 text-green-700 border-green-200';
            if (score >= 0.45) return 'bg-yellow-100 text-yellow-700 border-yellow-200';
            return 'bg-red-100 text-red-700 border-red-200';
        },
        getScoreBar(score) {
            return Math.min(100, Math.max(0, score * 100));
        },

        // ── Conversion ─────────────────────────────────────────────────
        updateTargetFormats() {
            if (!this.converterSourcePath) { this.converterTargetFormats = []; this.converterTargetFormat = ''; return; }
            const ext = this.converterSourcePath.split('.').pop().toLowerCase();
            const matrix = { pdf: ['.md','.txt','.docx'], docx: ['.md','.txt','.pdf'],
                             md: ['.pdf','.docx','.csv','.txt'], csv: ['.md','.json','.txt','.xlsx'],
                             json: ['.csv','.md','.txt','.xlsx'], txt: ['.md','.pdf'], xlsx: ['.csv','.md'] };
            this.converterTargetFormats = matrix[ext] || ['.md', '.txt'];
            this.converterTargetFormat  = this.converterTargetFormats[0] || '';
        },

        // ── Documents (OCR) ────────────────────────────────────────────
        openDocumentsTab() {
            if (!this.ocrEnabled) return;
            this.tab = 'documents';
            this.loadOcrStatus();
            this.loadDocuments();
            this.loadOcrQueue();
            this.loadOcrRagStatus();
            this.connectOcrEvents();
        },
        async loadOcrStatus() {
            // 200 {enabled:false} (ou 404 d'un serveur plus ancien) : feature
            // coupée → onglet masqué, jamais d'appels /api/ocr/* en échec.
            try {
                const d = await _api('/api/ocr/status', { allowFail: true });
                this.ocrStatus = d;
                this.ocrEnabled = !!d && d.enabled !== false;
            } catch(e) {
                this.ocrStatus = null;
                if (e.status === 404) this.ocrEnabled = false;
            }
            if (!this.ocrEnabled && this.tab === 'documents') {
                this.disconnectOcrEvents();
                this.tab = 'index';
            }
        },
        async loadDocuments() {
            this.docsLoading = true;
            try {
                const d = await _api('/api/ocr/docs');
                this.documents = Array.isArray(d?.items) ? d.items : [];
            } catch(e) { this.notify('error', 'Documents : ' + e.message); }
            finally { this.docsLoading = false; }
        },
        _setQueue(q) {
            // N'accepter qu'une file bien formée (un corps d'erreur cassait le gabarit).
            if (q && typeof q === 'object' && Array.isArray(q.items)) {
                this.ocrQueue = { paused: !!q.paused, active: q.active || null, items: q.items, batch: q.batch || null };
            }
        },
        async loadOcrQueue() {
            try { this._setQueue(await _api('/api/ocr/queue')); }
            catch(e) { this.notify('error', 'File OCR : ' + e.message); }
        },
        async loadOcrRagStatus() {
            try { this.ocrRagStatus = await _api('/api/ocr/rag/status', { allowFail: true }); }
            catch(e) { this.ocrRagStatus = null; }
        },

        // ── Live (SSE) — flux permanent de l'onglet, reconnexion bornée ──
        connectOcrEvents() {
            if (this._ocrEvents || !this.ocrEnabled) return;
            clearTimeout(this._ocrRetryTimer); this._ocrRetryTimer = null;
            const evt = new EventSource('/api/ocr/events');
            const wasDown = this.ocrLive === 'retry';
            evt.onopen = () => {
                this.ocrLive = 'up';
                this._ocrRetryMs = 1000;
                // Des événements ont pu se perdre pendant la coupure.
                if (wasDown) this._ocrResync();
            };
            evt.onmessage = (e) => {
                let msg; try { msg = JSON.parse(e.data); } catch(err) { return; }
                try { this._handleOcrEvent(msg); } catch(err) { console.warn('[ocr] événement', err); }
            };
            evt.onerror = () => {
                // Erreur HTTP (401/404/502) → EventSource passe en CLOSED et ne
                // retente plus jamais seul : on reprend la main, avec backoff.
                if (this._ocrEvents !== evt) return;
                evt.close(); this._ocrEvents = null;
                if (this.tab !== 'documents') { this.ocrLive = 'off'; return; }
                this.ocrLive = 'retry';
                const wait = this._ocrRetryMs;
                this._ocrRetryMs = Math.min(30000, this._ocrRetryMs * 2);
                this._ocrRetryTimer = setTimeout(async () => {
                    await this.loadOcrStatus();
                    if (this.tab === 'documents') this.connectOcrEvents();
                }, wait);
            };
            this._ocrEvents = evt;
        },
        disconnectOcrEvents() {
            clearTimeout(this._ocrRetryTimer); this._ocrRetryTimer = null;
            if (this._ocrEvents) { this._ocrEvents.close(); this._ocrEvents = null; }
            this.ocrLive = 'off'; this._ocrRetryMs = 1000;
        },
        _ocrResync() {
            this.loadDocuments();
            this.loadOcrQueue();
            if (this.selectedDocId && !this.pageEditing) this.selectDoc(this.selectedDocId, { keepPage: true });
        },
        _docInList(id) { return this.documents.find(x => x.id === id); },
        _handleOcrEvent(msg) {
            if (!msg) return;
            if (msg.type === 'ping') return;
            if (msg.type === 'resync' || msg?.data?.kind === 'resync') { this._ocrResync(); return; }
            const d = msg.data || {};
            const kind = d.kind;
            if (kind === 'queue') { this._setQueue(d.queue); return; }
            if (kind === 'notice') {
                const lvl = d.level === 'error' ? 'error' : (d.level === 'warning' ? 'warning' : 'success');
                this.notify(lvl, (d.title || '') + (d.body ? ' — ' + d.body : ''));
                return;
            }
            const doc = this._docInList(d.doc);
            const isSel = this.selectedDoc && this.selectedDoc.id === d.doc;
            if (kind === 'progress') {
                if (doc) {
                    doc.status = d.status;
                    if (d.total) { doc.pages_total = d.total; doc.pages_done = d.done; }
                }
                if (isSel) {
                    this.selectedDoc.status = d.status;
                    if (d.total) { this.selectedDoc.pages_total = d.total; this.selectedDoc.pages_done = d.done; }
                    const p = d.page && (this.selectedDoc.pages || []).find(x => x.n === d.page);
                    if (p && d.status === 'running') p.status = 'running';
                    // Suivre la page en cours seulement si l'utilisateur n'a
                    // pas choisi d'en lire une autre ; une requête par
                    // CHANGEMENT de page, pas par événement.
                    if (d.page && d.status === 'running' && this.ocrFollow && !this.pageEditing
                            && d.page !== this.selectedPageN) this.selectPage(d.page, { auto: true });
                    if (d.status === 'ready' && !this.selectedDoc.pages?.length) this.selectDoc(d.doc);
                }
            } else if (kind === 'text') {
                if (isSel && this.selectedPageN === d.page && this.pageData && !this.pageEditing) {
                    this.pageData.md = (this.pageData.md || '') + (d.delta || '');
                }
            } else if (kind === 'page_done') {
                if (doc && doc.pages_total) doc.pages_done = Math.min(doc.pages_total, (doc.pages_done || 0) + 1);
                if (isSel) {
                    const p = (this.selectedDoc.pages || []).find(x => x.n === d.page);
                    if (p) { p.status = d.status; p.divergence = d.divergence; }
                    if (this.selectedPageN === d.page && !this.pageEditing) this.selectPage(d.page, { auto: true });
                }
            } else if (kind === 'rag') {
                // Indexation d'un document (auto-index ou manuelle) : badge RAG
                // et bouton « Indexer » à jour sans recharger toute la liste.
                if (doc) {
                    if ('rag' in d) doc.rag = d.rag;
                    if ('indexing' in d) doc.indexing = d.indexing;
                }
                if (d.status === 'error' && d.error) this.notify('error', 'Indexation : ' + d.error);
                if (isSel && !this.pageEditing) this.selectDoc(d.doc, { keepPage: true });
                else if (!doc) this.loadDocuments();
            } else if (kind === 'job_done') {
                if (doc) doc.status = d.status;
                if (d.status === 'error' && d.error) this.notify('error', d.error);
                if (isSel && !this.pageEditing) this.selectDoc(d.doc, { keepPage: true });
                this.loadDocuments();
            }
        },

        // ── Upload (XHR séquentiel — POST /api/ocr/docs attend UN fichier) ──
        async handleOcrDrop(e) {
            this.ocrDragging = false;
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length) await this.uploadOcrDocs(null, files);
        },
        // XHR (progression d'envoi) + même porte 401 que fetch : sur 401, on
        // demande le jeton puis on renvoie le fichier une fois.
        _xhrUpload(url, fd, onProgress) {
            const send = () => new Promise((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', url, true);
                xhr.upload.onprogress = ev => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
                xhr.onload = () => {
                    let data = null;
                    try { data = JSON.parse(xhr.responseText); } catch(err) {}
                    resolve({ status: xhr.status, data });
                };
                xhr.onerror = () => resolve({ status: 0, data: null });
                xhr.send(fd);
            });
            return (async () => {
                let r = await send();
                if (r.status === 401 && window._ragAuth && await window._ragAuth.login()) r = await send();
                if (r.status >= 200 && r.status < 300) return r.data || {};
                const fb = r.status === 0 ? 'Serveur injoignable.' : (r.status === 413 ? 'Fichier trop volumineux.' : `Erreur ${r.status}`);
                throw new ApiError(_errText(r.data, fb), r.status, r.data);
            })();
        },
        async uploadOcrDocs(e, droppedFiles = null) {
            const input = e?.target || null;
            const list = Array.from(droppedFiles || input?.files || []);
            if (input) input.value = '';      // re-choisir le même fichier doit redéclencher
            if (!list.length) return;
            const ok = list.filter(f => /\.(pdf|docx)$/i.test(f.name));
            if (!ok.length) { this.notify('error', 'Formats acceptés : .pdf, .docx'); return; }
            if (ok.length < list.length) this.notify('info', `${list.length - ok.length} fichier(s) ignoré(s) (format).`);
            this.uploadProgressModal = true; this.uploadProgress = 0;
            let done = 0;
            const failed = [];
            try {
                // Un échec n'arrête plus le lot : chaque fichier est tenté,
                // le récapitulatif liste les refus.
                for (let i = 0; i < ok.length; i++) {
                    const f = ok[i];
                    this.uploadLabel = `${i + 1}/${ok.length} · ${f.name}`;
                    const fd = new FormData();
                    fd.append('file', f);
                    try {
                        await this._xhrUpload('/api/ocr/docs', fd,
                            (frac) => { this.uploadProgress = Math.round(((i + frac) / ok.length) * 100); });
                        done++;
                    } catch(err) { failed.push(`${f.name} : ${err.message}`); }
                }
            } finally {
                this.uploadProgressModal = false; this.uploadLabel = '';
                await this.loadDocuments();
            }
            if (failed.length) this.notify(done ? 'warning' : 'error',
                (done ? `${done} déposé(s) ; ` : '') + `${failed.length} refusé(s) : ` + failed.slice(0, 3).join(' · '));
            else this.notify('success', `${done} document(s) déposé(s).`);
        },

        // ── Lecteur ────────────────────────────────────────────────────
        async _confirmDropPageDraft() {
            if (!this.pageDirty) return true;
            const ok = await this.askConfirm('Modifications non enregistrées',
                'Abandonner la transcription en cours d\'édition ?', { confirmText: 'Abandonner', isDanger: true });
            if (ok) { this.pageEditing = false; this.pageDraft = ''; }
            return ok;
        },
        async selectDoc(id, { keepPage = false } = {}) {
            if (id !== this.selectedDocId && !(await this._confirmDropPageDraft())) return;
            const changed = id !== this.selectedDocId;
            const prevId = this.selectedDocId;
            const req = ++this._docReq;
            this.selectedDocId = id;
            if (changed) {
                this.pageEditing = false; this.ocrFollow = true; this.thumbLimit = 60;
                this.tagEditing = false;
            }
            let doc;
            try { doc = await _api(`/api/ocr/docs/${encodeURIComponent(id)}`); }
            catch(e) {
                if (req !== this._docReq) return;
                if (e.status === 404) {
                    this.notify('warning', 'Document introuvable (supprimé ?).');
                    this.selectedDocId = null; this.selectedDoc = null; this.pageData = null; this.selectedPageN = 0;
                    this.loadDocuments();
                } else {
                    // Échec transitoire : on reste sur le document affiché, pour
                    // que les actions visent bien celui que l'en-tête montre.
                    if (changed) this.selectedDocId = prevId;
                    this.notify('error', 'Document : ' + e.message);
                }
                return;
            }
            if (req !== this._docReq) return;     // un clic plus récent a gagné
            this.selectedDoc = doc;
            const pages = doc.pages || [];
            const cur = (keepPage || !changed) ? this.selectedPageN : 0;
            const n = pages.find(p => p.n === cur) ? cur : (pages[0]?.n || 0);
            if (n) await this.selectPage(n, { auto: true });
            else { this.selectedPageN = 0; this.pageData = null; }
        },
        async selectPage(n, { auto = false } = {}) {
            if (!this.selectedDocId || !n) return;
            if (!auto) {
                if (n !== this.selectedPageN && !(await this._confirmDropPageDraft())) return;
                // Un clic manuel coupe le suivi, sauf sur la page en cours d'OCR.
                const p = (this.selectedDoc?.pages || []).find(x => x.n === n);
                this.ocrFollow = !!(p && p.status === 'running');
            }
            if (this.pageEditing) return;
            const docId = this.selectedDocId;
            const req = ++this._pageReq;
            this.selectedPageN = n;
            try {
                const d = await _api(`/api/ocr/docs/${encodeURIComponent(docId)}/pages/${n}`);
                if (req === this._pageReq && docId === this.selectedDocId) this.pageData = d;
            } catch(e) {
                if (req === this._pageReq) { this.pageData = null; if (!auto) this.notify('error', 'Page : ' + e.message); }
            }
        },
        followRunningPage() {
            this.ocrFollow = true;
            const p = (this.selectedDoc?.pages || []).find(x => x.status === 'running');
            if (p) this.selectPage(p.n, { auto: true });
        },
        ocrPageImageUrl(n) {
            return `/api/ocr/docs/${encodeURIComponent(this.selectedDocId)}/pages/${n}/image`;
        },
        renderOcrMarkdown(md) {
            return _mdToHtml(md);
        },
        startPageEdit() {
            if (!this.pageData) return;
            if (this.pageData.status === 'running') { this.notify('info', 'Page en cours de lecture.'); return; }
            this.pageDraft = this.pageData.md || '';
            this.pageEditing = true;
        },
        async cancelPageEdit() {
            if (!(await this._confirmDropPageDraft())) return;
            this.pageEditing = false; this.pageDraft = '';
        },
        async savePage() {
            if (!this.pageEditing || this.pageSaving) return;
            this.pageSaving = true;
            try {
                await _api(`/api/ocr/docs/${encodeURIComponent(this.selectedDocId)}/pages/${this.selectedPageN}`,
                           { method: 'PUT', json: { md: this.pageDraft } });
                this.pageData.md = this.pageDraft;
                this.pageData.edited = true;
                this.pageEditing = false;
                this.notify('success', 'Page enregistrée.');
                // L'édition rend l'index RAG périmé : rafraîchir le badge du doc.
                this.selectDoc(this.selectedDocId, { keepPage: true });
            } catch(e) { this.notify('error', 'Enregistrement : ' + e.message); }
            finally { this.pageSaving = false; }
        },

        // ── Actions document ───────────────────────────────────────────
        async _docAction(key, fn) { return this.withBusy(key + ':' + this.selectedDocId, fn); },
        docBusy(key) { return !!this.busy[key + ':' + this.selectedDocId]; },
        async restartDoc() {
            if (!this.selectedDocId) return;
            await this._docAction('restart', async () => {
                try {
                    // « Relancer » un document transcrit = tout refaire (full) ;
                    // sinon reprise des pages restantes.
                    const full = this.selectedDoc?.status === 'done';
                    await _api(`/api/ocr/docs/${encodeURIComponent(this.selectedDocId)}/restart`, { json: full ? { full: true } : {} });
                    this.ocrFollow = true;
                    this.notify('success', 'Lecture lancée.');
                } catch(e) { this.notify('error', 'Lancement : ' + e.message); }
            });
        },
        async cancelDoc() {
            if (!this.selectedDocId) return;
            await this._docAction('cancel', async () => {
                try {
                    await _api(`/api/ocr/docs/${encodeURIComponent(this.selectedDocId)}/cancel`, { method: 'POST' });
                    this.notify('info', 'Arrêt demandé.');
                } catch(e) { this.notify('error', 'Arrêt : ' + e.message); }
            });
        },
        async rerunPage() {
            if (!this.selectedDocId || !this.selectedPageN) return;
            if (!(await this._confirmDropPageDraft())) return;
            await this._docAction('rerun', async () => {
                try {
                    await _api(`/api/ocr/docs/${encodeURIComponent(this.selectedDocId)}/pages/${this.selectedPageN}/rerun`, { json: {} });
                    if (this.pageData) this.pageData.md = '';
                    this.notify('info', `Relecture de la page ${this.selectedPageN}…`);
                } catch(e) { this.notify('error', 'Relecture : ' + e.message); }
            });
        },
        async deleteDoc(id) {
            const doc = this._docInList(id);
            const okGo = await this.askConfirm('Supprimer ce document ?',
                `« ${doc?.name || id} » : transcription et index RAG compris.`,
                { confirmText: 'Supprimer', isDanger: true });
            if (!okGo) return;
            await this.withBusy('del:' + id, async () => {
                try {
                    // Le serveur refuse (502) si la désindexation échoue : le document RESTE.
                    await _api(`/api/ocr/docs/${encodeURIComponent(id)}`, { method: 'DELETE' });
                    if (this.selectedDocId === id) {
                        this.pageEditing = false;
                        this.selectedDocId = null; this.selectedDoc = null;
                        this.pageData = null; this.selectedPageN = 0;
                    }
                    this.notify('success', 'Document supprimé.');
                } catch(e) { this.notify('error', 'Suppression : ' + e.message); }
                await this.loadDocuments();
            });
        },
        exportDocMd() {
            if (!this.selectedDocId) return;
            window.open(`/api/ocr/docs/${encodeURIComponent(this.selectedDocId)}/export`, '_blank', 'noopener');
        },
        async ragIndexDoc() {
            if (!this.selectedDocId) return;
            await this._docAction('index', async () => {
                try {
                    const d = await _api(`/api/ocr/docs/${encodeURIComponent(this.selectedDocId)}/rag/index`, { json: {} });
                    this.notify('success', `Indexé dans « ${d.rag?.collection} » (${d.rag?.chunks} extraits).`);
                } catch(e) { this.notify('error', 'Indexation : ' + e.message); }
                await this.selectDoc(this.selectedDocId, { keepPage: true });
                await this.loadDocuments();
            });
        },
        async ragRemoveDoc() {
            if (!this.selectedDocId) return;
            await this._docAction('deindex', async () => {
                try {
                    await _api(`/api/ocr/docs/${encodeURIComponent(this.selectedDocId)}/rag`, { method: 'DELETE' });
                    this.notify('success', 'Retiré de l\'index RAG.');
                } catch(e) { this.notify('error', 'Désindexation : ' + e.message); }
                await this.selectDoc(this.selectedDocId, { keepPage: true });
                await this.loadDocuments();
            });
        },

        // ── Étiquettes (POST /api/ocr/docs/{id}/tags) ──────────────────
        startTagEdit() {
            this.tagDraft = (this.selectedDoc?.tags || []).join(', ');
            this.tagEditing = true;
            this.$nextTick(() => document.getElementById('doc-tags-input')?.focus());
        },
        async saveTags() {
            if (!this.selectedDocId) return;
            const tags = this.tagDraft.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10);
            await this._docAction('tags', async () => {
                try {
                    const d = await _api(`/api/ocr/docs/${encodeURIComponent(this.selectedDocId)}/tags`, { json: { tags } });
                    const clean = Array.isArray(d.tags) ? d.tags : tags;
                    if (this.selectedDoc) this.selectedDoc.tags = clean;
                    const doc = this._docInList(this.selectedDocId);
                    if (doc) doc.tags = clean;
                    this.tagEditing = false;
                } catch(e) { this.notify('error', 'Étiquettes : ' + e.message); }
            });
        },

        // ── Recherche plein texte (GET /api/ocr/search) ────────────────
        async runOcrSearch() {
            const q = (this.ocrSearchQuery || '').trim();
            if (q.length < 2) { this.ocrSearchResults = null; return; }
            await this.withBusy('ocrSearch', async () => {
                try {
                    const d = await _api(`/api/ocr/search?q=${encodeURIComponent(q)}`);
                    this.ocrSearchResults = { items: Array.isArray(d.items) ? d.items : [], partial: !!d.partial };
                } catch(e) { this.notify('error', 'Recherche : ' + e.message); }
            });
        },
        clearOcrSearch() { this.ocrSearchQuery = ''; this.ocrSearchResults = null; },
        async openSearchHit(docId, n) {
            await this.selectDoc(docId);
            if (n && this.selectedDocId === docId) await this.selectPage(n);
        },

        // ── File multi-documents ───────────────────────────────────────
        async queueAllPending() {
            const ids = this.documents
                .filter(d => ['ready', 'uploaded', 'error', 'canceled'].includes(d.status))
                .map(d => d.id);
            if (!ids.length) { this.notify('info', 'Aucun document en attente.'); return; }
            await this.withBusy('queueAll', async () => {
                try {
                    const d = await _api('/api/ocr/queue/items', { json: { doc_ids: ids } });
                    this._setQueue(d);
                    const rej = Array.isArray(d?.rejected) ? d.rejected : [];
                    const n = ids.length - rej.length;
                    if (rej.length) {
                        const why = rej.slice(0, 3).map(r => typeof r === 'object'
                            ? `${this._docInList(r.doc || r.id)?.name || r.doc || r.id} (${r.reason || r.detail || 'refusé'})`
                            : (this._docInList(r)?.name || String(r))).join(' · ');
                        this.notify(n ? 'warning' : 'error', `${n} en file ; ${rej.length} refusé(s) : ${why}`);
                    } else this.notify('success', `${n} document(s) en file.`);
                } catch(e) { this.notify('error', 'File : ' + e.message); }
            });
        },
        async queueRemoveItem(id) {
            await this.withBusy('q:' + id, async () => {
                try { this._setQueue(await _api(`/api/ocr/queue/items/${encodeURIComponent(id)}`, { method: 'DELETE' })); }
                catch(e) { this.notify('error', 'File : ' + e.message); }
            });
        },
        async queueTogglePause() {
            const url = this.ocrQueue.paused ? '/api/ocr/queue/resume' : '/api/ocr/queue/pause';
            await this.withBusy('queuePause', async () => {
                try { this._setQueue(await _api(url, { method: 'POST' })); }
                catch(e) { this.notify('error', 'File : ' + e.message); }
            });
        },
        async queueClear() {
            const okGo = await this.askConfirm('Vider la file ?',
                'Le document en cours va au bout.', { confirmText: 'Vider', isDanger: true });
            if (!okGo) return;
            await this.withBusy('queueClear', async () => {
                try { this._setQueue(await _api('/api/ocr/queue', { method: 'DELETE' })); }
                catch(e) { this.notify('error', 'File : ' + e.message); }
            });
        },

        // ── Interroger (chat du chatbot, deep-link #ask) ───────────────
        askDocument() {
            const doc = this.selectedDoc;
            if (!doc) return;
            if (!doc.rag?.rel_path) {
                this.notify('info', 'Indexez d\'abord ce document.');
                return;
            }
            // Origine du chatbot : configurable (Connexions → URL du chat),
            // défaut = même hôte sans le port rag_app (Caddy : chatbot :443).
            const base = (this.config.chatbot_url || '').trim()
                || (location.protocol + '//' + location.hostname + '/');
            const params = new URLSearchParams({
                collection: doc.rag.collection || (this.ocrRagStatus?.default_collection || 'ocr-documents'),
                doc: doc.name || '',
                rag: doc.rag.rel_path || '',
            });
            window.open(base.replace(/\/?$/, '/') + '#ask?' + params.toString(), '_blank', 'noopener');
        },

        // ── Carte Connexions → OCR : découverte / VRAM des modèles ─────
        async loadOcrModels() {
            if (this.ocrModelsBusy) return;
            this.ocrModelsBusy = true; this.ocrModelsError = '';
            try {
                const d = await _api('/api/ocr/models', { allowFail: true });
                this.ocrModels = Array.isArray(d.models) ? d.models : [];
                this.ocrModelsError = d.error || '';
            } catch(e) { this.ocrModels = []; this.ocrModelsError = e.status === 404 ? 'OCR désactivé.' : e.message; }
            finally { this.ocrModelsBusy = false; }
        },
        async ocrModelAction(model, action) {
            if (this.ocrModelActionBusy) return;
            this.ocrModelActionBusy = model + ':' + action;
            try {
                await _api(`/api/ocr/models/${action}`, { json: { model } });
                this.notify('success', (action === 'load' ? 'Modèle chargé : ' : 'Modèle déchargé : ') + model);
                await this.loadOcrModels();
            } catch(e) { this.notify('error', 'Modèle : ' + e.message); }
            finally { this.ocrModelActionBusy = ''; }
        },

        // Libellés de statut document (chips de la bibliothèque).
        docIndexing() { return !!(this.selectedDoc?.indexing) || this.docBusy('index'); },
        ocrStatusLabel(s) {
            return ({ uploaded: 'Déposé', preparing: 'Préparation…', ready: 'Prêt',
                      running: 'Lecture…', done: 'Transcrit', error: 'Erreur',
                      canceled: 'Arrêté' })[s] || s || '—';
        },
        ocrStatusClass(s) {
            return ({ uploaded: 'bg-slate-100 text-slate-600',
                      preparing: 'bg-amber-100 text-amber-700',
                      ready: 'bg-sky-100 text-sky-700',
                      running: 'bg-amber-100 text-amber-700',
                      done: 'bg-emerald-100 text-emerald-700',
                      error: 'bg-rose-100 text-rose-700',
                      canceled: 'bg-slate-100 text-slate-500' })[s]
                || 'bg-slate-100 text-slate-600';
        },

        // ── Confirm ────────────────────────────────────────────────────
        askConfirm(title, message, options = {}) {
            // Une confirmation déjà ouverte vaut refus : sa promesse ne reste
            // jamais pendante.
            if (this.confirmModal.resolve) { this.confirmModal.resolve(false); this.confirmModal.resolve = null; }
            this._modalOpenedAt = performance.now();
            Object.assign(this.confirmModal, { title, message,
                confirmText: options.confirmText || 'Confirmer',
                cancelText:  options.cancelText  || 'Annuler',
                isDanger:    options.isDanger    || false, open: true });
            return new Promise(resolve => { this.confirmModal.resolve = resolve; });
        },
        closeConfirm(result) {
            this.confirmModal.open = false;
            if (this.confirmModal.resolve) { this.confirmModal.resolve(result); this.confirmModal.resolve = null; }
        },

        // ── Toasts ─────────────────────────────────────────────────────
        notify(type, message) {
            // Id incrémental : deux toasts du même tick avaient la même clé.
            const id = ++this._toastSeq;
            this.toasts.push({ id, type, message: String(message ?? '') });
            if (this.toasts.length > 6) this.toasts.shift();
            const ttl = type === 'error' ? 9000 : (type === 'warning' ? 7000 : 4500);
            setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, ttl);
        },
        dismissToast(id) { this.toasts = this.toasts.filter(t => t.id !== id); },

        // ── File icons ─────────────────────────────────────────────────
        getFileIcon(filename) {
            if (!filename) return '';
            const ext = filename.split('.').pop().toLowerCase();
            const icons = {
                pdf:  '<svg class="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>',
                py:   '<svg class="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
                js:   '<svg class="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>',
                json: '<svg class="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16m-7 6h7"/></svg>',
                md:   '<svg class="w-5 h-5 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
                docx: '<svg class="w-5 h-5 text-blue-700" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
                txt:  '<svg class="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
                csv:  '<svg class="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>',
            };
            return icons[ext] || '<svg class="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>';
        },

        // ── Rules ──────────────────────────────────────────────────────
        getAppliedRule(path, ext, isFolder) {
            let rule = null, source = 'Global';
            if (!isFolder && this.config.file_rules?.[path]) { rule = this.config.file_rules[path]; source = 'Fichier'; }
            if (!rule) {
                let best = '';
                for (const fp in (this.config.folder_rules || {})) {
                    if ((path === fp || path.startsWith(fp + '/')) && fp.length > best.length) { best = fp; rule = this.config.folder_rules[fp]; source = isFolder && path === fp ? 'Dossier' : 'Hérité'; }
                }
            }
            if (!rule && ext && this.config.extension_rules?.[ext]) { rule = this.config.extension_rules[ext]; source = 'Extension'; }
            if (!rule) { rule = { method: this.config.global_method || 'size', size: this.config.global_chunk_size, overlap: this.config.global_chunk_overlap, value: this.config.global_value || '' }; source = 'Global'; }
            return { ...rule, source };
        },
        formatRuleBadge(rule) {
            if (!rule) return '';
            if (rule.method === 'size')      return `Taille: ${rule.size}`;
            if (rule.method === 'delimiter') return `Délim: ${rule.value || ''}`;
            if (rule.method === 'regex')     return `Regex: ${rule.value || ''}`;
            if (rule.method === 'markdown')  return 'Struct (MD)';
            if (rule.method === 'sentence')  return 'Phrases';
            return rule.method;
        },

        // ── Tree ───────────────────────────────────────────────────────
        onSearch() { setTimeout(() => this.buildTree(), 10); },
        buildTree() {
            const query = String(this.searchQuery || '').trim().toLowerCase();
            if (query) {
                this.treeNodes = this.files
                    .filter(f => f.name.toLowerCase().includes(query) || f.rel_path.toLowerCase().includes(query))
                    .map(f => ({ ...f, path: f.rel_path, type: 'file', depth: 0, isOpen: true, ruleInfo: this.getAppliedRule(f.rel_path, f.ext, false) }));
                return;
            }
            const root = {};
            this.files.forEach(file => {
                const parts = file.rel_path.replace(/\\/g, '/').split('/').filter(p => p);
                let cur = root;
                parts.forEach((part, i) => {
                    const isFile = i === parts.length - 1, path = parts.slice(0, i + 1).join('/');
                    if (!cur[part]) cur[part] = { name: part, path, type: isFile ? 'file' : 'folder', children: {}, ...(isFile ? file : {}) };
                    cur = cur[part].children;
                });
            });
            const flatList = [];
            const traverse = (nodes, depth) => {
                Object.values(nodes).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'folder' ? -1 : 1))
                    .forEach(node => {
                        node.ruleInfo = this.getAppliedRule(node.path, node.ext, node.type === 'folder');
                        flatList.push({ ...node, depth, isOpen: this.folderStates[node.path] || false });
                        if (node.type === 'folder' && this.folderStates[node.path]) traverse(node.children, depth + 1);
                    });
            };
            traverse(root, 0);
            this.treeNodes = flatList;
        },
        toggleFolder(path) { this.folderStates[path] = !this.folderStates[path]; this.buildTree(); },

        // ── Logs ───────────────────────────────────────────────────────
        openLogsTab() {
            this.tab = 'logs';
            // Recharger la vue affichée (et pas seulement les traces).
            this.switchLogTab(this.logTab);
        },
        async loadTraces() {
            try {
                const d = await _api('/api/logs/traces');
                this.traces = (Array.isArray(d) ? d : []).map(t => ({
                    ...t, isOpen: false, mode: t.mode || '', chunks: Array.isArray(t.chunks) ? t.chunks : [] }));
            } catch(e) { this.notify('error', 'Traces : ' + e.message); }
        },
        async loadRawLogs(type) {
            this.rawLogsContent = "Chargement…";
            try { this.rawLogsContent = (await _api(`/api/logs/raw?type=${encodeURIComponent(type)}`)).text || "Vide."; }
            catch(e) { this.rawLogsContent = "Erreur : " + e.message; }
        },
        async loadQdrantTelemetry() {
            this.telemetryLoading = true; this.telemetryError = '';
            try {
                const d = await _api('/api/qdrant/telemetry');
                this.qdrantTelemetry = d.data?.result ?? d.data ?? null;
                if (!this.qdrantTelemetry) this.telemetryError = 'Réponse vide.';
            } catch(e) { this.qdrantTelemetry = null; this.telemetryError = e.message; }
            finally { this.telemetryLoading = false; }
        },
        switchLogTab(tabName) {
            this.logTab = tabName;
            if (tabName === 'traces') this.loadTraces();
            else if (tabName === 'qdrant') { this.loadQdrantTelemetry(); this.loadStats(); }
            else this.loadRawLogs(tabName);
        },
        openQdrantStats() {
            this.tab = 'logs';
            this.switchLogTab('qdrant');
        },
        async clearLogs() {
            const confirmed = await this.askConfirm('Purger les journaux', 'Effacer traces et journal applicatif ?', { confirmText: 'Purger', isDanger: true });
            if (!confirmed) return;
            await this.withBusy('clearLogs', async () => {
                try {
                    await _api('/api/logs/clear', { method: 'POST' });
                    this.notify('success', 'Journaux purgés.');
                    this.loadTraces(); this.loadRawLogs('app');
                } catch(e) { this.notify('error', 'Purge : ' + e.message); }
            });
        },

        // ── Config ─────────────────────────────────────────────────────
        // Défauts PROFONDS : chaque bloc imbriqué lié au formulaire existe
        // toujours (un rag_config.json sans bloc « sparse » cassait l'onglet).
        _withConfigDefaults(c) { return _cfgDefaults(c); },
        async loadConfig() {
            try {
                const d = await _api('/api/config');
                if (!d || typeof d !== 'object' || Array.isArray(d)) throw new ApiError('Réponse invalide.');
                this.config = this._withConfigDefaults(d);
                this._savedConfig = JSON.stringify(this.config);
                this.oldCollection = this.config.collection || '';
                this.configLoaded = true; this.configError = '';
            } catch(e) {
                // Surtout ne PAS garder des défauts JS qu'une sauvegarde
                // enverrait au serveur (écrasement de qdrant_url, modèle…).
                this.configLoaded = false;
                this.configError = e.message || 'Configuration illisible.';
                this.notify('error', 'Configuration : ' + this.configError);
            }
        },
        // Envoie la config SANS les modifications en attente des autres
        // sections : base = dernier état enregistré, + les clés de la section.
        // Renvoie true/false ; les appelants s'y fient.
        async saveConfig({ quiet = false, section = null } = {}) {
            if (!this.configLoaded) {
                this.notify('error', 'Configuration non chargée : sauvegarde bloquée.');
                return false;
            }
            let payload;
            try {
                if (section) {
                    payload = JSON.parse(this._savedConfig);
                    for (const k of (this._CONFIG_SECTIONS[section] || [])) payload[k] = this.config[k];
                } else payload = JSON.parse(JSON.stringify(this.config));
            } catch(e) { payload = JSON.parse(JSON.stringify(this.config)); }
            return (await this.withBusy('saveConfig', async () => {
                try {
                    const d = await _api('/api/config', { json: payload });
                    // Instantané : on ne marque enregistré QUE ce qui est parti.
                    const saved = JSON.parse(this._savedConfig);
                    const prevCollection = saved.collection;
                    for (const k in payload) saved[k] = payload[k];
                    this._savedConfig = JSON.stringify(saved);
                    // Collection changée (sélecteur OU champ de Connexions) :
                    // tout ce qui visait l'ancienne est remis à zéro.
                    if (payload.collection !== undefined && payload.collection !== prevCollection) {
                        await this._onCollectionSaved(payload.collection);
                    }
                    this.buildTree(); this.checkHealth();
                    if (!quiet) this.notify('success', 'Configuration enregistrée.');
                    if (d && d.reindex_required) {
                        this.notify('warning', 'Modèle ou découpage modifié : lancez une synchronisation.');
                    }
                    return true;
                } catch(e) {
                    this.notify('error', 'Sauvegarde refusée : ' + e.message);
                    return false;
                }
            })) === true;
        },
        async saveSection(section) {
            const ok = await this.saveConfig({ section });
            if (ok && section === 'settings') this.loadOcrStatus();
            return ok;
        },
        revertSection(section) {
            let saved;
            try { saved = JSON.parse(this._savedConfig); } catch(e) { return; }
            for (const k of (this._CONFIG_SECTIONS[section] || [])) {
                this.config[k] = saved[k] === undefined ? undefined : JSON.parse(JSON.stringify(saved[k]));
            }
            this.config = this._withConfigDefaults(this.config);
            this.buildTree();
        },

        // ── Tests de connectivité (cartes Connexions) ──────────────────
        // Utilisent la config ENREGISTRÉE (pas le formulaire) : enregistrer
        // d'abord — le serveur ne sonde pas une URL tapée à la volée.
        async _probe(url, slot, busySlot) {
            if (this[busySlot]) return;
            this[busySlot] = true; this[slot] = null;
            try { this[slot] = await _api(url, { allowFail: true }); }
            catch (e) { this[slot] = { ok: false, msg: e.message }; }
            finally { this[busySlot] = false; }
        },
        testReranker()   { return this._probe('/api/reranker/test', 'rerankerTest', 'rerankerTestBusy'); },
        testSparse()     { return this._probe('/api/sparse/test', 'sparseTest', 'sparseTestBusy'); },
        testContextual() { return this._probe('/api/contextual/test', 'contextualTest', 'contextualTestBusy'); },

        // ── Fichiers ───────────────────────────────────────────────────
        async loadFiles() {
            try {
                const d = await _api('/api/files');
                this.files = Array.isArray(d) ? d : [];
                this.buildTree();
            } catch(e) { this.notify('error', 'Fichiers : ' + e.message); }
        },
        async deleteFile(rel_path) {
            const confirmed = await this.askConfirm('Supprimer', `Supprimer « ${rel_path} » ?`, { confirmText: 'Supprimer', isDanger: true });
            if (!confirmed) return;
            await this.withBusy('del:' + rel_path, async () => {
                try {
                    await _api('/api/files/delete', { json: { rel_path } });
                    this.notify('success', 'Fichier supprimé.');
                } catch(e) { this.notify('error', 'Suppression : ' + e.message); }
                await this.loadFiles();
            });
        },

        // ── Upload ─────────────────────────────────────────────────────
        async handleDrop(e) {
            this.isDragging = false;
            let files = [];
            if (e.dataTransfer?.items) {
                let promises = [];
                for (let i = 0; i < e.dataTransfer.items.length; i++) {
                    const item = e.dataTransfer.items[i];
                    if (item.kind === 'file') {
                        const entry = item.webkitGetAsEntry();
                        if (entry) promises.push(this.traverseFileTree(entry, '', files));
                    }
                }
                await Promise.all(promises);
            } else if (e.dataTransfer?.files) files = Array.from(e.dataTransfer.files);
            if (files.length) this.uploadFiles(null, files);
        },
        traverseFileTree(item, path, filesArray) {
            return new Promise(resolve => {
                path = path || "";
                if (item.isFile) {
                    item.file(file => { file.customPath = path + file.name; filesArray.push(file); resolve(); },
                              () => resolve());
                } else if (item.isDirectory) {
                    const dr = item.createReader();
                    const readAll = async () => {
                        let all = [];
                        const read = () => new Promise(res => dr.readEntries(
                            entries => { if (entries.length) { all.push(...entries); read().then(res); } else res(); },
                            () => res()));
                        await read();
                        await Promise.all(all.map(e => this.traverseFileTree(e, path + item.name + "/", filesArray)));
                        resolve();
                    };
                    readAll();
                } else resolve();
            });
        },
        async uploadFiles(e, droppedFiles = null) {
            const input = e?.target || null;
            const list = Array.from(droppedFiles || input?.files || []);
            if (input) input.value = '';      // re-choisir le même fichier doit redéclencher
            if (!list.length) return;
            this.uploadProgressModal = true; this.uploadProgress = 0;
            this.uploadLabel = `${list.length} fichier(s)`;
            const fd = new FormData();
            for (const f of list) {
                // Noms gardés tels quels (espaces compris) : l'ingestion ne
                // renomme plus rien sur disque (passe RAG 2 2026-09-26).
                const path = f.customPath || f.webkitRelativePath || f.name;
                fd.append('files', f); fd.append('paths', path);
            }
            let d;
            try {
                d = await this._xhrUpload('/api/upload', fd, (frac) => { this.uploadProgress = Math.round(frac * 100); });
            } catch(err) {
                this.uploadProgressModal = false; this.uploadLabel = '';
                this.notify('error', 'Import : ' + err.message);
                return;
            }
            this.uploadProgressModal = false; this.uploadLabel = '';
            // Fichiers refusés (trop gros, extension, chemin), écrasés,
            // erreurs d'archive : tout est dit, rien n'est tu.
            const refused = [
                ...(Array.isArray(d.rejected) ? d.rejected.map(r => `${r.name} (${r.reason})`) : []),
                ...(Array.isArray(d.errors) ? d.errors : []),
            ];
            const count = d.count || 0;
            if (refused.length) {
                this.notify(count ? 'warning' : 'error',
                    (count ? `${count} importé(s) ; ` : '') + `${refused.length} refusé(s) : ` + refused.slice(0, 3).join(' · ')
                    + (refused.length > 3 ? ` (+${refused.length - 3})` : ''));
            } else {
                this.notify('success', `${count} objet(s) importé(s).`);
            }
            if (Array.isArray(d.overwritten) && d.overwritten.length) {
                this.notify('warning', `${d.overwritten.length} fichier(s) remplacé(s) : ` + d.overwritten.slice(0, 3).join(' · '));
            }
            await this.loadFiles();
        },

        // ── Converter ──────────────────────────────────────────────────
        async convertFile() {
            if (!this.converterSourcePath) return this.notify('error', 'Choisissez un fichier.');
            if (this.converterLoading) return;
            this.converterLoading = true;
            let d = null;
            try {
                d = await _api('/api/files/convert', { json: { rel_path: this.converterSourcePath, target_ext: this.converterTargetFormat } });
                this.notify('success', d.msg || 'Converti.');
                await this.loadFiles();
                this.converterSourcePath = ''; this.updateTargetFormats();
            } catch(e) { this.notify('error', 'Conversion : ' + e.message); }
            finally { this.converterLoading = false; }
            if (d && d.new_rel_path) {
                const confirmed = await this.askConfirm('Indexation', 'Indexer le fichier converti ?', { confirmText: 'Indexer' });
                if (confirmed) this.reindexSingleFile({ rel_path: d.new_rel_path, name: d.new_rel_path.split('/').pop() });
            }
        },

        // ── DB ─────────────────────────────────────────────────────────
        async resetDatabase() {
            const confirmed = await this.askConfirm('Purger la base', 'Efface l\'index vectoriel de la collection active.', { confirmText: 'Purger', isDanger: true });
            if (!confirmed) return;
            await this.withBusy('reset', async () => {
                try {
                    await _api('/api/reset', { method: 'POST' });
                    this.notify('success', 'Base purgée.');
                    this.collectionStats = null;
                    await this.loadFiles();
                } catch(e) { this.notify('error', 'Purge : ' + e.message); }
            });
        },
        async restartApp() {
            const confirmed = await this.askConfirm('Redémarrer', 'Redémarrer le serveur ?', { confirmText: 'Redémarrer', isDanger: true });
            if (!confirmed) return;
            await this.withBusy('restart', async () => {
                try {
                    await _api('/api/restart', { method: 'POST' });
                } catch(e) {
                    if (e.status !== 409) { this.notify('error', 'Redémarrage : ' + e.message); return; }
                    // Travail en cours (indexation, OCR) : forcer seulement sur demande.
                    const force = await this.askConfirm('Travail en cours', e.message || 'Une tâche tourne encore.',
                        { confirmText: 'Forcer', isDanger: true });
                    if (!force) return;
                    try { await _api('/api/restart', { json: { force: true } }); }
                    catch(e2) { this.notify('error', 'Redémarrage : ' + e2.message); return; }
                }
                await this._waitForRestart();
            });
        },
        // Attend la coupure puis le retour de /api/health (60 s max) au
        // lieu d'un rechargement aveugle au bout de 5,5 s.
        async _waitForRestart() {
            this.restartingModal = true; this.restartMsg = 'Arrêt…';
            const ping = async () => {
                try {
                    const r = await fetch('/api/health', { cache: 'no-store' });
                    return r.ok;
                } catch(e) { return false; }
            };
            const t0 = Date.now();
            let wentDown = false;
            while (Date.now() - t0 < 60000) {
                await new Promise(r => setTimeout(r, 800));
                const up = await ping();
                if (!up) { wentDown = true; this.restartMsg = 'Démarrage…'; continue; }
                // Recharger seulement une fois le serveur réellement tombé puis
                // revenu ; repli à 40 s (redémarrage trop rapide pour être vu).
                if (wentDown || Date.now() - t0 > 40000) { window.location.reload(); return; }
            }
            this.restartMsg = 'Le serveur ne répond pas.';
        },

        // ── Ingest ─────────────────────────────────────────────────────
        // (tâche de fond : voir startIngest / _launchIndexTask plus haut)

        // ── File editing ───────────────────────────────────────────────
        isEditable(filename) {
            if (!filename) return false;
            return ['txt','md','json','py','js','html','css','csv','yml','yaml','xml','robot'].includes(filename.split('.').pop().toLowerCase());
        },
        parseCSV(text, sep) {
            if (!text) return [['']];
            let rows = [], row = [], cur = '', inQ = false;
            for (let i = 0; i < text.length; i++) {
                let c = text[i];
                if (inQ) {
                    if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else inQ = false; }
                    else cur += c;
                } else {
                    if (c === '"') inQ = true;
                    else if (c === sep) { row.push(cur); cur = ''; }
                    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; if (text[i+1] === '\r') i++; }
                    else if (c !== '\r') cur += c;
                }
            }
            row.push(cur); if (row.length || !rows.length) rows.push(row);
            // Equalise row lengths. ``Math.max(...rows.map(r => r.length))``
            // throws ``RangeError: Maximum call stack`` on CSVs with
            // tens of thousands of rows — same gotcha as in the chunk
            // size bars above. Plain loop is bulletproof.
            let max = 0;
            for (let i = 0; i < rows.length; i++) {
                if (rows[i].length > max) max = rows[i].length;
            }
            rows.forEach(r => { while (r.length < max) r.push(''); });
            return rows;
        },
        serializeCSV(rows, sep) {
            return rows.map(row => row.map(cell => {
                let c = (cell || '').toString();
                return (c.includes(sep) || c.includes('"') || c.includes('\n')) ? '"' + c.replace(/"/g, '""') + '"' : c;
            }).join(sep)).join('\n');
        },
        async openFileViewer(fileNode) {
            this.activeFileNode = fileNode; this.fileViewerModalOpen = true;
            this.isEditingFile = this.isCsvEditing = false;
            this.fileViewerLoading = true; this.fileViewerContent = ""; this._fileOriginal = '';
            // Same client-side guard as testReindexParams: warn before
            // loading a multi-MB file into a textarea (browsers freeze).
            if (fileNode.size && fileNode.size > this.FILE_PREVIEW_HARD_BYTES) {
                this.fileViewerLoading = false;
                this.fileViewerContent = `Fichier trop volumineux (${this.formatBytes(fileNode.size)}). Aperçu limité à ${this.formatBytes(this.FILE_PREVIEW_HARD_BYTES)}.`;
                return;
            }
            const target = fileNode;
            try {
                const data = await _api(`/api/file_text?path=${encodeURIComponent(fileNode.full_path)}`);
                if (this.activeFileNode !== target) return;
                this.fileViewerContent = data.text || "";
                this._fileOriginal = this.fileViewerContent;
                // Un aperçu tronqué ne doit JAMAIS être réenregistré tel quel.
                target._truncated = !!data.truncated;
                if (data.truncated) this.notify('warning', this._truncMsg(data));
            }
            catch(e) { if (this.activeFileNode === target) this.fileViewerContent = "Erreur de chargement : " + e.message; }
            finally { if (this.activeFileNode === target) this.fileViewerLoading = false; }
        },
        // total_chars peut manquer (gros fichier lu en tête seulement) :
        // on donne alors la taille en octets.
        _truncMsg(d) {
            const shown = (d.returned_chars ?? 0).toLocaleString('fr-FR') + ' car.';
            const total = d.total_chars != null ? d.total_chars.toLocaleString('fr-FR') + ' car.'
                        : (d.total_bytes != null ? this.formatBytes(d.total_bytes) : '?');
            return `Aperçu tronqué : ${shown} sur ${total}.`;
        },
        async _confirmDropFileEdit() {
            if (!this.fileDirty) return true;
            return this.askConfirm('Modifications non enregistrées', 'Abandonner les modifications du fichier ?',
                                   { confirmText: 'Abandonner', isDanger: true });
        },
        async cancelFileEdit() {
            if (!(await this._confirmDropFileEdit())) return;
            this.fileViewerContent = this._fileOriginal;
            this.isEditingFile = this.isCsvEditing = false;
        },
        async closeFileViewer() {
            if (!this.fileViewerModalOpen) return;
            if (!(await this._confirmDropFileEdit())) return;
            this.fileViewerModalOpen = false; this.isEditingFile = false; this.isCsvEditing = false;
            this.fileViewerContent = ''; this._fileOriginal = ''; this.editorHl = '';
        },
        async reindexFromViewer() {
            const node = this.activeFileNode;
            if (!node) return;
            await this.closeFileViewer();
            if (!this.fileViewerModalOpen) this.openReindex(node);
        },
        enterEditMode() {
            if (this.activeFileNode?._truncated) {
                this.notify('error', 'Aperçu tronqué : édition impossible ici.');
                return;
            }
            const ext = this.activeFileNode?.ext?.replace('.', '').toLowerCase();
            if (ext === 'csv') {
                this.csvSeparator = this.fileViewerContent.includes(';') ? ';' : ',';
                this.csvData = this.parseCSV(this.fileViewerContent, this.csvSeparator);
                // Référence = CSV re-sérialisé : sinon une simple ouverture
                // compterait comme une modification (guillemets normalisés).
                this._fileOriginal = this.serializeCSV(this.csvData, this.csvSeparator);
                this.isCsvEditing = true;
            } else {
                this._fileOriginal = this.fileViewerContent;
                this.isCsvEditing = false;
                this.editorHl = this.highlightCode(this.fileViewerContent, ext);
            }
            this.isEditingFile = true;
            // Synchronisation scroll textarea ↔ couche highlight après rendu
            this.$nextTick(() => {
                const ta  = document.getElementById('code-editor-textarea');
                const hl  = document.getElementById('code-editor-highlight');
                if (!ta || !hl) return;
                if (!this.isCsvEditing) ta.focus();
                // Le <textarea> PERSISTE (x-show) : écouteur posé une seule fois.
                if (ta._rgSyncBound) return;
                ta._rgSyncBound = true;
                ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; }, { passive: true });
            });
        },
        // Re-coloration différée de l'éditeur (150 ms après la dernière
        // frappe) : le texte tapé reste lisible (textarea), seule la couche
        // colorée suit avec un léger retard.
        _scheduleEditorHl() {
            clearTimeout(this._editorHlTimer);
            this._editorHlTimer = setTimeout(() => {
                this.editorHl = this.highlightCode(this.fileViewerContent, this.activeFileNode?.ext?.replace('.', ''));
            }, 150);
        },
        highlightCode(text, ext) {
            if (!text) return '';
            const esc = (t) => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            let lang = { py: 'python', js: 'javascript', html: 'html', css: 'css', json: 'json', md: 'markdown', sh: 'bash', xml: 'xml', yaml: 'yaml', yml: 'yaml', robot: 'robotframework' }[(ext || '').replace('.', '').toLowerCase()] || '';
            let hl;
            // highlightAuto essaie TOUS les langages : réservé aux petits
            // textes ; au-delà de 500 k caractères, plus de coloration du tout.
            if (text.length > 500000 || (!lang && text.length > 20000) || !window.hljs) hl = esc(text);
            else {
                try { hl = lang && hljs.getLanguage(lang) ? hljs.highlight(text, {language: lang}).value : hljs.highlightAuto(text).value; }
                catch(e) { hl = esc(text); }
            }
            if (text.endsWith('\n')) hl += ' ';
            return hl;
        },
        formatViewerContent() {
            if (!this.activeFileNode || !this.fileViewerContent) return '';
            const ext = (this.activeFileNode.ext || '').replace('.', '').toLowerCase();
            const text = this.fileViewerContent;
            if (ext === 'csv') {
                let sep = text.includes(';') ? ';' : ',', rows = this.parseCSV(text, sep);
                // Au-delà de 2 000 lignes, aperçu partiel (le DOM ne suit plus).
                const shown = rows.slice(0, 2000);
                let html = '<div class="p-8"><div class="overflow-x-auto rounded-xl border border-slate-200"><table class="w-full text-left border-collapse bg-white">';
                shown.forEach((cols, i) => {
                    html += '<tr class="border-b border-slate-100 hover:bg-slate-50 last:border-0">';
                    cols.forEach(col => {
                        let cell = i===0 ? 'th' : 'td', css = i===0 ? 'px-4 py-3 bg-slate-50 font-bold text-slate-700 text-xs uppercase' : 'px-4 py-2 text-sm text-slate-600';
                        html += `<${cell} class="${css}">${_escHtml(col.trim())}</${cell}>`;
                    });
                    html += '</tr>';
                });
                html += '</table></div>';
                if (rows.length > shown.length) html += `<div class="text-xs text-slate-400 mt-3">${rows.length - shown.length} ligne(s) non affichée(s).</div>`;
                return html + '</div>';
            }
            let hl = this.highlightCode(text, ext);
            return `<div class="bg-white min-h-full w-full p-8"><pre class="m-0 font-mono text-[13px] whitespace-pre-wrap break-words leading-relaxed text-slate-800"><code class="hljs" style="background:transparent;padding:0;">${hl}</code></pre></div>`;
        },
        async saveFileContent() {
            if (!this.activeFileNode) return;
            await this.withBusy('saveFile', async () => {
                const content = this.isCsvEditing ? this.serializeCSV(this.csvData, this.csvSeparator) : this.fileViewerContent;
                const node = this.activeFileNode;
                try {
                    await _api('/api/files/save', { json: { rel_path: node.rel_path, content } });
                } catch(e) { this.notify('error', 'Sauvegarde : ' + e.message); return; }
                this.fileViewerContent = content; this._fileOriginal = content;
                this.isEditingFile = this.isCsvEditing = false;
                this.notify('success', 'Fichier enregistré.');
                const confirmed = await this.askConfirm('Fichier enregistré', 'Réindexer maintenant ?', { confirmText: 'Réindexer' });
                if (confirmed) this.reindexSingleFile(node); else await this.loadFiles();
            });
        },

        // ── Node rules ─────────────────────────────────────────────────
        openNodeRule(node) {
            this.activeRuleNode = node;
            const isFolder = node.type === 'folder';
            const existing = (isFolder ? this.config.folder_rules : this.config.file_rules)?.[node.path];
            this.nodeRuleParams = existing ? { ...existing } : { method: 'size', size: this.config.global_chunk_size, overlap: this.config.global_chunk_overlap, value: '' };
            this.nodeRuleModalOpen = true;
        },
        async saveNodeRule() {
            const node = this.activeRuleNode;
            if (!node) return;
            const isFolder = node.type === 'folder';
            const key = isFolder ? 'folder_rules' : 'file_rules';
            const before = JSON.parse(JSON.stringify(this.config[key] || {}));
            this.config[key] = { ...(this.config[key] || {}), [node.path]: { ...this.nodeRuleParams } };
            if (!(await this.saveConfig({ section: 'rules', quiet: true }))) { this.config[key] = before; return; }
            this.nodeRuleModalOpen = false;
            const confirmed = await this.askConfirm('Règle enregistrée', 'Réindexer maintenant ?', { confirmText: 'Réindexer' });
            if (!confirmed) return;
            if (isFolder) {
                if (this.indexTaskRunning) { this.notify('warning', 'Une indexation tourne déjà.'); this.taskModalOpen = true; return; }
                await this._launchIndexTask({ kind: 'bulk_reindex', folder: node.path });
            } else this.reindexSingleFile(node);
        },
        async removeNodeRule() {
            const node = this.activeRuleNode;
            if (!node) return;
            const key = node.type === 'folder' ? 'folder_rules' : 'file_rules';
            const before = JSON.parse(JSON.stringify(this.config[key] || {}));
            const next = { ...(this.config[key] || {}) };
            delete next[node.path];
            this.config[key] = next;
            if (!(await this.saveConfig({ section: 'rules' }))) { this.config[key] = before; return; }
            this.nodeRuleModalOpen = false;
            this.buildTree();
        },
        // ── Progress modal helpers ──────────────────────────────────────
        _startReindexTimer() {
            this._reindexStart = Date.now();
            this.reindexProgressElapsed = 0;
            clearInterval(this._reindexTimer);
            this._reindexTimer = setInterval(() => {
                this.reindexProgressElapsed = ((Date.now() - this._reindexStart) / 1000).toFixed(1);
            }, 100);
        },
        _stopReindexTimer() {
            clearInterval(this._reindexTimer);
            this._reindexTimer = null;
        },
        _openReindexProgress(label, file = '') {
            this.reindexProgressModal   = true;
            this.reindexProgressLabel   = label;
            this.reindexProgressFile    = file;
            this.reindexProgressPct2    = 5;
            this.reindexProgressDone    = false;
            this.reindexProgressChunks  = 0;
            // Une fermeture différée d'une réindexation précédente ne doit pas
            // masquer celle-ci.
            clearTimeout(this._reindexCloseTimer); this._reindexCloseTimer = null;
            this._startReindexTimer();
        },
        _closeReindexProgress(chunks = 0) {
            this._stopReindexTimer();
            this.reindexProgressPct2   = 100;
            this.reindexProgressDone   = true;
            this.reindexProgressChunks = chunks;
            clearTimeout(this._reindexCloseTimer);
            this._reindexCloseTimer = setTimeout(() => { this._reindexCloseTimer = null; this.reindexProgressModal = false; }, 2200);
        },
        _failReindexProgress() {
            this._stopReindexTimer();
            this.reindexProgressModal = false;
        },

        async reindexSingleFile(fileNode) {
            await this.withBusy('reindex:' + fileNode.rel_path, async () => {
                this._openReindexProgress('Réindexation', fileNode.name || fileNode.rel_path);
                // Progression simulée (la route répond en une fois) : minuterie
                // TOUJOURS arrêtée, succès ou exception.
                const tick = setInterval(() => {
                    if (this.reindexProgressPct2 < 85) this.reindexProgressPct2 += Math.random() * 15;
                }, 300);
                try {
                    const d = await _api('/api/files/reindex', { json: { rel_path: fileNode.rel_path } });
                    clearInterval(tick);
                    this._closeReindexProgress(d.chunks);
                    this.notify('success', `Réindexé : ${d.chunks} chunks`);
                    await this.loadFiles();
                } catch(e) {
                    this._failReindexProgress();
                    this.notify('error', 'Réindexation : ' + e.message);
                } finally { clearInterval(tick); }
            });
        },
        openReindex(file) {
            this.reindexFileTarget = file; this.reindexModalOpen = true; this.reindexMode = 'default';
            this.reindexPreviewChunks = []; this.reindexCurrentChunks = []; this.reindexRightTab = 'preview';
            this.reindexRunning = false; this.reindexProgressPct = 0; this.reindexDone = false; this.reindexDoneMsg = '';
            this.reindexParams = { method: 'size', size: this.config.global_chunk_size, overlap: this.config.global_chunk_overlap, value: '' };
            this.splitState = {}; this.previewSplitState = {}; this.previewHasSplits = false;
            // CRITICAL CHANGE: previously we fetched the file contents
            // AND the existing DB chunks in parallel. For a 5 MB file
            // that doubled peak memory (≈ 25 MB JS + 50 MB DOM) and
            // crashed the tab. Now only the preview kicks off — DB
            // chunks load lazily when the user actually clicks the
            // "Chunks DB" tab in the right pane.
            this.testReindexParams();
        },

        // Centralised close handler — aborts every in-flight fetch and
        // releases all the heavy state references (chunks, split state,
        // size caches) so the GC can reclaim them. Without this, closing
        // a modal during a slow preview would leave the file text and
        // chunk arrays alive in memory until the next openReindex call.
        closeReindexModal() {
            this._abortFile?.abort();
            this._abortDbChunks?.abort();
            this._abortFile = this._abortDbChunks = null;
            this.reindexModalOpen = false;
            this.reindexFileTarget = null;
            // Drop all the heavy state — these can be 10s of MB on big
            // files. Setting them empty lets the GC collect.
            this.reindexPreviewChunks = [];
            this.reindexCurrentChunks = [];
            this.previewSplitState = {};
            this.splitState = {};
            this._reindexMaxCharCache = { ref: null, value: 0 };
            this._previewMaxCharCache = { ref: null, value: 0 };
        },

        // Lazy: only called when the user clicks the "Chunks DB" tab.
        // Previously this ran in parallel with testReindexParams() on
        // modal open, doubling peak memory for files large enough to
        // matter.
        async loadReindexCurrentChunks(force = false) {
            if (!this.reindexFileTarget) return;
            // No-op if already loaded for this file (avoid refetch on
            // every tab switch) — sauf rechargement forcé après une
            // réindexation ou un découpage appliqué en base.
            if (!force && this.reindexCurrentChunks.length > 0) return;
            this.reindexChunksLoading = true;
            this._abortDbChunks?.abort();
            this._abortDbChunks = new AbortController();
            const prevState = this.splitState;  // direct ref, no clone
            try {
                const r = await fetch('/api/files/inspect', {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ full_path: this.reindexFileTarget.full_path }),
                    signal: this._abortDbChunks.signal,
                });
                if (!r.ok) throw new Error(`Erreur ${r.status}`);
                {
                    const raw = await r.json() || [];
                    // Tag with stable UID — see _mkUid above for rationale.
                    this.reindexCurrentChunks = raw.map(c => ({ ...c, _uid: this._mkUid() }));
                    // Reset the size cache (array reference changed).
                    this._reindexMaxCharCache = { ref: null, value: 0 };
                    const newState = {};
                    this.reindexCurrentChunks.forEach(c => {
                        const charCount = c.char_count || c.text?.length || 500;
                        const prev = prevState[c.chunk_index];
                        newState[c.chunk_index] = {
                            open:    prev?.open || false,
                            loading: false,
                            error:   '',
                            params: prev?.params || {
                                method:  'size',
                                size:    Math.max(100, Math.floor(charCount / 2)),
                                overlap: Math.max(0, Math.floor(charCount / 10)),
                                value:   '',
                            },
                        };
                    });
                    this.splitState = newState;
                }
            } catch(e) {
                if (e.name === 'AbortError') return;
                this.notify('error', 'Chunks en base : ' + (e.message || 'erreur'));
            } finally {
                this.reindexChunksLoading = false;
            }
        },

        // Switch right-pane tab. We use this hook (rather than a direct
        // x-model on the radio) so the DB chunks fetch can be deferred
        // to the moment the tab actually becomes visible.
        switchReindexTab(tab) {
            this.reindexRightTab = tab;
            if (tab === 'db') this.loadReindexCurrentChunks();
        },

        // Memoised — see chunkSizeBar above for the rationale. The
        // OLD spread+Math.max version was the single biggest cause of
        // the "tab freezes for 5s after every reindex modal click"
        // bug — it fired on every chunk on every render.
        reindexChunkSizeBar(charCount) {
            const arr = this.reindexCurrentChunks;
            if (!arr.length) return 0;
            let cache = this._reindexMaxCharCache;
            if (!cache || cache.ref !== arr) {
                let max = 0;
                for (let i = 0; i < arr.length; i++) {
                    const v = arr[i].char_count || (arr[i].text ? arr[i].text.length : 0);
                    if (v > max) max = v;
                }
                cache = { ref: arr, value: max };
                this._reindexMaxCharCache = cache;
            }
            return cache.value > 0 ? Math.round(charCount / cache.value * 100) : 0;
        },

        // Same pattern for the LEFT panel (the preview list, which has
        // its own array — reindexPreviewChunks). Previously it shared
        // the reindex bar function, which was wrong: max chunk size in
        // the preview can differ from max in the DB after the user
        // tweaks params.
        previewChunkSizeBar(charCount) {
            const arr = this.reindexPreviewChunks;
            if (!arr.length) return 0;
            let cache = this._previewMaxCharCache;
            if (!cache || cache.ref !== arr) {
                let max = 0;
                for (let i = 0; i < arr.length; i++) {
                    const v = arr[i].text ? arr[i].text.length : (arr[i].char_count || 0);
                    if (v > max) max = v;
                }
                cache = { ref: arr, value: max };
                this._previewMaxCharCache = cache;
            }
            return cache.value > 0 ? Math.round(charCount / cache.value * 100) : 0;
        },

        toggleReindexSplit(chunk_index) {
            // Direct mutation — Alpine 3 Proxy detects it. No clone needed.
            const s = this.splitState[chunk_index];
            if (s) s.open = !s.open;
        },

        async applyChunkSplitInReindex(chunk) {
            const idx   = chunk.chunk_index;
            const state = this.splitState[idx];
            if (!state || state.loading) return;

            if (!chunk._qdrant_id) {
                this.notify('error', 'ID Qdrant manquant. Fermez et rouvrez la fenêtre.');
                return;
            }
            state.loading = true; state.error = '';
            let success = false;
            try {
                const d = await _api('/api/chunks/split/apply', { json: { original_payload: chunk, params: state.params } });
                success = true;
                this.notify('success', `Chunk #${idx} → ${d.new_chunks} sous-chunk(s)`);
            } catch(e) {
                state.error = e.message || 'Erreur';
                this.notify('error', 'Découpage : ' + state.error);
            } finally {
                // Toujours relâché (l'ancien état « loading » restait collé
                // après un succès et bloquait le bouton).
                const cur = this.splitState[idx];
                if (cur) cur.loading = false;
            }
            if (success) {
                await this.loadReindexCurrentChunks(true);
                await this.loadFiles();
            }
        },
        async testReindexParams() {
            const file = this.reindexFileTarget;
            if (!file) return;

            // Client-side size guard. The server enforces its own cap
            // on /api/file_text but we want to ASK the user before
            // burning the bandwidth — they may have a smaller file
            // they actually want to use.
            if (file.size && file.size > this.FILE_PREVIEW_HARD_BYTES) {
                this.notify('error', `Fichier trop volumineux (${this.formatBytes(file.size)}). La preview est limitée à ${this.formatBytes(this.FILE_PREVIEW_HARD_BYTES)}.`);
                return;
            }
            if (file.size && file.size > this.FILE_PREVIEW_WARN_BYTES) {
                const ok = await this.askConfirm(
                    'Fichier volumineux',
                    `Ce fichier fait ${this.formatBytes(file.size)}. La prévisualisation peut être ralentie ou tronquée. Continuer ?`,
                    { confirmText: 'Continuer' }
                );
                if (!ok) return;
            }

            // Cancel previous in-flight preview if user re-clicks fast.
            this._abortFile?.abort();
            this._abortFile = new AbortController();

            this.reindexLoading = true;
            this.reindexPreviewChunks = [];
            this.previewSplitState = {};
            this.previewHasSplits = false;
            this._previewMaxCharCache = { ref: null, value: 0 };

            try {
                // 1) Fetch file text (bounded by server cap).
                const r = await fetch(
                    `/api/file_text?path=${encodeURIComponent(file.full_path)}`,
                    { signal: this._abortFile.signal },
                );
                if (!r.ok) throw new Error(r.status === 404 ? "Fichier introuvable" : `Erreur ${r.status}`);
                const fileData = await r.json();

                if (fileData.truncated) this.notify('warning', this._truncMsg(fileData));

                // 2) Send to /api/preview_text for chunking.
                const params = this.reindexMode === 'custom' ? { ...this.reindexParams } : null;
                const d2 = await _api('/api/preview_text', {
                    json: { text: fileData.text, params }, signal: this._abortFile.signal,
                });
                const chunks = ((d2 && d2.chunks) || []).map(c => ({ ...c, _uid: this._mkUid() }));

                this.reindexPreviewChunks = chunks;

                // Build split state in one direct assignment — no clone.
                const newState = {};
                for (let i = 0; i < chunks.length; i++) {
                    const c = chunks[i];
                    const charCount = c.text?.length || 500;
                    newState[c.index] = {
                        open: false, loading: false, error: '',
                        params: {
                            method: 'size',
                            size:    Math.max(100, Math.floor(charCount / 2)),
                            overlap: Math.max(0, Math.floor(charCount / 10)),
                            value: '',
                        },
                    };
                }
                this.previewSplitState = newState;
            } catch(e) {
                if (e.name === 'AbortError') return;
                this.notify('error', "Erreur d'aperçu : " + (e.message || 'inconnue'));
            } finally {
                this.reindexLoading = false;
            }
        },

        togglePreviewSplit(idx) {
            // Direct mutation — Alpine 3 detects via Proxy. No clone.
            const s = this.previewSplitState[idx];
            if (s) s.open = !s.open;
        },

        async splitPreviewChunk(chunk) {
            const idx   = chunk.index;
            const state = this.previewSplitState[idx];
            if (!state || state.loading) return;

            // Validate params before fetching — saves a server round-trip
            // on obvious mistakes.
            if (!this._validateSplitParams(state.params)) {
                state.error = 'Paramètres invalides (taille > 0, overlap < taille).';
                return;
            }

            state.loading = true;
            state.error = '';

            try {
                const d = await _api('/api/preview_text', { json: { text: chunk.text, params: state.params } });
                const rawSubs = (d && d.chunks) || [];
                if (!rawSubs.length) throw new Error('Aucun sous-chunk produit');

                // Tag sub-chunks with stable UIDs.
                const subChunks = rawSubs.map(c => ({ ...c, _uid: this._mkUid() }));

                const pos = this.reindexPreviewChunks.findIndex(c => c.index === idx);
                if (pos === -1) throw new Error('Chunk introuvable dans la preview');

                // Splice in-place is a single allocation regardless of
                // array size — vs the old [...before, ...subs, ...after]
                // which copied the whole array twice for each split.
                this.reindexPreviewChunks.splice(pos, 1, ...subChunks);

                // Renumber `index` (used as visible label and key into
                // previewSplitState). _uid stays stable for Alpine :key
                // so only the touched chunks actually re-render in DOM.
                const arr = this.reindexPreviewChunks;
                for (let i = 0; i < arr.length; i++) arr[i].index = i;

                // Invalidate the size-bar cache (max may have changed).
                this._previewMaxCharCache = { ref: null, value: 0 };
                this.previewHasSplits = true;

                // Rebuild splitState — preserve panel open/closed for
                // chunks that already had state, init fresh for new ones.
                const oldState = this.previewSplitState;
                const newState = {};
                for (let i = 0; i < arr.length; i++) {
                    const c = arr[i];
                    const charCount = c.text?.length || 500;
                    newState[c.index] = oldState[c.index] || {
                        open: false, loading: false, error: '',
                        params: {
                            method: 'size',
                            size:    Math.max(100, Math.floor(charCount / 2)),
                            overlap: Math.max(0, Math.floor(charCount / 10)),
                            value: '',
                        },
                    };
                }
                this.previewSplitState = newState;
                this.notify('success', `Chunk #${idx} → ${subChunks.length} sous-chunk(s) dans la preview`);
            } catch(e) {
                state.error = e.message || 'Erreur';
                this.notify('error', state.error);
            } finally {
                // state may have been replaced by the renumbering above
                // — fetch the current ref by index before mutating.
                const cur = this.previewSplitState[idx];
                if (cur) cur.loading = false;
            }
        },

        // ── Utility: validate split params before sending to server ──
        // Returns false for params that would never produce useful
        // chunks (size=0, overlap >= size, empty pattern).
        _validateSplitParams(p) {
            if (!p) return false;
            if (p.method === 'size' || p.method === 'sentence') {
                if (!p.size || p.size <= 0) return false;
                if (p.overlap && p.overlap >= p.size) return false;
                return true;
            }
            if (p.method === 'delimiter' || p.method === 'regex') {
                return !!(p.value && p.value.trim());
            }
            return true;
        },

        async confirmReindex() {
            if (!this.reindexFileTarget || this.reindexRunning) return;
            const target = this.reindexFileTarget;

            this.reindexRunning = true; this.reindexProgressPct = 5; this.reindexDone = false; this.reindexDoneMsg = '';
            // Affiche aussi la progress modal globale avec timer
            this._openReindexProgress('Réindexation', target.name);
            const tick = setInterval(() => {
                if (this.reindexProgressPct < 85) this.reindexProgressPct += Math.random() * 12;
                if (this.reindexProgressPct2 < 85) this.reindexProgressPct2 += Math.random() * 10;
            }, 350);

            try {
                let d;
                if (this.previewHasSplits && this.reindexPreviewChunks.length > 0) {
                    d = await _api('/api/files/reindex_from_chunks', { json: {
                        rel_path: target.rel_path,
                        chunks:   this.reindexPreviewChunks.map(c => ({ text: c.text })),
                    } });
                } else {
                    const params = this.reindexMode === 'custom' ? { ...this.reindexParams } : null;
                    d = await _api('/api/files/reindex', { json: { rel_path: target.rel_path, params } });
                }
                clearInterval(tick);
                this.reindexProgressPct = 100;
                this.reindexDone = true;
                this.reindexDoneMsg = `✓ ${d.chunks} chunks indexés${this.previewHasSplits ? ' (découpage personnalisé)' : ''}`;
                this._closeReindexProgress(d.chunks);
                this.notify('success', `Réindexé : ${d.chunks} chunks`);
                await this.loadFiles();
                if (this.reindexFileTarget === target) {
                    // Onglet « Chunks en base » : état APRÈS réindexation.
                    await this.loadReindexCurrentChunks(true);
                    this.reindexRightTab = 'db';
                }
                this.reindexRunning = false;
            } catch(e) {
                this._failReindexProgress();
                this.reindexDone = false; this.reindexRunning = false; this.reindexProgressPct = 0;
                this.notify('error', 'Réindexation : ' + e.message);
            } finally { clearInterval(tick); }
        },

        addRule() {
            let ext = this.newExt.trim();
            if (!ext) { this.notify('error', 'Entrez une extension'); return; }
            if (!ext.startsWith('.')) ext = '.' + ext;
            if ((this.newMethod === 'regex' || this.newMethod === 'delimiter') && !this.newVal) { this.notify('error', 'Valeur requise'); return; }
            this.config.extension_rules = { ...this.config.extension_rules, [ext]: { method: this.newMethod, value: (['regex','delimiter'].includes(this.newMethod)) ? this.newVal : null } };
            this.newExt = ''; this.newVal = ''; this.notify('success', 'Règle ajoutée'); this.buildTree();
        },
        removeRule(ext) { delete this.config.extension_rules[ext]; this.buildTree(); },

        formatBytes(bytes) {
            if (!bytes) return '0 B';
            const k = 1024, i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + ['B','KB','MB','GB'][i];
        },

        // ── Session console ────────────────────────────────────────────
        async logout() {
            if (this.configDirty && !(await this.askConfirm('Modifications non enregistrées',
                    'Se déconnecter quand même ?', { confirmText: 'Déconnexion', isDanger: true }))) return;
            try { await _api('/api/console/logout', { method: 'POST' }); } catch(e) {}
            this._savedConfig = JSON.stringify(this.config);   // pas de 2e alerte au rechargement
            window.location.reload();
        },
        async retryAuth() {
            this.authError = '';
            if (window._ragAuth && await window._ragAuth.retry()) window.location.reload();
        },

        // ── Help ───────────────────────────────────────────────────────
        async openHelp() {
            this.helpModalOpen = true; this.isLoadingReadme = true;
            try {
                const d = await _api('/api/help/readme');
                this.readmeContent = d.content || '';
            } catch(e) { this.readmeContent = "Documentation indisponible : " + e.message; }
            finally { this.isLoadingReadme = false; }
        },
        renderMarkdown(text) {
            return text ? _mdToHtml(text) : '';
        },
        handleMarkdownClick(event) {
            const link = event.target.closest('a');
            if (!link) return;
            const href = link.getAttribute('href');
            if (href?.startsWith('#') && href.length > 1) {
                event.preventDefault();
                let targetId = href.substring(1);
                try { targetId = decodeURIComponent(targetId); } catch(e) {}
                let el = document.getElementById(targetId);
                if (!el) {
                    for (let h of (event.target.closest('.markdown-body') || document).querySelectorAll('h1,h2,h3,h4,h5,h6')) {
                        if (h.textContent.trim().toLowerCase().replace(/[^\w\u00C0-\uFFFF\s-]/g,'').replace(/\s+/g,'-') === targetId) { el = h; break; }
                    }
                }
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        },
    }));
});
