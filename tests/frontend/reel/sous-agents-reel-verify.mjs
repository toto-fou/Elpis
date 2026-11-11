// SPDX-License-Identifier: MIT
/** tests/frontend/reel/sous-agents-reel-verify.mjs — sous-agents contre le core TS réel : console › Sandbox › Sous-agents (imposer la lecture seule d'explore, enregistrée dans config.json, relue), Paramètres › Agents (case d'explore cochée et grisée, case d'implement écrite dans custom_agents), cartes de runs persistés : bloc `budget_exhausted` (badge, 95/100 appels, détails dépliables : fichiers sûrs, candidats, avertissements de budget) et bloc `partial` arrêté sur budget, run réel de deux sous-agents lancés ensemble (web refusé avant lancement : sa ligne se ferme « indisponible » avec la cause ; explore sur sa propre ligne, bloc rendu par le core, lecture seule imposée), sans violation CSP */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/sous-agents-reel-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, apparait, Client } from '../lib/core-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('sous-agents-reel');
const core = await demarrerCoreReel({ tokParS: 200, outilsEnProcessus: true });
// Déroulé « Classique » du fil : ces vérifications visent ce déroulé (fil chronologique : fil-reel-verify.mjs).
for (const compte of Object.values(core.comptes)) { const c = new Client(core.urlMain); await c.req('POST', '/api/login-lite', compte); await c.req('PUT', '/api/settings', { chat_workflow: 'classic' }); }
const nav = await lancerNavigateur();
const BILAN = {
    status: 'budget_exhausted', tool_calls: 95, tool_calls_total: 95, tool_budget: 100, iterations: 95, resumed: false, budget_reset: false, duration_s: 72,
    files_changed: [{ path: 'src/route.ts', change: 'modified', added: 12, removed: 3 }, { path: 'src/route.test.ts', change: 'created', added: 40 }],
    files_changed_candidates: [{ path: '/work/calls.log', change: 'modified', added: 3 }], files_changed_attribution: 'uncertain', overlapped_with: ['t2-0a1b2c'],
    budget_warnings: [{ at: 50, text: 'Tool-iteration budget: 50/100 used, 50 left.' }, { at: 95, text: 'Tool-iteration budget: 95/100 used — only 5 left. Wrap up.' }],
    git: { branch: 'feat/route', commits: ['a1b2c3d Route'] }, errors: 1,
    read_only: false, read_only_source: null, remaining_work: 'Écrire les tests de la route.', report_chars: 900,
};
const BILAN_ARRET = {
    ...BILAN, status: 'partial', stop_reason: 'budget_wrap_up', tool_calls: 8, tool_calls_total: 8, tool_budget: 10, files_changed: [], files_changed_candidates: undefined,
    files_changed_attribution: undefined, git: { commits: [] }, budget_warnings: [{ at: 8, text: 'Tool-iteration budget: 8/10 used — only 2 left. Wrap up.' }],
};
try {
    const admin = new Client(core.urlAdmin);
    await admin.req('POST', '/api/login-lite', core.comptes.admin);
    const api = new Client(core.urlMain);
    await api.req('POST', '/api/login-lite', core.comptes.user);
    const fichierConfig = () => JSON.parse(fs.readFileSync(path.join(core.dossier, 'config.json'), 'utf8'));
    const erreurs = [];
    const violations = [];
    const surveiller = async (p) => {
        p.on('pageerror', (e) => erreurs.push(String(e.message || e)));
        await p.exposeBinding('__violationCsp', (_s, d) => violations.push(d));
        await p.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__violationCsp(`${e.effectiveDirective} ${e.blockedURI}`)));
    };

    // ── Console › Sandbox › Sous-agents : imposer la lecture seule d'explore ──
    const ctxAdmin = await contexteConnecte(nav, core.urlAdmin, core.comptes.admin);
    const pa = await ctxAdmin.newPage();
    await surveiller(pa);
    const ouvrirConsole = async () => {
        await pa.goto(core.urlAdmin + '/');
        await attendreMontage(pa);
        await pa.locator('aside .adm-nav__entry:has-text("Sandbox"):visible').first().click();
        await pause(150);
        await pa.locator('aside .adm-nav__sub:has-text("Sous-agents"):visible').first().click();
        await pa.locator('#ag-ro-impose-explore').waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
        await pause(300);
    };
    const coche = (id) => pa.locator('#' + id).isChecked().catch(() => null);
    await ouvrirConsole();
    v.ok('console : page « Sous-agents », six types, explore en lecture seule par défaut, rien d\'imposé, 3 simultanés', await pa.locator('[data-agent-type]').count() === 6
        && await coche('ag-ro-defaut-explore') === true && await coche('ag-ro-impose-explore') === false && await coche('ag-ro-defaut-implement') === false
        && await pa.locator('#ag-parallele').inputValue().catch(() => '') === '3');
    await pa.locator('#ag-ro-impose-explore').locator('xpath=ancestor::label').click();
    await pause(200);
    v.ok('édition : barre « 1 modification »', (await pa.locator('.adm-savebar__count').innerText().catch(() => '')).trim() === '1 modification');
    const envoi = pa.waitForResponse((r) => r.url().endsWith('/api/admin/agents') && r.request().method() === 'POST', { timeout: 10000 }).catch(() => null);
    await pa.locator('.adm-savebar button:has-text("Enregistrer")').first().click();
    const rep = await envoi;
    await pause(400);
    v.ok('Enregistrer : POST /api/admin/agents accepté, config.json › agents.read_only.forced.explore = true', !!rep && rep.ok() && fichierConfig().agents?.read_only?.forced?.explore === true, JSON.stringify(fichierConfig().agents));
    await ouvrirConsole();
    v.ok('rechargement de la console : « Imposer » relu coché pour explore', await coche('ag-ro-impose-explore') === true && await coche('ag-ro-impose-implement') === false);

    // ── Paramètres › Agents : case imposée, case libre écrite dans custom_agents ──
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    await surveiller(page);
    const modale = page.locator('div[aria-label="Paramètres"]');
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('button[title="Paramètres"]:visible').first().click();
    await modale.locator('aside button:has-text("Agents")').first().click();
    await apparait(modale.locator('[data-agent-row="explore"]'));
    v.ok('bande : puce « Lecture seule » d\'explore, infobulle « imposé par l\'administrateur » et Modifier retiré', ((await modale.locator('[data-agent-row="explore"] [data-capacite="lecture_seule"]').getAttribute('title')) || '').includes('imposé par l\'administrateur')
        && ((await modale.locator('[data-agent-row="explore"] [data-capacite="lecture_seule"]').getAttribute('title')) || '').includes('Modifier'));
    await modale.locator('[data-agent-edit="explore"]').click();
    const roExplore = modale.locator('[data-agent-ro="rw"]');
    await apparait(roExplore);
    v.ok('Paramètres › Agents : explore en lecture seule, segments grisés, « Imposé par l\'administrateur »', await roExplore.isDisabled() && await modale.locator('[data-agent-ro="ro"]').isDisabled()
        && (await modale.locator('[data-agent-ro="ro"]').getAttribute('aria-pressed')) === 'true'
        && (await modale.locator('[data-agent-ro-impose]').getAttribute('title')) === 'Imposé par l\'administrateur');
    v.ok('infobulle : ce que retire la lecture seule', /Lecture seule retire aussi Terminal et les commits/.test((await modale.locator('[data-agent-editor] [data-agent-fichiers]').evaluate((g) => document.getElementById(g.getAttribute('aria-labelledby'))?.title || '').catch(() => ''))));
    await modale.locator('[data-agent-edit="implement"]').click();
    const roImpl = modale.locator('[data-agent-ro="ro"]');
    await apparait(roImpl);
    v.ok('implement : lecture et écriture, modifiable, défaut de l\'administrateur', !(await roImpl.isDisabled()) && (await modale.locator('[data-agent-ro="rw"]').getAttribute('aria-pressed')) === 'true'
        && /Défaut de l'administrateur : lecture et écriture/.test(await modale.locator('[data-agent-editor] [data-agent-fichiers]').evaluate((g) => document.getElementById(g.getAttribute('aria-labelledby'))?.title || '')));
    await roImpl.click();
    const put = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PUT', { timeout: 10000 }).catch(() => null);
    await modale.locator('[data-agent-save]').click();
    const pr = await put;
    const stocke = ((await api.req('GET', '/api/settings')).custom_agents || []).find((a) => a.name === 'implement');
    v.ok('implement en lecture seule, Enregistrer : PUT custom_agents accepté, read_only relu du core, Terminal barré', !!pr && pr.ok() && stocke?.read_only === true
        && ((await modale.locator('[data-agent-row="implement"] [data-capacite="lecture_seule"]').getAttribute('title')) || '').includes('Terminal'), JSON.stringify(stocke));
    const modeles = await api.req('GET', '/api/settings/agent-templates');
    v.ok('core : read_only_policy et modèle explore imposé', modeles.read_only_policy?.forced?.explore === true && modeles.templates.find((t) => t.name === 'explore')?.read_only_forced === true);
    await page.keyboard.press('Escape');

    // ── Carte d'un run persisté avec le bloc du harnais ──
    const { id } = await api.req('POST', '/api/saved/chats/new', {});
    await api.req('PUT', `/api/saved/chats/${id}/save-messages`, {
        title: 'Bilan sous-agent',
        messages: [
            { role: 'user', content: 'Branche la route.' },
            { role: 'assistant', content: 'Le sous-agent a épuisé son budget.', task_runs: [
                { id: 'k1', agent: 'implement', label: 'brancher la route', state: 'incomplete', steps_total: 95, context_tokens: 4200, duration_ms: 72000, transcript: [{ text: 'travail' }], result: 'Rapport partiel.', harness: BILAN },
                { id: 'k2', agent: 'explore', label: 'lire la route', state: 'completed', steps_total: 8, context_tokens: 900, duration_ms: 9000, transcript: [{ text: 'lu' }], result: 'Status: partial', harness: BILAN_ARRET },
            ] },
        ],
    });
    const relu = (await api.req('GET', `/api/saved/chats/${id}`)).messages?.[1]?.task_runs?.[0]?.harness;
    v.ok('core : bloc du harnais gardé dans task_runs[] persisté (candidats et avertissements compris)', relu?.status === 'budget_exhausted' && relu.tool_calls === 95
        && relu.files_changed_candidates?.length === 1 && relu.budget_warnings?.length === 2, JSON.stringify(relu));
    await page.reload();
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: 'Bilan sous-agent' }).first().click();
    const ligne = page.locator('.task-runs .task-run').first();
    await apparait(ligne);
    v.ok('carte : badge « budget épuisé » et « 95/100 appels »', (await page.locator('[data-task-status]').first().innerText().catch(() => '')) === 'budget épuisé'
        && (await page.locator('[data-task-calls]').first().innerText().catch(() => '')) === '95/100 appels', await ligne.innerText().catch(() => ''));
    v.ok('carte : durée et reste à faire', (await page.locator('[data-task-duration]').first().innerText()).includes('1 min 12 s') && (await page.locator('[data-task-reste]').first().innerText()).includes('Écrire les tests'));
    const plus = page.locator('[data-task-more]').first();
    v.ok('détails : bouton « 2 fichiers · 1 incertain · 1 commit » replié', (await plus.innerText()).includes('2 fichiers · 1 incertain · 1 commit') && await plus.getAttribute('aria-expanded') === 'false');
    await plus.focus();
    await page.keyboard.press('Enter');
    await pause(200);
    const details = page.locator('.task-run-details').first();
    v.ok('détails dépliés au clavier : fichiers sûrs, puis « peut-être modifiés par un autre agent », commit', await plus.getAttribute('aria-expanded') === 'true' && await details.locator('[data-task-bilan-file]').count() === 2
        && await details.locator('[data-task-bilan-candidat]').count() === 1 && (await details.innerText()).includes('Peut-être modifiés par un autre agent (1)')
        && await details.locator('[data-task-bilan-incertain]').isVisible() && (await details.locator('[data-task-bilan-commit]').innerText()).includes('a1b2c3d'));
    v.ok('détails : avertissements de budget listés', await details.locator('[data-task-bilan-avertissement]').count() === 2
        && (await details.locator('[data-task-bilan-avertissement]').nth(1).innerText()).includes('après 95 appels'));
    const lignesPersistees = page.locator('.task-runs').first().locator(':scope > div');
    const ligneArret = lignesPersistees.nth(1);
    v.ok('carte : « partiel » et « arrêt sur budget » pour un agent qui a conclu sur l\'avertissement', (await ligneArret.locator('[data-task-status]').innerText().catch(() => '')) === 'partiel'
        && (await ligneArret.locator('[data-task-arret]').innerText().catch(() => '')).includes('arrêt sur budget')
        && await lignesPersistees.nth(0).locator('[data-task-arret]').count() === 0, await ligneArret.innerText().catch(() => ''));
    await page.locator('.task-run-eye').first().click();
    const deroule = page.locator('[data-modale-agent] [data-task-harness]');
    v.ok('déroulé : bloc « Bilan » avec le badge et le reste à faire', await apparait(deroule) && (await deroule.innerText()).includes('budget épuisé') && (await deroule.innerText()).includes('Écrire les tests'));
    await page.keyboard.press('Escape');

    // ── Run réel : web (refusé avant lancement, navigateur non servi) et explore lancés ensemble, chacun sur sa ligne ──
    await api.req('PUT', '/api/settings', { agents_enabled: true });
    const chat = core.chats[0];
    await page.reload();
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: chat.titre }).first().click();
    await pause(800);
    core.llm.scripter(
        (d) => ((d.tools || []).some((t) => t.function && t.function.name === 'task')
            ? { appels: [
                { nom: 'task', args: { description: 'chercher la doc', prompt: 'Find the parse_date docs online.', subagent_type: 'web' } },
                { nom: 'task', args: { description: 'trouver parse_date', prompt: 'Find where parse_date is defined.', subagent_type: 'explore' } },
            ] }
            : { contenu: 'TASK-ABSENT' }),
        { contenu: 'Status: done\nparse_date est défini à src/dates.py:12.' },
        'Réponse : src/dates.py, FIN-REEL.',
    );
    await page.locator('textarea[placeholder]').last().fill('Trouve où parse_date est défini.');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForFunction(() => document.body.innerText.includes('FIN-REEL'), null, { timeout: 40000 }).catch(() => {});
    const lignesReel = page.locator('.task-runs').last().locator(':scope > div');
    const ligneWeb = lignesReel.nth(0);
    const ligneExplore = lignesReel.nth(1);
    const statutReel = ligneExplore.locator('[data-task-status]');
    const libelles = ['terminé', 'partiel', 'bloqué', 'budget épuisé', 'délai dépassé', 'indisponible', 'erreur', 'annulé'];
    v.ok('run réel : deux lignes, chacune sous le titre de son appel', await apparait(statutReel, 20000) && await lignesReel.count() === 2
        && (await ligneWeb.locator('.task-run-title').innerText()).trim() === 'web — chercher la doc'
        && (await ligneExplore.locator('.task-run-title').innerText()).trim() === 'explore — trouver parse_date', await page.locator('.task-runs').last().innerText().catch(() => ''));
    v.ok('run réel : explore, badge de statut du core et appels sur le budget, sur SA ligne', libelles.includes(await statutReel.innerText())
        && /^\d+\/\d+ appels$/.test(await ligneExplore.locator('[data-task-calls]').innerText()));
    v.ok('run réel : explore en lecture seule imposée par l\'administrateur', (await ligneExplore.locator('[data-task-ro]').getAttribute('title').catch(() => '')) === 'Lecture seule : imposée par l\'administrateur');
    v.ok('refus avant lancement : la ligne web se ferme « indisponible » (ni « En attente » ni bouton d\'arrêt)', (await ligneWeb.locator('[data-task-status]').innerText().catch(() => '')) === 'indisponible'
        && !(await ligneWeb.innerText()).includes('En attente') && await ligneWeb.locator('.task-run-cancel').count() === 0);
    await ligneWeb.locator('[data-task-more]').click();
    await pause(150);
    v.ok('refus avant lancement : la cause s\'affiche dans les détails', (await ligneWeb.locator('.task-run-details').innerText().catch(() => '')).includes('not served'), await ligneWeb.innerText().catch(() => ''));
    v.ok('aucune violation CSP', violations.length === 0, violations.join(' | '));
    v.ok('aucune erreur JS', erreurs.length === 0, erreurs.join(' | '));
} catch (e) {
    console.error(e);
    console.error(core.journaux.main.join('').slice(-3000));
    v.ok('parcours mené à son terme', false, String(e.message || e));
} finally {
    await nav.close();
    await core.arreter();
}
process.exit(v.bilan());
