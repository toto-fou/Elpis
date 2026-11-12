// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/evenements.ts — events of a page: native dialogs, console and network journals, tabs opened or closed by the page, navigation details. */
import { finalUrl, tlsWarning } from './nav_util.ts';
import { NAV_GRACE_MS } from './requete.ts';
import { hostOf } from './result_util.ts';
import { chargeRequete, purgerTexte, requetePorteSecret } from './secret_util.ts';
import { joindreOnglets, urlOnglet } from './tab_util.ts';

// ── Dialogues natifs (alert / confirm / prompt) ───────────────────────
//
// Sans handler, Playwright BLOQUE la page au premier confirm() — d'où le
// « accepte tout » historique, posé à trois endroits différents. Mais
// « accepte toujours » veut dire : impossible de refuser un confirm,
// impossible de répondre à un prompt (mesuré : prompt() rendait ""). Le
// service avait bien /handle_next_dialog, mais il BLOQUE la réponse HTTP
// jusqu'à ce qu'un dialogue survienne — donc inutilisable depuis un agent,
// qui doit rendre la main pour déclencher l'action qui l'ouvre.
//
// On garde donc une politique ARMABLE, consommée N fois puis oubliée, et un
// journal du dernier dialogue vu. Défaut inchangé : accepter.
export function makeDialogState() {
    return { pending: null, last: null, count: 0, history: [] };
}

// Ce que fait le navigateur quand rien n'est armé — DIT dans chaque status.
export const DIALOG_DEFAULT_WHEN_UNARMED = 'accept';

export function attachDialogHandler(page, dialogState) {
    page.on('dialog', async (dialog) => {
        const type = dialog.type();
        const message = purgerTexte(dialog.message(), dialogState.formes);
        let action = DIALOG_DEFAULT_WHEN_UNARMED;
        let input = '';
        const pol = dialogState.pending;
        const armed = !!(pol && (pol.sticky || pol.remaining > 0));
        if (armed) {
            action = pol.action === 'dismiss' ? 'dismiss' : 'accept';
            input = pol.input_text || '';
            if (!pol.sticky) {
                pol.remaining -= 1;
                if (pol.remaining <= 0) dialogState.pending = null;
            }
        }
        dialogState.count += 1;
        dialogState.last = { type, message, action, input_text: input, seq: dialogState.count,
                             policy: armed ? 'armed' : 'default' };
        dialogState.history = dialogState.history || [];
        dialogState.history.push(dialogState.last);
        if (dialogState.history.length > 20) dialogState.history.shift();
        console.log(`[DIALOG] ${type}: ${message} → ${action}${input ? ` ("${input}")` : ''}${armed ? '' : ' (default)'}`);
        try {
            if (action === 'dismiss') await dialog.dismiss();
            else if (type === 'prompt') await dialog.accept(input);
            else await dialog.accept();
        } catch (e) {}
    });
}
// ── Journaux console + réseau d'une page ─────────────────────────────
// Audit tools web 2026-09-05 — le journal réseau ne retenait que xhr/fetch :
// la navigation elle-même (POST /authenticate → 303 → GET /secure) n'y était
// jamais, et rien ne distinguait l'appli des traqueurs tiers. On garde aussi
// les documents, on note l'hôte et le same-origin. Attaché à CHAQUE page
// (onglets compris) — avant, seule la première page de la session l'était.
// Pendant une connexion (`networkLog.formes`, formes du mot de passe) : console purgée, requêtes sans corps, celle qui porte le mot de passe écartée avec sa réponse.
const NET_TYPES = new Set(['document', 'xhr', 'fetch']);
const requetesEcartees = new WeakSet();
export const documentSansFragment = (u) => String(u || '').split('#')[0];
export function attachPageLoggers(page, consoleLogs, networkLog) {
    if (!page || page.__pwLoggersAttached || !consoleLogs || !networkLog) return;
    page.__pwLoggersAttached = true;
    // Chaque entrée porte l'URL du document (sans fragment) qui l'a émise : l'inspection ne rend que celles du document courant.
    const noter = (line) => {
        consoleLogs.push({ line, doc: documentSansFragment(page.url()) });
        if (consoleLogs.length > 100) consoleLogs.shift();
    };
    page.on('console', msg => {
        if (['error', 'warning'].includes(msg.type())) noter(`[${msg.type()}] ${purgerTexte(msg.text(), networkLog.formes)}`);
    });
    // Exception non rattrapée de la page (onload compris), que la console ne montre pas.
    page.on('pageerror', err => noter(`[pageerror] ${purgerTexte(String(err?.message || err), networkLog.formes)}`));
    const pageHost = () => { try { return hostOf(page.url()); } catch (_) { return ''; } };
    const entry = (req, rtype) => {
        const url = req.url();
        const host = hostOf(url);
        let sameOrigin = host !== '' && host === pageHost();
        // Une navigation principale vers un autre hôte DEVIENT la page : c'est
        // du same-origin pour la suite (redirection d'auth, SSO).
        try { if (rtype === 'document' && req.isNavigationRequest() && req.frame() === page.mainFrame()) sameOrigin = true; } catch (_) {}
        return { url: url.substring(0, 300), type: rtype, host, same_origin: sameOrigin };
    };
    page.on('request', req => {
        const rtype = req.resourceType();
        if (!NET_TYPES.has(rtype)) return;
        const formes = networkLog.formes;
        if (formes && requetePorteSecret(req.url(), chargeRequete(req), formes)) return requetesEcartees.add(req);
        networkLog.push({ ts: Date.now(), dir: 'REQ', method: req.method(), ...entry(req, rtype), postData: formes ? null : (req.postData()?.substring(0, 500) || null) });
        if (networkLog.length > 300) networkLog.shift();
    });
    page.on('response', resp => {
        const req = resp.request();
        const rtype = req.resourceType();
        if (!NET_TYPES.has(rtype) || requetesEcartees.has(req)) return;
        networkLog.push({ ts: Date.now(), dir: 'RES', status: resp.status(), ...entry(req, rtype) });
        if (networkLog.length > 300) networkLog.shift();
    });
}

