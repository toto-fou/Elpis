// SPDX-License-Identifier: MIT
// Vérif du CHARGEMENT DE MODÈLE, route-mock :
//   PERF_PORT=8931 node tests/frontend/load-progress-server.mjs &
//   PERF_PORT=8931 node tests/frontend/load-progress-verify.mjs
//
// La barre du widget de file était une ANIMATION CSS pilotée par une durée
// estimée : elle finissait figée à 100 % pendant que le modèle montait encore
// en VRAM. Le moteur connaît le vrai pourcentage — le client doit le suivre,
// et retomber sur l'animation quand le moteur ne le donne pas.
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/load-progress-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

// Largeur de la barre RÉELLE (style inline) — ``null`` si c'est encore
// l'animation de repli qui est rendue.
const largeurBarre = () => {
    const w = [...document.querySelectorAll('#app [role="status"] div[style*="width"]')]
        .map(e => e.style.width).filter(Boolean);
    return w.length ? w[w.length - 1] : null;
};

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(20000);
    await gotoApp(page, '/');

    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Bonjour');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // ════ 1 — Repli : moteur qui ne donne AUCUN pourcentage ═════════════
    await page.waitForFunction(
        () => /Chargement de Qwen3\.8-27B-long…/.test(
            (document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('le widget annonce le chargement du modèle', true);

    const replie = await page.evaluate(() => {
        const t = (document.getElementById('app') || {}).textContent || '';
        const anim = !!document.querySelector('#app .queue-progress-bar');
        return { estim: /~\s*\d+\s*s/.test(t), anim };
    });
    ok('sans progression moteur : estimation « ~Ns » conservée', replie.estim);
    ok('sans progression moteur : barre ANIMÉE conservée (comportement d’avant)',
       replie.anim);
    await page.screenshot({ path: `${SHOTS}/load-fallback.png` }).catch(() => {});

    // ════ 2 — Téléchargement : libellé distinct du chargement ═══════════
    await page.waitForFunction(
        () => /Téléchargement de Qwen3\.8-27B-long…/.test(
            (document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('récupérer le GGUF se dit « Téléchargement », pas « Chargement »', true);

    const pctDl = await page.evaluate(() => {
        const t = (document.getElementById('app') || {}).textContent || '';
        const m = t.match(/(\d+)\s*%/);
        return m ? Number(m[1]) : -1;
    });
    ok(`un pourcentage RÉEL remplace l’estimation (${pctDl} %)`, pctDl === 35);

    // ════ 3 — La barre suit vraiment le pourcentage ═════════════════════
    await page.waitForFunction(
        () => /modèle 1\/2/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('étape nommée quand le modèle en compte plusieurs (« modèle 1/2 »)', true);

    const w12 = await page.evaluate(largeurBarre);
    ok(`la barre est à la largeur du pourcentage (${w12})`, w12 === '12%');
    const animEncore = await page.evaluate(
        () => !!document.querySelector('#app .queue-progress-bar'));
    ok('l’animation d’estimation a cédé la place à la barre réelle', !animEncore);
    await page.screenshot({ path: `${SHOTS}/load-real.png` }).catch(() => {});

    // ════ 4 — Étape suivante : le repère évite la barre « qui recule » ══
    await page.waitForFunction(
        () => /vision 2\/2/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    const w62 = await page.evaluate(largeurBarre);
    ok(`seconde étape nommée et suivie (« vision 2/2 », ${w62})`, w62 === '62%');

    // ════ 5 — Fin : le widget s’efface ══════════════════════════════════
    await page.waitForFunction(
        () => !/Chargement de Qwen3\.8-27B-long…/.test(
            (document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('le widget disparaît une fois le modèle chargé', true);

    await page.waitForFunction(
        () => /Modèle prêt/.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 });
    ok('la réponse s’affiche normalement ensuite', true);
    await page.screenshot({ path: `${SHOTS}/load-done.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/load-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nload-progress-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
