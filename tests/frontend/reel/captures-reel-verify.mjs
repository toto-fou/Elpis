// SPDX-License-Identifier: MIT
/** tests/frontend/reel/captures-reel-verify.mjs — captures du navigateur (fil chronologique) contre le core TS réel, conversation relue de la base : plus de carrousel, appareil photo sur les étapes, « 2 captures » au pied, visionneuse en mode captures (étape, Télécharger seul, ←, Échap), « Masquer les captures web », déroulé Classique intact */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=…] node tests/frontend/reel/captures-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, apparait, disparait, Client } from '../lib/core-reel.mjs';

// PNG 1×1 servi à la place du service navigateur, absent du banc.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const appel = (id, nom, args) => ({ id, type: 'function', function: { name: nom, arguments: JSON.stringify(args) } });
const resultat = (id, contenu) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(contenu) });

const v = verifications('captures-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { chat_workflow: 'timeline', hide_web_screenshots: false });
    const { id } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${id}/save-messages`, {
        title: 'Captures',
        messages: [
            { role: 'user', content: 'Captures : vérifie le bandeau de maintenance.' },
            {
                role: 'assistant',
                content: 'Le bandeau de maintenance s\'affiche bien, y compris après une erreur de saisie.',
                tool_history: [
                    { role: 'assistant', content: 'J\'ouvre la page de connexion.', tool_calls: [appel('c1', 'pw_page', { action: 'goto', url: 'https://intranet.lan/connexion' })] },
                    resultat('c1', { success: true, url: 'https://intranet.lan/connexion' }),
                    { role: 'assistant', content: 'Le bandeau est là, je vérifie après une erreur de saisie.', tool_calls: [appel('c2', 'pw_act', { action: 'click', target: 'Se connecter' })] },
                    resultat('c2', { success: true }),
                ],
                tool_meta: { steps: {
                    c1: { ms: 1400, shot: '/api/playwright/screenshot/s1/1.png', shot_step: 1 },
                    c2: { ms: 600, shot: '/api/playwright/screenshot/s1/2.png', shot_step: 2 },
                } },
            },
        ],
    });

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await page.route('**/api/playwright/screenshot/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    const ouvrir = async () => {
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        await page.locator('[data-chat-row]', { hasText: 'Captures' }).first().click();
        await page.waitForFunction(() => document.body.innerText.includes('Captures : vérifie'), null, { timeout: 15000 }).catch(() => {});
        await pause(600);
    };
    const bulle = page.locator('#app .elpis-msg-assistant').last();
    const cams = bulle.locator('[data-voir-capture]');
    const pied = bulle.locator('[data-voir-captures]');
    const images = bulle.locator('img[src*="/api/playwright/screenshot/"], img[src^="blob:"]');
    const vis = page.locator('[data-image-viewer]');
    const ecran = async (nom) => { if (process.env.ELPIS_CAPTURES) await page.screenshot({ path: `${process.env.ELPIS_CAPTURES}/${nom}.png` }); };
    const titre = async () => (await vis.locator('.elpis-img-viewer__prompt').innerText()).trim();

    // ── Déroulés en fil : captures à la demande ──
    await ouvrir();
    v.ok('aucune image dans le fil (plus de carrousel)', (await images.count()) === 0);
    const libelles = await cams.evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')));
    v.ok('appareil photo sur chaque étape qui a pris une capture', libelles.join('|') === 'Voir la capture de l’étape 1|Voir la capture de l’étape 2', libelles.join('|'));
    await ecran('captures-fil');
    v.ok('« 2 captures » au pied', (await pied.innerText().catch(() => '')).trim() === '2 captures');
    await cams.nth(1).click();
    await apparait(vis);
    v.ok('visionneuse : capture du navigateur, ouverte sur l\'étape 2', (await vis.getAttribute('aria-label')) === 'Capture du navigateur' && (await titre()).startsWith('Étape 2 · '), await titre());
    await ecran('captures-visionneuse');
    const actions = (await vis.locator('.elpis-img-btn').allInnerTexts()).map((s) => s.trim());
    v.ok('visionneuse : Télécharger seul (ni Modifier, ni Copier, ni Supprimer)', actions.join('|') === 'Télécharger', actions.join('|'));
    v.ok('visionneuse : image chargée', await vis.locator('img').evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false));
    await page.keyboard.press('ArrowLeft');
    v.ok('← : capture de l\'étape 1', (await titre()).startsWith('Étape 1 · '), await titre());
    await page.keyboard.press('Escape');
    await disparait(vis).catch(() => {});
    v.ok('Échap ferme la visionneuse', (await vis.count()) === 0);
    await pied.click();
    await apparait(vis);
    v.ok('le pied ouvre la première capture', (await titre()).startsWith('Étape 1 · '), await titre());
    await page.keyboard.press('Escape');
    await disparait(vis).catch(() => {});

    // ── « Masquer les captures web » ──
    await api.req('PUT', '/api/settings', { hide_web_screenshots: true });
    await ouvrir();
    v.ok('réglage : ni appareil photo, ni « captures », ni image', (await cams.count()) === 0 && (await pied.count()) === 0 && (await images.count()) === 0);

    // ── Déroulé Classique : carrousel inchangé ──
    await api.req('PUT', '/api/settings', { hide_web_screenshots: false, chat_workflow: 'classic' });
    await ouvrir();
    v.ok('classique : carrousel des captures, sans boutons du fil chronologique', (await images.count()) >= 1 && (await cams.count()) === 0 && (await pied.count()) === 0);
    await api.req('PUT', '/api/settings', { chat_workflow: 'timeline' });
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} catch (e) {
    console.error(e);
    console.error(core.journaux.main.join('').slice(-3000));
    v.ok('parcours mené à son terme', false, String(e.message || e));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
