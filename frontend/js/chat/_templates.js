// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_templates.js -- Templates de prompt (2026-09-21).
//
//  « /template <nom> » insère un template dans le composeur, après
//  saisie de ses variables. Conception, syntaxe et choix repris
//  des projets de référence (Open WebUI, LibreChat) :
//  docs/templates-prompt-design-2026-09-21.md.
//
//  Deux étages :
//    * fonctions PURES (parse, render, systemValues, validName),
//      exportées pour node (tests/frontend/test_templates.js) et
//      sur ``window.elpisTemplates`` ;
//    * ``setupChatTemplates`` : cache des templates, fenêtre de
//      saisie des variables, insertion AU CURSEUR du composeur.
//
//  Syntaxe (compatible Open WebUI / LibreChat) :
//    {{nom}}                                   champ texte
//    {{nom | textarea}}                        zone multiligne
//    {{nom | select:options=["a","b"]}}        liste
//    {{nom | text:placeholder="…":default="…":required}}
//  Variables SYSTÈME (casse indifférente) : date, heure,
//  date_heure, jour, utilisateur, presse_papier — et leurs alias
//  CURRENT_DATE, CURRENT_TIME, CURRENT_DATETIME, CURRENT_WEEKDAY,
//  USER_NAME, CLIPBOARD, current_user, iso_datetime.
//
//  Le texte est INSÉRÉ, jamais envoyé (même règle que /prompt).
// ============================================================

