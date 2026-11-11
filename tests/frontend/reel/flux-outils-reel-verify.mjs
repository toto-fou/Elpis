// SPDX-License-Identifier: MIT
/** tests/frontend/reel/flux-outils-reel-verify.mjs — routage du flux d'un tour à outils contre le core TS réel, observé à chaque barrière du faux moteur : narration avant l'appel, bascule en ligne live, worklog figé, réponse finale, Stop pendant la réponse finale ; outil lent d'un serveur MCP visible pendant son exécution */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/flux-outils-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, messagesFixture } from '../lib/core-reel.mjs';
import { jetons } from '../lib/faux-llm.mjs';
import { demarrerFauxMcp } from '../lib/faux-mcp.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
// Plus longues que la fenêtre de retenue du core (LIVE_HOLDBACK_CHARS = 48) : le début s'affiche avant la fin du round.
const NARR1 = 'Je vais lire le fichier de configuration, puis vérifier chaque section une par une avant de corriger quoi que ce soit.';
const NARR2 = 'Le fichier est lu, je corrige maintenant la section des ports puis je relis le résultat pour être certain.';
const FINAL = 'Voilà, la configuration est corrigée : le port est revenu à 8443 et les sections sont cohérentes entre elles.';
const debut = (t) => t.slice(0, 30);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// Barrière : le faux moteur tient son flux jusqu'à `ouvrir()`.
const barriere = () => { let ouvrir; const promesse = new Promise((r) => { ouvrir = r; }); return { promesse, ouvrir }; };
const ETAT = () => {
    const pipe = [...document.querySelectorAll('details[data-pipeline]')].pop();
    const dansPipe = (el) => !!el && !!el.closest('details[data-pipeline]');
    const dansLive = (el) => !!el && !!el.closest('[data-live-narration]');
    const live = document.querySelector('[data-live-narration]');
    return {
        corps: [...document.querySelectorAll('.markdown-body')].filter((el) => !dansPipe(el) && !dansLive(el)).map((el) => el.textContent || '').join('\n'),
        live: live ? live.textContent || '' : '',
        liveDansPipe: !!document.querySelector('details[data-pipeline] [data-live-narration]'),
        pipe: pipe ? pipe.textContent || '' : '',
        resume: pipe ? ((pipe.querySelector(':scope > summary') || {}).textContent || '') : '',
        worklogs: [...document.querySelectorAll('.markdown-body--worklog:not([data-live-narration])')].map((el) => (el.textContent || '').trim()),
        statut: [...document.querySelectorAll('[role="status"]')].map((el) => el.textContent || '').join(' | '),
    };
};

