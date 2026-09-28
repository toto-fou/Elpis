// SPDX-License-Identifier: MIT
// ============================================================================
//  frontend/js/admin/skins.js — console › Système › Apparence (skins)
// ============================================================================
//  Gabarit : includes/admin/tab_appearance.html. Routes : /api/admin/skins*
//  (shared_infra/routes/admin/skins.py). Chaque action est IMMÉDIATE (pas de
//  barre d'enregistrement) : activer, choisir le défaut, importer, exporter,
//  supprimer, enregistrer le formulaire. Après un changement d'état, la liste
//  proposée au compte (menu d'apparence, Paramètres) est relue.
//
//  Le formulaire « Créer » part d'un skin existant : ses jetons sont LUS sur
//  la page (getComputedStyle, classes <body> posées puis retirées dans la
//  même tâche — aucun rendu intermédiaire), en clair et en sombre. Seuls ~20
//  jetons principaux sont éditables ; les autres jetons du skin de départ qui
//  diffèrent d'Ardoise sont recopiés tels quels, pour que le nouveau skin
//  garde une palette cohérente (accent foncé, surfaces teintées…).
// ============================================================================
function setupAdminSkins(vue, sharedRefs, ctx) {
    const { ref, computed } = vue;
    const { showToast, fetchAuth, openConfirm } = ctx;

    // Jetons principaux, dans l'ordre du formulaire. `color: false` = pas de
    // sélecteur de couleur (rayon).
    const SKIN_TOKENS = [
        { k: '--accent',         l: 'Accent' },
        { k: '--accent-fg',      l: 'Sur accent' },
        { k: '--app-bg',         l: 'Fond' },
        { k: '--surface',        l: 'Surface' },
        { k: '--surface-2',      l: 'Surface 2' },
        { k: '--text-900',       l: 'Texte' },
        { k: '--text-700',       l: 'Texte 2' },
        { k: '--text-500',       l: 'Discret' },
        { k: '--border',         l: 'Bordure' },
        { k: '--rail-bg',        l: 'Rail' },
        { k: '--rail-text',      l: 'Texte rail' },
        { k: '--rail-active-bg', l: 'Rail actif' },
        { k: '--ok',             l: 'Succès' },
        { k: '--warn',           l: 'Alerte' },
        { k: '--danger-text',    l: 'Erreur' },
        { k: '--prose-link',     l: 'Lien' },
        { k: '--radius',         l: 'Rayon', color: false },
        { k: '--cl-ink',         l: 'Encre' },
        { k: '--cl-clay',        l: 'Argile' },
        { k: '--cl-muted',       l: 'Sourdine' },
    ];
    const _PRINCIPAUX = new Set(SKIN_TOKENS.map(t => t.k));
    // Rayons dérivés : recalculés par le serveur depuis --radius.
    const _DERIVES = new Set(['--radius-sm', '--radius-md', '--radius-lg', '--radius-xl']);
    // Mêmes interdits que le serveur (skins.py › check_token_value).
    const _VALEUR_OK = (v) => typeof v === 'string' && v.trim() && v.length <= 200
        && !/[;{}<>\\]/.test(v) && !/url\(|@|expression|\/\*|\*\/|image-set|image\(|src\(|javascript:|element\(|cross-fade/i.test(v);

    const skinAdm = ref({ loading: false, loaded: false, error: '', list: [], default: '' });
    const skinAdmBusy = ref('');          // id de l'action en cours
    const skinImportInput = ref(null);
    const skinImportErr = ref('');
    const skinEd = ref(null);             // formulaire ouvert (création / modification)

    const skinAdmPlugins = computed(() => skinAdm.value.list.filter(s => s.source === 'plugin').length);

    async function _json(r) { try { return await r.json(); } catch (_) { return {}; } }
    function _apply(d) {
        if (d && Array.isArray(d.skins)) skinAdm.value.list = d.skins;
        if (d && typeof d.default === 'string') skinAdm.value.default = d.default;
    }
    function _relireCompte() { try { ctx.reloadAppSkins && ctx.reloadAppSkins(); } catch (_) {} }

    async function loadAdminSkins() {
        skinAdm.value.loading = true;
        skinAdm.value.error = '';
        try {
            const r = await fetchAuth('/api/admin/skins');
            if (!r) { skinAdm.value.error = 'Erreur réseau.'; return; }
            const d = await _json(r);
            if (!r.ok) { skinAdm.value.error = d.detail || ('Erreur ' + r.status); return; }
            _apply(d);
            skinAdm.value.loaded = true;
        } finally {
            skinAdm.value.loading = false;
        }
    }

    async function _putState(body, busyId) {
        skinAdmBusy.value = busyId;
        try {
            const r = await fetchAuth('/api/admin/skins', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!r) { showToast('Erreur réseau.', 'error'); return false; }
            const d = await _json(r);
            if (!r.ok) { showToast(d.detail || 'Modification refusée.', 'error'); return false; }
            _apply(d);
            _relireCompte();
            return true;
        } finally {
            skinAdmBusy.value = '';
        }
    }
    function skinToggle(sk) {
        if (sk.locked) return;
        return _putState({ enabled: { [sk.id]: !sk.enabled } }, sk.id);
    }
    function skinSetDefault(sk) {
        if (sk.is_default) return;
        return _putState({ default: sk.id }, sk.id);
    }

    function skinExport(sk) {
        const a = document.createElement('a');
        a.href = '/api/admin/skins/' + encodeURIComponent(sk.id) + '/export';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    async function skinDelete(sk) {
        if (sk.source !== 'plugin') return;
        const ok = await openConfirm('Supprimer « ' + sk.label + ' » ?',
            'Les comptes qui l\'utilisent passeront au skin par défaut.', true, 'Supprimer');
        if (!ok) return;
        skinAdmBusy.value = sk.id;
        try {
            const r = await fetchAuth('/api/admin/skins/' + encodeURIComponent(sk.id), { method: 'DELETE' });
            if (!r) { showToast('Erreur réseau.', 'error'); return; }
            const d = await _json(r);
            if (!r.ok) { showToast(d.detail || 'Suppression refusée.', 'error'); return; }
            _apply(d);
            _relireCompte();
            showToast('Skin supprimé.');
        } finally {
            skinAdmBusy.value = '';
        }
    }

    // ── Import (zip) ─────────────────────────────────────────────────────
    function skinImportPick() {
        skinImportErr.value = '';
        if (skinImportInput.value) skinImportInput.value.click();
    }
    async function _envoyerZip(file, overwrite) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('overwrite', overwrite ? 'true' : 'false');
        return fetchAuth('/api/admin/skins/import', { method: 'POST', body: fd });
    }
    async function skinImportFile(ev) {
        const file = ev && ev.target && ev.target.files && ev.target.files[0];
        if (ev && ev.target) ev.target.value = '';
        if (!file) return;
        skinImportErr.value = '';
        skinAdmBusy.value = '__import';
        try {
            let r = await _envoyerZip(file, false);
            if (r && r.status === 409) {
                const d409 = await _json(r);
                const ok = await openConfirm('Remplacer ?', (d409.detail || 'Ce skin existe déjà.') + ' Son état est conservé.', true, 'Remplacer');
                if (!ok) return;
                r = await _envoyerZip(file, true);
            }
            if (!r) { skinImportErr.value = 'Erreur réseau.'; return; }
            const d = await _json(r);
            if (!r.ok) { skinImportErr.value = d.detail || ('Import refusé (' + r.status + ').'); return; }
            _apply(d);
            const sk = d.skin || {};
            if (sk.id && !sk.enabled) {
                const act = await openConfirm('« ' + (sk.label || sk.id) + ' » importé',
                    'Il est désactivé : aucun compte ne le voit encore.', false, 'Activer', 'Plus tard');
                if (act) await _putState({ enabled: { [sk.id]: true } }, sk.id);
            } else {
                showToast('Skin importé.');
                _relireCompte();
            }
        } finally {
            skinAdmBusy.value = '';
        }
    }

    // ── Formulaire : lecture des jetons d'un skin sur la page ───────────
    // Noms de tous les jetons déclarés par style.css (:root et bloc sombre)
    // et par la feuille d'un skin intégré.
    function _nomsJetons(baseId) {
        const noms = new Set();
        const sels = new Set([':root', 'body.elpis-app-dark', 'body.elpis-dark-surface']);
        const pref = baseId ? 'body.elpis-skin-' + baseId : null;
        for (const sh of Array.from(document.styleSheets)) {
            let rules;
            try { rules = sh.cssRules; } catch (_) { continue; }
            if (!rules) continue;
            for (const r of Array.from(rules)) {
                const sel = r.selectorText || '';
                if (!r.style || !(sels.has(sel) || (pref && sel.indexOf(pref) === 0 && sel.indexOf(' ') < 0))) continue;
                for (let i = 0; i < r.style.length; i++) {
                    const n = r.style[i];
                    if (n.indexOf('--') === 0) noms.add(n);
                }
            }
        }
        SKIN_TOKENS.forEach(t => noms.add(t.k));
        return Array.from(noms);
    }
    // Valeurs calculées sous les classes d'un skin, posées et retirées dans la
    // même tâche : le navigateur ne peint rien entre les deux.
    function _lireJetons(baseId, dark, darkBase, noms) {
        const body = document.body;
        const avant = body.className;
        const out = {};
        try {
            const cls = body.classList;
            Array.from(cls).forEach(c => {
                if (c.indexOf('elpis-skin-') === 0 || c === 'elpis-app-dark' || c === 'elpis-dark-surface') cls.remove(c);
            });
            if (baseId) cls.add('elpis-skin-' + baseId);
            if (dark) cls.add('elpis-app-dark');
            if (dark || darkBase) cls.add('elpis-dark-surface');
            const cs = getComputedStyle(body);
            for (const n of noms) out[n] = (cs.getPropertyValue(n) || '').trim();
        } finally {
            body.className = avant;
        }
        return out;
    }
    // Jetons d'un mode : les principaux toujours, les autres s'ils diffèrent
    // d'Ardoise (et passent la validation du serveur).
    function _jetonsDepuis(baseVals, ardoiseVals) {
        const principaux = {}, autres = {};
        for (const t of SKIN_TOKENS) principaux[t.k] = baseVals[t.k] || ardoiseVals[t.k] || '';
        for (const n in baseVals) {
            if (_PRINCIPAUX.has(n) || _DERIVES.has(n)) continue;
            const v = baseVals[n];
            if (v && v !== ardoiseVals[n] && _VALEUR_OK(v)) autres[n] = v;
        }
        return { principaux, autres };
    }

    // Couleur quelconque → #rrggbb pour <input type=color> (alpha perdu).
    let _ctx2d = null;
    function skinHex(v) {
        try {
            if (!_ctx2d) _ctx2d = document.createElement('canvas').getContext('2d');
            _ctx2d.fillStyle = '#000000';
            _ctx2d.fillStyle = String(v || '').trim();
            const f = _ctx2d.fillStyle;
            if (/^#[0-9a-f]{6}$/i.test(f)) return f;
            const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(f);
            if (m) return '#' + [m[1], m[2], m[3]].map(x => Number(x).toString(16).padStart(2, '0')).join('');
        } catch (_) {}
        return '#000000';
    }

    const skinBases = computed(() => skinAdm.value.list.filter(s => s.source === 'builtin' || s.source === 'plugin'));

    async function _remplirDepuis(ed, baseId) {
        const base = skinAdm.value.list.find(s => s.id === baseId) || { id: '', source: 'builtin' };
        let detail = null;
        if (base.source === 'plugin') {
            const r = await fetchAuth('/api/admin/skins/' + encodeURIComponent(base.id));
            if (r && r.ok) detail = await _json(r);
        }
        const builtinId = base.source === 'builtin' ? base.id : '';
        const noms = _nomsJetons(builtinId);
        const modes = {};
        for (const mode of ['light', 'dark']) {
            const dark = mode === 'dark';
            const ardoise = _lireJetons('', dark, false, noms);
            let vals = _lireJetons(builtinId, dark, !!base.darkBase, noms);
            if (detail && detail.tokens) vals = Object.assign({}, ardoise, detail.tokens[mode] || {});
            modes[mode] = _jetonsDepuis(vals, ardoise);
        }
        ed.tokens = { light: modes.light.principaux, dark: modes.dark.principaux };
        ed.extra = { light: modes.light.autres, dark: modes.dark.autres };
        ed.darkBase = !!base.darkBase;
        ed.swatch = (base.sw && base.sw.length === 3) ? base.sw.slice()
            : [ed.tokens.light['--rail-bg'], ed.tokens.light['--app-bg'], ed.tokens.light['--accent']];
        if (detail && detail.css && !ed.css) ed.css = detail.css;
    }

    async function skinNew() {
        const ed = { mode: 'create', id: '', label: '', description: '', base: skinAdm.value.default || 'elpis',
                     darkBase: false, swatch: ['#0f172a', '#f8fafc', '#2563eb'], tokens: { light: {}, dark: {} },
                     extra: { light: {}, dark: {} }, css: '', brand: '', view: 'light', error: '', saving: false };
        await _remplirDepuis(ed, ed.base);
        skinEd.value = ed;
    }
    async function skinEdBase(baseId) {
        if (!skinEd.value) return;
        skinEd.value.base = baseId;
        await _remplirDepuis(skinEd.value, baseId);
    }
    async function skinEdit(sk) {
        if (sk.source !== 'plugin') return;
        const r = await fetchAuth('/api/admin/skins/' + encodeURIComponent(sk.id));
        if (!r || !r.ok) { showToast('Skin illisible.', 'error'); return; }
        const d = await _json(r);
        const noms = _nomsJetons('');
        const ed = { mode: 'edit', id: d.id, label: d.label, description: d.description || '', base: '',
                     darkBase: !!d.darkBase, swatch: (d.swatch || []).slice(0, 3), tokens: { light: {}, dark: {} },
                     extra: { light: {}, dark: {} }, css: d.css || '', brand: (d.brand && d.brand.name) || '',
                     version: d.version || '', author: d.author || '', license: d.license || '',
                     view: 'light', error: '', saving: false };
        for (const mode of ['light', 'dark']) {
            const ardoise = _lireJetons('', mode === 'dark', false, noms);
            const t = (d.tokens && d.tokens[mode]) || {};
            for (const x of SKIN_TOKENS) ed.tokens[mode][x.k] = t[x.k] || ardoise[x.k] || '';
            for (const n in t) if (!_PRINCIPAUX.has(n)) ed.extra[mode][n] = t[n];
        }
        skinEd.value = ed;
    }
    function skinEdClose() { skinEd.value = null; }

    // Aperçu : les jetons du mode affiché, posés en style inline sur le
    // panneau (échelle des rayons recalculée comme le fera le serveur).
    const skinPreviewStyle = computed(() => {
        const ed = skinEd.value;
        if (!ed) return {};
        const m = ed.view === 'dark' ? 'dark' : 'light';
        const st = Object.assign({}, ed.extra[m] || {}, ed.tokens[m] || {});
        const r = st['--radius'];
        if (r) {
            st['--radius-sm'] = 'calc(' + r + ' - 4px)';
            st['--radius-md'] = 'calc(' + r + ' - 2px)';
            st['--radius-lg'] = r;
            st['--radius-xl'] = 'calc(' + r + ' + 4px)';
        }
        return st;
    });
    const skinEdExtraCount = computed(() => {
        const ed = skinEd.value;
        return ed ? Object.keys(ed.extra.light).length + Object.keys(ed.extra.dark).length : 0;
    });

    async function skinEdSave() {
        const ed = skinEd.value;
        if (!ed || ed.saving) return;
        ed.error = '';
        const tokens = { light: {}, dark: {} };
        for (const m of ['light', 'dark']) {
            Object.assign(tokens[m], ed.extra[m] || {});
            for (const t of SKIN_TOKENS) {
                const v = String(ed.tokens[m][t.k] || '').trim();
                if (v) tokens[m][t.k] = v;
            }
        }
        const body = { id: String(ed.id || '').trim(), label: ed.label, description: ed.description,
                       darkBase: !!ed.darkBase, swatch: ed.swatch, tokens, css: ed.css || '',
                       brand: ed.brand ? { name: ed.brand } : null, update: ed.mode === 'edit' };
        if (ed.mode === 'edit') Object.assign(body, { version: ed.version, author: ed.author, license: ed.license });
        ed.saving = true;
        try {
            const r = await fetchAuth('/api/admin/skins', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (!r) { ed.error = 'Erreur réseau.'; return; }
            const d = await _json(r);
            if (!r.ok) { ed.error = d.detail || ('Refusé (' + r.status + ').'); return; }
            _apply(d);
            skinEd.value = null;
            const sk = d.skin || {};
            if (sk.id && !sk.enabled) {
                const act = await openConfirm('« ' + (sk.label || sk.id) + ' » créé',
                    'Il est désactivé : aucun compte ne le voit encore.', false, 'Activer', 'Plus tard');
                if (act) await _putState({ enabled: { [sk.id]: true } }, sk.id);
            } else {
                showToast('Skin enregistré.');
                _relireCompte();
            }
        } finally {
            ed.saving = false;
        }
    }

    return {
        SKIN_TOKENS, skinAdm, skinAdmBusy, skinAdmPlugins, skinImportInput, skinImportErr,
        skinEd, skinBases, skinPreviewStyle, skinEdExtraCount,
        loadAdminSkins, skinToggle, skinSetDefault, skinExport, skinDelete,
        skinImportPick, skinImportFile, skinNew, skinEdBase, skinEdit, skinEdClose, skinEdSave, skinHex,
    };
}
if (typeof window !== 'undefined') window.setupAdminSkins = setupAdminSkins;
