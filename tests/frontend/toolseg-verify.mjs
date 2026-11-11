// SPDX-License-Identifier: MIT
// Vérif affichage ENTRELACÉ texte/outils (UX 2026-07-20), route-mock :
//   PERF_PORT=8915 node tests/frontend/toolseg-server.mjs &
//   PERF_PORT=8915 node tests/frontend/toolseg-verify.mjs
// S1 (live)     : thinking EN TÊTE → conteneur « Travail de l'assistant »
//                 (accordéon externe UX 2026-07-24, replié par défaut,
//                 summary agrégé) contenant groupe A « 2 outils » (round
//                 muet, avant tout texte) → narration → groupe B « 1 outil »
//                 ; réponse finale HORS conteneur. Compteurs par segment,
//                 toggles indépendants, carte détail dans le bon groupe.
// S2 (rechargé) : reconstruction depuis tool_history CUMULATIVE — un round
//                 par message, narration affichée, AUCUNE duplication du
//                 tour 1 sur le message 2 ; dropdown/détail opérants sur
//                 messages gelés (Object.freeze).
// S3 (rechargé) : message au format DELTA (tool_history_delta, 2026-07-27) —
//                 le marqueur court-circuite les heuristiques de frontière
//                 (id 'a1' volontairement en collision avec le tour 1) : son
//                 round est affiché intégralement, sans sur-coupe.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/toolseg-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

