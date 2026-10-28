// SPDX-License-Identifier: MIT
// secret_util.js — session sécurisée du navigateur : garde centrale des routes et des cibles, saisie d'un secret du coffre
// (origine du frame, type du champ, cible visible unique), masquage des captures, purge des valeurs dans les réponses.

/** Attribut posé sur les champs qui ont reçu un secret ou qui ont été un champ mot de passe (masqués des captures et des lectures de valeur). */
export const MARQUE = 'data-elpis-secret';
export const SELECTEUR_MASQUE = `input[type="password" i], [${MARQUE}]`;
export const CHAMPS_SECRET = new Set(['password', 'username']);

/** `scheme://host[:port]` d'une adresse http(s) (WHATWG), `null` sinon. */
export function origineDe(adresse) {
    if (typeof adresse !== 'string' || !adresse.trim() || !URL.canParse(adresse.trim())) return null;
    const u = new URL(adresse.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin === 'null' ? null : u.origin;
}

/** Texte dont chaque occurrence de la valeur est remplacée (appel Playwright recopié dans un message d'erreur). */
export function masquerValeur(texte, valeur) {
    const t = typeof texte === 'string' ? texte : String(texte ?? '');
    return valeur ? t.split(valeur).join('[secret]') : t;
}

export function erreurSecret(code, message, statut = 403, fix = null) {
    const e = new Error(message);
    e.code = code;
    e.statut = statut;
    if (fix) e.details = { fix };
    return e;
}

// ── Garde de la session sécurisée ───────────────────────────────────────

/**
 * Routes (déclarées, `req.route.path`) permises en session sécurisée : liste blanche. Tout le reste (JavaScript fourni, trafic réécrit,
 * presse-papiers, états, PDF, enregistreur, glisser, lecture d'un élément par sélecteur…) est refusé, quelle que soit la graphie du chemin.
 */
const ROUTES_AUTORISEES = new Set([
    '/login', '/login_precheck', '/action', '/chain', '/locator', '/locate', '/find_elements', '/expect', '/wait_for', '/wait_for_dynamic',
    '/smart_inspect', '/inspect', '/observe', '/screenshot', '/element_screenshot', '/visual', '/extract_text', '/extract_table',
    '/a11y_audit', '/new_tab', '/switch_tab', '/close_tab', '/list_tabs', '/frames', '/network', '/dialog', '/handle_next_dialog', '/stop',
]);

/** Clés de cible brute (CSS, XPath, DSL Playwright) : jamais acceptées en session sécurisée. */
const CLES_BRUTES = ['selector', 'xpath', 'css', 'by_css', 'by_xpath', 'filter_has', 'target_selector', 'tag', 'scope'];
const CLES_SEMANTIQUES = ['ref', 'by_role', 'by_text', 'by_label', 'by_placeholder', 'by_test_id', 'by_alt', 'by_title'];
const CLES_TEXTE = ['by_name', 'by_text', 'by_label', 'by_placeholder', 'by_test_id', 'by_alt', 'by_title', 'filter_has_text'];
const FORME_ROLE = /^[a-z][a-z-]{1,40}$/;
const FORME_REF = /^loc_[a-z0-9]{1,20}(#\d{1,4})?$/;

const present = (v) => v !== undefined && v !== null && v !== '';

function refus(code, message, fix, statut = 403) {
    return { statut, corps: { error: message, code, fix } };
}

const FIX_SEMANTIQUE =
    "Ciblez par rôle et nom (role=button|name=…), label, placeholder, texte, test_id, alt, title, ou par ref d'un pw_find / pw_page inspect ; jamais css= ni xpath=.";

const MODIFICATEURS = new Set(['control', 'ctrl', 'meta', 'command', 'cmd', 'controlormeta']);
const TOUCHES_PRESSE_PAPIERS = new Set(['a', 'c', 'x', 'v', 'insert']);

/** Raccourci qui copie, coupe, colle ou sélectionne tout (Contrôle ou Méta + a c x v Insert, Maj + Insert ou Suppr). */
export function estRaccourciPressePapiers(touche) {
    if (typeof touche !== 'string') return false;
    const t = touche.split('+').map((x) => x.trim().toLowerCase());
    const derniere = t[t.length - 1];
    const mods = t.slice(0, -1);
    if (mods.some((m) => MODIFICATEURS.has(m)) && TOUCHES_PRESSE_PAPIERS.has(derniere)) return true;
    return mods.includes('shift') && (derniere === 'insert' || derniere === 'delete');
}

function refusGeste(o) {
    const geste = String(o.type || o.action || '').toLowerCase();
    if (geste === 'drag')
        return refus('secure_session_gesture_refused', 'Session sécurisée : le glisser-déposer est refusé.', 'Utilisez click, fill, press, select…');
    const touches = [o.key];
    if (geste === 'press') touches.push(o.text, o.value);
    if (touches.some(estRaccourciPressePapiers))
        return refus('secure_session_gesture_refused', 'Session sécurisée : copier, couper, coller et tout sélectionner sont refusés.', 'Ne manipulez pas le presse-papiers ; pw_login saisit les identifiants.');
    return null;
}

function verifierCibles(o, retirerRepli, profondeur = 0) {
    if (!o || typeof o !== 'object' || profondeur > 4) return null;
    if (Array.isArray(o)) {
        for (const x of o) {
            const e = verifierCibles(x, retirerRepli, profondeur + 1);
            if (e) return e;
        }
        return null;
    }
    const semantique = CLES_SEMANTIQUES.some((k) => present(o[k]));
    const geste = refusGeste(o);
    if (geste) return geste;
    for (const k of CLES_BRUTES) {
        if (!present(o[k])) continue;
        if (k === 'scope' && o[k] === 'body') continue;
        // Le repli `selector` accompagne toujours une cible sémantique côté hôte d'outils : il est retiré, jamais suivi.
        if (k === 'selector' && semantique && retirerRepli) {
            delete o[k];
            continue;
        }
        return refus('secure_session_selector_refused', `Session sécurisée : la cible brute (${k}) est refusée.`, FIX_SEMANTIQUE);
    }
    if (typeof o.to === 'string' && present(o.to))
        return refus('secure_session_selector_refused', 'Session sécurisée : la destination brute (to) est refusée.', FIX_SEMANTIQUE);
    if (present(o.by_role) && (typeof o.by_role !== 'string' || !FORME_ROLE.test(o.by_role)))
        return refus('secure_session_invalid_target', 'Session sécurisée : by_role doit être un rôle ARIA simple (button, textbox, link…).', FIX_SEMANTIQUE, 400);
    for (const k of CLES_TEXTE)
        if (present(o[k]) && typeof o[k] !== 'string')
            return refus('secure_session_invalid_target', `Session sécurisée : ${k} doit être un texte.`, FIX_SEMANTIQUE, 400);
    if (present(o.ref) && (typeof o.ref !== 'string' || !FORME_REF.test(o.ref)))
        return refus('secure_session_invalid_target', 'Session sécurisée : ref doit venir de pw_find / pw_page inspect (loc_…).', FIX_SEMANTIQUE, 400);
    if (present(o.nth) && !(Number.isInteger(o.nth) && o.nth >= 0))
        return refus('invalid_nth', 'nth doit être un entier positif ou nul.', 'Passez nth=0, 1, 2… ou omettez-le.', 400);
    for (const v of Object.values(o)) {
        if (v && typeof v === 'object') {
            const e = verifierCibles(v, retirerRepli, profondeur + 1);
            if (e) return e;
        }
    }
    return null;
}

/**
 * Garde centrale d'une requête sur une session sécurisée : route interdite, cible brute, cible mal formée.
 * Retire le repli `selector` quand une cible sémantique l'accompagne. `null` si la requête passe.
 */
export function gardeSessionSecurisee(req) {
    const route = req.route && typeof req.route.path === 'string' ? req.route.path : req.path;
    if (!ROUTES_AUTORISEES.has(route))
        return refus(
            'secure_session_route_refused',
            `Session sécurisée : ${String(route).replace(/^\//, '')} est refusé (il exécuterait du code fourni, réécrirait le trafic, toucherait au presse-papiers, lirait une valeur ou enregistrerait la session).`,
            "Fermez la session (pw_session stop) et ouvrez-en une normale pour cet outil, sans y saisir d'identifiant.",
        );
    return verifierCibles(req.body, true) || verifierCibles(req.query, false);
}

// ── Purge des valeurs dans les réponses ─────────────────────────────────

const LONGUEUR_MIN_PURGE = 3;

/** Formes sous lesquelles une valeur peut revenir (brute, URL, formulaire, HTML, JSON, base64 standard, sans bourrage et URL). */
export function formesSecret(v) {
    if (typeof v !== 'string' || v.length < LONGUEUR_MIN_PURGE) return [];
    const b64 = Buffer.from(v, 'utf8').toString('base64');
    const out = new Set([v, b64, b64.replace(/=+$/, ''), Buffer.from(v, 'utf8').toString('base64url')]);
    try {
        const url = encodeURIComponent(v);
        out.add(url);
        out.add(url.replaceAll('%20', '+'));
        out.add(new URLSearchParams({ x: v }).toString().slice(2));
        out.add(encodeURI(v));
    } catch {}
    out.add(v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'));
    out.add(JSON.stringify(v).slice(1, -1));
    return [...out].filter((x) => x.length >= LONGUEUR_MIN_PURGE);
}

/** Enregistre les valeurs d'une session : formes à purger, valeurs brutes (masque des captures, détection d'un champ resté plein) et `user:pass` de l'authentification HTTP Basic. */
export function retenirValeurs(session, valeurs, { basic = null } = {}) {
    if (!session._valeursSecretes) session._valeursSecretes = new Set();
    if (!session._secretsBruts) session._secretsBruts = new Set();
    for (const v of valeurs) {
        if (typeof v !== 'string' || !v) continue;
        session._secretsBruts.add(v);
        for (const f of formesSecret(v)) session._valeursSecretes.add(f);
    }
    if (basic) for (const f of formesSecret(`${basic.username}:${basic.password}`)) session._valeursSecretes.add(f);
}

/** Copie de la charge JSON dont chaque forme d'une valeur retenue (textes et clés) est remplacée par `[secret]`. */
export function purgerValeurs(charge, session) {
    const formes = session && session._valeursSecretes ? [...session._valeursSecretes].sort((a, b) => b.length - a.length) : [];
    if (!formes.length) return charge;
    const texte = (t) => {
        let s = t;
        for (const f of formes) if (s.includes(f)) s = s.split(f).join('[secret]');
        return s;
    };
    const marche = (v) => {
        if (typeof v === 'string') return texte(v);
        if (Array.isArray(v)) return v.map(marche);
        if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null))
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [texte(k), marche(x)]));
        return v;
    };
    return marche(charge);
}

