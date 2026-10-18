// SPDX-License-Identifier: MIT
/** browser-service/geste_util.js — navigation déclenchée par un geste (clic, Entrée) : suivie jusqu'à la page d'arrivée, bornée. */

/** Gestes de /action et /chain qui peuvent suivre un lien ou soumettre un formulaire. */
export const GESTES_NAVIGANTS = new Set(['click', 'smart_click', 'dblclick', 'double_click', 'press']);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Armé AVANT le geste ; la fonction rendue attend la navigation partie (grâce `graceMs`, arrivée bornée à `maxMs` et à l'échéance `limite`) : `{ url_before, url }` si l'URL a changé, `loading: true` si la page charge encore à l'échéance, sinon `null`.
export function suivreNavigation(page, { graceMs = 250, maxMs = 10000 } = {}) {
    let principal, avant;
    try { principal = page.mainFrame(); avant = page.url(); } catch (_) {
        return Object.assign(async () => null, { annuler: () => {} });
    }
    let partie = false, arrivee = false, echec = false, repondue = 0;
    const estNavigation = (r) => { try { return r.isNavigationRequest() && r.frame() === principal; } catch (_) { return false; } };
    const surRequete = (r) => { if (estNavigation(r)) partie = true; };
    const surReponse = (r) => { if (estNavigation(r.request())) repondue = Date.now(); };
    const surEchec = (r) => { if (estNavigation(r)) echec = true; };
    const surNavigation = (f) => { if (f === principal) arrivee = true; };
    const surFin = () => { echec = true; };
    const ecoutes = [['request', surRequete], ['response', surReponse], ['requestfailed', surEchec],
        ['framenavigated', surNavigation], ['download', surFin], ['close', surFin]];
    for (const [ev, f] of ecoutes) page.on(ev, f);
    const annuler = () => { for (const [ev, f] of ecoutes) page.off(ev, f); };
    const attendre = async ({ limite = Infinity } = {}) => {
        const t0 = Date.now();
        const fin = Math.max(t0 + Math.min(graceMs, maxMs), Math.min(t0 + maxMs, limite));
        let enCours = false;
        try {
            while (!arrivee && !echec) {
                if (Date.now() >= fin) { enCours = partie; break; }
                if (!partie && Date.now() - t0 >= graceMs) break;
                if (repondue && Date.now() - repondue > 1000) break;
                await dormir(25);
            }
            if (arrivee) {
                const reste = fin - Date.now();
                enCours = !(reste > 0 && await page.waitForLoadState('domcontentloaded', { timeout: reste }).then(() => true, () => false));
            }
        } finally { annuler(); }
        let apres = avant;
        try { apres = page.url(); } catch (_) { apres = avant; }
        if (apres === avant && !enCours) return null;
        return { url_before: avant, url: apres, ...(enCours ? { loading: true } : {}) };
    };
    return Object.assign(attendre, { annuler });
}

/** Champs de la réponse d'un geste qui a navigué : `url`, `url_before`, `navigated` si l'URL a changé, `nav_warning` si la page charge encore. */
export function champsNavigation(nav) {
    if (!nav) return {};
    const out = { url: nav.url, url_before: nav.url_before };
    if (nav.url !== nav.url_before) out.navigated = true;
    if (nav.loading)
        out.nav_warning = `navigation still loading: ${out.navigated ? `${nav.url} is not fully loaded yet`
            : 'the next page has not arrived yet, the tab still shows the page before'}; look at it with `
            + "pw_page(action='inspect') before relying on its content.";
    return out;
}
