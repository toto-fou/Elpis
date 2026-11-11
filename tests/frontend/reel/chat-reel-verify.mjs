// SPDX-License-Identifier: MIT
/** tests/frontend/reel/chat-reel-verify.mjs — chat contre le core TS réel : changement de conversation, envoi d'un message, réponse streamée par le faux LLM, persistance */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/chat-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const REPONSE = 'Le **faux moteur** répond en plusieurs jetons, pour vérifier le rendu progressif.\n\n1. premier point\n2. second point';

const v = verifications('chat-reel');
const core = await demarrerCoreReel({ tokParS: 40 });
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const avisFlux = [];
    page.on('console', (m) => { if (m.text().includes('[flux]')) avisFlux.push(m.text()); });
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const texteMarkdown = () => page.evaluate(() => [...document.querySelectorAll('.markdown-body')].map((n) => n.textContent).join('\n'));

    const [a, b] = core.chats;
    await page.locator(`text=${a.titre}`).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${a.titre} : question ${a.echanges}`, { timeout: 15000 }).catch(() => {});
    v.ok(`ouverture de « ${a.titre} » : ses messages sont affichés`, (await page.evaluate(() => document.body.innerText)).includes(`${a.titre} : question ${a.echanges}`));

    await page.locator(`text=${b.titre}`).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${b.titre} : question ${b.echanges}`, { timeout: 15000 }).catch(() => {});
    const corps = await page.evaluate(() => document.body.innerText);
    v.ok(`changement vers « ${b.titre} » : ses messages remplacent les précédents`, corps.includes(`${b.titre} : question ${b.echanges}`) && !corps.includes(`${a.titre} : question 1`));
    v.ok('rendu Markdown des réponses chargées', (await texteMarkdown()).includes(`Réponse ${b.echanges} sur ${b.titre}`));

    core.llm.scripter(REPONSE);
    const ta = page.locator('textarea[placeholder]').last();
    await ta.fill('Bonjour, réponds en deux points.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForSelector(EN_STREAM, { timeout: 15000 }).catch(() => {});
    v.ok('génération en cours (bouton Arrêter)', await page.locator(EN_STREAM).count() > 0);
    const partiel = await page.waitForFunction(() => {
        const n = [...document.querySelectorAll('.markdown-body')].pop();
        const t = n ? n.textContent : '';
        return t.includes('faux') && !t.includes('second point') ? t : false;
    }, null, { timeout: 15000, polling: 50 }).then((h) => h.jsonValue()).catch(() => '');
    v.ok('texte partiel affiché pendant le flux', !!partiel, String(partiel).slice(0, 80));
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 60000 }).catch(() => {});
    v.ok('fin du flux (bouton Arrêter retiré)', await page.locator(EN_STREAM).count() === 0);
    const final = await page.evaluate(() => {
        const n = [...document.querySelectorAll('.markdown-body')].pop();
        return n ? { texte: n.textContent, gras: !!n.querySelector('strong'), liste: n.querySelectorAll('ol li').length } : null;
    });
    v.ok('réponse finale complète et rendue (gras, liste)', final && final.texte.includes('second point') && final.gras && final.liste === 2, JSON.stringify(final));

    const appels = core.llm.completions();
    const dernier = appels.length ? appels[appels.length - 1].corps : null;
    const msgs = dernier && Array.isArray(dernier.messages) ? dernier.messages : [];
    v.ok('le moteur a reçu le message et l\'historique du chat', msgs.some((m) => String(m.content).includes('réponds en deux points')) && msgs.some((m) => String(m.content).includes(`${b.titre} : question 1`)));

    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    let enBase = null;
    for (let i = 0; i < 20; i++) {
        enBase = await api.req('GET', `/api/saved/chats/${b.id}`);
        if ((enBase.messages || []).some((m) => m.role === 'assistant' && String(m.content).includes('second point'))) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    v.ok('réponse enregistrée en base par le core', (enBase.messages || []).some((m) => m.role === 'assistant' && String(m.content).includes('second point')));

    await page.reload();
    await attendreMontage(page);
    await page.waitForFunction(() => document.body.innerText.includes('second point'), null, { timeout: 15000 }).catch(() => {});
    v.ok('après rechargement, la conversation reprend avec la réponse', (await page.evaluate(() => document.body.innerText)).includes('second point'));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
    v.ok('flux du core réel conforme au contrat (aucun événement inconnu ni hors contrat)', avisFlux.length === 0, avisFlux.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
