// SPDX-License-Identifier: MIT
// Vérif : appel d'outil VISIBLE pendant son exécution + AUCUN compteur de
// tokens pendant la réflexion (2026-08-18).
//   TOOL_MS=6000 PROBE_KIND=real PERF_PORT=8931 node tests/frontend/toolvis-server.mjs &
//   PERF_PORT=8931 node tests/frontend/toolvis-verify.mjs
//
// S1 — pendant la RÉFLEXION : la ligne live n'affiche PAS « tok/s » (le cumul
//      y inclurait le prefill : un chiffre qui ne correspond à aucun réel).
// S2 — pendant l'EXÉCUTION de l'outil : le résumé replié nomme l'outil en
//      cours (« read_file · demo.txt ») et NON la narration qui le précède —
//      sinon rien n'indique qu'un outil tourne et l'appel ne devient visible
//      qu'à la fin, via le compteur « · N outils ».
// S3 — en dépliant pendant l'exécution : la carte détail montre « en cours ».
// S4 — après : le résultat remplace « en cours », le débit réapparaît.
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/toolvis-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (n, c) => { checks.push([c ? 'PASS' : 'FAIL', n]); console.log((c ? '  ✓ ' : '  ✗ ') + n); };

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
const appTxt = () => page.locator('#app').textContent().then(t => (t || '').replace(/\s+/g, ' '));
const liveTxt = () => page.locator('#app').evaluate(() => {
    const el = document.querySelector('.font-mono.tabular-nums.select-none');
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
}).catch(() => '');

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    await page.locator('#app textarea').first().fill('vas-y');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // ── S1 : phase de réflexion (avant le 1er content_token) ─────────────
    await page.waitForFunction(
        () => /Je dois lire le fichier/.test(document.getElementById('app').textContent || ''),
        { timeout: 10000 });
    const live1 = await liveTxt();
    // Contrôle NÉGATIF : la ligne live existe bien (chrono affiché) — sans ça
    // l'assertion « pas de tok/s » passerait trivialement sur une ligne vide.
    ok('S1 la ligne live est bien présente pendant la réflexion (chrono)',
       /\d+\s*s/.test(live1));
    ok('S1 pendant la réflexion : aucun « tok/s » sur la ligne live',
       live1 !== '' && !/tok\/s/.test(live1));

    // ── S2 : exécution de l'outil, conteneur REPLIÉ ──────────────────────
    const sum = page.locator('details[data-pipeline] summary').first();
    await sum.waitFor({ state: 'visible' });
    const sumTxt = ((await sum.textContent()) || '').replace(/\s+/g, ' ');
    ok('S2 résumé replié : nomme l\'outil en cours (pas la narration)',
       /read_file/.test(sumTxt) && !/Je vais lire le fichier/.test(sumTxt));
    ok('S2 engrenage animé (outil en cours)',
       await page.locator('details[data-pipeline] > summary i.animate-spin').count() === 1);
    await page.screenshot({ path: `${SHOTS}/pendant-exec.png` }).catch(() => {});

    // ── S3 : déplier pendant l'exécution → « en cours » ──────────────────
    await sum.click();
    await page.waitForTimeout(150);
    await page.locator('details.group\\/toolwrap > summary').first().click();
    await page.waitForTimeout(150);
    await page.locator('button.group\\/toolbtn').first().click();
    await page.waitForTimeout(250);
    const card = ((await page.locator('details[data-pipeline] .rounded-xl.border').first()
        .textContent()) || '').replace(/\s+/g, ' ');
    ok('S3 carte détail pendant l\'exécution : paramètres + « en cours »',
       /Paramètres/.test(card) && /path/.test(card) && /en cours/i.test(card));
    ok('S3 le résultat n\'est pas encore là', !/bonjour/.test(card));

    // ── S4 : après l'exécution ───────────────────────────────────────────
    // On attend le TEXTE de la réponse, pas la fin du stream : la ligne live
    // (et donc le débit) n'existe que tant que le tour n'est pas clos.
    await page.waitForFunction(
        () => /Voici le contenu/.test(document.getElementById('app').textContent || ''),
        { timeout: 20000 });
    await page.waitForTimeout(400);
    const card2 = ((await page.locator('details[data-pipeline] .rounded-xl.border').first()
        .textContent()) || '').replace(/\s+/g, ' ');
    ok('S4 le résultat remplace « en cours »',
       /bonjour/.test(card2) && !/en cours/i.test(card2));

    // Contrôle NÉGATIF de S1 : hors réflexion le débit REVIENT (le compteur
    // est masqué pendant la réflexion, pas supprimé de l'interface).
    const live2 = await liveTxt();
    ok('S4 hors réflexion : le débit « tok/s » est de nouveau affiché',
       /tok\/s/.test(live2));

    // Aucun emoji dans le fil (règle produit : app sobre).
    const t = await appTxt();
    ok('aucun emoji couleur dans l\'interface',
       !/[\u{1F300}-\u{1FAFF}]/u.test(t));

    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\ntoolvis-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
