// SPDX-License-Identifier: MIT
/** tests/frontend/reel/sous-agents-reel-verify.mjs — sous-agents contre le core TS réel : console › Sandbox › Sous-agents (imposer la lecture seule d'explore, enregistrée dans config.json, relue), page Agents du menu Plus (case Modifier d'explore sous cadenas, fiche d'explore grisée « Imposé », lecture seule d'implement écrite dans custom_agents), cartes de runs persistés : bloc `budget_exhausted` (badge, 95 appels, détails dépliables : fichiers, autre agent en même temps, avertissements de budget) et bloc `partial` arrêté sur budget, run réel de deux sous-agents lancés ensemble (web refusé avant lancement : sa ligne se ferme « indisponible » ; explore sur sa propre ligne, bloc rendu par le core, lecture seule), sans violation CSP */
// Recette : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=/opt/pw-browsers/chromium] node tests/frontend/reel/sous-agents-reel-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { demarrerCoreReel, lancerNavigateur, contexteConnecte, attendreMontage, verifications, apparait, disparait, Client } from '../lib/core-reel.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const v = verifications('sous-agents-reel');
const core = await demarrerCoreReel({ tokParS: 200, outilsEnProcessus: true });
// Déroulé « Classique » du fil : ces vérifications visent ce déroulé (fil chronologique : fil-reel-verify.mjs).
for (const compte of Object.values(core.comptes)) { const c = new Client(core.urlMain); await c.req('POST', '/api/login-lite', compte); await c.req('PUT', '/api/settings', { chat_workflow: 'classic' }); }
const nav = await lancerNavigateur();
// Bloc du harnais actuel (packages/contracts/src/evenements.ts) : budget d'appels, source de la lecture seule et fichiers « candidats » retirés, `concurrent` signale un autre agent du compte.
const BILAN = {
    status: 'budget_exhausted', tool_calls: 95, tool_calls_total: 95, iterations: 95, resumed: false, duration_s: 72,
    files_changed: [{ path: 'src/route.ts', change: 'modified', added: 12, removed: 3 }, { path: 'src/route.test.ts', change: 'created', added: 40 }], concurrent: true,
    budget_warnings: [{ at: 50, text: 'Tool-iteration budget: 50/100 used, 50 left.' }, { at: 95, text: 'Tool-iteration budget: 95/100 used — only 5 left. Wrap up.' }],
    git: { branch: 'feat/route', commits: ['a1b2c3d Route'] }, errors: 1,
    read_only: false, remaining_work: 'Écrire les tests de la route.', report_chars: 900,
};
const BILAN_ARRET = {
    ...BILAN, status: 'partial', stop_reason: 'budget_wrap_up', tool_calls: 8, tool_calls_total: 8, files_changed: [], concurrent: undefined,
    git: { commits: [] }, budget_warnings: [{ at: 8, text: 'Tool-iteration budget: 8/10 used — only 2 left. Wrap up.' }],
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
        await p.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => window.__violationCsp(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber}`)));
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
    // Le réglage « sous-agents simultanés » (agents.max_parallel) a été retiré du produit : le plafond par compte est sur la carte du moteur.
    const types = await pa.locator('#sandbox-agents-ro [data-agent-type]').evaluateAll((l) => l.map((e) => e.getAttribute('data-agent-type')));
    v.ok('console : carte « Lecture seule », six types, explore en lecture seule par défaut, rien d\'imposé', types.join() === 'explore,implement,verify,web,pr,custom'
        && await coche('ag-ro-defaut-explore') === true && await coche('ag-ro-impose-explore') === false && await coche('ag-ro-defaut-implement') === false, types.join());
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

    // ── Page Agents (menu Plus) : lecture seule imposée sur explore, choix libre d'implement écrit dans custom_agents ──
    const ctx = await contexteConnecte(nav, core.urlMain, core.comptes.user);
    const page = await ctx.newPage();
    await surveiller(page);
    const agents = page.locator('[role="region"][aria-label="Gestion des agents"]');
    const fiche = agents.locator('[data-agent-fiche]');
    const ouvrirDroits = async (nom) => {
        await agents.locator(`[data-agent-open="${nom}"]`).click();
        await fiche.waitFor({ timeout: 5000 }).catch(() => {});
        await agents.locator('[data-agent-onglet="droits"]').click();
        await apparait(agents.locator('[data-agent-ro="rw"]'));
    };
    await page.goto(core.urlMain + '/');
    await attendreMontage(page);
    await page.locator('aside.elpis-slide-panel button[data-menu-plus]:visible').first().click();
    await page.locator('[role="menu"][aria-label="Plus"] [role="menuitem"][data-precharge="agents"]:visible').click();
    // La bande d'une carte ne dit plus qui impose la lecture seule (features/agents/page.ts) : l'origine se lit dans l'onglet Droits de la fiche.
    const modifierExplore = agents.locator('[data-agent-card="explore"] [data-capacite="modifier"]');
    await apparait(modifierExplore);
    v.ok('carte explore : case Modifier sous cadenas « Lecture seule : Modifier retiré »', (await modifierExplore.getAttribute('data-etat')) === 'verrou'
        && (await modifierExplore.getAttribute('title')) === 'Lecture seule : Modifier retiré');
    await ouvrirDroits('explore');
    const rw = agents.locator('[data-agent-ro="rw"]');
    const ro = agents.locator('[data-agent-ro="ro"]');
    v.ok('fiche explore › Droits : lecture seule retenue, choix grisés, « Imposé par l\'administrateur »', await rw.isDisabled() && await ro.isDisabled()
        && (await ro.getAttribute('aria-pressed')) === 'true'
        && (await agents.locator('[data-agent-ro-impose]').getAttribute('title').catch(() => '')) === 'Imposé par l\'administrateur');
    v.ok('effet écrit sous le choix : ce que retire la lecture seule', /rien n'est modifié, et le Terminal est retiré/.test(await agents.locator('[data-agent-ro-effet]').innerText().catch(() => '')));
    await agents.locator('[data-agents-retour]').click();
    await disparait(fiche);
    await ouvrirDroits('implement');
    const libreAvant = !(await ro.isDisabled()) && (await rw.getAttribute('aria-pressed')) === 'true' && await agents.locator('[data-agent-ro-impose]').count() === 0;
    await ro.click();
    v.ok('implement : écriture retenue et modifiable ; lecture seule choisie, « Défaut » rappelle le défaut de l\'administrateur (écriture)', libreAvant
        && (await ro.getAttribute('aria-pressed')) === 'true'
        && (await agents.locator('[data-agent-ro-defaut]').getAttribute('title').catch(() => '')) === 'Revenir au défaut de l\'administrateur : écriture');
    const put = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PUT', { timeout: 10000 }).catch(() => null);
    await agents.locator('[data-agent-save]').click();
    const pr = await put;
    await disparait(fiche);
    const stocke = ((await api.req('GET', '/api/settings')).custom_agents || []).find((a) => a.name === 'implement');
    const terminalImpl = agents.locator('[data-agent-card="implement"] [data-capacite="terminal"]');
    await apparait(terminalImpl);
    v.ok('implement en lecture seule, Enregistrer : PUT custom_agents accepté, read_only relu du core, Terminal barré sur la carte', !!pr && pr.ok() && stocke?.read_only === true
        && (await terminalImpl.getAttribute('data-etat')) === 'non' && (await terminalImpl.getAttribute('title')) === 'Terminal : retiré par la lecture seule', JSON.stringify(stocke));
    const modeles = await api.req('GET', '/api/settings/agent-templates');
    v.ok('core : read_only_policy et modèle explore imposé', modeles.read_only_policy?.forced?.explore === true && modeles.templates.find((t) => t.name === 'explore')?.read_only_forced === true);
    await page.keyboard.press('Escape');
    await disparait(agents);

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
    v.ok('core : bloc du harnais gardé dans task_runs[] persisté (autre agent et avertissements compris)', relu?.status === 'budget_exhausted' && relu.tool_calls === 95
        && relu.concurrent === true && relu.budget_warnings?.length === 2, JSON.stringify(relu));
    await page.reload();
    await attendreMontage(page);
    await page.locator('[data-chat-row]', { hasText: 'Bilan sous-agent' }).first().click();
    const ligne = page.locator('.task-runs .task-run').first();
    await apparait(ligne);
    v.ok('carte : badge « budget épuisé » et « 95 appels »', (await page.locator('[data-task-status]').first().innerText().catch(() => '')) === 'budget épuisé'
        && (await page.locator('[data-task-calls]').first().innerText().catch(() => '')) === '95 appels', await ligne.innerText().catch(() => ''));
    v.ok('carte : durée et reste à faire', (await page.locator('[data-task-duration]').first().innerText()).includes('1 min 12 s') && (await page.locator('[data-task-reste]').first().innerText()).includes('Écrire les tests'));
    const plus = page.locator('[data-task-more]').first();
    v.ok('détails : bouton « 2 fichiers · 1 commit » replié', (await plus.innerText()).includes('2 fichiers · 1 commit') && await plus.getAttribute('aria-expanded') === 'false', await plus.innerText());
    await plus.focus();
    await page.keyboard.press('Enter');
    await pause(200);
    const details = page.locator('.task-run-details').first();
    v.ok('détails dépliés au clavier : fichiers, note « un autre agent du compte tournait en même temps », commit', await plus.getAttribute('aria-expanded') === 'true' && await details.locator('[data-task-bilan-file]').count() === 2
        && await details.locator('[data-task-bilan-concurrent]').isVisible() && (await details.innerText()).includes('Un autre agent du compte tournait en même temps')
        && (await details.locator('[data-task-bilan-commit]').innerText()).includes('a1b2c3d'));
    v.ok('détails : avertissements de budget listés', await details.locator('[data-task-bilan-avertissement]').count() === 2
        && (await details.locator('[data-task-bilan-avertissement]').nth(1).innerText()).includes('après 95 appels'));
    const lignesPersistees = page.locator('.task-runs').first().locator(':scope > div');
    const ligneArret = lignesPersistees.nth(1);
    v.ok('carte : « partiel » et « arrêt sur budget » pour un agent qui a conclu sur l\'avertissement', (await ligneArret.locator('[data-task-status]').innerText().catch(() => '')) === 'partiel'
        && (await ligneArret.locator('[data-task-arret]').innerText().catch(() => '')).includes('arrêt sur budget')
        && await lignesPersistees.nth(0).locator('[data-task-arret]').count() === 0, await ligneArret.innerText().catch(() => ''));
    await page.locator('.task-run-eye').first().click();
    const deroule = page.locator('[data-modale-agent] [data-task-harness]');
    v.ok('fenêtre de l\'agent : bloc « Bilan » avec le badge et le reste à faire', await apparait(deroule) && (await deroule.innerText()).includes('budget épuisé') && (await deroule.innerText()).includes('Écrire les tests'));
    await page.keyboard.press('Escape');
    await disparait(page.locator('[data-modale-agent]'));

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
    const libelles = ['terminé', 'partiel', 'bloqué', 'statut inconnu', 'budget épuisé', 'délai dépassé', 'indisponible', 'erreur', 'annulé'];
    v.ok('run réel : deux lignes, chacune sous le titre de son appel', await apparait(statutReel, 20000) && await lignesReel.count() === 2
        && (await ligneWeb.locator('.task-run-title').innerText()).trim() === 'web — chercher la doc'
        && (await ligneExplore.locator('.task-run-title').innerText()).trim() === 'explore — trouver parse_date', await page.locator('.task-runs').last().innerText().catch(() => ''));
    // Le budget d'appels n'est plus dans le bloc du harnais (tool_budget retiré) : la ligne compte les appels seuls.
    v.ok('run réel : explore, badge de statut du core et appels, sur SA ligne', libelles.includes(await statutReel.innerText())
        && /^\d+ appels$/.test(await ligneExplore.locator('[data-task-calls]').innerText()), await ligneExplore.innerText().catch(() => ''));
    // L'origine de la lecture seule n'est plus dans le bloc (read_only_source retiré) : la ligne dit « lecture seule » sans sa source.
    v.ok('run réel : explore en lecture seule', await ligneExplore.locator('[data-task-ro]').isVisible().catch(() => false)
        && (await ligneExplore.locator('[data-task-ro]').getAttribute('title').catch(() => '')) === 'Lecture seule');
    v.ok('refus avant lancement : la ligne web se ferme « indisponible » (ni « En attente » ni bouton d\'arrêt)', (await ligneWeb.locator('[data-task-status]').innerText().catch(() => '')) === 'indisponible'
        && !(await ligneWeb.innerText()).includes('En attente') && await ligneWeb.locator('.task-run-cancel').count() === 0, await ligneWeb.innerText().catch(() => ''));
    // La cause du refus n'est plus dans les détails de la ligne (champ `reason` retiré du bloc du harnais et de DetailsSousAgent.vue) : seul le modèle la reçoit.
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
