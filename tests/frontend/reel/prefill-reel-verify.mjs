// SPDX-License-Identifier: MIT
/** tests/frontend/reel/prefill-reel-verify.mjs — progression du pré-remplissage contre le core TS réel : `prompt_progress` du moteur relayé par le core, pourcentage de l'entrée utile et part du cache dans la pastille vivante, effacé au premier jeton, repris à l'itération suivante d'un tour à outils */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/prefill-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
// 2 000 jetons relus du cache sur 5 631 : (2600 − 2000) / 3631 = 17 %, (4200 − 2000) / 3631 = 61 %, cache 36 %.
const ETAPES = [[2600, 600], [4200, 900], [5500, 900]].map(([processed, attenteMs]) => ({ total: 5631, cache: 2000, processed, time_ms: processed, attenteMs }));
const texteApp = () => (document.getElementById('app') || {}).textContent || '';
const v = verifications('prefill-reel');
const core = await demarrerCoreReel({ tokParS: 40, outilsEnProcessus: true });
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { memory_enabled: true });
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: core.chats[0].titre }).first().click();
    await page.waitForTimeout(800);
    core.llm.scripter(
        { progression: ETAPES, raisonnement: 'Je cherche dans l\'historique.', appels: [{ nom: 'session_search', args: { query: 'contexte' } }] },
        { progression: [{ total: 6000, cache: 2000, processed: 2600, time_ms: 100, attenteMs: 900 }], contenu: 'Analyse terminée, REPONSE-PREFILL.' },
    );
    await page.locator('textarea[placeholder]').last().fill('Analyse ce long contexte');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();

    const vu = (re) => page.waitForFunction((src) => new RegExp(src).test((document.getElementById('app') || {}).textContent || ''), re.source, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
    v.ok('pourcentage affiché à côté de « Prefill… », sur l\'entrée utile (17 %), avec la part du cache', await vu(/Prefill…\s*17\s*%\s*·\s*cache 36\s*%/));
    v.ok('porté par la pastille de statut (région live)', await page.evaluate(() => [...document.querySelectorAll('#app [role="status"]')].some((e) => /Prefill…\s*\d+\s*%/.test(e.textContent || ''))));
    v.ok('le pourcentage progresse (61 %)', await vu(/Prefill…\s*61\s*%/));
    v.ok('affiché tant qu\'aucun jeton n\'est sorti (96 %)', await vu(/Prefill…\s*96\s*%/));
    v.ok('effacé au premier jeton, sans attendre 100 %', await page.waitForFunction(() => !/Prefill…\s*96\s*%/.test((document.getElementById('app') || {}).textContent || ''), null, { timeout: 15000 }).then(() => true).catch(() => false));
    v.ok('itération suivante du tour à outils : « Prefill… » de nouveau (15 %)', await vu(/Prefill…\s*15\s*%/));
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
    v.ok('la réponse s\'affiche ensuite normalement', (await page.evaluate(texteApp)).includes('REPONSE-PREFILL') && !/Prefill…/.test(await page.evaluate(texteApp)));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
