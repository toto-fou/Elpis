// SPDX-License-Identifier: MIT
/** tests/frontend/reel/fil-reel-verify.mjs — fil chronologique contre le core TS réel : le texte écrit avant un outil ne bouge pas, étapes en ligne riche avec data-etape, réponse finale à la suite, rechargement identique au direct (tool_meta) */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/fil-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, messagesFixture } from '../lib/core-reel.mjs';
import { jetons } from '../lib/faux-llm.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const NARR1 = 'Je vais lire le fichier de configuration, puis vérifier chaque section une par une avant de corriger quoi que ce soit.';
const NARR2 = 'Le fichier est lu, je corrige maintenant la section des ports puis je relis le résultat pour être certain.';
const FINAL = 'Voilà, la configuration est corrigée : le port est revenu à 8443 et les sections sont cohérentes entre elles.';
const debut = (t) => t.slice(0, 30);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const barriere = () => { let ouvrir; const promesse = new Promise((r) => { ouvrir = r; }); return { promesse, ouvrir }; };

// Position verticale du paragraphe qui contient `t`, relative au haut de la bulle, et son conteneur.
const POSITION = (t) => {
    const p = [...document.querySelectorAll('.elpis-msg-assistant .markdown-body p')].filter((x) => (x.textContent || '').includes(t)).pop();
    if (!p) return null;
    const bulle = p.closest('.elpis-msg-assistant');
    return {
        y: Math.round(p.getBoundingClientRect().top - bulle.getBoundingClientRect().top),
        gris: !!p.closest('.markdown-body--worklog, [data-live-narration], details[data-pipeline]'),
        bloc: p.closest('[data-texte-tour]') ? 'tour' : p.closest('[data-texte-vivant]') ? 'vivant' : 'corps',
    };
};
const FIL = () => {
    const fil = [...document.querySelectorAll('[data-fil-tour]')].pop();
    return {
        texte: fil ? (fil.innerText || '').replace(/\s+/g, ' ').trim() : '',
        lignes: fil ? [...fil.querySelectorAll('[data-ligne-etapes]')].map((l) => (l.textContent || '').replace(/\s+/g, ' ').trim()) : [],
        etapes: fil ? [...fil.querySelectorAll('[data-etape]')].map((l) => l.getAttribute('data-etape')) : [],
        ancien: !!document.querySelector('details[data-pipeline], [data-live-narration]'),
    };
};

const v = verifications('fil-reel');
const core = await demarrerCoreReel({ tokParS: 60, outilsEnProcessus: true });
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.admin);
    await api.req('PUT', '/api/settings', { chat_workflow: 'timeline' });
    const { id } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: 'Fil', messages: messagesFixture(1, 'Fil') });
    await api.req('PUT', `/api/saved/chats/${id}/tools`, { tools: [] });
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.admin);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const attendre = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
    const ouvrir = async () => {
        await page.locator('[data-chat-row]').getByRole('button', { name: 'Fil', exact: true }).click();
        await page.waitForFunction(() => document.body.innerText.includes('Fil : question 1'), null, { timeout: 15000 }).catch(() => {});
        await pause(500);
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await ouvrir();

    const [b1, b2, b3] = [barriere(), barriere(), barriere()];
    const n1 = jetons(NARR1).length;
    core.llm.scripter(
        { contenu: NARR1, appels: [{ nom: 'session_search', args: { query: 'configuration' } }], retenues: [{ apres: n1, promesse: b1.promesse }] },
        { contenu: NARR2, appels: [{ nom: 'session_search', args: { query: 'correctif' } }], retenues: [{ apres: jetons(NARR2).length, promesse: b2.promesse }] },
        { contenu: FINAL, retenues: [{ apres: jetons(FINAL).length, promesse: b3.promesse }] },
    );
    await page.locator('textarea[placeholder]').last().fill('Corrige la configuration.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await attendre((t) => document.getElementById('app').textContent.includes(t), debut(NARR1));
    await pause(400);
    const avant = await page.evaluate(POSITION, debut(NARR1));
    v.ok('avant l\'appel : la narration s\'écrit en texte normal', !!avant && !avant.gris, JSON.stringify(avant));
    b1.ouvrir();
    await attendre((t) => !!document.querySelector('[data-texte-tour]') && document.querySelector('[data-texte-tour]').textContent.includes(t), debut(NARR1));
    await attendre((t) => document.getElementById('app').textContent.includes(t), debut(NARR2));
    await pause(400);
    const pendant = await page.evaluate(POSITION, debut(NARR1));
    const filPendant = await page.evaluate(FIL);
    v.ok('après l\'appel : la même phrase, au même endroit, toujours en texte normal', !!pendant && !pendant.gris && pendant.bloc === 'tour' && Math.abs(pendant.y - avant.y) <= 2, JSON.stringify({ avant, pendant }));
    v.ok('après l\'appel : une ligne d\'étape sous la phrase, avec data-etape, aucun conteneur « Travail »', filPendant.lignes.length >= 1 && filPendant.etapes.some(Boolean) && !filPendant.ancien, JSON.stringify(filPendant));
    b2.ouvrir();
    b3.ouvrir();
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    await pause(800);
    const direct = await page.evaluate(FIL);
    const corps = await page.evaluate(() => [...document.querySelectorAll('.elpis-msg-assistant')].pop().innerText);
    v.ok('fin : les deux narrations à leur place, la réponse après, deux étapes', direct.texte.indexOf(debut(NARR1)) >= 0 && direct.texte.indexOf(debut(NARR2)) > direct.texte.indexOf(debut(NARR1))
        && corps.indexOf(debut(FINAL)) > corps.indexOf(debut(NARR2)) && direct.etapes.filter(Boolean).length === 2 && !direct.ancien, JSON.stringify(direct).slice(0, 400));

    // Rechargement depuis la base, dans un nouvel onglet (l'instantané d'onglet, hors de ce lot, ne garde pas encore tool_meta).
    const onglet = await ctx.newPage();
    onglet.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    await onglet.goto(core.urlMain + '/');
    await attendreMontage(onglet);
    await onglet.locator('[data-chat-row]').getByRole('button', { name: 'Fil', exact: true }).click();
    await onglet.waitForFunction(() => document.body.innerText.includes('Fil : question 1'), null, { timeout: 15000 }).catch(() => {});
    await pause(800);
    const recharge = await onglet.evaluate(FIL);
    v.ok('rechargement : le fil est identique au direct', recharge.texte === direct.texte && recharge.etapes.join() === direct.etapes.join(), JSON.stringify({ direct: direct.texte, recharge: recharge.texte }).slice(0, 600));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
