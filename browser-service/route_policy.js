// SPDX-License-Identifier: MIT
// browser-service/route_policy.js — classe de capacité de chaque route du service et politique de la session sécurisée (pur, sans Playwright).

/** Classes de capacité : lire la page, exécuter du JS fourni, réécrire le trafic, exporter la session, agir, administrer, saisir un secret. */
export const CLASSES = Object.freeze(['read_dom', 'exec_js', 'network_control', 'export', 'gesture', 'admin', 'secret']);

/** Table unique : chaque route déclarée (`MÉTHODE chemin`, tel qu'enregistré dans server.js) et sa classe. */
export const CLASSES_ROUTES = Object.freeze({
    'DELETE /screenshots/:filename': 'admin',
    'GET /health': 'admin',
    'GET /sessions': 'admin',
    'POST /start': 'admin',
    'POST /stop': 'admin',
    'POST /cleanup': 'admin',
    'POST /cleanup_children': 'admin',

    'POST /login_precheck': 'secret',
    'POST /login': 'secret',

    'POST /action': 'gesture',
    'POST /chain': 'gesture',
    'POST /handle_dropdown': 'gesture',
    'POST /dialog': 'gesture',
    'POST /new_tab': 'gesture',
    'POST /switch_tab': 'gesture',
    'POST /close_tab': 'gesture',

    'POST /locator': 'read_dom',
    'GET /smart_inspect': 'read_dom',
    'GET /observe': 'read_dom',
    'POST /element_info': 'read_dom',
    'POST /expect': 'read_dom',
    'POST /wait_for': 'read_dom',
    'POST /wait_for_dynamic': 'read_dom',
    'POST /extract_text': 'read_dom',
    'POST /extract_table': 'read_dom',
    'POST /a11y_audit': 'read_dom',
    'POST /screenshot': 'read_dom',
    'POST /element_screenshot': 'read_dom',
    'GET /network': 'read_dom',
    'GET /list_tabs': 'read_dom',
    'GET /frames': 'read_dom',

    'POST /evaluate': 'exec_js',

    'POST /mock/add': 'network_control',
    'GET /mock/list': 'network_control',
    'POST /mock/clear': 'network_control',
    'POST /mock/remove': 'network_control',

    'POST /print_pdf': 'export',
    'POST /visual': 'export',
    'POST /save_state': 'export',
    'POST /trace_export': 'export',
    'POST /recorder/start': 'export',
    'POST /recorder/stop': 'export',
    'POST /recorder/clear': 'export',
    'GET /recorder/status': 'export',
    'GET /recorder/dump': 'export',
});

/** Classes refusées pendant toute une session sécurisée : JS fourni, trafic réécrit, exports (état, trace, PDF, références visuelles, enregistreur). */
export const REFUSEES_SESSION_SECURISEE = Object.freeze(new Set(['exec_js', 'network_control', 'export']));

const RAISONS = {
    exec_js: 'it would run supplied JavaScript in the page',
    network_control: 'it would stub or rewrite network traffic',
    export: 'it would record or export the session',
};

/** Classe d'une route déclarée (HEAD suit GET) ; `null` si la table ne la connaît pas. */
export function classeRoute(methode, chemin) {
    const m = String(methode || '').toUpperCase() === 'HEAD' ? 'GET' : String(methode || '').toUpperCase();
    return CLASSES_ROUTES[`${m} ${chemin}`] ?? null;
}

/** Refus d'une route sur une session (`null` si elle passe) : connexion en cours (409), classe interdite en session sécurisée ou inconnue (403), saisie d'un secret hors session sécurisée (403). */
export function refusRoute({ classe, route, secure = false, connexionEnCours = false }) {
    if (connexionEnCours) return { statut: 409, corps: {
        error: 'A login is in progress on this session: retry once it has finished.',
        code: 'secret_login_busy', retryable: true,
    } };
    if (secure && (!classe || REFUSEES_SESSION_SECURISEE.has(classe))) return { statut: 403, corps: {
        error: `Secure session: ${String(route || '?').replace(/^\//, '')} is refused (${RAISONS[classe] || 'this route has no capability class'}).`,
        code: 'secret_route_refused',
        fix: 'Use this tool in a normal session (start without secure=true) and never log in with a vault secret there.',
    } };
    if (!secure && classe === 'secret') return { statut: 403, corps: {
        error: 'A login with a vault secret needs a secure session.',
        code: 'secret_route_refused',
        fix: 'Start a secure session (start with secure=true) on the login page, then log in there.',
    } };
    return null;
}

// Clés qui portent un sélecteur (CSS, XPath, moteur Playwright, `selector:` de wait_after), à toute profondeur du corps ou de la requête.
const CLES_SELECTEUR = new Set(['selector', 'by_css', 'by_xpath', 'filter_has', 'target_selector', 'relative_to', 'wait_after', 'wait_for', 'scope']);
const CLES_ATTRIBUT = new Set(['attr', 'attribute']);
const SUR_VALEUR = /\[\s*value\b|@\s*value\b/i;

/** Session sécurisée : refus (400 secret_option_refused) d'un sélecteur ou d'un nom d'attribut qui vise `value` (attribut ou XPath), qui servirait d'oracle sur une valeur de champ ; null sinon. */
export function refusSelecteurValeur(...sources) {
    const refus = (ou) => ({ statut: 400, corps: {
        error: `Secure session: a selector or attribute that reads \`value\` is refused (${ou}).`,
        code: 'secret_option_refused',
        fix: 'Target the field by its label, placeholder, role and name, or another attribute.',
    } });
    const marche = (v, cle, n) => {
        if (n > 8 || v === null || v === undefined) return null;
        if (typeof v === 'string') {
            if (CLES_SELECTEUR.has(cle) && SUR_VALEUR.test(v)) return refus(cle);
            if (CLES_ATTRIBUT.has(cle) && v.trim().toLowerCase() === 'value') return refus(cle);
            if (cle === 'value' && /^\s*attr\s*=\s*value\s*\|/i.test(v)) return refus('attr-equals');
            return null;
        }
        if (typeof v !== 'object') return null;
        for (const [k, x] of Array.isArray(v) ? v.map((x) => [cle, x]) : Object.entries(v)) {
            const r = marche(x, k, n + 1);
            if (r) return r;
        }
        return null;
    };
    for (const src of sources) {
        const r = marche(src, '', 0);
        if (r) return r;
    }
    return null;
}

/** Routes enregistrées (`[[méthode, chemin], …]`) absentes de la table, et entrées de la table sans route : deux listes vides si tout concorde. */
export function ecartsTable(routes) {
    const vues = new Set();
    const sansClasse = [];
    for (const [m, p] of routes) {
        const cle = `${String(m).toUpperCase()} ${p}`;
        vues.add(cle);
        if (!CLASSES_ROUTES[cle]) sansClasse.push(cle);
    }
    const orphelines = Object.keys(CLASSES_ROUTES).filter((k) => !vues.has(k));
    return { sansClasse, orphelines };
}
