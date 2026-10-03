// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_image.js -- Génération d'images : composeur, tuiles de
//  progression, résultats, visionneuse.
//
//  Un tour est un tour « image » parce que le DERNIER message
//  utilisateur porte ``image_request`` : app-chat.js en tire
//  ``image_gen`` pour le corps de la requête. Régénérer, éditer
//  puis renvoyer ou réessayer repartent donc au moteur d'images
//  sans chemin particulier.
//
//  Les messages ne portent que des références (``/api/images/<id>``,
//  URL reconstruite par le serveur depuis l'id). Une image purgée
//  par la rétention répond 404 : le cadre « Expirée » la remplace.
//  Une image supprimée ici passe par « Supprimée », annulable 5 s
//  (le DELETE ne part qu'à l'expiration du toast).
//
//  Les préférences (format, taille, nombre, enrichir) sont celles
//  du COMPTE (``image_prefs`` des réglages) : le dernier choix fait
//  dans le composeur y est écrit, Paramètres › Images les montre.
//
//  Fonctions pures (globales, testées seules)
//  ------------------------------------------
//    IMAGE_MSG_KEYS, copyImageFields, imageSizeFor, imageCellStyle,
//    imagePickFixed, normalizeImagePrefs, parseImageCommand,
//    imageFileName, imageVariantRequest, imageSizeLabel,
//    imageRequestLabel, imageProgressText, imageErrorText,
//    imageInitialProgress, isImageMessage
//
//  Composants : ImageTile (<image-tile>), ImageGrid (<image-grid>),
//  enregistrés par app.js ; gabarits #image-tile-template et
//  #image-grid-template dans index.html.
//
//  Usine : setupChatImage(vue, sharedRefs, ctx)
//    sharedRefs : settings, isStreaming, attachedFiles, currentChatId
//    ctx        : fetchAuth, showToast, focusInput, openChat
// ============================================================

// ── Champs d'image d'un message ──────────────────────────────────
// UNE liste, lue par la projection de persistance (app-chat.js), la
// réhydratation (_history.js) et l'instantané de session (app.js) :
// un champ oublié à un seul de ces trois endroits est effacé EN BASE
// au tour suivant (le blob persisté est réécrit en entier).
var IMAGE_MSG_KEYS = Object.freeze([
    'image_request',     // user : options de la demande
    'generated_images',  // assistant : références du tour « Images »
    'tool_images',       // assistant : images produites par l'outil du modèle
    'revised_prompt',    // assistant : description enrichie envoyée au moteur
    'image_meta',        // assistant : {model, duration_s}
    'image_error',       // assistant : {code, message, retryable}
]);

/** Recopie les champs d'image non vides de ``src`` dans ``dst`` (rendu). */
function copyImageFields(src, dst) {
    const out = dst || {};
    if (!src || typeof src !== 'object') return out;
    for (const k of IMAGE_MSG_KEYS) {
        const v = src[k];
        if (v === undefined || v === null || v === '' || v === false) continue;
        if (Array.isArray(v) && !v.length) continue;
        out[k] = v;
    }
    return out;
}

/** Message produit (ou en cours de production) par le moteur d'images. */
function isImageMessage(msg) {
    return !!(msg && (msg._imageTurn
        || (msg.generated_images && msg.generated_images.length)
        || (msg.image_error && msg.role === 'assistant' && !(msg.tool_images && msg.tool_images.length))));
}

// ── Formats ──────────────────────────────────────────────────────
var IMAGE_RATIOS_ALL = Object.freeze(['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21']);
// Les cinq proposés dans le composeur ; l'orientation se bascule à part.
var IMAGE_BASE_RATIOS = Object.freeze(['1:1', '4:3', '3:2', '16:9', '21:9']);
var IMAGE_RATIO_ALIASES = Object.freeze({ 'carré': '1:1', carre: '1:1', portrait: '2:3', paysage: '3:2' });

function _imgRatioParts(ratio) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(ratio || '').trim());
    if (!m || !+m[1] || !+m[2]) return null;
    return [+m[1], +m[2]];
}

function imageRatioName(ratio) {
    return ratio === '1:1' ? 'Carré' : String(ratio || '');
}

function imageIsPortrait(ratio) {
    const p = _imgRatioParts(ratio);
    return !!(p && p[1] > p[0]);
}

function imageFlipRatio(ratio) {
    const p = _imgRatioParts(ratio);
    return p ? (p[1] + ':' + p[0]) : '1:1';
}

/** Forme « paysage » d'un ratio (celle du bouton qui le représente). */
function imageBaseRatio(ratio) {
    const p = _imgRatioParts(ratio);
    if (!p) return '1:1';
    return p[0] >= p[1] ? (p[0] + ':' + p[1]) : (p[1] + ':' + p[0]);
}

/** Dimensions ``{w, h}`` d'un ratio pour un plus grand côté, au pas ``step``. */
function imageSizeFor(ratio, side, step) {
    const pas = Number(step) > 0 ? Number(step) : 64;
    const cote = Number(side) > 0 ? Number(side) : 1024;
    const p = _imgRatioParts(ratio) || [1, 1];
    const arrondi = (v) => Math.max(pas, Math.round(v / pas) * pas);
    return p[0] >= p[1]
        ? { w: arrondi(cote), h: arrondi(cote * p[1] / p[0]) }
        : { w: arrondi(cote * p[0] / p[1]), h: arrondi(cote) };
}

function _imgParseSize(size) {
    const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(size || '').trim().toLowerCase());
    return m ? { w: +m[1], h: +m[2] } : null;
}

