// SPDX-License-Identifier: MIT
/** tests/frontend/reel/reflexion-reel-verify.mjs — réflexion contre le core TS réel : puce « tk » exacte, estimée ou absente, part du cache, raisonnement coupé puis repris (« Continuer »), raisonnement seul promu en réponse */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/reflexion-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const RAISONNEMENT = 'Je dois analyser le problème étape par étape, comparer les options';
// LLAMA_THINK_RESUME_MAX=1 : une seule reprise automatique d'un raisonnement coupé, pour atteindre la bannière en deux appels.
const espaces = (t) => String(t || '').replace(/[  ]/g, ' ');

const v = verifications('reflexion-reel');
const core = await demarrerCoreReel({ tokParS: 200, llm: { gabarit: '{% if enable_thinking %}<think>{% endif %}' }, envSup: { LLAMA_THINK_RESUME_MAX: '1' } });
// Déroulé « Classique » du fil : ces vérifications visent ce déroulé (fil chronologique : fil-reel-verify.mjs).
for (const compte of Object.values(core.comptes)) { const c = new Client(core.urlMain); await c.req('POST', '/api/login-lite', compte); await c.req('PUT', '/api/settings', { chat_workflow: 'classic' }); }
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const corps = [];
    page.on('request', (r) => { if (r.url().includes('/api/chat-saved-stream3') && r.method() === 'POST') corps.push(r.postDataJSON()); });
    const ligne = () => page.locator('#app [title^="Modèle :"]').last();
    const envoyer = async (texte) => {
        await page.locator('textarea[placeholder]').last().fill(texte);
        await page.locator('button:has(i.ph-paper-plane-right)').last().click();
        await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
        await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
    };
    const mesure = async () => {
        await ligne().waitFor({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(200);
        return { texte: espaces(await ligne().textContent().catch(() => '')), titre: espaces(await ligne().getAttribute('title').catch(() => '')) };
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: core.chats[2].titre }).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${core.chats[2].titre} : question 1`, { timeout: 15000 }).catch(() => {});

    // ── Puce de réflexion : compte exact (natif), part du cache ──
    core.llm.scripter({ raisonnement: 'Je pèse les options une à une.', contenu: 'Réponse EXACTE.', usage: { prompt_tokens: 5200, completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 640 } }, timings: { cache_n: 4800 } });
    await envoyer('cas exact');
    const m1 = await mesure();
    v.ok('compte exact : puce « 640 tk » sans « ≈ »', /640\s*tk/.test(m1.texte) && !/≈/.test(m1.texte), m1.texte);
    v.ok('compte exact : modèle et débit (jetons/s) gardés sur la ligne', m1.texte.includes('faux-modele') && /jetons\/s/.test(m1.texte), m1.texte);
    v.ok('part du cache sur la ligne (« cache 92 % »)', /cache 92\s*%/.test(m1.texte), m1.texte);
    v.ok('infobulle : entrée découpée en cache et utile', /Entrée 5 200 · cache 4 800 \(92 %\) · utile 400/.test(m1.titre), m1.titre);
    v.ok('infobulle : la réflexion fait partie de la sortie', /Sortie 1 000 · réflexion 640 · réponse 360/.test(m1.titre), m1.titre);

    // ── Compte estimé : /tokenize indisponible ──
    core.llm.etat.tokenizeKo = true;
    core.llm.scripter({ raisonnement: 'Je réfléchis encore un peu à la question posée.', contenu: 'Réponse ESTIMEE.' });
    await envoyer('cas estimé');
    const m2 = await mesure();
    core.llm.etat.tokenizeKo = false;
    v.ok('compte estimé : puce préfixée « ≈ »', /≈\s*\d+\s*tk/.test(m2.texte), m2.texte);
    v.ok('compte estimé : l\'infobulle porte aussi le « ≈ »', /réflexion ≈/.test(m2.titre), m2.titre);
    v.ok('sans cache : rien sur la ligne', !/cache/.test(m2.texte), m2.texte);

    // ── Aucune réflexion : aucune puce ──
    core.llm.scripter('Réponse SANS-REFLEXION.');
    await envoyer('cas sans réflexion');
    const m3 = await mesure();
    v.ok('sans réflexion : aucune puce (surtout pas « 0 tk »)', !/\btk\b/.test(m3.texte) && !/réflexion/.test(m3.titre), `${m3.texte} | ${m3.titre}`);
    v.ok('sans réflexion : le reste de la ligne est intact, infobulle sans découpe de la sortie', m3.texte.trim().length > 0 && /Sortie/.test(m3.titre.replace(/[\u202f\u00a0]/g, ' ')), `${m3.texte} | ${m3.titre}`);

    // ── Raisonnement coupé : le core le reprend seul (une reprise permise ici) ──
    const n0 = core.llm.completions().length;
    core.llm.scripter({ raisonnement: 'Première moitié du raisonnement AUTO-REPRIS', contenu: '', fin: 'length' }, 'Conclusion de la REPRISE-AUTO.');
    await envoyer('déclenche une reprise automatique');
    const reprise = core.llm.completions().slice(n0);
    v.ok('reprise automatique : un second appel porte le raisonnement interrompu', reprise.length === 2 && JSON.stringify(reprise[1].corps.messages || []).includes('AUTO-REPRIS'), String(reprise.length));
    v.ok('reprise automatique : la conclusion s\'affiche, sans bannière', await page.locator('.markdown-body', { hasText: 'REPRISE-AUTO' }).count() > 0
        && await page.locator('[role="status"]:has-text("Continuer")').count() === 0);

    // ── Coupé deux fois : plafond de reprises atteint, l'utilisateur reprend la main ──
    core.llm.scripter({ raisonnement: RAISONNEMENT, contenu: '', fin: 'length' }, { raisonnement: ' puis la suite du raisonnement', contenu: '', fin: 'length' });
    await envoyer('déclenche coupure');
    const banniere = page.locator('[role="status"]:has-text("Continuer")').last();
    await banniere.waitFor({ timeout: 10000 }).catch(() => {});
    const bulle = await page.evaluate(() => ([...document.querySelectorAll('.markdown-body')].pop() || {}).textContent || '');
    v.ok('coupure : le raisonnement n\'est pas promu en réponse', !bulle.includes('analyser le problème'), bulle.slice(0, 80));
    const pense = page.locator('details[data-think]').last();
    v.ok('coupure : bloc Réflexion peuplé, titre « Réflexion interrompue »', (await pense.locator('pre').innerText().catch(() => '')).includes('analyser le problème')
        && /Réflexion interrompue/.test(await pense.locator('summary').innerText().catch(() => '')));
    v.ok('coupure : bannière « Réflexion interrompue » avec « Continuer »', /Réflexion interrompue/.test(await banniere.innerText().catch(() => '')));
    core.llm.scripter('Conclusion depuis le raisonnement.');
    const avant = corps.length;
    await banniere.locator('button:has-text("Continuer")').click();
    await page.locator('text=Conclusion depuis le raisonnement.').first().waitFor({ timeout: 20000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    const suite = corps[avant] || {};
    const dernier = [...(suite.messages || [])].reverse().find((m) => m && m.role === 'assistant') || {};
    v.ok('reprise : le POST porte is_continue et resume_thinking', suite.is_continue === true && String(dernier.resume_thinking || '').includes('analyser le problème'), JSON.stringify(dernier).slice(0, 160));
    const appel = core.llm.completions().pop();
    const envoye = JSON.stringify((appel && appel.corps && appel.corps.messages) || []);
    v.ok('reprise : le marqueur thinkingTruncated est propagé au POST', dernier.thinkingTruncated === true, JSON.stringify(dernier).slice(0, 160));
    v.ok('reprise : le moteur reçoit le raisonnement interrompu', envoye.includes('analyser le problème'));
    v.ok('reprise : conclusion rendue, bannière retirée', await page.locator('text=Conclusion depuis le raisonnement.').count() > 0 && await page.locator('[role="status"]:has-text("Continuer")').count() === 0);
    v.ok('reprise : le titre du bloc de réflexion n\'est plus « Réflexion interrompue »', !/Réflexion interrompue/.test((await page.locator('details[data-think]').last().locator('summary').innerText().catch(() => '')) || ''));

    // ── Raisonnement seul sans coupure : promu en réponse ──
    core.llm.scripter({ raisonnement: 'La vraie réponse est 42.', contenu: '' });
    await envoyer('déclenche promotion');
    await page.locator('.markdown-body', { hasText: 'La vraie réponse est 42.' }).first().waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('raisonnement seul : promu en réponse, sans bannière', await page.locator('.markdown-body', { hasText: 'La vraie réponse est 42.' }).count() > 0
        && await page.locator('[role="status"]:has-text("Continuer")').count() === 0);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
