// SPDX-License-Identifier: MIT
/* ============================================================================
 * js/chat/_studio_menu.js — Annotation Studio (computer-use live view).
 *
 * Selecting "Studio" in the sidebar flips the shared currentView to 'studio';
 * includes/main/studio_page.html (refs/methods spread into the root setup()
 * return) renders a full page over the chat column, like Skills / Routines.
 *
 * It shows the latest screenshot of a desktop/VM target with the annotation
 * model's bounding boxes overlaid — updated LIVE as the chatbot's desktop_*
 * tools run (via the 'annotation_frame' SSE event bridged from app-chat.js),
 * and on demand via the "Capture & annotate" button (POST /api/desktop/capture).
 *
 * Single ingest point: applyFrame() — used by BOTH the live event and the
 * manual button — fetches the auth-gated PNG to a blob, revokes the previous
 * blob, and REPLACES studioFrame.value with a new object so the overlay
 * re-renders reliably (same blob discipline as the pw_* webshots).
 * ==========================================================================*/
function setupStudioMenu(vue, sharedRefs, ctx) {
    const { ref, computed } = vue;
    const { currentView } = sharedRefs;
    const { showToast, fetchAuth } = ctx;

    // The single source the overlay renders from. `imageUrl` is a blob URL.
    const studioFrame = ref({ imageUrl: '', boxes: [], imgW: 0, imgH: 0, target: '', ts: 0 });
    const studioTargets   = ref([]);
    const selectedTarget  = ref('');
    // Requête d'annotation tapée dans la barre du Studio. Vide = balayage
    // exhaustif (2 passes) ; rempli = le modèle annote CE QUI EST DEMANDÉ
    // (recherche ciblée, y compris des éléments absents de l'arbre a11y).
    const studioPrompt    = ref('');
    const studioLive      = ref(false);
    const studioCapturing = ref(false);
    const studioReading   = ref(false);
    const studioText      = ref(null);   // {text, region} du dernier OCR, ou null
    const studioRaw       = ref(true);   // défaut: capture BRUTE (sans modèle de vision)
    const studioError     = ref('');
    const hoveredElementId = ref(null);
    const desktopActiveTarget = ref('');    // cible active (sélecteur du panneau d'outils)

    // Réglages Studio : sélection d'écran(s) (multi-moniteur OPTIONNEL).
    const studioSettingsOpen = ref(false);
    const studioActionsOpen  = ref(false);  // menu déroulant du split-button « Capturer ▾ »
    const studioMonitors     = ref([]);     // [{index,label,width,height,left,top}]
    const studioMonitor      = ref(1);      // écran capturé (1=primaire par défaut)

    // Internal (not returned)
    let _lastBlobUrl = '';
    let _liveTimer   = null;
    let _activeLoaded = false;

    // Crash-guarded element list (only well-formed boxes reach the template).
    // Ne garde QUE les éléments réellement VISIBLES sur la capture : box bien formée
    // ET qui CHEVAUCHE le cadre de l'image [0,0,imgW,imgH]. Un élément hors cadre
    // (débordement multi-écran, popup fermé) serait dessiné hors du viewBox SVG
    // (invisible) tout en gonflant l'overlay et le compteur. imgW/imgH inconnus
    // (0) → fail-open (on garde tout). L'agent filtre déjà l'offscreen/hors-région ;
    // ceci est le miroir front (défense + alignement du compteur sur le visible).
    const studioElements = computed(() => {
        const f = studioFrame.value || {};
        const boxes = f.boxes || [];
        const W = Number(f.imgW || 0), H = Number(f.imgH || 0);
        // boxOnScreen (modèle pur, testé Node) : box bien formée ET dans le cadre.
        const onScreen = (typeof boxOnScreen === 'function')
            ? boxOnScreen
            : (box) => Array.isArray(box) && box.length === 4;
        return boxes.filter(b => b && onScreen(b.box, W, H));
    });

    function _boxArea(el) {
        const b = el && el.box;
        return (b && b.length >= 4) ? Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]) : 0;
    }
    // « Grand cadre » (fenêtre / conteneur) : couvre une large part de l'écran capturé.
    // On NE le dessine PAS en permanence et il ne capte AUCUN clic (pointer-events:none)
    // → les éléments dessous restent survolables/cliquables ; il n'apparaît qu'au SURVOL
    // (depuis l'arbre) → « responsif, pas affiché directement ».
    function isContainerBox(el) {
        const f = studioFrame.value;
        const frame = (f && f.imgW && f.imgH) ? (f.imgW * f.imgH) : 0;
        return frame ? (_boxArea(el) / frame) >= 0.5 : false;
    }
    // ── Plans (couches) : voir seulement le 1er plan, le 2e… et jusqu'à une
    // profondeur donnée dans la fenêtre. Modèle pur : elementLayers / filterByLayers
    // (_scenario_model.js). ``studioLayersOn`` vide = tous les plans.
    const studioLayersOpen = ref(false);
    const studioLayersOn   = ref({});      // { index: true } ; vide = tous
    const studioDepthMax   = ref(0);       // 0 = toutes les profondeurs
    const studioLayerInfo  = computed(() =>
        (typeof elementLayers === 'function') ? elementLayers(studioElements.value || []) : { layers: [], layerOf: {} });
    const studioLayers     = computed(() => studioLayerInfo.value.layers || []);
    const studioLayerActive = computed(() =>
        Object.keys(studioLayersOn.value).some(k => studioLayersOn.value[k]) || Number(studioDepthMax.value) > 0);
    const studioLayerFiltered = computed(() => {
        if (!studioLayerActive.value || typeof filterByLayers !== 'function') return studioElements.value || [];
        return filterByLayers(studioElements.value || [], studioLayersOn.value, studioDepthMax.value, studioLayerInfo.value.layerOf);
    });
    function toggleStudioLayers() { studioLayersOpen.value = !studioLayersOpen.value; }
    function isLayerOn(index) {
        const on = studioLayersOn.value;
        return !Object.keys(on).some(k => on[k]) || !!on[index];
    }
    function toggleLayer(index) {
        const on = Object.assign({}, studioLayersOn.value);
        const any = Object.keys(on).some(k => on[k]);
        if (!any) {                     // « tous » → tout sauf celui-ci
            (studioLayers.value || []).forEach(l => { on[l.index] = l.index !== index; });
        } else if (on[index]) delete on[index]; else on[index] = true;
        // tout coché = aucun filtre
        if ((studioLayers.value || []).every(l => on[l.index])) studioLayersOn.value = {};
        else studioLayersOn.value = on;
    }
    function soloLayer(index) { studioLayersOn.value = { [index]: true }; }
    function showAllLayers() { studioLayersOn.value = {}; studioDepthMax.value = 0; }
    function setDepthMax(n) { studioDepthMax.value = Number(n) || 0; }
    function layerLabel(l) {
        const ord = (typeof layerOrdinal === 'function') ? layerOrdinal(l.index) : (l.index + 'e plan');
        return ord + (l.label && l.label !== ord ? ' — ' + l.label : '');
    }

    // Ordre de rendu de l'overlay : grands cadres AU FOND, petits éléments DESSUS →
    // le clic/survol cible toujours l'élément le PLUS SPÉCIFIQUE (jamais le conteneur).
    // Après le filtre de plans/profondeur.
    const studioOverlayElements = computed(() =>
        (studioLayerFiltered.value || []).slice().sort((a, b) => _boxArea(b) - _boxArea(a)));

    // ── Inspecteur : l'élément LE PLUS PROFOND sous le pointeur ────────────
    // Règle unique pour le survol, le clic et le menu : parmi les boxes
    // AFFICHÉES (après plans/profondeur), la plus petite qui contient le point,
    // à surface égale la plus profonde dans l'arbre (deepestAt, modèle pur). Le
    // menu agit donc sur ce qu'on a cliqué, jamais sur un conteneur re-résolu.
    function studioHitTest(point) {
        if (typeof deepestAt !== 'function') return null;
        return deepestAt(studioOverlayElements.value || [], point);
    }
    // Nom RÉEL (jamais le rôle recopié) et libellé d'affichage.
    function elementName(el) {
        if (typeof realName === 'function') return realName(el);
        return (el && el.label) || '';
    }
    function elementDisplay(el) {
        if (!el) return '';
        const nm = elementName(el);
        if (nm) return nm;
        return '(' + (el.role || 'élément') + ' sans nom)';
    }
    // Barre d'inspection sous la scène : suit le survol, reste sur le dernier
    // élément vu (pas de clignotement quand la souris quitte une box), et
    // affiche l'élément SÉLECTIONNÉ quand il y en a un et rien de survolé.
    const studioLastHoverId = ref('');
    const studioInspectOpen = ref(false);
    const studioInspectEl = computed(() => {
        const els = studioElements.value || [];
        const hid = hoveredElementId.value || studioLastHoverId.value;
        const sel = selectedElementId.value;
        const pick = (id) => (id ? els.find(e => e && e.id === id) : null) || null;
        return pick(hoveredElementId.value) || pick(sel) || pick(hid);
    });
    const studioInspectInfo = computed(() => {
        const el = studioInspectEl.value;
        if (!el) return null;
        const els = studioElements.value || [];
        const crumbs = (typeof elementAncestors === 'function') ? elementAncestors(els, el) : [];
        const anchor = (typeof anchorFromElement === 'function') ? anchorFromElement(el, els) : {};
        const quality = (typeof anchorQuality === 'function') ? anchorQuality(anchor) : '';
        const target = (typeof targetKwargs === 'function') ? targetKwargs(anchor) : '';
        return { el, crumbs, anchor, quality, target, path: anchor.path || '' };
    });
    // Lignes de la fiche (clé → valeur), sans les vides.
    const studioInspectRows = computed(() => {
        const info = studioInspectInfo.value;
        if (!info) return [];
        const el = info.el, rows = [];
        const put = (k, v) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) rows.push({ k, v: Array.isArray(v) ? v.join(', ') : String(v) }); };
        put('rôle', el.role); put('nom', elementName(el)); put('auto_id', el.auto_id); put('classe', el.class_name);
        put('chemin', info.path); put('box', el.box); put('centre', el.center); put('états', el.states);
        put('patterns', el.patterns); put('valeur', el.value); put('profondeur', el.depth);
        put('source', el.source); put('id', el.id);
        return rows;
    });
    function qualityLabel(q) {
        return { uia: 'UIA', nom: 'nom', chemin: 'chemin', vision: 'vision', coords: 'x,y' }[q] || '—';
    }
    function qualityClass(q) {
        return { uia: 'bg-emerald-100 text-emerald-700', nom: 'bg-blue-100 text-blue-700',
                 chemin: 'bg-amber-100 text-amber-700', vision: 'bg-violet-100 text-violet-700',
                 coords: 'bg-red-100 text-red-700' }[q] || 'bg-slate-100 text-slate-500';
    }
    // ── Audit d'accessibilité : contrôles interactifs sans nom ni auto_id ──
    // C'est la liste exacte de ce que l'application devrait corriger pour être
    // automatisable proprement (modèle pur a11yAudit). Export CSV.
    const studioAuditOpen = ref(false);
    const studioAudit = computed(() =>
        (typeof a11yAudit === 'function') ? a11yAudit(studioElements.value || []) : { interactive: 0, rows: [], unnamed: 0 });
    function toggleStudioAudit() { studioAuditOpen.value = !studioAuditOpen.value; }

    // ── Arbre EN COLONNE (à côté de l'image et du code) ────────────────────
    // L'arbre n'est plus un onglet exclusif : c'est une colonne permanente entre
    // le stage et le rail → image | arbre | code visibles ensemble (env de code
    // complet). Repliable et redimensionnable ; état mémorisé par navigateur.
    const TREE_W_DEFAULT = 300, TREE_W_MIN = 220, TREE_W_MAX = 560;
    function _treeDockLoad() {
        try { const v = localStorage.getItem('studioTreeDock'); return v === null ? true : v === '1'; } catch (e) { return true; }
    }
    function _treeWidthLoad() {
        try { const v = Number(localStorage.getItem('studioTreeWidth')); return (isFinite(v) && v >= TREE_W_MIN) ? Math.min(TREE_W_MAX, v) : TREE_W_DEFAULT; } catch (e) { return TREE_W_DEFAULT; }
    }
    const studioTreeDock  = ref(_treeDockLoad());
    const studioTreeWidth = ref(_treeWidthLoad());
    function _treeDockStore() { try { localStorage.setItem('studioTreeDock', studioTreeDock.value ? '1' : '0'); } catch (e) { /* privé / plein */ } }
    function toggleStudioTreeDock() { studioTreeDock.value = !studioTreeDock.value; _treeDockStore(); }
    function openStudioTreeDock() { if (!studioTreeDock.value) { studioTreeDock.value = true; _treeDockStore(); } }
    function studioTreeDockReset() { studioTreeWidth.value = TREE_W_DEFAULT; try { localStorage.setItem('studioTreeWidth', String(TREE_W_DEFAULT)); } catch (e) { /* privé */ } }
    function studioTreeDockDragStart(ev) {
        if (!ev || ev.button) return;
        const startX = ev.clientX, startW = studioTreeWidth.value, el = ev.currentTarget;
        // poignée sur le bord GAUCHE : glisser vers la gauche élargit l'arbre (le stage rétrécit).
        const move = (e) => { studioTreeWidth.value = Math.round(Math.max(TREE_W_MIN, Math.min(TREE_W_MAX, startW + (startX - e.clientX)))); };
        const up = () => {
            el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
            try { localStorage.setItem('studioTreeWidth', String(studioTreeWidth.value)); } catch (e) { /* privé */ }
        };
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ancien navigateur */ }
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        ev.preventDefault();
    }
    function exportStudioAudit() {
        try {
            const csv = (typeof a11yAuditCsv === 'function') ? a11yAuditCsv(studioAudit.value) : '';
            const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'audit-accessibilite-' + (studioFrame.value.target || 'cible') + '.csv';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) { showToast && showToast('Export impossible', 'error'); }
    }
    async function copyStudioTarget() {
        const info = studioInspectInfo.value;
        if (!info || !info.target) return;
        try { await navigator.clipboard.writeText(info.target); showToast && showToast('Cible copiée'); }
        catch (e) { showToast && showToast('Copie impossible', 'error'); }
    }

    async function loadStudioTargets() {
        try {
            const r = await fetchAuth('/api/desktop/targets');
            if (!r.ok) { studioTargets.value = []; return; }
            const data = await r.json();
            studioTargets.value = Array.isArray(data.targets) ? data.targets : [];
        } catch (e) {
            studioTargets.value = [];
        }
        if (!selectedTarget.value && studioTargets.value.length) {
            const def = studioTargets.value.find(t => t.default) || studioTargets.value[0];
            selectedTarget.value = def ? def.name : '';
        }
    }

    // Cible ACTIVE (sélecteur du panneau d'outils) : charge targets + valeur courante.
    async function ensureDesktopTargets() {
        if (!studioTargets.value.length) await loadStudioTargets();
        if (!_activeLoaded) {
            _activeLoaded = true;
            try {
                const r = await fetchAuth('/api/desktop/active-target');
                const d = (r && r.ok) ? await r.json().catch(() => ({})) : {};
                desktopActiveTarget.value = d.target || '';
            } catch (e) { desktopActiveTarget.value = ''; }
        }
    }
    async function setDesktopActiveTarget(name) {
        desktopActiveTarget.value = name || '';
        try {
            await fetchAuth('/api/desktop/active-target', { method: 'POST', body: JSON.stringify({ target: name || '' }) });
            showToast(name ? ('Cible active : ' + name) : 'Cible : défaut');
        } catch (e) { showToast('Échec changement de cible', 'error'); }
    }

    function openStudio() {
        currentView.value = 'studio';
        loadStudioTargets();
    }

    function closeStudio() {
        currentView.value = 'chat';
        if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = null; }
        _activeLoaded = false;   // D5 — re-résout la cible active à la réouverture (sinon valeur périmée)
        // AUDIT 2026-09-01 (passe 5, F15) — la capture plein écran (blob URL)
        // n'était révoquée que par « Vider »/remplacement : quitter la page
        // (ou se déconnecter) laissait le dernier écran de la machine cible
        // vivant dans le heap. La scène est re-capturée à la réouverture.
        _frameSeq++;             // invalide une frame encore en vol
        clearStudio();           // révoque le blob + remet la scène à vide
    }

    function selectTarget(name) { selectedTarget.value = name; }
    function highlightElement(id) { hoveredElementId.value = id; if (id) studioLastHoverId.value = id; }
    function clearHighlight() { hoveredElementId.value = null; }
    // Renseigné par l'OCR de zone (clic droit → « Lire ») depuis _studio_chat.
    function setStudioText(text, region) { studioText.value = { text: text || '', region: region || '' }; }

    // « Vider » : remet la scène à zéro (image + annotations + erreur + texte).
    // Révoque le blob courant — même discipline qu'applyFrame.
    function clearStudio() {
        if (_lastBlobUrl) { try { URL.revokeObjectURL(_lastBlobUrl); } catch (e) {} _lastBlobUrl = ''; }
        studioFrame.value = { imageUrl: '', boxes: [], imgW: 0, imgH: 0, target: '', ts: 0 };
        studioError.value = '';
        studioText.value = null;
        hoveredElementId.value = null;
        studioLastHoverId.value = '';
        selectedElementId.value = '';
        studioLive.value = false;
        if (_liveTimer) { clearTimeout(_liveTimer); _liveTimer = null; }
    }

    /* Single ingest for manual + live frames. `frame` carries snake_case wire
     * fields (image_url, img_w/h, boxes, target). */
    // AUDIT 2026-09-01 (passe 5, F11) — jeton : une frame ANCIENNE résolue en
    // retard (fetch + createImageBitmap) révoquait le blob AFFICHÉ puis
    // reposait capture et boîtes périmées. Seule la DERNIÈRE demande écrit.
    let _frameSeq = 0;
    async function applyFrame(frame) {
        if (!frame) return;
        const mySeq = ++_frameSeq;
        const url = frame.image_url || frame.imageUrl || '';
        let blobUrl = '';
        let natW = 0, natH = 0;
        if (url) {
            try {
                const r = await fetchAuth(url);
                if (r.ok) {
                    const blob = await r.blob();
                    blobUrl = URL.createObjectURL(blob);
                    // Dimensions FIABLES lues sur l'image elle-même. Le backend
                    // peut renvoyer img_w/img_h = 0 (dépend du format de réponse
                    // de l'agent) ; sans dimensions justes le viewBox SVG tombe
                    // à « 0 0 1 1 » → l'image remplit le cadre (donc paraît OK)
                    // mais les <rect> d'annotation, à des coordonnées en pixels,
                    // sont projetés hors champ et deviennent invisibles. On
                    // décode donc la taille du blob ici, indépendamment du
                    // backend (createImageBitmap dispo partout ; @load reste un
                    // dernier filet via onStageImgLoad).
                    try {
                        const bmp = await createImageBitmap(blob);
                        natW = bmp.width; natH = bmp.height;
                        if (bmp.close) bmp.close();
                    } catch (e) { /* createImageBitmap indispo → onStageImgLoad */ }
                }
            } catch (e) { /* keep boxes even if the image fails */ }
        }
        if (mySeq !== _frameSeq) {
            // (F11) une frame plus récente a pris la main pendant nos await :
            // on jette NOTRE blob (jamais celui affiché) et on n'écrit rien.
            if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }
            return;
        }
        if (_lastBlobUrl) { try { URL.revokeObjectURL(_lastBlobUrl); } catch (e) {} }
        _lastBlobUrl = blobUrl;

        // Replace the whole object → reliable re-render of <image> + <rect>s.
        studioFrame.value = {
            imageUrl: blobUrl,
            boxes: Array.isArray(frame.boxes) ? frame.boxes : [],
            imgW: Number(frame.img_w || frame.imgW || 0) || natW || 0,
            imgH: Number(frame.img_h || frame.imgH || 0) || natH || 0,
            target: frame.target || selectedTarget.value || '',
            sig: frame.sig || '',          // signature dHash → effet/allers-retours (enregistrement)
            treeCapped: !!frame.tree_capped,   // l'agent a atteint son plafond de nœuds
            treeNodes: Number(frame.tree_nodes || 0),
            ts: frame.ts || Date.now(),
        };
        if (frame.target && !selectedTarget.value) selectedTarget.value = frame.target;

        // Live indicator: lit on each frame, auto-clears ~2.5s after the last.
        studioLive.value = true;
        if (_liveTimer) clearTimeout(_liveTimer);
        _liveTimer = setTimeout(() => { studioLive.value = false; }, 2500);
    }

    async function captureAndAnnotate() {
        if (studioCapturing.value) return;
        if (!selectedTarget.value) { showToast && showToast('Choisis une cible', 'error'); return; }
        studioCapturing.value = true;
        studioError.value = '';
        try {
            const r = await fetchAuth('/api/desktop/capture', {
                method: 'POST',
                body: JSON.stringify({
                    target: selectedTarget.value,
                    prompt: (studioPrompt.value || '').trim(),
                    raw: studioRaw.value,   // brut = screenshot seul, 0 box
                }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.ok === false) {
                studioError.value = data.message || data.error || 'Capture échouée';
                showToast && showToast(studioError.value, 'error');
            } else {
                await applyFrame(data);
                // Une note "annotation vision KO : …" = diagnostic d'échec de
                // la détection (endpoint/format/modèle) → warning, pas info.
                if (data.note) showToast && showToast(data.note,
                    String(data.note).startsWith('annotation vision KO') ? 'warning' : 'info');
            }
        } catch (e) {
            studioError.value = String(e && e.message || e);
            showToast && showToast('Capture échouée', 'error');
        } finally {
            studioCapturing.value = false;
        }
    }

    // ── Réglages : sélection d'écran(s) (multi-moniteur optionnel) ──────────
    async function loadMonitors() {
        if (!selectedTarget.value) { studioMonitors.value = []; return; }
        try {
            const r = await fetchAuth('/api/desktop/monitors?target=' + encodeURIComponent(selectedTarget.value), {}, true);
            const d = (r && r.ok) ? await r.json().catch(() => ({})) : {};
            studioMonitors.value = Array.isArray(d.monitors) ? d.monitors : [];
            if (typeof d.selected === 'number') studioMonitor.value = d.selected;
        } catch (e) { studioMonitors.value = []; }
    }
    function toggleStudioSettings() {
        studioSettingsOpen.value = !studioSettingsOpen.value;
        if (studioSettingsOpen.value) loadMonitors();
    }
    function toggleStudioActions() {
        studioActionsOpen.value = !studioActionsOpen.value;
    }
    // Items du menu déroulant : ferment le menu PUIS lancent l'action. Évite
    // un handler inline multi-instructions (piège des templates Vue in-DOM).
    function studioActionRead()  { studioActionsOpen.value = false; readText(); }
    function studioActionClear() { studioActionsOpen.value = false; clearStudio(); }
    async function selectMonitor(idx) {
        if (!selectedTarget.value) { showToast && showToast('Choisis une cible', 'error'); return; }
        try {
            const r = await fetchAuth('/api/desktop/select-monitor', {
                method: 'POST',
                body: JSON.stringify({ target: selectedTarget.value, monitor: idx }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || d.ok === false) { showToast && showToast(d.error || 'Sélection écran échouée', 'error'); return; }
            studioMonitor.value = (typeof d.selected === 'number') ? d.selected : idx;
            showToast && showToast('Écran sélectionné');
            if (studioFrame.value.imageUrl) captureAndAnnotate();   // refléter le nouvel écran
        } catch (e) { showToast && showToast('Sélection écran échouée', 'error'); }
    }

    // OCR : lit le texte visible de la cible (ce que l'arbre d'accessibilité
    // n'expose pas — journal, étiquettes canvas). La requête de la barre, si
    // présente, cible une zone (ex. « le journal ») ; sinon plein écran.
    async function readText() {
        if (studioReading.value) return;
        if (!selectedTarget.value) { showToast && showToast('Choisis une cible', 'error'); return; }
        studioReading.value = true;
        studioError.value = '';
        try {
            const r = await fetchAuth('/api/desktop/read', {
                method: 'POST',
                body: JSON.stringify({
                    target: selectedTarget.value,
                    query: (studioPrompt.value || '').trim(),
                }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.ok === false) {
                studioError.value = data.message || data.error || 'Lecture échouée';
                showToast && showToast(studioError.value, 'error');
            } else {
                studioText.value = { text: data.text || '(aucun texte)', region: data.region || '' };
            }
        } catch (e) {
            studioError.value = String(e && e.message || e);
            showToast && showToast('Lecture échouée', 'error');
        } finally {
            studioReading.value = false;
        }
    }

    // Backfill intrinsic size when the backend omitted img_w/h (viewBox binds it).
    function onStageImgLoad($event) {
        const img = $event && $event.target;
        if (!img) return;
        // Le cadre a sa taille définitive : c'est le moment de la relever, le zoom
        // « ajusté » en dépend.
        measureStage(img.ownerSVGElement || null);
        if (!studioFrame.value.imgW || !studioFrame.value.imgH) {
            studioFrame.value = {
                ...studioFrame.value,
                imgW: img.naturalWidth || studioFrame.value.imgW,
                imgH: img.naturalHeight || studioFrame.value.imgH,
            };
        }
    }

    function fmtConfidence(c) {
        const n = Number(c || 0);
        return n > 0 ? Math.round(n * 100) + '%' : '—';
    }
    function boxStroke(el) {
        if (el && el.id === selectedElementId.value) return '#2563eb';   // sélectionné = bleu franc
        if (el && el.id === hoveredElementId.value) return '#f59e0b';    // survol = ambre
        return '#93c5fd';                                                // défaut = bleu clair
    }

    // ── Vue de la scène : zoom, déplacement, étiquettes ─────────────────────
    // Le Studio est une CONSOLE DISTANTE : on ne s'assoit pas devant la VM, on ne
    // la voit QUE par ce cadre. Un écran 1920×1080 ramené à la largeur disponible
    // tombe à ~40 % — illisible, et les boîtes d'éléments s'y empilent en grille
    // bleue muette. D'où trois leviers : agrandir (zoom + déplacement), nommer
    // (étiquettes au repos) et alléger (feuilles seulement).
    const studioZoom    = ref('fit');              // 'fit' | échelle (1 = 100 %)
    const studioPan     = ref({ x: 0, y: 0 });     // coin haut-gauche visible, en px image
    const studioStage   = ref({ w: 0, h: 0 });     // taille du cadre à l'écran (px CSS)
    const studioDensity = ref('leaves');           // 'leaves' (défaut) | 'all'

    const ZOOM_MAX = 8;

    let _stageEl = null;

    /** Mesure le cadre. Appelé au chargement d'une frame, au redimensionnement et
     *  à chaque geste : le zoom se calcule à partir de cette taille. */
    function measureStage(el) {
        if (el) _stageEl = el;
        if (!_stageEl) return;
        const r = _stageEl.getBoundingClientRect();
        if (!r.width || !r.height) return;
        // (passe 6, F6) — ne remplace l'objet QUE si la taille a changé :
        // chaque nouvel objet invalide studioFitScale/studioScale/
        // studioViewBox et re-rend l'overlay SVG.
        const cur = studioStage.value;
        if (cur && cur.w === r.width && cur.h === r.height) return;
        studioStage.value = { w: r.width, h: r.height };
    }
    if (typeof window !== 'undefined') {
        // (passe 6, F6) — listener de module (jamais retiré) : garde de vue +
        // throttle rAF, sinon un redimensionnement de fenêtre mesurait le
        // stage ~60×/s même hors Studio.
        let _resizeQueued = false;
        window.addEventListener('resize', () => {
            if (_resizeQueued || currentView.value !== 'studio') return;
            _resizeQueued = true;
            requestAnimationFrame(() => { _resizeQueued = false; measureStage(); });
        });
    }

    /** Échelle qui fait tenir l'image entière dans le cadre — le plancher du zoom. */
    const studioFitScale = computed(() => {
        const f = studioFrame.value || {}, s = studioStage.value;
        if (!f.imgW || !f.imgH || !s.w || !s.h) return 1;
        return Math.min(s.w / f.imgW, s.h / f.imgH);
    });
    const studioScale = computed(() =>
        studioZoom.value === 'fit' ? studioFitScale.value
                                   : Math.max(studioFitScale.value, Number(studioZoom.value) || 1));

    /* ⚠ Le viewBox EST la fenêtre sur l'image. Tout ce qui convertit un clic en
     * pixels de la VM doit donc passer par la matrice du SVG (getScreenCTM), et
     * non recalculer l'échelle à la main : au moindre zoom, le calcul manuel
     * enverrait le clic ailleurs — sur un écran distant, un clic ailleurs est une
     * action ailleurs. */
    const studioViewBox = computed(() => {
        const f = studioFrame.value || {};
        const W = f.imgW || 1, H = f.imgH || 1;
        if (studioZoom.value === 'fit') return `0 0 ${W} ${H}`;
        const st = studioStage.value, sc = studioScale.value;
        const vw = Math.min(W, (st.w || W) / sc);
        const vh = Math.min(H, (st.h || H) / sc);
        const x = Math.max(0, Math.min(W - vw, studioPan.value.x));
        const y = Math.max(0, Math.min(H - vh, studioPan.value.y));
        return `${x} ${y} ${vw} ${vh}`;
    });

    function _viewRect() {
        const parts = String(studioViewBox.value).split(/\s+/).map(Number);
        return { x: parts[0] || 0, y: parts[1] || 0, w: parts[2] || 1, h: parts[3] || 1 };
    }

    /** Zoome en gardant le point visé IMMOBILE — sans ancrage, on perd ce qu'on
     *  regardait dès le premier cran de molette. */
    function setStudioZoom(next, anchor) {
        const f = studioFrame.value || {};
        const floor = studioFitScale.value;
        const target = (next === 'fit') ? 'fit'
                                        : Math.max(floor, Math.min(ZOOM_MAX, Number(next) || 1));
        if (target === 'fit') { studioZoom.value = 'fit'; studioPan.value = { x: 0, y: 0 }; return; }
        const before = _viewRect();
        const st = studioStage.value;
        const ax = anchor ? anchor[0] : before.x + before.w / 2;
        const ay = anchor ? anchor[1] : before.y + before.h / 2;
        const u = before.w ? (ax - before.x) / before.w : 0.5;
        const v = before.h ? (ay - before.y) / before.h : 0.5;
        const vw = Math.min(f.imgW || 1, (st.w || 1) / target);
        const vh = Math.min(f.imgH || 1, (st.h || 1) / target);
        studioZoom.value = target;
        studioPan.value = { x: ax - u * vw, y: ay - v * vh };
    }
    function zoomStudio(factor, anchor) {
        setStudioZoom((studioZoom.value === 'fit' ? studioFitScale.value : studioScale.value) * factor, anchor);
    }
    function panStudio(dxImage, dyImage) {
        if (studioZoom.value === 'fit') return;
        const view = _viewRect();
        studioPan.value = { x: view.x + dxImage, y: view.y + dyImage };
    }

    /** Feuilles = éléments qui n'en contiennent aucun autre. C'est ce qui casse
     *  l'empilement : un conteneur et ses vingt cellules dessinés ensemble donnent
     *  une grille illisible, alors que les vingt cellules seules se lisent. */
    const studioLeafIds = computed(() => {
        const els = (studioElements.value || []).filter(e => e && e.box);
        const leaves = new Set(els.map(e => e.id));
        for (const outer of els) {
            const [ax1, ay1, ax2, ay2] = outer.box;
            for (const inner of els) {
                if (inner === outer || !leaves.has(outer.id)) continue;
                const [bx1, by1, bx2, by2] = inner.box;
                const dedans = bx1 >= ax1 - 1 && by1 >= ay1 - 1 && bx2 <= ax2 + 1 && by2 <= ay2 + 1;
                if (dedans && _boxArea(inner) < _boxArea(outer) * 0.95) { leaves.delete(outer.id); break; }
            }
        }
        return leaves;
    });

    /** Ce que la scène dessine, après filtre de densité. */
    const studioVisibleElements = computed(() => {
        const all = studioOverlayElements.value || [];
        if (studioDensity.value === 'all') return all;
        const leaves = studioLeafIds.value;
        return all.filter(el => leaves.has(el.id));
    });

    // ── Arbre UIA : vue HIÉRARCHIQUE des éléments + sélection ────────────────
    // L'agent renvoie déjà l'arbre a11y/UIA (rôle, nom, auto_id, état, depth) ;
    // on l'affiche replié/dépliable et on choisit un élément pour agir dessus.
    const studioFilter      = ref('');     // recherche (nom/rôle/auto_id)
    const treeCollapsed     = ref({});     // { id: true } nœuds repliés
    const selectedElementId = ref('');     // élément choisi dans l'arbre

    const studioTreeRows = computed(() => {
        const els = (studioLayerFiltered && studioLayerFiltered.value) || [];   // même filtre de plans que la scène
        return (typeof elementTreeRows === 'function')
            ? elementTreeRows(els, treeCollapsed.value, studioFilter.value) : [];
    });
    const selectedElement = computed(() =>
        ((studioElements.value) || []).find(e => e && e.id === selectedElementId.value) || null);

    function toggleTreeCollapse(id) {
        const c = Object.assign({}, treeCollapsed.value);
        if (c[id]) delete c[id]; else c[id] = true;
        treeCollapsed.value = c;
    }
    function expandAllTree() { treeCollapsed.value = {}; }
    function collapseAllTree() {
        const els = (studioElements.value) || [];
        const c = {};
        for (let i = 0; i < els.length; i++) {
            const nd = Number((els[i + 1] || {}).depth);
            if (!isNaN(nd) && nd > Number(els[i].depth || 0)) c[els[i].id] = true;   // a des enfants
        }
        treeCollapsed.value = c;
    }
    // ``reveal`` (ou sélection depuis la scène) : déplie les ancêtres repliés et
    // fait défiler l'arbre jusqu'à la ligne — la scène et l'arbre restent synchro.
    const nextTick = vue.nextTick || ((fn) => setTimeout(fn, 0));
    function selectStudioElement(id, reveal) {
        if (reveal === true) selectedElementId.value = id;
        else selectedElementId.value = (selectedElementId.value === id) ? '' : id;
        if (!selectedElementId.value) return;
        revealInTree(selectedElementId.value);
    }
    function revealInTree(id) {
        openStudioTreeDock();                 // l'arbre est une colonne : la rouvrir si repliée
        const els = studioElements.value || [];
        const el = els.find(e => e && e.id === id);
        if (!el || typeof elementAncestors !== 'function') return;
        const anc = elementAncestors(els, el);
        if (anc.some(a => treeCollapsed.value[a.id])) {
            const c = Object.assign({}, treeCollapsed.value);
            anc.forEach(a => { delete c[a.id]; });
            treeCollapsed.value = c;
        }
        nextTick(() => {
            try {
                const row = (typeof document !== 'undefined') && document.querySelector('.elpis-studio-page [data-el-id="' + String(id).replace(/"/g, '') + '"]');
                if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
            } catch (e) { /* hors DOM */ }
        });
    }
    // Icône Phosphor par rôle (repère visuel dans l'arbre).
    function roleIcon(role) {
        const m = {
            window: 'ph-app-window', dialog: 'ph-app-window', frame: 'ph-app-window',
            button: 'ph-cursor-click', textbox: 'ph-text-t', edit: 'ph-text-t',
            checkbox: 'ph-check-square', radio: 'ph-circle', tab: 'ph-browser',
            menuitem: 'ph-list', menu: 'ph-list', link: 'ph-link',
            listitem: 'ph-list-bullets', list: 'ph-list-bullets', combobox: 'ph-caret-down',
            text: 'ph-text-aa', image: 'ph-image', icon: 'ph-image',
            pane: 'ph-square', group: 'ph-square', toolbar: 'ph-square', document: 'ph-square',
        };
        return m[String(role || '').toLowerCase()] || 'ph-dot-outline';
    }

    return {
        // state
        studioFrame, studioElements, studioOverlayElements, studioTargets, selectedTarget,
        studioPrompt, studioText, studioRaw,
        studioLive, studioCapturing, studioReading, studioError, hoveredElementId,
        desktopActiveTarget,
        studioSettingsOpen, studioMonitors, studioMonitor,
        toggleStudioSettings, loadMonitors, selectMonitor,
        studioActionsOpen, toggleStudioActions, studioActionRead, studioActionClear,
        // arbre UIA
        studioFilter, treeCollapsed, selectedElementId, studioTreeRows, selectedElement,
        toggleTreeCollapse, expandAllTree, collapseAllTree, selectStudioElement, revealInTree, roleIcon,
        // arbre en colonne (à côté de l'image et du code)
        studioTreeDock, studioTreeWidth, toggleStudioTreeDock, openStudioTreeDock,
        studioTreeDockReset, studioTreeDockDragStart,
        // inspecteur (élément le plus profond, chemin, cible)
        studioAuditOpen, studioAudit, toggleStudioAudit, exportStudioAudit,
        studioHitTest, elementName, elementDisplay, studioLastHoverId, studioInspectOpen,
        studioInspectEl, studioInspectInfo, studioInspectRows, qualityLabel, qualityClass, copyStudioTarget,
        // navigation
        openStudio, closeStudio,
        // actions
        loadStudioTargets, captureAndAnnotate, applyFrame, clearStudio, readText,
        ensureDesktopTargets, setDesktopActiveTarget, setStudioText,
        selectTarget, highlightElement, clearHighlight, onStageImgLoad,
        // plans (couches)
        studioLayersOpen, studioLayersOn, studioDepthMax, studioLayers, studioLayerActive, studioLayerFiltered,
        toggleStudioLayers, isLayerOn, toggleLayer, soloLayer, showAllLayers, setDepthMax, layerLabel,
        // display helpers
        fmtConfidence, boxStroke, isContainerBox,
        // vue de la scène
        studioZoom, studioPan, studioStage, studioDensity,
        studioViewBox, studioScale, studioFitScale,
        studioVisibleElements, studioLeafIds,
        measureStage, setStudioZoom, zoomStudio, panStudio,
    };
}
