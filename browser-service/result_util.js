// SPDX-License-Identifier: MIT
// browser-service/result_util.js — helpers PURS (sans Playwright, sans état)
// partagés par server.js et testables seuls (`npm test`).
//
// Audit tools web 2026-09-05 : ces mises en forme faisaient partie des
// correctifs perdus par le retour de version du 04/09. Les sortir du monolithe
// permet de les verrouiller par un test unitaire Node — la régression n'était
// visible qu'en rejouant une session navigateur complète.
import { celluleRobot } from './recorder_util.js';

/** Hôte d'une URL (host:port), '' si illisible. */
export function hostOf(url) {
    try { return new URL(String(url)).host; } catch (_) { return ''; }
}

/**
 * Compacte un journal console : les messages identiques deviennent UNE ligne
 * suffixée « (×N) », ordonnées par DERNIÈRE apparition. `n` = lignes rendues.
 * Mesuré : 5 à 35 répétitions de `ERR_NAME_NOT_RESOLVED` noyaient le seul
 * avertissement utile de la page.
 */
export function compactConsole(lines, n = 5) {
    const counts = new Map();          // message → occurrences
    const order = [];                  // messages distincts, dernière apparition d'abord
    for (let i = (lines || []).length - 1; i >= 0; i--) {
        const l = String(lines[i]);
        if (!counts.has(l)) { counts.set(l, 0); order.push(l); }
        counts.set(l, counts.get(l) + 1);
    }
    const out = order.slice(0, Math.max(1, n)).map(l => {
        const c = counts.get(l);
        return c > 1 ? `${l} (×${c})` : l;
    });
    return out.reverse();
}

/**
 * Résumé d'un journal réseau : filtre (types, sous-chaîne d'URL), `by_host`
 * sur TOUT ce qui matche, puis plafonne à `last` entrées en gardant D'ABORD
 * les documents et les appels same-origin (ce que le modèle cherche : le POST
 * du formulaire, la redirection, la page atteinte) et le bruit tiers ensuite.
 */
export function summarizeNetwork(logs, { last = 50, filter = '', types = null } = {}) {
    let l = Array.isArray(logs) ? logs : [];
    if (types && types.size) l = l.filter(e => types.has(e.type));
    if (filter) l = l.filter(e => String(e.url || '').includes(filter));
    const total = l.length;
    const by_host = {};
    for (const e of l) {
        const h = e.host || hostOf(e.url) || '(unknown)';
        by_host[h] = (by_host[h] || 0) + 1;
    }
    const n = Math.max(1, Math.min(parseInt(last, 10) || 50, 300));
    let picked = l, prioritized = false;
    if (l.length > n) {
        prioritized = true;
        const isPrio = e => e.type === 'document' || e.same_origin === true;
        const prio = l.filter(isPrio), rest = l.filter(e => !isPrio(e));
        picked = prio.slice(-n);
        if (picked.length < n) picked = picked.concat(rest.slice(-(n - picked.length)));
        picked = picked.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    }
    return { logs: picked, count: picked.length, total, by_host, prioritized };
}

