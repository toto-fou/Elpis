// SPDX-License-Identifier: MIT
/** tests/frontend/reel/moteurs-reel-verify.mjs — vLLM 0.31.0 et SGLang 0.5.21 en moteur par défaut, contre le core TS réel : réflexion offerte, bloc Réflexion en direct puis après rechargement (avec parseur, et `</think>` orphelin sans parseur), réflexion coupée, effort envoyé au moteur (menu du modèle et panneau « Génération ») */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/moteurs-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const PENSEE_1 = 'Je compare les deux options une à une avant de conclure PENSEE-UN.';
const REPONSE_1 = 'Le résultat est QUARANTE-DEUX.';
const PENSEE_2 = 'Le gabarit a ouvert la réflexion, je pèse encore PENSEE-DEUX.';
const REPONSE_2 = 'Réponse finale SANS-PARSEUR.';
const PENSEE_3 = 'Il faut chercher dans les conversations passées avant de répondre PENSEE-TROIS.';
const REPONSE_3 = 'Rien trouvé, réponse OUTIL-FINI.';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('moteurs-reel');

for (const dialecte of ['vllm', 'sglang']) {
    const core = await demarrerCoreReel({ tokParS: 80, outilsEnProcessus: true, llm: { dialecte }, envSup: { LLAMA_ENGINE: dialecte }, configSup: { app: { enable_model_selector: true } } });
    // Déroulé « Classique » du fil : ces vérifications visent ce déroulé (fil chronologique : fil-reel-verify.mjs).
    for (const compte of Object.values(core.comptes)) { const c = new Client(core.urlMain); await c.req('POST', '/api/login-lite', compte); await c.req('PUT', '/api/settings', { chat_workflow: 'classic' }); }
    const nav = await lancerNavigateur();
    try {
        const api = new Client(core.urlMain);
        await api.req('POST', '/api/login-lite', core.comptes.user);
        await api.req('PUT', '/api/settings', { memory_enabled: true });
        const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
        const page = await ctx.newPage();
        const erreurs = [];
        page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
        const tours = [];
        page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/api/chat-saved-stream3')) tours.push(r.postDataJSON()); });
        const parametres = page.waitForResponse((r) => r.url().includes('/effective-params'), { timeout: 20000 }).catch(() => null);
        const envoyer = async (texte, attendreFin = true) => {
            await page.locator('textarea[placeholder]').last().fill(texte);
            await page.locator('button:has(i.ph-paper-plane-right)').last().click();
            await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
            if (attendreFin) await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
        };
        const moteur = () => (core.llm.completions().at(-1) || {}).corps || {};
        const reflexion = (i = -1) => page.locator('details[data-think]').nth(i).locator('pre').textContent().catch(() => '');
        const bulles = () => page.evaluate(() => [...document.querySelectorAll('.markdown-body')].map((n) => n.textContent || ''));
        const ouvrirChat = async () => {
            await page.locator('[data-chat-row]', { hasText: core.chats[0].titre }).first().click();
            await page.waitForFunction((t) => document.body.innerText.includes(t), `${core.chats[0].titre} : question 1`, { timeout: 15000 }).catch(() => {});
            await pause(500);
        };
        await page.goto(core.urlMain + '/');
        await attendreMontage(page);
        const lus = await (await parametres)?.json().catch(() => null);
        v.ok(`${dialecte} : réflexion et effort déclarés par le dialecte du moteur (sans /props)`, lus && lus.supports_thinking === true && lus.supports_reasoning_effort === true, JSON.stringify(lus || {}).slice(0, 200));
        await ouvrirChat();

        // ── Avec --reasoning-parser : la réflexion arrive dans son champ, affichée en direct ──
        let lacher = () => {};
        const retenue = { apres: 9, promesse: new Promise((r) => { lacher = r; }) };
        core.llm.scripter({ raisonnement: PENSEE_1, contenu: REPONSE_1, retenue });
        await envoyer('question avec parseur', false);
        await page.waitForFunction(() => {
            const pre = [...document.querySelectorAll('details[data-think] pre')].pop();
            return pre && /Je compare/.test(pre.textContent || '');
        }, null, { timeout: 15000 }).catch(() => {});
        const direct = await reflexion();
        v.ok(`${dialecte} : bloc Réflexion peuplé en direct, pendant le flux`, /Je compare/.test(direct) && await page.locator(EN_STREAM).count() > 0, direct);
        lacher();
        await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
        await pause(300);
        const corps1 = moteur();
        v.ok(`${dialecte} : réflexion demandée au moteur (chat_template_kwargs.enable_thinking)`, (corps1.chat_template_kwargs || {}).enable_thinking === true && tours.at(-1)?.thinking_mode === true, JSON.stringify(corps1.chat_template_kwargs));
        v.ok(`${dialecte} : rien de llama.cpp dans la requête`, !('cache_prompt' in corps1) && !('id_slot' in corps1) && !('timings_per_token' in corps1), Object.keys(corps1).join(','));
        v.ok(`${dialecte} : fin du flux, réflexion complète dans son bloc`, (await reflexion()).includes('PENSEE-UN'));
        const b1 = (await bulles()).at(-1) || '';
        v.ok(`${dialecte} : la bulle ne montre que la réponse`, b1.includes('QUARANTE-DEUX') && !b1.includes('PENSEE-UN'), b1);

        // ── Sans parseur, gabarit qui ouvre <think> : seule la fermante sort, reclassée en fin de tour ──
        core.llm.scripter({ raisonnement: PENSEE_2, contenu: REPONSE_2, parseur: false, ouvertureParGabarit: true });
        await envoyer('question sans parseur');
        await pause(300);
        const b2 = (await bulles()).at(-1) || '';
        v.ok(`${dialecte} sans parseur : la bulle finale ne garde que la réponse, sans </think>`, b2.includes('SANS-PARSEUR') && !b2.includes('PENSEE-DEUX') && !b2.includes('</think>'), b2);
        v.ok(`${dialecte} sans parseur : la réflexion passe dans son bloc`, (await reflexion()).includes('PENSEE-DEUX'));

        // ── Rechargement : réflexions et réponses relues depuis la base ──
        await page.reload();
        await attendreMontage(page);
        await ouvrirChat();
        await page.locator('.markdown-body', { hasText: 'SANS-PARSEUR' }).first().waitFor({ timeout: 15000 }).catch(() => {});
        const relues = await bulles();
        const r1 = relues.find((t) => t.includes('QUARANTE-DEUX')) || '';
        const r2 = relues.find((t) => t.includes('SANS-PARSEUR')) || '';
        v.ok(`${dialecte} rechargé : les deux réponses, sans réflexion ni balise`, r1 && r2 && !/PENSEE-(UN|DEUX)/.test(r1 + r2) && !(r1 + r2).includes('</think>'), `${r1} | ${r2}`);
        const blocs = await page.locator('details[data-think] pre').allTextContents().catch(() => []);
        v.ok(`${dialecte} rechargé : chaque tour garde son bloc Réflexion, jamais dans la bulle`, blocs.length === 2 && blocs[0].includes('PENSEE-UN') && blocs[1].includes('PENSEE-DEUX'), blocs.join(' | ').slice(0, 200));

        // ── Nouvel onglet : relu depuis la base seule (la réflexion n'y est pas gardée, par choix du produit) ──
        const onglet = await ctx.newPage();
        await onglet.goto(core.urlMain + '/');
        await attendreMontage(onglet);
        await onglet.locator('[data-chat-row]', { hasText: core.chats[0].titre }).first().click();
        await onglet.locator('.markdown-body', { hasText: 'SANS-PARSEUR' }).first().waitFor({ timeout: 15000 }).catch(() => {});
        const base = await onglet.evaluate(() => [...document.querySelectorAll('.markdown-body')].map((n) => n.textContent || ''));
        const enBase = base.filter((t) => /QUARANTE-DEUX|SANS-PARSEUR/.test(t));
        v.ok(`${dialecte} relu de la base : réponses exactes, aucune réflexion ni balise enregistrée`, enBase.length === 2 && !/PENSEE-(UN|DEUX)|<\/think>/.test(enBase.join('|')), enBase.join(' | '));
        await onglet.close();

        // ── Sans parseur, outil appelé après une fermante orpheline : la narration du round ne garde pas la réflexion ──
        await page.locator('[data-chat-row]', { hasText: core.chats[1].titre }).first().click();
        await page.waitForFunction((t) => document.body.innerText.includes(t), `${core.chats[1].titre} : question 1`, { timeout: 15000 }).catch(() => {});
        await pause(500);
        core.llm.scripter(
            { raisonnement: PENSEE_3, contenu: '', parseur: false, ouvertureParGabarit: true, appels: [{ nom: 'session_search', args: { query: 'capitale' } }] },
            { raisonnement: 'Le résultat est vide.', contenu: REPONSE_3, parseur: false, ouvertureParGabarit: true },
        );
        await envoyer('cherche dans les conversations');
        await pause(400);
        const visible = await page.evaluate(() => document.getElementById('app').innerText);
        const outilAppele = core.llm.completions().slice(-2).length === 2 && JSON.stringify(core.llm.completions().at(-1).corps.messages || []).includes('session_search');
        v.ok(`${dialecte} sans parseur, outil : l'outil est appelé puis la réponse arrive`, outilAppele && visible.includes('OUTIL-FINI'), visible.slice(-300));
        v.ok(`${dialecte} sans parseur, outil : ni réflexion ni </think> hors du bloc Réflexion`, !visible.includes('</think>')
            && await page.evaluate(() => [...document.querySelectorAll('.markdown-body')].every((n) => !/PENSEE-TROIS|<\/think>/.test(n.textContent || ''))), visible.slice(-400));
        const etapes = await page.evaluate(() => [...document.querySelectorAll('details[data-pipeline]')].map((n) => n.textContent || '').join('|'));
        v.ok(`${dialecte} sans parseur, outil : la réflexion du round suit son étape d'outil, celle du dernier round le bloc Réflexion`, etapes.includes('PENSEE-TROIS')
            && /Le résultat est vide/.test(await page.locator('details[data-think] pre').last().textContent().catch(() => '')), etapes.slice(0, 300));

        // ── Effort par « Réflexion › » du menu du modèle, réflexion coupée puis rallumée dans le panneau « Génération » ──
        await page.reload();
        await attendreMontage(page);
        await ouvrirChat();
        const ouvrirEffort = async () => {
            await page.locator('[data-model-manager] > button').first().click();
            await page.locator('[data-effort-menu] > button').click().catch(() => {});
            const menu = page.getByRole('menu', { name: 'Effort de réflexion' });
            await menu.waitFor({ timeout: 5000 }).catch(() => {});
            return menu;
        };
        let sousMenu = await ouvrirEffort();
        const titres = (await sousMenu.getByRole('menuitemradio').evaluateAll((l) => l.map((e) => e.getAttribute('title') || e.textContent.trim())).catch(() => [])).join(' ');
        v.ok(`${dialecte} : « Réflexion › » avec les valeurs du moteur`, /low/.test(titres) && /medium/.test(titres) && /xhigh/.test(titres) && /none/.test(titres), titres);
        await sousMenu.locator('[title="low"]').click().catch(() => {});
        await pause(200);
        await page.locator('[data-reglages-generation]').click().catch(() => {});
        const panneauGen = page.locator('[data-panneau-generation]');
        const penser = panneauGen.getByRole('switch', { name: 'Réflexion', exact: true });
        await penser.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
        v.ok(`${dialecte} : interrupteur Réflexion du panneau « Génération » offert et actif par défaut`, (await penser.count()) === 1 && await penser.isChecked().catch(() => false));
        await panneauGen.locator('[data-reglage="Réflexion"] label').click().catch(() => {});
        await pause(200);
        core.llm.scripter('Réponse SANS-REFLEXION.');
        await envoyer('question effort bas sans réflexion');
        v.ok(`${dialecte} : effort « low » relayé au moteur, réflexion coupée jusqu'au moteur`, moteur().reasoning_effort === 'low'
            && tours.at(-1)?.thinking_mode === false && (moteur().chat_template_kwargs || {}).enable_thinking === false, `${JSON.stringify(moteur().reasoning_effort)} ${JSON.stringify(moteur().chat_template_kwargs)}`);
        sousMenu = await ouvrirEffort();
        await sousMenu.locator('[title="medium"]').click().catch(() => {});
        await pause(200);
        await page.locator('[data-reglages-generation]').click().catch(() => {});
        await penser.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
        await panneauGen.locator('[data-reglage="Réflexion"] label').click().catch(() => {});
        await pause(200);
        core.llm.scripter({ raisonnement: 'moyen', contenu: 'Réponse AVEC-REFLEXION.' });
        await envoyer('question effort moyen');
        v.ok(`${dialecte} : effort « medium » et réflexion rallumée relayés au moteur`, moteur().reasoning_effort === 'medium'
            && (moteur().chat_template_kwargs || {}).enable_thinking === true, `${JSON.stringify(moteur().reasoning_effort)} ${JSON.stringify(moteur().chat_template_kwargs)}`);
        v.ok(`${dialecte} : aucune erreur JS`, erreurs.length === 0, erreurs.join(' | '));
    } finally {
        await nav.close();
        await core.arreter();
    }
}
process.exit(v.bilan());
