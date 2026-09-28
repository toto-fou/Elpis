// SPDX-License-Identifier: MIT
// Vérif panneau « Réglages de génération » en mode DÉGRADÉ (2026-07-27) :
//   PERF_PORT=8917 node tests/frontend/sampling-server.mjs &
//   PERF_PORT=8917 node tests/frontend/sampling-verify.mjs
// S1 (modèle local NON chargé) : le panneau est ÉDITABLE (avant : écran
//     « Modèle non chargé » bloquant) — bandeau explicatif, override
//     max_tool_iterations saisissable, toggle Réflexion MASQUÉ (support
//     inconnu, modèle local) ; l'override part bien dans le POST.
// S2 (connecteur Kimi) : bandeau « Moteur externe », toggle Réflexion
//     AFFICHÉ (choix produit) éteint par défaut ; activé → le POST porte
//     thinking_budget_tokens=8192 + connector_id, et conserve l'override
//     max_tool_iterations saisi en S1 (état par chat).
import fs from 'fs';
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/sampling-shots';
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
    // Laisse le final se traiter (persist du body côté mock déjà fait au POST).
    await page.waitForTimeout(150);
}

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    // ════ S1 — modèle local sélectionné mais NON chargé ══════════════════
    // /api/llm/models ne liste aucun modèle 'loaded' → activeModelIds vide,
    // selectedModel retombe sur 'local-a' (premier disponible).
    const gear = page.locator('button[title*="Réglages de génération"]').first();
    await gear.waitFor({ state: 'visible' });
    await gear.click();

    const panel = page.locator('div.elpis-slide-panel', { hasText: 'Réglages de génération' }).first();
    await panel.waitFor({ state: 'visible' });
    ok('S1 panneau ouvert sur un modèle NON chargé', true);

    const panelTxt = () => panel.textContent().then((t) => t || '');
    ok('S1 bandeau « Modèle non chargé … s\'appliquent quand même »',
       /Modèle non chargé/.test(await panelTxt()) && /appliquent quand même/.test(await panelTxt()));
    ok('S1 les éditeurs sont rendus (temperature + max_tool_iterations)',
       /temperature/.test(await panelTxt()) && /max_tool_iterations/.test(await panelTxt()));
    ok('S1 colonne « modèle » vide (fmtPropVal → --)', /modèle\s*--/.test(await panelTxt()));
    ok('S1 toggle Réflexion MASQUÉ (modèle local non chargé, support inconnu)',
       await panel.getByText('Réflexion', { exact: true }).count() === 0);

    // Saisir un override max_tool_iterations (le champ number max=500).
    const mtiInput = panel.locator('input[type="number"][max="500"]').first();
    await mtiInput.fill('120');
    ok('S1 override max_tool_iterations saisi (120)', (await mtiInput.inputValue()) === '120');

    await page.screenshot({ path: `${SHOTS}/sampling-degraded-local.png` }).catch(() => {});

    await sendAndWait('test override local');
    const b1 = await lastBody();
    ok('S1 POST : sampling_override.max_tool_iterations = 120',
       !!b1.sampling_override && b1.sampling_override.max_tool_iterations === 120);
    ok('S1 POST : pas de connector_id (llama local)', !b1.connector_id);

    // ════ S2 — modèle d'un CONNECTEUR (Kimi) ═════════════════════════════
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByText('kimi-k2-instruct', { exact: false }).first().click();
    await page.waitForTimeout(300);   // watch → re-fetch effective-params dégradé

    // Le bandeau doit être HONNÊTE : un moteur externe ne reçoit que le
    // sampling OpenAI-standard, les samplers llama.cpp sont retirés du payload
    // (providers/openai_compat.py). Il affirmait « vos réglages s'appliquent
    // quand même » — faux pour top_k / min_p / repeat_penalty.
    ok('S2 bandeau « Moteur externe » : dit ce qui s\'applique VRAIMENT',
       /Moteur externe/.test(await panelTxt())
       && /s'appliquent/.test(await panelTxt())
       && /ignor/.test(await panelTxt()));
    ok('S2 samplers llama.cpp marqués « sans effet » et désactivés',
       (await panel.getByText('sans effet').count()) >= 3
       && await panel.locator('input[type=number][disabled]').count() >= 3);
    const themToggle = panel.getByText('Réflexion', { exact: true });
    ok('S2 toggle Réflexion AFFICHÉ pour le connecteur', await themToggle.count() === 1);
    ok('S2 toggle Réflexion ÉTEINT par défaut (aucun pré-remplissage)',
       /Désactivée/.test(await panelTxt()));

    await themToggle.click();
    await page.waitForTimeout(150);
    ok('S2 toggle activable (état « Activée »)', /Activée/.test(await panelTxt()));

    await page.screenshot({ path: `${SHOTS}/sampling-degraded-connector.png` }).catch(() => {});

    await sendAndWait('test override connecteur');
    const b2 = await lastBody();
    ok('S2 POST : connector_id = k1', b2.connector_id === 'k1');
    ok('S2 POST : override max_tool_iterations conservé (état par chat)',
       !!b2.sampling_override && b2.sampling_override.max_tool_iterations === 120);
    ok('S2 POST : thinking_budget_tokens = 8192 (toggle ON)',
       b2.sampling_override.thinking_budget_tokens === 8192);

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/sampling-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nsampling-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
