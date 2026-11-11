// SPDX-License-Identifier: MIT
/** tests/frontend/reel/reprise-reel-verify.mjs — cœur du chat contre le core TS réel : rechargement pendant un flux (rattachement au run), Stop puis « Continuer », édition renvoyée, régénération, fenêtre « Détails » */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/reprise-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const ENVOYER = 'button:has(i.ph-paper-plane-right)';
const longue = (balise) => `Début ${balise}. ${Array.from({ length: 120 }, (_, i) => `mot${i}`).join(' ')} FIN-${balise}`;

const v = verifications('reprise-reel');
const core = await demarrerCoreReel({ tokParS: 25 });
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    const domaines = [];
    const avisFlux = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    page.on('console', (m) => {
        if (m.text().includes('[chat] domaine')) domaines.push(m.text());
        if (m.text().includes('[flux]')) avisFlux.push(m.text());
    });
    const texte = () => page.evaluate(() => document.body.innerText);
    const derniereReponse = () => page.evaluate(() => {
        const n = [...document.querySelectorAll('.markdown-body')].pop();
        return n ? n.textContent : '';
    });
    const ouvrir = async (chat) => {
        await page.locator(`text=${chat.titre}`).first().click();
        await page.waitForFunction((t) => document.body.innerText.includes(t), `${chat.titre} : question ${chat.echanges}`, { timeout: 15000 }).catch(() => {});
    };
    const attendreFin = async (balise) => {
        await page.waitForFunction((b) => document.body.innerText.includes(b), balise, { timeout: 60000, polling: 200 }).catch(() => {});
        await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
    };
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const enBase = async (id) => (await api.req('GET', `/api/saved/chats/${id}`)).messages || [];

    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const [a, b] = core.chats;

    // ── Rechargement pendant le flux : la page se rattache au run qui continue côté serveur ──
    await ouvrir(a);
    core.llm.scripter(longue('RECHARGE'));
    await page.locator('textarea[placeholder]').last().fill('Réponds longuement, je vais recharger.');
    await page.locator(ENVOYER).last().click();
    const partiel = await page.waitForFunction(() => /mot3\b/.test(document.body.innerText) && !document.body.innerText.includes('FIN-RECHARGE'),
        null, { timeout: 20000, polling: 50 }).then(() => true).catch(() => false);
    v.ok('flux en cours avant le rechargement', partiel);
    await page.reload();
    await attendreMontage(page);
    await ouvrir(a);
    const rattache = await page.waitForFunction(() => /mot\d+/.test(document.body.innerText) && !document.body.innerText.includes('FIN-RECHARGE'),
        null, { timeout: 15000, polling: 100 }).then(() => true).catch(() => false);
    v.ok('après rechargement : rattaché au run en cours (texte partiel, puis la suite en direct)', rattache);
    await attendreFin('FIN-RECHARGE');
    const fin = await derniereReponse();
    v.ok('réponse complète affichée une seule fois après le rattachement', fin.includes('Début RECHARGE') && fin.split('FIN-RECHARGE').length === 2, fin.slice(-80));

    // ── Stop puis « Continuer » : la réponse interrompue est complétée, sans nouveau message utilisateur ──
    await ouvrir(b);
    const avantStop = (await enBase(b.id)).length;
    core.llm.scripter(longue('STOP'));
    await page.locator('textarea[placeholder]').last().fill('Réponds longuement, je vais t\'arrêter.');
    await page.locator(ENVOYER).last().click();
    await page.waitForFunction(() => /mot3\b/.test(document.body.innerText), null, { timeout: 20000, polling: 50 }).catch(() => {});
    await page.locator(EN_STREAM).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 15000 }).catch(() => {});
    const continuer = page.locator('button[aria-label="Continuer la génération interrompue"]');
    await continuer.waitFor({ timeout: 15000 }).catch(() => {});
    v.ok('après Stop : bouton « Continuer » sur la réponse interrompue', await continuer.count() === 1);
    const arretee = await derniereReponse();
    v.ok('après Stop : le texte reçu est gardé, sans la fin', /mot\d+/.test(arretee) && !arretee.includes('FIN-STOP'), arretee.slice(-60));
    core.llm.scripter(' et voici la SUITE-CONTINUEE');
    await continuer.click({ timeout: 10000 }).catch(() => {});
    await attendreFin('SUITE-CONTINUEE');
    const completee = await derniereReponse();
    v.ok('« Continuer » complète la même réponse', completee.includes('Début STOP') && completee.includes('SUITE-CONTINUEE'), completee.slice(-80));
    const appelCont = core.llm.completions().pop();
    const msgsCont = appelCont && Array.isArray(appelCont.corps.messages) ? appelCont.corps.messages : [];
    const partielle = msgsCont.findLastIndex((m) => m.role === 'assistant' && String(m.content).includes('Début STOP'));
    v.ok('« Continuer » renvoie la réponse partielle au moteur, suivie de la consigne de reprise du core', partielle >= 0
        && msgsCont.slice(partielle + 1).every((m) => !String(m.content).includes('je vais t\'arrêter')),
        JSON.stringify(msgsCont.slice(-2)).slice(0, 160));
    let base = [];
    for (let i = 0; i < 20; i++) {
        base = await enBase(b.id);
        if (base.some((m) => m.role === 'assistant' && String(m.content).includes('SUITE-CONTINUEE'))) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    v.ok('en base : une question et une réponse de plus, la réponse complétée', base.length === avantStop + 2
        && String(base[base.length - 1].content).includes('SUITE-CONTINUEE'), `${avantStop} → ${base.length}`);

    // ── Édition d'une question puis renvoi ──
    const questions = page.locator('button[title="Éditer et renvoyer"]');
    await questions.last().hover().catch(() => {});
    await questions.last().click({ force: true, timeout: 10000 }).catch(() => {});
    const zone = page.locator('textarea[data-edit-message-input]');
    await zone.waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('édition : la question s\'ouvre dans une zone de saisie', await zone.count() === 1 && (await zone.inputValue()).includes('arrêter'));
    await zone.fill('Question ÉDITÉE, réponds court.').catch(() => {});
    core.llm.scripter('Réponse à la REPONSE-EDITEE.');
    await zone.locator('xpath=..').locator('button:has-text("Envoyer")').click({ timeout: 10000 }).catch(() => {});
    await attendreFin('REPONSE-EDITEE');
    const appelEd = core.llm.completions().pop();
    const msgsEd = appelEd && Array.isArray(appelEd.corps.messages) ? appelEd.corps.messages : [];
    v.ok('édition : le moteur reçoit la question éditée en dernier', String((msgsEd[msgsEd.length - 1] || {}).content || '').includes('Question ÉDITÉE'));
    const corpsEd = await texte();
    v.ok('édition : la réponse précédente est remplacée', corpsEd.includes('REPONSE-EDITEE') && !corpsEd.includes('SUITE-CONTINUEE'));

    // ── Régénération de la dernière réponse ──
    const nbReponses = await page.locator('.markdown-body').count();
    core.llm.scripter('Nouvelle REPONSE-REGENEREE.');
    await page.locator('button[title="Régénérer la réponse"]').last().click({ force: true, timeout: 10000 }).catch(() => {});
    await attendreFin('REPONSE-REGENEREE');
    const corpsRe = await texte();
    v.ok('régénération : la dernière réponse est remplacée', corpsRe.includes('REPONSE-REGENEREE') && !corpsRe.includes('REPONSE-EDITEE'));
    v.ok('régénération : aucune bulle de plus', await page.locator('.markdown-body').count() === nbReponses, `${nbReponses} → ${await page.locator('.markdown-body').count()}`);

    // ── Fenêtre « Détails » de l'exécution ──
    const details = page.locator('button[aria-label="Détails de l\'exécution"]').last();
    v.ok('bouton « Détails » présent sur la réponse', await details.count() === 1);
    await details.click({ force: true, timeout: 10000 }).catch(() => {});
    const fenetre = page.locator('[role="dialog"][aria-label="Détails de l\'exécution"]');
    await fenetre.waitFor({ timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => {
        const d = document.querySelector('[role="dialog"][aria-label="Détails de l\'exécution"]');
        return d && !d.textContent.includes('Chargement…');
    }, null, { timeout: 10000 }).catch(() => {});
    const contenu = (await fenetre.textContent().catch(() => '')) || '';
    v.ok('« Détails » : chronologie chargée depuis le core', contenu.includes('Statut') && !contenu.includes('indisponibles'), contenu.slice(0, 120));
    await page.keyboard.press('Escape');
    await fenetre.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    v.ok('« Détails » : Échap ferme la fenêtre', await fenetre.count() === 0);

    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
    v.ok('domaines injectés complets (aucune clé absente de la racine)', domaines.length === 0, domaines.join(' | '));
    v.ok('flux conforme au contrat (aucun avis [flux])', avisFlux.length === 0, avisFlux.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
