// SPDX-License-Identifier: MIT
// Vérif de la puce « réflexion » de la ligne métriques (2026-08-17) :
//   PERF_PORT=8921 node tests/frontend/thinkmetrics-server.mjs &
//   PERF_PORT=8921 node tests/frontend/thinkmetrics-verify.mjs
//
// S1 mesure EXACTE   : puce « 640 tk », infobulle qui décompose la sortie
//                      (dont réflexion / dont réponse et outils).
// S2 mesure ESTIMÉE  : même puce préfixée « ≈ » — l'app ne présente jamais une
//                      approximation comme un compte exact.
// S3 SANS mesure     : aucune puce. Un « 0 tk » affirmerait une absence de
//                      raisonnement que les anciens messages ne permettent pas
//                      de constater.
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/thinkmetrics-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

// Ligne métriques du DERNIER message assistant (celle qui porte l'infobulle).
const lastMetricsLine = () => page.locator('#app [title^="Modèle :"]').last();

async function sendAndSettle(text) {
    const ta = page.locator('#app textarea').first();
    await ta.fill(text);
    await page.locator('button[title="Envoyer le message"]').first().click();
    // La ligne métriques n'apparaît qu'une fois le message TERMINÉ.
    await lastMetricsLine().waitFor({ state: 'visible' });
    await page.waitForTimeout(150);
    return (await lastMetricsLine().textContent()) || '';
}

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    // ════ S1 — mesure exacte ═════════════════════════════════════════════
    const t1 = await sendAndSettle('cas exact');
    ok('S1 puce réflexion affichée', /640\s*tk/.test(t1.replace(/ | /g, ' ')));
    ok('S1 pas de préfixe « ≈ » sur un compte exact', !/≈/.test(t1));
    ok('S1 la ligne garde ses métriques existantes (non-régression)',
       /qwen38-27b/.test(t1) && /tok\/s/.test(t1));

    const tip1 = (await lastMetricsLine().getAttribute('title')) || '';
    ok('S1 infobulle : total généré conservé', /Tokens générés/.test(tip1));
    ok('S1 infobulle : décomposition réflexion / réponse',
       /dont réflexion/.test(tip1) && /dont réponse et outils/.test(tip1));
    ok('S1 infobulle : la réflexion est SOUS la sortie, pas en plus',
       /Tokens générés\s*:\s*1[\s  ]?000/.test(tip1));
    await page.screenshot({ path: `${SHOTS}/exact.png` }).catch(() => {});

    // ════ S2 — mesure estimée ════════════════════════════════════════════
    const t2 = await sendAndSettle('cas estime');
    ok('S2 puce préfixée « ≈ » quand la mesure est approchée', /≈\s*640\s*tk/.test(t2.replace(/ | /g, ' ')));
    const tip2 = (await lastMetricsLine().getAttribute('title')) || '';
    ok('S2 infobulle porte aussi le « ≈ »', /dont réflexion\s*:\s*≈/.test(tip2));
    await page.screenshot({ path: `${SHOTS}/estime.png` }).catch(() => {});

    // ════ S3 — métriques d'avant la mesure ═══════════════════════════════
    const t3 = await sendAndSettle('cas aucune mesure');
    ok('S3 aucune puce réflexion (surtout pas « 0 tk »)', !/\btk\b/.test(t3));
    const tip3 = (await lastMetricsLine().getAttribute('title')) || '';
    ok('S3 infobulle sans ligne de décomposition', !/dont réflexion/.test(tip3));
    ok('S3 le reste de la ligne est intact', /qwen38-27b/.test(t3));
    await page.screenshot({ path: `${SHOTS}/sans-mesure.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nthinkmetrics-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
