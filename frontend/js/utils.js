// SPDX-License-Identifier: MIT
/**
 * static/js/utils.js
 *
 * App-wide helpers loaded before every other client script:
 *   - getFileMeta(filename)        icon/color/lang for a path
 *   - escapeHtml(s)                HTML entity-encode a string
 *   - sanitizeHtml(html)           sanitize a marked-rendered fragment
 *                                  via DOMPurify when present, falling
 *                                  back to a DOMParser-based scrubber
 *                                  that removes <script>/<style>/<iframe>
 *                                  /<object>/<embed>/<link>/<meta>/<base>
 *                                  /<form> and all on* / javascript: attrs ;
 *                                  both paths then neutralize REMOTE media
 *                                  (external <img> → click-through link,
 *                                  video/audio src, inline style url()) to
 *                                  close the image-exfiltration channel
 *   - setupMarked()                wires hljs into marked and registers
 *                                  a `postprocess` hook so EVERY call to
 *                                  marked.parse() returns sanitized HTML
 *   - TreeItem, AxNode             two recursive Vue components used
 *                                  by the file explorer and the AX tree
 *
 * Globals exposed: window.elpisEscape, window.elpisSanitize, TreeItem, AxNode.
 */

function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function(c) {
        return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
}
window.elpisEscape = escapeHtml;

// Chemin de fichier plausible (message du chat, sortie du terminal) :
// « src/app.py », « ./a/b.js:12 », « /work/x/y.md:3:7 », « main.py ».
// Sans barre oblique, l'extension doit être CONNUE (« os.path » ou
// « v1.2 » ne sont pas des fichiers). Rend { path, line, col } ou null.
const _PATH_EXTS = new Set(('py pyi js mjs cjs ts tsx jsx vue svelte json jsonc md mdx markdown txt '
    + 'html htm css scss less xml svg yml yaml toml ini cfg conf env sh bash zsh ps1 bat '
    + 'go rs java kt kts c h cc cpp hpp cs rb php pl lua r sql csv tsv log lock '
    + 'dockerfile makefile gradle properties rst tex robot ipynb docx xlsx pptx pdf png jpg jpeg gif webp').split(' '));
const _PATH_RE = /^(\.{0,2}\/)?((?:[\w@.\-]+\/)*[\w@.\-]+?)(?::(\d+))?(?::(\d+))?$/;
window.elpisParsePath = function(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t || t.length > 300 || /\s/.test(t) || /:\/\//.test(t)) return null;
    const m = t.match(_PATH_RE);
    if (!m) return null;
    const lead = m[1] || '';
    let path = m[2];
    const base = path.split('/').pop();
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
    const hasSlash = path.indexOf('/') >= 0 || !!lead;
    // Fichier caché (« .env », « .gitignore ») : un fichier, pas une extension.
    const dotfile = dot === 0 && base.length > 1;
    if (dotfile) {
        if (lead === '/' && path.indexOf('work/') === 0) path = path.slice(5);
        return (hasSlash || _PATH_EXTS.has(ext.slice(1)))
            ? { path: path, line: m[3] ? Number(m[3]) : 0, col: m[4] ? Number(m[4]) : 0 } : null;
    }
    if (!hasSlash && !_PATH_EXTS.has(ext)) return null;
    // « console.log », « process.env » : extensions de fichier ET membres
    // d'objets très courants. Sans barre oblique, un nom en identifiant
    // simple n'est pas pris pour un fichier (« app.log », « .env » écrits
    // avec un chemin restent des liens).
    if (!hasSlash && (ext === 'log' || ext === 'env') && /^[A-Za-z_$][\w$]*$/.test(base.slice(0, dot))) return null;
    if (dot <= 0 && !_PATH_EXTS.has(ext)) return null;       // « src/utils » : dossier, pas fichier
    if (lead === '/' && path.indexOf('work/') === 0) path = path.slice(5);
    return { path: path, line: m[3] ? Number(m[3]) : 0, col: m[4] ? Number(m[4]) : 0 };
};
window.elpisLooksLikePath = function(s) { return !!window.elpisParsePath(s); };

// Durée écoulée, lisible : secondes ENTIÈRES (jamais de dixièmes ni de
// millisecondes), puis bascule en min et en h dès que ça dépasse — « 42 s »,
// « 3 min 07 s », « 1 h 04 min ». Les unités basses sont paddées pour que la
// largeur reste stable (les lignes concernées sont en tabular-nums).
// PARTAGÉ : timer live du composeur, métriques de fin de réponse, durées
// d'étapes (outils, compression, sous-agents), bloc réflexion, export PDF.
//
// Sous la seconde, trois besoins distincts :
//   - un CHRONO qui démarre doit afficher « 0 s » (opts.live) ;
//   - une durée d'OUTIL garde un dixième (opts.precise) : « 0.2 s » vs
//     « 0.9 s » est une info utile, que « <1 s » écraserait ;
//   - partout ailleurs « <1 s » — « 0 s » se lirait comme « pas de mesure ».
// Au-delà de la seconde, tout le monde passe à l'entier (jamais de ms).
function fmtElapsed(sec, opts) {
    const raw = Math.max(0, Number(sec) || 0);
    const s = Math.floor(raw);
    if (s < 1) {
        if (opts && opts.live)    return '0 s';
        // Troncature (pas d'arrondi) : comme pour les secondes, un chrono ne
        // doit jamais afficher l'unité supérieure avant de l'avoir atteinte
        // — 990 ms arrondi donnerait « 1.0 s » juste avant « 1 s ».
        if (opts && opts.precise)
            return raw < 0.1 ? '<0.1 s' : (Math.floor(raw * 10) / 10).toFixed(1) + ' s';
        return '<1 s';
    }
    if (s < 60)   return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
    return Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ' min';
}
window.elpisFmtElapsed = fmtElapsed;
// Même rendu, entrée en millisecondes (durées d'étapes côté serveur).
window.elpisFmtElapsedMs = function (ms, opts) {
    return fmtElapsed((Number(ms) || 0) / 1000, opts);
};