/** Taille fixe (politique ``fixed``) la plus proche d'un ratio et d'un côté. */
function imagePickFixed(sizes, ratio, side) {
    const liste = (sizes || []).map(_imgParseSize).filter(Boolean);
    if (!liste.length) return '';
    const p = _imgRatioParts(ratio) || [1, 1];
    const cible = Math.log(p[0] / p[1]);
    const cote = Number(side) || 1024;
    let best = liste[0], score = Infinity;
    for (const s of liste) {
        const d = Math.abs(Math.log(s.w / s.h) - cible) * 10000 + Math.abs(Math.max(s.w, s.h) - cote);
        if (d < score) { score = d; best = s; }
    }
    return best.w + 'x' + best.h;
}

/** Boîte d'une image dans le fil : MÊME taille pour la tuile en cours et
 *  pour l'image finale (pas de saut de mise en page à l'arrivée). */
function imageCellStyle(w, h, n) {
    const W = Number(w) > 0 ? Number(w) : 1;
    const H = Number(h) > 0 ? Number(h) : 1;
    const boite = (Number(n) || 1) > 1 ? 208 : 360;
    const k = boite / Math.max(W, H);
    return { width: Math.round(W * k) + 'px', aspectRatio: W + ' / ' + H };
}

/** Préférences du compte ramenées à ce que le moteur permet. */
function normalizeImagePrefs(prefs, status) {
    const st = status || {};
    const p = (prefs && typeof prefs === 'object') ? prefs : {};
    const ratios = (st.ratios && st.ratios.length) ? st.ratios : IMAGE_RATIOS_ALL;
    const ratio = ratios.indexOf(p.ratio) >= 0 ? p.ratio : (ratios.indexOf('1:1') >= 0 ? '1:1' : ratios[0]);
    const maxSide = Number(st.max_side) || 2048;
    const sides = (st.sides && st.sides.length) ? st.sides.filter(s => s <= maxSide) : [];
    let side = Number(p.side) || Number(st.default_side) || 1024;
    if (sides.length && sides.indexOf(side) < 0) {
        // Côté retiré ou au-dessus du plafond : le plus proche en dessous,
        // sinon le plus petit proposé.
        const dessous = sides.filter(s => s <= side);
        side = dessous.length ? Math.max(...dessous) : Math.min(...sides);
    }
    side = Math.min(side, maxSide);
    const maxN = Math.max(1, Number(st.max_n) || 1);
    const n = Math.max(1, Math.min(parseInt(p.n, 10) || 1, maxN));
    const enhance = !!p.enhance && st.enhance_enabled !== false;
    return { ratio, side, n, enhance };
}

/** ``/image [ratio] [xN] description`` → ``{prompt, ratio, n, error}``. */
function parseImageCommand(raw, status) {
    const st = status || {};
    const ratios = (st.ratios && st.ratios.length) ? st.ratios : IMAGE_RATIOS_ALL;
    const out = { prompt: '', ratio: null, n: null, error: '' };
    let reste = String(raw || '').replace(/^\s+/, '');
    for (let k = 0; k < 2; k++) {
        let m = /^(\d{1,2}:\d{1,2}|carr[ée]|portrait|paysage)(?=\s|$)\s*/i.exec(reste);
        if (m && !out.ratio) {
            const brut = m[1].toLowerCase();
            const r = IMAGE_RATIO_ALIASES[brut] || brut;
            if (ratios.indexOf(r) < 0) { out.error = 'Format non proposé : ' + m[1]; return out; }
            out.ratio = r;
            reste = reste.slice(m[0].length);
            continue;
        }
        m = /^[x×](\d{1,2})(?=\s|$)\s*/i.exec(reste);
        if (m && out.n === null) {
            const plafond = Math.max(1, Number(st.max_n) || 8);
            out.n = Math.max(1, Math.min(parseInt(m[1], 10) || 1, plafond));
            reste = reste.slice(m[0].length);
            continue;
        }
        break;
    }
    out.prompt = reste.trim();
    return out;
}

/** Nom de fichier commun (grille, visionneuse, galerie) :
 *  ``<description>-<graine>.<ext>`` — l'id court à défaut de graine. */
