// SPDX-License-Identifier: MIT
/** tests/frontend/reel/outils-reel-verify.mjs — tours à outils contre le core TS réel et ses familles en processus : segments entrelacés (conteneur « Travail de l'assistant », groupes, narration, final) en direct puis rechargés, effets mémoire (en cours, au passé, dépli, Annuler, Gérer la mémoire), puce Tâches (progression, repli, abandon, survie au rechargement) */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/outils-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, apparait } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('outils-reel');
const core = await demarrerCoreReel({ tokParS: 150, outilsEnProcessus: true });
// Déroulé « Classique » du fil : ces vérifications visent ce déroulé (fil chronologique : fil-reel-verify.mjs).
for (const compte of Object.values(core.comptes)) { const c = new Client(core.urlMain); await c.req('POST', '/api/login-lite', compte); await c.req('PUT', '/api/settings', { chat_workflow: 'classic' }); }
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { memory_enabled: true });
    const categories = ((await api.req('GET', '/api/mcp/categories')).categories || []).map((c) => c.name);
    for (const c of core.chats) await api.req('PUT', `/api/saved/chats/${c.id}/tools`, { tools: categories });
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const ouvrir = async (chat) => {
        await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
        await page.waitForFunction((t) => document.body.innerText.includes(t), `${chat.titre} : question 1`, { timeout: 15000 }).catch(() => {});
        await pause(600);
    };
    const tour = async (msg) => {
        await page.locator('textarea[placeholder]').last().fill(msg);
        await page.locator('button:has(i.ph-paper-plane-right)').last().click();
        await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
        await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 40000 }).catch(() => {});
        await pause(500);
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const [a, b, c] = core.chats;

    // ── Segments : round muet à deux outils, narration + un outil, réponse finale ──
    await ouvrir(a);
    core.llm.scripter(
        { raisonnement: 'Je réfléchis au plan avant d\'agir.', appels: [{ nom: 'session_search', args: { query: 'bug' } }, { nom: 'session_search', args: { query: 'app.py' } }] },
        { contenu: 'Je vais corriger le bug en relisant l\'historique.', appels: [{ nom: 'session_search', args: { query: 'correctif' } }] },
        'Voilà, le correctif est appliqué.',
    );
    await tour('Corrige le bug de app.py.');
    const conteneur = page.locator('details[data-pipeline]').last();
    const resume = (await conteneur.locator('> summary').textContent().catch(() => '')) || '';
    v.ok('direct : un conteneur « Travail de l\'assistant » replié, résumé + « 3 outils »', await conteneur.count() === 1 && /3\s*outils/.test(resume) && !(await conteneur.evaluate((el) => el.open)), resume);
    const structure = async () => page.evaluate(() => {
        const pipe = [...document.querySelectorAll('details[data-pipeline]')].pop();
        const groupes = pipe ? [...pipe.querySelectorAll('details[class*="toolwrap"]')] : [];
        const md = [...document.querySelectorAll('.markdown-body')];
        const narr = md.find((el) => el.textContent.includes('corriger le bug'));
        const fin = md.find((el) => el.textContent.includes('le correctif est appliqué'));
        const ordre = [...groupes.map((g, i) => ['g' + i, g]), ['narration', narr], ['final', fin]].filter(([, el]) => el)
            .sort((x, y) => (x[1].compareDocumentPosition(y[1]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).map(([n]) => n);
        return { groupes: groupes.map((g) => g.querySelector('summary').textContent.replace(/\s+/g, ' ')), ordre, narrDedans: !!narr && !!narr.closest('details[data-pipeline]'),
            finDehors: !!fin && !fin.closest('details[data-pipeline]'), pense: groupes[0] ? groupes[0].textContent.includes('Je réfléchis au plan') : false };
    });
    const s1 = await structure();
    v.ok('direct : groupe A « 2 outils », groupe B « 1 outil »', s1.groupes.length === 2 && /2\s*outils/.test(s1.groupes[0]) && /1\s*outil\b/.test(s1.groupes[1]), JSON.stringify(s1.groupes));
    v.ok('direct : ordre groupe A, narration, groupe B, final ; final hors du conteneur', JSON.stringify(s1.ordre) === '["g0","narration","g1","final"]' && s1.narrDedans && s1.finDehors, JSON.stringify(s1));
    v.ok('direct : la réflexion du round reste sur le groupe A', s1.pense);
    const appels = core.llm.completions().slice(-3);
    const offerts = (appels[0].corps.tools || []).map((t) => t.function.name);
    v.ok('familles en processus : mémoire, recherche d\'historique et tâches proposées au moteur', ['memory', 'session_search', 'todowrite'].every((n) => offerts.includes(n)), offerts.join(', '));
    v.ok('le core exécute les outils et renvoie leurs résultats au moteur', appels.length === 3 && appels[1].corps.messages.filter((m) => m.role === 'tool').length >= 2 && appels[2].corps.messages.filter((m) => m.role === 'tool').length >= 3);
    await page.reload();
    await attendreMontage(page);
    await ouvrir(a);
    const s2 = await structure();
    v.ok('rechargé : même structure reconstruite depuis l\'historique d\'outils du core', s2.groupes.length === 2 && JSON.stringify(s2.ordre) === '["g0","narration","g1","final"]' && s2.finDehors, JSON.stringify(s2));

    // ── Effets mémoire : en cours, au passé, dépli, Annuler, Gérer la mémoire ──
    await ouvrir(b);
    const LIGNES = '[data-effects] > .elpis-effect';
    core.llm.scripter({ appels: [{ nom: 'memory', args: { action: 'add', store: 'user', content: 'Préfère des réponses concises' } }], tokParS: 20 }, 'Je retiens que tu préfères des réponses concises.');
    // L'état « en cours » d'un outil en processus ne dure que quelques dizaines de ms : un observateur le capte à son rendu.
    await page.evaluate(() => {
        window.__ecritureVue = false;
        const obs = new MutationObserver(() => {
            if (/Écriture en mémoire/.test((document.querySelector('[data-effects] .elpis-effect-label') || {}).textContent || '')) {
                window.__ecritureVue = true;
                obs.disconnect();
            }
        });
        obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.locator('textarea[placeholder]').last().fill('Retiens que je préfère les réponses courtes.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    const enCours = await page.waitForFunction(() => window.__ecritureVue === true, null, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
    v.ok('direct : libellé en cours « Écriture en mémoire »', enCours);
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 30000 }).catch(() => {});
    await pause(500);
    const tete = async (i) => page.locator(LIGNES).nth(i).locator('.elpis-effect-head').innerText().catch(() => '');
    v.ok('après le tour : la ligne reste, au passé (« Mémorisé »), hors du conteneur', /Mémorisé/.test(await tete(0)) && await page.locator('[data-effects]').first().evaluate((el) => !el.closest('details[data-pipeline]')).catch(() => false), await tete(0));
    v.ok('la mémoire n\'est pas une pastille d\'outil', !(await page.locator('details[data-pipeline] summary').allTextContents()).some((t) => /\bmemory\b/.test(t)));
    const etat1 = JSON.stringify(await api.req('GET', '/api/memory/state').catch(() => ({})));
    v.ok('le core a écrit la note dans le profil', etat1.includes('Préfère des réponses concises'), etat1.slice(0, 160));
    await page.reload();
    await attendreMontage(page);
    await ouvrir(b);
    await page.locator(LIGNES).first().waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('rechargé : la ligne d\'effet est reconstruite', /Mémorisé/.test(await tete(0)));
    await page.locator(LIGNES).nth(0).locator('.elpis-effect-head').click();
    await page.locator('[data-effect-added]').first().waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('dépli : texte ajouté, Annuler et Gérer la mémoire', (await page.locator(LIGNES).nth(0).locator('[data-effect-added]').innerText().catch(() => '')).includes('Préfère des réponses concises')
        && await apparait(page.locator(LIGNES).nth(0).locator('[data-effect-undo]')) && await apparait(page.locator(LIGNES).nth(0).locator('[data-effect-manage]')));
    await page.locator(LIGNES).nth(0).locator('[data-effect-undo]').click();
    await page.locator('[data-effect-undone]').first().waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('Annuler : étiquette « annulé », note retirée du core', /annulé/.test(await tete(0)) && !JSON.stringify(await api.req('GET', '/api/memory/state').catch(() => ({}))).includes('Préfère des réponses concises'));
    core.llm.scripter({ appels: [{ nom: 'memory', args: { action: 'add', store: 'memory', content: 'Le port du service est 8080' } }] }, 'Noté.');
    await tour('Note le port.');
    await page.locator(LIGNES).last().locator('.elpis-effect-head').click();
    await page.locator('[data-effect-manage]').last().click();
    await page.locator('[data-mem-origin]').first().waitFor({ timeout: 10000 }).catch(() => {});
    const origines = await page.locator('[data-mem-origin]').allInnerTexts();
    v.ok('Gérer la mémoire : Réglages › Mémoire, origine de la note = ce chat', origines.some((o) => o.includes(`« ${b.titre} »`)), origines.join(' | '));
    await page.keyboard.press('Escape');
    await pause(300);

    // ── Puce Tâches : progression, repli automatique, survie au rechargement, liste soldée ──
    await ouvrir(c);
    const PUCE = '[data-todo-flyout] > button';
    const ITEMS = '[data-todo-flyout] ul li';
    core.llm.scripter({ appels: [{ nom: 'todowrite', args: { todos: [{ content: 'Lire le code', status: 'completed' }, { content: 'Écrire le test', status: 'in_progress' }, { content: 'Publier', status: 'pending' }] } }] }, 'Je continue au prochain tour.');
    await tour('Travaille sur les tâches.');
    const puce = page.locator(PUCE).first();
    v.ok('tâches : puce dans la barre de prompt, « 1/3 », repliée en fin de tour', await apparait(puce) && /1\/3/.test(await puce.innerText().catch(() => ''))
        && await page.locator(ITEMS).count() === 0 && await page.locator('[data-todo-flyout]').first().evaluate((el) => !!el.closest('.elpis-compose-col')).catch(() => false));
    await puce.click();
    await pause(250);
    v.ok('tâches : dépli manuel, 3 éléments', await page.locator(ITEMS).count() === 3);
    await page.mouse.click(950, 300);
    await pause(250);
    v.ok('tâches : clic extérieur → repliée', await page.locator(ITEMS).count() === 0);
    v.ok('tâches : aucune ligne Tâches dans le fil, aucune pastille todowrite', !(await page.locator('[data-effects]').allInnerTexts()).some((t) => /Tâches/.test(t)) && !(await page.locator('details[data-pipeline] summary').allTextContents()).some((t) => /todowrite/.test(t)));
    await ouvrir(a);
    v.ok('autre chat : pas de puce Tâches', await page.locator(PUCE).count() === 0);
    await ouvrir(c);
    v.ok('retour : puce rechargée depuis le core', /1\/3/.test(await page.locator(PUCE).first().innerText().catch(() => '')));
    await page.reload();
    await attendreMontage(page);
    await ouvrir(c);
    v.ok('rechargement : la puce survit, repliée', await apparait(page.locator(PUCE)) && await page.locator(ITEMS).count() === 0);
    core.llm.scripter({ appels: [{ nom: 'todowrite', args: { todos: [{ content: 'Lire le code', status: 'completed' }, { content: 'Écrire le test', status: 'completed' }, { content: 'Publier', status: 'completed' }] } }] }, 'Tout est fait.');
    await tour('Finis les tâches.');
    v.ok('liste soldée : la puce disparaît', await page.locator('[data-todo-flyout]').count() === 0);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
