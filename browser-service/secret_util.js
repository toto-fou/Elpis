// SPDX-License-Identifier: MIT
// secret_util.js — saisie d'un secret du coffre (jeton ⟦creds:…⟧ résolu par l'hôte d'outils) :
// origine exacte attendue, vérifiée sur le FRAME de l'élément visé juste avant le remplissage,
// valeur jamais renvoyée ni journalisée (les erreurs Playwright en recopient l'appel).

export const GESTES_SECRET = new Set(['fill', 'type']);

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

function erreurSecret(code, message, statut = 403) {
    const e = new Error(message);
    e.code = code;
    e.statut = statut;
    return e;
}

/**
 * Origine attendue d'un geste porteur de secret ; `null` si le corps n'en porte pas.
 * Lève une erreur codée (statut 400) si le geste n'est pas fill/type, s'il n'a pas de cible ou si l'origine est illisible.
 */
export function origineSecret(corps, { geste, aCible }) {
    const brut = corps.secret_origin;
    if (brut === undefined || brut === null || brut === '') return null;
    const origine = origineDe(brut);
    if (!origine) throw erreurSecret('secret_origin_invalid', 'Origine du secret illisible.', 400);
    if (!GESTES_SECRET.has(geste))
        throw erreurSecret('secret_gesture_refused', `Un secret ne se saisit qu'avec fill ou type (reçu : ${geste}).`, 400);
    if (!aCible) throw erreurSecret('secret_requires_target', 'Un secret se saisit dans un champ ciblé, jamais dans l\'élément actif.', 400);
    return origine;
}

/**
 * Saisit la valeur dans l'élément, après avoir vérifié que son frame (pas seulement la page) est sur l'origine attendue.
 * L'élément est tenu par une poignée : si le frame navigue entre la vérification et la saisie, la poignée est détachée et la saisie échoue.
 */
export async function saisirSecret(locator, origine, valeur, { mode, timeout, force = false, delai = 30 }) {
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
            if (mode === 'fill') {
                await h.fill(valeur, { timeout, force });
            } else {
                await h.click({ timeout }).catch(() => {});
                await h.fill('', { timeout });
                if (typeof h.type === 'function') await h.type(valeur, { delay: delai, timeout });
                else await locator.pressSequentially(valeur, { delay: delai, timeout });
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
