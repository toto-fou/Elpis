// SPDX-License-Identifier: MIT
// Vérif des lignes d'EFFETS du message (écritures mémoire), route-mock :
//   PERF_PORT=8952 node tests/frontend/effects-server.mjs &
//   PERF_PORT=8952 node tests/frontend/effects-verify.mjs
// Couvre : reconstruction au reload (succès VISIBLES au passé, « Mémoire
// pleine » ambre, AUCUNE ligne Tâches — chip de la barre de prompt), lignes
// HORS du conteneur replié, memory/todowrite absents des pastilles d'outils, dépliage (ajouté / retiré
// barré), Annuler (→ « annulé »), Gérer la mémoire (Réglages → Mémoire),
// origine des notes dans les Réglages (lien vers le chat), flux live (libellé
// en cours puis au passé, la ligne RESTE après la fin), mode sombre lisible.
import { launch, gotoApp } from '../perf/lib/harness.mjs';
import os from 'os';

const PORT = Number(process.env.PERF_PORT || 8952);
const SHOTS = process.env.SHOTS_DIR || os.tmpdir();
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const LINES = '[data-effects] > .elpis-effect';
const headText = (i) => page.locator(LINES).nth(i).locator('.elpis-effect-head').innerText().catch(() => '');

try {
    page.setDefaultTimeout(45000);
    await gotoApp(page, '/');
    page.setDefaultTimeout(8000);
    await page.locator('text=Demo effets').first().click();
    await page.waitForSelector('[data-effects]');

    // ── Reload : reconstruction depuis tool_history ──────────────────────
    const n = await page.locator(LINES).count();
    ok('3 lignes d\'effets reconstruites (mémoire seule, pas de ligne Tâches)', n === 3);
    ok('aucune ligne Tâches dans le fil', !(await page.locator('[data-effects]').allInnerTexts()).some(t => /Tâches/.test(t)));
    const t0 = await headText(0), t2 = await headText(1), t3 = await headText(2);
    ok('succès RÉUSSI visible au passé : « Mémorisé »', /Mémorisé/.test(t0) && /profil utilisateur/.test(t0)
        && /Je retiens que tu préfères des réponses concises/.test(t0));
    ok('mémoire pleine : libellé dédié', /Mémoire pleine/.test(t2));
    ok('mémoire pleine en AMBRE (pas l\'état d\'échec)', await page.locator(LINES).nth(1).evaluate(
        el => el.classList.contains('is-full') && !el.classList.contains('is-error')));
    ok('remplacement : « Mémoire mise à jour »', /Mémoire mise à jour/.test(t3));

    // Hors du conteneur replié, pastilles d'outils sans memory/todowrite.
    const outside = await page.locator('[data-effects]').first().evaluate(el => !el.closest('details[data-pipeline]'));
    ok('lignes visibles HORS du conteneur « Travail de l\'assistant »', outside);
    const pipeOpen = await page.locator('details[data-pipeline]').first().evaluate(el => el.open).catch(() => null);
    ok('conteneur toujours replié par défaut', pipeOpen === false);
    const summary = await page.locator('details[data-pipeline] > summary').first().innerText().catch(() => '');
    ok('le conteneur ne compte que read_file (« 1 outil »)', /1 outil\b/.test(summary));
    await page.locator('details[data-pipeline] > summary').first().click();
    const pills = await page.locator('details[data-pipeline] details summary').first().innerText().catch(() => '');
    ok('pastilles : ni memory ni todowrite', /read_file/.test(pills) && !/memory|todowrite/.test(pills));
    await page.locator('details[data-pipeline] > summary').first().click();

    // ── Dépliage + Annuler ───────────────────────────────────────────────
    await page.locator(LINES).nth(0).locator('.elpis-effect-head').click();
    await page.waitForSelector('[data-effect-added]');
    const added = await page.locator(LINES).nth(0).locator('[data-effect-added]').innerText();
    ok('dépli : texte ajouté lu dans le journal', added.trim() === 'Préfère des réponses concises');
    ok('dépli : bouton Annuler (annulable)', await page.locator(LINES).nth(0).locator('[data-effect-undo]').isVisible());
    ok('dépli : bouton Gérer la mémoire', await page.locator(LINES).nth(0).locator('[data-effect-manage]').isVisible());
    await page.screenshot({ path: SHOTS + '/effects_open.png' });
    await page.locator(LINES).nth(0).locator('[data-effect-undo]').click();
    await page.waitForSelector('[data-effect-undone]');
    ok('Annuler → étiquette « annulé »', /annulé/.test(await headText(0)));
    ok('Annuler → le bouton disparaît', (await page.locator(LINES).nth(0).locator('[data-effect-undo]').count()) === 0);
    const counters = await (await fetch(`http://127.0.0.1:${PORT}/__counters`)).json();
    ok('une seule requête d\'annulation', counters.undo === 1);

    // Remplacement : retiré barré + ajouté, pas annulable.
    await page.locator(LINES).nth(2).locator('.elpis-effect-head').click();
    await page.waitForSelector(`${LINES}:nth-child(3) [data-effect-removed]`);
    const removed = page.locator(LINES).nth(2).locator('[data-effect-removed]');
    ok('remplacement : ancien texte barré', (await removed.innerText()).includes('8080')
        && await removed.evaluate(el => getComputedStyle(el).textDecorationLine.includes('line-through')));
    ok('remplacement : nouveau texte', (await page.locator(LINES).nth(2).locator('[data-effect-added]').innerText()).includes('8443'));
    ok('remplacement non annulable : pas de bouton Annuler',
        (await page.locator(LINES).nth(2).locator('[data-effect-undo]').count()) === 0);

    // Mémoire pleine : message de budget.
    await page.locator(LINES).nth(1).locator('.elpis-effect-head').click();
    ok('mémoire pleine dépliée : message de budget',
        /Budget plein/.test(await page.locator(LINES).nth(1).locator('[data-effect-body]').innerText()));

    // ── Gérer la mémoire → Réglages, origine des notes ───────────────────
    await page.locator(LINES).nth(0).locator('[data-effect-manage]').click();
    await page.waitForSelector('[data-mem-count-user]');
    ok('Gérer la mémoire ouvre Réglages → Mémoire', true);
    await page.waitForSelector('[data-mem-origin]');
    const origins = await page.locator('[data-mem-origin]').allInnerTexts();
    ok('origine : date + chat d\'origine', origins.length === 2 && /« Demo effets »/.test(origins[0]) && /\d{2}\/\d{2}/.test(origins[0]));
    ok('origine : note écrite depuis les Réglages', /Réglages/.test(origins[1] || ''));
    await page.screenshot({ path: SHOTS + '/effects_settings.png' });
    await page.locator('[data-mem-origin] .mem-origin-link').first().click();
    await page.waitForFunction(() => !document.querySelector('[data-mem-count-user]'));
    ok('clic sur le chat d\'origine : Réglages fermés', true);

    // ── Flux live ────────────────────────────────────────────────────────
    const nBlocks = await page.locator('[data-effects]').count();
    const ta = page.locator('textarea[placeholder]').last();
    await ta.fill('Note ça');
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-effects]').length > n, nBlocks);
    const live = page.locator('[data-effects]').last().locator('.elpis-effect').first();
    const runLabel = await live.locator('.elpis-effect-label').innerText();
    ok('live : libellé EN COURS « Écriture en mémoire »', /Écriture en mémoire/.test(runLabel));
    ok('live : libellé animé pendant l\'écriture',
        await live.locator('.elpis-effect-label').evaluate(el => el.classList.contains('mem-wave')));
    await page.waitForFunction(() => !document.querySelector('button[title="Arrêter la génération"]'), null, { timeout: 20000 });
    await page.waitForTimeout(300);
    const lastLines = page.locator('[data-effects]').last().locator('.elpis-effect');
    ok('live : la ligne RESTE après la fin, au passé',
        /Mémorisé/.test(await lastLines.nth(0).innerText()) && /Je retiens le drapeau de build/.test(await lastLines.nth(0).innerText()));
    ok('live : une seule ligne (mémoire), pas de ligne Tâches', (await lastLines.count()) === 1);
    ok('live : la liste est dans le chip de la barre de prompt',
        await page.locator('[data-todo-flyout]').first().isVisible());
    ok('live : aucune pastille de statut « todowrite » restante',
        !(await page.locator('[role="status"]').allInnerTexts()).some(t => /todowrite/.test(t)));

    // ── Mode sombre : contraste lisible ──────────────────────────────────
    await page.evaluate(() => document.body.classList.add('elpis-app-dark', 'elpis-dark-surface'));
    const colors = await page.locator(LINES).nth(0).locator('.elpis-effect-label').evaluate(el => getComputedStyle(el).color);
    ok('mode sombre : libellé clair (jeton --text-600)', /rgb\((1[5-9]\d|2\d\d)/.test(colors));
    await page.screenshot({ path: SHOTS + '/effects_dark.png' });

    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log(errors.slice(0, 5));
} catch (e) {
    ok('exception : ' + (e && e.message ? e.message.split('\n')[0] : e), false);
} finally {
    await browser.close();
}
const nPass = checks.filter(c => c[0] === 'PASS').length;
console.log(`\n${nPass}/${checks.length} ${nPass === checks.length ? 'PASS' : 'FAIL'}`);
process.exit(nPass === checks.length ? 0 : 1);
