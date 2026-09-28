// SPDX-License-Identifier: MIT
// Passe 8 (F3/F5) — itération REJOUÉE après un tool_call_delta : la narration
// déjà basculée dans la ligne live est purgée au ``reset`` et ne doit pas se
// retrouver EN DOUBLE dans le worklog ni dans la réponse.
//   PRETOOL_SCENARIO=reset PERF_PORT=8922 node tests/frontend/pretool-server.mjs &
//   PERF_PORT=8922 node tests/frontend/pretool-reset-verify.mjs
import { launch, gotoApp, BASE_URL } from '../perf/lib/harness.mjs';

const checks = [];
const ok = (name, cond, detail = '') => {
    checks.push([cond ? 'PASS' : 'FAIL', name]);
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (!cond && detail ? '  — ' + detail : ''));
};
const NARR1 = 'Je vais lire le fichier de configuration.';
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
const count = (hay, needle) => hay.split(needle).length - 1;

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    const ta = page.locator('#app textarea').first();
    await ta.waitFor({ state: 'visible' });
    await ta.fill('Corrige la configuration.');
    await page.locator('button[title="Envoyer le message"]').first().click();
    await page.waitForFunction((t) => { const p = document.querySelector('[data-live-narration]'); return !!p && (p.textContent || '').includes(t); }, NARR1);
    await release('r1_delta');
    await page.waitForFunction(() => !document.querySelector('button[title="Arrêter la génération"]'));
    await page.waitForTimeout(250);
    const s = await page.evaluate(() => {
        const inPipe = (el) => !!el.closest('details[data-pipeline]');
        const inLive = (el) => !!el.closest('[data-live-narration]');
        return {
            worklogs: [...document.querySelectorAll('.markdown-body--worklog:not([data-live-narration])')].map((el) => (el.textContent || '').trim()),
            body: [...document.querySelectorAll('.markdown-body')].filter((el) => !inPipe(el) && !inLive(el)).map((el) => el.textContent || '').join('\n'),
            pipe: (document.querySelector('details[data-pipeline]') || {}).textContent || '',
        };
    });
    ok('reset : narration figée UNE seule fois dans le worklog',
       s.worklogs.length === 1 && count(s.worklogs[0], 'Je vais lire le fichier') === 1, JSON.stringify(s.worklogs));
    // (le summary replié répète le début de la narration : on ne compte que les segments figés)
    ok('reset : réponse finale dans le corps, une fois', count(s.body, FINAL) === 1 && !s.body.includes(NARR1), s.body.slice(0, 200));
    ok('aucune erreur JS', errors.length === 0);
    if (errors.length) console.log('  errors:', errors);
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
} finally {
    await browser.close();
}
const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\npretool-reset-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
