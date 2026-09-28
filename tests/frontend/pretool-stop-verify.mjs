// SPDX-License-Identifier: MIT
// Passe 8 (F4) — Stop pendant la RÉPONSE FINALE d'un tour à outils (elle
// streame dans la ligne live du conteneur) : le texte déjà lu devient le
// corps du partiel au lieu d'être jeté.
//   PERF_PORT=8924 node tests/frontend/pretool-server.mjs &
//   PERF_PORT=8924 node tests/frontend/pretool-stop-verify.mjs
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond, detail = '') => {
    checks.push([cond ? 'PASS' : 'FAIL', name]);
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (!cond && detail ? '  — ' + detail : ''));
};
const FINAL = 'Voilà, la configuration est corrigée.';
const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });
// Relâche la barrière en RÉESSAYANT : le front peut réagir à l'event précédent
// avant que le serveur ait posé la barrière (tick de 40 ms).
const release = async (g) => {
    for (let i = 0; i < 40; i++) {
        const r = await fetch(`${BASE_URL}/__gate/${g}`, { method: 'POST' }).then((r) => r.json());
        if (r && r.released) return r;
        await new Promise((res) => setTimeout(res, 50));
    }
    return { released: false };
};
const inPipe = (el) => !!el.closest('details[data-pipeline]');

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Corrige la configuration.');
    await page.locator('button[title="Envoyer le message"]').first().click();
    for (const g of ['r1_narr', 'r1_delta', 'r2_narr']) {
        await page.waitForFunction((gate) => true, g);
        await page.waitForTimeout(300);
        await release(g);
    }
    // Réponse finale en cours dans la ligne live (barrière final_narr tenue).
    await page.waitForFunction((t) => { const p = document.querySelector('[data-live-narration]'); return !!p && (p.textContent || '').includes(t); }, FINAL);
    await page.locator('button[title="Arrêter la génération"]').first().click();
    await page.waitForFunction(() => !document.querySelector('button[title="Arrêter la génération"]'));
    await page.waitForTimeout(300);
    const s = await page.evaluate(() => {
        const inPipe = (el) => !!el.closest('details[data-pipeline]');
        const inLive = (el) => !!el.closest('[data-live-narration]');
        return {
            body: [...document.querySelectorAll('.markdown-body')].filter((el) => !inPipe(el) && !inLive(el)).map((el) => el.textContent || '').join('\n'),
            live: !!document.querySelector('[data-live-narration]'),
        };
    });
    ok('Stop : la réponse en cours est conservée dans le corps', s.body.includes(FINAL), s.body.slice(0, 200));
    ok('Stop : ligne live vidée', !s.live);
    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
    await release('final_narr').catch(() => {});
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
} finally {
    await browser.close();
}
const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\npretool-stop-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
