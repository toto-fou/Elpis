// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/destinations.ts — address checks before a requested navigation (form only, the relay judges destinations) and the guard of a fresh context. */
import { analyserUrl, messageRefus } from './url_guard.ts';

// ════════════════════════════════════════════════════════════════════
//  DESTINATIONS (cf. url_guard.js, proxy_guard.js)
// ════════════════════════════════════════════════════════════════════
//  Le relais filtrant (proxy_guard.js) fait foi : TOUT le trafic du
//  navigateur y passe (navigations, redirections, sous-ressources, WebSocket,
//  service workers) ; la boucle locale du bac y est jointe directement, le
//  reste part au relais de l'hôte, qui juge la destination (profil réseau du
//  bac, politique du navigateur). Avant une navigation demandée (goto, nouvel
//  onglet, /start), seule la forme de l'adresse est contrôlée ici.

/** Motif de refus d'une URL (``null`` = permise) : forme seule. */
export async function refusUrl(url) {
    const a = analyserUrl(url);
    return a.ok ? null : a.motif;
}

/** Réponse 403 uniforme pour une navigation directe refusée. */
export function repondreRefus(res, url, motif) {
    return res.status(403).json({ error: messageRefus(url, motif), code: 'url_blocked' });
}

// Schémas qu'une page ne doit jamais afficher, même atteints par un autre
// chemin que page.goto (script de la page) : on la ramène à une page vide.
const _SCHEMAS_INTERDITS = /^(file|view-source|chrome|chrome-extension|devtools|filesystem|resource|moz-extension):/i;

function gardePage(page) {
    page.on('framenavigated', (frame) => {
        try {
            if (frame !== page.mainFrame()) return;
            if (_SCHEMAS_INTERDITS.test(frame.url())) page.goto('about:blank').catch(() => {});
        } catch (_) { /* page fermée */ }
    });
}

/** Garde d'un contexte neuf : schémas interdits ramenés à une page vide
 *  (le réseau, lui, passe par le relais). */
export async function installerGarde(context) {
    context.on('page', gardePage);
}

// Agent utilisateur des contextes : un Chrome de bureau (le headless shell s'annoncerait « HeadlessChrome »).
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
