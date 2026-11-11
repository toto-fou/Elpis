// SPDX-License-Identifier: MIT
/** tests/frontend/reel/changement-flux-reel-verify.mjs — changement de chat pendant un flux, contre le core TS réel : le run continue côté serveur, aucun jeton ne fuit dans l'autre conversation, le retour s'y rattache et la réponse est enregistrée */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/changement-flux-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const MOTS = Array.from({ length: 150 }, (_, i) => `jeton${i}`).join(' ');
const REPONSE = `Début de la réponse longue. ${MOTS} FIN-DU-FLUX`;

const v = verifications('changement-flux-reel');
const core = await demarrerCoreReel({ tokParS: 25 });
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const domaines = [];
    page.on('console', (m) => { if (m.text().includes('[chat] domaine')) domaines.push(m.text()); });
    const avisFlux = [];
    page.on('console', (m) => { if (m.text().includes('[flux]')) avisFlux.push(m.text()); });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const [a, b] = core.chats;
    const texte = () => page.evaluate(() => document.body.innerText);
    const ouvrir = async (chat) => {
        await page.locator(`text=${chat.titre}`).first().click();
        await page.waitForFunction((t) => document.body.innerText.includes(t), `${chat.titre} : question ${chat.echanges}`, { timeout: 15000 }).catch(() => {});
    };

    await ouvrir(a);
    core.llm.scripter(REPONSE);
    await page.locator('textarea[placeholder]').last().fill('Réponds longuement.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    const partiel = await page.waitForFunction(() => {
        const t = document.body.innerText;
        return t.includes('jeton3') && !t.includes('FIN-DU-FLUX');
    }, null, { timeout: 20000, polling: 50 }).then(() => true).catch(() => false);
    v.ok(`flux en cours dans « ${a.titre} »`, partiel && (await page.locator(EN_STREAM).count()) > 0);

    await ouvrir(b);
    const corpsB = await texte();
    v.ok(`changement vers « ${b.titre} » pendant le flux : ses messages s'affichent`, corpsB.includes(`${b.titre} : question ${b.echanges}`) && !corpsB.includes(`${a.titre} : question 1`));
    v.ok('aucun jeton du flux quitté dans la conversation affichée', !/jeton\d/.test(corpsB));
    v.ok('la conversation affichée n\'est pas en génération', (await page.locator(EN_STREAM).count()) === 0);
    await page.waitForTimeout(1200);
    v.ok('toujours aucune fuite une seconde plus tard', !/jeton\d/.test(await texte()));

    await ouvrir(a);
    const rattache = await page.waitForFunction(() => /jeton\d/.test(document.body.innerText), null, { timeout: 15000, polling: 100 })
        .then(() => true).catch(() => false);
    const enDirect = rattache && !(await texte()).includes('FIN-DU-FLUX');
    v.ok(`retour dans « ${a.titre} » : rattaché au run encore en cours (texte partiel, puis la suite en direct)`, enDirect);
    await page.waitForFunction(() => document.body.innerText.includes('FIN-DU-FLUX'), null, { timeout: 60000, polling: 200 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
    const fin = await page.evaluate(() => {
        const n = [...document.querySelectorAll('.markdown-body')].pop();
        return n ? n.textContent : '';
    });
    v.ok('la réponse complète est affichée, une seule fois', fin.includes('Début de la réponse longue') && fin.includes('FIN-DU-FLUX') && fin.split('FIN-DU-FLUX').length === 2, fin.slice(-120));

    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    let enBase = null;
    for (let i = 0; i < 20; i++) {
        enBase = await api.req('GET', `/api/saved/chats/${a.id}`);
        if ((enBase.messages || []).some((m) => m.role === 'assistant' && String(m.content).includes('FIN-DU-FLUX'))) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    v.ok('la réponse est enregistrée dans sa conversation', (enBase.messages || []).some((m) => m.role === 'assistant' && String(m.content).includes('FIN-DU-FLUX')));
    const autre = await api.req('GET', `/api/saved/chats/${b.id}`);
    v.ok('l\'autre conversation n\'a reçu aucun message', (autre.messages || []).length === b.echanges * 2 && !(autre.messages || []).some((m) => String(m.content).includes('jeton')));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
    v.ok('domaines injectés complets (aucune clé absente de la racine)', domaines.length === 0, domaines.join(' | '));
    v.ok('flux conforme au contrat (aucun avis [flux])', avisFlux.length === 0, avisFlux.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
