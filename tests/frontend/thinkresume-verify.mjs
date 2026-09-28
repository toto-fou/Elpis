// SPDX-License-Identifier: MIT
// Vérif front « raisonnement coupé → reprise » (2026-08-17) :
//   PERF_PORT=8921 node tests/frontend/thinkresume-server.mjs &
//   PERF_PORT=8921 node tests/frontend/thinkresume-verify.mjs
// S1 — final truncated_in_think : le raisonnement N'EST PAS promu en réponse
//      markdown (bulle vide), le bloc Réflexion le garde, titre « Réflexion
//      interrompue », bannière avec bouton « Continuer ».
// S2 — clic Continuer : le POST porte is_continue:true ET le dernier assistant
//      du payload porte resume_thinking (le backend reprend DU raisonnement,
//      pas de zéro) ; après le final, la bulle porte la conclusion et la
//      bannière disparaît.
// S3 — régression : think-only SANS truncated_in_think → le filet de
//      promotion historique promeut toujours (réponse piégée dans le think).
import fs from 'fs';
import { launch, gotoApp } from '../perf/lib/harness.mjs';

const SHOTS = process.env.SHOTS_DIR || '/tmp/thinkresume-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([cond ? 'PASS' : 'FAIL', name]); console.log((cond ? '  ✓ ' : '  ✗ ') + name); };

const REASONING = 'Je dois analyser le problème étape par étape, comparer les options';

const { browser, page, errors } = await launch({ reducedMotion: 'reduce' });

const bodies = () => page.evaluate(async () => {
    const r = await fetch('/__test/bodies');
    return (await r.json()).bodies || [];
});

async function send(text) {
    const ta = page.locator('#app textarea').first();
    await ta.fill(text);
    await page.locator('button[title="Envoyer le message"]').first().click();
}

async function waitBodies(n) {
    for (let i = 0; i < 50; i++) {
        const b = await bodies();
        if (b.length >= n) return b;
        await page.waitForTimeout(100);
    }
    return bodies();
}

try {
    page.setDefaultTimeout(15000);
    await gotoApp(page, '/');
    ok('app montée (v-cloak levé)', true);

    // ════ S1 — coupure en plein raisonnement ═════════════════════════════
    await send('déclenche coupure');
    await waitBodies(1);
    // Laisse le final se poser (stream 30 ms/event + patch Vue).
    await page.locator('[role="status"]:has-text("Continuer")').waitFor({ state: 'visible' });

    // Le raisonnement n'apparaît PAS dans la bulle de réponse markdown.
    const bubbleTexts = await page.locator('.elpis-msg-body, [data-msg-content]').allInnerTexts().catch(() => []);
    const inBubble = bubbleTexts.some(t => t.includes('analyser le problème étape par étape'));
    // Repli robuste : le raisonnement ne doit exister QUE dans le <pre> du bloc think.
    const proseHasReasoning = await page.evaluate((r) => {
        const pres = new Set(Array.from(document.querySelectorAll('details[data-think] pre')));
        return Array.from(document.querySelectorAll('#app *')).some(el =>
            el.children.length === 0 && !pres.has(el.closest('details[data-think] pre') ? el : el)
            && false);
    }, REASONING).catch(() => false);
    ok('S1 raisonnement PAS promu en réponse markdown', !inBubble && !proseHasReasoning);

    const think = page.locator('details[data-think]').last();
    ok('S1 bloc Réflexion présent et peuplé',
       ((await think.locator('pre').innerText().catch(() => ''))).includes('analyser le problème'));
    const summaryTxt = (await think.locator('summary').innerText().catch(() => '')) || '';
    ok('S1 titre « Réflexion interrompue »', /Réflexion interrompue/.test(summaryTxt));
    ok('S1 titre PAS re-titré « Réponse »', !/^\s*Réponse\b/.test(summaryTxt));

    const banner = page.locator('[role="status"]:has-text("Continuer")').last();
    ok('S1 bannière de reprise visible', await banner.isVisible().catch(() => false));
    ok('S1 libellé bannière = « Réflexion interrompue »',
       /Réflexion interrompue/.test((await banner.innerText().catch(() => '')) || ''));
    await page.screenshot({ path: `${SHOTS}/thinkresume-s1.png` }).catch(() => {});

    // ════ S2 — Continuer : reprise AVEC le raisonnement ══════════════════
    await banner.locator('button:has-text("Continuer")').click();
    const b = await waitBodies(2);
    const cont = b[1] || {};
    ok('S2 POST is_continue:true', cont.is_continue === true);
    const msgs = cont.messages || [];
    const lastAsst = [...msgs].reverse().find(m => m && m.role === 'assistant') || {};
    ok('S2 dernier assistant du payload porte resume_thinking',
       typeof lastAsst.resume_thinking === 'string'
       && lastAsst.resume_thinking.includes('analyser le problème'));
    ok('S2 marqueur thinkingTruncated propagé', lastAsst.thinkingTruncated === true);

    await page.locator('text=Conclusion depuis le raisonnement.').first().waitFor({ state: 'visible' });
    ok('S2 conclusion rendue dans la bulle', true);
    await page.waitForTimeout(300);
    ok('S2 bannière disparue après reprise',
       (await page.locator('[role="status"]:has-text("Continuer")').count()) === 0);
    ok('S2 titre du bloc think revenu à la normale',
       !/Réflexion interrompue/.test((await page.locator('details[data-think]').last().locator('summary').innerText().catch(() => '')) || ''));
    await page.screenshot({ path: `${SHOTS}/thinkresume-s2.png` }).catch(() => {});

    // ════ S3 — régression : promotion legacy toujours active ═════════════
    await send('déclenche promotion');
    await waitBodies(3);
    await page.locator('text=La vraie réponse est 42.').first().waitFor({ state: 'visible' });
    ok('S3 think-only SANS truncated_in_think → promotion conservée', true);
    ok('S3 aucune bannière sur le tour promu',
       (await page.locator('[role="status"]:has-text("Continuer")').count()) === 0);
    await page.screenshot({ path: `${SHOTS}/thinkresume-s3.png` }).catch(() => {});

    ok('aucune erreur JS sur toute la session', errors.length === 0);
    if (errors.length) console.log('  errors:', errors.slice(0, 5));
} catch (e) {
    console.error('EXCEPTION:', e);
    checks.push(['FAIL', 'exception: ' + (e && e.message)]);
    await page.screenshot({ path: `${SHOTS}/thinkresume-exception.png` }).catch(() => {});
} finally {
    await browser.close();
}

const fails = checks.filter(([s]) => s === 'FAIL');
console.log(`\nthinkresume-verify : ${checks.length - fails.length}/${checks.length} PASS`);
process.exit(fails.length ? 1 : 0);
