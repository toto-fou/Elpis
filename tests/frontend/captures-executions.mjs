// SPDX-License-Identifier: MIT
// Captures de la console › Supervision › Exécutions (L5.7), route-mock.
//   PERF_PORT=8903 node tests/frontend/admin-server.mjs &
//   PERF_PORT=8903 CAPTURES=/chemin node tests/frontend/captures-executions.mjs
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const DIR = process.env.CAPTURES || '.';
const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
await page.setViewportSize({ width: 1440, height: 900 });
try {
    await gotoApp(page, '/');
    await page.locator('aside .adm-nav__entry:has-text("Supervision"):visible').first().click();
    await page.waitForTimeout(200);
    await page.locator('aside .adm-nav__sub:has-text("Exécutions"):visible').first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: DIR + '/console-1-executions.png' });
    await page.locator('tr:has-text("alice"):visible').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: DIR + '/console-2-filtre-compte.png' });
    await page.locator('.adm-card:has(th:has-text("Genre")) tbody tr:visible').first().click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: DIR + '/console-3-chronologie.png' });
    console.log('erreurs JS :', errors.length ? errors.slice(0, 3) : 'aucune');
} finally {
    await browser.close();
}