/** Texte purgé AVANT toute coupure ou comparaison (adresse, titre, message d'erreur). */
export function purgerTexte(texte, session) {
    return purgerValeurs(typeof texte === 'string' ? texte : String(texte ?? ''), session);
}

/** Ce texte (valeur d'un champ) contient-il une valeur secrète brute de la session ? */
export function contientSecret(texte, session) {
    if (typeof texte !== 'string' || !texte || !session || !session._secretsBruts) return false;
    for (const v of session._secretsBruts) if (v.length >= LONGUEUR_MIN_PURGE ? texte.includes(v) : texte === v) return true;
    return false;
}

/** Une requête sortante porte-t-elle une valeur secrète (adresse ou corps, sous toutes ses formes) ? */
export function requetePorteSecret(url, corps, session) {
    if (!session || !session._valeursSecretes || !session._valeursSecretes.size) return false;
    for (const f of session._valeursSecretes) if ((url && url.includes(f)) || (corps && corps.includes(f))) return true;
    return false;
}

// ── Marquage des champs, presse-papiers, formulaires, captures ──────────

/**
 * Script d'initialisation (tous les frames d'un contexte sécurisé) : marque tout champ qui est ou a été de type password même si la page
 * change son type ensuite ; annule copier, couper, coller et glisser sur un champ marqué ; vide les champs marqués au départ de la page et
 * à sa restauration (cache avant/arrière) ; annule la soumission d'un formulaire à champ marqué qui ferait un GET ou partirait vers une autre origine.
 */
