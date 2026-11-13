// SPDX-License-Identifier: MIT
/** tests/frontend/reel/onglets-reel-verify.mjs — démarrage et onglets contre le core TS réel : connexion appliquée une fois (un flux système, aucune requête en double ni fausse reconnexion), huit onglets chargés en HTTP/1.1 avec un seul flux système partagé, notification reçue dans chacun, reprise à la fermeture du meneur */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/onglets-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, attendreMontage, verifications, contexteConnecte, Client } from '../lib/core-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('onglets-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const erreurs = [];
    // ── Un onglet : la session lue, la connexion est appliquée une seule fois ──
    const ctx1 = await contexteConnecte(nav, core.urlMain, core.comptes.admin);
    const page = await ctx1.newPage();
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const api = [];
    const reconnexions = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) api.push(u.pathname + u.search); });
    page.on('console', (m) => { if (/\[sse\] Reconnect/.test(m.text())) reconnexions.push(m.text()); });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await pause(3000);
    const fois = (u) => api.filter((x) => x === u).length;
    const connexion = ['/api/system-events', '/api/inbox/count', '/api/notifications?limit=50', '/api/saved/chats?archived=0', '/api/notifications/unread-count', '/api/llm/connectors'];
    v.ok('démarrage : un seul flux système', fois('/api/system-events') === 1, String(fois('/api/system-events')));
    v.ok('démarrage : requêtes de la connexion lancées une fois', connexion.every((u) => fois(u) <= 1), connexion.map((u) => `${u}×${fois(u)}`).join(' '));
    v.ok('démarrage : aucune fausse reconnexion du flux', reconnexions.length === 0, reconnexions.join(' | '));
    await ctx1.close();

    // ── Huit onglets du même navigateur (HTTP/1.1 : 6 connexions par hôte) ──
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.admin);
    let flux = 0;
    const meneurs = new Set();
    const pages = [];
    const durees = [];
    for (let n = 0; n < 8; n++) {
        const p = await ctx.newPage();
        p.on('pageerror', (e) => erreurs.push(String(e.message || e)));
        p.on('request', (r) => { if (r.url().includes('/api/system-events')) { flux += 1; meneurs.add(p); } });
        const t0 = Date.now();
        const ok = await p.goto(core.urlMain + '/', { timeout: 15000 }).then(() => attendreMontage(p, 15000)).then(() => true, () => false);
        durees.push(ok ? Date.now() - t0 : null);
        pages.push(p);
    }
    v.ok('8 onglets chargés', durees.every((d) => d !== null && d < 10000), durees.join(', '));
    await pause(1000);
    v.ok('un seul flux système pour les 8 onglets', flux === 1, String(flux));

    const console_ = new Client(core.urlAdmin);
    await console_.req('POST', '/api/login-lite', core.comptes.admin);
    const recue = (p, n) => p.waitForFunction((m) => new RegExp(`${m} notification\\(s\\) non lue`).test(document.getElementById('app').innerHTML), n, { timeout: 15000, polling: 100 }).then(() => true, () => false);
    await console_.req('POST', '/api/admin/report/daily/generate', {});
    const r1 = await Promise.all(pages.map((p) => recue(p, 1)));
    v.ok('notification reçue dans chacun des 8 onglets', r1.every(Boolean), r1.join(','));

    // ── Fermeture du meneur : un autre onglet reprend le flux ──
    const meneur = pages.find((p) => meneurs.has(p));
    const restants = pages.filter((p) => p !== meneur);
    await meneur.close();
    const t0 = Date.now();
    while (flux < 2 && Date.now() - t0 < 10000) await pause(50);
    v.ok('fermeture du meneur : un seul nouveau flux, ouvert par un autre onglet', flux === 2 && restants.filter((p) => meneurs.has(p)).length === 1, `${flux} flux en ${Date.now() - t0} ms`);
    await pause(1000);
    await console_.req('POST', '/api/admin/report/daily/generate', {});
    const r2 = await Promise.all(restants.map((p) => recue(p, 2)));
    v.ok('après la reprise, nouvelle notification dans les 7 onglets', r2.every(Boolean), r2.join(','));
    await pause(500);
    v.ok('toujours un seul flux après la reprise', flux === 2, String(flux));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
