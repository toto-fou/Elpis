// SPDX-License-Identifier: MIT
// Vérif du bouton « Répondre maintenant », route-mock :
//   MODE=native PERF_PORT=8928 node tests/frontend/respond-now-server.mjs &
//   MODE=native PERF_PORT=8928 node tests/frontend/respond-now-verify.mjs
//   (puis MODE=legacy pour le repli)
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/respond-now-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const MODE = process.env.MODE || 'native';
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(20000);
    await gotoApp(page, '/');

    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Réfléchis puis réponds');
    await page.locator('button[title="Envoyer le message"]').first().click();

    const btn = page.locator('button:has-text("Répondre maintenant")').first();
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    ok('le bouton apparaît pendant le raisonnement', true);
    await page.screenshot({ path: `${SHOTS}/respond-now-${MODE}-before.png` }).catch(() => {});

    await btn.click();

    await page.waitForFunction(
        () => /Réponse (sans relance|après relance)/.test(
            (document.getElementById('app') || {}).textContent || ''),
        { timeout: 20000 });

    const probe = await page.evaluate(async () => (await fetch('/__probe')).json());
    const txt = await page.evaluate(() => (document.getElementById('app') || {}).textContent || '');

    ok('la voie native est TENTÉE en premier', probe.reasoningEndCalls >= 1);

    if (MODE === 'native') {
        ok('aucune relance du tour (le prompt n’est pas ré-évalué)',
           probe.streamPosts === 1);
        ok('aucune annulation émise', probe.cancels === 0);
        ok('la réponse arrive dans le MÊME flux', /Réponse sans relance/.test(txt));
        const open = await page.evaluate(
            () => !!document.querySelector('details[data-think][open]'));
        ok('le bloc de raisonnement est replié', !open);
    } else {
        ok('le refus du moteur déclenche le repli historique',
           probe.streamPosts === 2);
        ok('le repli annule bien le tour en cours', probe.cancels >= 1);
        ok('la réponse est obtenue par relance', /Réponse après relance/.test(txt));
    }

    await page.screenshot({ path: `${SHOTS}/respond-now-${MODE}-after.png` }).catch(() => {});
    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/respond-now-${MODE}-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nrespond-now-verify (${MODE}) : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
