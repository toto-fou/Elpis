// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_compose.js -- Composition (textarea, raccourcis,
//  @mentions de fichiers de la sandbox).
//
//  Extrait de app-chat.js (lignes 139-148, 369-578). Comportement
//  identique :
//
//    * State @mention (refs + vars locales avec cache)
//    * 11 fonctions internes pour gérer le dropdown @mention,
//      la pagination, le scroll, l'ouverture/fermeture
//    * 2 handlers d'input pour la textarea (keydown + input)
//
//  Le bloc s'occupe de :
//    * détecter le pattern ``@xxx`` dans la textarea
//    * fetcher la liste des fichiers de la sandbox via
//      ``/api/sandbox/tree`` (cache 30 s)
//    * afficher un dropdown filtré, paginé (50 par page sans query,
//      jusqu'à 200 en filtré), naviguable au clavier (↑↓Enter Esc)
//    * insérer le fichier choisi comme une "chip" dans
//      ``attachedFiles`` (avec son contenu lu via ``/api/sandbox/download``)
//
//  Dépendances injectées :
//    * sharedRefs.inputRef        -- ref(HTMLElement) — la textarea
//    * sharedRefs.inputMessage    -- ref(string)      — texte courant
//    * sharedRefs.attachedFiles   -- ref(array)       — chips au-dessus
//    * ctx.fetchAuth              -- helper HTTP authentifié
//    * ctx.showToast              -- toast système
//    * ctx.sendMessage            -- déclencheur d'envoi (Enter sans shift)
//    * ctx.autoResize             -- wrapper qui ré-ajuste la hauteur de la
//                                    textarea ; lazy car défini par le
//                                    template Vue après l'init du module
//
//  Le menu « / » (commandes, skills, prompts) vivait ici ; il est
//  parti dans chat/_slash.js quand il a gagné un registre, des
//  arguments et des niveaux de complétion. Ce module le MONTE et lui
//  cède la main en tête de cascade clavier — tout son retour est
//  re-exporté ici, donc app-chat.js et le template ne voient qu'un
//  seul module.
//
//  Exporte :
//    * showMentionDropdown, mentionQuery, mentionFiles, mentionIndex,
//      isMentionLoading, mentionHasMore   (refs Vue)
//    * loadMoreMentionFiles, onMentionScroll, closeMentionDropdown,
//      selectMention, handleInputKeydown, handleInputInput   (functions)
//    * tout le retour de setupChatSlash (menu « / »)
//    * tout le retour de setupChatTemplates (templates de prompt)
// ============================================================