// ── Onglets ouverts par la page (target=_blank, window.open) ──────────
// Ajoutés aux onglets de la session SANS y basculer et annoncés (opened_tab)
// dans la réponse suivante ; un onglet qui se ferme seul sort de la liste.
const ATTENTE_POPUP_MS = parseInt(process.env.PW_POPUP_GRACE_MS || '150', 10);
// Routes qui gèrent elles-mêmes les onglets : pas de rappel de l'onglet actif sur leurs erreurs.
const ROUTES_ONGLETS = new Set(['/new_tab', '/switch_tab', '/close_tab', '/list_tabs']);

// Suivi des onglets d'une page : ses popups adoptés, sa fermeture retirée de la session.
export function suivreOnglets(s, page) {
    if (!page || page.__elpisOngletsSuivis) return;
    page.__elpisOngletsSuivis = true;
    page.on('popup', (popup) => adopterOnglet(s, popup));
    page.on('close', () => retirerOnglet(s, page));
}

// Onglet neuf de la session (tab_new, popup) : dialogues, journaux et suivi de ses propres popups.
export function brancherOnglet(s, page) {
    attachDialogHandler(page, s.dialogState || (s.dialogState = makeDialogState()));
    attachPageLoggers(page, s.consoleLogs, s.networkLog);
    suivreOnglets(s, page);
}

// Popup ajouté à la session et mis en attente d'annonce.
function adopterOnglet(s, page) {
    if (s.tabs.includes(page) || page.isClosed()) return;
    brancherOnglet(s, page);
    s.tabs.push(page);
    (s.ongletsOuverts ||= []).push(page);
    for (const reveil of [...(s.reveilsOnglet || [])]) reveil();
    console.log(`[TABS] onglet ouvert par la page (${s.tabs.length} onglets)`);
}

// Onglet fermé retiré de la session ; s'il était actif, son voisin le devient (annoncé si la page s'est fermée seule).
export function retirerOnglet(s, page) {
    const i = s.tabs.indexOf(page);
    if (i < 0) return;
    s.tabs.splice(i, 1);
    s.ongletsOuverts = (s.ongletsOuverts || []).filter(p => p !== page);
    if (s.page === page && s.tabs.length) s.page = s.tabs[Math.min(i, s.tabs.length - 1)];
    if (!page.__elpisFermeParService) (s.ongletsFermes ||= []).push({ index: i, url: urlOnglet(page) });
}

// Attente bornée d'un onglet ouvert par la page, rendue dès son arrivée.
function attendreOnglet(s, ms) {
    return new Promise((resolve) => {
        const reveils = (s.reveilsOnglet ||= []);
        const reveil = () => {
            clearTimeout(minuteur);
            const i = reveils.indexOf(reveil);
            if (i >= 0) reveils.splice(i, 1);
            resolve();
        };
        const minuteur = setTimeout(reveil, ms);
        reveils.push(reveil);
    });
}

// Geste qui peut ouvrir un onglet sans que l'attente de navigation (/action, /chain) couvre déjà l'arrivée du popup.
function peutOuvrirOnglet(req) {
    const b = req.body || {};
    const geste = (type, key) => ['click', 'dblclick', 'double_click'].includes(type) || (type === 'press' && key === 'Enter');
    if (NAV_GRACE_MS >= ATTENTE_POPUP_MS) return false;
    if (req.path === '/action') return geste(b.type, b.key);
    if (req.path === '/chain' && Array.isArray(b.actions) && b.actions.length) {
        const dernier = b.actions[b.actions.length - 1] || {};
        return geste(dernier.type, dernier.key);
    }
    return false;
}

// Réponse JSON d'une route de session : onglets ouverts ou fermés par la page annoncés (après une courte attente pour un clic), onglet actif rappelé sur une erreur.
export function annoncerOnglets(req, res) {
    const s = req.session;
    const envoyer = res.json.bind(res);
    res.json = function (payload) {
        const annoncer = req.path !== '/stop' && (req.method === 'POST' || req.path === '/list_tabs');
        if (!annoncer || !payload || typeof payload !== 'object' || Array.isArray(payload)) return envoyer(payload);
        const finir = () => {
            try {
                joindreOnglets(payload, {
                    tabs: s.tabs, page: s.page,
                    ouverts: (s.ongletsOuverts || []).splice(0), fermes: (s.ongletsFermes || []).splice(0),
                    erreur: this.statusCode >= 400 && !ROUTES_ONGLETS.has(req.path),
                });
            } catch (e) { console.warn('[TABS] annonce impossible :', e.message); }
            return envoyer(payload);
        };
        if (this.statusCode < 400 && !(s.ongletsOuverts || []).length && peutOuvrirOnglet(req)) {
            attendreOnglet(s, ATTENTE_POPUP_MS).then(finir);
            return this;
        }
        return finir();
    };
}

// Statut HTTP, adresse finale (redirection) et avertissement TLS d'une navigation qui a répondu.
export async function detailsNavigation(resp, cible, arrivee) {
    if (!resp) return {};
    const d = {};
    try { d.http_status = resp.status(); } catch (_) { /* réponse détachée */ }
    const fin = finalUrl(cible, arrivee);
    if (fin) d.final_url = fin;
    const tls = tlsWarning(await resp.securityDetails().catch(() => null));
    if (tls) d.tls_warning = tls;
    return d;
}
