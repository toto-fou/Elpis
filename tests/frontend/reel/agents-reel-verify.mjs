// SPDX-License-Identifier: MIT
/** tests/frontend/reel/agents-reel-verify.mjs — sous-agents contre le core TS réel : onglet Agents (bascule enregistrée seule, banque des 5 modèles, validation des noms, agent créé puis relu du core, suppression), outil `task` exécuté par le core (ligne d'agent en direct, déroulé, fin, réhydratation au rechargement) */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/agents-reel-verify.mjs
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, Client, apparait, disparait } from '../lib/core-reel.mjs';

const EN_STREAM = 'button[title="Arrêter la génération"]';
const DEROULE = '[data-modale-agent]';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('agents-reel');
const core = await demarrerCoreReel({ tokParS: 60, outilsEnProcessus: true });
// Déroulé « Classique » du fil : ces vérifications visent ce déroulé (fil chronologique : fil-reel-verify.mjs).
for (const compte of Object.values(core.comptes)) { const c = new Client(core.urlMain); await c.req('POST', '/api/login-lite', compte); await c.req('PUT', '/api/settings', { chat_workflow: 'classic' }); }
const nav = await lancerNavigateur();
try {
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    const erreurs = [];
    page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
    const puts = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && new URL(r.url()).pathname === '/api/settings') puts.push(r.postDataJSON()); });
    const modale = page.locator('div[aria-label="Paramètres"]');
    const ouvrirOnglet = async () => {
        await page.locator('button[title="Paramètres"]:visible').first().click();
        await modale.locator('aside button:has-text("Agents")').first().click();
        await pause(400);
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);

    // ── Onglet Agents ──
    await ouvrirOnglet();
    const bascule = modale.locator('label:has-text("Activer les sous-agents") input[type=checkbox]').first();
    v.ok('onglet Agents : sous-agents coupés par défaut', !(await bascule.isChecked()));
    await apparait(modale.locator('[data-agent-row="explore"]'));
    const banque = [];
    for (const b of ['explore', 'implement', 'verify', 'web', 'pr']) if (await modale.locator(`[data-agent-row="${b}"]`).isVisible().catch(() => false)) banque.push(b);
    v.ok('banque : les 5 modèles livrés par le core, bandes de capacités, compteur 0 sur 30', banque.length === 5 && await modale.locator('[data-agent-capacites]').count() === 5
        && await apparait(modale.getByText('0 sur 30')), banque.join(','));
    await bascule.click({ force: true });
    await pause(700);
    v.ok('activer : PUT mono-clé agents_enabled, enregistré par le core', puts.length === 1 && Object.keys(puts[0]).join() === 'agents_enabled' && (await api.req('GET', '/api/settings')).agents_enabled === true, JSON.stringify(puts));
    await modale.locator('button:has-text("Nouvel agent"):visible').first().click();
    const nom = modale.locator('input[placeholder="docs-writer"]').first();
    const consigne = modale.locator('textarea.set-textarea').first();
    await nom.waitFor({ timeout: 5000 });
    await consigne.fill('You are a documentation agent.');
    for (const [saisie, attendu] of [['Bad Name', 'Nom invalide'], ['task', 'nom réservé'], ['explore', 'est un modèle livré']]) {
        await nom.fill(saisie);
        await modale.locator('button:has-text("Ajouter"):visible').first().click();
        v.ok(`validation : « ${saisie} » refusé (${attendu})`, await apparait(page.locator('#app').getByText(attendu)));
    }
    await nom.fill('docs-writer');
    await modale.locator('input[placeholder*="documentation"]').first().fill('rédige la documentation du dépôt');
    await modale.locator('button:has-text("Ajouter"):visible').first().click();
    await pause(900);
    const stocke = ((await api.req('GET', '/api/settings')).custom_agents || []).find((a) => a.name === 'docs-writer');
    v.ok('Ajouter : carte affichée, agent enregistré dans le core', await apparait(modale.getByText('docs-writer', { exact: true })) && !!stocke && /documentation agent/.test(stocke.prompt || ''), JSON.stringify(stocke));
    await page.keyboard.press('Escape');
    await page.reload();
    await attendreMontage(page);
    await ouvrirOnglet();
    v.ok('après rechargement : agent relu du core', await apparait(modale.getByText('docs-writer', { exact: true })));
    await modale.locator('[data-agent-menu-btn="docs-writer"]').click();
    await modale.locator('[data-agent-delete="docs-writer"]').click();
    await page.locator('button:has-text("Supprimer"):visible').last().click();
    await pause(900);
    v.ok('suppression : carte retirée, agent effacé du core', await disparait(modale.getByText('docs-writer', { exact: true }))
        && !((await api.req('GET', '/api/settings')).custom_agents || []).some((a) => a.name === 'docs-writer'));
    await page.keyboard.press('Escape');

    // ── Outil task : un sous-agent « explore » tourne sur le faux moteur ──
    const chat = core.chats[0];
    await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
    await pause(800);
    const n0 = core.llm.completions().length;
    core.llm.scripter(
        (d) => ((d.tools || []).some((t) => t.function && t.function.name === 'task')
            ? { appels: [{ nom: 'task', args: { description: 'trouver la définition de parse_date', prompt: 'Find where parse_date is defined and used.', subagent_type: 'explore' } }] }
            : { contenu: `TASK-ABSENT ${JSON.stringify((d.tools || []).map((t) => t.function && t.function.name))}` }),
        { contenu: `parse_date est défini à src/dates.py:12 ${Array.from({ length: 60 }, (_, i) => `m${i}`).join(' ')}`, tokParS: 25 },
        'Réponse : parse_date est défini dans src/dates.py, FIN-AGENT.',
    );
    await page.locator('textarea[placeholder]').last().fill('Trouve où parse_date est défini.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    const ligne = page.locator('.task-runs .task-run').first();
    await ligne.waitFor({ timeout: 20000 }).catch(() => {});
    v.ok('direct : ligne d\'agent avec sa branche et son libellé', await ligne.isVisible().catch(() => false) && (await page.locator('.task-branch').first().textContent().catch(() => '')).includes('└')
        && (await page.locator('.task-run-title').first().textContent().catch(() => '')).includes('trouver la définition de parse_date'));
    v.ok('direct : icône d\'état animée, bouton ✕ pendant le run', await page.locator('.task-run-ico.animate-spin').count() === 1 && await page.locator('.task-run-cancel').first().isVisible().catch(() => false));
    await page.locator('.task-run-eye').first().click().catch(() => {});
    await page.waitForSelector(DEROULE, { timeout: 5000 }).catch(() => {});
    const deroule = await page.locator(DEROULE).textContent().catch(() => '');
    v.ok('déroulé : instructions de l\'agent en tête', (deroule || '').includes('Find where parse_date is defined and used.'), (deroule || '').slice(0, 120));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.body.innerText.includes('FIN-AGENT'), null, { timeout: 40000 }).catch(() => {});
    await page.waitForSelector(EN_STREAM, { state: 'detached', timeout: 20000 }).catch(() => {});
    v.ok('fin : réponse finale, ligne d\'agent gardée avec la coche', await page.locator('.task-run-ico.is-done').count() >= 1 && (await page.locator('#app').innerText()).includes('FIN-AGENT'));
    const appels = core.llm.completions().slice(n0);
    v.ok('le core lance le sous-agent sur le moteur avec la consigne, puis rend son résultat au parent', appels.length === 3 && JSON.stringify(appels[1].corps.messages).includes('Find where parse_date is defined')
        && JSON.stringify(appels[2].corps.messages).includes('src/dates.py:12'), String(appels.length));
    await page.reload();
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
    await page.locator('.task-runs .task-run').first().waitFor({ timeout: 10000 }).catch(() => {});
    v.ok('rechargé : ligne d\'agent réhydratée depuis le core, terminée', await page.locator('.task-runs .task-run').count() >= 1 && await page.locator('.task-run-ico.is-done').count() >= 1);
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