// Ordre DOM au sein du message assistant : renvoie la liste ordonnée des
// jalons trouvés (thinking, dropdowns, narration, final).
const domOrder = () => page.evaluate(() => {
    const nodes = [];
    const think = document.querySelector('details[data-think]');
    if (think) nodes.push(['think', think]);
    document.querySelectorAll('details[class*="toolwrap"]').forEach((d, i) => nodes.push(['drop' + i, d]));
    document.querySelectorAll('.markdown-body').forEach((el) => {
        const t = el.textContent || '';
        if (t.includes('corriger le bug')) nodes.push(['narration', el]);
        else if (t.includes('Voilà, le correctif est appliqué')) nodes.push(['final', el]);
    });
    // Tri par position documentaire
    nodes.sort((a, b) => (a[1].compareDocumentPosition(b[1]) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    return nodes.map((n) => n[0]);
});

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    // ════ S1 — LIVE ══════════════════════════════════════════════════════
    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Corrige le bug de app.py.');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // Narration inter-rounds visible pendant/après le stream (dans le flux).
    await page.waitForFunction(() => /corriger le bug/.test((document.getElementById('app') || {}).textContent || ''));
    ok('S1 narration inter-rounds affichée', true);

    // Résumé VIVANT : le summary replié du conteneur affiche le début de la
    // dernière narration dès qu'elle rejoint son round (mise à jour en cours
    // de stream, sans avoir à ouvrir quoi que ce soit).
    await page.waitForFunction(() => {
        const s = document.querySelector('details[data-pipeline] > summary');
        return !!s && /corriger le bug/.test(s.textContent || '');
    });
    ok('S1 summary = résumé vivant (début de la narration) pendant le stream', true);

    // Fin du tour.
    await page.waitForFunction(() => /Voilà, le correctif est appliqué/.test((document.getElementById('app') || {}).textContent || ''));
    ok('S1 réponse finale affichée', true);

    // Conteneur « Travail de l'assistant » : UN par message, replié par
    // défaut, summary agrégé ; narration + groupes DEDANS, final DEHORS.
    const pipe = page.locator('details[data-pipeline]');
    ok('S1 UN conteneur « Travail de l\'assistant »', await pipe.count() === 1);
    const pipeSum = (await pipe.locator('> summary').textContent()) || '';
    ok('S1 summary du conteneur : résumé (dernière narration) + 3 outils agrégés',
       pipeSum.includes('corriger le bug') && /3\s*outils/.test(pipeSum));
    ok('S1 conteneur replié par défaut', !(await pipe.evaluate((el) => el.open)));
    ok('S1 narration + groupes DANS le conteneur, final DEHORS',
       await page.evaluate(() => {
           const inPipe = (el) => !!el && !!el.closest('details[data-pipeline]');
           const drops = [...document.querySelectorAll('details[class*="toolwrap"]')];
           let narr = null, fin = null;
           document.querySelectorAll('.markdown-body').forEach((el) => {
               const t = el.textContent || '';
               if (t.includes('corriger le bug')) narr = el;
               else if (t.includes('Voilà, le correctif est appliqué')) fin = el;
           });
           return drops.length === 2 && drops.every(inPipe)
               && inPipe(narr) && !!fin && !inPipe(fin);
       }));
    ok('S1 narration en style « journal de travail » (worklog)',
       await page.evaluate(() => {
           const narr = [...document.querySelectorAll('.markdown-body')]
               .find((el) => (el.textContent || '').includes('corriger le bug'));
           return !!narr && narr.classList.contains('markdown-body--worklog');
       }));

    // Ouvrir le conteneur pour interagir avec les groupes internes (les
    // summaries d'un <details> fermé sont invisibles pour Playwright).
    await pipe.locator('> summary').click();
    await page.waitForTimeout(200);
    ok('S1 conteneur ouvert au clic', await pipe.evaluate((el) => el.open));

    const drops = page.locator('details.group\\/toolwrap');
    ok('S1 DEUX groupes d\'outils (compteur par segment)', await drops.count() === 2);

    const sum0 = (await drops.nth(0).locator('> summary').textContent()) || '';
    const sum1 = (await drops.nth(1).locator('> summary').textContent()) || '';
    ok('S1 groupe A = « 2 outils » (round muet avant tout texte)', /2\s*outils/.test(sum0));
    ok('S1 groupe B = « 1 outil »', /1\s*outil\b/.test(sum1));
    ok('S1 pills du groupe A : read_file + execute_shell',
       sum0.includes('read_file') && sum0.includes('execute_shell'));
    ok('S1 pills du groupe B : write_file uniquement',
       sum1.includes('write_file') && !sum1.includes('read_file'));

    // Ordre du flux : groupe A → narration → groupe B → final. (Le thinking
    // de message a été TRANSFÉRÉ au 1er step du round — comportement
    // historique conservé : plus de bloc data-think au niveau message ici.)
    const order = await domOrder();
    ok('S1 ordre DOM = groupe A, narration, groupe B, final',
       JSON.stringify(order) === JSON.stringify(['drop0', 'narration', 'drop1', 'final']));
    ok('S1 thinking retenu SUR le step du round (dans le groupe A)',
       ((await drops.nth(0).textContent()) || '').includes("Je réfléchis au plan avant d'agir."));

    // Toggles indépendants : ouvrir B ne touche pas A.
    await drops.nth(1).locator('> summary').click();
    await page.waitForTimeout(200);
    ok('S1 groupe B ouvert au clic', await drops.nth(1).evaluate((el) => el.open));
    ok('S1 groupe A resté fermé (états par segment)', !(await drops.nth(0).evaluate((el) => el.open)));

    // Carte détail dans le BON groupe : pill write_file → args + résultat.
    await drops.nth(1).locator('button').filter({ hasText: 'write_file' }).first().click();
    await page.waitForTimeout(250);
    const detail1 = (await drops.nth(1).textContent()) || '';
    ok('S1 carte détail du groupe B (Paramètres + appel #1)',
       detail1.includes('Paramètres') && detail1.includes('appel #1'));
    ok('S1 la carte détail ne fuit pas dans le groupe A',
       !((await drops.nth(0).textContent()) || '').includes('Paramètres'));
    ok('S1 conteneur resté ouvert (sticky) après les clics internes',
       await pipe.evaluate((el) => el.open));

    await page.screenshot({ path: `${SHOTS}/toolseg-live.png` }).catch(() => {});

    // ════ S2 — CHAT PERSISTÉ (reconstruction tool_history cumulative) ════
    await page.locator('#app').getByText('Demo segments persisté', { exact: false }).first().click();
    await page.waitForSelector('details.group\\/toolwrap', { state: 'attached' });
    await page.waitForTimeout(300);

    const drops2 = page.locator('details.group\\/toolwrap');
    ok('S2/S3 UN groupe par message (3 au total : ni duplication du cumul, ni sur-coupe du delta)',
       await drops2.count() === 3);

    const pipes2 = page.locator('details[data-pipeline]');
    ok('S2/S3 un conteneur « Travail de l\'assistant » par message tooled (3 au total)',
       await pipes2.count() === 3);
    ok('S2/S3 summaries = résumés des narrations reconstruites',
       ((await pipes2.nth(0).locator('> summary').textContent()) || '').includes('Narration tour 1')
       && ((await pipes2.nth(1).locator('> summary').textContent()) || '').includes('Narration tour 2')
       && ((await pipes2.nth(2).locator('> summary').textContent()) || '').includes('Narration tour 3'));

    const appTxt = await page.evaluate(() => (document.getElementById('app') || {}).textContent || '');
    ok('S2 narration tour 1 affichée dans le flux', appTxt.includes('Narration tour 1.'));
    ok('S2 narration tour 2 affichée dans le flux', appTxt.includes('Narration tour 2.'));
    ok('S3 narration tour 3 affichée dans le flux', appTxt.includes('Narration tour 3.'));
    // Une seule occurrence DANS LES CORPS de message (le résumé du summary
    // du conteneur en reprend légitimement le début — exclu du comptage).
    ok('S2 narration tour 1 affichée UNE seule fois (hors résumé du summary)',
       await page.evaluate(() => {
           const t = [...document.querySelectorAll('.markdown-body')]
               .map((el) => el.textContent || '').join('\n');
           return t.split('Narration tour 1.').length === 2;
       }));
    ok('S2/S3 réponses finales intactes',
       appTxt.includes('Réponse 1 finale.') && appTxt.includes('Réponse 2 finale.')
       && appTxt.includes('Réponse 3 finale.'));

    const s2sum0 = (await drops2.nth(0).locator('> summary').textContent()) || '';
    const s2sum1 = (await drops2.nth(1).locator('> summary').textContent()) || '';
    const s3sum2 = (await drops2.nth(2).locator('> summary').textContent()) || '';
    ok('S2/S3 compteurs reconstruits (« 1 outil » chacun)',
       /1\s*outil\b/.test(s2sum0) && /1\s*outil\b/.test(s2sum1) && /1\s*outil\b/.test(s3sum2));
    ok('S2 groupe du msg 1 = read_file seul',
       s2sum0.includes('read_file') && !s2sum0.includes('execute_shell'));
    ok('S2 groupe du msg 2 = execute_shell seul',
       s2sum1.includes('execute_shell') && !s2sum1.includes('read_file'));
    ok('S3 groupe du msg 3 (delta, id en collision) = read_file affiché',
       s3sum2.includes('read_file') && !s3sum2.includes('execute_shell'));

    // Thinking EN TÊTE : le dernier assistant garde son thinking au reload ;
    // le bloc doit exister (v-if assoupli — l'ancien le masquait dès que
    // toolSteps était non vide) et PRÉCÉDER narration et groupe du message.
    ok('S3 thinking affiché EN TÊTE du message rechargé (avant narration + groupe)',
       await page.evaluate(() => {
           const th = document.querySelector('details[data-think]');
           const narr = [...document.querySelectorAll('.markdown-body')]
               .find((el) => (el.textContent || '').includes('Narration tour 3.'));
           const dr = [...document.querySelectorAll('details[class*="toolwrap"]')][2];
           return !!th && !!narr && !!dr
               && !!(th.compareDocumentPosition(narr) & Node.DOCUMENT_POSITION_FOLLOWING)
               && !!(th.compareDocumentPosition(dr) & Node.DOCUMENT_POSITION_FOLLOWING);
       }));

    // Narration AVANT son groupe (texte → compteur en dessous).
    ok('S2 narration tour 2 placée AVANT son groupe d\'outils',
       await page.evaluate(() => {
           const narr = [...document.querySelectorAll('.markdown-body')]
               .find((el) => (el.textContent || '').includes('Narration tour 2.'));
           const dr = [...document.querySelectorAll('details[class*="toolwrap"]')][1];
           return !!narr && !!dr && !!(narr.compareDocumentPosition(dr) & Node.DOCUMENT_POSITION_FOLLOWING);
       }));

    // Dropdown + carte détail sur message GELÉ (Object.freeze au reload).
    // Ouvrir d'abord le conteneur externe du message 2 (summary interne
    // invisible tant que l'externe est replié).
    await pipes2.nth(1).locator('> summary').click();
    await page.waitForTimeout(200);
    ok('S2 conteneur externe opérant sur message rechargé (gelé)',
       await pipes2.nth(1).evaluate((el) => el.open));
    await drops2.nth(1).locator('> summary').click();
    await page.waitForTimeout(200);
    ok('S2 dropdown opérant sur message rechargé (gelé)', await drops2.nth(1).evaluate((el) => el.open));
    await drops2.nth(1).locator('button').filter({ hasText: 'execute_shell' }).first().click();
    await page.waitForTimeout(250);
    ok('S2 carte détail : résultat reconstruit (« 1 passed »)',
       ((await drops2.nth(1).textContent()) || '').includes('1 passed'));

    // S3 — carte détail du message DELTA : le résultat du round (apparié via
    // l'id 'a1' en collision) est bien celui du tour 3, pas celui du tour 1.
    await pipes2.nth(2).locator('> summary').click();
    await page.waitForTimeout(200);
    await drops2.nth(2).locator('> summary').click();
    await page.waitForTimeout(200);
    await drops2.nth(2).locator('button').filter({ hasText: 'read_file' }).first().click();
    await page.waitForTimeout(250);
    ok('S3 carte détail du message delta : résultat du tour 3 (« def helper »)',
       ((await drops2.nth(2).textContent()) || '').includes('def helper'));

    await page.screenshot({ path: `${SHOTS}/toolseg-persisted.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/toolseg-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\ntoolseg-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
