// SPDX-License-Identifier: MIT
// Vérif de la PROGRESSION DU PRÉ-REMPLISSAGE, route-mock :
//   PERF_PORT=8927 node tests/frontend/prefill-progress-server.mjs &
//   PERF_PORT=8927 node tests/frontend/prefill-progress-verify.mjs
//
// ⚠ Deux câblages successifs se sont trompés d'endroit : ``statusText`` (dont
// le bandeau est réservé au stream d'arrière-plan et à la reconnexion — rien
// ne s'affichait), puis un widget séparé. Le pourcentage vit désormais dans la
// PILL DE STATUT vivante du message, à côté de « Prefill… » : le seul
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
        () => /Prefill…\s*\d+\s*%/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('le pourcentage s’affiche à côté de « Prefill… »', true);

    const pct1 = await page.evaluate(() => {
        const m = ((document.getElementById('app') || {}).textContent || '')
            .match(/Prefill…\s*(\d+)\s*%/);
        return m ? Number(m[1]) : -1;
    });
    ok(`un pourcentage RÉEL est affiché (${pct1} %)`, pct1 > 0 && pct1 < 100);
    await page.screenshot({ path: `${SHOTS}/prefill-running.png` }).catch(() => {});

    // ════ 2 — Il vit dans la pill de statut, pas dans un widget à part ══
    const inPill = await page.evaluate(() => {
        const els = [...document.querySelectorAll('#app [role="status"]')];
        return els.some(e => /Prefill…\s*\d+\s*%/.test(e.textContent || ''));
    });
    ok('porté par une région live (annoncé aux lecteurs d’écran)', inPill);

    // ════ 3 — Il porte sur l'entrée UTILE et montre la part du cache ═══
    // (2600 − 2000) / 3631 = 17 %, puis (4200 − 2000) / 3631 = 61 % ; cache
    // 2000 / 5631 = 36 %. Compté avec le cache, il aurait démarré à 46 %.
    ok(`le pourcentage porte sur l'entrée utile (${pct1} %)`, pct1 === 17 || pct1 === 61);
    ok('la part du cache est affichée', await page.evaluate(
        () => /Prefill…\s*\d+\s*%\s*·\s*cache 36\s*%/.test(
            (document.getElementById('app') || {}).textContent || '')));
    await page.waitForFunction(
        () => /Prefill…\s*61\s*%/.test(
            (document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('le pourcentage s’incrémente', true);

    // ════ 4 — Effacée au PREMIER token, même sans 100 % du moteur ════════
    // Le script s'arrête à 96 % : c'est le premier token de réflexion qui
    // doit effacer la pastille (sinon elle resterait figée tout le tour).
    await page.waitForFunction(
        () => /Prefill…\s*96\s*%/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('la pastille reste affichée tant qu’aucun token n’est sorti (96 %)', true);
    await page.waitForFunction(
        () => !/Prefill…\s*96\s*%/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('le pourcentage disparaît au premier token, sans attendre 100 %', true);

    // ════ 5 — Itération suivante : la lecture prime sur « Réflexion… » ═══
    // (6000 − 2000 relus du cache : (2600 − 2000) / 4000 = 15 %)
    await page.waitForFunction(
        () => /Prefill…\s*15\s*%/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    const pill = await page.evaluate(() => [...document.querySelectorAll('#app [role="status"]')]
        .map(e => e.textContent || '').join(' | '));
    ok('itération 2 : « Prefill… » et non « Réflexion… »',
       /Prefill…/.test(pill) && !/Réflexion…/.test(pill));

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