// ── Tokens ──────────────────────────────────────────────
// Format compact UNIQUE des compteurs de tokens (fr-FR) : « 845 »,
// « 12,3 k », « 245 k », « 1,2 M ». Le compte exact va dans l'infobulle
// (``toLocaleString('fr-FR')``).
function fmtTokenCount(n) {
    const v = Math.max(0, Number(n) || 0);
    const f = (x, d) => x.toLocaleString('fr-FR', { maximumFractionDigits: d });
    // 999 600 s'arrondit à « 1 000 k » : on passe alors à l'unité au-dessus.
    if (v >= 999500) return f(v / 1e6, v >= 1e8 ? 0 : 1) + ' M';
    if (v >= 1000) return f(v / 1000, v >= 1e5 ? 0 : 1) + ' k';
    return String(Math.round(v));
}
window.elpisFmtTokens = fmtTokenCount;

// Les postes d'une consommation au sens des fournisseurs (OpenAI,
// Anthropic), même découpe que ``token_breakdown`` côté serveur
// (shared_infra/observability/usage_store.py) : l'entrée CONTIENT le cache
// (relu, presque gratuit — le reste est l'entrée utile, réellement calculée)
// et la part des outils (définitions, appels et résultats re-soumis) ; la
// sortie CONTIENT la réflexion (le reste est la réponse). Bornes : cache et
// outils ≤ entrée, réflexion ≤ sortie.
function tokenBreakdown(input, output, cache, thinking, tools) {
    const n = (x) => Math.max(0, Math.round(Number(x) || 0));
    const inp = n(input), out = n(output);
    const c = Math.min(n(cache), inp), t = Math.min(n(thinking), out);
    return { input: inp, cache: c, input_new: inp - c, tools: Math.min(n(tools), inp),
             output: out, thinking: t, response: out - t,
             cache_pct: inp ? Math.round((c / inp) * 100) : 0 };
}
window.elpisTokenBreakdown = tokenBreakdown;

// ── Socle a11y ──────────────────────────────────────────
// Trois helpers PARTAGÉS pour finir le chantier accessibilité de façon
// systémique (un pattern, N applications) plutôt que rustine par rustine.

// 1. Garde de focus : mémorise l'élément actif à l'ouverture d'une modale /
//    d'un menu, le restitue à la fermeture (WCAG 2.4.3 — sans ça le focus
//    retombe sur <body> et l'utilisateur clavier repart de zéro).
window.elpisFocusGuard = function() {
    let remembered = null;
    return {
        remember: function() {
            remembered = (document.activeElement instanceof HTMLElement)
                ? document.activeElement : null;
        },
        restore: function() {
            if (remembered && document.contains(remembered)) {
                try { remembered.focus(); } catch (_) {}
            }
            remembered = null;
        },
    };
};

const _FOCUSABLE_SEL = 'a[href], button:not([disabled]), textarea:not([disabled]), ' +
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// 2. Piège Tab : à appeler depuis un @keydown.tab sur le CONTENEUR de la
//    modale — cycle premier ↔ dernier focusable au lieu de sortir vers la
//    page derrière l'overlay. Conteneur-scopé (ne PAS le brancher global :
//    Monaco et les inputs du fond ne doivent pas être affectés).
window.elpisTrapTab = function(e, container) {
    if (!container || e.key !== 'Tab') return;
    const items = Array.prototype.filter.call(
        container.querySelectorAll(_FOCUSABLE_SEL),
        function(el) { return el.offsetParent !== null; });   // visibles seulement
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
    }
};

// 3. Préférence OS « réduire les animations » — pendant JS (les blocs CSS
//    prefers-reduced-motion ne couvrent pas scrollIntoView smooth, etc.).
// ═══════════════════════════════════════════════════════════════════════════
//  Recherche floue — SOURCE UNIQUE (Ouverture rapide de l'éditeur, Ctrl+K admin)
// ═══════════════════════════════════════════════════════════════════════════
// Sous-séquence insensible aux accents (« eleve » trouve « élève.py ») : les
// caractères consécutifs et ceux qui ouvrent un segment (après / _ - . espace
// ›) rapportent davantage, et un motif compact devant une cible longue est
// préféré. Renvoie ``{ score, idx }`` — idx = positions trouvées dans ``hay``,
// pour surligner — ou null si ``needle`` n'est pas une sous-séquence.
// Vivait en copie locale dans app-editor.js ; la console admin (qui ne charge
// pas l'éditeur) en a besoin aussi.
window.elpisFuzzyMatch = function(needle, hay) {
    if (!needle) return null;
    const _strip = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const n = _strip(needle);
    const h = _strip(hay);
    const idx = [];
    let hi = 0, score = 0, streak = 0;
    let lastMatchedIdx = -2;
    for (let ni = 0; ni < n.length; ni++) {
        const c = n[ni];
        while (hi < h.length && h[hi] !== c) hi++;
        if (hi >= h.length) return null;
        if (hi === lastMatchedIdx + 1) {
            streak++; score += 2 + streak;
        } else {
            streak = 0;
            const prev = hi > 0 ? h[hi - 1] : '/';
            score += ('/_-. ›'.indexOf(prev) >= 0) ? 3 : 1;
        }
        idx.push(hi);
        lastMatchedIdx = hi;
        hi++;
    }
    const compactness = n.length / Math.max(1, h.length);
    return { score: score * (0.5 + compactness * 0.5), idx };
};

window.elpisReducedMotion = function() {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) { return false; }
};

const _SANITIZE_FORBID_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form',
]);

// ── Neutralisation des MÉDIAS DISTANTS dans le HTML rendu (anti-exfiltration) ──
// Une image externe auto-chargée = requête réseau dont l'URL peut encoder des
// données du chat : c'est LE canal d'exfiltration classique par injection
// indirecte (ChatGPT, Bard, Copilot/CamoLeak — corrigé chez GitHub en coupant
// le rendu d'images). Politique : data:image/*, blob: et même-origine passent ;
// toute URL http(s) TIERCE est remplacée par un lien cliquable (l'utilisateur
// garde l'accès, mais AUCUN chargement automatique). Couvre <img> (+srcset),
// video/audio/source/track (src/poster), input[src] et les style="…url(…)"
// inline (background-image). Appliqué en sortie de sanitizeHtml → tout
// marked.parse() passe dedans (hook postprocess).

function _isRemoteMediaUrl(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return false;
    if (/^data:image\//i.test(s)) return false;   // inline, aucune requête
    if (/^blob:/i.test(s)) return false;          // objet local
    if (/^data:/i.test(s)) return true;           // data: non-image = suspect
    try {
        const u = new URL(s, window.location.href);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
            return u.origin !== window.location.origin;
        }
        return true;                              // autres protocoles : jamais auto-chargés
    } catch (_) { return true; }
}

