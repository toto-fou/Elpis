// SPDX-License-Identifier: MIT
// Vérif sous-agents (outil `task`) + refonte thinking, route-mock, sans backend :
//   PERF_PORT=8912 node tests/frontend/task-server.mjs &
//   PERF_PORT=8912 node tests/frontend/task-verify.mjs
// S1 (live)     : ligne agent PERSISTANTE sous le thinking (icône d'état spinner
//                 → check, tokens live), AUCUNE liste d'outils enfant, AUCUNE
//                 pill « task » animée en doublon, pas de panneau outils.
// S2 (rechargé) : ligne réhydratée depuis task_runs, ordre thinking → agent,
//                 thinking plié par défaut mais dépliable.
// S3 (verrou)   : hide_thinking=1 → bloc visible (header + cadenas) verrouillé ;
//                 la ligne agent survit au reload in-tab (session-restore).
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/task-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const txt = (sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);

try {
    page.setDefaultTimeout(10000);
    await fetch(BASE_URL + '/__cfg?hide_thinking=0');
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    // ════ S1 — LIVE ══════════════════════════════════════════════════════
    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Trouve où parse_date est défini.');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // Ligne agent visible PENDANT le run, sans rien déplier.
    const card = page.locator('.task-runs .task-run').first();
    await card.waitFor({ state: 'visible' });
    ok('S1 ligne agent visible en direct', true);
    ok('S1 branche └─ présente', (await txt('.task-branch')).includes('└'));
    ok('S1 icône d\'état = spinner pendant le run',
       await page.locator('.task-run-ico.animate-spin').count() === 1);
    // La ligne agent EST le statut : aucune pill animée « task » en doublon.
    ok('S1 aucune pill de statut animée pendant le run',
       await page.locator('.animate-ping').count() === 0);

    // Bouton ✕ (annulation par-enfant) : opérant dès l'event `spawned` (id
    // assigné avant le 1er appel LLM). Le flux mock étant pré-scripté, on
    // vérifie que le POST part avec le bon child_id.
    const cancelBtn = page.locator('.task-run-cancel').first();
    await cancelBtn.waitFor({ state: 'visible' });
    ok('S1 bouton ✕ visible pendant le run (dès spawned)', true);
    await cancelBtn.click();
    // Polling côté NODE (waitForFunction(async …) résout sur la promesse
    // elle-même — truthy immédiate, l'attente ne prouvait rien).
    let cancels = [];
    for (let i = 0; i < 40 && cancels.length === 0; i++) {
        await page.waitForTimeout(150);
        cancels = (await (await fetch(BASE_URL + '/__cancels')).json()).items;
    }
    ok('S1 POST task-cancel émis avec le child_id', cancels.length === 1 && cancels[0].child_id === 't1-ab12');

    // ── Modale « œil » EN DIRECT : ouverte pendant le run, le déroulé se
    // remplit au fil des events (steps + narration `text`). Placée APRÈS
    // les contrôles time-critical (spinner/✕) — le mock à 200 ms/event
    // laisse le run actif jusqu'à ~3 s. ──────────────────────────────────
    const eye = page.locator('.task-run-eye').first();
    await eye.waitFor({ state: 'visible' });
    ok('S1 bouton œil visible pendant le run', true);
    await eye.click();
    await page.waitForSelector('[aria-label="Déroulé de l\'agent"]', { state: 'visible' });
    ok('S1 modale déroulé ouverte au clic', true);
    ok('S1 titre modale = agent + libellé long (5-6 mots)',
       ((await txt('[aria-label="Déroulé de l\'agent"] h3')) || '').includes('trouver la définition de parse_date'));
    await page.waitForFunction(() => /list_files/.test((document.querySelector('[aria-label="Déroulé de l\'agent"]') || {}).textContent || ''));
    ok('S1 étape outil affichée en direct dans la modale', true);
    await page.waitForFunction(() => /je lis dates\.py/.test((document.querySelector('[aria-label="Déroulé de l\'agent"]') || {}).textContent || ''));
    ok('S1 narration de l\'agent affichée en direct dans la modale', true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[aria-label="Déroulé de l\'agent"]', { state: 'detached' });
    ok('S1 Échap ferme la modale', true);

    // Thinking : bloc présent et PLIÉ pendant le stream.
    await page.waitForSelector('details[data-think]', { state: 'attached' });
    ok('S1 thinking plié par défaut pendant le stream',
       !(await page.locator('details[data-think]').first().evaluate(el => el.open)));

    // Compteur de tokens live → 1.2k.
    await page.waitForFunction(() => /1\.2k/.test((document.querySelector('.task-run-tokens') || {}).textContent || ''));
    ok('S1 compteur de tokens live (→ 1.2k)', true);

    // Fin du tour.
    await page.waitForFunction(() => /parse_date est défini/.test(document.querySelector('#app').textContent || ''));
    ok('S1 réponse finale affichée', true);

    // La ligne RESTE visible, l'icône passe en check, bilan « 2 appels ».
    ok('S1 ligne agent toujours visible après le run', await card.isVisible());
    await page.waitForFunction(() => !!document.querySelector('.task-run-ico.is-done'));
    ok('S1 icône d\'état = check une fois terminé', true);
    ok('S1 bilan « 2 appels »', /2\s*appels/.test(await txt('.task-run-meta')));
    ok('S1 libellé long affiché sur la ligne agent',
       (await txt('.task-run-title')).includes('trouver la définition de parse_date'));

    // Modale APRÈS le run : transcript final autoritatif, rendu avec les
    // idiomes du chat (accordéon Instructions, lignes pill → carte détail
    // Paramètres/Résultat), fermeture par le bouton ✕.
    const MODAL = '[aria-label="Déroulé de l\'agent"]';
    await eye.click();
    await page.waitForSelector(MODAL, { state: 'visible' });
    const finalModalTxt = (await txt(MODAL)) || '';
    ok('S1 modale finale : narration finale de l\'agent visible',
       finalModalTxt.includes('parse_date est défini à src/dates.py:12'));
    ok('S1 modale finale : bilan (terminé · 2 appels)',
       /terminé/.test(finalModalTxt) && /2\s*appels/.test(finalModalTxt));
    // Le résultat N'EST PAS affiché en vrac : il vit dans la carte détail.
    ok('S1 aperçu de résultat masqué tant que la carte est fermée',
       await page.locator(MODAL).getByText('def parse_date(s)').count() === 0);
    // Instructions (brief donné à l'agent) : affichées D'EMBLÉE en tête,
    // rendues comme une réponse (markdown), sans accordéon.
    ok('S1 instructions affichées d\'emblée en tête de modale',
       await page.locator(MODAL + ' [data-task-brief] .markdown-body').isVisible()
       && finalModalTxt.includes('Find where parse_date is defined and used.'));
    // Gabarit fixe : largeur 4xl + hauteur 85vh quel que soit le contenu.
    ok('S1 modale à taille fixe (max-w-4xl × h-85vh)',
       await page.evaluate(() => {
           const el = document.querySelector('[aria-label="Déroulé de l\'agent"] > div');
           return !!el && el.className.includes('max-w-4xl') && el.className.includes('h-[85vh]');
       }));
    // Carte détail d'une étape : Paramètres + Résultat (idiome carte outil).
    await page.locator(MODAL + ' button').filter({ hasText: 'read_file' }).first().click();
    await page.waitForTimeout(150);
    const cardTxt = (await txt(MODAL)) || '';
    ok('S1 carte détail étape : Paramètres + Résultat (aperçu)',
       cardTxt.includes('Paramètres') && cardTxt.includes('Résultat')
       && cardTxt.includes('def parse_date(s)') && cardTxt.includes('appel #2'));
    await page.locator(MODAL + ' button[title="Fermer"]').click();
    await page.waitForSelector(MODAL, { state: 'detached' });
    ok('S1 bouton Fermer opérant', true);
    // PAS de liste des outils de l'enfant, pas de panneau outils.
    ok('S1 aucune liste d\'outils enfant', await page.locator('.task-substep').count() === 0);
    ok('S1 pas de panneau outils pour un tour task-only',
       await page.locator('details.group\\/toolwrap').count() === 0);

    await page.screenshot({ path: `${SHOTS}/task-live.png` }).catch(() => {});

    // ════ S2 — CHAT PERSISTÉ (réhydratation task_runs) ═══════════════════
    await page.locator('#app').getByText('Demo task persisté', { exact: false }).first().click();
    await page.waitForSelector('.task-runs .task-run', { state: 'visible' });
    // La BASCULE de conversation doit être finie : sinon la ligne encore
    // affichée est celle du chat précédent, et S2 mesure S1.
    await page.waitForFunction(
        () => /explore/.test((document.querySelector('.task-run-title') || {}).textContent || ''),
        { timeout: 8000 },
    );
    ok('S2 ligne agent réhydratée au chargement du chat', true);
    ok('S2 libellé long « explore — audit des imports morts du projet »',
       (await txt('.task-run-title')).includes('explore') && (await txt('.task-run-title')).includes('audit des imports morts du projet'));
    ok('S2 tokens = occupation réelle persistée (context_tokens 1000 → 1k)', /1k/.test(await txt('.task-run-tokens')));
    ok('S2 bilan « 3 appels »', /3\s*appels/.test(await txt('.task-run-meta')));
    ok('S2 aucune liste d\'outils enfant', await page.locator('.task-substep').count() === 0);

    // Modale « œil » sur run PERSISTÉ (transcript + prompt réhydratés via
    // task_runs), rendue avec les idiomes du chat.
    const MODAL2 = '[aria-label="Déroulé de l\'agent"]';
    await page.locator('.task-run-eye').first().click();
    await page.waitForSelector(MODAL2, { state: 'visible' });
    const s2ModalTxt = (await txt(MODAL2)) || '';
    ok('S2 modale : narration réhydratée',
       s2ModalTxt.includes('Je commence par lister les fichiers du projet.'));
    ok('S2 modale : icône erreur sur l\'étape en échec (idiome chat)',
       await page.locator(MODAL2 + ' .ph-x-circle').count() === 1);
    ok('S2 instructions persistées affichées d\'emblée',
       await page.locator(MODAL2 + ' [data-task-brief] .markdown-body').isVisible()
       && s2ModalTxt.includes('propose un correctif par fichier'));
    await page.locator(MODAL2 + ' button').filter({ hasText: 'code' }).first().click();
    await page.waitForTimeout(150);
    ok('S2 carte détail : résultat d\'erreur (index_unavailable)',
       ((await txt(MODAL2)) || '').includes('index_unavailable'));
    await page.keyboard.press('Escape');
    await page.waitForSelector(MODAL2, { state: 'detached' });
    ok('S2 Échap ferme la modale (run persisté)', true);

    // Ordre visuel : le bloc thinking VIENT AVANT la ligne agent.
    ok('S2 ligne agent EN DESSOUS du bloc thinking',
       await page.evaluate(() => {
           const th = document.querySelector('details[data-think]');
           const tr = document.querySelector('.task-runs');
           return !!th && !!tr && !!(th.compareDocumentPosition(tr) & Node.DOCUMENT_POSITION_FOLLOWING);
       }));

    // Thinking réhydraté : plié par défaut, mais DÉPLIABLE (hide_thinking off).
    const think2 = page.locator('details[data-think]').first();
    await think2.waitFor({ state: 'attached' });
    ok('S2 thinking plié par défaut au chargement', !(await think2.evaluate(el => el.open)));
    await think2.locator('summary').click();
    ok('S2 thinking dépliable au clic', await think2.evaluate(el => el.open));
    ok('S2 contenu du thinking visible une fois déplié',
       (await think2.locator('pre').textContent()).includes('agent explore'));

    await page.screenshot({ path: `${SHOTS}/task-persisted.png` }).catch(() => {});

    // ════ S3 — VERROU hide_thinking (+ re-visite in-tab) ═════════════════
    await fetch(BASE_URL + '/__cfg?hide_thinking=1');
    await gotoApp(page, '/');
    await page.locator('#app').getByText('Demo task persisté', { exact: false }).first().click();
    // Régression pin : la re-visite in-tab passe par le session-restore
    // (elpis_chat_session, beforeunload) qui court-circuite loadChat — la
    // ligne agent doit SURVIVRE (taskRuns dans la whitelist du snapshot).
    await page.waitForSelector('.task-runs .task-run', { state: 'visible' });
    ok('S3 ligne agent survit au reload in-tab (session-restore)', true);
    const think3 = page.locator('details[data-think]').first();
    await think3.waitFor({ state: 'attached' });
    ok('S3 bloc thinking toujours AFFICHÉ sous hide_thinking', await think3.locator('summary').isVisible());
    ok('S3 cadenas à la place du caret', await think3.locator('summary i.ph-lock-simple').count() === 1);
    await think3.locator('summary').click();
    await page.waitForTimeout(200);
    ok('S3 dépliement désactivé (clic sans effet)', !(await think3.evaluate(el => el.open)));
    ok('S3 contenu absent du DOM sous verrou', await think3.locator('pre').count() === 0);

    await page.screenshot({ path: `${SHOTS}/task-locked.png` }).catch(() => {});

    // ════ S4 — FILE : annulation DIFFÉRÉE d'un enfant pas encore spawné ══
    // Batch de 2 task sérialisés : les deux lignes apparaissent (tool_call
    // upfront), la 2e SANS id. Le ✕ doit être opérant quand même : clic →
    // « annulation… » locale, POST différé émis au spawn avec le bon id.
    // ⚠ Le tour peut se rejouer DANS le chat c1 (le beforeunload re-sauve la
    // session APRÈS un sessionStorage.clear) → sa ligne « audit imports »
    // précède les nôtres. Tous les sélecteurs sont donc SCOPÉS au DERNIER
    // bloc .task-runs (le message streamé), jamais au DOM global.
    await fetch(BASE_URL + '/__cfg?hide_thinking=0&scenario=queue');
    await gotoApp(page, '/');
    const _lastRunsBox = () => {
        const boxes = document.querySelectorAll('.task-runs');
        return boxes[boxes.length - 1] || null;
    };
    const ta4 = page.locator('#app textarea').first();
    await ta4.waitFor({ state: 'visible' });
    await ta4.fill('Deux missions.');
    await page.locator('button[title="Envoyer le message"]').first().click();
    await page.waitForFunction(`(${_lastRunsBox})() && (${_lastRunsBox})().querySelectorAll('.task-run').length === 2`);
    ok('S4 deux lignes agents (batch sérialisé)', true);
    const run4b = page.locator('.task-runs').last().locator('.task-run').nth(1);
    const btn4b = run4b.locator('.task-run-cancel');
    ok('S4 ✕ présent sur le run EN FILE (sans id)', await btn4b.isVisible());
    await btn4b.click();
    ok('S4 « annulation… » affichée après le clic',
       ((await run4b.textContent()) || '').includes('annulation'));
    // Assertion NON racée : on attend l'issue (polling CÔTÉ NODE — un
    // waitForFunction(async …) résout sur la promesse elle-même, truthy
    // immédiate) et on vérifie qu'UN SEUL POST est parti, au spawn, avec
    // l'id de l'enfant B (jamais d'id null, jamais celui de l'enfant A).
    let c41 = [];
    for (let i = 0; i < 40 && c41.length === 0; i++) {
        await page.waitForTimeout(150);
        c41 = (await (await fetch(BASE_URL + '/__cancels')).json()).items;
    }
    ok('S4 annulation différée : un seul POST, au spawn, id de l\'enfant B',
       c41.length === 1 && c41[0].child_id === 't2-cd34');
    // Fin du tour : A en check, B terminé `cancelled` (icône warning).
    await page.waitForFunction(`(() => {
        const b = (${_lastRunsBox})();
        return b && b.querySelectorAll('.task-run-ico.is-done').length === 1
            && b.querySelectorAll('.task-run-ico.is-error').length === 1;
    })()`);
    ok('S4 états finaux : A completed, B cancelled', true);

    await page.screenshot({ path: `${SHOTS}/task-queue-cancel.png` }).catch(() => {});

    // ════ S5 — STOP GLOBAL : les lignes agents ne restent pas en spinner ═
    // Le Stop du parent tue aussi les enfants : le front fige localement
    // toute ligne `running` en `cancelled` (le bilan backend se perd dans
    // l'abort du fetch).
    await fetch(BASE_URL + '/__cfg?hide_thinking=0&scenario=queue');
    await gotoApp(page, '/');
    const ta5 = page.locator('#app textarea').first();
    await ta5.waitFor({ state: 'visible' });
    await ta5.fill('Deux missions, stop en vol.');
    await page.locator('button[title="Envoyer le message"]').first().click();
    await page.waitForFunction(`(${_lastRunsBox})() && (${_lastRunsBox})().querySelectorAll('.task-run').length === 2`);
    await page.locator('button[title="Arrêter la génération"]').first().click();
    await page.waitForFunction(`(() => {
        const b = (${_lastRunsBox})();
        return b && b.querySelectorAll('.task-run-ico.animate-spin').length === 0
            && b.querySelectorAll('.task-run-ico.is-error').length === 2;
    })()`);
    ok('S5 Stop global : plus aucun spinner agent, lignes en cancelled', true);
    ok('S5 état « cancelled » affiché',
       ((await page.locator('.task-runs').last().textContent()) || '').includes('cancelled'));

    await page.screenshot({ path: `${SHOTS}/task-stop-global.png` }).catch(() => {});
} catch (e) {
    ok('exception inattendue : ' + (e && e.message), false);
} finally {
    ok('aucune erreur page JS', errors.length === 0);
    if (errors.length) console.log('   pageerror:', errors.slice(0, 3));
    await browser.close();
    const failed = checks.filter(c => c[0] === 'FAIL');
    console.log(`\n${checks.length - failed.length}/${checks.length} OK`);
    process.exit(failed.length ? 1 : 0);
}
