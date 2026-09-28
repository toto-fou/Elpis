// SPDX-License-Identifier: MIT
// browser-service/result_util.js — helpers PURS (sans Playwright, sans état)
// partagés par server.js et testables seuls (`npm test`).
//
// Audit tools web 2026-09-05 : ces mises en forme faisaient partie des
// correctifs perdus par le retour de version du 04/09. Les sortir du monolithe
// permet de les verrouiller par un test unitaire Node — la régression n'était
// visible qu'en rejouant une session navigateur complète.

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
        if (hasValue(label)) return `label    ${label}`;
        return `value    ${hasValue(value) ? value : ''}`;
    }
    return hasValue(label) ? String(label) : (hasValue(value) ? String(value) : '');
}