function setupChatCompose(vue, sharedRefs, ctx) {
    const { ref, nextTick } = vue;
    const { inputRef, inputMessage, attachedFiles, isStreaming } = sharedRefs;
    const { fetchAuth, showToast, sendMessage }     = ctx;
    // Note: ``ctx.autoResize`` est un wrapper qui forward vers
    //       ``chatMod.autoResize`` (côté app.js). Il n'est pas garanti
    //       d'être disponible au moment de l'init de ce sous-module —
    //       on le ré-évalue à chaque appel, comme l'ancien code.

    // ── State @mention ────────────────────────────────────────────
    const showMentionDropdown = ref(false);
    const mentionQuery        = ref('');
    const mentionFiles        = ref([]);   // flat filtered list (paginated when no query)
    const mentionIndex        = ref(0);    // keyboard-selected row
    const isMentionLoading    = ref(false);
    const mentionHasMore      = ref(false); // true when more files can be loaded in dropdown
    // ── Recents (UX option 1 round 3) ─────────────────────────────
    // Quand l'utilisateur sélectionne un fichier via le @-menu, on
    // mémorise son path en localStorage. Au prochain ouverture, ces
    // fichiers (s'ils correspondent au filtre courant) sont ramenés
    // en tête de liste sous une section "Récents". L'index keyboard
    // continue de traverser une liste plate, mentionRecentCount donne
    // l'offset du séparateur "Récents" → "Tous" dans le rendu.
    const mentionRecentCount  = ref(0);
    const MENTION_RECENTS_KEY = 'elpis.mention.recents.v1';
    const MENTION_RECENTS_MAX = 5;
    let   _mentionAllFiles    = [];        // unfiltered flat cache
    let   _mentionCacheTime   = 0;         // timestamp of last cache fill
    let   _mentionSortedCache = null;      // cached sorted version of _mentionAllFiles (for no-query scroll)
    const MENTION_PAGE_SIZE   = 50;

    // ── Helpers ───────────────────────────────────────────────────

    function _flattenTree(items, acc) {
        acc = acc || [];
        (items || []).forEach(function(item) {
            if (!item) return;
            if (item.type === 'file') {
                acc.push({ path: item.path, name: item.name || (item.path || '').split('/').pop() });
            }
            // Descendre dans TOUS les containers possibles, indépendamment du type.
            // (dossiers, repos git clonés, etc.)
            var kids = item.children || item.items || item.files;
            if (Array.isArray(kids) && kids.length) {
                _flattenTree(kids, acc);
            }
        });
        return acc;
    }

    let _mentionInflight = null;           // dédup des fetchs concurrents

    async function _loadMentionFiles() {
        const now = Date.now();
        if (_mentionAllFiles.length > 0 && (now - _mentionCacheTime) < 30000) return;
        // dédup : si l'utilisateur retape « @ » pendant que
        // le tree charge (sandbox volumineuse), on REJOINT le fetch en vol au
        // lieu d'en lancer un second (deux réponses concurrentes rendaient
        // le dropdown imprévisible).
        if (_mentionInflight) return _mentionInflight;
        isMentionLoading.value = true;
        _mentionInflight = (async function() {
            try {
                const res = await fetchAuth('/api/sandbox/tree', {}, true);
                if (res && res.ok) {
                    const data = await res.json();
                    _mentionAllFiles = _flattenTree(data.items || []);
                    _mentionSortedCache = null;
                    _mentionCacheTime = Date.now();
                }
            } catch (e) { /* non-fatal */ }
            finally {
                isMentionLoading.value = false;
                _mentionInflight = null;
            }
        })();
        return _mentionInflight;
    }

    /** Return the full sorted list (used when no query, cached for perf). */
    function _getSortedAllFiles() {
        if (_mentionSortedCache) return _mentionSortedCache;
        _mentionSortedCache = _mentionAllFiles.slice().sort((a, b) => {
            const depthA = (a.path.match(/\//g) || []).length;
            const depthB = (b.path.match(/\//g) || []).length;
            if (depthA !== depthB) return depthA - depthB;
            return a.path.localeCompare(b.path);
        });
        return _mentionSortedCache;
    }

    function _filterMentionFiles(query) {
        const q = (query || '').toLowerCase();

        // Étape 1 : produire la liste déjà filtrée (logique d'origine)
        let filtered;
        if (!q) {
            const all = _getSortedAllFiles();
            mentionHasMore.value = all.length > MENTION_PAGE_SIZE;
            filtered = all.slice(0, MENTION_PAGE_SIZE);
        } else {
            filtered = _mentionAllFiles
                .filter(f => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
                .slice(0, 200);
            mentionHasMore.value = false;
        }

        // Étape 2 : extraire les recents qui matchent encore le filtre.
        // On itère les recents dans leur ordre (plus récent en premier),
        // en filtrant ceux qui ont disparu de _mentionAllFiles entre-temps.
        const recents      = _getMentionRecents();
        const filteredMap  = new Map(filtered.map(f => [f.path, f]));
        const recentItems  = [];
        const recentPathSet = new Set();
        for (const p of recents) {
            if (filteredMap.has(p)) {
                recentItems.push(filteredMap.get(p));
                recentPathSet.add(p);
            }
        }
        // Étape 3 : reste = filtered moins les recents (ordre préservé)
        const restItems = filtered.filter(f => !recentPathSet.has(f.path));

        mentionRecentCount.value = recentItems.length;
        return [...recentItems, ...restItems];
    }

    // ===========================================================
    //  Mention recents storage (UX option 1 round 3)
    //
    //  localStorage-backed, max MENTION_RECENTS_MAX entrées, ordre
    //  most-recent-first. Les paths absents dans le sandbox courant
    //  sont silencieusement filtrés à l'affichage (cf. _filterMentionFiles)
    //  donc pas besoin de ménage actif.
    // ===========================================================

    function _getMentionRecents() {
        try {
            const raw = localStorage.getItem(MENTION_RECENTS_KEY);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.filter(p => typeof p === 'string') : [];
        } catch (_) { return []; }
    }

    function _addMentionRecent(path) {
        if (!path || typeof path !== 'string') return;
        try {
            const cur = _getMentionRecents().filter(p => p !== path);
            cur.unshift(path);
            localStorage.setItem(MENTION_RECENTS_KEY, JSON.stringify(cur.slice(0, MENTION_RECENTS_MAX)));
        } catch (_) { /* localStorage may be disabled / quota -- non-fatal */ }
    }

    // ===========================================================
    //  Display helpers (UX option 1 round 3)
    //
    //  mentionIconClass(path) : retourne {icon, color} basé sur
    //  l'extension. Les classes Phosphor matchent celles utilisées
    //  ailleurs dans le composer (chips d'attachement) pour cohérence
    //  visuelle. Fallback sur ph-file pour les extensions inconnues.
    //
    //  mentionFilenameOf / mentionDirOf : split du path en basename +
    //  dirname pour le rendu sur deux lignes (nom en haut, dir en bas).
    // ===========================================================

    function mentionIconClass(filenameOrPath) {
        const name = (filenameOrPath || '').toLowerCase();
        if (name.endsWith('.js')   || name.endsWith('.mjs'))   return { icon: 'ph-file-js',         color: 'text-yellow-400' };
        if (name.endsWith('.ts')   || name.endsWith('.tsx'))   return { icon: 'ph-file-ts',         color: 'text-blue-400' };
        if (name.endsWith('.html'))                            return { icon: 'ph-browsers',        color: 'text-orange-500' };
        if (name.endsWith('.css'))                             return { icon: 'ph-paint-brush',     color: 'text-sky-400' };
        if (name.endsWith('.json'))                            return { icon: 'ph-brackets-curly',  color: 'text-lime-500' };
        if (name.endsWith('.py'))                              return { icon: 'ph-file-py',         color: 'text-blue-500' };
        if (name.endsWith('.sh'))                              return { icon: 'ph-terminal-window', color: 'text-green-500' };
        if (name.endsWith('.md'))                              return { icon: 'ph-info',            color: 'text-slate-400' };
        if (name.endsWith('.txt'))                             return { icon: 'ph-file-text',       color: 'text-gray-500' };
        return { icon: 'ph-file', color: 'text-blue-400' };
    }

    function mentionFilenameOf(path) {
        if (!path) return '';
        const i = path.lastIndexOf('/');
        return i >= 0 ? path.substring(i + 1) : path;
    }

    function mentionDirOf(path) {
        if (!path) return '';
        const i = path.lastIndexOf('/');
        return i >= 0 ? path.substring(0, i + 1) : '/';
    }

    /** Load the next page of files in the dropdown (infinite scroll). */
    function loadMoreMentionFiles() {
        if (!mentionHasMore.value) return;
        if (mentionQuery.value) return; // pagination only when no query
        const all = _getSortedAllFiles();
        const currentLen = mentionFiles.value.length;
        const nextLen    = Math.min(currentLen + MENTION_PAGE_SIZE, all.length);
        if (nextLen <= currentLen) { mentionHasMore.value = false; return; }
        // AUDIT 2026-08-31 (passe 3) — CONSERVER le hoist des « Récents ».
        // L'ancienne réassignation de la liste BRUTE triée renvoyait les
        // récents à leur place naturelle SANS remettre mentionRecentCount à
        // zéro : la liste se réordonnait SOUS le curseur (déclenché par ↓ au
        // bas de liste) et les en-têtes « Récents »/« Tous » coiffaient
        // n'importe quoi. On garde la même structure que _filterMentionFiles :
        // récents en tête, puis le reste dans l'ordre trié.
        const recents      = mentionFiles.value.slice(0, mentionRecentCount.value);
        const recentPaths  = new Set(recents.map(f => f.path));
        const rest         = all.filter(f => !recentPaths.has(f.path));
        mentionFiles.value = [...recents, ...rest].slice(0, nextLen);
        mentionHasMore.value = nextLen < recents.length + rest.length;
    }

    /** Scroll handler on the dropdown <ul> -- triggers loadMore near bottom. */
    function onMentionScroll(event) {
        const el = event.target;
        if (!el) return;
        // Seuil : 80px avant le bas → déclencher le chargement
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
            loadMoreMentionFiles();
        }
    }

    /**
     * Read the textarea text before the cursor and return the @query
     */
    function _getMentionContext() {
        const el = inputRef.value;
        if (!el) return null;
        const cursor = el.selectionStart;
        const before = (inputMessage.value || '').substring(0, cursor);
        const match  = before.match(/@([\w.\-/]*)$/);
        return match ? { query: match[1], start: cursor - match[0].length } : null;
    }

    function _openMentionDropdown(query) {
        mentionQuery.value  = query;
        mentionFiles.value  = _filterMentionFiles(query);
        mentionIndex.value  = 0;
        showMentionDropdown.value = true;
    }

    function _scrollMentionItem(idx) {
        // Scroll the active item inside the dropdown <ul> WITHOUT touching the page scroll.
        // scrollIntoView() moves the whole page -- we manually adjust the ul's scrollTop instead.
        // NB : depuis l'ajout des section headers (UX option 1 round 3), on ne peut plus
        // accéder aux data rows via list.children[idx] -- les <li> de header sont mélangés
        // dans children. On utilise un sélecteur data-mention-row pour ne cibler que les rows.
        nextTick(function() {
            const list = document.getElementById('mention-list');
            if (!list) return;
            const rows = list.querySelectorAll('li[data-mention-row]');
            const item = rows[idx];
            if (!item) return;
            const listTop    = list.scrollTop;
            const listBottom = listTop + list.clientHeight;
            const itemTop    = item.offsetTop;
            const itemBottom = itemTop + item.offsetHeight;
            if (itemBottom > listBottom) {
                list.scrollTop = itemBottom - list.clientHeight;
            } else if (itemTop < listTop) {
                list.scrollTop = itemTop;
            }
        });
    }

    function closeMentionDropdown() {
        showMentionDropdown.value = false;
        mentionFiles.value  = [];
        mentionQuery.value  = '';
        mentionIndex.value  = 0;
        mentionRecentCount.value = 0;
    }

    async function selectMention(file) {
        // Mémorise dans les recents AVANT de fermer la dropdown -- closeMentionDropdown
        // ne touche pas localStorage, mais avoir l'écriture en début de fonction
        // garantit que même si l'utilisateur enchaîne des sélections rapides,
        // l'ordre most-recent-first est préservé.
        if (file && file.path) _addMentionRecent(file.path);

        const ctx2 = _getMentionContext();
        const savedQuery = mentionQuery.value;   // capture before closeMentionDropdown clears it
        closeMentionDropdown();

        if (ctx2 !== null) {
            // Remove the @partial from the textarea -- the file appears as a chip below
            const before = (inputMessage.value || '').substring(0, ctx2.start);
            const after  = (inputMessage.value || '').substring(ctx2.start + 1 + savedQuery.length);
            inputMessage.value = before + after;
            nextTick(function() {
                if (inputRef.value) {
                    inputRef.value.setSelectionRange(ctx2.start, ctx2.start);
                    inputRef.value.focus();
                }
                ctx.autoResize && ctx.autoResize();
            });
        }

        // Dédup : ne pas joindre deux fois le même fichier via @mention.
        if (attachedFiles.value.some(f => f.name === file.path)) {
            return;
        }
        // Limite identique au drag & drop (_dnd.js : MAX_FILES = 10). Sans ce
        // garde, @mention contournait le plafond appliqué seulement au DnD.
        const MAX_FILES = 10;
        if (attachedFiles.value.length >= MAX_FILES) {
            showToast('Maximum ' + MAX_FILES + ' fichiers joints', 'error');
            return;
        }

        // AUDIT 2026-08-01 (M5) : jeton d'appartenance au chat courant.
        // `_resetTransientCompose` (chat/_history.js) fait
        // `attachedFiles.value = []` à chaque changement de conversation —
        // une NOUVELLE array. Si le download traîne et que l'utilisateur
        // change de chat entre-temps, le push tardif atterrissait dans le
        // composeur du chat SUIVANT : la puce y apparaissait et le contenu du
        // fichier partait au LLM dans un contexte auquel il n'appartient pas.
        // Comparer l'identité de l'array suffit à détecter le switch.
        const _ownerList = attachedFiles.value;

        try {
            const res = await fetchAuth(
                '/api/sandbox/download?path=' + encodeURIComponent(file.path),
                {}, true
            );
            if (attachedFiles.value !== _ownerList) return;   // chat changé
            if (res && res.ok) {
                const content = await res.text();
                if (attachedFiles.value !== _ownerList) return;
                // Re-vérifier après l'await : une autre sélection concurrente a pu
                // remplir la liste ou ajouter ce même path entre-temps.
                if (attachedFiles.value.some(f => f.name === file.path)) return;
                if (attachedFiles.value.length >= MAX_FILES) {
                    showToast('Maximum ' + MAX_FILES + ' fichiers joints', 'error');
                    return;
                }
                attachedFiles.value.push({ name: file.path, content, isMention: true });
            } else {
                showToast('Impossible de lire ' + file.name, 'error');
            }
        } catch (e) {
            showToast('Erreur lecture fichier', 'error');
        }
    }

    // ── Menu « / » (commandes, skills, prompts) ───────────────────
    // Sous-système extrait dans chat/_slash.js : registre de commandes,
    // arguments, niveaux de complétion, prompts sauvegardés. Monté ICI
    // plutôt que depuis app-chat.js parce que c'est ce module qui détient
    // la textarea, la cascade clavier et autoResize. Garde-fou identique
    // aux autres modules : script absent → le composeur reste utilisable,
    // seul le menu « / » manque.
    // Templates de prompt (chat/_templates.js, 2026-09-21) : cache, fenêtre
    // des variables, insertion au curseur. Monté AVANT le menu « / », qui
    // en sert la commande /template.
    const templates = (typeof setupChatTemplates === 'function')
        ? setupChatTemplates(vue, { inputRef, inputMessage }, ctx)
        : null;
    const slash = (typeof setupChatSlash === 'function')
        ? setupChatSlash(vue, { inputRef, inputMessage, isStreaming, showMentionDropdown, templates }, ctx)
        : null;

    function handleInputKeydown(e) {
        // Cascade de priorité : menu « / » d'abord (↑↓, Entrée/Tab, Échap),
        // puis @mention, puis l'envoi. Le module renvoie true quand il a
        // consommé la touche.
        if (slash && slash.slashKeydown(e)) return;
        if (showMentionDropdown.value) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                // Si on est au dernier item et qu'il y a plus à charger → charger la page suivante
                if (mentionIndex.value >= mentionFiles.value.length - 1 && mentionHasMore.value) {
                    loadMoreMentionFiles();
                }
                mentionIndex.value = Math.min(mentionIndex.value + 1, mentionFiles.value.length - 1);
                _scrollMentionItem(mentionIndex.value);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                mentionIndex.value = Math.max(mentionIndex.value - 1, 0);
                _scrollMentionItem(mentionIndex.value);
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                const chosen = mentionFiles.value[mentionIndex.value];
                if (chosen) selectMention(chosen);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeMentionDropdown();
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            // Pendant un stream, la saisie sert à PRÉPARER le prochain message
            // (style chatbot classique) : Enter insère un retour à la ligne —
            // pas d'envoi, pas de file d'attente. sendMessage garde de toute
            // façon son anti double-send, ceci évite juste d'avaler la touche.
            // EXCEPTION : une commande « / » connue s'exécute quand même —
            // sinon Entrée ne ferait RIEN, et une action silencieuse est
            // pire qu'un refus dit à voix haute (sendMessage la refusera
            // proprement si le contexte ne s'y prête pas).
            const _cmd = slash && slash.slashResolve(inputMessage.value);
            if (isStreaming && isStreaming.value && !_cmd) return;   // défaut = newline
            e.preventDefault();
            sendMessage();
        }
    }

    async function handleInputInput(e) {
        ctx.autoResize && ctx.autoResize();
        // @mention de fichier (prioritaire)
        const ctx2 = _getMentionContext();
        if (ctx2 !== null) {
            if (slash) slash.slashDismiss();
            await _loadMentionFiles();
            // (passe 3) le premier fetch de l'arbre peut être long : si le
            // ``@`` a été effacé pendant l'attente, la fermeture synchrone a
            // déjà eu lieu — ne pas ROUVRIR la liste avec la requête périmée.
            if (_getMentionContext() === null) return;
            _openMentionDropdown(ctx2.query);
            return;
        }
        if (showMentionDropdown.value) closeMentionDropdown();
        // Menu « / » : l'état est dérivé de la saisie, le module se
        // recalcule tout seul (et réarme après un Échap).
        if (slash) slash.onInput();
    }

    return {
        // Refs (lus par le template Vue pour rendre le dropdown)
        showMentionDropdown,
        mentionQuery,
        mentionFiles,
        mentionIndex,
        mentionRecentCount,
        isMentionLoading,
        mentionHasMore,
        // Handlers (template + autres parties de app-chat.js)
        loadMoreMentionFiles,
        onMentionScroll,
        closeMentionDropdown,
        selectMention,
        handleInputKeydown,
        handleInputInput,
        // Display helpers (template uses these for per-file rendering)
        mentionIconClass,
        mentionFilenameOf,
        mentionDirOf,
        // Menu « / » : refs + handlers, cf. chat/_slash.js
        ...(slash || {}),
        // Templates de prompt : fenêtre des variables, cf. chat/_templates.js
        ...(templates || {}),
    };
}

window.setupChatCompose = setupChatCompose;
