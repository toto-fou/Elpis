// SPDX-License-Identifier: MIT
/** tests/frontend/reel/parametres-reel-verify.mjs — Paramètres contre le core TS réel : onglet Mémoire (lecture, édition, compteur, Annuler, un seul magasin écrit, vidage confirmé, limite, brouillon gardé à la fermeture) et onglet Prompts (rangées datées, contenu brut, tri, recherche sans accents, copie), données relues du core */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/parametres-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client } from '../lib/core-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const BUG = '# Bug report\n\n**Contexte** : <résumé> & <details>\n\n- [ ] étapes\n- [x] attendu\n\nUtilise `git bisect` :\n\n```bash\ngit bisect start\n```';
const v = verifications('parametres-reel');
const core = await demarrerCoreReel();
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    await api.req('PUT', '/api/settings', { memory_enabled: true });
    await api.req('PUT', '/api/memory/state/user', { entries: ['Prénom : Alice', 'Travaille en français'] });
    await api.req('PUT', '/api/memory/state/memory', { entries: ['Le dépôt vit dans /srv', 'Les tests passent par pytest'] });
    for (const [title, content] of [['Résumé de réunion', 'Résume la réunion.'], ['Analyse de logs', 'Analyse les journaux du serveur et relève les erreurs.'], ['Bug report', BUG]]) {
        await api.req('POST', '/api/prompts', { title, content });
        await pause(1100);
    }
    const etat = async () => api.req('GET', '/api/memory/state');
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && /\/api\/memory\/state\//.test(r.url())) puts.push({ kind: r.url().split('/').pop(), ...r.postDataJSON() }); });
    const modale = page.locator('div[aria-label="Paramètres"]');
    const onglet = async (nom) => {
        if (!(await modale.isVisible().catch(() => false))) await page.locator('button[title="Paramètres"]:visible').first().click();
        await modale.waitFor({ timeout: 10000 });
        await modale.locator(`aside button:has-text("${nom}")`).first().click();
        await pause(500);
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);

    // ── Mémoire : lecture, édition, compteur, Annuler ──
    await onglet('Mémoire');
    v.ok('lecture : entrées du core affichées, aucun champ', (await modale.getByText('Prénom : Alice').count()) > 0 && await modale.locator('[data-mem-entry-user]').count() === 0);
    await modale.locator('[data-mem-edit]').click();
    await pause(250);
    const profil = modale.locator('[data-mem-entry-user]');
    const notes = modale.locator('[data-mem-entry-memory]');
    v.ok('édition : un champ par entrée, prérempli', await profil.count() === 2 && await notes.count() === 2 && (await profil.nth(0).inputValue()) === 'Prénom : Alice' && (await notes.nth(1).inputValue()) === 'Les tests passent par pytest');
    const compteur = modale.locator('[data-mem-count-user]');
    await profil.nth(0).fill('Prénom : Alice Martin');
    await pause(200);
    v.ok('compteur : longueur sérialisée du brouillon (séparateurs compris)', (await compteur.innerText()).trim().startsWith(String('Prénom : Alice Martin'.length + '\n§\n'.length + 'Travaille en français'.length)), await compteur.innerText());
    await modale.locator('[data-mem-cancel]').click();
    await pause(250);
    v.ok('Annuler : retour en lecture, rien n\'est écrit', await profil.count() === 0 && (await modale.getByText('Prénom : Alice').count()) > 0 && puts.length === 0);

    // ── Un seul magasin écrit, liste complète et ordonnée ──
    await modale.locator('[data-mem-edit]').click();
    await pause(250);
    await notes.nth(0).fill('Le dépôt vit dans /srv/devs');
    await modale.locator('[data-mem-add-memory]').click();
    await pause(150);
    await notes.nth(2).fill('Nouvelle note ajoutée à la main');
    await modale.locator('[data-mem-save]').click();
    await pause(800);
    const e1 = JSON.stringify(await etat());
    v.ok('Enregistrer : un seul PUT (notes), profil intact', puts.length === 1 && puts[0].kind === 'memory' && JSON.stringify(puts[0].entries) === JSON.stringify(['Le dépôt vit dans /srv/devs', 'Les tests passent par pytest', 'Nouvelle note ajoutée à la main']), JSON.stringify(puts));
    v.ok('Enregistrer : le core garde les trois notes et le profil d\'origine', e1.includes('Nouvelle note ajoutée à la main') && e1.includes('/srv/devs') && e1.includes('Prénom : Alice') && !e1.includes('Alice Martin'));
    v.ok('Enregistrer : retour en lecture, toast', await notes.count() === 0 && (await page.locator('#app').getByText('Mémoire enregistrée.').count()) > 0);

    // ── Vider les notes : confirmation d'abord ──
    await modale.locator('[data-mem-edit]').click();
    await pause(250);
    for (let i = 0; i < 3; i++) { await modale.locator('button[aria-label="Supprimer cette entrée"]').nth(2).click(); await pause(120); }
    const avant = puts.length;
    await modale.locator('[data-mem-save]').click();
    await pause(400);
    v.ok('vider : confirmation demandée, rien d\'envoyé avant', (await page.locator('#app').getByText('Vider ce que l\'assistant a retenu ?').count()) > 0 && puts.length === avant);
    await page.locator('button:has-text("Vider"):visible').last().click();
    await pause(700);
    v.ok('vider : liste vide écrite, le core n\'a plus de notes', puts.length === avant + 1 && puts.at(-1).entries.length === 0 && !JSON.stringify(await etat()).includes('pytest'));

    // ── Limite et brouillon gardé à la fermeture ──
    await modale.locator('[data-mem-edit]').click();
    await pause(250);
    await profil.nth(0).fill('x'.repeat(5000));
    await pause(250);
    v.ok('au-delà de la limite du core : compteur rouge, Enregistrer désactivé', ((await compteur.getAttribute('class')) || '').includes('text-red-500') && await modale.locator('[data-mem-save]').isDisabled());
    await profil.nth(0).fill('Prénom : Alice brouillon');
    v.ok('brouillon : badge « Modifications non enregistrées »', (await page.locator('#app').getByText('Modifications non enregistrées').count()) > 0);
    await page.keyboard.press('Escape');
    await pause(300);
    v.ok('fermeture : confirmation avant d\'abandonner le brouillon', (await page.locator('#app').getByText('Abandonner les modifications ?').count()) > 0);
    const abandon = page.locator('div[role="dialog"][aria-modal="true"]:has-text("Abandonner")').locator('button:has-text("Abandonner")').first();
    await abandon.click().catch(() => {});
    await pause(300);

    // ── Prompts : rangées, contenu brut, tri, recherche ──
    await onglet('Prompts');
    const items = modale.locator('[data-prompt-item]');
    const titres = async () => (await items.locator('.text-sm.truncate').allInnerTexts()).map((t) => t.trim());
    v.ok('Prompts : une rangée datée par prompt du core, contenu replié', await items.count() === 3 && await modale.locator('[data-prompt-date]').count() === 3 && await modale.locator('[data-prompt-body]').count() === 0);
    v.ok('tri par défaut : plus récents d\'abord', JSON.stringify(await titres()) === JSON.stringify(['Bug report', 'Analyse de logs', 'Résumé de réunion']), JSON.stringify(await titres()));
    await items.first().locator('[role="button"]').click();
    await pause(200);
    const brut = await modale.locator('[data-prompt-body] pre').evaluate((el) => ({ texte: el.innerText, enfants: el.children.length, html: el.innerHTML })).catch(() => ({ texte: '', enfants: -1, html: '' }));
    v.ok('dépli : source Markdown brute, rien d\'interprété, chevrons échappés', brut.texte.includes('# Bug report') && brut.texte.includes('`git bisect`') && brut.enfants === 0 && brut.html.includes('&lt;résumé&gt;'));
    await page.evaluate(() => { window.__copie = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copie = t; return Promise.resolve(); } } }); });
    await items.first().hover();
    await items.first().locator('[data-prompt-copy]').click();
    await pause(250);
    v.ok('« Copier » : la source au presse-papier, toast', ((await page.evaluate(() => window.__copie)) || '').startsWith('# Bug report') && (await page.locator('#app').getByText('Prompt copié').count()) > 0);
    await items.first().locator('[role="button"]').click();
    await modale.locator('[data-prompt-sort]').selectOption('ancien');
    await pause(200);
    v.ok('tri « plus anciens »', JSON.stringify(await titres()) === JSON.stringify(['Résumé de réunion', 'Analyse de logs', 'Bug report']));
    await modale.locator('[data-prompt-sort]').selectOption('titre');
    await pause(200);
    v.ok('tri par titre', JSON.stringify(await titres()) === JSON.stringify(['Analyse de logs', 'Bug report', 'Résumé de réunion']));
    const recherche = modale.locator('[data-prompt-search]');
    await recherche.fill('journaux');
    await pause(300);
    v.ok('recherche dans le contenu, compteur « 1 sur 3 »', await items.count() === 1 && (await titres())[0] === 'Analyse de logs' && (await modale.locator('[data-prompt-count]').innerText()).includes('1 sur 3'));
    await recherche.fill('reunion');
    await pause(300);
    v.ok('recherche insensible aux accents (« reunion » trouve « Résumé de réunion »)', await items.count() === 1 && (await titres())[0] === 'Résumé de réunion', JSON.stringify(await titres()));
    await recherche.fill('');
    await pause(300);
    v.ok('recherche vidée : liste complète', await items.count() === 3);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
