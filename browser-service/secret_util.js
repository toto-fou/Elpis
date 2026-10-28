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

/**
 * Origine attendue d'un geste porteur de secret ; `null` si le corps n'en porte pas.
 * Lève une erreur codée si la session n'est pas sécurisée, si le geste n'est pas `fill`, s'il n'a pas de cible, si le champ ou l'origine sont illisibles.
 */
export function origineSecret(corps, session, { geste, aCible }) {
    const brut = corps.secret_origin;
    if (brut === undefined || brut === null || brut === '') return null;
    if (!session || !session.secure)
        throw erreurSecret(
            'secret_requires_secure_session',
            'Un secret ne se saisit que dans une session sécurisée.',
            403,
            "Fermez cette session (pw_session stop) puis ouvrez-en une avec pw_session(action='start', url=…, secure=true).",
        );
    const origine = origineDe(brut);
    if (!origine) throw erreurSecret('secret_origin_invalid', 'Origine du secret illisible.', 400);
    if (geste !== 'fill') throw erreurSecret('secret_gesture_refused', `Un secret ne se saisit qu'avec fill (reçu : ${geste}).`, 400);
    if (!CHAMPS_SECRET.has(corps.secret_field)) throw erreurSecret('secret_field_invalid', 'Champ du secret inconnu (password ou username).', 400);
    if (!aCible) throw erreurSecret('secret_requires_target', 'Un secret se saisit dans un champ ciblé, jamais dans l\'élément actif.', 400);
    if (session.tlsTolerant && origine.startsWith('https:') && origine !== session.origineTolerance)
        throw erreurSecret('secret_tls_tolerant_origin', `Cette session tolère les certificats non vérifiés pour ${session.origineTolerance} seulement : saisie refusée sur ${origine}.`);
    return origine;
}

// ── Garde de la session sécurisée ───────────────────────────────────────