const _MEDIA_SCAN_RE = /<(img|video|audio|source|track|input)\b|style\s*=/i;

function _neutralizeRemoteMedia(html) {
    if (!html || !_MEDIA_SCAN_RE.test(html)) return html;
    try {
        const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
        const root = doc.body && doc.body.firstChild;
        if (!root) return html;
        // <img> distante → chip-lien : le clic (choix utilisateur) remplace le
        // chargement automatique.
        root.querySelectorAll('img').forEach(function(img) {
            img.removeAttribute('srcset');
            img.removeAttribute('sizes');
            const src = img.getAttribute('src') || '';
            if (!_isRemoteMediaUrl(src)) return;
            const a = doc.createElement('a');
            a.setAttribute('href', src);
            a.setAttribute('target', '_blank');
            a.setAttribute('rel', 'noopener noreferrer nofollow');
            a.className = 'elpis-ext-img';
            a.title = 'Image externe non chargée automatiquement — cliquer pour l\'ouvrir';
            let host = '';
            try { host = new URL(src, window.location.href).hostname; } catch (_) {}
            const icon = doc.createElement('i');
            icon.className = 'ph ph-image';
            a.appendChild(icon);
            const alt = (img.getAttribute('alt') || '').trim();
            a.appendChild(doc.createTextNode(
                ' ' + (alt ? alt + ' — ' : '') + 'image externe (' + (host || 'lien') + ')'));
            if (img.parentNode) img.parentNode.replaceChild(a, img);
        });
        // Autres éléments auto-chargeurs (HTML brut émis par le modèle) : on
        // retire l'attribut réseau distant, l'élément devient inerte.
        root.querySelectorAll('video, audio, source, track, input').forEach(function(el) {
            ['src', 'poster', 'srcset'].forEach(function(at) {
                if (el.hasAttribute(at) && _isRemoteMediaUrl(el.getAttribute(at))) {
                    el.removeAttribute(at);
                }
            });
        });
        // style inline avec url(…) : chargement CSS (background-image) → retiré.
        // marked n'émet jamais de style ; seul du HTML brut du modèle en porte.
        root.querySelectorAll('[style]').forEach(function(el) {
            if (/url\s*\(/i.test(el.getAttribute('style') || '')) el.removeAttribute('style');
        });
        return root.innerHTML;
    } catch (_) { return html; }
}
window.elpisNeutralizeRemoteMedia = _neutralizeRemoteMedia;

// Superpositions : un style inline « position:fixed|sticky » dans du HTML
// ou un SVG du modèle recouvrait l'IHM (faux bouton, faux dialogue — audit
// 2026-09-22). Ramené à « static » dans TOUS les passages DOMPurify.
if (window.DOMPurify && typeof window.DOMPurify.addHook === 'function') {
    window.DOMPurify.addHook('uponSanitizeAttribute', function(_node, data) {
        if (data.attrName === 'style' && /position\s*:\s*(fixed|sticky)/i.test(data.attrValue || '')) {
            data.attrValue = data.attrValue.replace(/position\s*:\s*(fixed|sticky)/gi, 'position:static');
        }
    });
}

function sanitizeHtml(html) {
    if (html === null || html === undefined) return '';
    const raw = String(html);
    if (!raw) return '';
    if (typeof window.DOMPurify !== 'undefined' && typeof window.DOMPurify.sanitize === 'function') {
        try {
            return _neutralizeRemoteMedia(window.DOMPurify.sanitize(raw, {
                ADD_ATTR: ['target'],
                FORBID_TAGS: Array.from(_SANITIZE_FORBID_TAGS),
                FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
            }));
        } catch (_) {  }
    }
    // Sans DOMPurify (ou s'il échoue) : texte échappé. L'ancien nettoyeur de
    // repli (DOMParser → innerHTML) était vulnérable aux mXSS (audit 2026-09-22).
    return escapeHtml(raw);
}
window.elpisSanitize = sanitizeHtml;

// ── Chemin canonique d'un fichier de la sandbox (audit éditeur 2026-09-23, E13)
// UNE fonction pour l'éditeur, le chat et les cartes de diff — miroir de
// ``shared_infra/sandbox/paths.strip_work_prefix`` côté serveur. Des
// variantes (``work/x``, ``/x``, ``./x``, ``a//b``, ``src/../x``) ouvraient
// sinon DEUX onglets et deux tampons pour un même fichier, ou faisaient
// collisionner les modèles Monaco. ``sbRoot`` : préfixe hôte affiché.
window.elpisCanonPath = function(p, sbRoot) {
    if (p === null || p === undefined) return p;
    let s = String(p).replace(/\\/g, '/').trim();
    if (sbRoot && s.startsWith(sbRoot)) s = s.substring(sbRoot.length);
    const out = [];
    for (const seg of s.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') { if (out.length) out.pop(); continue; }
        out.push(seg);
    }
    if (out.length && out[0] === 'work') out.shift();
    return out.join('/');
};

function getFileMeta(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
        'js':    { icon: 'ph-file-js',        color: 'text-yellow-400', lang: 'javascript' },
        'ts':    { icon: 'ph-file-ts',        color: 'text-blue-400',   lang: 'typescript' },
        'html':  { icon: 'ph-browsers',       color: 'text-orange-500', lang: 'html' },
        'css':   { icon: 'ph-paint-brush',    color: 'text-sky-400',    lang: 'css' },
        'json':  { icon: 'ph-brackets-curly', color: 'text-lime-500',   lang: 'json' },
        'py':    { icon: 'ph-file-py',        color: 'text-blue-500',   lang: 'python' },
        'sh':    { icon: 'ph-terminal-window',color: 'text-green-500',  lang: 'shell' },
        'md':    { icon: 'ph-info',           color: 'text-slate-400',  lang: 'markdown' },
        'txt':   { icon: 'ph-file-text',      color: 'text-gray-500',   lang: 'plaintext' },
        'robot': { icon: 'ph-robot',          color: 'text-cyan-600',   lang: 'robot' },
        // Aperçus Office / PDF de l'éditeur (mêmes couleurs que la barre d'aperçu)
        'docx':  { icon: 'ph-file-doc',       color: 'text-blue-400',    lang: 'plaintext' },
        'pptx':  { icon: 'ph-file-ppt',       color: 'text-orange-400',  lang: 'plaintext' },
        'xlsx':  { icon: 'ph-file-xls',       color: 'text-emerald-400', lang: 'plaintext' },
        'pdf':   { icon: 'ph-file-pdf',       color: 'text-rose-400',    lang: 'plaintext' }
    };
    return map[ext] || { icon: 'ph-file', color: 'text-gray-400', lang: 'plaintext' };
}

