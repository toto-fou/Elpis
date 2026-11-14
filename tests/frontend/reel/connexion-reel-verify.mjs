// SPDX-License-Identifier: MIT
/** tests/frontend/reel/connexion-reel-verify.mjs — connexion contre le core TS réel : refus d'un mauvais mot de passe, connexion, liste des chats, liste des modèles lue sans geste, déconnexion */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/connexion-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, attendreMontage, verifications } from '../lib/core-reel.mjs';
import { brancherReleveCsp } from '../lib/releve-csp.mjs';

const v = verifications('connexion-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const ctx = await nav.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await brancherReleveCsp(ctx);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const modeles = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/llm/models') modeles.push(r.url()); });
    const lues = async (n) => { for (let i = 0; i < 50 && modeles.length < n; i++) await page.waitForTimeout(100); return modeles.length >= n; };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const identifiant = page.locator('#login-identifiant');
    await identifiant.waitFor({ timeout: 15000 });
    v.ok('carte de connexion affichée sans session', await identifiant.isVisible());

    await identifiant.fill(core.comptes.user.username);
    await page.locator('#login-mdp').fill('mauvais-mot-de-passe');
    await page.locator('button[type="submit"]:has-text("Se connecter")').click();
    const erreur = page.locator('form [role="alert"]').first();
    await erreur.waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('mauvais mot de passe refusé avec un message', await erreur.isVisible(), await erreur.textContent().catch(() => ''));

    await page.locator('#login-mdp').fill(core.comptes.user.password);
    await page.locator('button[type="submit"]:has-text("Se connecter")').click();
    await identifiant.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    v.ok('carte de connexion fermée après connexion', !(await identifiant.isVisible()));
    const titre = page.locator(`text=${core.chats[0].titre}`).first();
    await titre.waitFor({ timeout: 15000 }).catch(() => {});
    v.ok('chats de la fixture listés dans la barre latérale', await titre.isVisible());
    const me = await page.evaluate(async () => (await fetch('/api/me-lite')).json());
    v.ok('session ouverte au nom du compte', me.logged_in === true && me.username === 'alice', JSON.stringify(me));

    // Le premier envoi a besoin du modèle et de ses réglages : la liste est lue à l'arrivée du compte, sans geste.
    v.ok('liste des modèles lue à la connexion, sans geste', await lues(1), String(modeles.length));
    const avant = modeles.length;
    await page.reload();
    await attendreMontage(page);
    v.ok('liste des modèles relue au rechargement de la page, session ouverte', await lues(avant + 1), String(modeles.length - avant));

    await page.evaluate(async () => { await fetch('/api/logout-lite', { method: 'POST' }); });
    await page.reload();
    await attendreMontage(page);
    await identifiant.waitFor({ timeout: 15000 }).catch(() => {});
    v.ok('après déconnexion, retour à la carte de connexion', await identifiant.isVisible());
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
