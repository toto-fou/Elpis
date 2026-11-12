// SPDX-License-Identifier: MIT
/** browser-service/src/geste_util.ts — navigation déclenchée par un geste (clic, Entrée) : suivie jusqu'à la page d'arrivée, bornée. */

/** Requête lue par le suivi (Request de Playwright). */
export interface RequeteSuivie {
    isNavigationRequest(): boolean;
    frame(): unknown;
}

/** Réponse lue par le suivi (Response de Playwright). */
export interface ReponseSuivie {
    request(): RequeteSuivie;
}

/** Écouteur d'un événement de page, paramètres comparés dans les deux sens (comme les méthodes), pour accepter la Page de Playwright. */
type Ecouteur = { ecouter(...args: unknown[]): void }['ecouter'];

/** Ce que le suivi lit d'une page (Page de Playwright). */
export interface PageSuivie {
    mainFrame(): unknown;
    url(): string;
    on(evenement: string, ecouteur: Ecouteur): unknown;
    off(evenement: string, ecouteur: Ecouteur): unknown;
    waitForLoadState(etat: 'domcontentloaded', options: { timeout: number }): Promise<unknown>;
}

/** Navigation suivie : adresses avant et après, `loading` si la page charge encore. */
export interface NavGeste {
    url_before: string;
    url: string;
    loading?: true;
}

/** Attente de la navigation d'un geste, et son abandon. */
export type SuiviNavigation = ((options?: { limite?: number }) => Promise<NavGeste | null>) & { annuler: () => void };

/** Champs de la réponse d'un geste qui a navigué. */
export interface ChampsNavigation {
    url?: string;
    url_before?: string;
    navigated?: true;
    nav_warning?: string;
}

/** Gestes de /action et /chain qui peuvent suivre un lien ou soumettre un formulaire. */
export const GESTES_NAVIGANTS: ReadonlySet<unknown> = new Set(['click', 'smart_click', 'dblclick', 'double_click', 'press']);

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Armé AVANT le geste ; la fonction rendue attend la navigation partie (grâce `graceMs`, arrivée bornée à `maxMs` et à l'échéance `limite`) : `{ url_before, url }` si l'URL a changé, `loading: true` si la page charge encore à l'échéance, sinon `null`.
export function suivreNavigation(page: PageSuivie, { graceMs = 250, maxMs = 10000 }: { graceMs?: number; maxMs?: number } = {}): SuiviNavigation {
    let principal: unknown, avant: string;
    try { principal = page.mainFrame(); avant = page.url(); } catch {
        return Object.assign(async (): Promise<NavGeste | null> => null, { annuler: () => { /* rien à retirer */ } });
    }
    let partie = false, arrivee = false, echec = false, repondue = 0;
    const estNavigation = (r: RequeteSuivie): boolean => { try { return r.isNavigationRequest() && r.frame() === principal; } catch { return false; } };
    const surRequete = (r: RequeteSuivie): void => { if (estNavigation(r)) partie = true; };
    const surReponse = (r: ReponseSuivie): void => { if (estNavigation(r.request())) repondue = Date.now(); };
    const surEchec = (r: RequeteSuivie): void => { if (estNavigation(r)) echec = true; };
    const surNavigation = (f: unknown): void => { if (f === principal) arrivee = true; };
    const surFin = (): void => { echec = true; };
    const ecoutes: [string, Ecouteur][] = [['request', surRequete], ['response', surReponse], ['requestfailed', surEchec],
        ['framenavigated', surNavigation], ['download', surFin], ['close', surFin]];
    for (const [ev, f] of ecoutes) page.on(ev, f);
    const annuler = (): void => { for (const [ev, f] of ecoutes) page.off(ev, f); };
    const attendre = async ({ limite = Infinity }: { limite?: number } = {}): Promise<NavGeste | null> => {
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
        let apres: string;
        try { apres = page.url(); } catch { apres = avant; }
        if (apres === avant && !enCours) return null;
        return { url_before: avant, url: apres, ...(enCours ? { loading: true } : {}) };
    };
    return Object.assign(attendre, { annuler });
}

/** Champs de la réponse d'un geste qui a navigué : `url`, `url_before`, `navigated` si l'URL a changé, `nav_warning` si la page charge encore. */
export function champsNavigation(nav: NavGeste | null | undefined): ChampsNavigation {
    if (!nav) return {};
    const out: ChampsNavigation = { url: nav.url, url_before: nav.url_before };
    if (nav.url !== nav.url_before) out.navigated = true;
    if (nav.loading)
        out.nav_warning = `navigation still loading: ${out.navigated ? `${nav.url} is not fully loaded yet`
            : 'the next page has not arrived yet, the tab still shows the page before'}; look at it with `
            + "pw_page(action='inspect') before relying on its content.";
    return out;
}