(function setupMarked() {
    // CORRECTIF — la garde portait AUSSI sur ``window.hljs`` : sans la
    // coloration syntaxique, on sortait de la fonction sans rien enregistrer,
    // donc SANS le hook ``postprocess`` qui sanitise. Une simple 404 sur
    // highlight.min.js suffisait à faire passer toute sortie de
    // ``marked.parse()`` non assainie. La coloration est un agrément, la
    // sanitisation une exigence : elles ne peuvent pas dépendre l'une de
    // l'autre.
    if (typeof window.marked === 'undefined') return;
    const renderer = new window.marked.Renderer();
    renderer.code = function(codeOrToken, language) {
        let codeText = typeof codeOrToken === 'string' ? codeOrToken : (codeOrToken.text || '');
        let lang = (typeof codeOrToken === 'string' ? language : codeOrToken.lang) || '';
        let match = lang.match(/\S*/);
        lang = match ? match[0] : '';
        let highlighted;
        // ``elpisHljsOff`` (AUDIT 2026-08-31) : posé par le rendu du bloc
        // ACTIF pendant le streaming (chat/_rendering.js). Un fence qui
        // n'OUVRE pas le bloc (prose + ``` sans ligne vide, code dans une
        // liste) passait par marked → ce renderer → hljs.highlightAuto (35
        // grammaires) ~9×/s sur un bloc qui grossit. La branche « hljs
        // absent » émet exactement la structure attendue pour un highlight
        // différé — le rendu FINAL du bloc colorera.
        if (window.hljs && !window.elpisHljsOff) {
            highlighted = codeText;
            if (lang && window.hljs.getLanguage(lang)) {
                try { highlighted = window.hljs.highlight(codeText, { language: lang }).value; } catch(e) {}
            } else {
                try { highlighted = window.hljs.highlightAuto(codeText).value; } catch(e) {}
            }
        } else {
            // hljs pas encore chargé (il l'est à la demande, cf. ensureVendor) :
            // on rend le code ÉCHAPPÉ, lisible et sûr. La passe qui parcourt les
            // <pre> le colorera dès que la lib sera là — la structure émise ici
            // est exactement celle qu'attend ``hljs.highlightElement``.
            highlighted = escapeHtml(codeText);
        }
        return `<pre><code class="hljs ${lang ? 'language-' + lang : ''}">${highlighted}</code></pre>\n`;
    };
    // `chemin/fichier.py:12` en ligne → cliquable (ouvre l'éditeur à la
    // ligne). Seule une CLASSE est posée : le clic est traité par
    // handleMarkdownClick, qui vérifie que le fichier existe dans la sandbox.
    renderer.codespan = function(tokOrText) {
        const raw = typeof tokOrText === 'string' ? tokOrText : ((tokOrText && tokOrText.text) || '');
        const html = escapeHtml(raw);
        return window.elpisLooksLikePath(raw)
            ? `<code class="elpis-path-link" title="Ouvrir dans l'éditeur">${html}</code>`
            : `<code>${html}</code>`;
    };
    window.marked.use({
        renderer,
        hooks: {
            postprocess: function(html) {
                return sanitizeHtml(html);
            },
        },
    });
})();

