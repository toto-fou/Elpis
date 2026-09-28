// SPDX-License-Identifier: MIT
// Vérif toggle « Raisonnement conservé » du panneau sampling (2026-08-18) :
//   PERF_PORT=8921 node tests/frontend/preserve-server.mjs &
//   PERF_PORT=8921 node tests/frontend/preserve-verify.mjs
//
// S1 (qwen38-27b, capacité CONFIRMÉE) : le toggle est AFFICHÉ, ON par défaut
//     (tri-état null = défaut du template) et l'état par défaut n'envoie RIEN
//     — non-régression : un utilisateur qui n'y touche pas garde le prompt
//     historique au byte près.
// S2 : bascule OFF → le POST porte sampling_override.preserve_reasoning=false
//     (false est une valeur SIGNIFIANTE, pas un « absent »).
// S3 : re-bascule ON → le POST porte preserve_reasoning=true (explicite).
// S4 (llama3-8b, capacité ABSENTE) : toggle MASQUÉ, et la valeur mémorisée
//     est PURGÉE — l'override localStorage est global au navigateur, il ne
//     doit jamais suivre vers un modèle qui ne comprend pas le kwarg.
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/preserve-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const lastBody = () => page.evaluate(async () => {
    const r = await fetch('/__test/last-body');
    return r.json();
});

async function sendAndWait(text) {
    const ta = page.locator('#app textarea').first();
    await ta.fill(text);
    await page.locator('button[title="Envoyer le message"]').first().click();
    await page.waitForFunction(() => /ok\./.test((document.getElementById('app') || {}).textContent || ''));
    await page.waitForTimeout(150);
}

async function selectModel(id) {
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByText(id, { exact: false }).first().click();
    await page.waitForTimeout(350);   // watch → re-fetch effective-params
}

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    const gear = page.locator('button[title*="Réglages de génération"]').first();
    await gear.waitFor({ state: 'visible' });
    await gear.click();
    const panel = page.locator('div.elpis-slide-panel', { hasText: 'Réglages de génération' }).first();
    await panel.waitFor({ state: 'visible' });
    const panelTxt = () => panel.textContent().then((t) => t || '');

    // ════ S1 — modèle avec capacité confirmée ════════════════════════════
    await selectModel('qwen38-27b');
    const toggle = panel.getByText('Raisonnement conservé', { exact: true });
    ok('S1 toggle AFFICHÉ (supports_preserve_reasoning = true)',
       await toggle.count() === 1);
    ok('S1 ON par défaut (tri-état null = défaut du template)',
       /la réflexion des tours passés reste dans le prompt/.test(await panelTxt()));

    await page.screenshot({ path: `${SHOTS}/preserve-on.png` }).catch(() => {});

    await sendAndWait('tour par defaut');
    const b1 = await lastBody();
    ok('S1 POST : preserve_reasoning ABSENT tant qu\'on n\'y touche pas',
       !b1.sampling_override || b1.sampling_override.preserve_reasoning === undefined);

    // ════ S2 — bascule OFF ═══════════════════════════════════════════════
    await toggle.click();
    await page.waitForTimeout(150);
    ok('S2 état OFF affiché',
       /seule la réflexion du tour courant est gardée/.test(await panelTxt()));

    await page.screenshot({ path: `${SHOTS}/preserve-off.png` }).catch(() => {});

    await sendAndWait('tour preserve off');
    const b2 = await lastBody();
    ok('S2 POST : sampling_override.preserve_reasoning === false',
       !!b2.sampling_override && b2.sampling_override.preserve_reasoning === false);

    // ════ S3 — re-bascule ON ═════════════════════════════════════════════
    await toggle.click();
    await page.waitForTimeout(150);
    await sendAndWait('tour preserve on');
    const b3 = await lastBody();
    ok('S3 POST : sampling_override.preserve_reasoning === true',
       !!b3.sampling_override && b3.sampling_override.preserve_reasoning === true);

    // ════ S4 — modèle SANS la capacité ═══════════════════════════════════
    await selectModel('llama3-8b');
    ok('S4 toggle MASQUÉ (supports_preserve_reasoning = false)',
       await panel.getByText('Raisonnement conservé', { exact: true }).count() === 0);

    await sendAndWait('tour modele sans capacite');
    const b4 = await lastBody();
    ok('S4 POST : valeur mémorisée PURGÉE (jamais envoyée à un modèle sans support)',
       !b4.sampling_override || b4.sampling_override.preserve_reasoning === undefined);

    await page.screenshot({ path: `${SHOTS}/preserve-unsupported.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/preserve-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\npreserve-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
