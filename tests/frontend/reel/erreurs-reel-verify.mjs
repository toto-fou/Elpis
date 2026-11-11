// SPDX-License-Identifier: MIT
/** tests/frontend/reel/erreurs-reel-verify.mjs — erreurs et avertissements contre le core TS réel : dépassement de contexte (message actionnable, avis du fournisseur, partiel gardé), clé refusée, conversation trop longue (avertissement et « Compacter »), reprise normale ensuite */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/erreurs-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBORDEMENT = { statut: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error' };

const v = verifications('erreurs-reel');
const core = await demarrerCoreReel({ tokParS: 200, llm: { nCtx: 4096 } });
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const texte = () => page.evaluate(() => (document.getElementById('app') || {}).innerText || '');
    const tour = async (msg) => {
        await page.locator('textarea[placeholder]').last().fill(msg);
        await page.locator('button:has(i.ph-paper-plane-right)').last().click();
        await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
        await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
        await pause(500);
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const [a, b] = core.chats;
    await page.locator('[data-chat-row]', { hasText: a.titre }).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${a.titre} : question 1`, { timeout: 15000 }).catch(() => {});

    // ── Dépassement de contexte refusé par le moteur ──
    const n0 = core.llm.completions().length;
    core.llm.scripter({ erreur: DEBORDEMENT });
    await tour('Analyse ce très gros document.');
    const t1 = await texte();
    v.ok('débordement : la cause est nommée (fenêtre de contexte)', /dépasse la fenêtre de contexte/i.test(t1), t1.slice(-300));
    v.ok('débordement : gestes proposés (compacter, nouveau chat)', /compactez/i.test(t1) && /nouveau chat/i.test(t1));
    v.ok('débordement : la réponse partielle est annoncée conservée', /partielle est conservée/i.test(t1));
    v.ok('débordement : l\'avis du fournisseur est cité, sans jargon HTTP en tête', t1.includes('exceeds the available context size') && !/400 Bad Request/.test(t1));
    v.ok('débordement : erreur déterministe, aucune relance au moteur', core.llm.completions().length === n0 + 1, String(core.llm.completions().length - n0));

    // ── Clé refusée par le moteur ──
    core.llm.scripter({ erreur: { statut: 401, message: 'invalid api key', type: 'authentication_error' } });
    await tour('Encore une question.');
    v.ok('clé refusée : message dédié (la clé n\'ouvre pas ce modèle)', /n'ouvre pas ce modèle/.test(await texte()));

    // ── Reprise : un tour normal passe ensuite ──
    core.llm.scripter('Tout va bien maintenant, REPONSE-NORMALE.');
    await tour('Et maintenant ?');
    v.ok('après les erreurs : un tour normal aboutit', (await texte()).includes('REPONSE-NORMALE'));

    // ── Conversation trop longue pour la fenêtre : avertissement avec « Compacter » ──
    await page.locator('[data-chat-row]', { hasText: b.titre }).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${b.titre} : question 1`, { timeout: 15000 }).catch(() => {});
    core.llm.scripter('Je réponds malgré tout.');
    await page.locator('textarea[placeholder]').last().fill('Lis ceci : ' + 'texte très long et répétitif '.repeat(900));
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForFunction(() => /Contexte maximum atteint/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
    const t4 = await texte();
    v.ok('trop long : avertissement « Contexte maximum atteint » affiché', /Contexte maximum atteint/.test(t4));
    v.ok('trop long : le toast propose « Compacter »', await page.locator('button', { hasText: 'Compacter' }).count() > 0);
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