// ── État PARTAGÉ de l'arbre de fichiers (2026-09-19) ───────────────────────
// Un singleton réactif que tous les TreeItem lisent (arbre des fichiers ET
// arborescence Git, mêmes chemins) :
//   • open     — dossiers dépliés, MÉMORISÉS par compte (localStorage) : un
//                rechargement, un re-tri serveur ou une réouverture de
//                l'éditeur ne replie plus tout ;
//   • selected — sélection multiple (Ctrl/Maj + clic) ;
//   • active   — fichier de l'onglet actif (surligné en permanence) ;
//   • git      — pastilles M/U/A/C par chemin (+ dossiers qui en contiennent) ;
//   • reveal   — « Localiser » : déplie les ancêtres, fait défiler jusqu'à la
//                ligne. Remplace l'ancien signal du fil d'Ariane.
// Créé paresseusement (Vue est global au runtime).
window.elpisTree = (function() {
    let st = null;
    let uid = null;
    let saveTimer = null;
    function S() {
        if (!st) st = Vue.reactive({
            open: new Set(), selected: new Set(), anchor: '',
            active: '', git: {}, gitDirs: new Set(),
            revealPath: '', revealSeq: 0,
        });
        return st;
    }
    function _key() { return 'elpis.tree.open.' + (uid || 'anon'); }
    function _persist() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(function() {
            try { localStorage.setItem(_key(), JSON.stringify(Array.from(S().open).slice(0, 5000))); } catch (_) {}
        }, 250);
    }
    function setUser(id) {
        if (id === uid) return;
        uid = id;
        let arr = [];
        try { arr = JSON.parse(localStorage.getItem(_key()) || '[]'); } catch (_) { arr = []; }
        S().open = new Set(Array.isArray(arr) ? arr.filter(function(x) { return typeof x === 'string'; }) : []);
        S().selected = new Set();
        S().anchor = '';
    }
    function parentOf(p) {
        p = String(p || '');
        const i = p.lastIndexOf('/');
        return i > 0 ? p.slice(0, i) : '';
    }
    function ancestors(p) {
        const out = [];
        let cur = parentOf(p);
        while (cur) { out.unshift(cur); cur = parentOf(cur); }
        return out;
    }
    function isOpen(p) { return S().open.has(p); }
    function setOpen(p, v) {
        const o = S().open;
        if (!!v === o.has(p)) return;
        if (v) o.add(p); else o.delete(p);
        _persist();
    }
    function collapseAll() {
        if (!S().open.size) return;
        S().open.clear();
        _persist();
    }
    // Déplie tous les ANCÊTRES de ``path`` (et ``path`` lui-même si
    // ``includeSelf`` — un dossier ciblé par le fil d'Ariane).
    function openAncestors(path, includeSelf) {
        const o = S().open;
        let changed = false;
        const list = ancestors(path);
        if (includeSelf && path) list.push(path);
        list.forEach(function(a) { if (!o.has(a)) { o.add(a); changed = true; } });
        if (changed) _persist();
    }
    function reveal(path, opts) {
        if (!path) return;
        openAncestors(path, !!(opts && opts.folder));
        S().revealPath = path;
        S().revealSeq++;
    }
    function setActive(p) { S().active = p || ''; }
    // Sélection : 'single' | 'toggle' | 'range' (``order`` = chemins visibles
    // dans l'ordre d'affichage, pour la plage).
    function select(path, mode, order) {
        const s = S();
        if (mode === 'toggle') {
            const n = new Set(s.selected);
            if (n.has(path)) n.delete(path); else n.add(path);
            s.selected = n;
            s.anchor = path;
            return;
        }
        if (mode === 'range' && s.anchor && Array.isArray(order)) {
            const a = order.indexOf(s.anchor), b = order.indexOf(path);
            if (a >= 0 && b >= 0) {
                const lo = Math.min(a, b), hi = Math.max(a, b);
                s.selected = new Set(order.slice(lo, hi + 1));
                return;
            }
        }
        s.selected = new Set([path]);
        s.anchor = path;
    }
    function clearSelection() { S().selected = new Set(); S().anchor = ''; }
    // Chemins sur lesquels agit une action lancée depuis ``path`` : toute la
    // sélection si ``path`` en fait partie et qu'elle compte plusieurs
    // éléments, sinon ``path`` seul. Les descendants d'un dossier déjà
    // sélectionné sont retirés (supprimer « src » ET « src/a.py »).
    function targetsFor(path) {
        const sel = S().selected;
        if (!path || sel.size < 2 || !sel.has(path)) return path ? [path] : [];
        const all = Array.from(sel);
        return all.filter(function(p) {
            return !all.some(function(q) { return q !== p && p.indexOf(q + '/') === 0; });
        });
    }
    // Pastilles Git : { chemin: 'M' | 'U' | 'A' | 'D' | 'C' }.
    function setGit(map) {
        const m = map || {};
        const dirs = new Set();
        Object.keys(m).forEach(function(p) { ancestors(p).forEach(function(a) { dirs.add(a); }); });
        S().git = m;
        S().gitDirs = dirs;
    }
    // Navigation clavier (motif APG « tree ») sur les lignes RENDUES : les
    // enfants d'un dossier replié ne sont pas dans le DOM, l'ordre du DOM est
    // donc exactement l'ordre visible.
    function navKey(e, rowEl, item) {
        const tree = rowEl && rowEl.closest('[role="tree"]');
        if (!tree) return false;
        const rows = Array.prototype.slice.call(tree.querySelectorAll('[role="treeitem"]'));
        const i = rows.indexOf(rowEl);
        const isFolder = item.type === 'folder';
        const focusAt = function(j) { if (rows[j]) { rows[j].focus(); return true; } return false; };
        switch (e.key) {
            case 'ArrowDown': return focusAt(i + 1);
            case 'ArrowUp':   return focusAt(i - 1);
            case 'Home':      return focusAt(0);
            case 'End':       return focusAt(rows.length - 1);
            case 'ArrowRight':
                if (!isFolder) return false;
                if (!isOpen(item.path)) { setOpen(item.path, true); return true; }
                if (rows[i + 1] && (rows[i + 1].dataset.path || '').indexOf(item.path + '/') === 0) return focusAt(i + 1);
                return true;
            case 'ArrowLeft': {
                if (isFolder && isOpen(item.path)) { setOpen(item.path, false); return true; }
                const par = parentOf(item.path);
                if (!par) return true;
                const pr = rows.find(function(r) { return r.dataset.path === par; });
                if (pr) pr.focus();
                return true;
            }
        }
        return false;
    }
    return {
        get state() { return S(); },
        setUser, isOpen, setOpen, collapseAll, openAncestors, reveal, setActive,
        select, clearSelection, targetsFor, setGit, navKey, parentOf,
    };
})();

// Compatibilité : le fil d'Ariane (et d'anciens appels) déplie un DOSSIER.
window.elpisRevealInTree = function(path) {
    window.elpisTree.reveal(path, { folder: true });
};

// Chemins d'un glisser-déposer interne (plusieurs si la sélection est
// multiple). Type MIME propre : un dépôt de fichiers depuis l'OS ne le porte
// jamais.
const _TREE_DND_MIME = 'application/x-elpis-paths';
window.elpisDraggedPaths = function(dt) {
    try {
        const raw = dt && dt.getData(_TREE_DND_MIME);
        if (raw) {
            const list = JSON.parse(raw);
            if (Array.isArray(list) && list.length) return list.filter(function(p) { return typeof p === 'string' && p; });
        }
    } catch (_) {}
    const one = dt && dt.getData('text/plain');
    return one ? [one] : [];
};

