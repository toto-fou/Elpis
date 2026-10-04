// SPDX-License-Identifier: MIT
// Vérifie le rendu réel des graphiques ECharts des outils chart_<type> (30 types),
// l'avis « ancien format » pour une configuration Chart.js, les outils de carte
// (Tableau, bascule Courbe, Agrandir), puis le thème sombre — route-mock :
//   venv/bin/python tests/frontend/chart_fixtures_gen.py   (si le moteur a changé)
//   PERF_PORT=8912 node tests/frontend/chart-server.mjs &
//   PERF_PORT=8912 node tests/frontend/chart-verify.mjs
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const FIX = JSON.parse(fs.readFileSync(new URL('./chart-fixtures.json', import.meta.url), 'utf8'));
const N = FIX.order.length - 1;                    // moins l'ancienne config Chart.js
const HTML_KINDS = FIX.order.filter(([, id]) => {
    const e = FIX.configs[id]._elpis; return e && e.render;
}).length;                                          // kpi + table : pas de canvas

const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); if (!cond) console.log('  ✗ ' + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

try {
    page.setDefaultTimeout(10000);
    await gotoApp(page, '/');
    ok('app montée', true);
    ok('ECharts PAS chargé avant le premier graphique', await page.evaluate(() => typeof window.echarts === 'undefined'));

    await page.locator('text=Charts').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.chart-render canvas').length >= 20, null, { timeout: 15000 });
    await page.waitForTimeout(800);

    ok('ECharts chargé à la demande', await page.evaluate(() => typeof window.echarts === 'object'));
    const nRender = await page.locator('.chart-render').count();
    const nLegacy = await page.locator('.chart-render-error:has-text("ancien format")').count();
    const nError = await page.locator('.chart-render-error').count();
    ok(`${N} cartes de graphique (${nRender})`, nRender === N);
    ok(`1 avis « ancien format » (${nLegacy})`, nLegacy === 1);
    ok(`aucune autre carte d'erreur (${nError - nLegacy})`, nError === nLegacy);

    const inst = await page.evaluate(() => {
        let withSeries = 0, empty = 0;
        document.querySelectorAll('.chart-render').forEach(card => {
            const host = card.querySelector('canvas') && card.querySelector('canvas').closest('[_echarts_instance_]');
            if (!host) return;
            const ch = window.echarts.getInstanceByDom(host);
            const o = ch && ch.getOption();
            if (o && o.series && o.series.length) withSeries++; else empty++;
        });
        return { withSeries, empty, tables: document.querySelectorAll('.chart-render table').length };
    });
    ok(`${N - HTML_KINDS} instances ECharts avec séries (${inst.withSeries})`, inst.withSeries === N - HTML_KINDS && inst.empty === 0);
    ok('tableau et indicateurs rendus en HTML', inst.tables >= 1
        && await page.locator('.chart-render :text("Tickets")').count() >= 1);

    // Outils de carte sur le premier graphique (barres)
    const first = page.locator('.chart-render').first();
    await first.locator('button:has-text("Tableau")').click();
    ok('Tableau : données affichées', await first.locator('table').count() === 1);
    await first.locator('button:has-text("Courbe")').click();
    await page.waitForTimeout(300);
    const morph = await page.evaluate(() => {
        const host = document.querySelector('.chart-render [_echarts_instance_]');
        return window.echarts.getInstanceByDom(host).getOption().series[0].type;
    });
    ok('bascule Courbe (série en line)', morph === 'line');
    await first.locator('button:has-text("Agrandir")').click();
    await page.waitForTimeout(300);
    ok('Agrandir : vue plein écran', await page.evaluate(() => [...document.body.children].some(e => e.style && e.style.position === 'fixed' && e.querySelector('canvas'))));
    await page.keyboard.press('Escape');

    const chartErr = [...errors, ...consoleErrors].filter(e => /chart|echarts|undefined|is not a/i.test(e));
    ok('aucune erreur console liée aux graphiques', chartErr.length === 0);
    if (chartErr.length) console.log('   errs:', chartErr.slice(0, 4));

    // Thème sombre : les deux classes d'app-settings.js, puis le re-thème global.
    await page.evaluate(() => {
        document.body.classList.add('elpis-app-dark');
        document.body.classList.add('elpis-dark-surface');
        window.elpisRethemeVisuals();
    });
    await page.waitForTimeout(500);
    const dark = await page.evaluate(() => ({
        cards: document.querySelectorAll('.chart-render.bg-slate-800').length,
        light: document.querySelectorAll('.chart-render.bg-white').length,
    }));
    ok(`cartes en thème sombre (${dark.cards})`, dark.cards === N && dark.light === 0);
    ok('aucune erreur après re-thème', [...errors].length === 0);

    // Changement de chat : les instances sont libérées (sweep / disposeAll).
    await page.locator('button:has-text("Nouveau chat"), [data-act="new-chat"]').first().click().catch(() => {});
    await page.waitForTimeout(400);
    ok('plus aucune carte après changement de chat', await page.locator('.chart-render').count() === 0);
} catch (e) {
    ok('exception: ' + (e && e.message || e), false);
} finally {
    await browser.close();
}

const failed = checks.filter(c => c[0] === 'FAIL');
console.log(`\n${checks.length - failed.length}/${checks.length} checks OK`);
for (const [st, n] of checks) console.log(`  ${st === 'PASS' ? '✓' : '✗'} ${n}`);
process.exit(failed.length ? 1 : 0);
