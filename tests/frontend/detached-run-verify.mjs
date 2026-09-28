// SPDX-License-Identifier: MIT
// Vérif du SUIVI D'UN RUN DÉTACHÉ (audit 2026-08-22, B3/B4), route-mock :
//   PERF_PORT=8926 node tests/frontend/detached-run-server.mjs &
//   PERF_PORT=8926 node tests/frontend/detached-run-verify.mjs
//
// Le serveur ne tue plus une génération dont des outils ont déjà tourné quand
// le flux se coupe : il la DÉTACHE, elle va au bout et persiste seule. Le
// client doit donc, à la coupure :
//   1. dire que la génération SE POURSUIT (et non « tour non rejoué ») ;
//   2. ne PAS marquer le message en erreur ;
//   3. garder le bouton Arrêter (le Stop traverse les workers) ;
//   4. SONDER l'état de génération, puis RECHARGER la conversation dès que le
//      run est terminé — c'est ce qui rend le résultat au lecteur sans qu'il
//      ait à deviner quand recharger.
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/detached-run-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = Number(process.env.PERF_PORT || 8926);
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const appText = () => (document.getElementById('app') || {}).textContent || '';

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

try {
    page.setDefaultTimeout(20000);
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Lance la mission');
    await page.locator('button[title="Envoyer le message"]').first().click();

    // ════ 1 — La coupure est annoncée comme une POURSUITE ═══════════════
    await page.waitForFunction(
        () => /se poursuit|arrière-plan|rechargera/i.test(
            (document.getElementById('app') || {}).textContent || ''),
        { timeout: 15000 },
    );
    const txt = await page.evaluate(appText);
    ok('coupure après un outil : la poursuite côté serveur est annoncée',
       /se poursuit|rechargera/i.test(txt));
    ok('plus de « tour non rejoué » (le run n’est plus perdu)',
       !/tour non rejoué/i.test(txt));
    await page.screenshot({ path: `${SHOTS}/detached-following.png` }).catch(() => {});

    // ════ 2 — Le bouton Arrêter reste offert pendant le suivi ═══════════
    const stopBtn = page.locator('button[aria-label="Arrêter la génération"]').first();
    ok('bouton Arrêter disponible pendant le suivi (Stop cross-worker)',
       await stopBtn.count() > 0);

    // ════ 3 — L'état est SONDÉ, puis la conversation RECHARGÉE ══════════
    // Le serveur répond « en cours » deux fois, puis « terminé » : le client
    // doit alors recharger la conversation et afficher la réponse persistée.
    await page.waitForFunction(
        () => /Mission terminée/i.test((document.getElementById('app') || {}).textContent || ''),
        { timeout: 40000 },
    );
    ok('fin du run détaché → conversation rechargée, réponse persistée affichée', true);

    const probe = await page.evaluate(async () => {
        const r = await fetch('/__probe');
        return r.json();
    });
    ok(`état de génération réellement sondé (${probe.statusCalls} appel(s))`,
       probe.statusCalls >= 2);
    ok(`conversation rechargée depuis le serveur (${probe.chatLoads} chargement(s))`,
       probe.chatLoads >= 1);

    // ════ 4 — Le suivi s'arrête : l'UI n'est plus « en génération » ═════
    const stillStreaming = await page.locator(
        'button[aria-label="Arrêter la génération"]').count();
    ok('suivi terminé → le bouton Arrêter a disparu', stillStreaming === 0);

    await page.screenshot({ path: `${SHOTS}/detached-reloaded.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/detached-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\ndetached-run-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