const TreeItem = {
    template: '#tree-item-template',
    props: { item: Object },
    emits: ['open-file', 'context-menu', 'download', 'delete', 'rename', 'move-item'],
    setup(props, { emit }) {
        const { ref, computed, watch, nextTick } = Vue;
        const T = window.elpisTree;
        const tree = T.state;
        const rowRef = ref(null);
        const isOpen = computed(() => props.item.type === 'folder' && tree.open.has(props.item.path));
        const isActive = computed(() => props.item.type !== 'folder' && tree.active === props.item.path);
        const isSelected = computed(() => tree.selected.size > 1 && tree.selected.has(props.item.path));
        const gitCode = computed(() => props.item.type === 'folder'
            ? (tree.gitDirs.has(props.item.path) ? '•' : '')
            : (tree.git[props.item.path] || ''));
        // « Localiser » : la ligne ciblée défile jusqu'à être visible.
        watch(() => tree.revealSeq, function() {
            if (tree.revealPath !== props.item.path) return;
            nextTick(function() {
                const el = rowRef.value;
                if (el && el.scrollIntoView) {
                    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
                }
            });
        });
        const dragOver = ref(false);
        const isFolder = computed(() => props.item.type === 'folder');
        const meta = computed(() => isFolder.value ? {} : getFileMeta(props.item.name));
        function _visibleOrder() {
            const t = rowRef.value && rowRef.value.closest('[role="tree"]');
            if (!t) return [];
            return Array.prototype.map.call(t.querySelectorAll('[role="treeitem"]'), function(r) { return r.dataset.path; });
        }
        function handleClick(event) {
            // Ctrl/Cmd + clic : ajoute/retire de la sélection ; Maj + clic :
            // plage depuis la dernière ligne choisie. Ni ouverture ni pliage.
            if (event && (event.ctrlKey || event.metaKey)) {
                T.select(props.item.path, 'toggle');
                return;
            }
            if (event && event.shiftKey) {
                T.select(props.item.path, 'range', _visibleOrder());
                return;
            }
            T.select(props.item.path, 'single');
            if (isFolder.value) T.setOpen(props.item.path, !isOpen.value);
            else emit('open-file', props.item.path);
        }
        function handleKeydown(event) {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            if (event.key === 'Delete') { event.preventDefault(); emit('delete', props.item.path); return; }
            if (event.key === 'F2')     { event.preventDefault(); emit('rename', props.item.path); return; }
            if (event.key === 'Escape' && tree.selected.size > 1) { T.clearSelection(); return; }
            if (T.navKey(event, rowRef.value, props.item)) event.preventDefault();
        }
        function handleRightClick(event) {
            // Clic droit HORS de la sélection : elle se réduit à la ligne
            // visée (même règle que les explorateurs de fichiers).
            if (!tree.selected.has(props.item.path)) T.select(props.item.path, 'single');
            emit('context-menu', { event, item: props.item });
        }
        function onDragStart(event) {
            const paths = T.targetsFor(props.item.path);
            event.dataTransfer.setData('text/plain', props.item.path);
            event.dataTransfer.setData(_TREE_DND_MIME, JSON.stringify(paths));
            event.dataTransfer.effectAllowed = 'move';
        }
        function onDragOver(event) {
            if (!isFolder.value) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            dragOver.value = true;
        }
        function onDragEnter(event) {
            if (!isFolder.value) return;
            event.preventDefault();
            dragOver.value = true;
        }
        function onDragLeave() { dragOver.value = false; }
        function onDrop(event) {
            dragOver.value = false;
            if (!isFolder.value) return;
            event.preventDefault();
            event.stopPropagation();
            var dt = event.dataTransfer;
            // DOSSIERS déposés : traverser via webkitGetAsEntry (dataTransfer.files
            // ne descend pas dans les répertoires). Entries extraites SYNC.
            var entries = [];
            if (dt.items && dt.items.length && typeof DataTransferItem !== 'undefined') {
                for (var i = 0; i < dt.items.length; i++) {
                    var it = dt.items[i];
                    if (it.kind !== 'file') continue;   // drag interne = 'string'
                    var entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
                    if (entry) entries.push(entry);
                }
            }
            if (entries.length && window.__elpisUploadEntries) {
                // EU des entries → traité exclusivement, on retourne (ne pas
                // retomber sur dt.files = fantôme dossier). Le parcours du
                // dossier tourne DANS l'import (barre « Préparation »,
                // annulable) — cf. uploadDroppedEntries (app.js).
                window.__dropHandled = Date.now();
                window.__elpisUploadEntries(entries, props.item.path);
                T.setOpen(props.item.path, true);
                return;
            }
            var files = dt.files;
            if (files && files.length > 0) {
                window.__dropHandled = Date.now();
                if (window.__elpisUploadFiles) {
                    window.__elpisUploadFiles(files, props.item.path);
                }
                T.setOpen(props.item.path, true);
                return;
            }
            // Déplacement interne — plusieurs chemins si la sélection l'est.
            // On écarte le dossier cible lui-même, ses ancêtres (déplacer un
            // dossier dans son propre descendant) et ce qui y est déjà.
            var dest = props.item.path;
            var srcs = window.elpisDraggedPaths(dt).filter(function(src) {
                return src && src !== dest && dest.indexOf(src + '/') !== 0
                    && T.parentOf(src) !== dest;
            });
            if (!srcs.length) return;
            window.__dropHandled = Date.now();
            srcs.forEach(function(src) { emit('move-item', { oldPath: src, newParent: dest }); });
            T.setOpen(dest, true);
        }
        const openFile = (p) => emit('open-file', p);
        const downloadFile = (p) => emit('download', p);
        const deleteFile = (p) => emit('delete', p);
        const renameFile = (p) => emit('rename', p);
        const onContextMenu = (payload) => emit('context-menu', payload);
        const onMoveItem = (payload) => emit('move-item', payload);
        return { isOpen, isFolder, isActive, isSelected, gitCode, rowRef, meta, dragOver,
                 handleClick, handleKeydown, handleRightClick,
                 onDragStart, onDragOver, onDragEnter, onDragLeave, onDrop,
                 openFile, downloadFile, deleteFile, renameFile, onContextMenu, onMoveItem };
    }
};

// ── Arbre récursif de la page Skills (thème CLAIR, ≠ TreeItem éditeur sombre).
// Nœuds {key, kind: 'domain'|'skill'|'file', label, skill?, path?, children[]}
// construits par _skills_menu.js (skillsTreeByScope). L'état dépli/repli est
// CENTRALISÉ dans le Set `collapsedSkills` du parent (défaut : tout déplié ;
// le Set est REMPLACÉ à chaque toggle → la prop change → recompute) — un
// isOpen local façon TreeItem se réinitialiserait à chaque re-render de liste.
const SkillTreeNode = {
    name: 'SkillTreeNode',
    template: '#skill-tree-node-template',
    props: {
        node: { type: Object, required: true },
        selectedKey: { type: String, default: '' },
        activeFileKey: { type: String, default: '' },
        collapsed: { type: Object, required: true },    // Set (réassigné, jamais muté)
    },
    emits: ['select-skill', 'open-file', 'toggle'],
    setup(props, { emit }) {
        const { computed } = Vue;
        const isExpandable = computed(() => (props.node.children || []).length > 0);
        const isOpen = computed(() => !props.collapsed.has(props.node.key));
        const isSelected = computed(() =>
            props.node.kind === 'skill' && props.node.key === props.selectedKey);
        const isFileActive = computed(() =>
            props.node.kind === 'file' && props.node.key === props.activeFileKey);
        const rowClass = computed(() => {
            if (isSelected.value) return 'bg-blue-50 ring-1 ring-blue-200';
            if (isFileActive.value) return 'bg-blue-50/60 ring-1 ring-blue-100';
            return 'hover:bg-slate-50';
        });
        const labelClass = computed(() => {
            // Hiérarchie par graisse (PAS de micro-majuscules trackées — même
            // grammaire que les en-têtes de groupe de la page).
            if (props.node.kind === 'domain') return 'text-[11px] font-semibold text-slate-500';
            if (props.node.kind === 'file') return 'font-mono text-[11px] text-slate-500';
            return 'font-mono text-sm font-medium text-slate-800';
        });
        function handleClick() {
            if (props.node.kind === 'skill') emit('select-skill', props.node.skill);
            else if (props.node.kind === 'file') emit('open-file', { skill: props.node.skill, path: props.node.path });
            else emit('toggle', props.node.key);        // domaine : la ligne replie/déplie
        }
        // Pass-through : la récursion ré-émet vers la racine (pattern TreeItem).
        const onSelectSkill = (p) => emit('select-skill', p);
        const onOpenFile = (p) => emit('open-file', p);
        const onToggle = (k) => emit('toggle', k);
        return { isExpandable, isOpen, isSelected, isFileActive, rowClass, labelClass,
                 handleClick, onSelectSkill, onOpenFile, onToggle };
    }
};

