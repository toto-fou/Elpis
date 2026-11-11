// SPDX-License-Identifier: MIT
/** tests/frontend/reel/commandes-reel-verify.mjs — menu « / » du composeur contre le core TS réel : commandes, filtrage, repli sur les skills, valeurs, clavier, /plan enregistré par le core sans appel au moteur, prompts personnels et partagés, commande inconnue envoyée, mode plan scellé à la création puis rendu par le core */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/commandes-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, apparait, disparait } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const v = verifications('commandes-reel');
const core = await demarrerCoreReel({ tokParS: 200 });
const nav = await lancerNavigateur();
try {
    const alice = new Client(core.urlMain);
    await alice.req('POST', '/api/login-lite', core.comptes.user);
    await alice.req('POST', '/api/prompts', { title: 'Résumé de réunion', content: 'Fais un résumé structuré de la réunion : décisions, actions, échéances.' });
    const admin = new Client(core.urlMain);
    await admin.req('POST', '/api/login-lite', core.comptes.admin);
    const { id: pid } = await admin.req('POST', '/api/prompts', { title: 'Checklist de mise en production', content: 'Vérifie sauvegardes, migrations et retour arrière.' });
    const console_ = new Client(core.urlAdmin);
    await console_.req('POST', '/api/login-lite', core.comptes.admin);
    const comptes = await console_.req('GET', '/api/admin/users-with-groups');
    const idAlice = ((comptes.items || comptes.users || comptes) || []).find((u) => u.username === 'alice')?.id;
    await admin.req('POST', '/api/prompts/share', { prompt_id: pid, user_ids: [idAlice] });
    const skills = ((await alice.req('GET', '/api/skills')).skills || []).map((s) => s.name).filter(Boolean);

    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const requetes = [];
    page.on('request', (r) => { const p = new URL(r.url()).pathname; if (r.method() !== 'GET') requetes.push({ m: r.method(), p, corps: r.postDataJSON() }); });
    const vers = (motif) => requetes.filter((r) => motif.test(r.p));
    const menu = page.locator('#slash-list');
    const lignes = page.locator('#slash-list li[data-slash-row]');
    const niveau = () => page.locator('[data-slash-level]').getAttribute('data-slash-level').catch(() => null);
    const ta = page.locator('textarea[placeholder]').last();
    const taper = async (t) => { await ta.type(t, { delay: 12 }); await page.waitForTimeout(250); };
    const vider = async () => { await ta.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace'); await page.waitForTimeout(220); };
    const textes = async () => (await lignes.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    const chat = core.chats[0];
    await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
    await page.waitForFunction((t) => document.body.innerText.includes(t), `${chat.titre} : question 1`, { timeout: 15000 }).catch(() => {});

    // ── Commandes, filtrage, repli sur les skills ──
    await ta.click();
    await taper('/');
    const toutes = await textes();
    v.ok('« / » : menu des commandes', await apparait(menu) && (await niveau()) === 'commands'
        && ['/plan', '/prompt', '/skills', '/settings', '/memory', '/usage', '/help', '/compact'].every((n) => toutes.some((t) => t.startsWith(n + ' ') || t.startsWith(n + ' ⟨'))), toutes.join(' | ').slice(0, 300));
    await taper('p');
    const p1 = await textes();
    v.ok('filtrage : préfixe avant sous-chaîne', p1.length >= 2 && (p1[0].startsWith('/plan') || p1[0].startsWith('/prompt')), p1.join(' | '));
    if (skills.length) {
        await vider();
        await taper('/' + skills[0].slice(0, 4));
        v.ok(`aucune commande : repli sur les skills du core (« ${skills[0]} »)`, (await niveau()) === 'skills' && (await textes()).some((t) => t.includes(skills[0])), (await textes()).join(' | '));
    }
    await vider();
    await taper('/settings ');
    v.ok('/settings + espace : menu gardé, niveau valeurs (memory, usage)', await apparait(menu) && (await niveau()) === 'values' && (await textes()).some((t) => t.includes('memory')));

    // ── Clavier ──
    await vider();
    await taper('/');
    const avant = await lignes.nth(0).getAttribute('class');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    v.ok('↓ déplace la surbrillance', avant !== await lignes.nth(0).getAttribute('class'));
    await vider();
    await taper('/pl');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    v.ok('Échap ferme le menu sans vider la saisie, la frappe suivante le rouvre', await disparait(menu) && (await ta.inputValue()) === '/pl'
        && (await taper('a'), await apparait(menu)));

    // ── /plan : enregistré par le core, aucun appel au moteur ──
    const n0 = core.llm.completions().length;
    await vider();
    await taper('/plan');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const plans = vers(/\/plan-mode$/);
    v.ok('/plan : un PUT plan_mode=true, saisie consommée, une seule puce « Mode plan » (pas de témoin en en-tête)', plans.length === 1 && plans[0].corps.plan_mode === true && (await ta.inputValue()) === ''
        && await page.locator('[data-plan-badge]').count() === 0 && await page.locator('[data-plan-chip]').count() === 1, JSON.stringify(plans));
    v.ok('/plan : le core a enregistré le mode', (await alice.req('GET', `/api/saved/chats/${chat.id}`)).plan_mode === true);
    v.ok('/plan : aucun appel au moteur', core.llm.completions().length === n0 && vers(/chat-saved-stream3/).length === 0);
    await vider();
    await taper('/plan on');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    v.ok('« /plan on » déjà actif : aucun nouveau PUT', vers(/\/plan-mode$/).length === 1);
    await page.locator('[data-plan-chip] button[aria-label="Désactiver le mode plan"]').click();
    await page.waitForTimeout(700);
    v.ok('clic sur la puce : PUT false, témoins retirés, mode coupé dans le core', vers(/\/plan-mode$/).at(-1).corps.plan_mode === false && await page.locator('[data-plan-chip]').count() === 0
        && (await alice.req('GET', `/api/saved/chats/${chat.id}`)).plan_mode === false);
    await vider();
    await taper('/plan off');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    v.ok('« /plan off » déjà coupé : aucun PUT (pas d\'inversion)', vers(/\/plan-mode$/).length === 2);

    // ── Prompts personnels et reçus en partage : insérés, jamais envoyés ──
    await vider();
    await taper('/prompt');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    const pr = await textes();
    v.ok('/prompt : prompts personnels et partagés lus du core', (await niveau()) === 'prompts' && pr.some((t) => t.includes('Résumé de réunion')) && pr.some((t) => t.includes('Checklist de mise en production')), pr.join(' | '));
    await lignes.filter({ hasText: 'Résumé de réunion' }).first().click();
    await page.waitForTimeout(500);
    const saisie = await ta.inputValue();
    v.ok('prompt choisi : inséré dans le composeur, rien d\'envoyé', saisie.includes('résumé structuré') && !saisie.startsWith('/prompt') && vers(/chat-saved-stream3/).length === 0);

    // ── Commande inconnue : part au moteur ──
    await vider();
    core.llm.scripter('Je ne connais pas cette commande, REPONSE-ZZZ.');
    await taper('/zzz bonjour');
    await page.keyboard.press('Enter');
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    await page.waitForFunction(() => document.body.innerText.includes('REPONSE-ZZZ'), null, { timeout: 15000 }).catch(() => {});
    v.ok('commande inconnue : envoyée au moteur telle quelle', JSON.stringify(core.llm.completions().at(-1).corps.messages || []).includes('/zzz bonjour'));

    // ── Chat vierge : /plan armé sans appel, scellé à la création, rendu par le core ──
    await page.locator('button[title="Nouveau chat (Ctrl+Maj+O)"]').last().click();
    await page.waitForTimeout(500);
    const r0 = requetes.length;
    await ta.click();
    await taper('/plan');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    v.ok('chat vierge : /plan armé sans aucun appel au core', requetes.length === r0 && await page.locator('[data-plan-chip]').count() === 1
        && await apparait(page.getByText('Mode plan armé')));
    core.llm.scripter('## Plan\n1. Étape une\n2. Étape deux');
    await taper('Prépare un plan de migration');
    await page.keyboard.press('Enter');
    await page.waitForSelector(EN_STREAM, { timeout: 10000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);
    const creation = vers(/\/api\/saved\/chats\/new$/).slice(-1)[0];
    v.ok('création : le POST /new scelle le mode (plan_mode true)', !!creation && creation.corps.plan_mode === true, JSON.stringify(creation));
    v.ok('le moteur reçoit la demande, en mode plan', JSON.stringify(core.llm.completions().at(-1).corps.messages || []).includes('Prépare un plan de migration'));
    v.ok('plan rendu : le core coupe le mode, puce et témoin partis seuls, toast « Plan rendu »', await page.locator('[data-plan-chip]').count() === 0 && await page.locator('[data-plan-badge]').count() === 0
        && await apparait(page.getByText('Plan rendu')));
    v.ok('aucun PUT /plan-mode dans ce scénario (décision du core)', vers(/\/plan-mode$/).length === 2);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
