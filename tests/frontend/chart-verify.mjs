// SPDX-License-Identifier: MIT
// Vérifie le rendu réel des graphiques Chart.js (tous types + plugins vendorisés),
// en clair ET en sombre, route-mock (sans backend) :
//   PERF_PORT=8912 node tests/frontend/chart-server.mjs &
//   PERF_PORT=8912 node tests/frontend/chart-verify.mjs
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const FIX = JSON.parse(fs.readFileSync(new URL('./chart-fixtures.json', import.meta.url), 'utf8'));
const N = FIX.order.length;

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
    page.setDefaultTimeout(10000);
    await gotoApp(page, '/');
    ok('app montée', true);

    await page.locator('text=Charts').first().click();
    // charts render in a 50ms setTimeout after the ref fetch → give them room
    await page.waitForTimeout(2500);

    // 1. Every controller/plugin actually registered in the real browser.
    const reg = await page.evaluate(() => {
        const c = window.Chart;
        return {
            hasChart: typeof c !== 'undefined',
            controllers: c ? Object.keys(c.registry.controllers.items) : [],
            datalabels: !!window.ChartDataLabels,
            annotation: !!window['chartjs-plugin-annotation'],
        };
    });
    ok('Chart.js chargé', reg.hasChart);
    for (const ctrl of ['treemap', 'sankey', 'matrix', 'boxplot', 'violin', 'candlestick', 'ohlc']) {
        ok('contrôleur enregistré: ' + ctrl, reg.controllers.includes(ctrl));
    }
    ok('plugin datalabels présent', reg.datalabels);
    ok('plugin annotation présent', reg.annotation);

    // 2. Every ref rendered a chart card; NONE fell back to an error card.
    const nRender = await page.locator('.chart-render').count();
    const nError  = await page.locator('.chart-render-error').count();
    const nCanvas = await page.locator('.chart-render canvas').count();
    ok(`aucune carte d'erreur (${nError})`, nError === 0);
    ok(`${N} cartes de graphique rendues (${nRender})`, nRender === N);
    // 21 single-canvas + 2 composites × 2 canvases = 25
    ok(`canvases présents (${nCanvas} ≥ ${N})`, nCanvas >= N);

    // 3. Composite (pie-of-pie / bar-of-pie) = one card with TWO canvases.
    const composite2 = await page.evaluate(() => {
        let found = 0;
        document.querySelectorAll('.chart-render').forEach(card => {
            if (card.querySelectorAll('canvas').length === 2) found++;
        });
        return found;
    });
    ok('2 cartes composites à double canvas (pie_of_pie + bar_of_pie)', composite2 === 2);

    // 3b. Advanced client-injection actually ran: some chart carries an injected
    //     animation delay function (stagger/progressive) and a scriptable fill.
    const injected = await page.evaluate(() => {
        let animFn = false, scriptableFill = false;
        document.querySelectorAll('.chart-render canvas').forEach(cv => {
            const ch = window.Chart && window.Chart.getChart(cv);
            if (!ch) return;
            // The source config keeps our injected functions (ch.options.animation.delay
            // gets resolved to a number by Chart.js during the animation).
            const co = (ch.config && ch.config.options) || {};
            if ((co.animation && typeof co.animation.delay === 'function')
                || (co.animations && co.animations.x && typeof co.animations.x.delay === 'function')) animFn = true;
            (ch.data.datasets || []).forEach(ds => {
                if (typeof ds.backgroundColor === 'function') scriptableFill = true;
            });
        });
        return { animFn, scriptableFill };
    });
    ok('animation injectée (delay fn stagger/progressive)', injected.animFn);
    ok('remplissage scriptable injecté (gradient/matrix/treemap)', injected.scriptableFill);

    // 4. No page/console errors (a failed plugin register / bad config would show here).
    const chartErr = [...errors, ...consoleErrors].filter(e => /chart|register|controller|is not a|undefined/i.test(e));
    ok('aucune erreur console liée aux charts', chartErr.length === 0);
    if (chartErr.length) console.log('   errs:', chartErr.slice(0, 4));

    // 5. Dark mode: enable the skin classes and re-render the chat → cards go dark.
    // Les DEUX classes, comme app-settings.js : ``elpis-app-dark`` porte le bloc
    // de tokens du toggle, ``elpis-dark-surface`` est le MARQUEUR « surface
    // sombre » que lit ``_chartDark()`` (et que pose aussi un skin à base
    // sombre). Le test ne posait que la première → carte restée blanche, échec
    // permanent sur du code correct.
    await page.evaluate(() => {
        document.body.classList.add('elpis-app-dark');
        document.body.classList.add('elpis-dark-surface');
    });
    // leave + re-open the chat to force a fresh enhancement pass under the dark class
    await page.locator('button:has-text("Nouveau chat"), [data-act="new-chat"]').first().click().catch(() => {});
    await page.waitForTimeout(400);
    await page.locator('text=Charts').first().click();
    await page.waitForTimeout(2500);
    const darkCard = await page.evaluate(() =>
        !!document.querySelector('.chart-render.bg-slate-800'));
    const darkErr = await page.locator('.chart-render-error').count();
    ok('cartes en thème sombre (bg-slate-800)', darkCard);
    ok('aucune erreur de rendu en sombre', darkErr === 0);

} catch (e) {
    ok('exception: ' + (e && e.message || e), false);
} finally {
    await browser.close();
}

const failed = checks.filter(c => c[0] === 'FAIL');
console.log(`\n${checks.length - failed.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(failed.length ? 1 : 0);