(function (root) {
    'use strict';

    // Un nom : lettres (accents compris), chiffres, « _ » et « - ».
    var TOKEN_RE = /\{\{\s*([\p{L}\p{N}_-]+)\s*(?:\|\s*([^{}]*?))?\s*\}\}/gu;
    var NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
    var TYPES = { text: 1, textarea: 1, select: 1 };

    // Nom système (minuscules) → clé canonique.
    var SYSTEM = {
        date: 'date', current_date: 'date',
        heure: 'heure', current_time: 'heure',
        date_heure: 'date_heure', current_datetime: 'date_heure',
        jour: 'jour', current_weekday: 'jour',
        utilisateur: 'utilisateur', user_name: 'utilisateur', current_user: 'utilisateur',
        presse_papier: 'presse_papier', clipboard: 'presse_papier',
        iso_datetime: 'iso_datetime',
    };

    function systemKey(name) {
        return SYSTEM[String(name || '').toLowerCase()] || null;
    }

    // Découpe « a:b="x:y":c=[1,2] » sur ``sep`` hors guillemets et crochets.
    function _split(s, sep) {
        var out = [], cur = '', q = null, depth = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s[i];
            if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
            if (c === '"' || c === "'") { q = c; cur += c; continue; }
            if (c === '[') depth++;
            if (c === ']') depth = Math.max(0, depth - 1);
            if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
            cur += c;
        }
        out.push(cur);
        return out.map(function (x) { return x.trim(); }).filter(function (x) { return x; });
    }

    function _value(v) {
        v = String(v == null ? '' : v).trim();
        if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) {
            return v.slice(1, -1);
        }
        if (v[0] === '[') {
            try { var a = JSON.parse(v); if (Array.isArray(a)) return a.map(String); } catch (_) {}
            return v.slice(1, v.endsWith(']') ? -1 : undefined).split(',')
                .map(function (x) { return x.trim().replace(/^["']|["']$/g, ''); })
                .filter(function (x) { return x; });
        }
        return v;
    }

    // « textarea:placeholder="x":required » → { type, placeholder, default, required, options }
    function _definition(def) {
        var spec = { type: 'text', placeholder: '', default: '', required: false, options: [] };
        if (!def) return spec;
        var parts = _split(def, ':');
        if (!parts.length) return spec;
        var first = parts[0];
        var m = first.match(/^type\s*=\s*(.+)$/);
        var type = (m ? _value(m[1]) : first).toLowerCase();
        var rest = parts.slice(1);
        if (!TYPES[type]) {
            // Pas un type connu : si c'est une propriété, on la garde.
            if (first.indexOf('=') > 0 || first === 'required') rest = parts;
            type = 'text';
        }
        spec.type = type;
        rest.forEach(function (p) {
            var i = p.indexOf('=');
            if (i < 0) { if (p.toLowerCase() === 'required') spec.required = true; return; }
            var k = p.slice(0, i).trim().toLowerCase();
            var v = _value(p.slice(i + 1));
            if (k === 'placeholder') spec.placeholder = String(v);
            else if (k === 'default' || k === 'value') spec.default = String(v);
            else if (k === 'options') spec.options = Array.isArray(v) ? v : String(v).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
            else if (k === 'required') spec.required = String(v) !== 'false';
        });
        if (spec.type === 'select' && !spec.options.length) spec.type = 'text';
        return spec;
    }

    // Variables d'un contenu, dans l'ordre de première apparition.
    //   vars   : [{ name, type, placeholder, default, required, options }]
    //            (la PREMIÈRE définition d'un nom l'emporte ; une
    //            répétition ne crée pas de second champ)
    //   system : clés canoniques des variables système utilisées
    function parse(content) {
        var vars = [], seen = {}, system = [];
        var s = String(content == null ? '' : content);
        TOKEN_RE.lastIndex = 0;
        var m;
        while ((m = TOKEN_RE.exec(s)) !== null) {
            var name = m[1];
            var sk = systemKey(name);
            if (sk) { if (system.indexOf(sk) < 0) system.push(sk); continue; }
            var key = name.toLowerCase();
            if (seen[key]) {
                // Définition typée plus loin qu'une première mention nue.
                if (m[2] && vars[seen[key] - 1]._bare) {
                    var d = _definition(m[2]);
                    d.name = vars[seen[key] - 1].name;
                    vars[seen[key] - 1] = d;
                }
                continue;
            }
            var spec = _definition(m[2]);
            spec.name = name;
            if (!m[2]) spec._bare = true;
            vars.push(spec);
            seen[key] = vars.length;
        }
        vars.forEach(function (v) { delete v._bare; });
        return { vars: vars, system: system };
    }

    // Remplace chaque {{…}} : système → ``sys[clé]``, sinon ``values[nom]``
    // (casse du nom indifférente). Une variable sans valeur devient vide.
    function render(content, values, sys) {
        var vals = {};
        Object.keys(values || {}).forEach(function (k) { vals[k.toLowerCase()] = values[k]; });
        return String(content == null ? '' : content).replace(TOKEN_RE, function (all, name) {
            var sk = systemKey(name);
            if (sk) return (sys && sys[sk] != null) ? String(sys[sk]) : '';
            var v = vals[String(name).toLowerCase()];
            return v == null ? '' : String(v);
        });
    }

    // Valeurs système au moment de l'insertion (heure LOCALE, en français).
    function systemValues(opts) {
        opts = opts || {};
        var now = opts.now instanceof Date ? opts.now : new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
        var heure = pad(now.getHours()) + ':' + pad(now.getMinutes());
        var jour = '';
        try { jour = now.toLocaleDateString('fr-FR', { weekday: 'long' }); } catch (_) {}
        return {
            date: date, heure: heure, date_heure: date + ' ' + heure, jour: jour,
            iso_datetime: now.toISOString(),
            utilisateur: String(opts.userName || ''),
            presse_papier: opts.clipboard == null ? '' : String(opts.clipboard),
        };
    }

    function validName(name) { return NAME_RE.test(String(name || '')); }

    var api = { parse: parse, render: render, systemValues: systemValues,
                systemKey: systemKey, validName: validName, SYSTEM_NAMES: Object.keys(SYSTEM) };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.elpisTemplates = api;
})(typeof window !== 'undefined' ? window : this);


// ── Montage côté chat ─────────────────────────────────────────────
// Dépendances : sharedRefs.inputRef / inputMessage (le composeur),
// ctx.fetchAuth, ctx.showToast, ctx.autoResize, ctx.userName (getter),
// ctx.openSettingsTab (« Nouveau template »).
function setupChatTemplates(vue, sharedRefs, ctx) {
    const { ref, reactive, nextTick } = vue;
    const { inputRef, inputMessage } = sharedRefs;
    const T = window.elpisTemplates;

    const templatesAll = ref([]);
    let _cacheAt = 0;
    const CACHE_MS = 30000;
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('templates:changed', function () { _cacheAt = 0; templatesAll.value = []; });
    }

    async function loadTemplates(force) {
        if (!force && Date.now() - _cacheAt < CACHE_MS && templatesAll.value.length) return templatesAll.value;
        try {
            const res = await ctx.fetchAuth('/api/prompt-templates', {}, true);
            if (res && res.ok) {
                templatesAll.value = ((await res.json()).items || []);
                _cacheAt = Date.now();
            }
        } catch (_) { /* silencieux : la liste restera vide */ }
        return templatesAll.value;
    }

    // Fenêtre de saisie des variables.
    const templateFill = reactive({
        open: false, template: null, fields: [], values: {}, error: '', sys: {},
    });

    // Insère ``text`` à la place de la sélection du composeur (ou au curseur).
    function _insert(text) {
        const el = inputRef && inputRef.value;
        const cur = inputMessage.value || '';
        let a = cur.length, b = cur.length;
        if (el && typeof el.selectionStart === 'number') { a = el.selectionStart; b = el.selectionEnd; }
        inputMessage.value = cur.slice(0, a) + text + cur.slice(b);
        const pos = a + text.length;
        nextTick(function () {
            if (inputRef && inputRef.value) {
                inputRef.value.focus();
                try { inputRef.value.setSelectionRange(pos, pos); } catch (_) {}
            }
            ctx.autoResize && ctx.autoResize();
        });
    }

    async function _readClipboard() {
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                return await navigator.clipboard.readText();
            }
        } catch (_) {}
        return null;
    }

    // Ouvre un template : variables système résolues d'abord, puis la
    // fenêtre s'il reste des variables à saisir, sinon insertion directe.
    async function openTemplate(tpl) {
        if (!tpl || !tpl.content) return false;
        // Le menu « / » vient de retirer la commande et replace le curseur
        // au tick suivant : on l'attend, sinon l'insertion se ferait à
        // l'ancienne position.
        await nextTick();
        const info = T.parse(tpl.content);
        let clip = null;
        const fields = info.vars.slice();
        if (info.system.indexOf('presse_papier') >= 0) {
            clip = await _readClipboard();
            // Presse-papiers illisible (contexte non sécurisé, refus) : il
            // devient un champ à remplir plutôt qu'un vide silencieux.
            if (clip == null) fields.unshift({ name: 'presse_papier', type: 'textarea',
                placeholder: 'Collez le texte ici', default: '', required: false, options: [],
                _system: true });
        }
        const sys = T.systemValues({ userName: ctx.userName || '', clipboard: clip });
        if (!fields.length) {
            _insert(T.render(tpl.content, {}, sys));
            return true;
        }
        const values = {};
        fields.forEach(function (f) {
            values[f.name] = f.default || (f.type === 'select' ? (f.options[0] || '') : '');
        });
        Object.assign(templateFill, { open: true, template: tpl, fields, values, error: '', sys });
        nextTick(function () {
            const first = document.querySelector('[data-template-fill] [data-template-field]');
            if (first) first.focus();
        });
        return true;
    }

    function submitTemplateFill() {
        if (!templateFill.open || !templateFill.template) return;
        const missing = templateFill.fields.filter(function (f) {
            return f.required && !String(templateFill.values[f.name] || '').trim();
        });
        if (missing.length) {
            templateFill.error = 'À remplir : ' + missing.map(function (f) { return f.name; }).join(', ');
            return;
        }
        const sys = Object.assign({}, templateFill.sys);
        if (Object.prototype.hasOwnProperty.call(templateFill.values, 'presse_papier')
                && templateFill.fields.some(function (f) { return f._system; })) {
            sys.presse_papier = templateFill.values.presse_papier;
        }
        const text = T.render(templateFill.template.content, templateFill.values, sys);
        cancelTemplateFill();
        _insert(text);
    }

    function cancelTemplateFill() {
        Object.assign(templateFill, { open: false, template: null, fields: [], values: {}, error: '', sys: {} });
        nextTick(function () { if (inputRef && inputRef.value) inputRef.value.focus(); });
    }

    // Entrée valide (Ctrl+Entrée dans une zone multiligne), Échap annule.
    function templateFillKeydown(e, field) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelTemplateFill(); return; }
        if (e.key !== 'Enter' || e.isComposing) return;
        if (field && field.type === 'textarea' && !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        submitTemplateFill();
    }

    // Appel par raccourci (« /template nom »). Rend un résultat de
    // commande pour le menu « / » (cf. _slash.js).
    async function runTemplateByName(name) {
        const key = String(name || '').trim().replace(/^\//, '').toLowerCase();
        if (key === '+') {
            ctx.openSettingsTab && ctx.openSettingsTab('prompts:templates');
            return { ok: true, silent: true };
        }
        const list = await loadTemplates();
        if (!key) {
            return list.length
                ? { ok: false, msg: 'Précisez un template : /template <nom>.' }
                : { ok: true, info: true, msg: 'Aucun template : créez-en un dans Paramètres → Prompts.' };
        }
        const tpl = list.find(function (t) { return String(t.name).toLowerCase() === key; });
        if (!tpl) return { ok: false, msg: 'Template inconnu : ' + key };
        await openTemplate(tpl);
        return { ok: true, silent: true };
    }

    function templateVarsLabel(tpl) {
        if (!tpl) return '';
        const info = T.parse(tpl.content);
        return info.vars.map(function (v) { return v.name; }).join(', ');
    }

    return {
        templatesAll, loadTemplates, openTemplate, runTemplateByName,
        templateFill, submitTemplateFill, cancelTemplateFill, templateFillKeydown,
        templateVarsLabel,
    };
}

if (typeof window !== 'undefined') window.setupChatTemplates = setupChatTemplates;