export function initialisationSecurisee() {
    const M = 'data-elpis-secret';
    const estMdp = (v) => String(v || '').trim().toLowerCase() === 'password';
    const marquer = (el) => {
        try {
            el.setAttribute(M, '1');
        } catch {}
    };
    const balayer = (racine) => {
        try {
            racine.querySelectorAll('input[type="password" i]').forEach(marquer);
        } catch {}
    };
    const observer = new MutationObserver((lots) => {
        for (const m of lots) {
            if (m.type === 'attributes') {
                if (m.target.tagName === 'INPUT' && (estMdp(m.oldValue) || estMdp(m.target.getAttribute('type')))) marquer(m.target);
            } else {
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    if (n.tagName === 'INPUT' && estMdp(n.getAttribute('type'))) marquer(n);
                    balayer(n);
                }
            }
        }
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
    document.addEventListener('DOMContentLoaded', () => balayer(document), { once: true });
    balayer(document);
    const marque = (el) => Boolean(el && el.nodeType === 1 && (el.hasAttribute(M) || (el instanceof HTMLInputElement && el.type === 'password')));
    const bloquer = (ev) => {
        if (marque(ev.target) || marque(document.activeElement)) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
        }
    };
    for (const t of ['copy', 'cut', 'paste', 'dragstart']) window.addEventListener(t, bloquer, true);
    const vider = () => {
        try {
            document.querySelectorAll('[' + M + ']').forEach((el) => {
                if ('value' in el) el.value = '';
            });
        } catch {}
    };
    window.addEventListener('pagehide', vider, true);
    window.addEventListener('pageshow', (ev) => { if (ev.persisted) vider(); }, true);
    window.addEventListener('submit', (ev) => {
        const f = ev.target;
        if (!(f instanceof HTMLFormElement) || ev.defaultPrevented || !Array.from(f.elements).some(marque)) return;
        const sub = ev.submitter;
        const methode = String((sub && sub.formMethod) || f.method || 'get').toLowerCase();
        let autre = false;
        try {
            autre = new URL((sub && sub.formAction) || f.action, location.href).origin !== location.origin;
        } catch {
            autre = true;
        }
        if (methode !== 'post' || autre) ev.preventDefault();
    }, false);
}