function _q(v) {
    return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
function _escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Expression Playwright LISIBLE correspondant aux paramètres de résolution
 * (`by_*`, `ref`, `selector`, `nth`, `filter_has_text`) — ce que le service a
 * réellement utilisé. Miroir de resolveOfficialLocator : name est un RegExp
 * insensible à la casse sauf `exact`.
 */
export function describeLocator(params, { first = true, scope = 'page' } = {}) {
    const p = params || {};
    let expr;
    if (p.ref) expr = `ref(${_q(p.ref)})`;
    else if (p.by_role) {
        const name = p.by_name
            ? (p.exact ? _q(p.by_name) : `/${_escapeRegex(p.by_name)}/i`)
            : null;
        expr = `${scope}.getByRole(${_q(p.by_role)}${name ? `, { name: ${name} }` : ''})`;
    }
    else if (p.by_text) expr = `${scope}.getByText(${_q(p.by_text)})`;
    else if (p.by_label) expr = `${scope}.getByLabel(${_q(p.by_label)})`;
    else if (p.by_placeholder) expr = `${scope}.getByPlaceholder(${_q(p.by_placeholder)})`;
    else if (p.by_alt) expr = `${scope}.getByAltText(${_q(p.by_alt)})`;
    else if (p.by_title) expr = `${scope}.getByTitle(${_q(p.by_title)})`;
    else if (p.by_test_id) expr = `${scope}.getByTestId(${_q(p.by_test_id)})`;
    else if (p.by_css) expr = `${scope}.locator(${_q(p.by_css)})`;
    else if (p.by_xpath) expr = `${scope}.locator(${_q('xpath=' + p.by_xpath)})`;
    else if (p.selector) expr = `${scope}.locator(${_q(p.selector)})`;
    else return null;
    if (p.filter_has_text) expr += `.filter({ hasText: ${_q(p.filter_has_text)} })`;
    if (p.nth !== undefined && p.nth !== null && p.nth >= 0) expr += `.nth(${p.nth})`;
    else if (first && !p.ref) expr += '.first()';
    return expr;
}

/**
 * Argument de sélection d'un événement `select` enregistré, par format.
 * L'événement porte l'option RÉELLEMENT choisie (`selected:{value,label}`,
 * posée par selectOptionSmart) — plus jamais `selectOption('')`.
 */
export function selectOptionArg(evt, fmt = 'playwright') {
    const e = evt || {};
    const sel = e.selected || {};
    const label = e.option_label ?? sel.label;
    const hasValue = v => v !== undefined && v !== null && v !== '';
    const value = hasValue(e.option_value) ? e.option_value : (hasValue(sel.value) ? sel.value : e.value);
    if (fmt === 'playwright') {
        if (hasValue(label)) return `{ label: ${_q(label)} }`;
        if (hasValue(value)) return `{ value: ${_q(value)} }`;
        return `''`;
    }
    if (fmt === 'cypress') return _q(hasValue(label) ? label : (hasValue(value) ? value : ''));
    if (fmt === 'robot') {
        if (hasValue(label)) return `label    ${celluleRobot(label)}`;
        return `value    ${celluleRobot(hasValue(value) ? value : '')}`;
    }
    return hasValue(label) ? String(label) : (hasValue(value) ? String(value) : '');
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Texte sans séquences ANSI (couleurs des journaux d'appel de Playwright). */
export function sansAnsi(texte) {
    return String(texte ?? '').replace(ANSI, '');
}

// Code stable d'un message d'erreur sans code : motif connu, sinon `browser_error` (jamais un morceau du message).
const CODES_MESSAGE = [
    [/^Navigation (échouée|failed)|net::ERR_|NS_ERROR_|NS_BINDING_/, 'navigation_failed'],
    [/^Adresse refusée par la politique|^URL blocked/i, 'url_blocked'],
    [/No <option> matching|^Option .+ (introuvable|not found)/, 'option_not_found'],
    [/is not a native <select>/, 'not_a_select'],
    [/select requires option_value/, 'option_required'],
    [/strict mode violation/, 'ambiguous_target'],
    [/^Ref expired or invalid/, 'ref_expired'],
    [/Timeout \d+ms exceeded|TimeoutError/, 'timeout'],
    [/Target (page, context or browser )?(has been )?closed|Browser has been closed/, 'page_closed'],
    [/not attached to the DOM|Element is detached/i, 'element_detached'],
    [/element is not visible/i, 'element_not_visible'],
    [/element is not enabled|element is disabled/i, 'element_disabled'],
    [/^Unknown chain action|^Type d'action inconnu|incompatible avec API Playwright/, 'unknown_action'],
    [/^actions\[\] required/, 'actions_required'],
    [/^Max \d+ actions per chain/, 'too_many_actions'],
    [/^No target: provide/, 'target_required'],
    [/^fill failed/, 'fill_failed'],
    [/^smartClick failed/, 'click_failed'],
    [/^drag failed/, 'drag_failed'],
    [/^Unknown assertion/, 'unknown_assertion'],
    [/^script \(string\) required/, 'script_required'],
    [/^(page|frame)\.evaluate: /, 'script_error'],
    [/^Session (introuvable|not found)/i, 'session_not_found'],
    [/^Session expir/i, 'session_expired'],
    [/^File d'attente de la session pleine|^Session occupée/, 'session_busy'],
    [/PDF generation is only supported|Printing is not available/i, 'pdf_unsupported'],
    [/Cannot (read|set) propert|is not a function|is not iterable|is not defined|undefined is not|null is not/, 'internal_error'],
];

/** Code machine court d'une erreur du service : code déjà propre gardé, sinon table des messages, sinon `browser_error`. */
export function codeErreur(message) {
    const m = sansAnsi(message).trim();
    if (/^[a-z][a-z0-9_]*$/.test(m)) return m;
    for (const [motif, code] of CODES_MESSAGE) if (motif.test(m)) return code;
    return 'browser_error';
}

/** Racines du serveur à masquer, la plus longue d'abord : motif (racine en début de chemin, pas dans une URL, suivie de `/` ou d'une fin de nom) et remplacement. */
export function racinesMasquees({ base = '', home = '' } = {}) {
    const out = [];
    for (const [r0, rempl] of [[base, ''], [home, '~']]) {
        const r = String(r0 || '').replace(/\/+$/, '');
        if (!r) continue;
        out.push({ n: r.length, motif: new RegExp(`(?<![\\w.~%\\]-])${_escapeRegex(r)}(?:/|(?![\\w.-]))`, 'g'), rempl });
    }
    return out.sort((a, b) => b.n - a.n);
}

// Clés dont la valeur vient du service (message, chemin de l'hôte), jamais de la page ; `result` (evaluate) n'est jamais parcouru.
const CLES_MESSAGES = new Set(['error', 'fix', 'warning', 'nav_warning', 'hint', 'note', 'tab_hint', 'fail_reason']);
const estCleService = (k) => CLES_MESSAGES.has(k) || k === 'path' || k.endsWith('_path');

/** Réponse JSON sans séquences ANSI ni chemins du serveur (dossier du service rendu relatif, dossier personnel en `~/`) dans ses messages et ses chemins ; contenu de la page et objets non simples (Date, URL) intacts. */
export function nettoyerSortie(valeur, racines = [], profondeur = 0, cle = '') {
    if (typeof valeur === 'string') {
        if (!estCleService(cle)) return valeur;
        let s = valeur.includes('\x1b') ? sansAnsi(valeur) : valeur;
        for (const { motif, rempl } of racines)
            s = s.replace(motif, (m) => (m.endsWith('/') ? (rempl ? `${rempl}/` : '') : (rempl || '.')));
        return s;
    }
    if (profondeur > 40 || valeur === null || typeof valeur !== 'object') return valeur;
    if (Array.isArray(valeur)) return valeur.map(v => nettoyerSortie(v, racines, profondeur + 1, cle));
    const proto = Object.getPrototypeOf(valeur);
    if (proto !== Object.prototype && proto !== null) return valeur;
    const out = {};
    for (const [k, v] of Object.entries(valeur)) out[k] = k === 'result' ? v : nettoyerSortie(v, racines, profondeur + 1, k);
    return out;
}

/** Corps d'une réponse d'erreur : `code` stable ajouté s'il manque (sauf 404/410 sans code, enveloppes de session du client). */
export function normaliserErreur(corps, status) {
    if (status < 400 || !corps || typeof corps !== 'object' || Array.isArray(corps)) return corps;
    if (typeof corps.error !== 'string' || (typeof corps.code === 'string' && corps.code)) return corps;
    if (status === 404 || status === 410) return corps;
    return { ...corps, code: corps.status === 'nav_error' ? 'navigation_failed' : codeErreur(corps.error) };
}

const ROLES_CIBLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell',
]);

/** Nœuds `{role, name}` actionnables d'un instantané ARIA de Playwright (`locator.ariaSnapshot()`), sans doublon. */
export function noeudsAria(yaml) {
    const out = [];
    const vus = new Set();
    for (const ligne of String(yaml || '').split('\n')) {
        let s = ligne.trim();
        if (!s.startsWith('- ')) continue;
        s = s.slice(2);
        if (s.startsWith("'")) {
            const fin = s.lastIndexOf("'");
            if (fin <= 0) continue;
            s = s.slice(1, fin).replace(/''/g, "'");
        }
        const m = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(s);
        if (!m || !ROLES_CIBLES.has(m[1])) continue;
        let name = m[2] || '';
        try { name = JSON.parse(`"${name}"`); } catch (_) { /* nom gardé tel quel */ }
        const cle = `${m[1]}\u0000${name}`;
        if (vus.has(cle)) continue;
        vus.add(cle);
        out.push({ role: m[1], name });
    }
    return out;
}

function _plat(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function _distance(a, b) {
    let prec = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const cour = [i];
        for (let j = 1; j <= b.length; j++)
            cour[j] = Math.min(prec[j] + 1, cour[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prec = cour;
    }
    return prec[b.length];
}

/** Ressemblance de deux noms entre 0 et 1 : accents et casse ignorés ; égalité, inclusion, mots communs, distance d'édition. */
export function ressemblance(a, b) {
    const x = _plat(a).slice(0, 80), y = _plat(b).slice(0, 80);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return 0.8;
    const mx = new Set(x.split(' ')), my = y.split(' ');
    const communs = my.filter(w => w.length > 2 && mx.has(w)).length;
    const mots = communs ? 0.5 + 0.3 * communs / Math.max(mx.size, my.length) : 0;
    return Math.max(mots, 1 - _distance(x, y) / Math.max(x.length, y.length));
}

// `|` qui séparerait deux clés du DSL des cibles (packages/navigateur, parseTargetDsl) : non échappé, suivi d'une clé connue et de `=`.
const SEPARATEUR_DSL = /(?<!\\)\|(?=\s*(?:role|name|text|label|placeholder|test_id|css|xpath|ref|alt|title|nth)\s*=)/gi;

/** Valeur insérée dans une cible DSL : un `|` qui y annoncerait une clé est échappé (`\|`), les autres restent lisibles. */
export function echapperDsl(valeur) {
    return String(valeur ?? '').replace(SEPARATEUR_DSL, '\\|');
}

/** Valeur entre guillemets doubles d'un sélecteur CSS ou Playwright : antislash et guillemet échappés (comme Playwright). */
export function echapperCss(valeur) {
    return String(valeur ?? '').replace(/[\\"]/g, '\\$&');
}

/** Littéral XPath 1.0, qui n'a pas d'échappement : entre apostrophes, entre guillemets, sinon concat(). */
export function litteralXPath(valeur) {
    const s = String(valeur ?? '');
    if (!s.includes("'")) return `'${s}'`;
    if (!s.includes('"')) return `"${s}"`;
    return `concat('${s.split("'").join(`', "'", '`)}')`;
}

/** Cibles proposées pour une cible introuvable : noms proches d'abord (même rôle avantagé), sinon les éléments du rôle demandé. */
export function classerSuggestions(noeuds, { name = '', role = '' } = {}, max = 5) {
    const cible = (n) => ({ role: n.role, name: n.name, target: n.name ? `role=${n.role}|name=${echapperDsl(n.name)}` : `role=${n.role}` });
    const liste = Array.isArray(noeuds) ? noeuds : [];
    if (name) {
        const notes = liste.map(n => ({ n, s: ressemblance(name, n.name) + (role && n.role === role ? 0.1 : 0) }))
            .filter(x => x.s >= 0.5).sort((a, b) => b.s - a.s);
        if (notes.length) return notes.slice(0, max).map(x => cible(x.n));
    }
    const memeRole = role ? liste.filter(n => n.role === role) : [];
    return (memeRole.length ? memeRole : liste).slice(0, max).map(cible);
}