const AxNode = {
    name: 'AxNode',
    template: '#ax-node-template',
    props: {
        node: { type: Object, required: true },
        depth: { type: Number, default: 0 },
        forceOpen: { type: Number, default: 0 },
        forceClose: { type: Number, default: 0 },
    },
    setup(props) {
        const { ref, computed, watch } = Vue;
        const isOpen = ref(props.depth < 2);
        const hasChildren = computed(() =>
            Array.isArray(props.node.children) && props.node.children.length > 0
        );
        const isElement = computed(() => props.node.node_type === 'element');
        const totalDescendants = computed(() => {
            let count = 0;
            function walk(n) {
                (n.children || []).forEach(c => {
                    count += 1;
                    walk(c);
                });
            }
            walk(props.node);
            return count;
        });
        function toggle() { isOpen.value = !isOpen.value; }
        watch(() => props.forceOpen, (v) => { if (v > 0) isOpen.value = true; });
        watch(() => props.forceClose, (v) => {
            if (v > 0 && props.depth > 0) isOpen.value = false;
        });
        return {
            isOpen, hasChildren, isElement, totalDescendants, toggle,
        };
    },
};


/* ===========================================================================
 *  ensureVendor — chargement à la demande des grosses libs vendor
 * ===========================================================================
 *  Le chemin critique chargeait 4,0 Mo de vendor à CHAQUE ouverture de page,
 *  dont l'essentiel ne sert jamais dans une session donnée :
 *
 *      mermaid.min.js        2 894 Ko   seulement si un message contient un
 *                                       diagramme — rare
 *      chart.js + 8 plugins    355 Ko   dashboard admin ou sortie de l'outil
 *                                       graphique
 *      monaco (loader + vs)  13 000 Ko   seulement si on ouvre l'éditeur
 *
 *  Ces libs ont toutes un point d'entrée unique et déjà défensif dans le code
 *  (``if (!window.mermaid)``, ``typeof Chart === 'undefined'``,
 *  ``typeof require === 'undefined'``) : il suffit d'y attendre le chargement
 *  au lieu d'abandonner. Aucune étape de build introduite.
 *
 *  Le chargement est mémoïsé PAR GROUPE : dix diagrammes dans un même message
 *  ne déclenchent qu'un téléchargement, et les appels concurrents partagent la
 *  même promesse.
 */
