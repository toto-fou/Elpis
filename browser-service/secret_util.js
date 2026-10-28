// SPDX-License-Identifier: MIT
// secret_util.js — saisie d'un secret du coffre (jeton ⟦creds:…⟧ résolu par l'hôte d'outils) :
// origine exacte attendue, vérifiée sur le FRAME de l'élément visé juste avant le remplissage,
// valeur jamais renvoyée ni journalisée (les erreurs Playwright en recopient l'appel).

// Un secret ne se saisit que par `fill` : pas de frappe caractère par caractère (l'hôte d'outils convertit `type`).
export const GESTES_SECRET = new Set(['fill']);
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

function erreurSecret(code, message, statut = 403, fix = null) {
    const e = new Error(message);
    e.code = code;
    e.statut = statut;
    if (fix) e.details = { fix };
    return e;
}

/**
 * Origine attendue d'un geste porteur de secret ; `null` si le corps n'en porte pas.
 * Lève une erreur codée (statut 400) si le geste n'est pas `fill`, s'il n'a pas de cible, si le champ visé (`secret_field`) ou l'origine sont illisibles.
 */
export function origineSecret(corps, { geste, aCible }) {
    const brut = corps.secret_origin;
    if (brut === undefined || brut === null || brut === '') return null;
    const origine = origineDe(brut);
    if (!origine) throw erreurSecret('secret_origin_invalid', 'Origine du secret illisible.', 400);
    if (!GESTES_SECRET.has(geste))
        throw erreurSecret('secret_gesture_refused', `Un secret ne se saisit qu'avec fill (reçu : ${geste}).`, 400);
    if (!CHAMPS_SECRET.has(corps.secret_field))
        throw erreurSecret('secret_field_invalid', 'Champ du secret inconnu (password ou username).', 400);
    if (!aCible) throw erreurSecret('secret_requires_target', 'Un secret se saisit dans un champ ciblé, jamais dans l\'élément actif.', 400);
    return origine;
}

/** Raison pour laquelle la session ne peut pas recevoir un secret (script, interception, trace, HAR, vidéo), `null` sinon. */
export function refusSessionPourSecret(s) {
    if (!s) return null;
    const raisons = [];
    if (s._scriptsActifs) raisons.push(`du JavaScript arbitraire ou une interception a servi dans cette session (${s._scriptsActifs})`);
    if (s._mockHandlerRegistered) raisons.push('des réponses simulées (pw_mock) sont enregistrées');
    if (s.traceActive) raisons.push('une trace Playwright enregistre les saisies');
    if (s.harActive) raisons.push('un HAR enregistre le trafic');
    if (s.videoActive) raisons.push('une vidéo enregistre la page');
    if (!raisons.length) return null;
    return erreurSecret(
        'secret_session_unsafe',
        `Saisie de secret refusée : ${raisons.join(' ; ')}.`,
        403,
        'Fermez cette session (pw_session stop) et ouvrez-en une nouvelle sans trace, HAR, vidéo, mock ni eval avant de redonner un identifiant.',
    );
}

/** Middleware Express (après getSession) : réservé aux points qui exécutent du JS arbitraire ou réécrivent le trafic ; refusé une fois un secret saisi, et marque la session sinon. */
export function gardeScripts(nature) {
    return (req, res, next) => {
        const s = req.session;
        if (s && s._secretSaisi)
            return res.status(403).json({
                error: `${nature} est refusé : un secret a été saisi dans cette session (le script pourrait le lire ou le modifier).`,
                code: 'session_tainted_by_secret',
                fix: 'Fermez la session (pw_session stop) puis ouvrez-en une nouvelle pour utiliser cet outil.',
            });
        if (s && !s._scriptsActifs) s._scriptsActifs = nature;
        next();
    };
}

/**
 * Saisit la valeur (par `fill`) dans l'élément, après avoir vérifié que son frame (pas seulement la page) est sur l'origine attendue
 * et que son type convient au champ (`password` : un <input type=password> ; `username` : jamais un champ password).
 * L'élément est tenu par une poignée : si le frame navigue entre la vérification et la saisie, la poignée est détachée et la saisie échoue.
 */
export async function saisirSecret(locator, origine, valeur, { champ, timeout, force = false }) {
    try {
        const h = await locator.elementHandle({ timeout });
        if (!h) throw erreurSecret('element_not_found', 'Champ introuvable.', 404);
        try {
            const frame = await h.ownerFrame();
            const reelle = frame ? origineDe(frame.url()) : null;
            if (reelle !== origine)
                throw erreurSecret(
                    'secret_origin_mismatch',
                    `Le frame du champ n'est pas sur l'origine attendue (${origine}) : saisie refusée.`,
                );
            const type = String((await h.getAttribute('type')) || '').trim().toLowerCase();
            if (champ === 'password' && type !== 'password')
                throw erreurSecret('secret_field_mismatch', 'Un mot de passe ne se saisit que dans un champ <input type="password">.');
            if (champ === 'username' && type === 'password')
                throw erreurSecret('secret_field_mismatch', 'Un identifiant ne se saisit pas dans un champ mot de passe.');
            await h.fill(valeur, { timeout, force });
        } finally {
            await h.dispose().catch(() => {});
        }
    } catch (e) {
        e.message = masquerValeur(e.message, valeur);
        if (typeof e.stack === 'string') e.stack = masquerValeur(e.stack, valeur);
        throw e;
    }
}