/** Contexte sécurisé → session (valeurs brutes lues à chaque capture). */
const contextesSecurises = new WeakMap();
let masquageInstalle = false;

const PLAFOND_CHAMPS_LUS = 150;

/** Masques d'une capture : champs marqués ou mot de passe, champs dont la valeur (lue côté Node) contient un secret, textes qui en contiennent un. */
async function masques(page, session) {
    const sortie = [];
    for (const f of page.frames()) {
        sortie.push(f.locator(SELECTEUR_MASQUE));
        const secrets = session && session._secretsBruts ? [...session._secretsBruts] : [];
        if (!secrets.length) continue;
        try {
            const champs = await f.locator('input, textarea').all();
            for (const c of champs.slice(0, PLAFOND_CHAMPS_LUS)) {
                const v = await c.inputValue({ timeout: 300 }).catch(() => null);
                if (contientSecret(v, session)) sortie.push(c);
            }
        } catch {}
        for (const v of secrets) if (v.length >= LONGUEUR_MIN_PURGE) sortie.push(f.getByText(v));
    }
    return sortie;
}

/** Les captures (page ou élément) de ce contexte masquent les champs sensibles, quel que soit leur point d'appel. */
export function securiserCaptures(context, page, session) {
    contextesSecurises.set(context, session);
    if (masquageInstalle) return;
    masquageInstalle = true;
    const protoPage = Object.getPrototypeOf(page);
    const protoLocator = Object.getPrototypeOf(page.locator('body'));
    const ajouter = async (opts, p, sess) => ({ ...(opts || {}), mask: [...((opts && opts.mask) || []), ...(await masques(p, sess))], maskColor: '#000000' });
    const pageScreenshot = protoPage.screenshot;
    protoPage.screenshot = async function (opts) {
        const sess = contextesSecurises.get(this.context());
        return pageScreenshot.call(this, sess ? await ajouter(opts, this, sess) : opts);
    };
    const locatorScreenshot = protoLocator.screenshot;
    protoLocator.screenshot = async function (opts) {
        const sess = contextesSecurises.get(this.page().context());
        return locatorScreenshot.call(this, sess ? await ajouter(opts, this.page(), sess) : opts);
    };
}

// ── Contrôle des champs ─────────────────────────────────────────────────

const TYPES_IDENTIFIANT = new Set(['text', 'email', 'tel', 'url', 'search', 'number']);

/** Élément unique parmi les VISIBLES (un champ masqué par CSS ne compte pas) ; `nth` compte parmi eux. Poignée à libérer par l'appelant. */
export async function choisirVisible(candidats, { timeout, nth = null }) {
    const visibles = candidats.filter({ visible: true });
    let n = await visibles.count().catch(() => 0);
    for (const fin = Date.now() + Math.min(timeout, 1500); n === 0 && Date.now() < fin; ) {
        await new Promise((r) => setTimeout(r, 150));
        n = await visibles.count().catch(() => 0);
    }
    if (n === 0)
        throw erreurSecret(
            'secret_target_not_visible',
            "Aucun élément visible ne correspond : un champ masqué par CSS n'est pas une cible valable.",
            404,
            "Ciblez l'élément affiché à l'écran (rôle, label, placeholder) et attendez qu'il le soit.",
        );
    if (n > 1 && nth === null)
        throw erreurSecret('ambiguous_target', `${n} éléments visibles correspondent : refus.`, 409, 'Précisez la cible (label, placeholder, nth=K ou un ref de pw_find).');
    if (nth !== null && nth >= n) throw erreurSecret('element_not_found', `nth=${nth} mais ${n} élément(s) visible(s) seulement.`, 404);
    const h = await (nth === null ? visibles.first() : visibles.nth(nth)).elementHandle({ timeout });
    if (!h) throw erreurSecret('element_not_found', 'Élément introuvable.', 404);
    return h;
}

