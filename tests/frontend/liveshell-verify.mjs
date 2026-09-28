// SPDX-License-Identifier: MIT
// Vérif TERMINAL EN DIRECT (live shell), route-mock :
//   PERF_PORT=8916 node tests/frontend/liveshell-server.mjs &
//   PERF_PORT=8916 node tests/frontend/liveshell-verify.mjs
// S1 (live)     : DEUX execute_shell parallèles → la console REMPLACE la
//                 carte détail du step shell : accordéon replié = info
//                 outils seule ; déplié = pills ; clic sur une pill shell =
//                 console (commandes à la suite, attribution par call_id,
//                 ANSI, \r, ↳ code ≠ 0, chip « 1 échec »). Fermeture via ✕.
// SCROLL        : le fil reste scrollable pendant/après le stream — molette
//                 au-dessus du chat ET au-dessus du terminal ouvert (pas de
//                 piège de scroll), fin de réponse atteignable.
// S2 (rechargé) : round persisté à 2 commandes → console unique reconstruite
//                 au clic de pill (sortie + couleur + ↳ code 2).
// S3 (OFF)      : réglage live_shell_enabled=false → clic de pill = carte
//                 classique (Paramètres/Résultat), AUCUNE console.
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/liveshell-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const SC = 'div.scroll-smooth.overflow-y-auto';   // conteneur de scroll du chat
const distFromBottom = () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1;
}, SC);
// Molette jusqu'en bas au-dessus d'un élément donné ; renvoie la distance finale.
async function wheelToBottomOver(locator) {
    const box = await locator.boundingBox();
    if (!box) return -1;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(40);
        if ((await distFromBottom()) < 60) break;
    }
    return distFromBottom();
}

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    // ════ S1 — LIVE (2 shells parallèles) ════════════════════════════════
    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Lance tests et lint.');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // Accordéon replié : aucune console dans le DOM, info outils seule.
    await page.waitForSelector('details.group\\/toolwrap', { state: 'attached' });
    ok('S1 repliée : aucune console (info outils seule)',
       await page.locator('.shell-live').count() === 0);

    // Déplier le conteneur « Travail de l'assistant » (accordéon externe,
    // UX 2026-07-24) puis l'accordéon du segment : les pills apparaissent,
    // toujours pas de console. Pas d'attente fixe entre les deux clics —
    // l'auto-wait de Playwright suffit et la fenêtre « en cours » est courte.
    await page.locator('details[data-pipeline] > summary').first().click();
    await page.locator('details.group\\/toolwrap > summary').first().click();
    await page.waitForSelector('details.group\\/toolwrap button.group\\/toolbtn', { state: 'visible' });
    ok('S1 dépliée sans clic de pill : pills visibles, pas de console',
       await page.locator('.shell-live').count() === 0);

    // Clic sur la 1re pill shell → la console REMPLACE la carte détail.
    await page.locator('details.group\\/toolwrap button.group\\/toolbtn').first().click();
    await page.waitForSelector('.shell-live', { state: 'visible' });
    const midStatus = (await page.locator('.shell-live-header').textContent()) || '';
    ok('S1 clic pill pendant l\'exec : console visible (« en cours… »)', /en cours/.test(midStatus));
    ok('S1 la console remplace la carte (pas de bloc Paramètres/Résultat)',
       !/Paramètres/.test((await page.locator('details.group\\/toolwrap').first().textContent()) || ''));

    // Attribution par call_id : le chunk précoce de sh2 sous SON invite.
    await page.waitForFunction(() => {
        const el = document.querySelector('.shell-live-body');
        return el && /lint: bad\.py/.test(el.textContent || '');
    });
    const midBody = (await page.locator('.shell-live-body').textContent()) || '';
    ok('S1 attribution par call_id : chunk précoce de sh2 placé APRÈS `$ python lint.py`',
       midBody.indexOf('$ python lint.py') !== -1
       && midBody.indexOf('lint: bad.py') > midBody.indexOf('$ python lint.py'));

    // SCROLL pendant le stream : molette vers le haut puis retour en bas.
    const chatArea = page.locator(SC).first();
    const boxMid = await chatArea.boundingBox();
    await page.mouse.move(boxMid.x + boxMid.width / 2, boxMid.y + boxMid.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(120);
    const distStream = await wheelToBottomOver(chatArea);
    ok('SCROLL pendant le stream : molette opérante, fin atteignable',
       distStream >= 0 && distStream < 60);

    // Fin du tour.
    await page.waitForFunction(() => /lint à corriger/.test((document.getElementById('app') || {}).textContent || ''));
    ok('S1 réponse finale affichée', true);

    ok('S1 UNE SEULE console pour les 2 commandes', await page.locator('.shell-live').count() === 1);
    ok('S1 console DANS l\'accordéon outils (details)',
       await page.evaluate(() => {
           const el = document.querySelector('.shell-live');
           return !!el && !!el.closest('details');
       }));
    const hdr = (await page.locator('.shell-live-header').textContent()) || '';
    ok('S1 titre « 2 commandes »', /2 commandes/.test(hdr));
    ok('S1 chip « 1 échec » (lint rc=2)', /1 échec/.test(hdr));
    ok('S1 point d\'état rouge (is-err)', await page.locator('.shell-live-dot.is-err').count() === 1);

    const bodyTxt = (await page.locator('.shell-live-body').textContent()) || '';
    ok('S1 commandes À LA SUITE dans l\'ordre des appels (pytest avant lint)',
       bodyTxt.indexOf('$ pytest -q') !== -1
       && bodyTxt.indexOf('$ pytest -q') < bodyTxt.indexOf('$ python lint.py'));
    ok('S1 sortie de pytest sous SON invite (avant `$ python lint.py`)',
       bodyTxt.indexOf('collecting tests') > bodyTxt.indexOf('$ pytest -q')
       && bodyTxt.indexOf('collecting tests') < bodyTxt.indexOf('$ python lint.py'));
    ok('S1 \\r résolu : progress 99% affiché, 10% écrasé',
       bodyTxt.includes('progress 99%') && !bodyTxt.includes('progress 10%'));
    ok('S1 stderr inclus (warning: slow)', bodyTxt.includes('warning: slow'));
    ok('S1 ANSI rendu : span vert « 3 passed »',
       await page.locator('.shell-live-body .sh-fg-2', { hasText: '3 passed' }).count() === 1);
    ok('S1 aucun résidu d\'échappement ANSI',
       bodyTxt.indexOf(String.fromCharCode(27)) === -1 && bodyTxt.indexOf('[32m') === -1);
    ok('S1 code retour ≠ 0 rappelé sous la commande (↳ code 2)', /↳ code 2/.test(bodyTxt));
    ok('S1 pas de rappel de code pour la commande OK', !/↳ code 0/.test(bodyTxt));
    ok('S1 boutons copier + fermer présents', await page.locator('.shell-live-copy').count() === 2);

    // SCROLL après le stream, console OUVERTE : la molette au-dessus du
    // terminal ne piège pas le scroll de page (chaînage une fois en bas).
    await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollTop = 0; }, SC);
    await page.waitForTimeout(120);
    const distOverConsole = await wheelToBottomOver(page.locator('.shell-live-body').first());
    ok('SCROLL molette AU-DESSUS du terminal : la page atteint la fin',
       distOverConsole >= 0 && distOverConsole < 60);

    // Fermer via ✕ → la console disparaît, les pills restent.
    await page.locator('.shell-live-copy[title="Fermer"]').click();
    await page.waitForTimeout(150);
    ok('S1 fermeture ✕ : console fermée, pills intactes',
       await page.locator('.shell-live').count() === 0
       && await page.locator('details.group\\/toolwrap button.group\\/toolbtn').count() >= 2);
    // Ré-ouverture : les données sont conservées.
    await page.locator('details.group\\/toolwrap button.group\\/toolbtn').nth(1).click();
    await page.waitForSelector('.shell-live', { state: 'visible' });
    ok('S1 ré-ouverture par une AUTRE pill shell : même console (session partagée)',
       /2 commandes/.test((await page.locator('.shell-live-header').textContent()) || ''));

    await page.screenshot({ path: `${SHOTS}/liveshell-live.png` }).catch(() => {});

    // ════ S2 — CHAT PERSISTÉ (round à 2 commandes) ═══════════════════════
    await page.locator('#app').getByText('Demo live shell persisté', { exact: false }).first().click();
    // (2026-09-02) Attendre le RENDU du chat rechargé : le toolwrap de l'ANCIEN
    // chat reste attaché pendant le fetch, et la console quitte le DOM en fin
    // de <transition> — un compte immédiat après « toolwrap attaché » lisait
    // l'ancien état (course mesurée : console encore là à +0 ms, partie à
    // +50 ms, sur HEAD comme sur l'arbre de travail).
    await page.waitForFunction(() => /Je lance le build/.test((document.getElementById('app') || {}).textContent || ''));
    await page.waitForFunction(() => !document.querySelector('.shell-live'), null, { timeout: 3000 }).catch(() => {});
    ok('S2 repliée par défaut au reload (pas de console)',
       await page.locator('.shell-live').count() === 0);
    await page.locator('details[data-pipeline] > summary').first().click();
    await page.locator('details.group\\/toolwrap > summary').first().click();
    await page.locator('details.group\\/toolwrap button.group\\/toolbtn').first().click();
    await page.waitForSelector('.shell-live', { state: 'visible' });

    ok('S2 console unique reconstruite au clic de pill', await page.locator('.shell-live').count() === 1);
    const rhdr = (await page.locator('.shell-live-header').textContent()) || '';
    ok('S2 titre « 2 commandes » + chip « 1 échec »',
       /2 commandes/.test(rhdr) && /1 échec/.test(rhdr));
    const rbody = (await page.locator('.shell-live-body').textContent()) || '';
    ok('S2 les deux commandes échoyées dans l\'ordre',
       rbody.indexOf('$ make build') !== -1
       && rbody.indexOf('$ make build') < rbody.indexOf('$ echo done'));
    ok('S2 sorties reconstruites (stdout+stderr de make, stdout d\'echo)',
       rbody.includes('reload out') && rbody.includes('erreur de build') && rbody.includes('done'));
    ok('S2 ANSI rendu au reload : span rouge',
       await page.locator('.shell-live-body .sh-fg-1', { hasText: 'erreur de build' }).count() === 1);
    ok('S2 ↳ code 2 sous make build uniquement',
       /↳ code 2/.test(rbody) && !/↳ code 0/.test(rbody));

    await page.screenshot({ path: `${SHOTS}/liveshell-persisted.png` }).catch(() => {});

    // ════ S3 — RÉGLAGE OFF : carte classique de retour ═══════════════════
    await page.evaluate((base) => fetch(base + '/__test/live-shell', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
    }), BASE_URL);
    await gotoApp(page, '/');
    await page.locator('#app').getByText('Demo live shell persisté', { exact: false }).first().click();
    await page.waitForFunction(() => /Le build a échoué/.test((document.getElementById('app') || {}).textContent || ''));
    await page.locator('details[data-pipeline] > summary').first().click();
    await page.locator('details.group\\/toolwrap > summary').first().click();
    await page.locator('details.group\\/toolwrap button.group\\/toolbtn').first().click();
    await page.waitForTimeout(250);
    ok('S3 réglage OFF → aucune console', await page.locator('.shell-live').count() === 0);
    const s3card = (await page.locator('details.group\\/toolwrap').first().textContent()) || '';
    ok('S3 clic de pill = carte classique (Paramètres + Résultat)',
       /Paramètres/.test(s3card) && /Résultat/.test(s3card));

    await page.screenshot({ path: `${SHOTS}/liveshell-off.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/liveshell-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nliveshell-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
