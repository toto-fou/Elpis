// SPDX-License-Identifier: MIT
// Vérif du rendu des blocs de code (Copier sticky + Aperçu HTML), route-mock :
//   PERF_PORT=8905 node tests/frontend/codeblock-server.mjs &
//   PERF_PORT=8905 node tests/frontend/codeblock-verify.mjs
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(8000);
    await gotoApp(page, '/');
    ok('app montée', true);

    await page.locator('text=Demo HTML').first().click();
    await page.waitForTimeout(1200);

    ok('bloc de code rendu (header présent)', (await page.locator('.code-wrapper .code-header').count()) > 0);

    // Le groupe d'actions flottant est STICKY (suit le scroll dans le bloc).
    const sticky = page.locator('.code-wrapper .copy-sticky').first();
    ok('groupe d\'actions présent', (await sticky.count()) > 0);
    const stickyPos = await sticky.evaluate(el => getComputedStyle(el).position).catch(() => '');
    ok('groupe d\'actions en position sticky', stickyPos === 'sticky');

    // Copier + Aperçu côte à côte, visibles, NON chevauchants.
    const copyBtn   = page.locator('.code-wrapper .copy-sticky .code-actions .copy-btn').first();
    const apercuBtn = page.locator('.code-wrapper .copy-sticky .code-actions button:not(.copy-btn)').first();
    ok('bouton Copier visible', await copyBtn.isVisible().catch(() => false));
    ok('bouton Aperçu visible', await apercuBtn.isVisible().catch(() => false));
    const cb = await copyBtn.boundingBox().catch(() => null);
    const ab = await apercuBtn.boundingBox().catch(() => null);
    const disjoint = !!(cb && ab) && (cb.x >= ab.x + ab.width - 1 || ab.x >= cb.x + cb.width - 1);
    ok('Copier et Aperçu ne se chevauchent pas', disjoint);

    const pre = page.locator('.code-wrapper pre').first();
    ok('code (pre) visible avant aperçu', await pre.isVisible().catch(() => false));
    ok('pas d\'iframe avant aperçu', (await page.locator('.code-preview-frame').count()) === 0);

    // Clic « Aperçu » → rendu REMPLACE le code (pre caché, iframe visible).
    await apercuBtn.click();
    await page.waitForTimeout(500);
    ok('iframe de rendu affichée', await page.locator('.code-preview-frame').first().isVisible().catch(() => false));
    ok('code (pre) masqué pendant l\'aperçu', !(await pre.isVisible().catch(() => true)));
    ok('bouton bascule en « Code »', /Code/.test(await apercuBtn.innerText().catch(() => '')));

    // Re-clic « Code » → retour au code, iframe retirée.
    await apercuBtn.click();
    await page.waitForTimeout(300);
    ok('retour au code (pre re-visible)', await pre.isVisible().catch(() => false));
    ok('iframe retirée au masquage', (await page.locator('.code-preview-frame').count()) === 0);

    // Re-clic « Aperçu » : NON-RÉGRESSION « page blanche » — l'iframe est recréée
    // avec un srcdoc non vide (l'ancien bug réaffichait une iframe vide).
    await apercuBtn.click();
    await page.waitForTimeout(500);
    const frame2 = page.locator('.code-preview-frame').first();
    ok('iframe ré-affichée au 2e aperçu', await frame2.isVisible().catch(() => false));
    const srcdocLen = await frame2.evaluate(el => (el.getAttribute('srcdoc') || '').length).catch(() => 0);
    ok('iframe ré-affichée NON vide (srcdoc présent)', srcdocLen > 20);

    ok('aucune erreur JS de page', errors.length === 0);
    if (errors.length) console.log('  erreurs:', errors.slice(0, 5));
} catch (e) {
    ok('exécution sans exception', false);
    console.log('  ! ' + String(e && e.message || e).split('\n')[0]);
} finally {
    await browser.close();
}

const pass = checks.filter(c => c[0] === 'PASS').length;
console.log(`\n${pass}/${checks.length} checks PASS`);
checks.forEach(([s, n]) => console.log(`  ${s === 'PASS' ? '✓' : '✗'} ${n}`));
process.exit(pass === checks.length ? 0 : 1);
