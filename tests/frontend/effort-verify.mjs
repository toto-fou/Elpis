// SPDX-License-Identifier: MIT
// Vérif chip « Effort de réflexion » de la barre de prompt (2026-08-16) :
//   PERF_PORT=8919 node tests/frontend/effort-server.mjs &
//   PERF_PORT=8919 node tests/frontend/effort-verify.mjs
// S1 (qwen38-27b, chargé, supporte l'effort) : chip VISIBLE (état « auto »),
//     menu = Auto + valeurs du modèle (low/medium/xhigh — pas de liste figée
//     côté front), choisir low → le POST porte
//     sampling_override.reasoning_effort='low'.
// S2 (llama3-8b, chargé, SANS support) : chip MASQUÉ, et la valeur mémorisée
//     est PURGÉE → le POST ne porte plus reasoning_effort (invariant : la
//     feature n'impacte pas les autres modèles).
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/effort-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const lastBody = () => page.evaluate(async () => {
    const r = await fetch('/__test/last-body');
    return r.json();
});

// Envoie un texte UNIQUE puis attend que le mock ait bien enregistré CE body
// (plus robuste qu'un timeout : le 'ok.' de S1 reste dans le DOM en S2).
async function sendAndWait(text) {
    const ta = page.locator('#app textarea').first();
    await ta.fill(text);
    await page.locator('button[title="Envoyer le message"]').first().click();
    for (let i = 0; i < 40; i++) {
        const b = await lastBody();
        if (b && b.message === text) return b;
        await page.waitForTimeout(100);
    }
    return lastBody();
}

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    // ════ S1 — qwen38-27b (chargé, supporte reasoning_effort) ════════════
    // Sélection EXPLICITE (l'élection auto dépend de localStorage/ordre).
    await page.locator('[data-model-manager] > button').first().click();
    await page.getByText('qwen38-27b', { exact: false }).first().click();
    await page.waitForTimeout(400);   // watch → fetch effective-params plein

    const chip = page.locator('[data-effort-menu]');
    await chip.waitFor({ state: 'visible' });
    ok('S1 chip Effort VISIBLE (capacité détectée serveur)', await chip.count() === 1);
    ok('S1 chip en « auto » par défaut (aucun override)',
       /auto/.test((await chip.textContent()) || ''));

    await chip.locator('button').first().click();
    const menu = chip.locator('[role="listbox"]');
    await menu.waitFor({ state: 'visible' });
    const menuTxt = (await menu.textContent()) || '';
    ok('S1 menu : Auto + valeurs DU MODÈLE (low/medium/xhigh)',
       /Auto/.test(menuTxt) && /low/.test(menuTxt) && /medium/.test(menuTxt) && /xhigh/.test(menuTxt));
    ok('S1 menu : pas de valeur hors template (none/high absents)',
       !/none/.test(menuTxt) && !/\bhigh\b/.test(menuTxt.replace(/xhigh/g, '')));

    await menu.getByText('low', { exact: true }).click();
    await page.waitForTimeout(150);
    ok('S1 menu fermé après sélection', await menu.count() === 0);
    ok('S1 chip affiche « low »', /low/.test((await chip.textContent()) || ''));
    await page.screenshot({ path: `${SHOTS}/effort-selected.png` }).catch(() => {});

    const b1 = await sendAndWait('test effort low');
    ok('S1 POST : sampling_override.reasoning_effort = low',
       !!b1.sampling_override && b1.sampling_override.reasoning_effort === 'low');
    ok('S1 POST : thinking prefill intact (8192 — non-régression)',
       b1.sampling_override.thinking_budget_tokens === 8192);
    ok('S1 POST : model = qwen38-27b', b1.model === 'qwen38-27b');

    // ════ S2 — llama3-8b (chargé, SANS support) ══════════════════════════
    await page.locator('[data-model-manager] > button').first().click();
    await page.getByText('llama3-8b', { exact: false }).first().click();
    await page.waitForTimeout(400);   // watch → fetch → purge reasoning_effort

    ok('S2 chip Effort MASQUÉ (modèle sans support)',
       await page.locator('[data-effort-menu]').count() === 0);
    await page.screenshot({ path: `${SHOTS}/effort-hidden.png` }).catch(() => {});

    const b2 = await sendAndWait('test effort purge');
    ok('S2 POST : reasoning_effort PURGÉ (pas envoyé à un modèle sans support)',
       !b2.sampling_override || b2.sampling_override.reasoning_effort === undefined);
    ok('S2 POST : model = llama3-8b', b2.model === 'llama3-8b');

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/effort-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\neffort-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
