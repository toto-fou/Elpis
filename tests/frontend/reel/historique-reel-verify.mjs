// SPDX-License-Identifier: MIT
/** tests/frontend/reel/historique-reel-verify.mjs — historique contre le core TS réel : course de deux clics (la réponse lente ne gagne pas), renommer, archiver, supprimer puis annuler, chat disparu, nouveau chat enregistré */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/historique-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('historique-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const suppressions = [];
    page.on('request', (r) => { if (r.method() === 'DELETE' && r.url().includes('/api/saved/chats/')) suppressions.push(r.url()); });
    const texte = () => page.evaluate(() => document.body.innerText);
    const ligne = (titre) => page.locator('[data-chat-row]', { hasText: titre }).first();
    const action = async (titre, libelle) => {
        await ligne(titre).click({ button: 'right' });
        await page.locator('#custom-context-menu button', { hasText: libelle }).click({ timeout: 5000 });
    };
    const dialogue = page.locator('[role="dialog"][aria-labelledby="app-modal-title"]');
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const [recettes, voyage, notes] = core.chats;
    await ligne(notes.titre).waitFor({ timeout: 15000 });

    // ── Course : A lent puis B aussitôt, B reste affiché ──
    await page.route(`**/api/saved/chats/${recettes.id}`, async (r) => { await pause(900); await r.continue(); });
    await ligne(recettes.titre).click();
    await pause(120);
    await ligne(voyage.titre).click();
    await pause(1600);
    const corps = await texte();
    v.ok('deux clics rapides : la conversation demandée en dernier reste affichée', corps.includes(`${voyage.titre} : question ${voyage.echanges}`) && !corps.includes(`${recettes.titre} : question 1`));
    await page.unroute(`**/api/saved/chats/${recettes.id}`);

    // ── Renommer ──
    await action(notes.titre, 'Renommer');
    await dialogue.waitFor({ timeout: 5000 });
    const champ = dialogue.locator('input');
    v.ok('Renommer : la fenêtre propose le titre actuel', (await champ.inputValue()) === notes.titre);
    await champ.fill('Carnet de lectures');
    await dialogue.locator('button', { hasText: 'Valider' }).click();
    await ligne('Carnet de lectures').waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('Renommer : le nouveau titre remplace l\'ancien dans la liste', await ligne('Carnet de lectures').count() === 1 && await ligne(notes.titre).count() === 0);
    v.ok('Renommer : titre enregistré par le core', (await api.req('GET', `/api/saved/chats/${notes.id}`)).title === 'Carnet de lectures');

    // ── Archiver ──
    await action(recettes.titre, 'Archiver');
    await pause(400);
    v.ok('Archiver : aucune confirmation, toast « Annuler »', !(await dialogue.isVisible().catch(() => false))
        && await page.locator('button', { hasText: 'Annuler' }).count() >= 1);
    await page.waitForFunction((t) => ![...document.querySelectorAll('[data-chat-row]')].some((d) => d.innerText.includes(t)), recettes.titre, { timeout: 5000 }).catch(() => {});
    v.ok('Archiver : la conversation quitte la liste', await ligne(recettes.titre).count() === 0);
    const archives = (await api.req('GET', '/api/saved/chats?archived=1')).items || [];
    v.ok('Archiver : rangée parmi les archives du core', archives.some((c) => c.id === recettes.id), JSON.stringify(archives.map((c) => c.title)));

    // ── Supprimer puis Annuler : rien n'est envoyé ──
    await action('Carnet de lectures', 'Supprimer');
    await dialogue.waitFor({ timeout: 5000 });
    await dialogue.locator('button', { hasText: 'Supprimer' }).click();
    const annuler = page.locator('button', { hasText: 'Annuler' }).last();
    await annuler.waitFor({ timeout: 5000 }).catch(() => {});
    v.ok('Supprimer : retrait immédiat et toast avec « Annuler »', await ligne('Carnet de lectures').count() === 0 && await annuler.count() === 1);
    await annuler.click();
    await ligne('Carnet de lectures').waitFor({ timeout: 5000 }).catch(() => {});
    await pause(5500);
    v.ok('Annuler : la conversation revient et aucune suppression n\'est envoyée', await ligne('Carnet de lectures').count() === 1 && suppressions.length === 0, suppressions.join(' | '));

    // ── Supprimer pour de bon : DELETE à l'expiration du toast ──
    await action('Carnet de lectures', 'Supprimer');
    await dialogue.waitFor({ timeout: 5000 });
    await dialogue.locator('button', { hasText: 'Supprimer' }).click();
    await page.waitForFunction(() => true, null, { timeout: 100 });
    for (let i = 0; i < 40 && suppressions.length === 0; i++) await pause(200);
    v.ok('Supprimer : DELETE envoyé à l\'expiration du toast', suppressions.length === 1 && suppressions[0].endsWith(`/${notes.id}`), suppressions.join(' | '));
    const restants = ((await api.req('GET', '/api/saved/chats')).items || []).map((c) => c.id);
    v.ok('Supprimer : la conversation n\'existe plus dans le core', !restants.includes(notes.id));

    // ── Chat supprimé ailleurs : message clair, liste relue ──
    const { id: fantome } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${fantome}/save-messages`, { title: 'Chat fantôme', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] });
    await page.reload();
    await attendreMontage(page);
    await ligne('Chat fantôme').waitFor({ timeout: 10000 });
    await api.req('DELETE', `/api/saved/chats/${fantome}`);
    await ligne('Chat fantôme').click();
    await page.waitForFunction(() => document.body.innerText.includes('n’existe plus'), null, { timeout: 8000 }).catch(() => {});
    v.ok('chat supprimé ailleurs : « Cette conversation n’existe plus. »', (await texte()).includes('n’existe plus'));
    await page.waitForFunction(() => ![...document.querySelectorAll('[data-chat-row]')].some((d) => d.innerText.includes('Chat fantôme')), null, { timeout: 8000 }).catch(() => {});
    v.ok('chat supprimé ailleurs : la liste est relue sans lui', await ligne('Chat fantôme').count() === 0);

    // ── Nouveau chat : créé par le core au premier envoi, listé, rechargé ──
    const avant = ((await api.req('GET', '/api/saved/chats')).items || []).length;
    await page.locator('button[title="Nouveau chat (Ctrl+Maj+O)"]').last().click();
    core.llm.scripter('Bienvenue dans la NOUVELLE-CONVERSATION.');
    core.llm.scripterTitre('Premier contact');
    await page.locator('textarea[placeholder]').last().fill('Premier message du nouveau chat');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForFunction(() => document.body.innerText.includes('NOUVELLE-CONVERSATION'), null, { timeout: 20000 }).catch(() => {});
    await page.waitForSelector('button[title="Arrêter la génération"]', { state: 'detached', timeout: 20000 }).catch(() => {});
    let liste = [];
    for (let i = 0; i < 20; i++) {
        liste = (await api.req('GET', '/api/saved/chats')).items || [];
        if (liste.length > avant) break;
        await pause(250);
    }
    const nouveau = liste.find((c) => !core.chats.some((f) => f.id === c.id) && c.id !== fantome);
    v.ok('nouveau chat : créé par le core', liste.length === avant + 1 && !!nouveau, `${avant} → ${liste.length}`);
    let enBase = [];
    for (let i = 0; nouveau && i < 20; i++) {
        enBase = (await api.req('GET', `/api/saved/chats/${nouveau.id}`)).messages || [];
        if (enBase.some((m) => m.role === 'assistant' && String(m.content).includes('NOUVELLE-CONVERSATION'))) break;
        await pause(250);
    }
    v.ok('nouveau chat : question et réponse enregistrées', enBase.some((m) => m.role === 'user' && String(m.content).includes('Premier message'))
        && enBase.some((m) => m.role === 'assistant' && String(m.content).includes('NOUVELLE-CONVERSATION')), JSON.stringify(enBase).slice(0, 200));
    await ligne('Premier contact').waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('nouveau chat : titre généré par le moteur, enregistré et affiché dans la liste', !!nouveau && nouveau.title === 'Premier contact' && await ligne('Premier contact').count() === 1, nouveau ? nouveau.title : '');
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
