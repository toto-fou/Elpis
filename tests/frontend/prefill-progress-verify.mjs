// SPDX-License-Identifier: MIT
// Vérif de la PROGRESSION DU PRÉ-REMPLISSAGE, route-mock :
//   PERF_PORT=8927 node tests/frontend/prefill-progress-server.mjs &
//   PERF_PORT=8927 node tests/frontend/prefill-progress-verify.mjs
//
// ⚠ Deux câblages successifs se sont trompés d'endroit : ``statusText`` (dont
// le bandeau est réservé au stream d'arrière-plan et à la reconnexion — rien
// ne s'affichait), puis un widget séparé. Le pourcentage vit désormais dans la
// PILL DE STATUT vivante du message, à côté de « Réflexion… » : le seul
// endroit que l'utilisateur regarde déjà pendant qu'il attend.
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/prefill-progress-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };
const appText = () => (document.getElementById('app') || {}).textContent || '';

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(20000);
    await gotoApp(page, '/');

    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Analyse ce long contexte');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // ════ 1 — La phase muette devient visible ═══════════════════════════
    await page.waitForFunction(
        () => /Réflexion…\s*\d+\s*%/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('le pourcentage s’affiche à côté de « Réflexion… »', true);

    const pct1 = await page.evaluate(() => {
        const m = ((document.getElementById('app') || {}).textContent || '')
            .match(/Réflexion…\s*(\d+)\s*%/);
        return m ? Number(m[1]) : -1;
    });
    ok(`un pourcentage RÉEL est affiché (${pct1} %)`, pct1 > 0 && pct1 < 100);
    await page.screenshot({ path: `${SHOTS}/prefill-running.png` }).catch(() => {});

    // ════ 2 — Il vit dans la pill de statut, pas dans un widget à part ══
    const inPill = await page.evaluate(() => {
        const els = [...document.querySelectorAll('#app [role="status"]')];
        return els.some(e => /Réflexion…\s*\d+\s*%/.test(e.textContent || ''));
    });
    ok('porté par une région live (annoncé aux lecteurs d’écran)', inPill);

    // ════ 3 — Il s’incrémente jusqu’à 100 % ═════════════════════════════
    await page.waitForFunction(
        () => /Réflexion…\s*100\s*%/.test(
            (document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('le pourcentage s’incrémente jusqu’à 100 %', true);

    // ════ 4 — Elle s'efface au PREMIER token, même de réflexion ═════════
    // C'est le cas qui restait figé : en mode réflexion, le premier token
    // n'est pas du contenu, et le widget serait resté bloqué à 100 % pendant
    // tout le raisonnement.
    await page.waitForFunction(
        () => !/Réflexion…\s*\d+\s*%/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('le pourcentage disparaît dès le premier token (réflexion comprise)', true);

    await page.waitForFunction(
        () => /Voici la réponse/i.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('la réponse s’affiche normalement ensuite', true);
    await page.screenshot({ path: `${SHOTS}/prefill-done.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/prefill-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nprefill-progress-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