function imageFileName(ref, prompt) {
    const r = ref || {};
    let base = String(prompt || '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)
        .replace(/-+$/, '');
    if (!base) base = 'image';
    const etiquette = (r.seed !== undefined && r.seed !== null && r.seed !== '')
        ? String(r.seed) : String(r.id || '').slice(0, 8);
    const mime = String(r.mime || 'image/png').toLowerCase();
    const ext = mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0 ? 'jpg'
        : (mime.indexOf('webp') >= 0 ? 'webp' : 'png');
    return base + (etiquette ? '-' + etiquette : '') + '.' + ext;
}

/** « Variantes » : même demande, graine tirée à nouveau par le moteur. */
function imageVariantRequest(req) {
    const r = Object.assign({}, req || {});
    delete r.seed;
    return r;
}

/** ``"1024x576"`` → ``"16:9 · 1024×576"`` (nom du ratio s'il est proposé). */
function imageSizeLabel(size) {
    const d = (size && typeof size === 'object') ? size : _imgParseSize(size);
    if (!d) return '';
    let nom = '';
    for (const r of IMAGE_RATIOS_ALL) {
        const p = _imgRatioParts(r);
        const v = p[0] / p[1];
        // L'arrondi au pas de 64 px déforme un peu : 5 % de tolérance.
        if (Math.abs(d.w / d.h - v) < 0.05 * v) { nom = imageRatioName(r); break; }
    }
    return (nom ? nom + ' · ' : '') + d.w + '×' + d.h;
}

/** Ligne sous la bulle utilisateur : « 16:9 · 1024×576 · ×2 · graine 42 ». */
function imageRequestLabel(req) {
    if (!req) return '';
    const parts = [];
    const sz = imageSizeLabel(req.size);
    if (sz) parts.push(sz);
    if (req.n > 1) parts.push('×' + req.n);
    if (req.seed !== undefined && req.seed !== null) parts.push('graine ' + req.seed);
    if (req.ref_image_id || req.strength !== undefined) parts.push('modification');
    if (req.enhance) parts.push('enrichie');
    return parts.join(' · ');
}

function _imgFmtSec(s) {
    const n = Math.max(0, Math.round(Number(s) || 0));
    if (n < 60) return n + ' s';
    return Math.floor(n / 60) + ' min ' + String(n % 60).padStart(2, '0') + ' s';
}

/** Libellé VISIBLE de la tuile. Jamais de pourcentage inventé : seul un
 *  avancement publié par le moteur (``pct_real``) s'affiche en %, une durée
 *  estimée porte « ≈ ». */
function imageProgressText(p, elapsed) {
    const pr = p || {};
    const ecoule = (elapsed === undefined || elapsed === null) ? (pr.elapsed_s || 0) : elapsed;
    if (pr.state === 'queued') {
        const q = Number(pr.queue_position) || 0;
        return q > 0 ? 'En file · ' + q + (q === 1 ? 're' : 'e') : 'En file';
    }
    if (pr.state === 'waiting') return 'En attente d’un créneau';
    if (pr.state === 'enhancing') return 'Description en cours';
    if (pr.pct_real && typeof pr.pct === 'number') {
        return 'Génération · ' + Math.max(0, Math.min(100, Math.round(pr.pct))) + ' %';
    }
    const eta = Number(pr.eta_s) || 0;
    return 'Génération · ' + _imgFmtSec(ecoule) + (eta > 0 ? ' / ≈' + _imgFmtSec(eta) : '');
}

var IMAGE_ERROR_TEXTS = Object.freeze({
    unavailable: 'Moteur d’images indisponible',
    forbidden: 'Images non autorisées pour ce compte',
    invalid: 'Demande invalide',
    timeout: 'Délai dépassé',
    busy: 'Moteur occupé',
    refused: 'Demande refusée par le moteur',
    engine: 'Erreur du moteur d’images',
    cancelled: 'Génération interrompue',
    too_large: 'Image trop lourde',
});

function imageErrorText(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (typeof err !== 'object') return IMAGE_ERROR_TEXTS.engine;
    return String(err.message || IMAGE_ERROR_TEXTS[err.code] || IMAGE_ERROR_TEXTS.engine);
}

/** Tuile affichée dès l'envoi, au format demandé (avant le premier événement). */
function imageInitialProgress(req) {
    const d = _imgParseSize(req && req.size) || { w: 1024, h: 1024 };
    return { state: 'queued', queue_position: null, elapsed_s: 0, eta_s: null,
             pct: null, pct_real: false, width: d.w, height: d.h,
             n: Math.max(1, Number(req && req.n) || 1) };
}

// ── État partagé avec les composants ─────────────────────────────
// Posé par setupChatImage : les composants lisent l'état des images
// (expirée, supprimée) et appellent les actions sans dépendre du parent.
var _imageApi = null;

const ImageTile = {
    template: '#image-tile-template',
    props: {
        progress: { type: Object, default: null },
        dims: { type: Object, default: null },    // {w, h, n} sans progression (erreur rechargée)
        error: { type: [Object, String, Boolean], default: null },
        stoppable: { type: Boolean, default: false },
    },
    emits: ['stop', 'retry'],
    setup(props) {
        const { ref, computed, watch, onBeforeUnmount } = Vue;
        // Temps écoulé : relevé du serveur aux changements d'état, avancé
        // ici à la seconde — un événement par seconde rejoué par le journal
        // du run n'apprendrait rien de plus.
        const now = ref(Date.now());
        let base = { at: Date.now(), s: 0 };
        let horloge = null;
        function arreter() { if (horloge) { clearInterval(horloge); horloge = null; } }
        watch(() => [props.progress ? props.progress.elapsed_s : null, !!props.progress && !props.error],
            ([s, actif]) => {
                base = { at: Date.now(), s: Number(s) || 0 };
                now.value = Date.now();
                if (actif && !horloge) horloge = setInterval(() => { now.value = Date.now(); }, 1000);
                if (!actif) arreter();
            }, { immediate: true });
        onBeforeUnmount(arreter);
        const ecoule = computed(() => base.s + Math.max(0, Math.round((now.value - base.at) / 1000)));
        const taille = computed(() => {
            const p = props.progress || {}, d = props.dims || {};
            return { w: p.width || d.w || 1024, h: p.height || d.h || 1024,
                     n: props.error ? 1 : Math.max(1, Math.min(4, p.n || d.n || 1)) };
        });
        return {
            cells: computed(() => Array.from({ length: taille.value.n }, (_, i) => i)),
            // Erreur : boîte réduite (celle d'une image d'un lot) — un échec
            // n'a pas à occuper la place d'une image réussie.
            cellStyle: computed(() => imageCellStyle(taille.value.w, taille.value.h, props.error ? 2 : taille.value.n)),
            label: computed(() => imageProgressText(props.progress || {}, ecoule.value)),
            // Région annoncée : l'état seul, sans la seconde qui défile.
            stateLabel: computed(() => imageProgressText(Object.assign({}, props.progress || {}, { eta_s: 0 }), 0)
                .replace(/ · 0 s$/, '')),
            queued: computed(() => ['queued', 'waiting', 'enhancing'].indexOf((props.progress || {}).state) >= 0),
            preview: computed(() => {
                const p = (props.progress || {}).preview;
                return (typeof p === 'string' && p.indexOf('data:image/') === 0) ? p : '';
            }),
            pct: computed(() => {
                const p = props.progress || {};
                return (p.pct_real && typeof p.pct === 'number') ? Math.max(0, Math.min(100, p.pct)) : null;
            }),
            errorText: computed(() => imageErrorText(props.error)),
            retryable: computed(() => !(props.error && typeof props.error === 'object' && props.error.retryable === false)),
        };
    },
};

const ImageGrid = {
    template: '#image-grid-template',
    props: {
        items: { type: Array, default: () => [] },
        prompt: { type: String, default: '' },     // description de l'utilisateur
        revised: { type: String, default: '' },    // description enrichie, si elle existe
        meta: { type: Object, default: null },     // {model, duration_s}
        tool: { type: Boolean, default: false },   // images de l'outil du modèle
        reveal: { type: Boolean, default: false }, // apparition animée (dernier tour)
        variants: { type: Boolean, default: false },
    },
    emits: ['variants'],
    setup(props) {
        const { computed } = Vue;
        const etat = () => (_imageApi ? _imageApi.state : {});
        const cells = computed(() => {
            const liste = props.items || [];
            return liste.map((ref, i) => ({
                ref, i,
                st: etat()[ref.id] || '',
                style: imageCellStyle(ref.width, ref.height, liste.length),
                src: ref.thumb_url || ref.url,
            }));
        });
        const texte = computed(() => props.revised || props.prompt || '');
        const metaText = computed(() => {
            const liste = props.items || [];
            const m = props.meta || {};
            const premier = liste[0] || {};
            const parts = [];
            if (m.model) parts.push(m.model);
            if (premier.width && premier.height) parts.push(imageSizeLabel({ w: premier.width, h: premier.height }));
            if (Number(m.duration_s) > 0) parts.push(_imgFmtSec(m.duration_s));
            if (liste.length === 1 && premier.seed !== undefined && premier.seed !== null) parts.push('graine ' + premier.seed);
            return parts.join(' · ');
        });
        return {
            cells, metaText, texte,
            canEdit: computed(() => !!(_imageApi && _imageApi.canEdit.value)),
            altText: computed(() => (texte.value || 'Image générée').slice(0, 300)),
            open(i) { if (_imageApi) _imageApi.openViewer(props.items, i, { prompt: props.prompt, revised: props.revised, meta: props.meta }); },
            edit(ref) { if (_imageApi) _imageApi.edit(ref); },
            download(ref) { if (_imageApi) _imageApi.download(ref, texte.value); },
            remove(ref) { if (_imageApi) _imageApi.remove(ref); },
            expired(ref) { if (_imageApi) _imageApi.markExpired(ref.id); },
            copy() { if (_imageApi) _imageApi.copyText(texte.value); },
        };
    },
};

function setupChatImage(vue, sharedRefs, ctx) {
    const { ref, reactive, computed, watch, nextTick } = vue;
    const { settings, isStreaming, attachedFiles, currentChatId } = sharedRefs;
    const { fetchAuth, showToast } = ctx;

    const imageMode   = ref(false);
    const imageStatus = ref(null);   // GET /api/image/status
    const imagePop    = ref('');     // '' | 'ratio' | 'more' : popover ouvert du composeur
    const imageOpts   = reactive({
        ratio: '1:1', side: 1024, n: 1, enhance: false,
        fixed: '',                                 // politique « fixed » : taille choisie
        custom: false, cw: 1024, ch: 1024,         // dimensions libres
        seed: '', negative_prompt: '', steps: '', strength: 0.75,
    });
    // Image générée à MODIFIER (« Modifier ») : {id, url, thumb_url} ou null.
    const imageEditRef = ref(null);
    const imageViewer  = ref(null);  // {items, idx, prompt, revised, meta}
    // Par id : 'expired' (404), 'pending' (suppression annulable), 'deleted'.
    const state = reactive({});

    // Disponibilité EN DIRECT : décocher « Images » dans les Paramètres
    // retire l'entrée sans recharger. ``image_ready`` est calculé par le
    // serveur pour CE compte (moteur prêt et groupes autorisés).
    const imageAvailable = computed(() => {
        const s = settings.value || {};
        return !!s.image_ready && s.image_enabled !== false;
    });
    const imageSeedSet = computed(() => {
        const v = parseInt(String(imageOpts.seed).trim(), 10);
        return Number.isFinite(v) && v >= 0;
    });

    // ── Statut et préférences ────────────────────────────────────
    let _statusAt = 0;
    let _prefsAppliquees = false;
    async function loadImageStatus(force) {
        if (!force && imageStatus.value && Date.now() - _statusAt < 30000) return imageStatus.value;
        try {
            const r = await fetchAuth('/api/image/status', {}, true);
            if (r && r.ok) {
                imageStatus.value = await r.json();
                _statusAt = Date.now();
                if (!_prefsAppliquees) {
                    _appliquerPrefs((imageStatus.value && imageStatus.value.prefs) || (settings.value || {}).image_prefs);
                    _prefsAppliquees = true;
                }
            }
        } catch (_) { /* statut absent : valeurs par défaut */ }
        return imageStatus.value;
    }

    function _appliquerPrefs(p) {
        const n = normalizeImagePrefs(p, imageStatus.value);
        imageOpts.ratio = n.ratio;
        imageOpts.side = n.side;
        imageOpts.n = n.n;
        imageOpts.enhance = n.enhance;
        const st = imageStatus.value || {};
        if (st.size_policy === 'fixed') imageOpts.fixed = imagePickFixed(st.sizes, n.ratio, n.side);
    }

    function _prefsCourantes() {
        return { ratio: imageOpts.ratio, side: imageOpts.side, n: imageOpts.n, enhance: !!imageOpts.enhance };
    }

    // Le choix fait dans le composeur devient la préférence du compte.
    // Écriture CIBLÉE (le serveur fusionne) : le formulaire des Paramètres
    // n'est pas enregistré en douce.
    let _prefsTimer = null;
    function _sauverPrefs() {
        const p = _prefsCourantes();
        if (settings.value) settings.value.image_prefs = p;
        if (_prefsTimer) clearTimeout(_prefsTimer);
        _prefsTimer = setTimeout(async () => {
            _prefsTimer = null;
            try {
                await fetchAuth('/api/settings', {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image_prefs: p }),
                }, true);
            } catch (_) { /* best-effort : le choix vaut pour la session */ }
        }, 600);
    }

    // Paramètres › Images enregistrés : le composeur suit.
    watch(() => JSON.stringify((settings.value || {}).image_prefs || null), (v, avant) => {
        if (v === avant || v === 'null') return;
        const p = (settings.value || {}).image_prefs;
        if (JSON.stringify(_prefsCourantes()) === JSON.stringify(normalizeImagePrefs(p, imageStatus.value))) return;
        _appliquerPrefs(p);
    });
    // Moteur connecté ou retiré, case cochée ou décochée : statut relu.
    watch(() => [!!(settings.value || {}).image_ready, (settings.value || {}).image_enabled !== false],
        ([pret, coche]) => {
            if (pret && coche) loadImageStatus(true);
            else if (imageMode.value) closeImageMode();
        });

    // ── Format ───────────────────────────────────────────────────
    const imageBaseRatios = computed(() => {
        const st = imageStatus.value || {};
        const permis = (st.ratios && st.ratios.length) ? st.ratios : IMAGE_RATIOS_ALL;
        return IMAGE_BASE_RATIOS.filter(r => permis.indexOf(r) >= 0 || permis.indexOf(imageFlipRatio(r)) >= 0);
    });
    const imageSides = computed(() => {
        const st = imageStatus.value || {};
        const max = Number(st.max_side) || 2048;
        return (st.sides || []).filter(s => s <= max);
    });
    const imageMaxN = computed(() => Math.max(1, Number((imageStatus.value || {}).max_n) || 1));
    const imageFeatures = computed(() => (imageStatus.value || {}).features || {});
    const imageFixedSizes = computed(() => {
        const st = imageStatus.value || {};
        return st.size_policy === 'fixed' ? (st.sizes || []) : [];
    });

    function _pas() { return Number((imageStatus.value || {}).step) || 64; }
    function _maxSide() { return Number((imageStatus.value || {}).max_side) || 2048; }

    /** Dimensions de la prochaine demande. */
    function imageSize(over) {
        const o = over || {};
        if (imageFixedSizes.value.length) {
            const choix = (o.ratio ? imagePickFixed(imageFixedSizes.value, o.ratio, imageOpts.side) : '')
                || imageOpts.fixed || imagePickFixed(imageFixedSizes.value, imageOpts.ratio, imageOpts.side);
            return _imgParseSize(choix) || { w: 1024, h: 1024 };
        }
        if (imageOpts.custom && !o.ratio) {
            const pas = _pas(), mx = _maxSide();
            const arr = (v) => Math.min(mx, Math.max(pas, Math.round((Number(v) || 1024) / pas) * pas));
            return { w: arr(imageOpts.cw), h: arr(imageOpts.ch) };
        }
        return imageSizeFor(o.ratio || imageOpts.ratio, Math.min(imageOpts.side, _maxSide()), _pas());
    }

    /** Vignette CSS d'un ratio (boîte ≤ 14 px). */
    function ratioBox(ratio) {
        const p = _imgRatioParts(ratio) || [1, 1];
        const k = 14 / Math.max(p[0], p[1]);
        return { width: Math.max(5, Math.round(p[0] * k)) + 'px', height: Math.max(5, Math.round(p[1] * k)) + 'px' };
    }

    function imageFormatLabel() {
        if (imageFixedSizes.value.length) {
            const d = imageSize();
            return d.w + '×' + d.h;
        }
        if (imageOpts.custom) return 'Libre';
        return imageRatioName(imageOpts.ratio);
    }

    function setImageRatio(r) {
        const base = imageBaseRatio(r);
        // L'orientation choisie se garde d'un format à l'autre.
        imageOpts.ratio = (imageIsPortrait(imageOpts.ratio) && base !== '1:1') ? imageFlipRatio(base) : base;
        imageOpts.custom = false;
        if (imageFixedSizes.value.length) imageOpts.fixed = imagePickFixed(imageFixedSizes.value, imageOpts.ratio, imageOpts.side);
        imagePop.value = '';
        _sauverPrefs();
    }
    function flipImageRatio() {
        if (imageOpts.custom) {
            const w = imageOpts.cw; imageOpts.cw = imageOpts.ch; imageOpts.ch = w;
            return;
        }
        if (imageOpts.ratio === '1:1') return;
        imageOpts.ratio = imageFlipRatio(imageOpts.ratio);
        if (imageFixedSizes.value.length) imageOpts.fixed = imagePickFixed(imageFixedSizes.value, imageOpts.ratio, imageOpts.side);
        _sauverPrefs();
    }
    function setImageSide(v) {
        const n = parseInt(v, 10);
        if (!n) return;
        imageOpts.side = n;
        _sauverPrefs();
    }
    function setImageFixed(size) {
        const d = _imgParseSize(size);
        if (!d) return;
        imageOpts.fixed = d.w + 'x' + d.h;
        // La préférence garde un ratio et un côté : retrouvés depuis la taille.
        let best = imageOpts.ratio, ecart = Infinity;
        for (const r of IMAGE_RATIOS_ALL) {
            const p = _imgRatioParts(r);
            const e = Math.abs(Math.log((d.w / d.h) / (p[0] / p[1])));
            if (e < ecart) { ecart = e; best = r; }
        }
        imageOpts.ratio = best;
        imageOpts.side = Math.max(d.w, d.h);
        _sauverPrefs();
    }
    function setImageN(v) {
        imageOpts.n = Math.max(1, Math.min(parseInt(v, 10) || 1, imageMaxN.value));
        _sauverPrefs();
    }
    function toggleImageEnhance() {
        imageOpts.enhance = !imageOpts.enhance;
        _sauverPrefs();
    }
    function setImageCustom(on) {
        if (on && !imageOpts.custom) {
            const d = imageSize();
            imageOpts.cw = d.w; imageOpts.ch = d.h;
        }
        imageOpts.custom = !!on;
    }
    function clearImageSeed() { imageOpts.seed = ''; }

    // Paramètres › Images : le formulaire édite ``settings.image_prefs``,
    // enregistré avec le reste des Paramètres.
    function _prefsForm() {
        const s = settings.value || {};
        if (!s.image_prefs || typeof s.image_prefs !== 'object') s.image_prefs = _prefsCourantes();
        return s.image_prefs;
    }
    function setPrefRatio(r) {
        const p = _prefsForm();
        const base = imageBaseRatio(r);
        p.ratio = (imageIsPortrait(p.ratio) && base !== '1:1') ? imageFlipRatio(base) : base;
    }
    function flipPrefRatio() {
        const p = _prefsForm();
        if (p.ratio && p.ratio !== '1:1') p.ratio = imageFlipRatio(p.ratio);
    }
    function toggleImagePop(nom) { imagePop.value = (imagePop.value === nom) ? '' : nom; }

    // ── Mode ─────────────────────────────────────────────────────
    async function toggleImageMode(on) {
        const suivant = (on === undefined) ? !imageMode.value : !!on;
        if (suivant) {
            const st = await loadImageStatus();
            if (!st || !st.available) {
                showToast((st && st.ready) ? 'Images désactivées dans vos Paramètres.'
                                           : 'Aucun moteur d’images disponible.', 'info');
                imageMode.value = false;
                return false;
            }
            if (imageOpts.n > imageMaxN.value) imageOpts.n = imageMaxN.value;
        } else {
            imageEditRef.value = null;
        }
        imageMode.value = suivant;
        imagePop.value = '';
        if (suivant && ctx.focusInput) ctx.focusInput();
        return suivant;
    }

    function closeImageMode() {
        imageMode.value = false;
        imagePop.value = '';
        imageEditRef.value = null;
    }

    /** Échap : ferme le popover ouvert, sinon quitte le mode quand le champ
     *  de saisie est vide et a le focus. Rend true si la touche est prise. */
    function imageEscape(champVide, focusSaisie) {
        if (imagePop.value) { imagePop.value = ''; return true; }
        if (imageMode.value && champVide && focusSaisie) { closeImageMode(); return true; }
        return false;
    }

    // En mode Images, une pièce jointe ne sert qu'à désigner l'image à
    // modifier : une seule, et une image. Le refus se fait À L'AJOUT.
    if (attachedFiles) {
        watch(() => attachedFiles.value.length, (n, avant) => {
            if (!imageMode.value || !(n > (avant || 0))) return;
            const liste = attachedFiles.value;
            const images = liste.filter(f => f && f.isImage);
            if (images.length !== liste.length || images.length > 1) {
                attachedFiles.value = images.length ? [images[images.length - 1]] : [];
                showToast('Mode Images : une seule image jointe, celle à modifier.', 'info');
            }
            if (attachedFiles.value.length) imageEditRef.value = null;
        });
    }

    /** « Modifier » une image générée : mode Images, image désignée. */
    async function editGeneratedImage(r) {
        if (!r || !r.id) return;
        if (!imageMode.value && !(await toggleImageMode(true))) return;
        if (attachedFiles && attachedFiles.value.length) attachedFiles.value = [];
        imageEditRef.value = { id: r.id, url: r.url || ('/api/images/' + r.id), thumb_url: r.thumb_url || '' };
        if (ctx.focusInput) ctx.focusInput();
    }
    function clearImageEditRef() { imageEditRef.value = null; }

    /** Options du message à envoyer (``image_request``). ``over`` : ratio et
     *  nombre propres à CETTE demande (commande /image), sans toucher aux
     *  préférences. */
    function buildImageRequest(withSource, over) {
        const o = over || {};
        const st = imageStatus.value || {};
        const f = st.features || {};
        const req = { n: Math.max(1, Math.min(parseInt(o.n || imageOpts.n, 10) || 1, imageMaxN.value)) };
        const d = imageSize(o);
        req.size = d.w + 'x' + d.h;
        if (!imageFixedSizes.value.length && (o.ratio || !imageOpts.custom)) {
            req.ratio = o.ratio || imageOpts.ratio;
            req.side = Math.max(d.w, d.h);
        }
        if (imageOpts.enhance && st.enhance_enabled !== false) req.enhance = true;
        if (imageEditRef.value) req.ref_image_id = imageEditRef.value.id;
        if (f.strength && (imageEditRef.value || withSource)) {
            const v = Number(imageOpts.strength);
            if (v >= 0.05 && v <= 1) req.strength = Math.round(v * 100) / 100;
        }
        if (f.seed && imageSeedSet.value) req.seed = parseInt(String(imageOpts.seed).trim(), 10);
        if (f.steps) {
            const s = parseInt(String(imageOpts.steps).trim(), 10);
            if (Number.isFinite(s) && s > 0) req.steps = s;
        }
        if (f.negative) {
            const neg = String(imageOpts.negative_prompt || '').trim();
            if (neg) req.negative_prompt = neg;
        }
        return req;
    }

    /** ``{w, h, n}`` d'une demande (tuile d'erreur après rechargement). */
    function imageReqDims(req) {
        const d = _imgParseSize(req && req.size) || { w: 1024, h: 1024 };
        return { w: d.w, h: d.h, n: Math.max(1, Number(req && req.n) || 1) };
    }

    // ── Actions sur une image ────────────────────────────────────
    /** État d'une image affichée hors composant (galerie). */
    function imageCellState(id) { return state[id] || ''; }

    function markImageExpired(id) {
        if (!id || state[id]) return;
        state[id] = 'expired';
    }

    function downloadImage(r, prompt) {
        if (!r || !r.url || state[r.id]) return;
        const a = document.createElement('a');
        a.href = r.url;
        a.download = imageFileName(r, prompt);
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    /** Suppression annulable : l'image disparaît tout de suite, le DELETE
     *  ne part qu'à l'expiration du toast (5 s) — « Annuler » la rend. */
    function removeImage(r) {
        if (!r || !r.id || state[r.id]) return;
        const id = r.id;
        state[id] = 'pending';
        if (imageViewer.value) _viewerApresRetrait(id);
        showToast('Image supprimée.', 'info', {
            duration: 5000,
            actionLabel: 'Annuler',
            onAction: () => { if (state[id] === 'pending') delete state[id]; },
            onExpire: async () => {
                if (state[id] !== 'pending') return;
                try {
                    const res = await fetchAuth('/api/images/' + encodeURIComponent(id), { method: 'DELETE' }, true);
                    if (res && !res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
                    if (!res) throw new Error('réseau');
                    state[id] = 'deleted';
                } catch (_) {
                    delete state[id];
                    showToast('Suppression impossible.', 'error');
                }
            },
        });
    }

    async function copyImageText(texte) {
        const t = String(texte || '').trim();
        if (!t) return;
        try {
            await navigator.clipboard.writeText(t);
            showToast('Description copiée.');
        } catch (_) {
            showToast('Copie impossible.', 'error');
        }
    }

    // ── Visionneuse ──────────────────────────────────────────────
    // Élément qui avait le focus à l'ouverture : il le retrouve à la fermeture.
    let _viewerRetour = null;
    function openImageViewer(items, idx, info) {
        const liste = (items || []).filter(r => r && r.id && !state[r.id]);
        if (!liste.length) return;
        const i = Math.max(0, Math.min(Number(idx) || 0, liste.length - 1));
        const inf = info || {};
        _viewerRetour = document.activeElement || null;
        imageViewer.value = { items: liste, idx: i, prompt: inf.prompt || '', revised: inf.revised || '',
                              meta: inf.meta || null };
        // Le focus entre dans la fenêtre : ← → et Tab y agissent aussitôt.
        nextTick(() => {
            const el = document.querySelector('[data-image-viewer]');
            if (el && el.focus) el.focus();
        });
    }
    function closeImageViewer() {
        imageViewer.value = null;
        const el = _viewerRetour;
        _viewerRetour = null;
        try { if (el && el.focus) el.focus(); } catch (_) {}
    }
    function imageViewerStep(delta) {
        const v = imageViewer.value;
        if (!v || v.items.length < 2) return;
        const n = v.items.length;
        imageViewer.value = Object.assign({}, v, { idx: (v.idx + delta + n) % n });
    }
    function _viewerApresRetrait(id) {
        const v = imageViewer.value;
        const restes = v.items.filter(r => r.id !== id && !state[r.id]);
        if (!restes.length) { closeImageViewer(); return; }
        imageViewer.value = Object.assign({}, v, { items: restes, idx: Math.min(v.idx, restes.length - 1) });
    }
    const imageViewerCurrent = computed(() => {
        const v = imageViewer.value;
        return v ? v.items[v.idx] : null;
    });
    // Description de l'image affichée : la sienne (galerie), sinon celle du
    // résultat ouvert.
    const imageViewerPrompt = computed(() => {
        const v = imageViewer.value, r = imageViewerCurrent.value;
        if (!v || !r) return '';
        return r.prompt || v.revised || v.prompt || '';
    });
    const imageViewerInfo = computed(() => {
        const v = imageViewer.value, r = imageViewerCurrent.value;
        if (!v || !r) return '';
        const m = v.meta || {};
        const parts = [];
        if (r.model || m.model) parts.push(r.model || m.model);
        if (r.width && r.height) parts.push(imageSizeLabel({ w: r.width, h: r.height }));
        if (r.seed !== undefined && r.seed !== null) parts.push('graine ' + r.seed);
        if (Number(m.duration_s) > 0) parts.push(_imgFmtSec(m.duration_s));
        return parts.join(' · ');
    });
    function imageViewerKeydown(e) {
        if (!imageViewer.value) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); imageViewerStep(-1); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); imageViewerStep(1); return; }
        if (e.key !== 'Tab') return;
        // Focus gardé dans la fenêtre : Tab boucle sur ses boutons.
        const racine = e.currentTarget;
        const liste = racine ? Array.from(racine.querySelectorAll('button:not([disabled])')) : [];
        if (!liste.length) return;
        const i = liste.indexOf(document.activeElement);
        let suivant = e.shiftKey ? i - 1 : i + 1;
        if (i < 0) suivant = e.shiftKey ? liste.length - 1 : 0;
        if (suivant < 0) suivant = liste.length - 1;
        if (suivant >= liste.length) suivant = 0;
        e.preventDefault();
        liste[suivant].focus();
    }

    // ── Galerie personnelle ──────────────────────────────────────
    // Toutes les images du compte (ou de la conversation ouverte), les plus
    // récentes d'abord, par pages au défilement.
    const GALERIE_PAGE = 48;
    const imageGallery = ref(null);  // {filter, items, next, total, keep, loading, done, error}
    let _galerieSeq = 0;
    let _galerieRetour = null;
    async function loadMoreGallery() {
        const g = imageGallery.value;
        if (!g || g.loading || g.done) return;
        const seq = _galerieSeq;
        imageGallery.value = Object.assign({}, g, { loading: true, error: '' });
        const qs = new URLSearchParams({ limit: String(GALERIE_PAGE) });
        if (g.next !== null && g.next !== undefined) qs.set('before', String(g.next));
        if (g.filter === 'chat' && currentChatId && currentChatId.value) qs.set('chat_id', String(currentChatId.value));
        let res = null, err = '';
        try {
            const r = await fetchAuth('/api/images?' + qs.toString(), {}, true);
            if (r && r.ok) res = await r.json();
            else err = 'Galerie indisponible.';
        } catch (_) { err = 'Galerie indisponible.'; }
        if (seq !== _galerieSeq || !imageGallery.value) return;   // filtre changé ou fenêtre fermée
        const cur = imageGallery.value;
        if (!res) { imageGallery.value = Object.assign({}, cur, { loading: false, error: err }); return; }
        const items = cur.items.concat((res.items || []).filter(it => it && it.id));
        const next = (res.next_before === null || res.next_before === undefined) ? null : res.next_before;
        imageGallery.value = Object.assign({}, cur, {
            items, next, done: next === null, loading: false,
            total: Number(res.total) || items.length, keep: Number(res.keep) || 0,
        });
    }
    async function openImageGallery(filtre) {
        _galerieSeq++;
        if (!imageGallery.value) _galerieRetour = document.activeElement || null;
        imageGallery.value = { filter: filtre === 'chat' ? 'chat' : 'all', items: [], next: null,
                               total: 0, keep: 0, loading: false, done: false, error: '' };
        nextTick(() => {
            const el = document.querySelector('[data-image-gallery]');
            if (el && el.focus) el.focus();
        });
        await loadMoreGallery();
    }
    function setGalleryFilter(filtre) {
        const g = imageGallery.value;
        if (!g || g.filter === filtre) return;
        if (filtre === 'chat' && !(currentChatId && currentChatId.value)) return;
        openImageGallery(filtre);
    }
    function closeImageGallery() {
        _galerieSeq++;
        imageGallery.value = null;
        const el = _galerieRetour;
        _galerieRetour = null;
        try { if (el && el.focus) el.focus(); } catch (_) {}
    }
    function onGalleryScroll(e) {
        const el = e && e.target;
        if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 240) loadMoreGallery();
    }
    function openGalleryItem(i) {
        const g = imageGallery.value;
        if (g) openImageViewer(g.items, i, {});
    }
    /** Conversation d'une image de la galerie. */
    function openImageChat(chatId) {
        if (!chatId) return;
        imageViewer.value = null;
        closeImageGallery();
        if (ctx.openChat) ctx.openChat(chatId);
    }

    const canEdit = computed(() => imageAvailable.value && !(isStreaming && isStreaming.value));
    _imageApi = {
        state,
        canEdit,
        openViewer: openImageViewer,
        edit: editGeneratedImage,
        download: downloadImage,
        remove: removeImage,
        markExpired: markImageExpired,
        copyText: copyImageText,
    };

    return {
        imageMode, imageStatus, imagePop, imageOpts, imageEditRef, imageAvailable, imageSeedSet,
        imageBaseRatios, imageSides, imageMaxN, imageFeatures, imageFixedSizes,
        loadImageStatus, toggleImageMode, closeImageMode, imageEscape, toggleImagePop,
        imageSize, ratioBox, imageFormatLabel, imageIsPortrait, imageBaseRatio, imageFlipRatio,
        setImageRatio, flipImageRatio, setImageSide, setImageFixed, setImageN,
        toggleImageEnhance, setImageCustom, clearImageSeed, setPrefRatio, flipPrefRatio,
        editGeneratedImage, clearImageEditRef, buildImageRequest, imageReqDims,
        imageRequestLabel, imageSizeLabel, isImageMessage, imageInitialProgress,
        markImageExpired, imageCellState, downloadImage, removeImage, copyImageText,
        imageViewer, imageViewerCurrent, imageViewerInfo, imageViewerPrompt,
        imageGallery, openImageGallery, loadMoreGallery, setGalleryFilter, closeImageGallery,
        onGalleryScroll, openGalleryItem, openImageChat,
        openImageViewer, closeImageViewer, imageViewerStep, imageViewerKeydown,
        imageCanEdit: canEdit,
    };
}

window.setupChatImage = setupChatImage;
