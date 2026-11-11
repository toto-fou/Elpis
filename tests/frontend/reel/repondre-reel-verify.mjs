// SPDX-License-Identifier: MIT
/** tests/frontend/reel/repondre-reel-verify.mjs — « Répondre maintenant » contre le core TS réel : pendant le raisonnement, voie native (`reasoning_end` relayé au moteur, réponse dans le même flux, aucune relance) puis repli quand le moteur refuse (annulation et relance du tour) */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/repondre-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const LONG = `Je réfléchis longuement ${Array.from({ length: 200 }, (_, i) => `idée${i}`).join(' ')} fin de réflexion.`;
const v = verifications('repondre-reel');
const core = await demarrerCoreReel({ tokParS: 20, llm: { gabarit: '{% if enable_thinking %}<think>{% endif %}' } });
// Déroulé « Classique » du fil : ces vérifications visent ce déroulé (fil chronologique : fil-reel-verify.mjs).
for (const compte of Object.values(core.comptes)) { const c = new Client(core.urlMain); await c.req('POST', '/api/login-lite', compte); await c.req('PUT', '/api/settings', { chat_workflow: 'classic' }); }
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const envois = [];
    const annulations = [];
    page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().includes('/api/chat-saved-stream3')) envois.push(r.url());
        if (r.url().includes('/api/chat/cancel')) annulations.push(r.url());
    });
    const texte = () => page.evaluate(() => (document.getElementById('app') || {}).textContent || '');
    const essai = async (chat, reponses) => {
        await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
        await page.waitForTimeout(800);
        const [e0, a0, c0] = [envois.length, annulations.length, core.llm.etat.controles.length];
        core.llm.scripter(...reponses);
        await page.locator('textarea[placeholder]').last().fill('Réfléchis puis réponds');
        await page.locator('button:has(i.ph-paper-plane-right)').last().click();
        const bouton = page.locator('button:has-text("Répondre maintenant")').first();
        const vu = await bouton.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
        await page.waitForFunction(() => /idée5\b/.test(document.body.textContent || ''), null, { timeout: 15000 }).catch(() => {});
        await bouton.click().catch(() => {});
        await page.waitForFunction(() => /Réponse (sans|après) relance/.test((document.getElementById('app') || {}).textContent || ''), null, { timeout: 30000 }).catch(() => {});
        await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
        return { vu, envois: envois.length - e0, annulations: annulations.length - a0, controles: core.llm.etat.controles.slice(c0) };
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);

    // ── Voie native : le core relaie reasoning_end, la réponse suit dans le même flux ──
    const natif = await essai(core.chats[0], [{ raisonnement: LONG, contenu: 'Réponse sans relance.' }]);
    v.ok('natif : bouton « Répondre maintenant » pendant le raisonnement', natif.vu);
    v.ok('natif : le core demande reasoning_end au moteur pour la complétion en cours', natif.controles.length >= 1 && natif.controles[0].action === 'reasoning_end' && /^chatcmpl-/.test(natif.controles[0].id), JSON.stringify(natif.controles));
    const t1 = await texte();
    v.ok('natif : réponse dans le même flux, sans relance ni annulation, raisonnement coupé', /Réponse sans relance/.test(t1) && natif.envois === 1 && natif.annulations === 0 && !t1.includes('fin de réflexion'), JSON.stringify(natif));
    v.ok('natif : bloc de raisonnement replié', !(await page.evaluate(() => !!document.querySelector('details[data-think][open]'))));

    // ── Moteur sans contrôle : repli par annulation et relance ──
    core.llm.etat.controleKo = true;
    const repli = await essai(core.chats[1], [{ raisonnement: LONG, contenu: 'Réponse qui ne doit pas arriver.' }, 'Réponse après relance.']);
    v.ok('repli : le refus du moteur déclenche l\'annulation et la relance du tour', repli.vu && repli.controles.length >= 1 && repli.envois === 2 && repli.annulations >= 1, JSON.stringify(repli));
    v.ok('repli : la réponse vient de la relance', /Réponse après relance/.test(await texte()) && !/ne doit pas arriver/.test(await texte()));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