/** Routes qui exécutent du JavaScript fourni, réécrivent le trafic ou enregistrent la session : refusées d'un bout à l'autre d'une session sécurisée. */
const ROUTES_REFUSEES = new Set([
    '/evaluate', '/poll_until', '/dispatch_event', '/trigger_framework_update', '/watch_changes', '/intercept', '/capture_response',
    '/select_date', '/select_color', '/clipboard', '/smart_click', '/handle_dropdown', '/query',
    '/save_state', '/trace_export', '/print_pdf',
]);
const PREFIXES_REFUSES = ['/mock/', '/recorder/'];

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
    for (const k of CLES_BRUTES) {
        if (!present(o[k])) continue;
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
    const chemin = req.path;
    if (ROUTES_REFUSEES.has(chemin) || PREFIXES_REFUSES.some((p) => chemin.startsWith(p)))
        return refus(
            'secure_session_route_refused',
            `Session sécurisée : ${chemin.slice(1)} est refusé (il exécuterait du code fourni, réécrirait le trafic, lirait une valeur ou enregistrerait la session).`,
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

/** Enregistre les valeurs d'une session (et la forme `user:pass` de l'authentification HTTP Basic). */
export function retenirValeurs(session, valeurs, { basic = null } = {}) {
    if (!session._valeursSecretes) session._valeursSecretes = new Set();
    for (const v of valeurs) for (const f of formesSecret(v)) session._valeursSecretes.add(f);
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

// ── Marquage des champs et masquage des captures ────────────────────────

/** Script d'initialisation (tous les frames d'un contexte sécurisé) : marque tout champ qui est ou a été de type password, même si la page change son type ensuite. */
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
}

const contextesSecurises = new WeakSet();
let masquageInstalle = false;

function masques(page) {
    return page.frames().map((f) => f.locator(SELECTEUR_MASQUE));
}

/** Les captures (page ou élément) de ce contexte masquent les champs marqués et les champs mot de passe, quel que soit leur point d'appel. */
export function securiserCaptures(context, page) {
    contextesSecurises.add(context);
    if (masquageInstalle) return;
    masquageInstalle = true;
    const protoPage = Object.getPrototypeOf(page);
    const protoLocator = Object.getPrototypeOf(page.locator('body'));
    const ajouter = (opts, p) => ({ ...(opts || {}), mask: [...((opts && opts.mask) || []), ...masques(p)], maskColor: '#000000' });
    const pageScreenshot = protoPage.screenshot;
    protoPage.screenshot = function (opts) {
        return pageScreenshot.call(this, contextesSecurises.has(this.context()) ? ajouter(opts, this) : opts);
    };
    const locatorScreenshot = protoLocator.screenshot;
    protoLocator.screenshot = function (opts) {
        return locatorScreenshot.call(this, contextesSecurises.has(this.page().context()) ? ajouter(opts, this.page()) : opts);
    };
}

// ── Saisie d'un secret ──────────────────────────────────────────────────

const TYPES_IDENTIFIANT = new Set(['text', 'email', 'tel', 'url', 'search', 'number']);

/**
 * Contrôle d'un champ avant tout secret (sans valeur) : élément unique visible, frame, type réel (propriété, pas attribut), champ éditable.
 * Renvoie la poignée et l'origine du frame ; l'appelant la libère.
 */
async function controlerChamp(candidats, { champ, timeout, nth = null }) {
    const visibles = candidats.filter({ visible: true });
    let n = await visibles.count().catch(() => 0);
    for (const fin = Date.now() + Math.min(timeout, 1500); n === 0 && Date.now() < fin; ) {
        await new Promise((r) => setTimeout(r, 150));
        n = await visibles.count().catch(() => 0);
    }
    if (n === 0)
        throw erreurSecret(
            'secret_target_not_visible',
            'Aucun champ visible ne correspond : un champ masqué par CSS n\'est pas une cible valable pour un secret.',
            404,
            'Ciblez le champ affiché à l\'écran (rôle, label, placeholder) et attendez qu\'il le soit.',
        );
    if (n > 1 && nth === null)
        throw erreurSecret('ambiguous_target', `${n} champs visibles correspondent : saisie du secret refusée.`, 409, 'Précisez la cible (label, placeholder, nth=K ou un ref de pw_find).');
    if (nth !== null && nth >= n)
        throw erreurSecret('element_not_found', `nth=${nth} mais ${n} champ(s) visible(s) seulement.`, 404);
    const h = await (nth === null ? visibles.first() : visibles.nth(nth)).elementHandle({ timeout });
    if (!h) throw erreurSecret('element_not_found', 'Champ introuvable.', 404);
    try {
        const frame = await h.ownerFrame();
        const origine = frame ? origineDe(frame.url()) : null;
        if (!origine) throw erreurSecret('secret_origin_mismatch', 'Le frame du champ n\'a pas d\'origine http(s) : saisie refusée.');
        const info = await h.evaluate((el) => ({
            input: el instanceof HTMLInputElement,
            area: el instanceof HTMLTextAreaElement,
            type: el instanceof HTMLInputElement ? el.type : null,
            ecriture: !el.disabled && !el.readOnly,
            opacite: parseFloat(getComputedStyle(el).opacity),
        }));
        if (info.opacite < 0.05)
            throw erreurSecret('secret_field_mismatch', 'Le champ est transparent : un champ invisible n\'est pas une cible valable pour un secret.');
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

/** Pré-contrôle sans valeur : renvoie l'origine du frame du champ visé, ou lève une erreur codée. */
export async function precontroleSecret(candidats, options) {
    const { h, origine } = await controlerChamp(candidats, options);
    await h.dispose().catch(() => {});
    return origine;
}

/**
 * Saisit la valeur (par `fill`) : champ contrôlé de nouveau, origine du frame égale à celle du jeton, champ marqué avant la saisie,
 * type revérifié juste après (une page qui change le type en réaction est refusée et le champ vidé). Aucune saisie après `delaiAvant`.
 */
export async function saisirSecret(candidats, origine, valeur, { champ, timeout, nth = null, force = false, delaiAvant = Infinity }) {
    try {
        const { h, origine: reelle } = await controlerChamp(candidats, { champ, timeout, nth });
        try {
            if (reelle !== origine)
                throw erreurSecret('secret_origin_mismatch', `Le frame du champ n'est pas sur l'origine attendue (${origine}) : saisie refusée.`);
            const reste = delaiAvant - Date.now();
            if (reste < 300) throw erreurSecret('secret_deadline', 'Délai de la requête dépassé : saisie du secret annulée.', 408);
            await h.evaluate((el, m) => el.setAttribute(m, '1'), MARQUE);
            await h.fill(valeur, { timeout: Math.min(timeout, reste), force });
            const type = await h.evaluate((el) => (el instanceof HTMLInputElement ? el.type : 'autre'));
            if (champ === 'password' && type !== 'password') {
                await h.evaluate((el) => { el.value = ''; }).catch(() => {});
                throw erreurSecret('secret_field_mismatch', 'Le champ a changé de type pendant la saisie : valeur effacée, saisie refusée.');
            }
        } finally {
            await h.dispose().catch(() => {});
        }
    } catch (e) {
        e.message = masquerValeur(e.message, valeur);
        if (typeof e.stack === 'string') e.stack = masquerValeur(e.stack, valeur);
        throw e;
    }
}