/**
 * Contrôle d'un champ avant tout secret (sans valeur) : visible et unique, frame, type réel (propriété, pas attribut), éditable.
 * Renvoie la poignée et l'origine du frame ; l'appelant la libère.
 */
export async function controlerChamp(candidats, { champ, timeout, nth = null }) {
    const h = await choisirVisible(candidats, { timeout, nth });
    try {
        const frame = await h.ownerFrame();
        const origine = frame ? origineDe(frame.url()) : null;
        if (!origine) throw erreurSecret('secret_origin_mismatch', "Le frame du champ n'a pas d'origine http(s) : saisie refusée.");
        const info = await h.evaluate((el) => ({
            input: el instanceof HTMLInputElement,
            area: el instanceof HTMLTextAreaElement,
            type: el instanceof HTMLInputElement ? el.type : null,
            ecriture: !el.disabled && !el.readOnly,
            opacite: parseFloat(getComputedStyle(el).opacity),
        }));
        if (info.opacite < 0.05)
            throw erreurSecret('secret_field_mismatch', "Le champ est transparent : un champ invisible n'est pas une cible valable pour un secret.");
        if (!info.ecriture) throw erreurSecret('secret_field_mismatch', 'Le champ est désactivé ou en lecture seule.');
        if (champ === 'password' && !(info.input && info.type === 'password'))
            throw erreurSecret('secret_field_mismatch', 'Un mot de passe ne se saisit que dans un champ <input type="password">.');
        if (champ === 'username' && !(info.area || (info.input && TYPES_IDENTIFIANT.has(info.type))))
            throw erreurSecret('secret_field_mismatch', 'Un identifiant se saisit dans un champ texte (text, email, tel, url, search, number) ou une zone de texte visible.');
        return { h, origine };
    } catch (e) {
        await h.dispose().catch(() => {});
        throw e;
    }
}

/**
 * Formulaire englobant (ou formaction du bouton) : sa soumission ne doit ni être un GET explicite ni viser une autre origine que `origine`.
 * Lève une erreur codée sinon. Un formulaire sans attribut `method` n'est pas refusé ici : le script d'initialisation annule un GET non traité par la page.
 */
export async function verifierFormulaire(h, origine) {
    const f = await h.evaluate((el) => {
        const form = el.form;
        const m = (el.getAttribute && el.getAttribute('formmethod')) || (form && form.getAttribute('method')) || '';
        let action = null;
        try {
            action = new URL((el.formAction && el.getAttribute('formaction') ? el.formAction : form && form.action) || location.href, location.href).origin;
        } catch {}
        return { form: Boolean(form), methode: m.toLowerCase(), action };
    });
    if (!f.form && !f.methode) return;
    if (f.methode && f.methode !== 'post')
        throw erreurSecret('login_form_not_post', "La soumission de ce formulaire ne serait pas un POST : un identifiant n'irait pas dans une adresse.", 403, 'Ce site ne se connecte pas par formulaire POST : demandez une autre voie à l\'utilisateur.');
    if (f.action !== origine)
        throw erreurSecret('login_form_other_origin', 'Le formulaire poste vers une autre origine que celle des identifiants : refus.', 403);
}

/** Saisit la valeur (par `fill`) : champ marqué avant la saisie, type revérifié après (changé : champ vidé et refus). Aucune saisie après `delaiAvant`. */
export async function remplirChamp(h, valeur, { champ, timeout, delaiAvant = Infinity }) {
    const reste = delaiAvant - Date.now();
    if (reste < 300) throw erreurSecret('login_deadline', 'Délai de la requête dépassé : saisie annulée.', 408);
    await h.evaluate((el, m) => el.setAttribute(m, '1'), MARQUE);
    await h.fill(valeur, { timeout: Math.min(timeout, reste) });
    const type = await h.evaluate((el) => (el instanceof HTMLInputElement ? el.type : 'autre'));
    if (champ === 'password' && type !== 'password') {
        await h.evaluate((el) => { el.value = ''; }).catch(() => {});
        throw erreurSecret('secret_field_mismatch', 'Le champ a changé de type pendant la saisie : valeur effacée, saisie refusée.');
    }
}
