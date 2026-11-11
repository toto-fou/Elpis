// SPDX-License-Identifier: MIT
/** tests/frontend/reel/notifications-reel-verify.mjs — notifications contre le core TS réel : rapport d'usage généré par la console, reçu en direct par la page (toast « Voir », badge), panneau groupé par date, lu / non lu, tout lu, effacer avec « Annuler », état relu du core, réglage « Notifications système » */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/notifications-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('notifications-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const console_ = new Client(core.urlAdmin);
    await console_.req('POST', '/api/login-lite', core.comptes.admin);
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.admin);
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.admin);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const texte = () => page.locator('#app').innerText().catch(() => '');
    const nonLues = async () => { const r = await api.req('GET', '/api/notifications/unread-count'); return Number(r.count ?? r.unread ?? r.n ?? -1); };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await pause(1500);
    v.ok('compte neuf : aucune notification non lue', await nonLues() === 0 && !/notification\(s\) non lue/.test(await page.locator('#app').innerHTML()));

    // ── Rapport généré par la console : la page main le reçoit en direct ──
    await console_.req('POST', '/api/admin/report/daily/generate', {});
    await page.waitForFunction(() => /Rapport d'usage IA/.test(document.getElementById('app').innerText), null, { timeout: 15000 }).catch(() => {});
    v.ok('en direct : toast « Rapport d\'usage IA » avec « Voir »', /Rapport d'usage IA/.test(await texte()) && await page.locator('button:has-text("Voir"):visible').first().isVisible().catch(() => false));
    await page.waitForFunction(() => /notification\(s\) non lue/.test(document.getElementById('app').innerHTML), null, { timeout: 10000 }).catch(() => {});
    v.ok('badge des non-lues, compteur du core à 1', /1 notification\(s\) non lue/.test(await page.locator('#app').innerHTML()) && await nonLues() === 1);

    // ── Panneau : groupement, lu / non lu ──
    await page.locator('button[title*="otification"]:visible').first().click();
    await pause(600);
    const t = await texte();
    v.ok('panneau : titre, groupe « Aujourd\'hui », la notification du rapport', /Notifications/.test(t) && /aujourd'hui/i.test(t) && /Rapport d'usage IA/.test(t), t.slice(0, 200));
    await pause(800);
    v.ok('ouverture du panneau : non-lues soldées dans le core, gardées « nouvelles » à l\'écran', await nonLues() === 0 && await page.locator('.sr-only:text("Non lue :")').count() === 1);
    await page.locator('button[title="Marquer comme non lu"]').first().click({ force: true });
    await pause(600);
    v.ok('« Marquer comme non lu » : compteur du core à 1, badge revenu', await nonLues() === 1 && /1 notification\(s\) non lue/.test(await page.locator('#app').innerHTML()));
    await page.locator('button[title="Marquer comme lu"]').first().click({ force: true });
    await pause(600);
    v.ok('« Marquer comme lu » : compteur du core à 0, badge retiré', await nonLues() === 0 && !/notification\(s\) non lue/.test(await page.locator('#app').innerHTML()));
    await page.keyboard.press('Escape');
    await page.mouse.click(900, 400);
    await console_.req('POST', '/api/admin/report/daily/generate', {});
    await page.waitForFunction(() => /1 notification\(s\) non lue/.test(document.getElementById('app').innerHTML), null, { timeout: 15000 }).catch(() => {});
    v.ok('seconde notification reçue en direct : 1 non lue, 2 dans le core', await nonLues() === 1 && ((await api.req('GET', '/api/notifications')).items || []).length === 2);
    await page.locator('button[title*="otification"]:visible').first().click();
    await pause(600);
    await page.locator('button[title="Marquer comme non lu"]').nth(1).click({ force: true });
    await pause(400);
    await page.locator('button[title="Tout marquer comme lu"]').first().click({ force: true });
    await pause(600);
    v.ok('« Tout marquer comme lu » : 0 non lue dans le core', await nonLues() === 0);
    await page.reload();
    await attendreMontage(page);
    await pause(800);
    await page.locator('button[title*="otification"]:visible').first().click();
    await pause(600);
    v.ok('après rechargement : notifications relues du core, toutes lues', /Rapport d'usage IA/.test(await texte()) && !/notification\(s\) non lue/.test(await page.locator('#app').innerHTML()));
    // « Effacer » : liste vidée aussitôt, toast « Annuler » ; le core n'est vidé qu'à la fin du toast.
    await page.locator('[data-notif-effacer]').first().click({ force: true });
    await pause(400);
    const annulerNotifs = page.locator('button', { hasText: 'Annuler' }).last();
    v.ok('« Effacer » : toast « Annuler », core encore intact', await annulerNotifs.count() === 1
        && ((await api.req('GET', '/api/notifications')).items || []).length > 0);
    await annulerNotifs.click();
    await pause(400);
    v.ok('« Annuler » : notifications rétablies', (await page.evaluate(() => window.__racine().notifications.length)) > 0);
    // Le clic sur le toast a refermé le panneau (clic extérieur) : on le rouvre.
    if (!(await page.locator('[data-notif-effacer]').count())) await page.locator('button[title*="otification"]:visible').first().click();
    await pause(600);
    await page.locator('[data-notif-effacer]').first().click({ force: true });
    await pause(7000);
    const restantes = await api.req('GET', '/api/notifications');
    v.ok('« Effacer » sans annuler : plus aucune notification dans le core', ((restantes.items || restantes.notifications || [])).length === 0, JSON.stringify(restantes).slice(0, 160));
    await page.keyboard.press('Escape');

    // ── Réglage du compte ──
    await page.locator('button[title="Paramètres"]:visible').first().click();
    const dialogue = page.locator('div[role="dialog"][aria-label="Paramètres"]');
    await dialogue.waitFor({ timeout: 10000 }).catch(() => {});
    await dialogue.locator('button:has-text("Chat")').first().click().catch(() => {});
    await pause(400);
    v.ok('Paramètres › Chat : réglage « Notifications système »', /Notifications système/.test(await texte()));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