(function () {
    'use strict';

    // Version d'un bundle vendor. Le serveur publie une EMPREINTE DE CONTENU
    // par fichier dans ``window.__VENDOR_V__`` (cf. routes/system.py) : elle
    // ne bouge que si le fichier bouge, ce qui autorise le serveur à répondre
    // ``immutable`` — plus aucune requête de revalidation sur les visites
    // suivantes.
    //
    // Repli sur le ?v= du <script> qui charge CE fichier (le BUILD_ID courant)
    // si la carte est absente : une version imparfaite vaut mieux qu'une URL
    // sans version, qui serait mise en cache sans moyen de l'invalider.
    const _FALLBACK_V = (function () {
        try {
            const src = document.currentScript && document.currentScript.src;
            const m = src && src.match(/[?&]v=([\w.-]+)/);
            return m ? m[1] : '';
        } catch (_) { return ''; }
    })();

    function _assetV(url) {
        const key = url.replace(/^static\//, '');
        const map = window.__VENDOR_V__ || {};
        const v = map[key] || _FALLBACK_V;
        return v ? ('?v=' + v) : '';
    }

    // Groupe → { urls (ordre significatif), ready() }.
    // ``ready`` évite un rechargement si la lib est déjà là (page qui l'aurait
    // encore en dur, ou double appel avant mémoïsation).
    const GROUPS = {
        mermaid: {
            urls: ['static/vendor/mermaid.min.js'],
            ready: () => !!window.mermaid,
        },
        // La coloration syntaxique ne sert qu'aux messages contenant du code.
        // Sans elle, les blocs s'affichent échappés et lisibles (cf. setupMarked) :
        // le chargement peut donc attendre le premier bloc réel.
        highlight: {
            urls: ['static/vendor/highlight.min.js'],
            ready: () => !!window.hljs,
        },
        // L'ordre compte : chart.js d'abord (les plugins s'enregistrent sur
        // window.Chart au chargement), puis l'adaptateur de dates AVANT
        // financial, qui utilise un axe temporel.
        chart: {
            urls: [
                'static/vendor/chart.js',
                'static/vendor/chartjs-adapter-date-fns.bundle.min.js',
                'static/vendor/chartjs-plugin-datalabels.min.js',
                'static/vendor/chartjs-plugin-annotation.min.js',
                'static/vendor/chartjs-chart-treemap.min.js',
                'static/vendor/chartjs-chart-sankey.min.js',
                'static/vendor/chartjs-chart-matrix.min.js',
                'static/vendor/chartjs-chart-boxplot.umd.min.js',
                'static/vendor/chartjs-chart-financial.js',
            ],
            ready: () => typeof window.Chart !== 'undefined',
            after: () => { if (window.elpisRegisterChartPlugins) window.elpisRegisterChartPlugins(); },
        },
        // Graphiques du chat (outils chart_<type>, rendu chat/_charts.js) :
        // ECharts puis sa traduction française (enregistre la locale « FR »).
        // Le groupe « chart » (Chart.js) reste celui du tableau de bord admin.
        echarts: {
            urls: ['static/vendor/echarts.min.js', 'static/vendor/echarts-langFR.js'],
            ready: () => !!window.echarts,
        },
        monaco: {
            urls: ['static/vendor/monaco/vs/loader.js'],
            ready: () => typeof window.require !== 'undefined',
        },
    };

    const _pending = Object.create(null);

    function _loadScript(url) {
        return new Promise(function (resolve, reject) {
            const el = document.createElement('script');
            el.src = url + _assetV(url);
            el.async = false;          // préserve l'ordre d'exécution du groupe
            el.onload = () => resolve();
            el.onerror = () => reject(new Error('Chargement impossible : ' + url));
            document.head.appendChild(el);
        });
    }

    /**
     * Charge un groupe vendor et résout quand il est utilisable.
     * Idempotent : les appels suivants rendent la même promesse.
     *
     * En cas d'échec la promesse est REJETÉE et la mémoïsation est purgée,
     * pour qu'un incident réseau ponctuel n'interdise pas définitivement la
     * fonctionnalité — l'appelant, lui, garde son repli existant.
     */
    window.ensureVendor = function ensureVendor(name) {
        const grp = GROUPS[name];
        if (!grp) return Promise.reject(new Error('Groupe vendor inconnu : ' + name));
        if (grp.ready()) return Promise.resolve();
        if (_pending[name]) return _pending[name];

        let chain = Promise.resolve();
        grp.urls.forEach(function (u) { chain = chain.then(() => _loadScript(u)); });

        _pending[name] = chain.then(function () {
            if (grp.after) { try { grp.after(); } catch (_) {} }
        }).catch(function (err) {
            delete _pending[name];
            throw err;
        });
        return _pending[name];
    };
})();


/* ---------------------------------------------------------------------------
 *  Enregistrement des plugins Chart.js — appelé APRÈS le chargement du groupe.
 *
 *  Ce bloc vivait en ligne dans index.html, juste sous les <script> de la pile
 *  chart.js. Le chargement devenant paresseux, il doit s'exécuter au même
 *  moment que la lib, pas au parse du document. Partagé par index.html et
 *  admin.html, qui le dupliquaient.
 *
 *  Les contrôleurs de type (treemap/sankey/matrix/boxplot/financial)
 *  s'enregistrent seuls au chargement : seuls les deux plugins d'options ont
 *  besoin d'un Chart.register explicite.
 * ------------------------------------------------------------------------- */
window.elpisRegisterChartPlugins = function elpisRegisterChartPlugins() {
    if (typeof Chart === 'undefined' || Chart.__elpisPluginsReady) return;
    try {
        if (window.ChartDataLabels) {
            Chart.register(window.ChartDataLabels);
            // Enregistré globalement mais INACTIF par défaut : ne dessine rien
            // tant qu'un graphique ne pose pas options.plugins.datalabels.display
            // (piloté côté backend par show_values).
            Chart.defaults.set('plugins.datalabels', { display: false });
        }
        const annPlugin = window['chartjs-plugin-annotation'];
        if (annPlugin) Chart.register(annPlugin);

        // Plugin maison : écrit la valeur au centre de l'arc d'une jauge.
        // Inerte tant qu'un graphique ne pose pas options.plugins.centerText.text.
        Chart.register({
            id: 'elpisCenterText',
            afterDatasetsDraw: function (chart) {
                const ct = chart.config.options && chart.config.options.plugins
                           && chart.config.options.plugins.centerText;
                if (!ct || !ct.text) return;
                const area = chart.chartArea; if (!area) return;
                const g = chart.ctx;
                const cx = (area.left + area.right) / 2;
                const cy = (area.top + area.bottom) / 2;
                const dark = document.body.classList.contains('elpis-dark-surface');
                g.save();
                g.textAlign = 'center'; g.textBaseline = 'middle';
                g.fillStyle = ct.color || (dark ? '#e2e8f0' : '#334155');
                g.font = '600 ' + (ct.size || 22) + 'px system-ui, sans-serif';
                g.fillText(String(ct.text), cx, ct.subtext ? cy - 6 : cy);
                if (ct.subtext) {
                    g.font = '400 12px system-ui, sans-serif';
                    g.globalAlpha = 0.65;
                    g.fillText(String(ct.subtext), cx, cy + 16);
                }
                g.restore();
            }
        });
        Chart.__elpisPluginsReady = true;
    } catch (e) {
        // Un plugin manquant ne doit jamais casser la page.
    }
};

// ═══════════════════════════════════════════════════════════════════════════
//  Casting intégré des sous-agents — SOURCE UNIQUE côté front
// ═══════════════════════════════════════════════════════════════════════════
// Miroir de ``llm_core.tools.task_tool._AGENTS`` (verrouillé par un test : une
// dérive ferait choisir l'utilisateur sur une description fausse).
//
// Cette liste vivait en TROIS exemplaires — l'onglet Agents des réglages, le
// sélecteur des routines, et la liste des noms réservés. Trois miroirs d'une
// même vérité, c'est trois occasions de diverger : le jour où le casting bouge,
// deux se mettent à jour et le troisième ment en silence.
//
// Les agents PERSONNALISÉS n'y sont pas : ils viennent de
// ``settings.custom_agents`` et sont lus tels quels au run.
// ``icon`` : un chaînage se lit d'abord à ses formes. Un agent personnalisé
// n'en a pas et retombe sur ``ph-robot`` — jamais une icône composée à la volée
// depuis son nom, qui rendrait un carré vide pour tout nom inattendu.
window.ELPIS_BUILTIN_AGENTS = [
    { name: 'explore',   icon: 'ph-magnifying-glass', hint: 'Explore le code et répond, sans rien modifier' },
    { name: 'implement', icon: 'ph-code',             hint: 'Écrit la modification et la vérifie, sans commiter' },
    { name: 'verify',    icon: 'ph-test-tube',        hint: 'Lance les tests, diagnostique, ne modifie rien' },
    { name: 'web',       icon: 'ph-globe',            hint: 'Recherche web sur navigateur réel, avec sources' },
    { name: 'pr',        icon: 'ph-git-pull-request', hint: 'Branche, commite et ouvre la pull request' },
];

// Miroir de ``task_tool.RESERVED_AGENT_NAMES``. Depuis la banque d'agents
// (2026-09-11), les noms INTÉGRÉS ne sont plus réservés : une entrée qui porte
// l'un d'eux est une SURCHARGE du modèle livré. Seul « task » reste interdit.
window.ELPIS_RESERVED_AGENT_NAMES = ['task'];