const v = verifications('flux-outils-reel');
const lent = await demarrerFauxMcp({ nom: 'lent', outils: [{ name: 'lire_lent', description: 'Lit un document, lentement.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, reponse: () => 'bonjour du document', delaiMs: 4000 }] });
const core = await demarrerCoreReel({ tokParS: 60, outilsEnProcessus: true, llm: { gabarit: '{% if enable_thinking %}<think>{% endif %}' } });
// Déroulé « Classique » du fil : ces vérifications visent ce déroulé (fil chronologique : fil-reel-verify.mjs).
for (const compte of Object.values(core.comptes)) { const c = new Client(core.urlMain); await c.req('POST', '/api/login-lite', compte); await c.req('PUT', '/api/settings', { chat_workflow: 'classic' }); }
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.admin);
    await api.req('PUT', '/api/settings', { memory_enabled: true, mcp_servers: [{ name: 'Lent', type: 'http', url: lent.url, visible: true, id: 'server_lent' }] });
    const chats = [];
    for (const titre of ['Configuration', 'Arrêt en route', 'Outil lent']) {
        const { id } = await api.req('POST', '/api/saved/chats/new', {});
        await api.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: titre, messages: messagesFixture(1, titre) });
        await api.req('PUT', `/api/saved/chats/${id}/tools`, { tools: titre === 'Outil lent' ? ['ext:server_lent'] : [] });
        chats.push({ id, titre });
    }
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.admin);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const etat = () => page.evaluate(ETAT);
    const attendre = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
    const ouvrir = async (titre) => {
        await page.locator('[data-chat-row]', { hasText: titre }).first().click();
        await page.waitForFunction((t) => document.body.innerText.includes(t), `${titre} : question 1`, { timeout: 15000 }).catch(() => {});
        await pause(500);
    };
    const envoyer = async (texte) => {
        await page.locator('textarea[placeholder]').last().fill(texte);
        await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);

    // ── Routage à chaque étape d'un tour à deux outils ──
    await ouvrir('Configuration');
    const [b1, b2, b3, b4] = [barriere(), barriere(), barriere(), barriere()];
    const n1 = jetons(NARR1).length;
    core.llm.scripter(
        { contenu: NARR1, appels: [{ nom: 'session_search', args: { query: 'configuration' } }], retenues: [{ apres: n1, promesse: b1.promesse }, { apres: n1 + 1, promesse: b2.promesse }] },
        { contenu: NARR2, appels: [{ nom: 'session_search', args: { query: 'correctif' } }], retenues: [{ apres: jetons(NARR2).length, promesse: b3.promesse }] },
        { contenu: FINAL, retenues: [{ apres: jetons(FINAL).length, promesse: b4.promesse }] },
    );
    await envoyer('Corrige la configuration.');
    await attendre((t) => document.getElementById('app').textContent.includes(t), debut(NARR1));
    await pause(400);
    let s = await etat();
    v.ok('R1 : début de narration streamé dans le corps avant tout appel, fin retenue par le core, pas de conteneur', s.corps.includes(debut(NARR1)) && !s.corps.includes('quoi que ce soit') && !s.pipe, s.corps.slice(-160));
    b1.ouvrir();
    await attendre((t) => ((document.querySelector('[data-live-narration]') || {}).textContent || '').includes(t), NARR1);
    await pause(300);
    s = await etat();
    v.ok('R1 appel annoncé : narration basculée en ligne live, corps vidé, rien de figé', s.live.includes(NARR1) && !s.liveDansPipe && !s.corps.includes(NARR1) && !s.pipe, JSON.stringify(s).slice(0, 200));
    v.ok('R1 appel annoncé : pastille « Appel d\'outil · session_search… »', /Appel d'outil · session_search…/.test(s.statut) && !/Réflexion…/.test(s.statut), s.statut);
    b2.ouvrir();
    await attendre((t) => ((document.querySelector('[data-live-narration]') || {}).textContent || '').includes(t), debut(NARR2));
    await pause(300);
    s = await etat();
    v.ok('R2 : narration en ligne live sous le conteneur, jamais dans le corps', s.live.includes(debut(NARR2)) && !s.liveDansPipe && !s.pipe.includes(debut(NARR2)) && !s.corps.includes(debut(NARR2)), JSON.stringify(s).slice(0, 240));
    v.ok('R2 : narration du round 1 figée en worklog, résumé = narration figée', s.worklogs.some((t) => t.includes(NARR1)) && s.resume.includes('Je vais lire') && !s.resume.includes('Le fichier est lu'), JSON.stringify({ w: s.worklogs, r: s.resume }));
    v.ok('R2 : aucune pastille « Appel d\'outil » pendant la rédaction visible', !/Appel d'outil/.test(s.statut), s.statut);
    v.ok('R2 : ligne live en Markdown, sans curseur de flux', await page.evaluate(() => !!document.querySelector('[data-live-narration] p') && !document.querySelector('[data-live-narration] .elpis-stream-caret')));
    b3.ouvrir();
    await attendre((t) => ((document.querySelector('[data-live-narration]') || {}).textContent || '').includes(t), debut(FINAL));
    await pause(300);
    s = await etat();
    v.ok('final en direct : dans la ligne live sous le conteneur, corps vide, deux groupes d\'outils', s.live.includes(debut(FINAL)) && !s.liveDansPipe && !s.corps.includes(debut(FINAL))
        && await page.evaluate(() => document.querySelectorAll('details[class*="toolwrap"]').length === 2), JSON.stringify(s).slice(0, 200));
    b4.ouvrir();
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    await pause(400);
    s = await etat();
    v.ok('fin : la réponse passe dans le corps, hors du conteneur, une seule fois', s.corps.includes(FINAL) && !s.pipe.includes(FINAL) && s.corps.split(FINAL).length === 2 && !s.live, JSON.stringify(s).slice(0, 200));

    v.ok('fin : les deux narrations figées dans le conteneur, jamais dans le corps', s.worklogs.some((t) => t.includes(NARR1)) && s.worklogs.some((t) => t.includes(NARR2)) && s.pipe.includes(debut(NARR2)) && !s.corps.includes(debut(NARR1)) && !s.corps.includes(debut(NARR2)), JSON.stringify(s).slice(0, 240));
    v.ok('fin : résumé agrégé « 2 outils », plus de pastille de statut', /2 outils/.test(s.resume) && !/Appel d'outil|Réflexion…/.test(s.statut), JSON.stringify({ r: s.resume, st: s.statut }));

    // ── Stop pendant la réponse finale : le texte déjà lu devient la réponse partielle ──
    await ouvrir('Arrêt en route');
    const b5 = barriere();
    const FINAL2 = 'Début de la réponse finale, lue avant le Stop, assez longue pour dépasser la fenêtre de retenue du core et rester affichée à l\'écran. La suite jamais lue.';
    core.llm.scripter({ contenu: 'Je regarde.', appels: [{ nom: 'session_search', args: { query: 'arret' } }] }, { contenu: FINAL2, retenues: [{ apres: jetons(FINAL2).length - 8, promesse: b5.promesse }] });
    await envoyer('Réponds puis je t\'arrête.');
    await attendre(() => /Début de la/.test(((document.querySelector('[data-live-narration]') || {}).textContent || '')));
    await page.locator(EN_STREAM).first().click().catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 15000 }).catch(() => {});
    b5.ouvrir();
    await pause(800);
    s = await etat();
    v.ok('Stop : le texte déjà lu devient le corps du partiel', /Début de la/.test(s.corps) && !/jamais lue/.test(s.corps) && !s.live, JSON.stringify(s).slice(0, 200));

    // ── Outil lent : visible pendant son exécution ──
    await ouvrir('Outil lent');
    const b6 = barriere();
    const b7 = barriere();
    core.llm.scripter({ raisonnement: 'Je réfléchis à quel document lire avant de répondre.', appels: [{ nom: 'lire_lent', args: { path: 'demo.txt' } }], retenues: [{ apres: 4, promesse: b6.promesse }] }, { contenu: 'Le document dit bonjour, FIN-LENT.', retenues: [{ apres: 5, promesse: b7.promesse }] });
    await envoyer('Lis demo.txt');
    await attendre(() => !!document.querySelector('[data-live-narration], details[data-think]'));
    await pause(400);
    const pendantReflexion = await page.evaluate(() => ({ ligne: [...document.querySelectorAll('[role="status"]')].map((e) => e.textContent).join(' | ') }));
    v.ok('pendant la réflexion : aucun débit (jetons/s) sur la ligne vivante', !/tok\/s|jetons\/s/.test(pendantReflexion.ligne), pendantReflexion.ligne);
    b6.ouvrir();
    const enCours = await attendre(() => {
        const p = [...document.querySelectorAll('details[data-pipeline]')].pop();
        const r = p && p.querySelector(':scope > summary');
        return !!r && /lire_lent/.test(r.textContent || '');
    });
    v.ok('pendant l\'outil : le résumé replié nomme l\'outil en cours', enCours && lent.etat.appels.length === 1);
    const pipe = page.locator('details[data-pipeline]').last();
    await pipe.locator('> summary').click().catch(() => {});
    v.ok('pendant l\'outil : engrenage animé sur le résumé', await page.locator('details[data-pipeline] > summary i.animate-spin').count() === 1);
    await page.locator('details.group\\/toolwrap > summary').last().click().catch(() => {});
    await page.locator('button.group\\/toolbtn').last().click().catch(() => {});
    await pause(300);
    const carteDetail = () => page.locator('details[data-pipeline] .rounded-xl.border').last().textContent().then((t) => (t || '').replace(/\s+/g, ' ')).catch(() => '');
    const carte = await carteDetail();
    v.ok('pendant l\'outil : carte détail avec ses paramètres et « en cours », sans résultat', /Paramètres/.test(carte) && /demo\.txt/.test(carte) && /en cours/i.test(carte) && !/bonjour du document/.test(carte), carte.slice(0, 200));
    await attendre(() => /Le document/.test(document.body.innerText));
    b7.ouvrir();
    await page.waitForFunction(() => document.body.innerText.includes('FIN-LENT'), null, { timeout: 30000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    await pause(400);
    const apres = await carteDetail();
    v.ok('après l\'outil : le résultat remplace « en cours »', /bonjour du document/.test(apres) && !/en cours/i.test(apres), apres.slice(0, 200));
    v.ok('aucun emoji couleur dans l\'interface', !/[\u{1F300}-\u{1FAFF}]/u.test(await page.evaluate(() => document.getElementById('app').innerText)));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
    await lent.arreter();
}
process.exit(v.bilan());
