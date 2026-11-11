// SPDX-License-Identifier: MIT
/** tests/frontend/reel/session-reel-verify.mjs — session contre le core TS réel : panne réseau sans expiration, 401 concurrents traités une fois, reconnexion, déconnexion volontaire */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/session-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, attendreMontage, verifications, contexteConnecte } from '../lib/core-reel.mjs';

const v = verifications('session-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    let fluxSysteme = 0;
    page.on('request', (r) => { if (r.url().includes('/api/system-events')) fluxSysteme += 1; });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const titre = page.locator(`text=${core.chats[0].titre}`).first();
    await titre.waitFor({ timeout: 15000 }).catch(() => {});
    const etat = () => page.evaluate(() => ({ ...window.__racine().sessionPage.etat }));
    const e0 = await etat();
    v.ok('session TS ouverte au chargement', e0.statut === 'connecte' && e0.compte.username === 'alice', JSON.stringify(e0));
    await page.waitForFunction(() => true, null, { timeout: 1000 });
    v.ok('flux SSE système ouvert', fluxSysteme >= 1, String(fluxSysteme));

    await page.route('**/api/saved/chats', (r) => r.abort('internetdisconnected'));
    const reseau = await page.evaluate(async () => (await window.__racine().httpPage.requete('/api/saved/chats')).type);
    await page.unroute('**/api/saved/chats');
    v.ok('panne réseau classée « reseau »', reseau === 'reseau', reseau);
    v.ok('panne réseau : session toujours ouverte', (await etat()).statut === 'connecte');

    const refus = await page.evaluate(async () => {
        const r = await window.__racine().httpPage.requete('/api/admin/users');
        return r.type === 'refus' || r.type === 'requete' ? r.type + ':' + r.statut : r.type;
    });
    v.ok('route réservée : refus sans expiration', /^(refus:403|requete:404)$/.test(refus) && (await etat()).statut === 'connecte', refus);

    await ctx.clearCookies();
    const types = await page.evaluate(async () => {
        const rs = await Promise.all(['/api/saved/chats', '/api/inbox/count', '/api/saved/chats'].map((u) => window.__racine().httpPage.requete(u)));
        return rs.map((r) => r.type).sort();
    });
    v.ok('401 concurrents : au plus une expiration, les autres périmées', types.filter((t) => t === 'expiration').length <= 1 && types.every((t) => t === 'expiration' || t === 'perime'), JSON.stringify(types));
    const e1 = await etat();
    v.ok('session expirée (raison « expiration »)', e1.statut === 'deconnecte' && e1.raison === 'expiration', JSON.stringify(e1));
    const identifiant = page.locator('#login-identifiant');
    await identifiant.waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('carte de connexion affichée après expiration', await identifiant.isVisible());
    const toasts = await page.locator('text=Session expirée').count();
    v.ok('un seul message d\'expiration', toasts === 1, String(toasts));
    const fluxAvant = fluxSysteme;
    await page.waitForTimeout(2500);
    v.ok('aucune reconnexion SSE sans session', fluxSysteme === fluxAvant, `${fluxAvant} → ${fluxSysteme}`);

    await identifiant.fill(core.comptes.user.username);
    await page.locator('#login-mdp').fill(core.comptes.user.password);
    await page.locator('button[type="submit"]:has-text("Se connecter")').click();
    await identifiant.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    const e2 = await etat();
    v.ok('reconnexion : nouvelle génération', e2.statut === 'connecte' && e2.generation > e1.generation, JSON.stringify(e2));
    await titre.waitFor({ timeout: 15000 }).catch(() => {});
    v.ok('chats rechargés après reconnexion', await titre.isVisible());
    await page.waitForTimeout(300);
    v.ok('flux SSE rouvert après reconnexion', fluxSysteme > fluxAvant, `${fluxAvant} → ${fluxSysteme}`);

    // « Se déconnecter » vit dans le menu du compte (nom du pied du volet).
    await page.locator('[data-menu-compte]:visible').first().click();
    await page.locator('[data-compte-sortie]').click();
    await identifiant.waitFor({ timeout: 10000 }).catch(() => {});
    const e3 = await etat();
    v.ok('déconnexion volontaire (raison « deconnexion »)', e3.statut === 'deconnecte' && e3.raison === 'deconnexion', JSON.stringify(e3));
    const me = await page.evaluate(async () => (await fetch('/api/me-lite')).json());
    v.ok('cookie de session invalidé côté serveur', me.logged_in === false, JSON.stringify(me));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
