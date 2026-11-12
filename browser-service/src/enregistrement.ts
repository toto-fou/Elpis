// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/enregistrement.ts — gestures noted by the recorder (pw_recorder): stable target read on the element, frames path, secrets replaced by variables. */
import { isLikelyText } from './localisateur.ts';
import { decrireElement, masquerScript, masquerSecret, masquerUrl, selecteurCadre } from './recorder_util.ts';

// ════════════════════════════════════════════════════════════════════
// RECORDER — capture session actions, replay as Playwright/Cypress/etc.
// ════════════════════════════════════════════════════════════════════
// We hook into the /action and /chain endpoints by intercepting via a
// session-level recorder. Each successful action is appended to
// session._recorder.events when session._recorder.recording is true.
// (The hook lives in the existing endpoints — see `recordEvent` below.)

// Attributs qui disent si un champ est secret (type, nom, id, libellés) ; `{}` s'il n'est plus lisible.
async function attributsDuChamp(locator) {
    if (!locator) return {};
    return locator.evaluate((el) => ({
        type: el.getAttribute('type') || '', name: el.getAttribute('name') || '', id: el.id || '',
        autocomplete: el.getAttribute('autocomplete') || '', label: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        labels: Array.from(el.labels || []).map((l) => l.textContent || '').join(' '),
    }), null, { timeout: 1000 }).catch(() => ({}));
}

// Cadres d'un geste, de la page vers celui de l'élément : sélecteur de chaque <iframe> dans son parent ; [] dans la page (cible = Frame ou Locator).
export async function cheminCadres(cible) {
    let cadre = null;
    if (cible && typeof cible.parentFrame === 'function') cadre = cible;
    else if (cible) {
        const h = await cible.elementHandle({ timeout: 1000 }).catch(() => null);
        if (!h) return [];
        cadre = await h.ownerFrame().catch(() => null);
        await h.dispose().catch(() => {});
    }
    const chemin = [];
    try {
        while (cadre && cadre.parentFrame()) {
            const el = await cadre.frameElement();
            chemin.unshift(await el.evaluate(selecteurCadre));
            await el.dispose().catch(() => {});
            cadre = cadre.parentFrame();
        }
    } catch (_) { return []; }
    return chemin;
}

// Aucun secret gardé : saisie d'un champ secret (variable d'environnement au rejeu, une par champ), littéraux d'une évaluation qui saisit, paramètres sensibles des URL.
export async function recordEvent(session, evt, locator = null) {
    if (!session || !session._recorder || !session._recorder.recording) return;
    if (locator && !evt.frames) {
        const cadres = await cheminCadres(locator);
        if (cadres.length) evt = { ...evt, frames: cadres };
    }
    // Geste par `ref` ou par un texte de repli : le sélecteur stable est lu sur l'élément visé, au moment du geste.
    const parTexte = evt.selector && isLikelyText(evt.selector);
    if (locator && ((evt.ref && !evt.selector) || parTexte) && !Object.values(evt.locator || {}).some(Boolean)) {
        const l = await locator.evaluate(decrireElement, null, { timeout: 1000 }).catch(() => null);
        if (l) evt = { ...evt, locator: l };
    }
    if (evt.action === 'fill' || evt.action === 'type')
        evt = masquerSecret(evt, locator ? await attributsDuChamp(locator) : {}, session._recorder.variables || (session._recorder.variables = new Map()));
    if (evt.action === 'eval') evt = { ...evt, script: masquerScript(evt.script).slice(0, 300) };
    const url = masquerUrl(evt.url);
    if (url !== evt.url) evt = { ...evt, url, url_masked: true };
    const events = session._recorder.events;
    events.push({ ts: Date.now() - session._recorder.start_ts, ...evt });
    if (events.length > 1000) events.shift(); // safety cap
}
